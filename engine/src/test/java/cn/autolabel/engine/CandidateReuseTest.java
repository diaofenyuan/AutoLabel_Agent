package cn.autolabel.engine;

import com.google.gson.*;
import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.nio.file.*;
import java.time.Instant;
import java.util.*;
import java.util.function.Consumer;

public final class CandidateReuseTest {
    private static int checks;
    private static final String BINDING="11111111-1111-4111-8111-111111111111",OTHER_BINDING="22222222-2222-4222-8222-222222222222";
    private interface Action{void run()throws Exception;}
    private record Fixture(Store store,CandidateReuse reuse,JsonObject run,JsonObject row,JsonObject sourceRun,JsonObject sourceRow,String assetId,String referenceId,Path input,Path reference,String versionId,long completed){}
    private static void check(boolean condition,String message){checks++;if(!condition)throw new AssertionError(message);}
    private static void rejects(String code,Action action)throws Exception{try{action.run();throw new AssertionError("Expected "+code);}catch(ApiError error){check(error.code.equals(code),"Expected "+code+", got "+error.code);}}

    public static void main(String[] args)throws Exception{
        Path root=Files.createTempDirectory("autolabel-reuse-test-");
        try(Store store=new Store(root)){Fixture fixture=fixture(store);basic(fixture);fingerprints(fixture);invalidSources(fixture);}
        System.out.println("Candidate reuse: "+checks+" checks passed; isolated data: "+root);
    }

    private static Fixture fixture(Store store)throws Exception{
        Projects projects=new Projects(store);JsonObject project=projects.create(Json.obj("name","复用夹具","taskType","detect","classes",Json.arr(Json.obj("id","item","name","物品","color","#4488ff")),
            "settings",Json.obj("attributes",Json.arr(Json.obj("name","材质")),"rules","只标完整物品","occlusionRules","遮挡仍标可见框","blurRules","模糊交人工","keypointConnections",new JsonArray())));
        Path input=store.root.resolve("fixture-input.png"),reference=store.root.resolve("fixture-reference.png");image(input,320,240,17);image(reference,32,24,18);
        String pid=Json.required(project,"id"),aid=importOne(projects,pid,input),ref=importOne(projects,pid,reference);projects.save(Json.obj("assetId",ref,"baseVersion",0,"annotations",Json.arr(box(1)),"confirm",true));
        JsonObject asset=projects.asset(aid),referenceAsset=projects.asset(ref);referenceAsset.addProperty("note","参考说明");referenceAsset.addProperty("inputPath",projects.path(ref).toString());
        JsonObject provider=Json.obj("id","fixture-provider","revision",1,"baseUrl","https://example.invalid/v1","protocol","chat-completions","headers",Json.obj("X-Fixture","local"),"extraParameters",Json.obj("temperature",0));
        JsonObject snapshot=Json.obj("project",project,"provider",provider,"references",Json.arr(referenceAsset),"parserVersion","annotations-v1","validatorVersion",TaskTemplates.VALIDATOR_VERSION,"requestContractVersion",TaskTemplates.REQUEST_CONTRACT_VERSION,"normalizationVersion",Media.NORMALIZATION_VERSION,"credentialBindingVersion",BINDING);
        JsonObject sourceRun=Json.obj("id","source-run","projectId",pid,"status","running","model","fixture-model","prompt","按完整模板标注。保留字符串 assetId。","snapshot",snapshot),run=sourceRun.deepCopy();run.addProperty("id","target-run");
        JsonObject sourceData=Json.obj("id","source-sample","assetId",aid,"asset",asset,"inputPath",projects.path(aid).toString(),"baseVersion",0),targetData=sourceData.deepCopy();targetData.addProperty("id","target-sample");
        JsonObject sourceRow=row(sourceRun,sourceData,0),targetRow=row(run,targetData,0);CandidateReuse reuse=new CandidateReuse(store);
        CandidateReuse.Prepared prepared=reuse.prepare(sourceRun,sourceRow,body(sourceRun,sourceRow),BINDING);check(prepared!=null,"source actual request can produce a fingerprint");
        long completed=System.currentTimeMillis()-20_000;JsonObject attempt=Json.obj("id","source-attempt","runId","source-run","sampleId","source-sample","assetId",aid,"providerId","fixture-provider","status","completed","model","fixture-model","completedAt",Instant.ofEpochMilli(completed).toString(),"response",Json.obj("model","fixture-model-2026","model_version","2026-09","system_fingerprint","fixture-system"));
        prepared.attemptFields().entrySet().forEach(entry->attempt.add(entry.getKey(),entry.getValue()));
        JsonObject candidate=asset.deepCopy();candidate.addProperty("version",1);candidate.addProperty("status","candidate");candidate.addProperty("source","api");candidate.addProperty("runId","source-run");candidate.addProperty("attemptId","source-attempt");candidate.add("annotations",Json.arr(box(2)));sourceData.addProperty("candidateVersion",1);
        String version=store.tx(c->{
            Store.update(c,"INSERT INTO providers(id,data) VALUES(?,?)",provider.get("id").getAsString(),provider);
            Store.update(c,"INSERT INTO runs(id,project_id,status,data) VALUES(?,?,?,?)","source-run",pid,"completed",sourceRun);Store.update(c,"INSERT INTO runs(id,project_id,status,data) VALUES(?,?,?,?)","target-run",pid,"running",run);
            Store.update(c,"INSERT INTO samples(id,run_id,asset_id,input_id,status,attempt_count,active_attempt,data) VALUES(?,?,?,?,?,?,?,?)","source-sample","source-run",aid,aid,"succeeded",1,"source-attempt",sourceData);
            Store.update(c,"INSERT INTO samples(id,run_id,asset_id,input_id,status,data) VALUES(?,?,?,?,?,?)","target-sample","target-run",aid,aid,"queued",targetData);
            Store.update(c,"INSERT INTO attempts(id,run_id,sample_id,group_id,status,data) VALUES(?,?,?,?,?,?)","source-attempt","source-run","source-sample","fixture-group","completed",attempt);
            Store.update(c,"INSERT INTO versions(asset_id,version,source,data,attempt_id,created_at) VALUES(?,?,?,?,?,?)",aid,1,"api",candidate,"source-attempt",Instant.ofEpochMilli(completed).toString());
            Store.update(c,"UPDATE assets SET data=? WHERE id=?",candidate,aid);Store.update(c,"INSERT INTO budgets(id,max_requests,used) VALUES('fixture-budget',10,1)");
            return Store.one(c,"SELECT id FROM versions WHERE attempt_id='source-attempt'").get("id").getAsString();
        });
        return new Fixture(store,reuse,run,targetRow,sourceRun,sourceRow,aid,ref,projects.path(aid),projects.path(ref),version,completed);
    }

    private static void basic(Fixture f)throws Exception{
        CandidateReuse.Prepared prepared=prepare(f,f.run,f.row);check(prepared!=null,"same semantics prepare reuse");
        check(body(f.run,f.row).toString().length()>100_000,"actual inline image exceeds ordinary short-text limit");
        CandidateReuse.Match match=f.reuse.find(prepared,System.currentTimeMillis());check(match!=null,"validated historical automatic candidate matches");
        check(Json.required(match.provenance(),"sourceAttemptId").equals("source-attempt")&&Json.integer(match.provenance(),"sourceCandidateVersion",0)==1,"match exposes source attempt and candidate version");
        check(Json.required(Json.object(match.provenance(),"sourceModelVersion"),"model_version").equals("2026-09"),"returned model version is preserved as reported");
        check(f.store.tx(c->f.reuse.revalidate(c,prepared,match))!=null,"shared transaction can revalidate the match");
        JsonObject counts=f.store.read(c->Store.one(c,"SELECT (SELECT COUNT(*) FROM attempts) AS attempts,(SELECT COUNT(*) FROM versions) AS versions,(SELECT used FROM budgets WHERE id='fixture-budget') AS used"));
        f.reuse.find(prepared,System.currentTimeMillis());f.store.tx(c->f.reuse.revalidate(c,prepared,match));
        JsonObject after=f.store.read(c->Store.one(c,"SELECT (SELECT COUNT(*) FROM attempts) AS attempts,(SELECT COUNT(*) FROM versions) AS versions,(SELECT used FROM budgets WHERE id='fixture-budget') AS used"));check(counts.equals(after),"helper never inserts attempts or candidates or changes budget");
        new Projects(f.store).save(Json.obj("assetId",f.assetId,"baseVersion",1,"annotations",Json.arr(box(3)),"confirm",true));
        check(f.reuse.find(prepared,System.currentTimeMillis())!=null&&f.store.tx(c->f.reuse.revalidate(c,prepared,match))!=null,"original automatic history remains reusable after later human confirmation");
        check(Json.str(new Projects(f.store).asset(f.assetId),"status","").equals("confirmed"),"read-only helper does not alter human confirmation");
        JsonObject old=f.run.deepCopy();Json.object(old,"snapshot").remove("requestContractVersion");check(prepare(f,old,f.row)==null,"old run without request contract is ineligible");
        for(String field:List.of("parserVersion","validatorVersion")){JsonObject altered=f.run.deepCopy();Json.object(altered,"snapshot").remove(field);check(prepare(f,altered,f.row)==null,"missing "+field+" is ineligible");}
        for(String field:List.of("force","evaluationOnly")){JsonObject altered=f.run.deepCopy();altered.addProperty(field,true);check(prepare(f,altered,f.row)==null,field+" bypasses reuse");}
        JsonObject disabled=f.run.deepCopy();disabled.addProperty("reuseEnabled",false);check(prepare(f,disabled,f.row)==null,"explicit disable bypasses reuse");
        JsonObject retried=f.row.deepCopy();retried.addProperty("attempt_count",1);check(prepare(f,f.run,retried)==null,"actual retry bypasses reuse");
        JsonObject unknownCount=f.row.deepCopy();unknownCount.remove("attempt_count");check(prepare(f,f.run,unknownCount)==null,"missing real attempt counter does not guess initial attempt");
        check(f.reuse.prepare(f.run,f.row,body(f.run,f.row),null)==null,"missing credential binding disables reuse");
        JsonObject missingBinding=f.run.deepCopy();Json.object(missingBinding,"snapshot").remove("credentialBindingVersion");Json.object(Json.object(missingBinding,"snapshot"),"provider").addProperty("credentialBindingVersion",BINDING);
        check(prepare(f,missingBinding,f.row)==null,"missing target snapshot binding cannot use provider or current-call binding");
        check(f.reuse.prepare(f.run,f.row,body(f.run,f.row),OTHER_BINDING)==null,"live binding mismatch with frozen run disables reuse");
        JsonObject expiry=f.run.deepCopy();expiry.addProperty("reuseMaxAgeSeconds",10);check(f.reuse.find(prepare(f,expiry,f.row),System.currentTimeMillis())==null,"expired original attempt misses");
        expiry.addProperty("reuseMaxAgeSeconds",60);check(f.reuse.find(prepare(f,expiry,f.row),System.currentTimeMillis())!=null,"candidate within lifetime matches");
        expiry.addProperty("reuseMaxAgeSeconds",0);rejects("reuse_age_invalid",()->prepare(f,expiry,f.row));
        check(f.reuse.find(prepared,f.completed-1)==null,"future source timestamp does not match");
    }

    private static void fingerprints(Fixture f)throws Exception{
        String base=prepare(f,f.run,f.row).fingerprint();
        changed(f,base,run->run.addProperty("prompt",Json.required(run,"prompt")+" "),"prompt whitespace");
        for(String field:List.of("attributes","rules","occlusionRules","blurRules","keypointNames","keypointConnections"))changed(f,base,run->Json.object(Json.object(Json.object(run,"snapshot"),"project"),"settings").add(field,Json.arr("改变规则")),"complete template "+field);
        changed(f,base,run->Json.array(Json.object(Json.object(run,"snapshot"),"project"),"classes").get(0).getAsJsonObject().addProperty("name","新类别含义"),"class meaning");
        for(String field:List.of("revision","baseUrl","protocol","headers","extraParameters"))changed(f,base,run->{JsonObject provider=Json.object(Json.object(run,"snapshot"),"provider");if(field.equals("revision"))provider.addProperty(field,2);else if(field.equals("headers")||field.equals("extraParameters"))provider.add(field,Json.obj("changed",1));else provider.addProperty(field,"changed");},"provider "+field);
        changed(f,base,run->run.addProperty("model","fixture-model-other"),"requested model");
        for(String field:List.of("note","version","resourceVersion","classMap","annotations"))changed(f,base,run->{JsonObject ref=Json.array(Json.object(run,"snapshot"),"references").get(0).getAsJsonObject();switch(field){case "note"->ref.addProperty(field,"新人工说明");case "version","resourceVersion"->ref.addProperty(field,9);case "classMap"->ref.add(field,Json.obj("original","item"));default->ref.add(field,Json.arr(box(2)));}},"reference "+field);
        for(String field:List.of("normalizationVersion","inputVersion","sourceToBaseline","alphaBackground")){
            JsonObject row=f.row.deepCopy(),asset=Json.object(data(row),"asset"),metadata=Json.object(asset,"metadata");if(field.equals("inputVersion"))metadata.addProperty(field,2);else if(field.equals("sourceToBaseline"))metadata.add(field,Json.arr(1,0,1,0,1,0));else metadata.addProperty(field,"changed");
            check(!base.equals(prepare(f,f.run,row).fingerprint()),"input semantics change invalidates "+field);
        }
        JsonObject changedBinding=f.run.deepCopy();Json.object(changedBinding,"snapshot").addProperty("credentialBindingVersion",OTHER_BINDING);check(!base.equals(f.reuse.prepare(changedBinding,f.row,body(changedBinding,f.row),OTHER_BINDING).fingerprint()),"new saved credential binding changes fingerprint");
        JsonObject operational=f.run.deepCopy();operational.addProperty("concurrency",30);operational.addProperty("requestsUsed",100);operational.addProperty("maxRequests",300);Json.object(operational,"snapshot").getAsJsonObject("project").addProperty("name","仅改展示名");check(base.equals(prepare(f,operational,f.row).fingerprint()),"nonsemantic display and budget changes keep fingerprint");
        JsonObject request=body(f.run,f.row);request.addProperty("temperature",0.5);check(!base.equals(f.reuse.prepare(f.run,f.row,request,BINDING).fingerprint()),"effective generation body is part of fingerprint");
        JsonObject mimeBody=body(f.run,f.row);JsonArray mimeContent=Json.array(Json.array(mimeBody,"messages").get(0).getAsJsonObject(),"content");JsonObject mimeImage=Json.object(mimeContent.get(mimeContent.size()-1).getAsJsonObject(),"image_url");mimeImage.addProperty("url",mimeImage.get("url").getAsString().replace("data:image/png;","data:image/jpeg;"));check(!base.equals(f.reuse.prepare(f.run,f.row,mimeBody,BINDING).fingerprint()),"declared request image MIME remains part of fingerprint");
        JsonObject normalBody=body(f.run,f.row),reordered=new JsonObject();List<String> keys=new ArrayList<>(normalBody.keySet());Collections.reverse(keys);for(String key:keys)reordered.add(key,normalBody.get(key));check(base.equals(f.reuse.prepare(f.run,f.row,reordered,BINDING).fingerprint()),"JSON key insertion order is normalized");
        JsonObject responseRun=f.run.deepCopy();Json.object(Json.object(responseRun,"snapshot"),"provider").addProperty("protocol","responses");JsonArray responseContent=new JsonArray();
        for(JsonElement element:Json.array(Json.array(normalBody,"messages").get(0).getAsJsonObject(),"content")){JsonObject part=element.getAsJsonObject();if(Json.str(part,"type","").equals("text"))responseContent.add(Json.obj("type","input_text","text",part.get("text")));else responseContent.add(Json.obj("type","input_image","image_url",Json.object(part,"image_url").get("url")));}
        JsonObject responseBody=Json.obj("model",f.run.get("model"),"input",Json.arr(Json.obj("role","user","content",responseContent)),"stream",false,"text",Json.obj("format",Json.obj("type","json_object")));CandidateReuse.Prepared responsePrepared=f.reuse.prepare(responseRun,f.row,responseBody,BINDING);check(responsePrepared!=null&&!base.equals(responsePrepared.fingerprint()),"Responses request image and text parts are supported and protocol-specific");
        JsonObject oldBody=body(f.run,f.row);JsonObject first=Json.array(Json.array(oldBody,"messages").get(0).getAsJsonObject(),"content").get(0).getAsJsonObject();first.addProperty("text",Json.obj("instructions",f.run.get("prompt"),"taskType","detect").toString());check(f.reuse.prepare(f.run,f.row,oldBody,BINDING)==null,"legacy partial template body cannot get a new fingerprint");
        JsonObject wrongBody=body(f.run,f.row);JsonArray content=Json.array(Json.array(wrongBody,"messages").get(0).getAsJsonObject(),"content");content.set(content.size()-1,imagePart(f.reference));rejects("reuse_request_invalid",()->f.reuse.prepare(f.run,f.row,wrongBody,BINDING));
        JsonObject otherAsset=data(f.row).deepCopy(),asset=Json.object(otherAsset,"asset");asset.addProperty("id","same-content-new-asset");otherAsset.addProperty("assetId","same-content-new-asset");JsonObject row=row(f.run,otherAsset,0);check(base.equals(prepare(f,f.run,row).fingerprint()),"same-project identical image can match across target asset identities");
    }

    private static void invalidSources(Fixture f)throws Exception{
        CandidateReuse.Prepared prepared=prepare(f,f.run,f.row);CandidateReuse.Match match=f.reuse.find(prepared,System.currentTimeMillis());
        for(String field:List.of("reuseFingerprint","reuseContextHash","reuseRequestHash","parserVersion","validatorVersion","requestContractVersion","credentialBindingVersion"))withDocument(f,"attempts","source-attempt",value->value.remove(field),()->check(f.reuse.find(prepared,System.currentTimeMillis())==null,"historical attempt missing "+field+" misses"));
        withDocument(f,"attempts","source-attempt",value->value.addProperty("sampleId","wrong-sample"),()->check(f.reuse.find(prepared,System.currentTimeMillis())==null,"attempt JSON association mismatch misses"));
        withDocument(f,"attempts","source-attempt",value->value.addProperty("providerId","wrong-provider"),()->check(f.reuse.find(prepared,System.currentTimeMillis())==null,"attempt provider association mismatch misses"));
        withDocument(f,"runs","source-run",value->value.addProperty("id","wrong-run"),()->check(f.reuse.find(prepared,System.currentTimeMillis())==null,"run JSON identity mismatch misses"));
        withDocument(f,"runs","source-run",value->{Json.object(value,"snapshot").remove("credentialBindingVersion");Json.object(Json.object(value,"snapshot"),"provider").addProperty("credentialBindingVersion",BINDING);},()->check(f.reuse.find(prepared,System.currentTimeMillis())==null,"missing source snapshot binding cannot use provider or completed-attempt binding"));
        withDocument(f,"attempts","source-attempt",value->value.addProperty("status","unknown"),()->check(f.reuse.find(prepared,System.currentTimeMillis())==null,"unknown result misses despite completed column"));
        withDocument(f,"versions",f.versionId,value->value.addProperty("source","manual"),()->check(f.reuse.find(prepared,System.currentTimeMillis())==null,"manual version cannot be a cache source"));
        withDocument(f,"versions",f.versionId,value->value.add("reuse",Json.obj("sourceAttemptId","earlier")),()->check(f.reuse.find(prepared,System.currentTimeMillis())==null,"previous reuse cannot extend source lifetime through a chain"));
        withDocument(f,"versions",f.versionId,value->value.add("annotations",Json.arr(box(-3))),()->check(f.reuse.find(prepared,System.currentTimeMillis())==null,"source geometry is revalidated"));
        withDocument(f,"samples","source-sample",value->value.addProperty("candidateVersion",99),()->check(f.reuse.find(prepared,System.currentTimeMillis())==null,"sample must point at this exact candidate version"));
        withDocument(f,"samples","source-sample",value->value.addProperty("candidateVersion",1.5),()->check(f.reuse.find(prepared,System.currentTimeMillis())==null,"fractional candidate association is not truncated to a valid version"));
        withDocument(f,"versions",f.versionId,value->value.add("annotations",Json.arr(box(4))),()->check(f.store.tx(c->f.reuse.revalidate(c,prepared,match))==null,"changed candidate between find and transaction is rejected"));
        withDocument(f,"samples","target-sample",value->value.addProperty("assetId","wrong-target"),()->check(f.store.tx(c->f.reuse.revalidate(c,prepared,match))==null,"target data identity is rechecked inside the transaction"));
        withDocument(f,"runs","target-run",value->Json.object(value,"snapshot").addProperty("credentialBindingVersion",OTHER_BINDING),()->check(f.store.tx(c->f.reuse.revalidate(c,prepared,match))==null,"frozen binding change after lookup is rejected"));
        withDocument(f,"runs","target-run",value->Json.object(value,"snapshot").remove("credentialBindingVersion"),()->check(f.store.tx(c->f.reuse.revalidate(c,prepared,match))==null,"transaction rejects a target whose persisted binding was removed after lookup"));
        withDocument(f,"projects",Json.required(f.run,"projectId"),value->Json.array(value,"classes").get(0).getAsJsonObject().addProperty("name","同 ID 新语义"),()->check(f.store.tx(c->f.reuse.revalidate(c,prepared,match))==null,"current class meaning change is rejected even when geometry remains valid"));
        byte[] bytes=Files.readAllBytes(f.input);Files.writeString(f.input,"changed fixture baseline");check(f.reuse.find(prepared,System.currentTimeMillis())==null,"changed historical image misses");rejects("reuse_input_invalid",()->prepare(f,f.run,f.row));Files.write(f.input,bytes);
        Path missing=f.store.root.resolve("missing-source.png");withDocument(f,"samples","source-sample",value->value.addProperty("inputPath",missing.toString()),()->check(f.reuse.find(prepared,System.currentTimeMillis())==null,"missing fixed historical input misses"));
        byte[] reference=Files.readAllBytes(f.reference);Files.writeString(f.reference,"changed fixture reference");check(f.reuse.find(prepared,System.currentTimeMillis())==null,"changed historical reference misses");Files.write(f.reference,reference);
        f.store.tx(c->{Store.update(c,"UPDATE samples SET status='cancelled' WHERE id='target-sample'");return null;});check(f.store.tx(c->f.reuse.revalidate(c,prepared,match))==null,"transaction refuses an already cancelled target");
    }

    private static void withDocument(Fixture f,String table,String id,Consumer<JsonObject> mutation,Action action)throws Exception{
        JsonObject original=f.store.read(c->Json.parse(Store.one(c,"SELECT data FROM "+table+" WHERE id=?",id).get("data").getAsString())),changed=original.deepCopy();mutation.accept(changed);
        f.store.tx(c->{Store.update(c,"UPDATE "+table+" SET data=? WHERE id=?",changed,id);return null;});try{action.run();}finally{f.store.tx(c->{Store.update(c,"UPDATE "+table+" SET data=? WHERE id=?",original,id);return null;});}
    }
    private static void changed(Fixture f,String base,Consumer<JsonObject> mutation,String label)throws Exception{JsonObject run=f.run.deepCopy();mutation.accept(run);check(!base.equals(prepare(f,run,f.row).fingerprint()),label+" changes fingerprint");}
    private static CandidateReuse.Prepared prepare(Fixture f,JsonObject run,JsonObject row)throws Exception{return f.reuse.prepare(run,row,body(run,row),BINDING);}
    private static JsonObject row(JsonObject run,JsonObject sample,int attempts){return Json.obj("id",sample.get("id"),"run_id",run.get("id"),"asset_id",sample.get("assetId"),"attempt_count",attempts,"data",sample.deepCopy());}
    private static JsonObject data(JsonObject row){return row.getAsJsonObject("data");}
    private static JsonObject body(JsonObject run,JsonObject row)throws Exception{
        JsonObject sample=data(row),snapshot=Json.object(run,"snapshot");JsonArray content=Json.arr(Json.obj("type","text","text",Json.obj("instructions",run.get("prompt"),"template",TaskTemplates.semantic(Json.object(snapshot,"project")),"outputContract","fixture annotation JSON").toString()));
        for(JsonElement element:Json.array(snapshot,"references")){JsonObject ref=element.getAsJsonObject();content.add(Json.obj("type","text","text",Json.obj("role","reference","assetId",ref.get("id"),"width",ref.get("width"),"height",ref.get("height"),"annotations",ref.get("annotations"),"note",Json.str(ref,"note",""),"resourceId",ref.get("resourceId"),"resourceVersion",ref.get("resourceVersion")).toString()));Path path=Path.of(Json.required(ref,"inputPath"));content.add(imagePart(path));}
        JsonObject asset=Json.object(sample,"asset");content.add(Json.obj("type","text","text",Json.obj("role","target","assetId",asset.get("id"),"width",asset.get("width"),"height",asset.get("height")).toString()));content.add(imagePart(Path.of(Json.required(sample,"inputPath"))));
        return Json.obj("model",run.get("model"),"messages",Json.arr(Json.obj("role","user","content",content)),"temperature",0,"stream",false,"response_format",Json.obj("type","json_object"));
    }
    private static JsonObject imagePart(Path path)throws Exception{return Json.obj("type","image_url","image_url",Json.obj("url","data:image/png;base64,"+Base64.getEncoder().encodeToString(Files.readAllBytes(path))));}
    private static void image(Path path,int width,int height,int seed)throws Exception{BufferedImage image=new BufferedImage(width,height,BufferedImage.TYPE_INT_RGB);Random random=new Random(seed);for(int y=0;y<height;y++)for(int x=0;x<width;x++)image.setRGB(x,y,random.nextInt());ImageIO.write(image,"png",path.toFile());}
    private static String importOne(Projects projects,String project,Path image){return Json.array(projects.importAssets(Json.obj("projectId",project,"paths",Json.arr(image.toString()),"mode","copy")),"assetIds").get(0).getAsString();}
    private static JsonObject box(int x){return Json.obj("id","object-one","classId","item","type","detect","bbox",Json.obj("x",x,"y",1,"width",10,"height",10));}
}
