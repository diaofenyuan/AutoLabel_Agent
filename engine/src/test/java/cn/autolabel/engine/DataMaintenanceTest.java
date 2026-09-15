package cn.autolabel.engine;

import com.google.gson.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;

final class DataMaintenanceTest {
    static void check(boolean value,String message){EngineTest.check(value,message);}
    static JsonObject cmd(Engine e,String command,JsonObject p)throws Exception{return (JsonObject)e.command(command,p);}
    static JsonObject owner(){return Json.obj("operationId","fixture-backup-1");}
    static void await(BooleanSupplier condition,String message)throws Exception{long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(8);while(!condition.getAsBoolean()&&System.nanoTime()<end)Thread.sleep(10);check(condition.getAsBoolean(),message);}
    static JsonObject ready(Engine e)throws Exception{long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(10);JsonObject state;do{state=cmd(e,"system.prepareDataMaintenance",owner());if(Json.bool(state,"ready",false))return state;Thread.sleep(20);}while(System.nanoTime()<end);throw new AssertionError("maintenance not ready: "+state);}
    static void run(Path root)throws Exception{ownershipAndRecovery(root);ownedProjectDeletion(root);inFlight(root);dispatchBarrier(root);ManualChainTest.root=root;ManualChainTest.maintenance();}
    static void ownershipAndRecovery(Path root)throws Exception{
        Path data=root.resolve("data-maintenance-owner");
        try(Engine e=new Engine(data)){
            String pid=Json.required(EngineTest.project(e,"detect"),"id");e.runs.suspend(true);
            e.store.tx(c->{for(String reason:List.of("user","budget_exhausted","result_unknown","restart")){String status=reason.equals("restart")?"running":"paused";JsonObject run=Json.obj("id",reason,"projectId",pid,"status",status,"pauseReason",reason,"total",1,"requestsUsed",0);Store.update(c,"INSERT INTO runs(id,project_id,status,data) VALUES(?,?,?,?)",reason,pid,status,run);String sampleStatus=reason.equals("result_unknown")?"unknown":"queued";Store.update(c,"INSERT INTO samples(id,run_id,asset_id,input_id,status,data) VALUES(?,?,?,?,?,?)",reason,reason,reason,reason,sampleStatus,Json.obj("asset",Json.obj("name",reason)));}Store.update(c,"INSERT INTO attempts(id,group_id,status,data) VALUES(?,?,?,?)","old-unknown","fixture","unknown",Json.obj("status","unknown"));return null;});
            ManualChainTest.rejects("invalid_argument",()->cmd(e,"system.prepareDataMaintenance",new JsonObject()));ManualChainTest.rejects("invalid_argument",()->cmd(e,"system.prepareDataMaintenance",Json.obj("operationId",5)));
            e.maintenance.enter("asset.import");
            try{JsonObject busy=cmd(e,"system.prepareDataMaintenance",owner());check(!Json.bool(busy,"ready",true)&&Json.bool(busy,"locked",false),"active command retains unready data lock");ManualChainTest.rejects("maintenance_operation_busy",()->e.maintenance.enterOwned("backup.create",owner()));}finally{e.maintenance.leave();}
            JsonObject state=ready(e);check(Json.required(state,"mode").equals("data")&&Json.bool(state,"dispatchPaused",false),"data mode and dispatch barrier exposed");JsonObject counts=Json.object(state,"counts");check(Json.integer(counts,"runningRuns",0)==4&&Json.integer(counts,"queuedSamples",0)==3&&Json.integer(counts,"unknownSamples",0)==1&&Json.integer(counts,"unknownCalls",0)==1,"pending and unknown records do not block stable maintenance");
            JsonObject other=Json.obj("operationId","another-operation");ManualChainTest.rejects("maintenance_owner_conflict",()->cmd(e,"system.prepareDataMaintenance",other));ManualChainTest.rejects("maintenance_owner_conflict",()->cmd(e,"system.cancelDataMaintenance",other));ManualChainTest.rejects("maintenance_owner_conflict",()->e.maintenance.enterOwned("backup.create",other));
            ManualChainTest.rejects("maintenance_mode_conflict",()->cmd(e,"system.prepareUpdate",new JsonObject()));ManualChainTest.rejects("maintenance_mode_conflict",()->cmd(e,"system.cancelUpdate",new JsonObject()));check(!Json.bool(cmd(e,"system.canUpdate",new JsonObject()),"canUpdate",true),"data lock cannot be reported update-ready");
            for(String command:List.of("project.create","run.create","run.resume","chat.send","system.resume"))ManualChainTest.rejects("engine_data_maintenance_locked",()->cmd(e,command,new JsonObject()));check(((JsonArray)e.command("project.list",new JsonObject())).size()==1,"reads available while data locked");
            e.maintenance.enterOwned("backup.create",owner());try{check(!Json.bool(cmd(e,"system.prepareDataMaintenance",owner()),"ready",true),"owned action visible as real activity");ManualChainTest.rejects("maintenance_operation_busy",()->e.maintenance.enterOwned("restore.prepare",owner()));ManualChainTest.rejects("maintenance_operation_busy",()->cmd(e,"system.cancelDataMaintenance",owner()));}finally{e.maintenance.leaveOwned();}
            check(Json.bool(ready(e),"ready",false),"owner permit released after file action");cmd(e,"system.cancelDataMaintenance",owner());check(Json.bool(e.runs.diagnostics(),"suspended",false)&&!Json.bool(e.runs.diagnostics(),"dataMaintenancePaused",true),"data unlock preserves independent sleep flag");check(Json.required(e.runs.get("user"),"pauseReason").equals("user")&&Json.required(e.runs.get("budget_exhausted"),"pauseReason").equals("budget_exhausted"),"maintenance preserves user and budget reasons");
        }
        try(Engine e=new Engine(data)){check(Json.required(e.runs.get("user"),"pauseReason").equals("user")&&Json.required(e.runs.get("budget_exhausted"),"pauseReason").equals("budget_exhausted")&&Json.required(e.runs.get("result_unknown"),"pauseReason").equals("result_unknown"),"restart preserves existing pause reasons");check(Json.required(e.runs.get("restart"),"pauseReason").equals("restart_review"),"only previously running run gains restart reason");check(!Json.bool(e.runs.diagnostics(),"dataMaintenancePaused",true),"process-owned maintenance flag does not survive restart");}
        try(Engine e=new Engine(root.resolve("data-update-conflict"))){check(Json.bool(cmd(e,"system.prepareUpdate",new JsonObject()),"ready",false),"update lock acquired");ManualChainTest.rejects("maintenance_mode_conflict",()->cmd(e,"system.prepareDataMaintenance",owner()));ManualChainTest.rejects("maintenance_mode_conflict",()->cmd(e,"system.cancelDataMaintenance",owner()));check(Json.bool(cmd(e,"system.canUpdate",new JsonObject()),"locked",false),"data command cannot release update lock");cmd(e,"system.cancelUpdate",new JsonObject());}
    }
    /**
     * 项目删除由桌面端在同一维护锁内发起（先备份、再级联删除），因此它必须与 backup.create 走同一条
     * 「持有维护锁的动作」通道：既不能在锁外被其它写入绕过，也不能因为锁已生效而自我拒绝。
     */
    static void ownedProjectDeletion(Path root)throws Exception{
        try(Engine e=new Engine(root.resolve("data-project-deletion"))){
            JsonObject kept=EngineTest.project(e,"detect");String keptId=Json.required(kept,"id");
            JsonObject doomed=EngineTest.project(e,"detect");String doomedId=Json.required(doomed,"id"),doomedName=Json.required(doomed,"name");
            String lock=Json.required(owner(),"operationId");
            ManualChainTest.rejects("invalid_argument",()->cmd(e,"project.delete",Json.obj("projectId",doomedId,"confirmName",doomedName)));
            ready(e);
            ManualChainTest.rejects("engine_data_maintenance_locked",()->cmd(e,"project.create",Json.obj("name","blocked","taskType","detect")));
            ManualChainTest.rejects("maintenance_owner_conflict",()->cmd(e,"project.delete",Json.obj("projectId",doomedId,"confirmName",doomedName,"operationId","another-operation")));
            JsonObject removed=cmd(e,"project.delete",Json.obj("projectId",doomedId,"confirmName",doomedName,"removeManagedFiles",true,"operationId",lock));
            check(Json.bool(removed,"deleted",false)&&Json.required(removed,"name").equals(doomedName),"owned project delete runs while the data lock is held");
            JsonArray remaining=(JsonArray)e.command("project.list",new JsonObject());
            check(remaining.size()==1&&Json.required(remaining.get(0).getAsJsonObject(),"id").equals(keptId),"cascade removes only the requested project");
            cmd(e,"system.cancelDataMaintenance",owner());
            check(((JsonArray)e.command("project.list",new JsonObject())).size()==1,"project list stays consistent after the lock is released");
        }
    }
    static JsonObject request(JsonObject provider,String pid,JsonArray ids){return Json.obj("projectId",pid,"providerId",provider.get("id"),"model","fixture","prompt","locate","assetIds",ids,"concurrency",1,"maxRequests",10,"maxRetries",0);}
    static void inFlight(Path root)throws Exception{
        try(EngineTest.Mock mock=new EngineTest.Mock();Engine e=new Engine(root.resolve("data-inflight"))){mock.slow=true;JsonObject provider=EngineTest.provider(e,mock,"responses");provider=e.providers.save(Json.obj("id",provider.get("id"),"timeoutMs",5000));String pid=Json.required(EngineTest.project(e,"detect"),"id");JsonArray ids=EngineTest.importSamples(e,pid,2);JsonObject run=cmd(e,"run.create",request(provider,pid,ids));String rid=Json.required(run,"id");await(()->mock.calls.get()==1,"first request actually reaches local server");JsonObject state=cmd(e,"system.prepareDataMaintenance",owner());check(!Json.bool(state,"ready",true)&&Json.bool(state,"locked",false)&&Json.integer(Json.object(state,"counts"),"activeCalls",0)==1,"sent request blocks ready without dropping lock");
            ready(e);JsonObject stats=Json.object(e.runs.get(rid),"statistics");check(Json.integer(stats,"succeeded",0)==1&&Json.integer(stats,"queued",0)==1&&Json.integer(stats,"requestsUsed",0)==1,"in-flight candidate saved while next sample remains queued");check(Json.integer(e.projects.asset(ids.get(0).getAsString()),"version",0)==1,"ready follows committed candidate");for(int i=0;i<8;i++)e.runs.tick();check(mock.calls.get()==1,"ready lock prevents further dispatch");cmd(e,"system.cancelDataMaintenance",owner());check(Json.required(EngineTest.waitRun(e,rid,10000),"status").equals("completed")&&mock.calls.get()==2,"unlock resumes remaining sample exactly once");}
    }
    static boolean blockedAt(String method){return Thread.getAllStackTraces().entrySet().stream().anyMatch(entry->entry.getKey().getState()==Thread.State.BLOCKED&&Arrays.stream(entry.getValue()).anyMatch(frame->frame.getClassName().equals(Runs.class.getName())&&frame.getMethodName().equals(method)));}
    static void dispatchBarrier(Path root)throws Exception{
        try(EngineTest.Mock mock=new EngineTest.Mock();Engine e=new Engine(root.resolve("data-dispatch-race"))){JsonObject provider=EngineTest.provider(e,mock,"responses");String pid=Json.required(EngineTest.project(e,"detect"),"id");JsonArray ids=EngineTest.importSamples(e,pid,1);e.runs.suspend(true);cmd(e,"run.create",request(provider,pid,ids));
            synchronized(e.providers){e.runs.suspend(false);await(()->blockedAt("execute"),"provider acquisition belongs to bounded worker after enqueue");CompletableFuture<Void> barrier=CompletableFuture.runAsync(()->e.runs.dataMaintenance(true));barrier.get(2,TimeUnit.SECONDS);check(blockedAt("execute")&&barrier.isDone(),"maintenance dispatch barrier does not wait for blocked preparation worker");}
            ready(e);int before=mock.calls.get();long attempts=e.store.read(c->Json.number(Store.one(c,"SELECT COUNT(*) AS n FROM attempts"),"n",0));check(before==0&&attempts==0,"worker sees maintenance barrier before any permit can become a sent request");for(int i=0;i<10;i++)e.runs.tick();check(mock.calls.get()==before&&e.store.read(c->Json.number(Store.one(c,"SELECT COUNT(*) AS n FROM attempts"),"n",0))==attempts,"no late claim or send crosses ready barrier");cmd(e,"system.cancelDataMaintenance",owner());}
    }
}
