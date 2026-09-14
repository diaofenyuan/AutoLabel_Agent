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
        transforms(root.resolve("transforms"));
        augment(root.resolve("augment"));
        splitting(root.resolve("splitting"));
        consumption(root.resolve("consumption"));
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
            long keptActual=Json.number(Json.object(Json.object(manifest,"selection"),"sampling"),"kept",-1),
                droppedActual=Json.number(Json.object(Json.object(manifest,"selection"),"sampling"),"dropped",-1);
            check(keptActual==3&&droppedActual==0,"清单记录采样报告（未启用采样时不剔除）kept="+keptActual+" dropped="+droppedActual);
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

            // 类别配额：不足时如实报告，不静默牺牲其他类别。dog 通过显式清单固定进训练集，配额语义可确定断言。
            String dogAsset=ids.get(5).getAsString();
            JsonObject quota=await(e,EngineTest.command(e,"dataset.version.create",Json.obj("projectId",pid,"seed","sample-seed",
                "selection",Json.obj("sampling",Json.obj("mode","stratified","ratio",0.5,"seed","quota",
                    "quotas",Json.obj("dog",3))),
                "split",Json.obj("explicit",Json.obj(dogAsset,"train")))));
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

    // ===== 转换：裁剪、平铺、缩放、灰度与重映射 =====

    private static void transforms(Path root)throws Exception{
        try(Engine e=new Engine(root.resolve("data"))){
            JsonObject project=EngineTest.command(e,"project.create",Json.obj("name","版本转换","taskType","detect",
                "classes",Json.arr(Json.obj("id","cat","name","猫","color","#3b82f6"),Json.obj("id","dog","name","狗","color","#ef4444"))));
            String pid=Json.required(project,"id");
            JsonArray ids=EngineTest.importSamples(e,pid,2);
            String asset=ids.get(0).getAsString();
            annotateAt(e,asset,"cat",200,180,200,120);
            annotateAt(e,ids.get(1).getAsString(),"dog",200,180,200,120);

            // 裁剪（对象完整保留）：坐标线性变换，标签按视图尺寸重建。
            JsonObject cropped=await(e,EngineTest.command(e,"dataset.version.create",Json.obj("projectId",pid,"seed","crop-seed",
                "transform",Json.obj("crop",Json.obj("left",0,"top",0,"right",0.5,"bottom",0.5)))));
            String croppedId=Json.required(cropped,"id");
            check(Json.required(cropped,"status").equals("ready"),"裁剪版本可生成");
            JsonObject cropItem=includedItem(e,croppedId,asset);
            check(Json.integer(cropItem,"width",0)==480&&Json.integer(cropItem,"height",0)==320,"裁剪视图尺寸正确");
            double[] line=labelValues(e,croppedId,cropItem);
            check(line.length==5&&line[0]==0&&Math.abs(line[1]-300/480.0)<1e-6&&Math.abs(line[2]-240/320.0)<1e-6
                &&Math.abs(line[3]-200/480.0)<1e-6&&Math.abs(line[4]-120/320.0)<1e-6,"裁剪标签按视图尺寸归一化");
            check(Json.bool(EngineTest.command(e,"dataset.version.verify",Json.obj("versionId",croppedId)),"consistent",false),"裁剪副本可复核");

            // 裁剪截断对象：默认 clip 保留裁剪后几何并逐项记录。
            JsonObject cutting=await(e,EngineTest.command(e,"dataset.version.create",Json.obj("projectId",pid,"seed","cut-seed",
                "transform",Json.obj("crop",Json.obj("left",0,"top",0,"right",0.3,"bottom",0.5)))));
            JsonObject cutItem=includedItem(e,Json.required(cutting,"id"),asset);
            check(Json.integer(cutItem,"objects",0)==1,"截断对象默认保留裁剪部分");
            check(issueCount(cutItem,"object_truncated")==1,"截断逐项计数并分级");
            double[] cutLine=labelValues(e,Json.required(cutting,"id"),cutItem);
            check(Math.abs(cutLine[3]-88/288.0)<1e-6,"截断后框宽为剩余部分");
            // 策略 drop：截断对象整体丢弃并记录；策略 reject：整个视图被拒绝。
            JsonObject droppedVersion=await(e,EngineTest.command(e,"dataset.version.create",Json.obj("projectId",pid,"seed","drop-seed",
                "transform",Json.obj("crop",Json.obj("left",0,"top",0,"right",0.3,"bottom",0.5),"boundaries","drop"))));
            JsonObject droppedItem=includedItem(e,Json.required(droppedVersion,"id"),asset);
            check(Json.integer(droppedItem,"objects",0)==0,"drop 策略丢弃截断对象");
            check(issueCount(droppedItem,"object_truncated")==1,"drop 策略仍记录截断");
            JsonObject rejectedVersion=await(e,EngineTest.command(e,"dataset.version.create",Json.obj("projectId",pid,"seed","reject-seed",
                "transform",Json.obj("crop",Json.obj("left",0,"top",0,"right",0.3,"bottom",0.5),"boundaries","reject"))));
            check(!includedItemExists(e,Json.required(rejectedVersion,"id"),asset),"reject 策略下该视图不进入版本内容");
            check(excludedReasons(e,Json.required(rejectedVersion,"id")).containsValue("transform_boundary_rejected"),"被拒绝视图逐项记录原因");

            // 平铺 2×1：对象不跨片时只出现在所属瓦片；跨片对象在 clip 策略下进入两个瓦片。
            JsonObject tiled=await(e,EngineTest.command(e,"dataset.version.create",Json.obj("projectId",pid,"seed","tile-seed",
                "transform",Json.obj("tile",Json.obj("mode","rows","rows",1,"cols",2)))));
            long tiles=0;for(JsonElement element:items(e,Json.required(tiled,"id")))
                if(Json.str(element.getAsJsonObject(),"assetId","").equals(asset))tiles++;
            check(tiles==2,"平铺 2×1 产生两个视图");
            // 确定性：同种子同配方得到同一内容哈希（I6）。
            JsonObject repeat=await(e,EngineTest.command(e,"dataset.version.create",Json.obj("projectId",pid,"seed","tile-seed",
                "transform",Json.obj("tile",Json.obj("mode","rows","rows",1,"cols",2)))));
            check(Json.required(repeat,"contentHash").equals(Json.required(tiled,"contentHash")),"转换后同种子内容哈希一致");
            // 构造跨片对象：x 380..580 横跨 x=480 的分界。
            annotateAt(e,ids.get(1).getAsString(),"dog",380,100,200,120);
            JsonObject crossing=await(e,EngineTest.command(e,"dataset.version.create",Json.obj("projectId",pid,"seed","cross-seed",
                "transform",Json.obj("tile",Json.obj("mode","rows","rows",1,"cols",2)))));
            long clippedViews=0;for(JsonElement element:items(e,Json.required(crossing,"id")))
                if(Json.str(element.getAsJsonObject(),"assetId","").equals(ids.get(1).getAsString()))clippedViews++;
            check(clippedViews==2,"clip 策略下跨片对象进入两个瓦片");
            JsonObject skipped=await(e,EngineTest.command(e,"dataset.version.create",Json.obj("projectId",pid,"seed","skip-seed",
                "transform",Json.obj("tile",Json.obj("mode","rows","rows",1,"cols",2),"crossTile","skip"))));
            long skippedRecords=0;for(JsonElement element:items(e,Json.required(skipped,"id"))){
                JsonObject item=element.getAsJsonObject();
                if(Json.str(item,"assetId","").equals(ids.get(1).getAsString())&&item.has("crossTileSkipped"))skippedRecords++;
            }
            check(skippedRecords==2,"跨片对象从所有瓦片剔除并逐项计数");
            check(includedItem(e,Json.required(skipped,"id"),ids.get(1).getAsString()).get("objects").getAsInt()==0,"被跳过对象不进入任何瓦片标签");

            // 缩放对齐：stretch 精确映射，contain 留边并居中。
            JsonObject stretched=await(e,EngineTest.command(e,"dataset.version.create",Json.obj("projectId",pid,"seed","stretch-seed",
                "transform",Json.obj("resize",Json.obj("width",480,"height",320,"fit","stretch")))));
            JsonObject stretchItem=includedItem(e,Json.required(stretched,"id"),asset);
            double[] stretchLine=labelValues(e,Json.required(stretched,"id"),stretchItem);
            check(Math.abs(stretchLine[1]-150/480.0)<1e-6&&Math.abs(stretchLine[2]-120/320.0)<1e-6
                &&Math.abs(stretchLine[3]-100/480.0)<1e-6&&Math.abs(stretchLine[4]-60/320.0)<1e-6,"stretch 缩放按轴独立映射");
            JsonObject contained=await(e,EngineTest.command(e,"dataset.version.create",Json.obj("projectId",pid,"seed","contain-seed",
                "transform",Json.obj("resize",Json.obj("width",480,"height",480,"fit","contain","paddingColor","#102030")))));
            JsonObject containItem=includedItem(e,Json.required(contained,"id"),asset);
            check(Json.integer(containItem,"width",0)==480&&Json.integer(containItem,"height",0)==480,"contain 视图尺寸正确");
            double[] containLine=labelValues(e,Json.required(contained,"id"),containItem);
            check(Math.abs(containLine[1]-150/480.0)<1e-6&&Math.abs(containLine[2]-200/480.0)<1e-6
                &&Math.abs(containLine[3]-100/480.0)<1e-6&&Math.abs(containLine[4]-60/480.0)<1e-6,"contain 缩放留边居中后坐标正确");

            // 灰度化：渲染结果为单通道灰度且不影响几何。
            JsonObject gray=await(e,EngineTest.command(e,"dataset.version.create",Json.obj("projectId",pid,"seed","gray-seed",
                "transform",Json.obj("grayscale",true))));
            JsonObject grayItem=includedItem(e,Json.required(gray,"id"),asset);
            java.awt.image.BufferedImage image=javax.imageio.ImageIO.read(
                versionDirectory(e,Json.required(gray,"id")).resolve(Json.required(grayItem,"image")).toFile());
            check(image.getWidth()==960&&image.getHeight()==640,"灰度视图保持原尺寸");
            int pixel=image.getRGB(480,320);
            check((pixel>>16&255)==(pixel>>8&255)&&(pixel>>8&255)==(pixel&255),"灰度化像素三通道相等");

            // 语义重映射：省略类别连带丢弃标注，重命名保持标识且校验合法性。
            JsonObject omitted=await(e,EngineTest.command(e,"dataset.version.create",Json.obj("projectId",pid,"seed","omit-seed",
                "transform",Json.obj("remap",Json.obj("omit",Json.arr("dog"))))));
            JsonObject omittedItem=includedItem(e,Json.required(omitted,"id"),ids.get(1).getAsString());
            check(Json.integer(omittedItem,"objects",0)==0&&Json.integer(omittedItem,"omittedObjects",0)==1,"省略类别连带丢弃其标注并计数");
            check(Json.array(omitted,"classes").size()==1,"生效类别表已剔除被省略类别");
            JsonObject renamed=await(e,EngineTest.command(e,"dataset.version.create",Json.obj("projectId",pid,"seed","rename-seed",
                "transform",Json.obj("remap",Json.obj("rename",Json.obj("cat","猫咪"))))));
            check(Json.required(Json.array(renamed,"classes").get(0).getAsJsonObject(),"name").equals("猫咪"),"重命名反映到类别表");
            check(Files.readString(versionDirectory(e,Json.required(renamed,"id")).resolve("data.yaml")).contains("猫咪"),"重映射写入 data.yaml");
            rejects("dataset_transform_invalid",()->EngineTest.command(e,"dataset.version.preflight",Json.obj("projectId",pid,
                "transform",Json.obj("remap",Json.obj("rename",Json.obj("cat","同名","dog","同名"))))));
            rejects("dataset_transform_invalid",()->EngineTest.command(e,"dataset.version.preflight",Json.obj("projectId",pid,
                "transform",Json.obj("remap",Json.obj("omit",Json.arr("cat","dog"))))));
            rejects("dataset_transform_invalid",()->EngineTest.command(e,"dataset.version.preflight",Json.obj("projectId",pid,
                "transform",Json.obj("crop",Json.obj("left",0.8,"top",0,"right",0.2,"bottom",0.5)))));
            JsonObject preview=EngineTest.command(e,"dataset.version.preflight",Json.obj("projectId",pid,
                "transform",Json.obj("tile",Json.obj("mode","rows","rows",1,"cols",2))));
            check(Json.number(Json.object(preview,"transformPreview"),"views",0)>0,"预检给出转换后的张数预估");

            // Pose：越界关键点按可见性约定处理，不静默裁掉已定位点。
            JsonObject pose=EngineTest.command(e,"project.create",Json.obj("name","版本姿态","taskType","pose",
                "classes",Json.arr(Json.obj("id","person","name","人","color","#3b82f6")),
                "settings",Json.obj("keypointNames",Json.arr("left","right"))));
            String poseId=Json.required(pose,"id");
            JsonArray poseIds=EngineTest.importSamples(e,poseId,1);
            EngineTest.command(e,"annotation.save",Json.obj("assetId",poseIds.get(0).getAsString(),"baseVersion",0,
                "annotations",Json.arr(Json.obj("id",Json.id(),"type","pose","classId","person",
                    "bbox",Json.obj("x",200,"y",180,"width",200,"height",120),
                    "keypoints",Json.arr(Json.obj("name","left","x",220,"y",220,"visibility",2),Json.obj("name","right","x",360,"y",220,"visibility",1)))),
                "confirm",true));
            JsonObject poseVersion=await(e,EngineTest.command(e,"dataset.version.create",Json.obj("projectId",poseId,"seed","pose-seed",
                "transform",Json.obj("crop",Json.obj("left",0,"top",0,"right",0.3,"bottom",0.5)))));
            JsonObject poseItem=includedItem(e,Json.required(poseVersion,"id"),poseIds.get(0).getAsString());
            check(issueCount(poseItem,"object_truncated")==1&&issueCount(poseItem,"keypoint_cropped")==1,"关键点越界被显式记录");
            double[] poseLine=labelValues(e,Json.required(poseVersion,"id"),poseItem);
            check(poseLine.length==11&&poseLine[7]==2&&poseLine[8]==0&&poseLine[9]==0&&poseLine[10]==0,"越界关键点按不可定位写入");
        }
    }

    // ===== 增强：确定性、仅训练集、pose 对称校验（阶段 D） =====

    private static void augment(Path root)throws Exception{
        try(Engine e=new Engine(root.resolve("data"))){
            JsonObject project=EngineTest.command(e,"project.create",Json.obj("name","版本增强","taskType","detect",
                "classes",Json.arr(Json.obj("id","cat","name","猫","color","#3b82f6"),Json.obj("id","dog","name","狗","color","#ef4444"))));
            String pid=Json.required(project,"id");
            JsonArray ids=EngineTest.importSamples(e,pid,2);
            annotateAt(e,ids.get(0).getAsString(),"cat",200,180,200,120);
            annotateAt(e,ids.get(1).getAsString(),"dog",200,180,200,120);
            JsonObject augmented=await(e,EngineTest.command(e,"dataset.version.create",Json.obj("projectId",pid,"seed","aug-seed",
                "transform",Json.obj("augment",Json.obj("multiplier",2,"brightness",true,"noise",true)))));
            check(Json.required(augmented,"status").equals("ready"),"增强版本可生成");
            long variants=0,trainVariants=0,valIncluded=0;
            for(JsonElement element:items(e,Json.required(augmented,"id"))){
                JsonObject item=element.getAsJsonObject();
                if(Json.str(item,"outcome","").equals("variant")){variants++;if(Json.required(item,"split").equals("train"))trainVariants++;}
                if(Json.str(item,"outcome","").equals("included")&&Json.required(item,"split").equals("val"))valIncluded++;
            }
            check(variants==2,"倍数为 2 时产生 2 个变体");
            check(trainVariants==variants,"变体只存在于训练集（I5）");
            check(valIncluded==1,"验证集保持原始内容且无变体");
            check(Json.bool(EngineTest.command(e,"dataset.version.verify",Json.obj("versionId",Json.required(augmented,"id"))),"consistent",false),"含变体的副本仍可复核");
            JsonObject variantItem=null;
            for(JsonElement element:items(e,Json.required(augmented,"id"))){
                JsonObject item=element.getAsJsonObject();
                if(Json.str(item,"outcome","").equals("variant"))variantItem=item;
            }
            check(variantItem.has("parentViewId")&&variantItem.has("augment"),"变体逐项记录父视图与生效参数");
            // 同种子确定性（D-6）：同种子同配方得到同一内容哈希。
            JsonObject repeat=await(e,EngineTest.command(e,"dataset.version.create",Json.obj("projectId",pid,"seed","aug-seed",
                "transform",Json.obj("augment",Json.obj("multiplier",2,"brightness",true,"noise",true)))));
            check(Json.required(repeat,"contentHash").equals(Json.required(augmented,"contentHash")),"同种子变体内容哈希一致");
            // Cutout 判定口径：覆盖率 ≥50% 判定目标失效。
            JsonObject cutoutParams=Json.obj("cutout",true,"cutoutX",40,"cutoutY",40,"cutoutSize",50);
            JsonObject covered=Json.obj("type","detect","bbox",Json.obj("x",150,"y",150,"width",100,"height",100));
            check(DatasetTransforms.cutoutCoverage(covered,cutoutParams,960,640)>0.99,"遮挡矩形覆盖目标时覆盖率接近 1");
            JsonObject corner=Json.obj("type","detect","bbox",Json.obj("x",500,"y",500,"width",100,"height",100));
            check(DatasetTransforms.cutoutCoverage(corner,cutoutParams,960,640)==0,"遮挡矩形未触及目标时覆盖率为 0");

            // pose 翻转：无对称映射时拒绝并给出原因（D-3）。
            JsonObject pose=EngineTest.command(e,"project.create",Json.obj("name","增强姿态","taskType","pose",
                "classes",Json.arr(Json.obj("id","person","name","人","color","#3b82f6")),
                "settings",Json.obj("keypointNames",Json.arr("left","right"))));
            String poseId=Json.required(pose,"id");
            JsonArray poseIds=EngineTest.importSamples(e,poseId,1);
            EngineTest.command(e,"annotation.save",Json.obj("assetId",poseIds.get(0).getAsString(),"baseVersion",0,
                "annotations",Json.arr(Json.obj("id",Json.id(),"type","pose","classId","person",
                    "bbox",Json.obj("x",200,"y",180,"width",200,"height",120),
                    "keypoints",Json.arr(Json.obj("name","left","x",220,"y",220,"visibility",2),Json.obj("name","right","x",360,"y",220,"visibility",1)))),
                "confirm",true));
            JsonObject flipPreview=EngineTest.command(e,"dataset.version.preflight",Json.obj("projectId",poseId,
                "transform",Json.obj("augment",Json.obj("multiplier",2,"flip","horizontal"))));
            check(!Json.bool(flipPreview,"canBuild",true),"无对称映射时预检标记阻断");
            check(issueCodePresent(flipPreview,"dataset_augment_flip_requires_symmetry"),"阻断项说明缺少关键点对称映射");
            rejects("dataset_augment_flip_requires_symmetry",()->EngineTest.command(e,"dataset.version.create",Json.obj("projectId",poseId,"seed","flip-seed",
                "transform",Json.obj("augment",Json.obj("multiplier",2,"flip","horizontal")))));
            // 定义对称映射后可翻转：配对槽位互换位置并镜像。
            JsonObject pose2=EngineTest.command(e,"project.create",Json.obj("name","增强姿态对称","taskType","pose",
                "classes",Json.arr(Json.obj("id","person","name","人","color","#3b82f6")),
                "settings",Json.obj("keypointNames",Json.arr("left","right"),"keypointSymmetry",Json.arr(Json.arr("left","right")))));
            String pose2Id=Json.required(pose2,"id");
            JsonArray pose2Ids=EngineTest.importSamples(e,pose2Id,1);
            EngineTest.command(e,"annotation.save",Json.obj("assetId",pose2Ids.get(0).getAsString(),"baseVersion",0,
                "annotations",Json.arr(Json.obj("id",Json.id(),"type","pose","classId","person",
                    "bbox",Json.obj("x",200,"y",180,"width",200,"height",120),
                    "keypoints",Json.arr(Json.obj("name","left","x",220,"y",220,"visibility",2),Json.obj("name","right","x",360,"y",220,"visibility",1)))),
                "confirm",true));
            JsonObject flipped=await(e,EngineTest.command(e,"dataset.version.create",Json.obj("projectId",pose2Id,"seed","pose-flip",
                "transform",Json.obj("augment",Json.obj("multiplier",4,"flip","horizontal")))));
            check(Json.required(flipped,"status").equals("ready"),"定义对称映射后翻转版本可生成");
            boolean checked=false;
            for(JsonElement element:items(e,Json.required(flipped,"id"))){
                JsonObject item=element.getAsJsonObject();
                if(!Json.str(item,"outcome","").equals("variant"))continue;
                JsonObject params=Json.object(item,"augment");
                if(Json.bool(params,"flip",false)&&Json.str(params,"flipDir","").equals("horizontal")){
                    double[] line=labelValues(e,Json.required(flipped,"id"),item);
                    // 槽位语义整体互换：left 槽取 right 的镜像位置与可见性，right 槽同理。
                    check(line.length==11&&Math.abs(line[5]-(960-360)/960.0)<1e-6&&Math.abs(line[8]-(960-220)/960.0)<1e-6,
                        "水平翻转按对称映射交换配对关键点位置");
                    check(line[7]==1&&line[10]==2,"配对关键点可见性随槽位互换");
                    checked=true;break;
                }
            }
            check(checked,"存在启用水平翻转的变体");
        }
    }

    // ===== 划分策略：比例、算法、显式清单（阶段 E） =====

    private static void splitting(Path root)throws Exception{
        try(Engine e=new Engine(root.resolve("data"))){
            JsonObject project=EngineTest.command(e,"project.create",Json.obj("name","版本划分","taskType","detect",
                "classes",Json.arr(Json.obj("id","cat","name","猫","color","#3b82f6"))));
            String pid=Json.required(project,"id");
            JsonArray ids=EngineTest.importSamples(e,pid,10);
            for(JsonElement id:ids)annotateAt(e,id.getAsString(),"cat",200,180,200,120);

            // 自定义比例 50/30/20（E-1）：划分报告给出目标与实际组数及未达标说明（E-6）。
            JsonObject custom=await(e,EngineTest.command(e,"dataset.version.create",Json.obj("projectId",pid,"seed","ratio-seed",
                "split",Json.obj("train",0.5,"val",0.3,"test",0.2))));
            JsonObject splitReport=Json.object(custom,"split");
            check(Json.required(splitReport,"rule").equals("dataset-split-v1"),"清单记录划分规则");
            check(Json.decimal(Json.object(splitReport,"ratios"),"train",0)==0.5,"清单记录自定义比例");
            long trainImages=0,valImages=0,testImages=0;
            for(JsonElement element:Json.array(splitReport,"actual")){
                JsonObject entry=element.getAsJsonObject();
                long images=Json.integer(entry,"images",0);
                if(Json.required(entry,"split").equals("train"))trainImages=images;
                if(Json.required(entry,"split").equals("val"))valImages=images;
                if(Json.required(entry,"split").equals("test"))testImages=images;
            }
            check(trainImages==5&&valImages==3&&testImages==2,"50/30/20 比例按来源组精确落实");
            // 原图与含变体两套口径（E-6）：无增强时两口径一致。
            check(Json.integer(Json.array(splitReport,"actual").get(0).getAsJsonObject(),"originals",0)==trainImages,"划分报告提供原图口径");

            // random-shuffle：同种子确定性，且与默认哈希顺序分配不同（E-3）。
            JsonObject shuffled=await(e,EngineTest.command(e,"dataset.version.create",Json.obj("projectId",pid,"seed","shuffle-seed",
                "split",Json.obj("algorithm","random-shuffle"))));
            JsonObject repeat=await(e,EngineTest.command(e,"dataset.version.create",Json.obj("projectId",pid,"seed","shuffle-seed",
                "split",Json.obj("algorithm","random-shuffle"))));
            check(Json.required(shuffled,"contentHash").equals(Json.required(repeat,"contentHash")),"打乱算法同种子可复现");
            Map<String,String> shuffledSplits=splits(e,Json.required(shuffled,"id"));
            Map<String,String> defaultSplits=splits(e,Json.required(custom,"id"));
            boolean differs=false;
            for(String assetId:shuffledSplits.keySet())
                if(!shuffledSplits.get(assetId).equals(defaultSplits.get(assetId))){differs=true;break;}
            check(differs,"打乱算法与默认哈希顺序产生不同归属");

            // 显式清单（E-5）：素材归属生效且整组跟随；未知素材报错。
            String pinnedTrain=ids.get(0).getAsString(),pinnedVal=ids.get(1).getAsString();
            JsonObject explicitVersion=await(e,EngineTest.command(e,"dataset.version.create",Json.obj("projectId",pid,"seed","explicit-seed",
                "split",Json.obj("explicit",Json.obj(pinnedTrain,"train",pinnedVal,"val")))));
            Map<String,String> explicitSplits=splits(e,Json.required(explicitVersion,"id"));
            check(explicitSplits.get(pinnedTrain).equals("train")&&explicitSplits.get(pinnedVal).equals("val"),"显式清单归属生效");
            rejects("dataset_split_unknown_asset",()->EngineTest.command(e,"dataset.version.create",Json.obj("projectId",pid,"seed","bad-seed",
                "split",Json.obj("explicit",Json.obj("不存在的素材","train")))));
            rejects("dataset_split_invalid",()->EngineTest.command(e,"dataset.version.preflight",Json.obj("projectId",pid,
                "split",Json.obj("train",0.6,"val",0.6))));
            // minimal-move：显式清单优先，剩余组按缺口分配（E-3）。
            JsonObject minimal=await(e,EngineTest.command(e,"dataset.version.create",Json.obj("projectId",pid,"seed","move-seed",
                "split",Json.obj("algorithm","minimal-move","explicit",Json.obj(pinnedTrain,"test")))));
            check(splits(e,Json.required(minimal,"id")).get(pinnedTrain).equals("test"),"minimal-move 遵循显式清单");
            JsonObject preview=EngineTest.command(e,"dataset.version.preflight",Json.obj("projectId",pid,
                "split",Json.obj("strict",true)));
            check(preview.has("splitPreview"),"预检给出划分预览");
        }
    }

    // ===== 消费端接入：训练快照引用版本、导出血缘（阶段 F） =====

    private static void consumption(Path root)throws Exception{
        try(Engine e=new Engine(root.resolve("data"))){
            JsonObject project=EngineTest.command(e,"project.create",Json.obj("name","版本消费","taskType","detect",
                "classes",Json.arr(Json.obj("id","cat","name","猫","color","#3b82f6"))));
            String pid=Json.required(project,"id");
            JsonArray ids=EngineTest.importSamples(e,pid,3);
            for(JsonElement id:ids)annotateAt(e,id.getAsString(),"cat",200,180,200,120);
            JsonObject version=await(e,EngineTest.command(e,"dataset.version.create",Json.obj("projectId",pid,"seed","consume-seed",
                "transform",Json.obj("augment",Json.obj("multiplier",1,"brightness",true)))));
            String versionId=Json.required(version,"id");
            check(Json.required(version,"status").equals("ready"),"消费前版本已就绪");

            // 训练快照 source=version（F-2）：按清单逐文件校验后冻结，指纹确定性可复现。
            JsonObject snapshot=EngineTest.command(e,"training.dataset.create",Json.obj("projectId",pid,"source","version","versionId",versionId));
            check(Json.required(snapshot,"status").equals("ready"),"版本训练快照体检通过");
            check(Json.required(Json.object(snapshot,"originDetail"),"kind").equals("version"),"快照记录版本来源");
            String snapshotHash=Json.required(snapshot,"snapshotHash");
            JsonObject snapshotAgain=EngineTest.command(e,"training.dataset.create",Json.obj("projectId",pid,"source","version","versionId",versionId));
            check(Json.required(snapshotAgain,"snapshotHash").equals(snapshotHash),"同版本两次快照指纹一致");
            // 变体进入训练快照：倍数 1 时每张训练图多一个变体项。
            long snapshotImages=0;
            for(JsonElement element:Json.array(snapshot,"files"))if(Json.required(element.getAsJsonObject(),"split").equals("train"))snapshotImages++;
            check(snapshotImages>0,"训练快照包含训练划分文件");
            // 非 ready 版本不可消费（I8）：不存在的版本直接 404。
            rejects("not_found",()->EngineTest.command(e,"training.dataset.create",Json.obj("projectId",pid,"source","version","versionId","不存在的版本")));

            // 导出血缘（F-1）：export.create 记录 datasetVersionId，清单 lineage 只追加字段。
            JsonObject exported=EngineTest.command(e,"export.create",Json.obj("projectId",pid,"outputDir",
                root.resolve("export-out").toString(),"datasetVersionId",versionId));
            check(Json.required(exported,"status").equals("completed"),"带版本血缘的导出完成");
            check(Json.required(exported,"datasetVersionId").equals(versionId),"导出记录来源版本");
            JsonObject exportManifest=Json.parse(Files.readString(Path.of(Json.required(exported,"path")).resolve("manifest.json")));
            check(Json.integer(exportManifest,"schemaVersion",0)==3,"导出清单升级到 schemaVersion 3");
            check(Json.required(Json.object(exportManifest,"lineage"),"sourceDatasetVersionId").equals(versionId),"清单血缘记录来源版本");
            // 历史导出路径不回归：普通导出清单 lineage 为空对象但仍是 schemaVersion 3。
            JsonObject plainExport=EngineTest.command(e,"export.create",Json.obj("projectId",pid,"outputDir",
                root.resolve("export-plain").toString()));
            JsonObject plainManifest=Json.parse(Files.readString(Path.of(Json.required(plainExport,"path")).resolve("manifest.json")));
            check(Json.integer(plainManifest,"schemaVersion",0)==3&&!Json.object(plainManifest,"lineage").has("sourceDatasetVersionId")||
                Json.object(plainManifest,"lineage").get("sourceDatasetVersionId").isJsonNull(),"普通导出血缘为空且不破坏既有读取");
            // 诊断摘要（F-5）：包含版本计数且不含绝对路径。
            JsonObject diagnostics=EngineTest.command(e,"diagnostics.get");
            check(diagnostics.has("datasetVersions"),"诊断包含数据集版本摘要");
            check(!diagnostics.toString().contains(root.toString()),"诊断不含本机绝对路径");
        }
    }

    // ===== 辅助 =====

    private static JsonArray items(Engine e,String versionId)throws Exception{
        JsonObject page=EngineTest.command(e,"dataset.version.items",Json.obj("versionId",versionId,"limit",500));
        return Json.array(page,"items");
    }

    private static void annotate(Engine e,String assetId,String classId)throws Exception{
        annotateAt(e,assetId,classId,200,180,200,120);
    }

    private static void annotateAt(Engine e,String assetId,String classId,int x,int y,int width,int height)throws Exception{
        JsonObject asset=EngineTest.command(e,"asset.get",Json.obj("assetId",assetId));
        annotateAt(e,assetId,classId,x,y,width,height,Json.integer(asset,"version",0));
    }

    private static void annotateAt(Engine e,String assetId,String classId,int x,int y,int width,int height,int baseVersion)throws Exception{
        EngineTest.command(e,"annotation.save",Json.obj("assetId",assetId,"baseVersion",baseVersion,"annotations",
            Json.arr(Json.obj("id",Json.id(),"type","detect","classId",classId,"bbox",Json.obj("x",x,"y",y,"width",width,"height",height))),"confirm",true));
    }

    private static JsonObject includedItem(Engine e,String versionId,String assetId)throws Exception{
        for(JsonElement element:items(e,versionId)){
            JsonObject item=element.getAsJsonObject();
            if(Json.str(item,"assetId","").equals(assetId)&&Json.str(item,"outcome","").equals("included"))return item;
        }
        throw new AssertionError("未找到素材的包含项："+assetId);
    }

    private static boolean includedItemExists(Engine e,String versionId,String assetId)throws Exception{
        for(JsonElement element:items(e,versionId)){
            JsonObject item=element.getAsJsonObject();
            if(Json.str(item,"assetId","").equals(assetId)&&Json.str(item,"outcome","").equals("included"))return true;
        }
        return false;
    }

    /** 读取 YOLO 标签首行并解析为数值；pose 行包含关键点字段。 */
    private static double[] labelValues(Engine e,String versionId,JsonObject item)throws Exception{
        String text=Files.readString(versionDirectory(e,versionId).resolve(Json.required(item,"label"))).strip();
        if(text.isEmpty())return new double[0];
        String[] parts=text.split("\n")[0].trim().split("\\s+");
        double[] values=new double[parts.length];
        for(int i=0;i<parts.length;i++)values[i]=Double.parseDouble(parts[i]);
        return values;
    }

    private static long issueCount(JsonObject item,String code){
        for(JsonElement element:Json.array(item,"issues")){
            JsonObject issue=element.getAsJsonObject();
            if(Json.required(issue,"code").equals(code))return Json.integer(issue,"count",0);
        }
        return 0;
    }

    private static boolean issueCodePresent(JsonObject preflight,String code){
        for(JsonElement element:Json.array(Json.object(preflight,"inspection"),"issues"))
            if(Json.required(element.getAsJsonObject(),"code").equals(code))return true;
        return false;
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
