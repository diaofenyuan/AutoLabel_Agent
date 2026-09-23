package cn.autolabel.engine;

import com.google.gson.*;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.Connection;
import java.util.*;

final class Reviews {
    final Store store;final Projects projects;
    static final Set<String> STATUSES=Set.of("pending","checked","dismissed","request_relabel");
    Reviews(Store store,Projects projects){this.store=store;this.projects=projects;}
    static JsonObject item(String pid,String aid,JsonElement version,String reason,String severity,String source,String objectId,String context,JsonObject links){
        String id=Json.id();JsonObject value=Json.obj("id",id,"projectId",pid,"assetId",aid,"candidateVersion",version,"objectId",objectId,"reason",reason,"severity",severity,"source",source,"status","pending","createdAt",Json.now());for(var link:links.entrySet())value.add(link.getKey(),link.getValue());value.addProperty("identityKey",context+":"+aid+":"+String.valueOf(version)+":"+reason+":"+String.valueOf(objectId));return value;
    }
    JsonObject build(JsonObject p){String mode=Json.str(p,"source","issues");if(mode.equals("hard"))return buildHard(p);if(p.has("source"))throw new ApiError(400,"review_source_invalid","复核来源无效。");if(p.has("evaluationId")==p.has("runId"))throw new ApiError(400,"review_source_invalid","请指定 evaluationId 或 runId，不能同时提供。");JsonObject rules=Json.object(p,"rules");for(String key:List.of("minMatchedIoU","maxNormalizedPointError"))if(rules.has(key)){double v=Json.decimal(rules,key,-1);if(!Double.isFinite(v)||v<0||v>1)throw new ApiError(400,"review_rule_invalid","复核定位阈值必须在 0～1 内。");}
        List<JsonObject> items=store.read(c->{List<JsonObject> result=new ArrayList<>();if(p.has("evaluationId")){String eid=Json.required(p,"evaluationId");JsonObject evaluation=Store.document(c,"evaluations",eid);String pid=Json.required(evaluation,"projectId");for(JsonElement entry:Store.docs(c,"SELECT data FROM evaluation_results WHERE evaluation_id=? ORDER BY rowid",eid)){
                    JsonObject row=entry.getAsJsonObject();String aid=Json.required(row,"assetId"),rid=Json.required(row,"runId"),context="evaluation:"+eid+":"+rid;JsonElement version=row.get("candidateVersion");JsonObject links=Json.obj("evaluationId",eid,"runId",rid,"schemeId",rid,"rules",new JsonObject());
                    if(!Json.required(row,"status").equals("scorable")){String status=Json.required(row,"status"),severity=status.equals("pending")?"info":status.equals("missing")?"warning":"error";result.add(item(pid,aid,version,"prediction_"+status,severity,"execution",null,context,links));}
                    else if(row.has("classResult")){JsonObject classification=Json.object(row,"classResult");if(!Json.bool(classification,"correct",false))result.add(item(pid,aid,version,Json.bool(classification,"missingPrediction",false)?"classification_missing":"classification_wrong","warning","truth_comparison",null,context,links));}
                    else{for(JsonElement id:Json.array(row,"unmatchedTruthIds"))result.add(item(pid,aid,version,"missed_object","error","truth_comparison",id.getAsString(),context,links));for(JsonElement id:Json.array(row,"unmatchedPredictionIds"))result.add(item(pid,aid,version,"extra_object","warning","truth_comparison",id.getAsString(),context,links));
                        for(JsonElement pair:Json.array(row,"pairs")){JsonObject matched=pair.getAsJsonObject();String object=Json.required(matched,"predictionId");if(rules.has("minMatchedIoU")&&Json.decimal(matched,"iou",1)<Json.decimal(rules,"minMatchedIoU",0))result.add(ruleItem(pid,aid,version,"localization_iou",object,context,links,rules,"minMatchedIoU"));
                            if(!Json.array(matched,"missingPredictedKeypoints").isEmpty())result.add(item(pid,aid,version,"missing_keypoint","warning","truth_comparison",object,context,links));
                            if(rules.has("maxNormalizedPointError"))for(JsonElement error:Json.array(matched,"keypointErrors"))if(Json.decimal(error.getAsJsonObject(),"errorNormalized",0)>Json.decimal(rules,"maxNormalizedPointError",1)){result.add(ruleItem(pid,aid,version,"keypoint_location",object,context,links,rules,"maxNormalizedPointError"));break;}}
                    }if(result.size()>10000)throw new ApiError(413,"review_issue_limit","单次复核构建超过 10000 项，请缩小评测范围。");}
            }else{String rid=Json.required(p,"runId");JsonObject run=Store.document(c,"runs",rid);String pid=Json.required(run,"projectId");for(JsonObject sample:Store.rows(c,"SELECT asset_id,status,data FROM samples WHERE run_id=? AND status IN ('failed','unknown')",rid)){JsonObject data=Json.parse(sample.get("data").getAsString());result.add(item(pid,Json.required(sample,"asset_id"),data.get("candidateVersion"),"prediction_"+Json.required(sample,"status"),"error","execution",null,"run:"+rid,Json.obj("runId",rid,"errorCode",data.get("errorCode"))));}}
            return result;});return saveItems(items,null);
    }
    static JsonObject ruleItem(String pid,String aid,JsonElement version,String reason,String objectId,String context,JsonObject links,JsonObject rules,String key){
        // 只把实际触发该项的规则纳入身份，改变阈值不会复用旧判断，无关规则也不会重复创建事实项。
        double threshold=Json.decimal(rules,key,0);JsonObject snapshot=links.deepCopy();snapshot.add("rules",Json.obj(key,threshold));return item(pid,aid,version,reason,"warning","truth_comparison",objectId,context+":"+key+"="+threshold,snapshot);
    }
    JsonObject saveItems(List<JsonObject> items,JsonObject sample){return store.tx(c->{if(sample!=null)Store.update(c,"INSERT INTO review_samples(id,project_id,data) VALUES(?,?,?)",Json.required(sample,"id"),Json.required(sample,"projectId"),sample);int created=0;JsonArray output=new JsonArray();
        for(JsonObject item:items){int inserted=Store.update(c,"INSERT OR IGNORE INTO review_items(id,project_id,evaluation_id,run_id,sample_id,asset_id,candidate_version,status,identity_key,data) VALUES(?,?,?,?,?,?,?,?,?,?)",Json.required(item,"id"),Json.required(item,"projectId"),Json.str(item,"evaluationId",null),Json.str(item,"runId",null),Json.str(item,"sampleId",null),Json.required(item,"assetId"),item.get("candidateVersion")==null||item.get("candidateVersion").isJsonNull()?null:item.get("candidateVersion").getAsInt(),"pending",Json.required(item,"identityKey"),item);created+=inserted;if(output.size()<500){if(inserted==1)output.add(item);else output.add(Json.parse(Json.required(Store.one(c,"SELECT data FROM review_items WHERE identity_key=?",Json.required(item,"identityKey")),"data")));}}
        Store.event(c,sample==null?"review.built":"review.sampled",null,null,null,Json.obj("created",created,"existing",items.size()-created,"sampleId",sample==null?null:sample.get("id")));return sample==null?Json.obj("created",created,"existing",items.size()-created,"items",output,"itemsTruncated",items.size()>500):sample;});}
    JsonObject list(JsonObject p){String pid=Json.required(p,"projectId");if(p.has("source")&&!Set.of("execution","truth_comparison","random","hard").contains(Json.required(p,"source")))throw new ApiError(400,"review_source_invalid","复核来源无效。");if(p.has("status")&&!STATUSES.contains(Json.required(p,"status")))throw new ApiError(400,"review_status_invalid","复核状态无效。");return store.read(c->{String condition="project_id=?";List<Object> args=new ArrayList<>(List.of(pid));for(String key:List.of("evaluationId","runId","sampleId","status","source"))if(p.has(key)){String column=switch(key){case "evaluationId"->"evaluation_id";case "runId"->"run_id";case "sampleId"->"sample_id";case "source"->"json_extract(data,'$.source')";default->"status";};condition+=" AND "+column+"=?";args.add(Json.required(p,key));}long total=Store.one(c,"SELECT COUNT(*) AS n FROM review_items WHERE "+condition,args.toArray()).get("n").getAsLong();args.add(Json.bounded(p,"limit",100,1,500));args.add(Json.bounded(p,"offset",0,0,Integer.MAX_VALUE));
            // 难例队列按优先级降序（低置信在前、几何问题加权），其余维持严重度分层 + 建立顺序。
            String order=Json.str(p,"source","").equals("hard")?" ORDER BY json_extract(data,'$.priority') DESC,rowid":" ORDER BY CASE json_extract(data,'$.severity') WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,rowid";
            return Json.obj("items",Store.docs(c,"SELECT data FROM review_items WHERE "+condition+order+" LIMIT ? OFFSET ?",args.toArray()),"total",total);});}
    JsonObject resolve(JsonObject p){String id=Json.required(p,"itemId"),action=Json.required(p,"action");if(!Set.of("checked","dismissed","request_relabel").contains(action))throw new ApiError(400,"review_action_invalid","不支持该复核操作。");if(!p.has("baseCandidateVersion"))throw new ApiError(400,"invalid_argument","请明确提供 baseCandidateVersion，失败无候选时为 null。");return store.tx(c->{JsonObject item=Store.document(c,"review_items",id);JsonElement current=item.has("candidateVersion")?item.get("candidateVersion"):JsonNull.INSTANCE;if(!Objects.equals(current,p.get("baseCandidateVersion")))throw new ApiError(409,"review_version_conflict","复核项对应版本与提交版本不同。");item.addProperty("status",action);item.addProperty("note",Json.str(p,"note",""));item.addProperty("resolvedAt",Json.now());Store.update(c,"UPDATE review_items SET status=?,data=? WHERE id=?",action,item,id);Store.event(c,"review.resolved",Json.str(item,"runId",null),Json.required(item,"assetId"),null,Json.obj("itemId",id,"status",action,"candidateVersion",current));return item;});}
    JsonObject sample(JsonObject p)throws Exception{String pid=Json.required(p,"projectId"),seed=Json.required(p,"seed");if(seed.length()>256)throw new ApiError(400,"review_seed_invalid","抽样种子最长 256 个字符。");List<JsonObject> assets=new AssetFiles(store,projects).select(p);if(!p.has("assetIds")||assets.isEmpty()||assets.size()>1000||Json.array(p,"assetIds").size()!=assets.size())throw new ApiError(400,"asset_selection_empty","请选择 1～1000 张无重复素材作为抽样范围。");int count=Json.bounded(p,"count",0,1,assets.size());assets.sort(Comparator.comparing(a->Json.required(a,"id")));long rng=ByteBuffer.wrap(MessageDigest.getInstance("SHA-256").digest(seed.getBytes(StandardCharsets.UTF_8))).getLong();Collections.shuffle(assets,new Random(rng));String id=Json.id();JsonArray versions=new JsonArray(),population=new JsonArray();for(JsonObject asset:assets)population.add(Json.obj("assetId",asset.get("id"),"version",asset.get("version")));List<JsonObject> items=new ArrayList<>();
        for(JsonObject asset:assets.subList(0,count)){String aid=Json.required(asset,"id");versions.add(Json.obj("assetId",aid,"version",asset.get("version"),"contentHash",asset.get("contentHash")));items.add(item(pid,aid,asset.get("version"),"random_sample","info","random",null,"sample:"+id,Json.obj("sampleId",id)));}
        JsonObject sample=Json.obj("id",id,"projectId",pid,"mode","random","populationCount",assets.size(),"count",count,"seed",seed,"algorithm","sha256-java-shuffle-v1","population",population,"assetVersions",versions,"createdAt",Json.now());return saveItems(items,sample);
    }

    /** 难例优先队列（source='hard'）：按「置信度低 + 几何问题 + 评测漏检/多检」排出优先级，只排队复核，不改任何标注。 */
    JsonObject buildHard(JsonObject p){if(p.has("evaluationId")==p.has("runId"))throw new ApiError(400,"review_source_invalid","请指定 evaluationId 或 runId，不能同时提供。");
        List<JsonObject> items=store.read(c->{List<JsonObject> result=new ArrayList<>();
            if(p.has("evaluationId")){String eid=Json.required(p,"evaluationId");JsonObject evaluation=Store.document(c,"evaluations",eid);String pid=Json.required(evaluation,"projectId");
                for(JsonElement entry:Store.docs(c,"SELECT data FROM evaluation_results WHERE evaluation_id=? ORDER BY rowid",eid)){
                    JsonObject row=entry.getAsJsonObject();String aid=Json.required(row,"assetId"),rid=Json.required(row,"runId"),context="hard:"+eid+":"+rid;JsonElement version=row.get("candidateVersion");
                    if(!Json.required(row,"status").equals("scorable")||row.has("classResult"))continue;
                    JsonObject signals=hardSignals(c,aid,version,row);double priority=hardPriority(signals);if(priority<=0)continue;
                    JsonObject links=Json.obj("evaluationId",eid,"runId",rid,"schemeId",rid,"signals",signals,"priority",priority);
                    result.add(item(pid,aid,version,"hard_case",priority>=1.5?"error":priority>=0.8?"warning":"info","hard",null,context,links));
                    if(result.size()>10000)throw new ApiError(413,"review_issue_limit","单次复核构建超过 10000 项，请缩小评测范围。");}
            }else{String rid=Json.required(p,"runId");JsonObject run=Store.document(c,"runs",rid);String pid=Json.required(run,"projectId");
                for(JsonObject row:Store.rows(c,"SELECT asset_id,data FROM samples WHERE run_id=? ORDER BY rowid",rid)){
                    JsonObject data=Json.parse(row.get("data").getAsString());String aid=Json.required(row,"asset_id");if(!data.has("candidateVersion"))continue;
                    JsonObject signals=hardSignals(c,aid,data.get("candidateVersion"),new JsonObject());double priority=hardPriority(signals);if(priority<=0)continue;
                    JsonObject links=Json.obj("runId",rid,"signals",signals,"priority",priority);
                    result.add(item(pid,aid,data.get("candidateVersion"),"hard_case",priority>=1.5?"error":priority>=0.8?"warning":"info","hard",null,"hard:run:"+rid,links));
                    if(result.size()>10000)throw new ApiError(413,"review_issue_limit","单次复核构建超过 10000 项，请缩小范围。");}}
            return result;});return saveItems(items,null);
    }
    /** 难例信号：候选版本的最低标注置信度、几何问题数/复核标记，加上评测行的漏检/多检数量。 */
    static JsonObject hardSignals(Connection c,String aid,JsonElement version,JsonObject row)throws Exception{
        JsonElement minimum=JsonNull.INSTANCE;int geometry=0;boolean review=false;
        if(version!=null&&!version.isJsonNull()){JsonObject stored=Store.one(c,"SELECT data FROM versions WHERE asset_id=? AND version=?",aid,version.getAsInt());
            if(stored!=null){JsonObject data=Json.parse(stored.get("data").getAsString());double min=1;boolean any=false;
                for(JsonElement element:Json.array(data,"annotations")){JsonObject annotation=element.getAsJsonObject();if(!annotation.has("confidence"))continue;double value=Json.decimal(annotation,"confidence",1);if(!any||value<min){min=value;any=true;}}
                if(any)minimum=Json.element(min);
                JsonObject metadata=Json.object(data,"metadata");geometry=Json.array(metadata,"geometryIssues").size();review=Json.bool(metadata,"requiresGeometryReview",false);}}
        JsonObject signals=Json.obj("minConfidence",minimum,"geometryIssues",geometry,"requiresGeometryReview",review,"missedObjects",Json.array(row,"unmatchedTruthIds").size(),"extraObjects",Json.array(row,"unmatchedPredictionIds").size());
        return signals;
    }
    /** 难例优先级：低置信为主（1-置信度），每个几何问题 +0.5、复核标记 +0.5，漏检 +0.4、多检 +0.2。 */
    static double hardPriority(JsonObject signals){
        double confidence=signals.get("minConfidence")==null||signals.get("minConfidence").isJsonNull()?0.5:Math.max(0,Math.min(1,Json.decimal(signals,"minConfidence",1)));
        double priority=(1-confidence)+0.5*Json.integer(signals,"geometryIssues",0)+(Json.bool(signals,"requiresGeometryReview",false)?0.5:0)+0.4*Json.integer(signals,"missedObjects",0)+0.2*Json.integer(signals,"extraObjects",0);
        return Math.round(priority*1000)/1000.0;
    }
    /** 复核结果回流的两张建议卡（只建议不自动改）：建议置信度阈值 / 建议送训练的素材清单。 */
    JsonObject suggestions(JsonObject p){String pid=Json.required(p,"projectId");
        return store.read(c->{
            JsonObject threshold=null;
            if(p.has("evaluationId")){String eid=Json.required(p,"evaluationId");JsonObject evaluation=Store.document(c,"evaluations",eid);if(!pid.equals(Json.required(evaluation,"projectId")))throw new ApiError(404,"evaluation_not_found","评测不属于该项目。");
                List<Double> matched=new ArrayList<>(),extra=new ArrayList<>();
                for(JsonElement entry:Store.docs(c,"SELECT data FROM evaluation_results WHERE evaluation_id=? ORDER BY rowid",eid)){
                    JsonObject row=entry.getAsJsonObject();if(!Json.required(row,"status").equals("scorable")||row.has("classResult"))continue;
                    Map<String,Double> confidences=confidenceById(c,Json.required(row,"assetId"),row.get("candidateVersion"));
                    for(JsonElement pair:Json.array(row,"pairs")){Double value=confidences.get(Json.str(pair.getAsJsonObject(),"predictionId",""));if(value!=null)matched.add(value);}
                    for(JsonElement id:Json.array(row,"unmatchedPredictionIds")){Double value=confidences.get(id.getAsString());if(value!=null)extra.add(value);}}
                if(!matched.isEmpty()){double minMatched=Collections.min(matched);Double suggested=null;String basis;
                    if(!extra.isEmpty()&&Collections.max(extra)<minMatched){suggested=Math.round((Collections.max(extra)+minMatched)/2*100)/100.0;basis="建议阈值取「多余预测的最高置信度」与「命中预测的最低置信度」的中点；只建议不自动改，请在运行参数里手动设置后小批量验证。";}
                    else if(extra.isEmpty()){suggested=Math.round(minMatched*0.9*100)/100.0;basis="本次评测没有多余预测，建议阈值取命中预测最低置信度的九成作为保守下界；只建议不自动改，请手动设置后小批量验证。";}
                    else basis="多余预测与命中预测的置信度区间重叠，没有安全分界：请先人工复核这些难例再决定阈值（只建议不自动改）。";
                    threshold=Json.obj("suggested",suggested,"basis",basis,"matchedCount",matched.size(),"extraCount",extra.size());}}
            LinkedHashSet<String> training=new LinkedHashSet<>();
            for(JsonObject row:Store.rows(c,"SELECT asset_id,status,data FROM review_items WHERE project_id=? ORDER BY rowid DESC LIMIT 5000",pid)){
                JsonObject data=Json.parse(row.get("data").getAsString());String status=Json.str(row,"status",""),source=Json.str(data,"source",""),reason=Json.str(data,"reason","");
                boolean keep=status.equals("request_relabel")||source.equals("hard")||status.equals("pending")&&Set.of("missed_object","extra_object").contains(reason);
                if(keep&&training.size()<500)training.add(Json.required(row,"asset_id"));}
            JsonArray assetIds=new JsonArray();for(String aid:training)assetIds.add(aid);
            JsonObject trainingSuggestion=Json.obj("assetIds",assetIds,"count",assetIds.size(),"reason","重标请求、难例优先队列与未处理的漏检/多检素材最适合送训（已去重、最多 500 张）；只建议不自动改，请确认清单后再进入训练数据集。");
            return Json.obj("confidenceThreshold",threshold==null?JsonNull.INSTANCE:threshold,"trainingSuggestion",trainingSuggestion);
        });
    }
    static Map<String,Double> confidenceById(Connection c,String aid,JsonElement version)throws Exception{
        Map<String,Double> result=new HashMap<>();if(version==null||version.isJsonNull())return result;
        JsonObject stored=Store.one(c,"SELECT data FROM versions WHERE asset_id=? AND version=?",aid,version.getAsInt());if(stored==null)return result;
        for(JsonElement element:Json.array(Json.parse(stored.get("data").getAsString()),"annotations")){JsonObject annotation=element.getAsJsonObject();if(annotation.has("confidence")&&annotation.has("id"))result.put(Json.str(annotation,"id",""),Json.decimal(annotation,"confidence",1));}
        return result;
    }
}
