package cn.autolabel.engine;

import com.google.gson.*;
import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.nio.file.*;
import java.sql.*;
import java.util.*;
import java.util.zip.*;

/** 用实际发布文件验证暂停恢复，避免只比数据库行数而遗漏像素依赖。 */
public final class DataBackupsSchema4Test {
    private static int checks;
    private static final String FLOW="paused-flow",STEP="transform-step-row",ARTIFACT="partial-views",RUN="local-run";
    private static final TransformedImages.RenderOptions OPTIONS=new TransformedImages.RenderOptions("#FFFFFF",256L*1024*1024);
    private interface Action{void run()throws Exception;}
    private static void check(boolean value,String message){checks++;if(!value)throw new AssertionError(message);}
    private static void rejects(String code,Action action)throws Exception{try{action.run();throw new AssertionError("应拒绝："+code);}catch(ApiError e){check(e.code.equals(code),"错误码："+e.code+"，预期："+code);}}
    public static void main(String[] args)throws Exception{
        Path root=Files.createTempDirectory("autolabel-backup-schema4-");roundTrip(root);legacyVersions(root);
        System.out.println("Schema 4 backup: "+checks+" checks passed; isolated data: "+root);
    }
    private static void roundTrip(Path root)throws Exception{
        Path output=Files.createDirectory(root.resolve("备份")),restoreParent=Files.createDirectory(root.resolve("恢复"));
        String assetId;JsonObject fixed,model;List<JsonObject> inputs=new ArrayList<>();Path originalRoot;String rawTail="原始完整结果末尾",mappedTail="回映完整结果末尾";
        try(Store store=new Store(root.resolve("原数据"))){
            originalRoot=store.root;Projects projects=new Projects(store);JsonObject project=projects.create(Json.obj("name","恢复视图","taskType","detect","classes",Json.arr(Json.obj("id","target","name","目标","color","#4488ff"))));
            BufferedImage source=new BufferedImage(12,4,BufferedImage.TYPE_INT_RGB);for(int y=0;y<4;y++)for(int x=0;x<12;x++)source.setRGB(x,y,((x*19)<<16)|((y*41)<<8)|(x+y));
            Path external=root.resolve("源图.png");ImageIO.write(source,"png",external.toFile());source.flush();
            JsonObject imported=projects.importAssets(Json.obj("projectId",project.get("id"),"paths",Json.arr(external.toString()),"mode","copy"));
            assetId=Json.array(imported,"assetIds").get(0).getAsString();JsonObject asset=projects.asset(assetId);Path baseline=projects.path(assetId);
            JsonArray operations=Json.arr(Json.obj("kind","tile","width",4,"height",4,"overlapX",0,"overlapY",0));fixed=TransformGeometry.plan(RunInputs.identity(asset),operations);
            String relative="flow-inputs/"+FLOW+"/"+STEP+"/"+assetId;Path directory=store.root.resolve(relative);Files.createDirectories(directory.getParent());
            try(TransformedImages.Session session=TransformedImages.open(baseline,fixed,directory,OPTIONS,null)){
                for(int i=0;i<2;i++)inputs.add(session.render("view-0000"+i).inputSnapshot());
            }
            check(!Json.required(inputs.get(0),"contentHash").equals(Json.required(inputs.get(1),"contentHash")),"两个已发布视图包含不同像素");
            Files.createDirectories(directory.resolve(".work-abandoned"));Files.writeString(directory.resolve(".work-abandoned/private.txt"),"不应归档");
            Files.createDirectories(directory.resolve("views/.partial-abandoned"));Files.writeString(directory.resolve("views/.partial-abandoned/input.png"),"不应归档");
            Path modelFile=root.resolve("登记模型.onnx");Files.writeString(modelFile,"只登记，不执行的模型夹具");LocalModels models=new LocalModels(store,projects);
            model=models.register(Json.obj("name","历史本地模型","taskType","detect","modelPath",modelFile.toString()));JsonObject historicalModel=model.deepCopy();historicalModel.addProperty("modelPath",modelFile.toString());
            JsonObject frozen=Json.obj("asset",asset,"inputPath",baseline.toString(),"manualProtected",false,"selectedVersion",0,"plan",fixed);
            JsonObject large=Json.obj("id","large-result","runId",RUN,"sampleId","sample-0","inputId","input-0","assetId",assetId,"source","local","status","needs_attention",
                "requiresGeometryReview",true,"rawResult",Json.obj("payload","x".repeat(32*1024*1024)+rawTail),"mappedResult",Json.obj("tail",mappedTail),"provenance",Json.obj("modelPath",modelFile.toString()));
            final String aid=assetId;
            store.tx(c->{
                Store.update(c,"INSERT INTO flow_runs(id,project_id,status,data) VALUES(?,?,?,?)",FLOW,project.get("id").getAsString(),"paused",Json.obj("id",FLOW,"projectId",project.get("id"),"status","paused"));
                JsonObject step=Json.obj("id",STEP,"flowRunId",FLOW,"stepId","transform","kind","transform","status","paused","workerActive",false,
                    "parameters",Json.obj("operations",operations,"background","#FFFFFF"),"workingArtifactId",ARTIFACT,"snapshot",Json.obj("transformPlans",Json.obj(aid,fixed),"local",Json.obj("model",historicalModel)));
                Store.update(c,"INSERT INTO flow_steps(id,flow_run_id,step_id,position,status,data) VALUES(?,?,?,?,?,?)",STEP,FLOW,"transform",0,"paused",step);
                Store.update(c,"INSERT INTO flow_artifacts(id,flow_run_id,project_id,step_id,kind,data) VALUES(?,?,?,?,?,?)",ARTIFACT,FLOW,project.get("id").getAsString(),"transform","views",Json.obj("id",ARTIFACT,"status","writing","total",3));
                for(String run:List.of(RUN,"historical-run")){
                    Store.update(c,"INSERT INTO runs(id,project_id,status,data) VALUES(?,?,?,?)",run,project.get("id").getAsString(),"paused",Json.obj("id",run,"projectId",project.get("id"),"status","paused","kind","local","snapshot",Json.obj("local",Json.obj("model",historicalModel))));
                    JsonObject parent=frozen.deepCopy();parent.addProperty("marker",run);Store.update(c,"INSERT INTO run_baselines(run_id,asset_id,data) VALUES(?,?,?)",run,aid,parent);
                }
                for(int i=0;i<3;i++){
                    String inputId="input-"+i,viewId="view-0000"+i;JsonObject snapshot=Json.obj("inputId",inputId,"kind","view","assetId",aid,"viewId",viewId,"width",4,"height",4);
                    JsonObject item=Json.obj("id",inputId,"artifactId",ARTIFACT,"assetId",aid,"viewId",viewId,"planStepId",STEP,"workStatus",i<2?"done":"queued","inputSnapshot",snapshot,"outcome","included");
                    if(i<2){JsonObject rendered=inputs.get(i);for(String field:List.of("contentHash","planHash","pixelTransformVersion","inputTransform"))snapshot.add(field,rendered.get(field));
                        item.addProperty("inputPath",directory.resolve("views/"+viewId+"/input.png").toString());item.add("contentHash",rendered.get("contentHash"));
                        JsonObject sample=item.deepCopy();sample.add("asset",asset);sample.addProperty("id","sample-"+i);Store.update(c,"INSERT INTO samples(id,run_id,asset_id,input_id,status,data) VALUES(?,?,?,?,?,?)","sample-"+i,RUN,aid,inputId,"succeeded",sample);
                    }
                    Store.update(c,"INSERT INTO flow_artifact_items(id,artifact_id,asset_id,position,outcome,data) VALUES(?,?,?,?,?,?)",inputId,ARTIFACT,aid,i,"included",item);
                }
                Store.update(c,"INSERT INTO input_results(id,run_id,sample_id,asset_id,input_id,source,status,created_at,data) VALUES(?,?,?,?,?,?,?,?,?)","large-result",RUN,"sample-0",aid,"input-0","local","needs_attention",Json.now(),large);
                Store.update(c,"INSERT INTO run_asset_results(id,run_id,asset_id,result_set_hash,candidate_version,status,created_at,data) VALUES(?,?,?,?,?,?,?,?)","aggregate",RUN,aid,"fixed-result-set",1,"needs_attention",Json.now(),Json.obj("id","aggregate","resultIds",Json.arr("large-result"),"requiresGeometryReview",true));
                return null;
            });
            DataBackups backups=new DataBackups(store);JsonObject preview=backups.preflight(Json.obj("outputDir",output.toString()));check(Json.bool(preview,"ready",false)&&Json.integer(preview,"schemaVersion",0)==4,"schema4 与暂停处理可预检");
            Path archive=Path.of(Json.required(backups.create(Json.obj("outputDir",output.toString())),"backupPath"));
            try(ZipFile zip=new ZipFile(archive.toFile())){
                check(zip.getEntry("files/"+relative+"/generation.json")!=null,"生成清单归档");
                for(int i=0;i<2;i++)for(String name:List.of("input.png","input.json"))check(zip.getEntry("files/"+relative+"/views/view-0000"+i+"/"+name)!=null,"已发布 PNG 与元数据成对归档");
                check(zip.stream().noneMatch(entry->entry.getName().contains(".session.lock")||entry.getName().contains(".work-")||entry.getName().contains(".partial-")||entry.getName().endsWith(".onnx")),"临时文件、锁和模型权重不归档");
                try(var input=zip.getInputStream(zip.getEntry("manifest.json"))){JsonObject manifest=Json.parse(new String(input.readAllBytes(),java.nio.charset.StandardCharsets.UTF_8));long bindings=Json.array(manifest,"bindings").asList().stream().map(JsonElement::getAsJsonObject).filter(b->Json.str(b,"table","").equals("run_baselines")&&b.has("runId")&&b.has("assetId")&&!b.has("id")).count();check(bindings==4,"两个复合键父图各保留两条显式绑定");}
            }
            Path destination=Path.of(Json.required(backups.prepareRestore(Json.obj("backupPath",archive.toString(),"targetParent",restoreParent.toString())),"dataDir"));
            verifyRestore(destination,originalRoot,assetId,fixed,inputs,model,rawTail,mappedTail);
            Path metadata=directory.resolve("views/view-00000/input.json"),saved=directory.resolve("saved-input.json");Files.move(metadata,saved);
            rejects("backup_transform_invalid",()->backups.preflight(Json.obj("outputDir",output.toString())));Files.move(saved,metadata);
        }
    }
    private static void verifyRestore(Path destination,Path originalRoot,String assetId,JsonObject plan,List<JsonObject> inputs,JsonObject model,String rawTail,String mappedTail)throws Exception{
        try(Store restored=new Store(destination)){
            Projects projects=new Projects(restored);String relative="flow-inputs/"+FLOW+"/"+STEP+"/"+assetId;Path directory=destination.resolve(relative);
            for(int i=0;i<2;i++){
                JsonObject descriptor=RunInputs.image(restored,projects,Json.obj("inputId","input-"+i));Path image=Path.of(Json.required(descriptor,"path"));
                check(image.startsWith(destination)&&!image.startsWith(originalRoot)&&Media.hash(image).equals(Json.required(inputs.get(i),"contentHash")),"恢复后固定输入可预览且像素摘要不变");
            }
            for(String run:List.of(RUN,"historical-run")){
                JsonObject baseline=restored.read(c->RunInputs.baseline(c,run,assetId));check(Json.required(baseline,"marker").equals(run),"复合主键未交叉覆盖");
                for(String path:List.of(Json.required(baseline,"inputPath"),Json.required(Json.object(Json.object(baseline,"asset"),"metadata"),"sourcePath")))check(Path.of(path).startsWith(destination)&&!Path.of(path).startsWith(originalRoot)&&Files.isRegularFile(Path.of(path)),"固定父图路径迁到新根目录");
            }
            JsonObject full=restored.read(c->Store.document(c,"input_results","large-result"));String raw=Json.object(full,"rawResult").get("payload").getAsString();check(raw.endsWith(rawTail)&&raw.length()>32*1024*1024,"超限完整 raw 末尾保留");check(Json.required(Json.object(full,"mappedResult"),"tail").equals(mappedTail),"完整 mapped 保留");
            JsonObject aggregate=restored.read(c->Store.document(c,"run_asset_results","aggregate"));check(Json.array(aggregate,"resultIds").get(0).getAsString().equals("large-result")&&Json.bool(aggregate,"requiresGeometryReview",false),"父图汇总及复核门槛保留");
            try(TransformedImages.Session session=TransformedImages.open(projects.path(assetId),plan,directory,OPTIONS,null)){
                for(int i=0;i<2;i++)check(session.render("view-0000"+i).reusedFile(),"恢复后继续复用原子发布视图");
                TransformedImages.Generated third=session.render("view-00002");check(!third.reusedFile()&&Files.isRegularFile(third.imagePath()),"恢复后继续生成未完成第三视图");
                BufferedImage actual=ImageIO.read(third.imagePath().toFile()),source=ImageIO.read(projects.path(assetId).toFile());check(actual.getRGB(0,0)==source.getRGB(8,0),"继续生成使用固定基准像素");actual.flush();source.flush();
            }
            LocalModels models=new LocalModels(restored,projects);JsonObject same=models.get(Json.obj("modelId",model.get("id"),"modelVersion",model.get("version")));check(same.equals(model),"模型登记固定版本只作为元数据保留");
            try(LocalRuntime runtime=new LocalRuntime(models,new JsonObject())){rejects("local_model_authorization_required",()->runtime.load(Json.obj("modelId",model.get("id"),"modelVersion",model.get("version"))));check(Json.array(runtime.state(),"slots").isEmpty(),"恢复不会创建执行授权或设备槽");}
            check(Json.bool(new DataBackups(restored).preflight(Json.obj("outputDir",destination.getParent().toString())),"ready",false),"恢复并继续后可再备份，不依赖旧素材根目录");
        }
    }
    private static void legacyVersions(Path root)throws Exception{
        Path output=Files.createDirectory(root.resolve("旧版兼容"));
        for(int version:List.of(2,3))try(Store store=new Store(root.resolve("schema-"+version))){
            store.tx(c->{try(Statement s=c.createStatement()){s.execute("PRAGMA user_version="+version);}return null;});
            DataBackups backups=new DataBackups(store);JsonObject created=backups.create(Json.obj("outputDir",output.toString()));check(Json.integer(created,"schemaVersion",0)==version,"旧版 schema 仍可归档");check(Json.bool(backups.inspect(Json.obj("backupPath",created.get("backupPath"))),"valid",false),"旧版 schema 仍可验证与重定位");
        }
    }
}
