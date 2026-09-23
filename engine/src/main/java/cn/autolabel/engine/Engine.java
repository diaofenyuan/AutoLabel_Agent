package cn.autolabel.engine;

import com.google.gson.*;
import java.nio.file.*;
import java.util.*;

final class Engine implements AutoCloseable {
    final Store store;final Projects projects;final Exporter exporter;final ExportFormats exportFormats;final Providers providers;final Runs runs;final Flows flows;final Maintenance maintenance;final LocalModels localModels;final LocalRuntime localRuntime;final LocalRuns localRuns;final RunResults runResults;final InputResultReuse inputReuse;final MediaJobs mediaJobs;final Tracks tracks;final TrackGenerations trackGenerations;final TrainingRuntime trainingRuntime;final TrainingDatasets trainingDatasets;final TrainingJobs trainingJobs;final DatasetVersions datasetVersions;final ProjectDeletion projectDeletion;
    Engine(Path path)throws Exception{this(path,new JsonObject());}
    /** 启动参数里的 materialsRoot 为存储根下的受管原图目录；缺省保持 <数据目录>/originals。 */
    static Path materialsRoot(JsonObject startup){
        String value=Json.str(startup,"materialsRoot","");
        if(value.isBlank())return null;
        if(value.length()>32767)throw new ApiError(400,"materials_root_invalid","受管原图目录必须是绝对路径。");
        try{Path path=Path.of(value);if(!path.isAbsolute())throw new ApiError(400,"materials_root_invalid","受管原图目录必须是绝对路径。");return path;}catch(ApiError e){throw e;}catch(Exception e){throw new ApiError(400,"materials_root_invalid","受管原图目录必须是绝对路径。");}
    }
    /** 启动参数里的 trainingRoot 为设置页配置的训练产物目录；缺省保持 <数据目录>/training。合法性与可写性由 Store 校验，失效只回退并记录原因，不让引擎拒绝启动。 */
    static Path trainingRoot(JsonObject startup){
        String value=Json.str(startup,"trainingRoot","");
        if(value.isBlank())return null;
        try{return Path.of(value);}catch(Exception e){return Path.of(".");}
    }
    Engine(Path path,JsonObject startup)throws Exception{Costs.referencePricing(Json.array(startup,"referencePricing"));store=new Store(path,materialsRoot(startup),trainingRoot(startup));projects=new Projects(store);exporter=new Exporter(store,projects);exportFormats=new ExportFormats(store);providers=new Providers(store);localModels=new LocalModels(store,projects);localRuntime=new LocalRuntime(localModels,startup);runs=new Runs(store,projects,providers);runResults=new RunResults(this);inputReuse=new InputResultReuse(this);runs.inputResults=runResults;runs.inputReuse=inputReuse;localRuns=new LocalRuns(this);flows=new Flows(this);mediaJobs=new MediaJobs(this,startup);exporter.mediaJobs=mediaJobs;projects.mediaJobs=mediaJobs;datasetVersions=new DatasetVersions(store,projects,exporter);exporter.datasetVersions=datasetVersions;tracks=new Tracks(this);trackGenerations=new TrackGenerations(this,tracks);tracks.generations=trackGenerations;trainingRuntime=new TrainingRuntime(localRuntime,startup);localRuntime.shareTrainingRuntime(trainingRuntime);trainingDatasets=new TrainingDatasets(store,projects,datasetVersions);trainingJobs=new TrainingJobs(store,trainingDatasets,localModels,localRuntime,trainingRuntime);runs.flowTick=()->{step(flows::tick);step(localRuns::tick);step(mediaJobs::tick);step(trackGenerations::tick);step(trainingJobs::tick);};maintenance=new Maintenance(this);projectDeletion=new ProjectDeletion(this);}
    Object command(String command,JsonObject p)throws Exception{
        if(command.equals("system.canUpdate"))return maintenance.status();if(command.equals("system.prepareUpdate"))return maintenance.prepare();if(command.equals("system.cancelUpdate"))return maintenance.cancel();
        if(command.equals("system.prepareDataMaintenance"))return maintenance.prepareData(p);if(command.equals("system.cancelDataMaintenance"))return maintenance.cancelData(p);
        if(Maintenance.isDataAction(command)){maintenance.enterOwned(command,p);try{return execute(command,p);}finally{maintenance.leaveOwned();}}
        boolean tracked=maintenance.enter(command);try{return execute(command,p);}finally{if(tracked)maintenance.leave();}
    }
    private Object execute(String command,JsonObject p)throws Exception{return switch(command){
        case "project.list"->projects.list();case "project.create"->projects.create(p);case "project.update"->projects.update(p);case "project.open"->projects.get(Json.required(p,"projectId"));case "project.example"->projects.example();
        // 项目删除只接受显式用户操作，不进入 Agent 工具白名单。
        case "project.delete.preflight"->projectDeletion.preflight(p);case "project.delete"->projectDeletion.delete(p);
        case "asset.list"->projects.listAssets(p);case "asset.get"->projects.asset(Json.required(p,"assetId"));case "asset.import"->projects.importAssets(p);
        case "track.timeline.create"->tracks.timelines.create(p);case "track.timeline.list"->tracks.timelines.list(p);case "track.timeline.get"->tracks.timelines.get(p);case "track.timeline.frames"->tracks.timelines.page(p);case "track.timeline.update"->tracks.timelines.update(p);
        case "track.create"->tracks.create(p);case "track.list"->tracks.list(p);case "track.get"->tracks.get(p);case "track.update"->tracks.update(p);case "track.delete"->tracks.delete(p);
        case "track.keyframe.list"->tracks.keys(p);case "track.keyframe.save"->tracks.saveKey(p);case "track.keyframe.delete"->tracks.deleteKey(p);case "track.split"->tracks.split(p);case "track.merge"->tracks.merge(p);
        case "track.generate.preview"->trackGenerations.preview(p);case "track.generate"->trackGenerations.generate(p);case "track.generation.get"->trackGenerations.get(p);case "track.generation.list"->trackGenerations.list(p);case "track.generation.results"->trackGenerations.results(p);case "track.generation.cancel"->trackGenerations.cancel(p);case "track.generation.retry"->trackGenerations.retry(p);
        case "track.local.sequence"->trackLocalSequence(p);
        case "track.local.sequence.get"->localTrackingCandidateGet(p);
        case "track.local.sequence.list"->localTrackingCandidateList(p);
        case "track.local.sequence.confirm"->confirmLocalTrackingCandidate(p);
        case "track.local.sequence.promote"->promoteLocalTrackingCandidate(p);
        case "media.runtime.get"->{FlowPlans.keys(p);yield mediaJobs.runtime();}case "media.runtime.configure"->mediaJobs.configure(p);
        case "media.video.inspect"->mediaJobs.inspect(p);case "media.video.create"->mediaJobs.createVideo(p);case "media.video.import"->mediaJobs.importVideo(p);case "media.video.frames"->mediaJobs.frames(p);
        case "media.job.get"->{FlowPlans.keys(p,"jobId");yield mediaJobs.get(Json.required(p,"jobId"));}case "media.job.list"->mediaJobs.list(p);case "media.job.cancel"->mediaJobs.cancel(p);case "media.job.retry"->mediaJobs.retry(p);
        case "media.job.resolve"->{FlowPlans.keys(p,"jobId");yield store.read(c->{JsonObject job=Store.document(c,"media_jobs",Json.required(p,"jobId"));JsonObject value=Json.obj("jobId",job.get("id"),"kind",job.get("kind"));if(job.has("sourcePath"))value.add("sourcePath",job.get("sourcePath"));return value;});}
        case "media.screening.create"->mediaJobs.createScreening(p);case "media.screening.result"->mediaJobs.screeningResult(p);
        case "media.recipe.list"->new MediaRecipes(store).list(p);case "media.recipe.save"->new MediaRecipes(store).save(p);case "media.recipe.delete"->new MediaRecipes(store).delete(p);
        case "asset.checkLocations"->new AssetFiles(store,projects).check(p);case "asset.relocate"->new AssetFiles(store,projects).relocate(p);
        case "backup.preflight"->new DataBackups(store).preflight(p);case "backup.create"->new DataBackups(store).create(p);case "backup.inspect"->new DataBackups(store).inspect(p);case "restore.prepare"->new DataBackups(store).prepareRestore(p);
        case "flow.capabilities"->FlowPlans.capabilities();case "flow.preflight"->flows.plans.preflight(p);case "flow.create"->flows.create(p);case "flow.get"->flows.get(Json.required(p,"flowRunId"));case "flow.list"->flows.list(p);case "flow.artifact"->new FlowArtifacts(store).get(p);case "flow.rerun"->flows.rerun(p);
        case "flow.pause","flow.resume","flow.cancel","flow.retry"->{JsonObject value=flows.control(command.substring(5),p);if(command.equals("flow.cancel"))localRuns.cancelFlow(Json.required(p,"flowRunId"));yield value;}
        case "local.runtime.get"->{FlowPlans.keys(p);yield localRuntime.state();}case "local.model.get"->localModels.get(p);
        case "local.runtime.configure"->localRuntime.configure(p);case "local.runtime.probe"->localRuntime.probe(p);
        case "local.model.register"->localModels.register(p);case "local.model.list"->localModels.list(p);case "local.model.resolve"->localModels.resolve(p);case "local.model.authorize"->localRuntime.authorize(p);case "local.model.load"->localRuntime.load(p);
        case "local.run.create"->localRuns.create(p);case "run.result.get"->runResults.get(p);case "flow.input.image"->RunInputs.image(store,projects,p);
        case "evaluationSet.create"->new EvaluationSets(store,projects).create(p);case "evaluationSet.list"->new EvaluationSets(store,projects).list(Json.required(p,"projectId"));case "evaluationSet.get"->new EvaluationSets(store,projects).get(p);
        case "evaluationSet.saveTruth"->new EvaluationSets(store,projects).saveTruth(p);case "evaluationSet.getTruth"->new EvaluationSets(store,projects).truth(p);case "evaluationSet.publish"->new EvaluationSets(store,projects).publish(p);
        case "evaluation.preflight"->new Evaluations(store,projects).preflight(p);case "evaluation.create"->new Evaluations(store,projects).create(p);case "evaluation.get"->new Evaluations(store,projects).get(Json.required(p,"evaluationId"));case "evaluation.list"->new Evaluations(store,projects).list(Json.required(p,"projectId"));case "evaluation.results"->new Evaluations(store,projects).results(p);
        case "evaluation.rerun.preflight"->new EvaluationReruns(this).preflight(p);case "evaluation.rerun.create"->new EvaluationReruns(this).create(p);case "evaluation.rerun.get"->new EvaluationReruns(this).get(Json.required(p,"comparisonId"));case "evaluation.rerun.finish"->new EvaluationReruns(this).finish(Json.required(p,"comparisonId"));
        case "review.build"->new Reviews(store,projects).build(p);case "review.list"->new Reviews(store,projects).list(p);case "review.resolve"->new Reviews(store,projects).resolve(p);case "review.sample"->new Reviews(store,projects).sample(p);case "review.suggestions"->new Reviews(store,projects).suggestions(p);
        case "annotation.save"->projects.save(p);case "annotation.draft"->projects.draft(p);case "annotation.history"->projects.history(Json.required(p,"assetId"));
        case "annotation.importYolo"->new YoloImporter(store,projects).importLabels(p);case "annotation.render"->new OverlayRenderer(store,projects).render(p);
        case "annotation.draft.discard"->store.tx(c->{String id=Json.required(p,"assetId");Store.update(c,"DELETE FROM drafts WHERE asset_id=?",id);Store.event(c,"annotation.draft_discarded",null,id,null,new JsonObject());return Json.obj("discarded",true);});
        case "export.preflight"->exporter.preflight(p);case "export.create"->exporter.create(p);case "export.list"->exporter.list(Json.required(p,"projectId"));
        case "export.format.list"->exportFormats.list(p);case "export.format.get"->exportFormats.get(p);case "export.format.save"->exportFormats.save(p);case "export.format.delete"->exportFormats.delete(p);
        case "export.reproduce"->new ExportHistory(store).reproduce(p);case "export.compare"->new ExportHistory(store).compare(p);
        case "training.runtime.get"->{FlowPlans.keys(p);yield trainingRuntime.probe(p);}
        case "training.root.status"->{FlowPlans.keys(p);yield trainingJobs.rootStatus();}
        // 切换产物目录前把已有任务与数据集固定在原目录，避免历史产物在界面里失联。
        case "training.root.pin"->{FlowPlans.keys(p);yield trainingJobs.pinRoot();}
        case "training.dataset.create"->trainingDatasets.create(p);case "training.dataset.list"->trainingDatasets.list(p);case "training.dataset.get"->trainingDatasets.get(p);
        case "training.job.preflight"->trainingJobs.preflight(p);
        case "training.job.create"->trainingJobs.create(p);case "training.job.list"->trainingJobs.list(p);case "training.job.get"->trainingJobs.get(p);
        case "training.job.metrics"->trainingJobs.metrics(p);case "training.job.log"->trainingJobs.log(p);
        case "training.job.cancel"->trainingJobs.cancel(p);case "training.job.retry"->trainingJobs.retry(p);case "training.job.delete"->trainingJobs.delete(p);
        // 受管产物路径只给桌面主进程做授权解析，不返回给渲染层。
        case "training.job.artifact"->trainingJobs.artifact(p);
        case "dataset.version.preflight"->datasetVersions.preflight(p);case "dataset.version.create"->datasetVersions.create(p);
        case "dataset.version.get"->datasetVersions.get(p);case "dataset.version.list"->datasetVersions.list(p);case "dataset.version.items"->datasetVersions.items(p);
        case "dataset.version.cancel"->datasetVersions.cancel(p);case "dataset.version.delete"->datasetVersions.delete(p);
        case "dataset.version.compare"->datasetVersions.compare(p);case "dataset.version.verify"->datasetVersions.verify(p);
        case "provider.list"->providers.list();case "provider.save"->providers.save(p);case "provider.delete"->providers.delete(p);case "provider.models"->providers.models(Json.required(p,"providerId"));case "provider.test"->providers.test(p);case "provider.testAll"->providers.testAll(p);case "provider.capabilities"->providers.capabilities(p);case "credential.set"->providers.credential(p);
        case "chat.send"->providers.chat(p);
        case "chat.cancel"->providers.cancel(Json.required(p,"sessionId"));
        case "run.create"->runs.create(p);case "run.list"->runs.list(Json.str(p,"projectId",null));case "run.get"->runs.get(p);case "run.attempts"->runs.attempts(p);
        case "budget.get"->store.read(c->Budgets.view(c,Json.required(p,"budgetScopeId")));
        case "budget.update"->store.tx(c->{String id=Json.required(p,"budgetScopeId");Budgets.ensure(c,id,p.has("maxRequests")?Costs.integer(p,"maxRequests",1,9_007_199_254_740_991L):Long.MAX_VALUE,true);if(p.has("costLimit"))Costs.update(c,id,p.get("costLimit"));return Budgets.view(c,id);});
        case "budget.estimate"->store.read(c->Costs.estimate(c,providers.get(Json.required(p,"providerId")),p));
        case "run.pause","run.resume","run.cancel","run.retry"->{JsonObject value=runs.control(command.substring(4),p);if(command.equals("run.cancel"))localRuns.cancel(Json.required(p,"runId"));yield value;}
        case "system.suspend"->runs.suspend(true);case "system.resume"->runs.suspend(false);
        case "event.list"->store.read(c->Store.events(c,Json.number(p,"after",0),Json.str(p,"runId",null),Json.str(p,"assetId",null),Json.str(p,"flowRunId",null),Json.bounded(p,"limit",500,1,2000)));
        case "event.snapshot"->store.read(c->{JsonObject result=Json.obj("sequence",Store.cursor(c),"timestamp",Json.now());
            if(p.has("runId"))result.add("run",runs.view(c,Json.required(p,"runId"),5000,0));else{JsonArray all=new JsonArray();for(JsonObject row:Store.rows(c,"SELECT id FROM runs ORDER BY rowid DESC LIMIT 100"))all.add(runs.view(c,Json.required(row,"id"),0,0));result.add("runs",all);}return result;});
        case "resource.list"->new ResourceLibrary(store,projects).list(p);case "resource.save"->new ResourceLibrary(store,projects).save(p);
        case "resource.get"->new ResourceLibrary(store,projects).get(p);case "resource.apply"->new ResourceLibrary(store,projects).apply(p);case "resource.reference"->new ResourceLibrary(store,projects).addReference(p);case "resource.image"->resourceImage(p);
        case "settings.get"->settings();
        case "settings.save"->{JsonObject settings=Json.object(p,"settings");Providers.rejectSecrets(settings);Json.bounded(settings,"globalConcurrency",8,1,32);yield store.tx(c->{JsonObject r=Store.one(c,"SELECT data FROM settings WHERE id='global'");JsonObject current=r==null?new JsonObject():Json.parse(r.get("data").getAsString());for(var e:settings.entrySet())current.add(e.getKey(),e.getValue());Store.update(c,"INSERT INTO settings(id,data) VALUES('global',?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",current);Store.event(c,"settings.saved",null,null,null,Json.obj("globalConcurrencyRequiresRestart",settings.has("globalConcurrency")));return current;});}
        case "diagnostics.get"->Json.obj("engineVersion","0.1.0","protocolVersion",1,"javaVersion",System.getProperty("java.version"),"os",System.getProperty("os.name"),"architecture",System.getProperty("os.arch"),"databaseMode","WAL","databaseVersion",Store.SCHEMA_VERSION,"writeFailed",store.writeFailed,"queue",runs.diagnostics(),"training",trainingJobs.diagnostics(),"datasetVersions",datasetVersions.diagnostics(),"timestamp",Json.now());
        default->throw new ApiError(501,"command_not_implemented","此功能尚未实现："+command);
    };}
    private JsonObject trackLocalSequence(JsonObject p)throws Exception{
        FlowPlans.keys(p,"timelineId","timelineVersion","modelId","modelVersion","device","classMap","timeoutMs","scope","detector");
        if(!"detect".equals(Json.str(p,"detector","")))throw new ApiError(422,"tracking_task_unsupported","自动跟踪首版仅支持 Detect 时间轴。");
        String timelineId=Json.required(p,"timelineId");
        JsonObject request=store.read(c->{
            JsonObject timeline=Store.document(c,"track_timelines",timelineId),job=Store.document(c,"media_jobs",Json.required(timeline,"mediaJobId"));
            if(Json.number(timeline,"version",0)!=Json.number(p,"timelineVersion",-1))throw new ApiError(409,"track_version_conflict","时间轴已变化，请重新载入后再运行自动跟踪。");
            if(!"detect".equals(Json.str(timeline,"taskType","")))throw new ApiError(422,"tracking_task_unsupported","自动跟踪首版仅支持 Detect 时间轴。");
            String sourceHash=Json.str(job,"sourceHash","");if(!sourceHash.matches("[a-f0-9]{64}"))throw new ApiError(409,"tracking_source_unverified","抽帧任务缺少固定来源视频指纹，不能运行自动跟踪。");
            JsonObject model=localModels.snapshot(Json.required(p,"modelId"),p.has("modelVersion")?(int)Costs.integer(p,"modelVersion",1,Integer.MAX_VALUE):null);
            List<JsonObject> source=TrackTimelines.frames(c,timelineId);if(source.size()<2||source.size()>120)throw new ApiError(422,"tracking_limit_exceeded","一次自动跟踪需要 2 至 120 张连续固定帧。");
            JsonObject first=source.get(0),second=source.get(1),tb=Json.object(first,"timeBase");
            if(!tb.equals(Json.object(second,"timeBase")))throw new ApiError(422,"tracking_cadence_unsupported","时间轴时间基不一致，不能进行自动跟踪。");
            java.math.BigInteger delta=new java.math.BigInteger(Json.required(second,"sourcePts")).subtract(new java.math.BigInteger(Json.required(first,"sourcePts")));java.math.BigInteger numerator=delta.multiply(new java.math.BigInteger(Json.required(tb,"numerator"))),denominator=new java.math.BigInteger(Json.required(tb,"denominator"));if(numerator.signum()<=0)throw new ApiError(422,"tracking_cadence_unsupported","固定帧时间必须严格递增。");java.math.BigInteger gcd=numerator.gcd(denominator);numerator=numerator.divide(gcd);denominator=denominator.divide(gcd);
            JsonObject r=Json.obj("device",p.get("device"),"timeoutMs",p.get("timeoutMs"),"sequenceId",Json.id(),"sourceVideoId",timeline.get("sourceVideoId"),"sourceVideoHash",sourceHash,"expectedModelHash",model.get("modelHash"),"templateHash",timeline.get("templateHash"),"classMap",p.get("classMap"),"cadence",Json.obj("numerator",numerator.toString(),"denominator",denominator.toString()));
            JsonArray frames=new JsonArray();for(JsonObject frame:source){tracks.timelines.verifyFile(frame);frames.add(Json.obj("inputId",frame.get("frameId"),"assetId",frame.get("assetId"),"sourceVideoId",frame.get("sourceVideoId"),"imagePath",tracks.timelines.path(frame).toString(),"expectedInputHash",frame.get("contentHash"),"width",frame.get("width"),"height",frame.get("height"),"pts",frame.get("sourcePts"),"timeBase",frame.get("timeBase"),"sceneId",frame.get("sceneId")));}r.add("frames",frames);return r;
        });
        JsonObject raw=localRuntime.trackSequence(request),statistics=Json.object(raw,"statistics");
        JsonObject candidate=persistLocalTrackingCandidate(timelineId,request,raw);
        return Json.obj("status","completed","candidateId",candidate.get("candidateId"),"candidateSetId",raw.get("candidateSetId"),"candidateCount",Json.integer(statistics,"tracks",0),"frameCount",Json.integer(statistics,"frames",0),"associatedCount",Json.integer(statistics,"associatedDetections",0),"reviewRequired",trackingReviewRequired(raw),"trackingPerformed",true,"candidateOnly",true,"provenance",raw.get("provenance"),"statistics",statistics,"frames",raw.get("frames"),"tracks",raw.get("tracks"),"trackingIssues",raw.get("trackingIssues"),"createdAt",candidate.get("createdAt"),"updatedAt",candidate.get("updatedAt"));
    }
    /** 保存一次已完成的 worker 结果，结果永远保持候选态，不能被查询接口隐式应用。 */
    JsonObject persistLocalTrackingCandidate(String timelineId,JsonObject request,JsonObject raw)throws Exception{
        String candidateId=Json.id(),now=Json.now();
        JsonObject candidate=Json.obj("candidateId",candidateId,"timelineId",timelineId,"status","completed","createdAt",now,"updatedAt",now,
            "candidateOnly",true,"humanConfirmed",false,"trackingPerformed",true,"reviewRequired",trackingReviewRequired(raw),
            "request",request.deepCopy(),"result",raw.deepCopy());
        for(String field:List.of("candidateSetId","provenance","statistics","frames","tracks","trackingIssues"))if(raw.has(field))candidate.add(field,raw.get(field).deepCopy());
        JsonObject statistics=Json.object(raw,"statistics");
        candidate.addProperty("candidateCount",Json.integer(statistics,"tracks",0));
        candidate.addProperty("frameCount",Json.integer(statistics,"frames",0));
        candidate.addProperty("associatedCount",Json.integer(statistics,"associatedDetections",0));
        copyField(candidate,"sourceVideoHash",raw,request,"sourceVideoHash");
        copyField(candidate,"templateHash",raw,request,"templateHash");
        copyField(candidate,"modelHash",raw,request,"expectedModelHash");
        if(raw.has("provenance")){
            JsonObject provenance=Json.object(raw,"provenance");
            if(provenance.has("workerHash"))candidate.add("workerHash",provenance.get("workerHash"));
        }
        store.tx(c->{
            if(Store.one(c,"SELECT id FROM track_timelines WHERE id=?",timelineId)==null)throw new ApiError(404,"not_found","时间轴不存在。");
            Store.update(c,"INSERT INTO local_tracking_candidates(id,timeline_id,status,created_at,updated_at,data) VALUES(?,?,?,?,?,?)",candidateId,timelineId,"completed",now,now,candidate);
            Store.event(c,"track.local.candidate_saved",null,null,null,Json.obj("candidateId",candidateId,"timelineId",timelineId,"reviewRequired",trackingReviewRequired(raw)));
            return null;
        });
        return candidate;
    }
    private static void copyField(JsonObject target,String field,JsonObject primary,JsonObject fallback,String fallbackField){
        if(primary.has(field)&&!primary.get(field).isJsonNull())target.add(field,primary.get(field));
        else if(fallback.has(fallbackField)&&!fallback.get(fallbackField).isJsonNull())target.add(field,fallback.get(fallbackField));
    }
    private JsonObject localTrackingCandidateGet(JsonObject p){
        FlowPlans.keys(p,"candidateId");String id=Json.required(p,"candidateId");
        return store.read(c->{JsonObject row=Store.one(c,"SELECT data FROM local_tracking_candidates WHERE id=?",id);if(row==null)throw new ApiError(404,"not_found","自动跟踪候选不存在。");return Json.parse(row.get("data").getAsString()).getAsJsonObject();});
    }
    private JsonObject localTrackingCandidateList(JsonObject p){
        FlowPlans.keys(p,"timelineId","offset","limit");String timelineId=Json.required(p,"timelineId");
        int offset=Json.bounded(p,"offset",0,0,Integer.MAX_VALUE),limit=Json.bounded(p,"limit",100,1,100);
        return store.read(c->{if(Store.one(c,"SELECT id FROM track_timelines WHERE id=?",timelineId)==null)throw new ApiError(404,"not_found","时间轴不存在。");
            JsonArray items=Store.docs(c,"SELECT data FROM local_tracking_candidates WHERE timeline_id=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?",timelineId,limit,offset);
            JsonObject count=Store.one(c,"SELECT COUNT(*) AS n FROM local_tracking_candidates WHERE timeline_id=?",timelineId);
            return Json.obj("items",items,"total",count.get("n"),"offset",offset,"limit",limit);});
    }
    /** 只记录用户明确确认后的人工复核提交，不把 worker 候选伪装成正式贡献。 */
    private JsonObject confirmLocalTrackingCandidate(JsonObject p){
        FlowPlans.keys(p,"candidateId","timelineId","timelineVersion","confirm");
        if(!Json.bool(p,"confirm",false))throw new ApiError(400,"tracking_confirmation_required","必须明确确认后才能提交人工复核。");
        String candidateId=Json.required(p,"candidateId"),timelineId=Json.required(p,"timelineId");
        int timelineVersion=(int)Costs.integer(p,"timelineVersion",1,Integer.MAX_VALUE);
        return store.tx(c->{
            JsonObject row=Store.one(c,"SELECT data FROM local_tracking_candidates WHERE id=?",candidateId);if(row==null)throw new ApiError(404,"not_found","自动跟踪候选不存在。");
            JsonObject candidate=Json.parse(row.get("data").getAsString());
            if(!timelineId.equals(Json.str(candidate,"timelineId","")))throw new ApiError(409,"tracking_candidate_scope_conflict","候选不属于当前时间轴。");
            JsonObject timeline=Store.document(c,"track_timelines",timelineId);if(Json.number(timeline,"version",0)!=timelineVersion)throw new ApiError(409,"track_version_conflict","时间轴已变化，请刷新后重新核对候选。");
            if(!Json.bool(candidate,"candidateOnly",false)||Json.bool(candidate,"humanConfirmed",true))throw new ApiError(409,"tracking_candidate_invalid","该记录不是可确认的本地候选。");
            JsonObject old=Json.object(candidate,"confirmation");if(old.has("status"))return confirmationResult(candidate,old);
            String now=Json.now();JsonObject confirmation=Json.obj("status","manual_review_required","confirmedAt",now,"timelineVersion",timelineVersion,"formalContributionCreated",false,"nextAction","请在时间轴逐帧核对，并通过关键帧编辑与正式候选生成流程提交；本次确认不会自动写入正式轨迹。");
            candidate.add("confirmation",confirmation);candidate.addProperty("updatedAt",now);
            Store.update(c,"UPDATE local_tracking_candidates SET updated_at=?,data=? WHERE id=?",now,candidate,candidateId);
            Store.event(c,"track.local.candidate_confirmed",null,null,null,Json.obj("candidateId",candidateId,"timelineId",timelineId,"formalContributionCreated",false));
            return confirmationResult(candidate,confirmation);
        });
    }
    private static JsonObject confirmationResult(JsonObject candidate,JsonObject confirmation){
        return Json.obj("candidateId",candidate.get("candidateId"),"timelineId",candidate.get("timelineId"),"status",Json.required(confirmation,"status"),"candidateOnly",true,"humanConfirmed",false,"requiresManualReview",true,"formalContributionCreated",false,"confirmedAt",confirmation.get("confirmedAt"),"timelineVersion",confirmation.get("timelineVersion"),"confirmation",confirmation.deepCopy(),"nextAction",Json.required(confirmation,"nextAction"));
    }
    /**
     * 把用户已确认的本地 Detect 跟踪候选提升为正式轨迹与生成任务。
     * 逐帧只采用 worker 真实关联到的检测，不用插值补框；产物仍是待复核候选贡献，人工修订前不会导出。
     */
    private JsonObject promoteLocalTrackingCandidate(JsonObject p){
        FlowPlans.keys(p,"candidateId","timelineId","timelineVersion","confirm");
        if(!Json.bool(p,"confirm",false))throw new ApiError(400,"tracking_confirmation_required","必须明确确认后才能把本地跟踪结果写入正式轨迹生成。");
        String candidateId=Json.required(p,"candidateId"),timelineId=Json.required(p,"timelineId");
        int timelineVersion=(int)Costs.integer(p,"timelineVersion",1,Integer.MAX_VALUE);
        return store.tx(c->{
            JsonObject row=Store.one(c,"SELECT data FROM local_tracking_candidates WHERE id=?",candidateId);
            if(row==null)throw new ApiError(404,"not_found","自动跟踪候选不存在。");
            JsonObject candidate=Json.parse(Json.required(row,"data"));
            if(!timelineId.equals(Json.str(candidate,"timelineId","")))throw new ApiError(409,"tracking_candidate_scope_conflict","候选不属于当前时间轴。");
            JsonObject timeline=Store.document(c,"track_timelines",timelineId);
            if(Json.number(timeline,"version",0)!=timelineVersion)throw new ApiError(409,"track_version_conflict","时间轴已变化，请刷新后重新核对候选。");
            TrackTimelines.currentTemplate(c,timeline);
            if(!Json.bool(candidate,"candidateOnly",false)||Json.bool(candidate,"humanConfirmed",true))throw new ApiError(409,"tracking_candidate_invalid","该记录不是可提交的本地候选。");
            if(candidate.has("promotion"))throw new ApiError(409,"tracking_candidate_promoted","该候选已经提交过正式轨迹生成，请直接查看对应生成记录。");
            JsonObject raw=Json.object(candidate,"result"),template=Json.object(timeline,"template");
            Set<String> templateClasses=new LinkedHashSet<>();for(JsonElement value:Json.array(template,"classes"))templateClasses.add(Json.required(value.getAsJsonObject(),"id"));
            Map<String,JsonObject> byFrameId=new LinkedHashMap<>();for(JsonObject frame:TrackTimelines.frames(c,timelineId))byFrameId.put(Json.required(frame,"frameId"),frame);
            JsonArray issues=new JsonArray(),promotedTracks=new JsonArray();List<JsonObject> outputs=new ArrayList<>();Map<String,String> trackIds=new LinkedHashMap<>();int skippedTracks=0;
            long activeTracks=Json.number(Store.one(c,"SELECT COUNT(*) AS n FROM tracks WHERE timeline_id=? AND status='active'",timelineId),"n",0);
            // 1) 每条 worker 轨迹建立真实轨迹记录；关键帧留空，逐帧结果由生成任务实际产出，避免把预测位置冒充人工关键帧。
            for(JsonElement value:Json.array(raw,"tracks")){
                JsonObject source=value.getAsJsonObject();String sourceTrackId=Json.str(source,"trackId",""),classId=Json.str(source,"classId","");
                if(sourceTrackId.isEmpty()||!templateClasses.contains(classId)){skippedTracks++;issues.add(Json.obj("code","tracking_class_unmapped","severity","error","message","该跟踪轨迹的类别不在冻结模板中，未建立正式轨迹。","sourceTrackId",sourceTrackId,"classId",classId));continue;}
                if(activeTracks+outputs.size()>=1000){skippedTracks++;issues.add(Json.obj("code","track_limit","severity","error","message","时间轴活动轨迹已达上限，其余跟踪轨迹未建立。","sourceTrackId",sourceTrackId));continue;}
                JsonObject track=Tracks.record(timeline,classId,"本地跟踪 "+(outputs.size()+1),"local:"+sourceTrackId);
                Tracks.insert(c,track);outputs.add(track);trackIds.put(sourceTrackId,Json.required(track,"id"));
                promotedTracks.add(Json.obj("trackId",track.get("id"),"sourceTrackId",sourceTrackId,"classId",classId));
            }
            if(outputs.isEmpty())throw new ApiError(409,"tracking_promotion_empty","该候选没有任何可映射到当前模板的跟踪轨迹，未创建生成任务。");
            // 2) 逐帧把真实关联检测转换为候选贡献输入；未关联对象只记录问题，不伪造轨迹归属。
            JsonArray frozenFrames=new JsonArray(),frameIds=new JsonArray(),skipped=new JsonArray();Map<String,JsonArray> candidates=new LinkedHashMap<>();
            for(JsonObject track:outputs)candidates.put(Json.required(track,"id"),new JsonArray());
            int annotationCount=0,skippedFrames=0;
            for(JsonElement value:Json.array(raw,"frames")){
                JsonObject source=value.getAsJsonObject();String frameId=Json.str(source,"inputId","");JsonObject timelineFrame=byFrameId.get(frameId);
                if(timelineFrame==null){skippedFrames++;issues.add(Json.obj("code","tracking_frame_not_in_timeline","severity","error","message","该跟踪帧不在当前时间轴中，已跳过。","frameId",frameId));continue;}
                Map<String,JsonObject> byAnnotation=new HashMap<>();for(JsonElement item:Json.array(Json.object(source,"prediction"),"annotations")){JsonObject annotation=item.getAsJsonObject();byAnnotation.put(Json.str(annotation,"id",""),annotation);}
                JsonObject asset=TrackTimelines.current(c,timelineFrame),state=TrackTimelines.state(c,timelineFrame);boolean frameReview=Json.bool(source,"requiresTrackingReview",false);
                for(JsonElement item:Json.array(source,"associations")){
                    JsonObject association=item.getAsJsonObject();String logical=Json.str(association,"logicalTrackId",""),trackId=trackIds.get(logical),annotationId=Json.str(association,"annotationId","");
                    JsonObject annotation=annotationId.isEmpty()?null:byAnnotation.get(annotationId);
                    if(trackId==null||annotation==null)continue;
                    JsonObject entry=Json.obj("frameId",frameId,"annotations",Json.arr(annotation.deepCopy()),"source",Json.obj("intervalId","local_tracking:"+logical,"keyframeIds",new JsonArray()),"valid",true,"requiresReview",frameReview,"reviewIssues",new JsonArray());
                    try{Annotations.validate(Json.array(entry,"annotations"),asset,template);}
                    catch(ApiError failure){entry.addProperty("valid",false);entry.addProperty("requiresReview",true);Json.array(entry,"reviewIssues").add(Json.obj("code",failure.code,"severity","error","message",failure.getMessage(),"frameId",frameId));issues.add(Json.obj("code",failure.code,"severity","error","message",failure.getMessage(),"frameId",frameId,"trackId",trackId));}
                    candidates.get(trackId).add(entry);annotationCount++;
                }
                JsonObject frozen=timelineFrame.deepCopy();frozen.add("expected",state);frozen.add("baseAnnotations",TrackGenerations.baseAnnotations(asset,TrackGenerations.heads(c,Json.required(timelineFrame,"assetId"))));
                frozenFrames.add(frozen);frameIds.add(timelineFrame.get("frameId"));
            }
            // 3) 构造冻结计划并入队；沿用既有版本校验、排队和逐帧提交路径。
            JsonArray reports=new JsonArray(),outputCopies=new JsonArray(),involved=new JsonArray();
            for(JsonObject track:outputs){reports.add(Json.obj("trackId",track.get("id"),"candidates",candidates.get(Json.required(track,"id")),"intervals",new JsonArray(),"skipped",new JsonArray()));outputCopies.add(track.deepCopy());involved.add(Json.obj("id",track.get("id"),"version",track.get("version")));}
            JsonObject plan=Json.obj("timeline",timeline.deepCopy(),"owner",outputs.get(0).deepCopy(),"outputs",outputCopies,"retired",new JsonArray(),"involved",involved,"frames",frozenFrames,"frameIds",frameIds,"reports",reports,"intervals",new JsonArray(),"skipped",skipped,"issues",issues,"parameters",TrackInterpolation.options(null),"scope","affected");
            plan.addProperty("planHash",TrackTimelines.hash(plan));
            JsonObject job=trackGenerations.enqueueExternal(c,plan,null);
            String now=Json.now();candidate.add("promotion",Json.obj("generationId",job.get("id"),"promotedAt",now,"timelineVersion",timelineVersion,"trackCount",outputs.size(),"frameCount",frozenFrames.size(),"candidateAnnotationCount",annotationCount,"skippedTrackCount",skippedTracks,"skippedFrameCount",skippedFrames,"formalContributionPending",true,"requiresManualReview",true));
            candidate.addProperty("updatedAt",now);
            Store.update(c,"UPDATE local_tracking_candidates SET updated_at=?,data=? WHERE id=?",now,candidate,candidateId);
            Store.event(c,"track.local.candidate_promoted",null,null,null,Json.obj("candidateId",candidateId,"timelineId",timelineId,"generationId",job.get("id"),"trackCount",outputs.size(),"frameCount",frozenFrames.size(),"candidateAnnotationCount",annotationCount));
            return Json.obj("candidateId",candidateId,"timelineId",timelineId,"generationId",job.get("id"),"status",job.get("status"),"trackCount",outputs.size(),"frameCount",frozenFrames.size(),"candidateAnnotationCount",annotationCount,"skippedTrackCount",skippedTracks,"skippedFrameCount",skippedFrames,"tracks",promotedTracks,"issues",issues,"candidateOnly",true,"humanConfirmed",false,"requiresManualReview",true,"formalContributionCreated",false,"nextAction","生成任务已入队。请在任务中心或轨迹候选历史查看逐帧候选贡献；保存人工修订前不会导出为正式标注。");
        });
    }
    static boolean trackingReviewRequired(JsonObject raw){return Json.bool(raw,"requiresTrackingReview",false);}
    JsonObject settings(){return store.read(c->{JsonObject r=Store.one(c,"SELECT data FROM settings WHERE id='global'");return r==null?Json.obj("theme","light","globalConcurrency",8,"closeBehavior","ask"):Json.parse(r.get("data").getAsString());});}
    JsonObject resourceImage(JsonObject p){ResourceLibrary library=new ResourceLibrary(store,projects);JsonObject resource=library.get(p);if(!Json.required(resource,"kind").equals("reference"))throw new ApiError(422,"reference_invalid","只有人工参考资源包含固定图片。");JsonObject content=Json.object(resource,"content");return Json.obj("resourceId",resource.get("id"),"resourceVersion",resource.get("version"),"path",library.referencePath(content).toString(),"contentHash",content.get("contentHash"),"width",content.get("width"),"height",content.get("height"));}
    /**
     * 后台调度与关停的分步兜底。
     * 调度侧：某一步的偶发异常不应饿死同一轮里的后续步骤，更不应停掉调度线程。
     * 关停侧：任一环节关闭失败都不能跳过 store.close()，否则 SQLite 连接不关、WAL 不做 checkpoint。
     */
    private static void step(Runnable action){
        try{action.run();}
        catch(Throwable failure){StringBuilder where=new StringBuilder();for(StackTraceElement frame:failure.getStackTrace()){where.append(' ').append(frame);if(where.length()>400)break;}System.err.println("engine_step_failed:"+(failure instanceof ApiError api?api.code+" — "+api.getMessage():failure.getClass().getSimpleName()+":"+(failure.getMessage()==null?"":failure.getMessage()))+" @"+where);}
    }
    @Override public void close(){step(trainingJobs::close);step(datasetVersions::close);step(trainingRuntime::close);step(trackGenerations::close);step(mediaJobs::close);step(localRuns::close);step(flows::close);step(runs::close);step(providers::close);step(store::close);}
}
