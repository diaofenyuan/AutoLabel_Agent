package cn.autolabel.engine;

import com.google.gson.*;
import com.google.gson.stream.JsonWriter;
import java.awt.geom.*;
import java.io.*;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.util.*;

/** 汇总固定输入结果；保留候选和来源，不承担执行、人工确认或 NMS。 */
final class InputAggregation {
    static final String VERSION = "input-aggregation-v1";
    static final int MAX_OBJECTS = 10000, MAX_POINTS = 65536;
    static final int MAX_PAIR_CHECKS = 20000, MAX_GEOMETRY_COST = 250000, MAX_DUPLICATE_ISSUES = 1000;
    private static final Set<String> STATUSES = Set.of("succeeded", "failed", "unknown", "cancelled", "needs_attention");

    private record Rect(double x, double y, double width, double height) {
        double right() { return x + width; }
        double bottom() { return y + height; }
        JsonObject json() { return Json.obj("x", x, "y", y, "width", width, "height", height); }
        boolean full(int w, int h) { return x == 0 && y == 0 && right() == w && bottom() == h; }
    }
    private record FixedInput(String id, Rect coverage) {}
    private record Candidate(String inputId, String resultId, String originalId, JsonObject annotation,
                             JsonObject source, boolean fullScope, boolean usable) {}
    private record Shape(Candidate candidate, RegionGeometry.Region region, Rectangle2D bounds, int cost) {}
    private record Coverage(double area, boolean complete) {}
    private record Edge(double x, double y1, double y2, int delta) {}

    static JsonObject aggregate(JsonObject baseline, JsonObject project, JsonArray expectedInputs, JsonArray results) {
        Budget budget = new Budget(); bounded(baseline, budget, 0); bounded(project, budget, 0);
        bounded(expectedInputs, budget, 0); bounded(results, budget, 0);
        String baselineId = text(baseline, "id", 160), baselineHash = text(baseline, "contentHash", 64);
        if (!baselineHash.matches("[0-9a-fA-F]{64}")) throw invalid("基准图内容摘要无效。");
        int width = integer(baseline, "width", 1, 20000), height = integer(baseline, "height", 1, 20000);
        int baselineVersion = integer(baseline, "version", 0, Integer.MAX_VALUE);
        if ((long)width * height > 40_000_000) throw invalid("基准图尺寸超过媒体限制。");
        String task = text(project, "taskType", 20);
        if (!Annotations.TYPES.contains(task) || Json.array(project, "classes").isEmpty()) throw invalid("项目任务或类别模板无效。");
        Annotations.classes(Json.array(project, "classes"));
        if (expectedInputs.isEmpty() || expectedInputs.size() > 10000 || results.size() > 10000) throw limit("固定输入数量必须在 1～10000 内。");
        TreeMap<String, FixedInput> fixed = new TreeMap<>();
        for (JsonElement value : expectedInputs) {
            JsonObject input = object(value); String id = text(input, "inputId", 160);
            Rect coverage = rectangle(object(input.get("baselineCoverageRect")), width, height);
            if (fixed.putIfAbsent(id, new FixedInput(id, coverage)) != null) throw invalid("固定输入 ID 不能重复。");
        }
        Map<String, JsonObject> records = new HashMap<>(); long rawObjects = 0, rawPoints = 0;
        for (JsonElement value : results) {
            JsonObject result = object(value); String inputId = text(result, "inputId", 160);
            text(result, "resultId", 160);
            if (!fixed.containsKey(inputId) || records.putIfAbsent(inputId, result) != null) throw invalid("结果包含额外或重复的输入 ID。");
            if (!STATUSES.contains(text(result, "status", 32))) throw invalid("输入结果终态不受支持。");
            if (result.has("mapping") && result.get("mapping").isJsonObject()) {
                JsonArray labels = Json.array(result.getAsJsonObject("mapping"), "annotations"); rawObjects += labels.size();
                for (JsonElement label : labels) if (label.isJsonObject())
                    rawPoints += Json.array(label.getAsJsonObject(), "points").size() + Json.array(label.getAsJsonObject(), "keypoints").size();
            }
            if (rawObjects > MAX_OBJECTS || rawPoints > MAX_POINTS) throw limit("聚合超过 10000 个对象或 65536 个点，请保留原始结果并缩小输入范围。");
        }
        JsonArray issues = new JsonArray(), resultIds = new JsonArray(), identity = new JsonArray();
        List<Rect> covered = new ArrayList<>(); List<Candidate> candidates = new ArrayList<>();
        int succeeded = 0, failed = 0, unknown = 0, cancelled = 0, missing = 0, needsAttention = 0;
        for (FixedInput input : fixed.values()) {
            JsonObject result = records.get(input.id);
            if (result == null) {
                missing++; issue(issues, input.id, null, null, "input_missing", "固定输入尚无结果，不能作为无目标处理。");
                identity.add(Json.obj("inputId", input.id, "coverage", input.coverage.json(), "resultId", null, "status", "missing", "mappingHash", null)); continue;
            }
            String resultId = Json.required(result, "resultId"), status = Json.required(result, "status"); resultIds.add(resultId);
            JsonElement mappingElement = result.get("mapping");
            identity.add(Json.obj("inputId", input.id, "coverage", input.coverage.json(), "resultId", resultId,
                "status", status, "mappingHash", mappingElement == null ? null : digest(mappingElement)));
            switch (status) {
                case "succeeded" -> succeeded++;
                case "needs_attention" -> { needsAttention++; issue(issues, input.id, resultId, null, "input_review_required", "该输入计算完成但仍待复核，不能贡献可采用覆盖。"); }
                case "failed" -> { failed++; issue(issues, input.id, resultId, null, "input_failed", "该输入执行失败，不能作为无目标处理。"); }
                case "unknown" -> { unknown++; issue(issues, input.id, resultId, null, "input_unknown", "该输入结果未知，不能假定成功或无目标。"); }
                case "cancelled" -> { cancelled++; issue(issues, input.id, resultId, null, "input_cancelled", "该输入已取消，不能作为完成结果。"); }
            }
            if (!status.equals("succeeded") && !status.equals("needs_attention")) continue;
            JsonObject mapping;
            try {
                mapping = object(mappingElement);
                validateMapping(mapping, input.coverage, baselineId, baselineHash, width, height);
            } catch (RuntimeException error) {
                issue(issues, input.id, resultId, null, "mapping_invalid", "回映封装的版本、身份、尺寸或覆盖范围不匹配，未采用其中标签。"); continue;
            }
            boolean blocked = inherited(mapping, input.id, resultId, issues), labelsValid = true;
            JsonArray labels = mapping.getAsJsonArray("annotations");
            Map<String, Integer> counts = new HashMap<>();
            for (JsonElement value : labels) if (value.isJsonObject()) counts.merge(Json.str(value.getAsJsonObject(), "id", ""), 1, Integer::sum);
            for (JsonElement value : labels) {
                try {
                    JsonObject original = object(value); String originalId = text(original, "id", 100000);
                    if (counts.getOrDefault(originalId, 0) != 1) throw invalid("同一输入的对象 ID 重复。");
                    strictNumbers(original);
                    JsonObject annotation = Annotations.validate(Json.arr(original), baseline, project).get(0).getAsJsonObject();
                    String id = "agg-" + digest(Json.arr(input.id, originalId)); annotation.addProperty("id", id);
                    JsonObject source = Json.obj("annotationId", id, "inputId", input.id, "resultId", resultId,
                        "sourceAnnotationId", originalId, "classId", annotation.get("classId"), "included", true);
                    candidates.add(new Candidate(input.id, resultId, originalId, annotation, source,
                        input.coverage.full(width, height), status.equals("succeeded") && !blocked));
                } catch (RuntimeException invalidLabel) {
                    labelsValid = false;
                    issue(issues, input.id, resultId, value.isJsonObject() ? Json.str(value.getAsJsonObject(), "id", null) : null,
                        "mapped_annotation_invalid", "回映结果含有不合法或重复 ID 的对象，已保留原结果供检查。");
                }
            }
            if (task.equals("classify") && labels.size() != 1) {
                labelsValid = false; issue(issues, input.id, resultId, null, "classification_result_invalid", "单个分类输入必须提供一个明确类别。");
            }
            if (task.equals("classify") && !input.coverage.full(width, height)) {
                blocked = true; issue(issues, input.id, resultId, null, "classification_scope_changed", "局部裁剪或切片类别不能自动提升为整张基准图类别。");
            }
            if (status.equals("succeeded") && !blocked && labelsValid) covered.add(input.coverage);
        }
        candidates.sort(Comparator.comparing(Candidate::inputId).thenComparing(Candidate::originalId));
        JsonArray annotations = new JsonArray(), sources = new JsonArray();
        if (task.equals("classify")) classify(candidates, annotations, sources, issues);
        else {
            for (Candidate candidate : candidates) { annotations.add(candidate.annotation); sources.add(candidate.source); }
            duplicates(candidates, issues);
        }
        Coverage coverage = union(covered, width, height);
        if (!coverage.complete) issue(issues, null, null, null, "coverage_incomplete", "成功且可采用的结果未完整覆盖基准图，不能作为完整标注或无目标图片。");
        JsonObject hashInput = Json.obj("aggregationVersion", VERSION, "mappingVersion", TransformGeometry.MAPPING_VERSION,
            "transformVersion", TransformGeometry.VERSION, "validatorVersion", TaskTemplates.VALIDATOR_VERSION,
            "baseline", Json.obj("id", baselineId, "contentHash", baselineHash, "width", width, "height", height, "version", baselineVersion),
            "template", TaskTemplates.semantic(project), "inputs", identity,
            "policy", Json.obj("duplicateIoU", 0.5, "pairLimit", MAX_PAIR_CHECKS, "geometryCostLimit", MAX_GEOMETRY_COST,
                "duplicateIssueLimit", MAX_DUPLICATE_ISSUES, "coverage", "usable-success-rectangle-union-v1", "classification", "full-image-consensus-v1"));
        return Json.obj("resultSetHash", digest(hashInput), "annotations", annotations, "requiresGeometryReview", hasErrors(issues),
            "geometryIssues", issues, "coverage", Json.obj("area", coverage.area, "totalArea", (double)width * height, "complete", coverage.complete),
            "statistics", Json.obj("inputsTotal", fixed.size(), "succeeded", succeeded, "failed", failed, "unknown", unknown,
                "cancelled", cancelled, "missing", missing, "needsAttention", needsAttention), "resultIds", resultIds, "objectSources", sources);
    }

    private static void validateMapping(JsonObject mapping, Rect expected, String baselineId, String hash, int width, int height) {
        if (!TransformGeometry.MAPPING_VERSION.equals(text(mapping, "version", 80)) || !TransformGeometry.VERSION.equals(text(mapping, "transformVersion", 80))
            || !text(mapping, "direction", 16).equals("inverse") || !text(mapping, "coordinateSpace", 16).equals("baseline")
            || !text(mapping, "baselineAssetId", 160).equals(baselineId) || !text(mapping, "baselineContentHash", 64).equalsIgnoreCase(hash)
            || integer(mapping, "width", 1, 20000) != width || integer(mapping, "height", 1, 20000) != height
            || !mapping.has("annotations") || !mapping.get("annotations").isJsonArray()
            || !mapping.has("geometryIssues") || !mapping.get("geometryIssues").isJsonArray()
            || !mapping.has("requiresGeometryReview") || !mapping.get("requiresGeometryReview").isJsonPrimitive()
            || !mapping.getAsJsonPrimitive("requiresGeometryReview").isBoolean()) throw invalid("回映封装不匹配。");
        Rect actual = rectangle(object(object(mapping.get("coverage")).get("baselineRect")), width, height);
        Rect transform = rectangle(object(object(mapping.get("inputTransform")).get("baselineCoverageRect")), width, height);
        if (!expected.equals(actual) || !expected.equals(transform)) throw invalid("回映覆盖范围不匹配。");
    }
    private static boolean inherited(JsonObject mapping, String inputId, String resultId, JsonArray issues) {
        boolean blocked = Json.bool(mapping, "requiresGeometryReview", false);
        for (JsonElement value : Json.array(mapping, "geometryIssues")) {
            JsonObject issue = object(value).deepCopy();
            String sourceId = Json.str(issue, "annotationId", null);
            issue.addProperty("inputId", inputId); issue.addProperty("resultId", resultId); issue.addProperty("inherited", true);
            if (sourceId != null) { issue.addProperty("sourceAnnotationId", sourceId); issue.addProperty("annotationId", "agg-" + digest(Json.arr(inputId, sourceId))); }
            if (!Json.str(issue, "severity", "error").equals("info")) blocked = true;
            issues.add(issue);
        }
        for (JsonElement value : Json.array(mapping, "items")) if (Json.str(object(value), "outcome", "").equals("review")) blocked = true;
        if (blocked) issue(issues, inputId, resultId, null, "upstream_geometry_review_required", "上游几何复核尚未解决，聚合不会清除其阻断状态。");
        return blocked;
    }
    private static void classify(List<Candidate> candidates, JsonArray annotations, JsonArray sources, JsonArray issues) {
        List<Candidate> full = new ArrayList<>();
        for (Candidate candidate : candidates) {
            sources.add(candidate.source);
            if (candidate.fullScope) full.add(candidate);
            else { candidate.source.addProperty("included", false); candidate.source.addProperty("reason", "classification_scope_changed"); }
        }
        Set<String> categories = new HashSet<>(); for (Candidate candidate : full) categories.add(Json.required(candidate.annotation, "classId"));
        if (full.isEmpty() || categories.size() != 1 || full.size() > 1 && full.stream().anyMatch(candidate -> !candidate.usable)) {
            for (Candidate candidate : full) { candidate.source.addProperty("included", false); candidate.source.addProperty("reason", "classification_consensus_unresolved"); }
            issue(issues, null, null, null, "classification_consensus_unresolved", "缺少可采用的整图类别，或多个整图结果存在冲突、待审状态；未自动选择类别。"); return;
        }
        Candidate chosen = full.getFirst(); annotations.add(chosen.annotation);
        // 图片级同类别结果合为一个类别条目，原始结果和各来源仍完整保留。
        for (Candidate candidate : full) candidate.source.addProperty("annotationId", Json.required(chosen.annotation, "id"));
    }
    private static void duplicates(List<Candidate> candidates, JsonArray issues) {
        Map<String, Set<String>> inputsByClass = new HashMap<>();
        for (Candidate candidate : candidates) inputsByClass.computeIfAbsent(Json.required(candidate.annotation, "classId"), ignored -> new HashSet<>()).add(candidate.inputId);
        List<Shape> shapes = new ArrayList<>();
        for (Candidate candidate : candidates) {
            String cls = Json.required(candidate.annotation, "classId"); if (inputsByClass.get(cls).size() < 2) continue;
            JsonObject annotation = candidate.annotation; String type = Json.required(annotation, "type"); RegionGeometry.Region region; int cost;
            if (type.equals("detect") || type.equals("pose")) {
                JsonObject b = Json.object(annotation, "bbox"); double x = Annotations.num(b, "x"), y = Annotations.num(b, "y"), w = Annotations.num(b, "width"), h = Annotations.num(b, "height");
                region = new RegionGeometry.Region(new Area(new Rectangle2D.Double(x, y, w, h)), w * h, x + w / 2, y + h / 2); cost = 4;
            } else { region = RegionGeometry.region(annotation); cost = type.equals("obb") ? 4 : Json.array(annotation, "points").size(); }
            shapes.add(new Shape(candidate, region, region.shape().getBounds2D(), cost));
        }
        shapes.sort(Comparator.comparing((Shape shape) -> Json.required(shape.candidate.annotation, "classId"))
            .thenComparingDouble(shape -> shape.bounds.getMinX()).thenComparing(shape -> Json.required(shape.candidate.annotation, "id")));
        int checks = 0, geometryCost = 0, matches = 0;
        for (int i = 0; i < shapes.size(); i++) for (int j = i + 1; j < shapes.size(); j++) {
            Shape a = shapes.get(i), b = shapes.get(j);
            if (!Json.required(a.candidate.annotation, "classId").equals(Json.required(b.candidate.annotation, "classId")) || b.bounds.getMinX() >= a.bounds.getMaxX()) break;
            if (++checks > MAX_PAIR_CHECKS) { duplicateLimit(issues); return; }
            if (a.candidate.inputId.equals(b.candidate.inputId) || !a.bounds.intersects(b.bounds)) continue;
            geometryCost += a.cost + b.cost;
            if (geometryCost > MAX_GEOMETRY_COST || matches >= MAX_DUPLICATE_ISSUES) { duplicateLimit(issues); return; }
            double iou = RegionGeometry.iou(a.region, b.region);
            if (iou >= 0.5) {
                matches++; issues.add(Json.obj("code", "possible_duplicate_object", "severity", "error", "message", "不同输入的同类对象明显重叠，请人工核对；所有候选均已保留。",
                    "annotationIds", Json.arr(a.candidate.annotation.get("id"), b.candidate.annotation.get("id")),
                    "inputIds", Json.arr(a.candidate.inputId, b.candidate.inputId), "iou", iou));
            }
        }
    }
    private static void duplicateLimit(JsonArray issues) {
        issue(issues, null, null, null, "duplicate_check_incomplete", "重叠检查达到计算上限，剩余对象尚未全部检查，需人工复核；未自动删除任何候选。");
    }

    /** 扫描线维护真实 Y 区间并集；完整性独立于浮点面积，不能靠 X/Y 投影乘积推断。 */
    private static Coverage union(List<Rect> rectangles, int width, int height) {
        if (rectangles.isEmpty()) return new Coverage(0, false);
        List<Edge> edges = new ArrayList<>(rectangles.size() * 2); TreeSet<Double> points = new TreeSet<>(); points.add(0.0); points.add((double)height);
        for (Rect rect : rectangles) {
            edges.add(new Edge(rect.x, rect.y, rect.bottom(), 1)); edges.add(new Edge(rect.right(), rect.y, rect.bottom(), -1)); points.add(rect.y); points.add(rect.bottom());
        }
        double[] ys = points.stream().mapToDouble(Double::doubleValue).toArray(); SegmentTree tree = new SegmentTree(ys);
        edges.sort(Comparator.comparingDouble(Edge::x)); double previous = 0, area = 0; boolean complete = true;
        for (int index = 0; index < edges.size();) {
            double x = edges.get(index).x;
            if (x > previous) { area += (x - previous) * tree.length[1]; if (!tree.full[1]) complete = false; }
            while (index < edges.size() && edges.get(index).x == x) {
                Edge edge = edges.get(index++); tree.update(1, 0, ys.length - 2, Arrays.binarySearch(ys, edge.y1), Arrays.binarySearch(ys, edge.y2) - 1, edge.delta);
            }
            previous = x;
        }
        if (previous < width) complete = false;
        return new Coverage(complete ? (double)width * height : area, complete);
    }
    private static final class SegmentTree {
        final double[] coordinates, length; final int[] count; final boolean[] full;
        SegmentTree(double[] coordinates) { this.coordinates = coordinates; length = new double[coordinates.length * 4]; count = new int[length.length]; full = new boolean[length.length]; }
        void update(int node, int left, int right, int start, int end, int delta) {
            if (start <= left && right <= end) count[node] += delta;
            else { int middle = (left + right) / 2; if (start <= middle) update(node * 2, left, middle, start, end, delta); if (end > middle) update(node * 2 + 1, middle + 1, right, start, end, delta); }
            if (count[node] > 0) { length[node] = coordinates[right + 1] - coordinates[left]; full[node] = true; }
            else if (left == right) { length[node] = 0; full[node] = false; }
            else { length[node] = length[node * 2] + length[node * 2 + 1]; full[node] = full[node * 2] && full[node * 2 + 1]; }
        }
    }
    private static Rect rectangle(JsonObject value, int width, int height) {
        double x = number(value.get("x")), y = number(value.get("y")), w = number(value.get("width")), h = number(value.get("height"));
        if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > width || y + h > height) throw invalid("输入覆盖矩形必须完整位于基准图内。");
        return new Rect(x == 0 ? 0 : x, y == 0 ? 0 : y, w, h);
    }
    private static void strictNumbers(JsonObject annotation) {
        if (annotation.has("bbox")) for (String field : List.of("x", "y", "width", "height")) number(object(annotation.get("bbox")).get(field));
        if (annotation.has("rotation")) number(annotation.get("rotation"));
        for (JsonElement value : Json.array(annotation, "points")) { JsonObject point = object(value); number(point.get("x")); number(point.get("y")); }
        for (JsonElement value : Json.array(annotation, "keypoints")) {
            JsonObject point = object(value); int visibility = integer(point, "visibility", 0, 2);
            if (visibility > 0) { number(point.get("x")); number(point.get("y")); }
        }
        if (annotation.has("confidence")) number(annotation.get("confidence"));
    }
    private static void issue(JsonArray issues, String inputId, String resultId, String annotationId, String code, String message) {
        issues.add(Json.obj("inputId", inputId, "resultId", resultId, "annotationId", annotationId, "code", code, "severity", "error", "message", message));
    }
    private static boolean hasErrors(JsonArray issues) {
        for (JsonElement value : issues) if (!Json.str(object(value), "severity", "error").equals("info")) return true; return false;
    }
    private static String text(JsonObject object, String key, int maximum) {
        JsonElement value = object.get(key);
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString() || value.getAsString().isBlank() || value.getAsString().length() > maximum) throw invalid("缺少或无效的标识字段：" + key);
        return value.getAsString();
    }
    private static int integer(JsonObject object, String key, int minimum, int maximum) {
        double value = number(object.get(key)); if (value != Math.rint(value) || value < minimum || value > maximum) throw invalid("整数参数无效：" + key); return (int)value;
    }
    private static double number(JsonElement element) {
        if (element == null || !element.isJsonPrimitive() || !element.getAsJsonPrimitive().isNumber() || !Double.isFinite(element.getAsDouble())) throw invalid("几何数值必须有限。"); return element.getAsDouble();
    }
    private static JsonObject object(JsonElement value) { if (value == null || !value.isJsonObject()) throw invalid("聚合数据必须为对象。"); return value.getAsJsonObject(); }
    private static final class Budget { int nodes = 2_000_000; long text = 32L * 1024 * 1024; }
    private static void bounded(JsonElement value, Budget budget, int depth) {
        if (--budget.nodes < 0 || depth > 40) throw limit("聚合数据量或嵌套深度超过限制。");
        if (value == null || value.isJsonNull()) return;
        if (value.isJsonObject()) for (var entry : value.getAsJsonObject().entrySet()) { budget.text -= entry.getKey().length(); bounded(entry.getValue(), budget, depth + 1); }
        else if (value.isJsonArray()) for (JsonElement item : value.getAsJsonArray()) bounded(item, budget, depth + 1);
        else if (value.getAsJsonPrimitive().isNumber()) number(value);
        else if (value.getAsJsonPrimitive().isString()) budget.text -= value.getAsString().length();
        if (budget.text < 0) throw limit("聚合文本总量超过限制。");
    }
    private static String digest(JsonElement value) {
        MessageDigest digest;
        try { digest = MessageDigest.getInstance("SHA-256"); } catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
        try (JsonWriter writer = new JsonWriter(new OutputStreamWriter(new DigestOutputStream(OutputStream.nullOutputStream(), digest), StandardCharsets.UTF_8))) {
            writer.setSerializeNulls(true); canonical(writer, value);
        } catch (IOException impossible) { throw new UncheckedIOException(impossible); }
        return HexFormat.of().formatHex(digest.digest());
    }
    private static void canonical(JsonWriter writer, JsonElement value) throws IOException {
        if (value == null || value.isJsonNull()) writer.nullValue();
        else if (value.isJsonObject()) { writer.beginObject(); for (String key : new TreeSet<>(value.getAsJsonObject().keySet())) { writer.name(key); canonical(writer, value.getAsJsonObject().get(key)); } writer.endObject(); }
        else if (value.isJsonArray()) { writer.beginArray(); for (JsonElement item : value.getAsJsonArray()) canonical(writer, item); writer.endArray(); }
        else if (value.getAsJsonPrimitive().isNumber()) writer.jsonValue(new BigDecimal(value.getAsString()).stripTrailingZeros().toPlainString());
        else if (value.getAsJsonPrimitive().isBoolean()) writer.value(value.getAsBoolean()); else writer.value(value.getAsString());
    }
    private static ApiError invalid(String message) { return new ApiError(422, "input_aggregation_invalid", message); }
    private static ApiError limit(String message) { return new ApiError(413, "input_aggregation_limit", message); }
}
