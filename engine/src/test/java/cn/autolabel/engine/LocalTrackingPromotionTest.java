package cn.autolabel.engine;

import com.google.gson.*;
import java.nio.file.*;
import java.util.*;

/**
 * 离线验证本地 Detect 跟踪候选提升为正式轨迹与生成任务：真实入队、候选贡献落库、人工保护与复核语义。
 * 夹具复用 TrackIntegrationTest 的固定时间轴构造，避免重复维护同一套 9 帧基准图。
 */
final class LocalTrackingPromotionTest {
    static int checks;static Path root;static JsonObject timeline;static JsonArray frames;
    interface Action{void run()throws Exception;}
    static void check(boolean value,String message){checks++;if(!value)throw new AssertionError(message);}
    static JsonObject cmd(Engine e,String command,JsonObject p)throws Exception{return (JsonObject)e.command(command,p);}
    static void rejects(String code,Action action)throws Exception{try{action.run();throw new AssertionError("Expected "+code);}catch(ApiError e){check(code.equals(e.code),code+" != "+e.code);}}
    static JsonObject frame(int n){return frames.get(n).getAsJsonObject();}
    static JsonObject asset(Engine e,int n)throws Exception{return cmd(e,"asset.get",Json.obj("assetId",frame(n).get("assetId")));}
    static JsonObject box(String id,double x){return Json.obj("id",id,"classId","obj","type","detect","bbox",Json.obj("x",x,"y",10,"width",15,"height",20));}
    static long count(Engine e,String sql,Object... args)throws Exception{return e.store.<Long>read(c->Json.number(Store.one(c,sql,args),"n",0));}
    static boolean hasIssue(JsonObject result,String code){for(JsonElement value:Json.array(result,"issues"))if(Json.required(value.getAsJsonObject(),"code").equals(code))return true;return false;}
    static JsonObject await(Engine e,String generationId)throws Exception{for(int i=0;i<800;i++){JsonObject value=cmd(e,"track.generation.get",Json.obj("generationId",generationId));if(!Set.of("queued","running","cancelling").contains(Json.required(value,"status")))return value;Thread.sleep(20);}throw new AssertionError("generation timeout");}

    /** 两段真实关联检测：t1 覆盖全部帧（第 5 帧几何越界），t2 只出现在前 3 帧，第 3 帧带 worker 复核标记。 */
    static JsonObject workerResult()throws Exception{
        JsonArray workerFrames=new JsonArray(),tracks=new JsonArray(),t1observations=new JsonArray(),t2observations=new JsonArray();
        for(int n=0;n<9;n++){
            JsonArray annotations=new JsonArray(),associations=new JsonArray();String first="t1-"+n;
            annotations.add(box(first,n==5?1e6:10+n*3));associations.add(Json.obj("annotationId",first,"logicalTrackId","t1","pts",Integer.toString(n),"sourceDetectionIndex",0));
            t1observations.add(Json.obj("inputId","frame-"+n,"annotationId",first,"pts",Integer.toString(n)));
            if(n<3){String second="t2-"+n;annotations.add(box(second,50+n*2));associations.add(Json.obj("annotationId",second,"logicalTrackId","t2","pts",Integer.toString(n),"sourceDetectionIndex",1));t2observations.add(Json.obj("inputId","frame-"+n,"annotationId",second,"pts",Integer.toString(n)));}
            workerFrames.add(Json.obj("inputId","frame-"+n,"assetId",frame(n).get("assetId"),"pts",Integer.toString(n),"timeBase",Json.obj("numerator",1,"denominator",10),"sceneId","one",
                "prediction",Json.obj("annotations",annotations),"associations",associations,"trackingIssues",new JsonArray(),"requiresTrackingReview",n==3,"confirmed",false));
        }
        tracks.add(Json.obj("trackId","t1","source","local_tracking","segmentIndex",0,"classId","obj","confirmed",false,"observations",t1observations));
        tracks.add(Json.obj("trackId","t2","source","local_tracking","segmentIndex",1,"classId","obj","confirmed",false,"observations",t2observations));
        return Json.obj("candidateSetId","set-1","sourceVideoId",timeline.get("sourceVideoId"),"sourceVideoHash","a".repeat(64),"templateHash",timeline.get("templateHash"),
            "modelHash","c".repeat(64),"source","local_tracking","taskType","detect","confirmed",false,"requiresTrackingReview",true,
            "provenance",Json.obj("workerHash","d".repeat(64)),"statistics",Json.obj("frames",9,"tracks",2,"associatedDetections",12,"unassociatedDetections",0),
            "frames",workerFrames,"tracks",tracks,"trackingIssues",new JsonArray());
    }
    static JsonObject request(){return Json.obj("sequenceId","sequence-1","sourceVideoId",timeline.get("sourceVideoId"),"sourceVideoHash","a".repeat(64),"expectedModelHash","c".repeat(64),"templateHash",timeline.get("templateHash"));}
    static JsonObject promote(Engine e,String candidateId)throws Exception{return cmd(e,"track.local.sequence.promote",Json.obj("candidateId",candidateId,"timelineId",timeline.get("id"),"timelineVersion",timeline.get("version"),"confirm",true));}

    public static void main(String[] args)throws Exception{
        root=Path.of("engine/build/verification/tracking-promotion-"+System.currentTimeMillis()).toAbsolutePath();Files.createDirectories(root);
        Path data=root.resolve("data");
        try(Engine e=new Engine(data)){
            TrackIntegrationTest.root=root;TrackIntegrationTest.setup(e,"detect",false);
            timeline=TrackIntegrationTest.timeline;frames=TrackIntegrationTest.frames;
            // 第 1 帧先有人工确认标注，验证生成任务必须保留人工版本。
            cmd(e,"annotation.save",Json.obj("assetId",frame(1).get("assetId"),"baseVersion",0,"annotations",Json.arr(box("human-1",70)),"confirm",true));
            String candidateId=Json.required(e.persistLocalTrackingCandidate(Json.required(timeline,"id"),request(),workerResult()),"candidateId");
            check(count(e,"SELECT COUNT(*) AS n FROM track_generations")==0,"候选落盘本身不创建生成任务");
            rejects("tracking_confirmation_required",()->cmd(e,"track.local.sequence.promote",Json.obj("candidateId",candidateId,"timelineId",timeline.get("id"),"timelineVersion",timeline.get("version"))));
            rejects("track_version_conflict",()->cmd(e,"track.local.sequence.promote",Json.obj("candidateId",candidateId,"timelineId",timeline.get("id"),"timelineVersion",Json.integer(timeline,"version",0)+1,"confirm",true)));
            JsonObject promoted=promote(e,candidateId);
            check(Json.required(promoted,"status").equals("queued"),"提升后进入真实生成队列");
            check(Json.integer(promoted,"trackCount",0)==2&&Json.integer(promoted,"frameCount",0)==9,"按 worker 轨迹建立正式轨迹并冻结全部帧");
            check(Json.bool(promoted,"candidateOnly",false)&&!Json.bool(promoted,"humanConfirmed",true)&&!Json.bool(promoted,"formalContributionCreated",true),"提升结果仍属候选态");
            String generationId=Json.required(promoted,"generationId");
            check(count(e,"SELECT COUNT(*) AS n FROM tracks WHERE status='active'")==2,"正式轨迹已持久化");
            check(count(e,"SELECT COUNT(*) AS n FROM track_generation_plans WHERE generation_id=?",generationId)==1,"冻结计划独立落盘");
            rejects("tracking_candidate_promoted",()->promote(e,candidateId));
            JsonObject done=await(e,generationId);
            check(Set.of("completed","completed_with_errors").contains(Json.required(done,"status")),"生成任务实际执行完毕："+done.get("status"));
            // 第 1 帧受人工保护不产生贡献；第 5 帧越界候选保留原始对象但不采用。贡献 10 条，当前贡献头 9 条。
            check(count(e,"SELECT COUNT(*) AS n FROM track_contributions WHERE generation_id=?",generationId)==10,"逐帧候选贡献写入贡献表");
            check(count(e,"SELECT COUNT(*) AS n FROM track_contribution_heads")==9,"只有可采用候选进入当前贡献头");
            check(count(e,"SELECT COUNT(*) AS n FROM attempts")==0,"提升不产生任何模型请求");
            JsonObject fourth=asset(e,4);
            check(Json.array(fourth,"annotations").size()==1&&Json.required(Json.array(fourth,"annotations").get(0).getAsJsonObject(),"classId").equals("obj"),"第 4 帧得到真实跟踪候选");
            check(Json.required(fourth,"status").equals("candidate")&&Json.required(fourth,"source").equals("track"),"候选来源标记为轨迹生成");
            check(Json.required(Json.object(fourth,"metadata"),"trackGenerationId").equals(generationId),"素材绑定本次生成标识");
            check(!Json.bool(Json.object(fourth,"metadata"),"requiresTrackReview",false),"规则通过的帧不额外要求复核");
            check(Json.bool(Json.object(asset(e,3),"metadata"),"requiresTrackReview",false),"worker 标记的帧保留复核要求");
            JsonObject human=asset(e,1);
            check(Json.array(human,"annotations").size()==1&&Json.required(Json.array(human,"annotations").get(0).getAsJsonObject(),"id").equals("human-1"),"人工确认帧保持原标注");
            check(Json.required(human,"status").equals("confirmed"),"人工确认状态不被候选覆盖");
            JsonObject blocked=asset(e,5);
            check(Json.array(blocked,"annotations").isEmpty()&&Json.bool(Json.object(blocked,"metadata"),"requiresTrackReview",false),"越界候选不写入正式标注但仍要求复核");
            Map<String,String> statuses=new HashMap<>();for(JsonElement value:Json.array(cmd(e,"track.generation.results",Json.obj("generationId",generationId,"section","frames","limit",100)),"items")){JsonObject item=value.getAsJsonObject();statuses.put(Json.required(item,"frameId"),Json.required(item,"status"));}
            check("protected".equals(statuses.get("frame-1")),"人工帧在生成结果中标记为受保护");
            check("blocked".equals(statuses.get("frame-5")),"越界几何帧在生成结果中标记为阻断");
            JsonObject guarded=cmd(e,"export.preflight",Json.obj("projectId",timeline.get("projectId"),"assetIds",Json.arr(frame(3).get("assetId"))));
            check(!Json.bool(Json.object(guarded,"summary"),"canExport",true)&&hasIssue(guarded,"track_review_required"),"待复核轨迹候选阻断导出并给出原因");
            JsonObject passable=cmd(e,"export.preflight",Json.obj("projectId",timeline.get("projectId"),"assetIds",Json.arr(frame(4).get("assetId"))));
            check(Json.bool(Json.object(passable,"summary"),"canExport",false),"规则通过的候选帧仍可通过格式校验");
            check(Json.required(Json.object(cmd(e,"track.local.sequence.get",Json.obj("candidateId",candidateId)),"promotion"),"generationId").equals(generationId),"候选记录保留提升来源");
        }
        try(Engine e=new Engine(data)){
            check(count(e,"SELECT COUNT(*) AS n FROM tracks WHERE status='active'")==2,"重启后正式轨迹保持");
            check(count(e,"SELECT COUNT(*) AS n FROM track_contributions")==10,"重启后候选贡献保持");
            check(Json.required(cmd(e,"asset.get",Json.obj("assetId",frame(1).get("assetId"))),"status").equals("confirmed"),"重启后人工版本保持");
        }
        System.out.println("LocalTrackingPromotionTest passed: "+checks+" checks; no network");
    }
}
