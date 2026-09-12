package cn.autolabel.engine;

import com.google.gson.*;
import java.math.BigDecimal;
import java.util.*;

/** 纯校验只识别显式包装，避免把历史自由属性说明升级成新的约束。 */
final class TemplateAttributes {
    private static final String ROOT = "settings.attributes";
    private static final Set<String> WRAPPER_FIELDS = Set.of("kind", "version", "definitions");
    private static final Set<String> TYPES = Set.of("text", "number", "boolean", "select");
    private static final Set<String> BASE_FIELDS = Set.of("id", "name", "type", "required");
    private static final int MAX_DEFINITIONS = 256;

    private TemplateAttributes() {}

    static JsonArray validateDefinition(JsonElement attributes) {
        JsonArray issues = new JsonArray();
        if (!structured(attributes)) return issues;
        JsonObject wrapper = attributes.getAsJsonObject();
        unknownFields(wrapper, WRAPPER_FIELDS, ROOT, null, issues);
        if (!integerInRange(wrapper.get("version"), 1, 1))
            issue(issues, ROOT + ".version", "attribute_definition_unsupported_version", "属性定义版本必须为 1", null);
        JsonElement definitions = wrapper.get("definitions");
        if (definitions == null || !definitions.isJsonArray()) {
            issue(issues, ROOT + ".definitions", "attribute_definition_invalid_type", "属性定义必须为数组", null);
            return issues;
        }
        if (definitions.getAsJsonArray().size() > MAX_DEFINITIONS) {
            issue(issues, ROOT + ".definitions", "attribute_definition_limit", "属性定义最多 256 项", null);
            return issues;
        }
        Set<String> ids = new HashSet<>();
        for (int index = 0; index < definitions.getAsJsonArray().size(); index++) {
            JsonElement value = definitions.getAsJsonArray().get(index);
            String path = ROOT + ".definitions[" + index + "]";
            if (!value.isJsonObject()) {
                issue(issues, path, "attribute_definition_invalid_type", "每项属性定义必须为对象", null);
                continue;
            }
            JsonObject definition = value.getAsJsonObject();
            String id = string(definition.get("id"));
            if (id == null || !id.matches("[A-Za-z0-9_-]{1,128}")) {
                issue(issues, path + ".id", "attribute_definition_invalid_id", "属性 ID 必须为 1～128 位英文字母、数字、下划线或短横线", null);
                id = null;
            } else if (!ids.add(id)) {
                issue(issues, path + ".id", "attribute_definition_duplicate_id", "属性 ID 重复：" + id, id);
            }
            if (!nonblankString(definition.get("name"), 100))
                issue(issues, path + ".name", "attribute_definition_invalid_name", "属性名称必须为非空文本，且不超过 100 个字符", id);
            String type = string(definition.get("type"));
            if (type == null || !TYPES.contains(type))
                issue(issues, path + ".type", "attribute_definition_invalid_type", "属性类型必须为 text、number、boolean 或 select", id);
            if (!booleanValue(definition.get("required")))
                issue(issues, path + ".required", "attribute_definition_invalid_type", "required 必须为布尔值", id);

            Set<String> allowed = new HashSet<>(BASE_FIELDS);
            if ("text".equals(type)) allowed.add("maxLength");
            if ("number".equals(type)) allowed.addAll(Set.of("min", "max"));
            if ("select".equals(type)) allowed.add("options");
            unknownFields(definition, allowed, path, id, issues);
            if ("text".equals(type) && definition.has("maxLength") && !integerInRange(definition.get("maxLength"), 1, 100_000))
                issue(issues, path + ".maxLength", "attribute_definition_invalid_constraint", "文本长度上限必须为 1～100000 的整数", id);
            if ("number".equals(type)) validateNumberDefinition(definition, path, id, issues);
            if ("select".equals(type)) validateOptions(definition.get("options"), path + ".options", id, issues);
        }
        return issues;
    }

    static JsonArray validateValues(JsonElement definition, JsonObject values) {
        JsonArray issues = validateDefinition(definition);
        // 定义本身有误时，不继续解释值，也不为历史未定义键补默认或生成删除操作。
        if (!issues.isEmpty() || !structured(definition)) return issues;
        for (JsonElement element : definition.getAsJsonObject().getAsJsonArray("definitions")) {
            JsonObject attribute = element.getAsJsonObject();
            String id = attribute.get("id").getAsString(), type = attribute.get("type").getAsString();
            String path = "annotations.attributes." + id;
            JsonElement value = values == null ? null : values.get(id);
            boolean required = attribute.get("required").getAsBoolean();
            String text = string(value);
            boolean emptyText = text != null && (("text".equals(type) && text.isBlank()) || ("select".equals(type) && text.isEmpty()));
            if (required && (value == null || value.isJsonNull() || emptyText)) {
                issue(issues, path, "attribute_value_required", "缺少必填属性：" + attribute.get("name").getAsString(), id);
                continue;
            }
            if (value == null) continue;
            switch (type) {
                case "text" -> {
                    if (text == null) invalidValueType(issues, path, id, "文本");
                    else if (attribute.has("maxLength") && text.length() > attribute.get("maxLength").getAsInt())
                        issue(issues, path, "attribute_value_out_of_range", "文本超出长度上限 " + attribute.get("maxLength").getAsInt(), id);
                }
                case "number" -> {
                    Double number = finiteNumber(value);
                    if (number == null) invalidValueType(issues, path, id, "有限数字");
                    else if ((attribute.has("min") && number < attribute.get("min").getAsDouble())
                            || (attribute.has("max") && number > attribute.get("max").getAsDouble()))
                        issue(issues, path, "attribute_value_out_of_range", "数字超出属性定义的取值范围", id);
                }
                case "boolean" -> {
                    if (!booleanValue(value)) invalidValueType(issues, path, id, "布尔值");
                }
                case "select" -> {
                    if (text == null) invalidValueType(issues, path, id, "枚举文本");
                    else if (!attribute.getAsJsonArray("options").contains(value))
                        issue(issues, path, "attribute_value_not_in_options", "属性值不在定义的选项中", id);
                }
                default -> throw new IllegalStateException("属性定义已校验但类型无法识别");
            }
        }
        return issues;
    }

    private static void validateNumberDefinition(JsonObject definition, String path, String id, JsonArray issues) {
        for (String key : List.of("min", "max")) {
            if (definition.has(key) && finiteNumber(definition.get(key)) == null)
                issue(issues, path + "." + key, "attribute_definition_invalid_constraint", "数字边界必须为有限数字", id);
        }
        Double min = finiteNumber(definition.get("min")), max = finiteNumber(definition.get("max"));
        if (min != null && max != null && min > max)
            issue(issues, path + ".max", "attribute_definition_invalid_constraint", "数字上限不能小于下限", id);
    }

    private static void validateOptions(JsonElement value, String path, String id, JsonArray issues) {
        if (value == null || !value.isJsonArray() || value.getAsJsonArray().isEmpty() || value.getAsJsonArray().size() > 256) {
            issue(issues, path, "attribute_definition_invalid_options", "枚举必须包含 1～256 个选项", id);
            return;
        }
        Set<String> options = new HashSet<>();
        for (int index = 0; index < value.getAsJsonArray().size(); index++) {
            JsonElement option = value.getAsJsonArray().get(index);
            if (!nonblankString(option, 1000))
                issue(issues, path + "[" + index + "]", "attribute_definition_invalid_options", "选项必须为非空文本，且不超过 1000 个字符", id);
            else if (!options.add(option.getAsString()))
                issue(issues, path + "[" + index + "]", "attribute_definition_invalid_options", "枚举选项重复", id);
        }
    }

    private static boolean structured(JsonElement value) {
        return value != null && value.isJsonObject() && "attribute_definitions".equals(string(value.getAsJsonObject().get("kind")));
    }

    private static String string(JsonElement value) {
        return value != null && value.isJsonPrimitive() && value.getAsJsonPrimitive().isString() ? value.getAsString() : null;
    }

    private static boolean nonblankString(JsonElement value, int maxLength) {
        String text = string(value);
        return text != null && !text.isBlank() && text.length() <= maxLength;
    }

    private static boolean booleanValue(JsonElement value) {
        return value != null && value.isJsonPrimitive() && value.getAsJsonPrimitive().isBoolean();
    }

    private static Double finiteNumber(JsonElement value) {
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isNumber()) return null;
        try {
            double number = value.getAsDouble();
            return Double.isFinite(number) ? number : null;
        } catch (NumberFormatException exception) { return null; }
    }

    private static boolean integerInRange(JsonElement value, int min, int max) {
        if (finiteNumber(value) == null) return false;
        try {
            BigDecimal number = value.getAsBigDecimal();
            int integer = number.intValueExact();
            return integer >= min && integer <= max;
        } catch (NumberFormatException | ArithmeticException exception) { return false; }
    }

    private static void unknownFields(JsonObject object, Set<String> allowed, String path, String id, JsonArray issues) {
        for (String key : object.keySet()) {
            if (!allowed.contains(key))
                issue(issues, path + "." + key, "attribute_definition_unknown_field", "属性定义包含未知字段：" + key, id);
        }
    }

    private static void invalidValueType(JsonArray issues, String path, String id, String type) {
        issue(issues, path, "attribute_value_invalid_type", "属性值必须为" + type, id);
    }

    private static void issue(JsonArray issues, String path, String code, String message, String id) {
        JsonObject issue = Json.obj("path", path, "code", code, "message", message);
        if (id != null) issue.addProperty("attributeId", id);
        issues.add(issue);
    }
}
