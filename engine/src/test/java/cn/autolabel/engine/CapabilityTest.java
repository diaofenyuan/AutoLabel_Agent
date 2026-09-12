package cn.autolabel.engine;

import com.google.gson.*;
import com.sun.net.httpserver.HttpServer;
import java.io.*;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.*;
import java.util.zip.CRC32;

final class CapabilityTest {
    static volatile String mode="ok";
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
        if(request.has("tools")){String name=mode.equals("wrong-name")?"other_tool":"report_status",arguments=mode.equals("invalid-json")?"not-json":Json.obj("status",mode.equals("wrong-status")?"no":"ok").toString();
            if(responses)return Json.obj("status","completed","output",Json.arr(Json.obj("type","function_call","call_id","fixture","name",name,"arguments",arguments)));
            return Json.obj("choices",Json.arr(Json.obj("finish_reason","tool_calls","message",Json.obj("tool_calls",Json.arr(Json.obj("id","fixture","type","function","function",Json.obj("name",name,"arguments",arguments)))))));
        }
        String content=request.has("response_format")||request.has("text")?switch(mode){case "false"->"{\"ok\":false}";case "string"->"{\"ok\":\"true\"}";case "missing"->"{}";default->"{\"ok\":true}";}:"OK";
        return responses?Json.obj("status","completed","output",Json.arr(Json.obj("type","message","content",Json.arr(Json.obj("type","output_text","text",content))))):Json.obj("choices",Json.arr(Json.obj("finish_reason","stop","message",Json.obj("content",content))));
    }
    static void run(Path root)throws Exception{
        HttpServer server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);server.createContext("/v1/",exchange->{try{JsonObject request=Json.parse(new String(exchange.getRequestBody().readAllBytes(),StandardCharsets.UTF_8));collect(request);byte[] body=response(exchange.getRequestURI().getPath().endsWith("responses"),request).toString().getBytes(StandardCharsets.UTF_8);exchange.getResponseHeaders().add("Content-Type","application/json");exchange.sendResponseHeaders(200,body.length);exchange.getResponseBody().write(body);}finally{exchange.close();}});server.start();
        try(Engine engine=new Engine(root.resolve("capability-data"))){for(String protocol:List.of("chat-completions","responses")){
            JsonObject provider=engine.providers.save(Json.obj("name","能力协议fixture","baseUrl","http://127.0.0.1:"+server.getAddress().getPort()+"/v1","protocol",protocol,"requestsPerMinute",60000));String id=Json.required(provider,"id");engine.providers.credential(Json.obj("providerId",id,"key","local-fixture-key"));
            for(String capability:List.of("image","multiImage")){images.clear();mode="ok";check(Json.required(engine.providers.test(Json.obj("providerId",id,"model","fixture","capability",capability)),"status").equals("verified"),protocol+" accepts image fixture");check(images.size()==(capability.equals("image")?1:2),"correct number of images sent");for(byte[] bytes:images)png(bytes);if(images.size()==2)check(!Arrays.equals(images.get(0),images.get(1)),"multi-image fixtures are distinct");}
            for(String bad:List.of("wrong-name","wrong-status","invalid-json")){mode=bad;check(Json.required(engine.providers.test(Json.obj("providerId",id,"model","fixture","capability","tools")),"status").equals("unverified"),"invalid tool evidence rejected: "+bad);}
            mode="ok";check(Json.required(engine.providers.test(Json.obj("providerId",id,"model","fixture","capability","tools")),"status").equals("verified"),"expected native tool accepted");
            for(String bad:List.of("false","string","missing")){mode=bad;check(Json.required(engine.providers.test(Json.obj("providerId",id,"model","fixture","capability","structured")),"status").equals("unverified"),"incorrect structured truth rejected: "+bad);}
            mode="ok";check(Json.required(engine.providers.test(Json.obj("providerId",id,"model","fixture","capability","structured")),"status").equals("verified"),"explicit boolean true accepted");
        }}finally{server.stop(0);}
    }
}
