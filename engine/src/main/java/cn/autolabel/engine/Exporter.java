package cn.autolabel.engine;

import com.google.gson.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.function.BooleanSupplier;

final class Exporter {
    private final Store store;private final Projects projects;
    MediaJobs mediaJobs;
    Exporter(Store store,Projects projects){this.store=store;this.projects=projects;}
    record Snapshot(JsonObject project,List<JsonObject> assets,Map<String,Path> paths,String type){}
    Snapshot snapshot(JsonObject p){String id=Json.required(p,"projectId");return store.read(c->{JsonObject project=Store.document(c,"projects",id);String type=Json.str(p,"taskType",Json.required(project,"taskType"));
        if(!type.equals(Json.required(project,"taskType")))throw new ApiError(422,"export_task_mismatch","本轮导出任务必须与项目标注类型一致。");
        Set<String> wanted=new HashSet<>();for(JsonElement e:Json.array(p,"assetIds"))wanted.add(e.getAsString());
        if(p.has("assetIds")&&wanted.isEmpty())throw new ApiError(400,"asset_selection_empty","所选素材为空，请选择素材后导出。");
        List<JsonObject> assets=new ArrayList<>();Map<String,Path> paths=new HashMap<>();for(JsonObject row:Store.rows(c,"SELECT id,data,path FROM assets WHERE project_id=? ORDER BY id",id)){
            JsonObject a=Json.parse(row.get("data").getAsString());String aid=Json.required(a,"id");if(!wanted.isEmpty()&&!wanted.contains(aid))continue;
            if(Json.bool(p,"onlyConfirmed",false)&&!Json.str(a,"status","").equals("confirmed"))continue;assets.add(a);paths.put(aid,Path.of(row.get("path").getAsString()));}
        if(!wanted.isEmpty()){Set<String> known=new HashSet<>();for(JsonObject row:Store.rows(c,"SELECT id FROM assets WHERE project_id=?",id))known.add(row.get("id").getAsString());if(!known.containsAll(wanted))throw new ApiError(400,"asset_project_mismatch","所选素材不属于当前项目。");}
        return new Snapshot(project,assets,paths,type);});}
    JsonObject inspect(Snapshot s){JsonArray issues=new JsonArray();Map<String,Integer> counts=new LinkedHashMap<>();Set<String> hashes=new HashSet<>();int objects=0,empty=0;
        Set<String> dirtyTrackAssets=store.read(c->{Set<String> ids=new HashSet<>();for(JsonObject row:Store.rows(c,"SELECT DISTINCT f.asset_id FROM track_dirty_frames d JOIN tracks t ON t.id=d.track_id JOIN timeline_frames f ON f.timeline_id=t.timeline_id AND f.frame_id=d.frame_id JOIN track_timelines l ON l.id=f.timeline_id WHERE l.project_id=?",Json.required(s.project,"id")))ids.add(Json.required(row,"asset_id"));return ids;});
        for(JsonElement e:Json.array(s.project,"classes"))counts.put(Json.required(e.getAsJsonObject(),"id"),0);
        if(s.assets.isEmpty())issues.add(issue(null,"error","export_empty","没有可导出的素材。"));
        if(counts.isEmpty())issues.add(issue(null,"error","classes_empty","项目尚未定义类别。"));
        for(JsonObject a:s.assets){String id=Json.required(a,"id"),status=Json.str(a,"status","");
            if(!Set.of("modified","confirmed").contains(status)){if(dirtyTrackAssets.contains(id))issues.add(issue(id,"error","track_recompute_required","该帧相关轨迹有尚未完成的重算，请生成候选或保存人工修订后导出。"));if(Json.bool(Json.object(a,"metadata"),"requiresTrackReview",false))issues.add(issue(id,"error","track_review_required","该帧轨迹候选存在待复核项，请保存人工修订版本后导出。"));}
            if(Json.bool(Json.object(a,"metadata"),"requiresGeometryReview",false))issues.add(issue(id,"error","geometry_review_required","该候选包含未完成覆盖或几何问题，请保存人工修订版本后导出。"));
            if(!Set.of("candidate","modified","confirmed").contains(status))issues.add(issue(id,"error","asset_unlabeled","素材尚未生成正式标注，不能当作无目标图片导出。"));
            if(!Files.isRegularFile(s.paths.get(id)))issues.add(issue(id,"error","media_missing","基准图片丢失。"));
            try{Annotations.validateStored(Json.array(a,"annotations"),a,s.project);}catch(ApiError e){issues.add(issue(id,"error",e.code,e.getMessage()));}
            JsonArray labels=Json.array(a,"annotations");if(labels.isEmpty()){empty++;if(s.type.equals("classify"))issues.add(issue(id,"error","classification_missing","分类样本必须指定类别。"));else issues.add(issue(id,"info","empty_label","无目标样本，来源："+Json.str(a,"source","未知")));}
            for(JsonElement e:labels){String cls=Json.str(e.getAsJsonObject(),"classId","");counts.computeIfPresent(cls,(k,v)->v+1);objects++;}
            if(!hashes.add(Json.str(a,"contentHash","")))issues.add(issue(id,"warning","duplicate_content","存在相同图片，划分时将保持同组。"));
        }
        JsonObject screening=mediaJobs==null?Json.obj("status","not_run"):mediaJobs.exportInspection(Json.required(s.project,"id"),s.assets);if(!Json.str(screening,"status","").equals("complete"))issues.add(issue(null,"warning","screening_not_complete","该导出范围的近重复检查尚未完整覆盖；可先在素材筛选中检查未分析范围。"));
        for(JsonElement pair:Json.array(screening,"nearPairs")){JsonObject value=pair.getAsJsonObject();JsonObject warning=issue(Json.required(value,"leftAssetId"),"warning","near_duplicate_candidate","存在近重复候选，需要结合画面与来源复核，不会自动删除。");warning.add("relatedAssetId",value.get("rightAssetId"));warning.add("distance",value.get("distance"));warning.add("threshold",value.get("threshold"));issues.add(warning);}
        screening.remove("nearPairs");long blocking=0;for(JsonElement e:issues)if(Json.str(e.getAsJsonObject(),"severity","").equals("error"))blocking++;
        return Json.obj("issues",issues,"screening",screening,"summary",Json.obj("assets",s.assets.size(),"objects",objects,"empty",empty,"classCounts",counts,"blocking",blocking,"canExport",blocking==0,"sourceGroups",groups(s.assets).values().stream().distinct().count()));
    }
    JsonObject preflight(JsonObject p){return inspect(snapshot(p));}
    static JsonObject issue(String id,String severity,String code,String message){return Json.obj("assetId",id,"severity",severity,"code",code,"message",message);}
    JsonObject create(JsonObject p)throws Exception{
        return createFixed(p,snapshot(p),Json.id(),()->true,null,null);
    }
    JsonObject createFixed(JsonObject p,Snapshot s,String id,BooleanSupplier keepGoing,String flowId,String stepId)throws Exception{
        JsonObject inspection=inspect(s);if(Json.number(Json.object(inspection,"summary"),"blocking",1)>0)throw new ApiError(422,"export_blocked","导出检查发现阻断问题，请处理后重试。",inspection);
        double ratio=Json.decimal(p,"trainRatio",0.8);if(!Double.isFinite(ratio)||ratio<=0||ratio>=1)throw new ApiError(400,"split_ratio_invalid","训练集比例必须大于 0 且小于 1。");
        Path parent=Path.of(Json.required(p,"outputDir")).toAbsolutePath().normalize();new ExportHistory(store).protectDestination(parent);Files.createDirectories(parent);
        long size=0;for(Path path:s.paths.values())size+=Files.size(path);if(Files.getFileStore(parent).getUsableSpace()<size+128L*1024*1024)throw new ApiError(507,"disk_space_low","导出目标磁盘空间不足。");
        Path temp=parent.resolve(".autolabel-partial-"+id),target=parent.resolve("autolabel-"+s.type+"-"+id.substring(0,8));
        Files.createDirectory(temp);String projectId=Json.required(s.project,"id");JsonObject record=Json.obj("id",id,"projectId",projectId,"path",target.toString(),"status","writing","createdAt",Json.now(),"taskType",s.type,"assetCount",s.assets.size());
        store.tx(c->{Store.update(c,"INSERT INTO exports(id,project_id,data) VALUES(?,?,?)",id,projectId,record);Store.flowEvent(c,"export.started",flowId,stepId,null,null,null,Json.obj("exportId",id,"projectId",projectId));return null;});
        try{
            Map<String,String> memberships=groups(s.assets);List<String> groups=memberships.values().stream().distinct().sorted().toList();int trainCount=groups.size()==1?1:Math.max(1,Math.min(groups.size()-1,(int)Math.round(groups.size()*ratio)));
            Set<String> train=new HashSet<>(groups.subList(0,trainCount));Map<String,Integer> classes=new LinkedHashMap<>();JsonArray definition=Json.array(s.project,"classes");
            for(int i=0;i<definition.size();i++)classes.put(Json.required(definition.get(i).getAsJsonObject(),"id"),i);
            JsonArray manifestAssets=new JsonArray();
            for(String split:List.of("train","val")){if(!s.type.equals("classify")){Files.createDirectories(temp.resolve("images/"+split));Files.createDirectories(temp.resolve("labels/"+split));}
                else for(var entry:classes.entrySet())Files.createDirectories(temp.resolve(split).resolve(String.format(Locale.ROOT,"%04d",entry.getValue())));}
            for(JsonObject asset:s.assets){String aid=Json.required(asset,"id"),split=train.contains(memberships.get(aid))?"train":"val";Path source=s.paths.get(aid);
                if(!keepGoing.getAsBoolean())throw new ApiError(409,"flow_step_interrupted","导出已停止，尚未发布该数据集。");
                if(!Media.hash(source).equals(Json.required(asset,"contentHash")))throw new ApiError(409,"media_content_changed","基准图片内容已改变，导出已停止。");
                String imagePath;
                if(s.type.equals("classify")){int cls=classes.get(Json.required(Json.array(asset,"annotations").get(0).getAsJsonObject(),"classId"));imagePath=split+"/"+String.format(Locale.ROOT,"%04d",cls)+"/"+aid+".png";}
                else {imagePath="images/"+split+"/"+aid+".png";Files.writeString(temp.resolve("labels/"+split+"/"+aid+".txt"),labels(asset,s.type,classes),StandardCharsets.UTF_8);}
                Files.copy(source,temp.resolve(imagePath));if(!Media.hash(temp.resolve(imagePath)).equals(Json.required(asset,"contentHash")))throw new ApiError(500,"export_copy_failed","导出图片副本校验失败。");
                JsonObject m=Json.obj("assetId",aid,"name",asset.get("name"),"image",imagePath,"split",split,"group",memberships.get(aid),"width",asset.get("width"),"height",asset.get("height"),"contentHash",asset.get("contentHash"),"version",asset.get("version"),"status",asset.get("status"),"source",asset.get("source"),"annotations",asset.get("annotations"));
                if(!s.type.equals("classify"))m.addProperty("labelHash",Media.hash(temp.resolve("labels/"+split+"/"+aid+".txt")));
                JsonObject input=Json.object(asset,"metadata");m.add("normalization",Json.obj("version",input.get("normalizationVersion"),"sourceToBaseline",input.get("sourceToBaseline"),"colorSpace",input.get("colorSpace"),"alphaBackground",input.get("alphaBackground")));if(input.has("sourceVideoId")){JsonObject video=MediaJobs.publicMetadata(input);video.remove("sourceHash");m.add("videoFrame",video);}manifestAssets.add(m);
            }
            if(!s.type.equals("classify")){StringBuilder yaml=new StringBuilder("train: images/train\nval: images/val\nnames:\n");
                for(int i=0;i<definition.size();i++)yaml.append("  ").append(i).append(": ").append(Json.GSON.toJson(Json.required(definition.get(i).getAsJsonObject(),"name"))).append('\n');
                if(s.type.equals("pose"))yaml.append("kpt_shape: [").append(Json.array(Json.object(s.project,"settings"),"keypointNames").size()).append(", 3]\n");Files.writeString(temp.resolve("data.yaml"),yaml,StandardCharsets.UTF_8);}
            JsonObject manifest=Json.obj("schemaVersion",1,"exporterVersion","0.1.0","id",id,"createdAt",record.get("createdAt"),"taskType",s.type,"classes",definition,"keypointNames",Json.array(Json.object(s.project,"settings"),"keypointNames"),"trainRatio",ratio,"splitRule","content-source-components-v2","screening",inspection.get("screening"),"assets",manifestAssets);
            Files.writeString(temp.resolve("manifest.json"),Json.GSON.toJson(manifest),StandardCharsets.UTF_8);
            record.addProperty("manifestHash",Media.hash(temp.resolve("manifest.json")));if(!s.type.equals("classify"))record.addProperty("yamlHash",Media.hash(temp.resolve("data.yaml")));
            if(!keepGoing.getAsBoolean())throw new ApiError(409,"flow_step_interrupted","导出已停止，尚未发布该数据集。");
            Files.move(temp,target,StandardCopyOption.ATOMIC_MOVE);record.addProperty("status","completed");record.addProperty("completedAt",Json.now());record.addProperty("manifestPath",target.resolve("manifest.json").toString());
            record.addProperty("trainCount",s.assets.stream().filter(a->train.contains(memberships.get(Json.required(a,"id")))).count());record.addProperty("valCount",s.assets.stream().filter(a->!train.contains(memberships.get(Json.required(a,"id")))).count());
            store.tx(c->{Store.update(c,"UPDATE exports SET data=? WHERE id=?",record,id);Store.flowEvent(c,"export.completed",flowId,stepId,null,null,null,Json.obj("projectId",projectId,"exportId",id));return null;});return record;
        }catch(Exception e){record.addProperty("status","failed");record.addProperty("errorCode",e instanceof ApiError a?a.code:"export_write_failed");store.tx(c->{Store.update(c,"UPDATE exports SET data=? WHERE id=?",record,id);Store.flowEvent(c,"export.failed",flowId,stepId,null,null,null,Json.obj("projectId",projectId,"exportId",id,"code",record.get("errorCode")));return null;});throw e;}
    }
    static String group(JsonObject a){JsonObject m=Json.object(a,"metadata");return Json.str(m,"sourceVideoId",Json.str(m,"groupId",Json.required(a,"contentHash")));}
    static Map<String,String> groups(List<JsonObject> assets){
        // 同内容、同视频或同素材组构成传递闭包，避免两种来源关系交叉时拆到不同集合。
        Map<String,String> parents=new HashMap<>(),first=new HashMap<>();for(JsonObject asset:assets){String id=Json.required(asset,"id");parents.put(id,id);}for(JsonObject asset:assets){String id=Json.required(asset,"id");JsonObject metadata=Json.object(asset,"metadata");List<String> keys=new ArrayList<>(List.of("hash:"+Json.required(asset,"contentHash")));for(String key:List.of("sourceVideoId","groupId"))if(metadata.has(key)&&!metadata.get(key).isJsonNull())keys.add(key+":"+Json.required(metadata,key));for(String key:keys){String other=first.putIfAbsent(key,id);if(other!=null){String left=root(parents,id),right=root(parents,other);if(!left.equals(right)){String minimum=left.compareTo(right)<0?left:right;parents.put(left,minimum);parents.put(right,minimum);}}}}
        Map<String,String> labels=new HashMap<>();for(JsonObject asset:assets)labels.merge(root(parents,Json.required(asset,"id")),group(asset),(a,b)->a.compareTo(b)<0?a:b);Map<String,String> result=new HashMap<>();for(JsonObject asset:assets){String id=Json.required(asset,"id");result.put(id,labels.get(root(parents,id)));}return result;
    }
    private static String root(Map<String,String> parents,String id){String result=id;while(!parents.get(result).equals(result))result=parents.get(result);while(!id.equals(result)){String next=parents.get(id);parents.put(id,result);id=next;}return result;}
    static String labels(JsonObject asset,String type,Map<String,Integer> classes){StringBuilder all=new StringBuilder();double w=Json.integer(asset,"width",1),h=Json.integer(asset,"height",1);
        for(JsonElement e:Json.array(asset,"annotations")){JsonObject a=e.getAsJsonObject();StringBuilder line=new StringBuilder(Integer.toString(classes.get(Json.required(a,"classId"))));
            if(type.equals("detect")||type.equals("pose")){JsonObject b=Json.object(a,"bbox");append(line,(Annotations.num(b,"x")+Annotations.num(b,"width")/2)/w,(Annotations.num(b,"y")+Annotations.num(b,"height")/2)/h,Annotations.num(b,"width")/w,Annotations.num(b,"height")/h);}
            if(type.equals("pose"))for(JsonElement k:Json.array(a,"keypoints")){JsonObject q=k.getAsJsonObject();int v=Json.integer(q,"visibility",0);append(line,v==0?0:Annotations.num(q,"x")/w,v==0?0:Annotations.num(q,"y")/h);line.append(' ').append(v);}
            if(type.equals("segment")||type.equals("obb"))for(JsonElement k:type.equals("obb")?Annotations.obb(a):Json.array(a,"points")){JsonObject q=k.getAsJsonObject();append(line,Annotations.num(q,"x")/w,Annotations.num(q,"y")/h);}
            all.append(line).append('\n');
        }return all.toString();
    }
    static void append(StringBuilder out,double... values){for(double value:values)out.append(' ').append(String.format(Locale.ROOT,"%.8f",value));}
    JsonArray list(String projectId){return store.read(c->Store.docs(c,"SELECT data FROM exports WHERE project_id=? ORDER BY rowid DESC",projectId));}
}
