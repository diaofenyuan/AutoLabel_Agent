package cn.autolabel.engine;

import com.google.gson.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;

/**
 * 训练任务：预检、队列、状态机、逐轮事件与产物登记。
 *
 * 进度只来自 worker 的真实 epoch 回调，不合成百分比；未知总量时只报已完成的轮次与耗时。
 * 训练进程没有固定总超时，存活由「停滞判定」把关，且只提示不杀进程。
 * 任务重启后一律置为 interrupted 且不自动重跑，避免用户拿到来源不明的结果。
 */
final class TrainingJobs implements AutoCloseable {
    private static final int MAX_LIST=100;
    private static final long STALL_MS=30L*60*1000L,CANCEL_GRACE_MS=60_000L;
    private static final Set<String> QUEUEABLE=Set.of("queued","preparing","running");
    private static final Set<String> TERMINAL_STAGES=Set.of("finished","failed","cancelled");

    private final Store store;private final TrainingDatasets datasets;private final LocalModels models;
    private final LocalRuntime localRuntime;private final TrainingRuntime runtime;private final int concurrency;
    // 进度保留策略（天）：0 表示永久保留逐轮指标。
    private final int retentionDays;
    private final Map<String,Active> active=new LinkedHashMap<>();
    private volatile boolean closed;

    /** 一个正在执行（或正在启动）的任务：进程、终止信号与取消状态。 */
    private static final class Active {
        final String jobId;final CompletableFuture<String> terminal=new CompletableFuture<>();
        volatile TrainingProcess process;volatile JsonObject terminalEvent;
        volatile boolean cancelRequested,stalled;volatile long cancelAt;
        Active(String jobId){this.jobId=jobId;}
    }

    TrainingJobs(Store store,TrainingDatasets datasets,LocalModels models,LocalRuntime localRuntime,TrainingRuntime runtime)throws Exception{
        this.store=store;this.datasets=datasets;this.models=models;this.localRuntime=localRuntime;this.runtime=runtime;
        concurrency=store.read(c->{JsonObject row=Store.one(c,"SELECT data FROM settings WHERE id='global'");
            return row==null?1:Json.bounded(Json.parse(row.get("data").getAsString()),"trainingConcurrency",1,1,2);});
        // 引擎重启：运行中的任务置为 interrupted，保留已写入的逐轮指标，绝不自动重跑。
        store.tx(c->{
            for(JsonObject row:Store.rows(c,"SELECT id,data FROM training_jobs WHERE status IN ('queued','preparing','running')")){
                String id=Json.required(row,"id");JsonObject data=Json.parse(Json.required(row,"data"));
                data.addProperty("status","interrupted");data.addProperty("stage","interrupted");data.addProperty("updatedAt",Json.now());
                data.addProperty("message","引擎重启时该任务仍在执行，已标记为中断；已产出的轮次指标与权重保留，需要时请手动重试。");
                data.add("error",Json.obj("code","training_interrupted","message","引擎重启导致训练中断，未自动重跑。"));
                Store.update(c,"UPDATE training_jobs SET status='interrupted',updated_at=?,data=? WHERE id=?",Json.now(),data,id);
                Store.event(c,"training.job.interrupted",null,null,null,Json.obj("jobId",id));
            }
            return null;
        });
        retentionDays=store.read(c->{JsonObject row=Store.one(c,"SELECT data FROM settings WHERE id='global'");
            return row==null?0:Json.bounded(Json.parse(row.get("data").getAsString()),"trainingRetentionDays",0,0,3650);});
        pruneMetrics();
    }

    /**
     * 进度保留策略：按天清理已结束任务的逐轮指标（数据库记录），产物、日志与结果文件一律保留。
     * 0 表示永久保留；被清理的任务在记录里留下 metricsPrunedAt，界面据此说明而不是显示成空曲线。
     */
    private void pruneMetrics(){
        if(retentionDays<=0)return;
        String cutoff=java.time.Instant.now().minus(retentionDays,java.time.temporal.ChronoUnit.DAYS).toString();
        List<String> expired=store.read(c->{
            List<String> ids=new ArrayList<>();
            for(JsonObject row:Store.rows(c,"SELECT id,updated_at,data FROM training_jobs WHERE status NOT IN ('queued','preparing','running') AND updated_at< ?",cutoff)){
                JsonObject data=Json.parse(Json.required(row,"data"));
                if(data.has("metricsPrunedAt"))continue;
                ids.add(Json.required(row,"id"));
            }
            return ids;
        });
        if(expired.isEmpty())return;
        String prunedAt=Json.now();
        store.tx(c->{
            for(String id:expired){
                Store.update(c,"DELETE FROM training_epochs WHERE job_id=?",id);
                JsonObject record=Json.parse(Json.required(Store.one(c,"SELECT data FROM training_jobs WHERE id=?",id),"data"));
                record.addProperty("metricsPrunedAt",prunedAt);record.addProperty("metricsRetentionDays",retentionDays);
                Store.update(c,"UPDATE training_jobs SET data=? WHERE id=?",record,id);
            }
            return null;
        });
    }

    // ===== 预检 =====

    JsonObject preflight(JsonObject p)throws Exception{
        FlowPlans.keys(p,"datasetId","parameters");
        JsonObject parameters=TrainingParameters.parse(p.has("parameters")?Json.object(p,"parameters"):null);
        JsonObject data=datasets.load(identifier(p,"datasetId",128)).data();
        JsonObject summary=Json.object(Json.object(data,"inspection"),"summary");
        JsonArray issues=new JsonArray(),classNames=classNames(data);
        String taskType=Json.required(data,"taskType");
        if(!Json.bool(summary,"usable",false))issue(issues,"error","training_dataset_invalid","数据集存在未修复的阻断问题，请先重新创建快照。");
        // 从零训练合法，但极小数据集上的指标不可用必须显式提示。
        if(!parameters.has("baseModel")||parameters.get("baseModel").isJsonNull())
            issue(issues,"warning","training_base_model_absent","未指定基础权重将从零开始训练；极小数据集上的指标不可用。");
        else verifyBaseModel(parameters,data,taskType,classNames,issues);
        JsonObject environment=resolveEnvironment(parameters,issues);
        JsonObject estimates=Json.obj("datasetBytes",Json.number(data,"bytes",0),"images",Json.number(summary,"images",0),
            "objects",Json.number(summary,"objects",0),"epochs",Json.integer(parameters,"epochs",0),
            "estimatedPeakBytes",Json.number(summary,"bytes",0)+2L*1024*1024*1024);
        try{store.requireSpace(Json.number(estimates,"estimatedPeakBytes",0));}
        catch(ApiError failure){
            if(!"disk_space_low".equals(failure.code))throw failure;
            issue(issues,"error","disk_space_low",failure.getMessage());
        }
        JsonObject resolved=TrainingParameters.summary(parameters,environment);
        resolved.add("classNames",classNames.deepCopy());
        resolved.add("keypointNames",Json.array(data,"keypointNames").deepCopy());
        resolved.addProperty("snapshotHash",Json.required(data,"snapshotHash"));
        return Json.obj("ok",!hasError(issues),"issues",issues,"estimates",estimates,"resolvedParameters",resolved);
    }

    private void verifyBaseModel(JsonObject parameters,JsonObject data,String taskType,JsonArray classNames,JsonArray issues)throws Exception{
        JsonObject base=Json.object(parameters,"baseModel"),model;
        try{
            model=models.snapshot(Json.required(base,"modelId"),base.has("modelVersion")?base.get("modelVersion").getAsInt():null);
            // 基础权重必须在当前数据作用域内已授权，且文件哈希与登记一致；严禁自动下载。
            localRuntime.requireAuthorized(model);
        }catch(ApiError failure){
            if(failure.status>=500)throw failure;
            issue(issues,"error",failure.code,failure.getMessage());
            return;
        }
        if(!Json.required(model,"taskType").equals(taskType)){issue(issues,"error","training_task_mismatch","基础权重任务类型与数据集任务类型不一致。");return;}
        JsonArray modelClasses=Json.array(model,"classNames");
        if(modelClasses.isEmpty()){
            // 早期登记的权重没有类别表，不能凭猜测判定一致；训练启动时由 worker 再核对一次。
            issue(issues,"warning","training_base_model_classes_unknown","该权重未登记类别表，类别一致性将在训练启动时核对。");
            return;
        }
        if(modelClasses.size()!=classNames.size()){
            // 类别不一致时不做隐式映射，避免静默把目标丢成背景。
            issue(issues,"error","training_class_map_required","基础权重的类别数与数据集不一致，请选择类别匹配的权重或显式配置类别映射。");
            return;
        }
        for(int index=0;index<modelClasses.size();index++){
            String expected=classNames.get(index).getAsString(),actual=modelClasses.get(index).getAsString();
            if(!expected.equals(actual)){issue(issues,"error","training_class_map_required","基础权重的类别名称与数据集不一致："+actual+" → "+expected);return;}
        }
    }

    /** 设备解析：gpu-auto 允许在启动前回退且如实记录；显式指定 GPU 时直接拒绝。 */
    private JsonObject resolveEnvironment(JsonObject parameters,JsonArray issues)throws Exception{
        JsonObject state=runtime.requireEnvironment(),resolved=TrainingRuntime.resolveDevice(state,Json.required(parameters,"device"));
        boolean automatic=Json.str(parameters,"batch","").equals("auto");
        if(automatic&&Json.str(resolved,"device","cpu").equals("cpu"))
            issue(issues,"error","training_batch_auto_requires_gpu","批次大小 auto 需要 GPU，请改为固定批次或改用 GPU 设备。");
        if(resolved.has("fallback"))
            issue(issues,"warning","training_device_fallback","已从 gpu-auto 回退到 cpu："+Json.required(Json.object(resolved,"fallback"),"reason"));
        if(Json.number(parameters,"valPeriod",1)>1&&!Json.bool(Json.object(state,"capabilities"),"valPeriod",false))
            issue(issues,"warning","training_val_period_unsupported","当前 Ultralytics 版本不支持按轮次间隔验证，将每轮都验证。");
        for(String device:runtime.claimed())if(device.equals(Json.str(resolved,"device","")))
            issue(issues,"warning","training_device_busy","设备 "+device+" 正被其他训练任务占用，提交后将排队等待。");
        JsonObject result=resolved.deepCopy();
        for(String field:List.of("cudaAvailable","pythonVersion","ultralyticsVersion","torchVersion","workerHash")){
            if(state.has(field))result.add(field,state.get(field).deepCopy());
        }
        return result;
    }

    // ===== 建任务 =====

    JsonObject create(JsonObject p)throws Exception{
        FlowPlans.keys(p,"datasetId","parameters","confirm");
        if(closed)throw error(503,"training_closed","训练模块已停止。");
        if(!Json.bool(p,"confirm",false))throw error(400,"training_confirmation_required","提交训练前必须明确确认数据集与参数。");
        String datasetId=identifier(p,"datasetId",128);
        JsonObject requested=Json.obj("datasetId",datasetId);
        if(p.has("parameters"))requested.add("parameters",Json.object(p,"parameters").deepCopy());
        JsonObject report=preflight(requested);
        if(!Json.bool(report,"ok",false))throw error(422,"training_preflight_failed","训练预检未通过，请先修复阻断问题再提交。");
        JsonObject resolved=Json.object(report,"resolvedParameters");
        JsonObject parameters=TrainingParameters.parse(p.has("parameters")?Json.object(p,"parameters"):null);
        TrainingDatasets.Snapshot snapshot=datasets.load(datasetId);
        JsonObject data=snapshot.data();
        String device=Json.required(resolved,"actualDevice");
        // 设备被推理占用时直接拒绝：训练与推理互斥，不排队也不共享显存。
        if(localRuntime.deviceBusy(device))throw error(409,"device_busy","设备 "+device+" 正被本地推理占用，请等待其结束后再提交训练。");
        String jobId=Json.id(),now=Json.now(),taskType=Json.required(data,"taskType");
        JsonObject job=Json.obj("id",jobId,"datasetId",datasetId,"projectId",data.has("projectId")?data.get("projectId"):JsonNull.INSTANCE,"taskType",taskType,
            "status","queued","stage","queued","device",device,"createdAt",now,"updatedAt",now,
            // 产物目录随任务固定：之后更换默认产物目录，历史任务的权重、日志与指标仍可读取。
            "artifactsDir",newJobDirectory(jobId).toString(),
            "snapshotHash",Json.required(data,"snapshotHash"),"classNames",classNames(data).deepCopy(),"keypointNames",Json.array(data,"keypointNames").deepCopy(),
            "parameters",parameters.deepCopy(),"requestedDevice",Json.required(resolved,"requestedDevice"),"actualDevice",device,
            "fallback",resolved.has("fallback")?resolved.get("fallback").deepCopy():JsonNull.INSTANCE,
            "environment",environmentSnapshot(resolved,resolved),"parametersHash",hashText(parameters.toString()),"message","已进入队列，等待执行。");
        store.tx(c->{
            Store.update(c,"INSERT INTO training_jobs(id,dataset_id,project_id,status,device,created_at,updated_at,data) VALUES(?,?,?,?,?,?,?,?)",
                jobId,datasetId,Json.str(data,"projectId",null),"queued",device,now,now,job);
            Store.event(c,"training.job.created",null,null,null,Json.obj("jobId",jobId,"datasetId",datasetId,"device",device,"queued",true));
            return null;
        });
        dispatch();
        return get(Json.obj("jobId",jobId));
    }

    JsonObject list(JsonObject p){
        FlowPlans.keys(p,"projectId","status","offset","limit");
        if(p.has("projectId"))FlowPlans.string(p,"projectId",128);
        String status=p.has("status")?FlowPlans.string(p,"status",32):null;
        int limit=Json.bounded(p,"limit",MAX_LIST,1,MAX_LIST),offset=Json.bounded(p,"offset",0,0,Integer.MAX_VALUE);
        return store.read(c->{
            String condition="1=1";List<Object> args=new ArrayList<>();
            if(p.has("projectId")){condition+=" AND project_id=?";args.add(Json.required(p,"projectId"));}
            if(status!=null){condition+=" AND status=?";args.add(status);}
            long total=Json.number(Store.one(c,"SELECT COUNT(*) AS n FROM training_jobs WHERE "+condition,args.toArray()),"n",0);
            args.add(limit);args.add(offset);JsonArray items=new JsonArray();
            for(JsonObject row:Store.rows(c,"SELECT data FROM training_jobs WHERE "+condition+" ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?",args.toArray()))
                items.add(view(Json.parse(row.get("data").getAsString())));
            return Json.obj("items",items,"total",total,"offset",offset,"limit",limit,"concurrency",concurrency);
        });
    }

    JsonObject get(JsonObject p){
        FlowPlans.keys(p,"jobId");
        String jobId=identifier(p,"jobId",128);
        return view(store.read(c->Store.document(c,"training_jobs",jobId)));
    }

    JsonObject metrics(JsonObject p){
        FlowPlans.keys(p,"jobId","offset","limit");
        String jobId=identifier(p,"jobId",128);
        int limit=Json.bounded(p,"limit",500,1,2000),offset=Json.bounded(p,"offset",0,0,Integer.MAX_VALUE);
        return store.read(c->{
            long total=Json.number(Store.one(c,"SELECT COUNT(*) AS n FROM training_epochs WHERE job_id=?",jobId),"n",0);
            JsonArray items=Store.docs(c,"SELECT data FROM training_epochs WHERE job_id=? ORDER BY epoch LIMIT ? OFFSET ?",jobId,limit,offset);
            return Json.obj("items",items,"total",total,"offset",offset,"limit",limit);
        });
    }

    JsonObject log(JsonObject p)throws Exception{
        FlowPlans.keys(p,"jobId","maxBytes");
        String jobId=identifier(p,"jobId",128);
        int max=Json.bounded(p,"maxBytes",64*1024,1,256*1024);
        Path file=jobDirectory(jobId).resolve("train.log");
        if(!Files.isRegularFile(file))return Json.obj("jobId",jobId,"available",false,"log","","truncated",false);
        long size=Files.size(file);
        byte[] bytes;
        try(var channel=Files.newByteChannel(file,StandardOpenOption.READ)){
            int length=(int)Math.min(size,max);long from=Math.max(0,size-length);
            channel.position(from);java.nio.ByteBuffer buffer=java.nio.ByteBuffer.allocate(length);
            while(buffer.hasRemaining()&&channel.read(buffer)>0){}
            buffer.flip();bytes=new byte[buffer.remaining()];buffer.get(bytes);
        }
        // 日志可能包含本机路径：这里只返回内容本身，由界面标注为原始日志尾部。
        return Json.obj("jobId",jobId,"available",true,"log",new String(bytes,StandardCharsets.UTF_8),"truncated",size>max,"bytes",size);
    }

    // ===== 取消 / 重试 / 删除 =====

    JsonObject cancel(JsonObject p)throws Exception{
        FlowPlans.keys(p,"jobId","graceful");
        String jobId=identifier(p,"jobId",128);
        Active holder;
        synchronized(this){
            holder=active.get(jobId);
            if(holder==null){
                JsonObject record=store.read(c->Store.document(c,"training_jobs",jobId));
                String status=Json.required(record,"status");
                if(!QUEUEABLE.contains(status))throw error(409,"training_not_active","该任务已经结束，无需取消。");
                // 尚未启动的排队任务直接以取消收尾，不产生任何进程。
                settle(jobId,"cancelled","已取消排队中的任务，未开始训练。",null);
                return get(Json.obj("jobId",jobId));
            }
            holder.cancelRequested=true;holder.cancelAt=System.currentTimeMillis();
        }
        store.tx(c->{
            JsonObject record=Store.document(c,"training_jobs",jobId);
            JsonObject data=record;
            data.addProperty("cancelRequested",true);data.addProperty("message","已请求取消：当前轮次结束后停止并保留已产出的权重。");data.addProperty("updatedAt",Json.now());
            Store.update(c,"UPDATE training_jobs SET updated_at=?,data=? WHERE id=?",Json.now(),data,jobId);
            Store.event(c,"training.job.cancelling",null,null,null,Json.obj("jobId",jobId,"graceful",!p.has("graceful")||Json.bool(p,"graceful",true)));
            return null;
        });
        TrainingProcess process=holder.process;
        if(process!=null&&process.running())try{process.request("cancel",new JsonObject(),10000);}catch(ApiError ignored){/* 进程已退出时由退出通知收尾 */}
        return get(Json.obj("jobId",jobId));
    }

    JsonObject retry(JsonObject p)throws Exception{
        FlowPlans.keys(p,"jobId","parameters");
        String jobId=identifier(p,"jobId",128);
        JsonObject record=store.read(c->Store.document(c,"training_jobs",jobId));
        String status=Json.required(record,"status");
        if(QUEUEABLE.contains(status))throw error(409,"training_active","运行中的任务不能重试，请先取消后再重试。");
        JsonObject data=record;
        JsonObject parameters=p.has("parameters")?Json.object(p,"parameters").deepCopy():Json.object(data,"parameters").deepCopy();
        // 重试一律生成新任务记录，不在同一记录内改写状态历史。
        return create(Json.obj("datasetId",Json.required(record,"datasetId"),"parameters",parameters,"confirm",true));
    }

    JsonObject delete(JsonObject p)throws Exception{
        FlowPlans.keys(p,"jobId","confirm");
        if(!Json.bool(p,"confirm",false))throw error(400,"training_confirmation_required","删除训练任务前必须明确确认。");
        String jobId=identifier(p,"jobId",128);
        synchronized(this){
            if(active.containsKey(jobId))throw error(409,"training_active","运行中的任务不能删除，请先取消。");
        }
        JsonObject record=store.read(c->Store.document(c,"training_jobs",jobId));
        // 目录必须在删除记录前按记录解析：记录删掉后就只剩当前产物根可用。
        Path directory=jobDirectory(record);
        JsonObject data=record;
        for(JsonElement element:Json.array(data,"artifacts")){
            JsonObject artifact=element.getAsJsonObject();String hash=Json.str(artifact,"hash",null);if(hash==null)continue;
            // 已被登记为本地模型的产物不能随任务一起删掉，否则推理链路会指向缺失文件。
            long referenced=store.read(c->Json.number(Store.one(c,"SELECT COUNT(*) AS n FROM resources WHERE kind='local_model' AND json_extract(data,'$.content.modelHash')=?",hash),"n",0));
            if(referenced>0)throw error(409,"training_artifact_referenced","该任务的产物已登记为本地模型，请先删除对应本地模型再删除任务。");
        }
        store.tx(c->{
            Store.update(c,"DELETE FROM training_epochs WHERE job_id=?",jobId);
            Store.update(c,"DELETE FROM training_artifacts WHERE job_id=?",jobId);
            Store.update(c,"DELETE FROM training_jobs WHERE id=?",jobId);
            Store.event(c,"training.job.deleted",null,null,null,Json.obj("jobId",jobId));
            return null;
        });
        deleteDirectory(directory);
        return Json.obj("deleted",true,"jobId",jobId);
    }

    // ===== 产物（受管路径仅供桌面主进程使用） =====

    JsonObject artifact(JsonObject p)throws Exception{
        FlowPlans.keys(p,"jobId","kind");
        String jobId=identifier(p,"jobId",128),kind=FlowPlans.string(p,"kind",32);
        JsonObject record=store.read(c->Store.document(c,"training_jobs",jobId));
        JsonObject data=record,found=null;
        for(JsonElement element:Json.array(data,"artifacts")){
            JsonObject artifact=element.getAsJsonObject();if(kind.equals(Json.str(artifact,"kind","")))found=artifact;
        }
        if(found==null)throw error(404,"training_artifact_missing","该训练任务没有可用的"+kind+"产物。");
        Path path=managedPath(jobId,Json.required(found,"name"));
        if(!Files.isRegularFile(path))throw error(404,"training_artifact_missing","训练产物文件已不存在。");
        String hash=Media.hash(path);
        if(!hash.equals(Json.required(found,"hash")))throw error(409,"training_artifact_changed","训练产物与登记哈希不一致。");
        JsonObject result=Json.obj("jobId",jobId,"kind",kind,"path",path.toString(),"hash",hash,"size",Files.size(path),
            "name",Json.required(found,"name"),"taskType",Json.required(data,"taskType"),"classNames",Json.array(data,"classNames").deepCopy());
        return result;
    }

    // ===== 产物目录（默认在数据目录内，可配置到外部磁盘） =====

    /** 产物目录状态：默认位置、实际生效位置、回退原因与占用，供设置页如实显示。 */
    JsonObject rootStatus(){
        Path fallback=store.root.resolve("training");
        JsonObject result=Json.obj("defaultPath",fallback.toString(),"actualPath",store.trainingRoot.toString(),
            "custom",!store.trainingRoot.equals(fallback),"retentionDays",retentionDays);
        if(store.trainingRootIssue!=null)result.addProperty("fallbackReason",store.trainingRootIssue);
        long jobCount=store.read(c->Json.number(Store.one(c,"SELECT COUNT(*) AS n FROM training_jobs"),"n",0));
        long datasetCount=store.read(c->Json.number(Store.one(c,"SELECT COUNT(*) AS n FROM training_datasets"),"n",0));
        long unpinned=store.read(c->{
            long missing=Json.number(Store.one(c,"SELECT COUNT(*) AS n FROM training_jobs WHERE json_extract(data,'$.artifactsDir') IS NULL"),"n",0);
            return missing+Json.number(Store.one(c,"SELECT COUNT(*) AS n FROM training_datasets WHERE json_extract(data,'$.snapshotDir') IS NULL"),"n",0);
        });
        result.addProperty("jobs",jobCount);result.addProperty("datasets",datasetCount);result.addProperty("unpinned",unpinned);
        long[] usage=usage(store.trainingRoot);
        result.addProperty("bytes",usage[0]);result.addProperty("files",usage[1]);
        return result;
    }

    /** 把已有任务与数据集固定在当前产物根；切换默认产物目录前调用，返回固定的记录数。 */
    JsonObject pinRoot(){
        List<String[]> updates=new ArrayList<>();
        store.read(c->{
            for(JsonObject row:Store.rows(c,"SELECT id,data FROM training_jobs")){
                JsonObject data=Json.parse(Json.required(row,"data"));
                if(data.has("artifactsDir"))continue;
                updates.add(new String[]{Json.required(row,"id"),newJobDirectory(Json.required(row,"id")).toString()});
            }
            return null;
        });
        if(!updates.isEmpty())store.tx(c->{
            for(String[] update:updates){
                JsonObject record=Json.parse(Json.required(Store.one(c,"SELECT data FROM training_jobs WHERE id=?",update[0]),"data"));
                record.addProperty("artifactsDir",update[1]);
                Store.update(c,"UPDATE training_jobs SET data=? WHERE id=?",record,update[0]);
            }
            return null;
        });
        return Json.obj("jobs",updates.size(),"datasets",datasets.pinRoot(),"path",store.trainingRoot.toString());
    }

    private static long[] usage(Path directory){
        long[] total=new long[2];
        if(!Files.isDirectory(directory))return total;
        try(var walk=Files.walk(directory)){
            for(Path path:walk.toList()){
                if(path.equals(directory)||Files.isDirectory(path))continue;
                try{total[0]+=Files.size(path);total[1]++;}catch(Exception ignored){/* 并发删除的文件跳过即可 */}
            }
        }catch(Exception ignored){/* 目录不可读时按已统计的部分返回，不虚报 */}
        return total;
    }

    // ===== 调度与执行 =====

    /** 由队列调度线程驱动：启动排队任务、停滞判定、取消超时强杀。 */
    public void tick(){
        if(closed)return;
        long now=System.currentTimeMillis();
        for(Active holder:active.values()){
            TrainingProcess process=holder.process;
            if(process==null||!process.running())continue;
            if(holder.cancelRequested&&holder.cancelAt>0&&now-holder.cancelAt>CANCEL_GRACE_MS){
                // 优雅取消到期仍未退出：终止该进程树，产物与已写入指标保留。
                process.close();
                continue;
            }
            if(!holder.stalled&&process.sinceLastEventMs()>=STALL_MS){
                holder.stalled=true;
                // 停滞只提示不杀进程：长任务可能只是单个 epoch 很慢。
                markStalled(holder.jobId);
            }
        }
        dispatch();
    }

    private synchronized void dispatch(){
        if(closed)return;
        while(active.size()<concurrency){
            JsonObject row=store.read(c->Store.one(c,"SELECT id FROM training_jobs WHERE status='queued' ORDER BY created_at,id LIMIT 1"));
            if(row==null)return;
            String jobId=Json.required(row,"id");
            JsonObject record=store.read(c->Store.document(c,"training_jobs",jobId));
            JsonObject data=record;
            String requestedDevice=Json.str(data,"requestedDevice","gpu-auto");
            JsonObject state;
            try{state=runtime.requireEnvironment();}
            catch(ApiError failure){settle(jobId,"failed",failure.getMessage(),failure);continue;}
            catch(Exception failure){settle(jobId,"failed","训练环境检查失败，请核对 Python 环境与训练组件。",error(500,"training_environment_unavailable","训练环境检查失败。"));continue;}
            JsonObject resolved=TrainingRuntime.resolveDevice(state,requestedDevice);
            JsonObject parameters=data.has("parameters")?Json.object(data,"parameters"):new JsonObject();
            String device=Json.required(resolved,"device");
            if(device.equals("cpu")&&Json.str(parameters,"batch","").equals("auto")){
                settle(jobId,"failed","批次大小 auto 需要 GPU，当前只能使用 cpu。",error(409,"training_batch_auto_requires_gpu","批次大小 auto 需要 GPU。"));
                continue;
            }
            // 设备被推理占用时不抢占、不降级，任务保持排队，由用户决定取消或等待。
            if(localRuntime.deviceBusy(device))return;
            if(!runtime.claim(device,jobId))return;
            Active holder=new Active(jobId);
            active.put(jobId,holder);
            String now=Json.now();
            data.addProperty("status","preparing");data.addProperty("stage","preparing");data.addProperty("device",device);
            data.addProperty("actualDevice",device);data.addProperty("updatedAt",now);
            data.addProperty("requestedDevice",requestedDevice);
            data.add("fallback",resolved.has("fallback")?resolved.get("fallback").deepCopy():JsonNull.INSTANCE);
            data.add("environment",environmentSnapshot(resolved,state));
            data.addProperty("message","正在准备数据集与环境。");
            final JsonObject snapshot=data;
            store.tx(c->{
                Store.update(c,"UPDATE training_jobs SET status='preparing',device=?,updated_at=?,data=? WHERE id=?",device,now,snapshot,jobId);
                Store.event(c,"training.job.preparing",null,null,null,Json.obj("jobId",jobId,"device",device));
                return null;
            });
            Thread.ofPlatform().name("training-"+jobId).daemon(true).start(()->execute(jobId,holder,device));
        }
    }

    private void execute(String jobId,Active holder,String device){
        try{
            JsonObject record=store.read(c->Store.document(c,"training_jobs",jobId));
            TrainingDatasets.Snapshot snapshot=datasets.load(Json.required(record,"datasetId"));
            Path directory=jobDirectory(jobId);
            Files.createDirectories(directory);
            writeSnapshotFile(jobId,holder,snapshot,directory);
            if(holder.cancelRequested||closed){
                settle(jobId,"cancelled","已取消训练，未启动进程。",null);
                return;
            }
            TrainingProcess process=runtime.newProcess();
            holder.process=process;
            process.open();
            if(holder.cancelRequested){
                process.close();
                settle(jobId,"cancelled","已取消训练，未开始训练轮次。",null);
                return;
            }
            JsonObject parameters=Json.object(record,"parameters");
            process.train(jobId,payload(jobId,record,parameters,directory,snapshot),listener(jobId,holder));
            store.tx(c->{
                JsonObject current=Store.document(c,"training_jobs",jobId);
                current.addProperty("status","running");current.addProperty("stage","running");current.addProperty("startedAt",Json.now());
                current.addProperty("updatedAt",Json.now());current.addProperty("message","训练执行中。");
                Store.update(c,"UPDATE training_jobs SET status='running',updated_at=?,data=? WHERE id=?",Json.now(),current,jobId);
                Store.event(c,"training.job.started",null,null,null,Json.obj("jobId",jobId,"device",device,"workerHash",process.workerHash()));
                return null;
            });
            String stage=holder.terminal.get();
            finish(jobId,holder,stage,process);
        }catch(ApiError failure){
            settle(jobId,holder.cancelRequested?"cancelled":"failed",failure.getMessage(),failure);
        }catch(InterruptedException interrupted){
            Thread.currentThread().interrupt();
            settle(jobId,"interrupted","训练线程被中断，任务未自动重跑。",error(503,"training_interrupted","训练线程被中断。"));
        }catch(Exception failure){
            settle(jobId,holder.cancelRequested?"cancelled":"failed","训练未能完成，请查看日志尾部与诊断。",error(500,"training_failed","训练未能完成。"));
        }finally{
            TrainingProcess process=holder.process;
            if(process!=null)try{process.close();}catch(Exception ignored){/* 进程已经结束 */}
            runtime.release(device);
            synchronized(this){active.remove(jobId);}
            dispatch();
        }
    }

    private JsonObject payload(String jobId,JsonObject record,JsonObject parameters,Path directory,TrainingDatasets.Snapshot snapshot)throws Exception{
        JsonObject data=record;
        JsonObject payload=Json.obj("jobId",jobId,"taskType",Json.required(data,"taskType"),
            "dataPath",snapshot.directory().resolve("data.yaml").toString(),"outputDir",directory.toString(),
            "device",Json.required(data,"actualDevice"),
            "epochs",parameters.get("epochs"),"learningRate",parameters.get("learningRate"),"batch",parameters.get("batch"),
            "imgsz",parameters.get("imgsz"),"optimizer",parameters.get("optimizer"),"momentum",parameters.get("momentum"),
            "weightDecay",parameters.get("weightDecay"),"warmupEpochs",parameters.get("warmupEpochs"),"patience",parameters.get("patience"),
            "workers",parameters.get("workers"),"seed",parameters.get("seed"),"cosLr",parameters.get("cosLr"),
            "closeMosaic",parameters.get("closeMosaic"),"augment",parameters.get("augment"),"valPeriod",parameters.get("valPeriod"));
        JsonObject base=parameters.has("baseModel")&&!parameters.get("baseModel").isJsonNull()?Json.object(parameters,"baseModel"):null;
        if(base!=null){
            JsonObject model=models.snapshot(Json.required(base,"modelId"),base.has("modelVersion")?base.get("modelVersion").getAsInt():null);
            localRuntime.requireAuthorized(model);
            payload.addProperty("baseModelPath",Json.required(model,"modelPath"));
            payload.addProperty("baseModelHash",Json.required(model,"modelHash"));
        }
        return payload;
    }

    private TrainingProcess.Listener listener(String jobId,Active holder){
        return new TrainingProcess.Listener(){
            public void event(JsonObject event){handle(jobId,holder,event);}
            public void exited(String code,String message){holder.terminal.completeExceptionally(error(503,code,message));}
        };
    }

    private void handle(String jobId,Active holder,JsonObject event){
        String stage=Json.str(event,"stage","");
        holder.stalled=false;
        if("epoch".equals(stage)){recordEpoch(jobId,event);return;}
        if(TERMINAL_STAGES.contains(stage)){holder.terminalEvent=event;holder.terminal.complete(stage);return;}
        store.tx(c->{
            JsonObject current=Store.document(c,"training_jobs",jobId);
            current.addProperty("stage",stage);current.addProperty("updatedAt",Json.now());
            if(event.has("message"))current.addProperty("message",Json.str(event,"message",""));
            Store.update(c,"UPDATE training_jobs SET updated_at=?,data=? WHERE id=?",Json.now(),current,jobId);
            JsonObject payload=Json.obj("jobId",jobId,"stage",stage,"elapsedMs",Json.number(event,"elapsedMs",0));
            if(event.has("message"))payload.addProperty("message",Json.str(event,"message",""));
            Store.event(c,"training.job.progress",null,null,null,payload);
            return null;
        });
    }

    private void recordEpoch(String jobId,JsonObject event){
        int epoch=Json.integer(event,"epoch",0),epochs=Json.integer(event,"epochs",0);
        JsonObject metrics=event.has("metrics")?Json.object(event,"metrics").deepCopy():new JsonObject();
        long elapsedMs=Json.number(event,"elapsedMs",0);
        JsonObject row=Json.obj("jobId",jobId,"epoch",epoch,"epochs",epochs,"metrics",metrics,"elapsedMs",elapsedMs,"at",Json.now());
        long eta=epoch>0&&epochs>epoch?Math.round((double)elapsedMs/epoch*(epochs-epoch)):0;
        row.add("etaSeconds",epoch>0&&epochs>epoch?new JsonPrimitive(Math.round(eta/1000.0)):JsonNull.INSTANCE);
        row.addProperty("etaEstimated",true);
        row.addProperty("etaBasis","按已完成轮次的平均耗时估算");
        store.tx(c->{
            Store.update(c,"INSERT INTO training_epochs(job_id,epoch,data) VALUES(?,?,?) ON CONFLICT(job_id,epoch) DO UPDATE SET data=excluded.data",jobId,epoch,row);
            JsonObject current=Store.document(c,"training_jobs",jobId);
            current.addProperty("completedEpochs",epoch);current.addProperty("epochs",epochs);
            current.addProperty("elapsedMs",elapsedMs);current.add("lastMetrics",metrics.deepCopy());
            if(eta>0){current.addProperty("etaSeconds",Math.round(eta/1000.0));current.addProperty("etaEstimated",true);}
            current.addProperty("updatedAt",Json.now());
            if(Json.integer(current,"bestEpoch",0)==0||better(metrics,current)){current.addProperty("bestEpoch",epoch);current.add("bestMetrics",metrics.deepCopy());}
            Store.update(c,"UPDATE training_jobs SET updated_at=?,data=? WHERE id=?",Json.now(),current,jobId);
            Store.event(c,"training.job.epoch",null,null,null,row.deepCopy());
            return null;
        });
    }

    /** 以 mAP50 优先、其次 mAP50-95、再其次 top1 作为「更优」判据；三类指标都缺失时不改写最优轮次。 */
    private static boolean better(JsonObject metrics,JsonObject current){
        JsonObject best=Json.object(current,"bestMetrics");
        for(String key:List.of("mAP50","mAP50_95","top1")){
            Double next=metric(metrics,key),previous=metric(best,key);
            if(next==null)continue;
            if(previous==null)return true;
            if(!next.equals(previous))return next>previous;
        }
        return false;
    }

    private static Double metric(JsonObject value,String key){
        JsonElement element=value.get(key);
        if(element==null||!element.isJsonPrimitive()||!element.getAsJsonPrimitive().isNumber())return null;
        double number=element.getAsDouble();
        return Double.isFinite(number)?number:null;
    }

    private void finish(String jobId,Active holder,String stage,TrainingProcess process)throws Exception{
        JsonObject event=holder.terminalEvent==null?new JsonObject():holder.terminalEvent;
        JsonObject result=event.has("result")?Json.object(event,"result"):new JsonObject();
        JsonArray artifacts=collectArtifacts(jobId,result);
        String note=Json.str(event,"message","");
        if("finished".equals(stage))settle(jobId,"succeeded",note.isBlank()?"训练完成。":note,null,artifacts,result);
        else if("cancelled".equals(stage))settle(jobId,"cancelled",note.isBlank()?"已取消训练，已产出的权重与逐轮指标保留。":note,null,artifacts,result);
        else{
            String code=Json.str(event,"code","training_failed");
            settle(jobId,"failed",note.isBlank()?"训练失败。":note,error(422,code,note),artifacts,result);
        }
        // 日志摘要在终态确定之后落盘：它记录的是最终状态与逐轮指标，再作为产物单独登记。
        writeLogFile(jobId,process);
        registerArtifact(jobId,"log","train.log");
    }

    /** 追加登记一份已经落盘的受管产物（用于终态之后才生成的日志摘要）。 */
    private void registerArtifact(String jobId,String kind,String name)throws Exception{
        Path path=managedPath(jobId,name);
        if(!Files.isRegularFile(path))return;
        JsonObject row=Json.obj("kind",kind,"name",name,"size",Files.size(path),"hash",Media.hash(path),"registeredAt",Json.now());
        final JsonObject artifact=row;
        store.tx(c->{
            JsonObject current=Store.document(c,"training_jobs",jobId);
            JsonArray artifacts=Json.array(current,"artifacts").deepCopy(),kept=new JsonArray();
            for(JsonElement element:artifacts)if(!kind.equals(Json.str(element.getAsJsonObject(),"kind","")))kept.add(element);
            kept.add(artifact.deepCopy());
            current.add("artifacts",kept);
            Store.update(c,"UPDATE training_jobs SET updated_at=?,data=? WHERE id=?",Json.now(),current,jobId);
            Store.update(c,"INSERT INTO training_artifacts(id,job_id,kind,path,size,hash,data) VALUES(?,?,?,?,?,?,?)",
                Json.id(),jobId,kind,path.toString(),Json.number(artifact,"size",0),Json.required(artifact,"hash"),artifact);
            return null;
        });
    }

    /** 只登记受管目录内、哈希与大小都对得上的产物；worker 报告的任何路径都要重新核对。 */
    private JsonArray collectArtifacts(String jobId,JsonObject result)throws Exception{
        JsonArray artifacts=new JsonArray();Path directory=jobDirectory(jobId);JsonArray reported=Json.array(result,"artifacts");
        for(JsonElement element:reported){
            JsonObject artifact=element.getAsJsonObject(),row=new JsonObject();
            String kind=Json.str(artifact,"kind",""),path=Json.str(artifact,"path",null),hash=Json.str(artifact,"hash",null);
            if(kind.isBlank()||path==null||hash==null||!hash.matches("[a-f0-9]{64}"))continue;
            Path candidate=Path.of(path).toAbsolutePath().normalize();
            if(!candidate.startsWith(directory)||!Files.isRegularFile(candidate))continue;
            long size=Files.size(candidate);
            if(size!=Json.number(artifact,"size",-1))continue;
            if(!Media.hash(candidate).equals(hash))continue;
            row.addProperty("kind",kind);row.addProperty("name",directory.relativize(candidate).toString().replace('\\','/'));
            row.addProperty("size",size);row.addProperty("hash",hash);row.addProperty("registeredAt",Json.now());
            artifacts.add(row);
        }
        return artifacts;
    }

    /**
     * 写入任务目录内的日志摘要：逐轮指标取自训练事件落库的同一份数据，因此与指标接口完全一致。
     * worker 的 stderr 尾部按原样附在后面，供排查环境与依赖问题。
     */
    private void writeLogFile(String jobId,TrainingProcess process){
        try{
            JsonObject record=store.read(c->Store.document(c,"training_jobs",jobId));
            StringBuilder text=new StringBuilder();
            text.append("# 由自动标注小助手汇总的训练日志\n");
            text.append("任务：").append(jobId).append('\n');
            text.append("数据集：").append(Json.str(record,"datasetId","")).append(" 快照：").append(Json.str(record,"snapshotHash","")).append('\n');
            text.append("设备：").append(Json.str(record,"actualDevice",Json.str(record,"device","")));
            String fallback=Json.str(record,"fallback","");
            if(!fallback.isBlank())text.append("（").append(fallback).append("）");
            text.append(" 状态：").append(Json.str(record,"status","")).append('\n');
            text.append("参数：").append(Json.object(record,"parameters").toString()).append('\n');
            text.append("环境：").append(Json.object(record,"environment").toString()).append('\n');
            JsonArray epochs=store.read(c->Store.docs(c,"SELECT data FROM training_epochs WHERE job_id=? ORDER BY epoch",jobId));
            for(JsonElement element:epochs){
                JsonObject row=element.getAsJsonObject();
                text.append("第 ").append(Json.integer(row,"epoch",0)).append('/').append(Json.integer(row,"epochs",0)).append(" 轮  ");
                text.append("耗时 ").append(Math.round(Json.number(row,"elapsedMs",0)/1000.0)).append("s  ");
                text.append("指标 ").append(Json.object(row,"metrics").toString()).append('\n');
            }
            if(epochs.isEmpty())text.append("未产生任何训练轮次。\n");
            if(record.has("message"))text.append("结论：").append(Json.str(record,"message","")).append('\n');
            String tail=process==null?"":process.stderrTail(256*1024);
            if(!tail.isBlank()){
                text.append("\n----- 训练进程 stderr 尾部（原始输出，可能包含本机路径）-----\n").append(tail);
            }
            String content=text.toString();
            if(content.length()>512*1024)content=content.substring(content.length()-512*1024);
            Files.writeString(jobDirectory(jobId).resolve("train.log"),content,StandardCharsets.UTF_8);
        }catch(Exception ignored){/* 日志写入失败不能覆盖任务结论 */}
    }

    private void writeSnapshotFile(String jobId,Active holder,TrainingDatasets.Snapshot snapshot,Path directory)throws Exception{
        JsonObject data=snapshot.data(),summary=Json.object(Json.object(data,"inspection"),"summary");
        JsonObject content=Json.obj("datasetId",Json.required(data,"id"),"origin",Json.required(data,"origin"),"taskType",Json.required(data,"taskType"),
            "snapshotHash",Json.required(data,"snapshotHash"),"createdAt",Json.required(data,"createdAt"),
            "classes",Json.array(data,"classes").deepCopy(),"files",Json.number(summary,"images",0),"objects",Json.number(summary,"objects",0),
            "splits",Json.object(summary,"splits").deepCopy(),"frozenAt",Json.now());
        Files.writeString(directory.resolve("dataset-snapshot.json"),content.toString(),StandardCharsets.UTF_8);
    }

    private void markStalled(String jobId){
        store.tx(c->{
            JsonObject current=Store.document(c,"training_jobs",jobId);
            current.addProperty("stalledAt",Json.now());
            current.addProperty("message","已超过 30 分钟没有收到训练轮次事件，进程仍在运行；可继续等待或手动取消。");
            Store.update(c,"UPDATE training_jobs SET updated_at=?,data=? WHERE id=?",Json.now(),current,jobId);
            Store.event(c,"training.job.stalled",null,null,null,Json.obj("jobId",jobId,"stage",Json.str(current,"stage",""),"sinceLastEventMs",STALL_MS));
            return null;
        });
    }

    /** 统一的终态收敛：无论成功、失败、取消还是中断，都只在这里写最终状态并广播事件。 */
    private void settle(String jobId,String status,String message,ApiError failure){
        settle(jobId,status,message,failure,new JsonArray(),new JsonObject());
    }

    private void settle(String jobId,String status,String message,ApiError failure,JsonArray artifacts,JsonObject result){
        String now=Json.now();
        store.tx(c->{
            JsonObject current=Store.document(c,"training_jobs",jobId);
            current.addProperty("status",status);current.addProperty("stage",status);current.addProperty("updatedAt",now);
            current.addProperty("finishedAt",now);if(message!=null)current.addProperty("message",message);
            if(failure!=null)current.add("error",Json.obj("code",failure.code,"message",failure.getMessage()));
            if(!artifacts.isEmpty())current.add("artifacts",artifacts.deepCopy());
            if(!result.isEmpty()){
                current.add("result",Json.obj("completedEpochs",Json.number(result,"completedEpochs",Json.number(current,"completedEpochs",0)),
                    "bestEpoch",Json.number(result,"bestEpoch",Json.number(current,"bestEpoch",0)),
                    "bestFitness",result.has("bestFitness")?result.get("bestFitness"):JsonNull.INSTANCE));
            }
            current.remove("etaSeconds");
            Store.update(c,"UPDATE training_jobs SET status=?,updated_at=?,data=? WHERE id=?",status,now,current,jobId);
            for(JsonElement element:artifacts){
                JsonObject artifact=element.getAsJsonObject();
                Store.update(c,"INSERT INTO training_artifacts(id,job_id,kind,path,size,hash,data) VALUES(?,?,?,?,?,?,?)",
                    Json.id(),jobId,Json.required(artifact,"kind"),jobDirectory(jobId).resolve(Json.required(artifact,"name")).toString(),
                    Json.number(artifact,"size",0),Json.required(artifact,"hash"),artifact);
            }
            JsonObject payload=Json.obj("jobId",jobId,"status",status,"completedEpochs",Json.number(current,"completedEpochs",0));
            if(failure!=null)payload.add("error",Json.obj("code",failure.code,"message",failure.getMessage()));
            String type=switch(status){case "succeeded"->"finished";case "cancelled"->"cancelled";case "interrupted"->"interrupted";default->"failed";};
            Store.event(c,"training.job."+type,null,null,null,payload);
            return null;
        });
    }

    /** 诊断摘要：只报告队列与当前轮次，不含数据集路径与用户目录。 */
    JsonObject diagnostics(){
        JsonArray items=new JsonArray();
        for(Active holder:active.values()){
            TrainingProcess process=holder.process;
            JsonObject item=Json.obj("jobId",holder.jobId,"cancelRequested",holder.cancelRequested,"stalled",holder.stalled);
            if(process!=null){item.addProperty("stage",process.currentStage());item.addProperty("running",process.running());item.addProperty("sinceLastEventMs",process.sinceLastEventMs());}
            items.add(item);
        }
        long queued=store.read(c->Json.number(Store.one(c,"SELECT COUNT(*) AS n FROM training_jobs WHERE status='queued'"),"n",0));
        return Json.obj("concurrency",concurrency,"running",items.size(),"queued",queued,"items",items);
    }

    // ===== 视图与工具 =====

    /** 对外视图只保留受管相对清单与摘要，不暴露受管绝对路径。 */
    private static JsonObject view(JsonObject record){
        JsonObject data=record,result=new JsonObject();
        for(String field:List.of("id","datasetId","taskType","status","device"))if(data.has(field)&&!data.get(field).isJsonNull())result.add(field,data.get(field).deepCopy());
        if(data.has("projectId")&&!data.get("projectId").isJsonNull())result.add("projectId",data.get("projectId"));
        for(String field:List.of("stage","message","parameters","requestedDevice","actualDevice","fallback","environment","createdAt","updatedAt","startedAt","finishedAt",
            "elapsedMs","etaSeconds","etaEstimated","completedEpochs","epochs","lastMetrics","bestMetrics","bestEpoch","error","cancelRequested","stalledAt","workerHash",
            "parametersHash","snapshotHash","classNames","keypointNames","result","metricsPrunedAt","metricsRetentionDays")){
            if(data.has(field))result.add(field,data.get(field).deepCopy());
        }
        JsonArray artifacts=new JsonArray();
        for(JsonElement element:Json.array(data,"artifacts")){
            JsonObject artifact=element.getAsJsonObject();
            artifacts.add(Json.obj("kind",Json.required(artifact,"kind"),"name",Json.required(artifact,"name"),
                "size",Json.number(artifact,"size",0),"hash",Json.required(artifact,"hash")));
        }
        result.add("artifacts",artifacts);
        int epochs=Json.integer(data,"epochs",0),completed=Json.integer(data,"completedEpochs",0);
        // 进度只在总量已知且由真实轮次回调驱动时给出，不合成百分比。
        result.addProperty("progressKnown",epochs>0);
        result.addProperty("progress",epochs>0?Math.min(1.0,(double)completed/epochs):0.0);
        return result;
    }

    /** 记录任务启动时的生效环境，便于事后判断该结果由哪个版本的解释器与训练组件产出。 */
    private JsonObject environmentSnapshot(JsonObject resolved,JsonObject state){
        JsonObject environment=new JsonObject();
        for(String field:List.of("cudaAvailable","pythonVersion","ultralyticsVersion","torchVersion")){
            if(state.has(field))environment.add(field,state.get(field).deepCopy());
            else if(resolved.has(field))environment.add(field,resolved.get(field).deepCopy());
        }
        environment.addProperty("device",Json.str(resolved,"device",""));
        if(state.has("workerHash"))environment.add("workerHash",state.get("workerHash").deepCopy());
        return environment;
    }

    /** 任务目录优先采用记录里的 artifactsDir，使更换默认产物目录后历史任务仍指向原位置。 */
    private Path jobDirectory(String id){
        JsonObject record=store.read(c->{
            try{return Store.document(c,"training_jobs",id);}
            catch(ApiError missing){return null;}
        });
        return record==null?newJobDirectory(id):jobDirectory(record);
    }

    private Path jobDirectory(JsonObject record){
        // artifactsDir 与其他任务字段一样在记录根上（data 列即整个记录），不存在嵌套的 data 层。
        String recorded=Json.str(record,"artifactsDir",null);
        if(recorded!=null&&!recorded.isBlank()){
            try{Path path=Path.of(recorded);if(path.isAbsolute())return path.toAbsolutePath().normalize();}
            catch(Exception ignored){/* 记录损坏时按当前产物根重算，不因单个字段挡住任务操作。 */}
        }
        return newJobDirectory(Json.required(record,"id"));
    }

    private Path newJobDirectory(String id){
        Path base=store.trainingRoot.normalize(),directory=base.resolve(id).normalize();
        if(!directory.startsWith(base))throw error(500,"training_job_path_invalid","训练任务目录无效。");
        return directory;
    }

    private Path managedPath(String jobId,String name)throws Exception{
        Path directory=jobDirectory(jobId),path=directory.resolve(name).normalize();
        if(!path.startsWith(directory))throw error(409,"training_job_path_invalid","训练产物路径无效。");
        return path;
    }

    private static void deleteDirectory(Path directory){
        if(!Files.isDirectory(directory))return;
        try(var walk=Files.walk(directory)){
            for(Path path:walk.sorted(Comparator.reverseOrder()).toList())Files.deleteIfExists(path);
        }catch(Exception ignored){/* 记录已删除时残留文件不影响结论，占用量由存储页显示 */}
    }

    private static JsonArray classNames(JsonObject data){
        JsonArray result=new JsonArray();
        for(JsonElement element:Json.array(data,"classes"))result.add(Json.required(element.getAsJsonObject(),"name"));
        return result;
    }

    static void issue(JsonArray issues,String severity,String code,String message){
        issues.add(Json.obj("severity",severity,"code",code,"message",message));
    }
    private static boolean hasError(JsonArray issues){
        for(JsonElement element:issues)if(Json.str(element.getAsJsonObject(),"severity","").equals("error"))return true;
        return false;
    }
    private static String hashText(String value)throws Exception{
        MessageDigest digest=MessageDigest.getInstance("SHA-256");
        byte[] bytes=digest.digest(value.getBytes(StandardCharsets.UTF_8));
        StringBuilder text=new StringBuilder();
        for(byte item:bytes)text.append(String.format("%02x",item));
        return text.toString();
    }
    private static String identifier(JsonObject p,String field,int max){
        String value=Json.required(p,field);
        if(value.length()>max)throw new ApiError(400,"training_parameter_invalid","训练参数过长："+field);
        return value;
    }
    private static ApiError error(int status,String code,String message){return new ApiError(status,code,message);}

    @Override public void close(){
        closed=true;
        List<Active> holders;List<String> jobIds;
        synchronized(this){
            holders=new ArrayList<>(active.values());jobIds=new ArrayList<>(active.keySet());active.clear();
        }
        for(Active holder:holders){
            TrainingProcess process=holder.process;
            if(process!=null)try{process.close();}catch(Exception ignored){/* 引擎退出，进程树已终止 */}
        }
        for(int index=0;index<jobIds.size();index++){
            try{settle(jobIds.get(index),"interrupted","引擎停止时任务仍在执行，已标记为中断；需要时请手动重试。",null);}
            catch(Exception ignored){/* 关闭阶段的落库失败不阻塞退出 */}
        }
    }
}
