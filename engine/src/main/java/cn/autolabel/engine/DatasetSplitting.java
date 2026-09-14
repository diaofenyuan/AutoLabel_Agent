package cn.autolabel.engine;

import com.google.gson.*;
import java.util.*;

/**
 * 划分模块（M5）：比例、重分配算法、显式清单与划分报告的数据基础。
 *
 * 来源组仍是不可拆分的最小单位（I4）：显式清单把素材归属到划分时，整组跟随，
 * 组内冲突视为配置错误；分组约束优先级高于比例（7.4），比例无法满足时在划分报告中如实说明。
 * 三种算法都确定性可复现（I6）：同一种子与配方必然得到同一划分。
 */
final class DatasetSplitting {
    static final String ALGORITHM_SOURCE_GROUP="source-group",ALGORITHM_RANDOM="random-shuffle",ALGORITHM_MINIMAL="minimal-move";
    /** 划分规则名写入清单，消费端据此复算划分而不是去猜目录结构。 */
    static final String RULE="dataset-split-v1";
    private static final Set<String> ALGORITHMS=Set.of(ALGORITHM_SOURCE_GROUP,ALGORITHM_RANDOM,ALGORITHM_MINIMAL);
    private static final Set<String> SPLITS=Set.of("train","val","test");
    private static final double[] DEFAULT_RATIO={0.7,0.2,0.1};

    private DatasetSplitting(){}

    /** 划分配方规范化：只保留生效值，默认 70/20/10 按来源组重排。 */
    static JsonObject normalize(JsonObject raw){
        keys(raw,"algorithm","train","val","test","strict","explicit");
        String algorithm=raw.has("algorithm")&&!Json.str(raw,"algorithm","").isEmpty()
            ?choice(raw,"algorithm",ALGORITHM_SOURCE_GROUP,ALGORITHMS):ALGORITHM_SOURCE_GROUP;
        double train=percent(raw,"train",DEFAULT_RATIO[0]),val=percent(raw,"val",DEFAULT_RATIO[1]),test=percent(raw,"test",DEFAULT_RATIO[2]);
        if(Math.abs(train+val+test-1)>0.001)throw invalid("划分比例之和必须为 1。");
        boolean strict=Json.bool(raw,"strict",false);
        JsonObject explicit=explicit(raw);
        JsonObject result=new JsonObject();
        if(!algorithm.equals(ALGORITHM_SOURCE_GROUP))result.addProperty("algorithm",algorithm);
        if(train!=DEFAULT_RATIO[0]||val!=DEFAULT_RATIO[1]||test!=DEFAULT_RATIO[2])
            result.add("ratios",Json.obj("train",train,"val",val,"test",test));
        if(strict)result.addProperty("strict",true);
        if(explicit.size()>0)result.add("explicit",explicit);
        return result;
    }

    private static JsonObject explicit(JsonObject raw){
        if(!raw.has("explicit")||raw.get("explicit").isJsonNull())return new JsonObject();
        JsonObject rawMap=Json.object(raw,"explicit"),result=new JsonObject();
        if(rawMap.size()>10_000)throw invalid("显式划分清单最多 10000 项。");
        List<String> ids=new ArrayList<>(rawMap.keySet());Collections.sort(ids);
        for(String assetId:ids){
            JsonElement value=rawMap.get(assetId);
            if(!value.isJsonPrimitive()||!value.getAsJsonPrimitive().isString())throw invalid("显式划分取值必须是 train/val/test："+assetId);
            String split=value.getAsString();
            if(!SPLITS.contains(split))throw invalid("显式划分取值必须是 train/val/test："+assetId);
            result.addProperty(assetId,split);
        }
        return result;
    }

    static double[] ratios(JsonObject split){
        JsonObject ratios=Json.object(split,"ratios");
        return new double[]{Json.decimal(ratios,"train",DEFAULT_RATIO[0]),Json.decimal(ratios,"val",DEFAULT_RATIO[1]),Json.decimal(ratios,"test",DEFAULT_RATIO[2])};
    }

    static String algorithm(JsonObject split){return Json.str(split,"algorithm",ALGORITHM_SOURCE_GROUP);}
    static boolean strict(JsonObject split){return Json.bool(split,"strict",false);}

    /** 组→划分分配：显式清单先固定整组，其余组按算法补齐目标配额。 */
    static Map<String,String> assignGroups(List<String> order,double[] ratio,JsonObject explicit,Map<String,String> groups,String seed,String algorithm){
        Map<String,String> groupSplit=new LinkedHashMap<>();
        for(String assetId:explicit.keySet()){
            String split=Json.required(explicit,assetId),group=groups.get(assetId);
            if(group==null)continue;
            String previous=groupSplit.get(group);
            if(previous!=null&&!previous.equals(split))throw invalid("同一来源组被显式划分到不同集合："+group);
            groupSplit.put(group,split);
        }
        int total=order.size();
        long[] counts=new long[3];
        for(String group:order){
            String split=groupSplit.get(group);
            if(split!=null)counts[index(split)]++;
        }
        List<String> remaining=new ArrayList<>();
        for(String group:order)if(!groupSplit.containsKey(group))remaining.add(group);
        if(algorithm.equals(ALGORITHM_MINIMAL)&&!groupSplit.isEmpty()){
            // minimal-move：剩余组逐个放入比例缺口最大的划分，保持已有归属的稳定性。
            for(String group:remaining){
                int best=0;double bestDeficit=Double.NEGATIVE_INFINITY;
                for(int i=0;i<3;i++){
                    double deficit=ratio[i]*total-counts[i];
                    if(deficit>bestDeficit){bestDeficit=deficit;best=i;}
                }
                groupSplit.put(group,name(best));counts[best]++;
            }
            return groupSplit;
        }
        int[] target=targetCounts(total,ratio);
        for(String group:remaining){
            int best=-1;
            for(int i=0;i<3;i++)if(counts[i]<target[i]&&(best<0||counts[i]<counts[best]))best=i;
            if(best<0)best=2;
            groupSplit.put(group,name(best));counts[best]++;
        }
        return groupSplit;
    }

    /** 目标组数：与既有 assign 的口径一致——组数不足时保证 train/val 至少一组，比例只是逼近目标。 */
    static int[] targetCounts(int total,double[] ratio){
        if(total<=0)return new int[3];
        int train,val,test;
        if(total<3){train=1;val=total>=2?1:0;test=0;}
        else{
            train=Math.max(1,Math.min((int)Math.round(total*ratio[0]),total-2));
            val=Math.max(1,Math.min((int)Math.round(total*ratio[1]),total-train-1));
            test=total-train-val;
        }
        return new int[]{train,val,test};
    }

    /** 组顺序：默认按种子哈希排序；random-shuffle 用种子派生的独立哈希打乱（仍是确定性排列）。 */
    static List<String> orderedGroups(Map<String,String> groups,String seed,String algorithm){
        List<String> result=new ArrayList<>(new HashSet<>(groups.values()));
        String salt=algorithm.equals(ALGORITHM_RANDOM)?"shuffle|":"";
        result.sort(Comparator.comparing(label->DatasetVersions.hashText(seed+"|"+salt+label)));
        return result;
    }

    private static int index(String split){return split.equals("train")?0:split.equals("val")?1:2;}
    private static String name(int index){return index==0?"train":index==1?"val":"test";}
    private static double percent(JsonObject object,String key,double fallback){
        double value=Json.decimal(object,key,fallback);
        if(!(value>=0&&value<=1))throw invalid(key+" 必须在 0～1 之间。");
        return value;
    }
    private static String choice(JsonObject object,String key,String fallback,Set<String> allowed){
        String value=Json.str(object,key,"");
        if(!allowed.contains(value))throw invalid(key+" 只能是 "+String.join(" / ",new TreeSet<>(allowed))+"。");
        return value;
    }
    private static void keys(JsonObject object,String... allowed){
        Set<String> names=Set.of(allowed);
        for(String name:object.keySet())if(!names.contains(name))throw invalid("不支持的划分参数："+name);
    }
    private static ApiError invalid(String message){return new ApiError(422,"dataset_split_invalid",message);}
}
