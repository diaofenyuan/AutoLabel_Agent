package cn.autolabel.engine;

import com.google.gson.*;
import java.nio.file.*;
import java.util.*;

/**
 * 离线验证系统休眠与唤醒协调：休眠只停止新分派，唤醒核对持久化状态且不自动重发未知请求。
 * 覆盖轨迹生成排队、用户暂停运行、结果未知样本与事件游标；夹具复用 TrackIntegrationTest 的固定时间轴。
 */
final class SuspendResumeTest {
    static int checks;static Path root;static JsonObject timeline;static JsonArray frames;
    static void check(boolean value,String message){checks++;if(!value)throw new AssertionError(message);}
    static JsonObject cmd(Engine e,String command,JsonObject p)throws Exception{return (JsonObject)e.command(command,p);}
    static long count(Engine e,String sql,Object... args)throws Exception{return e.store.<Long>read(c->Json.number(Store.one(c,sql,args),"n",0));}
    static String column(Engine e,String table,String name,String id)throws Exception{return e.store.<String>read(c->Json.required(Store.one(c,"SELECT "+name+" AS n FROM "+table+" WHERE id=?",id),"n"));}
    public static void main(String[] args)throws Exception{
        root=Path.of("engine/build/verification/suspend-resume-"+System.currentTimeMillis()).toAbsolutePath();Files.createDirectories(root);
        Path data=root.resolve("data");String runId=Json.id(),sampleId=Json.id();
        try(Engine e=new Engine(data)){
            TrackIntegrationTest.root=root;TrackIntegrationTest.setup(e,"detect",false);
            timeline=TrackIntegrationTest.timeline;frames=TrackIntegrationTest.frames;String assetId=Json.required(frames.get(0).getAsJsonObject(),"assetId");
            // 夹具：休眠前已存在的一条用户暂停运行与一个结果未知样本。
            e.store.tx(c->{
                JsonObject run=Json.obj("id",runId,"projectId",timeline.get("projectId"),"name","休眠夹具","kind","api","status","paused","pauseReason","user","createdAt",Json.now());
                Store.update(c,"INSERT INTO runs(id,project_id,status,data) VALUES(?,?,?,?)",runId,Json.required(timeline,"projectId"),"paused",run);
                JsonObject sample=Json.obj("id",sampleId,"assetId",assetId,"name","unknown-fixture");
                Store.update(c,"INSERT INTO samples(id,run_id,asset_id,input_id,status,next_at,data) VALUES(?,?,?,?,?,?,?)",sampleId,runId,assetId,assetId,"unknown",0,sample);
                return null;});
            long beforeSuspend=e.store.<Long>read(Store::cursor);
            JsonObject suspended=cmd(e,"system.suspend",new JsonObject());
            check(Json.bool(suspended,"suspended",false)&&Json.bool(suspended,"stopsNewDispatch",false),"休眠明确停止新分派");
            check(Json.array(suspended,"subsystems").asList().stream().anyMatch(value->value.getAsString().equals("track_generations"))&&
                Json.array(suspended,"subsystems").asList().stream().anyMatch(value->value.getAsString().equals("media_jobs")),"休眠覆盖轨迹生成与媒体子系统");
            check(Json.bool(suspended,"unknownResultsNotRetried",false)&&Json.number(suspended,"inFlightRequests",0)==0,"休眠报告在途请求且声明不重发未知结果");
            check(!e.runs.dispatchAllowed(),"休眠期间分派被关闭");
            // 休眠期间新建的生成任务必须保持排队，不能抢跑。
            JsonObject track=cmd(e,"track.create",Json.obj("timelineId",timeline.get("id"),"timelineVersion",timeline.get("version"),"classId","obj","name","休眠夹具"));
            JsonObject queued=cmd(e,"track.generate",Json.obj("trackId",track.get("id"),"baseVersion",track.get("version"),"timelineVersion",timeline.get("version"),"scope","all"));
            Thread.sleep(500);
            check(Json.required(cmd(e,"track.generation.get",Json.obj("generationId",queued.get("id"))),"status").equals("queued"),"休眠期间不启动新的生成任务");
            Thread.sleep(150);
            JsonObject resumed=cmd(e,"system.resume",new JsonObject());
            check(!Json.bool(resumed,"suspended",true)&&e.runs.dispatchAllowed(),"唤醒后恢复分派");
            check(Json.number(resumed,"suspendedMs",-1)>=100,"休眠时长被单独记录");
            JsonObject report=Json.object(resumed,"checks");
            check(Json.required(report,"database").equals("ok"),"唤醒核对数据库可读");
            check(Json.number(report,"eventSequence",0)>=beforeSuspend,"唤醒核对事件游标未回退");
            check(Json.number(report,"unknownResults",0)==1&&Json.number(report,"pausedRuns",0)==1,"唤醒核对未知结果与暂停运行数量");
            check(!Json.bool(resumed,"autoResumedPausedRuns",true)&&!Json.bool(resumed,"autoResentUnknownRequests",true),"唤醒不自动解除暂停或重发未知请求");
            check("unknown".equals(column(e,"samples","status",sampleId)),"结果未知样本唤醒后保持未知");
            check(count(e,"SELECT COUNT(*) AS n FROM attempts WHERE sample_id=?",sampleId)==0,"唤醒未为未知样本产生新尝试");
            check(count(e,"SELECT attempt_count AS n FROM samples WHERE id=?",sampleId)==0,"未知样本尝试计数未被改写");
            check("paused".equals(column(e,"runs","status",runId)),"用户暂停的运行唤醒后保持暂停");
            check(e.store.<String>read(c->Json.str(Json.parse(Json.required(Store.one(c,"SELECT data FROM runs WHERE id=?",runId),"data")),"pauseReason","")).equals("user"),"暂停原因保持为用户主动暂停");
            check(Json.required(TrackIntegrationTest.await(e,Json.obj("id",queued.get("id"))),"status").equals("completed"),"唤醒后排队任务按原状态继续完成");
            JsonArray events=e.store.read(c->Store.events(c,beforeSuspend-1,null,null,null,2000));
            boolean sawSuspend=false,sawResume=false,ordered=true;long previous=0;
            for(JsonElement value:events){JsonObject event=value.getAsJsonObject();long sequence=Json.number(event,"sequence",0);ordered&=sequence>previous;previous=sequence;String type=Json.str(event,"type","");sawSuspend|=type.equals("engine.suspended");sawResume|=type.equals("engine.resumed");}
            check(sawSuspend&&sawResume,"休眠与唤醒事件进入持久事件流");
            check(ordered,"事件序号严格递增，可用于断线补齐");
            check(Json.number(cmd(e,"event.snapshot",new JsonObject()),"sequence",0)>=previous,"状态快照游标覆盖已提交事件");
        }
        System.out.println("SuspendResumeTest passed: "+checks+" checks; no network");
    }
}
