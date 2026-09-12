package cn.autolabel.engine;

import com.google.gson.*;
import java.math.*;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.util.*;

/** 只生成基准图坐标下的轨迹候选；保存方仍须在事务内核对人工版本保护条件。 */
final class TrackInterpolation {
    static final String VERSION = "baseline-track-linear-v1";
    static final int MAX_FRAMES = 10_000, MAX_POINTS = 65_536, MAX_INTEGER_LENGTH = 80;
    private static final MathContext PRECISION = MathContext.DECIMAL128;
    private static final Set<String> STATES = Set.of("located", "occluded", "enter", "exit", "unlocatable");
    private static final Set<String> ANNOTATION_STATES = Set.of("empty", "candidate", "manual", "confirmed");
    private TrackInterpolation() {}

    static String templateHash(JsonObject project) { return project(project).hash; }

    static JsonObject interpolate(JsonObject project, JsonObject timeline, JsonObject track, JsonObject options) {
        Context context = context(project, timeline); Track fixed = track(context, track, false);
        JsonObject thresholds = options(options); JsonArray candidates = new JsonArray(), skipped = new JsonArray(), intervals = new JsonArray();
        Set<String> keyed = new HashSet<>(); fixed.keys.forEach(key -> keyed.add(key.frame.id));
        Set<String> handled = new HashSet<>(); int outputPoints = 0; boolean requiresReview = false;
        for (int i = 1; i < fixed.keys.size(); i++) {
            Key left = fixed.keys.get(i - 1), right = fixed.keys.get(i);
            Interval interval = interval(context, left, right, thresholds); JsonObject detail = interval.json.deepCopy();
            int generated = 0, protectedCount = 0;
            for (int index = left.frame.index + 1; index < right.frame.index; index++) {
                Frame frame = context.timeline.frames.get(index); handled.add(frame.id);
                if (frame.protectedByHuman()) { skipped.add(skipped(frame, "human_protected", "该帧已有人工修改或确认，保留现有版本。")); protectedCount++; continue; }
                if (interval.blocked) { skipped.add(skipped(frame, "interval_blocked", "关键帧之间存在明确边界，未生成候选。")); continue; }
                int pointCount = context.project.task.equals("pose") ? Json.array(left.annotation, "keypoints").size() : 0;
                if (candidates.size() >= MAX_FRAMES || outputPoints > MAX_POINTS - pointCount) throw limit("生成候选或关键点总数超过限制，请缩小时间范围。");
                candidates.add(candidate(context, fixed, left, right, frame, interval, thresholds));
                outputPoints += pointCount; generated++;
            }
            detail.addProperty("candidateCount", generated); detail.addProperty("protectedFrameCount", protectedCount); intervals.add(detail);
            requiresReview |= interval.requiresReview;
        }
        for (Frame frame : context.timeline.frames) if (!handled.contains(frame.id)) {
            String reason = frame.protectedByHuman() ? "human_protected" : keyed.contains(frame.id) ? "keyframe" : "outside_keyframes";
            skipped.add(skipped(frame, reason, reason.equals("keyframe") ? "保留显式关键帧，不生成替代版本。" : reason.equals("human_protected") ? "保留人工版本。" : "没有包围该帧的两个关键帧，不外推目标。"));
        }
        sortByFrame(skipped, context.timeline);
        JsonObject output = Json.obj("algorithmVersion", VERSION, "validatorVersion", TaskTemplates.VALIDATOR_VERSION,
            "sourceVideoId", fixed.source, "trackId", fixed.id, "objectId", fixed.objectId,
            "templateHash", context.project.hash, "templateSnapshot", context.project.semantic.deepCopy(), "coordinateSpace", "baseline",
            "candidateOnly", true, "humanConfirmed", false, "requiresReview", requiresReview,
            "thresholds", thresholds, "candidates", candidates, "intervals", intervals, "skipped", skipped,
            "statistics", Json.obj("framesTotal", context.timeline.frames.size(), "keyframes", fixed.keys.size(), "candidates", candidates.size(), "outputPoints", outputPoints));
        output.addProperty("generationHash", digest(Json.obj("algorithmVersion", VERSION, "validatorVersion", TaskTemplates.VALIDATOR_VERSION,
            "template", context.project.semantic, "timeline", context.timeline.snapshot, "track", fixed.snapshot, "thresholds", thresholds)));
        return output;
    }

    /** 旧、新相邻区间的差集覆盖端点编辑、移动、插入和删除；人工帧只列为保护项。 */
    static JsonObject affectedIntervals(JsonObject project, JsonObject timeline, JsonObject beforeTrack, JsonObject afterTrack) {
        Context context = context(project, timeline); Track before = track(context, beforeTrack, true), after = track(context, afterTrack, true);
        sameIdentity(before, after, true);
        Map<String, JsonObject> oldIntervals = pairs(before), newIntervals = pairs(after);
        JsonArray changed = new JsonArray(), affected = new JsonArray(); SortedSet<Integer> indexes = new TreeSet<>();
        Map<String, Key> oldKeys = keyMap(before), newKeys = keyMap(after); SortedSet<String> ids = new TreeSet<>(oldKeys.keySet()); ids.addAll(newKeys.keySet());
        for (String id : ids) {
            Key a = oldKeys.get(id), b = newKeys.get(id);
            if (a != null && b != null && a.hash.equals(b.hash)) continue;
            changed.add(Json.obj("keyframeId", id, "before", a == null ? null : a.snapshot.deepCopy(), "after", b == null ? null : b.snapshot.deepCopy()));
            if (a != null) indexes.add(a.frame.index); if (b != null) indexes.add(b.frame.index);
        }
        addChangedPairs(oldIntervals, newIntervals, "before", affected, indexes, context.timeline);
        addChangedPairs(newIntervals, oldIntervals, "after", affected, indexes, context.timeline);
        List<JsonElement> sorted = new ArrayList<>(affected.asList()); sorted.sort(Comparator
            .comparingInt((JsonElement value) -> context.timeline.byId.get(Json.required(value.getAsJsonObject(), "leftFrameId")).index)
            .thenComparing(value -> Json.required(value.getAsJsonObject(), "phase"))
            .thenComparing(value -> Json.required(value.getAsJsonObject(), "intervalId")));
        affected = new JsonArray(); sorted.forEach(affected::add);
        JsonObject output = Json.obj("algorithmVersion", VERSION, "sourceVideoId", before.source, "trackId", before.id,
            "templateHash", context.project.hash, "beforeTrackHash", digest(before.snapshot), "afterTrackHash", digest(after.snapshot),
            "candidateOnly", true, "humanConfirmed", false, "changedKeyframes", changed, "affectedIntervals", affected,
            "requiresRecompute", !changed.isEmpty());
        addFrameScope(output, indexes, context.timeline, after, true); output.addProperty("planHash", digest(output)); return output;
    }

    /** 拆分边界归右轨迹，不虚构边界关键帧；原来跨越边界的候选区间由调用方失效。 */
    static JsonObject splitPlan(JsonObject project, JsonObject timeline, JsonObject track, String splitFrameId, String leftTrackId, String rightTrackId) {
        Context context = context(project, timeline); Track fixed = track(context, track, false);
        String leftId = id(leftTrackId, "leftTrackId"), rightId = id(rightTrackId, "rightTrackId");
        if (leftId.equals(rightId)) throw invalid("拆分后的两个轨迹 ID 必须不同。");
        Frame split = frame(context.timeline, splitFrameId); List<Key> left = new ArrayList<>(), right = new ArrayList<>();
        for (Key key : fixed.keys) (key.frame.time.compareTo(split.time) < 0 ? left : right).add(key);
        if (left.isEmpty() || right.isEmpty()) throw invalid("拆分两侧都需要已有关键帧；不会自动补造边界关键帧。");
        Key a = left.get(left.size() - 1), b = right.get(0); JsonObject bridge = pair(a, b);
        JsonObject output = Json.obj("algorithmVersion", VERSION, "kind", "track_split_plan", "sourceVideoId", fixed.source,
            "templateHash", context.project.hash, "sourceTrackId", fixed.id, "sourceTrackHash", digest(fixed.snapshot),
            "splitFrameId", split.id, "splitTime", split.time.json(), "boundaryOwner", "right", "candidateOnly", true, "humanConfirmed", false,
            "leftTrack", trackSnapshot(leftId, fixed.objectId, fixed.source, context.project.hash, left),
            "rightTrack", trackSnapshot(rightId, fixed.objectId, fixed.source, context.project.hash, right), "removedInterval", bridge);
        addFrameScope(output, range(a.frame.index, b.frame.index), context.timeline, fixed, false);
        output.addProperty("planHash", digest(output)); return output;
    }

    /** 合并只形成可审查的轨迹计划；不同身份、模板和重叠时间域不自动选取胜者。 */
    static JsonObject mergePlan(JsonObject project, JsonObject timeline, JsonObject leftTrack, JsonObject rightTrack, String mergedTrackId) {
        Context context = context(project, timeline); Track a = track(context, leftTrack, false), b = track(context, rightTrack, false);
        sameIdentity(a, b, false); if (a.id.equals(b.id)) throw invalid("不能将同一轨迹与自身合并。");
        if (a.keys.get(0).frame.time.compareTo(b.keys.get(0).frame.time) > 0) { Track swap = a; a = b; b = swap; }
        Key end = a.keys.get(a.keys.size() - 1), start = b.keys.get(0);
        if (end.frame.time.compareTo(start.frame.time) >= 0) throw conflict("轨迹时间范围存在重叠，必须先人工解决对象身份和关键帧冲突。");
        Set<String> ids = new HashSet<>(); for (Key key : a.keys) ids.add(key.id);
        for (Key key : b.keys) if (!ids.add(key.id)) throw conflict("合并轨迹含重复关键帧 ID。");
        List<Key> keys = new ArrayList<>(a.keys); keys.addAll(b.keys);
        JsonObject merged = trackSnapshot(id(mergedTrackId, "mergedTrackId"), a.objectId, a.source, context.project.hash, keys);
        Track validated = track(context, merged, false); JsonObject thresholds = options(null); Interval bridge = interval(context, end, start, thresholds);
        JsonObject output = Json.obj("algorithmVersion", VERSION, "kind", "track_merge_plan", "sourceVideoId", a.source,
            "templateHash", context.project.hash, "sourceTrackIds", Json.arr(a.id, b.id), "sourceTrackHashes", Json.arr(digest(a.snapshot), digest(b.snapshot)),
            "candidateOnly", true, "humanConfirmed", false, "track", merged, "addedInterval", bridge.json,
            "requiresReview", bridge.requiresReview, "thresholds", thresholds);
        addFrameScope(output, range(end.frame.index, start.frame.index), context.timeline, validated, !bridge.blocked);
        output.addProperty("planHash", digest(output)); return output;
    }

    private static JsonObject candidate(Context context, Track track, Key left, Key right, Frame frame, Interval interval, JsonObject thresholds) {
        Rational ratio = frame.time.subtract(left.frame.time).divide(right.frame.time.subtract(left.frame.time));
        JsonObject identity = Json.obj("algorithmVersion", VERSION, "validatorVersion", TaskTemplates.VALIDATOR_VERSION,
            "trackId", track.id, "objectId", track.objectId, "sourceVideoId", track.source, "templateHash", context.project.hash,
            "frame", frame.snapshot, "leftKeyframeHash", left.hash, "rightKeyframeHash", right.hash,
            "intervalHash", digest(interval.json), "ratio", ratio.json(), "thresholds", thresholds);
        String candidateId = "track-candidate-" + digest(identity); JsonObject a = left.annotation, b = right.annotation;
        JsonObject box = new JsonObject(); for (String field : List.of("x", "y", "width", "height"))
            box.addProperty(field, mix(Json.object(a, "bbox").get(field), Json.object(b, "bbox").get(field), ratio));
        JsonObject annotation = Json.obj("id", candidateId, "classId", a.get("classId"), "type", context.project.task, "bbox", box);
        JsonArray dispositions = new JsonArray();
        if (context.project.task.equals("pose")) {
            JsonArray points = new JsonArray(), l = Json.array(a, "keypoints"), r = Json.array(b, "keypoints");
            for (int i = 0; i < l.size(); i++) {
                JsonObject p = l.get(i).getAsJsonObject(), q = r.get(i).getAsJsonObject();
                int visibility = Math.min(Json.integer(p, "visibility", 0), Json.integer(q, "visibility", 0));
                String name = Json.required(p, "name"); points.add(Json.obj("name", name, "visibility", visibility,
                    "x", visibility == 0 ? 0 : mix(p.get("x"), q.get("x"), ratio), "y", visibility == 0 ? 0 : mix(p.get("y"), q.get("y"), ratio)));
                dispositions.add(Json.obj("name", name, "leftVisibility", p.get("visibility"), "rightVisibility", q.get("visibility"),
                    "candidateVisibility", visibility, "method", visibility == 0 ? "unlocatable_zero" : "linear_time"));
            }
            annotation.add("keypoints", points);
        }
        JsonArray validated = Annotations.validateGeometry(Json.arr(annotation), frame.baseline, context.project.project);
        JsonObject provenance = Json.obj("kind", "track_interpolation", "algorithmVersion", VERSION, "sourceVideoId", track.source,
            "trackId", track.id, "objectId", track.objectId, "templateHash", context.project.hash, "keyframeIds", Json.arr(left.id, right.id),
            "endpointAnnotationIds", Json.arr(Json.required(a, "id"), Json.required(b, "id")), "endpointHashes", Json.arr(left.hash, right.hash),
            "endpointFrames", Json.arr(left.frame.snapshot.deepCopy(), right.frame.snapshot.deepCopy()),
            "endpointStates", Json.arr(left.state, right.state), "intervalId", Json.required(interval.json, "intervalId"), "ratio", ratio.json(),
            "frameTime", frame.time.json(), "coordinateSpace", "baseline", "pointDispositions", dispositions,
            "metrics", interval.json.get("metrics").deepCopy(), "thresholds", thresholds.deepCopy());
        return Json.obj("candidateId", candidateId, "frameId", frame.id, "baseline", frame.baseline.deepCopy(),
            "annotations", validated, "candidateOnly", true, "humanConfirmed", false, "requiresReview", interval.requiresReview,
            "reviewIssues", interval.json.get("reviewIssues").deepCopy(), "source", provenance, "applyPrecondition", precondition(frame));
    }

    private static Interval interval(Context context, Key left, Key right, JsonObject thresholds) {
        JsonArray issues = new JsonArray(); boolean blocked = false;
        if (left.state.equals("exit")) { issues.add(issue("exit_boundary", "左端已标记离开，不能向后连接。", "error")); blocked = true; }
        if (right.state.equals("enter")) { issues.add(issue("enter_boundary", "右端为进入点，不能从之前的帧连接。", "error")); blocked = true; }
        if (left.state.equals("unlocatable") || right.state.equals("unlocatable")) {
            issues.add(issue("unlocatable_boundary", "区间端点不可定位，不跨越该区间捏造几何。", "error")); blocked = true;
        }
        Set<String> scenes = new TreeSet<>(); boolean unchecked = false;
        for (int i = left.frame.index; i <= right.frame.index; i++) {
            String scene = context.timeline.frames.get(i).scene; if (scene == null) unchecked = true; else scenes.add(scene);
        }
        if (scenes.size() > 1) { issues.add(issue("scene_boundary", "输入的场景分段在该区间发生变化，禁止跨场景插值。", "error")); blocked = true; }
        if (unchecked) issues.add(issue("scene_unchecked", "该区间缺少完整的人工或既有场景分段，候选必须复核。", "warning"));
        JsonObject metrics = Json.obj("duration", right.frame.time.subtract(left.frame.time).json(),
            "durationSeconds", right.frame.time.subtract(left.frame.time).decimal(), "sceneIds", Json.element(scenes), "sceneCheckComplete", !unchecked);
        if (!blocked) {
            JsonObject a = Json.object(left.annotation, "bbox"), b = Json.object(right.annotation, "bbox");
            double centerDistance = Math.hypot(center(b, "x", "width") - center(a, "x", "width"), center(b, "y", "height") - center(a, "y", "height"));
            BigDecimal seconds = right.frame.time.subtract(left.frame.time).decimal();
            BigDecimal speed = BigDecimal.valueOf(centerDistance).divide(seconds, PRECISION), scale = BigDecimal.ONE;
            for (String field : List.of("width", "height")) {
                BigDecimal x = a.get(field).getAsBigDecimal(), y = b.get(field).getAsBigDecimal();
                scale = scale.max(x.divide(y, PRECISION)).max(y.divide(x, PRECISION));
            }
            double pointDistance = 0; JsonArray unlocatable = new JsonArray();
            if (context.project.task.equals("pose")) {
                JsonArray p = Json.array(left.annotation, "keypoints"), q = Json.array(right.annotation, "keypoints");
                for (int i = 0; i < p.size(); i++) {
                    JsonObject x = p.get(i).getAsJsonObject(), y = q.get(i).getAsJsonObject();
                    if (Json.integer(x, "visibility", 0) == 0 || Json.integer(y, "visibility", 0) == 0) unlocatable.add(Json.required(x, "name"));
                    else pointDistance = Math.max(pointDistance, Math.hypot(Annotations.num(y, "x") - Annotations.num(x, "x"), Annotations.num(y, "y") - Annotations.num(x, "y")));
                }
            }
            BigDecimal pointSpeed = BigDecimal.valueOf(pointDistance).divide(seconds, PRECISION);
            metrics.addProperty("centerDistancePixels", centerDistance); metrics.addProperty("centerSpeedPixelsPerSecond", speed);
            metrics.addProperty("maxKeypointDistancePixels", pointDistance); metrics.addProperty("maxKeypointSpeedPixelsPerSecond", pointSpeed); metrics.addProperty("scaleFactor", scale);
            compareThreshold(issues, seconds, thresholds, "maxGapSeconds", "long_keyframe_gap", "关键帧时间间隔超过阈值，请补充关键帧或检查候选。");
            compareThreshold(issues, speed, thresholds, "maxCenterSpeedPixelsPerSecond", "rapid_center_motion", "框中心变化速度超过阈值，需要检查插值结果。");
            compareThreshold(issues, pointSpeed, thresholds, "maxKeypointSpeedPixelsPerSecond", "rapid_keypoint_motion", "关键点变化速度超过阈值，需要检查点位对应关系。");
            compareThreshold(issues, scale, thresholds, "maxScaleFactor", "rapid_size_change", "框尺寸变化比例超过阈值，需要检查插值结果。");
            if (!unlocatable.isEmpty()) issues.add(Json.obj("code", "keypoint_unlocatable", "severity", "warning", "message", "部分关键点端点不可定位，候选对应点保留 visibility=0、坐标为 0。", "keypointNames", unlocatable));
            Set<String> omitted = new TreeSet<>(); Set<String> geometry = Set.of("id", "classId", "type", "bbox", "keypoints", "confidence");
            for (JsonObject annotation : List.of(left.annotation, right.annotation)) for (String field : annotation.keySet()) if (!geometry.contains(field)) omitted.add(field);
            if (!omitted.isEmpty()) issues.add(Json.obj("code", "annotation_metadata_not_interpolated", "severity", "warning", "message", "候选只插值几何，端点附加属性需要人工检查。", "fields", Json.element(omitted)));
        }
        boolean review = !issues.isEmpty(); JsonObject output = pair(left, right);
        output.addProperty("blocked", blocked); output.addProperty("requiresReview", review); output.add("reviewIssues", issues);
        output.add("metrics", metrics); output.add("thresholds", thresholds.deepCopy());
        output.addProperty("scenePolicy", "input_supplied_scene_ids"); output.addProperty("trackingPerformed", false);
        return new Interval(blocked, review, output);
    }

    private static void compareThreshold(JsonArray issues, BigDecimal actual, JsonObject thresholds, String field, String code, String message) {
        BigDecimal threshold = thresholds.get(field).getAsBigDecimal();
        if (actual.compareTo(threshold) > 0) issues.add(Json.obj("code", code, "severity", "warning", "message", message,
            "metricValue", actual, "thresholdName", field, "threshold", threshold));
    }
    private static double center(JsonObject box, String origin, String size) { return Annotations.num(box, origin) + Annotations.num(box, size) / 2; }
    private static double mix(JsonElement left, JsonElement right, Rational ratio) {
        // 先用精确时间权重计算十进制坐标，最后一次转 double；大 PTS 不会先被浮点数吞掉差值。
        BigDecimal a = left.getAsBigDecimal(), b = right.getAsBigDecimal();
        return a.multiply(new BigDecimal(ratio.denominator.subtract(ratio.numerator)))
            .add(b.multiply(new BigDecimal(ratio.numerator))).divide(new BigDecimal(ratio.denominator), PRECISION).doubleValue();
    }

    private static Context context(JsonObject project, JsonObject timeline) {
        Project fixed = project(project); bounded(timeline); return new Context(fixed, timeline(timeline));
    }
    private static Project project(JsonObject input) {
        bounded(input); String task = string(input, "taskType");
        if (!Set.of("detect", "pose").contains(task)) throw new ApiError(422, "track_interpolation_unsupported", "首版轨迹插值仅支持 Detect 和 Pose。");
        JsonArray classes = array(input, "classes"); if (classes.isEmpty()) throw invalid("冻结模板必须含有类别。");
        try { Annotations.classes(classes); } catch (RuntimeException error) { throw invalid("冻结类别模板无效：" + error.getMessage()); }
        if (task.equals("pose")) {
            JsonArray names = array(object(input, "settings"), "keypointNames"); Set<String> unique = new HashSet<>();
            if (names.isEmpty() || names.size() > MAX_POINTS) throw invalid("Pose 模板必须包含有限个有序关键点。");
            for (JsonElement name : names) if (!name.isJsonPrimitive() || !name.getAsJsonPrimitive().isString() || !unique.add(id(name.getAsString(), "keypointName"))) throw invalid("Pose 关键点名称必须唯一且有意义。");
        }
        JsonObject copy = input.deepCopy(), semantic = TaskTemplates.semantic(copy); return new Project(copy, semantic, digest(semantic), task);
    }
    private static Timeline timeline(JsonObject input) {
        String source = string(input, "sourceVideoId"); JsonArray entries = array(input, "frames");
        if (entries.isEmpty() || entries.size() > MAX_FRAMES) throw limit("时间轴需要 1～10000 个帧。");
        List<Frame> frames = new ArrayList<>(); Set<String> ids = new HashSet<>(); Map<String, JsonObject> baselines = new HashMap<>(); int width = -1, height = -1;
        for (JsonElement entry : entries) {
            JsonObject raw = asObject(entry, "frame"); String frameId = string(raw, "frameId");
            if (!ids.add(frameId)) throw invalid("时间轴帧 ID 重复。");
            if (raw.has("sourceVideoId") && !source.equals(string(raw, "sourceVideoId"))) throw conflict("帧来自不同视频，不能连接。");
            Rational time = frameTime(raw); String scene = raw.has("sceneId") && !raw.get("sceneId").isJsonNull() ? string(raw, "sceneId") : null;
            JsonObject baseline = object(raw, "baseline"); String baselineId = string(baseline, "id"), hash = string(baseline, "contentHash");
            if (!hash.matches("[0-9a-fA-F]{64}")) throw invalid("基准图需要固定的 SHA-256 身份。");
            int w = integer(baseline, "width", 1, 20_000), h = integer(baseline, "height", 1, 20_000);
            if ((long)w * h > 40_000_000) throw limit("基准图像素总数超过限制。");
            long baselineVersion = longInteger(baseline, "version"), annotationVersion = longInteger(raw, "annotationVersion");
            if (width < 0) { width = w; height = h; } else if (width != w || height != h) throw conflict("同一轨迹只能使用同尺寸基准图，必须先固定坐标变换。");
            String state = string(raw, "annotationState"); if (!ANNOTATION_STATES.contains(state)) throw invalid("帧 annotationState 必须明确是否有人工修改。");
            JsonObject fixedBaseline = Json.obj("id", baselineId, "contentHash", hash.toLowerCase(Locale.ROOT), "width", w, "height", h, "version", baselineVersion);
            JsonObject previous = baselines.putIfAbsent(baselineId, fixedBaseline);
            if (previous != null && !previous.equals(fixedBaseline)) throw conflict("同一基准图 ID 对应了不一致的内容或版本。");
            JsonObject snapshot = Json.obj("frameId", frameId, "sourceVideoId", source, "time", time.json(), "sceneId", scene,
                "baseline", fixedBaseline, "annotationVersion", annotationVersion, "annotationState", state);
            frames.add(new Frame(frameId, time, scene, fixedBaseline, annotationVersion, state, snapshot, -1));
        }
        frames.sort(Comparator.comparing(Frame::time)); Map<String, Frame> byId = new HashMap<>(); JsonArray snapshots = new JsonArray();
        for (int i = 0; i < frames.size(); i++) {
            Frame raw = frames.get(i); if (i > 0 && raw.time.compareTo(frames.get(i - 1).time) == 0) throw invalid("时间轴包含相同实际时间，不能按帧 ID 猜测先后。");
            Frame frame = new Frame(raw.id, raw.time, raw.scene, raw.baseline, raw.annotationVersion, raw.state, raw.snapshot, i);
            frames.set(i, frame); byId.put(frame.id, frame); snapshots.add(frame.snapshot);
        }
        return new Timeline(source, frames, byId, Json.obj("sourceVideoId", source, "frames", snapshots));
    }
    private static Rational frameTime(JsonObject frame) {
        Rational exact = frame.has("time") ? rational(object(frame, "time"), false) : null;
        boolean anyPts = frame.has("pts") || frame.has("timeBase");
        if (anyPts) {
            BigInteger pts = bigInteger(frame.get("pts"), "pts", false); Rational base = rational(object(frame, "timeBase"), true);
            Rational fromPts = new Rational(pts.multiply(base.numerator), base.denominator);
            if (exact != null && exact.compareTo(fromPts) != 0) throw invalid("帧的 PTS/timeBase 与精确时间不一致。"); exact = fromPts;
        }
        if (exact == null) throw invalid("每帧需要真实 PTS/timeBase 或精确有理时间。"); return exact;
    }
    private static Rational rational(JsonObject input, boolean positive) {
        return new Rational(bigInteger(input.get("numerator"), "numerator", positive), bigInteger(input.get("denominator"), "denominator", true));
    }
    private static BigInteger bigInteger(JsonElement element, String field, boolean positive) {
        if (element == null || !element.isJsonPrimitive() || element.getAsJsonPrimitive().isBoolean()) throw invalid(field + " 必须是十进制整数。");
        String text = element.getAsString(); if (text.length() > MAX_INTEGER_LENGTH || !text.matches("-?[0-9]+")) throw invalid(field + " 必须是不超过 80 字符的十进制整数。");
        BigInteger value = new BigInteger(text); if (positive && value.signum() <= 0) throw invalid(field + " 必须大于 0。"); return value;
    }
    private static Track track(Context context, JsonObject input, boolean allowEmpty) {
        bounded(input); String trackId = string(input, "trackId"), objectId = string(input, "objectId"), source = string(input, "sourceVideoId"), hash = string(input, "templateHash");
        if (!source.equals(context.timeline.source)) throw conflict("轨迹与时间轴不是同一来源视频。");
        if (!hash.equals(context.project.hash)) throw conflict("轨迹冻结模板与当前语义模板不一致。");
        JsonArray entries = array(input, "keyframes"); if ((!allowEmpty && entries.isEmpty()) || entries.size() > MAX_FRAMES) throw limit("轨迹关键帧数量无效。");
        Set<String> ids = new HashSet<>(), frameIds = new HashSet<>(); List<Key> keys = new ArrayList<>(); String classId = null; int points = 0;
        for (JsonElement entry : entries) {
            JsonObject raw = asObject(entry, "keyframe"); String keyId = string(raw, "keyframeId"), state = string(raw, "state");
            if (!ids.add(keyId) || !frameIds.add(string(raw, "frameId"))) throw conflict("轨迹包含重复关键帧 ID 或同帧多个对象。");
            if (!objectId.equals(string(raw, "objectId"))) throw conflict("关键帧对象身份与显式轨迹冲突。");
            if (!STATES.contains(state)) throw invalid("关键帧状态无效。"); Frame frame = frame(context.timeline, string(raw, "frameId"));
            JsonObject annotation = null;
            if (state.equals("unlocatable")) {
                if (raw.has("annotation") && !raw.get("annotation").isJsonNull()) throw invalid("不可定位关键帧不能同时提供可定位几何。");
            } else {
                JsonObject original = object(raw, "annotation");
                if (original.size() > 64) throw limit("关键帧单对象附加字段过多，不能无界复制候选诊断。");
                points += Json.array(original, "keypoints").size();
                if (points > MAX_POINTS) throw limit("关键帧关键点总数超过限制。");
                if (context.project.task.equals("pose")) for (JsonElement point : array(original, "keypoints")) integer(asObject(point, "keypoint"), "visibility", 0, 2);
                try { annotation = Annotations.validate(Json.arr(original), frame.baseline, context.project.project).get(0).getAsJsonObject(); }
                catch (RuntimeException error) { throw new ApiError(422, "track_annotation_invalid", "关键帧标注无效：" + error.getMessage(), Json.obj("keyframeId", keyId)); }
                String category = Json.required(annotation, "classId"); if (classId == null) classId = category;
                else if (!classId.equals(category)) throw conflict("同一轨迹的关键帧类别冲突，不能自动连接。");
            }
            JsonObject snapshot = Json.obj("keyframeId", keyId, "frameId", frame.id, "objectId", objectId, "state", state, "annotation", annotation);
            keys.add(new Key(keyId, frame, state, annotation, snapshot, digest(Json.obj("keyframe", snapshot, "frame", frame.snapshot))));
        }
        keys.sort(Comparator.comparing(key -> key.frame.time));
        return new Track(trackId, objectId, source, hash, keys, trackSnapshot(trackId, objectId, source, hash, keys));
    }
    static JsonObject options(JsonObject raw) {
        JsonObject result = Json.obj("maxGapSeconds", 2, "maxCenterSpeedPixelsPerSecond", 500, "maxKeypointSpeedPixelsPerSecond", 500, "maxScaleFactor", 2);
        if (raw != null) {
            bounded(raw); for (String field : raw.keySet()) {
                if (!result.has(field)) throw invalid("未知插值阈值：" + field);
                JsonElement value = raw.get(field); if (!value.isJsonPrimitive() || !value.getAsJsonPrimitive().isNumber()) throw invalid("插值阈值必须是数值。");
                BigDecimal number = value.getAsBigDecimal(); if (number.signum() <= 0 || number.compareTo(BigDecimal.valueOf(1e12)) > 0 || field.equals("maxScaleFactor") && number.compareTo(BigDecimal.ONE) < 0) throw invalid("插值阈值超出允许范围。");
                result.addProperty(field, number.stripTrailingZeros());
            }
        }
        return result;
    }

    private static JsonObject trackSnapshot(String id, String objectId, String source, String hash, List<Key> keys) {
        JsonArray values = new JsonArray(); for (Key key : keys) values.add(key.snapshot.deepCopy());
        return Json.obj("trackId", id, "objectId", objectId, "sourceVideoId", source, "templateHash", hash, "keyframes", values);
    }
    private static JsonObject pair(Key left, Key right) {
        JsonObject result = Json.obj("leftKeyframeId", left.id, "rightKeyframeId", right.id, "leftFrameId", left.frame.id, "rightFrameId", right.frame.id,
            "leftKeyframeHash", left.hash, "rightKeyframeHash", right.hash, "startTime", left.frame.time.json(), "endTime", right.frame.time.json());
        result.addProperty("intervalId", "track-interval-" + digest(result)); return result;
    }
    private static Map<String, JsonObject> pairs(Track track) {
        Map<String, JsonObject> values = new TreeMap<>(); for (int i = 1; i < track.keys.size(); i++) {
            JsonObject pair = pair(track.keys.get(i - 1), track.keys.get(i)); values.put(Json.required(pair, "intervalId"), pair);
        } return values;
    }
    private static Map<String, Key> keyMap(Track track) { Map<String, Key> result = new HashMap<>(); for (Key key : track.keys) result.put(key.id, key); return result; }
    private static void addChangedPairs(Map<String, JsonObject> from, Map<String, JsonObject> other, String phase, JsonArray output, SortedSet<Integer> indexes, Timeline timeline) {
        for (var entry : from.entrySet()) if (!other.containsKey(entry.getKey())) {
            JsonObject value = entry.getValue().deepCopy(); value.addProperty("phase", phase); output.add(value);
            int left = frame(timeline, Json.required(value, "leftFrameId")).index, right = frame(timeline, Json.required(value, "rightFrameId")).index;
            indexes.addAll(range(left, right));
        }
    }
    private static SortedSet<Integer> range(int left, int right) { SortedSet<Integer> result = new TreeSet<>(); for (int i = left; i <= right; i++) result.add(i); return result; }
    private static void addFrameScope(JsonObject output, SortedSet<Integer> indexes, Timeline timeline, Track remaining, boolean regenerate) {
        Set<String> keyframes = new HashSet<>(); remaining.keys.forEach(key -> keyframes.add(key.frame.id));
        JsonArray all = new JsonArray(), mutable = new JsonArray(), candidates = new JsonArray(), protectedFrames = new JsonArray(), preconditions = new JsonArray();
        for (int index : indexes) {
            Frame frame = timeline.frames.get(index); all.add(frame.id);
            if (frame.protectedByHuman()) protectedFrames.add(skipped(frame, "human_protected", "修改区间仍保留人工版本。"));
            else if (!keyframes.contains(frame.id)) {
                // 失效旧候选和生成新候选是两件事；删除端点后不把域外帧误列为可外推对象。
                mutable.add(frame.id); preconditions.add(precondition(frame));
                if (regenerate && remaining.keys.size() > 1 && frame.index > remaining.keys.get(0).frame.index && frame.index < remaining.keys.get(remaining.keys.size() - 1).frame.index) candidates.add(frame.id);
            }
        }
        output.add("affectedFrameIds", all); output.add("mutableCandidateFrameIds", mutable); output.add("eligibleCandidateFrameIds", candidates);
        output.add("protectedFrames", protectedFrames); output.add("applyPreconditions", preconditions);
    }
    private static JsonObject precondition(Frame frame) {
        return Json.obj("frameId", frame.id, "baselineAssetId", frame.baseline.get("id"), "baselineContentHash", frame.baseline.get("contentHash"),
            "baselineVersion", frame.baseline.get("version"), "expectedAnnotationVersion", frame.annotationVersion,
            "allowedAnnotationStates", Json.arr("empty", "candidate"), "candidateOnly", true);
    }
    private static void sameIdentity(Track a, Track b, boolean sameTrack) {
        if (!a.source.equals(b.source) || !a.templateHash.equals(b.templateHash) || !a.objectId.equals(b.objectId) || sameTrack && !a.id.equals(b.id)) throw conflict("轨迹来源、冻结模板或对象身份不一致。");
    }
    private static Frame frame(Timeline timeline, String frameId) { Frame result = timeline.byId.get(frameId); if (result == null) throw invalid("关键帧不在冻结时间轴中：" + frameId); return result; }
    private static JsonObject skipped(Frame frame, String reason, String message) { return Json.obj("frameId", frame.id, "reason", reason, "message", message, "annotationState", frame.state, "annotationVersion", frame.annotationVersion); }
    private static void sortByFrame(JsonArray values, Timeline timeline) {
        List<JsonElement> sorted = new ArrayList<>(values.asList()); sorted.sort(Comparator.comparingInt(value -> frame(timeline, Json.required(value.getAsJsonObject(), "frameId")).index));
        while (!values.isEmpty()) values.remove(values.size() - 1); sorted.forEach(values::add);
    }
    private static JsonObject issue(String code, String message, String severity) { return Json.obj("code", code, "message", message, "severity", severity); }
    private static String string(JsonObject object, String field) {
        JsonElement value = object.get(field); if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()) throw invalid("缺少字符串字段：" + field);
        return id(value.getAsString(), field);
    }
    private static String id(String value, String field) { if (value == null || value.isBlank() || value.length() > 512 || !value.equals(value.strip())) throw invalid(field + " 为空、过长或包含首尾空白。"); return value; }
    private static JsonObject object(JsonObject parent, String field) { return asObject(parent.get(field), field); }
    private static JsonObject asObject(JsonElement value, String field) { if (value == null || !value.isJsonObject()) throw invalid(field + " 必须是对象。"); return value.getAsJsonObject(); }
    private static JsonArray array(JsonObject parent, String field) { JsonElement value = parent.get(field); if (value == null || !value.isJsonArray()) throw invalid(field + " 必须是数组。"); return value.getAsJsonArray(); }
    private static int integer(JsonObject input, String field, int min, int max) { long value = longInteger(input, field); if (value < min || value > max) throw invalid(field + " 超出允许范围。"); return (int)value; }
    private static long longInteger(JsonObject input, String field) {
        BigInteger value = bigInteger(input.get(field), field, false); if (value.signum() < 0 || value.compareTo(BigInteger.valueOf(Long.MAX_VALUE)) > 0) throw invalid(field + " 必须是非负整数版本或尺寸。"); return value.longValue();
    }
    private static void bounded(JsonElement input) { long[] usage = {0, 0}; bounded(input, 0, usage); }
    private static void bounded(JsonElement value, int depth, long[] usage) {
        if (++usage[0] > 600_000 || depth > 32) throw limit("轨迹输入结构过大或过深。");
        if (value == null || value.isJsonNull()) return;
        if (value.isJsonObject()) for (var field : value.getAsJsonObject().entrySet()) { if (field.getKey().length() > 512) throw invalid("字段名过长。"); usage[1] += field.getKey().length(); bounded(field.getValue(), depth + 1, usage); }
        else if (value.isJsonArray()) for (JsonElement child : value.getAsJsonArray()) bounded(child, depth + 1, usage);
        else {
            String text = value.getAsString(); usage[1] += text.length();
            if (value.getAsJsonPrimitive().isNumber()) {
                if (text.length() > 128) throw invalid("数值文本过长。");
                try { BigDecimal number = new BigDecimal(text); if (Math.abs((long)number.scale()) > 400 || !Double.isFinite(number.doubleValue())) throw invalid("输入数值必须有限且精度范围合理。"); }
                catch (NumberFormatException error) { throw invalid("无效数值。"); }
            }
        }
        if (usage[1] > 16 * 1024 * 1024) throw limit("轨迹输入文本过大。");
    }
    private static String digest(JsonElement value) {
        try { MessageDigest hash = MessageDigest.getInstance("SHA-256"); canonical(value, hash); return HexFormat.of().formatHex(hash.digest()); }
        catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }
    private static void canonical(JsonElement value, MessageDigest hash) {
        if (value == null || value.isJsonNull()) { update(hash, "null"); return; }
        if (value.isJsonObject()) {
            update(hash, "{"); boolean comma = false; for (String key : new TreeSet<>(value.getAsJsonObject().keySet())) {
                if (comma) update(hash, ","); comma = true; update(hash, Json.GSON.toJson(key)); update(hash, ":"); canonical(value.getAsJsonObject().get(key), hash);
            } update(hash, "}");
        } else if (value.isJsonArray()) { update(hash, "["); boolean comma = false; for (JsonElement item : value.getAsJsonArray()) { if (comma) update(hash, ","); comma = true; canonical(item, hash); } update(hash, "]"); }
        else if (value.getAsJsonPrimitive().isNumber()) update(hash, value.getAsBigDecimal().stripTrailingZeros().toString());
        else update(hash, Json.GSON.toJson(value));
    }
    private static void update(MessageDigest hash, String value) { hash.update(value.getBytes(StandardCharsets.UTF_8)); }
    private static ApiError invalid(String message) { return new ApiError(400, "track_interpolation_invalid", message); }
    private static ApiError conflict(String message) { return new ApiError(409, "track_identity_conflict", message); }
    private static ApiError limit(String message) { return new ApiError(413, "track_interpolation_limit", message); }

    private record Project(JsonObject project, JsonObject semantic, String hash, String task) {}
    private record Timeline(String source, List<Frame> frames, Map<String, Frame> byId, JsonObject snapshot) {}
    private record Context(Project project, Timeline timeline) {}
    private record Frame(String id, Rational time, String scene, JsonObject baseline, long annotationVersion, String state, JsonObject snapshot, int index) {
        boolean protectedByHuman() { return state.equals("manual") || state.equals("confirmed"); }
    }
    private record Key(String id, Frame frame, String state, JsonObject annotation, JsonObject snapshot, String hash) {}
    private record Track(String id, String objectId, String source, String templateHash, List<Key> keys, JsonObject snapshot) {}
    private record Interval(boolean blocked, boolean requiresReview, JsonObject json) {}
    private record Rational(BigInteger numerator, BigInteger denominator) implements Comparable<Rational> {
        Rational {
            if (denominator.signum() <= 0) throw invalid("时间分母必须大于 0。");
            BigInteger divisor = numerator.gcd(denominator); numerator = numerator.divide(divisor); denominator = denominator.divide(divisor);
        }
        Rational subtract(Rational other) { return new Rational(numerator.multiply(other.denominator).subtract(other.numerator.multiply(denominator)), denominator.multiply(other.denominator)); }
        Rational divide(Rational other) { if (other.numerator.signum() <= 0) throw invalid("插值时间区间必须严格递增。"); return new Rational(numerator.multiply(other.denominator), denominator.multiply(other.numerator)); }
        BigDecimal decimal() { return new BigDecimal(numerator).divide(new BigDecimal(denominator), PRECISION); }
        JsonObject json() { return Json.obj("numerator", numerator.toString(), "denominator", denominator.toString()); }
        @Override public int compareTo(Rational other) { return numerator.multiply(other.denominator).compareTo(other.numerator.multiply(denominator)); }
    }
}
