package cn.autolabel.engine;

import com.google.gson.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.sql.Connection;
import java.util.*;
import java.util.concurrent.*;

/**
 * 数据集版本。
 *
 * 版本是「原始数据集 + 配方」在某一时刻的不可变产物：先解析出确定性的输入集（素材 + 标注版本 + 来源组），
 * 再按配方划分、复制为受管副本、逐文件校验哈希，最后原子发布并生成清单。
 * 生成过程只读原始素材与标注（I2），副本进入版本目录后不再改写（I1、I3）；
 * 划分以来源组为最小单位（I4），比例只能逼近目标并如实报告（7.4）。
 * 阶段 A 只支持最简配方：不筛选、不转换、按默认比例以来源组为单位划分。
 */
final class DatasetVersions implements AutoCloseable {
    private static final int MAX_ITEMS=200_000,MAX_ISSUES=2000,MAX_LIST=100,MAX_PAGE=500,MAX_NAME=200;
    private static final double[] DEFAULT_RATIO={0.7,0.2,0.1};
    private static final int PRECISION=8;
    private static final Set<String> LABELED=Set.of("candidate","modified","confirmed");
    private static final Set<String> SCOPES=Set.of("labeled","confirmed");
    private static final Set<String> SPLITS=Set.of("train","val","test");
    /** 划分规则名写入清单，消费端据此复算而不是去猜目录结构。 */
    private static final String SPLIT_RULE="ratio-source-group-v1";

    private final Store store;private final Projects projects;private final Exporter exporter;
    private final ExecutorService builds=Executors.newVirtualThreadPerTaskExecutor();
    private final Set<String> cancelled=ConcurrentHashMap.newKeySet();

    DatasetVersions(Store store,Projects projects,Exporter exporter){this.store=store;this.projects=projects;this.exporter=exporter;}

    // ===== 数据源解析 =====

    private static final class Source {
        String projectId,taskType,scope;JsonObject project;boolean classify;
        List<JsonObject> assets=new ArrayList<>(),excluded=new ArrayList<>();
        Map<String,Path> paths=new LinkedHashMap<>();
        JsonArray classes=new JsonArray(),keypointNames=new JsonArray();
        Map<String,Integer> classIndex=new LinkedHashMap<>();
    }

    /** 按素材标识顺序解析，保证同一输入多次解析得到完全相同的项序（I6 的前提）。 */
    private Source resolve(String projectId,String scope)throws Exception{
        projects.get(projectId);
        return store.read(c->{
            Source s=new Source();s.projectId=projectId;s.scope=scope;
            s.project=Store.document(c,"projects",projectId);
            s.taskType=Json.required(s.project,"taskType");s.classify=s.taskType.equals("classify");
            for(JsonElement e:Json.array(s.project,"classes"))s.classes.add(e.getAsJsonObject());
            for(int i=0;i<s.classes.size();i++)s.classIndex.put(Json.required(s.classes.get(i).getAsJsonObject(),"id"),i);
            s.keypointNames=Json.array(Json.object(s.project,"settings"),"keypointNames").deepCopy();
            for(JsonObject row:Store.rows(c,"SELECT id,data,path FROM assets WHERE project_id=? ORDER BY id",projectId)){
                JsonObject asset=Json.parse(Json.required(row,"data")),status=asset;
                String state=Json.str(status,"status","");
                // 未纳入范围的素材同样参与解析：它们构成「遗漏范围」，只是不进入版本内容。
                if(scope.equals("confirmed")?!state.equals("confirmed"):!LABELED.contains(state)){s.excluded.add(asset);continue;}
                s.assets.add(asset);s.paths.put(Json.required(asset,"id"),Path.of(Json.required(row,"path")));
            }
            if(s.assets.size()+s.excluded.size()>MAX_ITEMS)throw error(413,"dataset_too_large","单个数据集版本最多 "+MAX_ITEMS+" 张图片。");
            return s;
        });
    }

    private static JsonArray classTable(Source s){
        JsonArray table=new JsonArray();
        for(int i=0;i<s.classes.size();i++)table.add(Json.obj("id",Json.required(s.classes.get(i).getAsJsonObject(),"id"),
            "name",Json.required(s.classes.get(i).getAsJsonObject(),"name"),"index",i));
        return table;
    }
    private static String className(Source s,String classId){
        for(JsonElement e:s.classes)if(Json.required(e.getAsJsonObject(),"id").equals(classId))return Json.required(e.getAsJsonObject(),"name");
        return classId;
    }

    // ===== 预检 =====

    JsonObject preflight(JsonObject p)throws Exception{
        keys(p,"projectId","annotationScope");
        String scope=scope(p);
        Source s=resolve(string(p,"projectId",128),scope);
        JsonObject inspection=inspect(s);
        long blocking=blocking(Json.array(inspection,"issues"));
        return Json.obj("projectId",s.projectId,"taskType",s.taskType,"annotationScope",scope,
            "assets",s.assets.size(),"excluded",s.excluded.size(),"groups",distinctGroups(s),
            "classes",classTable(s),"keypointNames",s.keypointNames.deepCopy(),
            "split",Json.obj("rule",SPLIT_RULE,"train",DEFAULT_RATIO[0],"val",DEFAULT_RATIO[1],"test",DEFAULT_RATIO[2]),
            "inspection",inspection,"blocking",blocking,"canBuild",blocking==0);
    }

    private JsonObject inspect(Source s){return exporter.inspect(new Exporter.Snapshot(s.project,s.assets,s.paths,s.taskType));}
    private static long distinctGroups(Source s){return Exporter.groups(s.assets).values().stream().distinct().count();}
    private static long blocking(JsonArray issues){
        long total=0;
        for(JsonElement e:issues)if(Json.str(e.getAsJsonObject(),"severity","").equals("error"))total++;
        return total;
    }

    // ===== 生成 =====

    JsonObject create(JsonObject p)throws Exception{
        keys(p,"projectId","name","annotationScope","seed");
        String projectId=string(p,"projectId",128),scope=scope(p);
        String name=p.has("name")?string(p,"name",MAX_NAME):"";
        String seed=p.has("seed")&&Json.str(p,"seed","").strip().length()>0?string(p,"seed",256):Json.id();
        Source s=resolve(projectId,scope);
        JsonObject inspection=inspect(s);
        if(blocking(Json.array(inspection,"issues"))>0)
            throw new ApiError(422,"dataset_version_blocked","数据集体检存在阻断问题，请先处理后重新生成版本。",inspection);
        if(s.assets.isEmpty())throw error(422,"dataset_version_empty","当前标注范围内没有可用素材，无法生成版本。");
        JsonObject recipe=recipe(scope,seed);String recipeHash=hashText(recipe.toString());
        String id=Json.id(),buildId=Json.id(),now=Json.now();
        store.tx(c->{
            int next=(int)Json.number(Store.one(c,"SELECT COALESCE(MAX(version),0)+1 AS n FROM dataset_versions WHERE project_id=?",projectId),"n",1);
            JsonObject data=Json.obj("id",id,"projectId",projectId,"number",next,"name",name,"status","building",
                "sourceKind","project","taskType",s.taskType,"annotationScope",scope,"recipe",recipe,"recipeHash",recipeHash,
                "classes",classTable(s),"keypointNames",s.keypointNames.deepCopy(),"inspection",inspection,"createdAt",now);
            Store.update(c,"INSERT INTO dataset_versions(id,project_id,version,status,recipe_hash,created_at,data) VALUES(?,?,?,?,?,?,?)",
                id,projectId,next,"building",recipeHash,now,data);
            Store.update(c,"INSERT INTO dataset_version_builds(id,version_id,status,created_at,updated_at,data) VALUES(?,?,?,?,?,?)",
                buildId,id,"queued",now,now,Json.obj("versionId",id,"progress",Json.obj("stage","queued","done",0,"total",0)));
            Store.event(c,"dataset.version.created",null,null,null,Json.obj("versionId",id,"projectId",projectId,"number",next,"recipeHash",recipeHash));
            return null;
        });
        builds.execute(()->run(id,buildId,projectId,scope,recipe,recipeHash,seed));
        return get(Json.obj("versionId",id));
    }

    private static JsonObject recipe(String scope,String seed){
        return Json.obj("selection",Json.obj("annotationScope",scope),"transform",new JsonObject(),
            "split",Json.obj("mode",SPLIT_RULE,"train",DEFAULT_RATIO[0],"val",DEFAULT_RATIO[1],"test",DEFAULT_RATIO[2],"seed",seed));
    }

    private void run(String versionId,String buildId,String projectId,String scope,JsonObject recipe,String recipeHash,String seed){
        Path temporary=null;
        try{
            Source s=resolve(projectId,scope);
            int total=s.assets.size()+s.excluded.size();
            progress(buildId,"scanning",0,total);
            JsonObject inspection=inspect(s);
            if(blocking(Json.array(inspection,"issues"))>0)
                throw new ApiError(422,"dataset_version_blocked","数据集体检存在阻断问题，版本生成已停止。",inspection);
            Map<String,String> groups=Exporter.groups(s.assets);
            List<String> order=orderedGroups(groups,seed);
            Map<String,String> splits=assign(order);
            progress(buildId,"splitting",0,total);
            Path base=versionsDirectory();Files.createDirectories(base);
            temporary=base.resolve(".autolabel-partial-"+versionId);Path target=base.resolve(versionId);
            Files.createDirectory(temporary);
            long expected=0;for(Path path:s.paths.values())expected+=Files.size(path);
            store.requireSpace(expected+128L*1024*1024);
            List<JsonObject> items=new ArrayList<>();JsonArray manifestItems=new JsonArray();
            Map<String,long[]> counters=new LinkedHashMap<>();for(String split:SPLITS)counters.put(split,new long[2]);
            long bytes=0,objects=0;int position=0;
            // 被排除项先入库：它们决定「遗漏范围」，position 是稳定项序。
            for(JsonObject asset:s.excluded)items.add(excludedItem(asset,++position,"annotation_scope_excluded"));
            for(JsonObject asset:s.assets){
                if(cancelled.contains(buildId))throw error(409,"dataset_version_cancelled","版本生成已取消。");
                String assetId=Json.required(asset,"id"),contentHash=Json.required(asset,"contentHash");
                String split=splits.get(groups.get(assetId));if(split==null)split="train";
                Path source=s.paths.get(assetId),copy=temporary.resolve(imagePath(s,asset,split,assetId,source));
                Files.createDirectories(copy.getParent());
                if(!Media.hash(source).equals(contentHash))throw error(409,"dataset_source_changed","基准图片内容在生成期间被改变，版本生成已停止。");
                Files.copy(source,copy);
                if(!Media.hash(copy).equals(contentHash))throw error(500,"dataset_copy_failed","版本图片副本校验失败。");
                String image=relative(temporary,copy),label=null,labelHash=null;bytes+=Files.size(copy);
                if(!s.classify){
                    String text=ExportWriters.yolo(asset,s.taskType,s.classIndex,PRECISION);
                    Path labelFile=temporary.resolve("labels").resolve(split).resolve(assetId+".txt");
                    Files.createDirectories(labelFile.getParent());Files.writeString(labelFile,text,StandardCharsets.UTF_8);
                    label=relative(temporary,labelFile);labelHash=Media.hash(labelFile);bytes+=Files.size(labelFile);
                }
                int count=Json.array(asset,"annotations").size();objects+=count;
                long[] counter=counters.get(split);counter[0]++;counter[1]+=count;
                JsonObject item=Json.obj("position",++position,"assetId",assetId,"outcome","included","split",split,
                    "sourceGroup",groups.get(assetId),"image",image,"contentHash",contentHash,"width",Json.integer(asset,"width",0),
                    "height",Json.integer(asset,"height",0),"objects",count,"annotationVersion",Json.integer(asset,"version",0),
                    "name",Json.str(asset,"name",assetId),"bytes",Files.size(copy));
                if(s.classify&&!Json.array(asset,"annotations").isEmpty()){
                    String classId=Json.required(Json.array(asset,"annotations").get(0).getAsJsonObject(),"classId");
                    item.addProperty("classId",classId);item.addProperty("className",className(s,classId));
                }
                if(label!=null){item.addProperty("label",label);item.addProperty("labelHash",labelHash);}
                items.add(item);manifestItems.add(item);
                if(position%32==0)progress(buildId,"copying",position,total);
            }
            progress(buildId,"copying",position,total);
            JsonArray auxiliary=new JsonArray();
            if(!s.classify){
                Path yaml=temporary.resolve("data.yaml");Files.writeString(yaml,yamlText(s),StandardCharsets.UTF_8);
                auxiliary.add(Json.obj("path","data.yaml","hash",Media.hash(yaml)));
            }
            JsonObject manifest=manifest(versionId,s,recipe,recipeHash,manifestItems,items,order.size(),inspection,auxiliary,objects,bytes,counters);
            Path manifestFile=temporary.resolve("manifest.json");
            Files.writeString(manifestFile,Json.GSON.toJson(manifest),StandardCharsets.UTF_8);
            String manifestHash=Media.hash(manifestFile),contentHash=contentHash(s,items),now=Json.now();
            progress(buildId,"publishing",position,total);
            if(cancelled.contains(buildId))throw error(409,"dataset_version_cancelled","版本生成已取消。");
            Files.move(temporary,target,StandardCopyOption.ATOMIC_MOVE);temporary=null;
            List<JsonObject> frozen=items;
            store.tx(c->{
                for(JsonObject item:frozen)
                    Store.update(c,"INSERT INTO dataset_version_items(version_id,position,asset_id,outcome,split,data) VALUES(?,?,?,?,?,?)",
                        versionId,Json.integer(item,"position",0),Json.str(item,"assetId",null),Json.required(item,"outcome"),Json.required(item,"split"),item);
                Store.update(c,"UPDATE dataset_versions SET status='ready',content_hash=?,manifest_hash=?,completed_at=?,"
                    +"data=json_set(data,'$.status','ready','$.completedAt',?,'$.summary',json(?),'$.split',json(?),'$.selection',json(?),'$.inspection',json(?)) WHERE id=?",
                    contentHash,manifestHash,now,now,manifest.get("summary").toString(),manifest.get("split").toString(),
                    manifest.get("selection").toString(),inspection.toString(),versionId);
                Store.update(c,"UPDATE dataset_version_builds SET status='done',updated_at=?,data=json_set(data,'$.progress',json(?)) WHERE id=?",
                    now,Json.obj("stage","done","done",frozen.size(),"total",frozen.size()).toString(),buildId);
                Store.event(c,"dataset.version.ready",null,null,null,Json.obj("versionId",versionId,"projectId",projectId,"contentHash",contentHash,"manifestHash",manifestHash));
                return null;
            });
        }catch(Exception failure){
            if(temporary!=null)deleteDirectory(temporary);
            fail(versionId,buildId,failure);
        }finally{cancelled.remove(buildId);}
    }

    private static JsonObject excludedItem(JsonObject asset,int position,String reason){
        return Json.obj("position",position,"assetId",Json.required(asset,"id"),"outcome","filtered_out","split","none",
            "reasonCode",reason,"status",Json.str(asset,"status",""),"name",Json.str(asset,"name",Json.required(asset,"id")));
    }

    private static String imagePath(Source s,JsonObject asset,String split,String assetId,Path source){
        String extension=TrainingDatasets.suffix(source.getFileName().toString());
        if(extension.isEmpty())extension="png";
        String folder="";
        if(s.classify){
            JsonArray annotations=Json.array(asset,"annotations");
            // 分类目录用类别标识而不是展示名：目录名必须唯一且不受重命名影响。
            folder=annotations.isEmpty()?"unlabeled":Json.required(annotations.get(0).getAsJsonObject(),"classId");
        }
        return "images/"+split+"/"+(folder.isEmpty()?"":folder+"/")+assetId+"."+extension;
    }

    /** 确定性排序：按种子与来源组标识的哈希排序，同种子必然得到同一划分（I6）。 */
    private static List<String> orderedGroups(Map<String,String> groups,String seed){
        List<String> labels=new ArrayList<>(groups.values().stream().distinct().toList());
        labels.sort(Comparator.comparing(label->hashText(seed+"|"+label)));
        return labels;
    }

    /** 以来源组为单位逼近目标比例；组数不足时保证每个非空划分至少一组，实际比例如实写入清单（7.4）。 */
    private static Map<String,String> assign(List<String> order){
        int total=order.size();
        if(total==0)return Map.of();
        int train,val;
        if(total<3){train=1;val=total>=2?1:0;}
        else{
            train=Math.max(1,Math.min((int)Math.round(total*DEFAULT_RATIO[0]),total-2));
            val=Math.max(1,Math.min((int)Math.round(total*DEFAULT_RATIO[1]),total-train-1));
        }
        Map<String,String> result=new HashMap<>();
        for(int i=0;i<total;i++)result.put(order.get(i),i<train?"train":i<train+val?"val":"test");
        return result;
    }

    private static JsonObject manifest(String versionId,Source s,JsonObject recipe,String recipeHash,JsonArray manifestItems,
            List<JsonObject> items,int groups,JsonObject inspection,JsonArray auxiliary,long objects,long bytes,Map<String,long[]> counters){
        JsonArray actual=new JsonArray();
        for(String split:SPLITS)actual.add(Json.obj("split",split,"images",counters.get(split)[0],"objects",counters.get(split)[1]));
        Map<String,Integer> reasons=new TreeMap<>();int excluded=0;
        for(JsonObject item:items)if(Json.str(item,"outcome","").equals("filtered_out")){
            excluded++;reasons.merge(Json.str(item,"reasonCode","unspecified"),1,Integer::sum);
        }
        long errors=blocking(Json.array(inspection,"issues")),issues=Json.array(inspection,"issues").size();
        JsonArray copy=new JsonArray();for(JsonObject item:items)copy.add(item.deepCopy());
        return Json.obj("schemaVersion",3,"kind","dataset-version","generatorVersion","0.1.0","id",versionId,
            "projectId",s.projectId,"taskType",s.taskType,"classes",classTable(s),"keypointNames",s.keypointNames.deepCopy(),
            "lineage",Json.obj("sourceKind","project","parentVersionId",null,"annotationScope",s.scope),
            "recipe",recipe,"recipeHash",recipeHash,
            "selection",Json.obj("annotationScope",s.scope,"excluded",excluded,"excludedByReason",Json.GSON.toJsonTree(reasons)),
            "transform",new JsonObject(),
            "split",Json.obj("mode",SPLIT_RULE,"rule",SPLIT_RULE,"train",DEFAULT_RATIO[0],"val",DEFAULT_RATIO[1],"test",DEFAULT_RATIO[2],
                "seed",Json.str(Json.object(recipe,"split"),"seed",""),"groups",groups,"actual",actual),
            "summary",Json.obj("images",manifestItems.size(),"excluded",excluded,"objects",objects,"bytes",bytes,"groups",groups,
                "issues",issues,"errors",errors,"warnings",issues-errors),
            "inspection",inspection,"items",copy,"auxiliaryFiles",auxiliary);
    }

    private static String contentHash(Source s,List<JsonObject> items){
        StringBuilder canonical=new StringBuilder("dataset-version-v1\n").append(s.taskType).append('\n')
            .append(s.classes).append('\n').append(s.keypointNames).append('\n');
        List<String> lines=new ArrayList<>();
        for(JsonObject item:items)lines.add(Json.str(item,"assetId","-")+"|"+Json.required(item,"outcome")+"|"+Json.str(item,"split","none")
            +"|"+Json.str(item,"sourceGroup","-")+"|"+Json.str(item,"image","-")+"|"+Json.str(item,"contentHash","-")+"|"+Json.str(item,"labelHash","-"));
        Collections.sort(lines);
        for(String line:lines)canonical.append(line).append('\n');
        return hashText(canonical.toString());
    }

    private static String yamlText(Source s){
        StringBuilder yaml=new StringBuilder("# 由自动标注小助手生成的数据集版本，请勿手工修改\ntrain: images/train\nval: images/val\nnames:\n");
        for(int i=0;i<s.classes.size();i++)yaml.append("  ").append(i).append(": ").append(Json.GSON.toJson(Json.required(s.classes.get(i).getAsJsonObject(),"name"))).append('\n');
        if(s.taskType.equals("pose")&&s.keypointNames.size()>0)yaml.append("kpt_shape: [").append(s.keypointNames.size()).append(", 3]\n");
        return yaml.toString();
    }

    // ===== 查询 =====

    JsonObject get(JsonObject p){
        keys(p,"versionId");
        String versionId=string(p,"versionId",128);
        return store.read(c->view(c,load(c,versionId)));
    }

    JsonObject list(JsonObject p){
        keys(p,"projectId","offset","limit");
        int limit=Json.bounded(p,"limit",MAX_LIST,1,MAX_LIST),offset=Json.bounded(p,"offset",0,0,Integer.MAX_VALUE);
        return store.read(c->{
            String condition="status<>'deleted'";List<Object> args=new ArrayList<>();
            if(p.has("projectId")){condition+=" AND project_id=?";args.add(string(p,"projectId",128));}
            long total=Json.number(Store.one(c,"SELECT COUNT(*) AS n FROM dataset_versions WHERE "+condition,args.toArray()),"n",0);
            args.add(limit);args.add(offset);JsonArray result=new JsonArray();
            for(JsonObject row:Store.rows(c,"SELECT data FROM dataset_versions WHERE "+condition+" ORDER BY project_id,version DESC LIMIT ? OFFSET ?",args.toArray()))
                result.add(view(c,Json.parse(Json.required(row,"data"))));
            return Json.obj("items",result,"total",total,"offset",offset,"limit",limit);
        });
    }

    JsonObject items(JsonObject p){
        keys(p,"versionId","outcome","offset","limit");
        String versionId=string(p,"versionId",128);
        int limit=Json.bounded(p,"limit",MAX_PAGE,1,MAX_PAGE),offset=Json.bounded(p,"offset",0,0,Integer.MAX_VALUE);
        String outcome=p.has("outcome")?string(p,"outcome",32):null;
        return store.read(c->{
            if(Store.one(c,"SELECT id FROM dataset_versions WHERE id=?",versionId)==null)throw error(404,"not_found","数据集版本不存在。");
            String condition="version_id=?";List<Object> args=new ArrayList<>(List.of(versionId));
            if(outcome!=null){condition+=" AND outcome=?";args.add(outcome);}
            long total=Json.number(Store.one(c,"SELECT COUNT(*) AS n FROM dataset_version_items WHERE "+condition,args.toArray()),"n",0);
            args.add(limit);args.add(offset);JsonArray rows=new JsonArray();
            for(JsonObject row:Store.rows(c,"SELECT data FROM dataset_version_items WHERE "+condition+" ORDER BY position LIMIT ? OFFSET ?",args.toArray()))
                rows.add(Json.parse(Json.required(row,"data")));
            return Json.obj("items",rows,"total",total,"offset",offset,"limit",limit);
        });
    }

    /** 列上的指纹不进 data，读取时合并，避免视图里出现两套哈希。 */
    private static JsonObject load(Connection c,String versionId)throws Exception{
        JsonObject row=Store.one(c,"SELECT * FROM dataset_versions WHERE id=?",versionId);
        if(row==null)throw error(404,"not_found","数据集版本不存在。");
        JsonObject data=Json.parse(Json.required(row,"data"));
        data.addProperty("id",versionId);
        for(String[] pair:List.of(new String[]{"project_id","projectId"},new String[]{"version","number"},new String[]{"status","status"},
            new String[]{"recipe_hash","recipeHash"},new String[]{"content_hash","contentHash"},new String[]{"manifest_hash","manifestHash"}))
            if(!row.get(pair[0]).isJsonNull())data.addProperty(pair[1],row.get(pair[0]).getAsString());
        for(String[] pair:List.of(new String[]{"created_at","createdAt"},new String[]{"completed_at","completedAt"}))
            if(!row.get(pair[0]).isJsonNull())data.addProperty(pair[1],row.get(pair[0]).getAsString());
        return data;
    }

    /** 对外视图不含受管绝对路径与用户目录（I9）。 */
    private JsonObject view(Connection c,JsonObject record)throws Exception{
        JsonObject result=new JsonObject();
        for(String field:List.of("id","projectId","number","name","status","sourceKind","taskType","annotationScope",
            "recipe","recipeHash","contentHash","manifestHash","classes","keypointNames","summary","split","selection","createdAt","completedAt","failure"))
            if(record.has(field))result.add(field,record.get(field).deepCopy());
        if(record.has("inspection")){
            JsonObject inspection=Json.object(record,"inspection");
            result.add("inspection",Json.obj("issues",Json.array(inspection,"issues"),"summary",Json.object(inspection,"summary").deepCopy()));
        }
        JsonArray counts=new JsonArray();
        for(JsonObject row:Store.rows(c,"SELECT outcome,split,COUNT(*) AS n FROM dataset_version_items WHERE version_id=? GROUP BY outcome,split ORDER BY outcome,split",Json.required(record,"id")))
            counts.add(Json.obj("outcome",row.get("outcome"),"split",row.get("split"),"count",row.get("n")));
        result.add("counts",counts);
        JsonObject build=Store.one(c,"SELECT status,data FROM dataset_version_builds WHERE version_id=? ORDER BY created_at DESC LIMIT 1",Json.required(record,"id"));
        if(build!=null)result.add("build",Json.obj("status",build.get("status"),"progress",Json.object(Json.parse(Json.required(build,"data")),"progress").deepCopy()));
        return result;
    }

    JsonObject cancel(JsonObject p){
        keys(p,"versionId");
        String versionId=string(p,"versionId",128);
        return store.tx(c->{
            JsonObject record=Store.document(c,"dataset_versions",versionId);
            if(!Json.str(record,"status","").equals("building"))throw error(409,"dataset_version_not_building","只有正在生成的版本可以取消。");
            JsonObject build=Store.one(c,"SELECT id FROM dataset_version_builds WHERE version_id=? ORDER BY created_at DESC LIMIT 1",versionId);
            if(build!=null)cancelled.add(Json.required(build,"id"));
            return Json.obj("versionId",versionId,"cancelled",true);
        });
    }

    JsonObject delete(JsonObject p){
        keys(p,"versionId","confirm");
        if(!Json.bool(p,"confirm",false))throw error(400,"dataset_version_confirmation_required","请明确确认后再删除数据集版本。");
        String versionId=string(p,"versionId",128);
        return store.tx(c->{
            JsonObject record=Store.document(c,"dataset_versions",versionId),status=record;
            if(Json.str(status,"status","").equals("deleted"))return Json.obj("versionId",versionId,"deleted",true);
            if(Json.str(status,"status","").equals("building"))throw error(409,"dataset_version_building","正在生成的版本请先取消再删除。");
            // 软删除：副本保留，元数据与逐项记录仍可追溯，彻底清理交由生命周期管理处理（9.3）。
            Store.update(c,"UPDATE dataset_versions SET status='deleted',data=json_set(data,'$.status','deleted','$.deletedAt',?) WHERE id=?",Json.now(),versionId);
            Store.event(c,"dataset.version.deleted",null,null,null,Json.obj("versionId",versionId,"projectId",record.get("projectId"),"number",record.get("number")));
            return Json.obj("versionId",versionId,"deleted",true);
        });
    }

    // ===== 对比与复核 =====

    JsonObject compare(JsonObject p){
        keys(p,"versionId","otherVersionId");
        String left=string(p,"versionId",128),right=string(p,"otherVersionId",128);
        return store.read(c->{
            JsonObject a=load(c,left),b=load(c,right);
            Map<String,JsonObject> first=included(c,left),second=included(c,right);
            JsonArray added=new JsonArray(),removed=new JsonArray(),changed=new JsonArray();int unchanged=0;
            for(var entry:first.entrySet()){
                JsonObject other=second.get(entry.getKey());
                if(other==null){removed.add(entry.getKey());continue;}
                JsonArray fields=new JsonArray();
                for(String field:List.of("contentHash","labelHash","split","sourceGroup","objects"))
                    if(!Objects.equals(entry.getValue().get(field),other.get(field)))fields.add(field);
                if(fields.isEmpty())unchanged++;else changed.add(Json.obj("assetId",entry.getKey(),"fields",fields));
            }
            for(String id:second.keySet())if(!first.containsKey(id))added.add(id);
            return Json.obj("versionId",left,"otherVersionId",right,"added",added,"removed",removed,"changed",changed,"unchanged",unchanged,
                "classesChanged",!Json.array(a,"classes").equals(Json.array(b,"classes"))||!Json.array(a,"keypointNames").equals(Json.array(b,"keypointNames")),
                "recipeChanged",!Objects.equals(Json.object(a,"recipe"),Json.object(b,"recipe")));
        });
    }

    private static Map<String,JsonObject> included(Connection c,String versionId)throws Exception{
        Map<String,JsonObject> result=new LinkedHashMap<>();
        for(JsonObject row:Store.rows(c,"SELECT data FROM dataset_version_items WHERE version_id=? AND outcome='included' ORDER BY position",versionId)){
            JsonObject item=Json.parse(Json.required(row,"data"));result.put(Json.required(item,"assetId"),item);
        }
        return result;
    }

    /** 按清单逐项校验受管副本：任一缺失或哈希不一致都明确列出，不做静默替换（8.1）。 */
    JsonObject verify(JsonObject p)throws Exception{
        keys(p,"versionId");
        String versionId=string(p,"versionId",128);
        JsonObject record=store.read(c->load(c,versionId));
        if(!Json.str(record,"status","").equals("ready"))throw error(409,"dataset_version_not_ready","只有已生成的版本可以复核。");
        Path directory=version(versionId),manifestFile=directory.resolve("manifest.json");
        if(!Files.isRegularFile(manifestFile))throw error(409,"dataset_manifest_missing","版本清单缺失，无法复核。");
        String manifestHash=Json.str(record,"manifestHash","");
        if(manifestHash.isEmpty()||!Media.hash(manifestFile).equals(manifestHash))
            throw error(409,"dataset_manifest_changed","版本清单已被外部修改，不能证明副本未被改动。");
        JsonObject manifest=Json.parse(Files.readString(manifestFile,StandardCharsets.UTF_8));
        List<String[]> members=new ArrayList<>();
        for(JsonElement e:Json.array(manifest,"items")){
            JsonObject item=e.getAsJsonObject();
            if(!Json.str(item,"outcome","").equals("included"))continue;
            members.add(new String[]{Json.required(item,"image"),Json.required(item,"contentHash")});
            if(item.has("label"))members.add(new String[]{Json.required(item,"label"),Json.required(item,"labelHash")});
        }
        for(JsonElement e:Json.array(manifest,"auxiliaryFiles")){JsonObject file=e.getAsJsonObject();members.add(new String[]{Json.required(file,"path"),Json.required(file,"hash")});}
        JsonArray missing=new JsonArray(),changed=new JsonArray();int verified=0;
        for(String[] member:members){
            Path file=directory.resolve(member[0]).normalize();
            if(!file.startsWith(directory)||!Files.isRegularFile(file)){if(missing.size()<MAX_ISSUES)missing.add(member[0]);continue;}
            if(!Media.hash(file).equals(member[1])){if(changed.size()<MAX_ISSUES)changed.add(member[0]);continue;}
            verified++;
        }
        return Json.obj("versionId",versionId,"verified",verified,"total",members.size(),"missing",missing,"changed",changed,
            "consistent",missing.isEmpty()&&changed.isEmpty(),"contentHash",Json.str(record,"contentHash",""),"manifestHash",manifestHash);
    }

    // ===== 目录与辅助 =====

    private Path versionsDirectory(){return store.root.resolve("datasets").resolve("versions").normalize();}
    /** 版本目录：只有 ready 版本才存在对应内容，消费端引用前必须校验状态。 */
    Path version(String id)throws Exception{
        Path base=versionsDirectory(),directory=base.resolve(id).normalize();
        if(!directory.startsWith(base))throw error(500,"dataset_version_path_invalid","数据集版本目录无效。");
        return directory;
    }
    private static String relative(Path root,Path path){return root.relativize(path).toString().replace('\\','/');}

    private void progress(String buildId,String stage,int done,int total){
        try{
            store.tx(c->{
                JsonObject row=Store.one(c,"SELECT data FROM dataset_version_builds WHERE id=?",buildId);
                if(row==null)return null;
                JsonObject data=Json.parse(Json.required(row,"data")),progress=Json.object(data,"progress");
                progress.addProperty("stage",stage);progress.addProperty("done",done);progress.addProperty("total",total);
                data.add("progress",progress);
                Store.update(c,"UPDATE dataset_version_builds SET status=?,updated_at=?,data=? WHERE id=?",stage,Json.now(),data,buildId);
                return null;
            });
        }catch(Exception ignored){/* 进度写入失败不能中断生成本身。 */}
    }

    private void fail(String versionId,String buildId,Exception failure){
        String code=failure instanceof ApiError a?a.code:"dataset_version_failed";
        String message=failure instanceof ApiError a?a.getMessage():"版本生成失败，请查看诊断后重试。";
        String status=code.equals("dataset_version_cancelled")?"cancelled":"failed",now=Json.now();
        String detail=Json.obj("code",code,"message",message).toString();
        try{
            store.tx(c->{
                Store.update(c,"UPDATE dataset_versions SET status=?,data=json_set(data,'$.status',?,'$.failure',json(?)) WHERE id=?",status,status,detail,versionId);
                Store.update(c,"UPDATE dataset_version_builds SET status=?,updated_at=?,data=json_set(data,'$.progress',json(?),'$.failure',json(?)) WHERE id=?",
                    status,now,Json.obj("stage",status,"done",0,"total",0).toString(),detail,buildId);
                Store.event(c,"dataset.version."+status,null,null,null,Json.obj("versionId",versionId,"code",code));
                return null;
            });
        }catch(Exception ignored){}
    }

    private static void deleteDirectory(Path directory){
        if(!Files.isDirectory(directory))return;
        try(var walk=Files.walk(directory)){for(Path path:walk.sorted(Comparator.reverseOrder()).toList())Files.deleteIfExists(path);}
        catch(Exception ignored){}
    }

    static String hashText(String text){
        try{
            MessageDigest digest=MessageDigest.getInstance("SHA-256");
            digest.update(text.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest.digest());
        }catch(Exception impossible){throw error(500,"dataset_hash_failed","数据集版本指纹计算失败。");}
    }

    private static String scope(JsonObject p){
        String scope=Json.str(p,"annotationScope","labeled");
        if(!SCOPES.contains(scope))throw error(400,"dataset_scope_invalid","标注范围应为 labeled 或 confirmed。");
        return scope;
    }
    private static void keys(JsonObject p,String... allowed){
        Set<String> names=Set.of(allowed);
        for(String name:p.keySet())if(!names.contains(name))throw error(400,"dataset_parameter_unknown","不支持的数据集参数："+name);
    }
    private static String string(JsonObject p,String field,int max){
        JsonElement value=p.get(field);
        if(value==null||!value.isJsonPrimitive()||!value.getAsJsonPrimitive().isString())throw error(400,"dataset_parameter_missing","请填写数据集参数："+field);
        String text=value.getAsString().strip();
        if(text.isEmpty()||text.length()>max)throw error(400,"dataset_parameter_invalid","数据集参数为空或过长："+field);
        return text;
    }
    private static ApiError error(int status,String code,String message){return new ApiError(status,code,message);}
    @Override public void close(){builds.shutdownNow();}
}
