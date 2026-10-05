package cn.autolabel.engine;

import com.google.gson.*;
import java.nio.file.*;
import java.util.*;
import java.util.stream.Stream;

/**
 * 图片分类数据集导入：YOLO 类别文件夹结构（根目录/类别文件夹/图片）。
 *
 * 分类标签不落在 txt 里，而是由图片所在的类别文件夹决定，因此不能复用按同名 txt 配对的
 * {@link YoloImporter}。这里以图片内容哈希（素材 metadata.sourceHash）把数据集文件对应到项目素材；
 * 哈希匹配不到时再退回唯一的同名素材，重名不猜。只填写尚无正式版本与草稿的素材，
 * 已标注素材保持原样并逐项回报，避免静默覆盖人工标注。
 */
final class ClassifyImporter {
    private static final int MAX_IMAGES=10000;
    private static final String IMAGE_PATTERN=".*\\.(jpe?g|png)$";
    private final Store store;private final Projects projects;
    ClassifyImporter(Store store,Projects projects){this.store=store;this.projects=projects;}

    /** 预检：列出根目录下的类别子文件夹、图片数与按类别名称给出的映射建议，不写入任何数据。 */
    JsonObject scan(JsonObject p)throws Exception{
        JsonObject project=requireClassifyProject(p);
        Dataset dataset=discover(requireRoot(p));
        JsonArray folders=new JsonArray(),issues=new JsonArray();
        for(ClassFolder folder:dataset.folders)folders.add(Json.obj("name",folder.name,"imageCount",folder.files.size(),"classId",suggestClassId(project,folder.name)));
        for(Path file:dataset.strayFiles)issues.add(Json.obj("code","label_structure_invalid","name",file.getFileName().toString(),
            "message","数据集根目录下不应直接存放图片，请选择包含类别子文件夹的目录。"));
        return Json.obj("folders",folders,"images",dataset.imageCount(),"issues",issues);
    }

    /** 导入：classMap 必须覆盖全部发现到的类别文件夹；每个素材只接受一次类别，写入候选不覆盖旧标注。 */
    JsonObject importFolders(JsonObject p)throws Exception{
        JsonObject project=requireClassifyProject(p);String pid=Json.required(project,"id");
        Path root=requireRoot(p);
        JsonObject classMap=Json.object(p,"classMap");
        if(classMap.isEmpty())throw new ApiError(400,"class_map_required","请明确类别文件夹名称到项目类别的映射。");
        Set<String> knownIds=classIds(project);Map<String,String> folderToClass=new LinkedHashMap<>();
        for(var entry:classMap.entrySet()){
            String folder=entry.getKey();
            if(folder.isBlank()||folder.length()>200||folder.contains("/")||folder.contains("\\")||folder.equals(".")||folder.equals(".."))
                throw new ApiError(400,"class_map_invalid","类别文件夹名称无效。");
            if(entry.getValue()==null||!entry.getValue().isJsonPrimitive()||!entry.getValue().getAsJsonPrimitive().isString())
                throw new ApiError(400,"class_map_invalid","类别映射应使用文件夹名称到稳定类别 ID。");
            String classId=entry.getValue().getAsString();
            if(!knownIds.contains(classId))throw new ApiError(400,"class_map_invalid","映射到了项目中不存在的类别："+classId);
            folderToClass.put(folder,classId);
        }
        Dataset dataset=discover(root);
        if(dataset.folders.isEmpty())throw new ApiError(400,"dataset_empty","所选目录没有类别子文件夹，无法按类别文件夹导入。");
        List<String> unmapped=new ArrayList<>();
        for(ClassFolder folder:dataset.folders)if(!folderToClass.containsKey(folder.name))unmapped.add(folder.name);
        if(!unmapped.isEmpty())throw new ApiError(400,"label_class_unmapped","以下类别文件夹没有映射到项目类别："+String.join("、",unmapped));
        if(dataset.imageCount()>MAX_IMAGES)throw new ApiError(413,"import_batch_too_large","单次分类导入最多 "+MAX_IMAGES+" 张图片。");

        Map<String,String> hashIndex=new HashMap<>();Map<String,List<String>> stemIndex=new HashMap<>();
        for(JsonElement element:store.read(c->Store.docs(c,"SELECT data FROM assets WHERE project_id=?",pid))){
            JsonObject asset=element.getAsJsonObject();
            String aid=Json.required(asset,"id"),hash=Json.str(Json.object(asset,"metadata"),"sourceHash","");
            if(!hash.isEmpty())hashIndex.putIfAbsent(hash,aid);
            stemIndex.computeIfAbsent(YoloImporter.stem(Json.required(asset,"name")),key->new ArrayList<>()).add(aid);
        }
        JsonArray errors=new JsonArray(),saved=new JsonArray();
        // 先按图片归拢到素材，再判断同一素材是否被多个类别认领，避免按目录顺序任意取胜。
        Map<String,List<Match>> claims=new LinkedHashMap<>();
        for(ClassFolder folder:dataset.folders){
            String classId=folderToClass.get(folder.name);
            for(Path file:folder.files){
                String aid=match(Media.hashQuick(file),YoloImporter.stem(file.getFileName().toString()),hashIndex,stemIndex);
                if(aid==null){errors.add(Json.obj("name",file.getFileName().toString(),"folder",folder.name,"code","asset_unmatched","message","数据集图片在项目素材中找不到唯一对应项，未导入。"));continue;}
                claims.computeIfAbsent(aid,key->new ArrayList<>()).add(new Match(folder.name,classId,file));
            }
        }
        for(Path file:dataset.strayFiles)errors.add(Json.obj("name",file.getFileName().toString(),"code","label_structure_invalid","message","数据集根目录下的图片没有类别文件夹，未导入。"));
        for(var entry:claims.entrySet()){
            String aid=entry.getKey(),classId=entry.getValue().get(0).classId;List<Match> matches=entry.getValue();
            if(matches.size()>1){LinkedHashSet<String> folders=new LinkedHashSet<>();for(Match match:matches)folders.add(match.folder);
                errors.add(Json.obj("assetId",aid,"code","label_conflict","message","同一素材出现在多个类别文件夹（"+String.join("、",folders)+"），未导入。"));continue;}
            try{
                JsonObject asset=projects.asset(aid);
                if(Json.integer(asset,"version",0)>0||asset.has("draft")){errors.add(Json.obj("assetId",aid,"code","annotation_existing","message","该素材已有正式标注或草稿，分类导入不会覆盖，请人工处理后再导入。"));continue;}
                String folderName=matches.get(0).folder,fileName=matches.get(0).file.getFileName().toString();
                JsonArray annotations=Json.arr(Json.obj("id",Json.id(),"classId",classId,"type","classify"));
                saved.add(projects.save(Json.obj("assetId",aid,"baseVersion",0,"annotations",annotations,"confirm",false),"imported_yolo",
                    Json.obj("source","class_folder","folderName",folderName,"fileName",fileName,"labelHash",Media.hash(matches.get(0).file),"importedAt",Json.now())));
            }catch(ApiError e){if(e.status>=500)throw e;errors.add(Json.obj("assetId",aid,"code",e.code,"message",e.getMessage()));}
            catch(Exception e){errors.add(Json.obj("assetId",aid,"code","label_read_failed","message","分类标签写入失败，原标注保持不变。"));}
        }
        return Json.obj("imported",saved.size(),"errors",errors,"items",saved);
    }

    private JsonObject requireClassifyProject(JsonObject p)throws Exception{
        JsonObject project=projects.get(Json.required(p,"projectId"));
        if(!Json.required(project,"taskType").equals("classify"))throw new ApiError(400,"task_type_mismatch","当前项目不是图片分类任务，不能用类别文件夹导入。");
        return project;
    }
    private static Path requireRoot(JsonObject p)throws Exception{
        Path root;
        try{root=Path.of(Json.required(p,"rootDir")).toAbsolutePath().normalize();}catch(ApiError e){throw e;}catch(Exception e){throw new ApiError(400,"directory_unavailable","类别数据集目录不可访问。");}
        if(!Files.isDirectory(root))throw new ApiError(400,"directory_unavailable","类别数据集目录不可访问。");
        return root;
    }
    /** 只扫描根目录下一层：子目录即类别，目录内只取图片；不跟随符号链接，避免越出已授权目录。 */
    private static Dataset discover(Path root)throws Exception{
        List<Path> entries=new ArrayList<>();
        try(Stream<Path> stream=Files.list(root)){stream.filter(entry->!Files.isSymbolicLink(entry)).forEach(entries::add);}
        catch(Exception e){throw new ApiError(400,"directory_unavailable","类别数据集目录不可访问。");}
        entries.sort(Comparator.comparing(entry->entry.getFileName().toString(),String.CASE_INSENSITIVE_ORDER));
        List<ClassFolder> folders=new ArrayList<>();List<Path> stray=new ArrayList<>();
        for(Path entry:entries){
            if(Files.isDirectory(entry)){
                List<Path> files=new ArrayList<>();
                try(Stream<Path> stream=Files.list(entry)){stream.filter(Files::isRegularFile).filter(ClassifyImporter::isImage).forEach(files::add);}
                files.sort(Comparator.comparing(file->file.getFileName().toString(),String.CASE_INSENSITIVE_ORDER));
                folders.add(new ClassFolder(entry.getFileName().toString(),files));
            }else if(Files.isRegularFile(entry)&&isImage(entry))stray.add(entry);
        }
        return new Dataset(folders,stray);
    }
    private static String match(String hash,String stem,Map<String,String> hashIndex,Map<String,List<String>> stemIndex){
        String aid=hashIndex.get(hash);
        if(aid!=null)return aid;
        List<String> candidates=stemIndex.get(stem);
        return candidates!=null&&candidates.size()==1?candidates.get(0):null;
    }
    private static String suggestClassId(JsonObject project,String folder){
        String wanted=folder.trim().toLowerCase(Locale.ROOT);
        for(JsonElement e:Json.array(project,"classes")){JsonObject c=e.getAsJsonObject();
            if(Json.required(c,"name").trim().toLowerCase(Locale.ROOT).equals(wanted))return Json.required(c,"id");}
        return "";
    }
    private static Set<String> classIds(JsonObject project){Set<String> ids=new HashSet<>();for(JsonElement e:Json.array(project,"classes"))ids.add(Json.required(e.getAsJsonObject(),"id"));return ids;}
    private static boolean isImage(Path path){return path.getFileName().toString().toLowerCase(Locale.ROOT).matches(IMAGE_PATTERN);}

    private record ClassFolder(String name,List<Path> files){}
    private record Dataset(List<ClassFolder> folders,List<Path> strayFiles){int imageCount(){int total=0;for(ClassFolder folder:folders)total+=folder.files.size();return total;}}
    private record Match(String folder,String classId,Path file){}
}
