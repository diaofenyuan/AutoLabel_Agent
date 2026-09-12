package cn.autolabel.engine;

import com.google.gson.*;
import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.sql.*;
import java.util.*;
import java.util.function.Consumer;
import java.util.zip.*;

public final class DataBackupsTest {
    private static int checks;
    private interface Action{void run()throws Exception;}
    private static void check(boolean condition,String message){checks++;if(!condition)throw new AssertionError(message);}
    private static void rejects(String code,Action action)throws Exception{try{action.run();throw new AssertionError("Expected "+code);}catch(ApiError error){check(error.code.equals(code),"Expected "+code+", got "+error.code+": "+error.getMessage());}}
    private record Fixture(String projectId,String first,String second,String referenceId,String setVersionId,String exportId,Path externalSource,Path exportDirectory,String labelHash,String evaluationManifestHash){}

    public static void main(String[] args)throws Exception{
        Path root=args.length==0?Files.createTempDirectory("autolabel-backup-test-"):Path.of(args[0]).toAbsolutePath().resolve("backup-test-"+Json.id());Files.createDirectories(root);
        run(root);System.out.println("Data backups: "+checks+" checks passed; isolated data: "+root);
    }

    static void run(Path root)throws Exception{
        Path archives=Files.createDirectories(root.resolve("备份 输出")),restoreParent=Files.createDirectories(root.resolve("恢复 数据"));
        try(Store store=new Store(root.resolve("live"))){
            Fixture fixture=fixture(root,store);DataBackups backups=new DataBackups(store);
            // 保留真实 WAL 数据；不关闭连接、不手工检查点后直接调用一致快照。
            store.tx(c->{Store.update(c,"INSERT INTO settings(id,data) VALUES('wal-marker',?)",Json.obj("value","最新 WAL 写入"));return null;});
            Path direct=root.resolve("direct.db");store.snapshotDatabase(direct);
            try(Connection copy=DriverManager.getConnection("jdbc:sqlite:"+direct)){check(Store.one(copy,"SELECT data FROM settings WHERE id='wal-marker'")!=null,"snapshot includes committed WAL data");}
            rejects("backup_output_exists",()->store.snapshotDatabase(direct));check(Files.isRegularFile(direct),"existing snapshot is never overwritten");
            JsonObject preview=backups.preflight(Json.obj("outputDir",archives.toString()));check(Json.bool(preview,"ready",false)&&Json.array(preview,"issues").isEmpty(),"complete fixture passes preflight");
            check(Json.integer(preview,"fileCount",0)>8,"preflight includes source, baseline, evaluation, reference and export dependencies");
            JsonObject created=backups.create(Json.obj("outputDir",archives.toString(),"operationId","fixture-backup"));Path archive=Path.of(Json.required(created,"backupPath"));
            check(Files.isRegularFile(archive)&&Json.str(created,"status","").equals("completed"),"archive is published only after verification");
            JsonObject manifest=manifest(archive);check(!Json.bool(manifest,"credentialsIncluded",true),"archive declares no credentials");
            try(ZipFile zip=new ZipFile(archive.toFile())){check(zip.stream().noneMatch(entry->entry.getName().contains("credentials")||entry.getName().contains("obsolete.db")||entry.getName().contains("thumbnail-cache")),"unregistered private files, old backups and cache excluded");}
            check(Json.bool(backups.inspect(Json.obj("backupPath",archive.toString())),"valid",false),"archive inspection verifies full restore dependencies");

            Projects original=new Projects(store);original.save(Json.obj("assetId",fixture.first,"baseVersion",2,"annotations",Json.arr(box(21)),"confirm",true));
            byte[] sourceBytes=Files.readAllBytes(fixture.externalSource);Files.writeString(fixture.externalSource,"source changed after backup");
            JsonObject restored=backups.prepareRestore(Json.obj("backupPath",archive.toString(),"targetParent",restoreParent.toString()));Path destination=Path.of(Json.required(restored,"dataDir"));
            check(!destination.equals(store.root)&&destination.startsWith(restoreParent),"restore prepares a fresh directory with Chinese and spaces");
            check(Json.bool(restored,"credentialRebindRequired",false)&&!Json.bool(restored,"currentDataChanged",true),"restore requests rebinding and leaves current data alone");
            verifyRestored(destination,fixture);
            check(Json.integer(original.asset(fixture.first),"version",0)==3,"live project remains at its later revision");
            check(Files.readString(fixture.externalSource).equals("source changed after backup"),"restore never overwrites the external source");
            try(Store again=new Store(destination)){check(Json.integer(new Projects(again).asset(fixture.first),"version",0)==2,"prepared database reopens with frozen version");}

            JsonObject missing=backups.preflight(Json.obj("outputDir",archives.toString()));check(!Json.bool(missing,"ready",true)&&!Json.array(missing,"issues").isEmpty(),"changed external original prevents complete backup");
            long before=children(archives);rejects("backup_dependencies_invalid",()->backups.create(Json.obj("outputDir",archives.toString())));check(children(archives)==before,"failed backup does not publish a partial archive");
            Files.write(fixture.externalSource,sourceBytes);
            store.tx(c->{JsonObject asset=Store.document(c,"assets",fixture.second);Json.object(asset,"metadata").addProperty("sourcePath",root.resolve("已移动的原图.jpg").toString());Store.update(c,"UPDATE assets SET data=? WHERE id=?",asset,fixture.second);return null;});
            check(Json.bool(backups.preflight(Json.obj("outputDir",archives.toString())),"ready",false),"duplicate dependency can use the registered historical source when the first path is missing");
            store.tx(c->{JsonObject asset=Store.document(c,"assets",fixture.second);Json.object(asset,"metadata").addProperty("sourcePath",fixture.externalSource.toString());Store.update(c,"UPDATE assets SET data=? WHERE id=?",asset,fixture.second);return null;});
            store.tx(c->{Store.update(c,"UPDATE attempts SET status='sent' WHERE id='unknown-attempt'");return null;});
            JsonObject active=backups.preflight(Json.obj("outputDir",archives.toString()));check(Json.array(active,"issues").toString().contains("backup_not_quiescent"),"actual in-flight request blocks snapshot publication");
            store.tx(c->{Store.update(c,"UPDATE attempts SET status='unknown' WHERE id='unknown-attempt'");return null;});
            rejects("restore_target_invalid",()->backups.prepareRestore(Json.obj("backupPath",archive.toString(),"targetParent",store.root.toString())));
            malformed(root,archives,restoreParent,store,backups,archive,fixture);
            store.tx(c->{try(Statement statement=c.createStatement()){statement.execute("PRAGMA user_version="+(Store.SCHEMA_VERSION+1));}return null;});
            rejects("backup_schema_unsupported",()->backups.preflight(Json.obj("outputDir",archives.toString())));
            store.tx(c->{try(Statement statement=c.createStatement()){statement.execute("PRAGMA user_version="+Store.SCHEMA_VERSION);}return null;});
            check(children(store.root.resolve(".backup-work"))==0,"private staging directories cleaned after success and failure");
        }
    }

    private static Fixture fixture(Path root,Store store)throws Exception{
        Projects projects=new Projects(store);JsonObject project=projects.create(Json.obj("name","备份夹具","taskType","detect","classes",Json.arr(Json.obj("id","item","name","物品","color","#4488ff")),"settings",Json.obj("prompt","路径文本 C:/old/path 只作为提示词，不应被替换")));
        String pid=Json.required(project,"id");Path copy=root.resolve("copied.png"),external=root.resolve("外部 引用.jpg");image(copy,"png",0x223344);image(external,"jpeg",0xaabbcc);
        String first=importOne(projects,pid,copy,"copy"),second=importOne(projects,pid,external,"reference");
        projects.save(Json.obj("assetId",first,"baseVersion",0,"annotations",Json.arr(box(4)),"confirm",true));
        projects.save(Json.obj("assetId",first,"baseVersion",1,"annotations",Json.arr(box(8)),"confirm",true));
        projects.draft(Json.obj("assetId",first,"baseVersion",2,"annotations",Json.arr(box(12))));projects.save(Json.obj("assetId",second,"baseVersion",0,"annotations",Json.arr(box(5))));
        ResourceLibrary resources=new ResourceLibrary(store,projects);JsonObject reference=resources.addReference(Json.obj("assetId",second,"assetVersion",1,"name","冻结参考","note","独立人工说明"));
        JsonObject resolved=store.read(c->resources.resolveReference(c,Json.obj("resourceId",reference.get("id")),project));
        EvaluationSets sets=new EvaluationSets(store,projects);JsonObject set=sets.create(Json.obj("projectId",pid,"name","固定答案","assetIds",Json.arr(first)));String sid=Json.required(set,"id");
        sets.saveTruth(Json.obj("setId",sid,"assetId",first,"baseTruthVersion",0,"source","manual","annotations",Json.arr(box(8))));
        JsonObject version=sets.publish(Json.obj("setId",sid,"baseSetRevision",2));String setVersion=Json.required(version,"id");
        Path exportParent=Files.createDirectories(root.resolve("项目外 导出"));JsonObject exported=new Exporter(store,projects).create(Json.obj("projectId",pid,"outputDir",exportParent.toString()));Path exportedPath=Path.of(Json.required(exported,"path"));
        JsonObject exportManifest=Json.parse(Files.readString(exportedPath.resolve("manifest.json")));JsonObject exportAsset=Json.array(exportManifest,"assets").get(0).getAsJsonObject();String labelHash=Json.required(exportAsset,"labelHash");
        JsonObject asset=projects.asset(first);store.tx(c->{
            Store.update(c,"INSERT INTO budgets(id,max_requests,used) VALUES('paused-budget',50,7)");
            JsonObject run=Json.obj("id","paused-run","projectId",pid,"status","paused","pauseReason","budget_exhausted","requestsUsed",7,"snapshot",Json.obj("project",project,"references",Json.arr(resolved)),"total",1);
            Store.update(c,"INSERT INTO runs(id,project_id,status,data) VALUES(?,?,?,?)","paused-run",pid,"paused",run);
            Store.update(c,"INSERT INTO samples(id,run_id,asset_id,input_id,status,data) VALUES(?,?,?,?,?,?)","unknown-sample","paused-run",first,first,"unknown",Json.obj("id","unknown-sample","assetId",first,"asset",asset,"inputPath",projects.path(first).toString(),"baseVersion",2));
            Store.update(c,"INSERT INTO attempts(id,run_id,sample_id,group_id,status,data) VALUES(?,?,?,?,?,?)","unknown-attempt","paused-run","unknown-sample","fixture-group","unknown",Json.obj("id","unknown-attempt","status","unknown","purpose","annotation"));return null;
        });
        Path backupFolder=Files.createDirectories(store.root.resolve("backups"));Files.writeString(backupFolder.resolve("obsolete.db"),"old fixture backup");Path cache=Files.createDirectories(store.root.resolve("thumbnail-cache"));Files.writeString(cache.resolve("unused.bin"),"rebuildable cache");Path privateFolder=Files.createDirectories(root.resolve("credentials"));Files.writeString(privateFolder.resolve("providers.enc.json"),"fixture-exclusion-marker");
        return new Fixture(pid,first,second,Json.required(reference,"id"),setVersion,Json.required(exported,"id"),external,exportedPath,labelHash,Json.required(version,"manifestHash"));
    }

    private static void verifyRestored(Path destination,Fixture fixture)throws Exception{
        try(Store restored=new Store(destination)){
            Projects projects=new Projects(restored);JsonObject first=projects.asset(fixture.first),second=projects.asset(fixture.second);
            check(Json.integer(first,"version",0)==2&&first.has("draft"),"formal version and independent draft restored");
            check(Json.decimal(Json.object(Json.array(first,"annotations").get(0).getAsJsonObject(),"bbox"),"x",0)==8,"formal geometry preserved");
            check(Json.decimal(Json.object(Json.array(first,"draft").get(0).getAsJsonObject(),"bbox"),"x",0)==12,"draft geometry preserved independently");
            check(projects.history(fixture.first).size()==2,"manual revision history restored");
            check(projects.path(fixture.first).startsWith(destination)&&Files.isRegularFile(projects.path(fixture.first)),"baseline absolute path rebound to new root");
            Path source=Path.of(Json.required(Json.object(second,"metadata"),"sourcePath"));check(source.startsWith(destination)&&Media.hash(source).equals(Json.required(Json.object(second,"metadata"),"sourceHash")),"external original materialized as verified managed copy");
            check(Json.str(Json.object(projects.get(fixture.projectId),"settings"),"prompt","").contains("C:/old/path"),"arbitrary text is not globally replaced");
            JsonObject budget=restored.read(c->Store.one(c,"SELECT used,max_requests FROM budgets WHERE id='paused-budget'"));check(Json.integer(budget,"used",0)==7&&Json.integer(budget,"max_requests",0)==50,"budget counters preserve sent and unknown usage");
            check(restored.read(c->Json.required(Store.one(c,"SELECT status FROM attempts WHERE id='unknown-attempt'"),"status")).equals("unknown"),"unknown call remains unknown");
            check(restored.read(c->Json.required(Store.one(c,"SELECT status FROM samples WHERE id='unknown-sample'"),"status")).equals("unknown"),"unknown sample is not silently queued");
            JsonObject sample=restored.read(c->Json.parse(Store.one(c,"SELECT data FROM samples WHERE id='unknown-sample'").get("data").getAsString()));check(Path.of(Json.required(sample,"inputPath")).startsWith(destination),"fixed run input relocated");
            JsonObject run=restored.read(c->Store.document(c,"runs","paused-run"));check(Json.str(run,"pauseReason","").equals("budget_exhausted"),"pause reason preserved");
            JsonObject reference=Json.array(Json.object(run,"snapshot"),"references").get(0).getAsJsonObject();check(Path.of(Json.required(reference,"inputPath")).startsWith(destination),"run reference operational path relocated");
            check(Files.isRegularFile(new ResourceLibrary(restored,projects).referencePath(reference)),"frozen shared reference remains usable");
            JsonObject resource=new ResourceLibrary(restored,projects).get(Json.obj("resourceId",fixture.referenceId,"version",1));check(Json.str(resource,"note","").equals("独立人工说明"),"reference version and note preserved");
            EvaluationSets sets=new EvaluationSets(restored,projects);JsonObject setVersion=sets.version(fixture.setVersionId);check(Json.required(setVersion,"manifestHash").equals(fixture.evaluationManifestHash)&&Files.isRegularFile(sets.image(fixture.setVersionId,fixture.first)),"evaluation manifest bytes and image binding preserved");
            ExportHistory.Fixed exported=new ExportHistory(restored).fixed(fixture.exportId);check(exported.directory().startsWith(destination),"external export directory relocated");
            JsonObject item=Json.array(exported.manifest(),"assets").get(0).getAsJsonObject();Path label=exported.directory().resolve("labels/"+Json.required(item,"split")+"/"+Json.required(item,"assetId")+".txt");check(Media.hash(label).equals(fixture.labelHash),"historical export label bytes remain unchanged");
            Path reproduceParent=Files.createDirectories(destination.getParent().resolve("恢复后重导出-"+Json.id()));JsonObject reproduced=new ExportHistory(restored).reproduce(Json.obj("exportId",fixture.exportId,"outputDir",reproduceParent.toString()));
            Path reproducedDirectory=Path.of(Json.required(reproduced,"path"));check(reproducedDirectory.startsWith(reproduceParent)&&Media.hash(reproducedDirectory.resolve("data.yaml")).equals(Media.hash(exported.directory().resolve("data.yaml"))),"restored export reproduces using relocated record and unchanged relative YAML");
            check(restored.read(c->Store.one(c,"SELECT data FROM settings WHERE id='wal-marker'"))!=null,"WAL marker retained through archive restore");
            check(Json.bool(new DataBackups(restored).preflight(Json.obj("outputDir",destination.getParent().toString())),"ready",false),"restored workspace can be backed up again without old source locations");
        }
    }

    private static void malformed(Path root,Path archives,Path restoreParent,Store store,DataBackups backups,Path archive,Fixture fixture)throws Exception{
        Path corrupt=archives.resolve("corrupt.autolabel");rewriteArchive(archive,corrupt,entries->{String first=entries.keySet().stream().filter(name->name.startsWith("files/")).findFirst().orElseThrow();byte[] bytes=entries.get(first).clone();bytes[bytes.length/2]^=1;entries.put(first,bytes);});
        long before=children(restoreParent);rejects("backup_hash_mismatch",()->backups.prepareRestore(Json.obj("backupPath",corrupt.toString(),"targetParent",restoreParent.toString())));check(children(restoreParent)==before,"failed restore removes only its new staging directory");
        Path traversal=archives.resolve("traversal.autolabel");rewriteArchive(archive,traversal,entries->entries.put("../outside.txt","blocked".getBytes(StandardCharsets.UTF_8)));
        rejects("backup_path_invalid",()->backups.inspect(Json.obj("backupPath",traversal.toString())));check(!Files.exists(root.resolve("outside.txt")),"path traversal writes no outside file");
        Path reserved=archives.resolve("reserved.autolabel");rewriteArchive(archive,reserved,entries->entries.put("files/media/CON.txt","blocked".getBytes(StandardCharsets.UTF_8)));rejects("backup_path_invalid",()->backups.inspect(Json.obj("backupPath",reserved.toString())));
        Path caseCollision=archives.resolve("case-collision.autolabel");rewriteArchive(archive,caseCollision,entries->{String first=entries.keySet().stream().filter(name->name.startsWith("files/")).findFirst().orElseThrow();entries.put(first.toUpperCase(Locale.ROOT),entries.get(first));});rejects("backup_archive_invalid",()->backups.inspect(Json.obj("backupPath",caseCollision.toString())));
        Path size=archives.resolve("size.autolabel");rewriteArchive(archive,size,entries->{JsonObject value=Json.parse(new String(entries.get("manifest.json"),StandardCharsets.UTF_8));value.addProperty("totalBytes",Json.number(value,"totalBytes",0)+1);entries.put("manifest.json",value.toString().getBytes(StandardCharsets.UTF_8));});rejects("backup_manifest_invalid",()->backups.inspect(Json.obj("backupPath",size.toString())));
        Path missing=archives.resolve("missing.autolabel");rewriteArchive(archive,missing,entries->{String first=entries.keySet().stream().filter(name->name.startsWith("files/")).findFirst().orElseThrow();entries.remove(first);});rejects("backup_archive_invalid",()->backups.inspect(Json.obj("backupPath",missing.toString())));
        Path rewrite=archives.resolve("rewrite.autolabel");rewriteArchive(archive,rewrite,entries->{JsonObject value=Json.parse(new String(entries.get("manifest.json"),StandardCharsets.UTF_8));JsonObject binding=Json.array(value,"bindings").get(0).getAsJsonObject();binding.addProperty("column","data");binding.add("pointer",Json.arr("annotations"));entries.put("manifest.json",value.toString().getBytes(StandardCharsets.UTF_8));});rejects("backup_binding_invalid",()->backups.inspect(Json.obj("backupPath",rewrite.toString())));
        Path truncated=archives.resolve("interrupted.autolabel");byte[] bytes=Files.readAllBytes(archive);Files.write(truncated,Arrays.copyOf(bytes,bytes.length/2));rejects("backup_archive_invalid",()->backups.inspect(Json.obj("backupPath",truncated.toString())));
        check(Json.integer(new Projects(store).asset(fixture.first),"version",0)==3,"all invalid archive attempts leave live data intact");
    }

    private static JsonObject manifest(Path archive)throws Exception{try(ZipFile zip=new ZipFile(archive.toFile());InputStream input=zip.getInputStream(zip.getEntry("manifest.json"))){return Json.parse(new String(input.readAllBytes(),StandardCharsets.UTF_8));}}
    private static void rewriteArchive(Path source,Path target,Consumer<LinkedHashMap<String,byte[]>> mutate)throws Exception{
        LinkedHashMap<String,byte[]> entries=new LinkedHashMap<>();try(ZipFile zip=new ZipFile(source.toFile())){Enumeration<? extends ZipEntry> iterator=zip.entries();while(iterator.hasMoreElements()){ZipEntry entry=iterator.nextElement();try(InputStream input=zip.getInputStream(entry)){entries.put(entry.getName(),input.readAllBytes());}}}mutate.accept(entries);
        try(ZipOutputStream zip=new ZipOutputStream(Files.newOutputStream(target,StandardOpenOption.CREATE_NEW))){for(var entry:entries.entrySet()){zip.putNextEntry(new ZipEntry(entry.getKey()));zip.write(entry.getValue());zip.closeEntry();}}
    }
    private static long children(Path root)throws IOException{try(var stream=Files.list(root)){return stream.count();}}
    private static void image(Path file,String format,int color)throws Exception{BufferedImage image=new BufferedImage(64,48,BufferedImage.TYPE_INT_RGB);for(int y=0;y<48;y++)for(int x=0;x<64;x++)image.setRGB(x,y,color);ImageIO.write(image,format,file.toFile());}
    private static String importOne(Projects projects,String pid,Path file,String mode){return Json.array(projects.importAssets(Json.obj("projectId",pid,"paths",Json.arr(file.toString()),"mode",mode)),"assetIds").get(0).getAsString();}
    private static JsonObject box(int x){return Json.obj("id","object-one","classId","item","type","detect","bbox",Json.obj("x",x,"y",4,"width",20,"height",18));}
}
