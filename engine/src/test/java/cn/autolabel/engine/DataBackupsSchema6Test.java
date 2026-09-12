package cn.autolabel.engine;

import com.google.gson.*;
import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.nio.file.*;
import java.util.*;
import java.util.zip.ZipFile;

/** 固定相对图片和十张轨迹表一起往返，不依赖生成工作器是否已完成集成。 */
public final class DataBackupsSchema6Test {
    private static final List<String> TABLES=List.of("track_timelines","timeline_frames","tracks","track_versions","track_generations","track_generation_plans","track_generation_frames","track_contributions","track_contribution_heads","track_dirty_frames");
    private static int checks;
    private interface Action{void run()throws Exception;}
    private static void check(boolean value,String message){checks++;if(!value)throw new AssertionError(message);}
    private static void rejects(String code,Action action)throws Exception{try{action.run();throw new AssertionError("应拒绝："+code);}catch(ApiError e){check(e.code.equals(code),"实际错误 "+e.code+"，预期 "+code);}}
    private record Fixture(JsonObject frame,JsonObject historyPlan,JsonObject currentPlan,String timelineImage,String generationImage){}

    public static void main(String[] args)throws Exception{
        Path root=Files.createTempDirectory("autolabel-backup-schema6-"),archives=Files.createDirectory(root.resolve("备份")),restore=Files.createDirectory(root.resolve("恢复"));
        try(Store store=new Store(root.resolve("原数据"))){
            Fixture fixture=fixture(root,store);DataBackups backups=new DataBackups(store);Map<String,JsonElement> before=snapshot(store);
            JsonObject preview=backups.preflight(Json.obj("outputDir",archives.toString()));check(Json.integer(preview,"schemaVersion",0)==Store.SCHEMA_VERSION&&Json.bool(preview,"ready",false),"schema6 已提交轨迹数据可一致备份");
            Path archive=Path.of(Json.required(backups.create(Json.obj("outputDir",archives.toString())),"backupPath"));
            try(ZipFile zip=new ZipFile(archive.toFile())){
                check(zip.getEntry("files/"+fixture.timelineImage)!=null,"仅时间轴引用的固定图片入档");
                check(zip.getEntry("files/"+fixture.generationImage)!=null,"仅历史生成计划引用的固定图片入档");
                JsonObject manifest=Json.parse(new String(zip.getInputStream(zip.getEntry("manifest.json")).readAllBytes(),java.nio.charset.StandardCharsets.UTF_8));
                check(Json.array(manifest,"bindings").asList().stream().noneMatch(value->TABLES.contains(Json.required(value.getAsJsonObject(),"table"))),"相对输入无需改写轨迹表或固定计划");
            }
            check(Json.bool(backups.inspect(Json.obj("backupPath",archive.toString())),"valid",false),"schema6 归档完整恢复检查通过");
            store.tx(c->{Store.update(c,"UPDATE track_contributions SET data=? WHERE id='contribution-old'",Json.obj("id","contribution-old","note","备份后的写入"));return null;});
            Path destination=Path.of(Json.required(backups.prepareRestore(Json.obj("backupPath",archive.toString(),"targetParent",restore.toString())),"dataDir"));
            Files.delete(store.root.resolve(fixture.timelineImage));Files.delete(store.root.resolve(fixture.generationImage));
            verifyRestore(destination,store.root,before,fixture);
        }
        System.out.println("Schema 6 backup: "+checks+" checks passed; isolated data: "+root);
    }

    private static Fixture fixture(Path root,Store store)throws Exception{
        Projects projects=new Projects(store);JsonObject project=projects.create(Json.obj("name","轨迹备份","taskType","detect","classes",Json.arr(Json.obj("id","target","name","目标","color","#4488ff"))));String pid=Json.required(project,"id");
        Path source=root.resolve("来源图片.png");BufferedImage image=new BufferedImage(40,20,BufferedImage.TYPE_INT_RGB);image.setRGB(2,2,0x66aaff);ImageIO.write(image,"png",source.toFile());
        String assetId=Json.array(projects.importAssets(Json.obj("projectId",pid,"paths",Json.arr(source.toString()),"mode","copy")),"assetIds").get(0).getAsString();
        JsonObject asset=projects.asset(assetId),template=TaskTemplates.snapshot(project);String templateHash=TrackInterpolation.templateHash(template);
        JsonObject row=store.read(c->Store.one(c,"SELECT path FROM assets WHERE id=?",assetId));Path baseline=Path.of(Json.required(row,"path"));
        String timelineImage="media/timeline-history.png",generationImage="media/generation-history.png";Files.copy(baseline,store.root.resolve(timelineImage));Files.copy(baseline,store.root.resolve(generationImage));
        JsonObject frame=Json.obj("frameId","frame-0","sourceFrameId","frame-0","assetId",assetId,"contentHash",asset.get("contentHash"),"width",40,"height",20,"inputVersion",1,"normalizationVersion",Media.NORMALIZATION_VERSION,"sceneId","scene-1","inputImage",timelineImage,
            "sourceVideoId","source-video","videoSourceHash","a".repeat(64),"sourcePresentationIndex",0,"sourcePts","9007199254740993","originPts","9007199254740993","relativePts","0","timeBase",Json.obj("numerator","1","denominator","90000"),"timeSeconds",0,"rangeIndex",0);
        JsonObject timeline=Json.obj("id","timeline","projectId",pid,"mediaJobId","video-job","sourceVideoId","source-video","name","历史时间轴","version",2,"taskType","detect","templateHash",templateHash,"template",template,"frameCount",1,"width",40,"height",20);
        JsonObject track=Json.obj("id","track","timelineId","timeline","version",2,"status","active","classId","target","name","物体","keyframes",new JsonArray());
        JsonObject frozen=frame.deepCopy();frozen.addProperty("inputImage",generationImage);frozen.add("expected",Json.obj("annotationVersion",0,"annotationState","empty","draftSavedAt",null,"draftHash",null,"protected",false));frozen.add("baseAnnotations",Json.arr(Json.obj("id","manual-note","attributes",Json.obj("note",store.root.toString()))));
        JsonObject history=plan(timeline,track,frozen),current=plan(timeline,track,frame);
        store.tx(c->{
            JsonObject metadata=Json.object(asset,"metadata");for(String key:List.of("sourceVideoId","sourcePts","timeBase"))metadata.add(key,frame.get(key));metadata.addProperty("inputVersion",1);asset.add("metadata",metadata);Store.update(c,"UPDATE assets SET data=? WHERE id=?",asset,assetId);
            Store.update(c,"INSERT INTO media_jobs(id,project_id,kind,status,data) VALUES(?,?,?,?,?)","video-job",pid,"video_extract","cancelled",Json.obj("id","video-job","projectId",pid,"kind","video_extract","status","cancelled","artifactCommitted",false));
            Store.update(c,"INSERT INTO track_timelines(id,project_id,media_job_id,template_hash,version,data) VALUES(?,?,?,?,?,?)","timeline",pid,"video-job",templateHash,2,timeline);
            Store.update(c,"INSERT INTO timeline_frames(id,timeline_id,frame_id,asset_id,position,data) VALUES(?,?,?,?,?,?)","timeline-frame","timeline","frame-0",assetId,0,frame);
            Store.update(c,"INSERT INTO tracks(id,timeline_id,version,status,data) VALUES(?,?,?,?,?)","track","timeline",2,"active",track);
            for(int version=1;version<=2;version++){JsonObject fixed=track.deepCopy();fixed.addProperty("version",version);fixed.addProperty("name","历史名称 "+version);Store.update(c,"INSERT INTO track_versions(id,track_id,version,data) VALUES(?,?,?,?)","track-version-"+version,"track",version,fixed);}
            for(String suffix:List.of("old","current")){
                String id="generation-"+suffix,status=suffix.equals("old")?"completed":"interrupted";JsonObject plan=suffix.equals("old")?history:current;
                JsonObject job=Json.obj("id",id,"trackId","track","timelineId","timeline","trackVersion",2,"timelineVersion",2,"involvedTrackIds",Json.arr("track"),"status",status,"parameters",new JsonObject(),"scope","affected","progress",Json.obj("completed",1,"total",1),"candidateOnly",true,"humanConfirmed",false,"requestsUsed",0);
                Store.update(c,"INSERT INTO track_generations(id,track_id,status,data) VALUES(?,?,?,?)",id,"track",status,job);
                Store.update(c,"INSERT INTO track_generation_plans(generation_id,data) VALUES(?,?)",id,plan);
                Store.update(c,"INSERT INTO track_generation_frames(id,generation_id,asset_id,status,data) VALUES(?,?,?,?,?)","result-"+suffix,id,assetId,"applied",Json.obj("assetId",assetId,"frameId","frame-0","status","applied","rawCandidates",Json.arr(Json.obj("history",suffix))));
                Store.update(c,"INSERT INTO track_contributions(id,generation_id,track_id,asset_id,data) VALUES(?,?,?,?,?)","contribution-"+suffix,id,"track",assetId,Json.obj("id","contribution-"+suffix,"generationId",id,"trackId","track","assetId",assetId,"annotations",Json.arr(Json.obj("id","annotation-"+suffix)),"requiresReview",true));
            }
            // 迁移前的 schema 6 记录仍可能把计划嵌在 generation.data；验证新入口保留兼容读取分支。
            JsonObject legacy=Json.obj("id","generation-legacy","trackId","track","timelineId","timeline","status","completed","parameters",new JsonObject(),"scope","affected","progress",Json.obj("completed",1,"total",1),"candidateOnly",true,"humanConfirmed",false,"requestsUsed",0,"plan",history);
            Store.update(c,"INSERT INTO track_generations(id,track_id,status,data) VALUES(?,?,?,?)","generation-legacy","track","completed",legacy);
            Store.update(c,"INSERT INTO track_contribution_heads(track_id,asset_id,contribution_id) VALUES(?,?,?)","track",assetId,"contribution-current");
            Store.update(c,"INSERT INTO track_dirty_frames(track_id,frame_id) VALUES(?,?)","track","frame-0");return null;
        });
        return new Fixture(frame,history,current,timelineImage,generationImage);
    }

    private static JsonObject plan(JsonObject timeline,JsonObject track,JsonObject frame){
        JsonObject plan=Json.obj("timeline",timeline.deepCopy(),"owner",track.deepCopy(),"outputs",Json.arr(track.deepCopy()),"retired",new JsonArray(),"involved",Json.arr(track.deepCopy()),"frames",Json.arr(frame.deepCopy()),"frameIds",Json.arr("frame-0"),"reports",new JsonArray(),"intervals",new JsonArray(),"skipped",new JsonArray(),"issues",new JsonArray(),"parameters",new JsonObject(),"scope","affected");
        plan.addProperty("planHash",TrackTimelines.hash(plan));return plan;
    }

    private static Map<String,JsonElement> snapshot(Store store){return store.read(c->{Map<String,JsonElement> rows=new LinkedHashMap<>();for(String table:TABLES)rows.put(table,Json.element(Store.rows(c,"SELECT * FROM "+table+" ORDER BY rowid")));return rows;});}

    private static JsonArray stripEmbeddedPlans(JsonArray rows){JsonArray result=new JsonArray();for(JsonElement value:rows){JsonObject row=value.getAsJsonObject().deepCopy();if(row.has("data")&&row.get("data").isJsonPrimitive()){JsonObject data=Json.parse(row.get("data").getAsString());if(data.has("plan")){data.remove("plan");row.addProperty("data",data.toString());}}result.add(row);}return result;}

    private static void verifyRestore(Path root,Path oldRoot,Map<String,JsonElement> before,Fixture fixture)throws Exception{
        try(Engine restored=new Engine(root)){
            Map<String,JsonElement> after=snapshot(restored.store);for(String table:TABLES){
                if(table.equals("track_generations"))check(stripEmbeddedPlans(before.get(table).getAsJsonArray()).equals(stripEmbeddedPlans(after.get(table).getAsJsonArray())),"十表逐行逐字段保留："+table);
                else if(!table.equals("track_generation_plans"))check(before.get(table).equals(after.get(table)),"十表逐行逐字段保留："+table);
            }
            check(after.get("track_generation_plans").getAsJsonArray().size()==before.get("track_generation_plans").getAsJsonArray().size()+1,"迁移前内嵌计划迁入独立计划表");
            check(!restored.store.read(c->Store.document(c,"track_generations","generation-legacy")).has("plan"),"迁移后 generation 主表不再重复保存计划");
            JsonObject frame=restored.store.read(c->TrackTimelines.frame(c,"timeline","frame-0"));restored.tracks.timelines.verifyFile(frame);
            check(restored.tracks.timelines.path(frame).startsWith(root)&&!restored.tracks.timelines.path(frame).startsWith(oldRoot),"时间轴 helper 在新根目录读取固定像素");
            for(String id:List.of("generation-old","generation-current")){
                JsonObject job=restored.store.read(c->Store.document(c,"track_generations",id)),plan=restored.store.read(c->TrackGenerations.storedPlan(c,id)),unhashed=plan.deepCopy();String hash=Json.required(unhashed,"planHash");unhashed.remove("planHash");
                check(TrackTimelines.hash(unhashed).equals(hash),"恢复后仍符合实际固定计划摘要语义");
                check(!job.has("plan")&&plan.equals(id.equals("generation-old")?fixture.historyPlan:fixture.currentPlan),"独立计划表与旧计划、基底标注、预条件、路径文本原样保留");
                JsonObject frozen=Json.array(plan,"frames").get(0).getAsJsonObject();restored.tracks.timelines.verifyFile(frozen);check(ImageIO.read(restored.tracks.timelines.path(frozen).toFile()).getRGB(2,2)==ImageIO.read(restored.tracks.timelines.path(frame).toFile()).getRGB(2,2),"历史计划输入能继续读取相同像素");
            }
            JsonObject page=restored.tracks.timelines.page(Json.obj("timelineId","timeline","offset",0,"limit",1));check(Json.array(page,"items").size()==1&&Json.array(Json.array(page,"items").get(0).getAsJsonObject(),"contributions").size()==1,"恢复后的时间轴分页读取当前贡献头");
            JsonObject generationPage=restored.trackGenerations.results(Json.obj("generationId","generation-old","offset",0,"limit",1));check(Json.array(generationPage,"items").size()==1,"历史逐帧生成结果仍可分页读取");
            DataBackups backups=new DataBackups(restored.store);JsonObject output=Json.obj("outputDir",root.getParent().toString());check(Json.bool(backups.preflight(output),"ready",false),"恢复后可再次完整备份");
            invalidDependencies(restored.store,backups,output,fixture);
        }
    }

    private static void updatePlanPath(Store store,String path){store.tx(c->{JsonObject plan=TrackGenerations.storedPlan(c,"generation-old");Json.array(plan,"frames").get(0).getAsJsonObject().addProperty("inputImage",path);plan.remove("planHash");plan.addProperty("planHash",TrackTimelines.hash(plan));Store.update(c,"UPDATE track_generation_plans SET data=? WHERE generation_id='generation-old'",plan);return null;});}

    private static void invalidDependencies(Store store,DataBackups backups,JsonObject output,Fixture fixture)throws Exception{
        Path file=store.root.resolve(fixture.generationImage);byte[] bytes=Files.readAllBytes(file);Files.delete(file);rejects("backup_track_invalid",()->backups.preflight(output));Files.write(file,bytes);
        file=store.root.resolve(fixture.timelineImage);bytes=Files.readAllBytes(file);Files.delete(file);rejects("backup_track_invalid",()->backups.preflight(output));Files.write(file,bytes);
        updatePlanPath(store,"../outside.png");rejects("backup_path_invalid",()->backups.preflight(output));updatePlanPath(store,fixture.generationImage);
        store.tx(c->{JsonObject frame=Store.document(c,"timeline_frames","timeline-frame");frame.addProperty("inputImage",store.root.getParent().resolve("outside.png").toString());Store.update(c,"UPDATE timeline_frames SET data=? WHERE id='timeline-frame'",frame);return null;});rejects("backup_path_invalid",()->backups.preflight(output));
        store.tx(c->{Store.update(c,"UPDATE timeline_frames SET data=? WHERE id='timeline-frame'",fixture.frame);JsonObject plan=TrackGenerations.storedPlan(c,"generation-old");plan.addProperty("scope","changed-without-hash");Store.update(c,"UPDATE track_generation_plans SET data=? WHERE generation_id='generation-old'",plan);return null;});rejects("backup_track_invalid",()->backups.preflight(output));
        store.tx(c->{Store.update(c,"UPDATE track_generation_plans SET data=? WHERE generation_id='generation-old'",fixture.historyPlan);Store.update(c,"UPDATE track_generations SET status='running' WHERE id='generation-current'");return null;});
        check(Json.array(backups.preflight(output),"issues").toString().contains("backup_not_quiescent"),"执行中的轨迹生成不能发布完整备份");
        store.tx(c->{Store.update(c,"UPDATE track_generations SET status='interrupted' WHERE id='generation-current'");return null;});
        Path corrupt=store.root.resolve(fixture.generationImage);byte[] valid=Files.readAllBytes(corrupt);Files.writeString(corrupt,"内容变化");
        // 同内容的其他已登记副本可按旧备份约定补回固定位置，不能伪造不同版本。
        updatePlanPath(store,fixture.generationImage);store.tx(c->{JsonObject plan=TrackGenerations.storedPlan(c,"generation-old");Json.array(plan,"frames").get(0).getAsJsonObject().addProperty("contentHash","b".repeat(64));plan.remove("planHash");plan.addProperty("planHash",TrackTimelines.hash(plan));Store.update(c,"UPDATE track_generation_plans SET data=? WHERE generation_id='generation-old'",plan);return null;});
        rejects("backup_dependency_conflict",()->backups.preflight(output));Files.write(corrupt,valid);
    }
}
