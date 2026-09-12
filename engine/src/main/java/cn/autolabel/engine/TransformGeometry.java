package cn.autolabel.engine;

import com.google.gson.*;
import java.awt.geom.*;
import java.util.*;

/** 只处理基准图几何；文件生成、候选持久化与人工复核由调用方负责。 */
final class TransformGeometry {
    static final String VERSION = "baseline-transform-v1";
    static final String MAPPING_VERSION = "baseline-mapping-v1";
    private static final String DIAGNOSTIC_MAPPING_VERSION = "segment-diagnostic-mapping-v1";
    static final int MAX_STEPS = 30, MAX_VIEWS = 10000, MAX_POINTS = 65536;
    static final double ROUND_OFF = 1e-7;
    private static final Matrix IDENTITY = new Matrix(1, 0, 0, 0, 1, 0);

    private record Rect(double x, double y, double width, double height) {
        double right() { return x + width; }
        double bottom() { return y + height; }
        boolean empty() { return width <= 0 || height <= 0; }
        boolean contains(double px, double py) { return px >= x && py >= y && px <= right() && py <= bottom(); }
        Rect intersect(Rect other) {
            double left = Math.max(x, other.x), top = Math.max(y, other.y);
            return new Rect(left, top, Math.max(0, Math.min(right(), other.right()) - left),
                Math.max(0, Math.min(bottom(), other.bottom()) - top));
        }
        JsonObject json() { return Json.obj("x", x, "y", y, "width", width, "height", height); }
        Area area() { return new Area(new Rectangle2D.Double(x, y, width, height)); }
    }

    private record Matrix(double a, double b, double c, double d, double e, double f) {
        double x(double x, double y) { return a * x + b * y + c; }
        double y(double x, double y) { return d * x + e * y + f; }
        Matrix after(Matrix previous) {
            return new Matrix(a * previous.a + b * previous.d, a * previous.b + b * previous.e,
                a * previous.c + b * previous.f + c, d * previous.a + e * previous.d,
                d * previous.b + e * previous.e, d * previous.c + e * previous.f + f);
        }
        Matrix inverse() {
            double determinant = a * e - b * d;
            if (!Double.isFinite(determinant) || determinant == 0) throw invalid("坐标变换不可逆。");
            return new Matrix(e / determinant, -b / determinant, (b * f - e * c) / determinant,
                -d / determinant, a / determinant, (d * c - a * f) / determinant);
        }
        Rect rect(Rect r) {
            double left = x(r.x, r.y), top = y(r.x, r.y);
            return new Rect(left, top, a * r.width, e * r.height);
        }
        JsonArray json() { return Json.arr(a, b, c, d, e, f); }
    }

    private record View(String id, Matrix matrix, Rect valid, JsonObject tile) {}

    /** 公共步骤只保存一次，避免切片数乘步骤数放大持久化计划。 */
    static JsonObject plan(JsonObject baseline, JsonArray operations) {
        keys(baseline, Set.of("assetId", "contentHash", "width", "height", "normalizationVersion", "inputVersion"));
        text(baseline, "assetId", 160); text(baseline, "normalizationVersion", 160);
        String hash = text(baseline, "contentHash", 64);
        if (!hash.matches("[0-9a-fA-F]{64}")) throw invalid("基准图内容摘要无效。");
        integer(baseline, "inputVersion", 1, Integer.MAX_VALUE);
        int rootWidth = integer(baseline, "width", 1, 20000), rootHeight = integer(baseline, "height", 1, 20000);
        dimensions(rootWidth, rootHeight);
        if (operations.size() > MAX_STEPS) throw invalid("图像处理步骤不能超过 30 个。");
        int width = rootWidth, height = rootHeight;
        List<View> views = new ArrayList<>();
        views.add(new View("view-00000", IDENTITY, new Rect(0, 0, width, height), null));
        JsonArray normalized = new JsonArray(), steps = new JsonArray(); boolean tiled = false;
        for (int index = 0; index < operations.size(); index++) {
            JsonObject operation = object(operations.get(index), "图像处理步骤");
            String kind = text(operation, "kind", 20); int previousWidth = width, previousHeight = height;
            JsonObject fixed; Matrix local = null;
            switch (kind) {
                case "crop" -> {
                    keys(operation, Set.of("kind", "x", "y", "width", "height"));
                    int x = integer(operation, "x", 0, width), y = integer(operation, "y", 0, height);
                    int w = integer(operation, "width", 1, width), h = integer(operation, "height", 1, height);
                    if ((long)x + w > width || (long)y + h > height) throw invalid("裁剪矩形必须完整位于当前图像内。");
                    fixed = Json.obj("kind", kind, "x", x, "y", y, "width", w, "height", h);
                    local = new Matrix(1, 0, -x, 0, 1, -y); width = w; height = h;
                }
                case "resize" -> {
                    keys(operation, Set.of("kind", "width", "height", "fit"));
                    int w = integer(operation, "width", 1, 20000), h = integer(operation, "height", 1, 20000);
                    dimensions(w, h); String fit = optionalText(operation, "fit", "contain", 20);
                    if (!Set.of("contain", "stretch").contains(fit)) throw invalid("缩放方式必须为 contain 或 stretch。");
                    double sx = (double)w / width, sy = (double)h / height, dx = 0, dy = 0;
                    if (fit.equals("contain")) { sx = sy = Math.min(sx, sy); dx = (w - width * sx) / 2; dy = (h - height * sy) / 2; }
                    fixed = Json.obj("kind", kind, "width", w, "height", h, "fit", fit);
                    local = new Matrix(sx, 0, dx, 0, sy, dy); width = w; height = h;
                }
                case "tile" -> {
                    if (tiled) throw invalid("同一图像处理计划最多执行一次切片。");
                    keys(operation, Set.of("kind", "width", "height", "overlapX", "overlapY"));
                    int w = integer(operation, "width", 1, width), h = integer(operation, "height", 1, height);
                    int overlapX = optionalInteger(operation, "overlapX", 0, 0, w - 1);
                    int overlapY = optionalInteger(operation, "overlapY", 0, 0, h - 1);
                    List<Integer> xs = positions(width, w, w - overlapX), ys = positions(height, h, h - overlapY);
                    if ((long)xs.size() * ys.size() > MAX_VIEWS) throw invalid("单图切片数超过 10000，未截断执行范围。");
                    View parent = views.getFirst(); List<View> children = new ArrayList<>(xs.size() * ys.size());
                    for (int row = 0; row < ys.size(); row++) for (int col = 0; col < xs.size(); col++) {
                        int x = xs.get(col), y = ys.get(row); Matrix crop = new Matrix(1, 0, -x, 0, 1, -y);
                        Rect valid = crop.rect(parent.valid).intersect(new Rect(0, 0, w, h));
                        if (valid.empty()) throw invalid("切片仅包含留边区域，请调整切片或先裁掉留边。");
                        JsonObject tile = Json.obj("stepIndex", index, "row", row, "column", col,
                            "x", x, "y", y, "width", w, "height", h);
                        children.add(new View(String.format(Locale.ROOT, "view-%05d", children.size()), crop.after(parent.matrix), valid, tile));
                    }
                    views = children; width = w; height = h; tiled = true;
                    fixed = Json.obj("kind", kind, "width", w, "height", h, "overlapX", overlapX, "overlapY", overlapY);
                }
                default -> throw invalid("不支持的图像处理步骤：" + kind);
            }
            if (local != null) {
                List<View> updated = new ArrayList<>(views.size());
                for (View view : views) {
                    Rect valid = local.rect(view.valid).intersect(new Rect(0, 0, width, height));
                    if (valid.empty()) throw invalid("处理结果只包含留边区域，没有基准图像内容。");
                    updated.add(new View(view.id, local.after(view.matrix), valid, view.tile));
                }
                views = updated;
            }
            normalized.add(fixed);
            steps.add(Json.obj("index", index, "kind", kind, "inputWidth", previousWidth, "inputHeight", previousHeight,
                "outputWidth", width, "outputHeight", height, "forward", local == null ? null : local.json(),
                "inverse", local == null ? null : local.inverse().json()));
        }
        JsonArray entries = new JsonArray(); List<Rect> regions = new ArrayList<>(views.size());
        for (View view : views) {
            Matrix inverse = view.matrix.inverse(); Rect region = inverse.rect(view.valid).intersect(new Rect(0, 0, rootWidth, rootHeight));
            if (region.empty()) throw invalid("处理计划没有有效基准图覆盖范围。");
            regions.add(region);
            entries.add(Json.obj("viewId", view.id, "width", width, "height", height, "baselineToInput", view.matrix.json(),
                "inputToBaseline", inverse.json(), "validInputRect", view.valid.json(), "baselineCoverageRect", region.json(), "tile", view.tile));
        }
        // 单次规则网格切片及后续公共操作保持 X/Y 笛卡尔积，可线性存储区间并排序求覆盖。
        double coverageArea = unionLength(regions, true) * unionLength(regions, false);
        return Json.obj("version", VERSION, "coordinateSpace", "baseline_pixel_edges", "baseline", baseline.deepCopy(),
            "operations", normalized, "steps", steps, "views", entries, "coverageArea", coverageArea,
            "coversWholeBaseline", Math.abs(coverageArea - (double)rootWidth * rootHeight) <= ROUND_OFF,
            "roundOffTolerancePx", ROUND_OFF);
    }

    static final class PreparedPlan {
        private final JsonObject fixed;
        private final Map<String, JsonObject> views = new HashMap<>();
        private PreparedPlan(JsonObject fixed) {
            this.fixed = fixed;
            for (JsonElement value : Json.array(fixed, "views")) {
                JsonObject view = value.getAsJsonObject(); views.put(Json.required(view, "viewId"), view);
            }
        }
        JsonObject json() { return fixed.deepCopy(); }
        JsonObject forward(String viewId, JsonArray annotations, JsonObject project) {
            return map(this, viewId, annotations, project, false, null);
        }
        JsonObject forward(String viewId, JsonObject inputResult, JsonObject project) {
            return map(this, viewId, resultAnnotations(inputResult), project, false, inputResult);
        }
        // 数组入口只用于没有上游诊断的原始输出；已有候选必须传完整结果封装。
        JsonObject inverse(String viewId, JsonArray annotations, JsonObject project) {
            return map(this, viewId, annotations, project, true, null);
        }
        JsonObject inverse(String viewId, JsonObject inputResult, JsonObject project) {
            return map(this, viewId, resultAnnotations(inputResult), project, true, inputResult);
        }
    }

    /** 重建后比较全部派生字段，拒绝被改写的矩阵、有效区、尺寸和缺失切片。批处理只读取一次。 */
    static PreparedPlan readPlan(JsonObject persisted) {
        boundedTree(persisted, new int[]{1_500_000}, 0);
        if (!VERSION.equals(Json.str(persisted, "version", ""))) throw invalid("坐标变换计划版本不支持。");
        JsonObject baseline = object(persisted.get("baseline"), "基准图");
        if (!persisted.has("operations") || !persisted.get("operations").isJsonArray()) throw invalid("坐标计划缺少操作清单。");
        JsonObject expected = plan(baseline, persisted.getAsJsonArray("operations"));
        if (!expected.equals(persisted)) throw invalid("坐标计划与操作清单不一致，不能使用被改写的变换或覆盖范围。");
        return new PreparedPlan(expected);
    }

    static JsonObject forward(JsonObject plan, String viewId, JsonArray annotations, JsonObject project) {
        return readPlan(plan).forward(viewId, annotations, project);
    }
    static JsonObject forward(JsonObject plan, String viewId, JsonObject inputResult, JsonObject project) {
        return readPlan(plan).forward(viewId, inputResult, project);
    }
    static JsonObject inverse(JsonObject plan, String viewId, JsonArray annotations, JsonObject project) {
        return readPlan(plan).inverse(viewId, annotations, project);
    }
    static JsonObject inverse(JsonObject plan, String viewId, JsonObject inputResult, JsonObject project) {
        return readPlan(plan).inverse(viewId, inputResult, project);
    }
    static JsonObject mapPoint(JsonArray matrix, JsonObject point) {
        Matrix m = matrix(matrix); double x = number(point, "x"), y = number(point, "y");
        double px = m.x(x, y), py = m.y(x, y);
        if (!Double.isFinite(px) || !Double.isFinite(py)) throw invalid("坐标变换溢出。");
        return Json.obj("x", px, "y", py);
    }

    private static JsonObject map(PreparedPlan prepared, String viewId, JsonArray input, JsonObject project,
                                  boolean inverse, JsonObject upstream) {
        JsonObject view = prepared.views.get(viewId);
        if (view == null) throw invalid("所选视图不属于坐标变换计划。");
        boundedTree(input, new int[]{500_000}, 0);
        if (input.size() > 10000) throw invalid("单图对象不能超过 10000。");
        int points = 0;
        for (JsonElement value : input) {
            JsonObject annotation = object(value, "标注对象");
            points += Json.array(annotation, "points").size() + Json.array(annotation, "keypoints").size();
            if (points > MAX_POINTS) throw invalid("单次坐标映射顶点总数超过限制，请拆分处理。");
        }
        JsonObject baseline = Json.object(prepared.fixed, "baseline");
        int width = Json.integer(inverse ? baseline : view, "width", 0), height = Json.integer(inverse ? baseline : view, "height", 0);
        JsonObject inputAsset = inverse ? view : baseline;
        if (upstream != null) verifyEnvelope(upstream, view, baseline, inputAsset, inverse);
        if (upstream != null) diagnosticBounds(upstream, points, inverse);
        Matrix matrix = matrix(Json.array(view, inverse ? "inputToBaseline" : "baselineToInput"));
        Rect coverage = rect(Json.object(view, "baselineCoverageRect")), valid = rect(Json.object(view, "validInputRect"));
        JsonArray annotations = new JsonArray(), items = new JsonArray(), issues = new JsonArray();
        Set<String> ids = new HashSet<>(); int[] snaps = {0};
        String task = text(project, "taskType", 20);
        if (!Annotations.TYPES.contains(task)) throw invalid("项目标注类型无效。");
        boolean wholeView = full(coverage, Json.integer(baseline, "width", 0), Json.integer(baseline, "height", 0));
        for (int index = 0; index < input.size(); index++) {
            JsonObject original = input.get(index).getAsJsonObject().deepCopy();
            String id = Json.str(original, "id", "invalid-" + index);
            JsonObject item = Json.obj("annotationId", id, "outcome", "mapped", "annotation", null);
            JsonArray objectIssues = new JsonArray(); JsonObject candidate = null;
            try {
                if (!ids.add(id)) throw Annotations.error("标注对象 ID 不能重复。");
                if (task.equals("segment") && unsupportedSegment(original)) throw Annotations.error("当前标注结构不支持孔洞、多轮廓或掩码，不能忽略后转换。");
                if (task.equals("classify") && input.size() > 1) throw Annotations.error("单图分类至多一个类别。");
                strictGeometryNumbers(original);
                JsonObject source = Annotations.validate(Json.arr(original), inputAsset, project).get(0).getAsJsonObject();
                if (!inside(source, new Rect(0, 0, Json.integer(inputAsset, "width", 0), Json.integer(inputAsset, "height", 0))))
                    throw Annotations.error("输入几何超出图像范围；不能将原始越界坐标作为浮点舍入误差修正。");
                JsonObject raw = transformed(source, matrix, width, height, snaps);
                item.add("rawMappedGeometry", geometryOnly(raw));
                if (task.equals("classify")) {
                    candidate = raw;
                    if (!wholeView) issue(objectIssues, id, "classification_scope_changed", "classId", "裁剪或切片改变了图片语义范围，请人工核对类别。");
                } else if (inverse) {
                    if (!inside(source, valid)) issue(objectIssues, id, "geometry_in_padding", "geometry", "预测几何进入留边区域，不能自动裁掉后采用。");
                    if (touchesArtificialBoundary(source, valid, coverage, baseline))
                        issue(objectIssues, id, "possible_object_truncation", "geometry", "对象触及基准图内部的裁剪或切片边界，请核对是否截断。");
                    candidate = raw;
                } else {
                    candidate = clipForward(source, raw, coverage, matrix, width, height, item, objectIssues, snaps);
                }
                if (candidate != null) {
                    try { candidate = Annotations.validate(Json.arr(candidate), Json.obj("width", width, "height", height), project).get(0).getAsJsonObject(); }
                    catch (ApiError error) {
                        issue(objectIssues, id, task.equals("obb") ? "obb_not_representable" : "mapped_geometry_invalid", "geometry", error.getMessage());
                        candidate = null;
                    }
                }
            } catch (ApiError | IllegalStateException | ClassCastException | NumberFormatException error) {
                issue(objectIssues, id, "input_geometry_invalid", "geometry", error instanceof ApiError ? error.getMessage() : "标注结构无效，保留原始对象供诊断。");
                item.add("sourceGeometry", original);
                // 越界等输入错误仍可显示精确回映诊断，但绝不据此恢复为合法候选。
                try { item.add("rawMappedGeometry", geometryOnly(transformed(original, matrix, width, height, new int[]{0}))); }
                catch (RuntimeException ignored) { /* 结构缺失时仅保留来源诊断。 */ }
            }
            if (!objectIssues.isEmpty()) item.addProperty("outcome", "review");
            if (candidate != null) { item.add("annotation", candidate); annotations.add(candidate); }
            item.add("geometryIssues", objectIssues); items.add(item); issues.addAll(objectIssues);
        }
        if (task.equals("classify") && input.isEmpty()) issue(issues, null, "classification_missing", "annotations", "分类没有返回类别，不能作为有效空标签。");
        if (upstream != null) carryReview(upstream, items, issues);
        JsonArray diagnostics = upstream == null ? new JsonArray() : mapDiagnostics(upstream, matrix, view, baseline, inverse, issues);
        if (snaps[0] > 0) issues.add(Json.obj("annotationId", null, "code", "arithmetic_roundoff_normalized", "severity", "info",
            "field", "geometry", "message", "仅对坐标运算产生的边界浮点误差进行了归一化。", "count", snaps[0], "tolerancePx", ROUND_OFF));
        boolean review = hasErrors(issues);
        return Json.obj("version", MAPPING_VERSION, "transformVersion", VERSION, "direction", inverse ? "inverse" : "forward",
            "viewId", viewId, "baselineAssetId", baseline.get("assetId"), "baselineContentHash", baseline.get("contentHash"),
            "inputTransform", view.deepCopy(),
            "coordinateSpace", inverse ? "baseline" : "input", "width", width, "height", height,
            "annotations", annotations, "items", items, "geometryIssues", issues, "geometryDiagnostics", diagnostics, "requiresGeometryReview", review,
            "coverage", Json.obj("baselineRect", coverage.json(), "validInputRect", valid.json(), "viewCoversWholeBaseline", wholeView,
                "planCoversWholeBaseline", prepared.fixed.get("coversWholeBaseline")),
            "emptyMeaning", annotations.isEmpty() ? review ? "unresolved_geometry" : inverse ? "no_reported_objects" : "no_visible_source_annotations" : null);
    }

    private static JsonObject clipForward(JsonObject source, JsonObject raw, Rect coverage, Matrix matrix, int width, int height,
                                           JsonObject item, JsonArray issues, int[] snaps) {
        String task = Json.required(source, "type"), id = Json.required(source, "id");
        if (task.equals("detect") || task.equals("pose")) {
            Rect box = rect(Json.object(source, "bbox")), clipped = box.intersect(coverage);
            if (clipped.empty()) {
                boolean retainedPoint = task.equals("pose") && Json.array(source, "keypoints").asList().stream().anyMatch(value -> {
                    JsonObject point = value.getAsJsonObject(); return Json.integer(point, "visibility", 0) > 0 && coverage.contains(number(point, "x"), number(point, "y"));
                });
                if (retainedPoint) issue(issues, id, "pose_point_without_visible_bbox", "bbox", "对象框位于裁剪区外但仍有可定位点在区内，请检查对象框。");
                else excluded(item);
                return null;
            }
            JsonObject candidate = raw.deepCopy(); candidate.add("bbox", snappedRect(matrix.rect(clipped), width, height, snaps).json());
            if (!same(box, clipped)) issue(issues, id, "object_truncated", "bbox", "裁剪仅保留了对象的一部分，请核对后采用。");
            if (task.equals("pose")) {
                JsonArray dispositions = new JsonArray(), mapped = Json.array(candidate, "keypoints");
                for (int i = 0; i < mapped.size(); i++) {
                    JsonObject original = Json.array(source, "keypoints").get(i).getAsJsonObject(), point = mapped.get(i).getAsJsonObject();
                    int visibility = Json.integer(original, "visibility", 0);
                    if (visibility > 0 && !coverage.contains(number(original, "x"), number(original, "y"))) {
                        dispositions.add(Json.obj("index", i, "name", original.get("name"), "reason", "outside_view",
                            "sourcePoint", original.deepCopy(), "rawMappedPoint", point.deepCopy()));
                        point.addProperty("x", 0); point.addProperty("y", 0); point.addProperty("visibility", 0);
                        issue(issues, id, "keypoint_cropped", "keypoints." + i, "裁剪移除了已定位关键点；视图候选暂记不可定位并保留来源点。");
                    }
                }
                item.add("pointDispositions", dispositions);
            }
            return candidate;
        }
        Area area = RegionGeometry.region(source).shape(), intersection = (Area)area.clone(); intersection.intersect(coverage.area());
        if (intersection.isEmpty()) { excluded(item); return null; }
        Area lost = (Area)area.clone(); lost.subtract(coverage.area());
        if (lost.isEmpty()) return raw;
        issue(issues, id, "object_truncated", "points", "裁剪仅保留了区域的一部分，请核对后采用。");
        JsonArray rings = rings(intersection, matrix, width, height, snaps);
        item.add("previewRings", Json.obj("rings", rings, "fillRule", "evenOdd", "coordinateSpace", "input"));
        item.addProperty("retainedArea", RegionGeometry.area(intersection));
        if (rings.size() != 1) {
            issue(issues, id, "segment_multi_ring_unsupported", "points", "交集包含多个边界，已保留全部路径；不能连接、取最大轮廓或填洞后导出。"); return null;
        }
        JsonObject candidate = raw.deepCopy(); candidate.add("points", rings.get(0)); return candidate;
    }

    private static void carryReview(JsonObject upstream, JsonArray items, JsonArray issues) {
        boundedTree(upstream, new int[]{1_500_000}, 0);
        JsonArray prior = Json.array(upstream, "geometryIssues");
        for (JsonElement value : prior) {
            JsonObject issue = object(value, "上游几何问题").deepCopy(); issue.addProperty("inherited", true); issues.add(issue);
        }
        if (Json.bool(upstream, "requiresGeometryReview", false) && !hasErrors(prior))
            issue(issues, null, "upstream_geometry_review_required", "geometry", "上游结果尚有未解决的几何复核问题，回映不会自动清除。");
        Map<String, JsonObject> mapped = new HashMap<>();
        for (JsonElement value : items) mapped.putIfAbsent(Json.str(value.getAsJsonObject(), "annotationId", ""), value.getAsJsonObject());
        for (JsonElement value : Json.array(upstream, "items")) {
            JsonObject previous = object(value, "上游对象诊断"); String id = Json.str(previous, "annotationId", "");
            if (!Json.str(previous, "outcome", "").equals("review")) continue;
            JsonObject diagnostic = Json.obj("coordinateSpace", Json.str(upstream, "coordinateSpace", "input"),
                "viewId", upstream.get("viewId"), "width", upstream.get("width"), "height", upstream.get("height"),
                "rawMappedGeometry", previous.get("rawMappedGeometry"), "previewRings", previous.get("previewRings"),
                "pointDispositions", previous.get("pointDispositions"), "sourceGeometry", previous.get("sourceGeometry"));
            JsonObject destination = mapped.get(id);
            if (destination != null) {
                destination.addProperty("outcome", "review"); destination.add("upstreamDiagnostic", diagnostic.deepCopy());
            } else {
                destination = Json.obj("annotationId", id, "outcome", "review", "annotation", null, "upstreamDiagnostic", diagnostic.deepCopy());
                items.add(destination); mapped.put(id, destination);
            }
            issue(issues, id, "upstream_geometry_review_required", "geometry", "该对象的上游复核尚未解决，不能通过回映消除。");
        }
    }

    private static void diagnosticBounds(JsonObject upstream, int annotationPoints, boolean inverse) {
        if (!upstream.has("geometryDiagnostics")) return;
        boundedTree(upstream, new int[]{1_500_000}, 0);
        if (!upstream.get("geometryDiagnostics").isJsonArray()) throw invalid("完整几何诊断必须为数组。");
        JsonArray diagnostics = Json.array(upstream, "geometryDiagnostics");
        if (diagnostics.size() > 10000) throw invalid("完整几何诊断数量超过限制。");
        long points = annotationPoints; String expected = inverse ? "input" : "baseline";
        for (JsonElement raw : diagnostics) {
            if (!raw.isJsonObject()) continue;
            JsonObject source = raw.getAsJsonObject(); String space = text(source, "coordinateSpace", 32);
            boolean workerSpace = space.equals("baseline_pixels") && !source.has("diagnosticMappingVersion") && !source.has("maskToMapped");
            if (!workerSpace && !space.equals(expected)) throw invalid("完整几何诊断坐标空间不匹配，不能重复回映。");
            if (source.has("diagnosticMappingVersion") && !DIAGNOSTIC_MAPPING_VERSION.equals(text(source, "diagnosticMappingVersion", 80)))
                throw invalid("完整几何诊断映射版本不受支持。");
            if (source.has("rings") && source.get("rings").isJsonArray()) {
                JsonArray rings = Json.array(source, "rings");
                if (rings.size() > 4096) throw invalid("单项完整几何诊断的环数超过限制。");
                for (JsonElement ring : rings) if (ring.isJsonObject() && ring.getAsJsonObject().has("points") && ring.getAsJsonObject().get("points").isJsonArray()) {
                    points += Json.array(ring.getAsJsonObject(), "points").size();
                    if (points > MAX_POINTS) throw invalid("标注与完整诊断的顶点总数超过限制。");
                }
            }
        }
    }

    private static JsonArray mapDiagnostics(JsonObject upstream, Matrix transform, JsonObject view, JsonObject baseline, boolean inverse, JsonArray issues) {
        JsonArray output = new JsonArray(); String targetSpace = inverse ? "baseline" : "input";
        for (JsonElement raw : Json.array(upstream, "geometryDiagnostics")) {
            JsonObject mapped = Json.obj("diagnosticMappingVersion", DIAGNOSTIC_MAPPING_VERSION, "coordinateSpace", targetSpace,
                "viewId", view.get("viewId"), "baselineAssetId", baseline.get("assetId"), "baselineContentHash", baseline.get("contentHash"),
                "width", (inverse ? baseline : view).get("width"), "height", (inverse ? baseline : view).get("height"));
            String annotationId = null;
            try {
                JsonObject source = object(raw, "完整几何诊断"); annotationId = text(source, "annotationId", 160);
                mapped.addProperty("annotationId", annotationId);
                // 保留最初的完整诊断，往返映射不层层嵌套副本，也不将旧矩阵冒充目标矩阵。
                mapped.add("sourceDiagnostic", source.has("sourceDiagnostic") ? source.get("sourceDiagnostic").deepCopy() : source.deepCopy());
                mapped.addProperty("sourceCoordinateSpace", text(source, "coordinateSpace", 32));
                if (source.has("mappingStatus") && !text(source, "mappingStatus", 20).equals("mapped")) throw invalid("上游完整几何诊断尚未通过映射校验。");
                if (source.has("viewId") && !text(source, "viewId", 160).equals(Json.required(view, "viewId"))) throw invalid("完整几何诊断来自不同视图。");
                if (source.has("baselineAssetId") && !text(source, "baselineAssetId", 160).equals(Json.required(baseline, "assetId"))
                    || source.has("baselineContentHash") && !text(source, "baselineContentHash", 64).equals(Json.required(baseline, "contentHash"))) throw invalid("完整几何诊断来自不同基准图。");
                for (String field : List.of("width", "height")) if (source.has(field) && integer(source, field, 1, 20000) != Json.integer(inverse ? view : baseline, field, 0))
                    throw invalid("完整几何诊断尺寸与映射输入不匹配。");
                int maskWidth = integer(source, "maskWidth", 1, 20000), maskHeight = integer(source, "maskHeight", 1, 20000); dimensions(maskWidth, maskHeight);
                String matrixField = source.has("diagnosticMappingVersion") ? "maskToMapped" : "maskToBaseline";
                if (!source.has(matrixField) || !source.get(matrixField).isJsonArray()) throw invalid("完整几何诊断缺少掩码坐标矩阵。");
                Matrix composed = matrix(transform.after(matrix(Json.array(source, matrixField))).json());
                if (!source.has("rings") || !source.get("rings").isJsonArray()) throw invalid("完整几何诊断缺少全部环。");
                JsonArray rings = Json.array(source, "rings"); Map<Integer, JsonObject> byId = new LinkedHashMap<>(); Map<Integer, Integer> parents = new HashMap<>();
                int outer = 0, holes = 0;
                for (JsonElement value : rings) {
                    JsonObject ring = object(value, "诊断环"); int id = integer(ring, "ringId", 0, 4095);
                    if (byId.putIfAbsent(id, ring) != null) throw invalid("完整几何诊断存在重复环标识。");
                    if (!ring.has("parentRingId")) throw invalid("诊断环缺少父环标识。");
                    parents.put(id, ring.get("parentRingId").isJsonNull() ? null : integer(ring, "parentRingId", 0, 4095));
                    int depth = integer(ring, "depth", 0, 4095);
                    if (!ring.has("hole") || !ring.get("hole").isJsonPrimitive() || !ring.getAsJsonPrimitive("hole").isBoolean()
                        || ring.get("hole").getAsBoolean() != (depth % 2 == 1)) throw invalid("诊断环的孔洞标记与层级不一致。");
                    if (depth % 2 == 1) holes++; else outer++;
                }
                Set<Integer> complete = new HashSet<>();
                for (int id : byId.keySet()) {
                    Set<Integer> chain = new HashSet<>(); Integer cursor = id;
                    while (cursor != null && !complete.contains(cursor)) {
                        if (!byId.containsKey(cursor)) throw invalid("诊断环引用了不存在的父环。");
                        if (!chain.add(cursor)) throw invalid("完整几何诊断的父环存在循环。");
                        cursor = parents.get(cursor);
                    }
                    complete.addAll(chain);
                }
                for (String field : List.of("degenerate", "outOfBounds", "requiresGeometryReview")) if (source.has(field)
                    && (!source.get(field).isJsonPrimitive() || !source.getAsJsonPrimitive(field).isBoolean())) throw invalid("完整几何诊断标记必须为布尔值。");
                JsonArray transformedRings = new JsonArray(); boolean outside = Json.bool(source, "outOfBounds", false), degenerate = Json.bool(source, "degenerate", false);
                for (var entry : byId.entrySet()) {
                    JsonObject ring = entry.getValue(); Integer parent = parents.get(entry.getKey());
                    if (integer(ring, "depth", 0, 4095) != (parent == null ? 0 : integer(byId.get(parent), "depth", 0, 4095) + 1)) throw invalid("诊断环深度与父环不一致。");
                    if (!ring.has("points") || !ring.get("points").isJsonArray()) throw invalid("诊断环缺少完整顶点数组。");
                    if (Json.array(ring, "points").size() < 3) degenerate = true;
                    JsonArray transformedPoints = new JsonArray();
                    for (JsonElement point : Json.array(ring, "points")) {
                        JsonObject original = object(point, "诊断环顶点"); double x = number(original, "x"), y = number(original, "y");
                        double tx = transform.x(x, y), ty = transform.y(x, y);
                        if (!Double.isFinite(tx) || !Double.isFinite(ty)) throw invalid("诊断环回映产生了非有限坐标。");
                        outside |= tx < 0 || ty < 0 || tx > Json.integer(inverse ? baseline : view, "width", 0) || ty > Json.integer(inverse ? baseline : view, "height", 0);
                        transformedPoints.add(Json.obj("x", tx, "y", ty));
                    }
                    JsonObject copied = ring.deepCopy(); copied.add("points", transformedPoints); transformedRings.add(copied);
                }
                if (source.has("outerCount") && integer(source, "outerCount", 0, 4096) != outer
                    || source.has("holeCount") && integer(source, "holeCount", 0, 4096) != holes) throw invalid("完整几何诊断环计数不一致。");
                boolean review = outer != 1 || holes > 0 || degenerate || outside || Json.bool(source, "requiresGeometryReview", false);
                mapped.addProperty("mappingStatus", "mapped"); mapped.addProperty("maskWidth", maskWidth); mapped.addProperty("maskHeight", maskHeight);
                mapped.add("maskToMapped", composed.json()); mapped.add("rings", transformedRings); mapped.addProperty("outerCount", outer); mapped.addProperty("holeCount", holes);
                mapped.addProperty("degenerate", degenerate); mapped.addProperty("outOfBounds", outside); mapped.addProperty("requiresGeometryReview", review);
                if (review) issue(issues, annotationId, "geometry_diagnostic_review_required", "geometryDiagnostics", "完整轮廓仍有未解决的复核要求，坐标映射不会使其可采用。");
            } catch (ApiError | IllegalStateException | ClassCastException | NumberFormatException error) {
                mapped.add("sourceDiagnostic", raw.deepCopy());
                mapped.addProperty("mappingStatus", "invalid"); mapped.addProperty("requiresGeometryReview", true);
                mapped.add("mappingError", Json.obj("code", "geometry_diagnostic_invalid", "message", error instanceof ApiError ? error.getMessage() : "完整几何诊断结构无效。"));
                issue(issues, annotationId, "geometry_diagnostic_invalid", "geometryDiagnostics", "完整诊断无法可靠映射，已保留全部源诊断，请人工处理。");
            }
            output.add(mapped);
        }
        return output;
    }

    static void assertExportable(JsonObject mapping) {
        if (!MAPPING_VERSION.equals(Json.str(mapping, "version", "")) || !mapping.has("requiresGeometryReview")
            || Json.bool(mapping, "requiresGeometryReview", true) || hasErrors(Json.array(mapping, "geometryIssues")))
            throw new ApiError(422, "geometry_review_required", "坐标回映仍有未解决的几何问题，请修正当前版本后导出。");
        for (JsonElement value : Json.array(mapping, "items"))
            if (Json.str(value.getAsJsonObject(), "outcome", "").equals("review"))
                throw new ApiError(422, "geometry_review_required", "存在未解决的对象几何诊断。");
    }

    private static JsonObject transformed(JsonObject source, Matrix m, int width, int height, int[] snaps) {
        JsonObject result = source.deepCopy(); String type = Json.required(source, "type");
        if (Set.of("detect", "pose").contains(type)) result.add("bbox", snappedRect(m.rect(rect(Json.object(source, "bbox"))), width, height, snaps).json());
        if (Set.of("segment", "obb").contains(type)) {
            JsonArray input = type.equals("obb") ? Annotations.obb(source) : Json.array(source, "points"), output = new JsonArray();
            for (JsonElement value : input) output.add(transformedPoint(value.getAsJsonObject(), m, width, height, snaps));
            result.add("points", output); result.remove("bbox"); result.remove("rotation");
        }
        if (type.equals("pose")) {
            JsonArray keypoints = new JsonArray();
            for (JsonElement value : Json.array(source, "keypoints")) {
                JsonObject original = value.getAsJsonObject(), point = original.deepCopy();
                if (Json.integer(original, "visibility", -1) == 0) { point.addProperty("x", 0); point.addProperty("y", 0); }
                else { JsonObject mapped = transformedPoint(original, m, width, height, snaps); point.add("x", mapped.get("x")); point.add("y", mapped.get("y")); }
                keypoints.add(point);
            }
            result.add("keypoints", keypoints);
        }
        return result;
    }

    private static JsonObject geometryOnly(JsonObject value) {
        JsonObject geometry = new JsonObject();
        for (String key : List.of("type", "bbox", "rotation", "points", "keypoints", "classId")) if (value.has(key)) geometry.add(key, value.get(key).deepCopy());
        return geometry;
    }
    private static JsonArray resultAnnotations(JsonObject result) {
        if (!result.has("annotations") || !result.get("annotations").isJsonArray()) throw invalid("坐标映射输入缺少标注数组。");
        return result.getAsJsonArray("annotations");
    }
    private static void verifyEnvelope(JsonObject result, JsonObject view, JsonObject baseline, JsonObject inputAsset, boolean inverse) {
        for (String field : List.of("width", "height"))
            if (result.has(field) && integer(result, field, 1, 20000) != Json.integer(inputAsset, field, 0))
                throw invalid("模型结果尺寸与固定输入视图不一致。");
        if (result.has("coordinateSpace") && !text(result, "coordinateSpace", 20).equals(inverse ? "input" : "baseline"))
            throw invalid("结果坐标空间不匹配，不能重复回映或将输入坐标当作基准图坐标。");
        if (result.has("baselineAssetId") && !text(result, "baselineAssetId", 160).equals(Json.required(baseline, "assetId"))
            || result.has("baselineContentHash") && !text(result, "baselineContentHash", 64).equals(Json.required(baseline, "contentHash")))
            throw invalid("结果不属于当前固定基准图。");
        if (result.has("transformVersion") && !text(result, "transformVersion", 80).equals(VERSION))
            throw invalid("上游坐标变换版本不支持。");
        if (inverse && (result.has("viewId") && !text(result, "viewId", 160).equals(Json.required(view, "viewId"))
            || result.has("inputTransform") && !view.equals(result.get("inputTransform"))))
            throw invalid("结果来自不同的切片或变换计划，不能使用当前逆矩阵。");
    }
    private static boolean unsupportedSegment(JsonObject a) {
        for (String field : List.of("holes", "rings", "contours", "components", "polygons", "mask", "maskPath", "segmentation")) if (a.has(field)) return true;
        return false;
    }
    private static void strictGeometryNumbers(JsonObject a) {
        String type = Json.required(a, "type");
        if (Set.of("detect", "pose").contains(type) || type.equals("obb") && Json.array(a, "points").isEmpty()) {
            JsonObject box = Json.object(a, "bbox");
            for (String field : List.of("x", "y", "width", "height")) number(box, field);
            if (a.has("rotation")) number(a, "rotation");
        }
        if (Set.of("segment", "obb").contains(type)) for (JsonElement value : Json.array(a, "points")) {
            JsonObject point = object(value, "轮廓点"); number(point, "x"); number(point, "y");
        }
        if (type.equals("pose")) for (JsonElement value : Json.array(a, "keypoints")) {
            JsonObject point = object(value, "关键点"); int visibility = integer(point, "visibility", 0, 2);
            if (visibility > 0) { number(point, "x"); number(point, "y"); }
        }
    }
    private static JsonObject transformedPoint(JsonObject point, Matrix m, int width, int height, int[] snaps) {
        double x = number(point, "x"), y = number(point, "y");
        return Json.obj("x", snap(m.x(x, y), width, snaps), "y", snap(m.y(x, y), height, snaps));
    }
    private static Rect snappedRect(Rect box, int width, int height, int[] snaps) {
        double x = snap(box.x, width, snaps), y = snap(box.y, height, snaps);
        return new Rect(x, y, snap(box.right(), width, snaps) - x, snap(box.bottom(), height, snaps) - y);
    }
    private static double snap(double value, int dimension, int[] snaps) {
        if (!Double.isFinite(value)) throw invalid("坐标变换溢出。");
        if (value < 0 && value >= -ROUND_OFF) { snaps[0]++; return 0; }
        if (value > dimension && value <= dimension + ROUND_OFF) { snaps[0]++; return dimension; }
        return value;
    }
    private static JsonArray rings(Area shape, Matrix m, int width, int height, int[] snaps) {
        JsonArray rings = new JsonArray(), current = null; double[] coordinates = new double[6]; int total = 0;
        for (PathIterator iterator = shape.getPathIterator(null); !iterator.isDone(); iterator.next()) {
            int kind = iterator.currentSegment(coordinates);
            if (kind == PathIterator.SEG_MOVETO) current = new JsonArray();
            if (kind == PathIterator.SEG_MOVETO || kind == PathIterator.SEG_LINETO) {
                if (++total > MAX_POINTS) throw invalid("交集诊断顶点超过限制。");
                current.add(transformedPoint(Json.obj("x", coordinates[0], "y", coordinates[1]), m, width, height, snaps));
            } else if (kind == PathIterator.SEG_CLOSE) {
                if (current == null || current.size() < 3) throw invalid("交集边界退化，不能生成有效轮廓。");
                // Area 求交可能重复产生同一交点，只消除其数值重复并记录，不简化用户轮廓。
                for (int i = current.size() - 1; i >= 0 && current.size() > 1; i--) {
                    JsonObject a = current.get(i).getAsJsonObject(), b = current.get((i + 1) % current.size()).getAsJsonObject();
                    if (Math.hypot(number(a, "x") - number(b, "x"), number(a, "y") - number(b, "y")) <= 1e-10) {
                        current.remove(i); snaps[0]++;
                    }
                }
                if (current.size() < 3) throw invalid("交集边界退化，保留来源诊断后人工处理。");
                rings.add(current); current = null;
            } else throw invalid("几何交集出现不支持的曲线边界。");
        }
        return rings;
    }
    private static boolean inside(JsonObject annotation, Rect region) {
        String type = Json.required(annotation, "type");
        if (type.equals("detect") || type.equals("pose")) {
            Rect b = rect(Json.object(annotation, "bbox"));
            if (!region.contains(b.x, b.y) || !region.contains(b.right(), b.bottom())) return false;
            if (type.equals("pose")) for (JsonElement value : Json.array(annotation, "keypoints")) {
                JsonObject point = value.getAsJsonObject();
                if (Json.integer(point, "visibility", 0) > 0 && !region.contains(number(point, "x"), number(point, "y"))) return false;
            }
            return true;
        }
        for (JsonElement value : type.equals("obb") ? Annotations.obb(annotation) : Json.array(annotation, "points")) {
            JsonObject point = value.getAsJsonObject(); if (!region.contains(number(point, "x"), number(point, "y"))) return false;
        }
        return true;
    }
    private static boolean touchesArtificialBoundary(JsonObject annotation, Rect valid, Rect coverage, JsonObject baseline) {
        Rect bounds;
        if (Set.of("detect", "pose").contains(Json.required(annotation, "type"))) bounds = rect(Json.object(annotation, "bbox"));
        else {
            Rectangle2D b = RegionGeometry.region(annotation).shape().getBounds2D(); bounds = new Rect(b.getX(), b.getY(), b.getWidth(), b.getHeight());
        }
        return coverage.x > ROUND_OFF && bounds.x <= valid.x + ROUND_OFF
            || coverage.y > ROUND_OFF && bounds.y <= valid.y + ROUND_OFF
            || coverage.right() < Json.integer(baseline, "width", 0) - ROUND_OFF && bounds.right() >= valid.right() - ROUND_OFF
            || coverage.bottom() < Json.integer(baseline, "height", 0) - ROUND_OFF && bounds.bottom() >= valid.bottom() - ROUND_OFF;
    }
    private static void excluded(JsonObject item) { item.addProperty("outcome", "excluded"); item.addProperty("excludedReason", "outside_view"); }
    private static void issue(JsonArray issues, String id, String code, String field, String message) {
        issues.add(Json.obj("annotationId", id, "code", code, "severity", "error", "field", field, "message", message));
    }
    private static boolean hasErrors(JsonArray issues) {
        for (JsonElement value : issues) if (!Json.str(object(value, "几何问题"), "severity", "error").equals("info")) return true;
        return false;
    }
    private static boolean same(Rect a, Rect b) { return a.x == b.x && a.y == b.y && a.width == b.width && a.height == b.height; }
    private static boolean full(Rect r, int width, int height) {
        return Math.abs(r.x) <= ROUND_OFF && Math.abs(r.y) <= ROUND_OFF && Math.abs(r.right() - width) <= ROUND_OFF && Math.abs(r.bottom() - height) <= ROUND_OFF;
    }
    private static List<Integer> positions(int size, int tile, int stride) {
        List<Integer> result = new ArrayList<>();
        for (int value = 0; ; value += stride) {
            int position = Math.min(value, size - tile);
            if (result.isEmpty() || result.getLast() != position) result.add(position);
            if (result.size() > MAX_VIEWS) throw invalid("单图切片数超过限制。");
            if (position == size - tile) return result;
        }
    }
    private static double unionLength(List<Rect> regions, boolean horizontal) {
        List<double[]> intervals = new ArrayList<>(regions.size());
        for (Rect r : regions) intervals.add(horizontal ? new double[]{r.x, r.right()} : new double[]{r.y, r.bottom()});
        intervals.sort(Comparator.comparingDouble(value -> value[0]));
        double total = 0, start = intervals.getFirst()[0], end = intervals.getFirst()[1];
        for (int i = 1; i < intervals.size(); i++) {
            double[] interval = intervals.get(i);
            if (interval[0] <= end) end = Math.max(end, interval[1]);
            else { total += end - start; start = interval[0]; end = interval[1]; }
        }
        return total + end - start;
    }
    private static Matrix matrix(JsonArray input) {
        if (input.size() != 6) throw invalid("仿射矩阵必须包含六个有限数值。");
        double[] n = new double[6]; for (int i = 0; i < 6; i++) n[i] = number(input.get(i));
        Matrix result = new Matrix(n[0], n[1], n[2], n[3], n[4], n[5]); result.inverse(); return result;
    }
    private static Rect rect(JsonObject value) { return new Rect(number(value, "x"), number(value, "y"), number(value, "width"), number(value, "height")); }
    private static void dimensions(int width, int height) { if ((long)width * height > 40_000_000) throw invalid("处理图像不能超过 4000 万像素。"); }
    private static void keys(JsonObject value, Set<String> allowed) {
        for (String key : value.keySet()) if (!allowed.contains(key)) throw invalid("不支持的图像处理参数：" + key);
    }
    private static String text(JsonObject value, String key, int limit) {
        if (!value.has(key) || !value.get(key).isJsonPrimitive() || !value.getAsJsonPrimitive(key).isString()) throw invalid("缺少有效字段：" + key);
        String result = value.get(key).getAsString();
        if (result.isBlank() || result.length() > limit) throw invalid("字段长度无效：" + key); return result;
    }
    private static String optionalText(JsonObject value, String key, String fallback, int limit) { return value.has(key) ? text(value, key, limit) : fallback; }
    private static int integer(JsonObject value, String key, int min, int max) {
        double n = number(value, key); if (n != Math.rint(n) || n < min || n > max) throw invalid("整数参数超出范围：" + key); return (int)n;
    }
    private static int optionalInteger(JsonObject value, String key, int fallback, int min, int max) { return value.has(key) ? integer(value, key, min, max) : fallback; }
    private static double number(JsonObject value, String key) { if (!value.has(key)) throw invalid("缺少数值字段：" + key); return number(value.get(key)); }
    private static double number(JsonElement value) {
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isNumber()) throw invalid("几何参数必须为有限数值。");
        double n = value.getAsDouble(); if (!Double.isFinite(n)) throw invalid("几何参数必须为有限数值。"); return n;
    }
    private static JsonObject object(JsonElement value, String label) { if (value == null || !value.isJsonObject()) throw invalid(label + "必须为对象。"); return value.getAsJsonObject(); }
    private static void boundedTree(JsonElement value, int[] remaining, int depth) {
        if (--remaining[0] < 0 || depth > 32) throw invalid("几何数据超过大小或嵌套层数限制。");
        if (value == null || value.isJsonNull()) return;
        if (value.isJsonObject()) for (var entry : value.getAsJsonObject().entrySet()) boundedTree(entry.getValue(), remaining, depth + 1);
        else if (value.isJsonArray()) for (JsonElement child : value.getAsJsonArray()) boundedTree(child, remaining, depth + 1);
        else if (value.getAsJsonPrimitive().isNumber()) number(value);
        else if (value.getAsJsonPrimitive().isString() && value.getAsString().length() > 100000) throw invalid("几何字段文本超过限制。");
    }
    private static ApiError invalid(String message) { return new ApiError(422, "transform_geometry_invalid", message); }
}
