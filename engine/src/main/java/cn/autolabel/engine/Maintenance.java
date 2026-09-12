package cn.autolabel.engine;

import com.google.gson.*;
import java.util.HashSet;
import java.util.Set;

final class Maintenance {
    private static final Set<String> READ_ONLY=Set.of("project.list","project.open","asset.list","asset.get","annotation.history","export.preflight","export.list","export.compare","provider.list","provider.capabilities","run.list","run.get","run.attempts","budget.get","event.list","event.snapshot","resource.list","settings.get","diagnostics.get","asset.checkLocations","evaluationSet.list","evaluationSet.get","evaluationSet.getTruth","evaluation.preflight","evaluation.list","evaluation.get","evaluation.results","review.list","budget.estimate","evaluation.rerun.preflight","evaluation.rerun.get","resource.get","resource.image","backup.inspect");
    private static final Set<String> DATA_ACTIONS=Set.of("backup.create","restore.prepare");
    private final Engine engine;
    private String mode,operationId;
    private final Set<String> cancelledOperations=new HashSet<>();
    private int activeCommands,ownedActions;
    Maintenance(Engine engine){this.engine=engine;}
    synchronized boolean enter(String command){
        if(Set.of("track.timeline.list","track.timeline.get","track.timeline.frames","track.list","track.get","track.keyframe.list","track.generate.preview","track.generation.get","track.generation.list","track.generation.results").contains(command))return false;
        if(READ_ONLY.contains(command)||Set.of("flow.capabilities","flow.preflight","flow.get","flow.list","flow.artifact","local.runtime.get","local.model.get","local.model.list","local.model.resolve","run.result.get","flow.input.image","media.runtime.get","media.job.get","media.job.list","media.video.frames","media.screening.result").contains(command))return false;
        if(mode!=null)throw new ApiError(423,mode.equals("data")?"engine_data_maintenance_locked":"engine_update_locked",mode.equals("data")?"引擎正在维护数据，暂不接受新的写入或模型调用。":"引擎正在准备安装更新，暂不接受新的写入或模型调用。");
        activeCommands++;return true;
    }
    synchronized void leave(){activeCommands--;}
    private JsonObject counts(boolean data){
        JsonObject counts=engine.store.read(c->Json.obj(
            "runningRuns",Store.one(c,"SELECT COUNT(*) AS n FROM runs WHERE status NOT IN ('completed','completed_with_errors','cancelled')").get("n"),
            "activeSamples",Store.one(c,data?"SELECT COUNT(*) AS n FROM samples WHERE status IN ('preparing','sending','waiting','parsing','validating','saving')":"SELECT COUNT(*) AS n FROM samples WHERE status NOT IN ('succeeded','failed','cancelled')").get("n"),
            "activeCalls",Store.one(c,"SELECT COUNT(*) AS n FROM attempts WHERE status='sent'").get("n"),
            "unknownCalls",Store.one(c,"SELECT COUNT(*) AS n FROM attempts WHERE status='unknown'").get("n"),
            "writingExports",Store.one(c,"SELECT COUNT(*) AS n FROM exports WHERE json_extract(data,'$.status')='writing'").get("n"),
            "queuedSamples",Store.one(c,"SELECT COUNT(*) AS n FROM samples WHERE status IN ('queued','retry_wait')").get("n"),
            "unknownSamples",Store.one(c,"SELECT COUNT(*) AS n FROM samples WHERE status='unknown'").get("n")));
        counts.addProperty("activeCommands",activeCommands);counts.addProperty("ownedActions",ownedActions);counts.add("pendingChats",engine.providers.activity());
        JsonObject queue=engine.runs.diagnostics();counts.add("executingWorkers",queue.get("activeWorkers"));counts.add("queuedWorkers",queue.get("queuedInMemory"));JsonObject flowQueue=engine.flows.diagnostics();counts.add("executingFlowWorkers",flowQueue.get("activeWorkers"));counts.add("queuedFlowWorkers",flowQueue.get("queuedInMemory"));
        long unfinishedFlows=engine.store.read(c->Json.number(Store.one(c,"SELECT COUNT(*) AS n FROM flow_runs WHERE status NOT IN ('completed','completed_with_errors','cancelled')"),"n",0));counts.addProperty("unfinishedFlows",unfinishedFlows);counts.addProperty("activeLocalSlots",engine.localRuntime.active());counts.add("activeMediaWorkers",engine.mediaJobs.diagnostics().get("activeWorkers"));counts.addProperty("unfinishedMediaJobs",engine.store.<Long>read(c->Json.number(Store.one(c,"SELECT COUNT(*) AS n FROM media_jobs WHERE status IN ('queued','running','cancelling')"),"n",0)));counts.addProperty("activeTrackWorkers",engine.trackGenerations.active());counts.addProperty("unfinishedTrackGenerations",engine.store.<Long>read(c->Json.number(Store.one(c,"SELECT COUNT(*) AS n FROM track_generations WHERE status IN ('queued','running','cancelling')"),"n",0)));return counts;
    }
    private JsonObject state(boolean data){
        JsonObject counts=counts(data);JsonArray reasons=new JsonArray();
        for(var entry:counts.entrySet())if(!Set.of("unknownCalls","queuedSamples","unknownSamples").contains(entry.getKey())&&!(data&&Set.of("runningRuns","unfinishedFlows","unfinishedMediaJobs","unfinishedTrackGenerations").contains(entry.getKey()))&&entry.getValue().getAsLong()>0)reasons.add(entry.getKey());
        if(engine.store.writeFailed)reasons.add("storage_write_failed");boolean ready=reasons.isEmpty();
        return Json.obj("ready",ready,"canUpdate",!data&&ready,"mode",mode,"operationId",operationId,"locked",mode!=null,"dispatchPaused",data,"counts",counts,"activeRuns",counts.get("runningRuns"),"activeAttempts",counts.get("activeCalls"),"activeCommands",activeCommands,"reasons",reasons,"message",ready?"引擎已空闲。":data?"正在等待进行中的数据操作和调用保存；排队及未知结果记录会保留。":"仍有未结束任务或进行中的数据操作，请先处理。");
    }
    synchronized JsonObject status(){
        JsonObject status=state("data".equals(mode));
        if("data".equals(mode)){status.addProperty("ready",false);status.addProperty("canUpdate",false);Json.array(status,"reasons").add("data_maintenance");status.addProperty("message","数据维护锁尚未释放，不能安装更新。");}
        return status;
    }
    synchronized JsonObject prepare(){
        if("data".equals(mode))throw modeConflict();
        // 与命令入场共用同一把锁，先封闭写入口，再全量核对数据库及执行资源。
        mode="update";try{JsonObject status=state(false);if(!Json.bool(status,"ready",false))mode=null;status.addProperty("locked",mode!=null);status.add("mode",Json.element(mode));return status;}
        catch(RuntimeException e){mode=null;throw e;}
    }
    synchronized JsonObject cancel(){if("data".equals(mode))throw modeConflict();mode=null;return Json.obj("released",true,"locked",false,"mode",null);}
    synchronized JsonObject prepareData(JsonObject p){
        String requested=operationId(p);if(cancelledOperations.contains(requested))throw new ApiError(409,"maintenance_operation_cancelled","该维护操作已取消，请使用新的操作标识。");if(mode!=null&&!mode.equals("data"))throw modeConflict();
        if(mode!=null&&!requested.equals(operationId))throw ownerConflict();
        if(mode==null){
            mode="data";operationId=requested;
            // 先关闭命令入口，再等待当前分派完成认领与入队；之后的零活动检查才具有屏障含义。
            engine.runs.dataMaintenance(true);
        }
        return state(true);
    }
    synchronized JsonObject cancelData(JsonObject p){
        String requested=operationId(p);
        // 取消可能先于超时的 prepare 到达；会话内保留终态，迟到请求不能重新取得锁。
        if(mode==null){cancelledOperations.add(requested);return Json.obj("released",true,"locked",false,"mode",null);}
        requireOwner(requested);
        if(ownedActions>0)throw new ApiError(409,"maintenance_operation_busy","数据维护操作仍在执行，请等待完成后释放锁。");
        engine.runs.dataMaintenance(false);cancelledOperations.add(requested);mode=null;operationId=null;return Json.obj("released",true,"locked",false,"mode",null);
    }
    synchronized void enterOwned(String command,JsonObject p){
        if(!DATA_ACTIONS.contains(command))throw new IllegalArgumentException();requireOwner(operationId(p));
        JsonObject status=state(true);if(!Json.bool(status,"ready",false))throw new ApiError(409,"maintenance_operation_busy","数据维护尚未就绪或已有维护操作正在执行。",status);
        ownedActions++;
    }
    synchronized void leaveOwned(){ownedActions--;}
    private void requireOwner(String requested){if(!"data".equals(mode))throw modeConflict();if(!requested.equals(operationId))throw ownerConflict();}
    private static String operationId(JsonObject p){
        JsonElement value=p.get("operationId");if(value==null||!value.isJsonPrimitive()||!value.getAsJsonPrimitive().isString()||!value.getAsString().matches("[A-Za-z0-9_-]{1,128}"))throw new ApiError(400,"invalid_argument","operationId 必须为 1～128 个字母、数字、下划线或连字符。");return value.getAsString();
    }
    private static ApiError modeConflict(){return new ApiError(409,"maintenance_mode_conflict","当前维护锁类型与该操作不符，请先完成并释放原维护操作。");}
    private static ApiError ownerConflict(){return new ApiError(409,"maintenance_owner_conflict","该数据维护锁属于另一操作，不能接管或释放。");}
}
