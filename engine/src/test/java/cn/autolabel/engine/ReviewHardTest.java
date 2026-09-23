package cn.autolabel.engine;

import com.google.gson.*;
import java.nio.file.Path;
import java.util.*;

/**
 * 难例优先队列与建议回流（第 15 步）。
 * 断言口径：hard 队列按优先级降序（低置信在前、geometryIssues 加权）；
 * 两张建议卡只建议不自动改——阈值只回显建议值，送训练只给清单。
 */
final class ReviewHardTest {
    static void check(boolean value,String message){EngineTest.check(value,message);}
    static JsonObject cmd(Engine e,String name,JsonObject p)throws Exception{return (JsonObject)e.command(name,p);}
    static JsonObject annotation(String id,double x,double confidence){return Json.obj("id",id,"type","detect","classId","item","confidence",confidence,"bbox",Json.obj("x",x,"y",180,"width",120,"height",100));}

    static void run(Path root)throws Exception{
        formula();
        queue(root);
    }
    /** 优先级公式单测：低置信在前、geometryIssues/复核标记加权、漏检重于多检。 */
    static void formula(){
        double lowOnly=Reviews.hardPriority(Json.obj("minConfidence",0.1,"geometryIssues",0,"requiresGeometryReview",false,"missedObjects",0,"extraObjects",0));
        double geometry=Reviews.hardPriority(Json.obj("minConfidence",1,"geometryIssues",2,"requiresGeometryReview",false,"missedObjects",0,"extraObjects",0));
        double reviewFlag=Reviews.hardPriority(Json.obj("minConfidence",1,"geometryIssues",0,"requiresGeometryReview",true,"missedObjects",0,"extraObjects",0));
        double missed=Reviews.hardPriority(Json.obj("minConfidence",1,"geometryIssues",0,"requiresGeometryReview",false,"missedObjects",1,"extraObjects",0));
        double extra=Reviews.hardPriority(Json.obj("minConfidence",1,"geometryIssues",0,"requiresGeometryReview",false,"missedObjects",0,"extraObjects",1));
        double clean=Reviews.hardPriority(Json.obj("minConfidence",1,"geometryIssues",0,"requiresGeometryReview",false,"missedObjects",0,"extraObjects",0));
        check(Math.abs(lowOnly-0.9)<1e-9&&Math.abs(clean)<1e-9,"低置信按 1-置信度进入优先级");
        check(Math.abs(geometry-1.0)<1e-9&&geometry>lowOnly,"每个 geometryIssues 加权 0.5，两项几何问题高于仅低置信");
        check(Math.abs(reviewFlag-0.5)<1e-9,"requiresGeometryReview 同样加权 0.5");
        check(Math.abs(missed-0.4)<1e-9&&Math.abs(extra-0.2)<1e-9&&missed>extra,"评测漏检重于多检");
    }
    /** 集成：真实评测链路产出的 hard 队列按优先级降序，且建议卡只建议不自动改。 */
    static void queue(Path root)throws Exception{
        try(Engine e=new Engine(root.resolve("review-hard-data"))){
            JsonObject project=cmd(e,"project.create",Json.obj("name","难例队列","taskType","detect","classes",Json.arr(Json.obj("id","item","name","物体"))));String pid=Json.required(project,"id");
            java.nio.file.Files.createDirectories(root.resolve("review-hard-images"));
            JsonArray ids=new JsonArray();
            // 三张图必须内容各异：相同像素会被素材导入按内容去重，测试就只剩一个素材。
            for(int i=0;i<3;i++){java.awt.image.BufferedImage image=new java.awt.image.BufferedImage(400,360,java.awt.image.BufferedImage.TYPE_INT_RGB);image.setRGB(i,i,0x334455+i*0x101010);javax.imageio.ImageIO.write(image,"png",root.resolve("review-hard-images").resolve("hard-"+i+".png").toFile());}
            // 三张素材：高置信命中 / 低置信命中+多检 / 漏检。
            JsonArray created=Json.array(cmd(e,"asset.import",Json.obj("projectId",pid,"paths",Json.arr(root.resolve("review-hard-images").resolve("hard-0.png").toString(),root.resolve("review-hard-images").resolve("hard-1.png").toString(),root.resolve("review-hard-images").resolve("hard-2.png").toString()))),"assetIds");
            for(JsonElement id:created)ids.add(id);
            List<JsonArray> predictions=List.of(
                Json.arr(annotation("p-confident",220,0.95)),
                Json.arr(annotation("p-low",220,0.30),annotation("p-extra",260,0.20)),
                new JsonArray());
            String runId=EvaluationTest.fixtureRun(e,pid,ids,predictions,new JsonArray());
            JsonObject set=cmd(e,"evaluationSet.create",Json.obj("projectId",pid,"name","难例真值","assetIds",ids));int revision=1;
            for(JsonElement id:ids)revision=Json.integer(cmd(e,"evaluationSet.saveTruth",Json.obj("setId",Json.required(set,"id"),"assetId",id,"baseTruthVersion",0,"source","manual","annotations",Json.arr(annotation("t",210,1)))),"setRevision",0);
            JsonObject version=cmd(e,"evaluationSet.publish",Json.obj("setId",Json.required(set,"id"),"baseSetRevision",revision));
            JsonObject evaluation=cmd(e,"evaluation.create",Json.obj("setVersionId",Json.required(version,"id"),"schemes",Json.arr(Json.obj("runId",runId)),"match",Json.obj("iouThreshold",0.5,"poseNormalization","image_diagonal")));
            String eid=Json.required(evaluation,"id");
            JsonObject built=cmd(e,"review.build",Json.obj("evaluationId",eid,"source","hard"));
            check(Json.integer(built,"created",0)>=3&&Json.integer(built,"existing",-1)==0,"难例队列为每个有信号的素材建一条优先项，实际 build="+built+"，评测行="+cmd(e,"evaluation.results",Json.obj("evaluationId",eid,"limit",10)));
            JsonObject list=cmd(e,"review.list",Json.obj("projectId",pid,"source","hard"));
            List<Double> priorities=new ArrayList<>();for(JsonElement element:Json.array(list,"items"))priorities.add(Json.decimal(element.getAsJsonObject(),"priority",0));
            for(int i=1;i<priorities.size();i++)check(priorities.get(i-1)>=priorities.get(i),"hard 队列按优先级降序（低置信在前、geometryIssues 加权后的总分）");
            check(priorities.getFirst()>priorities.getLast(),"队列确实分出高低先后");
            JsonObject first=Json.array(list,"items").get(0).getAsJsonObject();
            check(Math.abs(Json.decimal(Json.object(first,"signals"),"minConfidence",1)-0.2)<1e-9,"置信度最低的难例排在最前");
            check(Json.required(first,"source").equals("hard")&&Json.required(first,"reason").equals("hard_case")&&first.has("priority")&&first.has("signals"),"难例项带优先级与信号明细");
            // 建议卡：阈值只建议不自动改；送训练清单含漏检/难例素材。
            JsonObject suggestions=cmd(e,"review.suggestions",Json.obj("projectId",pid,"evaluationId",eid));
            JsonObject threshold=Json.object(suggestions,"confidenceThreshold");
            check(threshold.has("suggested")&&Json.required(threshold,"basis").contains("只建议不自动改"),"建议阈值必须给口径且明示只建议不自动改");
            check(Json.integer(threshold,"extraCount",-1)>=1&&Json.integer(threshold,"matchedCount",-1)>=1,"建议阈值基于命中/多余预测的置信度分界");
            JsonObject training=Json.object(suggestions,"trainingSuggestion");
            check(Json.integer(training,"count",-1)>=2&&Json.array(training,"assetIds").size()==Json.integer(training,"count",-1)&&Json.required(training,"reason").contains("只建议不自动改"),"建议送训练清单去重且明示只建议");
            check(Json.array(cmd(e,"review.list",Json.obj("projectId",pid,"source","hard")),"items").size()>=3,"建议卡不改动任何复核项或标注（只读回显）");
            // 素材先落正式标注：导出链路不收未标注素材（asset_unlabeled 阻断）——这正是「先复核确认、再送训」的真实顺序。
            for(int i=0;i<ids.size();i++){String aid=ids.get(i).getAsString();int baseVersion=Json.integer(e.projects.asset(aid),"version",0);
                cmd(e,"annotation.save",Json.obj("assetId",aid,"baseVersion",baseVersion,"annotations",predictions.get(i)==null?new JsonArray():predictions.get(i),"confirm",true));}
            // 「建议送训练」一键链路：按清单导出 → 建训练数据集（既有链路，两次调用即用户的一次点击）。
            JsonArray trainList=Json.array(training,"assetIds");
            JsonObject exported=cmd(e,"export.create",Json.obj("projectId",pid,"assetIds",trainList,"excludeUnlabeled",false,"outputDir",root.resolve("review-hard-export").toString()));
            JsonObject dataset=cmd(e,"training.dataset.create",Json.obj("projectId",pid,"source","export","exportId",Json.required(exported,"id")));
            check(Json.required(dataset,"id").length()>0,"建议送训练清单可一键走完「导出 → 训练数据集」既有链路");
        }
    }
}
