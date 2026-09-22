package cn.autolabel.engine;

import com.google.gson.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.sql.Connection;
import java.time.Instant;
import java.util.*;

final class CandidateReuse {
    private static final String PARSER_VERSION="annotations-v1";
    private static final int SEARCH_LIMIT=64;
    private static final long IMAGE_LIMIT=32L*1024*1024;
    private final Store store;

    CandidateReuse(Store store){this.store=store;}

    record Prepared(String fingerprint,JsonObject attemptFields,JsonObject run,JsonObject sample,long maxAgeMillis){}
    record Match(JsonArray annotations,JsonObject provenance,String versionRowId,String associationHash){}
    private record Source(JsonObject row,JsonObject version,JsonObject attempt,JsonObject sample,JsonObject run){}
    private static final class BodyState {
        final JsonObject run,sample;final JsonArray expectedImages;int images,targets,templates,references;long totalImageBytes;
        BodyState(JsonObject run,JsonObject sample){this.run=run;this.sample=sample;expectedImages=Json.array(Json.object(run,"snapshot"),"references").deepCopy();expectedImages.add(Json.object(sample,"asset"));}
    }

    Prepared prepare(JsonObject run,JsonObject sampleRow,JsonObject effectiveRequest,String credentialBindingVersion)throws Exception{
        return prepareFingerprint(run,sampleRow,effectiveRequest,credentialBindingVersion,true);
    }
    Prepared prepareAttempt(JsonObject run,JsonObject sampleRow,JsonObject effectiveRequest,String credentialBindingVersion)throws Exception{
        // 强制重标只跳过本轮读取；新的真实成功请求仍可作为以后复用的来源。
        return prepareFingerprint(run,sampleRow,effectiveRequest,credentialBindingVersion,false);
    }
    private Prepared prepareFingerprint(JsonObject run,JsonObject sampleRow,JsonObject effectiveRequest,String credentialBindingVersion,boolean lookup)throws Exception{
        if((lookup&&!eligibleRun(run))||Json.bool(run,"evaluationOnly",false)||!versions(Json.object(run,"snapshot"))||!binding(credentialBindingVersion))return null;
        // 必须传入数据库行的真实次数，不能根据运行总请求数猜测单图是否已经重试。
        if(!sampleRow.has("attempt_count")||Json.integer(sampleRow,"attempt_count",-1)!=0)return null;
        JsonObject sample=sampleData(sampleRow);String runId=Json.required(run,"id"),assetId=Json.required(sample,"assetId");
        if(sampleRow.has("run_id")&&!runId.equals(Json.str(sampleRow,"run_id","")))return null;
        if(sampleRow.has("asset_id")&&!assetId.equals(Json.str(sampleRow,"asset_id","")))return null;
        if(sampleRow.has("id")&&!Json.required(sampleRow,"id").equals(Json.required(sample,"id")))return null;
        JsonObject snapshot=Json.object(run,"snapshot"),provider=Json.object(snapshot,"provider");
        if(Json.object(snapshot,"project").has("id")&&!Json.required(run,"projectId").equals(Json.str(Json.object(snapshot,"project"),"id","")))return null;
        if(!credentialBindingVersion.equals(frozenBinding(run))||Json.integer(provider,"revision",0)<1)return null;
        JsonObject asset=Json.object(sample,"asset");if(!assetId.equals(Json.str(asset,"id",""))||!Json.required(run,"projectId").equals(Json.str(asset,"projectId","")))return null;
        long ttl=expiry(run);verifyInputs(run,sample);
        BodyState state=new BodyState(run,sample);JsonElement normalized=normalizeBody(effectiveRequest,state);
        if(state.images!=state.expectedImages.size()||state.references!=state.expectedImages.size()-1||state.targets!=1||state.templates!=1)return null;
        if(!Json.required(run,"model").equals(Json.str(effectiveRequest,"model","")))return null;
        String requestHash=hash(canonical(normalized)),contextHash=hash(canonical(context(run,sample,credentialBindingVersion)));
        String fingerprint=fingerprint(contextHash,requestHash);
        JsonObject fields=Json.obj("reuseFingerprint",fingerprint,"reuseContextHash",contextHash,"reuseRequestHash",requestHash,
            "parserVersion",PARSER_VERSION,"validatorVersion",TaskTemplates.VALIDATOR_VERSION,"requestContractVersion",TaskTemplates.REQUEST_CONTRACT_VERSION,"credentialBindingVersion",credentialBindingVersion);
        return new Prepared(fingerprint,fields,run.deepCopy(),sample.deepCopy(),ttl);
    }

    Match find(Prepared input,long nowEpochMs)throws Exception{
        if(input==null||!eligibleRun(input.run))return null;
        // 先只取有界标识，避免把大量历史请求与响应同时载入内存。
        List<JsonObject> ids=store.read(c->Store.rows(c,"SELECT v.id FROM versions v JOIN attempts a ON a.id=v.attempt_id JOIN runs r ON r.id=a.run_id WHERE r.project_id=? AND r.id<>? AND v.source='api' AND a.status='completed' AND json_extract(a.data,'$.reuseFingerprint')=? ORDER BY json_extract(a.data,'$.completedAt') DESC,v.id DESC LIMIT ?",
            Json.required(input.run,"projectId"),Json.required(input.run,"id"),input.fingerprint,SEARCH_LIMIT));
        for(JsonObject id:ids){
            Source source=store.read(c->source(c,id.get("id").getAsString()));if(source==null)continue;
            Match match=checked(input,source,nowEpochMs);if(match==null)continue;
            try{verifyInputs(source.run,source.sample);}catch(Exception ignored){continue;}
            return match;
        }
        return null;
    }

    Match revalidate(Connection c,Prepared input,Match match)throws Exception{
        if(input==null||match==null)return null;
        JsonObject run=Store.document(c,"runs",Json.required(input.run,"id"));if(!eligibleRun(run)||!Json.str(run,"status","").equals("running"))return null;
        JsonObject row=Store.one(c,"SELECT * FROM samples WHERE id=?",Json.required(input.sample,"id"));
        if(row==null||Json.integer(row,"attempt_count",-1)!=0||!Set.of("queued","preparing").contains(Json.str(row,"status",""))||!Json.required(input.run,"id").equals(Json.str(row,"run_id",""))||!Json.required(input.sample,"assetId").equals(Json.str(row,"asset_id","")))return null;
        JsonObject currentSample=sampleData(row);String binding=Json.required(input.attemptFields,"credentialBindingVersion");
        if(!Json.required(input.sample,"id").equals(Json.str(currentSample,"id",""))||!Json.required(input.sample,"assetId").equals(Json.str(currentSample,"assetId",""))||!Json.required(input.sample,"assetId").equals(Json.str(Json.object(currentSample,"asset"),"id",""))||!binding.equals(frozenBinding(run)))return null;
        if(!same(context(run,currentSample,binding),context(input.run,input.sample,binding)))return null;
        Source source=source(c,match.versionRowId);if(source==null)return null;
        Prepared policy=new Prepared(input.fingerprint,input.attemptFields,input.run,input.sample,Math.min(input.maxAgeMillis,expiry(run)));
        Match refreshed=checked(policy,source,System.currentTimeMillis());if(refreshed==null||!refreshed.associationHash.equals(match.associationHash))return null;
        JsonObject asset=Store.document(c,"assets",Json.required(input.sample,"assetId"));
        if(!Json.required(input.run,"projectId").equals(Json.str(asset,"projectId",""))||!same(imageContext(asset),imageContext(Json.object(input.sample,"asset"))))return null;
        JsonObject project=Store.document(c,"projects",Json.required(input.run,"projectId"));
        if(!same(TaskTemplates.semantic(project),TaskTemplates.semantic(Json.object(Json.object(input.run,"snapshot"),"project"))))return null;
        // 此处只复查关联和当前几何规则；人工状态、草稿与 baseVersion 保护仍由保存方决定。
        try{return new Match(Annotations.validate(refreshed.annotations,asset,project),refreshed.provenance,refreshed.versionRowId,refreshed.associationHash);}
        catch(ApiError invalid){return null;}
    }

    private Match checked(Prepared input,Source source,long nowEpochMs){
        try{
            JsonObject row=source.row,v=source.version,a=source.attempt,s=source.sample,r=source.run;
            String pid=Json.required(input.run,"projectId"),aid=Json.required(row,"source_asset_id"),rid=Json.required(row,"source_run_id"),sid=Json.required(row,"source_sample_id"),attempt=Json.required(row,"source_attempt_id");
            if(!pid.equals(Json.str(row,"project_id",""))||!pid.equals(Json.str(row,"asset_project_id",""))||rid.equals(Json.required(input.run,"id"))||Json.bool(r,"evaluationOnly",false))return null;
            if(!rid.equals(Json.str(r,"id",""))||!pid.equals(Json.str(r,"projectId",""))||!attempt.equals(Json.str(a,"id",""))||!Json.str(r,"model","").equals(Json.str(a,"model",""))||!Json.str(Json.object(Json.object(r,"snapshot"),"provider"),"id","").equals(Json.str(a,"providerId","")))return null;
            JsonObject sourceProject=Json.object(Json.object(r,"snapshot"),"project");if(sourceProject.has("id")&&!pid.equals(Json.str(sourceProject,"id","")))return null;
            if(!Json.str(row,"version_source","").equals("api")||!Json.str(v,"source","").equals("api")||!Json.str(v,"status","").equals("candidate")||v.has("reuse")||Json.object(v,"metadata").has("reuse"))return null;
            if(!Json.str(row,"attempt_status","").equals("completed")||!Json.str(a,"status","").equals("completed")||!Json.str(row,"sample_status","").equals("succeeded"))return null;
            if(!aid.equals(Json.str(v,"id",""))||!pid.equals(Json.str(v,"projectId",""))||!rid.equals(Json.str(v,"runId",""))||!attempt.equals(Json.str(v,"attemptId","")))return null;
            if(!rid.equals(Json.str(row,"sample_run_id",""))||!aid.equals(Json.str(row,"sample_asset_id",""))||!rid.equals(Json.str(a,"runId",""))||!sid.equals(Json.str(a,"sampleId",""))||!aid.equals(Json.str(a,"assetId","")))return null;
            if(!sid.equals(Json.str(s,"id",""))||!aid.equals(Json.str(s,"assetId",""))||!attempt.equals(Json.str(row,"active_attempt","")))return null;
            if(Json.integer(row,"version_no",0)<1||!same(row.get("version_no"),v.get("version"))||!same(v.get("version"),s.get("candidateVersion")))return null;
            if(!versions(a)||!versions(Json.object(r,"snapshot"))||!input.fingerprint.equals(Json.str(a,"reuseFingerprint",""))||!Json.required(input.attemptFields,"credentialBindingVersion").equals(Json.str(a,"credentialBindingVersion","")))return null;
            if(!Json.required(a,"credentialBindingVersion").equals(frozenBinding(r)))return null;
            JsonObject asset=Json.object(s,"asset");if(!aid.equals(Json.str(asset,"id",""))||!pid.equals(Json.str(asset,"projectId",""))||!same(imageContext(v),imageContext(asset)))return null;
            String contextHash=hash(canonical(context(r,s,Json.required(a,"credentialBindingVersion")))),requestHash=Json.str(a,"reuseRequestHash","");
            if(!requestHash.matches("[a-f0-9]{64}")||!contextHash.equals(Json.str(a,"reuseContextHash",""))||!fingerprint(contextHash,requestHash).equals(input.fingerprint))return null;
            long completed=Instant.parse(Json.required(a,"completedAt")).toEpochMilli();if(completed>nowEpochMs||input.maxAgeMillis!=Long.MAX_VALUE&&nowEpochMs-completed>input.maxAgeMillis)return null;
            JsonArray annotations=Annotations.validate(Json.array(v,"annotations"),asset,Json.object(Json.object(r,"snapshot"),"project"));
            if(!v.has("annotations")||!v.get("annotations").isJsonArray())return null;
            annotations=Annotations.validate(annotations,Json.object(input.sample,"asset"),Json.object(Json.object(input.run,"snapshot"),"project"));
            JsonObject response=Json.object(a,"response"),modelVersion=new JsonObject();for(String field:List.of("model","model_version","system_fingerprint"))if(response.has(field))modelVersion.add(field,response.get(field).deepCopy());
            JsonObject provenance=Json.obj("sourceRunId",rid,"sourceSampleId",sid,"sourceAssetId",aid,"sourceCandidateVersion",v.get("version"),"sourceAttemptId",attempt,
                "sourceCompletedAt",a.get("completedAt"),"sourceModel",a.get("model"),"sourceModelVersion",modelVersion,"reuseFingerprint",input.fingerprint);
            JsonObject association=Json.obj("version",v,"attempt",pick(a,List.of("id","runId","sampleId","assetId","status","completedAt","model","reuseFingerprint","reuseContextHash","reuseRequestHash","parserVersion","validatorVersion","requestContractVersion","credentialBindingVersion")),"sample",s,"context",contextHash,"row",rowIdentity(row));
            return new Match(annotations,provenance,Json.required(row,"version_row_id"),hash(canonical(association)));
        }catch(Exception invalid){return null;}
    }

    private static Source source(Connection c,String id)throws Exception{
        JsonObject row=Store.one(c,"SELECT v.id AS version_row_id,v.asset_id AS source_asset_id,v.version AS version_no,v.source AS version_source,v.data AS version_data,a.id AS source_attempt_id,a.run_id AS source_run_id,a.sample_id AS source_sample_id,a.status AS attempt_status,a.data AS attempt_data,s.run_id AS sample_run_id,s.asset_id AS sample_asset_id,s.status AS sample_status,s.active_attempt,s.data AS sample_data,r.project_id,r.data AS run_data,src.project_id AS asset_project_id FROM versions v JOIN attempts a ON a.id=v.attempt_id JOIN samples s ON s.id=a.sample_id JOIN runs r ON r.id=a.run_id JOIN assets src ON src.id=v.asset_id WHERE v.id=?",id);
        if(row==null)return null;
        try{return new Source(row,stored(row,"version_data"),stored(row,"attempt_data"),stored(row,"sample_data"),stored(row,"run_data"));}catch(RuntimeException invalid){return null;}
    }
    private static JsonObject rowIdentity(JsonObject row){JsonObject result=new JsonObject();for(var entry:row.entrySet())if(!entry.getKey().endsWith("_data"))result.add(entry.getKey(),entry.getValue());return result;}
    private static JsonObject stored(JsonObject row,String field){return Json.parse(row.get(field).getAsString());}
    private static JsonObject sampleData(JsonObject row){return row.has("data")?(row.get("data").isJsonObject()?row.getAsJsonObject("data").deepCopy():stored(row,"data")):row.deepCopy();}
    private static boolean eligibleRun(JsonObject run){return Json.bool(run,"reuseEnabled",true)&&!Json.bool(run,"force",false)&&!Json.bool(run,"evaluationOnly",false);}
    private static boolean versions(JsonObject value){return PARSER_VERSION.equals(Json.str(value,"parserVersion",""))&&TaskTemplates.VALIDATOR_VERSION.equals(Json.str(value,"validatorVersion",""))&&TaskTemplates.REQUEST_CONTRACT_VERSION.equals(Json.str(value,"requestContractVersion",""));}
    private static String frozenBinding(JsonObject run){
        // 只有运行快照中的绑定能证明当时使用的凭据，不能用当前配置或尝试记录补齐历史。
        JsonElement value=Json.object(run,"snapshot").get("credentialBindingVersion");
        if(value==null||!value.isJsonPrimitive()||!value.getAsJsonPrimitive().isString())return null;
        String persisted=value.getAsString();return binding(persisted)?persisted:null;
    }
    private static boolean binding(String value){try{return value!=null&&UUID.fromString(value).toString().equalsIgnoreCase(value);}catch(IllegalArgumentException e){return false;}}
    private static long expiry(JsonObject run){
        if(!run.has("reuseMaxAgeSeconds")||run.get("reuseMaxAgeSeconds").isJsonNull())return Long.MAX_VALUE;
        try{JsonElement value=run.get("reuseMaxAgeSeconds");if(!value.isJsonPrimitive()||!value.getAsJsonPrimitive().isNumber())throw new ArithmeticException();long seconds=value.getAsBigDecimal().longValueExact();if(seconds<=0)throw new ArithmeticException();return Math.multiplyExact(seconds,1000L);}
        catch(ArithmeticException invalid){throw new ApiError(400,"reuse_age_invalid","结果有效期必须是可支持的正整数秒数。");}
    }

    private static JsonObject context(JsonObject run,JsonObject sample,String binding){
        JsonObject snapshot=Json.object(run,"snapshot"),provider=Json.object(snapshot,"provider");JsonArray refs=new JsonArray();
        for(JsonElement element:Json.array(snapshot,"references")){
            JsonObject ref=element.getAsJsonObject(),value=pick(ref,List.of("id","version","resourceId","resourceVersion","annotations","note","classMap","sourceTemplate"));value.add("image",imageContext(ref));refs.add(value);
        }
        JsonObject fingerprint=Json.obj("fingerprintVersion","candidate-reuse-v2","projectId",run.get("projectId"),"input",imageContext(Json.object(sample,"asset")),
            "preprocessing",pick(sample,List.of("inputContract","inputTransform","preprocessing","coordinateTransform","baselineToInput","inputToBaseline")),
            "provider",pick(provider,List.of("id","revision","baseUrl","protocol","headers","extraParameters")),"credentialBindingVersion",binding,
            "model",run.get("model"),"classConvention",TaskTemplates.classConvention(Json.object(snapshot,"project")),"references",refs,
            "normalizationVersion",snapshot.get("normalizationVersion"),"parserVersion",snapshot.get("parserVersion"),"validatorVersion",snapshot.get("validatorVersion"),"requestContractVersion",snapshot.get("requestContractVersion"));
        // 宽松口径（reuseScope=hint）：提示词与模板提示只留在来源运行快照里（记录可查），不参与指纹与比对。
        if(!Json.str(run,"reuseScope","template").equals("hint")){fingerprint.add("prompt",run.get("prompt").deepCopy());fingerprint.add("template",TaskTemplates.semantic(Json.object(snapshot,"project")));}
        return fingerprint;
    }
    private static JsonObject imageContext(JsonObject asset){return Json.obj("contentHash",asset.get("contentHash"),"width",asset.get("width"),"height",asset.get("height"),"normalization",pick(Json.object(asset,"metadata"),List.of("normalizationVersion","inputVersion","sourceWidth","sourceHeight","exifOrientation","sourceToBaseline","colorSpace","alphaBackground","sourceHash","pngIccApplied","preprocessing","inputTransform","baselineToInput","inputToBaseline")));}
    private static JsonObject pick(JsonObject object,List<String> fields){JsonObject value=new JsonObject();for(String field:fields)if(object.has(field))value.add(field,object.get(field).deepCopy());return value;}

    private void verifyInputs(JsonObject run,JsonObject sample)throws Exception{
        verifyImage(Path.of(Json.required(sample,"inputPath")),Json.object(sample,"asset"));
        for(JsonElement element:Json.array(Json.object(run,"snapshot"),"references")){
            JsonObject reference=element.getAsJsonObject();Path file;
            if(reference.has("resourceId")){
                String relative=Json.required(reference,"referenceImage");Path part=Path.of(relative),base=store.root.resolve("resource-library");file=store.root.resolve(part).normalize();
                if(part.isAbsolute()||!file.startsWith(base)||!Files.isRegularFile(file)||!file.toRealPath().startsWith(base.toRealPath())||!base.toRealPath().startsWith(store.root.toRealPath()))throw new ApiError(409,"reuse_input_invalid","历史参考图片不在受管目录。");
            }else file=store.read(c->{JsonObject row=Store.one(c,"SELECT path FROM assets WHERE id=?",Json.required(reference,"id"));if(row==null)throw new ApiError(409,"reuse_input_invalid","参考素材已经失联。");return Path.of(Json.required(row,"path"));});
            verifyImage(file,reference);
        }
    }
    private static void verifyImage(Path file,JsonObject asset)throws Exception{
        String expected=Json.required(asset,"contentHash");if(!file.isAbsolute()||!expected.matches("[a-f0-9]{64}")||!Files.isRegularFile(file)||Files.size(file)>IMAGE_LIMIT||!Media.hash(file).equals(expected)||Json.integer(asset,"width",0)<1||Json.integer(asset,"height",0)<1)throw new ApiError(409,"reuse_input_invalid","复用输入缺失、内容变化或尺寸无效。");
    }

    private static JsonElement normalizeBody(JsonElement value,BodyState state)throws Exception{
        if(value.isJsonArray()){JsonArray out=new JsonArray();for(JsonElement child:value.getAsJsonArray())out.add(normalizeBody(child,state));return out;}
        if(!value.isJsonObject())return value.deepCopy();JsonObject object=value.getAsJsonObject(),out=new JsonObject();String type=Json.str(object,"type","");
        for(var entry:object.entrySet()){
            String key=entry.getKey();JsonElement child=entry.getValue();
            if(key.equals("image_url")&&Set.of("image_url","input_image").contains(type)){
                JsonObject image=child.isJsonObject()?child.getAsJsonObject().deepCopy():Json.obj("url",child);
                // 图片字段允许超过普通文本上限，摘要基于真正将发送的字节。
                JsonElement urlValue=image.get("url");if(urlValue==null||!urlValue.isJsonPrimitive()||!urlValue.getAsJsonPrimitive().isString())throw new ApiError(409,"reuse_request_invalid","请求图片地址无效。");
                String url=urlValue.getAsString();int comma=url.indexOf(',');if(comma<0||!url.substring(0,comma).matches("data:image/(png|jpeg);base64")||url.length()-comma-1>IMAGE_LIMIT*4/3+4)throw new ApiError(409,"reuse_request_invalid","复用请求必须包含已校验的内联图片。");
                byte[] bytes;try{bytes=Base64.getDecoder().decode(url.substring(comma+1));}catch(IllegalArgumentException invalid){throw new ApiError(409,"reuse_request_invalid","请求图片编码无效。");}
                state.totalImageBytes+=bytes.length;if(state.totalImageBytes>IMAGE_LIMIT||state.images>=state.expectedImages.size())throw new ApiError(409,"reuse_request_invalid","请求图片数量或大小与固定输入不一致。");
                String digest=hash(bytes);if(!digest.equals(Json.required(state.expectedImages.get(state.images++).getAsJsonObject(),"contentHash")))throw new ApiError(409,"reuse_request_invalid","请求图片与固定输入内容不一致。");
                image.remove("url");image.addProperty("mimeType",url.substring(5,comma-7));image.addProperty("sha256",digest);image.addProperty("bytes",bytes.length);out.add(key,image);
            }else if(key.equals("text")&&Set.of("text","input_text","output_text").contains(type)&&child.isJsonPrimitive()){
                String text=child.getAsString();JsonObject structured=null;try{JsonElement parsed=JsonParser.parseString(text);if(parsed.isJsonObject())structured=parsed.getAsJsonObject();}catch(JsonParseException ignored){}
                if(structured!=null&&Json.str(structured,"role","").equals("target")){
                    JsonObject asset=Json.object(state.sample,"asset");if(!Json.required(state.sample,"assetId").equals(Json.str(structured,"assetId",""))||Json.integer(structured,"width",0)!=Json.integer(asset,"width",0)||Json.integer(structured,"height",0)!=Json.integer(asset,"height",0))throw new ApiError(409,"reuse_request_invalid","请求目标与样本不一致。");structured.addProperty("assetId","$target");state.targets++;out.add(key,structured);
                }else if(structured!=null&&Json.str(structured,"role","").equals("reference")){
                    if(state.references>=state.expectedImages.size()-1)throw new ApiError(409,"reuse_request_invalid","请求参考数量与运行快照不一致。");
                    JsonObject ref=state.expectedImages.get(state.references++).getAsJsonObject();
                    if(!same(structured.get("assetId"),ref.get("id"))||!same(structured.get("width"),ref.get("width"))||!same(structured.get("height"),ref.get("height"))||!same(structured.get("annotations"),ref.get("annotations"))||!Json.str(structured,"note","").equals(Json.str(ref,"note",""))||!same(structured.get("resourceId"),ref.get("resourceId"))||!same(structured.get("resourceVersion"),ref.get("resourceVersion")))throw new ApiError(409,"reuse_request_invalid","请求参考标注或说明与运行快照不一致。");out.add(key,structured);
                }else if(structured!=null&&structured.has("instructions")&&structured.has("template")){
                    if(!Json.str(state.run,"reuseScope","template").equals("hint")&&(!same(structured.get("template"),TaskTemplates.semantic(Json.object(Json.object(state.run,"snapshot"),"project")))||!Objects.equals(structured.get("instructions"),state.run.get("prompt"))))throw new ApiError(409,"reuse_request_invalid","请求提示词或完整模板与运行快照不一致。");state.templates++;out.add(key,structured);
                }else out.add(key,child.deepCopy());
            }else out.add(key,normalizeBody(child,state));
        }
        return out;
    }
    private static String fingerprint(String context,String request)throws Exception{return hash("candidate-reuse-v1\n"+context+"\n"+request);}
    private static String hash(String text)throws Exception{return hash(text.getBytes(StandardCharsets.UTF_8));}
    private static String hash(byte[] bytes)throws Exception{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));}
    private static boolean same(JsonElement a,JsonElement b){return canonical(a).equals(canonical(b));}
    static String canonical(JsonElement value){
        if(value==null||value.isJsonNull())return "null";
        if(value.isJsonObject()){StringJoiner join=new StringJoiner(",","{","}");new TreeMap<>(value.getAsJsonObject().asMap()).forEach((key,child)->join.add(Json.GSON.toJson(key)+":"+canonical(child)));return join.toString();}
        if(value.isJsonArray()){StringJoiner join=new StringJoiner(",","[","]");for(JsonElement child:value.getAsJsonArray())join.add(canonical(child));return join.toString();}
        JsonPrimitive primitive=value.getAsJsonPrimitive();if(primitive.isNumber())return primitive.getAsBigDecimal().stripTrailingZeros().toPlainString();return primitive.toString();
    }
}
