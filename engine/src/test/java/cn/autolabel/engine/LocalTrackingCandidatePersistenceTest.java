package cn.autolabel.engine;

import com.google.gson.*;
import java.nio.file.*;

/** 离线验证本地跟踪候选落盘、只读查询和重启可见性。 */
final class LocalTrackingCandidatePersistenceTest {
    static int checks;
    static void check(boolean ok,String message){checks++;if(!ok)throw new AssertionError(message);}
    static void seed(Engine e,String projectId,String timelineId)throws Exception{
        e.store.tx(c->{
            Store.update(c,"INSERT INTO projects(id,data) VALUES(?,?)",projectId,Json.obj("id",projectId,"name","跟踪候选夹具","taskType","detect"));
            String jobId="job-1";Store.update(c,"INSERT INTO media_jobs(id,project_id,kind,status,data) VALUES(?,?,?,?,?)",jobId,projectId,"video_extract","completed",Json.obj("id",jobId,"projectId",projectId,"kind","video_extract","status","completed"));
            Store.update(c,"INSERT INTO track_timelines(id,project_id,media_job_id,template_hash,version,data) VALUES(?,?,?,?,?,?)",timelineId,projectId,jobId,"b".repeat(64),1,Json.obj("id",timelineId,"projectId",projectId,"mediaJobId",jobId,"templateHash","b".repeat(64),"version",1,"taskType","detect"));
            return null;
        });
    }
    static JsonObject raw(){return Json.obj("candidateSetId","set-1","sourceVideoId","video-1","sourceVideoHash","a".repeat(64),"templateHash","b".repeat(64),"modelHash","c".repeat(64),"requiresTrackingReview",true,"provenance",Json.obj("workerHash","d".repeat(64)),"statistics",Json.obj("frames",2,"tracks",1),"frames",Json.arr(),"tracks",Json.arr(),"trackingIssues",Json.arr());}
    static void rejects(String code,Action action)throws Exception{try{action.run();throw new AssertionError("应拒绝："+code);}catch(ApiError e){check(e.code.equals(code),"实际错误 "+e.code+"，预期 "+code);}}
    interface Action{void run()throws Exception;}
    public static void main(String[] args)throws Exception{
        Path root=Files.createTempDirectory("autolabel-local-candidate-");String timeline="timeline-1";
        try(Engine e=new Engine(root)){
            seed(e,"project-1",timeline);JsonObject request=Json.obj("sequenceId","sequence-1","sourceVideoId","video-1","sourceVideoHash","a".repeat(64),"expectedModelHash","c".repeat(64),"templateHash","b".repeat(64),"frames",Json.arr(Json.obj("inputId","frame-1")));
            JsonObject saved=e.persistLocalTrackingCandidate(timeline,request,raw());String candidateId=Json.required(saved,"candidateId");
            check(Json.bool(saved,"candidateOnly",false)&&!Json.bool(saved,"humanConfirmed",true),"保存结果保持候选态");check(Json.object(saved,"request").has("sequenceId")&&Json.object(saved,"result").has("sourceVideoHash"),"完整请求和 worker 结果快照落盘");check(Json.required(saved,"workerHash").length()==64,"来源 worker 指纹落盘");
            JsonObject got=(JsonObject)e.command("track.local.sequence.get",Json.obj("candidateId",candidateId));check(Json.required(got,"candidateId").equals(candidateId)&&Json.bool(Json.object(got,"result"),"requiresTrackingReview",false),"只读 get 返回原始复核语义");
            JsonObject page=(JsonObject)e.command("track.local.sequence.list",Json.obj("timelineId",timeline,"limit",100));check(Json.integer(page,"total",0)==1&&Json.array(page,"items").size()==1,"只读 list 返回候选");
            rejects("tracking_confirmation_required",()->e.command("track.local.sequence.confirm",Json.obj("candidateId",candidateId,"timelineId",timeline,"timelineVersion",1,"confirm",false)));
            JsonObject confirmation=(JsonObject)e.command("track.local.sequence.confirm",Json.obj("candidateId",candidateId,"timelineId",timeline,"timelineVersion",1,"confirm",true));
            check(Json.required(confirmation,"status").equals("manual_review_required")&&Json.bool(confirmation,"candidateOnly",false)&&!Json.bool(confirmation,"humanConfirmed",true),"确认只进入人工复核，不伪造正式贡献");
            check(!Json.bool(confirmation,"formalContributionCreated",true)&&Json.required(confirmation,"nextAction").contains("关键帧"),"确认结果保留正式提交的下一步");
            JsonObject repeated=(JsonObject)e.command("track.local.sequence.confirm",Json.obj("candidateId",candidateId,"timelineId",timeline,"timelineVersion",1,"confirm",true));
            check(Json.required(repeated,"confirmedAt").equals(Json.required(confirmation,"confirmedAt")),"重复确认幂等保留原确认时间");
            rejects("track_version_conflict",()->e.command("track.local.sequence.confirm",Json.obj("candidateId",candidateId,"timelineId",timeline,"timelineVersion",2,"confirm",true)));
            JsonObject confirmed=(JsonObject)e.command("track.local.sequence.get",Json.obj("candidateId",candidateId));check(Json.object(confirmed,"confirmation").has("confirmedAt")&&!Json.bool(confirmed,"humanConfirmed",true),"重读候选保留人工复核状态且仍未确认正式标注");
        }
        try(Engine reopened=new Engine(root)){
            JsonObject page=(JsonObject)reopened.command("track.local.sequence.list",Json.obj("timelineId",timeline));check(Json.integer(page,"total",0)==1,"重启后候选仍可查询");
        }finally{delete(root);}
        System.out.println("LocalTrackingCandidatePersistenceTest passed: "+checks+" checks; no network");
    }
    static void delete(Path path)throws Exception{if(!Files.exists(path))return;try(var stream=Files.walk(path)){stream.sorted((a,b)->b.compareTo(a)).forEach(value->{try{Files.deleteIfExists(value);}catch(Exception ignored){}});}}
}
