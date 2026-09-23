package cn.autolabel.engine;

import com.google.gson.*;
import com.sun.net.httpserver.HttpServer;
import java.io.*;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.zip.CRC32;

final class CapabilityTest {
    static volatile String mode="ok";
    // 对话请求计数器：/models 不计，用于验收「一键验证真实计费次数从 6 降到 ≤3」。
    static final AtomicInteger chats=new AtomicInteger();
    static final List<byte[]> images=Collections.synchronizedList(new ArrayList<>());
    static void check(boolean value,String message){EngineTest.check(value,message);}
    static void collect(JsonElement element){
        if(element.isJsonObject())for(var field:element.getAsJsonObject().entrySet())collect(field.getValue());
        else if(element.isJsonArray())for(JsonElement item:element.getAsJsonArray())collect(item);
        else if(element.isJsonPrimitive()&&element.getAsJsonPrimitive().isString()){String value=element.getAsString();if(value.startsWith("data:image/png;base64,"))images.add(Base64.getDecoder().decode(value.substring(value.indexOf(',')+1)));}
    }
    static void png(byte[] bytes)throws Exception{
        try(var input=new DataInputStream(new ByteArrayInputStream(bytes))){check(input.readLong()==0x89504e470d0a1a0aL,"PNG signature valid");boolean ended=false;
            while(input.available()>0){int size=input.readInt();byte[] type=input.readNBytes(4),payload=input.readNBytes(size);long actual=Integer.toUnsignedLong(input.readInt());CRC32 crc=new CRC32();crc.update(type);crc.update(payload);check(crc.getValue()==actual,"PNG chunk CRC valid");if(new String(type,StandardCharsets.US_ASCII).equals("IEND")){ended=true;break;}}check(ended&&input.available()==0,"PNG complete through IEND");}
        var decoded=javax.imageio.ImageIO.read(new ByteArrayInputStream(bytes));check(decoded!=null&&decoded.getWidth()==64&&decoded.getHeight()==64,"PNG actual decoding and dimensions valid");
    }
    static JsonObject response(boolean responses,JsonObject request){
        if(request.has("tools")){String name=mode.equals("wrong-name")?"other_tool":"report_status",arguments=mode.equals("invalid-json")?"not-json":Json.obj("status",mode.equals("wrong-status")||mode.equals("tools-wrong")?"no":"ok").toString();
            // 合并探针要求「文本+工具调用」同回：单能力 test() 的工具判定只看 toolCalls，附带文本不影响既有断言。
            if(responses)return Json.obj("status","completed","output",Json.arr(Json.obj("type","message","content",Json.arr(Json.obj("type","output_text","text","OK"))),Json.obj("type","function_call","call_id","fixture","name",name,"arguments",arguments)));
            return Json.obj("choices",Json.arr(Json.obj("finish_reason","tool_calls","message",Json.obj("content","OK","tool_calls",Json.arr(Json.obj("id","fixture","type","function","function",Json.obj("name",name,"arguments",arguments)))))));
        }
        String content=request.has("response_format")||request.has("text")?switch(mode){case "false"->"{\"ok\":false}";case "string"->"{\"ok\":\"true\"}";case "missing"->"{}";default->"{\"ok\":true}";}:"OK";
        return responses?Json.obj("status","completed","output",Json.arr(Json.obj("type","message","content",Json.arr(Json.obj("type","output_text","text",content))))):Json.obj("choices",Json.arr(Json.obj("finish_reason","stop","message",Json.obj("content",content))));
    }
    static void run(Path root)throws Exception{
        HttpServer server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);server.createContext("/v1/",exchange->{try{
            // 模型列表是 GET 且没有请求体，必须在对话响应之前分流，否则空体解析会直接 500。
            if(exchange.getRequestURI().getPath().endsWith("/models")){
                byte[] list=Json.obj("data",Json.arr(Json.obj("id","fixture-a"),Json.obj("id","fixture-b"),Json.obj("id","fixture-a"),Json.obj("id","   "),Json.obj("note","缺少 id 的条目不应被登记"))).toString().getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().add("Content-Type","application/json");exchange.sendResponseHeaders(200,list.length);exchange.getResponseBody().write(list);return;
            }
            JsonObject request=Json.parse(new String(exchange.getRequestBody().readAllBytes(),StandardCharsets.UTF_8));chats.incrementAndGet();collect(request);byte[] body=response(exchange.getRequestURI().getPath().endsWith("responses"),request).toString().getBytes(StandardCharsets.UTF_8);exchange.getResponseHeaders().add("Content-Type","application/json");exchange.sendResponseHeaders(200,body.length);exchange.getResponseBody().write(body);}finally{exchange.close();}});server.start();
        try(Engine engine=new Engine(root.resolve("capability-data"))){for(String protocol:List.of("chat-completions","responses")){
            JsonObject provider=engine.providers.save(Json.obj("name","能力协议fixture","baseUrl","http://127.0.0.1:"+server.getAddress().getPort()+"/v1","protocol",protocol,"requestsPerMinute",60000));String id=Json.required(provider,"id");engine.providers.credential(Json.obj("providerId",id,"key","local-fixture-key"));
            for(String capability:List.of("image","multiImage")){images.clear();mode="ok";check(Json.required(engine.providers.test(Json.obj("providerId",id,"model","fixture","capability",capability)),"status").equals("verified"),protocol+" accepts image fixture");check(images.size()==(capability.equals("image")?1:2),"correct number of images sent");for(byte[] bytes:images)png(bytes);if(images.size()==2)check(!Arrays.equals(images.get(0),images.get(1)),"multi-image fixtures are distinct");}
            for(String bad:List.of("wrong-name","wrong-status","invalid-json")){mode=bad;check(Json.required(engine.providers.test(Json.obj("providerId",id,"model","fixture","capability","tools")),"status").equals("unverified"),"invalid tool evidence rejected: "+bad);}
            mode="ok";check(Json.required(engine.providers.test(Json.obj("providerId",id,"model","fixture","capability","tools")),"status").equals("verified"),"expected native tool accepted");
            for(String bad:List.of("false","string","missing")){mode=bad;check(Json.required(engine.providers.test(Json.obj("providerId",id,"model","fixture","capability","structured")),"status").equals("unverified"),"incorrect structured truth rejected: "+bad);}
            mode="ok";check(Json.required(engine.providers.test(Json.obj("providerId",id,"model","fixture","capability","structured")),"status").equals("verified"),"explicit boolean true accepted");
            // 模型清单要落进 provider 文档：只返回不落库的话，界面刷新后选择器又只剩已保存的那一个模型。
            JsonArray listed=Json.array(engine.providers.models(id),"models");
            check(listed.size()==2&&listed.get(0).getAsString().equals("fixture-a")&&listed.get(1).getAsString().equals("fixture-b"),protocol+" keeps interface order and drops duplicate, blank and id-less entries");
            JsonObject registered=engine.providers.get(id);
            check(registered.has("models")&&registered.has("modelsFetchedAt")&&Json.array(registered,"models").size()==2,"model list is registered on the provider document");
            check(Json.integer(registered,"revision",0)==Json.integer(provider,"revision",0),"listing models does not bump the provider revision");
            // 一键验证：连接不计费，其余五项合并为 3 次并发真实调用——「真实计费次数从 6 降到 ≤3」的验收点。
            mode="ok";int before=chats.get();
            JsonObject all=engine.providers.testAll(Json.obj("providerId",id,"model","fixture"));
            check(Json.integer(all,"billedCalls",0)==3&&chats.get()-before==3,protocol+" testAll merges five capabilities into exactly 3 billed chat calls");
            JsonObject allTests=Json.object(all,"tests");
            for(String cap:List.of("connection","text","image","multiImage","structured","tools"))check(allTests.has(cap)&&Json.required(Json.object(allTests,cap),"status").equals("verified"),protocol+" testAll verifies "+cap);
            check(Json.integer(engine.providers.get(id),"revision",0)==Json.integer(provider,"revision",0),"testAll does not bump the provider revision");
            // 同一次响应里两项独立判定：带文本内容但 status='no' 的工具调用 → multiImage 通过、tools 不通过。
            mode="tools-wrong";JsonObject partial=Json.object(engine.providers.testAll(Json.obj("providerId",id,"model","fixture")),"tests");
            check(Json.required(Json.object(partial,"multiImage"),"status").equals("verified"),"tool response carrying text still verifies multiImage");
            check(Json.required(Json.object(partial,"tools"),"status").equals("unverified"),"wrong tool status keeps tools unverified in the same merged probe");
            // 缓存键 =「接口地址+模型+协议」：只改名字与限额不再作废既有结论（含已验证与未验证两种）。
            engine.providers.save(Json.obj("id",id,"name","能力协议fixture-改名","requestsPerMinute",12000));
            JsonObject kept=Json.object(engine.providers.capabilities(Json.obj("providerId",id,"model","fixture")),"tests");
            for(String cap:List.of("connection","text","image","multiImage","structured"))check(Json.required(Json.object(kept,cap),"status").equals("verified"),protocol+" renaming keeps cached conclusion: "+cap);
            check(Json.required(Json.object(kept,"tools"),"status").equals("unverified"),"renaming keeps cached negative conclusion as well");
            // 结论归属校验：把记录里的接口地址改成别的端点后必须按未验证处理，伪造/错配结论不返回给前端。
            engine.providers.store.tx(c->{JsonObject current=Store.document(c,"providers",id),byModel=Json.object(Json.object(current,"capabilities"),"fixture"),entry=Json.object(byModel,"structured").deepCopy();entry.addProperty("baseUrl","http://127.0.0.1:1/v1");byModel.add("structured",entry);Store.update(c,"UPDATE providers SET data=? WHERE id=?",current,id);return null;});
            check(Json.str(engine.providers.capabilities(Json.obj("providerId",id,"model","fixture")),"structured","").equals("unverified"),"cached conclusion recorded for another endpoint is treated as unverified");
            // 换接口地址后旧清单必须清空，否则选择器会列出另一个端点的模型名。
            engine.providers.save(Json.obj("id",id,"name","能力协议fixture","baseUrl","http://127.0.0.1:"+server.getAddress().getPort()+"/v2","protocol",protocol));
            check(!engine.providers.get(id).has("models"),"changing the endpoint clears the stale model list");
            // 换接口地址后旧结论属于另一个端点：读取口按未验证处理（text 在 tools-wrong 轮里是已验证的）。
            check(Json.str(engine.providers.capabilities(Json.obj("providerId",id,"model","fixture")),"text","").equals("unverified"),"changing the endpoint invalidates cached capability conclusions");
        }}finally{server.stop(0);}
    }
}
