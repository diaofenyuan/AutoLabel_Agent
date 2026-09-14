package cn.autolabel.engine;

import com.google.gson.*;
import java.sql.Connection;
import java.time.Instant;
import java.util.*;

/**
 * 选择模块（M3）：过滤与采样。
 *
 * 过滤决定「整张进入或整张排除」，作用于全部划分；采样只抽取训练集子集（I5 同源口径），
 * 二者共用「确定性谓词 + 逐项判定」机制，但报告分开：抽样导致的类别失衡不能被误报为数据本身失衡。
 * 判定只读素材与标注（I2），同一选择配方与种子必然得到同一判定与同一子集（I6）。
 *
 * 硬规则不可关闭：效果图与叠加框线图片、视频帧、衍生素材永不进入版本内容，
 * 它们与「缺标签文件不得当作合法无目标图」属同一类既有口径。
 */
final class DatasetSelection {
    static final String SCOPE="annotation_scope_excluded",SCOPE_CONFIRMED="annotation_scope_confirmed_only",
        FORM_VIDEO="form_video_frame",FORM_DERIVED="form_derived",FORM_OVERLAY="form_overlay_rendering",
        EXPLICIT="explicit_exclude",EMPTY_EXCLUDED="empty_label_excluded",EMPTY_LIMIT="empty_label_limit_exceeded",
        CLASS_EXCLUDED="class_excluded",CLASS_MISSING="class_not_included",SIZE="size_excluded",
        GROUP="source_group_excluded",TIME="time_excluded",SAMPLED="sampled_out",NEAR="near_duplicate_folded";
    private static final Set<String> EMPTY_POLICY=Set.of("keep","limit","exclude");
    private static final Set<String> MODES=Set.of("none","random","stratified");
    private static final Set<String> NEAR_MODES=Set.of("off","fold");
    private static final int MAX_IDS=10_000,MAX_LABELS=1_000,MAX_CLASSES=200,MAX_TEXT=200,MAX_SEED=256,MAX_ITEMS=200_000,MAX_SIDE=20_000;

    private DatasetSelection(){}

    /** 逐项判定结果：排除项必须带原因码，与体检问题码共用命名空间（A1）。 */
    record Decision(boolean included,String reasonCode){}
    /** 判定的只读上下文：导入时间与已渲染效果图指纹，一次构建多次使用。 */
    record Context(Map<String,String> importedAt,Set<String> renderedOverlays){}
    /** 采样结果：保留项、剔除项与报告；报告逐类给出可用、保留与未满足的配额。 */
    record Sampled(List<JsonObject> kept,List<JsonObject> dropped,JsonObject report){}

    // ===== 配方规范化 =====

    /** 只保留生效值：配方哈希必须覆盖全部实际判定条件，未生效字段不进入配方（I6）。 */
    static JsonObject normalize(JsonObject raw){
        keys(raw,"filters","sampling");
        JsonObject filters=Json.object(raw,"filters"),sampling=Json.object(raw,"sampling");
        keys(filters,"emptyLabel","emptyLabelLimit","includeClasses","excludeClasses","minWidth","maxWidth","minHeight","maxHeight",
            "minAspect","maxAspect","sourceGroups","importedAfter","importedBefore","explicitExclude");
        keys(sampling,"mode","ratio","count","seed","quotas","nearDuplicate");
        String empty=choice(filters,"emptyLabel","limit",EMPTY_POLICY),mode=choice(sampling,"mode","none",MODES),near=choice(sampling,"nearDuplicate","off",NEAR_MODES);
        Integer emptyLimit=whole(filters,"emptyLabelLimit",50,0,MAX_ITEMS);
        Double minWidth=decimal(filters,"minWidth",1,MAX_SIDE),maxWidth=decimal(filters,"maxWidth",1,MAX_SIDE);
        Double minHeight=decimal(filters,"minHeight",1,MAX_SIDE),maxHeight=decimal(filters,"maxHeight",1,MAX_SIDE);
        Double minAspect=decimal(filters,"minAspect",0.001,1000),maxAspect=decimal(filters,"maxAspect",0.001,1000);
        if(minWidth!=null&&maxWidth!=null&&minWidth>maxWidth)throw invalid("最小宽度不能大于最大宽度。");
        if(minHeight!=null&&maxHeight!=null&&minHeight>maxHeight)throw invalid("最小高度不能大于最大高度。");
        if(minAspect!=null&&maxAspect!=null&&minAspect>maxAspect)throw invalid("最小长宽比不能大于最大长宽比。");
        Double ratio=sampling.has("ratio")&&!sampling.get("ratio").isJsonNull()?Json.decimal(sampling,"ratio",0):null;
        if(ratio!=null&&!(ratio>0&&ratio<=1))throw invalid("采样比例必须大于 0 且不超过 1。");
        Integer count=sampling.has("count")&&!sampling.get("count").isJsonNull()?whole(sampling,"count",1,1,MAX_ITEMS):null;
        if(!mode.equals("none")&&ratio==null&&count==null)throw invalid("采样需要给出比例或条数。");
        JsonObject quotas=quotas(Json.object(sampling,"quotas"));
        JsonObject result=Json.obj("filters",Json.obj("emptyLabel",empty,"emptyLabelLimit",emptyLimit,
            "includeClasses",ids(filters,"includeClasses",MAX_CLASSES),"excludeClasses",ids(filters,"excludeClasses",MAX_CLASSES),
            "minWidth",minWidth,"maxWidth",maxWidth,"minHeight",minHeight,"maxHeight",maxHeight,"minAspect",minAspect,"maxAspect",maxAspect,
            "sourceGroups",ids(filters,"sourceGroups",MAX_LABELS),
            "importedAfter",moment(filters,"importedAfter"),"importedBefore",moment(filters,"importedBefore"),
            "explicitExclude",ids(filters,"explicitExclude",MAX_IDS)),
            "sampling",Json.obj("mode",mode,"ratio",ratio,"count",count,"seed",text(sampling,"seed",MAX_SEED),
            "quotas",quotas,"nearDuplicate",near));
        return result;
    }

    /** 采样种子留空时跟随版本种子，保证「同源 + 同配方 + 同种子」得到同一子集。 */
    static JsonObject withSeed(JsonObject selection,String seed){
        JsonObject sampling=Json.object(selection,"sampling");
        if(Json.str(sampling,"seed","").isBlank())sampling.addProperty("seed",seed);
        return selection;
    }

    // ===== 过滤 =====

    /**
     * 逐项判定：先应用不可关闭的硬规则，再按用户谓词判定；空标签限量在整批上统一处理，
     * 因此判定顺序必须稳定（调用方按素材标识排序传入）。
     */
    static Map<String,Decision> judge(List<JsonObject> assets,JsonObject selection,Map<String,String> groups,Context context){
        JsonObject filters=Json.object(selection,"filters");
        Set<String> include=values(filters,"includeClasses"),exclude=values(filters,"excludeClasses"),
            explicit=values(filters,"explicitExclude"),sourceGroups=values(filters,"sourceGroups");
        Double minWidth=decimal(filters,"minWidth"),maxWidth=decimal(filters,"maxWidth"),minHeight=decimal(filters,"minHeight"),
            maxHeight=decimal(filters,"maxHeight"),minAspect=decimal(filters,"minAspect"),maxAspect=decimal(filters,"maxAspect");
        Instant after=instant(filters,"importedAfter"),before=instant(filters,"importedBefore");
        String policy=Json.str(filters,"emptyLabel","keep");
        int limit=(int)Json.number(filters,"emptyLabelLimit",MAX_ITEMS);
        Map<String,Decision> result=new LinkedHashMap<>();int empties=0;
        for(JsonObject asset:assets){
            String id=Json.required(asset,"id"),reason=form(asset,context);
            if(reason==null&&explicit.contains(id))reason=EXPLICIT;
            if(reason==null&&!include.isEmpty()&&Collections.disjoint(include,classes(asset)))reason=CLASS_MISSING;
            if(reason==null&&!exclude.isEmpty()&&!Collections.disjoint(exclude,classes(asset)))reason=CLASS_EXCLUDED;
            if(reason==null&&outsideSize(asset,minWidth,maxWidth,minHeight,maxHeight,minAspect,maxAspect))reason=SIZE;
            if(reason==null&&!sourceGroups.isEmpty()&&!sourceGroups.contains(groups.get(id)))reason=GROUP;
            if(reason==null&&!within(context.importedAt().get(id),after,before))reason=TIME;
            if(reason==null&&Json.array(asset,"annotations").isEmpty()){
                // 空标签是合法负样本：默认保留但限量，超限部分显式记录而不是静默丢弃。
                if(policy.equals("exclude"))reason=EMPTY_EXCLUDED;
                else if(policy.equals("limit")&&empties>=limit)reason=EMPTY_LIMIT;
                else empties++;
            }
            result.put(id,new Decision(reason==null,reason));
        }
        return result;
    }

    /** 素材形态硬规则：判定依据是素材自身记录，不依赖用户开关。 */
    static String form(JsonObject asset,Context context){
        JsonObject metadata=Json.object(asset,"metadata");
        if(!Json.str(metadata,"sourceVideoId","").isBlank())return FORM_VIDEO;
        for(String key:List.of("rootAssetId","parentAssetId","inputSnapshot","derivedFrom"))
            if(metadata.has(key)&&!metadata.get(key).isJsonNull())return FORM_DERIVED;
        String sourceHash=Json.str(metadata,"sourceHash","");
        // 效果图按其渲染时的实际文件指纹识别：同一张叠加图被重复导入也仍然会被排除。
        return !sourceHash.isEmpty()&&context.renderedOverlays().contains(sourceHash)?FORM_OVERLAY:null;
    }

    private static boolean outsideSize(JsonObject asset,Double minWidth,Double maxWidth,Double minHeight,Double maxHeight,Double minAspect,Double maxAspect){
        double width=Json.integer(asset,"width",0),height=Json.integer(asset,"height",0);
        if(width<1||height<1)return true;
        if(minWidth!=null&&width<minWidth)return true;
        if(maxWidth!=null&&width>maxWidth)return true;
        if(minHeight!=null&&height<minHeight)return true;
        if(maxHeight!=null&&height>maxHeight)return true;
        double aspect=width/height;
        if(minAspect!=null&&aspect<minAspect)return true;
        return maxAspect!=null&&aspect>maxAspect;
    }

    private static boolean within(String importedAt,Instant after,Instant before){
        if(after==null&&before==null)return true;
        if(importedAt==null||importedAt.isBlank())return false;
        try{
            Instant value=Instant.parse(importedAt);
            return (after==null||!value.isBefore(after))&&(before==null||!value.isAfter(before));
        }catch(Exception unparsable){return false;}
    }

    private static Set<String> classes(JsonObject asset){
        Set<String> result=new LinkedHashSet<>();
        for(JsonElement e:Json.array(asset,"annotations")){
            JsonObject annotation=e.getAsJsonObject();
            String classId=Json.str(annotation,"classId","");
            if(!classId.isEmpty())result.add(classId);
        }
        return result;
    }

    /** 遗漏范围摘要：按原因码聚合，界面据此下钻到具体素材。 */
    static JsonObject summarize(Map<String,Integer> reasons){
        JsonObject result=new JsonObject();
        for(var entry:new TreeMap<>(reasons).entrySet())result.addProperty(entry.getKey(),entry.getValue());
        return result;
    }

    // ===== 采样 =====

    /**
     * 采样只作用于训练集：验证集与测试集保持原始内容，跨版本指标才可比（I5）。
     * 顺序固定为「近重复折叠 → 目标条数（含配额下限）」，同一种子必然得到同一子集（I6）。
     */
    static Sampled sample(JsonObject selection,List<JsonObject> items,JsonArray nearPairs,String screeningStatus){
        JsonObject sampling=Json.object(selection,"sampling"),quotas=Json.object(sampling,"quotas");
        String mode=Json.str(sampling,"mode","none"),seed=Json.str(sampling,"seed","");
        List<JsonObject> kept=new ArrayList<>(items),dropped=new ArrayList<>();
        JsonObject near=fold(Json.str(sampling,"nearDuplicate","off"),kept,dropped,nearPairs==null?new JsonArray():nearPairs,screeningStatus,seed);
        JsonObject report=Json.obj("mode",mode,"seed",seed,"nearDuplicate",near,
            "ratio",sampling.has("ratio")&&!sampling.get("ratio").isJsonNull()?sampling.get("ratio"):null,
            "count",sampling.has("count")&&!sampling.get("count").isJsonNull()?sampling.get("count"):null,
            "note","采样只作用于训练集，验证集与测试集保持原始内容。");
        int available=kept.size();
        report.addProperty("available",available);
        if(!mode.equals("none")||!quotas.isEmpty()){
            int target=target(mode,available,sampling,quotas,kept);
            List<JsonObject> chosen=mode.equals("stratified")?stratified(kept,target,quotas,seed):random(kept,target,quotas,seed);
            Set<String> ids=new HashSet<>();for(JsonObject item:chosen)ids.add(Json.required(item,"assetId"));
            List<JsonObject> result=new ArrayList<>(),remain=new ArrayList<>();
            for(JsonObject item:kept)(ids.contains(Json.required(item,"assetId"))?result:remain).add(item);
            for(JsonObject item:remain){JsonObject drop=item.deepCopy();drop.addProperty("reasonCode",SAMPLED);dropped.add(drop);}
            kept=result;
            report.addProperty("target",target);
            // 配额是下限、比例是软目标：下限高于目标时如实标记，不假装两者一致。
            report.addProperty("quotaFloorRaised",kept.size()>target);
        }
        report.addProperty("kept",kept.size());report.addProperty("dropped",dropped.size());
        JsonObject counts=new JsonObject();JsonArray shortfall=new JsonArray();
        for(var entry:quotas.entrySet()){
            String classId=entry.getKey();int quota=entry.getValue().getAsInt(),held=0,seen=0;
            for(JsonObject item:items)if(primary(item).equals(classId))seen++;
            for(JsonObject item:kept)if(primary(item).equals(classId))held++;
            if(seen>0&&held<quota)shortfall.add(Json.obj("classId",classId,"quota",quota,"available",seen,"kept",held,
                "reason",held<Math.min(quota,seen)?"sampling_budget_exhausted":"class_missing"));
        }
        report.add("quotaShortfall",shortfall);report.add("classCounts",counts(items,kept));
        return new Sampled(kept,dropped,report);
    }

    /** 目标条数取「比例/条数」与「配额下限」的较大者，配额按实际可用张数封顶，避免目标虚高。 */
    private static int target(String mode,int available,JsonObject sampling,JsonObject quotas,List<JsonObject> items){
        int base=available;
        if(mode.equals("random")||mode.equals("stratified")){
            if(sampling.has("count")&&!sampling.get("count").isJsonNull())base=(int)Json.number(sampling,"count",1);
            else base=(int)Math.round(available*Json.decimal(sampling,"ratio",1));
        }
        base=Math.max(1,Math.min(base,available));
        long floors=0;
        for(var entry:quotas.entrySet()){
            long seen=0;for(JsonObject item:items)if(primary(item).equals(entry.getKey()))seen++;
            floors+=Math.min(entry.getValue().getAsLong(),seen);
        }
        return (int)Math.max(base,Math.min(floors,available));
    }

    /** 随机采样：顺序由种子与素材标识的哈希决定，不用可变随机源，保证同种子同结果。 */
    private static List<JsonObject> random(List<JsonObject> items,int target,JsonObject quotas,String seed){
        List<JsonObject> order=ordered(items,seed);Set<String> quota=quotaFirst(order,quotas);
        List<JsonObject> result=new ArrayList<>();
        for(JsonObject item:order)if(target>result.size()&&quota.contains(Json.required(item,"assetId")))result.add(item);
        for(JsonObject item:order)if(target>result.size()&&!quota.contains(Json.required(item,"assetId")))result.add(item);
        return result;
    }

    /** 分层采样：按主类别占比分配名额，先满足配额下限，再按类别顺序补齐剩余名额。 */
    private static List<JsonObject> stratified(List<JsonObject> items,int target,JsonObject quotas,String seed){
        Map<String,List<JsonObject>> byClass=new TreeMap<>();
        for(JsonObject item:items)byClass.computeIfAbsent(primary(item),k->new ArrayList<>()).add(item);
        Map<String,Integer> budget=new LinkedHashMap<>();
        List<String> order=new ArrayList<>(byClass.keySet());order.sort(Comparator.comparing(classId->DatasetVersions.hashText(seed+"|"+classId)));
        int allocated=0;
        for(String classId:order){
            int floor=quotas.has(classId)?Math.min(quotas.get(classId).getAsInt(),byClass.get(classId).size()):Math.min(1,byClass.get(classId).size());
            budget.put(classId,floor);allocated+=floor;
        }
        while(allocated<target){
            boolean advanced=false;
            for(String classId:order){
                if(allocated>=target)break;
                if(budget.get(classId)>=byClass.get(classId).size())continue;
                budget.merge(classId,1,Integer::sum);allocated++;advanced=true;
            }
            if(!advanced)break;
        }
        List<JsonObject> result=new ArrayList<>();
        for(String classId:order){
            List<JsonObject> pool=ordered(byClass.get(classId),seed);
            result.addAll(pool.subList(0,Math.min(budget.get(classId),pool.size())));
        }
        return result;
    }

    /** 近重复折叠：同簇只保留代表（优先人工确认、再目标数、最后标识），剔除项逐个记录原因码。 */
    private static JsonObject fold(String mode,List<JsonObject> items,List<JsonObject> dropped,JsonArray nearPairs,String screeningStatus,String seed){
        JsonObject report=Json.obj("mode",mode,"status",mode.equals("fold")?screeningStatus:"off","folded",0,"clusters",0,"crossGroupClusters",0);
        if(!mode.equals("fold"))return report;
        Map<String,String> parents=new HashMap<>();Set<String> known=new HashSet<>();for(JsonObject item:items){String id=Json.required(item,"assetId");parents.put(id,id);known.add(id);}
        Map<String,String> content=new HashMap<>();
        for(JsonObject item:items){
            String hash=Json.str(item,"contentHash","");if(hash.isEmpty())continue;
            String previous=content.putIfAbsent(hash,Json.required(item,"assetId"));
            if(previous!=null)union(parents,known,previous,Json.required(item,"assetId"));
        }
        for(JsonElement e:nearPairs){
            JsonObject pair=e.getAsJsonObject();String left=Json.str(pair,"leftAssetId",""),right=Json.str(pair,"rightAssetId","");
            if(known.contains(left)&&known.contains(right))union(parents,known,left,right);
        }
        Map<String,List<JsonObject>> clusters=new LinkedHashMap<>();
        for(JsonObject item:items)clusters.computeIfAbsent(find(parents,Json.required(item,"assetId")),k->new ArrayList<>()).add(item);
        int folded=0,groups=0,reduced=0;
        for(List<JsonObject> cluster:clusters.values()){
            if(cluster.size()<2)continue;
            List<JsonObject> order=new ArrayList<>(cluster);
            order.sort(Comparator.comparingInt((JsonObject item)->rank(Json.str(item,"status","")))
                .thenComparing(item->-Json.integer(item,"objects",0)).thenComparing(item->Json.required(item,"assetId")));
            Set<String> sources=new HashSet<>();for(JsonObject item:cluster)sources.add(Json.str(item,"sourceGroup","-"));
            if(sources.size()>1)groups++;
            reduced++;
            for(int i=1;i<order.size();i++){JsonObject drop=order.get(i).deepCopy();drop.addProperty("reasonCode",NEAR);dropped.add(drop);folded++;}
        }
        report.addProperty("folded",folded);report.addProperty("clusters",reduced);report.addProperty("crossGroupClusters",groups);
        report.addProperty("seed",seed);
        return report;
    }

    private static Set<String> quotaFirst(List<JsonObject> order,JsonObject quotas){
        Set<String> result=new HashSet<>();
        for(var entry:quotas.entrySet()){
            String classId=entry.getKey();int needed=entry.getValue().getAsInt(),held=0;
            for(JsonObject item:order){
                if(held>=needed)break;
                if(primary(item).equals(classId)){result.add(Json.required(item,"assetId"));held++;}
            }
        }
        return result;
    }

    private static JsonArray counts(List<JsonObject> items,List<JsonObject> kept){
        Map<String,int[]> values=new TreeMap<>();
        for(JsonObject item:items)values.computeIfAbsent(primary(item),k->new int[2])[0]++;
        for(JsonObject item:kept)values.computeIfAbsent(primary(item),k->new int[2])[1]++;
        JsonArray result=new JsonArray();
        for(var entry:values.entrySet())result.add(Json.obj("classId",entry.getKey(),"available",entry.getValue()[0],"kept",entry.getValue()[1]));
        return result;
    }

    /** 主类别：出现次数最多的标注类别，平票取类别标识较小者，保证分层结果可复现。 */
    private static String primary(JsonObject item){
        JsonArray classes=Json.array(item,"classIds");
        if(classes.isEmpty())return Json.str(item,"classId","unlabeled");
        Map<String,Integer> counts=new TreeMap<>();
        for(JsonElement e:classes)counts.merge(e.getAsString(),1,Integer::sum);
        return counts.entrySet().stream().max(Comparator.<Map.Entry<String,Integer>>comparingInt(Map.Entry::getValue)
            .thenComparing(entry->entry.getKey(),Comparator.reverseOrder())).map(Map.Entry::getKey).orElse("unlabeled");
    }

    private static List<JsonObject> ordered(List<JsonObject> items,String seed){
        List<JsonObject> order=new ArrayList<>(items);
        order.sort(Comparator.comparing(item->DatasetVersions.hashText(seed+"|"+Json.required(item,"assetId"))));
        return order;
    }

    private static int rank(String status){return switch(status){case "confirmed"->0;case "modified"->1;case "candidate"->2;default->3;};}
    private static String find(Map<String,String> parents,String id){String root=id;while(!parents.get(root).equals(root))root=parents.get(root);while(!parents.get(id).equals(root)){String next=parents.get(id);parents.put(id,root);id=next;}return root;}
    private static void union(Map<String,String> parents,Set<String> known,String left,String right){
        if(!known.contains(left)||!known.contains(right))return;
        String a=find(parents,left),b=find(parents,right);if(a.equals(b))return;
        if(a.compareTo(b)<0)parents.put(b,a);else parents.put(a,b);
    }

    // ===== 上下文与参数 =====

    /** 上下文只读数据库：导入时间用于增量迭代版本，效果图指纹用于素材形态硬规则。 */
    static Context context(Connection c,String projectId)throws Exception{
        Map<String,String> imported=new HashMap<>();
        for(JsonObject row:Store.rows(c,"SELECT e.asset_id AS id,MIN(e.timestamp) AS t FROM events e JOIN assets a ON a.id=e.asset_id WHERE a.project_id=? AND e.type='asset.imported' GROUP BY e.asset_id",projectId))
            imported.put(Json.required(row,"id"),Json.str(row,"t",""));
        Set<String> overlays=new HashSet<>();
        for(JsonObject row:Store.rows(c,"SELECT DISTINCT json_extract(e.payload,'$.imageHash') AS h FROM events e JOIN assets a ON a.id=e.asset_id WHERE a.project_id=? AND e.type='annotation.rendered'",projectId)){
            String hash=Json.str(row,"h","");if(!hash.isBlank())overlays.add(hash);
        }
        return new Context(imported,overlays);
    }

    private static JsonObject quotas(JsonObject raw){
        if(raw.size()>MAX_CLASSES)throw invalid("采样配额最多 "+MAX_CLASSES+" 个类别。");
        JsonObject result=new JsonObject();
        List<String> keys=new ArrayList<>(raw.keySet());Collections.sort(keys);
        for(String classId:keys){
            JsonElement value=raw.get(classId);
            if(!value.isJsonPrimitive()||!value.getAsJsonPrimitive().isNumber())throw invalid("采样配额必须是数字："+classId);
            int quota=value.getAsInt();
            if(quota<0||quota>MAX_ITEMS)throw invalid("采样配额超出允许范围："+classId);
            result.addProperty(classId,quota);
        }
        return result;
    }

    private static Set<String> values(JsonObject object,String key){
        Set<String> result=new LinkedHashSet<>();
        for(JsonElement e:Json.array(object,key))result.add(e.getAsString());
        return result;
    }

    private static JsonArray ids(JsonObject object,String key,int max){
        JsonArray source=Json.array(object,key),result=new JsonArray();Set<String> seen=new HashSet<>();
        if(source.size()>max)throw invalid(key+" 最多 "+max+" 项。");
        for(JsonElement e:source){
            if(!e.isJsonPrimitive()||!e.getAsJsonPrimitive().isString())throw invalid(key+" 必须是字符串列表。");
            String value=e.getAsString().strip();
            if(value.isEmpty()||value.length()>MAX_TEXT)throw invalid(key+" 存在空值或过长取值。");
            if(seen.add(value))result.add(value);
        }
        return result;
    }

    private static String text(JsonObject object,String key,int max){
        if(!object.has(key)||object.get(key).isJsonNull())return "";
        JsonElement value=object.get(key);
        if(!value.isJsonPrimitive()||!value.getAsJsonPrimitive().isString())throw invalid(key+" 必须是文本。");
        String text=value.getAsString().strip();
        if(text.length()>max)throw invalid(key+" 过长。");
        return text;
    }

    private static String choice(JsonObject object,String key,String fallback,Set<String> allowed){
        String value=object.has(key)&&!object.get(key).isJsonNull()?text(object,key,32):fallback;
        if(value.isEmpty())value=fallback;
        if(!allowed.contains(value))throw invalid(key+" 只能是 "+String.join(" / ",new TreeSet<>(allowed))+"。");
        return value;
    }

    private static Integer whole(JsonObject object,String key,int fallback,int min,int max){
        if(!object.has(key)||object.get(key).isJsonNull())return fallback;
        JsonElement value=object.get(key);
        if(!value.isJsonPrimitive()||!value.getAsJsonPrimitive().isNumber())throw invalid(key+" 必须是整数。");
        int number=value.getAsInt();
        if(number<min||number>max)throw invalid(key+" 超出允许范围 "+min+"～"+max+"。");
        return number;
    }

    private static Double decimal(JsonObject object,String key){
        if(!object.has(key)||object.get(key).isJsonNull())return null;
        JsonElement value=object.get(key);
        if(!value.isJsonPrimitive()||!value.getAsJsonPrimitive().isNumber())throw invalid(key+" 必须是数字。");
        double number=value.getAsDouble();
        if(!Double.isFinite(number))throw invalid(key+" 必须是有限数字。");
        return number;
    }

    private static Double decimal(JsonObject object,String key,double min,double max){
        Double value=decimal(object,key);
        if(value==null)return null;
        if(value<min||value>max)throw invalid(key+" 超出允许范围 "+min+"～"+max+"。");
        return value;
    }

    private static String moment(JsonObject object,String key){
        String value=text(object,key,40);
        if(value.isEmpty())return "";
        try{Instant.parse(value);}catch(Exception failure){throw invalid(key+" 必须是 ISO 8601 时间。");}
        return value;
    }

    private static Instant instant(JsonObject object,String key){
        String value=moment(object,key);
        return value.isEmpty()?null:Instant.parse(value);
    }

    private static void keys(JsonObject object,String... allowed){
        Set<String> names=Set.of(allowed);
        for(String name:object.keySet())if(!names.contains(name))throw invalid("不支持的筛选参数："+name);
    }

    private static ApiError invalid(String message){return new ApiError(400,"dataset_selection_invalid",message);}
}
