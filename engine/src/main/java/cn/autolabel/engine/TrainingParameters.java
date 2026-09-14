package cn.autolabel.engine;

import com.google.gson.*;
import java.util.*;

/**
 * 训练参数模型。
 *
 * 边界只在这里定义一次：界面（shared/training.ts）、预检与建任务共用同一组取值，
 * 避免出现界面可提交而引擎拒绝、或引擎放宽而界面不提示的两套口径。
 */
final class TrainingParameters {
    static final Set<String> OPTIMIZERS=Set.of("auto","SGD","Adam","AdamW");
    private static final Set<String> KEYS=Set.of("epochs","learningRate","batch","imgsz","device","baseModel","optimizer","momentum",
        "weightDecay","warmupEpochs","patience","workers","seed","cosLr","closeMosaic","augment","valPeriod","resume");

    /** 校验并归一化：所有字段都会补齐默认值，调用方无需再判空。 */
    static JsonObject parse(JsonObject value){
        if(value==null)throw error("parameters","训练参数必须为对象。");
        for(String key:value.keySet())if(!KEYS.contains(key))throw new ApiError(400,"training_parameter_unknown","不支持的训练参数："+key,Json.obj("field",key));
        JsonObject result=Json.obj("epochs",integer(value,"epochs",1,10000,100),
            "learningRate",decimal(value,"learningRate",1e-6,1,0.01),
            "imgsz",imageSize(value),"device",device(value),
            "optimizer",optimizer(value),"momentum",decimal(value,"momentum",0,1,0.937),
            "weightDecay",decimal(value,"weightDecay",0,1,0.0005),"warmupEpochs",integer(value,"warmupEpochs",0,100,3),
            "patience",integer(value,"patience",1,10000,100),"workers",integer(value,"workers",0,32,8),
            "seed",integer(value,"seed",0,2147483647,0),"closeMosaic",integer(value,"closeMosaic",0,10000,10),
            "valPeriod",integer(value,"valPeriod",1,1000,1),"cosLr",bool(value,"cosLr",false),
            "augment",bool(value,"augment",true),"resume",bool(value,"resume",false));
        if(value.has("batch")){
            JsonElement raw=value.get("batch");
            if(raw.isJsonPrimitive()&&raw.getAsJsonPrimitive().isString()){
                if(!raw.getAsString().equals("auto"))throw error("batch","批次大小只接受 1～1024 的整数或 auto。");
                result.addProperty("batch","auto");
            }else result.addProperty("batch",integer(value,"batch",1,1024,16));
        }else result.addProperty("batch",16);
        JsonObject base=baseModel(value);
        result.add("baseModel",base==null?JsonNull.INSTANCE:base);
        // 续训必须从已有权重出发；从零训练没有可恢复的检查点。
        if(Json.bool(result,"resume",false)&&base==null)throw error("resume","续训需要指定基础权重（last.pt 对应的本地模型版本）。");
        return result;
    }

    static String device(JsonObject value){
        String device=Json.str(value,"device","gpu-auto");
        if(!device.matches("gpu-auto|cpu|0|[1-9][0-9]{0,2}"))throw error("device","执行设备应为 cpu、gpu-auto 或 0 至 999 的 GPU 编号。");
        return device;
    }

    private static String optimizer(JsonObject value){
        String optimizer=Json.str(value,"optimizer","auto");
        if(!OPTIMIZERS.contains(optimizer))throw error("optimizer","优化器只支持 auto、SGD、Adam 或 AdamW。");
        return optimizer;
    }

    private static int imageSize(JsonObject value){
        int imgsz=integer(value,"imgsz",32,4096,640);
        // ultralytics 只接受 32 的倍数，非倍数会在训练中途才失败。
        if(imgsz%32!=0)throw error("imgsz","输入尺寸必须是 32 的倍数。");
        return imgsz;
    }

    private static JsonObject baseModel(JsonObject value){
        JsonElement raw=value.get("baseModel");
        if(raw==null||raw.isJsonNull())return null;
        if(!raw.isJsonObject())throw error("baseModel","基础权重应为本地模型标识对象或 null。");
        JsonObject base=raw.getAsJsonObject();
        for(String key:base.keySet())if(!Set.of("modelId","modelVersion").contains(key))throw error("baseModel","基础权重包含未支持的字段："+key);
        String modelId=Json.required(base,"modelId");
        if(modelId.isBlank()||modelId.length()>128)throw error("baseModel","基础权重标识无效。");
        JsonObject result=Json.obj("modelId",modelId);
        if(base.has("modelVersion"))result.addProperty("modelVersion",integer(base,"modelVersion",1,Integer.MAX_VALUE,1));
        return result;
    }

    private static int integer(JsonObject value,String field,int min,int max,int fallback){
        double number=decimal(value,field,min,max,fallback);
        if(number!=Math.rint(number))throw error(field,field+" 必须为整数。");
        return (int)number;
    }

    private static double decimal(JsonObject value,String field,double min,double max,double fallback){
        if(!value.has(field))return fallback;
        JsonElement raw=value.get(field);
        if(raw==null||!raw.isJsonPrimitive()||!raw.getAsJsonPrimitive().isNumber())throw error(field,field+" 必须为数值。");
        double number;
        try{number=raw.getAsDouble();}catch(RuntimeException invalid){throw error(field,field+" 必须为数值。");}
        // NaN 与无穷必须显式拒绝：它们会绕过区间比较并污染训练配置。
        if(!Double.isFinite(number))throw error(field,field+" 必须是有限数值。");
        if(number<min||number>max)throw error(field,field+" 应在 "+min+"～"+max+" 之间。");
        return number;
    }

    private static boolean bool(JsonObject value,String field,boolean fallback){
        if(!value.has(field))return fallback;
        JsonElement raw=value.get(field);
        if(raw==null||!raw.isJsonPrimitive()||!raw.getAsJsonPrimitive().isBoolean())throw error(field,field+" 必须为布尔值。");
        return raw.getAsBoolean();
    }

    /** 面向前端与任务记录的摘要：不含任何本地路径。 */
    static JsonObject summary(JsonObject parameters,JsonObject resolved){
        JsonObject result=parameters.deepCopy();
        result.addProperty("requestedDevice",device(parameters));
        result.addProperty("actualDevice",Json.str(resolved,"device",""));
        JsonElement fallback=resolved.get("fallback");
        result.add("fallback",fallback==null?JsonNull.INSTANCE:fallback.deepCopy());
        return result;
    }

    private static ApiError error(String field,String message){return new ApiError(400,"training_parameter_invalid",message,Json.obj("field",field));}
}
