package cn.autolabel.engine;

import com.google.gson.*;
import java.nio.file.*;
import java.util.*;

/**
 * 阶段 B 验收：过滤谓词、素材形态硬规则、采样（仅训练集）、遗漏范围与确定性。
 * 全部使用本地合成夹具，不发起任何外部请求。
 */
final class DatasetVersionsTest {
    private DatasetVersionsTest(){}

    static void run(Path root)throws Exception{
        filters(root.resolve("filters"));
        sampling(root.resolve("sampling"));
        folding(root.resolve("folding"));
    }

    // ===== 过滤与硬规则 =====

    private static void filters(Path root)throws Exception{
        try(Engine e=new Engine(root.resolve("data"))){
            JsonObject project=EngineTest.command(e,"project.create",Json.obj("name","版本过滤","taskType","detect",
                "classes",Json.arr(Json.obj("id","cat","name","猫","color","#3b82f6"),Json.obj("id","dog","name","狗","color","#ef4444"))));
            String pid=Json.required(project,"id");
            JsonArray ids=EngineTest.importSamples(e,pid,9);
            for(int i=0;i<ids.size();i++)annotate(e,ids.get(i).getAsString(),i%3==1?"dog":"cat");
            JsonObject overlay=EngineTest.command(e,"annotation.render",Json.obj("assetId",ids.get(0).getAsString(),"outputPath",
                root.resolve("overlay.png").toString(),"showLabels",false));
            check(Files.isRegularFile(Path.of(Json.required(overlay,"path"))),"效果图已生成");
            JsonObject imported=EngineTest.command(e,"asset.import",Json.obj("projectId",pid,"paths",Json.arr(Json.required(overlay,"path"))));
            check(Json.integer(imported,"imported",0)==1,"效果图可被再次导入（用于验证硬排除）");
            String overlayAsset=Json.array(imported,"assetIds").get(0).getAsString();
            annotate(e,overlayAsset,"cat");
            // 未纳入范围的素材、视频帧与衍生素材：形态由素材自身记录判定，不依赖用户开关。
            String scopeOnly=ids.get(8).getAsString();
            mark(e,scopeOnly,asset->asset.addProperty("status","unlabeled"));
            String videoFrame=ids.get(6).getAsString();
            mark(e,videoFrame,asset->Json.object(asset,"metadata").addProperty("sourceVideoId","video-1"));
            String derived=ids.get(7).getAsString();
            mark(e,derived,asset->Json.object(asset,"metadata").addProperty("parentAssetId",ids.get(0).getAsString()));

            JsonObject preflight=EngineTest.command(e,"dataset.version.preflight",Json.obj("projectId",pid,
                "selection",Json.obj("filters",Json.obj("explicitExclude",Json.arr(ids.get(1).getAsString())))));
            JsonObject reasons=Json.object(preflight,"excludedByReason");
            check(Json.number(preflight,"assets",0)==5,"过滤后可用素材数正确（9 张导入 + 1 张效果图副本，排除 5 项）");
            check(Json.number(preflight,"excludedTotal",0)==5,"遗漏范围计数正确（范围外 / 视频帧 / 衍生素材 / 效果图 / 显式排除）");
            check(Json.number(reasons,"form_video_frame",0)==1,"视频帧按硬规则排除");
            check(Json.number(reasons,"form_derived",0)==1,"衍生素材按硬规则排除");
            check(Json.number(reasons,"form_overlay_rendering",0)==1,"效果图按渲染指纹排除");
            check(Json.number(reasons,"explicit_exclude",0)==1,"显式排除清单优先");
            check(Json.number(reasons,"annotation_scope_excluded",0)==1,"标注范围外的素材计入遗漏范围");

            JsonObject created=await(e,EngineTest.command(e,"dataset.version.create",Json.obj("projectId",pid,"seed","filter-seed",
                "selection",Json.obj("filters",Json.obj("explicitExclude",Json.arr(ids.get(1).getAsString()))))));
            check(Json.required(created,"status").equals("ready"),"带过滤的版本可生成");
            Map<String,String> excludedReasons=excludedReasons(e,Json.required(created,"id"));
            check("form_overlay_rendering".equals(excludedReasons.get(overlayAsset)),"效果图逐项记录原因码");
            check("form_video_frame".equals(excludedReasons.get(videoFrame)),"视频帧逐项记录原因码");
            check(Json.array(created,"counts").size()>0,"版本视图包含逐项计数");
            JsonObject verified=EngineTest.command(e,"dataset.version.verify",Json.obj("versionId",Json.required(created,"id")));
            check(Json.bool(verified,"consistent",false),"过滤后的副本仍可复核");
            JsonObject manifest=Json.parse(Files.readString(versionDirectory(e,Json.required(created,"id")).resolve("manifest.json")));
            check(Json.number(Json.object(Json.object(manifest,"selection"),"sampling"),"kept",0)==3
                &&Json.number(Json.object(Json.object(manifest,"selection"),"sampling"),"dropped",1)==0,"清单记录采样报告（未启用采样时不剔除）");
            check(Json.object(Json.object(manifest,"selection"),"filters").has("emptyLabel"),"清单记录生效筛选参数");

            // 谓词逐条验证：类别、尺寸、空标签策略与来源组。
            JsonObject byClass=EngineTest.command(e,"dataset.version.preflight",Json.obj("projectId",pid,
                "selection",Json.obj("filters",Json.obj("excludeClasses",Json.arr("dog")))));
            check(Json.number(Json.object(byClass,"excludedByReason"),"class_excluded",0)>0,"按类别排除生效");
            JsonObject bySize=EngineTest.command(e,"dataset.version.preflight",Json.obj("projectId",pid,
                "selection",Json.obj("filters",Json.obj("minWidth",2000))));
            check(Json.number(Json.object(bySize,"excludedByReason"),"size_excluded",0)>=6,"尺寸谓词按整张判定");
            check(Json.number(bySize,"assets",0)==0,"全部被尺寸谓词排除");
            JsonObject emptyExcluded=EngineTest.command(e,"dataset.version.preflight",Json.obj("projectId",pid,
                "selection",Json.obj("filters",Json.obj("emptyLabel","exclude"))));
            check(Json.number(Json.object(emptyExcluded,"excludedByReason"),"empty_label_excluded",0)==0,"无目标素材在有目标范围内不误报");
            JsonObject groups=EngineTest.command(e,"dataset.version.preflight",Json.obj("projectId",pid,"selection",Json.obj("filters",
                Json.obj("sourceGroups",Json.arr("不存在的来源组")))));
            check(Json.number(groups,"assets",0)==0,"来源组谓词按组整张判定");
            check(Json.number(Json.object(groups,"excludedByReason"),"source_group_excluded",0)>=6,"被排除项带来源组原因码");

            rejects("dataset_selection_invalid",()->EngineTest.command(e,"dataset.version.preflight",Json.obj("projectId",pid,
                "selection",Json.obj("filters",Json.obj("unknownFilter",1)))));
            rejects("dataset_selection_invalid",()->EngineTest.command(e,"dataset.version.preflight",Json.obj("projectId",pid,
                "selection",Json.obj("sampling",Json.obj("mode","random")))));
        }
    }

    // ===== 采样：仅训练集、确定性与配额 =====

    private static void sampling(Path root)throws Exception{
        try(Engine e=new Engine(root.resolve("data"))){
            JsonObject project=EngineTest.command(e,"project.create",Json.obj("name","版本采样","taskType","detect",
                "classes",Json.arr(Json.obj("id","cat","name","猫","color","#3b82f6"),Json.obj("id","dog","name","狗","color","#ef4444"))));
            String pid=Json.required(project,"id");
            JsonArray ids=EngineTest.importSamples(e,pid,6);
            for(int i=0;i<ids.size();i++)annotate(e,ids.get(i).getAsString(),i==5?"dog":"cat");

            JsonObject plain=await(e,EngineTest.command(e,"dataset.version.create",Json.obj("projectId",pid,"seed","sample-seed")));
            long plainTrain=trainCount(e,Json.required(plain,"id"));
            check(plainTrain==4,"默认按 70/20/10 以来源组划分（6 张 → 训练 4 张）");

            JsonObject sampled=await(e,EngineTest.command(e,"dataset.version.create",Json.obj("projectId",pid,"seed","sample-seed",
                "selection",Json.obj("sampling",Json.obj("mode","random","ratio",0.5,"seed","fixed")))));
            long sampledTrain=trainCount(e,Json.required(sampled,"id"));
            check(sampledTrain==2,"采样只抽取训练集子集（4 → 2）");
            Map<String,String> splits=splits(e,Json.required(sampled,"id"));
            long val=0,test=0;for(String value:splits.values()){if(value.equals("val"))val++;if(value.equals("test"))test++;}
            check(val==1&&test==1,"验证集与测试集不参与采样");
            Map<String,String> reasons=excludedReasons(e,Json.required(sampled,"id"));
            long sampledOut=0;for(String code:reasons.values())if(code.equals("sampled_out"))sampledOut++;
            check(sampledOut==2,"被抽出的训练图片逐项记录 sampled_out");
            JsonObject report=Json.object(Json.object(sampled,"selection"),"sampling");
            check(Json.number(report,"kept",0)==2&&Json.number(report,"dropped",0)==2,"采样报告给出保留与剔除张数");

            // 同配方同种子必然得到同一内容哈希（I6）。
            JsonObject repeat=await(e,EngineTest.command(e,"dataset.version.create",Json.obj("projectId",pid,"seed","sample-seed",
                "selection",Json.obj("sampling",Json.obj("mode","random","ratio",0.5,"seed","fixed")))));
            check(Json.required(repeat,"contentHash").equals(Json.required(sampled,"contentHash")),"同种子同配方内容哈希一致");
            check(Json.required(repeat,"recipeHash").equals(Json.required(sampled,"recipeHash")),"同配方配方哈希一致");
            // 种子参与子集选择：多候选里必然存在与 fixed 不同的子集（确定性，不依赖运气）。
            boolean seedMatters=false;
            for(String candidate:List.of("another","seed-b","seed-c","seed-d")){
                JsonObject variant=await(e,EngineTest.command(e,"dataset.version.create",Json.obj("projectId",pid,"seed","sample-seed",
                    "selection",Json.obj("sampling",Json.obj("mode","random","ratio",0.5,"seed",candidate)))));
                if(!Json.required(variant,"contentHash").equals(Json.required(sampled,"contentHash"))){seedMatters=true;break;}
            }
            check(seedMatters,"不同种子得到不同子集");
            JsonObject changedRecipe=await(e,EngineTest.command(e,"dataset.version.create",Json.obj("projectId",pid,"seed","sample-seed",
                "selection",Json.obj("filters",Json.obj("minAspect",0.5)))));
            check(!Json.required(changedRecipe,"recipeHash").equals(Json.required(plain,"recipeHash")),"筛选变化反映到配方哈希");

            // 类别配额：不足时如实报告，不静默牺牲其他类别。
            JsonObject quota=await(e,EngineTest.command(e,"dataset.version.create",Json.obj("projectId",pid,"seed","sample-seed",
                "selection",Json.obj("sampling",Json.obj("mode","stratified","ratio",0.5,"seed","quota",
                    "quotas",Json.obj("dog",3))))));
            JsonObject quotaReport=Json.object(Json.object(quota,"selection"),"sampling");
            check(Json.array(quotaReport,"quotaShortfall").size()==1,"配额无法满足时逐项报告");
            JsonObject shortfall=Json.array(quotaReport,"quotaShortfall").get(0).getAsJsonObject();
            check(Json.required(shortfall,"classId").equals("dog"),"未满足的配额指向具体类别");
            long quotaTrain=trainCount(e,Json.required(quota,"id"));
            check(quotaTrain>=1,"配额的类别下限被保留");

            // 空标签策略：默认限量保留，超限与显式排除都逐项记录原因。
            JsonObject emptyProject=EngineTest.command(e,"project.create",Json.obj("name","空标签","taskType","detect",
                "classes",Json.arr(Json.obj("id","cat","name","猫","color","#3b82f6"))));
            String emptyPid=Json.required(emptyProject,"id");
            JsonArray emptyIds=EngineTest.importSamples(e,emptyPid,4);
            for(int i=0;i<3;i++)annotate(e,emptyIds.get(i).getAsString(),"cat");
            JsonObject emptyLabels=EngineTest.command(e,"annotation.save",Json.obj("assetId",emptyIds.get(3).getAsString(),"baseVersion",0,"annotations",new JsonArray()));
            check(Json.required(emptyLabels,"status").equals("modified"),"空标签素材以正式状态保存");
            JsonObject limited=EngineTest.command(e,"dataset.version.preflight",Json.obj("projectId",emptyPid,
                "selection",Json.obj("filters",Json.obj("emptyLabelLimit",0))));
            check(Json.number(Json.object(limited,"excludedByReason"),"empty_label_limit_exceeded",0)==1,"空标签超限被逐项记录");
            JsonObject excluded=EngineTest.command(e,"dataset.version.preflight",Json.obj("projectId",emptyPid,
                "selection",Json.obj("filters",Json.obj("emptyLabel","exclude"))));
            check(Json.number(Json.object(excluded,"excludedByReason"),"empty_label_excluded",0)==1,"空标签可显式排除");
            JsonObject kept=EngineTest.command(e,"dataset.version.preflight",Json.obj("projectId",emptyPid));
            check(Json.number(kept,"assets",0)==4,"空标签默认作为合法负样本保留");
        }
    }

    // ===== 近重复折叠 =====

    private static void folding(Path root)throws Exception{
        try(Engine e=new Engine(root.resolve("data"))){
            JsonObject project=EngineTest.command(e,"project.create",Json.obj("name","近重复折叠","taskType","detect",
                "classes",Json.arr(Json.obj("id","cat","name","猫","color","#3b82f6"))));
            String pid=Json.required(project,"id");
            JsonArray ids=EngineTest.importSamples(e,pid,1);
            for(JsonElement id:ids)annotate(e,id.getAsString(),"cat");
            String source=ids.get(0).getAsString();
            // 相同内容的第二份副本无法通过导入产生（导入按内容指纹去重），直接在库里构造以验证折叠口径；
            // 副本指向同一真实文件、状态降为候选，保证折叠代表一定选中已确认的原素材。
            String twin=Json.id();
            e.store.tx(c->{
                JsonObject original=Store.document(c,"assets",source);
                String originalPath=Json.required(Store.one(c,"SELECT path FROM assets WHERE id=?",source),"path");
                JsonObject copy=original.deepCopy();copy.addProperty("id",twin);copy.addProperty("name","副本.png");
                copy.addProperty("status","candidate");
                Store.update(c,"INSERT INTO assets(id,project_id,data,path) VALUES(?,?,?,?)",twin,pid,copy,originalPath);
                return null;
            });
            JsonObject plain=await(e,EngineTest.command(e,"dataset.version.create",Json.obj("projectId",pid,"seed","fold-seed")));
            Map<String,String> plainSplits=splits(e,Json.required(plain,"id"));
            check(plainSplits.containsKey(twin)&&plainSplits.containsKey(source),"默认不折叠：同内容两项都进入版本");
            Map<String,String> plainGroups=new HashMap<>();
            for(JsonElement element:items(e,Json.required(plain,"id"))){
                JsonObject item=element.getAsJsonObject();if(plainSplits.containsKey(Json.required(item,"assetId")))
                plainGroups.put(Json.required(item,"assetId"),Json.required(item,"sourceGroup"));
            }
            check(plainGroups.get(twin).equals(plainGroups.get(source)),"同内容素材属于同一来源组");

            JsonObject folded=await(e,EngineTest.command(e,"dataset.version.create",Json.obj("projectId",pid,"seed","fold-seed",
                "selection",Json.obj("sampling",Json.obj("nearDuplicate","fold")))));
            String foldedId=Json.required(folded,"id");
            Map<String,String> splits=splits(e,foldedId);
            check(splits.containsKey(source)&&!splits.containsKey(twin),"折叠后同簇只保留人工确认的代表");
            Map<String,String> reasons=excludedReasons(e,foldedId);
            check("near_duplicate_folded".equals(reasons.get(twin)),"被折叠项逐项记录原因码");
            JsonObject report=Json.object(Json.object(folded,"selection"),"sampling");
            check(Json.number(Json.object(report,"nearDuplicate"),"folded",0)==1,"折叠报告给出剔除张数");
            check(Json.number(Json.object(report,"nearDuplicate"),"clusters",0)>=1,"折叠报告给出簇数");
            check(!reasons.containsKey(source),"代表项不被折叠");
            JsonObject verified=EngineTest.command(e,"dataset.version.verify",Json.obj("versionId",foldedId));
            check(Json.bool(verified,"consistent",false),"折叠后的副本仍可复核");
            // 折叠只收训练集子集：整个项目只有一个来源组且全部落入训练集，验证集与测试集不存在。
            long val=0,test=0;for(String value:splits.values()){if(value.equals("val"))val++;if(value.equals("test"))test++;}
            check(val==0&&test==0,"单来源组项目全部落入训练集");
        }
    }

    // ===== 辅助 =====

    private static JsonArray items(Engine e,String versionId)throws Exception{
        JsonObject page=EngineTest.command(e,"dataset.version.items",Json.obj("versionId",versionId,"limit",500));
        return Json.array(page,"items");
    }

    private static void annotate(Engine e,String assetId,String classId)throws Exception{
        EngineTest.command(e,"annotation.save",Json.obj("assetId",assetId,"baseVersion",0,"annotations",
            Json.arr(Json.obj("id",Json.id(),"type","detect","classId",classId,"bbox",Json.obj("x",200,"y",180,"width",200,"height",120))),"confirm",true));
    }

    private static void mark(Engine e,String assetId,java.util.function.Consumer<JsonObject> mutation)throws Exception{
        e.store.tx(c->{JsonObject asset=Store.document(c,"assets",assetId);JsonObject updated=asset.deepCopy();mutation.accept(updated);
            Store.update(c,"UPDATE assets SET data=? WHERE id=?",updated,assetId);return null;});
    }

    private static JsonObject await(Engine e,JsonObject version)throws Exception{
        String id=Json.required(version,"id");
        for(int i=0;i<600;i++){
            JsonObject current=EngineTest.command(e,"dataset.version.get",Json.obj("versionId",id));
            if(!Json.str(current,"status","").equals("building"))return current;
            Thread.sleep(25);
        }
        throw new AssertionError("版本生成未在预期时间内结束");
    }

    private static Map<String,String> excludedReasons(Engine e,String versionId)throws Exception{
        Map<String,String> result=new HashMap<>();
        JsonObject page=EngineTest.command(e,"dataset.version.items",Json.obj("versionId",versionId,"outcome","filtered_out","limit",500));
        for(JsonElement item:Json.array(page,"items")){
            JsonObject value=item.getAsJsonObject();result.put(Json.required(value,"assetId"),Json.required(value,"reasonCode"));
        }
        return result;
    }

    private static Map<String,String> splits(Engine e,String versionId)throws Exception{
        Map<String,String> result=new HashMap<>();
        for(int offset=0;;offset+=500){
            JsonObject page=EngineTest.command(e,"dataset.version.items",Json.obj("versionId",versionId,"outcome","included","offset",offset,"limit",500));
            for(JsonElement item:Json.array(page,"items")){
                JsonObject value=item.getAsJsonObject();result.put(Json.required(value,"assetId"),Json.required(value,"split"));
            }
            if(Json.array(page,"items").size()<500)return result;
        }
    }

    private static long trainCount(Engine e,String versionId)throws Exception{
        long train=0;for(String split:splits(e,versionId).values())if(split.equals("train"))train++;return train;
    }

    private static Path versionDirectory(Engine e,String versionId){
        return e.store.root.resolve("datasets").resolve("versions").resolve(versionId);
    }

    private static void check(boolean ok,String message){EngineTest.check(ok,message);}

    private static void rejects(String code,java.util.concurrent.Callable<JsonObject> action){
        try{action.call();throw new AssertionError("Expected "+code);}catch(ApiError failure){check(failure.code.equals(code),"Expected "+code+" got "+failure.code);}catch(Exception failure){throw new AssertionError(failure);}
    }
}
