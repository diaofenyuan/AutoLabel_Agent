package cn.autolabel.engine;

import com.google.gson.*;
import java.awt.geom.Area;
import java.awt.geom.Rectangle2D;
import java.awt.image.BufferedImage;
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

    private final Store store;private final Projects projects;private final Exporter exporter;
    private final ExecutorService builds=Executors.newVirtualThreadPerTaskExecutor();
    private final Set<String> cancelled=ConcurrentHashMap.newKeySet();

    DatasetVersions(Store store,Projects projects,Exporter exporter){this.store=store;this.projects=projects;this.exporter=exporter;}

    // ===== 数据源解析 =====

    private static final class Source {
        String projectId,taskType,scope;JsonObject project;boolean classify;JsonObject transform=new JsonObject();
        Set<String> omit=Set.of();
        List<JsonObject> assets=new ArrayList<>(),excluded=new ArrayList<>();
        Map<String,Path> paths=new LinkedHashMap<>();
        JsonArray classes=new JsonArray(),keypointNames=new JsonArray();
        Map<String,Integer> classIndex=new LinkedHashMap<>();
    }

    /** 按素材标识顺序解析，保证同一输入多次解析得到完全相同的项序（I6 的前提）。 */
    private Source resolve(String projectId,String scope,JsonObject selection,JsonObject transform)throws Exception{
        projects.get(projectId);
        return store.read(c->{
            Source s=new Source();s.projectId=projectId;s.scope=scope;s.transform=transform;
            s.project=Store.document(c,"projects",projectId);
            s.taskType=Json.required(s.project,"taskType");s.classify=s.taskType.equals("classify");
            for(JsonElement e:Json.array(s.project,"classes"))s.classes.add(e.getAsJsonObject());
            s.keypointNames=Json.array(Json.object(s.project,"settings"),"keypointNames").deepCopy();
            if(DatasetTransforms.enabled(transform)){
                s.classes=DatasetTransforms.effectiveClasses(s.classes,Json.object(transform,"remap"));
                Set<String> omit=new LinkedHashSet<>();
                for(JsonElement e:Json.array(Json.object(transform,"remap"),"omit"))omit.add(e.getAsString());
                s.omit=omit;
            }
            for(int i=0;i<s.classes.size();i++)s.classIndex.put(Json.required(s.classes.get(i).getAsJsonObject(),"id"),i);
            DatasetSelection.Context context=DatasetSelection.context(c,projectId);
            List<JsonObject> candidates=new ArrayList<>();List<Path> paths=new ArrayList<>();
            for(JsonObject row:Store.rows(c,"SELECT id,data,path FROM assets WHERE project_id=? ORDER BY id",projectId)){
                JsonObject asset=Json.parse(Json.required(row,"data"));
                String state=Json.str(asset,"status","");
                // 未纳入范围的素材同样参与解析：它们构成「遗漏范围」，只是不进入版本内容。
                if(scope.equals("confirmed")?!state.equals("confirmed"):!LABELED.contains(state)){
                    s.excluded.add(Json.obj("asset",asset,"reasonCode",scope.equals("confirmed")?DatasetSelection.SCOPE_CONFIRMED:DatasetSelection.SCOPE));continue;
                }
                candidates.add(asset);paths.add(Path.of(Json.required(row,"path")));
            }
            Map<String,String> groups=Exporter.groups(candidates);
            Map<String,DatasetSelection.Decision> decisions=DatasetSelection.judge(candidates,selection,groups,context);
            for(int i=0;i<candidates.size();i++){
                JsonObject asset=candidates.get(i);String id=Json.required(asset,"id");
                DatasetSelection.Decision decision=decisions.get(id);
                if(!decision.included()){s.excluded.add(Json.obj("asset",asset,"reasonCode",decision.reasonCode()));continue;}
                s.assets.add(asset);s.paths.put(id,paths.get(i));
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
        keys(p,"projectId","annotationScope","selection","seed","transform","split");
        String scope=scope(p);JsonObject selection=DatasetSelection.normalize(Json.object(p,"selection"));
        JsonObject transform=DatasetTransforms.normalize(Json.object(p,"transform"));
        JsonObject splitRecipe=DatasetSplitting.normalize(Json.object(p,"split"));
        String projectId=string(p,"projectId",128),seed=p.has("seed")?string(p,"seed",256):"preview";
        Source s=resolve(projectId,scope,selection,transform);
        JsonObject inspection=inspect(s);
        long blocking=blocking(Json.array(inspection,"issues"));
        JsonObject reasons=reasonCounts(s);
        JsonObject preview=transformPreview(transform,s,splitRecipe,seed);
        if(flipNeedsSymmetry(s)){
            Json.array(inspection,"issues").add(Json.obj("annotationId",null,"severity","error","code","dataset_augment_flip_requires_symmetry",
                "field","augment.flip","message","姿态任务的翻转增强需要先在项目设置中定义关键点对称映射。"));
            blocking++;
        }
        validateExplicit(s,splitRecipe);
        blocking+=leakIssues(s,splitRecipe,seed,Json.array(inspection,"issues"));
        if(Json.number(preview,"estimatedItems",0)+s.excluded.size()>MAX_ITEMS){
            Json.array(inspection,"issues").add(Json.obj("annotationId",null,"severity","error","code","dataset_too_large",
                "field","transform","message","按当前转换估算的版本项数超过上限，请减小平铺规模或先过滤素材。"));
            blocking++;
        }
        return Json.obj("projectId",s.projectId,"taskType",s.taskType,"annotationScope",scope,
            "assets",s.assets.size(),"excluded",s.excluded.size(),"groups",distinctGroups(s),
            "classes",classTable(s),"keypointNames",s.keypointNames.deepCopy(),"selection",selection,"transform",transform,"split",splitRecipe,
            "excludedByReason",reasons,"excludedTotal",total(reasons),
            "sampling",samplingPreview(selection,s,seed),"transformPreview",preview,
            "splitPreview",splitPreview(splitRecipe,s,seed),
            "inspection",inspection,"blocking",blocking,"canBuild",blocking==0);
    }

    /** 划分预览：按预览种子走一遍分配，给出各划分组数、实际比例与未达标说明（E-6）。 */
    private static JsonObject splitPreview(JsonObject splitRecipe,Source s,String seed){
        Map<String,String> groups=Exporter.groups(s.assets);
        double[] ratio=DatasetSplitting.ratios(splitRecipe);
        List<String> order=DatasetSplitting.orderedGroups(groups,seed,DatasetSplitting.algorithm(splitRecipe));
        Map<String,String> splits=DatasetSplitting.assignGroups(order,ratio,Json.object(splitRecipe,"explicit"),groups,seed,DatasetSplitting.algorithm(splitRecipe));
        long[] actual=new long[3];
        for(String group:new HashSet<>(splits.values())){}
        for(String group:splits.values()){
            int index=group.equals("train")?0:group.equals("val")?1:2;actual[index]++;
        }
        int[] target=DatasetSplitting.targetCounts(order.size(),ratio);
        JsonArray unmet=new JsonArray();
        for(int i=0;i<3;i++)if(actual[i]!=target[i]){
            String split=i==0?"train":i==1?"val":"test";
            unmet.add(Json.obj("split",split,"targetGroups",target[i],"actualGroups",actual[i],
                "reason","group_granularity"));
        }
        return Json.obj("rule",DatasetSplitting.RULE,"algorithm",DatasetSplitting.algorithm(splitRecipe),
            "groups",order.size(),"actualGroups",Json.obj("train",actual[0],"val",actual[1],"test",actual[2]),
            "targetGroups",Json.obj("train",target[0],"val",target[1],"test",target[2]),"unmet",unmet);
    }

    /** 显式清单校验：素材必须存在于当前标注范围（E-5），未知素材逐条报错。 */
    private static void validateExplicit(Source s,JsonObject splitRecipe){
        Set<String> known=new HashSet<>();
        for(JsonObject asset:s.assets)known.add(Json.required(asset,"id"));
        for(String assetId:Json.object(splitRecipe,"explicit").keySet())
            if(!known.contains(assetId))throw error(422,"dataset_split_unknown_asset","显式划分清单中的素材不在当前标注范围内："+assetId);
    }

    /**
     * 严格防泄漏（E-4）：近重复候选对跨划分即为泄漏。严格模式下作为阻断项返回 1；
     * 非严格模式降级为提示。近重复检查未完整覆盖时如实标注，不假装核验过。
     */
    private int leakIssues(Source s,JsonObject splitRecipe,String seed,JsonArray issues){
        Map<String,String> groups=Exporter.groups(s.assets);
        double[] ratio=DatasetSplitting.ratios(splitRecipe);
        List<String> order=DatasetSplitting.orderedGroups(groups,seed,DatasetSplitting.algorithm(splitRecipe));
        Map<String,String> splits=DatasetSplitting.assignGroups(order,ratio,Json.object(splitRecipe,"explicit"),groups,seed,DatasetSplitting.algorithm(splitRecipe));
        JsonObject screening=exporter.mediaJobs==null?null:exporter.mediaJobs.exportInspection(s.projectId,s.assets);
        if(screening==null||!Json.str(screening,"status","").equals("complete")){
            issues.add(Json.obj("annotationId",null,"severity","warning","code","screening_not_complete",
                "field","split.strict","message","近重复检查尚未完整覆盖，跨划分泄漏无法核验。"));
            return 0;
        }
        int leaks=0;
        for(JsonElement e:Json.array(screening,"nearPairs")){
            JsonObject pair=e.getAsJsonObject();
            String left=Json.str(pair,"leftAssetId",""),right=Json.str(pair,"rightAssetId","");
            String leftGroup=groups.get(left),rightGroup=groups.get(right);
            if(leftGroup==null||rightGroup==null||leftGroup.equals(rightGroup))continue;
            String leftSplit=splits.get(leftGroup),rightSplit=splits.get(rightGroup);
            if(leftSplit==null||rightSplit==null||leftSplit.equals(rightSplit))continue;
            leaks++;
            issues.add(Json.obj("annotationId",left,"severity",DatasetSplitting.strict(splitRecipe)?"error":"warning",
                "code","dataset_split_leak_detected","field","split","message","近重复候选跨划分："+leftSplit+" / "+rightSplit,
                "relatedAssetId",right));
        }
        return DatasetSplitting.strict(splitRecipe)?Math.min(leaks,1):0;
    }

    /** 转换预览：视图计划按「宽×高」去重计算，给出精确张数与按源字节的体积上界（标注为估算）。 */
    private static JsonObject transformPreview(JsonObject transform,Source s,JsonObject splitRecipe,String seed){
        if(!DatasetTransforms.enabled(transform))return Json.obj("enabled",false);
        JsonObject augment=Json.object(transform,"augment");int multiplier=Json.integer(augment,"multiplier",0);
        Map<String,Integer> grids=new LinkedHashMap<>();
        long views=0,bytes=0,trainViews=0;
        if(multiplier>0){
            Map<String,String> groups=Exporter.groups(s.assets);
            double[] ratio=DatasetSplitting.ratios(splitRecipe);
            List<String> order=DatasetSplitting.orderedGroups(groups,seed,DatasetSplitting.algorithm(splitRecipe));
            Map<String,String> splits=DatasetSplitting.assignGroups(order,ratio,Json.object(splitRecipe,"explicit"),groups,seed,DatasetSplitting.algorithm(splitRecipe));
            for(JsonObject asset:s.assets){
                String assetId=Json.required(asset,"id");
                if("train".equals(splits.get(groups.get(assetId))))trainViews+=grids.computeIfAbsent(
                    Json.integer(asset,"width",0)+"x"+Json.integer(asset,"height",0),
                    k->DatasetTransforms.plan(transform,asset).views().size());
            }
        }
        for(JsonObject asset:s.assets){
            String key=Json.integer(asset,"width",0)+"x"+Json.integer(asset,"height",0);
            Integer count=grids.get(key);
            if(count==null){count=DatasetTransforms.plan(transform,asset).views().size();grids.put(key,count);}
            views+=count;
            try{bytes+=Files.size(s.paths.get(Json.required(asset,"id")))*count;}
            catch(Exception unavailable){bytes+=1024L*1024*count;}
        }
        long variants=trainViews*(long)multiplier;
        return Json.obj("enabled",true,"recipe",transform.deepCopy(),"order","crop,tile,resize,grayscale",
            "views",views,"variants",variants,"estimatedItems",views+variants,
            "estimatedBytes",bytes+variants*(bytes/Math.max(1,views)),
            "note","平铺与缩放场景下张数为精确计划值、磁盘占用为按源文件推算的估算值；增强变体只作用于训练集。");
    }

    /** 姿态翻转的前置校验（D-3）：没有关键点对称映射时禁止启用翻转，给出原因而不是静默镜像。 */
    private static Map<String,String> poseSymmetry(JsonObject project){
        Map<String,String> result=new HashMap<>();
        for(JsonElement e:Json.array(Json.object(project,"settings"),"keypointSymmetry")){
            JsonArray pair=e.getAsJsonArray();
            if(pair.size()!=2)throw error(400,"dataset_symmetry_invalid","关键点对称映射必须成对给出。");
            result.put(pair.get(0).getAsString(),pair.get(1).getAsString());
            result.put(pair.get(1).getAsString(),pair.get(0).getAsString());
        }
        return result;
    }

    private static boolean flipNeedsSymmetry(Source s){
        String flip=Json.str(Json.object(s.transform,"augment"),"flip","none");
        return s.taskType.equals("pose")&&!flip.isEmpty()&&!flip.equals("none")&&poseSymmetry(s.project).isEmpty();
    }

    private static JsonObject reasonCounts(Source s){
        Map<String,Integer> reasons=new TreeMap<>();
        for(JsonObject entry:s.excluded)reasons.merge(Json.required(entry,"reasonCode"),1,Integer::sum);
        return DatasetSelection.summarize(reasons);
    }
    private static long total(JsonObject reasons){long sum=0;for(var entry:reasons.entrySet())sum+=entry.getValue().getAsLong();return sum;}

    /** 提交前的采样预估：按预览种子走一遍划分，给出会落入训练集的张数；磁盘占用留到生成时实测。 */
    private static JsonObject samplingPreview(JsonObject selection,Source s,String seed){
        JsonObject sampling=Json.object(selection,"sampling");
        Map<String,String> groups=Exporter.groups(s.assets);
        List<String> order=DatasetSplitting.orderedGroups(groups,seed,DatasetSplitting.ALGORITHM_SOURCE_GROUP);
        Map<String,String> splits=DatasetSplitting.assignGroups(order,DEFAULT_RATIO,new JsonObject(),groups,seed,DatasetSplitting.ALGORITHM_SOURCE_GROUP);
        long train=0;
        for(JsonObject asset:s.assets)if("train".equals(splits.get(groups.get(Json.required(asset,"id")))))train++;
        return Json.obj("mode",Json.str(sampling,"mode","none"),"nearDuplicate",Json.str(sampling,"nearDuplicate","off"),
            "quotas",Json.object(sampling,"quotas").deepCopy(),"previewSeed",seed,"trainCandidates",train,
            "note","采样只作用于训练集，验证集与测试集保持原始内容；张数按预览种子计算。");
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
        keys(p,"projectId","name","annotationScope","seed","selection","transform","split");
        String projectId=string(p,"projectId",128),scope=scope(p);
        String name=p.has("name")?string(p,"name",MAX_NAME):"";
        String seed=p.has("seed")&&Json.str(p,"seed","").strip().length()>0?string(p,"seed",256):Json.id();
        JsonObject selection=DatasetSelection.withSeed(DatasetSelection.normalize(Json.object(p,"selection")),seed);
        JsonObject transform=DatasetTransforms.normalize(Json.object(p,"transform"));
        JsonObject splitRecipe=DatasetSplitting.normalize(Json.object(p,"split"));
        Source s=resolve(projectId,scope,selection,transform);
        if(flipNeedsSymmetry(s))
            throw error(422,"dataset_augment_flip_requires_symmetry","姿态任务的翻转增强需要先在项目设置中定义关键点对称映射。");
        JsonObject inspection=inspect(s);
        if(blocking(Json.array(inspection,"issues"))>0)
            throw new ApiError(422,"dataset_version_blocked","数据集体检存在阻断问题，请先处理后重新生成版本。",inspection);
        if(s.assets.isEmpty())throw error(422,"dataset_version_empty","当前标注范围内没有可用素材，无法生成版本。");
        validateExplicit(s,splitRecipe);
        JsonObject recipe=recipe(scope,seed,selection,transform,splitRecipe);String recipeHash=hashText(recipe.toString());
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
        builds.execute(()->run(id,buildId,projectId,scope,recipe,recipeHash,seed,selection));
        return get(Json.obj("versionId",id));
    }

    private static JsonObject recipe(String scope,String seed,JsonObject selection,JsonObject transform,JsonObject splitRecipe){
        JsonObject split=splitRecipe.deepCopy();
        split.addProperty("rule",DatasetSplitting.RULE);
        split.addProperty("seed",seed);
        return Json.obj("annotationScope",scope,"selection",selection,"transform",transform,"split",split);
    }

    private void run(String versionId,String buildId,String projectId,String scope,JsonObject recipe,String recipeHash,String seed,JsonObject selection){
        Path temporary=null;
        try{
            JsonObject transform=Json.object(recipe,"transform");
            boolean transformed=DatasetTransforms.enabled(transform);
            String boundaries=Json.str(transform,"boundaries",DatasetTransforms.BOUNDARY_CLIP);
            JsonObject augment=Json.object(transform,"augment");int multiplier=Json.integer(augment,"multiplier",0);
            Source s=resolve(projectId,scope,selection,transform);
            Map<String,String> symmetry=poseSymmetry(s.project);
            JsonObject inspection=inspect(s);
            if(blocking(Json.array(inspection,"issues"))>0)
                throw new ApiError(422,"dataset_version_blocked","数据集体检存在阻断问题，版本生成已停止。",inspection);
            JsonObject splitRecipe=Json.object(recipe,"split");
            double[] ratio=DatasetSplitting.ratios(splitRecipe);
            String splitAlgorithm=DatasetSplitting.algorithm(splitRecipe);
            Map<String,String> groups=Exporter.groups(s.assets);
            List<String> order=DatasetSplitting.orderedGroups(groups,seed,splitAlgorithm);
            Map<String,String> splits=DatasetSplitting.assignGroups(order,ratio,Json.object(splitRecipe,"explicit"),groups,seed,splitAlgorithm);
            // 严格防泄漏（E-4）：近重复候选跨划分时阻断生成，非严格模式仅记录提示。
            JsonArray leakBuffer=new JsonArray();
            if(leakIssues(s,splitRecipe,seed,leakBuffer)>0)
                throw error(422,"dataset_split_leak_detected","严格防泄漏模式下存在跨划分的近重复候选，已停止生成。");
            // 采样只作用于训练集：验证集与测试集保持原始内容，跨版本指标才可比（I5）。
            DatasetSelection.Sampled sampled=sample(selection,s,groups,splits,projectId);
            Set<String> dropped=new HashSet<>();Map<String,JsonObject> byId=new HashMap<>();
            for(JsonObject item:sampled.dropped())dropped.add(Json.required(item,"assetId"));
            for(JsonObject asset:s.assets)byId.put(Json.required(asset,"id"),asset);
            // 视图计划按「宽×高」去重估算总量与体积上界；逐素材在复制阶段再展开完整计划。
            Map<String,Integer> grids=new LinkedHashMap<>();long viewTotal=0,variantTotal=0,expected=0;
            for(JsonObject asset:s.assets){
                String assetId=Json.required(asset,"id");
                long size=Files.size(s.paths.get(assetId));
                if(!transformed||dropped.contains(assetId)){if(!transformed)expected+=size;continue;}
                String split=splits.get(groups.get(assetId));if(split==null)split="train";
                String key=Json.integer(asset,"width",0)+"x"+Json.integer(asset,"height",0);
                Integer count=grids.get(key);
                if(count==null){count=DatasetTransforms.plan(transform,asset).views().size();grids.put(key,count);}
                viewTotal+=count;expected+=size*count;
                if(split.equals("train")&&multiplier>0){variantTotal+=count*(long)multiplier;expected+=size*count*multiplier;}
            }
            int total=(int)(s.excluded.size()+sampled.dropped().size()+viewTotal+variantTotal);
            progress(buildId,"scanning",0,total);
            progress(buildId,"splitting",0,total);
            Path base=versionsDirectory();Files.createDirectories(base);
            temporary=base.resolve(".autolabel-partial-"+versionId);Path target=base.resolve(versionId);
            Files.createDirectory(temporary);
            store.requireSpace(expected+128L*1024*1024);
            List<JsonObject> items=new ArrayList<>();JsonArray manifestItems=new JsonArray();
            Map<String,long[]> counters=new LinkedHashMap<>();for(String split:SPLITS)counters.put(split,new long[2]);
            long bytes=0,objects=0;int position=0,processed=0,rejectedViews=0;
            // 被排除项先入库：它们决定「遗漏范围」，position 是稳定项序。
            for(JsonObject entry:s.excluded){items.add(excludedItem(Json.object(entry,"asset"),++position,Json.required(entry,"reasonCode")));processed++;}
            for(JsonObject item:sampled.dropped()){items.add(excludedItem(byId.get(Json.required(item,"assetId")),++position,
                Json.str(item,"reasonCode",DatasetSelection.SAMPLED)));processed++;}
            for(JsonObject asset:s.assets){
                if(cancelled.contains(buildId))throw error(409,"dataset_version_cancelled","版本生成已取消。");
                String assetId=Json.required(asset,"id"),contentHash=Json.required(asset,"contentHash");
                if(dropped.contains(assetId))continue;
                String split=splits.get(groups.get(assetId));if(split==null)split="train";
                Path source=s.paths.get(assetId);
                if(!transformed){
                    Path copy=temporary.resolve(imagePath(s,asset,split,assetId,source,null));
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
                    if(++processed%32==0)progress(buildId,"copying",processed,total);
                    continue;
                }
                // 转换路径：先做类别省略与跨片判定的整体过滤，再逐视图渲染与标注重建。
                if(!Media.hash(source).equals(contentHash))throw error(409,"dataset_source_changed","基准图片内容在生成期间被改变，版本生成已停止。");
                BufferedImage baselineImage=DatasetTransforms.decode(source,Json.integer(asset,"width",0),Json.integer(asset,"height",0));
                JsonArray annotations=new JsonArray();int omitted=0;
                for(JsonElement e:Json.array(asset,"annotations")){
                    JsonObject annotation=e.getAsJsonObject();
                    if(s.omit.contains(Json.str(annotation,"classId","")))omitted++;else annotations.add(annotation.deepCopy());
                }
                Set<String> crossSkipped=Set.of();int crossCount=0;
                if(transform.has("tile")&&Json.str(transform,"crossTile",DatasetTransforms.CROSS_CLIP).equals(DatasetTransforms.CROSS_SKIP)&&!annotations.isEmpty()){
                    DatasetTransforms.Plan crossPlan=DatasetTransforms.plan(transform,asset);
                    crossSkipped=crossTileObjects(crossPlan,annotations);crossCount=crossSkipped.size();
                }
                JsonArray effective=new JsonArray();
                for(JsonElement e:annotations)if(!crossSkipped.contains(Json.required(e.getAsJsonObject(),"id")))effective.add(e.getAsJsonObject());
                DatasetTransforms.Plan plan=DatasetTransforms.plan(transform,asset);
                JsonArray views=plan.views();int viewCount=views.size(),viewIndex=0;
                for(JsonElement v:views){
                    JsonObject view=v.getAsJsonObject();String viewId=Json.required(view,"viewId");
                    DatasetTransforms.Rebuild rebuild=DatasetTransforms.forward(plan.geometry(),viewId,s.project,effective,boundaries);
                    if(rebuild.rejected()){
                        JsonObject rejected=Json.obj("position",++position,"assetId",assetId,"viewId",viewId,"outcome","filtered_out",
                            "split",split,"sourceGroup",groups.get(assetId),"reasonCode","transform_boundary_rejected",
                            "viewIndex",viewIndex,"viewCount",viewCount,"name",Json.str(asset,"name",assetId));
                        items.add(rejected);processed++;rejectedViews++;continue;
                    }
                    BufferedImage rendered=DatasetTransforms.render(baselineImage,transform,view);
                    Path copy=temporary.resolve(imagePath(s,asset,split,assetId,source,viewId));
                    DatasetTransforms.writePng(rendered,copy);
                    String image=relative(temporary,copy),viewHash=Media.hash(copy),label=null,labelHash=null;bytes+=Files.size(copy);
                    int width=Json.integer(view,"width",rendered.getWidth()),height=Json.integer(view,"height",rendered.getHeight());
                    if(!s.classify){
                        JsonObject pseudo=Json.obj("width",width,"height",height,"annotations",rebuild.annotations());
                        String text=ExportWriters.yolo(pseudo,s.taskType,s.classIndex,PRECISION);
                        Path labelFile=temporary.resolve("labels").resolve(split).resolve(assetId+"_"+viewId+".txt");
                        Files.createDirectories(labelFile.getParent());Files.writeString(labelFile,text,StandardCharsets.UTF_8);
                        label=relative(temporary,labelFile);labelHash=Media.hash(labelFile);bytes+=Files.size(labelFile);
                    }
                    int count=rebuild.annotations().size();objects+=count;
                    long[] counter=counters.get(split);counter[0]++;counter[1]+=count;
                    JsonObject item=Json.obj("position",++position,"assetId",assetId,"viewId",viewId,"viewIndex",viewIndex,"viewCount",viewCount,
                        "outcome","included","split",split,"sourceGroup",groups.get(assetId),"image",image,"contentHash",viewHash,
                        "width",width,"height",height,"objects",count,"annotationVersion",Json.integer(asset,"version",0),
                        "name",Json.str(asset,"name",assetId),"bytes",Files.size(copy));
                    if(omitted>0)item.addProperty("omittedObjects",omitted);
                    if(crossCount>0)item.addProperty("crossTileSkipped",crossCount);
                    if(!rebuild.issues().isEmpty()){
                        JsonArray issueRecords=new JsonArray();
                        for(var entry:rebuild.issues().entrySet())issueRecords.add(Json.obj("code",entry.getKey(),"count",entry.getValue()));
                        item.add("issues",issueRecords);
                    }
                    if(s.classify&&!rebuild.annotations().isEmpty()){
                        String classId=Json.required(rebuild.annotations().get(0).getAsJsonObject(),"classId");
                        item.addProperty("classId",classId);item.addProperty("className",className(s,classId));
                    }
                    if(label!=null){item.addProperty("label",label);item.addProperty("labelHash",labelHash);}
                    items.add(item);manifestItems.add(item);
                    viewIndex++;
                    if(++processed%32==0)progress(buildId,"copying",processed,total);
                    // 增强（阶段 D）：只对训练集视图生成变体；变体继承视图划分并逐项记录（I5、D-5）。
                    if(split.equals("train")&&multiplier>0){
                        for(int variantIndex=1;variantIndex<=multiplier;variantIndex++){
                            if(cancelled.contains(buildId))throw error(409,"dataset_version_cancelled","版本生成已取消。");
                            String variantId=viewId+"-aug"+variantIndex;
                            JsonObject params=DatasetTransforms.variantParams(augment,seed,assetId+"|"+viewId,variantIndex);
                            BufferedImage variantImage=DatasetTransforms.renderVariant(rendered,params);
                            Path variantFile=temporary.resolve(imagePath(s,asset,split,assetId,source,variantId));
                            DatasetTransforms.writePng(variantImage,variantFile);
                            String variantHash=Media.hash(variantFile);bytes+=Files.size(variantFile);
                            JsonArray variantAnnotations=new JsonArray();int cutoutDropped=0,geometryDropped=0;
                            for(JsonElement ae:rebuild.annotations()){
                                JsonObject mapped=DatasetTransforms.mapVariantAnnotation(ae.getAsJsonObject(),params,width,height,symmetry);
                                if(Json.bool(params,"cutout",false)&&DatasetTransforms.cutoutCoverage(mapped,params,width,height)>=DatasetTransforms.CUTOUT_COVERAGE_PERCENT/100.0){
                                    cutoutDropped++;continue;
                                }
                                try{variantAnnotations.addAll(Annotations.validate(Json.arr(mapped),Json.obj("width",width,"height",height),s.project));}
                                catch(ApiError invalidGeometry){geometryDropped++;}
                            }
                            String variantLabel=null,variantLabelHash=null;
                            if(!s.classify){
                                String text=ExportWriters.yolo(Json.obj("width",width,"height",height,"annotations",variantAnnotations),s.taskType,s.classIndex,PRECISION);
                                Path labelFile=temporary.resolve("labels").resolve(split).resolve(assetId+"_"+variantId+".txt");
                                Files.createDirectories(labelFile.getParent());Files.writeString(labelFile,text,StandardCharsets.UTF_8);
                                variantLabel=relative(temporary,labelFile);variantLabelHash=Media.hash(labelFile);bytes+=Files.size(labelFile);
                            }
                            int variantObjects=variantAnnotations.size();objects+=variantObjects;
                            long[] variantCounter=counters.get(split);variantCounter[0]++;variantCounter[1]+=variantObjects;
                            JsonObject variant=Json.obj("position",++position,"assetId",assetId,"viewId",variantId,"variantIndex",variantIndex,
                                "parentViewId",viewId,"outcome","variant","split",split,"sourceGroup",groups.get(assetId),
                                "image",relative(temporary,variantFile),"contentHash",variantHash,"width",width,"height",height,
                                "objects",variantObjects,"annotationVersion",Json.integer(asset,"version",0),
                                "name",Json.str(asset,"name",assetId),"bytes",Files.size(variantFile),"augment",params.deepCopy());
                            if(cutoutDropped>0)variant.addProperty("cutoutDropped",cutoutDropped);
                            if(geometryDropped>0)variant.addProperty("geometryDropped",geometryDropped);
                            if(omitted>0)variant.addProperty("omittedObjects",omitted);
                            if(variantLabel!=null){variant.addProperty("label",variantLabel);variant.addProperty("labelHash",variantLabelHash);}
                            items.add(variant);manifestItems.add(variant);
                            if(++processed%32==0)progress(buildId,"copying",processed,total);
                        }
                    }
                }
            }
            progress(buildId,"copying",processed,total);
            JsonArray auxiliary=new JsonArray();
            if(!s.classify){
                Path yaml=temporary.resolve("data.yaml");Files.writeString(yaml,yamlText(s),StandardCharsets.UTF_8);
                auxiliary.add(Json.obj("path","data.yaml","hash",Media.hash(yaml)));
            }
            JsonObject manifest=manifest(versionId,s,recipe,recipeHash,manifestItems,items,order.size(),inspection,auxiliary,objects,bytes,counters,sampled.report(),
                transformSection(transform,transformed,viewTotal,variantTotal,rejectedViews),
                splitReport(splitRecipe,order,splits,items,counters));
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
                    +"data=json_set(data,'$.status','ready','$.completedAt',?,'$.summary',json(?),'$.split',json(?),'$.selection',json(?),'$.transform',json(?),'$.inspection',json(?)) WHERE id=?",
                    contentHash,manifestHash,now,now,manifest.get("summary").toString(),manifest.get("split").toString(),
                    manifest.get("selection").toString(),manifest.get("transform").toString(),inspection.toString(),versionId);
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

    /**
     * 采样输入只包含训练集项：调用方已按来源组确定划分，采样只在训练集内部抽取子集。
     * 近重复折叠复用既有素材筛选结果，缺少分析就如实报告「未分析」，不假装折叠过。
     */
    private DatasetSelection.Sampled sample(JsonObject selection,Source s,Map<String,String> groups,Map<String,String> splits,String projectId){
        JsonObject sampling=Json.object(selection,"sampling");
        List<JsonObject> train=new ArrayList<>();
        for(JsonObject asset:s.assets){
            String id=Json.required(asset,"id");
            if(!"train".equals(splits.get(groups.get(id))))continue;
            JsonArray classes=new JsonArray();
            for(JsonElement e:Json.array(asset,"annotations"))classes.add(Json.required(e.getAsJsonObject(),"classId"));
            JsonObject item=Json.obj("assetId",id,"contentHash",Json.str(asset,"contentHash",""),"status",Json.str(asset,"status",""),
                "objects",Json.array(asset,"annotations").size(),"sourceGroup",groups.get(id),"classIds",classes);
            if(s.classify&&!classes.isEmpty())item.addProperty("classId",classes.get(0).getAsString());
            train.add(item);
        }
        JsonArray pairs=new JsonArray();String status="off";
        if(Json.str(sampling,"nearDuplicate","off").equals("fold")){
            JsonObject screening=exporter.mediaJobs==null?null:exporter.mediaJobs.exportInspection(projectId,s.assets);
            if(screening==null)status="not_analyzed";
            else{status=Json.str(screening,"status","not_analyzed");pairs=Json.array(screening,"nearPairs");}
        }
        return DatasetSelection.sample(selection,train,pairs,status);
    }

    private static JsonObject excludedItem(JsonObject asset,int position,String reason){
        return Json.obj("position",position,"assetId",Json.required(asset,"id"),"outcome","filtered_out","split","none",
            "reasonCode",reason,"status",Json.str(asset,"status",""),"name",Json.str(asset,"name",Json.required(asset,"id")));
    }

    private static String imagePath(Source s,JsonObject asset,String split,String assetId,Path source,String viewId){
        // 转换路径全部重编码为 PNG；未转换路径沿用基准图扩展名（导入已统一为 PNG）。
        String extension=viewId!=null?"png":TrainingDatasets.suffix(source.getFileName().toString());
        if(extension.isEmpty())extension="png";
        String folder="";
        if(s.classify){
            JsonArray annotations=Json.array(asset,"annotations");
            // 分类目录用类别标识而不是展示名：目录名必须唯一且不受重命名影响。
            folder=annotations.isEmpty()?"unlabeled":Json.required(annotations.get(0).getAsJsonObject(),"classId");
        }
        String base=viewId==null?assetId:assetId+"_"+viewId;
        return "images/"+split+"/"+(folder.isEmpty()?"":folder+"/")+base+"."+extension;
    }

    /** 确定性排序已迁移到 DatasetSplitting.orderedGroups；此处仅保留清单与报告的组装。 */

    /** 划分报告（E-6）：目标与实际组数、原图/变体两套口径、未达标说明，全部写入清单。 */
    private static JsonObject splitReport(JsonObject splitRecipe,List<String> order,Map<String,String> splits,
            List<JsonObject> items,Map<String,long[]> counters){
        double[] ratio=DatasetSplitting.ratios(splitRecipe);
        int[] target=DatasetSplitting.targetCounts(order.size(),ratio);
        long[] actualGroups=new long[3];
        for(String split:splits.values()){
            if(split.equals("train"))actualGroups[0]++;
            else if(split.equals("val"))actualGroups[1]++;
            else actualGroups[2]++;
        }
        long[][] byOutcome=new long[3][2];
        for(JsonObject item:items){
            String outcome=Json.str(item,"outcome","");
            if(!outcome.equals("included")&&!outcome.equals("variant"))continue;
            String split=Json.required(item,"split");
            byOutcome[split.equals("train")?0:split.equals("val")?1:2][outcome.equals("variant")?1:0]++;
        }
        JsonArray actual=new JsonArray();
        JsonArray unmet=new JsonArray();
        String[] names={"train","val","test"};
        for(int i=0;i<3;i++){
            actual.add(Json.obj("split",names[i],"originals",byOutcome[i][0],"variants",byOutcome[i][1],
                "images",byOutcome[i][0]+byOutcome[i][1],"objects",counters.get(names[i])[1]));
            if(actualGroups[i]!=target[i])unmet.add(Json.obj("split",names[i],"targetGroups",target[i],
                "actualGroups",actualGroups[i],"reason","group_granularity"));
        }
        return Json.obj("rule",DatasetSplitting.RULE,"algorithm",DatasetSplitting.algorithm(splitRecipe),
            "strict",DatasetSplitting.strict(splitRecipe),
            "ratios",Json.obj("train",ratio[0],"val",ratio[1],"test",ratio[2]),
            "seed",Json.str(splitRecipe,"seed",""),
            "explicit",Json.object(splitRecipe,"explicit").size(),
            "groups",order.size(),
            "targetGroups",Json.obj("train",target[0],"val",target[1],"test",target[2]),
            "actualGroups",Json.obj("train",actualGroups[0],"val",actualGroups[1],"test",actualGroups[2]),
            "unmet",unmet,"actual",actual);
    }

    private static JsonObject manifest(String versionId,Source s,JsonObject recipe,String recipeHash,JsonArray manifestItems,
            List<JsonObject> items,int groups,JsonObject inspection,JsonArray auxiliary,long objects,long bytes,Map<String,long[]> counters,
            JsonObject samplingReport,JsonObject transformSection,JsonObject splitReport){
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
            "selection",Json.obj("annotationScope",s.scope,"filters",Json.object(Json.object(recipe,"selection"),"filters"),
                "excluded",excluded,"excludedByReason",Json.GSON.toJsonTree(reasons),"sampling",samplingReport),
            "transform",transformSection,
            "split",splitReport,
            "summary",Json.obj("images",manifestItems.size(),"excluded",excluded,"objects",objects,"bytes",bytes,"groups",groups,
                "issues",issues,"errors",errors,"warnings",issues-errors),
            "inspection",inspection,"items",copy,"auxiliaryFiles",auxiliary);
    }

    /** 清单的转换段：配方与顺序原样固定，生成过程只读原始素材（autoOrient 在导入时已生效）。 */
    private static JsonObject transformSection(JsonObject transform,boolean transformed,long viewTotal,long variantTotal,int rejectedViews){
        JsonObject section=transform.deepCopy();
        section.addProperty("enabled",transformed);
        if(transformed){
            section.addProperty("order","crop,tile,resize,grayscale");
            section.addProperty("autoOrient","applied-at-import");
            section.addProperty("renderedViews",viewTotal);
            section.addProperty("renderedVariants",variantTotal);
            if(rejectedViews>0)section.addProperty("rejectedViews",rejectedViews);
        }
        return section;
    }

    /** 跨片判定：对象区域与多个瓦片覆盖范围相交即视为跨片对象（skip 策略下从所有瓦片剔除并计数）。 */
    private static Set<String> crossTileObjects(DatasetTransforms.Plan plan,JsonArray annotations){
        List<Area> coverages=new ArrayList<>();
        for(JsonElement v:plan.views()){
            JsonObject coverage=Json.object(v.getAsJsonObject(),"baselineCoverageRect");
            coverages.add(new Area(new Rectangle2D.Double(Json.decimal(coverage,"x",0),Json.decimal(coverage,"y",0),
                Json.decimal(coverage,"width",0),Json.decimal(coverage,"height",0))));
        }
        Set<String> result=new LinkedHashSet<>();
        for(JsonElement e:annotations){
            JsonObject annotation=e.getAsJsonObject();Area shape;
            if(Json.str(annotation,"type","").equals("detect")||Json.str(annotation,"type","").equals("pose")){
                JsonObject box=Json.object(annotation,"bbox");
                shape=new Area(new Rectangle2D.Double(Json.decimal(box,"x",0),Json.decimal(box,"y",0),
                    Json.decimal(box,"width",0),Json.decimal(box,"height",0)));
            }else shape=RegionGeometry.region(annotation).shape();
            int hits=0;
            for(Area coverage:coverages){
                Area part=(Area)shape.clone();part.intersect(coverage);
                if(!part.isEmpty()&&++hits>1){result.add(Json.required(annotation,"id"));break;}
            }
        }
        return result;
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
            "recipe","recipeHash","contentHash","manifestHash","classes","keypointNames","summary","split","selection","transform","createdAt","completedAt","failure"))
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
                if(other==null){removed.add(itemRef(entry.getValue()));continue;}
                JsonArray fields=new JsonArray();
                for(String field:List.of("contentHash","labelHash","split","sourceGroup","objects"))
                    if(!Objects.equals(entry.getValue().get(field),other.get(field)))fields.add(field);
                if(fields.isEmpty())unchanged++;else changed.add(itemRef(entry.getValue()));
            }
            for(var entry:second.entrySet())if(!first.containsKey(entry.getKey()))added.add(itemRef(entry.getValue()));
            return Json.obj("versionId",left,"otherVersionId",right,"added",added,"removed",removed,"changed",changed,"unchanged",unchanged,
                "classesChanged",!Json.array(a,"classes").equals(Json.array(b,"classes"))||!Json.array(a,"keypointNames").equals(Json.array(b,"keypointNames")),
                "recipeChanged",!Objects.equals(Json.object(a,"recipe"),Json.object(b,"recipe")));
        });
    }

    /** 平铺使一个素材对应多个视图项：对比键为「素材标识+视图标识」。 */
    private static JsonObject itemRef(JsonObject item){
        JsonObject ref=Json.obj("assetId",Json.required(item,"assetId"));
        if(item.has("viewId"))ref.add("viewId",item.get("viewId"));
        return ref;
    }

    private static Map<String,JsonObject> included(Connection c,String versionId)throws Exception{
        Map<String,JsonObject> result=new LinkedHashMap<>();
        for(JsonObject row:Store.rows(c,"SELECT data FROM dataset_version_items WHERE version_id=? AND outcome IN ('included','variant') ORDER BY position",versionId)){
            JsonObject item=Json.parse(Json.required(row,"data"));
            result.put(Json.str(item,"assetId","-")+"|"+Json.str(item,"viewId","-"),item);
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
            String outcome=Json.str(item,"outcome","");
            if(!outcome.equals("included")&&!outcome.equals("variant"))continue;
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

    /** 诊断摘要（F-5）：只含状态计数，不含项目内容与路径。 */
    JsonObject diagnostics(){
        return store.read(c->{
            long building=0,ready=0,failed=0;
            for(JsonObject row:Store.rows(c,"SELECT status,COUNT(*) AS n FROM dataset_versions GROUP BY status")){
                long count=Json.number(row,"n",0);
                switch(Json.str(row,"status","")){
                    case "building"->building=count;
                    case "ready"->ready=count;
                    case "failed","cancelled"->failed+=count;
                    default->{}
                }
            }
            return Json.obj("building",building,"ready",ready,"failed",failed);
        });
    }

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
