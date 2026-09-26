package cn.autolabel.engine;

import com.google.gson.*;
import java.nio.file.*;
import java.sql.Connection;
import java.util.*;
import java.util.stream.Stream;

final class Projects {
    /** 超过这个张数转后台导入任务：同步命令在桌面侧的超时是 120 秒，上万张不可能在期限内完成。 */
    static final int ASYNC_IMPORT_THRESHOLD=500;
    final Store store;final Media media;MediaJobs mediaJobs;
    Projects(Store store){this.store=store;media=new Media(store);}
    JsonObject create(JsonObject p){
        String name=Json.required(p,"name"),type=Json.str(p,"taskType","detect");if(!Annotations.TYPES.contains(type))throw new ApiError(400,"task_type_invalid","任务类型无效。");
        JsonArray classes=Json.array(p,"classes");Annotations.classes(classes);String id=Json.id(),now=Json.now();
        JsonObject project=Json.obj("id",id,"name",name,"description",Json.str(p,"description",""),"taskType",type,"classes",classes,
            "createdAt",now,"updatedAt",now,"assetCount",0,"annotatedCount",0,"confirmedCount",0,"settings",Json.object(p,"settings"));
        TaskTemplates.validate(project,"project_template_invalid");return store.tx(c->{Store.update(c,"INSERT INTO projects(id,data) VALUES(?,?)",id,project);Store.event(c,"project.created",null,null,null,Json.obj("projectId",id));return project;});
    }
    JsonObject project(Connection c,String id)throws Exception{
        JsonObject p=Store.document(c,"projects",id);
        JsonObject counts=Store.one(c,"SELECT COUNT(*) AS total,COALESCE(SUM(CASE WHEN status IN ('candidate','modified','confirmed') THEN 1 ELSE 0 END),0) AS annotated,COALESCE(SUM(CASE WHEN status='confirmed' THEN 1 ELSE 0 END),0) AS confirmed FROM assets WHERE project_id=?",id);
        p.add("assetCount",counts.get("total"));p.add("annotatedCount",counts.get("annotated"));p.add("confirmedCount",counts.get("confirmed"));return p;
    }
    JsonObject get(String id){return store.read(c->project(c,id));}
    JsonArray list(){return store.read(c->{JsonArray a=new JsonArray();for(JsonObject row:Store.rows(c,"SELECT id FROM projects ORDER BY json_extract(data,'$.updatedAt') DESC"))a.add(project(c,row.get("id").getAsString()));return a;});}
    JsonObject update(JsonObject p){String id=Json.required(p,"projectId");return store.tx(c->{JsonObject project=Store.document(c,"projects",id);
        JsonObject incomingSettings=Json.object(p,"settings"),oldSettings=Json.object(project,"settings");
        if(incomingSettings.has("alphaBackground")&&!Json.str(incomingSettings,"alphaBackground","").equals(Json.str(oldSettings,"alphaBackground","#ffffff"))&&Store.one(c,"SELECT id FROM assets WHERE project_id=? LIMIT 1",id)!=null)throw new ApiError(409,"normalization_change_requires_new_input","现有素材的透明背景已固定；请在新项目设置背景后重新导入，避免旧标签与图片不一致。");
        for(String key:List.of("name","description","classes"))if(p.has(key))project.add(key,p.get(key));
        if(p.has("settings")){JsonObject settings=Json.object(project,"settings");for(var e:Json.object(p,"settings").entrySet())settings.add(e.getKey(),e.getValue());project.add("settings",settings);}
        Json.required(project,"name");Annotations.classes(Json.array(project,"classes"));TaskTemplates.validate(project,"project_template_invalid");
        if(p.has("classes")||p.has("settings"))for(JsonElement e:Store.docs(c,"SELECT data FROM assets WHERE project_id=?",id)){
            JsonObject a=e.getAsJsonObject();if(!Json.array(a,"annotations").isEmpty())Annotations.validateStored(Json.array(a,"annotations"),a,project);}
        project.addProperty("updatedAt",Json.now());Store.update(c,"UPDATE projects SET data=? WHERE id=?",project,id);Store.event(c,"project.updated",null,null,null,Json.obj("projectId",id));return project(c,id);});}
    static JsonObject asset(Connection c,String id)throws Exception{
        JsonObject a=Store.document(c,"assets",id);JsonObject draft=Store.one(c,"SELECT * FROM drafts WHERE asset_id=?",id);
        if(draft!=null){a.add("draft",JsonParser.parseString(draft.get("data").getAsString()));JsonObject m=Json.object(a,"metadata");m.add("draftBaseVersion",draft.get("base_version"));m.add("draftSavedAt",draft.get("saved_at"));a.add("metadata",m);}return a;
    }
    JsonObject asset(String id){return store.read(c->asset(c,id));}
    private static final List<String> RESULT_FILTERS=List.of("all","candidate","empty","failed","confirmed","unlabeled");
    /** 素材筛选统一以整项目数据计算，失败状态沿用最近 20 次运行中每张图的最新样本结果。 */
    private static String assetOverviewCte(){return "WITH recent_runs AS (SELECT id,json_extract(data,'$.createdAt') AS created_at,rowid AS run_order FROM runs WHERE project_id=? ORDER BY created_at DESC,rowid DESC LIMIT 20),"
        +" ranked_samples AS (SELECT s.asset_id,s.status,ROW_NUMBER() OVER(PARTITION BY s.asset_id ORDER BY r.created_at DESC,r.run_order DESC,s.rowid ASC) AS sample_rank FROM recent_runs r JOIN samples s ON s.run_id=r.id),"
        +" classified_assets AS (SELECT a.id,a.data,a.path,a.rowid AS asset_order,CASE WHEN a.status='confirmed' THEN 'confirmed' WHEN latest.status IN ('failed','unknown') THEN 'failed' WHEN a.status='candidate' THEN CASE WHEN json_array_length(a.data,'$.annotations')>0 THEN 'candidate' ELSE 'empty' END WHEN a.status='unlabeled' THEN 'unlabeled' ELSE 'other' END AS result_state FROM assets a LEFT JOIN ranked_samples latest ON latest.asset_id=a.id AND latest.sample_rank=1 WHERE a.project_id=?) ";}
    private static String filterCondition(String filter){if(!RESULT_FILTERS.contains(filter))throw new ApiError(400,"asset_result_filter_invalid","素材结果筛选状态无效。");return filter.equals("all")?"":" AND result_state=?";}
    private static List<Object> filterArgs(String projectId,String filter){List<Object> args=new ArrayList<>(List.of(projectId,projectId));if(!filter.equals("all"))args.add(filter);return args;}
    Path path(String id){return store.read(c->{JsonObject r=Store.one(c,"SELECT path FROM assets WHERE id=?",id);if(r==null)throw new ApiError(404,"asset_not_found","素材不存在。");return Path.of(r.get("path").getAsString());});}
    JsonObject listAssets(JsonObject p){String id=Json.required(p,"projectId"),filter=Json.str(p,"resultFilter","all");int offset=Json.bounded(p,"offset",0,0,Integer.MAX_VALUE),limit=Json.bounded(p,"limit",100,1,500);
        return store.read(c->{Store.document(c,"projects",id);String cte=assetOverviewCte(),filterWhere=filterCondition(filter);List<Object> overviewArgs=filterArgs(id,filter);
            JsonObject counts=Store.one(c,cte+"SELECT COUNT(*) AS all_count,COALESCE(SUM(result_state='candidate'),0) AS candidate,COALESCE(SUM(result_state='empty'),0) AS empty,COALESCE(SUM(result_state='failed'),0) AS failed,COALESCE(SUM(result_state='confirmed'),0) AS confirmed,COALESCE(SUM(result_state='unlabeled'),0) AS unlabeled,COALESCE(SUM(result_state='other'),0) AS other,COALESCE(SUM(json_extract(data,'$.status')='unlabeled'),0) AS status_unlabeled,COALESCE(SUM(json_extract(data,'$.status')='candidate'),0) AS status_candidate,COALESCE(SUM(json_extract(data,'$.status')='modified'),0) AS status_modified,COALESCE(SUM(json_extract(data,'$.status')='confirmed'),0) AS status_confirmed,COALESCE(SUM(json_extract(data,'$.status')='invalid'),0) AS status_invalid,COALESCE(SUM(json_extract(data,'$.status')='missing'),0) AS status_missing FROM classified_assets",id,id);
            JsonObject filterCounts=Json.obj("all",counts.get("all_count"),"candidate",counts.get("candidate"),"empty",counts.get("empty"),"failed",counts.get("failed"),"confirmed",counts.get("confirmed"),"unlabeled",counts.get("unlabeled"),"other",counts.get("other"));
            JsonObject statusCounts=Json.obj("unlabeled",counts.get("status_unlabeled"),"candidate",counts.get("status_candidate"),"modified",counts.get("status_modified"),"confirmed",counts.get("status_confirmed"),"invalid",counts.get("status_invalid"),"missing",counts.get("status_missing"));
            String condition=" WHERE 1=1"+filterWhere;List<Object> args=new ArrayList<>(overviewArgs);
            if(p.has("status")){condition+=" AND json_extract(data,'$.status')=?";args.add(Json.required(p,"status"));}
            JsonArray requestedIds=Json.array(p,"assetIds");if(p.has("assetIds")){if(requestedIds.size()>500)throw new ApiError(400,"asset_selection_too_large","单次素材读取最多 500 张。");if(requestedIds.isEmpty())condition+=" AND 0";else{StringBuilder marks=new StringBuilder();for(JsonElement assetId:requestedIds){if(marks.length()>0)marks.append(',');marks.append('?');args.add(assetId.getAsString());}condition+=" AND id IN ("+marks+")";}}
            long total=Store.one(c,cte+"SELECT COUNT(*) AS n FROM classified_assets"+condition,args.toArray()).get("n").getAsLong();
            args.add(limit);args.add(offset);JsonArray items=new JsonArray();
            // 一次取页内的素材 + 一次取这些素材的草稿：原来逐行各查两遍（N+1），上万素材时列表查询是主要卡顿源。
            List<JsonObject> rows=Store.rows(c,cte+"SELECT id,data,path,result_state FROM classified_assets"+condition+" ORDER BY asset_order LIMIT ? OFFSET ?",args.toArray());
            Map<String,JsonObject> drafts=new HashMap<>();if(!rows.isEmpty()){
                List<Object> draftArgs=new ArrayList<>();StringBuilder marks=new StringBuilder();
                for(JsonObject r:rows){if(marks.length()>0)marks.append(',');marks.append('?');draftArgs.add(Json.required(r,"id"));}
                for(JsonObject d:Store.rows(c,"SELECT asset_id,data,base_version,saved_at FROM drafts WHERE asset_id IN ("+marks+")",draftArgs.toArray()))drafts.put(Json.required(d,"asset_id"),d);}
            for(JsonObject r:rows){JsonObject item=Json.parse(r.get("data").getAsString());item.add("resultState",r.get("result_state"));JsonObject draft=drafts.get(Json.required(r,"id"));
                if(draft!=null){item.add("draft",Json.parse(draft.get("data").getAsString()));JsonObject m=Json.object(item,"metadata");m.add("draftBaseVersion",draft.get("base_version"));m.add("draftSavedAt",draft.get("saved_at"));item.add("metadata",m);}items.add(item);}
            return Json.obj("items",items,"total",total,"filterCounts",filterCounts,"statusCounts",statusCounts);});
    }
    JsonObject listAssetIds(JsonObject p){String id=Json.required(p,"projectId"),filter=Json.str(p,"resultFilter","all");int offset=Json.bounded(p,"offset",0,0,Integer.MAX_VALUE),limit=Json.bounded(p,"limit",500,1,500);String filterWhere=filterCondition(filter);List<Object> args=filterArgs(id,filter);args.add(limit);args.add(offset);
        return store.read(c->{Store.document(c,"projects",id);String cte=assetOverviewCte();long total=Store.one(c,cte+"SELECT COUNT(*) AS n FROM classified_assets WHERE 1=1"+filterWhere,filterArgs(id,filter).toArray()).get("n").getAsLong();JsonArray ids=new JsonArray();for(JsonObject row:Store.rows(c,cte+"SELECT id FROM classified_assets WHERE 1=1"+filterWhere+" ORDER BY asset_order LIMIT ? OFFSET ?",args.toArray()))ids.add(row.get("id"));return Json.obj("ids",ids,"total",total);});
    }
    /** 逐张归一化的取消与进度口子：同步导入用空实现，后台任务接真实任务状态。 */
    interface ImportMeter{default void checkpoint(){}default void progress(int done,int total,int skipped,int errors){}}
    static final class ImportTally{int imported,skipped;final JsonArray errors=new JsonArray();final JsonArray ids=new JsonArray();}
    synchronized JsonObject importAssets(JsonObject p){
        String projectId=Json.required(p,"projectId");JsonObject project=get(projectId);String mode=importMode(p);
        List<Path> files=expandImportFiles(p);
        if(files.size()>ASYNC_IMPORT_THRESHOLD&&mediaJobs!=null)return mediaJobs.queueAssetImport(projectId,mode,files);
        ImportTally tally=new ImportTally();
        try{importFiles(project,files,mode,tally,null);}catch(Exception e){if(e instanceof ApiError a&&a.status>=500)throw a;/* 同步导入尽力而为，单张失败已进 errors */}
        return Json.obj("imported",tally.imported,"skipped",tally.skipped,"errors",tally.errors,"assetIds",tally.ids);
    }
    static String importMode(JsonObject p){String mode=Json.str(p,"mode","copy");if(!Set.of("copy","reference").contains(mode))throw new ApiError(400,"import_mode_invalid","导入方式应为 copy 或 reference。");return mode;}
    static List<Path> expandImportFiles(JsonObject p){
        JsonArray paths=Json.array(p,"paths");if(paths.isEmpty())throw new ApiError(400,"paths_required","请选择图片或文件夹。");
        List<Path> files=new ArrayList<>();for(JsonElement e:paths){Path path=Path.of(e.getAsString()).toAbsolutePath().normalize();
            if(Files.isDirectory(path)){try(Stream<Path> stream=Files.walk(path,12)){stream.filter(Files::isRegularFile).filter(f->f.toString().toLowerCase().matches(".*\\.(jpe?g|png)$")).limit(10001-files.size()).forEach(files::add);}catch(Exception ex){throw new ApiError(400,"directory_unavailable","无法访问选定文件夹。");}}
            else files.add(path);if(files.size()>10000)throw new ApiError(413,"import_batch_too_large","单次最多导入 10000 张图片。");}
        return files;
    }
    /** 逐张归一化、每 200 张一次事务落库：坏图只记错跳过；去重走 content_hash 索引 + 批内指纹集。 */
    void importFiles(JsonObject project,List<Path> files,String mode,ImportTally tally,ImportMeter meter)throws Exception{
        String projectId=Json.required(project,"id");String background=Json.str(Json.object(project,"settings"),"alphaBackground","#ffffff");
        List<JsonObject> rows=new ArrayList<>();Set<String> seen=new HashSet<>();int done=0;
        for(Path source:files){
            if(meter!=null)meter.checkpoint();
            String id=Json.id();try{
                Media.Normalized result=media.normalize(source,id,background,mode.equals("copy"));String hash=result.hash();
                boolean duplicate=!seen.add(hash)||store.read(c->Store.one(c,"SELECT id FROM assets WHERE project_id=? AND content_hash=?",projectId,hash)!=null);
                if(duplicate){Files.deleteIfExists(result.path());if(mode.equals("copy"))Files.deleteIfExists(Path.of(Json.required(result.metadata(),"sourcePath")));tally.skipped++;}
                else{JsonObject asset=Json.obj("id",id,"projectId",projectId,"name",source.getFileName().toString(),"width",result.width(),"height",result.height(),
                    "mediaUrl","autolabel-media://asset/"+id,"thumbnailUrl","autolabel-media://thumb/"+id,"contentHash",hash,"status","unlabeled","annotations",new JsonArray(),"version",0,"source","import","metadata",result.metadata(),"privatePath",result.path().toString());
                    rows.add(asset);tally.ids.add(id);tally.imported++;if(rows.size()>=200)commitAssets(projectId,rows);}
            }catch(Exception e){if(e instanceof ApiError a&&a.status>=500)throw a;
                tally.errors.add(Json.obj("name",source.getFileName().toString(),"code",e instanceof ApiError a?a.code:"image_decode_failed","message",e instanceof ApiError a?a.getMessage():"图片解码或保存失败，请检查格式与文件权限。"));}
            done++;if(meter!=null)meter.progress(done,files.size(),tally.skipped,tally.errors.size());
        }
        commitAssets(projectId,rows);
    }
    private void commitAssets(String projectId,List<JsonObject> rows){
        if(rows.isEmpty())return;List<JsonObject> batch=new ArrayList<>(rows);rows.clear();
        store.tx(c->{for(JsonObject asset:batch){String id=Json.required(asset,"id"),path=Json.required(asset,"privatePath");asset.remove("privatePath");
                Store.update(c,"INSERT INTO assets(id,project_id,data,path) VALUES(?,?,?,?)",id,projectId,asset,path);}
            Store.event(c,"asset.imported",null,null,null,Json.obj("projectId",projectId,"imported",batch.size()));return null;});
    }
    JsonObject save(JsonObject p){return save(p,"manual",null);}
    JsonObject save(JsonObject p,String source,JsonObject sourceMetadata){String id=Json.required(p,"assetId");if(!p.has("baseVersion")||!p.has("annotations")||!p.get("annotations").isJsonArray())throw new ApiError(400,"invalid_argument","保存必须包含 baseVersion 与 annotations 数组。");
        return store.tx(c->{JsonObject a=Store.document(c,"assets",id);int base=Json.integer(p,"baseVersion",-1);if(base!=Json.integer(a,"version",0))throw new ApiError(409,"annotation_version_conflict","标注版本已变化，请检查新版本后再保存。",Json.obj("currentVersion",a.get("version")));
            JsonObject project=Store.document(c,"projects",Json.required(a,"projectId"));JsonArray annotations=Annotations.validate(Json.array(p,"annotations"),a,project);
            int version=nextVersion(c,id);String status=Json.bool(p,"confirm",false)?"confirmed":source.equals("manual")?"modified":"candidate";
            a.add("annotations",annotations);a.addProperty("version",version);a.addProperty("status",status);a.addProperty("source",source);
            if(source.equals("manual")&&Json.bool(Json.object(a,"metadata"),"requiresGeometryReview",false)){JsonObject metadata=Json.object(a,"metadata");metadata.addProperty("requiresGeometryReview",false);metadata.add("geometryReviewResolution",Json.obj("sourceVersion",base,"resolvedAt",Json.now(),"version",version));}
            JsonObject annotationMetadata=Json.object(a,"metadata");annotationMetadata.add("annotationTemplate",TaskTemplates.snapshot(project));a.add("metadata",annotationMetadata);
            if(source.equals("manual")&&Json.bool(annotationMetadata,"requiresTrackReview",false)){annotationMetadata.addProperty("requiresTrackReview",false);annotationMetadata.add("trackReviewResolution",Json.obj("sourceVersion",base,"resolvedAt",Json.now(),"version",version));}
            if(sourceMetadata!=null){JsonObject metadata=Json.object(a,"metadata");metadata.add("labelImport",sourceMetadata);a.add("metadata",metadata);}
            Store.update(c,"INSERT INTO versions(asset_id,version,source,data,created_at) VALUES(?,?,?,?,?)",id,version,source,a,Json.now());Store.update(c,"UPDATE assets SET data=? WHERE id=?",a,id);
            Store.update(c,"DELETE FROM drafts WHERE asset_id=?",id);Store.event(c,"annotation.saved",null,id,null,Json.obj("projectId",a.get("projectId"),"version",version,"status",status));return a;});
    }
    static int nextVersion(Connection c,String id)throws Exception{return Store.one(c,"SELECT COALESCE(MAX(version),0)+1 AS n FROM versions WHERE asset_id=?",id).get("n").getAsInt();}
    JsonObject draft(JsonObject p){String id=Json.required(p,"assetId");if(!p.has("baseVersion")||!p.has("annotations")||!p.get("annotations").isJsonArray())throw new ApiError(400,"invalid_argument","草稿必须包含版本与标注数组。");
        return store.tx(c->{Store.document(c,"assets",id);String now=Json.now();Store.update(c,"INSERT INTO drafts(asset_id,base_version,data,saved_at) VALUES(?,?,?,?) ON CONFLICT(asset_id) DO UPDATE SET base_version=excluded.base_version,data=excluded.data,saved_at=excluded.saved_at",id,Json.integer(p,"baseVersion",-1),p.get("annotations"),now);Store.event(c,"annotation.draft_saved",null,id,null,Json.obj("savedAt",now));return Json.obj("savedAt",now);});}
    JsonArray history(String id){return store.read(c->Store.docs(c,"SELECT data FROM versions WHERE asset_id=? ORDER BY version DESC LIMIT 100",id));}
    JsonObject example()throws Exception{
        try(var definition=Projects.class.getResourceAsStream("/examples/example-street.json");var picture=Projects.class.getResourceAsStream("/examples/example-street.png")){
            if(definition!=null&&picture!=null){JsonObject info=Json.parse(new String(definition.readAllBytes(),java.nio.charset.StandardCharsets.UTF_8));
                JsonObject p=create(Json.obj("name",info.get("name"),"description",info.get("description"),"taskType","detect","classes",info.get("classes"),"settings",Json.obj("example",true,"synthetic",true,"notCompleteGroundTruth",true)));
                String pid=Json.required(p,"id");Path dir=store.root.resolve("examples").resolve(pid);Files.createDirectories(dir);Path file=dir.resolve("城市场景.png");Files.copy(picture,file);
                JsonObject imported=importAssets(Json.obj("projectId",pid,"paths",Json.arr(file.toString())));String aid=Json.array(imported,"assetIds").get(0).getAsString();
                save(Json.obj("assetId",aid,"baseVersion",0,"annotations",info.get("annotations"),"confirm",false));
                store.tx(c->{JsonObject a=Store.document(c,"assets",aid);a.addProperty("source","preset_manual");JsonObject m=Json.object(a,"metadata");m.addProperty("synthetic",true);m.addProperty("notCompleteGroundTruth",true);m.addProperty("sourceDescription",Json.str(info,"source","预置人工示例"));a.add("metadata",m);
                    Store.update(c,"UPDATE assets SET data=? WHERE id=?",a,aid);Store.update(c,"UPDATE versions SET source='preset_manual',data=? WHERE asset_id=? AND version=1",a,aid);return null;});return get(pid);
            }
        }
        JsonObject project=create(Json.obj("name","示例 · 物品检测","description","离线几何示例，图片由软件绘制，可自由分发。标注是预置人工规则样例，不含 AI 调用。","taskType","detect",
            "classes",Json.arr(Json.obj("id","sample-box","name","收纳盒","color","#3b82f6")),"settings",Json.obj("example",true,"license","CC0-1.0","synthetic",true)));
        String pid=Json.required(project,"id");Path dir=store.root.resolve("examples").resolve(pid);Files.createDirectories(dir);JsonArray paths=new JsonArray();
        for(int i=0;i<6;i++){Path path=dir.resolve("样例-"+(i+1)+".png");Media.sample(path,i);paths.add(path.toString());}
        JsonObject imported=importAssets(Json.obj("projectId",pid,"paths",paths,"mode","copy"));
        for(int i=0;i<Json.array(imported,"assetIds").size();i++){String id=Json.array(imported,"assetIds").get(i).getAsString();int index=i;
            store.tx(c->{JsonObject a=Store.document(c,"assets",id);a.add("annotations",Json.arr(Json.obj("id",Json.id(),"type","detect","classId","sample-box","bbox",Json.obj("x",170+index*27,"y",155+index*13,"width",360,"height",260))));
                a.addProperty("status","confirmed");a.addProperty("version",1);a.addProperty("source","preset_manual");Json.object(a,"metadata").addProperty("synthetic",true);
                Store.update(c,"UPDATE assets SET data=? WHERE id=?",a,id);Store.update(c,"INSERT INTO versions(asset_id,version,source,data,created_at) VALUES(?,?,?,?,?)",id,1,"preset_manual",a,Json.now());Store.event(c,"annotation.saved",null,id,null,Json.obj("projectId",pid,"version",1,"source","preset_manual"));return null;});
        }return get(pid);
    }
}
