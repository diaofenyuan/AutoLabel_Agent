package cn.autolabel.engine;

import com.google.gson.*;
import java.util.*;

/** 独立纯几何夹具，不启动引擎、不修改工程构建入口。 */
final class TransformGeometryTest {
    private static int assertions;
    public static void main(String[] args) {
        run(); System.out.println("TransformGeometryTest passed: " + assertions + " assertions across 15 geometry groups");
    }
    static void run() {
        identity(); composition(); contain(); tiling(); detect(); pose(); obbUniform(); obbStretch();
        obbClipping(); segment(); malformed(); classificationAndReview();
        diagnosticTopologyMapping(); diagnosticReviewAndSpaces(); invalidDiagnostics();
    }
    private static void check(boolean value, String message) {
        assertions++; if (!value) throw new AssertionError(message);
    }
    private static void near(double actual, double expected, String message) {
        check(Math.abs(actual - expected) < 1e-8, message + " actual=" + actual + " expected=" + expected);
    }
    private static void rejects(String code, Runnable action) {
        try { action.run(); throw new AssertionError("Expected " + code); }
        catch (ApiError error) { check(error.code.equals(code), "Expected " + code + " got " + error.code); }
    }
    private static JsonObject baseline(int width, int height) {
        return Json.obj("assetId", "baseline", "contentHash", "a".repeat(64), "width", width, "height", height,
            "normalizationVersion", "srgb-exif-alpha-v2", "inputVersion", 1);
    }
    private static JsonObject project(String type) {
        return Json.obj("taskType", type, "classes", Json.arr(Json.obj("id", "item", "name", "物品")),
            "settings", Json.obj("keypointNames", Json.arr("unknown", "occluded", "visible")));
    }
    private static JsonObject box(String type, double x, double y, double width, double height) {
        return Json.obj("id", "a", "classId", "item", "type", type, "bbox", Json.obj("x", x, "y", y, "width", width, "height", height));
    }
    private static JsonObject polygon(String type, double... coordinates) {
        JsonArray points = new JsonArray();
        for (int i = 0; i < coordinates.length; i += 2) points.add(Json.obj("x", coordinates[i], "y", coordinates[i + 1]));
        return Json.obj("id", "a", "classId", "item", "type", type, "points", points);
    }
    private static JsonObject obb(double x, double y, double width, double height, double angle) {
        JsonObject value = box("obb", x, y, width, height); value.addProperty("rotation", angle); return value;
    }
    private static JsonObject crop(int x, int y, int width, int height) { return Json.obj("kind", "crop", "x", x, "y", y, "width", width, "height", height); }
    private static JsonObject resize(int width, int height, String fit) { return Json.obj("kind", "resize", "width", width, "height", height, "fit", fit); }
    private static JsonObject tile(int width, int height, int overlapX, int overlapY) {
        return Json.obj("kind", "tile", "width", width, "height", height, "overlapX", overlapX, "overlapY", overlapY);
    }
    private static JsonObject plan(int width, int height, JsonObject... operations) { return TransformGeometry.plan(baseline(width, height), Json.arr((Object[])operations)); }
    private static JsonObject forward(JsonObject plan, JsonObject annotation) { return TransformGeometry.forward(plan, "view-00000", Json.arr(annotation), project(Json.required(annotation, "type"))); }
    private static JsonObject inverse(JsonObject plan, JsonObject annotation) { return TransformGeometry.inverse(plan, "view-00000", Json.arr(annotation), project(Json.required(annotation, "type"))); }
    private static JsonObject first(JsonObject result) { return Json.array(result, "annotations").get(0).getAsJsonObject(); }
    private static JsonObject item(JsonObject result) { return Json.array(result, "items").get(0).getAsJsonObject(); }
    private static boolean issue(JsonObject result, String code) {
        return Json.array(result, "geometryIssues").asList().stream().anyMatch(value -> code.equals(Json.str(value.getAsJsonObject(), "code", "")));
    }
    private static void reviewed(JsonObject result, String code) {
        check(Json.bool(result, "requiresGeometryReview", false), "review required for " + code);
        check(issue(result, code), "diagnostic retained for " + code);
        rejects("geometry_review_required", () -> TransformGeometry.assertExportable(result));
    }
    private static void geometryNear(JsonObject actual, JsonObject expected) {
        for (String key : List.of("x", "y", "width", "height")) near(Json.decimal(actual, key, 0), Json.decimal(expected, key, 0), "roundtrip " + key);
    }

    private static void identity() {
        JsonObject plan = plan(80, 120), input = box("detect", 0, 0, 80, 120), unchanged = input.deepCopy();
        JsonObject mapped = forward(plan, input); TransformGeometry.assertExportable(mapped);
        geometryNear(Json.object(first(mapped), "bbox"), Json.object(input, "bbox"));
        check(input.equals(unchanged), "source annotation unchanged");
        check(Json.bool(plan, "coversWholeBaseline", false), "identity covers baseline");
        check(Json.array(Json.array(plan, "views").get(0).getAsJsonObject(), "baselineToInput").equals(Json.arr(1, 0, 0, 0, 1, 0)), "already normalized baseline never reapplies EXIF");
        JsonObject boundary = TransformGeometry.mapPoint(Json.arr(0, -1, 120, 1, 0, 0), Json.obj("x", 80, "y", 120));
        near(Json.decimal(boundary, "x", -1), 0, "pixel-edge coordinates use full width and height");
        near(Json.decimal(boundary, "y", -1), 80, "point utility respects row-major affine convention");
        JsonObject restored = Json.parse(plan.toString());
        check(TransformGeometry.readPlan(restored).json().equals(plan), "serialized plan remains valid");
    }

    private static void composition() {
        JsonObject a = plan(100, 80, crop(10, 20, 60, 40), resize(120, 80, "stretch"));
        JsonObject b = plan(100, 80, resize(200, 160, "stretch"), crop(10, 20, 60, 40));
        JsonObject firstView = Json.array(a, "views").get(0).getAsJsonObject(), secondView = Json.array(b, "views").get(0).getAsJsonObject();
        check(!Json.array(firstView, "baselineToInput").equals(Json.array(secondView, "baselineToInput")), "operation order changes actual map");
        JsonObject point = TransformGeometry.mapPoint(Json.array(firstView, "baselineToInput"), Json.obj("x", 20, "y", 30));
        near(Json.decimal(point, "x", -1), 20, "composition x"); near(Json.decimal(point, "y", -1), 20, "composition y");
        JsonObject source = box("detect", 20, 30, 20, 10), mapped = forward(a, source), back = inverse(a, first(mapped));
        geometryNear(Json.object(first(back), "bbox"), Json.object(source, "bbox"));
        check(!Json.bool(a, "coversWholeBaseline", true), "inverse matrix cannot restore crop coverage");
        check(Json.array(a, "steps").size() == 2, "public step ledger includes both transforms");
        JsonObject fractional = plan(333, 217, resize(640, 640, "contain"), crop(1, 113, 638, 414));
        TransformGeometry.readPlan(fractional);
        JsonObject sample = box("detect", 40, 40, 25, 30), fixed = forward(fractional, sample), reversed = inverse(fractional, first(fixed));
        geometryNear(Json.object(first(reversed), "bbox"), Json.object(sample, "bbox"));
    }

    private static void contain() {
        JsonObject plan = plan(200, 100, resize(200, 200, "contain"));
        JsonObject view = Json.array(plan, "views").get(0).getAsJsonObject();
        geometryNear(Json.object(view, "validInputRect"), Json.obj("x", 0, "y", 50, "width", 200, "height", 100));
        JsonObject mapped = inverse(plan, box("detect", 20, 70, 20, 20));
        geometryNear(Json.object(first(mapped), "bbox"), Json.obj("x", 20, "y", 20, "width", 20, "height", 20));
        TransformGeometry.assertExportable(mapped);
        JsonObject padding = inverse(plan, box("detect", 10, 20, 20, 20)); reviewed(padding, "geometry_in_padding");
        check(Json.array(padding, "annotations").isEmpty(), "padding does not become a valid negative or clipped detection");
        JsonObject partial = inverse(plan, box("detect", 10, 40, 20, 20)); reviewed(partial, "geometry_in_padding");
        rejects("transform_geometry_invalid", () -> plan(200, 100, resize(200, 200, "contain"), crop(0, 0, 200, 40)));
        rejects("transform_geometry_invalid", () -> plan(200, 100, resize(200, 200, "contain"), tile(20, 20, 0, 0)));
    }

    private static void tiling() {
        JsonObject plan = plan(103, 73, tile(40, 30, 10, 10)); JsonArray views = Json.array(plan, "views");
        check(views.size() == 16, "anchored irregular edge tiles are explicit");
        JsonObject last = Json.object(views.get(15).getAsJsonObject(), "tile");
        near(Json.decimal(last, "x", -1), 63, "last tile anchored at right"); near(Json.decimal(last, "y", -1), 43, "last tile anchored at bottom");
        near(Json.decimal(plan, "coverageArea", 0), 103 * 73, "overlap counted once in coverage");
        TransformGeometry.PreparedPlan prepared = TransformGeometry.readPlan(plan);
        JsonObject mapped = prepared.inverse("view-00015", Json.arr(box("detect", 5, 5, 10, 10)), project("detect"));
        geometryNear(Json.object(first(mapped), "bbox"), Json.obj("x", 68, "y", 48, "width", 10, "height", 10));
        JsonObject gapped = plan(100, 60, tile(40, 30, 0, 0), crop(5, 5, 30, 20));
        near(Json.decimal(gapped, "coverageArea", 0), 3200, "crop after tiling retains exact uncovered gaps");
        check(!Json.bool(gapped, "coversWholeBaseline", true), "cropped tile union is not falsely complete");
        JsonObject maximum = plan(100, 100, tile(1, 1, 0, 0));
        check(Json.array(maximum, "views").size() == 10000, "bounded maximum tile plan usable");
        TransformGeometry.readPlan(maximum);
        check(!Json.array(maximum, "views").get(0).getAsJsonObject().has("steps"), "shared steps are not duplicated per tile");
        rejects("transform_geometry_invalid", () -> plan(101, 100, tile(1, 1, 0, 0)));
        rejects("transform_geometry_invalid", () -> plan(100, 100, tile(50, 50, 50, 0)));
        rejects("transform_geometry_invalid", () -> plan(100, 100, tile(50, 50, 0, 0), tile(10, 10, 0, 0)));
    }

    private static void detect() {
        JsonObject plan = plan(100, 100, crop(20, 20, 40, 40));
        JsonObject partial = forward(plan, box("detect", 10, 30, 20, 10)); reviewed(partial, "object_truncated");
        geometryNear(Json.object(first(partial), "bbox"), Json.obj("x", 0, "y", 10, "width", 10, "height", 10));
        JsonObject outside = forward(plan, box("detect", 0, 0, 10, 10));
        check(Json.str(item(outside), "outcome", "").equals("excluded"), "provably outside object recorded");
        check(Json.str(outside, "emptyMeaning", "").equals("no_visible_source_annotations"), "outside view is not baseline negative");
        JsonObject touching = forward(plan, box("detect", 0, 30, 20, 10));
        check(Json.str(item(touching), "outcome", "").equals("excluded"), "zero area boundary contact is outside");
        JsonObject thin = forward(plan, box("detect", 19.999, 30, 0.002, 10));
        check(Json.array(thin, "annotations").size() == 1, "positive thin intersection not discarded");
        JsonObject back = TransformGeometry.inverse(plan, "view-00000", partial, project("detect"));
        reviewed(back, "upstream_geometry_review_required");
        check(issue(back, "possible_object_truncation"), "interior crop edge remains diagnosable after inverse");
        rejects("transform_geometry_invalid", () -> TransformGeometry.inverse(plan, "view-00000", back, project("detect")));
        rejects("transform_geometry_invalid", () -> TransformGeometry.inverse(plan(100, 100, crop(30, 20, 40, 40)), "view-00000", partial, project("detect")));
        JsonObject wrongSize = Json.obj("annotations", Json.arr(box("detect", 1, 1, 10, 10)), "width", 39, "height", 40);
        rejects("transform_geometry_invalid", () -> TransformGeometry.inverse(plan, "view-00000", wrongSize, project("detect")));
        JsonObject oversized = inverse(plan, box("detect", 0, 0, 40 + 1e-8, 10));
        reviewed(oversized, "input_geometry_invalid");
        check(Json.array(oversized, "annotations").isEmpty(), "tiny raw input overrun is not rounded into acceptance");
    }

    private static void pose() {
        JsonObject plan = plan(100, 100, crop(20, 20, 60, 60)), source = box("pose", 10, 10, 80, 80);
        source.add("keypoints", Json.arr(Json.obj("name", "unknown", "x", 999, "y", 999, "visibility", 0),
            Json.obj("name", "occluded", "x", 40, "y", 40, "visibility", 1), Json.obj("name", "visible", "x", 90, "y", 90, "visibility", 2)));
        JsonObject result = forward(plan, source); reviewed(result, "keypoint_cropped");
        JsonArray points = Json.array(first(result), "keypoints");
        check(Json.integer(points.get(0).getAsJsonObject(), "visibility", -1) == 0 && Json.decimal(points.get(0).getAsJsonObject(), "x", -1) == 0, "unknown point remains zero sentinel");
        check(Json.integer(points.get(1).getAsJsonObject(), "visibility", -1) == 1, "located occluded point retains visibility one");
        near(Json.decimal(points.get(1).getAsJsonObject(), "x", -1), 20, "located point mapped");
        check(Json.integer(points.get(2).getAsJsonObject(), "visibility", -1) == 0, "cropped point becomes unknown only in editable view candidate");
        JsonObject disposition = Json.array(item(result), "pointDispositions").get(0).getAsJsonObject();
        check(Json.integer(Json.object(disposition, "sourcePoint"), "visibility", -1) == 2, "cropped point original visibility retained");
        near(Json.decimal(Json.object(disposition, "rawMappedPoint"), "x", 0), 70, "cropped point retains unclamped mapped position");
        JsonObject back = TransformGeometry.inverse(plan, "view-00000", result, project("pose"));
        check(Json.integer(Json.array(first(back), "keypoints").get(2).getAsJsonObject(), "visibility", -1) == 0, "inverse does not invent removed keypoint");
        reviewed(back, "upstream_geometry_review_required");
        JsonObject badBox = box("pose", 0, 0, 10, 10); badBox.add("keypoints", source.get("keypoints"));
        JsonObject inconsistent = forward(plan, badBox); reviewed(inconsistent, "pose_point_without_visible_bbox");
        check(Json.array(inconsistent, "annotations").isEmpty(), "keypoint without visible bbox remains unresolved not excluded");
        JsonObject fractionalVisibility = source.deepCopy();
        Json.array(fractionalVisibility, "keypoints").get(1).getAsJsonObject().addProperty("visibility", 1.5);
        reviewed(forward(plan, fractionalVisibility), "input_geometry_invalid");
    }

    private static void obbUniform() {
        JsonObject plan = plan(100, 100, resize(200, 200, "contain")), source = obb(30, 30, 20, 10, 30);
        JsonObject result = forward(plan, source); TransformGeometry.assertExportable(result);
        check(!first(result).has("bbox") && !first(result).has("rotation"), "canonical OBB avoids conflicting bbox and rotation");
        JsonObject reversed = inverse(plan, first(result)); TransformGeometry.assertExportable(reversed);
        JsonArray original = Annotations.obb(source), back = Json.array(first(reversed), "points");
        for (int i = 0; i < 4; i++) geometryNear(back.get(i).getAsJsonObject(), original.get(i).getAsJsonObject());
        JsonObject axis = forward(plan(100, 100, resize(200, 100, "stretch")), obb(30, 30, 20, 10, 0));
        TransformGeometry.assertExportable(axis); check(Json.array(first(axis), "points").size() == 4, "axis aligned OBB survives anisotropic scaling exactly");
    }

    private static void obbStretch() {
        JsonObject plan = plan(100, 100, resize(200, 100, "stretch"));
        JsonObject result = forward(plan, obb(30, 30, 20, 10, 30)); reviewed(result, "obb_not_representable");
        check(Json.array(result, "annotations").isEmpty(), "parallelogram is not fitted into an OBB");
        check(Json.array(Json.object(item(result), "rawMappedGeometry"), "points").size() == 4, "exact distorted four points remain available");
        JsonObject reverse = inverse(plan, obb(60, 30, 20, 10, 30)); reviewed(reverse, "obb_not_representable");
        JsonObject carried = TransformGeometry.inverse(plan, "view-00000", result, project("obb"));
        reviewed(carried, "upstream_geometry_review_required");
        check(Json.array(carried, "items").size() == 1 && item(carried).has("upstreamDiagnostic"), "unrepresentable empty candidate preserves original object and diagnostics");
    }

    private static void obbClipping() {
        JsonObject source = obb(30, 30, 40, 40, 45);
        JsonObject triangle = forward(plan(100, 100, crop(50, 50, 50, 50)), source);
        reviewed(triangle, "obb_not_representable");
        check(Json.array(Json.object(item(triangle), "previewRings"), "rings").get(0).getAsJsonArray().size() == 3, "triangle intersection retained without corner clamping");
        JsonObject five = forward(plan(100, 100, crop(30, 0, 70, 100)), source);
        reviewed(five, "obb_not_representable");
        check(Json.array(Json.object(item(five), "previewRings"), "rings").get(0).getAsJsonArray().size() == 5, "five vertex intersection not converted to rectangle: " + Json.object(item(five), "previewRings"));
        JsonObject rectangle = forward(plan(100, 100, crop(40, 40, 20, 20)), source);
        reviewed(rectangle, "object_truncated"); check(Json.array(rectangle, "annotations").size() == 1, "representable clipped rectangle still requires human review");
    }

    private static void segment() {
        JsonObject l = polygon("segment", 0, 0, 4, 0, 4, 1, 1, 1, 1, 4, 0, 4);
        JsonObject single = forward(plan(10, 10, crop(0, 0, 2, 2)), l); reviewed(single, "object_truncated");
        near(RegionGeometry.region(first(single)).area(), 3, "single concave intersection exact area");
        JsonObject u = polygon("segment", 0, 0, 4, 0, 4, 4, 3, 4, 3, 1, 1, 1, 1, 4, 0, 4);
        JsonObject multi = forward(plan(10, 10, crop(0, 2, 4, 1)), u); reviewed(multi, "segment_multi_ring_unsupported");
        check(Json.array(multi, "annotations").isEmpty(), "disconnected region is never connected into one contour");
        JsonObject rings = Json.object(item(multi), "previewRings");
        check(Json.array(rings, "rings").size() == 2 && Json.str(rings, "fillRule", "").equals("evenOdd"), "all paths retained with hole-safe fill rule");
        near(Json.decimal(item(multi), "retainedArea", 0), 2, "two component area retained");
        JsonObject shape = polygon("segment", 20, 20, 70, 20, 60, 60, 20, 50), plan = plan(100, 100, resize(200, 150, "stretch"));
        JsonObject mapped = forward(plan, shape); TransformGeometry.assertExportable(mapped);
        JsonObject back = inverse(plan, first(mapped));
        near(RegionGeometry.iou(RegionGeometry.region(shape), RegionGeometry.region(first(back))), 1, "anisotropic segment roundtrip preserves true region");
    }

    private static void malformed() {
        JsonObject plan = plan(100, 100), hole = polygon("segment", 0, 0, 90, 0, 90, 90, 0, 90);
        hole.add("holes", Json.arr(Json.arr(Json.obj("x", 20, "y", 20), Json.obj("x", 30, "y", 20), Json.obj("x", 30, "y", 30))));
        JsonObject result = forward(plan, hole); reviewed(result, "input_geometry_invalid");
        check(item(result).getAsJsonObject("sourceGeometry").has("holes"), "unsupported holes retained rather than ignored");
        JsonObject crossing = forward(plan, polygon("segment", 10, 10, 80, 80, 10, 80, 80, 10)); reviewed(crossing, "input_geometry_invalid");
        JsonObject nan = box("detect", 1, 1, 10, 10); Json.object(nan, "bbox").addProperty("x", Double.NaN);
        rejects("transform_geometry_invalid", () -> forward(plan, nan));
        JsonObject forged = plan.deepCopy(); Json.array(forged, "views").get(0).getAsJsonObject().add("inputToBaseline", Json.arr(0, 0, 0, 0, 0, 0));
        rejects("transform_geometry_invalid", () -> TransformGeometry.readPlan(forged));
        JsonObject changed = plan.deepCopy(); Json.object(Json.array(changed, "views").get(0).getAsJsonObject(), "validInputRect").addProperty("width", 99);
        rejects("transform_geometry_invalid", () -> TransformGeometry.readPlan(changed));
        JsonObject dimension = plan.deepCopy(); Json.array(dimension, "views").get(0).getAsJsonObject().addProperty("width", 200);
        rejects("transform_geometry_invalid", () -> TransformGeometry.readPlan(dimension));
        JsonObject coverage = plan.deepCopy(); coverage.addProperty("coversWholeBaseline", false);
        rejects("transform_geometry_invalid", () -> TransformGeometry.readPlan(coverage));
        rejects("transform_geometry_invalid", () -> TransformGeometry.mapPoint(Json.arr(1, 1, 0, 1, 1, 0), Json.obj("x", 2, "y", 3)));
        rejects("transform_geometry_invalid", () -> plan(100, 100, crop(90, 90, 20, 20)));
        JsonObject unknown = crop(0, 0, 10, 10); unknown.addProperty("clamp", true);
        rejects("transform_geometry_invalid", () -> plan(100, 100, unknown));
        JsonObject fractional = crop(0, 0, 10, 10); fractional.addProperty("x", 0.5);
        rejects("transform_geometry_invalid", () -> plan(100, 100, fractional));
        JsonArray tooMany = new JsonArray(); for (int i = 0; i < 31; i++) tooMany.add(crop(0, 0, 100, 100));
        rejects("transform_geometry_invalid", () -> TransformGeometry.plan(baseline(100, 100), tooMany));
        TransformGeometry.PreparedPlan prepared = TransformGeometry.readPlan(plan);
        plan.addProperty("version", "tampered");
        TransformGeometry.assertExportable(prepared.forward("view-00000", Json.arr(box("detect", 10, 10, 10, 10)), project("detect")));
        check(TransformGeometry.VERSION.equals(Json.str(prepared.json(), "version", "")), "prepared plan detached from mutable caller JSON");
    }

    private static void classificationAndReview() {
        JsonObject label = Json.obj("id", "a", "type", "classify", "classId", "item");
        TransformGeometry.assertExportable(forward(plan(100, 50, resize(200, 200, "contain")), label));
        JsonObject cropPlan = plan(100, 100, crop(20, 20, 40, 40)), local = forward(cropPlan, label);
        reviewed(local, "classification_scope_changed");
        reviewed(inverse(cropPlan, label), "classification_scope_changed");
        JsonObject tilePlan = plan(100, 100, tile(50, 50, 0, 0));
        check(Json.bool(tilePlan, "coversWholeBaseline", false), "full tile plan still has local semantic scopes");
        reviewed(forward(tilePlan, label), "classification_scope_changed");
        JsonObject empty = TransformGeometry.inverse(plan(100, 100), "view-00000", new JsonArray(), project("classify"));
        reviewed(empty, "classification_missing");
        JsonObject flagOnly = Json.obj("annotations", Json.arr(box("detect", 10, 10, 10, 10)), "requiresGeometryReview", true);
        JsonObject inherited = TransformGeometry.inverse(plan(100, 100), "view-00000", flagOnly, project("detect"));
        reviewed(inherited, "upstream_geometry_review_required");
        JsonObject forwardInherited = TransformGeometry.forward(plan(100, 100), "view-00000", inherited, project("detect"));
        reviewed(forwardInherited, "upstream_geometry_review_required");
        inherited.addProperty("requiresGeometryReview", false);
        rejects("geometry_review_required", () -> TransformGeometry.assertExportable(inherited));
        JsonObject negative = TransformGeometry.inverse(plan(100, 100), "view-00000", new JsonArray(), project("detect"));
        check(Json.str(negative, "emptyMeaning", "").equals("no_reported_objects"), "geometry helper does not invent execution success or human negative truth");
    }

    private static JsonObject diagnosticRing(int id, Integer parent, int depth, double... coordinates) {
        return Json.obj("ringId", id, "parentRingId", parent, "depth", depth, "hole", depth % 2 == 1,
            "points", polygon("segment", coordinates).get("points"));
    }
    private static JsonObject workerDiagnostic() {
        return Json.obj("annotationId", "a", "maskWidth", 50, "maskHeight", 40, "coordinateSpace", "baseline_pixels",
            "maskToBaseline", Json.arr(1.6, 0, 0, 0, 1.6, -2), "outerCount", 2, "holeCount", 1,
            "degenerate", false, "outOfBounds", false, "requiresGeometryReview", true, "rings", Json.arr(
                diagnosticRing(0, null, 0, 8, 9, 24, 9, 24, 21, 8, 21),
                diagnosticRing(1, 0, 1, 12, 12, 20, 12, 20, 18, 12, 18),
                diagnosticRing(2, null, 0, 40, 30, 56, 30, 56, 42, 40, 42)));
    }
    private static JsonObject workerResult(JsonObject diagnostic) {
        return Json.obj("assetId", "input-view", "width", 80, "height", 60, "annotations", Json.arr(polygon("segment", 8, 9, 24, 9, 24, 21, 8, 21)),
            "geometryDiagnostics", Json.arr(diagnostic), "geometryIssues", Json.arr(Json.obj("annotationId", "a", "code", "segment_topology_unsupported", "severity", "error")),
            "requiresGeometryReview", true);
    }
    private static JsonObject diagnostic(JsonObject mapped) { return Json.array(mapped, "geometryDiagnostics").get(0).getAsJsonObject(); }

    private static void diagnosticTopologyMapping() {
        JsonObject plan = plan(100, 80, crop(20, 10, 40, 20), resize(80, 60, "stretch"));
        JsonObject source = workerDiagnostic(), input = workerResult(source), before = input.deepCopy();
        JsonObject mapped = TransformGeometry.inverse(plan, "view-00000", input, project("segment")), result = diagnostic(mapped);
        check(Json.str(result, "coordinateSpace", "").equals("baseline") && Json.str(result, "mappingStatus", "").equals("mapped"), "孔洞诊断明确使用目标基准坐标");
        check(Json.array(result, "rings").size() == 3 && Json.integer(result, "outerCount", 0) == 2 && Json.integer(result, "holeCount", 0) == 1, "双区域和孔洞均完整保留");
        for (int i = 0; i < 3; i++) {
            JsonObject original = Json.array(source, "rings").get(i).getAsJsonObject(), ring = Json.array(result, "rings").get(i).getAsJsonObject();
            check(ring.get("ringId").equals(original.get("ringId")) && ring.get("parentRingId").equals(original.get("parentRingId"))
                && ring.get("depth").equals(original.get("depth")) && ring.get("hole").equals(original.get("hole")), "回映保留环标识与完整层级");
            for (int point = 0; point < Json.array(original, "points").size(); point++) {
                JsonObject a = Json.array(original, "points").get(point).getAsJsonObject(), b = Json.array(ring, "points").get(point).getAsJsonObject();
                near(Json.decimal(b, "x", 0), Json.decimal(a, "x", 0) / 2 + 20, "全部环顶点 X 回映");
                near(Json.decimal(b, "y", 0), Json.decimal(a, "y", 0) / 3 + 10, "全部环顶点 Y 回映");
            }
        }
        double[] expected = {.8, 0, 20, 0, 1.6 / 3, 10 - 2.0 / 3};
        for (int i = 0; i < 6; i++) near(Json.array(result, "maskToMapped").get(i).getAsDouble(), expected[i], "掩码到目标矩阵正确复合");
        check(!result.has("maskToBaseline") && result.get("sourceDiagnostic").equals(source), "旧掩码矩阵只保留在完整源诊断中");
        JsonObject roundtrip = diagnostic(TransformGeometry.forward(plan, "view-00000", mapped, project("segment")));
        for (int i = 0; i < 6; i++) near(Json.array(roundtrip, "maskToMapped").get(i).getAsDouble(), Json.array(source, "maskToBaseline").get(i).getAsDouble(), "正向映射复合当前掩码矩阵");
        check(roundtrip.get("sourceDiagnostic").equals(source), "往返映射保留最初源诊断且不嵌套扩张");
        check(input.equals(before), "诊断映射不修改调用者输入");
    }

    private static void diagnosticReviewAndSpaces() {
        JsonObject plan = plan(100, 80, crop(20, 10, 40, 20), resize(80, 60, "stretch")), input = workerResult(workerDiagnostic());
        JsonObject mapped = TransformGeometry.inverse(plan, "view-00000", input, project("segment"));
        reviewed(mapped, "segment_topology_unsupported");
        check(Json.array(mapped, "annotations").size() == 1, "诊断回映不把孔洞填入可采用标注");
        input.addProperty("requiresGeometryReview", false); input.add("geometryIssues", new JsonArray());
        reviewed(TransformGeometry.inverse(plan, "view-00000", input, project("segment")), "geometry_diagnostic_review_required");
        rejects("transform_geometry_invalid", () -> TransformGeometry.inverse(plan, "view-00000", mapped, project("segment")));
        JsonObject forged = workerResult(diagnostic(mapped));
        rejects("transform_geometry_invalid", () -> TransformGeometry.inverse(plan, "view-00000", forged, project("segment")));
        JsonObject wrong = workerDiagnostic(); wrong.addProperty("coordinateSpace", "mask_pixels");
        rejects("transform_geometry_invalid", () -> TransformGeometry.inverse(plan, "view-00000", workerResult(wrong), project("segment")));
        JsonObject unclipped = workerDiagnostic(); Json.array(Json.array(unclipped, "rings").get(0).getAsJsonObject(), "points").get(0).getAsJsonObject().addProperty("x", -80);
        JsonObject outside = diagnostic(TransformGeometry.inverse(plan, "view-00000", workerResult(unclipped), project("segment")));
        near(Json.decimal(Json.array(Json.array(outside, "rings").get(0).getAsJsonObject(), "points").get(0).getAsJsonObject(), "x", 0), -20, "诊断越界坐标不裁剪");
        check(Json.bool(outside, "outOfBounds", false), "越界诊断仍明确要求复核");
    }

    private static void invalidDiagnostics() {
        JsonObject plan = plan(100, 80, crop(20, 10, 40, 20), resize(80, 60, "stretch"));
        List<JsonObject> invalid = new ArrayList<>();
        JsonObject duplicate = workerDiagnostic(); Json.array(duplicate, "rings").get(1).getAsJsonObject().addProperty("ringId", 0); invalid.add(duplicate);
        JsonObject cyclic = workerDiagnostic(); Json.array(cyclic, "rings").get(0).getAsJsonObject().addProperty("parentRingId", 1); invalid.add(cyclic);
        JsonObject missing = workerDiagnostic(); Json.array(missing, "rings").get(1).getAsJsonObject().addProperty("parentRingId", 9); invalid.add(missing);
        JsonObject illegal = workerDiagnostic(); Json.array(illegal, "rings").get(0).getAsJsonObject().addProperty("ringId", -1); invalid.add(illegal);
        JsonObject depth = workerDiagnostic(); Json.array(depth, "rings").get(1).getAsJsonObject().addProperty("depth", 3); invalid.add(depth);
        for (JsonObject bad : invalid) {
            JsonObject input = workerResult(bad); Json.array(input, "geometryDiagnostics").add(workerDiagnostic());
            JsonObject mapped = TransformGeometry.inverse(plan, "view-00000", input, project("segment")), first = diagnostic(mapped);
            check(Json.str(first, "mappingStatus", "").equals("invalid") && !first.has("rings") && !first.has("maskToMapped"), "坏层级不冒充目标坐标");
            check(first.get("sourceDiagnostic").equals(bad) && first.has("mappingError"), "坏诊断全部源环保留并有明确错误");
            check(Json.str(Json.array(mapped, "geometryDiagnostics").get(1).getAsJsonObject(), "mappingStatus", "").equals("mapped"), "坏诊断不静默吞掉其他完整诊断");
            reviewed(mapped, "geometry_diagnostic_invalid");
        }
        JsonObject nan = workerDiagnostic(); Json.array(Json.array(nan, "rings").get(0).getAsJsonObject(), "points").get(0).getAsJsonObject().addProperty("x", Double.NaN);
        rejects("transform_geometry_invalid", () -> TransformGeometry.inverse(plan, "view-00000", workerResult(nan), project("segment")));
        JsonObject huge = workerDiagnostic(); JsonArray points = new JsonArray();
        for (int i = 0; i < TransformGeometry.MAX_POINTS; i++) points.add(Json.obj("x", 1, "y", 1));
        Json.array(huge, "rings").get(0).getAsJsonObject().add("points", points);
        rejects("transform_geometry_invalid", () -> TransformGeometry.inverse(plan, "view-00000", workerResult(huge), project("segment")));
    }
}
