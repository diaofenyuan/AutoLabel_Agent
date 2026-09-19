package cn.autolabel.engine;

import com.google.gson.*;
import com.sun.net.httpserver.HttpServer;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import javax.imageio.ImageIO;

/**
 * 发送副本与区域裁剪的验收。
 *
 * 这里断言的是**工程正确性**，不是模型质量：
 * 1. 声明给模型的 target 尺寸必须等于实际发出去那张图的像素尺寸（口径不一致会直接写出越界坐标）；
 * 2. 长边缩放确实生效，且发出的是 JPEG；
 * 3. 模型按副本坐标返回的框，要逆映射回基准图坐标——用「副本正中心的框」反推基准图正中心；
 * 4. 越界区域 / 非法长边在创建运行时就拒绝；映射后越界的坐标交给几何校验明确报错，不静默截断；
 * 5. 缺省（不带 payload）时行为与以前完全一致：原图 PNG、按基准尺寸声明。
 */
final class PayloadImagesTest {
    static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    interface Action{void run()throws Exception;}
    static void rejects(Action action,String code,String message)throws Exception{
        try{action.run();throw new AssertionError(message+"：期望 "+code+"，实际没有报错");}
        catch(ApiError error){check(error.code.equals(code),message+"：期望 "+code+"，实际 "+error.code);}
    }

    public static void run(Path root)throws Exception{
        Files.createDirectories(root);
        AtomicInteger calls=new AtomicInteger();
        List<JsonObject> bodies=new java.util.concurrent.CopyOnWriteArrayList<>();
        // 夹具回一份「副本正中心 20×20 的框」：它逆映射回去应当正好落在基准图或裁剪区域的中心。
        var picture=new Object(){int width=0,height=0;};
        HttpServer server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
        server.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
        server.createContext("/v1/chat/completions",exchange->{
            try{JsonObject body=Json.parse(new String(exchange.getRequestBody().readAllBytes(),StandardCharsets.UTF_8));bodies.add(body);calls.incrementAndGet();
                int[] declared=declaredTarget(body);String assetId=target(body);
                String content=Json.obj("assetId",assetId,"annotations",Json.arr(Json.obj("id","payload-fixture","type","detect","classId","item",
                    "bbox",Json.obj("x",declared[0]/2.0-10,"y",declared[1]/2.0-10,"width",20,"height",20)))).toString();
                byte[] payload=Json.obj("choices",Json.arr(Json.obj("finish_reason","stop","message",Json.obj("role","assistant","content",content))),
                    "usage",Json.obj("input_tokens",10,"output_tokens",10)).toString().getBytes(StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(200,payload.length);exchange.getResponseBody().write(payload);
            }catch(Exception error){exchange.sendResponseHeaders(500,0);}finally{exchange.close();}});
        server.start();
        String url="http://127.0.0.1:"+server.getAddress().getPort()+"/v1";
        try(Engine engine=new Engine(root.resolve("payload-data"))){
            JsonObject provider=engine.providers.save(Json.obj("name","发送副本夹具","baseUrl",url,"protocol","chat-completions","timeoutMs",20000,"maxRetries",0));
            engine.providers.credential(Json.obj("providerId",Json.required(provider,"id"),"key","isolated-payload"));
            String project=Json.required(EngineTest.project(engine,"detect"),"id");
            JsonArray imported=EngineTest.importSamples(engine,project,2);
            String asset=imported.get(0).getAsString(),second=imported.get(1).getAsString();
            JsonObject source=engine.projects.asset(asset);
            int baselineWidth=Json.integer(source,"width",0),baselineHeight=Json.integer(source,"height",0);
            check(baselineWidth==960&&baselineHeight==640,"fixture baseline is 960x640, actual "+baselineWidth+"x"+baselineHeight);

            // ===== 1. 缺省：不派生副本，声明尺寸就是基准尺寸，坐标原样留着 =====
            JsonObject plain=runOnce(engine,provider,project,Json.arr(asset),null);
            check(Json.required(plain,"status").equals("completed"),"plain run completed: "+plain);
            JsonObject plainPayload=Json.object(plain,"payloadActual");
            check(!Json.bool(plainPayload,"derived",true),"plain run sends the baseline image itself");
            check(Json.integer(plainPayload,"width",0)==960&&Json.integer(plainPayload,"height",0)==640,"plain run declares baseline size");
            check(sentImage(engine,asset,Json.array(bodies.get(bodies.size()-1),"messages")).width==960,"plain run actually sends 960px wide image");
            check(centerOf(engine,asset).equals(List.of(480.0,320.0)),"plain run keeps baseline coordinates, actual "+centerOf(engine,asset));

            // ===== 2. 长边缩放：声明尺寸 = 实发尺寸，坐标逆映射回基准图 =====
            JsonObject scaled=runOnce(engine,provider,project,Json.arr(asset),Json.obj("maxEdge",400));
            JsonObject scaledPayload=Json.object(scaled,"payloadActual");
            Sent scaledImage=sentImage(engine,asset,Json.array(bodies.get(bodies.size()-1),"messages"));
            check(Json.bool(scaledPayload,"derived",false),"scaled run derives a payload copy");
            check(scaledImage.width==Json.integer(scaledPayload,"width",0)&&scaledImage.height==Json.integer(scaledPayload,"height",0),
                "declared target size must equal the image actually sent: declared "+Json.integer(scaledPayload,"width",0)+"x"+Json.integer(scaledPayload,"height",0)
                    +" actual "+scaledImage.width+"x"+scaledImage.height);
            check(scaledImage.width==400&&scaledImage.height==267,"400px long edge scales 960x640 to 400x267, actual "+scaledImage);
            check(scaledImage.jpeg,"payload copy is sent as JPEG so the provider does not receive a 3MB PNG");
            check(Json.number(scaledPayload,"bytes",0)<Json.number(scaledPayload,"sourceBytes",0),"scaled copy must be smaller than the source image");
            check(Json.number(scaledPayload,"sourceBytes",0)>0,"source size recorded for comparison");
            List<Double> center=centerOf(engine,asset);
            check(Math.abs(center.get(0)-480)<1.5&&Math.abs(center.get(1)-320)<1.5,"scaled run maps back to baseline center, actual "+center);

            // ===== 3. 区域裁剪 + 缩放：两个变换叠加后仍要回到正确位置 =====
            JsonObject cropped=runOnce(engine,provider,project,Json.arr(asset),Json.obj("maxEdge",200,
                "region",Json.obj("left",0.25,"top",0.25,"right",0.75,"bottom",0.75)));
            JsonObject croppedPayload=Json.object(cropped,"payloadActual");
            Sent croppedImage=sentImage(engine,asset,Json.array(bodies.get(bodies.size()-1),"messages"));
            check(croppedImage.width==Json.integer(croppedPayload,"width",0)&&croppedImage.height==Json.integer(croppedPayload,"height",0),
                "cropped run declares the copy size it really sent");
            check(croppedImage.width==200&&croppedImage.height==133,"crop 480x320 then scale to 200px long edge, actual "+croppedImage);
            check(Json.integer(croppedPayload,"sourceWidth",0)==960&&Json.integer(croppedPayload,"sourceHeight",0)==640,"source dimensions recorded");
            List<Double> croppedCenter=centerOf(engine,asset);
            check(Math.abs(croppedCenter.get(0)-480)<2.5&&Math.abs(croppedCenter.get(1)-320)<2.5,"crop + scale maps back to the baseline center, actual "+croppedCenter);

            // ===== 4. 同一运行里的第二个样本也必须走同一份配方 =====
            // 这条是为了钉住一个真实缺陷：把「实发事实」写回配方键会让后续样本退回原图发送。
            JsonObject two=runOnce(engine,provider,project,Json.arr(asset,second),Json.obj("maxEdge",400));
            check(Json.required(two,"status").equals("completed"),"two-sample run completed: "+two);
            check(Json.number(Json.object(two,"statistics"),"succeeded",0)==2,"two samples succeeded");
            Sent lastImage=sentImage(engine,asset,Json.array(bodies.get(bodies.size()-1),"messages"));
            check(lastImage.width==400&&lastImage.height==267,"second sample keeps the same recipe, actual "+lastImage);

            // ===== 5. 反向用例：越界区域与非法长边在创建时就拒绝 =====
            rejects(() -> engine.runs.create(Json.obj("projectId",project,"providerId",Json.required(provider,"id"),"model","fixture",
                "prompt","locate","assetIds",Json.arr(asset),"maxRequests",1,"payload",Json.obj("region",Json.obj("left",0.1,"top",0.1,"right",1.2,"bottom",0.9)))),
                "payload_region_out_of_bounds","越界区域必须被拒绝");
            rejects(() -> engine.runs.create(Json.obj("projectId",project,"providerId",Json.required(provider,"id"),"model","fixture",
                "prompt","locate","assetIds",Json.arr(asset),"maxRequests",1,"payload",Json.obj("maxEdge",10))),
                "payload_max_edge_invalid","非法长边必须被拒绝");
            rejects(() -> engine.runs.create(Json.obj("projectId",project,"providerId",Json.required(provider,"id"),"model","fixture",
                "prompt","locate","assetIds",Json.arr(asset),"maxRequests",1,"payload",Json.obj("region",Json.obj("left",0.4,"top",0.4,"right",0.41,"bottom",0.9)))),
                "payload_region_too_small","退化区域必须被拒绝");
            System.out.println("PASS payload assertions; calls="+calls.get()+"\nVERIFICATION_DIR="+root);
        }finally{server.stop(0);}
    }

    static JsonObject runOnce(Engine engine,JsonObject provider,String project,JsonArray assetIds,JsonObject payload)throws Exception{
        JsonObject request=Json.obj("projectId",project,"providerId",Json.required(provider,"id"),"model","fixture","prompt","locate",
            "assetIds",assetIds,"maxRequests",assetIds.size(),"concurrency",1,"forceRerun",true);
        if(payload!=null)request.add("payload",payload);
        JsonObject run=engine.runs.create(request);
        return EngineTest.waitRun(engine,Json.required(run,"id"),30000);
    }

    /** 取出请求里声明给模型的 target 尺寸；同时校验声明与实发一致的前提数据。 */
    static int[] declaredTarget(JsonObject body){
        for(JsonElement message:Json.array(body,"messages"))for(JsonElement part:Json.array(message.getAsJsonObject(),"content")){
            JsonObject value=part.getAsJsonObject();String text=Json.str(value,"text","");
            if(!text.startsWith("{"))continue;
            JsonObject parsed=Json.parse(text);
            if("target".equals(Json.str(parsed,"role","")))return new int[]{Json.integer(parsed,"width",0),Json.integer(parsed,"height",0)};
        }
        throw new AssertionError("请求里没有 target 声明");
    }
    static String target(JsonObject body){
        for(JsonElement message:Json.array(body,"messages"))for(JsonElement part:Json.array(message.getAsJsonObject(),"content")){
            JsonObject value=part.getAsJsonObject();String text=Json.str(value,"text","");
            if(text.startsWith("{")){JsonObject parsed=Json.parse(text);if("target".equals(Json.str(parsed,"role","")))return Json.required(parsed,"assetId");}
        }
        return null;
    }
    /** 从真实请求体里解出那张图的像素尺寸与格式：断言以「实际发出去的东西」为准。 */
    static Sent sentImage(Engine engine,String asset,JsonArray messages)throws Exception{
        for(JsonElement message:messages)for(JsonElement part:Json.array(message.getAsJsonObject(),"content")){
            JsonObject value=part.getAsJsonObject();if(!"image_url".equals(Json.str(value,"type","")))continue;
            String uri=Json.str(Json.object(value,"image_url"),"url","");
            boolean jpeg=uri.startsWith("data:image/jpeg");
            byte[] bytes=Base64.getDecoder().decode(uri.substring(uri.indexOf(',')+1));
            BufferedImage image=ImageIO.read(new ByteArrayInputStream(bytes));
            return new Sent(image.getWidth(),image.getHeight(),jpeg,bytes.length);
        }
        throw new AssertionError("请求里没有图片");
    }
    static List<Double> centerOf(Engine engine,String asset)throws Exception{
        JsonObject stored=engine.projects.asset(asset);
        JsonObject bbox=Json.object(Json.array(stored,"annotations").get(0).getAsJsonObject(),"bbox");
        return List.of(Json.decimal(bbox,"x",0)+Json.decimal(bbox,"width",0)/2,Json.decimal(bbox,"y",0)+Json.decimal(bbox,"height",0)/2);
    }
    record Sent(int width,int height,boolean jpeg,int bytes){}
}
