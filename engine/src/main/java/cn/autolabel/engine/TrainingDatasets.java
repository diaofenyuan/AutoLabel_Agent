package cn.autolabel.engine;

import com.google.gson.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;

/**
 * 训练数据集快照。
 *
 * 训练任务只读受管快照目录，不直接读用户目录：先把来源清单逐文件校验内容哈希再复制到受管目录，
 * 因此训练启动后源目录被改动不会影响已提交任务，换数据只能是新快照加新任务。
 * 体检在复制之前完成，存在阻断级问题时只落一条不可用记录，不产生任何副本与磁盘占用。
 */
final class TrainingDatasets {
    private static final int MAX_FILES=200_000,MAX_ISSUES=2000,MAX_LABEL_BYTES=2*1024*1024,MAX_LIST=100;
    private static final Set<String> TASKS=Annotations.TYPES;
    private static final Set<String> IMAGE_SUFFIXES=Set.of("png","jpg","jpeg","bmp","webp");

    private final Store store;private final Projects projects;

    TrainingDatasets(Store store,Projects projects){this.store=store;this.projects=projects;}

    /** 扫描累积器：来源清单与逐文件问题，尚未复制任何文件。 */
    private static final class Scan {
        final JsonArray issues=new JsonArray();final List<JsonObject> files=new ArrayList<>();
        final String taskType;JsonArray classes=new JsonArray(),keypointNames=new JsonArray();
        JsonObject origin=new JsonObject();
        int images,objects,emptyLabels;long bytes;int[] classCounts=new int[1];
        Scan(String taskType){this.taskType=taskType;}
    }
    record Snapshot(JsonObject record,JsonObject data,Path directory){}

    JsonObject create(JsonObject p)throws Exception{
        keys(p,"projectId","source","trainDir","valDir","yamlDir","taskType","classNames","keypointNames","exportId");
        String source=string(p,"source",32);
        if(!Set.of("upload","export").contains(source))throw error(400,"training_source_invalid","训练数据来源应为 upload 或 export。");
        String projectId=null;
        if(p.has("projectId")){projectId=string(p,"projectId",128);projects.get(projectId);}
        Scan scan=source.equals("upload")?scanUpload(p):scanExport(p);
        JsonObject inspection=inspect(scan);
        boolean usable=!hasError(scan.issues);
        String id=Json.id(),createdAt=Json.now();
        JsonObject data=Json.obj("id",id,"projectId",projectId,"origin",source,"taskType",scan.taskType,
            "classes",classTable(scan.classes),"keypointNames",scan.keypointNames.deepCopy(),"originDetail",scan.origin.deepCopy(),
            "inspection",inspection,"status",usable?"ready":"invalid","createdAt",createdAt);
        if(usable){
            Path directory=datasetDirectory(id);
            try{
                Files.createDirectories(directory);
                data.add("files",freeze(scan.files,directory));
                String yaml=yamlText(scan);
                data.add("dataYaml",Json.obj("text",yaml,"hash",hashText(yaml)));
                Files.writeString(directory.resolve("data.yaml"),yaml,StandardCharsets.UTF_8);
                data.addProperty("bytes",scan.bytes);
            }catch(Exception failure){
                // 复制或写配置失败必须整体回滚，不能留下半个可用快照。
                deleteDirectory(directory);
                if(failure instanceof ApiError error)throw error;
                throw error(500,"training_dataset_write_failed","训练数据集副本未完成，请检查数据目录空间与权限。");
            }
        }
        String snapshotHash=snapshotHash(scan,data);
        // 指纹进入 data 是为了让对外视图与内部记录读到同一个值，它本身不参与指纹计算。
        data.addProperty("snapshotHash",snapshotHash);
        JsonObject record=Json.obj("id",id,"projectId",projectId,"origin",source,"taskType",scan.taskType,"snapshotHash",snapshotHash,
            "createdAt",createdAt,"data",data);
        // 写入事务里只捕获终态值：projectId 允许为空但不能再被重新赋值。
        final String linkedProject=projectId;
        store.tx(c->{
            Store.update(c,"INSERT INTO training_datasets(id,project_id,origin,task_type,snapshot_hash,created_at,data) VALUES(?,?,?,?,?,?,?)",
                id,linkedProject,source,scan.taskType,snapshotHash,createdAt,record);
            Store.event(c,"training.dataset.ready",null,null,null,Json.obj("datasetId",id,"origin",source,"status",data.get("status"),"snapshotHash",snapshotHash));
            return null;
        });
        return view(record);
    }

    JsonObject list(JsonObject p){
        keys(p,"projectId","offset","limit");
        if(p.has("projectId"))string(p,"projectId",128);
        int limit=Json.bounded(p,"limit",MAX_LIST,1,MAX_LIST),offset=Json.bounded(p,"offset",0,0,Integer.MAX_VALUE);
        return store.read(c->{
            String condition="1=1";List<Object> args=new ArrayList<>();
            if(p.has("projectId")){condition+=" AND project_id=?";args.add(Json.required(p,"projectId"));}
            long total=Json.number(Store.one(c,"SELECT COUNT(*) AS n FROM training_datasets WHERE "+condition,args.toArray()),"n",0);
            args.add(limit);args.add(offset);JsonArray items=new JsonArray();
            for(JsonObject row:Store.rows(c,"SELECT data FROM training_datasets WHERE "+condition+" ORDER BY created_at DESC LIMIT ? OFFSET ?",args.toArray()))
                items.add(view(Json.parse(row.get("data").getAsString())));
            return Json.obj("items",items,"total",total,"offset",offset,"limit",limit);
        });
    }

    JsonObject get(JsonObject p){
        keys(p,"datasetId");
        return view(store.read(c->Store.document(c,"training_datasets",string(p,"datasetId",128))));
    }

    Snapshot load(String id){
        JsonObject record=store.read(c->Store.document(c,"training_datasets",id));
        JsonObject data=Json.object(record,"data");
        if(!Json.str(data,"status","").equals("ready"))throw error(409,"training_dataset_invalid","该数据集体检未通过，不能用于训练。");
        return new Snapshot(record,data,datasetDirectory(id));
    }

    /** 对外视图只保留受管相对清单与摘要，不暴露受管绝对路径与用户目录。 */
    static JsonObject view(JsonObject record){
        JsonObject data=Json.object(record,"data"),result=new JsonObject();
        for(String field:List.of("id","projectId","origin","taskType","createdAt"))result.add(field,record.get(field));
        for(String field:List.of("snapshotHash","status","bytes","classes","keypointNames","inspection","originDetail")){
            if(data.has(field))result.add(field,data.get(field).deepCopy());
        }
        JsonArray files=new JsonArray();
        for(JsonElement element:Json.array(data,"files")){
            JsonObject file=element.getAsJsonObject(),visible=new JsonObject();
            for(String field:List.of("split","image","hash","bytes","width","height","label","labelHash","className","objects")){
                if(file.has(field))visible.add(field,file.get(field).deepCopy());
            }
            files.add(visible);
        }
        result.add("files",files);
        if(data.has("dataYaml"))result.add("dataYaml",Json.obj("hash",Json.object(data,"dataYaml").get("hash")));
        return result;
    }

    /** 训练类别表：id 即 YOLO 标签行的类别序号，与 names 的数组位置一一对应。 */
    static JsonArray classTable(JsonArray names){
        JsonArray table=new JsonArray();
        for(int index=0;index<names.size();index++)table.add(Json.obj("id",Integer.toString(index),"name",names.get(index).getAsString()));
        return table;
    }

    private Path datasetDirectory(String id){
        Path base=store.root.resolve("training").resolve("datasets").normalize(),directory=base.resolve(id).normalize();
        if(!directory.startsWith(base))throw error(500,"training_dataset_path_invalid","训练数据集目录无效。");
        return directory;
    }

    // ===== 路径 A：用户上传训练集与验证集 =====

    private Scan scanUpload(JsonObject p)throws Exception{
        Path train=directory(p,"trainDir"),val=directory(p,"valDir");
        String taskType=null;
        if(p.has("taskType")){taskType=string(p,"taskType",32);if(!TASKS.contains(taskType))throw error(400,"training_task_invalid","训练任务类型无效。");}
        Scan scan=new Scan(taskType==null?"detect":taskType);
        JsonObject yaml=readYaml(p,train,val);
        if(taskType==null)issue(scan,"error","training_task_undetermined",null,0,"任务类型无法判定：未指定任务类型，也没有可读的 data.yaml。");
        scan.classes=classes(p,yaml,scan.issues);
        scan.keypointNames=keypointNames(p,yaml,scan.issues,taskType);
        if(yaml!=null)crossCheckSplit(scan.issues,yaml,train,val);
        if(taskType!=null&&!scan.classes.isEmpty()){
            scan.classCounts=new int[scan.classes.size()];
            collect(scan,"train",train);
            collect(scan,"val",val);
        }
        if(scan.files.size()>MAX_FILES)throw error(413,"training_dataset_too_large","单次训练数据集最多 20 万个文件。");
        scan.origin=Json.obj("kind","upload","dataYaml",yaml!=null);
        return scan;
    }

    /** 在所选训练/验证集目录附近寻找 data.yaml，用于读取 names 与 kpt_shape 并交叉校验。 */
    private JsonObject readYaml(JsonObject p,Path train,Path val){
        LinkedHashSet<Path> candidates=new LinkedHashSet<>();
        if(p.has("yamlDir"))candidates.add(directory(p,"yamlDir"));
        candidates.add(train);candidates.add(val);
        if(train.getParent()!=null)candidates.add(train.getParent());
        if(val.getParent()!=null)candidates.add(val.getParent());
        for(Path candidate:candidates){
            Path file=candidate.resolve("data.yaml");
            if(!Files.isRegularFile(file))continue;
            try{return parseYaml(candidate,Files.readString(file,StandardCharsets.UTF_8));}catch(Exception ignored){return null;}
        }
        return null;
    }

    /** 只读取生成快照所需的最小 YAML 子集：顶层 train/val、缩进的 names 映射与 kpt_shape。 */
    static JsonObject parseYaml(Path directory,String text){
        JsonObject result=Json.obj("names",new JsonArray(),"directory",directory.toAbsolutePath().normalize().toString());
        Map<Integer,String> declared=new TreeMap<>(),mapping=new TreeMap<>();
        boolean inNames=false;int keypoints=0;
        for(String raw:text.split("\\R")){
            String line=raw.stripTrailing();
            if(line.isBlank()||line.stripLeading().startsWith("#"))continue;
            String trimmed=line.stripLeading();boolean nested=line.length()!=trimmed.length();
            int colon=trimmed.indexOf(':');
            if(colon<0){inNames=false;continue;}
            String key=trimmed.substring(0,colon).strip(),value=trimmed.substring(colon+1).strip();
            if(!nested){
                inNames=key.equals("names");
                if(key.equals("train")||key.equals("val"))result.addProperty(key,unquote(value));
                if(key.equals("kpt_shape"))keypoints=integer(first(unescapeList(value)),0);
                continue;
            }
            if(inNames&&key.matches("0|[1-9][0-9]*"))mapping.put(Integer.parseInt(key),unquote(value));
        }
        // 类别编号必须从 0 起连续，否则无法与 YOLO 标签行号一一对应。
        boolean contiguous=!mapping.isEmpty();
        for(Integer key:mapping.keySet())if(key!=declared.size()&&contiguous){contiguous=false;break;}else if(contiguous)declared.put(key,mapping.get(key));
        if(contiguous)for(String name:declared.values())Json.array(result,"names").add(name);
        if(keypoints>0)result.addProperty("keypoints",keypoints);
        return result;
    }

    private static List<String> unescapeList(String value){
        String body=value.strip();
        if(body.startsWith("[")&&body.endsWith("]"))body=body.substring(1,body.length()-1);
        List<String> parts=new ArrayList<>();
        for(String item:body.split(","))parts.add(item.strip());
        return parts;
    }
    private static String first(List<String> values){return values.isEmpty()?"":values.getFirst();}
    private static String unquote(String value){
        String text=value.strip();
        if(text.length()>=2&&(text.startsWith("\"")&&text.endsWith("\"")||text.startsWith("'")&&text.endsWith("'")))text=text.substring(1,text.length()-1);
        return text.replace("\\\"","\"").replace("\\\\","\\");
    }
    private static int integer(String value,int fallback){try{return Integer.parseInt(value.strip());}catch(NumberFormatException e){return fallback;}}

    private JsonArray classes(JsonObject p,JsonObject yaml,JsonArray issues){
        JsonArray explicit=names(p,"classNames"),declared=yaml==null?new JsonArray():Json.array(yaml,"names");
        if(explicit!=null){
            if(!declared.isEmpty()&&!declared.equals(explicit))
                issue(issues,"error","training_classes_conflict",null,0,"data.yaml 的 names 与所选类别表不一致，请以 data.yaml 为准或修正类别表。");
            return explicit;
        }
        if(declared.isEmpty())issue(issues,"error","training_classes_undetermined",null,0,"类别表无法判定：请在 data.yaml 中声明 names，或显式提供类别名称。");
        return declared;
    }

    private JsonArray keypointNames(JsonObject p,JsonObject yaml,JsonArray issues,String taskType){
        if(!Objects.equals(taskType,"pose")||yaml==null)return new JsonArray();
        JsonArray explicit=names(p,"keypointNames");
        int declared=yaml.has("keypoints")?yaml.get("keypoints").getAsInt():0;
        if(explicit!=null&&declared>0&&explicit.size()!=declared)
            issue(issues,"error","training_keypoints_conflict",null,0,"data.yaml 的 kpt_shape 与所选关键点表数量不一致。");
        if(explicit!=null)return explicit;
        if(declared>0){JsonArray generated=new JsonArray();for(int i=0;i<declared;i++)generated.add("keypoint_"+(i+1));return generated;}
        issue(issues,"error","training_keypoints_undetermined",null,0,"关键点任务需要提供关键点名称或 data.yaml 的 kpt_shape。");
        return new JsonArray();
    }

    private static JsonArray names(JsonObject p,String field){
        if(!p.has(field))return null;
        JsonElement value=p.get(field);
        if(!value.isJsonArray())throw error(400,"training_parameter_invalid",field+" 必须为字符串数组。");
        JsonArray result=new JsonArray();Set<String> seen=new HashSet<>();
        for(JsonElement item:value.getAsJsonArray()){
            if(!item.isJsonPrimitive()||!item.getAsJsonPrimitive().isString())throw error(400,"training_parameter_invalid",field+" 只能包含字符串。");
            String name=item.getAsString().strip();
            if(name.isEmpty()||name.length()>200||!seen.add(name))throw error(400,"training_parameter_invalid",field+" 不能为空、重复或超过 200 字符。");
            result.add(name);
        }
        if(result.isEmpty())throw error(400,"training_parameter_invalid",field+" 不能为空数组。");
        return result;
    }

    private static void crossCheckSplit(JsonArray issues,JsonObject yaml,Path train,Path val){
        for(String[] pair:List.of(new String[]{"train",train.toString()},new String[]{"val",val.toString()})){
            String declared=Json.str(yaml,pair[0],null);
            if(declared==null||declared.isBlank())continue;
            Path resolved=Path.of(declared);
            if(!resolved.isAbsolute())resolved=Path.of(Json.required(yaml,"directory")).resolve(declared);
            if(!resolved.normalize().equals(Path.of(pair[1]).normalize()))
                issue(issues,"warning","training_yaml_split_mismatch",null,0,"data.yaml 声明的 "+pair[0]+" 目录与所选目录不同，本次以所选目录为准。");
        }
    }

    /** 枚举单个划分的图片与标签，逐文件完成配对、解码与标签校验。 */
    private void collect(Scan scan,String split,Path root)throws Exception{
        if(!Files.isDirectory(root))throw error(400,"training_directory_unavailable","训练或验证集目录不可访问。");
        boolean classify=scan.taskType.equals("classify");
        Path imageRoot=Files.isDirectory(root.resolve("images"))?root.resolve("images"):root;
        Path labelRoot=Files.isDirectory(root.resolve("labels"))?root.resolve("labels"):root;
        Map<Path,String> images=new TreeMap<>();
        try(var walk=Files.walk(imageRoot,classify?4:3)){
            for(Path path:walk.filter(Files::isRegularFile).toList()){
                String name=path.getFileName().toString();
                if(!IMAGE_SUFFIXES.contains(suffix(name)))continue;
                if(images.size()>=MAX_FILES)throw error(413,"training_dataset_too_large","单次训练数据集最多 20 万个文件。");
                images.put(path,relative(imageRoot,path));
            }
        }
        Set<String> labelNames=new HashSet<>();
        if(!classify){
            try(var walk=Files.walk(labelRoot,3)){
                for(Path path:walk.filter(Files::isRegularFile).toList()){
                    if(!suffix(path.getFileName().toString()).equals("txt"))continue;
                    labelNames.add(stem(relative(labelRoot,path))+".txt");
                }
            }
        }
        Set<String> matched=new HashSet<>();
        for(Map.Entry<Path,String> entry:images.entrySet()){
            Path path=entry.getKey();String image=entry.getValue();
            String className=null;
            if(classify){
                int separator=image.lastIndexOf('/');
                if(separator<0){issue(scan,"error","training_class_folder_missing",image,0,"分类数据要求每个类别一个子目录。");continue;}
                className=image.substring(0,separator);
                int index=classIndex(scan,className);
                if(index<0){issue(scan,"error","training_class_unknown",image,0,"类别目录 "+className+" 不在类别表中。");continue;}
                scan.classCounts[index]++;
            }
            int[] size;
            try{size=AssetFiles.dimensions(path);}
            catch(Exception unreadable){issue(scan,"error","training_image_unreadable",image,0,"图片无法解码，请修复或移除该文件。");continue;}
            JsonObject file=Json.obj("split",split,"name",path.getFileName().toString(),"source",path.toString(),"hash",Media.hash(path),
                "bytes",Files.size(path),"width",size[0],"height",size[1]);
            if(className!=null)file.addProperty("className",className);
            int objects=0;
            if(!classify){
                // 标签名按图片在图片根内的相对位置推导；images/ 与 labels/ 并列时不能跨根相对化。
                String labelName=stem(image)+".txt";matched.add(labelName);
                Path label=labelRoot.resolve(labelName).normalize();
                if(!Files.isRegularFile(label)){
                    // 缺标签文件不等于显式无目标图，不能按负样本使用。
                    issue(scan,"error","training_label_missing",image,0,"缺少同名标签文件；如需表示无目标请使用空标签文件。");
                }else if(Files.size(label)>MAX_LABEL_BYTES){
                    issue(scan,"error","training_label_too_large",labelName,0,"单个标签文件不能超过 2 MiB。");
                    continue;
                }else{
                    objects=checkLabel(scan,Files.readString(label,StandardCharsets.UTF_8),split+"/"+labelName,scan.classes.size());
                    file.addProperty("label",labelName);
                    file.addProperty("labelHash",Media.hash(label));
                    file.addProperty("labelSource",label.toString());
                    file.addProperty("labelBytes",Files.size(label));
                    if(objects==0){scan.emptyLabels++;issue(scan,"warning","training_empty_label",split+"/"+labelName,0,"空标签文件：该图会被当作显式无目标样本。");}
                }
            }
            file.addProperty("objects",objects);
            scan.images++;scan.objects+=objects;scan.bytes+=Files.size(path)+Json.number(file,"labelBytes",0);
            scan.files.add(file);
        }
        for(String label:labelNames)if(!matched.contains(label))issue(scan,"error","training_label_orphan",split+"/"+label,0,"该标签没有同名图片，无法配对。");
        if(images.isEmpty())issue(scan,"error","training_split_empty",null,0,split.equals("val")?"验证集没有任何图片，无法评估指标。":"训练集没有任何图片，无法训练。");
    }

    private static int classIndex(Scan scan,String className){
        for(int index=0;index<scan.classes.size();index++)if(scan.classes.get(index).getAsString().equals(className))return index;
        return -1;
    }

    /** 逐行校验 YOLO 标签；返回有效目标数量，空文件表示显式无目标。 */
    private int checkLabel(Scan scan,String text,String locator,int classes){
        int objects=0,lineNo=0;
        for(String line:text.split("\\R")){
            if(line.isBlank())continue;
            lineNo++;
            String[] fields=line.strip().split("\\s+");
            if(!fields[0].matches("0|[1-9][0-9]*")){issue(scan,"error","training_label_format_invalid",locator,lineNo,"类别编号必须为非负整数。");continue;}
            int index=Integer.parseInt(fields[0]);
            if(index>=classes){issue(scan,"error","training_class_index_out_of_range",locator,lineNo,"类别编号 "+index+" 超出 names 范围（共 "+classes+" 类）。");continue;}
            boolean valid=switch(scan.taskType){
                case "detect"->fields.length==5&&box(fields,1);
                case "obb"->fields.length==9&&coordinates(fields,1,9);
                case "segment"->fields.length>=7&&fields.length%2==1&&coordinates(fields,1,fields.length);
                case "pose"->scan.keypointNames.size()>0&&fields.length==5+3*scan.keypointNames.size()&&box(fields,1)&&visibility(fields,5,scan.keypointNames.size());
                default->false;
            };
            if(!valid){issue(scan,"error","training_label_format_invalid",locator,lineNo,"标签列数或取值与 "+scan.taskType+" 的 YOLO 约定不一致。");continue;}
            scan.classCounts[index]++;objects++;
        }
        return objects;
    }

    private static boolean box(String[] fields,int offset){
        if(!coordinates(fields,offset,offset+4))return false;
        double cx=value(fields[offset]),cy=value(fields[offset+1]),w=value(fields[offset+2]),h=value(fields[offset+3]);
        // 越界框在训练前就必须暴露，不能靠后续裁剪掩盖。
        return w>0&&h>0&&cx-w/2>=-1e-6&&cy-h/2>=-1e-6&&cx+w/2<=1+1e-6&&cy+h/2<=1+1e-6;
    }
    private static boolean visibility(String[] fields,int offset,int count){
        for(int i=0;i<count;i++)if(!fields[offset+3*i+2].matches("[012]"))return false;
        return true;
    }
    private static boolean coordinates(String[] fields,int from,int to){
        for(int i=from;i<to;i++){double number=value(fields[i]);if(!Double.isFinite(number)||number<0||number>1)return false;}
        return true;
    }
    private static double value(String raw){try{return Double.parseDouble(raw);}catch(NumberFormatException e){return Double.NaN;}}

    // ===== 路径 B：接入经 AI 标注后的数据集 =====

    private Scan scanExport(JsonObject p)throws Exception{
        String exportId=string(p,"exportId",128);
        ExportHistory.Fixed fixed=new ExportHistory(store).fixed(exportId);
        JsonObject manifest=fixed.manifest();
        if(!Json.str(Json.object(manifest,"format"),"labelFormat","").equals("yolo"))
            throw error(422,"training_format_unsupported","训练数据集需要 YOLO 标签格式的导出，请先按 YOLO 格式重新导出。");
        String taskType=Json.required(manifest,"taskType");
        if(!TASKS.contains(taskType))throw error(422,"training_task_invalid","导出记录的任务类型不能用于训练。");
        JsonArray definition=Json.array(manifest,"classes");
        if(definition.isEmpty())throw error(422,"training_classes_undetermined","导出清单缺少类别表，无法建立训练标签空间。");
        JsonArray keypointNames=Json.array(manifest,"keypointNames");
        if(taskType.equals("pose")&&keypointNames.isEmpty())throw error(422,"training_keypoints_undetermined","姿态导出缺少关键点模板，无法校验标签列数。");
        Scan scan=new Scan(taskType);
        // YOLO 标签行使用类别的数组序号，因此训练类别表按清单顺序重建为 id=序号的表。
        JsonArray sourceIds=new JsonArray();
        for(JsonElement element:definition){
            JsonObject declared=element.getAsJsonObject();
            scan.classes.add(Json.required(declared,"name"));
            sourceIds.add(Json.required(declared,"id"));
        }
        scan.keypointNames=keypointNames.deepCopy();
        scan.classCounts=new int[scan.classes.size()];
        boolean classify=taskType.equals("classify");
        Set<String> assets=new HashSet<>();
        for(JsonElement element:Json.array(manifest,"assets")){
            JsonObject asset=element.getAsJsonObject();
            String assetId=Json.required(asset,"assetId"),split=Json.required(asset,"split"),image=Json.required(asset,"image");
            if(!assets.add(assetId)){issue(scan,"error","training_duplicate_image",image,0,"导出清单出现重复素材。");continue;}
            Path source=ExportHistory.inside(fixed.directory(),image);
            if(!Media.hash(source).equals(Json.required(asset,"contentHash")))
                throw error(409,"export_dependency_changed","历史导出的图片副本已被外部修改，不能作为训练数据。");
            JsonObject file=Json.obj("split",split,"name",source.getFileName().toString(),"source",source.toString(),"hash",asset.get("contentHash"),
                "bytes",Files.size(source),"width",Json.integer(asset,"width",0),"height",Json.integer(asset,"height",0));
            if(classify){
                // 分类导出用目录表达类别，复制时保留该分组而不是重新猜测类别编号。
                String relative=image.startsWith(split+"/")?image.substring(split.length()+1):image;
                int separator=relative.lastIndexOf('/');
                if(separator<0)throw error(422,"training_class_folder_missing","分类导出缺少类别目录，无法建立训练标签空间。");
                file.addProperty("className",relative.substring(0,separator));
            }
            int objects=0;
            if(asset.has("label")&&!asset.get("label").isJsonNull()){
                String label=Json.required(asset,"label");Path labelPath=ExportHistory.inside(fixed.directory(),label);
                if(Files.size(labelPath)>MAX_LABEL_BYTES)throw error(413,"training_label_too_large","单个标签文件不能超过 2 MiB。");
                objects=checkLabel(scan,Files.readString(labelPath,StandardCharsets.UTF_8),label,scan.classes.size());
                file.addProperty("label",labelPath.getFileName().toString());
                file.addProperty("labelHash",Json.required(asset,"labelHash"));
                file.addProperty("labelSource",labelPath.toString());
                file.addProperty("labelBytes",Files.size(labelPath));
                if(objects==0){scan.emptyLabels++;issue(scan,"warning","training_empty_label",label,0,"空标签文件：该图会被当作显式无目标样本。");}
            }else if(!classify){
                issue(scan,"error","training_label_missing",image,0,"导出清单没有该图片的标签文件。");
            }else{
                int index=classIndex(scan,file.get("className").getAsString());
                if(index<0){issue(scan,"error","training_class_unknown",image,0,"类别目录不在导出类别表中。");continue;}
                scan.classCounts[index]++;
            }
            file.addProperty("objects",objects);
            scan.images++;scan.objects+=objects;scan.bytes+=Files.size(source)+Json.number(file,"labelBytes",0);
            scan.files.add(file);
        }
        scan.origin=Json.obj("kind","export","exportId",exportId,"manifestHash",Json.required(fixed.record(),"manifestHash"),
            "taskType",taskType,"labelFormat","yolo","sourceClassIds",sourceIds);
        return scan;
    }

    static String suffix(String name){int dot=name.lastIndexOf('.');return dot>0?name.substring(dot+1).toLowerCase(Locale.ROOT):"";}
    static String stem(String name){int dot=name.lastIndexOf('.');return dot>0?name.substring(0,dot):name;}
    static String relative(Path root,Path path){return root.relativize(path).toString().replace('\\','/');}

    // ===== 体检汇总 =====

    private static void issue(Scan scan,String severity,String code,String file,int line,String message){
        issue(scan.issues,severity,code,file,line,message);
    }
    private static void issue(JsonArray issues,String severity,String code,String file,int line,String message){
        if(issues.size()>=MAX_ISSUES)return;
        JsonObject issue=Json.obj("severity",severity,"code",code,"message",message);
        if(file!=null)issue.addProperty("file",file);
        if(line>0)issue.addProperty("line",line);
        issues.add(issue);
    }
    private static boolean hasError(JsonArray issues){
        for(JsonElement element:issues)if(Json.str(element.getAsJsonObject(),"severity","").equals("error"))return true;
        return false;
    }

    private static JsonObject inspect(Scan scan){
        JsonArray issues=scan.issues;
        if(scan.images>0&&scan.emptyLabels*2>scan.images)
            issue(issues,"warning","training_empty_label_ratio",null,0,"空标签图片占比超过一半，请确认其中不含漏标。");
        Map<String,Integer> splits=new TreeMap<>();Map<String,String> hashes=new LinkedHashMap<>();
        Set<String> duplicate=new LinkedHashSet<>(),overlap=new LinkedHashSet<>();
        for(JsonObject file:scan.files){
            String name=Json.required(file,"name"),split=Json.required(file,"split");
            splits.merge(split,1,Integer::sum);
            String previous=hashes.put(Json.required(file,"hash"),split);
            if(previous==null)continue;
            if(previous.equals(split))duplicate.add(name);else overlap.add(name);
        }
        if(!duplicate.isEmpty())issue(issues,"warning","training_duplicate_image",null,0,"同一划分内存在内容完全相同的图片 "+duplicate.size()+" 张。");
        if(!overlap.isEmpty())issue(issues,"warning","training_split_overlap",null,0,"训练集与验证集存在内容重叠 "+overlap.size()+" 张，指标可能偏乐观。");
        int max=0,min=Integer.MAX_VALUE;
        for(int count:scan.classCounts){max=Math.max(max,count);if(count>0)min=Math.min(min,count);}
        if(max>0&&min!=Integer.MAX_VALUE&&max>min*20)issue(issues,"warning","training_class_imbalance",null,0,"类别分布严重不均衡，少数类可能得不到有效学习。");
        if(issues.size()>=MAX_ISSUES)issue(issues,"warning","training_issues_truncated",null,0,"问题清单已达上限，请先修复已报告的问题后重新体检。");
        JsonObject summary=Json.obj("issues",issues.size(),"errors",count(issues,"error"),"warnings",count(issues,"warning"),
            "splits",Json.GSON.toJsonTree(splits),"classCounts",Json.GSON.toJsonTree(scan.classCounts),"images",scan.images,"objects",scan.objects,
            "emptyLabels",scan.emptyLabels,"bytes",scan.bytes,"classes",scan.classes.size(),"keypoints",scan.keypointNames.size(),"usable",!hasError(issues));
        return Json.obj("issues",issues,"summary",summary);
    }

    private static int count(JsonArray issues,String severity){
        int total=0;
        for(JsonElement element:issues)if(Json.str(element.getAsJsonObject(),"severity","").equals(severity))total++;
        return total;
    }

    // ===== 复制与配置生成 =====

    /** 按固定布局复制并逐文件校验哈希；任何不一致都使整份快照失败，而不是留下可疑副本。 */
    private JsonArray freeze(List<JsonObject> files,Path directory)throws Exception{
        JsonArray result=new JsonArray();Set<String> used=new HashSet<>();
        for(JsonObject file:files){
            String split=Json.required(file,"split"),className=Json.str(file,"className",null);
            String folder="images/"+split+"/"+(className==null?"":className+"/");
            String name=unique(used,folder,Json.required(file,"name"));
            JsonObject copied=Json.obj("split",split,"image",folder+name,"hash",Json.required(file,"hash"),"bytes",Json.required(file,"bytes"),
                "width",Json.required(file,"width"),"height",Json.required(file,"height"),"objects",Json.required(file,"objects"));
            if(className!=null)copied.addProperty("className",className);
            copyInto(Path.of(Json.required(file,"source")),directory,copied.get("image").getAsString(),Json.required(file,"hash"));
            if(file.has("label")){
                String label="labels/"+split+"/"+stem(name)+".txt";
                copied.addProperty("label",label);copied.addProperty("labelHash",Json.required(file,"labelHash"));
                copyInto(Path.of(Json.required(file,"labelSource")),directory,label,Json.required(file,"labelHash"));
            }
            result.add(copied);
        }
        return result;
    }

    private static void copyInto(Path source,Path directory,String relative,String expected)throws Exception{
        Path output=directory.resolve(relative).normalize();
        if(!output.startsWith(directory))throw error(409,"training_dataset_path_invalid","训练数据集目标路径无效。");
        Path parent=output.getParent();
        if(parent!=null)Files.createDirectories(parent);
        Files.copy(source,output);
        // 复制后再校验一次：源文件在扫描与复制之间被改动时必须整体失败。
        if(!Media.hash(output).equals(expected))throw error(409,"training_source_changed","源文件在创建快照期间被修改，请重新创建数据集。");
    }

    private static String unique(Set<String> used,String folder,String name){
        String extension=suffix(name),base=stem(name),candidate=name;
        for(int index=2;!used.add(folder+candidate);index++)candidate=base+"-"+index+(extension.isEmpty()?"":"."+extension);
        return candidate;
    }

    private static String yamlText(Scan scan){
        StringBuilder yaml=new StringBuilder("# 由自动标注小助手生成的训练快照，请勿手工修改\ntrain: images/train\nval: images/val\nnames:\n");
        for(int index=0;index<scan.classes.size();index++)yaml.append("  ").append(index).append(": ").append(Json.GSON.toJson(scan.classes.get(index).getAsString())).append('\n');
        if(scan.taskType.equals("pose")&&scan.keypointNames.size()>0)yaml.append("kpt_shape: [").append(scan.keypointNames.size()).append(", 3]\n");
        return yaml.toString();
    }

    /** 快照指纹覆盖类别表、逐文件内容哈希与规模；体检未通过时改为覆盖问题清单，保证同一份输入可复核。 */
    private static String snapshotHash(Scan scan,JsonObject data){
        StringBuilder canonical=new StringBuilder("training-v1\n").append(scan.taskType).append('\n').append(scan.classes).append('\n').append(scan.keypointNames).append('\n');
        List<String> lines=new ArrayList<>();
        for(JsonElement element:Json.array(data,"files")){
            JsonObject file=element.getAsJsonObject();
            lines.add(Json.required(file,"split")+"|"+Json.required(file,"image")+"|"+Json.required(file,"hash")+"|"+
                Json.str(file,"labelHash","-")+"|"+Json.integer(file,"width",0)+"x"+Json.integer(file,"height",0));
        }
        if(lines.isEmpty()){
            for(JsonElement element:scan.issues){
                JsonObject issue=element.getAsJsonObject();
                canonical.append(Json.required(issue,"severity")).append('|').append(Json.required(issue,"code")).append('|')
                    .append(Json.str(issue,"file","-")).append('|').append(Json.integer(issue,"line",0)).append('\n');
            }
        }else{
            Collections.sort(lines);
            for(String line:lines)canonical.append(line).append('\n');
        }
        return hashText(canonical.toString());
    }

    static String hashText(String text){
        try{
            MessageDigest digest=MessageDigest.getInstance("SHA-256");
            digest.update(text.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest.digest());
        }catch(Exception impossible){throw error(500,"training_hash_failed","训练数据集指纹计算失败。");}
    }

    private static void deleteDirectory(Path directory){
        if(!Files.isDirectory(directory))return;
        // 回滚失败只保留残留目录；记录状态仍为不可用，不会被训练任务读取。
        try(var walk=Files.walk(directory)){
            for(Path path:walk.sorted(Comparator.reverseOrder()).toList())Files.deleteIfExists(path);
        }catch(Exception ignored){}
    }

    private static Path directory(JsonObject p,String field){
        Path path=Path.of(string(p,field,32767)).toAbsolutePath().normalize();
        if(!Files.isDirectory(path))throw error(400,"training_directory_unavailable","所选目录不存在或不可访问："+field);
        return path;
    }
    private static void keys(JsonObject p,String... allowed){
        Set<String> names=Set.of(allowed);
        for(String name:p.keySet())if(!names.contains(name))throw error(400,"training_parameter_unknown","不支持的训练参数："+name);
    }
    private static String string(JsonObject p,String field,int max){
        JsonElement value=p.get(field);
        if(value==null||!value.isJsonPrimitive()||!value.getAsJsonPrimitive().isString())throw error(400,"training_parameter_missing","请填写训练参数："+field);
        String text=value.getAsString().strip();
        if(text.isEmpty()||text.length()>max)throw error(400,"training_parameter_invalid","训练参数为空或过长："+field);
        return text;
    }
    private static ApiError error(int status,String code,String message){return new ApiError(status,code,message);}
}
