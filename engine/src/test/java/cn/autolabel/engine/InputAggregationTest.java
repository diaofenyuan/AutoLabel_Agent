package cn.autolabel.engine;

import com.google.gson.*;
import java.util.*;

/** 固定输入汇总的纯内存验证，不启动数据库或模型请求。 */
final class InputAggregationTest {
    private static int checks;
    public static void main(String[] args) { run(); System.out.println("InputAggregationTest passed: " + checks + " assertions"); }
    static void run() {
        coverageAndEmpty(); identifiersAndHash(); duplicates(); inheritedReview(); classification(); invalidMapping(); limits();
    }
    private static void check(boolean value, String message) { checks++; if (!value) throw new AssertionError(message); }
    private static void near(double actual, double expected, String message) { check(Math.abs(actual - expected) < 1e-8, message + " actual=" + actual); }
    private static void rejects(String code, Runnable action) {
        try { action.run(); throw new AssertionError("Expected " + code); }
        catch (ApiError error) { check(code.equals(error.code), "Expected " + code + " got " + error.code); }
    }
    private static JsonObject baseline() { return Json.obj("id", "baseline", "contentHash", "a".repeat(64), "width", 100, "height", 100, "version", 4); }
    private static JsonObject project(String task) {
        return Json.obj("taskType", task, "classes", Json.arr(Json.obj("id", "item", "name", "物品", "color", "#336699"), Json.obj("id", "other", "name", "其他", "color", "#996633")),
            "settings", Json.obj("keypointNames", Json.arr("nose"), "keypointConnections", new JsonArray(), "rules", Json.arr("标注可定位对象")));
    }
    private static JsonObject rect(double x, double y, double w, double h) { return Json.obj("x", x, "y", y, "width", w, "height", h); }
    private static JsonObject full() { return rect(0, 0, 100, 100); }
    private static JsonObject expected(String id, JsonObject rect) { return Json.obj("inputId", id, "baselineCoverageRect", rect); }
    private static JsonObject box(String id, double x, double y, double w, double h) { return Json.obj("id", id, "classId", "item", "type", "detect", "bbox", rect(x, y, w, h)); }
    private static JsonObject polygon(String id, double... coordinates) {
        JsonArray points = new JsonArray(); for (int i = 0; i < coordinates.length; i += 2) points.add(Json.obj("x", coordinates[i], "y", coordinates[i + 1]));
        return Json.obj("id", id, "classId", "item", "type", "segment", "points", points);
    }
    private static JsonObject mapping(JsonObject project, JsonObject coverage, JsonArray annotations) {
        JsonObject baseline = baseline();
        JsonObject geometric = Json.obj("assetId", baseline.get("id"), "contentHash", baseline.get("contentHash"), "width", 100, "height", 100,
            "normalizationVersion", "srgb-exif-alpha-v2", "inputVersion", 1);
        JsonObject crop = Json.obj("kind", "crop", "x", coverage.get("x"), "y", coverage.get("y"), "width", coverage.get("width"), "height", coverage.get("height"));
        JsonObject plan = TransformGeometry.plan(geometric, Json.arr(crop));
        return TransformGeometry.inverse(plan, "view-00000", annotations, project);
    }
    private static JsonObject result(String input, String status, JsonObject mapping) {
        return Json.obj("inputId", input, "resultId", "result-" + input, "status", status, "mapping", mapping);
    }
    private static JsonObject aggregate(JsonObject project, JsonArray expected, JsonObject... results) {
        return InputAggregation.aggregate(baseline(), project, expected, Json.arr((Object[])results));
    }
    private static boolean issue(JsonObject result, String code) { return Json.array(result, "geometryIssues").asList().stream().anyMatch(value -> code.equals(Json.str(value.getAsJsonObject(), "code", ""))); }
    private static void review(JsonObject result, String code) {
        check(Json.bool(result, "requiresGeometryReview", false), "review gate for " + code); check(issue(result, code), "issue retained: " + code);
    }
    private static void coverageAndEmpty() {
        JsonObject project = project("detect"); JsonObject tl = rect(0, 0, 50, 50), tr = rect(50, 0, 50, 50), bl = rect(0, 50, 50, 50), br = rect(50, 50, 50, 50);
        JsonArray fixed = Json.arr(expected("tl", tl), expected("tr", tr), expected("bl", bl), expected("br", br));
        JsonObject first = result("tl", "succeeded", mapping(project, tl, new JsonArray())), diagonal = result("br", "succeeded", mapping(project, br, new JsonArray()));
        JsonObject missing = aggregate(project, fixed, first, diagonal); review(missing, "coverage_incomplete");
        near(Json.decimal(Json.object(missing, "coverage"), "area", -1), 5000, "diagonal rectangles do not multiply X/Y projections");
        check(Json.integer(Json.object(missing, "statistics"), "missing", -1) == 2, "missing tiles separate from empty success");
        JsonObject complete = aggregate(project, fixed, first, diagonal, result("tr", "succeeded", mapping(project, tr, new JsonArray())), result("bl", "succeeded", mapping(project, bl, new JsonArray())));
        check(Json.bool(Json.object(complete, "coverage"), "complete", false) && !Json.bool(complete, "requiresGeometryReview", true), "all complete clean empty inputs form legal empty detection");
        near(Json.decimal(Json.object(complete, "coverage"), "area", 0), 10000, "full quadrant coverage");
        for (String task : List.of("obb", "segment", "pose")) {
            JsonObject p = project(task), empty = aggregate(p, Json.arr(expected("one", full())), result("one", "succeeded", mapping(p, full(), new JsonArray())));
            check(!Json.bool(empty, "requiresGeometryReview", true) && Json.array(empty, "annotations").isEmpty(), "complete empty " + task + " allowed");
        }
        JsonObject overlap = aggregate(project, Json.arr(expected("left", rect(0, 0, 70, 100)), expected("right", rect(50, 0, 50, 100))),
            result("left", "succeeded", mapping(project, rect(0, 0, 70, 100), new JsonArray())), result("right", "succeeded", mapping(project, rect(50, 0, 50, 100), new JsonArray())));
        near(Json.decimal(Json.object(overlap, "coverage"), "area", 0), 10000, "overlapping coverage counted only once");
        JsonObject states = aggregate(project, Json.arr(expected("s", full()), expected("f", full()), expected("u", full()), expected("c", full())),
            result("s", "succeeded", mapping(project, full(), new JsonArray())), result("f", "failed", null), result("u", "unknown", null), result("c", "cancelled", null));
        review(states, "input_unknown");
        JsonObject stats = Json.object(states, "statistics");
        check(Json.integer(stats, "failed", -1) == 1 && Json.integer(stats, "unknown", -1) == 1 && Json.integer(stats, "cancelled", -1) == 1, "terminal states remain separate despite another input covering full image");
    }
    private static void identifiersAndHash() {
        JsonObject project = project("detect"), a = result("a", "succeeded", mapping(project, full(), Json.arr(box("same", 10, 10, 10, 10)))),
            b = result("b", "succeeded", mapping(project, full(), Json.arr(box("same", 70, 70, 10, 10))));
        JsonArray fixed = Json.arr(expected("a", full()), expected("b", full()));
        JsonObject merged = aggregate(project, fixed, a, b), reordered = aggregate(project, Json.arr(expected("b", full()), expected("a", full())), b, a);
        check(merged.equals(reordered), "fixed input and result reordering preserve hash and full aggregate output");
        JsonArray labels = Json.array(merged, "annotations");
        check(labels.size() == 2 && !Json.required(labels.get(0).getAsJsonObject(), "id").equals(Json.required(labels.get(1).getAsJsonObject(), "id")), "same original ID across views receives stable distinct IDs");
        check(Json.array(merged, "objectSources").size() == 2 && Json.array(merged, "resultIds").equals(Json.arr("result-a", "result-b")), "original result IDs and object sources retained");
        Annotations.validate(labels, baseline(), project);
        JsonObject changedTemplate = project.deepCopy(); Json.object(changedTemplate, "settings").add("attributes", Json.obj("occlusion", "说明"));
        JsonObject different = aggregate(changedTemplate, fixed, a, b);
        check(!Json.required(merged, "resultSetHash").equals(Json.required(different, "resultSetHash")), "full semantic template enters aggregation identity");
        JsonObject colorOnly = project.deepCopy(); Json.array(colorOnly, "classes").get(0).getAsJsonObject().addProperty("color", "#FFFFFF");
        check(Json.required(merged, "resultSetHash").equals(Json.required(aggregate(colorOnly, fixed, a, b), "resultSetHash")), "UI colors do not enter semantic identity");
        JsonObject revised = baseline(); revised.addProperty("version", 5);
        check(!Json.required(merged, "resultSetHash").equals(Json.required(InputAggregation.aggregate(revised, project, fixed, Json.arr(a, b)), "resultSetHash")), "fixed baseline version enters identity");
        rejects("input_aggregation_invalid", () -> aggregate(project, fixed, a, a));
        rejects("input_aggregation_invalid", () -> aggregate(project, fixed, result("extra", "succeeded", mapping(project, full(), new JsonArray()))));
        rejects("input_aggregation_invalid", () -> aggregate(project, Json.arr(expected("a", full()), expected("a", full())), a));
    }
    private static void duplicates() {
        JsonObject project = project("detect"), duplicate = aggregate(project, Json.arr(expected("a", full()), expected("b", full())),
            result("a", "succeeded", mapping(project, full(), Json.arr(box("a", 10, 10, 20, 20)))),
            result("b", "succeeded", mapping(project, full(), Json.arr(box("b", 15, 10, 20, 20)))));
        review(duplicate, "possible_duplicate_object"); check(Json.array(duplicate, "annotations").size() == 2, "overlapping candidates are preserved rather than NMS");
        JsonObject segment = project("segment");
        JsonObject regions = aggregate(segment, Json.arr(expected("a", full()), expected("b", full())),
            result("a", "succeeded", mapping(segment, full(), Json.arr(polygon("l", 0, 0, 40, 0, 40, 10, 10, 10, 10, 40, 0, 40)))),
            result("b", "succeeded", mapping(segment, full(), Json.arr(polygon("notch", 20, 20, 30, 20, 30, 30, 20, 30)))));
        check(!issue(regions, "possible_duplicate_object") && !Json.bool(regions, "requiresGeometryReview", true), "concave region duplicate check uses true intersection rather than bbox");
        JsonObject obb = project("obb"), horizontal = box("horizontal", 20, 45, 60, 10); horizontal.addProperty("type", "obb"); horizontal.addProperty("rotation", 0);
        JsonObject vertical = horizontal.deepCopy(); vertical.addProperty("id", "vertical"); vertical.addProperty("rotation", 90);
        JsonObject crossing = aggregate(obb, Json.arr(expected("a", full()), expected("b", full())), result("a", "succeeded", mapping(obb, full(), Json.arr(horizontal))), result("b", "succeeded", mapping(obb, full(), Json.arr(vertical))));
        check(!issue(crossing, "possible_duplicate_object") && !Json.bool(crossing, "requiresGeometryReview", true), "rotated rectangle IoU is not stored-axis bbox overlap");
    }
    private static void inheritedReview() {
        JsonObject project = project("detect"), base = mapping(project, full(), Json.arr(box("one", 20, 20, 10, 10)));
        JsonObject needs = aggregate(project, Json.arr(expected("a", full())), result("a", "needs_attention", base));
        review(needs, "input_review_required");
        check(Json.integer(Json.object(needs, "statistics"), "needsAttention", -1) == 1 && Json.array(needs, "annotations").size() == 1, "needs_attention retains legal candidate and separate count");
        near(Json.decimal(Json.object(needs, "coverage"), "area", -1), 0, "needs_attention cannot contribute usable coverage even if mapping flag is false");
        JsonObject inherited = base.deepCopy(); inherited.addProperty("requiresGeometryReview", true);
        JsonObject flagged = aggregate(project, Json.arr(expected("a", full())), result("a", "succeeded", inherited)); review(flagged, "upstream_geometry_review_required");
        check(Json.array(flagged, "annotations").size() == 1, "review flag does not discard schema-valid candidate");
        JsonObject info = base.deepCopy(); Json.array(info, "geometryIssues").add(Json.obj("annotationId", "one", "severity", "info", "code", "roundoff", "message", "浮点运算记录"));
        JsonObject informative = aggregate(project, Json.arr(expected("a", full())), result("a", "succeeded", info));
        check(issue(informative, "roundoff") && !Json.bool(informative, "requiresGeometryReview", true), "info is retained without becoming an error");
        JsonObject error = base.deepCopy(); Json.array(error, "geometryIssues").add(Json.obj("annotationId", "one", "severity", "error", "code", "existing_error", "message", "待审"));
        review(aggregate(project, Json.arr(expected("a", full())), result("a", "succeeded", error)), "existing_error");
        JsonObject itemOnly = base.deepCopy(); Json.array(itemOnly, "items").get(0).getAsJsonObject().addProperty("outcome", "review");
        review(aggregate(project, Json.arr(expected("a", full())), result("a", "succeeded", itemOnly)), "upstream_geometry_review_required");
    }
    private static void classification() {
        JsonObject project = project("classify"), label = Json.obj("id", "class", "type", "classify", "classId", "item");
        JsonObject first = result("a", "succeeded", mapping(project, full(), Json.arr(label))), second = result("b", "succeeded", mapping(project, full(), Json.arr(label)));
        JsonObject consensus = aggregate(project, Json.arr(expected("a", full()), expected("b", full())), first, second);
        check(Json.array(consensus, "annotations").size() == 1 && Json.array(consensus, "objectSources").size() == 2 && !Json.bool(consensus, "requiresGeometryReview", true), "same valid full-image classifications produce one schema-valid label with all sources");
        JsonObject other = label.deepCopy(); other.addProperty("classId", "other");
        JsonObject conflict = aggregate(project, Json.arr(expected("a", full()), expected("b", full())), first, result("b", "succeeded", mapping(project, full(), Json.arr(other))));
        review(conflict, "classification_consensus_unresolved"); check(Json.array(conflict, "annotations").isEmpty(), "conflicting classes do not select an arbitrary winner");
        JsonObject localRect = rect(0, 0, 50, 50), local = aggregate(project, Json.arr(expected("tile", localRect)), result("tile", "succeeded", mapping(project, localRect, Json.arr(label))));
        review(local, "classification_scope_changed"); check(Json.array(local, "annotations").isEmpty() && Json.array(local, "objectSources").size() == 1, "local class remains traceable without becoming full-image label");
    }
    private static void invalidMapping() {
        JsonObject project = project("detect"), clean = mapping(project, full(), new JsonArray());
        for (String field : List.of("version", "transformVersion", "direction", "coordinateSpace", "baselineAssetId", "baselineContentHash")) {
            JsonObject wrong = clean.deepCopy(); wrong.addProperty(field, "wrong");
            JsonObject result = aggregate(project, Json.arr(expected("a", full())), result("a", "succeeded", wrong));
            review(result, "mapping_invalid"); near(Json.decimal(Json.object(result, "coverage"), "area", -1), 0, "invalid mapping identity contributes no coverage");
        }
        JsonObject wrongDimensions = clean.deepCopy(); wrongDimensions.addProperty("width", 99);
        review(aggregate(project, Json.arr(expected("a", full())), result("a", "succeeded", wrongDimensions)), "mapping_invalid");
        JsonObject wrongCoverage = clean.deepCopy(); Json.object(wrongCoverage, "coverage").add("baselineRect", rect(0, 0, 50, 100));
        review(aggregate(project, Json.arr(expected("a", full())), result("a", "succeeded", wrongCoverage)), "mapping_invalid");
        JsonObject partiallyInvalid = mapping(project, full(), Json.arr(box("good", 10, 10, 10, 10)));
        Json.array(partiallyInvalid, "annotations").add(box("bad", -5, 0, 10, 10));
        JsonObject saved = aggregate(project, Json.arr(expected("a", full())), result("a", "needs_attention", partiallyInvalid));
        review(saved, "mapped_annotation_invalid"); check(Json.array(saved, "annotations").size() == 1, "valid subset retained while original invalid result stays traceable");
    }
    private static void limits() {
        JsonObject project = project("detect"), tooMany = mapping(project, full(), new JsonArray()); JsonArray many = new JsonArray();
        for (int i = 0; i < 10001; i++) many.add(box("a" + i, 10, 10, 10, 10)); tooMany.add("annotations", many);
        rejects("input_aggregation_limit", () -> aggregate(project, Json.arr(expected("a", full())), result("a", "succeeded", tooMany)));
        JsonObject tooManyPoints = mapping(project("segment"), full(), new JsonArray()); JsonArray points = new JsonArray();
        for (int i = 0; i < 65537; i++) points.add(Json.obj("x", 10, "y", 10));
        tooManyPoints.add("annotations", Json.arr(Json.obj("id", "points", "classId", "item", "type", "segment", "points", points)));
        rejects("input_aggregation_limit", () -> aggregate(project("segment"), Json.arr(expected("a", full())), result("a", "succeeded", tooManyPoints)));
        JsonArray crowdedA = new JsonArray(), crowdedB = new JsonArray();
        for (int i = 0; i < 40; i++) { crowdedA.add(box("a" + i, 10, 10, 20, 20)); crowdedB.add(box("b" + i, 10, 10, 20, 20)); }
        JsonObject bounded = aggregate(project, Json.arr(expected("a", full()), expected("b", full())), result("a", "succeeded", mapping(project, full(), crowdedA)), result("b", "succeeded", mapping(project, full(), crowdedB)));
        review(bounded, "duplicate_check_incomplete"); check(Json.array(bounded, "annotations").size() == 80, "computation cap retains every candidate and does not imply duplicate scan completed");
    }
}
