package cn.autolabel.engine;

import com.google.gson.*;
import com.google.gson.stream.JsonWriter;
import java.io.*;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.security.DigestOutputStream;
import java.sql.*;
import java.util.*;
import java.util.zip.*;

final class DataBackups {
    private static final String FORMAT="autolabel-backup";
    private static final long MARGIN=128L*1024*1024,MAX_MANIFEST=64L*1024*1024;
    private static final int MAX_FILES=200_000;
    private static final Set<String> JSON_TABLES=Set.of("assets","versions","samples","runs","exports","flow_steps","flow_artifact_items","run_baselines","media_jobs","video_sources");
    /**
     * 用户自有原件的依赖种类：导入时登记的外部图片，以及抽帧与流程导入选中的外部文件。
     * 它们不在受管目录内，被移动、改名或清理属于用户自己的文件管理决定，而标注基线、运行输入、
     * 流程产物与媒体产物都另有受管副本参与备份，恢复能力不受影响。
     * 若把它们当作必要依赖，任何一次历史原件的移动都会让整库备份——以及删除前的自动备份——永久失败，
     * 所以这里只降级为警告，真正受管的数据仍然阻断。
     */
    private static final Set<String> OPTIONAL_KINDS=Set.of("source","flow_import","video_source");
    private final Store store;

    DataBackups(Store store){this.store=store;}

    private static final class FileRef {
        Path source;final String target,kind;String expected,hash;long size;final Set<Path> candidates=new LinkedHashSet<>();
        FileRef(Path source,String target,String expected,String kind){this.source=source;this.target=target;this.expected=expected;this.kind=kind;candidates.add(source);}
    }
    private static final class Plan {
        final LinkedHashMap<String,FileRef> files=new LinkedHashMap<>();final JsonArray bindings=new JsonArray(),issues=new JsonArray(),warnings=new JsonArray();
        Path database;int schemaVersion;long totalBytes;String databaseHash;
    }

    JsonObject preflight(JsonObject p){
        Path work=null;
        try{
            Path output=directory(p,"outputDir");work=workDirectory();Path database=work.resolve("autolabel.db");store.snapshotDatabase(database);
            Plan plan=plan(database,store.root,false);finishPlan(plan);
            // 空间不足要先入问题清单再算 ready：反过来的话界面会同时看到「可备份」与一条错误。
            long usable=Files.getFileStore(output).getUsableSpace();
            if(usable<plan.totalBytes+MARGIN)plan.issues.add(issue("backup_space_low","目标磁盘空间不足。"));
            JsonObject result=summary(plan);result.addProperty("availableBytes",usable);result.addProperty("ready",plan.issues.isEmpty());
            return result;
        }catch(ApiError e){throw e;}catch(Exception e){throw error(500,"backup_preflight_failed","备份预检未完成，请检查文件与目录权限。");}
        finally{cleanup(work);}
    }

    JsonObject create(JsonObject p){
        Path work=null,partial=null;boolean partialCreated=false;String id=Json.id(),operation=Json.str(p,"operationId",id);
        try{
            Path output=directory(p,"outputDir");work=workDirectory();Path database=work.resolve("autolabel.db");store.snapshotDatabase(database);
            Plan plan=plan(database,store.root,false);finishPlan(plan);requireComplete(plan);requireSpace(output,plan.totalBytes);
            JsonObject manifest=manifest(plan,id);byte[] manifestBytes=manifest.toString().getBytes(StandardCharsets.UTF_8);
            if(manifestBytes.length>MAX_MANIFEST)throw error(413,"backup_manifest_large","备份依赖清单过大，请减少单个数据目录的素材数量。");
            partial=output.resolve(".autolabel-backup-"+id+".partial");Path target=output.resolve("AutoLabel-"+id+".autolabel");
            progress(operation,"copying",0,plan.files.size(),0,plan.totalBytes);long copied=0;int count=0;
            OutputStream file=Files.newOutputStream(partial,StandardOpenOption.CREATE_NEW);partialCreated=true;
            try(ZipOutputStream zip=new ZipOutputStream(new BufferedOutputStream(file))){
                zip.setLevel(1);zip.putNextEntry(new ZipEntry("manifest.json"));zip.write(manifestBytes);zip.closeEntry();
                writeEntry(zip,"database/autolabel.db",database,Files.size(database),plan.databaseHash);copied+=Files.size(database);
                for(FileRef ref:plan.files.values()){
                    requireSpace(output,0);writeEntry(zip,"files/"+ref.target,ref.source,ref.size,ref.hash);copied+=ref.size;count++;
                    if(count==plan.files.size()||count%25==0)progress(operation,"copying",count,plan.files.size(),copied,plan.totalBytes);
                }
            }
            // 复制后再次核对所有原依赖，外部软件改动引用素材时不发布看似完整的备份。
            for(FileRef ref:plan.files.values())verifyFile(ref.source,ref.size,ref.hash);
            progress(operation,"verifying",count,count,copied,plan.totalBytes);verifyArchive(partial,null);
            Files.move(partial,target,StandardCopyOption.ATOMIC_MOVE);partial=null;progress(operation,"completed",count,count,copied,plan.totalBytes);
            JsonObject result=summary(plan);result.addProperty("backupId",id);result.addProperty("backupPath",target.toString());result.addProperty("status","completed");return result;
        }catch(ApiError e){throw e;}catch(Exception e){throw error(500,"backup_create_failed","备份未能完整保存，原项目数据未改动。");}
        finally{if(partial!=null&&partialCreated)deleteOwnedFile(partial,".autolabel-backup-");cleanup(work);}
    }

    JsonObject inspect(JsonObject p){
        Path work=null;
        try{
            Path archive=archive(p);work=workDirectory();JsonObject manifest=verifyArchive(archive,work);
            rewrite(work.resolve("autolabel.db"),Json.array(manifest,"bindings"),work,null);
            Plan restored=plan(work.resolve("autolabel.db"),work,true);finishPlan(restored);requireComplete(restored);
            JsonObject result=summary(restored);result.addProperty("backupId",Json.required(manifest,"id"));result.add("createdAt",manifest.get("createdAt"));result.addProperty("valid",true);return result;
        }catch(ApiError e){throw e;}catch(Exception e){throw error(422,"backup_invalid","备份内容无法验证，请保留原文件并检查备份来源。");}
        finally{cleanup(work);}
    }

    JsonObject prepareRestore(JsonObject p){
        Path stage=null;
        try{
            Path archive=archive(p),parent=directory(p,"targetParent");
            if(parent.startsWith(store.root.toRealPath()))throw error(409,"restore_target_invalid","请选择当前数据目录之外的新位置。");
            String id=Json.id();stage=Files.createDirectory(parent.resolve(".autolabel-restore-"+id));Path target=parent.resolve("AutoLabelData-"+id);
            JsonObject manifest=verifyArchive(archive,stage);Path database=stage.resolve("autolabel.db");JsonArray bindings=Json.array(manifest,"bindings");
            rewrite(database,bindings,stage,null);Plan restored=plan(database,stage,true);finishPlan(restored);requireComplete(restored);
            // 只重定位登记过的文件字段；标注、提示词、历史清单及其摘要保持原值。
            rewrite(database,bindings,target,stage);checkDatabase(database);Files.move(stage,target,StandardCopyOption.ATOMIC_MOVE);stage=null;
            return Json.obj("status","prepared","dataDir",target.toString(),"backupId",manifest.get("id"),"fileCount",restored.files.size(),"totalBytes",restored.totalBytes,"credentialRebindRequired",true,"currentDataChanged",false);
        }catch(ApiError e){throw e;}catch(Exception e){throw error(500,"backup_restore_failed","恢复目录未能完整准备，当前数据目录未改动。");}
        finally{cleanup(stage);}
    }

    private Plan plan(Path database,Path dataRoot,boolean confined)throws Exception{
        Plan plan=new Plan();plan.database=database;plan.schemaVersion=checkDatabase(database);
        try(Connection c=open(database)){
            long active=Store.one(c,"SELECT (SELECT COUNT(*) FROM attempts WHERE status='sent')+(SELECT COUNT(*) FROM samples WHERE status IN ('preparing','sending','waiting','parsing','validating','saving'))+(SELECT COUNT(*) FROM exports WHERE json_extract(data,'$.status')='writing') AS n").get("n").getAsLong();
            if(active>0)plan.issues.add(issue("backup_not_quiescent","仍有真实在途调用或写入，请先进入数据维护状态。"));
            for(JsonObject row:Store.rows(c,"SELECT id,path,data FROM assets")){
                String id=Json.required(row,"id");JsonObject asset=Json.parse(row.get("data").getAsString());String path=Json.required(row,"path"),hash=hashValue(asset,"contentHash");
                String target=inputTarget(path,dataRoot,hash);add(plan,path,target,hash,"baseline",dataRoot,confined);bind(plan,"assets",id,"path",List.of(),path,target);
                assetSource(plan,asset,"assets",id,List.of(),dataRoot,confined);
            }
            for(JsonObject row:Store.rows(c,"SELECT id,data FROM versions"))assetSource(plan,Json.parse(row.get("data").getAsString()),"versions",row.get("id").getAsString(),List.of(),dataRoot,confined);
            for(JsonObject row:Store.rows(c,"SELECT id,data FROM samples")){
                String id=Json.required(row,"id");JsonObject sample=Json.parse(row.get("data").getAsString()),asset=Json.object(sample,"asset");
                assetSource(plan,asset,"samples",id,List.of("asset"),dataRoot,confined);
                if(sample.has("inputPath")){String path=Json.required(sample,"inputPath"),hash=inputHash(sample),target=inputTarget(path,dataRoot,hash);requireViewTarget(sample,target);add(plan,path,target,hash,"run_input",dataRoot,confined);bind(plan,"samples",id,"data",List.of("inputPath"),path,target);}
            }
            for(String table:plan.schemaVersion>=3?List.of("runs","flow_steps"):List.of("runs"))for(JsonObject row:Store.rows(c,"SELECT id,data FROM "+table)){
                String id=Json.required(row,"id");JsonObject run=Json.parse(row.get("data").getAsString());JsonArray refs=Json.array(Json.object(run,"snapshot"),"references");
                for(int i=0;i<refs.size();i++){
                    JsonObject ref=refs.get(i).getAsJsonObject();List<String> prefix=List.of("snapshot","references",String.valueOf(i));assetSource(plan,ref,table,id,prefix,dataRoot,confined);
                    if(ref.has("referenceImage"))reference(plan,ref,dataRoot,confined);
                    if(ref.has("inputPath")){String path=Json.required(ref,"inputPath"),hash=hashValue(ref,"contentHash"),target=ref.has("referenceImage")?relative(Json.required(ref,"referenceImage")):inputTarget(path,dataRoot,hash);add(plan,path,target,hash,"reference",dataRoot,confined);List<String> pointer=new ArrayList<>(prefix);pointer.add("inputPath");bind(plan,table,id,"data",pointer,path,target);}
                }
                if(table.equals("flow_steps")){JsonArray imports=Json.array(Json.object(run,"snapshot"),"importFiles");for(int i=0;i<imports.size();i++)flowSource(plan,imports.get(i).getAsJsonObject(),table,id,List.of("snapshot","importFiles",String.valueOf(i)),dataRoot,confined);}
                if(plan.schemaVersion>=4&&table.equals("flow_steps"))transformFiles(plan,run,dataRoot,confined);
            }
            if(plan.schemaVersion>=3){
                if(Json.number(Store.one(c,"SELECT COUNT(*) AS n FROM flow_steps WHERE json_extract(data,'$.workerActive')=1"),"n",0)>0)plan.issues.add(issue("backup_not_quiescent","流程文件步骤仍在执行，请等待数据维护就绪。"));
                for(JsonObject row:Store.rows(c,"SELECT id,data FROM flow_artifact_items")){String id=Json.required(row,"id");JsonObject item=Json.parse(row.get("data").getAsString()),asset=Json.object(item,"asset");assetSource(plan,asset,"flow_artifact_items",id,List.of("asset"),dataRoot,confined);flowSource(plan,item,"flow_artifact_items",id,List.of(),dataRoot,confined);
                    if(item.has("inputPath")){String path=Json.required(item,"inputPath"),hash=inputHash(item),target=inputTarget(path,dataRoot,hash);requireViewTarget(item,target);add(plan,path,target,hash,"flow_input",dataRoot,confined);bind(plan,"flow_artifact_items",id,"data",List.of("inputPath"),path,target);}
                }
            }
            if(plan.schemaVersion>=4)for(JsonObject row:Store.rows(c,"SELECT run_id,asset_id,data FROM run_baselines")){
                String runId=Json.required(row,"run_id"),assetId=Json.required(row,"asset_id");JsonObject baseline=Json.parse(row.get("data").getAsString()),asset=Json.object(baseline,"asset");
                if(baseline.has("inputPath")){String path=Json.required(baseline,"inputPath"),hash=hashValue(asset,"contentHash"),target=inputTarget(path,dataRoot,hash);add(plan,path,target,hash,"run_baseline",dataRoot,confined);bindBaseline(plan,runId,assetId,List.of("inputPath"),path,target);}
                JsonObject metadata=Json.object(asset,"metadata");String source=Json.str(metadata,"sourcePath","");if(!source.isBlank()){
                    String hash=hashValue(metadata,"sourceHash"),target="originals/imported-"+hash+(Json.str(metadata,"originalFormat","png").equals("jpeg")?".jpg":".png");add(plan,source,target,hash,"source",dataRoot,confined);bindBaseline(plan,runId,assetId,List.of("asset","metadata","sourcePath"),source,target);
                }
            }
            for(String target:plan.files.keySet())if(target.startsWith("flow-inputs/")&&target.endsWith("/input.png")){
                String generation=target.substring(0,target.indexOf("/views/"))+"/generation.json",metadata=target.substring(0,target.length()-3)+"json";
                if(!plan.files.containsKey(generation)||!plan.files.containsKey(metadata))throw error(422,"backup_transform_invalid","固定视图缺少已登记的生成或输入清单。");
            }
            if(plan.schemaVersion>=5)mediaFiles(plan,c,dataRoot,confined);
            if(plan.schemaVersion>=6)trackFiles(plan,c,dataRoot,confined);
            for(JsonObject row:Store.rows(c,"SELECT kind,data FROM resources")){
                JsonObject resource=Json.parse(row.get("data").getAsString());if(Json.required(row,"kind").equals("resource_version"))resource=Json.object(resource,"resource");
                if(Json.str(resource,"kind","").equals("reference")&&Json.object(resource,"content").has("referenceImage"))reference(plan,Json.object(resource,"content"),dataRoot,confined);
            }
            for(JsonObject row:Store.rows(c,"SELECT id,data FROM evaluation_set_versions")){
                String id=safeId(Json.required(row,"id"));JsonObject version=Json.parse(row.get("data").getAsString());String directory="evaluation-sets/"+id;
                add(plan,dataRoot.resolve(directory+"/manifest.json").toString(),directory+"/manifest.json",hashValue(version,"manifestHash"),"evaluation",dataRoot,confined);
                for(JsonElement element:Json.array(version,"assets")){JsonObject asset=element.getAsJsonObject();String file=relative(Json.str(asset,"image","images/"+safeId(Json.required(asset,"assetId"))+".png"));add(plan,dataRoot.resolve(directory).resolve(file).toString(),directory+"/"+file,hashValue(asset,"contentHash"),"evaluation",dataRoot,confined);}
            }
            for(JsonObject row:Store.rows(c,"SELECT id,data FROM exports WHERE json_extract(data,'$.status')='completed'"))export(plan,row,dataRoot,confined);
            if(plan.schemaVersion>=10)versionFiles(plan,c,dataRoot,confined);
        }
        return plan;
    }

    private void assetSource(Plan plan,JsonObject asset,String table,String id,List<String> prefix,Path root,boolean confined){
        JsonObject metadata=Json.object(asset,"metadata");String source=Json.str(metadata,"sourcePath","");if(source.isBlank())return;
        String hash=hashValue(metadata,"sourceHash"),extension=Json.str(metadata,"originalFormat","png").equals("jpeg")?".jpg":".png",target="originals/imported-"+hash+extension;
        if(!optionalSource(plan,source,root,confined))return;
        add(plan,source,target,hash,"source",root,confined);List<String> pointer=new ArrayList<>(prefix);pointer.add("metadata");pointer.add("sourcePath");bind(plan,table,id,"data",pointer,source,target);
    }
    private static void flowSource(Plan plan,JsonObject file,String table,String id,List<String> prefix,Path root,boolean confined){
        if(!file.has("sourcePath"))return;String source=Json.required(file,"sourcePath"),hash=hashValue(file,"sourceHash"),target="originals/flow-"+hash+(source.toLowerCase(Locale.ROOT).endsWith(".png")?".png":".jpg");if(!optionalSource(plan,source,root,confined))return;add(plan,source,target,hash,"flow_import",root,confined);List<String> pointer=new ArrayList<>(prefix);pointer.add("sourcePath");bind(plan,table,id,"data",pointer,source,target);
    }
    private static String inputHash(JsonObject value){JsonObject snapshot=Json.object(value,"inputSnapshot");return snapshot.has("contentHash")||Json.str(snapshot,"kind","").equals("view")?hashValue(snapshot,"contentHash"):hashValue(Json.object(value,"asset"),"contentHash");}
    private static void trackFiles(Plan plan,Connection c,Path root,boolean confined)throws Exception{
        for(JsonObject row:Store.rows(c,"SELECT data FROM timeline_frames"))trackInput(plan,Json.parse(row.get("data").getAsString()),root,confined);
        for(JsonObject row:Store.rows(c,"SELECT id,status,data FROM track_generations")){
            if(Set.of("running","cancelling").contains(Json.required(row,"status")))plan.issues.add(issue("backup_not_quiescent","轨迹生成仍在执行，请等待数据维护就绪。"));
            JsonObject job=Json.parse(row.get("data").getAsString());
            // 7C 将冻结计划独立存储，旧版本仍允许从 job.plan 读取以保持迁移兼容。
            JsonObject stored=Store.one(c,"SELECT data FROM track_generation_plans WHERE generation_id=?",row.get("id").getAsString());
            JsonElement value=stored==null?job.get("plan"):stored.get("data");
            if(value!=null&&value.isJsonPrimitive())value=Json.parse(value.getAsString());
            if(value==null||!value.isJsonObject())throw error(422,"backup_track_invalid","轨迹生成记录缺少固定计划。");
            JsonObject fixed=value.getAsJsonObject();JsonElement frames=fixed.get("frames");
            if(frames==null||!frames.isJsonArray()||frames.getAsJsonArray().size()>10000)throw error(422,"backup_track_invalid","轨迹固定计划的图片清单无效或超过上限。");
            JsonObject unhashed=fixed.deepCopy();String expected=hashValue(unhashed,"planHash");unhashed.remove("planHash");
            String actual=HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(unhashed.toString().getBytes(StandardCharsets.UTF_8)));
            if(!expected.equals(actual))throw error(422,"backup_track_invalid","轨迹固定计划与登记摘要不符。");
            for(JsonElement frame:frames.getAsJsonArray()){
                if(!frame.isJsonObject())throw error(422,"backup_track_invalid","轨迹固定计划的图片记录无效。");
                trackInput(plan,frame.getAsJsonObject(),root,confined);
            }
        }
    }
    private static void trackInput(Plan plan,JsonObject frame,Path root,boolean confined)throws Exception{
        String image=relative(Json.required(frame,"inputImage"));
        if(!allowedTarget(image)||!image.endsWith(".png")||frame.has("inputPath"))throw error(422,"backup_track_invalid","轨迹固定输入须为受管相对 PNG 文件。");
        Path file=root.resolve(image);
        if(!Files.isRegularFile(file,LinkOption.NOFOLLOW_LINKS)||!file.toRealPath().equals(file.toAbsolutePath().normalize())||!file.toRealPath().startsWith(root.toRealPath()))throw error(422,"backup_track_invalid","轨迹固定图片缺失或越过受管目录。");
        // 相对位置本身参与计划摘要；恢复同一位置即可换根，不能重写历史计划或重算其身份。
        add(plan,file.toString(),image,hashValue(frame,"contentHash"),"track_input",root,confined);
    }
    private static void mediaFiles(Plan plan,Connection c,Path root,boolean confined)throws Exception{
        for(JsonObject row:Store.rows(c,"SELECT id,status,data FROM media_jobs")){
            String id=safeId(Json.required(row,"id"));JsonObject job=Json.parse(row.get("data").getAsString());
            if(Set.of("running","cancelling").contains(Json.required(row,"status")))plan.issues.add(issue("backup_not_quiescent","媒体工作器仍在执行，请等待数据维护就绪。"));
            JsonObject frozen=Json.object(job,"frozenPlan");String sourceHash=job.has("sourceHash")?hashValue(job,"sourceHash"):frozen.has("sourceHash")?hashValue(frozen,"sourceHash"):job.has("expectedSourceHash")?hashValue(job,"expectedSourceHash"):null;
            if(job.has("sourcePath"))videoSource(plan,"media_jobs",id,List.of("sourcePath"),Json.required(job,"sourcePath"),sourceHash,root,confined);
            if(frozen.has("sourcePath"))videoSource(plan,"media_jobs",id,List.of("frozenPlan","sourcePath"),Json.required(frozen,"sourcePath"),hashValue(frozen,"sourceHash"),root,confined);
            JsonArray inputs=Json.array(job,"privateInputs");if(inputs.size()>10000)throw error(413,"backup_media_invalid","筛选固定输入超过支持数量。");
            for(JsonElement value:inputs){JsonObject input=value.getAsJsonObject();String image=relative(Json.required(input,"inputImage"));
                if(!allowedTarget(image)||!image.endsWith(".png")||input.has("inputPath"))throw error(422,"backup_media_invalid","筛选固定输入须为受管相对 PNG 文件。");Path file=root.resolve(image);managedMediaFile(file,root);add(plan,file.toString(),image,hashValue(input,"contentHash"),"screening_input",root,confined);
            }
            // 提交点由数据库确认；磁盘上单独出现 complete.json 或部分帧不能冒充完整产物。
            if(!Json.bool(job,"artifactCommitted",false))continue;
            String kind=Json.required(job,"kind");if(kind.equals("video_extract"))videoFiles(plan,job,root,confined);
            else if(kind.equals("image_screening")){String target="media-jobs/"+id+"/screening.json";Path file=root.resolve(target);managedMediaFile(file,root);if(Files.size(file)>128L*1024*1024)throw error(413,"backup_media_invalid","筛选结果超过支持大小。");add(plan,file.toString(),target,hashValue(job,"screeningHash"),"screening_result",root,confined);}
            else throw error(422,"backup_media_invalid","已提交媒体产物类型不受支持。");
        }
        for(JsonObject row:Store.rows(c,"SELECT id,data FROM video_sources")){JsonObject source=Json.parse(row.get("data").getAsString());videoSource(plan,"video_sources",Json.required(row,"id"),List.of("sourcePath"),Json.required(source,"sourcePath"),hashValue(source,"contentHash"),root,confined);}
    }
    private static void videoSource(Plan plan,String table,String id,List<String> pointer,String source,String expected,Path root,boolean confined)throws Exception{
        if(!optionalSource(plan,source,root,confined))return;
        Path file=absolute(source);String hash=expected==null?Media.hash(file):expected,name=file.getFileName().toString(),extension=name.contains(".")?name.substring(name.lastIndexOf('.')).toLowerCase(Locale.ROOT):".video";
        if(!extension.matches("\\.[a-z0-9]{1,10}"))extension=".video";String target="video-sources/"+hash+extension;
        add(plan,source,target,hash,"video_source",root,confined);bind(plan,table,id,"data",pointer,source,target);
    }
    private static void videoFiles(Plan plan,JsonObject job,Path root,boolean confined)throws Exception{
        String id=safeId(Json.required(job,"id")),prefix="media-jobs/"+id+"/generation/";Path directory=root.resolve(prefix),complete=directory.resolve("complete.json"),manifest=directory.resolve("frames.jsonl");
        managedMediaFile(complete,root);managedMediaFile(manifest,root);if(Files.size(complete)>1024*1024||Files.size(manifest)>64L*1024*1024)throw error(413,"backup_media_invalid","视频完成清单超过支持大小。");
        String completeHash=hashValue(job,"completeHash"),manifestHash=hashValue(job,"manifestHash");verifyFile(complete,Files.size(complete),completeHash);verifyFile(manifest,Files.size(manifest),manifestHash);JsonObject summary=Json.parse(Files.readString(complete,StandardCharsets.UTF_8));
        if(!id.equals(Json.str(summary,"jobId",""))||!manifestHash.equals(Json.str(summary,"manifestHash","")))throw error(422,"backup_media_invalid","视频完成记录与任务不一致。");
        for(String name:List.of("recipe.json","filter.txt","frames.jsonl","complete.json")){Path file=directory.resolve(name);managedMediaFile(file,root);add(plan,file.toString(),prefix+name,name.equals("complete.json")?completeHash:name.equals("frames.jsonl")?manifestHash:Media.hash(file),"video_metadata",root,confined);}
        String sourceVideoId=Json.required(job,"sourceVideoId");Set<String> identities=new HashSet<>();long[] bytes={0};
        jsonLines(manifest,frame->{String frameId=Json.required(frame,"frameId"),image=relative(Json.required(frame,"imagePath"));
            if(!frameId.matches("frame-[0-9]{8}")||!image.matches("frames/"+frameId+"\\.(png|jpg)")||!identities.add(frameId)||identities.size()>10000
                ||!sourceVideoId.equals(Json.required(frame,"sourceVideoId")))throw error(422,"backup_media_invalid","视频帧身份、数量或相对路径无效。");
            Path file=directory.resolve(image);managedMediaFile(file,root);long size=integerValue(frame,"bytes");String hash=hashValue(frame,"contentHash");verifyFile(file,size,hash);bytes[0]=Math.addExact(bytes[0],size);add(plan,file.toString(),prefix+image,hash,"video_frame",root,confined);
        });
        if(identities.size()!=integerValue(summary,"frameCount")||bytes[0]!=integerValue(summary,"outputBytes"))throw error(422,"backup_media_invalid","视频帧数量或大小与完成记录不一致。");
    }
    private interface JsonLine{void accept(JsonObject value)throws Exception;}
    private static void jsonLines(Path path,JsonLine action)throws Exception{
        try(InputStream input=new BufferedInputStream(Files.newInputStream(path));ByteArrayOutputStream line=new ByteArrayOutputStream()){
            byte[] block=new byte[8192];int size;while((size=input.read(block))!=-1)for(int i=0;i<size;i++){if(block[i]=='\n'){action.accept(Json.parse(line.toString(StandardCharsets.UTF_8)));line.reset();}else{if(line.size()>=65536)throw error(413,"backup_media_invalid","视频帧元数据行超过支持大小。");line.write(block[i]);}}if(line.size()>0)action.accept(Json.parse(line.toString(StandardCharsets.UTF_8)));
        }
    }
    private static void managedMediaFile(Path file,Path root)throws IOException{
        if(!Files.isRegularFile(file,LinkOption.NOFOLLOW_LINKS)||!file.toRealPath().equals(file.toAbsolutePath().normalize())||!file.toRealPath().startsWith(root.toRealPath()))throw error(422,"backup_media_invalid","媒体依赖缺失或越过受管目录。");
    }
    private static void requireViewTarget(JsonObject value,String target){JsonObject input=Json.object(value,"inputSnapshot");if(Json.str(input,"kind","").equals("view")&&(!target.startsWith("flow-inputs/")||!target.endsWith("/views/"+safeId(Json.required(input,"viewId"))+"/input.png")))throw error(422,"backup_transform_invalid","固定视图不在已登记的图像处理目录。");}
    private static void transformFiles(Plan plan,JsonObject step,Path root,boolean confined)throws Exception{
        JsonObject plans=Json.object(Json.object(step,"snapshot"),"transformPlans");if(plans.isEmpty())return;
        String prefix="flow-inputs/"+safeId(Json.required(step,"flowRunId"))+"/"+safeId(Json.required(step,"id"))+"/";
        for(var entry:plans.entrySet()){
            String assetId=safeId(entry.getKey()),directory=prefix+assetId;Path manifest=root.resolve(directory+"/generation.json");
            // 暂停可以只发布部分视图；仅按冻结计划枚举原子发布文件，不扫描临时目录。
            if(!Files.exists(manifest,LinkOption.NOFOLLOW_LINKS)){if(Files.exists(root.resolve(directory),LinkOption.NOFOLLOW_LINKS))throw error(422,"backup_transform_invalid","已有图像处理目录缺少生成清单。");continue;}
            JsonObject generation=transformJson(manifest,root,32L*1024*1024),fixed=entry.getValue().getAsJsonObject();String planHash=jsonHash(fixed);
            JsonObject baseline=Json.object(fixed,"baseline"),policy=Json.object(generation,"renderPolicy");
            if(!Json.str(generation,"kind","").equals("autolabel-transformed-images-v1")||!Json.object(generation,"plan").equals(fixed)
                ||!planHash.equals(Json.str(generation,"planHash",""))||!assetId.equals(Json.str(generation,"baselineAssetId",""))
                ||!hashValue(baseline,"contentHash").equals(Json.str(generation,"baselineContentHash",""))
                ||!jsonHash(Json.obj("planHash",planHash,"renderPolicy",policy)).equals(Json.str(generation,"recipeHash","")))
                throw error(422,"backup_transform_invalid","图像处理生成清单与固定计划不一致。");
            add(plan,manifest.toString(),directory+"/generation.json",Media.hash(manifest),"transform_metadata",root,confined);
            for(JsonElement value:Json.array(fixed,"views")){
                JsonObject view=value.getAsJsonObject();String viewId=safeId(Json.required(view,"viewId")),relative=directory+"/views/"+viewId;Path published=root.resolve(relative);
                if(!Files.exists(published,LinkOption.NOFOLLOW_LINKS))continue;
                Path image=published.resolve("input.png"),metadata=published.resolve("input.json");JsonObject snapshot=transformJson(metadata,root,1024*1024);
                String hash=hashValue(snapshot,"contentHash");
                if(!Json.str(snapshot,"kind","").equals("derived_image")||!viewId.equals(Json.str(snapshot,"viewId",""))||!Json.object(snapshot,"inputTransform").equals(view)
                    ||!planHash.equals(Json.str(snapshot,"planHash",""))||!Objects.equals(generation.get("recipeHash"),snapshot.get("recipeHash"))
                    ||!Objects.equals(generation.get("pixelTransformVersion"),snapshot.get("pixelTransformVersion"))||!policy.equals(Json.object(snapshot,"renderPolicy"))
                    ||!assetId.equals(Json.str(snapshot,"baselineAssetId",""))||!Objects.equals(generation.get("baselineContentHash"),snapshot.get("baselineContentHash"))
                    ||integerValue(snapshot,"width")!=integerValue(view,"width")||integerValue(snapshot,"height")!=integerValue(view,"height"))
                    throw error(422,"backup_transform_invalid","已发布视图清单与固定计划不一致。");
                managedTransformFile(image,root);verifyFile(image,integerValue(snapshot,"fileSize"),hash);
                add(plan,image.toString(),relative+"/input.png",hash,"flow_input",root,confined);add(plan,metadata.toString(),relative+"/input.json",Media.hash(metadata),"transform_metadata",root,confined);
            }
        }
    }
    private static void managedTransformFile(Path file,Path root)throws IOException{
        if(!Files.isRegularFile(file,LinkOption.NOFOLLOW_LINKS)||!file.toRealPath().equals(file.toAbsolutePath().normalize())||!file.toRealPath().startsWith(root.toRealPath()))
            throw error(422,"backup_transform_invalid","图像处理依赖缺失或越过受管目录。");
    }
    private static JsonObject transformJson(Path file,Path root,long limit)throws Exception{managedTransformFile(file,root);if(Files.size(file)>limit)throw error(413,"backup_manifest_large","图像处理清单超过支持大小。");return Json.parse(Files.readString(file,StandardCharsets.UTF_8));}
    private static String jsonHash(JsonElement value)throws Exception{
        // 与已发布像素清单保持同一规范序列化，键顺序和 1/1.0 不改变计划身份。
        MessageDigest digest=MessageDigest.getInstance("SHA-256");try(JsonWriter writer=new JsonWriter(new OutputStreamWriter(new DigestOutputStream(OutputStream.nullOutputStream(),digest),StandardCharsets.UTF_8))){writer.setSerializeNulls(true);canonical(writer,value);}return HexFormat.of().formatHex(digest.digest());
    }
    private static void canonical(JsonWriter writer,JsonElement value)throws IOException{
        if(value==null||value.isJsonNull())writer.nullValue();else if(value.isJsonObject()){writer.beginObject();for(String key:new TreeSet<>(value.getAsJsonObject().keySet())){writer.name(key);canonical(writer,value.getAsJsonObject().get(key));}writer.endObject();}
        else if(value.isJsonArray()){writer.beginArray();for(JsonElement item:value.getAsJsonArray())canonical(writer,item);writer.endArray();}
        else if(value.getAsJsonPrimitive().isNumber())writer.jsonValue(new BigDecimal(value.getAsString()).stripTrailingZeros().toPlainString());else if(value.getAsJsonPrimitive().isBoolean())writer.value(value.getAsBoolean());else writer.value(value.getAsString());
    }
    private void reference(Plan plan,JsonObject ref,Path root,boolean confined){String relative=relative(Json.required(ref,"referenceImage"));if(!relative.startsWith("resource-library/"))throw error(422,"backup_dependency_invalid","参考图片不在受管参考目录。");add(plan,root.resolve(relative).toString(),relative,hashValue(ref,"contentHash"),"reference",root,confined);}

    private void export(Plan plan,JsonObject row,Path root,boolean confined)throws Exception{
        String id=safeId(Json.required(row,"id"));JsonObject record=Json.parse(row.get("data").getAsString());Path source=absolute(Json.required(record,"path"));
        if(confined&&!source.startsWith(root))throw error(422,"backup_binding_missing","恢复后的导出目录仍指向备份之外。");
        String target="exports/"+id;Path manifest=exportFile(source,"manifest.json");
        if(!Files.isRegularFile(manifest)){plan.issues.add(issue("backup_dependency_missing","历史导出清单缺失："+id));return;}
        if(Files.size(manifest)>MAX_MANIFEST)throw error(413,"backup_manifest_large","历史导出清单超过支持大小。");
        String expected=Json.str(record,"manifestHash",null);if(expected!=null)verifyFile(manifest,Files.size(manifest),expected);else plan.warnings.add(issue("legacy_export_unverified","此旧导出仅核验当前备份内容，不补造历史验证结果："+id));
        JsonObject definition=Json.parse(Files.readString(manifest));if(!id.equals(Json.required(definition,"id")))throw error(422,"backup_dependency_invalid","历史导出标识与清单不一致。");
        add(plan,manifest.toString(),target+"/manifest.json",expected,"export",root,confined);bind(plan,"exports",id,"data",List.of("path"),source.toString(),target);
        if(record.has("manifestPath"))bind(plan,"exports",id,"data",List.of("manifestPath"),Json.required(record,"manifestPath"),target+"/manifest.json");
        boolean classification=Json.required(definition,"taskType").equals("classify");
        for(JsonElement element:Json.array(definition,"assets")){
            JsonObject asset=element.getAsJsonObject();String image=relative(Json.required(asset,"image"));add(plan,exportFile(source,image).toString(),target+"/"+image,hashValue(asset,"contentHash"),"export",root,confined);
            if(!classification){String split=Json.required(asset,"split");if(!Set.of("train","val").contains(split))throw error(422,"backup_dependency_invalid","历史导出划分无效。");String label="labels/"+split+"/"+safeId(Json.required(asset,"assetId"))+".txt";add(plan,exportFile(source,label).toString(),target+"/"+label,Json.str(asset,"labelHash",null),"export",root,confined);}
        }
        if(!classification)add(plan,exportFile(source,"data.yaml").toString(),target+"/data.yaml",Json.str(record,"yamlHash",null),"export",root,confined);
    }
    private static Path exportFile(Path directory,String name)throws IOException{
        Path file=directory.resolve(relative(name));
        if(Files.exists(file)&&!file.toRealPath().startsWith(directory.toRealPath()))throw error(422,"backup_dependency_invalid","历史导出依赖通过链接越过登记目录。");return file;
    }

    /**
     * 数据集版本副本：清单、辅助文件与逐项副本整体纳入备份。
     * 版本目录内的相对位置即恢复位置，故不登记路径绑定；恢复后同一版本仍可按清单复核（I1、I3、I8）。
     */
    private static void versionFiles(Plan plan,Connection c,Path root,boolean confined)throws Exception{
        for(JsonObject row:Store.rows(c,"SELECT id,manifest_hash FROM dataset_versions WHERE status='ready'")){
            String versionId=safeId(Json.required(row,"id")),directory="datasets/versions/"+versionId;
            Path base=root.resolve("datasets").resolve("versions").resolve(versionId),manifest=base.resolve("manifest.json");
            add(plan,manifest.toString(),directory+"/manifest.json",Json.str(row,"manifest_hash",null),"dataset_version",root,confined);
            for(JsonObject item:Store.rows(c,"SELECT data FROM dataset_version_items WHERE version_id=? ORDER BY position",versionId)){
                JsonObject entry=Json.parse(item.get("data").getAsString());
                // 被排除与采样丢弃项没有副本文件，只在数据库记录中保留原因码。
                String image=Json.str(entry,"image",""),label=Json.str(entry,"label","");
                if(!image.isBlank())add(plan,base.resolve(relative(image)).toString(),directory+"/"+relative(image),Json.str(entry,"contentHash",null),"dataset_version",root,confined);
                if(!label.isBlank())add(plan,base.resolve(relative(label)).toString(),directory+"/"+relative(label),Json.str(entry,"labelHash",null),"dataset_version",root,confined);
            }
            // 辅助文件范围取自清单本身，避免目录扫描把无关文件带进备份。
            if(Files.isRegularFile(manifest,LinkOption.NOFOLLOW_LINKS))for(JsonElement element:Json.array(Json.parse(Files.readString(manifest,StandardCharsets.UTF_8)),"auxiliaryFiles")){
                JsonObject auxiliary=element.getAsJsonObject();String path=relative(Json.required(auxiliary,"path"));
                add(plan,base.resolve(path).toString(),directory+"/"+path,hashValue(auxiliary,"hash"),"dataset_version",root,confined);
            }
        }
    }

    private static void add(Plan plan,String source,String target,String expected,String kind,Path root,boolean confined){
        target=relative(target);Path input=absolute(source);if(confined&&!input.startsWith(root))throw error(422,"backup_binding_missing","恢复后的素材仍指向备份之外。");
        FileRef previous=plan.files.get(target);if(previous!=null){if(expected!=null&&previous.expected!=null&&!expected.equals(previous.expected))throw error(422,"backup_dependency_conflict","不同文件版本使用了同一保存位置。");if(previous.expected==null)previous.expected=expected;previous.candidates.add(input);return;}
        if(plan.files.size()>=MAX_FILES)throw error(413,"backup_file_limit","单次备份依赖文件过多。");plan.files.put(target,new FileRef(input,target,expected,kind));
    }
    private static void bind(Plan plan,String table,String id,String column,List<String> pointer,String original,String target){plan.bindings.add(Json.obj("table",table,"id",id,"column",column,"pointer",pointer,"original",original,"target",relative(target)));}
    private static void bindBaseline(Plan plan,String runId,String assetId,List<String> pointer,String original,String target){plan.bindings.add(Json.obj("table","run_baselines","runId",runId,"assetId",assetId,"column","data","pointer",pointer,"original",original,"target",relative(target)));}

    private static void finishPlan(Plan plan)throws Exception{
        plan.totalBytes=Files.size(plan.database);plan.databaseHash=Media.hash(plan.database);Map<String,Path> known=new HashMap<>();
        // 相同内容的历史路径可能仍可读取，不能因第一条路径失效而丢掉已登记副本。
        for(FileRef file:plan.files.values())for(Path candidate:file.candidates)if(Files.isRegularFile(candidate)){
            try{String hash=Media.hash(candidate);if(file.expected==null||hash.equals(file.expected))known.put(hash,candidate);}catch(IOException ignored){/* 下方统一报告不可读取依赖。 */}
        }
        List<FileRef> unavailable=new ArrayList<>();
        for(FileRef file:plan.files.values()){
            if(file.expected!=null&&known.containsKey(file.expected))file.source=known.get(file.expected);
            try{
                if(!Files.isRegularFile(file.source))throw error(422,"backup_dependency_missing","依赖文件缺失。");
                file.size=Files.size(file.source);file.hash=Media.hash(file.source);if(file.expected!=null&&!file.expected.equals(file.hash))throw error(422,"backup_dependency_changed","依赖文件内容已变化。");
                plan.totalBytes=Math.addExact(plan.totalBytes,file.size);
            }catch(Exception e){
                JsonObject record=Json.obj("code",e instanceof ApiError a?a.code:"backup_dependency_unavailable","target",file.target,"kind",file.kind,"message","依赖文件缺失、内容变化或不可访问。");
                if(!OPTIONAL_KINDS.contains(file.kind)){plan.issues.add(record);continue;}
                plan.warnings.add(record);unavailable.add(file);
            }
        }
        // 取不到的外部原件不能进压缩包：留在清单里会让归档校验在大小与摘要上失败；
        // 它的路径绑定也要一并撤掉，否则绑定会指向一个不存在的条目。
        // 撤掉绑定意味着恢复后的数据库保留该字段的原值（仍是用户机器上的原始路径），
        // 由素材重定位负责重新指向，这是「原件本来就取不到」时唯一诚实的处理。
        for(FileRef file:unavailable){plan.files.remove(file.target);dropBindings(plan,file.target);}
    }
    private static void dropBindings(Plan plan,String target){
        // JsonArray 没有 clear()，倒序按索引移除即可，避免重建数组时漏掉引用关系。
        for(int i=plan.bindings.size()-1;i>=0;i--)if(target.equals(Json.str(plan.bindings.get(i).getAsJsonObject(),"target","")))plan.bindings.remove(i);
    }
    /**
     * 用户自有原件在恢复校验阶段的登记前置检查。
     * 备份时取不到原件的那一项已被降级为警告并撤掉绑定，数据库里仍保留它的原始绝对路径；
     * 校验备份内容（confined=true）时这条越界路径是预期结果，不能按「越过备份范围」报错。
     * 受管数据不走这条路径，仍由 add 做越界检查。
     */
    private static boolean optionalSource(Plan plan,String source,Path root,boolean confined){
        if(!confined||absolute(source).startsWith(root))return true;
        plan.warnings.add(Json.obj("code","backup_source_external","target",source,"kind","source","message","原件不在受管目录内，恢复后保留原路径，需由素材重定位处理。"));
        return false;
    }

    private static JsonObject manifest(Plan plan,String id){
        JsonArray files=new JsonArray();for(FileRef file:plan.files.values())files.add(Json.obj("entry","files/"+file.target,"target",file.target,"size",file.size,"sha256",file.hash,"kind",file.kind));
        return Json.obj("format",FORMAT,"formatVersion",1,"id",id,"createdAt",Json.now(),"schemaVersion",plan.schemaVersion,"database",Json.obj("entry","database/autolabel.db","size",size(plan.database),"sha256",plan.databaseHash),"files",files,"bindings",plan.bindings,"totalBytes",plan.totalBytes,"credentialsIncluded",false);
    }

    private static JsonObject verifyArchive(Path archive,Path destination)throws Exception{
        try(ZipFile zip=new ZipFile(archive.toFile())){
            LinkedHashMap<String,ZipEntry> entries=new LinkedHashMap<>();Set<String> caseNames=new HashSet<>();Enumeration<? extends ZipEntry> iterator=zip.entries();
            while(iterator.hasMoreElements()){
                ZipEntry entry=iterator.nextElement();String name=relative(entry.getName());if(entry.isDirectory()||!caseNames.add(name.toLowerCase(Locale.ROOT))||entries.putIfAbsent(name,entry)!=null)throw error(422,"backup_archive_invalid","备份包含重复条目或非文件条目。");
                if(entries.size()>MAX_FILES+2)throw error(413,"backup_file_limit","备份条目过多。");
            }
            ZipEntry descriptor=entries.get("manifest.json");if(descriptor==null||descriptor.getSize()<1||descriptor.getSize()>MAX_MANIFEST)throw error(422,"backup_manifest_invalid","备份清单缺失或大小无效。");
            byte[] bytes;try(InputStream in=zip.getInputStream(descriptor)){bytes=in.readNBytes((int)MAX_MANIFEST+1);}if(bytes.length!=descriptor.getSize())throw error(422,"backup_manifest_invalid","备份清单大小不一致。");
            JsonObject manifest=Json.parse(new String(bytes,StandardCharsets.UTF_8));
            if(!FORMAT.equals(Json.str(manifest,"format",""))||integerValue(manifest,"formatVersion")!=1||!manifest.has("credentialsIncluded")||!manifest.get("credentialsIncluded").isJsonPrimitive()||!manifest.getAsJsonPrimitive("credentialsIncluded").isBoolean()||manifest.get("credentialsIncluded").getAsBoolean())throw error(422,"backup_format_unsupported","备份格式或版本不受支持。");
            if(!manifest.has("files")||!manifest.get("files").isJsonArray()||!manifest.has("bindings")||!manifest.get("bindings").isJsonArray())throw error(422,"backup_manifest_invalid","备份缺少文件或路径绑定清单。");
            safeId(Json.required(manifest,"id"));JsonObject database=Json.object(manifest,"database");if(!Json.str(database,"entry","").equals("database/autolabel.db"))throw error(422,"backup_manifest_invalid","数据库条目无效。");
            JsonArray files=Json.array(manifest,"files");if(files.size()>MAX_FILES||entries.size()!=files.size()+2)throw error(422,"backup_archive_invalid","备份实际条目与清单不一致。");
            LinkedHashMap<String,JsonObject> declared=new LinkedHashMap<>();declared.put("database/autolabel.db",database);Set<String> targets=new HashSet<>();long total=positiveSize(database);
            for(JsonElement element:files){
                JsonObject file=element.getAsJsonObject();String target=relative(Json.required(file,"target")),name=relative(Json.required(file,"entry"));
                if(!allowedTarget(target)||!name.equals("files/"+target)||!targets.add(target)||declared.putIfAbsent(name,file)!=null)throw error(422,"backup_manifest_invalid","备份文件位置重复或无效。");
                total=Math.addExact(total,positiveSize(file));
            }
            if(total!=integerValue(manifest,"totalBytes"))throw error(422,"backup_manifest_invalid","备份总大小不一致。");
            if(destination!=null)requireSpace(destination,total);
            for(var entry:declared.entrySet()){
                ZipEntry stored=entries.get(entry.getKey());JsonObject spec=entry.getValue();long expected=positiveSize(spec);String hash=hashValue(spec,"sha256");
                if(stored==null||stored.getSize()!=expected)throw error(422,"backup_archive_invalid","备份文件大小与清单不一致。");
                Path target=destination==null?null:destination.resolve(entry.getKey().equals("database/autolabel.db")?"autolabel.db":Json.required(spec,"target"));
                if(target!=null){Files.createDirectories(target.getParent());if(!target.normalize().startsWith(destination.normalize()))throw error(422,"backup_path_invalid","备份条目越过目标目录。");}
                try(InputStream input=zip.getInputStream(stored);OutputStream output=target==null?OutputStream.nullOutputStream():Files.newOutputStream(target,StandardOpenOption.CREATE_NEW)){copyChecked(input,output,expected,hash);}
            }
            for(JsonElement element:Json.array(manifest,"bindings"))validateBinding(element.getAsJsonObject(),targets);
            if(destination!=null){int schema=checkDatabase(destination.resolve("autolabel.db"));if(schema!=integerValue(manifest,"schemaVersion"))throw error(422,"backup_schema_invalid","清单与数据库版本不一致。");}
            return manifest;
        }catch(ZipException e){throw error(422,"backup_archive_invalid","备份压缩文件损坏或不完整。");}
    }

    private static void validateBinding(JsonObject binding,Set<String> targets){
        String table=Json.required(binding,"table"),column=Json.required(binding,"column"),target=relative(Json.required(binding,"target"));JsonArray pointer=Json.array(binding,"pointer");
        if(table.equals("run_baselines")){Json.required(binding,"runId");Json.required(binding,"assetId");if(binding.has("id"))throw error(422,"backup_binding_invalid","固定父图必须使用运行与素材复合标识。");}else Json.required(binding,"id");Json.required(binding,"original");boolean allowed=false;
        List<String> path=new ArrayList<>();for(JsonElement element:pointer){if(!element.isJsonPrimitive()||!element.getAsJsonPrimitive().isString())throw error(422,"backup_binding_invalid","路径绑定字段无效。");path.add(element.getAsString());}
        if(table.equals("assets")&&column.equals("path")&&path.isEmpty())allowed=true;
        if(JSON_TABLES.contains(table)&&column.equals("data")){
            if(Set.of("assets","versions").contains(table)&&path.equals(List.of("metadata","sourcePath")))allowed=true;
            if(table.equals("samples")&&(path.equals(List.of("inputPath"))||path.equals(List.of("asset","metadata","sourcePath"))))allowed=true;
            if(table.equals("run_baselines")&&(path.equals(List.of("inputPath"))||path.equals(List.of("asset","metadata","sourcePath"))))allowed=true;
            if(table.equals("video_sources")&&path.equals(List.of("sourcePath")))allowed=true;
            if(table.equals("media_jobs")&&(path.equals(List.of("sourcePath"))||path.equals(List.of("frozenPlan","sourcePath"))))allowed=true;
            if(table.equals("exports")&&(path.equals(List.of("path"))||path.equals(List.of("manifestPath"))))allowed=true;
            if(Set.of("runs","flow_steps").contains(table)&&path.size()>=4&&path.get(0).equals("snapshot")&&path.get(1).equals("references")&&path.get(2).matches("[0-9]{1,6}")&&(path.subList(3,path.size()).equals(List.of("inputPath"))||path.subList(3,path.size()).equals(List.of("metadata","sourcePath"))))allowed=true;
            if(table.equals("flow_steps")&&path.size()==4&&path.get(0).equals("snapshot")&&path.get(1).equals("importFiles")&&path.get(2).matches("[0-9]{1,6}")&&path.get(3).equals("sourcePath"))allowed=true;
            if(table.equals("flow_artifact_items")&&(path.equals(List.of("inputPath"))||path.equals(List.of("sourcePath"))||path.equals(List.of("asset","metadata","sourcePath"))))allowed=true;
        }
        boolean directory=table.equals("exports")&&path.equals(List.of("path"));
        if(!allowed||(!directory&&!targets.contains(target))||(directory&&targets.stream().noneMatch(item->item.startsWith(target+"/"))))throw error(422,"backup_binding_invalid","备份试图修改未登记的文件路径字段。");
    }

    private static void rewrite(Path database,JsonArray bindings,Path destination,Path previous)throws Exception{
        try(Connection c=open(database)){
            c.setAutoCommit(false);try{
                for(JsonElement element:bindings){
                    JsonObject binding=element.getAsJsonObject();String table=Json.required(binding,"table"),column=Json.required(binding,"column"),target=relative(Json.required(binding,"target"));
                    boolean baseline=table.equals("run_baselines");String where=baseline?"run_id=? AND asset_id=?":"id=?";Object[] keys=baseline?new Object[]{Json.required(binding,"runId"),Json.required(binding,"assetId")}:new Object[]{Json.required(binding,"id")};
                    String expected=previous==null?Json.required(binding,"original"):previous.resolve(target).toAbsolutePath().normalize().toString();String resolved=destination.resolve(target).toAbsolutePath().normalize().toString();
                    JsonObject row=Store.one(c,"SELECT "+column+" FROM "+table+" WHERE "+where,keys);if(row==null)throw error(422,"backup_binding_invalid","路径绑定记录不存在。");
                    if(column.equals("path")){if(!Json.required(row,column).equals(expected))throw error(422,"backup_binding_invalid","路径绑定与数据库不一致。");Store.update(c,"UPDATE "+table+" SET path=? WHERE id=?",resolved,keys[0]);}
                    else{
                        JsonObject value=Json.parse(row.get(column).getAsString());JsonArray pointer=Json.array(binding,"pointer");JsonElement parent=value;
                        for(int i=0;i<pointer.size()-1;i++){String key=pointer.get(i).getAsString();parent=parent.isJsonArray()?parent.getAsJsonArray().get(Integer.parseInt(key)):parent.getAsJsonObject().get(key);if(parent==null)throw error(422,"backup_binding_invalid","路径字段不存在。");}
                        String key=pointer.get(pointer.size()-1).getAsString();JsonElement old=parent.getAsJsonObject().get(key);
                        if(old==null||!old.isJsonPrimitive()||!old.getAsString().equals(expected))throw error(422,"backup_binding_invalid","路径绑定与数据库不一致。");parent.getAsJsonObject().addProperty(key,resolved);
                        Object[] arguments=baseline?new Object[]{value,keys[0],keys[1]}:new Object[]{value,keys[0]};Store.update(c,"UPDATE "+table+" SET data=? WHERE "+where,arguments);
                    }
                }
                c.commit();
            }catch(Exception e){c.rollback();throw e;}
        }
    }

    private static Connection open(Path database)throws SQLException{
        Connection c=DriverManager.getConnection("jdbc:sqlite:"+database);try(Statement statement=c.createStatement()){statement.execute("PRAGMA foreign_keys=ON");statement.execute("PRAGMA trusted_schema=OFF");}return c;
    }
    private static int checkDatabase(Path database)throws Exception{
        if(!Files.isRegularFile(database))throw error(422,"backup_database_invalid","备份数据库缺失。");
        try(Connection c=open(database);Statement statement=c.createStatement()){
            try(ResultSet result=statement.executeQuery("PRAGMA integrity_check")){if(!result.next()||!"ok".equals(result.getString(1)))throw error(422,"backup_database_invalid","备份数据库完整性校验失败。");}
            try(ResultSet result=statement.executeQuery("PRAGMA foreign_key_check")){if(result.next())throw error(422,"backup_database_invalid","备份数据库关联校验失败。");}
            try(ResultSet result=statement.executeQuery("PRAGMA user_version")){int version=result.getInt(1);if(version<2||version>Store.SCHEMA_VERSION)throw error(422,"backup_schema_unsupported","当前备份入口只支持版本 2 至 "+Store.SCHEMA_VERSION+" 数据库。");return version;}
        }
    }
    private static void writeEntry(ZipOutputStream zip,String name,Path source,long size,String hash)throws Exception{
        verifyFile(source,size,hash);zip.putNextEntry(new ZipEntry(name));try(InputStream input=Files.newInputStream(source)){copyChecked(input,zip,size,hash);}zip.closeEntry();
    }
    private static void copyChecked(InputStream input,OutputStream output,long expected,String expectedHash)throws Exception{
        MessageDigest digest=MessageDigest.getInstance("SHA-256");byte[] buffer=new byte[65536];long copied=0;int n;
        while((n=input.read(buffer))!=-1){copied=Math.addExact(copied,n);if(copied>expected)throw error(422,"backup_size_mismatch","备份文件解压大小超出清单声明。");output.write(buffer,0,n);digest.update(buffer,0,n);}
        if(copied!=expected||!HexFormat.of().formatHex(digest.digest()).equals(expectedHash))throw error(422,"backup_hash_mismatch","备份文件大小或摘要校验失败。");
    }
    private static void verifyFile(Path path,long size,String hash)throws Exception{if(!Files.isRegularFile(path)||Files.size(path)!=size||!Media.hash(path).equals(hash))throw error(422,"backup_dependency_changed","依赖文件在备份期间变化或与登记内容不符。");}
    private static JsonObject summary(Plan plan){return Json.obj("schemaVersion",plan.schemaVersion,"fileCount",plan.files.size(),"totalBytes",plan.totalBytes,"issues",plan.issues,"warnings",plan.warnings,"credentialsIncluded",false,"credentialRebindRequired",true);}
    private static void requireComplete(Plan plan){if(!plan.issues.isEmpty())throw new ApiError(422,"backup_dependencies_invalid","必要依赖缺失、变化或仍在写入，未生成完整备份。",Json.obj("issues",plan.issues));}
    private static void requireSpace(Path directory,long bytes)throws IOException{if(Files.getFileStore(directory).getUsableSpace()<Math.addExact(bytes,MARGIN))throw error(507,"backup_space_low","备份或恢复目标磁盘空间不足。");}
    private static long positiveSize(JsonObject object){return integerValue(object,"size");}
    private static long integerValue(JsonObject object,String key){try{JsonElement value=object.get(key);if(value==null||!value.isJsonPrimitive()||!value.getAsJsonPrimitive().isNumber())throw new ArithmeticException();long size=value.getAsBigDecimal().longValueExact();if(size<0)throw new ArithmeticException();return size;}catch(Exception e){throw error(422,"backup_manifest_invalid","备份大小和版本必须是非负整数。");}}
    private static long size(Path path){try{return Files.size(path);}catch(IOException e){throw error(500,"backup_dependency_unavailable","无法读取备份依赖大小。");}}
    private static String hashValue(JsonObject object,String key){String hash=Json.required(object,key);if(!hash.matches("[a-f0-9]{64}"))throw error(422,"backup_hash_invalid","备份依赖缺少有效的 SHA-256。");return hash;}
    private static String safeId(String value){if(!value.matches("[a-zA-Z0-9_-]{1,100}"))throw error(422,"backup_dependency_invalid","依赖标识无效。");return value;}
    private static String relative(String value){
        if(value.isEmpty()||value.length()>8192||value.indexOf('\\')>=0||value.startsWith("/")||value.contains(":")||value.indexOf('\0')>=0)throw error(422,"backup_path_invalid","备份条目必须是安全的相对路径。");
        for(String part:value.split("/",-1))if(part.isEmpty()||part.equals(".")||part.equals("..")||part.endsWith(".")||part.endsWith(" ")||part.matches(".*[\\x00-\\x1f<>\"|?*].*")||part.matches("(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])(\\..*)?"))throw error(422,"backup_path_invalid","备份条目包含不安全路径。");return value;
    }
    private static boolean allowedTarget(String target){return List.of("media/","originals/","run-inputs/","resource-library/","evaluation-sets/","exports/","datasets/versions/").stream().anyMatch(target::startsWith)
        ||target.matches("video-sources/[a-f0-9]{64}\\.[a-z0-9]{1,10}")
        ||target.matches("media-jobs/[a-zA-Z0-9_-]{1,100}/(?:screening\\.json|generation/(?:recipe\\.json|filter\\.txt|frames\\.jsonl|complete\\.json|frames/frame-[0-9]{8}\\.(?:png|jpg)))")
        ||target.matches("flow-inputs/[a-zA-Z0-9_-]{1,100}/[a-zA-Z0-9_-]{1,100}/[a-zA-Z0-9_-]{1,100}/(?:generation\\.json|views/[a-zA-Z0-9_-]{1,100}/input\\.(?:png|json))");}
    private static String inputTarget(String source,Path root,String hash){Path path=absolute(source);if(path.startsWith(root)){String relative=root.relativize(path).toString().replace('\\','/');if(allowedTarget(relative))return relative(relative);}return "run-inputs/"+hash+".png";}
    private static Path absolute(String value){Path path=Path.of(value);if(!path.isAbsolute())throw error(422,"backup_dependency_invalid","依赖文件路径必须是绝对路径。");return path.toAbsolutePath().normalize();}
    private static Path archive(JsonObject p){Path file=absolute(Json.required(p,"backupPath"));if(!Files.isRegularFile(file))throw error(404,"backup_missing","请选择可读取的备份文件。");return file;}
    private static Path directory(JsonObject p,String key)throws IOException{Path directory=absolute(Json.required(p,key));if(!Files.isDirectory(directory)||!Files.isWritable(directory))throw error(400,"backup_directory_unavailable","请选择已存在且可写的目录。");return directory.toRealPath();}
    private Path workDirectory()throws IOException{Path parent=store.root.resolve(".backup-work");Files.createDirectories(parent);if(!parent.toRealPath().startsWith(store.root.toRealPath()))throw error(409,"backup_path_invalid","备份临时目录不能指向数据目录之外。");return Files.createTempDirectory(parent,"backup-");}
    private void progress(String operation,String phase,int done,int total,long bytes,long size){store.tx(c->{Store.event(c,"backup.progress",null,null,null,Json.obj("operationId",operation,"phase",phase,"completedFiles",done,"totalFiles",total,"copiedBytes",bytes,"totalBytes",size));return null;});}
    private static void cleanup(Path path){
        if(path==null)return;Path absolute=path.toAbsolutePath().normalize();String name=absolute.getFileName().toString();
        if(!name.startsWith("backup-")&&!name.startsWith(".autolabel-restore-"))return;
        try{if(Files.isSymbolicLink(absolute))return;try(var files=Files.walk(absolute)){for(Path file:files.sorted(Comparator.reverseOrder()).toList())if(file.toAbsolutePath().normalize().startsWith(absolute))Files.deleteIfExists(file);}}catch(IOException ignored){/* 未完成目录保持不可用，不清理任务目录以外的文件。 */}
    }
    private static void deleteOwnedFile(Path file,String prefix){try{if(file.getFileName().toString().startsWith(prefix))Files.deleteIfExists(file);}catch(IOException ignored){}}
    private static JsonObject issue(String code,String message){return Json.obj("code",code,"message",message);}
    private static ApiError error(int status,String code,String message){return new ApiError(status,code,message);}
}
