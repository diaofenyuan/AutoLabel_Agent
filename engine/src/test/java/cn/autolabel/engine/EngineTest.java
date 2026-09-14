package cn.autolabel.engine;

import com.google.gson.*;
import com.sun.net.httpserver.HttpServer;
import javax.imageio.ImageIO;
import java.awt.Color;
import java.awt.image.BufferedImage;
import java.io.*;
import java.net.*;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

public final class EngineTest {
    static int assertions;
    static Path root;
    static void check(boolean ok,String message){assertions++;if(!ok)throw new AssertionError(message);}
    static JsonObject obj(Object value){return ((JsonElement)value).getAsJsonObject();}
    static JsonObject command(Engine e,String command,JsonObject payload)throws Exception{return obj(e.command(command,payload));}
    static JsonObject command(Engine e,String command)throws Exception{return command(e,command,new JsonObject());}
    static void error(String code,Runnable runnable){try{runnable.run();throw new AssertionError("Expected "+code);}catch(ApiError e){check(e.code.equals(code),"Expected "+code+" got "+e.code);}}
    public static void main(String[] args)throws Exception{
        root=Path.of("engine/build/verification").toAbsolutePath().resolve("run-"+System.currentTimeMillis());Files.createDirectories(root);
        if(args.length>0&&args[0].equals("training-datasets")){TrainingDatasetsTest.run(root);System.out.println("PASS "+assertions+" training dataset assertions; synthetic fixtures and local files only.\nVERIFICATION_DIR="+root);return;}
        if(args.length>0&&args[0].equals("materials-root")){MaterialsRootTest.run(root);System.out.println("PASS "+assertions+" materials root assertions; synthetic fixtures and local files only.\nVERIFICATION_DIR="+root);return;}
        if(args.length>0&&args[0].equals("training-root")){TrainingRootTest.run(root);System.out.println("PASS "+assertions+" training root assertions; synthetic fixtures and local files only.\nVERIFICATION_DIR="+root);return;}
        if(args.length>0&&args[0].equals("dataset-versions")){DatasetVersionsTest.run(root);System.out.println("PASS "+assertions+" dataset version assertions; synthetic fixtures and local files only.\nVERIFICATION_DIR="+root);return;}
        if(args.length>0&&args[0].equals("view-integration")){ViewRunIntegrationTest.run(root);System.out.println("PASS "+assertions+" view integration assertions.\nVERIFICATION_DIR="+root);return;}
        if(args.length>0&&args[0].equals("local-integration")){LocalRunIntegrationTest.run(root);System.out.println("PASS "+assertions+" local run integration assertions.\nVERIFICATION_DIR="+root);return;}
        if(args.length>0&&args[0].equals("reuse-integration")){ReuseIntegrationTest.run(root);System.out.println("PASS "+assertions+" reuse integration assertions; local real request and provenance checks only.\nVERIFICATION_DIR="+root);return;}
        if(args.length>0&&args[0].equals("flow-integration")){FlowIntegrationTest.run(root);System.out.println("PASS "+assertions+" flow integration assertions; fixed artifacts and local requests only.\nVERIFICATION_DIR="+root);return;}
        if(args.length>0&&args[0].equals("flow-foundation")){FlowFoundationTest.run(root);System.out.println("PASS "+assertions+" flow foundation assertions; local requests and transaction recovery only.\nVERIFICATION_DIR="+root);return;}
        if(args.length>0&&args[0].equals("backup-integration")){BackupIntegrationTest.run(root);System.out.println("PASS "+assertions+" backup integration assertions; local file and ownership verification only.\nVERIFICATION_DIR="+root);return;}
        if(args.length>0&&args[0].equals("data-maintenance")){DataMaintenanceTest.run(root);System.out.println("PASS "+assertions+" data maintenance assertions; local protocol and recovery only.\nVERIFICATION_DIR="+root);return;}
        if(args.length>0&&args[0].equals("manual")){ManualChainTest.run(root);System.out.println("PASS "+assertions+" manual-chain assertions.");return;}
        if(args.length>0&&args[0].equals("evaluation")){EvaluationTest.run(root);System.out.println("PASS "+assertions+" evaluation assertions; synthetic known-answer fixtures only.\nVERIFICATION_DIR="+root);return;}
        if(args.length>0&&args[0].equals("capabilities")){CapabilityTest.run(root);System.out.println("PASS "+assertions+" capability assertions; local protocol fixtures only.\nVERIFICATION_DIR="+root);return;}
        if(args.length>0&&args[0].equals("cost-rerun")){CostRerunTest.run(root);System.out.println("PASS "+assertions+" cost and rerun assertions; local protocol fixtures only.\nVERIFICATION_DIR="+root);return;}
        if(args.length>0&&args[0].equals("five-task")){MultiTaskEvaluationTest.run(root);System.out.println("PASS "+assertions+" five-task evaluation assertions; independent geometry and local protocol only.\nVERIFICATION_DIR="+root);return;}
        if(args.length>0&&args[0].equals("resource-integration")){ResourceIntegrationTest.run(root);System.out.println("PASS "+assertions+" resource integration assertions; local protocol only.\nVERIFICATION_DIR="+root);return;}
        if(args.length==0||!args[0].equals("transport")){mediaAndExports();queueAndProtocols();DatasetVersionsTest.run(root.resolve("dataset-versions"));httpProcess();}transportLimits();iccProfile();cancelWaiting();System.out.println("PASS "+assertions+" assertions; controlled local protocol verification only.");System.out.println("VERIFICATION_DIR="+root);
    }
    static JsonObject project(Engine e,String type)throws Exception{return command(e,"project.create",Json.obj("name","测试 "+type,"taskType",type,"classes",Json.arr(Json.obj("id","item","name","物品","color","#3b82f6")),"settings",Json.obj("keypointNames",Json.arr("left","right"))));}
    static JsonObject label(String type){JsonObject a=Json.obj("id",Json.id(),"type",type,"classId","item");if(Set.of("detect","pose","obb").contains(type))a.add("bbox",Json.obj("x",200,"y",180,"width",200,"height",120));
        if(type.equals("obb"))a.addProperty("rotation",20);if(type.equals("segment"))a.add("points",Json.arr(Json.obj("x",200,"y",180),Json.obj("x",400,"y",180),Json.obj("x",380,"y",300),Json.obj("x",220,"y",280)));
        if(type.equals("pose"))a.add("keypoints",Json.arr(Json.obj("name","left","x",220,"y",220,"visibility",2),Json.obj("name","right","x",360,"y",220,"visibility",1)));return a;}
    static JsonArray importSamples(Engine e,String pid,int count)throws Exception{Path dir=root.resolve("input-"+pid);Files.createDirectories(dir);JsonArray files=new JsonArray();for(int i=0;i<count;i++){Path path=dir.resolve("image-"+i+".png");Media.sample(path,i);files.add(path.toString());}
        JsonObject result=command(e,"asset.import",Json.obj("projectId",pid,"paths",files));check(Json.integer(result,"imported",0)==count,"import sample count");return Json.array(result,"assetIds");}
    static void mediaAndExports()throws Exception{
        Path data=root.resolve("manual-data");String persistedAsset;JsonArray exportDirectories=new JsonArray();
        try(Engine e=new Engine(data)){
            JsonObject example=command(e,"project.example",new JsonObject());JsonObject exampleAssets=command(e,"asset.list",Json.obj("projectId",example.get("id")));check(Json.number(exampleAssets,"total",0)>0,"offline example available");
            check(Json.str(Json.array(exampleAssets,"items").get(0).getAsJsonObject(),"source","").equals("preset_manual"),"preset origin marked");
            for(String type:List.of("detect","pose","obb","segment","classify")){
                JsonObject p=project(e,type);String pid=Json.required(p,"id");JsonArray ids=importSamples(e,pid,3);
                for(JsonElement id:ids)command(e,"annotation.save",Json.obj("assetId",id,"baseVersion",0,"annotations",Json.arr(label(type)),"confirm",true));
                JsonObject preflight=command(e,"export.preflight",Json.obj("projectId",pid));check(Json.bool(Json.object(preflight,"summary"),"canExport",false),"preflight "+type);
                JsonObject exported=command(e,"export.create",Json.obj("projectId",pid,"outputDir",root.resolve("datasets").toString()));check(Json.required(exported,"status").equals("completed"),"export "+type);
                Path destination=Path.of(Json.required(exported,"path"));exportDirectories.add(Json.obj("type",type,"path",destination.toString()));JsonObject manifest=Json.parse(Files.readString(destination.resolve("manifest.json")));
                check(Json.array(manifest,"assets").size()==3,"manifest count "+type);for(JsonElement item:Json.array(manifest,"assets")){JsonObject a=item.getAsJsonObject();check(Media.hash(destination.resolve(Json.required(a,"image"))).equals(Json.required(a,"contentHash")),"export immutable image "+type);}
                if(!type.equals("classify"))check(!Files.readString(destination.resolve("data.yaml")).contains("path:"),"portable YAML root "+type);
                String aid=ids.get(0).getAsString();JsonObject asset=e.projects.asset(aid);JsonArray draft=Json.arr(label(type));command(e,"annotation.draft",Json.obj("assetId",aid,"baseVersion",1,"annotations",draft));
                check(e.projects.asset(aid).has("draft"),"draft stored "+type);error("annotation_version_conflict",()->e.projects.save(Json.obj("assetId",aid,"baseVersion",0,"annotations",draft)));
                command(e,"annotation.save",Json.obj("assetId",aid,"baseVersion",1,"annotations",draft));check(!e.projects.asset(aid).has("draft"),"save clears draft "+type);
                check(Files.readString(destination.resolve("manifest.json")).equals(manifest.toString()),"manifest unaffected by later edits "+type);
                error("asset_selection_empty",()->e.exporter.preflight(Json.obj("projectId",pid,"assetIds",new JsonArray())));
            }
            Files.writeString(root.resolve("exports.json"),exportDirectories.toString());
            JsonObject p=project(e,"detect");String pid=Json.required(p,"id");JsonArray ids=importSamples(e,pid,1);persistedAsset=ids.get(0).getAsString();
            check(!Json.bool(Json.object(e.exporter.preflight(Json.obj("projectId",pid)),"summary"),"canExport",true),"unlabeled is not negative");
            e.projects.draft(Json.obj("assetId",persistedAsset,"baseVersion",0,"annotations",Json.arr(label("detect"))));
            Path alpha=root.resolve("alpha.png");BufferedImage image=new BufferedImage(2,3,BufferedImage.TYPE_INT_ARGB);image.setRGB(0,0,0x00ff0000);image.setRGB(1,2,0xff00ff00);ImageIO.write(image,"png",alpha.toFile());
            Media.Normalized normalized=e.projects.media.normalize(alpha,Json.id(),"#ffffff",false);BufferedImage actual=ImageIO.read(normalized.path().toFile());check((actual.getRGB(0,0)&0xffffff)==0xffffff,"alpha background flattened");check(!actual.getColorModel().hasAlpha(),"baseline opaque sRGB");
            for(int orientation=1;orientation<=8;orientation++){
                Path jpg=root.resolve("exif-"+orientation+".jpg");writeExif(jpg,orientation);Media.Normalized n=e.projects.media.normalize(jpg,Json.id(),"#ffffff",false);check(Json.integer(n.metadata(),"exifOrientation",0)==orientation,"EXIF detected "+orientation);check(n.width()==(orientation>=5?20:40)&&n.height()==(orientation>=5?40:20),"EXIF dimensions "+orientation);
                BufferedImage normalizedImage=ImageIO.read(n.path().toFile());int redX=switch(orientation){case 2,3->39;case 6,7->19;default->0;},redY=switch(orientation){case 3,4->19;case 7,8->39;default->0;};Color red=new Color(normalizedImage.getRGB(redX,redY));check(red.getRed()>red.getBlue()+100,"EXIF mirrored/rotated pixel "+orientation);
            }
            JsonObject fake=e.projects.asset(persistedAsset);JsonObject obbProject=p.deepCopy();obbProject.addProperty("taskType","obb");JsonObject obb=label("obb");obb.add("points",Json.arr(Json.obj("x",1,"y",1),Json.obj("x",20,"y",2),Json.obj("x",19,"y",30),Json.obj("x",3,"y",27)));error("annotation_invalid",()->Annotations.validate(Json.arr(obb),fake,obbProject));
            check(e.store.read(c->Store.one(c,"PRAGMA journal_mode").get("journal_mode").getAsString()).equals("wal"),"SQLite WAL mode");
        }
        try(Engine e=new Engine(data)){check(e.projects.asset(persistedAsset).has("draft"),"draft survives restart");check(Json.integer(e.projects.asset(persistedAsset),"version",-1)==0,"draft is not formal version");}
    }
    static void writeExif(Path path,int orientation)throws Exception{
        BufferedImage image=new BufferedImage(40,20,BufferedImage.TYPE_INT_RGB);var g=image.createGraphics();g.setColor(Color.BLUE);g.fillRect(0,0,40,20);g.setColor(Color.RED);g.fillRect(0,0,12,12);g.dispose();ByteArrayOutputStream jpeg=new ByteArrayOutputStream();ImageIO.write(image,"jpeg",jpeg);
        byte[] exif={0x45,0x78,0x69,0x66,0,0,0x49,0x49,0x2a,0,8,0,0,0,1,0,0x12,1,3,0,1,0,0,0,(byte)orientation,0,0,0,0,0,0,0};
        ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] bytes=jpeg.toByteArray();out.write(bytes,0,2);out.write(0xff);out.write(0xe1);out.write((exif.length+2)>>8);out.write((exif.length+2)&255);out.write(exif);out.write(bytes,2,bytes.length-2);Files.write(path,out.toByteArray());
    }
    static final class Mock implements AutoCloseable {
        final HttpServer server;final AtomicInteger active=new AtomicInteger(),maxActive=new AtomicInteger(),calls=new AtomicInteger();
        final List<JsonObject> bodies=new CopyOnWriteArrayList<>();final AtomicBoolean retryOnce=new AtomicBoolean();volatile boolean slow;
        Mock()throws Exception{server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),20);server.setExecutor(Executors.newVirtualThreadPerTaskExecutor());server.createContext("/v1/",exchange->{int concurrency=active.incrementAndGet();maxActive.accumulateAndGet(concurrency,Math::max);
            try{String path=exchange.getRequestURI().getPath();if(path.endsWith("/models")){respond(exchange,200,Json.obj("data",Json.arr(Json.obj("id","local-protocol-fixture"))));return;}
                calls.incrementAndGet();JsonObject body=Json.parse(new String(exchange.getRequestBody().readAllBytes(),StandardCharsets.UTF_8));bodies.add(body);if(retryOnce.compareAndSet(true,false)){exchange.getResponseHeaders().set("Retry-After","1");respond(exchange,429,Json.obj("error","controlled rate limit"));return;}
                String assetId=target(body);Thread.sleep(slow?2200:assetId==null?40:assetId.hashCode()%2==0?500:250);String content=assetId==null?"OK":Json.obj("assetId",assetId,"annotations",Json.arr(label("detect"))).toString();JsonObject usage=Json.obj("input_tokens",25,"output_tokens",15);
                if(path.endsWith("/responses"))respond(exchange,200,Json.obj("status","completed","output",Json.arr(Json.obj("type","message","content",Json.arr(Json.obj("type","output_text","text",content)))),"usage",usage));
                else respond(exchange,200,Json.obj("choices",Json.arr(Json.obj("finish_reason","stop","message",Json.obj("role","assistant","content",content))),"usage",usage));
            }catch(Exception ignored){}finally{active.decrementAndGet();exchange.close();}});server.start();}
        String url(){return "http://127.0.0.1:"+server.getAddress().getPort()+"/v1";}
        String target(JsonObject body){JsonArray messages=body.has("messages")?Json.array(body,"messages"):Json.array(body,"input");for(JsonElement m:messages)for(JsonElement part:Json.array(m.getAsJsonObject(),"content")){JsonObject p=part.getAsJsonObject();String t=Json.str(p,"text","");if(t.startsWith("{")&&t.contains("\"role\":\"target\""))return Json.required(Json.parse(t),"assetId");}return null;}
        static void respond(com.sun.net.httpserver.HttpExchange e,int status,JsonObject body)throws IOException{byte[] b=body.toString().getBytes(StandardCharsets.UTF_8);e.getResponseHeaders().set("Content-Type","application/json");e.sendResponseHeaders(status,b.length);e.getResponseBody().write(b);}
        public void close(){server.stop(0);}
    }
    static JsonObject provider(Engine e,Mock mock,String protocol)throws Exception{JsonObject p=e.providers.save(Json.obj("name","受控本地协议 "+protocol,"baseUrl",mock.url(),"protocol",protocol,"requestsPerMinute",60000,"concurrency",2,"timeoutMs",1000,"maxRetries",1,"quotaGroupId","local-shared-test"));e.providers.credential(Json.obj("providerId",p.get("id"),"key","fixture-secret-never-persist"));return p;}
    static JsonObject waitRun(Engine e,String id,int millis)throws Exception{long end=System.currentTimeMillis()+millis;JsonObject run;do{run=e.runs.get(id);String status=Json.required(run,"status");if(!status.equals("running"))return run;Thread.sleep(80);}while(System.currentTimeMillis()<end);throw new AssertionError("run timeout: "+run);}
    static void queueAndProtocols()throws Exception{
        Path data=root.resolve("queue-data");String recoverRun;
        try(Mock mock=new Mock()){
            try(Engine e=new Engine(data)){
                JsonObject chat=provider(e,mock,"chat-completions"),responses=provider(e,mock,"responses"),p=project(e,"detect");String pid=Json.required(p,"id");JsonArray ids=importSamples(e,pid,8);
                JsonObject draftAsset=e.projects.asset(ids.get(0).getAsString());e.projects.draft(Json.obj("assetId",ids.get(0),"baseVersion",0,"annotations",Json.arr(label("detect"))));
                JsonArray first=new JsonArray(),second=new JsonArray();for(int i=0;i<8;i++)(i<4?first:second).add(ids.get(i));
                JsonObject r1=e.runs.create(Json.obj("projectId",pid,"providerId",chat.get("id"),"model","local-protocol-fixture","prompt","identify items","assetIds",first,"concurrency",4,"maxRequests",4));
                JsonObject r2=e.runs.create(Json.obj("projectId",pid,"providerId",responses.get("id"),"model","local-protocol-fixture","prompt","identify items","assetIds",second,"concurrency",4,"maxRequests",4));
                JsonObject done1=waitRun(e,Json.required(r1,"id"),20000),done2=waitRun(e,Json.required(r2,"id"),20000);check(Json.required(done1,"status").equals("completed"),"chat annotation completed: "+done1);check(Json.required(done2,"status").equals("completed"),"responses annotation completed");
                check(mock.maxActive.get()==2,"real HTTP concurrency shared limit=2, observed "+mock.maxActive.get());check(mock.calls.get()==8,"each sample sent once");check(Json.number(Json.object(done1,"statistics"),"succeeded",0)==4,"exclusive sample count");
                for(JsonElement aid:ids){JsonArray history=e.projects.history(aid.getAsString());check(history.size()==1,"one idempotent candidate per asset");JsonObject candidate=history.get(0).getAsJsonObject();check(Json.required(candidate,"id").equals(aid.getAsString()),"out-of-order asset association");}
                check(e.projects.asset(ids.get(0).getAsString()).has("draft"),"late AI protects draft");check(Json.integer(e.projects.asset(ids.get(0).getAsString()),"version",-1)==0,"AI did not overwrite draft's formal baseline");
                JsonObject bodyResponses=mock.bodies.stream().filter(b->b.has("input")).findFirst().orElseThrow();check(bodyResponses.toString().contains("input_image"),"responses input_image mapping");check(!bodyResponses.has("messages"),"responses uses input");
                JsonObject toolBody=e.providers.body(responses,"m",Json.arr(Json.obj("role","assistant","tool_calls",Json.arr(Json.obj("id","call-1","function",Json.obj("name","test","arguments","{}")))),Json.obj("role","tool","tool_call_id","call-1","content","done")),Json.arr(Json.obj("type","function","function",Json.obj("name","test","parameters",Json.obj("type","object")))),false);
                check(toolBody.toString().contains("function_call_output"),"responses tool result mapping");check(Json.array(toolBody,"tools").get(0).getAsJsonObject().has("name"),"responses tool flattened");
                JsonObject sessionPayload=Json.obj("providerId",chat.get("id"),"model","fixture","messages",Json.arr(Json.obj("role","user","content","Hello")),"sessionId","agent-budget-test","maxRequests",2);
                JsonObject agentReply=e.providers.chat(sessionPayload);check(Json.number(Json.object(agentReply,"budget"),"requestsUsed",0)==1,"Agent call persisted in shared scope");
                JsonObject scoped=e.runs.create(Json.obj("projectId",pid,"providerId",chat.get("id"),"model","fixture","prompt","label","assetIds",Json.arr(ids.get(6),ids.get(7)),"budgetScopeId","agent-budget-test","maxRequests",2));
                JsonObject scopedDone=waitRun(e,Json.required(scoped,"id"),10000);Thread.sleep(600);scopedDone=e.runs.get(Json.required(scoped,"id"));check(Json.number(scopedDone,"requestsUsed",0)==1,"only one remaining call after Agent");check(Json.number(Json.object(scopedDone,"budget"),"requestsUsed",0)==2,"shared scope includes Agent and annotation");
                error("budget_exhausted",()->e.providers.chat(sessionPayload));e.runs.control("cancel",Json.obj("runId",scoped.get("id")));
                JsonObject budget=e.runs.create(Json.obj("projectId",pid,"providerId",chat.get("id"),"model","fixture","prompt","label","assetIds",ids,"concurrency",8,"maxRequests",1));JsonObject paused=waitRun(e,Json.required(budget,"id"),10000);Thread.sleep(800);paused=e.runs.get(Json.required(budget,"id"));check(Json.required(paused,"status").equals("paused"),"budget pause");check(Json.number(paused,"requestsUsed",0)==1,"atomic last quota reservation");
                e.runs.control("resume",Json.obj("runId",budget.get("id"),"maxRequests",8));JsonObject resumed=waitRun(e,Json.required(budget,"id"),20000);check(Json.required(resumed,"status").equals("completed"),"budget increase resumes remaining");check(Json.number(resumed,"requestsUsed",0)==8,"budget total persisted");
                mock.retryOnce.set(true);JsonObject retry=e.runs.create(Json.obj("projectId",pid,"providerId",responses.get("id"),"model","fixture","prompt","label","assetIds",Json.arr(ids.get(1)),"maxRequests",2));JsonObject retried=waitRun(e,Json.required(retry,"id"),15000);check(Json.number(retried,"requestsUsed",0)==2,"retry consumes new request");check(Json.number(retried,"retries",0)==1,"retry counted separately");check(Json.required(retried,"status").equals("completed"),"429 bounded retry succeeds");
                mock.slow=true;JsonObject unknown=e.runs.create(Json.obj("projectId",pid,"providerId",chat.get("id"),"model","fixture","prompt","label","assetIds",Json.arr(ids.get(2)),"maxRequests",3));JsonObject unknownDone=waitRun(e,Json.required(unknown,"id"),10000);check(Json.number(Json.object(unknownDone,"statistics"),"unknown",0)==1,"timeout results unknown");check(Json.number(unknownDone,"requestsUsed",0)==1,"unknown not free and not auto retried");
                JsonObject interrupted=e.runs.create(Json.obj("projectId",pid,"providerId",responses.get("id"),"model","fixture","prompt","label","assetIds",Json.arr(ids.get(3))));recoverRun=Json.required(interrupted,"id");long until=System.currentTimeMillis()+5000;while(Json.number(e.runs.get(recoverRun),"requestsUsed",0)==0&&System.currentTimeMillis()<until)Thread.sleep(50);
                JsonArray events=e.store.read(c->Store.events(c,0,null,null,2000));long last=0;for(JsonElement event:events){long sequence=Json.number(event.getAsJsonObject(),"sequence",0);check(sequence>last,"events strictly ordered");last=sequence;}
                String persisted=e.store.read(c->Store.docs(c,"SELECT data FROM attempts")).toString();check(!persisted.contains("fixture-secret-never-persist"),"credentials not persisted");check(!persisted.contains("iVBOR"),"base64 images not duplicated in trace");
            }
            try(Engine e=new Engine(data)){JsonObject restored=e.runs.get(recoverRun);check(Json.number(restored,"requestsUsed",0)==1,"restart preserves charged request");check(Json.number(Json.object(restored,"statistics"),"unknown",0)==1,"restart preserves unknown");int calls=mock.calls.get();Thread.sleep(300);check(mock.calls.get()==calls,"restart does not resend unknown");}
        }
    }
    static void transportLimits()throws Exception{
        HttpServer server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),4);server.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
        server.createContext("/stall/chat/completions",e->{try{e.sendResponseHeaders(200,0);e.getResponseBody().write('{');e.getResponseBody().flush();Thread.sleep(2500);e.getResponseBody().write('}');}catch(Exception ignored){}finally{e.close();}});
        server.createContext("/oversize/chat/completions",e->{try{e.sendResponseHeaders(200,0);byte[] data=new byte[65536];Arrays.fill(data,(byte)' ');for(int i=0;i<150;i++)e.getResponseBody().write(data);}catch(Exception ignored){}finally{e.close();}});server.start();
        try(Engine e=new Engine(root.resolve("transport-data"))){for(String path:List.of("stall","oversize")){JsonObject p=e.providers.save(Json.obj("name",path,"baseUrl","http://127.0.0.1:"+server.getAddress().getPort()+"/"+path,"protocol","chat-completions","timeoutMs",1000,"requestsPerMinute",60000));e.providers.credential(Json.obj("providerId",p.get("id"),"key","transport-key"));long start=System.currentTimeMillis();
                try{e.providers.chat(Json.obj("providerId",p.get("id"),"model","fixture","messages",Json.arr(Json.obj("role","user","content","test"))));throw new AssertionError("expected bounded transport failure");}catch(ApiError failure){check(failure.code.equals(path.equals("stall")?"provider_timeout":"response_too_large"),"transport code "+path+": "+failure.code);}
                check(System.currentTimeMillis()-start<2200,"transport bounded elapsed "+path);
            }
            JsonArray attempts=e.store.read(c->Store.docs(c,"SELECT data FROM attempts ORDER BY rowid"));check(attempts.size()==2,"transport attempts retained");check(Json.required(attempts.get(0).getAsJsonObject(),"status").equals("unknown"),"stalled body remote result unknown");
        }finally{server.stop(0);}
    }
    static void iccProfile()throws Exception{
        BufferedImage image=new BufferedImage(2,2,BufferedImage.TYPE_INT_ARGB);image.setRGB(0,0,0xff808080);image.setRGB(1,0,0x80808080);
        var writer=ImageIO.getImageWritersByFormatName("png").next();var params=writer.getDefaultWriteParam();var metadata=writer.getDefaultImageMetadata(javax.imageio.ImageTypeSpecifier.createFromRenderedImage(image),params);
        var tree=(javax.imageio.metadata.IIOMetadataNode)metadata.getAsTree("javax_imageio_png_1.0");var profile=new javax.imageio.metadata.IIOMetadataNode("iCCP");profile.setAttribute("profileName","linear-rgb");profile.setAttribute("compressionMethod","deflate");
        ByteArrayOutputStream compressed=new ByteArrayOutputStream();try(var deflate=new java.util.zip.DeflaterOutputStream(compressed)){deflate.write(java.awt.color.ICC_Profile.getInstance(java.awt.color.ColorSpace.CS_LINEAR_RGB).getData());}profile.setUserObject(compressed.toByteArray());tree.appendChild(profile);metadata.setFromTree("javax_imageio_png_1.0",tree);
        Path path=root.resolve("linear-profile.png");try(var stream=ImageIO.createImageOutputStream(path.toFile())){writer.setOutput(stream);writer.write(null,new javax.imageio.IIOImage(image,null,metadata),params);}finally{writer.dispose();}
        try(Engine e=new Engine(root.resolve("icc-data"))){Media.Normalized normalized=e.projects.media.normalize(path,Json.id(),"#ffffff",false);BufferedImage result=ImageIO.read(normalized.path().toFile());int opaque=result.getRGB(0,0)&255,alpha=result.getRGB(1,0)&255;
            check(opaque>=186&&opaque<=189,"linear RGB ICC converted to sRGB: "+opaque);check(alpha>=219&&alpha<=223,"ICC conversion before alpha composite: "+alpha);check(Json.bool(normalized.metadata(),"pngIccApplied",false),"ICC conversion recorded");}
    }
    static void cancelWaiting()throws Exception{
        try(Mock mock=new Mock();Engine e=new Engine(root.resolve("cancel-data"))){JsonObject provider=provider(e,mock,"chat-completions");provider.addProperty("requestsPerMinute",1);provider.addProperty("timeoutMs",5000);e.providers.save(provider);String pid=Json.required(provider,"id");
            JsonObject payload=Json.obj("providerId",pid,"model","fixture","messages",Json.arr(Json.obj("role","user","content","hello")),"sessionId","cancel-waiting","budgetScopeId","cancel-budget","maxRequests",2);e.providers.chat(payload);
            ExecutorService executor=Executors.newSingleThreadExecutor();try{Future<?> waiting=executor.submit(()->{try{e.providers.chat(payload);throw new AssertionError("queued call should cancel");}catch(ApiError failure){check(failure.code.equals("call_cancelled"),"waiting cancellation code");}});
                Thread.sleep(150);check(Json.integer(e.providers.cancel("cancel-waiting"),"cancelled",0)==1,"waiting session cancelled");waiting.get(3,TimeUnit.SECONDS);
                check(mock.calls.get()==1,"waiting cancellation sends no API request");check(e.store.read(c->Json.number(Budgets.view(c,"cancel-budget"),"requestsUsed",0))==1,"waiting cancellation reserves no budget");
                JsonObject redacted=e.providers.redact(Json.obj("keypoints",Json.arr(1,2),"input_tokens",3,"apiKey","secret")).getAsJsonObject();check(redacted.get("keypoints").isJsonArray()&&redacted.get("input_tokens").getAsInt()==3,"redaction preserves geometry and actual usage");
            }finally{executor.shutdownNow();}
        }
    }
    static void httpProcess()throws Exception{
        Path jar=Path.of("engine/build/autolabel-engine.jar").toAbsolutePath();Process process=new ProcessBuilder(Path.of(System.getProperty("java.home"),"bin/java.exe").toString(),"-Djava.awt.headless=true","-jar",jar.toString()).redirectError(root.resolve("process-stderr.txt").toFile()).start();
        try{String token="test-startup-token-000000000000000000";BufferedWriter stdin=new BufferedWriter(new OutputStreamWriter(process.getOutputStream(),StandardCharsets.UTF_8));stdin.write(Json.obj("token",token,"dataDir",root.resolve("http-data").toString(),"protocolVersion",1).toString());stdin.newLine();stdin.flush();
            BufferedReader stdout=process.inputReader(StandardCharsets.UTF_8);JsonObject ready=Json.parse(stdout.readLine());check(Json.required(ready,"type").equals("ready"),"JAR ready handshake");String base="http://127.0.0.1:"+Json.integer(ready,"port",0);HttpClient http=HttpClient.newHttpClient();
            check(http.send(HttpRequest.newBuilder(URI.create(base+"/health")).GET().build(),HttpResponse.BodyHandlers.ofString()).statusCode()==401,"HTTP token protection");
            var events=http.send(HttpRequest.newBuilder(URI.create(base+"/events?after=0")).header("Authorization","Bearer "+token).GET().build(),HttpResponse.BodyHandlers.ofInputStream());check(events.statusCode()==200,"SSE authenticated connection");
            try(var reader=new BufferedReader(new InputStreamReader(events.body(),StandardCharsets.UTF_8))){check(reader.readLine().startsWith("id:"),"SSE committed event ID");}
            var response=http.send(HttpRequest.newBuilder(URI.create(base+"/command")).header("Authorization","Bearer "+token).header("Content-Type","application/json").POST(HttpRequest.BodyPublishers.ofString(Json.obj("command","project.example","payload",new JsonObject()).toString())).build(),HttpResponse.BodyHandlers.ofString());check(response.statusCode()==200&&Json.bool(Json.parse(response.body()),"ok",false),"JAR offline example command");
            http.send(HttpRequest.newBuilder(URI.create(base+"/command")).header("Authorization","Bearer "+token).POST(HttpRequest.BodyPublishers.ofString("{\"command\":\"engine.shutdown\"}")).build(),HttpResponse.BodyHandlers.ofString());check(process.waitFor(15,TimeUnit.SECONDS),"graceful shutdown");check(process.exitValue()==0,"JAR clean exit");
        }finally{process.destroyForcibly();}
    }
}
