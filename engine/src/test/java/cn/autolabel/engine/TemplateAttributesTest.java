package cn.autolabel.engine;

import com.google.gson.*;
import java.math.BigDecimal;

final class TemplateAttributesTest {
    private static int assertions;

    public static void main(String[] args) {
        legacyRemainsUntouched(); validDefinitionsAndValues(); invalidDefinitions(); invalidValues();
        System.out.println("TemplateAttributesTest passed: " + assertions + " assertions across 4 groups");
    }

    private static void check(boolean value, String message) {
        assertions++;
        if (!value) throw new AssertionError(message);
    }

    private static JsonObject attribute(String id, String type, boolean required) {
        return Json.obj("id", id, "name", "属性 " + id, "type", type, "required", required);
    }

    private static JsonObject definitions(JsonElement... definitions) {
        JsonArray items = new JsonArray();
        for (JsonElement definition : definitions) items.add(definition);
        return Json.obj("kind", "attribute_definitions", "version", 1, "definitions", items);
    }

    private static void issue(JsonArray issues, String path, String code) {
        check(issues.asList().stream().anyMatch(value -> {
            JsonObject issue = value.getAsJsonObject();
            return path.equals(Json.str(issue, "path", "")) && code.equals(Json.str(issue, "code", ""))
                && !Json.str(issue, "message", "").isBlank();
        }), "应返回可定位的中文问题 " + path + "：" + issues);
    }

    private static void definitionIssue(JsonObject value, String path, String code) {
        JsonObject before = value.deepCopy();
        JsonArray issues = TemplateAttributes.validateDefinition(value);
        issue(issues, path, code);
        check(TemplateAttributes.validateValues(value, null).equals(issues), "定义无效时先返回定义问题");
        check(value.equals(before), "无效定义也不能被改写");
    }

    private static void legacyRemainsUntouched() {
        JsonElement[] legacy = {
            null, JsonNull.INSTANCE, new JsonPrimitive("遮挡由人工判断"), new JsonPrimitive(false), new JsonPrimitive(42),
            Json.arr(Json.obj("name", "材质")), Json.obj("kind", Json.arr("normal")),
            Json.obj("occlusion", "说明"), Json.obj("kind", "other", "version", 999),
            Json.obj("kind", true), Json.obj("kind", "attribute_definitions ", "definitions", false),
            Json.obj("definitions", Json.arr(attribute("id", "number", true)))
        };
        JsonObject values = Json.obj("note", "原始备注", "legacy", Json.obj("自由", Json.arr(1, 2)), "unknown", false);
        JsonObject valuesBefore = values.deepCopy();
        for (JsonElement value : legacy) {
            JsonElement before = value == null ? null : value.deepCopy();
            check(TemplateAttributes.validateDefinition(value).isEmpty(), "未明确启用的新结构不能约束旧语义");
            check(TemplateAttributes.validateValues(value, values).isEmpty(), "旧格式不校验或删除属性值");
            check(value == null || value.equals(before), "旧定义不补默认、不转写");
        }
        check(values.equals(valuesBefore), "旧属性说明和自由值完整保留");
    }

    private static void validDefinitionsAndValues() {
        JsonObject text = attribute("material_1", "text", true); text.addProperty("maxLength", 2);
        JsonObject number = attribute("height-2", "number", true); number.addProperty("min", 0); number.addProperty("max", 3.5);
        JsonObject bool = attribute("visible", "boolean", true);
        JsonObject select = attribute("occlusion", "select", true); select.add("options", Json.arr("无", "部分", "完全"));
        JsonObject schema = definitions(text, number, bool, select, attribute("optional", "text", false));
        JsonObject values = Json.obj("material_1", "金属", "height-2", 0, "visible", false, "occlusion", "无",
            "note", "保留旧备注", "extra", Json.obj("历史附加值", true));
        JsonObject schemaBefore = schema.deepCopy(), valuesBefore = values.deepCopy();
        check(TemplateAttributes.validateDefinition(schema).isEmpty(), "四种类型的有效定义");
        check(TemplateAttributes.validateValues(schema, values).isEmpty(), "0 和 false 满足必填，缺失的可选字段不补默认");
        values.addProperty("height-2", 3.5);
        check(TemplateAttributes.validateValues(schema, values).isEmpty(), "数字上界包含在范围内");
        values.addProperty("height-2", 0);
        check(schema.equals(schemaBefore) && values.equals(valuesBefore), "校验不改变定义或自由附加字段");
        check(TemplateAttributes.validateValues(definitions(), null).isEmpty(), "允许空定义且没有隐式必填项");
        JsonObject limits = attribute("a".repeat(128), "text", false);
        limits.addProperty("name", "名".repeat(100)); limits.addProperty("maxLength", 100_000);
        JsonObject largeValues = new JsonObject(); largeValues.addProperty("a".repeat(128), "文".repeat(100_000));
        check(TemplateAttributes.validateValues(definitions(limits), largeValues).isEmpty(), "允许明确上限的有效文本与稳定 ID");
    }

    private static void invalidDefinitions() {
        String base = "settings.attributes.definitions[0]";
        JsonObject schema = definitions(); schema.addProperty("version", 2);
        definitionIssue(schema, "settings.attributes.version", "attribute_definition_unsupported_version");
        schema.addProperty("version", "1");
        definitionIssue(schema, "settings.attributes.version", "attribute_definition_unsupported_version");
        schema.add("version", new JsonPrimitive(new BigDecimal("1.0000000000000000000000001")));
        definitionIssue(schema, "settings.attributes.version", "attribute_definition_unsupported_version");
        schema = definitions(); schema.addProperty("other", true);
        definitionIssue(schema, "settings.attributes.other", "attribute_definition_unknown_field");
        schema = definitions(); schema.addProperty("definitions", "错误");
        definitionIssue(schema, "settings.attributes.definitions", "attribute_definition_invalid_type");
        definitionIssue(definitions(JsonNull.INSTANCE), base, "attribute_definition_invalid_type");
        schema = definitions();
        for (int index = 0; index < 257; index++) schema.getAsJsonArray("definitions").add(attribute("id" + index, "boolean", false));
        definitionIssue(schema, "settings.attributes.definitions", "attribute_definition_limit");

        JsonObject value = attribute("duplicate", "text", false);
        definitionIssue(definitions(value, value.deepCopy()), "settings.attributes.definitions[1].id", "attribute_definition_duplicate_id");
        for (String id : new String[] { "", "中文", "has.dot", "a".repeat(129) }) {
            definitionIssue(definitions(attribute(id, "text", false)), base + ".id", "attribute_definition_invalid_id");
        }
        value = attribute("id", "text", false); value.addProperty("name", " ");
        definitionIssue(definitions(value), base + ".name", "attribute_definition_invalid_name");
        value = attribute("id", "string", false);
        definitionIssue(definitions(value), base + ".type", "attribute_definition_invalid_type");
        value = attribute("id", "boolean", false); value.remove("required");
        definitionIssue(definitions(value), base + ".required", "attribute_definition_invalid_type");
        value.addProperty("required", "false");
        definitionIssue(definitions(value), base + ".required", "attribute_definition_invalid_type");
        value = attribute("id", "boolean", false); value.addProperty("min", 0);
        definitionIssue(definitions(value), base + ".min", "attribute_definition_unknown_field");
        for (JsonElement limit : new JsonElement[] { JsonNull.INSTANCE, new JsonPrimitive(0), new JsonPrimitive(1.5), new JsonPrimitive(100001), new JsonPrimitive("2") }) {
            value = attribute("id", "text", false); value.add("maxLength", limit);
            definitionIssue(definitions(value), base + ".maxLength", "attribute_definition_invalid_constraint");
        }
        value = attribute("id", "number", false); value.addProperty("min", 2); value.addProperty("max", 1);
        definitionIssue(definitions(value), base + ".max", "attribute_definition_invalid_constraint");
        for (JsonElement limit : new JsonElement[] { new JsonPrimitive(Double.NaN), new JsonPrimitive(Double.POSITIVE_INFINITY), new JsonPrimitive("0"), JsonNull.INSTANCE }) {
            value = attribute("id", "number", false); value.add("min", limit);
            definitionIssue(definitions(value), base + ".min", "attribute_definition_invalid_constraint");
        }
        value = attribute("id", "select", false);
        definitionIssue(definitions(value), base + ".options", "attribute_definition_invalid_options");
        value.add("options", new JsonArray());
        definitionIssue(definitions(value), base + ".options", "attribute_definition_invalid_options");
        value.add("options", Json.arr("正常", "正常"));
        definitionIssue(definitions(value), base + ".options[1]", "attribute_definition_invalid_options");
        value.add("options", Json.arr(" ", 1));
        definitionIssue(definitions(value), base + ".options[0]", "attribute_definition_invalid_options");
        issue(TemplateAttributes.validateDefinition(definitions(value)), base + ".options[1]", "attribute_definition_invalid_options");
    }

    private static void invalidValues() {
        JsonObject text = attribute("label", "text", true); text.addProperty("maxLength", 2);
        JsonObject number = attribute("score", "number", true); number.addProperty("min", 0); number.addProperty("max", 1);
        JsonObject select = attribute("state", "select", true); select.add("options", Json.arr("好", "坏"));
        JsonObject schema = definitions(text, number, attribute("flag", "boolean", true), select);
        JsonArray missing = TemplateAttributes.validateValues(schema, null);
        check(missing.size() == 4, "每个必填缺失项独立定位");
        issue(missing, "annotations.attributes.score", "attribute_value_required");
        JsonObject values = Json.obj("label", " ", "score", JsonNull.INSTANCE, "flag", false, "state", "");
        JsonArray issues = TemplateAttributes.validateValues(schema, values);
        check(issues.size() == 3, "空白必填文本、null 和空枚举值缺失，false 有效");
        issue(issues, "annotations.attributes.state", "attribute_value_required");
        check("state".equals(issues.get(2).getAsJsonObject().get("attributeId").getAsString()), "问题保留稳定属性 ID");
        values = Json.obj("label", "太长了", "score", 1.1, "flag", "false", "state", "一般");
        issues = TemplateAttributes.validateValues(schema, values);
        issue(issues, "annotations.attributes.label", "attribute_value_out_of_range");
        issue(issues, "annotations.attributes.score", "attribute_value_out_of_range");
        issue(issues, "annotations.attributes.flag", "attribute_value_invalid_type");
        issue(issues, "annotations.attributes.state", "attribute_value_not_in_options");
        JsonObject numberSchema = definitions(number);
        for (JsonElement value : new JsonElement[] { new JsonPrimitive(Double.NaN), new JsonPrimitive(Double.NEGATIVE_INFINITY), new JsonPrimitive(new BigDecimal("1e999")), new JsonPrimitive("0"), new JsonPrimitive(false), new JsonArray() }) {
            issue(TemplateAttributes.validateValues(numberSchema, Json.obj("score", value)), "annotations.attributes.score", "attribute_value_invalid_type");
        }
        select.addProperty("required", false);
        check(TemplateAttributes.validateValues(definitions(select), new JsonObject()).isEmpty(), "可选枚举允许缺失");
        for (String invalid : new String[] { "", "好 ", "未知" })
            issue(TemplateAttributes.validateValues(definitions(select), Json.obj("state", invalid)), "annotations.attributes.state", "attribute_value_not_in_options");
        issue(TemplateAttributes.validateValues(definitions(select), Json.obj("state", JsonNull.INSTANCE)), "annotations.attributes.state", "attribute_value_invalid_type");
        JsonObject before = values.deepCopy();
        TemplateAttributes.validateValues(schema, values);
        check(values.equals(before), "错误值原样保留，调用方可展示并修改");
    }
}
