package cn.autolabel.engine;

import com.google.gson.*;
import java.nio.file.*;
import java.sql.Connection;
import java.util.*;
import java.util.concurrent.*;

final class Runs implements AutoCloseable {
    final Store store;final Projects projects;final Providers providers;final CandidateReuse reuse;RunResults inputResults;InputResultReuse inputReuse;
    private final int globalLimit;
    private final ThreadPoolExecutor requests;
    private final ScheduledExecutorService dispatcher=Executors.newSingleThreadScheduledExecutor(Thread.ofPlatform().name("queue-dispatcher").factory());
    private final Object dispatchGate=new Object();
    private volatile boolean closed,suspended,storagePaused,dataMaintenancePaused;
    private volatile long suspendedAt;
    /** 存储异常只暂停派发一段时间：瞬时磁盘抖动或一次写失败不应该让后台任务永久停摆。 */
    private volatile long storagePausedUntil;
    private int roundRobin;
    volatile Runnable flowTick=()->{};
    Runs(Store store,Projects projects,Providers providers){this.store=store;this.projects=projects;this.providers=providers;reuse=new CandidateReuse(store);
        globalLimit=store.read(c->{JsonObject r=Store.one(c,"SELECT data FROM settings WHERE id='global'");return r==null?8:Json.bounded(Json.parse(r.get("data").getAsString()),"globalConcurrency",8,1,32);});
        requests=new ThreadPoolExecutor(globalLimit,globalLimit,0,TimeUnit.MILLISECONDS,new ArrayBlockingQueue<>(globalLimit),Thread.ofPlatform().name("model-annotation-",0).factory(),new ThreadPoolExecutor.AbortPolicy());
        recover();dispatcher.scheduleWithFixedDelay(this::tick,100,80,TimeUnit.MILLISECONDS);
    }
    void recover(){store.tx(c->{
        Store.update(c,"INSERT OR IGNORE INTO budgets(id,max_requests,used) SELECT COALESCE(json_extract(data,'$.budgetScopeId'),id),COALESCE(MIN(json_extract(data,'$.maxRequests')),9223372036854775807),SUM(COALESCE(json_extract(data,'$.requestsUsed'),0)) FROM runs WHERE COALESCE(json_extract(data,'$.kind'),'api')='api' GROUP BY COALESCE(json_extract(data,'$.budgetScopeId'),id)");
        for(JsonObject row:Store.rows(c,"SELECT id,data FROM runs WHERE status='running'")){JsonObject run=Json.parse(row.get("data").getAsString());run.addProperty("status","paused");run.addProperty("pauseReason","restart_review");Store.update(c,"UPDATE runs SET status='paused',data=? WHERE id=?",run,row.get("id").getAsString());}
        for(JsonObject row:Store.rows(c,"SELECT samples.*,runs.status AS run_status,json_extract(runs.data,'$.kind') AS run_kind FROM samples JOIN runs ON runs.id=samples.run_id WHERE samples.status IN ('preparing','sending','waiting','parsing','validating','saving')")){
            String attempt=Json.str(row,"active_attempt",null);JsonObject a=attempt==null?null:Store.one(c,"SELECT status FROM attempts WHERE id=?",attempt);
            boolean sent=a!=null&&Set.of("sent","unknown").contains(Json.str(a,"status",""))||Json.str(row,"run_kind","").equals("local")&&!Json.required(row,"status").equals("preparing");String status=Json.str(row,"run_status","").equals("cancelled")?"cancelled":sent?"unknown":"queued";
            Store.update(c,"UPDATE samples SET status=?,active_attempt=NULL WHERE id=?",status,row.get("id").getAsString());Store.event(c,"sample."+status,Json.required(row,"run_id"),Json.required(row,"asset_id"),attempt,Json.obj("reason","engine_restarted","remoteResultUnknown",sent));}
        for(JsonObject row:Store.rows(c,"SELECT id,data FROM attempts WHERE status='sent'")){JsonObject a=Json.parse(row.get("data").getAsString());a.addProperty("status","unknown");a.addProperty("errorCode","engine_restarted");Store.update(c,"UPDATE attempts SET status='unknown',data=? WHERE id=?",a,Json.required(row,"id"));}
        for(JsonObject row:Store.rows(c,"SELECT id,data FROM exports WHERE json_extract(data,'$.status')='writing'")){JsonObject e=Json.parse(row.get("data").getAsString());e.addProperty("status","failed");e.addProperty("errorCode","engine_restarted");Store.update(c,"UPDATE exports SET data=? WHERE id=?",e,Json.required(row,"id"));}
        Store.event(c,"engine.recovered",null,null,null,Json.obj("requiresRunReview",true));return null;});}
    JsonObject create(JsonObject p){store.requireSpace(0);String projectId=Json.required(p,"projectId"),providerId=Json.required(p,"providerId"),model=Json.required(p,"model");JsonObject provider=providers.get(providerId);
        if(p.has("flow")||p.has("steps")||p.has("pipeline"))throw new ApiError(422,"flow_execution_not_implemented","run.create 仅执行 API 标注节点，完整流程请使用 flow.create。");
        providers.requireCredential(provider);
        String id=Json.id();
        return store.tx(c->{JsonObject project=Store.document(c,"projects",projectId);if(Json.array(project,"classes").isEmpty())throw new ApiError(422,"classes_required","请先设置类别。");
            Set<String> wanted=new LinkedHashSet<>();for(JsonElement e:Json.array(p,"assetIds"))wanted.add(e.getAsString());List<JsonObject> selected=new ArrayList<>();
            if(p.has("assetIds")&&wanted.isEmpty())throw new ApiError(400,"asset_selection_empty","所选素材为空，请选择素材后运行。");
            for(JsonObject r:Store.rows(c,"SELECT id,data,path FROM assets WHERE project_id=? ORDER BY rowid",projectId))if(wanted.isEmpty()||wanted.contains(Json.required(r,"id")))selected.add(r);
            if(selected.isEmpty()||(!wanted.isEmpty()&&selected.size()!=wanted.size()))throw new ApiError(400,"run_assets_invalid","请选择属于当前项目的有效素材。");
            JsonArray resourceSelections=Json.array(p,"referenceResources"),assetReferences=Json.array(p,"referenceAssetIds");if(p.has("referenceResources")&&!p.get("referenceResources").isJsonArray())throw new ApiError(400,"reference_invalid","资源参考必须为数组。");if(resourceSelections.size()+assetReferences.size()>63)throw new ApiError(422,"image_limit_exceeded","项目和资源库参考合计最多 63 张。");
            JsonArray references=new JsonArray();for(JsonElement e:assetReferences){String refId=e.getAsString();if(selected.stream().anyMatch(r->Json.required(r,"id").equals(refId)))throw new ApiError(422,"reference_target_overlap","参考素材不能同时作为本次待标注素材。");
                JsonObject reference=Store.document(c,"assets",refId);if(!Json.required(reference,"projectId").equals(projectId)||!Set.of("confirmed","modified").contains(Json.str(reference,"status","")))throw new ApiError(422,"reference_invalid","参考样例必须是当前项目的人工标注。");references.add(reference);}
            ResourceLibrary library=new ResourceLibrary(store,projects);for(JsonElement selection:resourceSelections){if(!selection.isJsonObject())throw new ApiError(400,"reference_invalid","资源参考选择必须为对象。");JsonObject reference=library.resolveReference(c,selection.getAsJsonObject(),project);if(selected.stream().anyMatch(r->Json.required(r,"id").equals(Json.required(reference,"id"))))throw new ApiError(422,"reference_target_overlap","资源参考源素材不能同时作为本次目标。");references.add(reference);}
            if(references.size()+1>Json.integer(provider,"maxImages",8))throw new ApiError(422,"image_limit_exceeded","参考图片加目标图片超过接口图片数量限制。");
            insert(c,prepare(p,id,project,provider,references,selected));return view(c,id,true);});
    }
    record Prepared(JsonObject run,JsonArray samples){}
    static void validateReuse(JsonObject p){
        for(String field:List.of("reuseEnabled","forceRerun"))if(p.has(field)&&(!p.get(field).isJsonPrimitive()||!p.getAsJsonPrimitive(field).isBoolean()))throw new ApiError(400,"reuse_policy_invalid",field+" 必须为布尔值。");
        if(p.has("reuseScope")&&!Set.of("hint","template","none").contains(Json.str(p,"reuseScope","")))throw new ApiError(400,"reuse_policy_invalid","复用口径只能是 hint、template 或 none。");
        if(p.has("force"))throw new ApiError(400,"reuse_policy_invalid","强制重新请求请使用 forceRerun。");
        if(p.has("reuseMaxAgeSeconds")&&!p.get("reuseMaxAgeSeconds").isJsonNull())try{JsonElement value=p.get("reuseMaxAgeSeconds");if(!value.isJsonPrimitive()||!value.getAsJsonPrimitive().isNumber()||value.getAsBigDecimal().longValueExact()<1)throw new ArithmeticException();Math.multiplyExact(value.getAsBigDecimal().longValueExact(),1000L);}catch(ArithmeticException error){throw new ApiError(400,"reuse_age_invalid","结果有效期必须是可支持的正整数秒数。");}
    }
    Prepared prepare(JsonObject p,String id,JsonObject project,JsonObject provider,JsonArray references,List<JsonObject> selected){
        validateReuse(p);
        if(selected.isEmpty())throw new ApiError(400,"asset_selection_empty","所选素材为空，不能创建标注子任务。");
        String model=Json.required(p,"model"),prompt=Json.required(p,"prompt");int concurrency=Json.bounded(p,"concurrency",Math.min(4,globalLimit),1,32),retries=Json.bounded(p,"maxRetries",Json.integer(provider,"maxRetries",2),0,6);
        long max=Json.number(p,"maxRequests",Long.MAX_VALUE);if(max<1)throw new ApiError(400,"budget_invalid","请求上限至少为 1。");String policy=Json.str(p,"failurePolicy","continue");if(!Set.of("continue","pause").contains(policy))throw new ApiError(400,"invalid_argument","失败策略应为 continue 或 pause。");
        JsonObject run=Json.obj("id",id,"projectId",project.get("id"),"name",Json.str(p,"name","自动标注 · "+model),"status","running","createdAt",Json.now(),"updatedAt",Json.now(),"providerId",provider.get("id"),"model",model,"prompt",prompt,
            "concurrency",concurrency,"maxRetries",retries,"total",selected.size(),"requestsUsed",0,"retries",0,"reused",0,"plannedRequests",selected.size(),"estimatedMaxRequests",(long)selected.size()*(retries+1),
            "snapshot",Json.obj("project",project.deepCopy(),"provider",provider.deepCopy(),"references",references.deepCopy(),"parserVersion","annotations-v1","validatorVersion",TaskTemplates.VALIDATOR_VERSION,"requestContractVersion",TaskTemplates.REQUEST_CONTRACT_VERSION,"credentialBindingVersion",providers.credentialBindingVersion(Json.required(provider,"id")),"normalizationVersion",Media.NORMALIZATION_VERSION),"failurePolicy",policy,"budgetScopeId",Budgets.scope(p,id));
        String reuseScope=Json.str(p,"reuseScope",Json.bool(p,"reuseEnabled",true)?"template":"none");run.addProperty("reuseScope",reuseScope);run.addProperty("reuseEnabled",!reuseScope.equals("none")&&Json.bool(p,"reuseEnabled",true));run.addProperty("forceRerun",Json.bool(p,"forceRerun",false));run.addProperty("force",Json.bool(p,"forceRerun",false));if(p.has("reuseMaxAgeSeconds"))run.add("reuseMaxAgeSeconds",p.get("reuseMaxAgeSeconds"));if(max!=Long.MAX_VALUE)run.addProperty("maxRequests",max);
        // 发送副本的配方在这里就校验并冻结：越界区域现在报错，之后每次请求都按同一份配方发。
        if(p.has("payload")&&!p.get("payload").isJsonNull())run.add("payload",PayloadImages.freeze(Json.object(p,"payload")));JsonArray samples=new JsonArray();
        for(JsonObject row:selected){JsonObject asset=Json.parse(row.get("data").getAsString());samples.add(Json.obj("id",Json.id(),"assetId",asset.get("id"),"asset",asset,"inputPath",row.get("path"),"baseVersion",asset.get("version")));}
        return new Prepared(run,samples);
    }
    static void insert(Connection c,Prepared prepared)throws Exception{
        JsonObject run=prepared.run;String id=Json.required(run,"id");if(run.has("flowRunId")){if(Store.one(c,"SELECT id FROM budgets WHERE id=?",Json.required(run,"budgetScopeId"))==null)throw new ApiError(409,"budget_scope_missing","流程共享预算尚未建立。");}else Budgets.ensure(c,Json.required(run,"budgetScopeId"),Json.number(run,"maxRequests",Long.MAX_VALUE),false);
        // 调用者同时提交步骤的 childRunId，调度器不可能看到一半创建的流程子任务。
        Store.update(c,"INSERT INTO runs(id,project_id,status,data) VALUES(?,?,?,?)",id,Json.required(run,"projectId"),"running",run);
        for(JsonElement value:prepared.samples){JsonObject sample=value.getAsJsonObject();Store.update(c,"INSERT INTO samples(id,run_id,asset_id,input_id,status,data) VALUES(?,?,?,?,?,?)",Json.required(sample,"id"),id,Json.required(sample,"assetId"),Json.str(sample,"inputId",Json.required(sample,"assetId")),"queued",sample);}
        Store.event(c,"run.created",id,null,null,Json.obj("total",run.get("total"),"model",run.get("model"),"concurrency",run.get("concurrency"),"requestsUsed",0));
    }
    JsonObject get(String id){return get(Json.obj("runId",id));}
    /** 样本分页：默认沿用 5000 上限（兼容既有调用方），任务详情传小页签把响应压在 MB 级以内。 */
    JsonObject get(JsonObject p){String id=Json.required(p,"runId");int limit=Json.bounded(p,"sampleLimit",5000,1,5000),offset=Json.bounded(p,"sampleOffset",0,0,Integer.MAX_VALUE);return store.read(c->view(c,id,limit,offset));}
    JsonArray list(String project){return store.read(c->{JsonArray a=new JsonArray();for(JsonObject r:project==null?Store.rows(c,"SELECT id FROM runs ORDER BY rowid DESC LIMIT 100"):Store.rows(c,"SELECT id FROM runs WHERE project_id=? ORDER BY rowid DESC LIMIT 100",project))a.add(view(c,Json.required(r,"id"),0,0));return a;});}
    JsonObject view(Connection c,String id,boolean samples)throws Exception{return view(c,id,samples?5000:0,0);}
    JsonObject view(Connection c,String id,int sampleLimit,int sampleOffset)throws Exception{
        JsonObject run=Store.document(c,"runs",id);run.addProperty("kind",Json.str(run,"kind","api"));run.remove("force");JsonObject stats=Json.obj("total",Json.integer(run,"total",0),"queued",0,"preparing",0,"sending",0,"waiting",0,"parsing",0,"validating",0,"saving",0,"succeeded",0,"failed",0,"cancelled",0,"unknown",0,"retry_wait",0,"reused",Json.integer(run,"reused",0));
        String scope=Json.str(run,"budgetScopeId",id);if(Store.one(c,"SELECT id FROM budgets WHERE id=?",scope)!=null)run.add("budget",Budgets.view(c,scope));
        for(JsonObject r:Store.rows(c,"SELECT status,COUNT(*) AS n FROM samples WHERE run_id=? GROUP BY status",id))stats.add(Json.required(r,"status"),r.get("n"));
        long inFlight=Store.one(c,"SELECT COUNT(*) AS n FROM attempts WHERE run_id=? AND status='sent'",id).get("n").getAsLong();if(Json.str(run,"kind","api").equals("local"))inFlight=Json.number(Store.one(c,"SELECT COUNT(*) AS n FROM samples WHERE run_id=? AND status IN ('preparing','waiting','parsing','validating','saving')",id),"n",0);stats.addProperty("inFlight",inFlight);stats.addProperty("requestsUsed",Json.number(run,"requestsUsed",0));stats.addProperty("retries",Json.number(run,"retries",0));stats.addProperty("globalConcurrency",globalLimit);
        stats.addProperty("completed",Json.number(stats,"succeeded",0)+Json.number(stats,"failed",0)+Json.number(stats,"cancelled",0));stats.addProperty("inputTotal",Json.integer(run,"total",0));stats.addProperty("inputCompleted",Json.integer(stats,"completed",0)+Json.integer(stats,"unknown",0));stats.addProperty("baselineTotal",Json.integer(Store.one(c,"SELECT COUNT(DISTINCT asset_id) AS n FROM samples WHERE run_id=?",id),"n",0));stats.addProperty("baselineCompleted",Json.integer(Store.one(c,"SELECT COUNT(*) AS n FROM (SELECT asset_id FROM samples WHERE run_id=? GROUP BY asset_id HAVING SUM(CASE WHEN status IN ('succeeded','failed','unknown','cancelled') THEN 0 ELSE 1 END)=0)",id),"n",0));run.add("statistics",stats);
        Json.object(Json.object(Json.object(run,"snapshot"),"local"),"model").remove("modelPath");if(sampleLimit>0){JsonArray items=new JsonArray();long total=Json.number(Store.one(c,"SELECT COUNT(*) AS n FROM samples WHERE run_id=?",id),"n",0);
            for(JsonObject r:Store.rows(c,"SELECT * FROM samples WHERE run_id=? ORDER BY rowid LIMIT ? OFFSET ?",id,sampleLimit,sampleOffset)){
            JsonObject data=Json.parse(r.get("data").getAsString());JsonObject item=Json.obj("id",r.get("id"),"assetId",r.get("asset_id"),"status",r.get("status"),"attemptCount",r.get("attempt_count"),"nextAttemptAt",r.get("next_at"),"attemptId",r.get("active_attempt"),"inputId",r.get("input_id"),"name",data.has("name")?data.get("name"):Json.object(data,"asset").get("name"));
            if(Json.str(run,"kind","api").equals("local"))item.add("attemptId",JsonNull.INSTANCE);for(String key:List.of("errorCode","message","candidateVersion","startedAt","completedAt","reused","reusedFrom","resultId","requiresGeometryReview","inputReusedFrom"))if(data.has(key))item.add(key,data.get(key));if(data.has("inputSnapshot"))item.add("inputSnapshot",RunInputs.publicSnapshot(Json.object(data,"inputSnapshot")));items.add(item);}run.add("samples",items);run.addProperty("samplesTotal",total);run.addProperty("samplesTruncated",sampleOffset+items.size()<total);}
        return run;
    }
    JsonObject control(String action,JsonObject p){return store.tx(c->control(c,action,p));}
    JsonObject control(Connection c,String action,JsonObject p)throws Exception{String id=Json.required(p,"runId");JsonObject run=Store.document(c,"runs",id);
        if(!action.equals("cancel")&&Json.str(run,"status","").equals("cancelled"))throw new ApiError(409,"run_cancelled","已取消任务请创建新运行。");
        if(p.has("maxRequests")){long max=Json.number(p,"maxRequests",0);if(max<1)throw new ApiError(400,"budget_invalid","请求上限至少为 1。");run.addProperty("maxRequests",max);Budgets.ensure(c,Json.str(run,"budgetScopeId",id),max,true);}
        switch(action){
            case "pause"->{run.addProperty("status","paused");run.addProperty("pauseReason","user");}
            case "resume"->{if(Json.str(run,"status","").equals("cancelled"))throw new ApiError(409,"run_cancelled","已取消任务请创建新运行。");run.addProperty("status","running");run.remove("pauseReason");}
            case "cancel"->{run.addProperty("status","cancelled");Store.update(c,"UPDATE samples SET status='cancelled' WHERE run_id=? AND status IN ('queued','retry_wait','unknown')",id);}
            case "retry"->{Set<String> selected=new HashSet<>();for(JsonElement e:Json.array(p,"assetIds"))selected.add(e.getAsString());
                for(JsonObject sample:Store.rows(c,"SELECT id,asset_id,status FROM samples WHERE run_id=? AND status IN ('failed','unknown')",id)){
                    if(!selected.isEmpty()&&!selected.contains(Json.required(sample,"asset_id")))continue;
                    if(Json.required(sample,"status").equals("unknown")&&!Json.bool(p,"retryUnknown",false))continue;
                    Store.update(c,"UPDATE samples SET status='queued',next_at=0,active_attempt=NULL,data=json_set(data,'$.retryRequested',json('true')) WHERE id=?",Json.required(sample,"id"));}
                run.addProperty("status","running");run.remove("pauseReason");}
            default->throw new IllegalArgumentException();}
        run.addProperty("updatedAt",Json.now());Store.update(c,"UPDATE runs SET status=?,data=? WHERE id=?",Json.required(run,"status"),run,id);Store.event(c,"run."+action,id,null,null,Json.obj("status",run.get("status"),"maxRequests",run.get("maxRequests"),"retryUnknown",Json.bool(p,"retryUnknown",false)));return view(c,id,true);}
    boolean dispatchAllowed(){return !closed&&!suspended&&!storagePaused&&!dataMaintenancePaused&&!store.writeFailed;}
    /** 存储类失败只暂停派发固定时长，到期自动复核；磁盘仍不可用时下一次 tick 会再次暂停。 */
    void pauseStorage(String reason){storagePaused=true;storagePausedUntil=System.currentTimeMillis()+30000;System.err.println("engine_dispatch_paused:"+reason);}
    void tick(){synchronized(dispatchGate){
        // 调度线程是唯一驱动后台流程的线程。ScheduledExecutorService 在任务抛出异常后会静默停止
        // 后续执行，表现为 HTTP 与健康检查都正常、但任务永远不再推进，因此这里必须兜住所有异常。
        if(storagePaused&&System.currentTimeMillis()>=storagePausedUntil)storagePaused=false;
        if(dispatchAllowed()){try{flowTick.run();}catch(Throwable failure){System.err.println("engine_flow_tick_failed:"+failure.getClass().getSimpleName());}}
        dispatchTick();}}
    private void dispatchTick(){if(closed||suspended||storagePaused||dataMaintenancePaused||store.writeFailed)return;
        try{
            if(requests.getActiveCount()+requests.getQueue().size()>=globalLimit)return;store.requireSpace(0);
            List<JsonObject> runs=store.read(c->Store.rows(c,"SELECT id,data FROM runs WHERE status='running' AND COALESCE(json_extract(data,'$.kind'),'api')='api' ORDER BY rowid LIMIT 100"));if(runs.isEmpty())return;
            int start=Math.floorMod(roundRobin++,runs.size());for(int i=0;i<runs.size();i++){
                JsonObject run=Json.parse(runs.get((start+i)%runs.size()).get("data").getAsString());String id=Json.required(run,"id");
                JsonObject sample=store.read(c->{long active=Store.one(c,"SELECT COUNT(*) AS n FROM samples WHERE run_id=? AND status IN ('preparing','sending','waiting','parsing','validating','saving')",id).get("n").getAsLong();
                    if(active>=Json.integer(run,"concurrency",4))return null;return Store.one(c,"SELECT * FROM samples WHERE run_id=? AND status IN ('queued','retry_wait') AND next_at<=? ORDER BY rowid LIMIT 1",id,System.currentTimeMillis());});
                if(sample==null){if(Json.bool(run,"inputResults",false))inputResults.schedulePending(id);settle(id);continue;}
                try{providers.credentialFor(Json.object(Json.object(run,"snapshot"),"provider"),Json.object(run,"snapshot"));}catch(ApiError error){pauseBudget(id,error.code);continue;}
                String attempt=Json.id(),sampleId=Json.required(sample,"id"),assetId=Json.required(sample,"asset_id");
                boolean claimed=store.tx(c->{if(!Json.required(Store.document(c,"runs",id),"status").equals("running"))return false;
                    int changed=Store.update(c,"UPDATE samples SET status='preparing',active_attempt=? WHERE id=? AND status IN ('queued','retry_wait')",attempt,sampleId);if(changed==1)Store.event(c,"sample.preparing",id,assetId,attempt,Json.obj("stage","preparing"));return changed==1;});
                if(!claimed)continue;
                try{requests.execute(()->execute(run,sample,attempt));}catch(RejectedExecutionException e){releasePreparation(id,sampleId,attempt,0);}
                return;
            }
        }catch(ApiError e){if(e.code.startsWith("storage_")||e.code.equals("disk_space_low"))pauseStorage(e.code);}
        catch(Exception e){pauseStorage("internal_error");}
    }
    void pauseBudget(String id){pauseBudget(id,"budget_exhausted");}
    record ReuseRequest(JsonObject body,CandidateReuse.Prepared prepared){}
    ReuseRequest prepareReuse(JsonObject run,JsonObject row,JsonObject body,Providers.Credential credential)throws Exception{
        if(Json.bool(run,"inputResults",false)||Json.integer(row,"attempt_count",-1)!=0||Json.bool(run,"evaluationOnly",false))return null;String binding=credential.bindingVersion;if(binding==null)return null;
        try{CandidateReuse.Prepared prepared=reuse.prepareAttempt(run,row,body,binding);return prepared==null?null:new ReuseRequest(body,prepared);}
        catch(ApiError error){if(error.code.startsWith("storage_"))throw error;return null;}catch(java.io.IOException error){return null;}
    }
    boolean applyReuse(JsonObject initialRun,JsonObject row,String preparingAttempt,ReuseRequest request)throws Exception{
        if(!Json.bool(initialRun,"reuseEnabled",true)||Json.bool(initialRun,"force",false)||Json.bool(Json.parse(row.get("data").getAsString()),"retryRequested",false))return false;
        CandidateReuse.Match found=reuse.find(request.prepared,System.currentTimeMillis());if(found==null)return false;String id=Json.required(initialRun,"id"),sampleId=Json.required(row,"id"),assetId=Json.required(row,"asset_id");
        return store.tx(c->{if(!dispatchAllowed())return false;JsonObject run=Store.document(c,"runs",id),snapshot=Json.object(run,"snapshot");try{providers.credentialFor(Json.object(snapshot,"provider"),snapshot);}catch(ApiError error){if(Json.required(run,"status").equals("running")){run.addProperty("status","paused");run.addProperty("pauseReason",error.code);Store.update(c,"UPDATE runs SET status='paused',data=? WHERE id=?",run,id);Store.event(c,"run.paused",id,null,null,Json.obj("reason",error.code));}Store.update(c,"UPDATE samples SET status=?,active_attempt=NULL,next_at=0 WHERE id=? AND active_attempt=?",Json.required(run,"status").equals("cancelled")?"cancelled":"queued",sampleId,preparingAttempt);return true;}
            JsonObject current=Store.one(c,"SELECT active_attempt,data FROM samples WHERE id=?",sampleId);if(current==null||!preparingAttempt.equals(Json.str(current,"active_attempt","")))return false;CandidateReuse.Match match=reuse.revalidate(c,request.prepared,found);if(match==null)return false;JsonObject sample=Json.parse(current.get("data").getAsString()),asset=Store.document(c,"assets",assetId),frozen=Json.object(snapshot,"project");int version=Projects.nextVersion(c,assetId);JsonObject candidate=asset.deepCopy();candidate.add("annotations",match.annotations());candidate.addProperty("version",version);candidate.addProperty("status","candidate");candidate.addProperty("source","api");candidate.addProperty("runId",id);candidate.remove("attemptId");candidate.remove("reuse");candidate.addProperty("reused",true);candidate.add("reusedFrom",match.provenance());JsonObject metadata=Json.object(candidate,"metadata");metadata.remove("reuse");metadata.add("annotationTemplate",TaskTemplates.snapshot(frozen));candidate.add("metadata",metadata);
            // 复用生成独立候选版本，不虚构远端 attempt、用量或人工确认。
            Store.update(c,"INSERT INTO versions(asset_id,version,source,data,attempt_id,created_at) VALUES(?,?,?,?,NULL,?)",assetId,version,"api",candidate,Json.now());boolean protectedHuman=Set.of("modified","confirmed").contains(Json.str(asset,"status",""))||Json.integer(asset,"version",0)!=Json.integer(sample,"baseVersion",0)||Store.one(c,"SELECT asset_id FROM drafts WHERE asset_id=?",assetId)!=null;if(!protectedHuman)Store.update(c,"UPDATE assets SET data=? WHERE id=?",candidate,assetId);
            sample.addProperty("candidateVersion",version);sample.addProperty("completedAt",Json.now());sample.addProperty("reused",true);sample.add("reusedFrom",match.provenance());sample.remove("errorCode");sample.remove("message");Store.update(c,"UPDATE samples SET status='succeeded',active_attempt=NULL,next_at=0,data=? WHERE id=?",sample,sampleId);run.addProperty("reused",Json.integer(run,"reused",0)+1);run.addProperty("updatedAt",Json.now());Store.update(c,"UPDATE runs SET data=? WHERE id=?",run,id);Store.event(c,"sample.succeeded",id,assetId,null,Json.obj("stage","completed","candidateVersion",version,"reused",true,"reusedFrom",match.provenance(),"manualProtected",protectedHuman));Store.event(c,"annotation.candidate",id,assetId,null,Json.obj("version",version,"reused",true,"reusedFrom",match.provenance(),"manualProtected",protectedHuman));return true;
        });
    }
    void releasePreparation(String runId,String sampleId,String attempt,long delay){store.tx(c->{String status=Json.required(Store.document(c,"runs",runId),"status").equals("cancelled")?"cancelled":"queued";Store.update(c,"UPDATE samples SET status=?,active_attempt=NULL,next_at=? WHERE id=? AND active_attempt=?",status,delay==0?0:System.currentTimeMillis()+delay,sampleId,attempt);return null;});}
    void pauseBudget(String id,String reason){store.tx(c->{JsonObject run=Store.document(c,"runs",id);if(!Json.str(run,"status","").equals("running"))return null;run.addProperty("status","paused");run.addProperty("pauseReason",reason);Store.update(c,"UPDATE runs SET status='paused',data=? WHERE id=?",run,id);Store.event(c,"run.paused",id,null,null,Json.obj("reason",reason,"requestsUsed",run.get("requestsUsed")));return null;});}
    /** 请求体与它实际用到的那张副本：坐标逆映射要靠同一份，不能在两处各算一次。 */
    record Outgoing(JsonArray messages,PayloadImages.Payload payload){}
    Outgoing messages(JsonObject run,JsonObject sample)throws Exception{
        JsonObject snapshot=Json.object(run,"snapshot"),project=Json.object(snapshot,"project"),asset=Json.object(sample,"asset");JsonArray content=new JsonArray();
        String schema="Return JSON only: {\"assetId\":\"TARGET_ID\",\"annotations\":[{\"id\":\"unique-id\",\"type\":\""+Json.required(project,"taskType")+"\",\"classId\":\"stable-class-id\",\"bbox\":{\"x\":0,\"y\":0,\"width\":10,\"height\":10},\"keypoints\":[],\"points\":[]}]}. Use baseline pixel coordinates. Omit fields not needed by the task. Empty annotations means no target found. Pose names/order must match template; visibility 0 unknown, 1 occluded but located, 2 visible. OBB bbox rotation is in degrees, or four true rectangle corners. Never return perspective quadrilaterals as OBB.";
        if(Json.bool(run,"inputResults",false))schema=schema.replace("Use baseline pixel coordinates.","Use pixel coordinates of the attached target input image. Do not map to its parent image.");JsonObject instruction=Json.obj("instructions",Json.required(run,"prompt"),"outputContract",schema);
        if(Json.str(snapshot,"requestContractVersion","").equals(TaskTemplates.REQUEST_CONTRACT_VERSION))instruction.add("template",TaskTemplates.semantic(project));
        else{instruction.add("taskType",project.get("taskType"));instruction.add("classes",project.get("classes"));instruction.add("keypointNames",Json.array(Json.object(project,"settings"),"keypointNames"));}
        content.add(Json.obj("type","text","text",instruction.toString()));
        long totalBytes=0;
        for(JsonElement e:Json.array(snapshot,"references")){JsonObject ref=e.getAsJsonObject();Path path=ref.has("resourceId")?new ResourceLibrary(store,projects).referencePath(ref):projects.path(Json.required(ref,"id"));totalBytes+=Files.size(path);if(totalBytes>32L*1024*1024)throw new ApiError(413,"model_images_too_large","本次图片合计超过 32 MiB，请减少参考或图片尺寸。");
            if(!ref.has("resourceId")&&!Media.hash(path).equals(Json.required(ref,"contentHash")))throw new ApiError(409,"reference_changed","参考图片内容已变化，请创建新运行。");content.add(Json.obj("type","text","text",Json.obj("role","reference","assetId",ref.get("id"),"width",ref.get("width"),"height",ref.get("height"),"annotations",ref.get("annotations"),"note",Json.str(ref,"note",""),"resourceId",ref.get("resourceId"),"resourceVersion",ref.get("resourceVersion")).toString()));content.add(image(path));}
        Path target=Path.of(Json.required(sample,"inputPath"));
        // 发送副本：按运行冻结的配方裁剪/缩放。原图直发时 path 就是基准图本身，行为与以前一致。
        PayloadImages.Payload payload=PayloadImages.prepare(target,PayloadImages.recipe(run),store.root.resolve("media").resolve("payload"));
        totalBytes+=payload.bytes();if(totalBytes>32L*1024*1024)throw new ApiError(413,"model_images_too_large","本次图片合计超过 32 MiB，请减少参考或调低发送尺寸。");
        if(!Media.hash(target).equals(Json.required(asset,"contentHash")))throw new ApiError(409,"media_content_changed","基准图片内容已变化，请重新导入。");
        // 声明的是**副本自己的**像素尺寸：模型按它返回坐标，引擎再逆映射回基准图（口径不一致会直接写出越界坐标）。
        content.add(Json.obj("type","text","text",Json.obj("role","target","assetId",asset.get("id"),"width",payload.width(),"height",payload.height()).toString()));content.add(image(payload.path()));
        return new Outgoing(Json.arr(Json.obj("role","user","content",content)),payload);
    }
    static JsonObject image(Path path)throws Exception{String name=path.getFileName().toString().toLowerCase(Locale.ROOT);
        String type=name.endsWith(".jpg")||name.endsWith(".jpeg")?"image/jpeg":"image/png";
        return Json.obj("type","image_url","image_url",Json.obj("url","data:"+type+";base64,"+Base64.getEncoder().encodeToString(Files.readAllBytes(path))));}
    void execute(JsonObject initialRun,JsonObject row,String attempt){String runId=Json.required(initialRun,"id"),sampleId=Json.required(row,"id"),assetId=Json.required(row,"asset_id");JsonObject sample=Json.parse(row.get("data").getAsString());boolean sent=false;JsonObject parsedInput=null;Providers.Permit acquired=null;InputResultReuse.Prepared inputPrepared=null;
        try{
            // 读图、请求规范化和历史校验在既有有界 worker 中完成，调度锁只负责 claim 与入队。
            JsonObject provider=Json.object(Json.object(initialRun,"snapshot"),"provider");Outgoing outgoing=messages(initialRun,sample);JsonObject body=providers.body(provider,Json.required(initialRun,"model"),outgoing.messages(),new JsonArray(),true);
            Providers.Credential credential;try{credential=providers.credentialFor(provider,Json.object(initialRun,"snapshot"));}catch(ApiError error){pauseBudget(runId,error.code);releasePreparation(runId,sampleId,attempt,0);return;}
            inputPrepared=inputReuse==null?null:inputReuse.api(initialRun,row,body,credential);if(inputPrepared!=null&&inputReuse.apply(inputPrepared,attempt))return;InputResultReuse.Prepared fixedInput=inputPrepared;ReuseRequest reuseRequest=prepareReuse(initialRun,row,body,credential);if(reuseRequest!=null&&applyReuse(initialRun,row,attempt,reuseRequest)){releasePreparation(runId,sampleId,attempt,0);return;}
            if(!dispatchAllowed()){releasePreparation(runId,sampleId,attempt,0);return;}
            String stop=store.read(c->{JsonObject current=Store.document(c,"runs",runId);if(!Json.required(current,"status").equals("running"))return "stopped";String scope=Json.str(current,"budgetScopeId",runId);if(Json.number(current,"requestsUsed",0)>=Json.number(current,"maxRequests",Long.MAX_VALUE)||Budgets.exhausted(c,scope))return "budget_exhausted";return Costs.blockReason(c,scope,Costs.snapshot(provider,Json.required(initialRun,"model")));});if(stop!=null){if(!stop.equals("stopped"))pauseBudget(runId,stop);releasePreparation(runId,sampleId,attempt,0);return;}
            Providers.Permit permit=providers.acquire(provider,credential);acquired=permit;if(permit==null){releasePreparation(runId,sampleId,attempt,200);return;}
            sent=store.tx(c->{JsonObject run=Store.document(c,"runs",runId);if(!Json.required(run,"status").equals("running")||closed||suspended||dataMaintenancePaused){Store.update(c,"UPDATE samples SET status=?,active_attempt=NULL WHERE id=? AND active_attempt=?",Json.required(run,"status").equals("cancelled")?"cancelled":"queued",sampleId,attempt);return false;}
                try{providers.credentialFor(provider,Json.object(run,"snapshot"));}catch(ApiError error){run.addProperty("status","paused");run.addProperty("pauseReason",error.code);Store.update(c,"UPDATE runs SET status='paused',data=? WHERE id=?",run,runId);Store.update(c,"UPDATE samples SET status='queued',active_attempt=NULL WHERE id=? AND active_attempt=?",sampleId,attempt);Store.event(c,"run.paused",runId,null,null,Json.obj("reason",error.code));return false;}
                String scope=Json.str(run,"budgetScopeId",runId);long used=Json.number(run,"requestsUsed",0);if(used>=Json.number(run,"maxRequests",Long.MAX_VALUE)||Budgets.exhausted(c,scope)){Store.update(c,"UPDATE samples SET status='queued',active_attempt=NULL WHERE id=?",sampleId);run.addProperty("status","paused");run.addProperty("pauseReason","budget_exhausted");Store.update(c,"UPDATE runs SET status='paused',data=? WHERE id=?",run,runId);Store.event(c,"run.paused",runId,null,null,Json.obj("reason","budget_exhausted"));return false;}
                String costReason=Costs.blockReason(c,scope,Costs.snapshot(provider,Json.required(initialRun,"model")));if(costReason!=null){Store.update(c,"UPDATE samples SET status='queued',active_attempt=NULL WHERE id=?",sampleId);run.addProperty("status","paused");run.addProperty("pauseReason",costReason);Store.update(c,"UPDATE runs SET status='paused',data=? WHERE id=?",run,runId);Store.event(c,"run.paused",runId,null,null,Json.obj("reason",costReason));return false;}
                store.requireSpace(0);Costs.reserve(c,scope,Costs.snapshot(provider,Json.required(initialRun,"model")));Budgets.reserve(c,scope);run.addProperty("requestsUsed",used+1);int count=Json.integer(row,"attempt_count",0);if(count>0)run.addProperty("retries",Json.number(run,"retries",0)+1);
                Store.update(c,"UPDATE runs SET data=? WHERE id=?",run,runId);JsonObject data=Json.obj("id",attempt,"runId",runId,"sampleId",sampleId,"assetId",assetId,"providerId",provider.get("id"),"model",initialRun.get("model"),"status","sent","sentAt",Json.now(),"usage",JsonNull.INSTANCE,"request",providers.redact(body,credential));
                if(fixedInput!=null)data.addProperty("inputReuseFingerprint",fixedInput.fingerprint());if(reuseRequest!=null)for(var field:reuseRequest.prepared.attemptFields().entrySet())data.add(field.getKey(),field.getValue());data.addProperty("budgetScopeId",scope);data.add("priceSnapshot",Costs.snapshot(provider,Json.required(initialRun,"model")));Costs.attach(data);
                // 记下这一张**实际发出去的是什么**：尺寸、体积与是否派生，任务详情据此核对，而不是靠猜。
                // 注意别覆盖 run.payload——那是冻结的配方，覆盖了同一运行后面的样本会退回原图发送。
                long sourceBytes=outgoing.payload().derived()?Files.size(Path.of(Json.required(sample,"inputPath"))):outgoing.payload().bytes();
                JsonObject payloadFacts=PayloadImages.facts(outgoing.payload(),sourceBytes);data.add("payload",payloadFacts);run.add("payloadActual",payloadFacts);Store.update(c,"UPDATE runs SET data=? WHERE id=?",run,runId);
                Store.update(c,"INSERT INTO attempts(id,run_id,sample_id,group_id,status,data) VALUES(?,?,?,?,?,?)",attempt,runId,sampleId,permit.group(),"sent",data);Store.update(c,"UPDATE samples SET status='waiting',attempt_count=attempt_count+1 WHERE id=? AND active_attempt=?",sampleId,attempt);
                Store.event(c,"sample.sending",runId,assetId,attempt,Json.obj("stage","sending","requestsUsed",used+1));Store.event(c,"sample.waiting",runId,assetId,attempt,Json.obj("stage","waiting"));return true;});
            if(!sent)return;
            Providers.Reply reply=providers.complete(provider,body,credential);
            store.tx(c->{JsonObject a=Json.parse(Store.one(c,"SELECT data FROM attempts WHERE id=?",attempt).get("data").getAsString());a.add("usage",reply.usage());Costs.attach(a);a.add("response",providers.redact(reply.raw(),credential));a.addProperty("receivedAt",Json.now());Store.update(c,"UPDATE attempts SET data=? WHERE id=?",a,attempt);Store.update(c,"UPDATE samples SET status='parsing' WHERE id=? AND active_attempt=?",sampleId,attempt);Store.event(c,"sample.parsing",runId,assetId,attempt,Json.obj("stage","parsing","usage",reply.usage()));return null;});JsonObject result;
            try{String content=reply.content().strip();if(content.startsWith("```")){content=content.replaceFirst("^```(?:json)?\\s*","").replaceFirst("\\s*```$","");}result=Json.parse(content);}catch(Exception e){throw new ApiError(422,"model_annotation_json_invalid","接口返回的不是标注结果，多为超时或网关错误页；已拒绝按标注解析，素材保持原状。");}
            parsedInput=result;if(!result.has("assetId")||!Json.required(result,"assetId").equals(RunInputs.inputId(sample)))throw new ApiError(422,"model_asset_mismatch","返回素材标识缺失或与本次请求不一致。");
            if(!result.has("annotations")||!result.get("annotations").isJsonArray())throw new ApiError(422,"model_annotations_missing","模型未返回 annotations 数组；不会将缺失结果视为无目标。");
            // 模型按发送副本的坐标返回；先逆映射回基准图再进校验。越界由既有几何校验明确报错，不静默截断。
            result.add("annotations",PayloadImages.mapBack(Json.array(result,"annotations"),outgoing.payload()));
            if(Json.bool(initialRun,"inputResults",false)){stage(runId,sampleId,assetId,attempt,"validating");JsonObject fixed=inputResults.result(initialRun,sample,"api",attempt,result,Json.obj("requestId",attempt,"providerId",provider.get("id"),"model",initialRun.get("model"),"responseRecordedInAttempt",true),null);InputResultReuse.attach(fixed,inputPrepared);if(inputResults.save(initialRun,sample,attempt,fixed))inputResults.aggregate(runId,assetId);return;}stage(runId,sampleId,assetId,attempt,"validating");JsonObject frozen=Json.object(Json.object(initialRun,"snapshot"),"project");JsonArray annotations=Annotations.validate(Json.array(result,"annotations"),Json.object(sample,"asset"),frozen);
            stage(runId,sampleId,assetId,attempt,"saving");
            store.tx(c->{JsonObject current=Store.one(c,"SELECT active_attempt,status FROM samples WHERE id=?",sampleId);if(current==null||!attempt.equals(Json.str(current,"active_attempt","")))return null;
                JsonObject asset=Store.document(c,"assets",assetId);int version=Projects.nextVersion(c,assetId);JsonObject candidate=Json.bool(initialRun,"evaluationOnly",false)?Json.object(sample,"asset").deepCopy():asset.deepCopy();candidate.add("annotations",annotations);candidate.addProperty("version",version);candidate.addProperty("status","candidate");candidate.addProperty("source","api");candidate.addProperty("runId",runId);candidate.addProperty("attemptId",attempt);
                candidate.remove("reused");candidate.remove("reusedFrom");candidate.remove("reuse");JsonObject candidateMetadata=Json.object(candidate,"metadata");candidateMetadata.remove("reuse");candidateMetadata.add("annotationTemplate",TaskTemplates.snapshot(frozen));candidate.add("metadata",candidateMetadata);
                Store.update(c,"INSERT OR IGNORE INTO versions(asset_id,version,source,data,attempt_id,created_at) VALUES(?,?,?,?,?,?)",assetId,version,"api",candidate,attempt,Json.now());
                boolean currentTemplateCompatible=true;try{JsonObject currentProject=Store.document(c,"projects",Json.required(asset,"projectId"));Annotations.validate(annotations,asset,currentProject);currentTemplateCompatible=TaskTemplates.semantic(currentProject).equals(TaskTemplates.semantic(frozen));}catch(ApiError e){currentTemplateCompatible=false;}
                boolean cancelled=Json.str(Store.document(c,"runs",runId),"status","").equals("cancelled");
                boolean protectedHuman=cancelled||Json.bool(initialRun,"evaluationOnly",false)||!currentTemplateCompatible||Set.of("modified","confirmed").contains(Json.str(asset,"status",""))||Json.integer(asset,"version",0)!=Json.integer(sample,"baseVersion",0)||Store.one(c,"SELECT asset_id FROM drafts WHERE asset_id=?",assetId)!=null;
                // 新候选始终保留独立版本；人工版本、草稿及其他已更新版本不被异步返回覆盖。
                if(!protectedHuman)Store.update(c,"UPDATE assets SET data=? WHERE id=?",candidate,assetId);
                sample.addProperty("candidateVersion",version);sample.addProperty("completedAt",Json.now());sample.remove("errorCode");sample.remove("message");if(cancelled)sample.addProperty("lateResult",true);Store.update(c,"UPDATE samples SET status=?,data=? WHERE id=?",cancelled?"cancelled":"succeeded",sample,sampleId);
                JsonObject a=Json.parse(Store.one(c,"SELECT data FROM attempts WHERE id=?",attempt).get("data").getAsString());a.addProperty("status","completed");a.addProperty("completedAt",Json.now());a.add("usage",reply.usage());a.add("response",providers.redact(reply.raw(),credential));Store.update(c,"UPDATE attempts SET status='completed',data=? WHERE id=?",a,attempt);
                Store.event(c,cancelled?"sample.cancelled":"sample.succeeded",runId,assetId,attempt,Json.obj("stage",cancelled?"cancelled":"completed","candidateVersion",version,"manualProtected",protectedHuman,"currentTemplateCompatible",currentTemplateCompatible,"lateResult",cancelled,"usage",reply.usage()));Store.event(c,"annotation.candidate",runId,assetId,attempt,Json.obj("version",version,"manualProtected",protectedHuman,"lateResult",cancelled));return null;});
        }catch(Exception e){try{if(!sent&&e instanceof ApiError auth&&Set.of("credential_missing","credential_binding_changed").contains(auth.code)){pauseBudget(runId,auth.code);releasePreparation(runId,sampleId,attempt,0);return;}fail(initialRun,row,sample,attempt,sent,e);if(Json.bool(initialRun,"inputResults",false))inputResults.apiFailure(initialRun,sample,attempt,sent,parsedInput,e);}catch(Exception storage){pauseStorage("result_not_saved:"+(storage instanceof ApiError a?a.code:storage.getClass().getSimpleName()));}}
        finally{providers.release(acquired);try{settle(runId);}catch(Exception e){pauseStorage("settle_failed");}}
    }
    void stage(String run,String sample,String asset,String attempt,String stage){store.tx(c->{int changed=Store.update(c,"UPDATE samples SET status=? WHERE id=? AND active_attempt=?",stage,sample,attempt);if(changed==1)Store.event(c,"sample."+stage,run,asset,attempt,Json.obj("stage",stage));return null;});}
    void fail(JsonObject initialRun,JsonObject row,JsonObject sample,String attempt,boolean sent,Exception error){
        String runId=Json.required(initialRun,"id"),sampleId=Json.required(row,"id"),assetId=Json.required(row,"asset_id");boolean unknown=error instanceof Providers.RemoteError r&&r.unknown;boolean retryable=error instanceof Providers.RemoteError r&&r.retryable;
        String code=error instanceof Providers.RemoteError r?r.code:error instanceof ApiError a?a.code:"input_or_result_failed";String message=error instanceof Providers.RemoteError r?r.getMessage():error instanceof ApiError a?a.getMessage():"素材读取或结果处理失败。";
        if(error instanceof ApiError a&&a.code.startsWith("storage_")){pauseStorage(a.code);return;}
        int count=Json.integer(row,"attempt_count",0)+(sent?1:0);long wait=error instanceof Providers.RemoteError r?r.retryAfter:0;
        long next=System.currentTimeMillis()+Math.max(wait,Math.min(60000,1000L*(1L<<Math.min(count,6)))+ThreadLocalRandom.current().nextLong(250));
        store.tx(c->{JsonObject current=Store.one(c,"SELECT active_attempt FROM samples WHERE id=?",sampleId);if(current==null||!attempt.equals(Json.str(current,"active_attempt","")))return null;JsonObject run=Store.document(c,"runs",runId);
            boolean cancelled=Json.str(run,"status","").equals("cancelled");boolean retry=retryable&&count<=Json.integer(run,"maxRetries",2)&&!cancelled;String status=cancelled?"cancelled":unknown?"unknown":retry?"retry_wait":"failed";
            sample.addProperty("errorCode",code);sample.addProperty("message",message);Store.update(c,"UPDATE samples SET status=?,next_at=?,data=? WHERE id=?",status,retry?next:0,sample,sampleId);
            if(sent){JsonObject a=Json.parse(Store.one(c,"SELECT data FROM attempts WHERE id=?",attempt).get("data").getAsString());a.addProperty("status",unknown?"unknown":"failed");a.addProperty("errorCode",code);a.addProperty("completedAt",Json.now());if(error instanceof Providers.RemoteError remote&&!remote.usage.isJsonNull())a.add("usage",remote.usage);Costs.attach(a);Store.update(c,"UPDATE attempts SET status=?,data=? WHERE id=?",unknown?"unknown":"failed",a,attempt);}
            if(!cancelled&&!retry&&Json.str(run,"failurePolicy","").equals("pause")){run.addProperty("status","paused");run.addProperty("pauseReason",unknown?"result_unknown":"sample_failed");Store.update(c,"UPDATE runs SET status='paused',data=? WHERE id=?",run,runId);}
            Store.event(c,"sample."+status,runId,assetId,attempt,Json.obj("stage",status,"code",code,"message",message,"nextAttemptAt",retry?next:null));return null;});
    }
    void settle(String id){store.tx(c->{JsonObject run=Store.document(c,"runs",id);if(!Json.str(run,"status","").equals("running"))return null;JsonObject stats=Json.object(view(c,id,false),"statistics");long pending=0;for(String key:List.of("queued","preparing","sending","waiting","parsing","validating","saving","retry_wait"))pending+=Json.number(stats,key,0);
        if(pending==0){if(Json.bool(run,"inputResults",false)&&!RunResults.aggregated(c,id))return null;String status=Json.number(stats,"unknown",0)>0?"needs_attention":(Json.number(stats,"failed",0)>0||Store.one(c,"SELECT r.id FROM run_asset_results r WHERE r.run_id=? AND r.status='needs_attention' AND r.rowid=(SELECT MAX(x.rowid) FROM run_asset_results x WHERE x.run_id=r.run_id AND x.asset_id=r.asset_id) LIMIT 1",id)!=null)?"completed_with_errors":"completed";run.addProperty("status",status);run.addProperty("completedAt",Json.now());Store.update(c,"UPDATE runs SET status=?,data=? WHERE id=?",status,run,id);Store.event(c,"run."+status,id,null,null,Json.obj("statistics",stats));}return null;});}
    JsonArray attempts(JsonObject p){String id=Json.required(p,"runId");return store.read(c->Store.docs(c,"SELECT data FROM attempts WHERE run_id=? ORDER BY rowid DESC LIMIT 200",id));}
    /**
     * 休眠只停止新的分派，不撤销在途请求；唤醒后核对持久化状态并保持用户暂停/预算不足/结果未知原状。
     * 唤醒不自动重发任何结果未知的调用，休眠时长与处理耗时分开记录。
     */
    JsonObject suspend(boolean value){
        if(value)suspendedAt=System.currentTimeMillis();
        suspended=value;
        JsonObject report=store.tx(c->{JsonObject detail=value?suspendSnapshot(c):resumeSnapshot(c);Store.event(c,value?"engine.suspended":"engine.resumed",null,null,null,detail.deepCopy());return detail;});
        if(!value)suspendedAt=0;
        return report;
    }
    private JsonObject suspendSnapshot(Connection c)throws Exception{
        return Json.obj("suspended",true,"stoppedAt",Json.now(),"stopsNewDispatch",true,
            "subsystems",Json.arr("api_runs","local_runs","media_jobs","track_generations"),
            "inFlightRequests",inFlightCount(c),"unknownResultsNotRetried",true,
            "note","休眠只暂停新的分派。在途请求结果按持久化状态处理，唤醒后不会自动重发结果未知的调用。");
    }
    private JsonObject resumeSnapshot(Connection c)throws Exception{
        long elapsed=suspendedAt<=0?0:Math.max(0,System.currentTimeMillis()-suspendedAt);
        return Json.obj("suspended",false,"resumedAt",Json.now(),"suspendedMs",elapsed,
            "checks",Json.obj("database","ok","eventSequence",Store.cursor(c),"inFlightRequests",inFlightCount(c),
                "unknownResults",count(c,"samples","status='unknown'"),"pausedRuns",count(c,"runs","status='paused'"),
                "interruptedTrackGenerations",count(c,"track_generations","status='interrupted'"),
                "interruptedMediaJobs",count(c,"media_jobs","status='interrupted'")),
            "autoResumedPausedRuns",false,"autoResentUnknownRequests",false,
            "note","唤醒只恢复分派。用户暂停、预算不足和结果未知的任务保持原状态，等待用户处理。");
    }
    private long inFlightCount(Connection c)throws Exception{return count(c,"samples","status IN ('preparing','sending','waiting','parsing','validating','saving')");}
    private long count(Connection c,String table,String condition)throws Exception{return Json.number(Store.one(c,"SELECT COUNT(*) AS n FROM "+table+" WHERE "+condition),"n",0);}
    void dataMaintenance(boolean value){synchronized(dispatchGate){dataMaintenancePaused=value;}}
    JsonObject diagnostics(){return Json.obj("globalConcurrency",globalLimit,"activeWorkers",requests.getActiveCount(),"queuedInMemory",requests.getQueue().size(),"queueCapacity",globalLimit,"suspended",suspended,"dataMaintenancePaused",dataMaintenancePaused,"storagePaused",storagePaused||store.writeFailed,"providerGroups",providers.limits());}
    @Override public void close(){closed=true;dispatcher.shutdownNow();requests.shutdownNow();try{requests.awaitTermination(5,TimeUnit.SECONDS);}catch(InterruptedException e){Thread.currentThread().interrupt();}}
}
