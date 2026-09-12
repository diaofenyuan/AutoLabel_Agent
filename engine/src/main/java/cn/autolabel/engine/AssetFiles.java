package cn.autolabel.engine;

import com.google.gson.*;
import javax.imageio.ImageIO;
import java.nio.file.*;
import java.util.*;
import java.util.stream.Stream;

final class AssetFiles {
    final Store store;final Projects projects;
    AssetFiles(Store store,Projects projects){this.store=store;this.projects=projects;}
    List<JsonObject> select(JsonObject p){String pid=Json.required(p,"projectId");Set<String> selected=new HashSet<>();for(JsonElement id:Json.array(p,"assetIds"))selected.add(id.getAsString());if(p.has("assetIds")&&selected.isEmpty())throw new ApiError(400,"asset_selection_empty","请选择素材。");
        return store.read(c->{Store.document(c,"projects",pid);List<JsonObject> result=new ArrayList<>();for(JsonElement e:Store.docs(c,"SELECT data FROM assets WHERE project_id=?",pid)){JsonObject a=e.getAsJsonObject();if(selected.isEmpty()||selected.contains(Json.required(a,"id")))result.add(a);}if(!selected.isEmpty()&&result.size()!=selected.size())throw new ApiError(400,"asset_project_mismatch","所选素材不属于当前项目。");return result;});}
    JsonObject check(JsonObject p){JsonArray items=new JsonArray();for(JsonObject a:select(p)){JsonObject metadata=Json.object(a,"metadata");String source=Json.str(metadata,"sourcePath","");Path baseline=projects.path(Json.required(a,"id"));String baselineState=state(baseline,Json.required(a,"contentHash"));items.add(Json.obj("assetId",a.get("id"),"name",a.get("name"),"sourceStatus",source.isBlank()?"missing":state(Path.of(source),Json.str(metadata,"sourceHash","")),"baselineStatus",baselineState,"canUseBaseline",baselineState.equals("intact")));}return Json.obj("items",items);}
    static String state(Path path,String expected){try{if(!Files.exists(path))return "missing";if(!Files.isReadable(path)||!Files.isRegularFile(path))return "unavailable";return Media.hash(path).equals(expected)?"intact":"changed";}catch(Exception e){return "unavailable";}}
    JsonObject relocate(JsonObject p)throws Exception{
        Path directory=Path.of(Json.required(p,"directory")).toAbsolutePath().normalize();if(!Files.isDirectory(directory))throw new ApiError(400,"directory_unavailable","选定素材目录不可访问。");List<JsonObject> assets=select(p);Map<String,List<Path>> hashes=new HashMap<>();Map<String,List<Path>> names=new HashMap<>();Set<String> wanted=new HashSet<>();for(JsonObject a:assets)wanted.add(Json.str(Json.object(a,"metadata"),"sourceHash",""));
        int scanned=0;try(Stream<Path> stream=Files.walk(directory,12)){Iterator<Path> iterator=stream.filter(Files::isRegularFile).filter(f->f.toString().toLowerCase(Locale.ROOT).matches(".*\\.(jpe?g|png)$")).iterator();while(iterator.hasNext()){Path file=iterator.next();if(++scanned>20000)throw new ApiError(413,"relocate_scan_limit","选定目录超过 20000 张图片，请缩小扫描范围。");names.computeIfAbsent(file.getFileName().toString(),k->new ArrayList<>()).add(file);
                try{if(Files.size(file)>Media.MAX_FILE)continue;String hash=Media.hash(file);if(wanted.contains(hash))hashes.computeIfAbsent(hash,k->new ArrayList<>()).add(file);}catch(java.io.IOException ignored){}}}
        JsonArray items=new JsonArray(),issues=new JsonArray();int relocated=0,unchanged=0;
        for(JsonObject asset:assets){String aid=Json.required(asset,"id");JsonObject metadata=Json.object(asset,"metadata");try{
            String original=Json.str(metadata,"sourcePath","");Path old=original.isBlank()?null:Path.of(original),baseline=projects.path(aid);String sourceState=old==null?"missing":state(old,Json.str(metadata,"sourceHash",""));String baselineState=state(baseline,Json.required(asset,"contentHash"));
            if(sourceState.equals("intact")&&baselineState.equals("intact")){unchanged++;continue;}
            List<Path> matches=sourceState.equals("intact")?List.of(old):hashes.getOrDefault(Json.str(metadata,"sourceHash",""),List.of());
            if(matches.size()!=1){String code=matches.size()>1?"relocate_ambiguous":!names.getOrDefault(Json.required(asset,"name"),List.of()).isEmpty()?"relocate_content_changed":"relocate_not_found";issues.add(Json.obj("assetId",aid,"code",code,"message",matches.size()>1?"存在多个内容一致的候选，请缩小目录范围。":"未找到与原素材内容一致的文件，旧标注关联保持不变。","candidates",matches.stream().map(Path::toString).toList()));continue;}
            Path source=matches.getFirst();int[] dimensions=dimensions(source);if(dimensions[0]!=Json.integer(metadata,"sourceWidth",0)||dimensions[1]!=Json.integer(metadata,"sourceHeight",0))throw new ApiError(409,"relocate_dimensions_mismatch","候选图片源尺寸不匹配，未更改关联。");
            if(baselineState.equals("changed"))throw new ApiError(409,"baseline_content_changed","基准图已被外部更改，请保留为新素材；重定位不会覆盖不同内容。");
            if(!baselineState.equals("intact")){
                Media.Normalized regenerated=projects.media.normalize(source,Json.id(),Json.str(metadata,"alphaBackground","#ffffff"),false);
                if(!regenerated.hash().equals(Json.required(asset,"contentHash")))throw new ApiError(409,"normalization_version_mismatch","当前规范化结果与旧版本不一致，未替换旧素材。");
                Path expected=store.root.resolve("media").resolve(aid+".png");if(!baseline.toAbsolutePath().normalize().equals(expected))throw new ApiError(409,"baseline_path_invalid","素材基准图路径不在受管目录。");Files.move(regenerated.path(),expected);
            }
            Path destination=source;
            if(Json.str(metadata,"importMode","").equals("copy")){
                destination=store.root.resolve("originals").resolve(aid+(Json.str(metadata,"originalFormat","").equals("jpeg")?".jpg":".png"));Files.createDirectories(destination.getParent());
                if(!destination.equals(source)){if(Files.exists(destination)&&!Media.hash(destination).equals(Json.str(metadata,"sourceHash","")))throw new ApiError(409,"managed_source_changed","受管源文件已有不同内容，未覆盖。" );if(!Files.exists(destination))Files.copy(source,destination);}
            }
            if(!Media.hash(destination).equals(Json.str(metadata,"sourceHash","")))throw new ApiError(409,"relocate_content_changed","候选文件在扫描或复制期间发生变化，未更改素材关联。");
            String resolved=destination.toAbsolutePath().normalize().toString();
            JsonObject result=store.tx(c->{JsonObject current=Store.document(c,"assets",aid);JsonObject m=Json.object(current,"metadata");if(!Json.str(m,"sourceHash","").equals(Json.str(metadata,"sourceHash","")))throw new ApiError(409,"asset_input_changed","素材输入版本已变化，请重新检查。");m.addProperty("sourcePath",resolved);m.addProperty("relocatedAt",Json.now());current.add("metadata",m);Store.update(c,"UPDATE assets SET data=? WHERE id=?",current,aid);Store.event(c,"asset.relocated",null,aid,null,Json.obj("projectId",current.get("projectId"),"baselineRestored",!baselineState.equals("intact")));return current;});items.add(result);relocated++;
        }catch(Exception e){if(e instanceof ApiError a&&a.status>=500)throw a;issues.add(Json.obj("assetId",aid,"code",e instanceof ApiError a?a.code:"relocate_io_failed","message",e instanceof ApiError a?a.getMessage():"文件访问或恢复失败，标注与草稿保留。"));}}
        return Json.obj("relocated",relocated,"unchanged",unchanged,"scanned",scanned,"issues",issues,"items",items);
    }
    static int[] dimensions(Path path)throws Exception{try(var input=ImageIO.createImageInputStream(path.toFile())){var readers=ImageIO.getImageReaders(input);if(!readers.hasNext())throw new ApiError(422,"image_corrupt","候选文件无法解码。");var reader=readers.next();try{reader.setInput(input,true,true);return new int[]{reader.getWidth(0),reader.getHeight(0)};}finally{reader.dispose();}}}
}
