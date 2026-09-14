package cn.autolabel.engine;

import com.google.gson.*;
import java.sql.Connection;
import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 导出格式规范：标签序列化方式 + 目录与命名模板。
 *
 * 设计原因：标签写法与目录布局原先硬编码在 Exporter 内，新增格式只能改导出器本体，用户常用布局也无法保存复用。
 * 这里把「导出格式」抽成一份可校验、可版本化的规范：导出器只按规范渲染路径与标签，导出清单记录本次实际生效的规范快照，
 * 因此历史副本的复现与比对不依赖格式模板是否仍存在、是否被改过。
 *
 * 内置预设与用户保存的模板使用同一份扁平结构（元数据字段与格式字段同层），避免出现两套形状。
 */
final class ExportFormats {
    static final String HEAD_KIND = "export_format";
    static final String REVISION_KIND = "export_format_version";
    static final String BUILTIN_PREFIX = "builtin:";
    static final List<String> LABEL_FORMAT_ORDER = List.of("yolo", "coco", "voc", "csv");
    static final Set<String> LABEL_FORMATS = Set.copyOf(LABEL_FORMAT_ORDER);
    static final Set<String> NAMING = Set.of("assetId", "original");
    static final Set<String> PLACEHOLDERS = Set.of("split", "name", "assetId", "index", "classId", "classId4", "className");
    static final Set<String> CLASS_PLACEHOLDERS = Set.of("classId", "classId4", "className");
    static final List<String> CSV_COLUMNS = List.of("split", "assetId", "name", "image", "width", "height", "classId", "className",
        "cx", "cy", "w", "h", "xmin", "ymin", "xmax", "ymax", "rotation", "points", "keypoints", "visibility", "attributes", "status", "source", "group");
    static final List<String> CLASSIFY_CSV_COLUMNS = List.of("split", "assetId", "name", "image", "width", "height", "classId", "className", "status", "source", "group");
    static final Map<String, String> LABEL_FORMAT_NAMES = Map.of(
        "yolo", "YOLO 文本标签", "coco", "COCO JSON", "voc", "Pascal VOC XML", "csv", "平铺 CSV 索引");
    private static final Map<String, Set<String>> SUPPORTED = new LinkedHashMap<>();
    private static final int MAX_TEMPLATE = 400;
    private static final Pattern PLACEHOLDER = Pattern.compile("\\{([^{}]*)}");
    private final Store store;

    static {
        SUPPORTED.put("yolo", Set.of("detect", "obb", "segment", "pose", "classify"));
        SUPPORTED.put("coco", Set.of("detect", "segment", "pose"));
        SUPPORTED.put("voc", Set.of("detect"));
        SUPPORTED.put("csv", Set.of("detect", "obb", "segment", "pose", "classify"));
    }

    ExportFormats(Store store) { this.store = store; }

    /** 内置预设与已保存模板一起返回，界面一次读取即可列出全部可选格式。 */
    JsonArray list(JsonObject p) {
        String taskType = Json.str(p, "taskType", null);
        if (taskType != null && !Annotations.TYPES.contains(taskType)) throw invalid("未知标注任务类型：" + taskType);
        JsonArray result = presets(taskType);
        for (JsonElement element : store.read(c -> Store.docs(c, "SELECT data FROM export_formats WHERE kind=? ORDER BY rowid DESC", HEAD_KIND))) {
            JsonObject saved = element.getAsJsonObject();
            if (taskType == null || taskType.equals(Json.str(saved, "taskType", ""))) result.add(saved);
        }
        return result;
    }

    /** 只返回与目标任务兼容的内置预设，避免界面列出必然失败的组合。 */
    static JsonArray presets(String taskType) {
        JsonArray result = new JsonArray();
        for (String format : LABEL_FORMAT_ORDER)
            if (taskType == null || SUPPORTED.get(format).contains(taskType)) result.add(preset(format, taskType));
        return result;
    }

    JsonObject get(JsonObject p) {
        String id = Json.required(p, "formatId");
        if (id.startsWith(BUILTIN_PREFIX)) return builtin(id);
        return store.read(c -> revision(c, id, p));
    }

    JsonObject save(JsonObject p) {
        Providers.rejectSecrets(p);
        String taskType = requireTask(Json.required(p, "taskType"));
        String name = Json.required(p, "name");
        if (name.length() > 100) throw invalid("导出格式名称最多 100 个字符。");
        JsonObject fields = normalize(p, taskType);
        fields.addProperty("name", name);
        fields.addProperty("category", Json.str(p, "category", "").strip());
        fields.addProperty("note", Json.str(p, "note", "").strip());
        return store.tx(c -> commit(c, p, fields));
    }

    JsonObject delete(JsonObject p) {
        String id = Json.required(p, "formatId");
        if (id.startsWith(BUILTIN_PREFIX)) throw new ApiError(403, "export_format_builtin", "内置预设不能删除，请另存为自定义格式。");
        return store.tx(c -> {
            JsonObject row = Store.one(c, "SELECT data FROM export_formats WHERE id=?", id);
            if (row == null) throw notFound();
            JsonObject item = Json.parse(Json.required(row, "data"));
            if (p.has("baseVersion") && Json.number(p, "baseVersion", -1) != Json.number(item, "version", 0)) throw conflict();
            Store.update(c, "DELETE FROM export_formats WHERE id=? OR id LIKE ?", id, "export-format-version:" + id + ":%");
            Store.event(c, "export.format.deleted", null, null, null, Json.obj("formatId", id, "version", item.get("version")));
            return Json.obj("formatId", id, "version", item.get("version"), "deleted", true);
        });
    }

    /**
     * 解析本次导出实际生效的格式：优先内联规范，其次按标识读取内置预设或保存模板，都未提供时沿用内置 YOLO 默认布局。
     * 返回扁平规范 + 来源标识，导出器与清单只读这一份结果，保证落盘与记录使用同一份定义。
     */
    JsonObject resolve(JsonObject p, String taskType) {
        requireTask(taskType);
        JsonElement inline = p.get("format");
        if (inline != null && !inline.isJsonNull() && inline.isJsonObject())
            return resolved("自定义导出格式", "inline", 1, "inline", normalize(inline.getAsJsonObject(), taskType));
        JsonObject definition = p.has("formatId") ? get(revisionRequest(p)) : preset("yolo", taskType);
        String declared = Json.str(definition, "taskType", null);
        // 预设不绑定任务类型，兼容性交由 normalize 判定；用户模板绑定任务，避免跨任务误用布局。
        if (declared != null && !declared.equals(taskType))
            throw new ApiError(422, "export_format_task_mismatch",
                "所选导出格式面向" + (Annotations.TYPES.contains(declared) ? declared : "未知") + "任务，与本项目的 " + taskType + " 任务不一致。");
        return resolved(Json.str(definition, "name", ""), Json.required(definition, "id"), Json.number(definition, "version", 1),
            Json.str(definition, "source", "saved"), normalize(definition, taskType));
    }

    /** 渲染模板；占位符缺失直接报错，不静默产出半截路径。 */
    static String render(String template, Map<String, String> variables) {
        if (template == null || template.isEmpty()) return "";
        Matcher matcher = PLACEHOLDER.matcher(template);
        StringBuilder out = new StringBuilder();
        int last = 0;
        while (matcher.find()) {
            String value = variables.get(matcher.group(1));
            if (value == null) throw pathError("模板占位符不受支持：{" + matcher.group(1) + "}");
            out.append(template, last, matcher.start()).append(value);
            last = matcher.end();
        }
        out.append(template, last, template.length());
        return out.toString();
    }

    /** 渲染结果必须是数据集内相对路径，阻断绝对路径、盘符与上跳片段。 */
    static String validatePath(String rendered, String field) {
        if (rendered == null || rendered.isEmpty()) throw pathError(field + "没有生成有效路径。");
        if (rendered.indexOf('{') >= 0 || rendered.indexOf('}') >= 0) throw pathError(field + "存在未闭合的占位符。");
        if (rendered.indexOf('\\') >= 0) throw pathError(field + "只能使用正斜杠分隔目录。");
        if (rendered.startsWith("/") || rendered.matches("^[A-Za-z]:.*")) throw pathError(field + "必须是数据集内的相对路径。");
        for (String segment : rendered.split("/", -1)) {
            if (segment.isEmpty()) throw pathError(field + "包含空目录名。");
            if (segment.equals(".") || segment.equals("..")) throw pathError(field + "不能包含相对路径片段。");
        }
        return rendered;
    }

    /** 未显式指定命名方式时使用素材 ID；选择原始文件名时去掉扩展名并过滤非法字符，重名由导出器确定性消歧。 */
    static String assetFileName(JsonObject asset, String naming, String assetId) {
        if (!"original".equals(naming)) return assetId;
        String raw = Json.str(asset, "name", "");
        int dot = raw.lastIndexOf('.');
        if (dot > 0) raw = raw.substring(0, dot);
        String cleaned = raw.replaceAll("[\\\\/:*?\"<>|\\u0000-\\u001f]", "_").replaceAll("^[.\\s]+", "").replaceAll("[.\\s]+$", "").strip();
        if (cleaned.isEmpty()) return assetId;
        return cleaned.length() > 120 ? cleaned.substring(0, 120) : cleaned;
    }

    /** 模板变量；分类任务下类别相关占位符才有取值，其它任务在校验阶段已拒绝这些占位符。 */
    static Map<String, String> variables(String split, String assetId, String name, int index, int classId, String className, boolean classify) {
        Map<String, String> variables = new LinkedHashMap<>();
        variables.put("split", split);
        variables.put("name", name);
        variables.put("assetId", assetId);
        variables.put("index", String.format(Locale.ROOT, "%06d", index));
        variables.put("classId", classify ? Integer.toString(classId) : "");
        variables.put("classId4", classify ? String.format(Locale.ROOT, "%04d", classId) : "");
        variables.put("className", classify ? className : "");
        return variables;
    }

    /** 把任意来源的格式输入规整成一份完整规范，缺失字段取默认值，非法组合直接拒绝。 */
    static JsonObject normalize(JsonObject raw, String taskType) {
        requireTask(taskType);
        boolean classify = taskType.equals("classify");
        String labelFormat = Json.str(raw, "labelFormat", "yolo");
        if (!LABEL_FORMATS.contains(labelFormat)) throw invalid("不支持的标签格式：" + labelFormat);
        if (!SUPPORTED.get(labelFormat).contains(taskType))
            throw new ApiError(422, "export_format_task_unsupported",
                LABEL_FORMAT_NAMES.get(labelFormat) + "不支持 " + taskType + " 任务，请改用其它导出格式。");
        JsonObject layout = Json.object(raw, "layout");
        // 只保留该任务类型实际会用到的那一类图片模板：分类按类别目录组织，其它任务按划分目录组织。
        // 未使用的一侧留空，避免内置预设在两类模板并存时被无关的占位符规则拒绝。
        JsonObject normalized = Json.obj(
            "image", classify ? "" : template(layout, "image", taskType, true),
            "classifyImage", classify ? template(layout, "classifyImage", taskType, true) : "",
            "label", classify ? "" : template(layout, "label", taskType, labelFormat.equals("yolo") || labelFormat.equals("voc")),
            "index", template(layout, "index", taskType, labelFormat.equals("coco") || labelFormat.equals("csv")));
        JsonObject result = Json.obj("taskType", taskType, "labelFormat", labelFormat, "layout", normalized,
            "precision", Json.bounded(raw, "precision", 8, 1, 8),
            "naming", naming(Json.str(raw, "naming", "assetId")),
            "includeDataYaml", false, "cocoFileName", "", "csvBom", Json.bool(raw, "csvBom", true), "csvColumns", new JsonArray());
        switch (labelFormat) {
            case "yolo" -> {
                // 分类任务按类别目录组织图片，不写逐图标签也不生成 data.yaml，与历史导出行为保持一致。
                image(normalized, classify ? "classifyImage" : "image");
                if (!classify) extension(normalized, "label", ".txt");
                requireEmpty(normalized, "index", "YOLO 布局不生成索引文件，data.yaml 已记录划分。");
                result.addProperty("includeDataYaml", !classify && Json.bool(raw, "includeDataYaml", true));
            }
            case "voc" -> {
                image(normalized, "image");
                extension(normalized, "label", ".xml");
                optionalExtension(normalized, "index", ".txt");
            }
            case "coco" -> {
                image(normalized, "image");
                requireEmpty(normalized, "label", "COCO JSON 不生成逐图标签文件，请清空标签路径。");
                extension(normalized, "index", ".json");
                String fileName = template(raw, "cocoFileName", taskType, false);
                if (fileName.isEmpty()) fileName = "{name}.png";
                if (!fileName.toLowerCase(Locale.ROOT).endsWith(".png"))
                    throw pathError("COCO 文件名必须以 .png 结尾（清单中的 file_name 指向数据集内的图片）。");
                result.addProperty("cocoFileName", fileName);
            }
            case "csv" -> {
                image(normalized, classify ? "classifyImage" : "image");
                requireEmpty(normalized, "label", "CSV 索引不生成逐图标签文件，请清空标签路径。");
                extension(normalized, "index", ".csv");
                result.add("csvColumns", columns(raw, classify));
            }
            default -> throw invalid("不支持的标签格式：" + labelFormat);
        }
        return result;
    }

    /** 内置预设：定义与规范同为扁平结构，已知任务类型时按该任务规整，未知任务保留完整模板交由 resolve 规整。 */
    private static JsonObject preset(String format, String taskType) {
        JsonObject raw = defaults(taskType);
        raw.addProperty("labelFormat", format);
        JsonObject layout = Json.object(raw, "layout");
        layout.addProperty("image", "images/{split}/{name}.png");
        layout.addProperty("classifyImage", "{split}/{classId4}/{name}.png");
        switch (format) {
            case "yolo" -> layout.addProperty("label", "labels/{split}/{name}.txt");
            case "coco" -> layout.addProperty("index", "annotations/instances_{split}.json");
            case "voc" -> {
                layout.addProperty("label", "annotations/{name}.xml");
                layout.addProperty("index", "ImageSets/{split}.txt");
            }
            case "csv" -> layout.addProperty("index", "annotations.csv");
            default -> throw invalid("不支持的导出格式：" + format);
        }
        JsonObject spec = taskType == null ? raw : normalize(raw, taskType);
        spec.addProperty("id", BUILTIN_PREFIX + format);
        spec.addProperty("kind", "builtin");
        spec.addProperty("builtin", true);
        spec.addProperty("source", "builtin");
        spec.addProperty("version", 1);
        spec.addProperty("name", LABEL_FORMAT_NAMES.get(format));
        spec.addProperty("category", "内置预设");
        spec.addProperty("note", description(format));
        return spec;
    }

    private static JsonObject defaults(String taskType) {
        boolean classify = "classify".equals(taskType);
        return Json.obj("labelFormat", "yolo", "precision", 8, "naming", "assetId", "includeDataYaml", !classify, "csvBom", true,
            "cocoFileName", "{name}.png", "csvColumns", defaultColumns(classify),
            "layout", Json.obj("image", "", "classifyImage", "", "label", "", "index", ""));
    }

    private static String description(String format) {
        return switch (format) {
            case "yolo" -> "images/labels 目录与 data.yaml，与历史版本默认布局一致。";
            case "coco" -> "COCO 实例标注 JSON，支持 Detect、Segment、Pose。";
            case "voc" -> "逐图 Pascal VOC XML，仅支持 Detect，可选生成 ImageSets 划分清单。";
            case "csv" -> "把每张图的目标展开为 CSV 行，便于表格核对或对接自有训练脚本。";
            default -> "";
        };
    }

    private static JsonObject builtin(String id) {
        String format = id.substring(BUILTIN_PREFIX.length());
        if (!LABEL_FORMATS.contains(format)) throw notFound();
        return preset(format, null);
    }

    private static String naming(String value) {
        if (!NAMING.contains(value)) throw invalid("文件命名方式应为 assetId 或 original。");
        return value;
    }

    /** 模板校验：占位符白名单、括号配对、相对路径与扩展名要求在这里一次判完，导出阶段不再猜测用户意图。 */
    private static String template(JsonObject parent, String field, String taskType, boolean required) {
        String value = Json.str(parent, field, "").strip();
        if (value.isEmpty()) {
            if (required) throw pathError("请填写" + fieldName(field) + "路径模板。");
            return "";
        }
        if (value.length() > MAX_TEMPLATE) throw pathError(fieldName(field) + "模板过长。");
        int depth = 0;
        for (char ch : value.toCharArray()) {
            if (ch == '{') depth++;
            else if (ch == '}' && --depth < 0) throw pathError(fieldName(field) + "模板括号不匹配。");
        }
        if (depth != 0) throw pathError(fieldName(field) + "模板括号不匹配。");
        Matcher matcher = PLACEHOLDER.matcher(value);
        while (matcher.find()) {
            String name = matcher.group(1);
            if (!PLACEHOLDERS.contains(name)) throw pathError(fieldName(field) + "包含不支持的占位符：{" + name + "}");
            if (CLASS_PLACEHOLDERS.contains(name) && !taskType.equals("classify"))
                throw pathError("{" + name + "} 只在分类导出中可用。");
        }
        validatePath(value.replaceAll("\\{[^{}]*}", "x"), fieldName(field));
        return value;
    }

    private static String fieldName(String field) {
        return switch (field) {
            case "image" -> "图片";
            case "classifyImage" -> "分类图片";
            case "label" -> "标签";
            case "index" -> "索引";
            case "cocoFileName" -> "COCO 文件名";
            default -> field;
        };
    }

    /** 导出不做图片转码，因此图片路径必须落在 .png 上，避免写出扩展名与内容不符的文件。 */
    private static void image(JsonObject layout, String field) {
        if (Json.str(layout, field, "").isEmpty()) throw pathError("请填写" + fieldName(field) + "路径模板。");
        extension(layout, field, ".png");
    }

    private static void extension(JsonObject layout, String field, String suffix) {
        String value = Json.str(layout, field, "");
        if (value.isEmpty()) throw pathError("请填写" + fieldName(field) + "路径模板。");
        if (!value.toLowerCase(Locale.ROOT).endsWith(suffix))
            throw pathError(fieldName(field) + "路径必须以 " + suffix + " 结尾。");
    }

    private static void optionalExtension(JsonObject layout, String field, String suffix) {
        String value = Json.str(layout, field, "");
        if (!value.isEmpty() && !value.toLowerCase(Locale.ROOT).endsWith(suffix))
            throw pathError(fieldName(field) + "路径必须以 " + suffix + " 结尾。");
    }

    private static void requireEmpty(JsonObject layout, String field, String message) {
        if (!Json.str(layout, field, "").isEmpty()) throw pathError(message);
    }

    private static JsonArray columns(JsonObject raw, boolean classify) {
        JsonArray source = Json.array(raw, "csvColumns");
        return source.isEmpty() ? defaultColumns(classify) : validateColumns(source);
    }

    private static JsonArray defaultColumns(boolean classify) {
        JsonArray result = new JsonArray();
        for (String column : classify ? CLASSIFY_CSV_COLUMNS : CSV_COLUMNS) result.add(column);
        return result;
    }

    private static JsonArray validateColumns(JsonArray source) {
        Set<String> seen = new HashSet<>();
        JsonArray result = new JsonArray();
        for (JsonElement element : source) {
            if (!element.isJsonPrimitive() || !element.getAsJsonPrimitive().isString()) throw invalid("CSV 列名必须是字符串。");
            String column = element.getAsString();
            if (!CSV_COLUMNS.contains(column)) throw invalid("不支持的 CSV 列：" + column);
            if (!seen.add(column)) throw invalid("CSV 列不能重复：" + column);
            result.add(column);
        }
        if (result.isEmpty()) throw invalid("CSV 列至少保留一列。");
        return result;
    }

    private static JsonObject revisionRequest(JsonObject p) {
        JsonObject request = Json.obj("formatId", Json.required(p, "formatId"));
        if (p.has("formatVersion")) request.add("version", p.get("formatVersion"));
        return request;
    }

    private static JsonObject revision(Connection c, String id, JsonObject p) throws Exception {
        JsonObject head = Store.one(c, "SELECT kind,data FROM export_formats WHERE id=?", id);
        if (head == null) throw notFound();
        if (REVISION_KIND.equals(Json.required(head, "kind"))) throw invalid("请通过导出格式标识读取指定版本。");
        JsonObject current = Json.parse(Json.required(head, "data"));
        if (!p.has("version") || Json.number(p, "version", 0) == Json.number(current, "version", 0)) return current;
        int requested = (int) Json.number(p, "version", 0);
        JsonObject row = Store.one(c, "SELECT data FROM export_formats WHERE id=?", "export-format-version:" + id + ":" + requested);
        if (row == null) throw new ApiError(404, "export_format_not_found", "指定的导出格式版本不存在。");
        JsonObject stored = Json.parse(Json.required(row, "data"));
        if (!id.equals(Json.str(stored, "formatId", ""))) throw new ApiError(409, "export_format_version_invalid", "导出格式版本关联不一致。");
        return Json.object(stored, "format").deepCopy();
    }

    private JsonObject commit(Connection c, JsonObject p, JsonObject fields) throws Exception {
        String id = Json.str(p, "id", null);
        JsonObject old = null;
        if (id != null) {
            if (id.startsWith(BUILTIN_PREFIX)) throw new ApiError(403, "export_format_builtin", "内置预设不能直接修改，请另存为自定义格式。");
            JsonObject row = Store.one(c, "SELECT data FROM export_formats WHERE id=?", id);
            if (row == null) throw notFound();
            old = Json.parse(Json.required(row, "data"));
        }
        int current = old == null ? 0 : Json.integer(old, "version", 1);
        if (old != null && (!p.has("baseVersion") || Json.number(p, "baseVersion", -1) != current)) throw conflict();
        if (old == null && p.has("baseVersion") && Json.number(p, "baseVersion", -1) != 0) throw conflict();
        if (id == null) id = Json.id();
        String now = Json.now();
        JsonObject result = fields.deepCopy();
        result.addProperty("id", id);
        result.addProperty("kind", "saved");
        result.addProperty("builtin", false);
        result.addProperty("source", "saved");
        result.addProperty("version", current + 1);
        result.addProperty("createdAt", old == null ? now : Json.str(old, "createdAt", now));
        result.addProperty("updatedAt", now);
        saveRevision(c, id, current + 1, result);
        Store.update(c, "INSERT INTO export_formats(id,kind,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data", id, HEAD_KIND, result);
        Store.event(c, "export.format.saved", null, null, null, Json.obj("formatId", id, "version", result.get("version"), "labelFormat", result.get("labelFormat")));
        return result;
    }

    private static void saveRevision(Connection c, String id, int version, JsonObject format) throws Exception {
        Store.update(c, "INSERT INTO export_formats(id,kind,data) VALUES(?,?,?)",
            "export-format-version:" + id + ":" + version, REVISION_KIND, Json.obj("formatId", id, "version", version, "format", format));
    }

    private static JsonObject resolved(String name, String id, long version, String source, JsonObject spec) {
        JsonObject result = spec.deepCopy();
        result.addProperty("id", id);
        result.addProperty("name", name);
        result.addProperty("version", version);
        result.addProperty("source", source);
        return result;
    }

    private static String requireTask(String taskType) {
        if (taskType == null || !Annotations.TYPES.contains(taskType)) throw invalid("未知标注任务类型：" + taskType);
        return taskType;
    }

    private static ApiError invalid(String message) { return new ApiError(400, "export_format_invalid", message); }
    private static ApiError pathError(String message) { return new ApiError(400, "export_format_path_invalid", message); }
    private static ApiError notFound() { return new ApiError(404, "export_format_not_found", "导出格式不存在或已被删除。"); }
    private static ApiError conflict() { return new ApiError(409, "export_format_version_conflict", "导出格式已被更新，请重新载入后保存。"); }
}
