package cn.autolabel.engine;

import com.google.gson.*;
import java.util.*;

final class TaskTemplates {
    static final String VALIDATOR_VERSION="annotations-v2";
    static final String REQUEST_CONTRACT_VERSION="annotation-template-v2";
    private TaskTemplates(){}
    static final List<String> SETTINGS=List.of("keypointNames","keypointConnections","attributes","rules","occlusionRules","blurRules");
    static JsonObject snapshot(JsonObject project){
        JsonObject settings=new JsonObject(),source=Json.object(project,"settings");for(String field:SETTINGS)if(source.has(field))settings.add(field,source.get(field).deepCopy());
        return Json.obj("snapshotVersion",2,"taskType",project.get("taskType"),"classes",Json.array(project,"classes").deepCopy(),"settings",settings);
    }
    static JsonElement field(JsonObject template,String key){return template.has(key)?template.get(key):Json.object(template,"settings").get(key);}
    static void validate(JsonObject template,String code){
        if(!Annotations.TYPES.contains(Json.required(template,"taskType")))throw new ApiError(422,code,"模板任务类型无效。");JsonElement classes=field(template,"classes");if(classes!=null){if(!classes.isJsonArray())throw new ApiError(422,code,"模板类别必须是数组。");Annotations.classes(classes.getAsJsonArray());}
        JsonElement names=field(template,"keypointNames");JsonArray points=new JsonArray();if(names!=null){if(!names.isJsonArray()||names.getAsJsonArray().size()>256)throw new ApiError(422,code,"点位名称必须为至多 256 项的有序数组。");Set<String> unique=new HashSet<>();for(JsonElement name:names.getAsJsonArray()){if(!name.isJsonPrimitive()||!name.getAsJsonPrimitive().isString()||name.getAsString().isBlank()||!unique.add(name.getAsString()))throw new ApiError(422,code,"点位名称必须非空且不能重复。");points.add(Json.obj("name",name));}}
        JsonElement connections=field(template,"keypointConnections");if(connections!=null){if(!connections.isJsonArray())throw new ApiError(422,code,"点位连接关系必须是数组。");for(JsonElement element:connections.getAsJsonArray()){if(!element.isJsonArray()||element.getAsJsonArray().size()!=2)throw new ApiError(422,code,"连接关系必须由两个点位组成。");for(JsonElement point:element.getAsJsonArray()){boolean valid=false;try{if(point.isJsonPrimitive()){if(point.getAsJsonPrimitive().isNumber())point.getAsBigDecimal().intValueExact();valid=OverlayRenderer.pointIndex(points,point)>=0;}}catch(Exception ignored){/* 分数索引及无效类型不能被截断为合法点位。 */}if(!valid)throw new ApiError(422,code,"连接关系引用了不存在的点位。");}}}
        JsonElement prompt=field(template,"prompt");if(prompt!=null&&(!prompt.isJsonPrimitive()||!prompt.getAsJsonPrimitive().isString()))throw new ApiError(422,code,"模板提示词必须为文本。");JsonArray issues=TemplateAttributes.validateDefinition(field(template,"attributes"));if(!issues.isEmpty())throw new ApiError(422,code,"属性定义无效，请按具体字段修正。",Json.obj("issues",issues));
    }
    static JsonObject semantic(JsonObject project){
        JsonArray classes=new JsonArray();for(JsonElement entry:Json.array(project,"classes")){JsonObject value=entry.getAsJsonObject();classes.add(Json.obj("id",value.get("id"),"name",value.get("name")));}
        JsonObject result=Json.obj("taskType",project.get("taskType"),"classes",classes),settings=Json.object(project,"settings");
        // 请求和后续复用指纹共用语义字段，界面样式、绝对路径和项目其他数据不进入模型上下文。
        for(String field:SETTINGS)if(settings.has(field))result.add(field,settings.get(field).deepCopy());
        return result;
    }
}
