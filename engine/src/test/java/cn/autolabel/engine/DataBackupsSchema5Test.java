package cn.autolabel.engine;

import com.google.gson.*;
import java.nio.file.*;
import java.util.*;
import java.util.zip.*;

/** 实际媒体任务往返验证：发布字节保持不变，执行路径由新数据根目录重建。 */
public final class DataBackupsSchema5Test {
    private static int checks;
    private interface Action{void run()throws Exception;}
    private static void check(boolean value,String message){checks++;if(!value)throw new AssertionError(message);}
    private static void rejects(String code,Action action)throws Exception{try{action.run();throw new AssertionError("应拒绝："+code);}catch(ApiError e){check(e.code.equals(code),"实际错误 "+e.code+"，预期 "+code);}}
    public static void main(String[] args)throws Exception{
        if(args.length!=3)throw new IllegalArgumentException("ffmpegPath ffprobePath sourceVideoPath");
        Path root=Files.createTempDirectory("autolabel-backup-schema5-");Path source=Files.copy(Path.of(args[2]),root.resolve("原始视频.mp4"));
        JsonObject startup=Json.obj("mediaFfmpegPath",Path.of(args[0]).toAbsolutePath().toString(),"mediaFfprobePath",Path.of(args[1]).toAbsolutePath().toString());
        roundTrip(root,source,startup);System.out.println("Schema 5 backup: "+checks+" checks passed; isolated data: "+root);
    }
    private static JsonObject await(Engine engine,String id)throws Exception{
        long end=System.nanoTime()+30_000_000_000L;
        while(System.nanoTime()<end){JsonObject job=engine.mediaJobs.get(id);String status=Json.required(job,"status");if(!Set.of("queued","running","cancelling").contains(status)&&Json.integer(engine.mediaJobs.diagnostics(),"activeWorkers",0)==0)return job;Thread.sleep(20);}
        throw new AssertionError("媒体任务未在 30 秒内完成："+id);
    }
    private static void roundTrip(Path root,Path source,JsonObject startup)throws Exception{
        Path output=Files.createDirectory(root.resolve("备份输出")),restoreParent=Files.createDirectory(root.resolve("恢复目录"));
        try(Engine engine=new Engine(root.resolve("原数据"),startup)){
            JsonObject project=engine.projects.create(Json.obj("name","视频恢复夹具","taskType","detect","classes",Json.arr(Json.obj("id","target","name","目标","color","#4488ff"))));String pid=Json.required(project,"id");
            JsonObject parameters=Json.obj("mode","every_n","everyNFrames",1,"ranges",Json.arr(Json.obj("start",0,"end",1)),"format","png","maxFrames",10,"maxOutputBytes",16L*1024*1024,"timeoutMs",30000);
            JsonObject created=engine.mediaJobs.createVideo(Json.obj("projectId",pid,"sourcePath",source.toString(),"parameters",parameters));String videoId=Json.required(created,"id");
            JsonObject completed=await(engine,videoId);check(Json.required(completed,"status").equals("completed")&&Json.bool(completed,"artifactCommitted",false),"真实 FFmpeg 抽帧提交完成");
            JsonObject job=engine.store.read(c->Store.document(c,"media_jobs",videoId));String sourceHash=Json.required(job,"sourceHash"),sourceVideoId=Json.required(job,"sourceVideoId"),completeHash=Json.required(job,"completeHash"),manifestHash=Json.required(job,"manifestHash");
            Path generation=engine.store.root.resolve("media-jobs/"+videoId+"/generation");String recipeHash=Media.hash(generation.resolve("recipe.json"));JsonObject frames=engine.mediaJobs.frames(Json.obj("jobId",videoId));int count=Json.integer(frames,"total",0);check(count>=2,"真实视频至少产生两帧");
            JsonArray paths=new JsonArray();for(int i=0;i<2;i++)paths.add(generation.resolve("frames/frame-0000000"+i+".png").toString());
            JsonObject imported=engine.projects.importAssets(Json.obj("projectId",pid,"paths",paths,"mode","copy"));check(Json.integer(imported,"imported",0)==2,"筛选输入使用真实帧归一化基准图");
            String screeningId=Json.required(engine.mediaJobs.createScreening(Json.obj("projectId",pid,"assetIds",imported.get("assetIds"),"parameters",Json.obj("nearEnabled",false,"deduplicate",true))),"id");
            JsonObject screened=await(engine,screeningId);check(Json.required(screened,"status").equals("completed")&&Json.bool(screened,"artifactCommitted",false),"真实筛选结果已原子提交");
            JsonObject originalPage=engine.mediaJobs.screeningResult(Json.obj("jobId",screeningId,"section","items","offset",1,"limit",1));check(Json.integer(originalPage,"total",0)==2&&Json.array(originalPage,"items").size()==1,"筛选结果真实分页");
            JsonObject screeningJob=engine.store.read(c->Store.document(c,"media_jobs",screeningId));String screeningHash=Json.required(screeningJob,"screeningHash");
            JsonObject historicalInput=Json.array(screeningJob,"privateInputs").get(0).getAsJsonObject().deepCopy();String previous=Json.required(historicalInput,"inputImage"),historicalImage="media/prepared-history.png";
            Files.copy(engine.store.root.resolve(previous),engine.store.root.resolve(historicalImage));historicalInput.addProperty("inputImage",historicalImage);
            Path incomplete=Files.createDirectories(engine.store.root.resolve("media-jobs/interrupted-video/generation/frames"));Files.writeString(incomplete.resolve("frame-00000000.png"),"未提交帧");Files.writeString(incomplete.getParent().resolve("frames.partial.jsonl"),"未完成清单");Files.writeString(incomplete.getParent().resolve("complete.json"),"不能仅凭文件冒充提交");
            Files.writeString(generation.resolve("frames.partial.jsonl"),"旧临时清单");Files.writeString(generation.resolve("frame.png.tmp"),"旧临时帧");Files.writeString(engine.store.root.resolve("media-jobs/"+screeningId+"/screening.json.partial"),"未提交筛选结果");
            engine.store.tx(c->{
                JsonObject interrupted=Json.obj("id","interrupted-video","projectId",pid,"kind","video_extract","status","interrupted","sourcePath",source.toString(),"parameters",parameters,"artifactCommitted",false);
                Store.update(c,"INSERT INTO media_jobs(id,project_id,kind,status,data) VALUES(?,?,?,?,?)","interrupted-video",pid,"video_extract","interrupted",interrupted);
                JsonObject history=Json.obj("id","historical-screening","projectId",pid,"kind","image_screening","status","interrupted","privateInputs",Json.arr(historicalInput),"artifactCommitted",false);
                Store.update(c,"INSERT INTO media_jobs(id,project_id,kind,status,data) VALUES(?,?,?,?,?)","historical-screening",pid,"image_screening","interrupted",history);
                JsonObject saved=Store.document(c,"media_jobs",videoId);saved.addProperty("status","cancelled");Store.update(c,"UPDATE media_jobs SET status='cancelled',data=? WHERE id=?",saved,videoId);
                return null;
            });
            long featureCount=engine.store.read(c->Json.number(Store.one(c,"SELECT COUNT(*) AS n FROM screening_features"),"n",0));check(featureCount>0,"真实筛选写入可保留的特征缓存");
            DataBackups backups=new DataBackups(engine.store);JsonObject preview=backups.preflight(Json.obj("outputDir",output.toString()));check(Json.bool(preview,"ready",false)&&Json.integer(preview,"schemaVersion",0)==5,"schema5 与已提交但取消的产物可备份");
            Path archive=Path.of(Json.required(backups.create(Json.obj("outputDir",output.toString())),"backupPath"));
            try(ZipFile zip=new ZipFile(archive.toFile())){
                String prefix="files/media-jobs/"+videoId+"/generation/";for(String file:List.of("recipe.json","filter.txt","frames.jsonl","complete.json"))check(zip.getEntry(prefix+file)!=null,"全部已发布视频元数据归档");
                check(zip.stream().filter(entry->entry.getName().startsWith(prefix+"frames/")).count()==count,"视频帧按清单完整归档");
                check(zip.getEntry("files/media-jobs/"+screeningId+"/screening.json")!=null&&zip.getEntry("files/"+historicalImage)!=null,"筛选结果和仅历史任务引用的输入归档");
                check(zip.stream().noneMatch(entry->entry.getName().contains("interrupted-video/generation")||entry.getName().endsWith(".partial")||entry.getName().endsWith(".tmp")||entry.getName().contains("frames.partial")),"未提交 generation 和所有半成品排除");
                check(zip.stream().filter(entry->entry.getName().startsWith("files/video-sources/")).count()==1,"同源视频只保存一个完整内容副本");
            }
            Path metadata=generation.resolve("complete.json");byte[] completeBytes=Files.readAllBytes(metadata);Files.writeString(metadata,"损坏完成记录");rejects("backup_dependency_changed",()->backups.preflight(Json.obj("outputDir",output.toString())));Files.write(metadata,completeBytes);
            Path destination=Path.of(Json.required(backups.prepareRestore(Json.obj("backupPath",archive.toString(),"targetParent",restoreParent.toString())),"dataDir"));
            Files.delete(source);
            verifyRestore(destination,videoId,screeningId,sourceVideoId,sourceHash,completeHash,manifestHash,recipeHash,screeningHash,originalPage,frames,historicalImage,featureCount);
        }
    }
    private static void verifyRestore(Path root,String videoId,String screeningId,String sourceVideoId,String sourceHash,String completeHash,String manifestHash,String recipeHash,String screeningHash,JsonObject originalPage,JsonObject originalFrames,String historicalImage,long featureCount)throws Exception{
        try(Engine restored=new Engine(root)){
            JsonObject job=restored.store.read(c->Store.document(c,"media_jobs",videoId)),source=restored.store.read(c->Store.document(c,"video_sources",sourceVideoId));
            for(String path:List.of(Json.required(job,"sourcePath"),Json.required(Json.object(job,"frozenPlan"),"sourcePath"),Json.required(source,"sourcePath"))){Path file=Path.of(path);check(file.startsWith(root)&&Files.isRegularFile(file)&&Media.hash(file).equals(sourceHash),"作业和来源记录显式路径重定位且同源内容未变");}
            check(Json.required(source,"id").equals(sourceVideoId)&&Json.required(source,"contentHash").equals(sourceHash),"同源视频身份不随路径变化");
            Path generation=root.resolve("media-jobs/"+videoId+"/generation");check(Media.hash(generation.resolve("complete.json")).equals(completeHash)&&Media.hash(generation.resolve("frames.jsonl")).equals(manifestHash)&&Media.hash(generation.resolve("recipe.json")).equals(recipeHash),"历史 recipe 和完成清单原始字节不重写");
            check(Media.hash(root.resolve("media-jobs/"+screeningId+"/screening.json")).equals(screeningHash),"完整筛选结果字节未变");
            check(restored.mediaJobs.screeningResult(Json.obj("jobId",screeningId,"section","items","offset",1,"limit",1)).equals(originalPage),"恢复后筛选分页与原结果一致");
            check(restored.mediaJobs.frames(Json.obj("jobId",videoId)).equals(originalFrames),"恢复后帧清单与来源时间身份完整一致");
            JsonObject retry=restored.store.read(c->Store.document(c,"media_jobs","historical-screening"));JsonObject input=Json.array(retry,"privateInputs").get(0).getAsJsonObject();check(Json.required(input,"inputImage").equals(historicalImage)&&!input.has("inputPath")&&Media.hash(root.resolve(historicalImage)).equals(Json.required(input,"contentHash")),"历史筛选相对输入仍可重建执行路径");
            check(restored.store.read(c->Json.number(Store.one(c,"SELECT COUNT(*) AS n FROM screening_features"),"n",0))==featureCount,"筛选特征表完整保留");
            restored.mediaJobs.importVideo(Json.obj("jobId",videoId));JsonObject imported=await(restored,videoId);check(Json.required(imported,"status").equals("completed")&&Json.bool(imported,"assetsCommitted",false),"原来源已删除，恢复帧仍通过实际重校验和导入");
            for(JsonElement value:Json.array(originalFrames,"items")){JsonObject frame=value.getAsJsonObject();String id="vf-"+videoId+"-"+Json.required(frame,"frameId");JsonObject metadata=Json.object(restored.projects.asset(id),"metadata");
                check(Json.required(metadata,"sourcePts").equals(Json.required(frame,"sourcePts"))&&Json.required(metadata,"originPts").equals(Json.required(frame,"originPts"))&&Json.object(metadata,"timeBase").equals(Json.object(frame,"timeBase")),"每帧 PTS 和时间基准在恢复导入后保留");
                check(Json.required(metadata,"videoSourceHash").equals(sourceHash)&&Json.required(metadata,"sourceHash").equals(Json.required(frame,"contentHash")),"原视频摘要与帧原图摘要不混淆");
            }
            DataBackups backups=new DataBackups(restored.store);check(Json.bool(backups.preflight(Json.obj("outputDir",root.getParent().toString())),"ready",false),"恢复导入后仍可完整再备份");
            restored.store.tx(c->{Store.update(c,"UPDATE media_jobs SET status='running' WHERE id='historical-screening'");return null;});JsonObject active=backups.preflight(Json.obj("outputDir",root.getParent().toString()));check(!Json.bool(active,"ready",true)&&Json.array(active,"issues").toString().contains("backup_not_quiescent"),"媒体工作状态阻止发布写入中的备份");
            restored.store.tx(c->{Store.update(c,"UPDATE media_jobs SET status='interrupted' WHERE id='historical-screening'");return null;});
            restored.store.tx(c->{JsonObject history=Store.document(c,"media_jobs","historical-screening");Json.array(history,"privateInputs").get(0).getAsJsonObject().addProperty("inputImage","../outside.png");Store.update(c,"UPDATE media_jobs SET data=? WHERE id='historical-screening'",history);return null;});
            rejects("backup_path_invalid",()->backups.preflight(Json.obj("outputDir",root.getParent().toString())));
        }
    }
}
