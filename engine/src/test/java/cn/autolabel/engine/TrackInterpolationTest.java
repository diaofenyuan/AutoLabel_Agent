package cn.autolabel.engine;

import com.google.gson.*;
import java.math.BigInteger;
import java.util.*;

/** 有理时间、可见性和版本保护的纯内存夹具，不启动视频、数据库或模型。 */
final class TrackInterpolationTest {
    private static int checks;
    public static void main(String[] args) { run(); System.out.println("TrackInterpolationTest passed: " + checks + " assertions"); }
    static void run() {
        actualTime(); poseVisibility(); boundaries(); humanProtection(); reviewMetrics(); affectedRanges(); splitAndMerge(); stableIdentity(); invalidInputs(); limits();
    }
    private static void check(boolean value, String message) { checks++; if (!value) throw new AssertionError(message); }
    private static void near(double actual, double expected, String message) { check(Math.abs(actual - expected) < 1e-8, message + " actual=" + actual); }
    private static void rejects(String code, Runnable action) {
        try { action.run(); throw new AssertionError("Expected " + code); }
        catch (ApiError error) { check(code.equals(error.code), "Expected " + code + " got " + error.code + ": " + error.getMessage()); }
    }
    private static JsonObject project(String task) {
        return Json.obj("taskType", task, "classes", Json.arr(Json.obj("id", "item", "name", "物体", "color", "#336699"), Json.obj("id", "other", "name", "其他", "color", "#663399")),
            "settings", Json.obj("keypointNames", Json.arr("a", "b", "c"), "keypointConnections", new JsonArray(), "rules", Json.arr("按真实点位标注")));
    }
    private static JsonObject frame(int index, String pts) {
        return Json.obj("frameId", "f" + index, "pts", pts, "timeBase", Json.obj("numerator", "1", "denominator", "10"), "sceneId", "scene-a",
            "baseline", Json.obj("id", "asset-" + index, "contentHash", "a".repeat(64), "width", 100, "height", 100, "version", 1), "annotationVersion", 4, "annotationState", "empty");
    }
    private static JsonObject timeline(int count) { JsonArray frames = new JsonArray(); for (int i = 0; i < count; i++) frames.add(frame(i, Integer.toString(i))); return Json.obj("sourceVideoId", "video-a", "frames", frames); }
    private static JsonObject timeline(String... pts) { JsonArray frames = new JsonArray(); for (int i = 0; i < pts.length; i++) frames.add(frame(i, pts[i])); return Json.obj("sourceVideoId", "video-a", "frames", frames); }
    private static JsonObject at(JsonObject timeline, int index) { return Json.array(timeline, "frames").get(index).getAsJsonObject(); }
    private static JsonObject box(String id, double x) { return Json.obj("id", id, "classId", "item", "type", "detect", "bbox", Json.obj("x", x, "y", 10, "width", 10, "height", 20)); }
    private static JsonObject point(String name, double x, double y, int visibility) { return Json.obj("name", name, "x", x, "y", y, "visibility", visibility); }
    private static JsonObject pose(String id, double x, JsonObject... points) { JsonObject a = box(id, x); a.addProperty("type", "pose"); a.add("keypoints", Json.arr((Object[])points)); return a; }
    private static JsonObject key(int frame, String state, JsonObject annotation) { return Json.obj("keyframeId", "k" + frame, "frameId", "f" + frame, "objectId", "object-a", "state", state, "annotation", annotation); }
    private static JsonObject key(int frame, double x) { return key(frame, "located", box("annotation-" + frame, x)); }
    private static JsonObject track(JsonObject project, JsonObject... keys) { return Json.obj("trackId", "track-a", "objectId", "object-a", "sourceVideoId", "video-a", "templateHash", TrackInterpolation.templateHash(project), "keyframes", Json.arr((Object[])keys)); }
    private static JsonObject generate(JsonObject project, JsonObject timeline, JsonObject track) { return TrackInterpolation.interpolate(project, timeline, track, new JsonObject()); }
    private static JsonObject first(JsonObject output) { return Json.array(output, "candidates").get(0).getAsJsonObject(); }
    private static JsonObject annotation(JsonObject candidate) { return Json.array(candidate, "annotations").get(0).getAsJsonObject(); }
    private static JsonObject interval(JsonObject output, int index) { return Json.array(output, "intervals").get(index).getAsJsonObject(); }
    private static boolean issue(JsonObject value, String code) { return Json.array(value, "reviewIssues").asList().stream().anyMatch(item -> code.equals(Json.str(item.getAsJsonObject(), "code", ""))); }
    private static Set<String> strings(JsonArray values) { Set<String> result = new HashSet<>(); values.forEach(value -> result.add(value.getAsString())); return result; }
    private static String hash(JsonObject value, String name) { return Json.required(value, name); }

    private static void actualTime() {
        JsonObject p = project("detect"), time = timeline("0", "1", "10"), t = track(p, key(0, 10), key(2, 60));
        JsonObject inputCopy = t.deepCopy(), timeCopy = time.deepCopy(), result = generate(p, time, t), candidate = first(result);
        near(Json.decimal(Json.object(annotation(candidate), "bbox"), "x", -1), 15, "unequal sampling uses one tenth, not frame midpoint");
        check(Json.object(Json.object(candidate, "source"), "ratio").equals(Json.obj("numerator", "1", "denominator", "10")), "ratio is exact and reduced");
        check(Json.bool(candidate, "candidateOnly", false) && !Json.bool(candidate, "humanConfirmed", true), "interpolation is never human confirmation");
        check(!annotation(candidate).has("trackId") && !annotation(candidate).has("source") && !annotation(candidate).has("attributes"), "track identity stays outside standard annotations");
        check(t.equals(inputCopy) && time.equals(timeCopy), "input snapshots are not mutated");
        Annotations.validate(Json.array(candidate, "annotations"), Json.object(candidate, "baseline"), p); check(true, "candidate passes existing validator");
        BigInteger huge = BigInteger.TEN.pow(70); JsonObject hugeTime = timeline(huge.toString(), huge.add(BigInteger.ONE).toString(), huge.add(BigInteger.TEN).toString());
        near(Json.decimal(Json.object(annotation(first(generate(p, hugeTime, t))), "bbox"), "x", -1), 15, "large PTS retains small time differences");
        JsonObject negative = timeline("-10", "-9", "0"); near(Json.decimal(Json.object(annotation(first(generate(p, negative, t))), "bbox"), "x", -1), 15, "negative PTS is valid");
        JsonObject mixed = time.deepCopy(); at(mixed, 1).addProperty("pts", "100"); Json.object(at(mixed, 1), "timeBase").addProperty("denominator", "1000");
        at(mixed, 1).add("time", Json.obj("numerator", "1", "denominator", "10"));
        check(generate(p, mixed, t).equals(result), "equivalent PTS bases and matching explicit time have identical identity");
        JsonObject exact = time.deepCopy(); for (int i = 0; i < 3; i++) { JsonObject frame = at(exact, i); String pts = Json.required(frame, "pts"); frame.remove("pts"); frame.remove("timeBase"); frame.add("time", Json.obj("numerator", pts, "denominator", "10")); }
        check(generate(p, exact, t).equals(result), "exact rational timestamps work without PTS");
    }

    private static void poseVisibility() {
        JsonObject p = project("pose"), time = timeline("0", "5", "10");
        JsonObject left = pose("left", 10, point("a", 90, 90, 0), point("b", 10, 20, 1), point("c", 0.0, 0.0, 2));
        JsonObject right = pose("right", 20, point("a", 30, 40, 2), point("b", 30, 40, 2), point("c", 10, 10, 2));
        JsonObject output = generate(p, time, track(p, key(0, "occluded", left), key(2, "located", right))), candidate = first(output);
        JsonArray points = Json.array(annotation(candidate), "keypoints"); JsonObject a = points.get(0).getAsJsonObject(), b = points.get(1).getAsJsonObject(), c = points.get(2).getAsJsonObject();
        check(Json.integer(a, "visibility", -1) == 0 && Json.decimal(a, "x", -1) == 0 && Json.decimal(a, "y", -1) == 0, "unlocatable endpoint yields canonical v0, not invented coordinates");
        check(Json.integer(b, "visibility", -1) == 1, "occluded endpoint stays visibility 1"); near(Json.decimal(b, "x", -1), 20, "located occluded point still interpolates");
        check(Json.integer(c, "visibility", -1) == 2, "zero coordinate is a valid visible location"); near(Json.decimal(c, "x", -1), 5, "visible .0 coordinate is not mistaken for missing");
        check(issue(candidate, "keypoint_unlocatable") && Json.bool(candidate, "requiresReview", false), "missing points retain explicit review diagnostics");
        check(Json.array(Json.object(candidate, "source"), "pointDispositions").size() == 3, "all point decisions are traceable");
        JsonObject reverse = generate(p, time, track(p, key(0, "located", right), key(2, "occluded", left)));
        check(Json.integer(Json.array(annotation(first(reverse)), "keypoints").get(1).getAsJsonObject(), "visibility", -1) == 1, "right occluded endpoint also stays v1");
        JsonObject mismatch = right.deepCopy(); Json.array(mismatch, "keypoints").get(0).getAsJsonObject().addProperty("name", "b");
        rejects("track_annotation_invalid", () -> generate(p, time, track(p, key(0, "located", left), key(2, "located", mismatch))));
        JsonObject fractional = right.deepCopy(); Json.array(fractional, "keypoints").get(0).getAsJsonObject().addProperty("visibility", 1.5);
        rejects("track_interpolation_invalid", () -> generate(p, time, track(p, key(0, "located", left), key(2, "located", fractional))));
    }

    private static void boundaries() {
        JsonObject p = project("detect"), time = timeline(5), t = track(p, key(0, 10), key(4, 20));
        JsonObject scene = time.deepCopy(); at(scene, 2).addProperty("sceneId", "scene-b"); JsonObject crossed = generate(p, scene, t);
        check(Json.array(crossed, "candidates").isEmpty() && issue(interval(crossed, 0), "scene_boundary"), "interior scene boundary blocks even when endpoint scenes match");
        JsonObject unknown = time.deepCopy(); at(unknown, 2).remove("sceneId"); JsonObject unchecked = generate(p, unknown, t);
        check(Json.array(unchecked, "candidates").size() == 3 && issue(first(unchecked), "scene_unchecked") && Json.bool(first(unchecked), "requiresReview", false), "missing scene metadata is visibly unchecked");
        JsonObject enterRight = generate(p, time, track(p, key(0, 10), key(4, "enter", box("r", 20))));
        check(Json.array(enterRight, "candidates").isEmpty() && issue(interval(enterRight, 0), "enter_boundary"), "enter cannot connect from left");
        check(Json.array(generate(p, time, track(p, key(0, "enter", box("l", 10)), key(4, 20))), "candidates").size() == 3, "enter can connect forward");
        JsonObject exitLeft = generate(p, time, track(p, key(0, "exit", box("l", 10)), key(4, 20)));
        check(Json.array(exitLeft, "candidates").isEmpty() && issue(interval(exitLeft, 0), "exit_boundary"), "exit cannot connect forward");
        check(Json.array(generate(p, time, track(p, key(0, 10), key(4, "exit", box("r", 20)))), "candidates").size() == 3, "exit accepts connection up to last located frame");
        JsonObject missing = generate(p, time, track(p, key(0, 10), key(2, "unlocatable", null), key(4, 20)));
        check(Json.array(missing, "candidates").isEmpty() && issue(interval(missing, 0), "unlocatable_boundary") && issue(interval(missing, 1), "unlocatable_boundary"), "unlocatable keyframe blocks both adjacent intervals");
        JsonObject limited = generate(p, time, track(p, key(1, 10), key(3, 20)));
        check(Json.array(limited, "candidates").size() == 1 && Json.required(first(limited), "frameId").equals("f2"), "no extrapolation outside endpoint domain");
        check(Json.array(generate(p, time, track(p, key(2, 10))), "candidates").isEmpty(), "one explicit keyframe cannot invent a trajectory");
    }

    private static void humanProtection() {
        JsonObject p = project("detect"), time = timeline(5), t = track(p, key(0, 10), key(4, 20));
        at(time, 1).addProperty("annotationState", "manual"); at(time, 2).addProperty("annotationState", "confirmed"); at(time, 3).addProperty("annotationState", "candidate");
        JsonObject output = generate(p, time, t); check(Json.array(output, "candidates").size() == 1 && Json.required(first(output), "frameId").equals("f3"), "manual and confirmed frames cannot receive replacement candidates");
        JsonObject condition = Json.object(first(output), "applyPrecondition");
        check(Json.number(condition, "expectedAnnotationVersion", -1) == 4 && Json.required(condition, "baselineAssetId").equals("asset-3"), "candidate carries exact baseline and annotation version preconditions");
        check(Json.array(condition, "allowedAnnotationStates").equals(Json.arr("empty", "candidate")), "transaction policy excludes newly edited human state");
        long protectedCount = Json.array(output, "skipped").asList().stream().filter(value -> "human_protected".equals(Json.str(value.getAsJsonObject(), "reason", ""))).count();
        check(protectedCount == 2, "human skips are explicit and inspectable");
    }

    private static void reviewMetrics() {
        JsonObject p = project("detect"), time = timeline("0", "10", "100"), left = key(0, 10), right = key(2, 60);
        Json.object(Json.object(right, "annotation"), "bbox").addProperty("width", 30);
        JsonObject options = Json.obj("maxGapSeconds", 2, "maxCenterSpeedPixelsPerSecond", 1, "maxScaleFactor", 2);
        JsonObject output = TrackInterpolation.interpolate(p, time, track(p, left, right), options), candidate = first(output), detail = interval(output, 0);
        check(issue(candidate, "long_keyframe_gap") && issue(candidate, "rapid_center_motion") && issue(candidate, "rapid_size_change"), "long gaps and fast geometry changes are review signals");
        near(Json.decimal(Json.object(detail, "metrics"), "durationSeconds", 0), 10, "actual duration is returned");
        near(Json.decimal(Json.object(detail, "metrics"), "centerSpeedPixelsPerSecond", 0), 6, "actual center speed is returned");
        check(Json.decimal(Json.object(detail, "thresholds"), "maxCenterSpeedPixelsPerSecond", 0) == 1 && !Json.bool(detail, "trackingPerformed", true), "explicit threshold is frozen without claiming tracking drift detection");
        JsonObject attrs = key(2, 20); Json.object(attrs, "annotation").add("attributes", Json.obj("occlusion", "partial"));
        JsonObject attrCandidate = first(generate(p, timeline(3), track(p, key(0, 10), attrs)));
        check(issue(attrCandidate, "annotation_metadata_not_interpolated") && !annotation(attrCandidate).has("attributes"), "nongeometric metadata is not silently copied or invented");
        JsonObject poseProject = project("pose"), a = pose("a", 10, point("a", 0, 0, 2), point("b", 0, 0, 2), point("c", 0, 0, 2)),
            b = pose("b", 10, point("a", 90, 0, 2), point("b", 0, 0, 2), point("c", 0, 0, 2));
        JsonObject pose = TrackInterpolation.interpolate(poseProject, timeline(3), track(poseProject, key(0, "located", a), key(2, "located", b)), Json.obj("maxKeypointSpeedPixelsPerSecond", 100));
        check(issue(first(pose), "rapid_keypoint_motion"), "keypoint speed is evaluated separately from bbox center");
    }

    private static void affectedRanges() {
        JsonObject p = project("detect"), time = timeline(7), before = track(p, key(0, 10), key(2, 20), key(4, 30), key(6, 40));
        at(time, 3).addProperty("annotationState", "manual"); JsonObject after = before.deepCopy();
        Json.object(Json.object(Json.array(after, "keyframes").get(1).getAsJsonObject(), "annotation"), "bbox").addProperty("x", 22);
        JsonObject plan = TrackInterpolation.affectedIntervals(p, time, before, after);
        check(Json.array(plan, "affectedIntervals").size() == 4 && Json.array(plan, "changedKeyframes").size() == 1, "edit produces old/new adjacent intervals only");
        check(strings(Json.array(plan, "affectedFrameIds")).equals(Set.of("f0", "f1", "f2", "f3", "f4")), "unaffected distant interval is excluded");
        check(strings(Json.array(plan, "eligibleCandidateFrameIds")).equals(Set.of("f1")) && Json.array(plan, "protectedFrames").size() == 1, "recomputation still protects manual frames and explicit keyframes");
        JsonObject deleted = before.deepCopy(); Json.array(deleted, "keyframes").remove(1); JsonObject deletion = TrackInterpolation.affectedIntervals(p, time, before, deleted);
        check(Json.array(deletion, "affectedIntervals").size() == 3, "deletion includes two old intervals and their replacement bridge");
        check(strings(Json.array(deletion, "eligibleCandidateFrameIds")).contains("f2"), "deleted keyframe can become a candidate when not human protected");
        JsonObject moved = before.deepCopy(); Json.array(moved, "keyframes").get(1).getAsJsonObject().addProperty("frameId", "f1");
        check(Json.array(TrackInterpolation.affectedIntervals(p, time, before, moved), "affectedIntervals").size() == 4, "moving keyframe returns changed time neighbors");
        JsonObject same = TrackInterpolation.affectedIntervals(p, time, before, before);
        check(!Json.bool(same, "requiresRecompute", true) && Json.array(same, "affectedIntervals").isEmpty(), "unchanged snapshots need no recomputation");
        JsonObject single = track(p, key(2, 20)), empty = track(p);
        JsonObject removal = TrackInterpolation.affectedIntervals(p, time, single, empty);
        check(strings(Json.array(removal, "affectedFrameIds")).equals(Set.of("f2")) && Json.array(removal, "changedKeyframes").size() == 1, "last endpoint deletion is reported even without an adjacent interval");
        check(Json.array(removal, "eligibleCandidateFrameIds").isEmpty(), "last endpoint deletion does not authorize extrapolation");
        JsonObject removedStart = before.deepCopy(); Json.array(removedStart, "keyframes").remove(0);
        JsonObject shortened = TrackInterpolation.affectedIntervals(p, time, before, removedStart);
        check(Json.array(shortened, "eligibleCandidateFrameIds").isEmpty() && strings(Json.array(shortened, "mutableCandidateFrameIds")).contains("f1"), "old terminal candidates may be invalidated but cannot be regenerated beyond the new domain");
        JsonObject oldOutput = generate(p, time, before), newOutput = generate(p, time, after);
        String oldDistant = Json.array(oldOutput, "candidates").asList().stream().map(JsonElement::getAsJsonObject).filter(c -> "f5".equals(Json.required(c, "frameId"))).findFirst().orElseThrow().get("candidateId").getAsString();
        String newDistant = Json.array(newOutput, "candidates").asList().stream().map(JsonElement::getAsJsonObject).filter(c -> "f5".equals(Json.required(c, "frameId"))).findFirst().orElseThrow().get("candidateId").getAsString();
        check(oldDistant.equals(newDistant), "keyframe edit does not invalidate unrelated candidate identity");
    }

    private static void splitAndMerge() {
        JsonObject p = project("detect"), time = timeline(7), original = track(p, key(0, 10), key(2, 20), key(4, 30), key(6, 40));
        JsonObject split = TrackInterpolation.splitPlan(p, time, original, "f3", "left", "right"), left = Json.object(split, "leftTrack"), right = Json.object(split, "rightTrack");
        check(Json.array(left, "keyframes").size() == 2 && Json.array(right, "keyframes").size() == 2, "split partitions existing keys without fabricating a boundary");
        check(Json.required(Json.object(split, "removedInterval"), "leftFrameId").equals("f2") && Json.required(Json.object(split, "removedInterval"), "rightFrameId").equals("f4"), "removed cross-boundary interval is explicit");
        check(Json.array(split, "eligibleCandidateFrameIds").isEmpty() && strings(Json.array(split, "mutableCandidateFrameIds")).equals(Set.of("f3")), "split only invalidates the removed bridge, without planning replacement candidates");
        check(Json.array(generate(p, time, left), "candidates").size() == 1 && Json.array(generate(p, time, right), "candidates").size() == 1, "split children do not extrapolate across gap");
        JsonObject merge = TrackInterpolation.mergePlan(p, time, left, right, "track-a");
        check(Json.array(Json.object(merge, "track"), "keyframes").equals(Json.array(original, "keyframes")), "strict merge restores original keys");
        check(merge.equals(TrackInterpolation.mergePlan(p, time, right, left, "track-a")), "merge argument order does not drift plan identity");
        check(generate(p, time, Json.object(merge, "track")).equals(generate(p, time, original)), "merge plan remains normal validated track input");
        JsonObject pivot = TrackInterpolation.splitPlan(p, time, original, "f2", "left", "right");
        check(Json.array(Json.object(pivot, "leftTrack"), "keyframes").size() == 1 && Json.required(Json.array(Json.object(pivot, "rightTrack"), "keyframes").get(0).getAsJsonObject(), "frameId").equals("f2"), "exact split key belongs to right child");
        rejects("track_interpolation_invalid", () -> TrackInterpolation.splitPlan(p, time, original, "f0", "l", "r"));
        rejects("track_interpolation_invalid", () -> TrackInterpolation.splitPlan(p, time, original, "f3", "same", "same"));
        JsonObject overlapping = track(p, key(1, 10), key(4, 30)); overlapping.addProperty("trackId", "overlap");
        rejects("track_identity_conflict", () -> TrackInterpolation.mergePlan(p, time, left, overlapping, "merged"));
        JsonObject different = right.deepCopy(); different.addProperty("objectId", "different"); for (JsonElement key : Json.array(different, "keyframes")) key.getAsJsonObject().addProperty("objectId", "different");
        rejects("track_identity_conflict", () -> TrackInterpolation.mergePlan(p, time, left, different, "merged"));
        JsonObject differentClass = right.deepCopy(); for (JsonElement key : Json.array(differentClass, "keyframes")) Json.object(key.getAsJsonObject(), "annotation").addProperty("classId", "other");
        rejects("track_identity_conflict", () -> TrackInterpolation.mergePlan(p, time, left, differentClass, "merged"));
        JsonObject duplicate = right.deepCopy(); Json.array(duplicate, "keyframes").get(0).getAsJsonObject().addProperty("keyframeId", "k0");
        rejects("track_identity_conflict", () -> TrackInterpolation.mergePlan(p, time, left, duplicate, "merged"));
        JsonObject entered = right.deepCopy(); Json.array(entered, "keyframes").get(0).getAsJsonObject().addProperty("state", "enter");
        JsonObject mergedBoundary = TrackInterpolation.mergePlan(p, time, left, entered, "merged");
        check(Json.bool(Json.object(mergedBoundary, "addedInterval"), "blocked", false) && Json.bool(mergedBoundary, "requiresReview", false), "merge plan retains entry boundary instead of reconnecting it");
    }

    private static void stableIdentity() {
        JsonObject p = project("detect"), time = timeline(5), t = track(p, key(0, 10), key(4, 30)); JsonObject original = generate(p, time, t);
        JsonObject reordered = time.deepCopy(); JsonArray reversedFrames = new JsonArray(); for (int i = 4; i >= 0; i--) reversedFrames.add(at(reordered, i)); reordered.add("frames", reversedFrames);
        JsonObject reversed = t.deepCopy(); reversed.add("keyframes", Json.arr(Json.array(t, "keyframes").get(1), Json.array(t, "keyframes").get(0)));
        check(generate(p, reordered, reversed).equals(original), "input arrays are normalized by actual time, never by ID");
        JsonObject recolored = p.deepCopy(); Json.array(recolored, "classes").get(0).getAsJsonObject().addProperty("color", "#FFFFFF");
        check(generate(recolored, time, t).equals(original), "UI class colors are outside frozen semantic identity");
        JsonObject semantic = p.deepCopy(); Json.object(semantic, "settings").add("occlusionRules", Json.arr("改变语义"));
        rejects("track_identity_conflict", () -> generate(semantic, time, t));
        JsonObject version = time.deepCopy(); at(version, 2).addProperty("annotationVersion", 5);
        check(!hash(original, "generationHash").equals(hash(generate(p, version, t), "generationHash")), "annotation revision enters generation identity");
        JsonObject endpoint = time.deepCopy(); Json.object(at(endpoint, 0), "baseline").addProperty("contentHash", "b".repeat(64));
        check(!hash(first(original), "candidateId").equals(hash(first(generate(p, endpoint, t)), "candidateId")), "source endpoint baseline identity is frozen in each candidate");
        JsonObject scene = time.deepCopy(); at(scene, 2).remove("sceneId");
        check(!hash(first(original), "candidateId").equals(hash(first(generate(p, scene, t)), "candidateId")), "changed interval review status changes candidate identity");
        JsonObject defaultOptions = Json.obj("maxGapSeconds", 2.0, "maxCenterSpeedPixelsPerSecond", 500.0, "maxKeypointSpeedPixelsPerSecond", 500, "maxScaleFactor", 2.0);
        check(TrackInterpolation.interpolate(p, time, t, defaultOptions).equals(original), "explicit defaults and numeric formatting are idempotent");
    }

    private static void invalidInputs() {
        JsonObject p = project("detect"), time = timeline(3), t = track(p, key(0, 10), key(2, 20));
        JsonObject duplicate = time.deepCopy(); at(duplicate, 1).addProperty("pts", "0");
        rejects("track_interpolation_invalid", () -> generate(p, duplicate, t));
        JsonObject mismatched = time.deepCopy(); at(mismatched, 1).add("time", Json.obj("numerator", "1", "denominator", "5"));
        rejects("track_interpolation_invalid", () -> generate(p, mismatched, t));
        JsonObject nonpositive = time.deepCopy(); Json.object(at(nonpositive, 1), "timeBase").addProperty("numerator", "0");
        rejects("track_interpolation_invalid", () -> generate(p, nonpositive, t));
        JsonObject negativeDenominator = time.deepCopy(); Json.object(at(negativeDenominator, 1), "timeBase").addProperty("denominator", "-1");
        rejects("track_interpolation_invalid", () -> generate(p, negativeDenominator, t));
        JsonObject tooLong = time.deepCopy(); at(tooLong, 1).addProperty("pts", "1".repeat(81));
        rejects("track_interpolation_invalid", () -> generate(p, tooLong, t));
        JsonObject source = time.deepCopy(); at(source, 1).addProperty("sourceVideoId", "another-video");
        rejects("track_identity_conflict", () -> generate(p, source, t));
        JsonObject size = time.deepCopy(); Json.object(at(size, 1), "baseline").addProperty("width", 101);
        rejects("track_identity_conflict", () -> generate(p, size, t));
        JsonObject objectConflict = t.deepCopy(); Json.array(objectConflict, "keyframes").get(1).getAsJsonObject().addProperty("objectId", "wrong");
        rejects("track_identity_conflict", () -> generate(p, time, objectConflict));
        JsonObject classConflict = t.deepCopy(); Json.object(Json.array(classConflict, "keyframes").get(1).getAsJsonObject(), "annotation").addProperty("classId", "other");
        rejects("track_identity_conflict", () -> generate(p, time, classConflict));
        JsonObject invalidAnnotation = t.deepCopy(); Json.object(Json.object(Json.array(invalidAnnotation, "keyframes").get(1).getAsJsonObject(), "annotation"), "bbox").addProperty("x", -1);
        rejects("track_annotation_invalid", () -> generate(p, time, invalidAnnotation));
        rejects("track_identity_conflict", () -> generate(p, time, track(p, key(0, 10), key(0, 20))));
        rejects("track_interpolation_invalid", () -> generate(p, time, track(p, key(0, "unlocatable", box("a", 10)), key(2, 20))));
        rejects("track_interpolation_invalid", () -> TrackInterpolation.interpolate(p, time, t, Json.obj("maxGapSeconds", 0)));
        rejects("track_interpolation_invalid", () -> TrackInterpolation.interpolate(p, time, t, Json.obj("maxScaleFactor", 0.5)));
        rejects("track_interpolation_invalid", () -> TrackInterpolation.interpolate(p, time, t, Json.obj("unknownOption", 1)));
        rejects("track_interpolation_unsupported", () -> TrackInterpolation.templateHash(project("obb")));
    }

    private static void limits() {
        JsonObject p = project("detect"), t = track(p, key(0, 10), key(2, 20));
        rejects("track_interpolation_limit", () -> generate(p, timeline(10_001), t));
        JsonObject poseProject = project("pose"); JsonArray names = new JsonArray(), points = new JsonArray();
        for (int i = 0; i < 1025; i++) { names.add("point-" + i); points.add(point("point-" + i, 10, 10, 2)); }
        Json.object(poseProject, "settings").add("keypointNames", names); JsonObject a = box("a", 10), b = box("b", 20);
        a.addProperty("type", "pose"); b.addProperty("type", "pose"); a.add("keypoints", points); b.add("keypoints", points.deepCopy());
        JsonObject poseTrack = track(poseProject, key(0, "located", a), key(65, "located", b));
        rejects("track_interpolation_limit", () -> generate(poseProject, timeline(66), poseTrack));
        JsonObject huge = t.deepCopy(); JsonObject annotation = Json.object(Json.array(huge, "keyframes").get(0).getAsJsonObject(), "annotation");
        for (int i = 0; i < 65; i++) annotation.addProperty("extra" + i, i);
        rejects("track_interpolation_limit", () -> generate(p, timeline(3), huge));
    }
}
