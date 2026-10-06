package cn.autolabel.engine;

import com.google.gson.*;
import java.awt.image.BufferedImage;
import javax.imageio.ImageIO;
import java.nio.file.*;
import java.util.*;

/**
 * track.timeline.ensure 集成测试：为「已入库但没有时间轴」的抽帧任务批量补建。
 * 断言口径：幂等（重复调用不再新建）、只补真缺口（已有轴的任务归 existing）、
 * 非 detect/pose 项目不建轴并逐条说明、单个任务失败只跳过它自己、未入库的任务不纳入。
 */
final class TrackTimelineEnsureTest {
    static void check(boolean value,String message){EngineTest.check(value,message);}
    static JsonObject cmd(Engine e,String name,JsonObject p)throws Exception{return (JsonObject)e.command(name,p);}

    /**
     * 造一个已入库的抽帧任务：导入 count 张图并把它们标成该任务的帧。
     * declaredFrames 用于模拟「完成记录与实到帧数不符」的坏批次（只会让 createIn 报 409）；
     * committed=false 模拟产物尚未提交入库的任务；withTimeline=true 时先手动建好一条轴。
     */
    static String importedJob(Engine e,Path root,String pid,String source,int count,int declaredFrames,boolean committed,boolean withTimeline)throws Exception{
        String jobId=Json.id();Path dir=root.resolve(pid).resolve(jobId);Files.createDirectories(dir);JsonArray paths=new JsonArray();
        for(int i=0;i<count;i++){Path path=dir.resolve(i+".png");BufferedImage image=new BufferedImage(96,72,BufferedImage.TYPE_INT_RGB);image.setRGB(0,0,0xff0000+i*300+jobId.hashCode());ImageIO.write(image,"png",path.toFile());paths.add(path.toString());}
        JsonArray assets=Json.array(cmd(e,"asset.import",Json.obj("projectId",pid,"paths",paths)),"assetIds");
        e.store.tx(c->{JsonObject job=Json.obj("id",jobId,"projectId",pid,"kind","video_extract","status","completed","sourceVideoId",source,"assetsCommitted",committed,"summary",Json.obj("frameCount",declaredFrames));Store.update(c,"INSERT INTO media_jobs(id,project_id,kind,status,data) VALUES(?,?,?,?,?)",jobId,pid,"video_extract","completed",job);
            for(int i=0;i<assets.size();i++){String id=assets.get(i).getAsString();JsonObject a=Store.document(c,"assets",id),metadata=Json.object(a,"metadata");for(var entry:Json.obj("mediaJobId",jobId,"frameId","frame-"+jobId+"-"+i,"sourceVideoId",source,"videoSourceHash","a".repeat(64),"sourcePresentationIndex",i,"sourcePts",Integer.toString(i),"originPts","0","relativePts",Integer.toString(i),"timeBase",Json.obj("numerator",1,"denominator",10),"timeSeconds",i/10.0,"rangeIndex",0).entrySet())metadata.add(entry.getKey(),entry.getValue());a.add("metadata",metadata);Store.update(c,"UPDATE assets SET data=? WHERE id=?",a,id);}return null;});
        if(withTimeline)cmd(e,"track.timeline.create",Json.obj("projectId",pid,"mediaJobId",jobId));
        return jobId;
    }
    static Set<String> jobIds(JsonObject result,String field){Set<String> ids=new LinkedHashSet<>();for(JsonElement value:Json.array(result,field))ids.add(Json.required(value.getAsJsonObject(),"mediaJobId"));return ids;}
    static long timelineCount(Engine e,String pid){return e.store.<Long>read(c->Json.number(Store.one(c,"SELECT COUNT(*) AS n FROM track_timelines WHERE project_id=?",pid),"n",0));}

    static void run(Path root)throws Exception{
        supported(root);
        unsupported(root);
    }
    /** 主链路：一次补建所有缺口、第二轮幂等、坏批次单独跳过、未入库任务不纳入。 */
    static void supported(Path root)throws Exception{
        try(Engine e=new Engine(root.resolve("ensure-detect"))){
            JsonObject project=cmd(e,"project.create",Json.obj("name","补建时间轴","taskType","detect","classes",Json.arr(Json.obj("id","obj","name","对象","color","#557799"))));String pid=Json.required(project,"id");
            String existingJob=importedJob(e,root,pid,"video-existing",5,5,true,true);
            String missingA=importedJob(e,root,pid,"video-a",4,4,true,false);
            String missingB=importedJob(e,root,pid,"video-b",3,3,true,false);
            String notCommitted=importedJob(e,root,pid,"video-pending",2,2,false,false);
            String broken=importedJob(e,root,pid,"video-broken",2,9,true,false);
            check(timelineCount(e,pid)==1,"补建前的基线：只有手动建的那条轴");

            JsonObject first=cmd(e,"track.timeline.ensure",Json.obj("projectId",pid));
            check(Json.bool(first,"supported",false)&&Json.required(first,"taskType").equals("detect"),"detect 项目判定为支持轨迹时间轴");
            check(Json.array(first,"created").size()==2,"一轮恰好补建两个缺口任务，实际 "+first);
            check(jobIds(first,"created").equals(new LinkedHashSet<>(List.of(missingA,missingB))),"补建的正是缺口任务，坏批次与已入库任务都不在其中");
            check(jobIds(first,"existing").equals(Set.of(existingJob)),"已有时机的任务归入 existing，不重复建轴");
            check(Json.array(first,"skipped").size()==1&&Json.required(Json.array(first,"skipped").get(0).getAsJsonObject(),"mediaJobId").equals(broken),"帧数不符的坏批次只跳过它自己");
            check(Json.required(Json.array(first,"skipped").get(0).getAsJsonObject(),"reason").equals("track_frames_changed"),"坏批次如实带出引擎错误码");
            check(!Json.bool(first,"truncated",true),"任务数远低于单轮上限时不标截断");
            // 未入库的任务（assetsCommitted=false）不得被纳入补建，也不该出现在 skipped 里。
            check(!jobIds(first,"created").contains(notCommitted)&&!jobIds(first,"existing").contains(notCommitted)&&!jobIds(first,"skipped").contains(notCommitted),"未入库任务既不建轴也不报错");
            check(timelineCount(e,pid)==3,"补建后项目恰好三条轴");
            for(JsonElement value:Json.array(first,"created")){JsonObject timeline=value.getAsJsonObject();JsonObject loaded=cmd(e,"track.timeline.get",Json.obj("timelineId",Json.required(timeline,"id")));check(Json.required(loaded,"mediaJobId").equals(Json.required(timeline,"mediaJobId")),"补建返回的轴标识可被 get 原样取回");}

            JsonObject second=cmd(e,"track.timeline.ensure",Json.obj("projectId",pid));
            check(Json.array(second,"created").isEmpty(),"第二轮幂等：没有新缺口，不再建轴，实际 "+second);
            check(Json.array(second,"existing").size()==3,"第二轮把三条已有轴全部归入 existing");
            check(Json.array(second,"skipped").size()==1,"第二轮仍如实报告那条坏批次");
            check(timelineCount(e,pid)==3,"第二轮不新增任何轴");
        }
    }
    /** 非 detect/pose 项目：整轮不建轴，逐条给出 reason，且不落任何时间轴。 */
    static void unsupported(Path root)throws Exception{
        try(Engine e=new Engine(root.resolve("ensure-segment"))){
            JsonObject project=cmd(e,"project.create",Json.obj("name","分割项目","taskType","segment","classes",Json.arr(Json.obj("id","obj","name","对象","color","#557799"))));String pid=Json.required(project,"id");
            String job=importedJob(e,root,pid,"video-seg",3,3,true,false);
            JsonObject result=cmd(e,"track.timeline.ensure",Json.obj("projectId",pid));
            check(!Json.bool(result,"supported",true)&&Json.required(result,"taskType").equals("segment"),"segment 项目判定为不支持轨迹时间轴");
            check(Json.array(result,"created").isEmpty()&&Json.array(result,"existing").isEmpty(),"不支持时既不建轴也没有已有轴");
            check(Json.array(result,"skipped").size()==1,"不支持的任务逐条列在 skipped");
            JsonObject skip=Json.array(result,"skipped").get(0).getAsJsonObject();
            check(Json.required(skip,"mediaJobId").equals(job)&&Json.required(skip,"reason").equals("track_task_type_unsupported")&&Json.required(skip,"message").contains("segment"),"skip 带任务标识、原因码与说明当前任务类型");
            check(timelineCount(e,pid)==0,"不支持的项目一条轴也不落库");
        }
    }
}