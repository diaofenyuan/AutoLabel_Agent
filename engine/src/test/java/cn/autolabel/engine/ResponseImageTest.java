package cn.autolabel.engine;

import com.google.gson.*;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

final class ResponseImageTest {
    static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    public static void main(String[] args)throws Exception{
        Path root=Path.of(args[0]);Files.createDirectories(root);var picture=new java.awt.image.BufferedImage(256,256,java.awt.image.BufferedImage.TYPE_INT_RGB);Random random=new Random(497);for(int y=0;y<256;y++)for(int x=0;x<256;x++)picture.setRGB(x,y,random.nextInt(1<<24));Path png=root.resolve("large-data-uri.png");javax.imageio.ImageIO.write(picture,"png",png.toFile());String uri=Json.object(Runs.image(png),"image_url").get("url").getAsString();check(uri.length()>100000,"fixture exceeds generic text boundary");
        var seen=new java.util.concurrent.atomic.AtomicBoolean();HttpServer server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);server.createContext("/v1/responses",exchange->{try{JsonObject request=Json.parse(new String(exchange.getRequestBody().readAllBytes(),StandardCharsets.UTF_8));JsonArray content=Json.array(Json.array(request,"input").get(0).getAsJsonObject(),"content");JsonObject image=content.get(1).getAsJsonObject();seen.set(Json.str(image,"type","").equals("input_image")&&image.get("image_url").getAsString().equals(uri));byte[] body=Json.obj("status","completed","output",Json.arr(Json.obj("type","message","content",Json.arr(Json.obj("type","output_text","text","accepted"))))).toString().getBytes(StandardCharsets.UTF_8);exchange.sendResponseHeaders(200,body.length);exchange.getResponseBody().write(body);}finally{exchange.close();}});server.start();
        try(Engine engine=new Engine(root.resolve("data"))){JsonObject provider=engine.providers.save(Json.obj("name","Responses大图fixture","baseUrl","http://127.0.0.1:"+server.getAddress().getPort()+"/v1","protocol","responses"));String id=Json.required(provider,"id");engine.providers.credential(Json.obj("providerId",id,"key","local-fixture-key"));JsonObject response=engine.providers.chat(Json.obj("providerId",id,"model","fixture","budgetScopeId","large-image","maxRequests",1,"messages",Json.arr(Json.obj("role","user","content",Json.arr(Json.obj("type","text","text","inspect the attached image"),Runs.image(png))))));check(seen.get(),"actual HTTP receives complete image data");check(Json.str(response,"content","").equals("accepted"),"response parsed");check(Json.number(Json.object(response,"budget"),"requestsUsed",0)==1,"request recorded once");check(javax.imageio.ImageIO.read(new java.io.ByteArrayInputStream(Base64.getDecoder().decode(uri.substring(uri.indexOf(',')+1)))).getWidth()==256,"image decodes after URI transport");
            try{Providers.imageUrl(Json.obj("url","data:image/png;base64,"+"AAAA".repeat((32*1024*1024)/3+1)));throw new AssertionError("oversized image accepted");}catch(ApiError error){check(error.code.equals("image_payload_too_large"),"32MiB image bound retained");}
            try{Json.required(Json.obj("text","x".repeat(100001)),"text");throw new AssertionError("generic text bound changed");}catch(ApiError error){check(error.code.equals("invalid_argument"),"generic text bound unchanged");}
        }finally{server.stop(0);}System.out.println("PASS 7 large-image assertions; local Responses HTTP only.\nVERIFICATION_DIR="+root);
    }
}
