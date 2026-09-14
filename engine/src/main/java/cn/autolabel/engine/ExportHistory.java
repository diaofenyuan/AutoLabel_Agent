package cn.autolabel.engine;

import com.google.gson.*;
import java.nio.file.*;
import java.util.*;

final class ExportHistory {
    private final Store store;
    ExportHistory(Store store){this.store=store;}
    record Fixed(JsonObject record,JsonObject manifest,Path directory){}
    Fixed fixed(String id)throws Exception{
        JsonObject record=store.read(c->Store.document(c,"exports",id));if(!Json.str(record,"status","").equals("completed"))throw new ApiError(409,"export_not_completed","只能使用已完成的历史导出。");
        Path directory=Path.of(Json.required(record,"path")).toAbsolutePath().normalize(),manifestFile=directory.resolve("manifest.json");if(!Files.isRegularFile(manifestFile))throw new ApiError(404,"export_manifest_missing","历史导出清单缺失。");
        if(!record.has("manifestHash"))throw new ApiError(409,"legacy_export_unverified","此早期导出没有保存清单校验值，无法证明未被外部改动；请保留原副本并新建导出。");
        if(!Media.hash(manifestFile).equals(Json.required(record,"manifestHash")))throw new ApiError(409,"export_manifest_changed","历史清单已被修改，不能作为固定版本重导出。");JsonObject manifest=Json.parse(Files.readString(manifestFile));
        if(!Json.required(manifest,"id").equals(id))throw new ApiError(409,"export_manifest_mismatch","历史导出标识与清单不一致。");return new Fixed(record,manifest,directory);
    }
    void protectDestination(Path path){if(path.startsWith(store.root.resolve("media"))||path.startsWith(store.materialsRoot))throw new ApiError(409,"export_target_protected","不能向受管原图目录导出数据集。");store.read(c->{for(JsonElement e:Store.docs(c,"SELECT data FROM exports")){String existing=Json.str(e.getAsJsonObject(),"path","");if(!existing.isEmpty()&&path.startsWith(Path.of(existing).toAbsolutePath().normalize()))throw new ApiError(409,"export_target_protected","新导出不能嵌套在历史训练数据集内。");}return null;});}
    JsonObject reproduce(JsonObject p)throws Exception{
        Fixed source=fixed(Json.required(p,"exportId"));Path parent=Path.of(Json.required(p,"outputDir")).toAbsolutePath().normalize();protectDestination(parent);Files.createDirectories(parent);store.requireSpace(0);
        String id=Json.id(),pid=Json.required(source.record,"projectId"),type=Json.required(source.manifest,"taskType");Path temporary=parent.resolve(".autolabel-partial-"+id),destination=parent.resolve("autolabel-"+type+"-"+id.substring(0,8));Files.createDirectory(temporary);
        JsonObject record=Json.obj("id",id,"projectId",pid,"path",destination.toString(),"status","writing","createdAt",Json.now(),"taskType",type,"assetCount",Json.array(source.manifest,"assets").size(),"sourceExportId",Json.required(source.record,"id"));
        store.tx(c->{Store.update(c,"INSERT INTO exports(id,project_id,data) VALUES(?,?,?)",id,pid,record);Store.event(c,"export.started",null,null,null,Json.obj("exportId",id,"sourceExportId",source.record.get("id")));return null;});
        try{
            long bytes=0;for(JsonElement e:Json.array(source.manifest,"assets"))bytes+=Files.size(inside(source.directory,Json.required(e.getAsJsonObject(),"image")));if(Files.getFileStore(parent).getUsableSpace()<bytes+128L*1024*1024)throw new ApiError(507,"disk_space_low","目标磁盘空间不足。");
            // 按清单记录的实际相对路径逐项复制：历史 YOLO 布局与自定义格式共用同一条路径，不再硬编码目录结构；
            // 旧清单缺少 label / auxiliaryFiles 时回退到 YOLO 约定，保证既有历史副本仍可校验复现。
            List<String[]> members=new ArrayList<>();
            for(JsonElement e:Json.array(source.manifest,"assets")){JsonObject a=e.getAsJsonObject();
                members.add(new String[]{Json.required(a,"image"),Json.required(a,"contentHash")});
                String label=labelReference(type,a);if(label!=null)members.add(new String[]{label,Json.required(a,"labelHash")});
            }
            if(source.manifest.has("auxiliaryFiles")&&!source.manifest.get("auxiliaryFiles").isJsonNull())
                for(JsonElement e:Json.array(source.manifest,"auxiliaryFiles")){JsonObject a=e.getAsJsonObject();members.add(new String[]{Json.required(a,"path"),Json.required(a,"hash")});}
            else if(!type.equals("classify"))members.add(new String[]{"data.yaml",Json.required(source.record,"yamlHash")});
            for(String[] member:members)copyVerified(source.directory,temporary,member[0],member[1]);
            JsonObject manifest=source.manifest.deepCopy();manifest.addProperty("id",id);manifest.add("createdAt",record.get("createdAt"));manifest.addProperty("sourceExportId",Json.required(source.record,"id"));Files.writeString(temporary.resolve("manifest.json"),manifest.toString());record.addProperty("manifestHash",Media.hash(temporary.resolve("manifest.json")));if(!type.equals("classify"))record.add("yamlHash",source.record.get("yamlHash"));
            Files.move(temporary,destination,StandardCopyOption.ATOMIC_MOVE);record.addProperty("status","completed");record.addProperty("completedAt",Json.now());record.addProperty("manifestPath",destination.resolve("manifest.json").toString());for(String key:List.of("trainCount","valCount"))if(source.record.has(key))record.add(key,source.record.get(key));
            store.tx(c->{Store.update(c,"UPDATE exports SET data=? WHERE id=?",record,id);Store.event(c,"export.completed",null,null,null,Json.obj("exportId",id,"sourceExportId",source.record.get("id")));return null;});return record;
        }catch(Exception e){record.addProperty("status","failed");record.addProperty("errorCode",e instanceof ApiError a?a.code:"export_copy_failed");store.tx(c->{Store.update(c,"UPDATE exports SET data=? WHERE id=?",record,id);Store.event(c,"export.failed",null,null,null,Json.obj("exportId",id,"code",record.get("errorCode")));return null;});throw e;}
    }
    /** 优先使用清单记录的标签路径；旧清单缺少该字段时按 YOLO 约定推导，分类导出没有逐图标签。 */
    private static String labelReference(String type,JsonObject asset){
        if(asset.has("label")&&!asset.get("label").isJsonNull())return Json.required(asset,"label");
        if(type.equals("classify")||!asset.has("labelHash"))return null;
        return "labels/"+Json.required(asset,"split")+"/"+Json.required(asset,"assetId")+".txt";
    }
    static Path inside(Path root,String relative)throws Exception{Path child=root.resolve(relative).normalize();if(Path.of(relative).isAbsolute()||!child.startsWith(root)||!Files.isRegularFile(child)||!child.toRealPath().startsWith(root.toRealPath()))throw new ApiError(409,"export_dependency_missing","清单引用的历史副本缺失或路径越界。");return child;}
    static void copyVerified(Path source,Path destination,String relative,String expected)throws Exception{Path input=inside(source,relative);if(!Media.hash(input).equals(expected))throw new ApiError(409,"export_dependency_changed","历史图片、标签或配置副本已被外部修改。");Path output=destination.resolve(relative).normalize();if(!output.startsWith(destination))throw new ApiError(409,"export_dependency_invalid","历史副本路径无效。");Path parent=output.getParent();if(parent!=null)Files.createDirectories(parent);Files.copy(input,output);if(!Media.hash(output).equals(expected))throw new ApiError(500,"export_copy_failed","历史副本复制校验失败。");}
    JsonObject compare(JsonObject p)throws Exception{
        Fixed left=fixed(Json.required(p,"exportId")),right=fixed(Json.required(p,"otherExportId"));Map<String,JsonObject> a=byId(left.manifest),b=byId(right.manifest);JsonArray added=new JsonArray(),removed=new JsonArray(),changed=new JsonArray();int unchanged=0;
        boolean classesChanged=!Json.array(left.manifest,"classes").equals(Json.array(right.manifest,"classes"))||!Json.array(left.manifest,"keypointNames").equals(Json.array(right.manifest,"keypointNames"));
        for(var entry:a.entrySet()){JsonObject other=b.get(entry.getKey());if(other==null){removed.add(entry.getKey());continue;}JsonArray fields=new JsonArray();for(String field:List.of("contentHash","version","status","source","annotations","split","normalization"))if(!Objects.equals(entry.getValue().get(field),other.get(field)))fields.add(field);if(classesChanged)fields.add("classesOrTemplate");if(fields.isEmpty())unchanged++;else changed.add(Json.obj("assetId",entry.getKey(),"fields",fields));}
        for(String id:b.keySet())if(!a.containsKey(id))added.add(id);
        // 输出布局或标签格式变化单独标记：素材逐项相同但目录结构不同时，不能给出「完全一致」的错觉。
        return Json.obj("exportId",left.record.get("id"),"otherExportId",right.record.get("id"),"added",added,"removed",removed,"changed",changed,"unchanged",unchanged,"classesChanged",classesChanged,"formatChanged",!Objects.equals(left.manifest.get("format"),right.manifest.get("format")));
    }
    static Map<String,JsonObject> byId(JsonObject manifest){Map<String,JsonObject> result=new LinkedHashMap<>();for(JsonElement e:Json.array(manifest,"assets")){JsonObject a=e.getAsJsonObject();result.put(Json.required(a,"assetId"),a);}return result;}
}
