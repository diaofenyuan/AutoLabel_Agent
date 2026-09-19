package cn.autolabel.engine;

import com.google.gson.*;
import java.nio.file.*;
import java.util.*;

final class LocalModels {
    final Store store;final ResourceLibrary library;
    LocalModels(Store store,Projects projects){this.store=store;library=new ResourceLibrary(store,projects);}
    JsonObject register(JsonObject p)throws Exception{
        FlowPlans.keys(p,"id","baseVersion","name","taskType","modelPath","classNames","origin","catalogId");String name=FlowPlans.string(p,"name",100),task=FlowPlans.string(p,"taskType",32);if(!Annotations.TYPES.contains(task))throw new ApiError(400,"task_invalid","本地模型任务类型无效。");Path path=file(FlowPlans.string(p,"modelPath",32767));long bytes=Files.size(path);if(bytes<1||bytes>16L*1024*1024*1024)throw new ApiError(413,"local_model_size_invalid","模型大小须为 1 字节至 16 GiB。");String hash=Media.hash(path),fileName=path.getFileName().toString(),format=fileName.toLowerCase(Locale.ROOT).endsWith(".pt")?"pt":"onnx";
        // 类别表可选：登记后训练预检可离线核对类别一致性，缺省时由训练启动阶段向 worker 核对。
        JsonObject content=Json.obj("taskType",task,"format",format,"fileName",fileName,"modelHash",hash,"sizeBytes",bytes,"modelPath",path.toString());
        JsonArray classNames=classNames(p);if(classNames!=null)content.add("classNames",classNames);
        // 来源与模型库标识只作记录：执行授权仍按文件路径与哈希核对，不因来源放行任何执行。
        String origin=origin(p),catalogId=catalogId(p);if(origin!=null)content.addProperty("origin",origin);if(catalogId!=null)content.addProperty("catalogId",catalogId);
        JsonObject fields=Json.obj("kind","local_model","name",name,"category","","note","","content",content);return publicModel(store.tx(c->library.commit(c,p,fields)));
    }
    /** 类别表只接受非空且不重复的字符串，顺序即模型输出的类别序号。 */
    private static JsonArray classNames(JsonObject p){
        if(!p.has("classNames"))return null;
        JsonElement value=p.get("classNames");
        if(!value.isJsonArray())throw new ApiError(400,"local_model_classes_invalid","模型类别表必须为字符串数组。");
        JsonArray result=new JsonArray();Set<String> seen=new HashSet<>();
        for(JsonElement element:value.getAsJsonArray()){
            if(!element.isJsonPrimitive()||!element.getAsJsonPrimitive().isString())throw new ApiError(400,"local_model_classes_invalid","模型类别表只能包含字符串。");
            String item=element.getAsString().strip();
            if(item.isEmpty()||item.length()>200||!seen.add(item))throw new ApiError(400,"local_model_classes_invalid","模型类别不能为空、重复或超过 200 字符。");
            result.add(item);
        }
        if(result.isEmpty())throw new ApiError(400,"local_model_classes_invalid","模型类别表不能为空数组。");
        return result;
    }
    /** 模型来源只接受固定三种；缺省视为用户自己找的文件，因此旧记录不需要迁移。 */
    private static String origin(JsonObject p){
        if(!p.has("origin"))return null;
        String value=FlowPlans.string(p,"origin",16);
        if(!List.of("user","builtin","downloaded").contains(value))throw new ApiError(400,"local_model_origin_invalid","本地模型来源只能是 user、builtin 或 downloaded。");
        return value;
    }
    /** 模型库标识与 shared/model-library.ts 的 id 同形，界面据此把「已启用」标回目录里的那一条。 */
    private static String catalogId(JsonObject p){
        if(!p.has("catalogId"))return null;
        String value=FlowPlans.string(p,"catalogId",64);
        if(!value.matches("[A-Za-z0-9_-]{1,64}"))throw new ApiError(400,"local_model_catalog_invalid","模型库标识无效。");
        return value;
    }
    static Path file(String value)throws Exception{Path path=Path.of(value);String name=path.getFileName()==null?"":path.getFileName().toString().toLowerCase(Locale.ROOT);if(!path.isAbsolute()||!Files.isRegularFile(path)||!(name.endsWith(".pt")||name.endsWith(".onnx")))throw new ApiError(400,"local_model_path_invalid","请选择存在的 PT 或 ONNX 模型文件。");return path.toRealPath();}
    JsonObject resource(String id,Integer version){JsonObject p=Json.obj("resourceId",id);if(version!=null)p.addProperty("version",version);JsonObject resource=library.raw(p);if(!Json.required(resource,"kind").equals("local_model"))throw new ApiError(422,"local_model_invalid","所选资源不是通过专用入口登记的本地模型。");return resource;}
    JsonObject get(JsonObject p){FlowPlans.keys(p,"modelId","modelVersion");return publicModel(resource(FlowPlans.string(p,"modelId",128),p.has("modelVersion")?(int)Costs.integer(p,"modelVersion",1,Integer.MAX_VALUE):null));}
    JsonObject snapshot(String id,Integer version)throws Exception{JsonObject resource=resource(id,version),content=Json.object(resource,"content");Path path=file(Json.required(content,"modelPath"));if(!Media.hash(path).equals(Json.required(content,"modelHash")))throw new ApiError(409,"local_model_changed","模型文件已变化，请登记新版本后运行。");JsonObject result=publicModel(resource);result.addProperty("modelPath",path.toString());return result;}
    JsonObject resolve(JsonObject p)throws Exception{FlowPlans.keys(p,"modelId","version");JsonObject model=snapshot(FlowPlans.string(p,"modelId",128),p.has("version")?(int)Costs.integer(p,"version",1,Integer.MAX_VALUE):null);return Json.obj("modelId",model.get("id"),"version",model.get("version"),"path",model.get("modelPath"),"modelHash",model.get("modelHash"),"taskType",model.get("taskType"),"format",model.get("format"));}
    JsonObject list(JsonObject p){FlowPlans.keys(p,"taskType","limit","offset");if(p.has("taskType")&&!Annotations.TYPES.contains(FlowPlans.string(p,"taskType",32)))throw new ApiError(400,"task_invalid","模型任务类型无效。");int limit=Json.bounded(p,"limit",100,1,500),offset=Json.bounded(p,"offset",0,0,Integer.MAX_VALUE);return store.read(c->{String condition="kind='local_model'";List<Object> args=new ArrayList<>();if(p.has("taskType")){condition+=" AND json_extract(data,'$.content.taskType')=?";args.add(Json.required(p,"taskType"));}long total=Json.number(Store.one(c,"SELECT COUNT(*) AS n FROM resources WHERE "+condition,args.toArray()),"n",0);args.add(limit);args.add(offset);JsonArray items=new JsonArray();for(JsonObject row:Store.rows(c,"SELECT data FROM resources WHERE "+condition+" ORDER BY rowid DESC LIMIT ? OFFSET ?",args.toArray()))items.add(publicModel(Json.parse(row.get("data").getAsString())));return Json.obj("items",items,"total",total);});}
    static JsonObject publicModel(JsonObject resource){JsonObject result=new JsonObject();for(String field:List.of("id","version","kind","name","createdAt","updatedAt"))result.add(field,resource.get(field));JsonObject content=Json.object(resource,"content");for(String field:List.of("taskType","format","fileName","modelHash","sizeBytes"))result.add(field,content.get(field));if(content.has("classNames"))result.add("classNames",Json.array(content,"classNames").deepCopy());if(content.has("origin"))result.add("origin",content.get("origin"));if(content.has("catalogId"))result.add("catalogId",content.get("catalogId"));return result;}
}
