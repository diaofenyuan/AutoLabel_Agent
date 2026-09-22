package cn.autolabel.engine;

import com.google.gson.*;
import com.sun.net.httpserver.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

public final class Main {
    private static final int MAX_COMMAND=8*1024*1024;
    /** 事件流心跳间隔：必须显著小于桌面端 45 秒的读超时，为偶发 5 秒 SQLite 争用留出余量。 */
    private static final long SSE_HEARTBEAT_MS=5000;
    public static void main(String[] args){
        try{
            BufferedReader stdin=new BufferedReader(new InputStreamReader(System.in,StandardCharsets.UTF_8));String line=stdin.readLine();if(line==null||line.length()>8*1024*1024)throw new ApiError(400,"startup_invalid","启动参数为空或过大。");
            JsonObject config=Json.parse(line);if(Json.integer(config,"protocolVersion",0)!=1)throw new ApiError(409,"protocol_mismatch","通信协议不兼容。");
            String token=Json.required(config,"token");if(token.length()<24)throw new ApiError(400,"startup_token_invalid","启动令牌长度不足。");Path root=Path.of(Json.required(config,"dataDir"));if(!root.isAbsolute())throw new ApiError(400,"data_directory_invalid","数据目录必须为绝对路径。");
            Engine engine=new Engine(root,config);HttpServer server=HttpServer.create(new InetSocketAddress(InetAddress.getByName("127.0.0.1"),0),32);
            ExecutorService connections=Executors.newVirtualThreadPerTaskExecutor();server.setExecutor(connections);AtomicBoolean closed=new AtomicBoolean();CountDownLatch stop=new CountDownLatch(1);
            Semaphore commands=new Semaphore(16),streams=new Semaphore(8),media=new Semaphore(64);
            // 关停链必须无条件走到 countDown：任何一步抛异常都会让主线程永久等待，桌面端只能强杀进程。
            Runnable shutdown=()->{if(!closed.compareAndSet(false,true))return;
                try{server.stop(1);}catch(Exception ignored){}
                try{engine.close();}catch(Exception failure){System.err.println("engine_close_failed:"+failure.getClass().getSimpleName());}
                connections.shutdownNow();stop.countDown();};
            server.createContext("/",exchange->{
                boolean acquired=false;try{
                    String supplied=exchange.getRequestHeaders().getFirst("Authorization");byte[] expected=("Bearer "+token).getBytes(StandardCharsets.UTF_8);
                    if(supplied==null||!MessageDigest.isEqual(expected,supplied.getBytes(StandardCharsets.UTF_8)))throw new ApiError(401,"unauthorized","本地引擎鉴权失败。");
                    String path=exchange.getRequestURI().getPath(),method=exchange.getRequestMethod();
                    if(path.equals("/events")&&method.equals("GET")){
                        if(!streams.tryAcquire())throw new ApiError(429,"event_connections_full","事件连接已达到上限。");
                        try{sse(exchange,engine,closed);}finally{streams.release();}return;
                    }
                    // 健康检查不占命令许可：导出、版本生成、训练等长任务会把 16 个许可占满，
                    // 若健康检查也要排队，桌面端会在引擎仍然健康时被 503 判成断连。
                    if(path.equals("/health")&&method.equals("GET")){send(exchange,200,Json.obj("ok",true,"version","0.1.0","protocolVersion",1,"state","ready"));return;}
                    // 图片流同样不占命令许可，否则工作台一次加载缩略图网格就会挤掉后续命令。
                    if((path.startsWith("/evaluation-media/")||path.startsWith("/media/")||path.startsWith("/thumb/"))&&method.equals("GET")){
                        if(!media.tryAcquire())throw new ApiError(503,"media_busy","图片请求过于密集，请稍后重试。");
                        try{
                            if(path.startsWith("/evaluation-media/")){
                                String[] ids=path.substring(18).split("/");if(ids.length!=2||!ids[0].matches("[a-zA-Z0-9-]{1,100}")||!ids[1].matches("[a-zA-Z0-9-]{1,100}"))throw new ApiError(400,"asset_id_invalid","评测素材标识无效。");Path file=new EvaluationSets(engine.store,engine.projects).image(ids[0],ids[1]);exchange.getResponseHeaders().set("Content-Type","image/png");exchange.getResponseHeaders().set("Cache-Control","private, max-age=86400");exchange.getResponseHeaders().set("X-Content-Type-Options","nosniff");exchange.sendResponseHeaders(200,Files.size(file));try(OutputStream out=exchange.getResponseBody()){Files.copy(file,out);}return;
                            }
                            String id=path.substring(7);if(!id.matches("[a-zA-Z0-9-]{1,100}"))throw new ApiError(400,"asset_id_invalid","素材标识无效。");
                            if(path.startsWith("/thumb/")){Path source=engine.projects.path(id);if(!Files.isRegularFile(source))throw new ApiError(404,"media_missing","基准图片不存在。");
                                Path thumb=Thumbnails.file(engine.store.root,source,Json.required(engine.projects.asset(id),"contentHash"));
                                exchange.getResponseHeaders().set("Content-Type","image/jpeg");exchange.getResponseHeaders().set("Cache-Control","private, max-age=31536000, immutable");exchange.getResponseHeaders().set("X-Content-Type-Options","nosniff");exchange.sendResponseHeaders(200,Files.size(thumb));try(OutputStream out=exchange.getResponseBody()){Files.copy(thumb,out);}return;}
                            Path file=engine.projects.path(id);if(!Files.isRegularFile(file))throw new ApiError(404,"media_missing","基准图片不存在。");
                            exchange.getResponseHeaders().set("Content-Type","image/png");exchange.getResponseHeaders().set("Cache-Control","private, max-age=86400");exchange.getResponseHeaders().set("X-Content-Type-Options","nosniff");exchange.sendResponseHeaders(200,Files.size(file));try(OutputStream out=exchange.getResponseBody()){Files.copy(file,out);}return;
                        }finally{media.release();}
                    }
                    if(!commands.tryAcquire())throw new ApiError(503,"command_busy","引擎操作繁忙，请稍后重试。");acquired=true;
                    if(!path.equals("/command"))throw new ApiError(404,"route_not_found","接口路径不存在。");if(!method.equals("POST"))throw new ApiError(405,"method_not_allowed","命令接口只接受 POST。");
                    byte[] bytes=exchange.getRequestBody().readNBytes(MAX_COMMAND+1);if(bytes.length>MAX_COMMAND)throw new ApiError(413,"command_too_large","命令超过 8 MiB。");
                    JsonObject request=Json.parse(new String(bytes,StandardCharsets.UTF_8));String command=Json.required(request,"command");
                    if(command.equals("engine.shutdown")){send(exchange,200,Json.obj("ok",true,"data",Json.obj("stopping",true)));Thread.ofPlatform().start(shutdown);return;}
                    Object result=engine.command(command,Json.object(request,"payload"));send(exchange,200,Json.obj("ok",true,"data",result));
                }catch(ApiError e){try{send(exchange,e.status,Json.obj("ok",false,"error",e.json()));}catch(Exception ignored){}}
                catch(Providers.RemoteError e){try{send(exchange,502,Json.obj("ok",false,"error",Json.obj("code",e.code,"message",e.getMessage(),"details",new JsonObject())));}catch(Exception ignored){}}
                catch(JsonParseException|IllegalStateException|IllegalArgumentException e){try{send(exchange,400,Json.obj("ok",false,"error",Json.obj("code","invalid_argument","message","请求参数格式无效。","details",new JsonObject())));}catch(Exception ignored){}}
                catch(Exception e){System.err.println("engine_command_failed:"+e.getClass().getSimpleName());try{send(exchange,500,Json.obj("ok",false,"error",Json.obj("code","internal_error","message","操作未完成，请查看诊断并检查输入文件。","details",new JsonObject())));}catch(Exception ignored){}}
                // Error（如超大图片导致的 OutOfMemoryError）不接住就没有任何响应，
                // 桌面端只能等到超时才报「连接中断」，这正是最容易被感知为断连的路径。
                catch(Throwable fatal){System.err.println("engine_command_fatal:"+fatal.getClass().getSimpleName());try{send(exchange,500,Json.obj("ok",false,"error",Json.obj("code","internal_error","message","操作占用资源过多已中止，请缩小输入范围后重试。","details",new JsonObject())));}catch(Throwable ignored){}}
                finally{if(acquired)commands.release();exchange.close();}
            });
            Runtime.getRuntime().addShutdownHook(new Thread(shutdown,"engine-shutdown"));server.start();System.out.println(Json.obj("type","ready","port",server.getAddress().getPort(),"protocolVersion",1,"version","0.1.0"));System.out.flush();
            // 父进程断开管道后退出，防止 Electron 异常关闭留下孤立引擎。
            Thread.ofVirtual().start(()->{try{while(stdin.readLine()!=null){}}catch(IOException ignored){}shutdown.run();});stop.await();
        }catch(Throwable e){System.err.println(Json.obj("type","startup_error","code",e instanceof ApiError a?a.code:"engine_start_failed","message",e instanceof ApiError a?a.getMessage():"引擎启动失败，请检查 Java 运行时与数据目录。"));System.exit(1);}
    }
    static void send(HttpExchange e,int status,JsonObject json)throws IOException{byte[] bytes=json.toString().getBytes(StandardCharsets.UTF_8);e.getResponseHeaders().set("Content-Type","application/json; charset=utf-8");e.getResponseHeaders().set("Cache-Control","no-store");e.getResponseHeaders().set("X-Content-Type-Options","nosniff");e.sendResponseHeaders(status,bytes.length);try(OutputStream out=e.getResponseBody()){out.write(bytes);}}
    static void sse(HttpExchange exchange,Engine engine,AtomicBoolean closed)throws Exception{
        long after=0;String query=exchange.getRequestURI().getRawQuery();if(query!=null)for(String part:query.split("&"))if(part.startsWith("after="))after=Long.parseLong(part.substring(6));
        String last=exchange.getRequestHeaders().getFirst("Last-Event-ID");if(last!=null)after=Math.max(after,Long.parseLong(last));
        if(after<0)throw new ApiError(400,"cursor_invalid","事件游标无效。");exchange.getResponseHeaders().set("Content-Type","text/event-stream; charset=utf-8");exchange.getResponseHeaders().set("Cache-Control","no-cache");exchange.getResponseHeaders().set("X-Accel-Buffering","no");exchange.sendResponseHeaders(200,0);
        try(OutputStream out=exchange.getResponseBody()){long heartbeat=0;while(!closed.get()){
            try{
                long cursor=after;JsonArray batch=engine.store.read(c->Store.events(c,cursor,null,null,200));
                for(JsonElement item:batch){JsonObject e=item.getAsJsonObject();after=Json.number(e,"sequence",after);out.write(("id: "+after+"\ndata: "+e+"\n\n").getBytes(StandardCharsets.UTF_8));}
                if(System.currentTimeMillis()-heartbeat>SSE_HEARTBEAT_MS){out.write(": heartbeat\n\n".getBytes(StandardCharsets.UTF_8));heartbeat=System.currentTimeMillis();}out.flush();if(batch.isEmpty())Thread.sleep(150);
            }
            catch(InterruptedException stopped){Thread.currentThread().interrupt();return;}
            catch(RuntimeException transientFailure){
                // 事件流是桌面端判定连接状态的唯一依据：一次偶发读库或解析抖动不应该断开它，
                // 这里补一次心跳并重试下一轮，游标未推进所以事件不会丢。
                System.err.println("engine_sse_retry:"+transientFailure.getClass().getSimpleName());
                try{if(System.currentTimeMillis()-heartbeat>SSE_HEARTBEAT_MS){out.write(": heartbeat\n\n".getBytes(StandardCharsets.UTF_8));heartbeat=System.currentTimeMillis();}out.flush();Thread.sleep(500);}
                catch(InterruptedException stopped){Thread.currentThread().interrupt();return;}
            }
        }}catch(IOException ignored){/* 客户端断开后由持久化游标补齐，不影响队列。 */}
    }
}
