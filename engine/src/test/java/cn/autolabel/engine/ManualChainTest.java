package cn.autolabel.engine;

import com.google.gson.*;
import javax.imageio.ImageIO;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

final class ManualChainTest {
    static Path root;
    static void check(boolean condition,String message){EngineTest.check(condition,message);}
    static JsonObject cmd(Engine e,String command,JsonObject p)throws Exception{return (JsonObject)e.command(command,p);}
    interface Action{void run()throws Exception;}
    static void rejects(String code,Action action)throws Exception{try{action.run();throw new AssertionError("Expected "+code);}catch(ApiError e){check(e.code.equals(code),"Expected "+code+" got "+e.code);}}
    static void run(Path target)throws Exception{root=target;maintenance();labels();relocationAndOverlay();exportFormats();System.out.println("Manual 4A additions verified at "+root);}
    static void maintenance()throws Exception{
        try(Engine e=new Engine(root.resolve("maintenance"))){JsonObject p=EngineTest.project(e,"detect");String pid=Json.required(p,"id");
            e.store.tx(c->{for(int i=0;i<110;i++){String id="old-run-"+i,status=i==0?"paused":"completed";Store.update(c,"INSERT INTO runs(id,project_id,status,data) VALUES(?,?,?,?)",id,pid,status,Json.obj("id",id,"projectId",pid,"status",status,"total",0));}return null;});
            JsonObject busy=cmd(e,"system.prepareUpdate",new JsonObject());check(!Json.bool(busy,"canUpdate",true)&&!Json.bool(busy,"locked",true),"all runs inspected beyond list pagination");check(Json.number(Json.object(busy,"counts"),"runningRuns",0)==1,"full active run count");
            e.store.tx(c->{JsonObject run=Store.document(c,"runs","old-run-0");run.addProperty("status","cancelled");Store.update(c,"UPDATE runs SET status='cancelled',data=? WHERE id='old-run-0'",run);return null;});
            e.maintenance.enter("asset.import");try{check(!Json.bool(cmd(e,"system.prepareUpdate",new JsonObject()),"ready",true),"active media command blocks update");}finally{e.maintenance.leave();}
            JsonObject ready=cmd(e,"system.prepareUpdate",new JsonObject());check(Json.bool(ready,"ready",false)&&Json.bool(ready,"locked",false),"idle engine frozen before ready");
            rejects("engine_update_locked",()->cmd(e,"project.create",Json.obj("name","blocked","taskType","detect")));check(((JsonArray)e.command("project.list",new JsonObject())).size()==1,"read-only available during maintenance");
            cmd(e,"system.cancelUpdate",new JsonObject());cmd(e,"project.create",Json.obj("name","resumed","taskType","detect"));check(!Json.bool(cmd(e,"system.canUpdate",new JsonObject()),"locked",true),"cancel update releases write gate");
        }
    }
    static String oneAsset(Engine e,String pid,Path path,String mode)throws Exception{JsonObject result=cmd(e,"asset.import",Json.obj("projectId",pid,"paths",Json.arr(path.toString()),"mode",mode));check(Json.integer(result,"imported",0)==1,"fixture image imported");return Json.array(result,"assetIds").get(0).getAsString();}
    static void labels()throws Exception{
        try(Engine e=new Engine(root.resolve("labels-data"))){Path source=root.resolve("orientation-six.jpg");EngineTest.writeExif(source,6);
            for(String type:List.of("detect","pose","obb","segment")){JsonObject p=EngineTest.project(e,type);String pid=Json.required(p,"id"),aid=oneAsset(e,pid,source,"copy");Path label=root.resolve(type+".txt");
                String text=type.equals("pose")?"0 0.25 0.4 0.25 0.4 0.125 0.2 2 0.375 0.6 1":type.equals("detect")?"0 0.25 0.4 0.25 0.4":"0 0.125 0.2 0.375 0.2 0.375 0.6 0.125 0.6";Files.writeString(label,text);
                JsonObject imported=cmd(e,"annotation.importYolo",Json.obj("projectId",pid,"labelSpace","source","classMap",Json.obj("0","item"),"items",Json.arr(Json.obj("assetId",aid,"labelPath",label.toString()))));check(Json.integer(imported,"imported",0)==1,"source YOLO "+type+": "+imported);
                JsonObject asset=e.projects.asset(aid),a=Json.array(asset,"annotations").get(0).getAsJsonObject();check(Json.required(asset,"source").equals("imported_yolo"),"label origin retained");check(Json.required(asset,"status").equals("candidate"),"import is not manual confirmation");
                if(type.equals("detect")||type.equals("pose")){JsonObject box=Json.object(a,"bbox");check(close(box,"x",8)&&close(box,"y",5)&&close(box,"width",8)&&close(box,"height",10),"EXIF box converted once "+type);}
                else{JsonObject first=Json.array(a,"points").get(0).getAsJsonObject();check(close(first,"x",16)&&close(first,"y",5),"EXIF polygon/OBB corner converted");}
                if(type.equals("pose")){JsonObject first=Json.array(a,"keypoints").get(0).getAsJsonObject();check(close(first,"x",16)&&close(first,"y",5),"semantic keypoint order after rotation");
                    Files.writeString(label,"0 0.6 0.25 0.4 0.25 0.8 0.125 2 0.4 0.375 1");JsonObject again=cmd(e,"annotation.importYolo",Json.obj("projectId",pid,"labelSpace","baseline","classMap",Json.obj("0","item"),"items",Json.arr(Json.obj("assetId",aid,"baseVersion",1,"labelPath",label.toString()))));check(Json.integer(again,"imported",0)==1,"baseline pose imported");JsonObject after=Json.array(e.projects.asset(aid),"annotations").get(0).getAsJsonObject();check(a.get("bbox").equals(after.get("bbox"))&&a.get("keypoints").equals(after.get("keypoints")),"baseline not rotated twice");}
                int version=Json.integer(e.projects.asset(aid),"version",0);Files.writeString(label,"0 0.2 nan 0.4 0.5");JsonObject invalid=cmd(e,"annotation.importYolo",Json.obj("projectId",pid,"labelSpace","source","classMap",Json.obj("0","item"),"items",Json.arr(Json.obj("assetId",aid,"baseVersion",version,"labelPath",label.toString()))));check(Json.integer(invalid,"imported",1)==0&&Json.array(invalid,"errors").size()==1,"invalid labels isolated");check(Json.integer(e.projects.asset(aid),"version",0)==version,"invalid labels preserve version");
            }
            JsonObject p=EngineTest.project(e,"detect");String pid=Json.required(p,"id"),aid=oneAsset(e,pid,source,"copy");JsonObject missing=cmd(e,"annotation.importYolo",Json.obj("projectId",pid,"labelSpace","baseline","classMap",Json.obj("0","item"),"labelsDir",root.toString()));check(Json.integer(missing,"imported",1)==0,"missing label not negative");check(Json.required(e.projects.asset(aid),"status").equals("unlabeled"),"missing label stays unlabeled");
            Path empty=root.resolve("orientation-six.txt");Files.writeString(empty,"");JsonObject negative=cmd(e,"annotation.importYolo",Json.obj("projectId",pid,"labelSpace","baseline","classMap",Json.obj("0","item"),"labelsDir",root.toString()));check(Json.integer(negative,"imported",0)==1&&Json.array(e.projects.asset(aid),"annotations").isEmpty(),"existing empty label is explicit negative");
            rejects("invalid_argument",()->cmd(e,"annotation.importYolo",Json.obj("projectId",pid,"labelsDir",root.toString(),"classMap",Json.obj("0","item"))));
        }
    }
    static boolean close(JsonObject o,String key,double value){return Math.abs(Json.decimal(o,key,0)-value)<1e-8;}
    static void relocationAndOverlay()throws Exception{
        try(Engine e=new Engine(root.resolve("files-data"))){JsonObject project=EngineTest.project(e,"detect");String pid=Json.required(project,"id");Path original=root.resolve("original-source.png");Media.sample(original,0);String aid=oneAsset(e,pid,original,"reference");e.projects.save(Json.obj("assetId",aid,"baseVersion",0,"annotations",Json.arr(EngineTest.label("detect")),"confirm",true));
            e.projects.draft(Json.obj("assetId",aid,"baseVersion",1,"annotations",new JsonArray()));String beforeHash=Media.hash(e.projects.path(aid));
            Path correct=root.resolve("correct-location"),wrong=root.resolve("wrong-location");Files.createDirectories(correct);Files.createDirectories(wrong);Path moved=correct.resolve("different-name.png");Files.move(original,moved);Media.sample(wrong.resolve("original-source.png"),2);
            JsonObject mismatch=cmd(e,"asset.relocate",Json.obj("projectId",pid,"directory",wrong.toString()));check(Json.integer(mismatch,"relocated",-1)==0,"same filename different content not relinked");check(Json.required(Json.array(mismatch,"issues").get(0).getAsJsonObject(),"code").equals("relocate_content_changed"),"content change explained");
            Path duplicate=correct.resolve("duplicate.png");Files.copy(moved,duplicate);JsonObject ambiguous=cmd(e,"asset.relocate",Json.obj("projectId",pid,"directory",correct.toString()));check(Json.required(Json.array(ambiguous,"issues").get(0).getAsJsonObject(),"code").equals("relocate_ambiguous"),"duplicate hash requires disambiguation");Files.move(duplicate,root.resolve("duplicate-outside.png"));
            JsonObject relocated=cmd(e,"asset.relocate",Json.obj("projectId",pid,"directory",correct.toString()));check(Json.integer(relocated,"relocated",0)==1,"hash and dimensions relink");JsonObject asset=e.projects.asset(aid);check(asset.has("draft")&&Json.integer(asset,"version",0)==1&&Json.required(asset,"status").equals("confirmed"),"relink preserves formal and draft");
            Path baseline=e.projects.path(aid);Files.move(baseline,root.resolve("baseline-backup.png"));JsonObject restored=cmd(e,"asset.relocate",Json.obj("projectId",pid,"directory",correct.toString()));check(Json.integer(restored,"relocated",0)==1&&Media.hash(baseline).equals(beforeHash),"missing baseline regenerated only with exact content hash");
            Path overlay=root.resolve("overlay.png");JsonObject rendered=cmd(e,"annotation.render",Json.obj("assetId",aid,"version",1,"outputPath",overlay.toString(),"showLabels",false));check(Json.integer(rendered,"version",0)==1,"overlay uses saved version not draft");var input=ImageIO.read(baseline.toFile());var output=ImageIO.read(overlay.toFile());check(input.getWidth()==output.getWidth()&&input.getHeight()==output.getHeight(),"overlay baseline size");check(input.getRGB(200,220)!=output.getRGB(200,220),"actual stored rectangle rendered");check(Media.hash(baseline).equals(beforeHash),"overlay does not alter training baseline");
            Path hidden=root.resolve("overlay-hidden.jpg");cmd(e,"annotation.render",Json.obj("assetId",aid,"outputPath",hidden.toString(),"format","jpeg","showGeometry",false,"showLabels",false));check(ImageIO.read(hidden.toFile())!=null,"JPEG overlay output");
            rejects("overlay_target_protected",()->cmd(e,"annotation.render",Json.obj("assetId",aid,"outputPath",e.store.root.resolve("media/forbidden.png").toString())));
            JsonObject exported=cmd(e,"export.create",Json.obj("projectId",pid,"outputDir",root.resolve("history").toString()));Path exportedDir=Path.of(Json.required(exported,"path"));JsonObject manifest=Json.parse(Files.readString(exportedDir.resolve("manifest.json")));check(Json.array(manifest,"assets").get(0).getAsJsonObject().get("contentHash").getAsString().equals(beforeHash),"training export uses baseline not overlay");
            e.projects.save(Json.obj("assetId",aid,"baseVersion",1,"annotations",new JsonArray(),"confirm",true));e.projects.update(Json.obj("projectId",pid,"classes",Json.arr(Json.obj("id","item","name","新名称","color","#ff0000"))));
            Path historicalOverlay=root.resolve("historical-overlay.png");JsonObject historical=cmd(e,"annotation.render",Json.obj("assetId",aid,"version",1,"outputPath",historicalOverlay.toString(),"showLabels",false));check(Json.required(historical,"templateSource").equals("saved_version")&&ImageIO.read(historicalOverlay.toFile()).getRGB(200,220)==output.getRGB(200,220),"historical overlay retains saved class color");
            JsonObject reproduced=cmd(e,"export.reproduce",Json.obj("exportId",exported.get("id"),"outputDir",root.resolve("history").toString()));JsonObject comparison=cmd(e,"export.compare",Json.obj("exportId",exported.get("id"),"otherExportId",reproduced.get("id")));check(Json.integer(comparison,"unchanged",0)==1&&Json.array(comparison,"changed").isEmpty(),"historical reproduce ignores later project edits");
            JsonObject latest=cmd(e,"export.create",Json.obj("projectId",pid,"outputDir",root.resolve("history").toString()));JsonObject difference=cmd(e,"export.compare",Json.obj("exportId",exported.get("id"),"otherExportId",latest.get("id")));check(Json.array(difference,"changed").size()==1&&Json.bool(difference,"classesChanged",false),"history compares annotation and class edits");
            rejects("overlay_target_protected",()->cmd(e,"annotation.render",Json.obj("assetId",aid,"outputPath",exportedDir.resolve("images/train/effect.png").toString())));
            rejects("export_target_protected",()->cmd(e,"export.reproduce",Json.obj("exportId",exported.get("id"),"outputDir",exportedDir.toString())));
            JsonObject first=Json.array(manifest,"assets").get(0).getAsJsonObject();Path label=exportedDir.resolve("labels/"+Json.required(first,"split")+"/"+aid+".txt");Files.writeString(label,"changed");rejects("export_dependency_changed",()->cmd(e,"export.reproduce",Json.obj("exportId",exported.get("id"),"outputDir",root.resolve("history").toString())));
            check(e.store.read(c->Store.one(c,"SELECT COUNT(*) AS n FROM exports WHERE json_extract(data,'$.status')='failed'").get("n").getAsInt())==1,"failed reproduce never marked complete");
        }
    }
    /** 自定义导出格式：内置预设与保存模板共用同一读取路径，清单记录实际生效规范，复现与比对不依赖模板是否仍存在。 */
    static void exportFormats()throws Exception{
        try(Engine e=new Engine(root.resolve("format-data"))){
            JsonObject project=EngineTest.project(e,"detect");String pid=Json.required(project,"id");List<String> assets=new ArrayList<>();
            for(int i=0;i<2;i++){Path file=root.resolve("format-"+i+".png");Media.sample(file,i);String aid=oneAsset(e,pid,file,"copy");
                e.projects.save(Json.obj("assetId",aid,"baseVersion",0,"annotations",Json.arr(EngineTest.label("detect")),"confirm",true));assets.add(aid);}
            check(((JsonArray)e.command("export.format.list",Json.obj("taskType","detect"))).size()==4,"detect 任务列出四个内置预设");
            JsonObject saved=cmd(e,"export.format.save",Json.obj("taskType","detect","name","COCO 单文件","note","自定义目录",
                "labelFormat","coco","precision",3,"cocoFileName","{name}.png",
                "layout",Json.obj("image","imgs/{split}/{name}.png","label","","index","ann/{split}.json")));
            String formatId=Json.required(saved,"id");check(Json.integer(saved,"version",0)==1&&!Json.bool(saved,"builtin",true),"自定义导出格式保存为 1 版");
            check(((JsonArray)e.command("export.format.list",Json.obj("taskType","detect"))).size()==5,"保存模板与内置预设一起列出");
            JsonObject preflight=cmd(e,"export.preflight",Json.obj("projectId",pid,"formatId",formatId,"formatVersion",1));
            check(Json.bool(Json.object(preflight,"summary"),"canExport",false)&&Json.required(Json.object(preflight,"format"),"labelFormat").equals("coco"),"预检返回实际生效的自定义格式："+preflight+" saved="+saved);
            JsonObject broken=cmd(e,"export.preflight",Json.obj("projectId",pid,"format",Json.obj("labelFormat","coco","layout",Json.obj("image","a.jpg","index","a.json"))));
            check(!Json.bool(Json.object(broken,"summary"),"canExport",true),"图片扩展名不符作为检查项阻断导出");
            Path out=root.resolve("format-out");
            JsonObject exported=cmd(e,"export.create",Json.obj("projectId",pid,"outputDir",out.toString(),"formatId",formatId,"formatVersion",1));
            Path dir=Path.of(Json.required(exported,"path"));JsonObject manifest=Json.parse(Files.readString(dir.resolve("manifest.json")));
            check(Json.required(Json.object(manifest,"format"),"labelFormat").equals("coco"),"清单记录本次生效的格式规范");
            check(Json.array(manifest,"auxiliaryFiles").size()==2,"COCO 索引按划分各生成一份并记录摘要");
            check(Files.isRegularFile(dir.resolve("ann/train.json"))&&Files.isRegularFile(dir.resolve("ann/val.json")),"索引文件落在自定义目录");
            check(Json.array(manifest,"assets").asList().stream().noneMatch(item->item.getAsJsonObject().has("label")),"COCO 逐图清单不写标签路径");
            JsonObject coco=Json.parse(Files.readString(dir.resolve("ann/train.json")));
            check(Json.array(coco,"categories").size()==1&&Json.array(coco,"annotations").size()==1,"COCO 类别与目标数量");
            check(!Files.exists(dir.resolve("labels"))&&Files.exists(dir.resolve("imgs")),"自定义图片目录生效且不生成标签目录");
            check(Files.isRegularFile(dir.resolve("imgs/train/"+assets.get(0)+".png"))||Files.isRegularFile(dir.resolve("imgs/val/"+assets.get(0)+".png")),"自定义图片路径实际落地");
            JsonObject reproduced=cmd(e,"export.reproduce",Json.obj("exportId",exported.get("id"),"outputDir",out.toString()));
            JsonObject stable=cmd(e,"export.compare",Json.obj("exportId",exported.get("id"),"otherExportId",reproduced.get("id")));
            check(Json.integer(stable,"unchanged",0)==Json.array(manifest,"assets").size()&&!Json.bool(stable,"formatChanged",true),"自定义格式副本可复现且格式一致："+stable);
            JsonObject yolo=cmd(e,"export.create",Json.obj("projectId",pid,"outputDir",out.toString()));
            check(Json.bool(cmd(e,"export.compare",Json.obj("exportId",exported.get("id"),"otherExportId",yolo.get("id"))),"formatChanged",false),"默认布局与自定义布局的差异被单独标记");
            JsonObject csv=cmd(e,"export.create",Json.obj("projectId",pid,"outputDir",out.toString(),"formatId","builtin:csv"));
            String rows=Files.readString(Path.of(Json.required(csv,"path")).resolve("annotations.csv"),StandardCharsets.UTF_8);
            check(rows.startsWith("\ufeff")&&rows.contains("classId")&&rows.contains("xmin"),"CSV 索引含 BOM 与几何列");
            JsonObject voc=cmd(e,"export.create",Json.obj("projectId",pid,"outputDir",out.toString(),"formatId","builtin:voc"));
            Path vocDir=Path.of(Json.required(voc,"path"));JsonObject vocAsset=Json.array(Json.parse(Files.readString(vocDir.resolve("manifest.json"))),"assets").get(0).getAsJsonObject();
            check(Files.readString(vocDir.resolve(Json.required(vocAsset,"label"))).contains("<bndbox>"),"VOC 逐图 XML 写出边界框");
            rejects("export_format_path_invalid",()->cmd(e,"export.format.save",Json.obj("taskType","detect","name","越界","labelFormat","coco","layout",Json.obj("image","../escape.png","index","a.json"))));
            try(Engine other=new Engine(root.resolve("format-obb"))){JsonObject obb=EngineTest.project(other,"obb");rejects("export_format_task_unsupported",()->other.command("export.format.save",Json.obj("taskType",Json.required(obb,"taskType"),"name","VOC 旋转框","labelFormat","voc","layout",Json.obj("image","images/{name}.png","label","a/{name}.xml"))));}
            rejects("export_format_version_conflict",()->cmd(e,"export.format.save",Json.obj("id",formatId,"baseVersion",0,"taskType","detect","name","过期版本","labelFormat","coco","layout",Json.obj("image","imgs/{split}/{name}.png","index","ann/{split}.json"))));
            JsonObject updated=cmd(e,"export.format.save",Json.obj("id",formatId,"baseVersion",1,"taskType","detect","name","COCO 单文件",
                "labelFormat","coco","layout",Json.obj("image","imgs/{split}/{name}.png","label","","index","annotations/{split}.json")));
            check(Json.integer(updated,"version",0)==2,"更新导出格式生成新版本");
            check(Json.integer(cmd(e,"export.format.get",Json.obj("formatId",formatId,"version",1)),"version",0)==1,"历史格式版本仍可读取");
            cmd(e,"export.format.delete",Json.obj("formatId",formatId,"baseVersion",2));
            JsonObject gone=cmd(e,"export.preflight",Json.obj("projectId",pid,"formatId",formatId));
            check(!Json.bool(Json.object(gone,"summary"),"canExport",true),"删除后的格式标识作为检查项阻断导出");
            JsonObject reproducedAfterDelete=cmd(e,"export.reproduce",Json.obj("exportId",exported.get("id"),"outputDir",out.toString()));
            check(Json.required(reproducedAfterDelete,"status").equals("completed"),"格式模板删除后历史副本仍可复现");
        }
    }
}
