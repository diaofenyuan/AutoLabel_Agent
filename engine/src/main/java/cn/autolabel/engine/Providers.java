package cn.autolabel.engine;

import com.google.gson.*;
import java.io.IOException;
import java.io.InputStream;
import java.net.*;
import java.net.http.*;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.LongSupplier;

final class Providers {
    /** 登记到 provider 文档的模型候选上限，避免异常接口返回超大列表撑大配置与备份。 */
    private static final int MAX_MODELS=500,MAX_MODEL_NAME=200;
    final Store store;
    private final Map<String,Credential> keys=new ConcurrentHashMap<>();
    static final class Credential {
        final String key,bindingVersion;
        Credential(String key,String bindingVersion){this.key=key;this.bindingVersion=bindingVersion;}
        @Override public String toString(){return "[credential]";}
    }
    private final HttpClient client=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(15)).followRedirects(HttpClient.Redirect.NEVER).build();
    private final ThreadPoolExecutor interactive=new ThreadPoolExecutor(2,2,0,TimeUnit.MILLISECONDS,new ArrayBlockingQueue<>(16),Thread.ofPlatform().name("model-chat-",0).factory(),new ThreadPoolExecutor.AbortPolicy());
    private final Map<QuotaId,Gate> gates=new HashMap<>();
    private final Map<String,GroupView> quotaGroups=new HashMap<>();
    private final LongSupplier quotaNanos,quotaMillis;
    private final Map<String,Set<Future<?>>> sessions=new ConcurrentHashMap<>();
    private volatile boolean closing;
    private enum QuotaKind { CREDENTIAL, PROVIDER, MANUAL }
    private record QuotaId(QuotaKind kind,String value){}
    private record Quota(int concurrency,int rpm){}
    private static class Gate {int active;boolean used;long lastNanos,next;}
    private static class GroupView {int active;final Set<Gate> gates=Collections.newSetFromMap(new IdentityHashMap<>());}
    static final class Permit {
        private final Providers owner;
        private final String group;
        private final List<Gate> acquired;
        private final GroupView accounting;
        private boolean released;
        private Permit(Providers owner,String group,List<Gate> acquired,GroupView accounting){this.owner=owner;this.group=group;this.acquired=List.copyOf(acquired);this.accounting=accounting;}
        String group(){return group;}
        @Override public String toString(){return "[permit]";}
    }
    record Reply(String content,JsonArray tools,JsonElement usage,JsonObject raw){}
    private static final class LimitedBody implements HttpResponse.BodySubscriber<byte[]> {
        private final HttpResponse.BodySubscriber<byte[]> delegate=HttpResponse.BodySubscribers.ofByteArray();
        private java.util.concurrent.Flow.Subscription subscription;private long bytes;
        public CompletionStage<byte[]> getBody(){return delegate.getBody();}
        public void onSubscribe(java.util.concurrent.Flow.Subscription s){subscription=s;delegate.onSubscribe(s);}
        public void onNext(java.util.List<ByteBuffer> buffers){for(ByteBuffer buffer:buffers)bytes+=buffer.remaining();if(bytes>8L*1024*1024){subscription.cancel();delegate.onError(new java.io.IOException("response_size_limit"));return;}delegate.onNext(buffers);}
        public void onError(Throwable error){delegate.onError(error);}
        public void onComplete(){delegate.onComplete();}
    }
    static final class RemoteError extends RuntimeException {
        final String code;final boolean retryable,unknown;final long retryAfter;
        JsonElement usage=JsonNull.INSTANCE;
        RemoteError(String code,String message,boolean retryable,boolean unknown,long retryAfter){super(message);this.code=code;this.retryable=retryable;this.unknown=unknown;this.retryAfter=retryAfter;}
    }
    Providers(Store store){this(store,System::nanoTime,System::currentTimeMillis);}
    Providers(Store store,LongSupplier quotaNanos,LongSupplier quotaMillis){this.store=store;this.quotaNanos=Objects.requireNonNull(quotaNanos);this.quotaMillis=Objects.requireNonNull(quotaMillis);}
    JsonObject get(String id){return store.read(c->Store.document(c,"providers",id));}
    JsonArray list(){return store.read(c->{JsonArray result=new JsonArray();for(JsonElement element:Store.docs(c,"SELECT data FROM providers ORDER BY rowid")){JsonObject value=element.getAsJsonObject();if(!value.has("status"))value.addProperty("status","active");result.add(value);}return result;});}
    /** 删除前检查所有尚未结束的运行；凭据只存在内存和桌面保险库，Java 侧同步清除内存副本。 */
    JsonObject delete(JsonObject p){String id=Json.required(p,"providerId");JsonObject result;
        synchronized(this){result=store.tx(c->{Store.document(c,"providers",id);JsonArray active=new JsonArray();for(JsonObject row:Store.rows(c,"SELECT id,status FROM runs WHERE json_extract(data,'$.providerId')=? AND status NOT IN ('completed','completed_with_errors','cancelled','needs_attention')",id))active.add(Json.obj("runId",row.get("id"),"status",row.get("status")));if(!active.isEmpty())throw new ApiError(409,"provider_in_use","该接口仍被未结束任务使用，请先暂停或取消任务后再删除。",Json.obj("providerId",id,"activeRuns",active));Store.update(c,"DELETE FROM providers WHERE id=?",id);Store.event(c,"provider.deleted",null,null,null,Json.obj("providerId",id,"credentialCleared",true));return Json.obj("deleted",true,"providerId",id,"credentialCleared",true);});keys.remove(id);}return result;}
    JsonObject save(JsonObject p){
        rejectSecrets(p);String id=Json.str(p,"id",Json.id());JsonObject old=p.has("id")?get(id):new JsonObject();JsonObject value=old.deepCopy();
        for(String field:List.of("name","baseUrl","protocol","model","headers","extraParameters","quotaGroupId","concurrency","requestsPerMinute","timeoutMs","maxRetries","maxImages","capabilities","pricing"))if(p.has(field)&&!field.equals("capabilities"))value.add(field,p.get(field));
        if(p.has("pricing")&&!p.get("pricing").isJsonNull()){if(!p.get("pricing").isJsonObject())throw new ApiError(400,"pricing_invalid","单价配置必须为对象或 null。");value.add("pricing",Costs.validatePrice(p.getAsJsonObject("pricing")));}
        value.addProperty("id",id);Json.required(value,"name");String base=Json.required(value,"baseUrl").replaceAll("/+$","");
        URI uri;try{uri=URI.create(base);}catch(Exception e){throw new ApiError(400,"provider_url_invalid","接口地址不是有效 URL。");}
        if(uri.getHost()==null||uri.getUserInfo()!=null||uri.getQuery()!=null||uri.getFragment()!=null||!("https".equals(uri.getScheme())||("http".equals(uri.getScheme())&&Set.of("localhost","127.0.0.1","[::1]","::1").contains(uri.getHost()))))throw new ApiError(400,"provider_url_invalid","接口必须使用 HTTPS；本地协议测试允许回环 HTTP，地址中不能携带凭据或查询参数。");
        String protocol=Json.str(value,"protocol","chat-completions");if(Set.of("chat","chat_completions","chatCompletions","openai").contains(protocol))protocol="chat-completions";
        if(!Set.of("chat-completions","responses").contains(protocol))throw new ApiError(400,"protocol_unsupported","协议应为 chat-completions 或 responses。");
        value.addProperty("baseUrl",base);value.addProperty("protocol",protocol);
        // 接口地址、协议或请求头变了，先前登记的模型清单就属于另一个端点：留着会让选择器列出无效模型名。
        if(!base.equals(Json.str(old,"baseUrl",""))||!protocol.equals(Json.str(old,"protocol",""))
            ||!String.valueOf(value.get("headers")).equals(String.valueOf(old.get("headers")))){value.remove("models");value.remove("modelsFetchedAt");}value.addProperty("concurrency",Json.bounded(value,"concurrency",4,1,32));value.addProperty("requestsPerMinute",Json.bounded(value,"requestsPerMinute",60,1,60000));
        value.addProperty("timeoutMs",Json.bounded(value,"timeoutMs",120000,1000,600000));value.addProperty("maxRetries",Json.bounded(value,"maxRetries",2,0,6));value.addProperty("maxImages",Json.bounded(value,"maxImages",8,1,64));
        value.addProperty("revision",Json.integer(old,"revision",0)+1);value.add("capabilities",new JsonObject());value.addProperty("updatedAt",Json.now());
        try{HttpRequest.Builder validator=HttpRequest.newBuilder(uri);for(var header:Json.object(value,"headers").entrySet()){if(Set.of("host","content-length","connection","authorization","cookie").contains(header.getKey().toLowerCase()))throw new IllegalArgumentException();validator.header(header.getKey(),header.getValue().getAsString());}}
        catch(IllegalArgumentException e){throw new ApiError(400,"header_invalid","请求头名称或值无效，或尝试覆盖受保护请求头。");}
        return store.tx(c->{Store.update(c,"INSERT INTO providers(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",id,value);Store.event(c,"provider.saved",null,null,null,Json.obj("providerId",id));return value;});
    }
    static void rejectSecrets(JsonElement element){
        if(element.isJsonObject())for(var e:element.getAsJsonObject().entrySet()){
            if(sensitiveName(e.getKey()))throw new ApiError(400,"credential_field_forbidden","敏感字段应通过凭据通道设置，不能写入普通接口配置。");rejectSecrets(e.getValue());}
        else if(element.isJsonArray())for(JsonElement e:element.getAsJsonArray())rejectSecrets(e);
    }
    JsonObject credential(JsonObject p){String id=Json.required(p,"providerId");String key=Json.required(p,"key"),version=null;
        if(p.has("credentialBindingVersion")){JsonElement value=p.get("credentialBindingVersion");if(value==null||!value.isJsonPrimitive()||!value.getAsJsonPrimitive().isString()||!value.getAsString().matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"))throw new ApiError(400,"credential_binding_invalid","凭据绑定版本必须为主进程生成的 UUID。");version=value.getAsString();}
        synchronized(this){JsonObject provider=get(id);if(!Json.str(provider,"status","active").equals("active"))throw new ApiError(409,"provider_disabled","该接口已停用，请重新启用后保存凭据。");keys.put(id,new Credential(key,version));}return Json.obj("saved",true);}
    void requireCredential(JsonObject provider){if(!keys.containsKey(Json.required(provider,"id")))throw new ApiError(400,"credential_missing","请先为该接口保存 API Key。");}
    String credentialBindingVersion(String providerId){Credential value=keys.get(providerId);return value==null?null:value.bindingVersion;}
    Credential credentialFor(JsonObject provider,JsonObject snapshot){Credential value=keys.get(Json.required(provider,"id"));if(value==null)throw new ApiError(400,"credential_missing","请先为该接口保存 API Key。");if(snapshot.has("credentialBindingVersion")&&!Objects.equals(Json.str(snapshot,"credentialBindingVersion",null),value.bindingVersion))throw new ApiError(409,"credential_binding_changed","该运行固定的凭据绑定已变化，请检查配置并创建新运行。");return value;}
    private QuotaId credentialQuota(JsonObject p){return credentialQuota(p,keys.get(Json.required(p,"id")));}
    private QuotaId credentialQuota(JsonObject p,Credential credential){String id=Json.required(p,"id");
        if(credential==null)return new QuotaId(QuotaKind.PROVIDER,id);
        try{return new QuotaId(QuotaKind.CREDENTIAL,"credential-"+HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(credential.key.getBytes(StandardCharsets.UTF_8))));}catch(Exception e){throw new IllegalStateException(e);}}
    private List<QuotaId> quotas(JsonObject p){return quotas(p,keys.get(Json.required(p,"id")));}
    private List<QuotaId> quotas(JsonObject p,Credential captured){QuotaId credential=credentialQuota(p,captured);String explicit=Json.str(p,"quotaGroupId","");
        return explicit.isBlank()?List.of(credential):List.of(credential,new QuotaId(QuotaKind.MANUAL,explicit));}
    private static Quota quota(JsonObject p){return new Quota(Json.bounded(p,"concurrency",4,1,32),Json.bounded(p,"requestsPerMinute",60,1,60000));}
    private static long spacingNanos(int rpm){return (TimeUnit.MINUTES.toNanos(1)+rpm-1)/rpm;}
    String group(JsonObject p){String explicit=Json.str(p,"quotaGroupId","");return explicit.isBlank()?credentialQuota(p).value:explicit;}
    synchronized Permit acquire(JsonObject p){return acquire(p,keys.get(Json.required(p,"id")));}
    synchronized Permit acquire(JsonObject p,Credential captured){
        if(closing)return null;
        // 请求实际发送的凭据已固定；即使配置后来换 Key，也必须占用这份凭据的门槛。
        List<QuotaId> requested=quotas(p,captured);Map<QuotaId,Quota> limits=new LinkedHashMap<>();Quota own=quota(p);
        for(QuotaId id:requested)limits.put(id,own);
        // 手动组只增加门槛，不能替代凭据门槛；两个命名空间也不能因同名而误合并。
        for(JsonElement e:list()){JsonObject other=e.getAsJsonObject();Quota configured=quota(other);for(QuotaId id:quotas(other))if(limits.containsKey(id)){
            Quota prior=limits.get(id);limits.put(id,new Quota(Math.min(prior.concurrency,configured.concurrency),Math.min(prior.rpm,configured.rpm)));}}
        long now=quotaNanos.getAsLong();
        for(var entry:limits.entrySet()){Gate gate=gates.get(entry.getKey());Quota limit=entry.getValue();
            if(gate!=null&&(gate.active>=limit.concurrency||(gate.used&&now-gate.lastNanos<spacingNanos(limit.rpm))))return null;}
        // 全部门槛通过后才占用；失败申请既不保留部分并发，也不提前消耗另一个门槛的频率。
        long wall=quotaMillis.getAsLong();List<Gate> acquired=new ArrayList<>();String explicit=Json.str(p,"quotaGroupId","");String group=explicit.isBlank()?requested.getFirst().value:explicit;
        GroupView accounting=quotaGroups.computeIfAbsent(group,k->new GroupView());
        for(var entry:limits.entrySet()){Gate gate=gates.computeIfAbsent(entry.getKey(),k->new Gate());gate.active++;gate.used=true;gate.lastNanos=now;
            gate.next=wall+(spacingNanos(entry.getValue().rpm)+999999)/1000000;acquired.add(gate);accounting.gates.add(gate);}
        accounting.active++;return new Permit(this,group,acquired,accounting);
    }
    synchronized void release(Permit p){
        if(p==null||p.owner!=this||p.released)return;
        // 释放申请时取得的对象；配置或凭据后来变化，也不能扣到新门槛或重复释放别人的额度。
        for(Gate gate:p.acquired)gate.active--;p.accounting.active--;p.released=true;
    }
    Permit awaitPermit(JsonObject provider){return awaitPermit(provider,keys.get(Json.required(provider,"id")));}
    Permit awaitPermit(JsonObject provider,Credential captured){long deadline=System.nanoTime()+TimeUnit.MILLISECONDS.toNanos(Json.integer(provider,"timeoutMs",120000));
        while(!closing){if(Thread.currentThread().isInterrupted())throw new ApiError(499,"call_cancelled","请求在发送前已取消，未占用请求预算。");Permit permit=acquire(provider,captured);if(permit!=null)return permit;
            if(System.nanoTime()>=deadline)throw new ApiError(429,"provider_capacity_timeout","等待共享接口额度超时，请调整频率或稍后重试；本次没有发送请求。");
            try{Thread.sleep(40);}catch(InterruptedException e){Thread.currentThread().interrupt();throw new ApiError(499,"call_cancelled","请求在发送前已取消，未占用请求预算。");}}
        throw new ApiError(503,"engine_stopping","引擎正在退出，请求尚未发送。");
    }
    synchronized JsonObject limits(){JsonObject result=new JsonObject();quotaGroups.forEach((id,g)->result.add(id,Json.obj("inFlight",g.active,"nextAvailableAt",g.gates.stream().mapToLong(gate->gate.next).max().orElse(0))));return result;}
    JsonElement activity(){return Json.element(interactive.getActiveCount()+interactive.getQueue().size());}
    JsonObject body(JsonObject provider,String model,JsonArray messages,JsonArray tools,boolean structured){return body(provider,model,messages,tools,structured,false);}
    JsonObject body(JsonObject provider,String model,JsonArray messages,JsonArray tools,boolean structured,boolean stream){
        boolean responses=Json.str(provider,"protocol","").equals("responses");JsonObject body=Json.object(provider,"extraParameters").deepCopy();
        for(String key:List.of("model","messages","input","tools","stream","authorization"))body.remove(key);
        body.addProperty("model",model);body.addProperty("stream",stream);
        if(!responses){body.add("messages",messages);if(!tools.isEmpty())body.add("tools",tools);if(structured)body.add("response_format",Json.obj("type","json_object"));}
        else{
            JsonArray input=new JsonArray();for(JsonElement e:messages){JsonObject m=e.getAsJsonObject();String role=Json.required(m,"role");
                if(role.equals("tool")){input.add(Json.obj("type","function_call_output","call_id",Json.required(m,"tool_call_id"),"output",Json.str(m,"content","")));continue;}
                JsonElement content=m.get("content");if(content!=null&&!content.isJsonNull()){
                    JsonArray parts=new JsonArray();if(content.isJsonPrimitive())parts.add(Json.obj("type",role.equals("assistant")?"output_text":"input_text","text",content.getAsString()));
                    else for(JsonElement part:content.getAsJsonArray()){JsonObject q=part.getAsJsonObject();String type=Json.str(q,"type","");
                        if(type.equals("text"))parts.add(Json.obj("type",role.equals("assistant")?"output_text":"input_text","text",Json.str(q,"text","")));
                        else if(type.equals("image_url"))parts.add(Json.obj("type","input_image","image_url",imageUrl(Json.object(q,"image_url"))));
                        else throw new ApiError(400,"message_part_unsupported","不支持该消息内容类型。");}
                    input.add(Json.obj("role",role,"content",parts));}
                for(JsonElement call:Json.array(m,"tool_calls")){JsonObject q=call.getAsJsonObject(),f=Json.object(q,"function");input.add(Json.obj("type","function_call","call_id",Json.required(q,"id"),"name",Json.required(f,"name"),"arguments",Json.str(f,"arguments","{}")));}
            }body.add("input",input);
            if(!tools.isEmpty()){JsonArray mapped=new JsonArray();for(JsonElement e:tools){JsonObject f=Json.object(e.getAsJsonObject(),"function");JsonObject t=f.deepCopy();t.addProperty("type","function");mapped.add(t);}body.add("tools",mapped);}
            if(structured)body.add("text",Json.obj("format",Json.obj("type","json_object")));
        }return body;
    }
    static String imageUrl(JsonObject image){
        JsonElement field=image.get("url");if(field==null||!field.isJsonPrimitive()||!field.getAsJsonPrimitive().isString())throw new ApiError(400,"image_url_invalid","图片 URL 缺失或无效。");String value=field.getAsString();
        // 图片数据不是普通文本字段，按图片字节上限检查，不能套用提示词的字符数限制。
        if(value.startsWith("data:image/")){int comma=value.indexOf(',');if(comma<0||comma>100||!value.substring(0,comma).endsWith(";base64"))throw new ApiError(400,"image_url_invalid","图片 data URL 必须使用 base64 编码。");long encoded=value.length()-comma-1L,padding=value.endsWith("==")?2:value.endsWith("=")?1:0;if(encoded==0||encoded%4!=0||encoded/4*3-padding>32L*1024*1024)throw new ApiError(413,"image_payload_too_large","单张图片数据不能超过 32 MiB。");return value;}
        return Json.required(image,"url");
    }
    JsonObject request(JsonObject p,String suffix,JsonObject body){
        return request(p,suffix,body,credentialFor(p,new JsonObject()));
    }
    private JsonObject request(JsonObject p,String suffix,JsonObject body,Credential credential){
        String key=credential.key;
        HttpRequest.Builder builder=HttpRequest.newBuilder(URI.create(Json.required(p,"baseUrl")+suffix)).timeout(Duration.ofMillis(Json.integer(p,"timeoutMs",120000))).header("Authorization","Bearer "+key).header("Accept","application/json");
        for(var e:Json.object(p,"headers").entrySet()){String name=e.getKey();if(Set.of("host","content-length","connection","authorization","cookie").contains(name.toLowerCase()))throw new ApiError(400,"header_forbidden","不允许覆盖受保护请求头。");builder.header(name,e.getValue().getAsString());}
        if(body==null)builder.GET();else builder.header("Content-Type","application/json").POST(HttpRequest.BodyPublishers.ofString(body.toString(),StandardCharsets.UTF_8));
        CompletableFuture<HttpResponse<byte[]>> pending=null;
        try{
            // 总超时覆盖响应体接收，不能让“已返回头但正文停滞”的请求长期占用额度。
            pending=client.sendAsync(builder.build(),info->new LimitedBody());
            HttpResponse<byte[]> response=pending.get(Json.integer(p,"timeoutMs",120000),TimeUnit.MILLISECONDS);byte[] bytes=response.body();
            int status=response.statusCode();if(status<200||status>=300){String code=switch(status){case 401,403->"provider_auth_failed";case 404->"provider_model_or_route_not_found";case 429->"provider_rate_limited";default->"provider_http_"+status;};
                long retryAfter=0;String header=response.headers().firstValue("Retry-After").orElse("");try{retryAfter=Math.max(0,Long.parseLong(header)*1000);}catch(Exception e){try{retryAfter=Math.max(0,ZonedDateTime.parse(header,java.time.format.DateTimeFormatter.RFC_1123_DATE_TIME).toInstant().toEpochMilli()-System.currentTimeMillis());}catch(Exception ignored){}}
                RemoteError failure=new RemoteError(code,"接口返回 HTTP "+status+"，请核对接口、模型与权限。",status==429||status>=500,false,Math.min(retryAfter,3600000));try{JsonObject errorBody=Json.parse(new String(bytes,StandardCharsets.UTF_8));if(errorBody.has("usage"))failure.usage=errorBody.get("usage");}catch(Exception ignored){}throw failure;}
            try{return Json.parse(new String(bytes,StandardCharsets.UTF_8));}catch(Exception e){throw new RemoteError("provider_response_invalid","接口没有返回有效 JSON。",false,false,0);}
        }catch(RemoteError e){throw e;}catch(TimeoutException e){throw new RemoteError("provider_timeout","请求超时，远端是否完成未知；不会自动重发。",false,true,0);}
        catch(InterruptedException e){Thread.currentThread().interrupt();throw new RemoteError("request_interrupted","调用中断，远端结果未知。",false,true,0);}
        catch(ExecutionException e){Throwable cause=e.getCause();if(cause instanceof HttpTimeoutException)throw new RemoteError("provider_timeout","请求超时，远端是否完成未知；不会自动重发。",false,true,0);
            if(cause!=null&&String.valueOf(cause.getMessage()).contains("response_size_limit"))throw new RemoteError("response_too_large","接口返回超过 8 MiB，已停止接收与解析。",false,false,0);
            throw new RemoteError("provider_network_unknown","网络连接中断，远端结果未知。",false,true,0);}
        finally{if(pending!=null&&!pending.isDone())pending.cancel(true);}
    }
    /** 读取一次 SSE 流；只有收到解析器确认的完整终态才返回，任何提前结束均标记为未知。 */
    private JsonObject requestStreaming(JsonObject p,String suffix,JsonObject body,Credential credential,java.util.function.Consumer<String> onDelta){
        String key=credential.key;
        HttpRequest.Builder builder=HttpRequest.newBuilder(URI.create(Json.required(p,"baseUrl")+suffix)).timeout(Duration.ofMillis(Json.integer(p,"timeoutMs",120000))).header("Authorization","Bearer "+key).header("Accept","text/event-stream");
        for(var e:Json.object(p,"headers").entrySet()){String name=e.getKey();if(Set.of("host","content-length","connection","authorization","cookie").contains(name.toLowerCase()))throw new ApiError(400,"header_forbidden","不允许覆盖受保护请求头。");builder.header(name,e.getValue().getAsString());}
        builder.header("Content-Type","application/json").POST(HttpRequest.BodyPublishers.ofString(body.toString(),StandardCharsets.UTF_8));
        CompletableFuture<HttpResponse<InputStream>> pending=null;
        try{
            pending=client.sendAsync(builder.build(),HttpResponse.BodyHandlers.ofInputStream());
            HttpResponse<InputStream> response=pending.get(Json.integer(p,"timeoutMs",120000),TimeUnit.MILLISECONDS);
            int status=response.statusCode();
            if(status<200||status>=300){byte[] bytes=response.body().readNBytes(8*1024*1024+1);String code=switch(status){case 401,403->"provider_auth_failed";case 404->"provider_model_or_route_not_found";case 429->"provider_rate_limited";default->"provider_http_"+status;};RemoteError failure=new RemoteError(code,"接口返回 HTTP "+status+"，请核对接口、模型与权限。",status==429||status>=500,false,0);try{JsonObject errorBody=Json.parse(new String(bytes,StandardCharsets.UTF_8));if(errorBody.has("usage"))failure.usage=errorBody.get("usage");}catch(Exception ignored){}throw failure;}
            String contentType=response.headers().firstValue("Content-Type").orElse("");if(!contentType.toLowerCase(Locale.ROOT).contains("text/event-stream"))throw new RemoteError("provider_response_invalid","流式请求未返回 text/event-stream。",false,false,0);
            try(InputStream input=response.body()){return new ProviderStreams(Json.str(p,"protocol","chat-completions"),onDelta).read(input);}
            catch(ProviderStreams.StreamError failure){throw new RemoteError(failure.code,failure.getMessage(),false,true,0);}
            catch(IOException failure){throw new RemoteError("provider_stream_unknown","接口流读取中断，远端结果未知。",false,true,0);}
        }catch(RemoteError e){throw e;}catch(TimeoutException e){throw new RemoteError("provider_timeout","请求超时，远端是否完成未知；不会自动重发。",false,true,0);}
        catch(InterruptedException e){Thread.currentThread().interrupt();throw new RemoteError("request_interrupted","调用中断，远端结果未知。",false,true,0);}
        catch(ExecutionException e){Throwable cause=e.getCause();if(cause instanceof HttpTimeoutException)throw new RemoteError("provider_timeout","请求超时，远端是否完成未知；不会自动重发。",false,true,0);throw new RemoteError("provider_network_unknown","网络连接中断，远端结果未知。",false,true,0);}
        catch(IOException e){throw new RemoteError("provider_stream_unknown","接口流读取中断，远端结果未知。",false,true,0);}
        finally{if(pending!=null&&!pending.isDone())pending.cancel(true);}
    }
    Reply complete(JsonObject provider,JsonObject body){return complete(provider,body,credentialFor(provider,new JsonObject()),ignored -> {});}
    Reply complete(JsonObject provider,JsonObject body,Credential credential){return complete(provider,body,credential,ignored -> {});}
    Reply complete(JsonObject provider,JsonObject body,Credential credential,java.util.function.Consumer<String> onDelta){
        String suffix=Json.str(provider,"protocol","").equals("responses")?"/responses":"/chat/completions";
        JsonObject raw=Json.bool(body,"stream",false)?requestStreaming(provider,suffix,body,credential,onDelta):request(provider,suffix,body,credential);StringBuilder text=new StringBuilder();JsonArray calls=new JsonArray();
        try{
        if(Json.str(provider,"protocol","").equals("responses")){
            if(raw.has("status")&&!Json.str(raw,"status","").equals("completed"))throw new RemoteError("provider_incomplete","接口未完成响应，请检查长度或服务状态。",false,false,0);
            for(JsonElement e:Json.array(raw,"output")){JsonObject item=e.getAsJsonObject();String type=Json.str(item,"type","");
                if(type.equals("function_call"))calls.add(Json.obj("id",Json.str(item,"call_id",Json.str(item,"id",Json.id())),"name",Json.required(item,"name"),"arguments",Json.str(item,"arguments","{}")));
                for(JsonElement c:Json.array(item,"content")){JsonObject part=c.getAsJsonObject();if(Json.str(part,"type","").equals("output_text"))text.append(Json.str(part,"text",""));}
            }
        }else{JsonArray choices=Json.array(raw,"choices");if(choices.isEmpty())throw new RemoteError("provider_response_missing","接口响应缺少 choices。",false,false,0);
            JsonObject choice=choices.get(0).getAsJsonObject();if(Set.of("length","content_filter").contains(Json.str(choice,"finish_reason","")))throw new RemoteError("provider_incomplete","模型响应被截断或过滤。",false,false,0);
            JsonObject m=Json.object(choice,"message");JsonElement content=m.get("content");if(content!=null&&!content.isJsonNull()){if(content.isJsonPrimitive())text.append(content.getAsString());else for(JsonElement e:content.getAsJsonArray())text.append(Json.str(e.getAsJsonObject(),"text",""));}
            for(JsonElement e:Json.array(m,"tool_calls")){JsonObject q=e.getAsJsonObject(),f=Json.object(q,"function");calls.add(Json.obj("id",Json.required(q,"id"),"name",Json.required(f,"name"),"arguments",Json.str(f,"arguments","{}")));}}
        return new Reply(text.toString(),calls,raw.has("usage")?raw.get("usage"):JsonNull.INSTANCE,raw);
        }catch(RemoteError failure){if(raw.has("usage"))failure.usage=raw.get("usage");throw failure;}
    }
    JsonObject chat(JsonObject payload){
        String session=Json.str(payload,"sessionId",Json.id());Future<JsonObject> pending=null;
        try{pending=interactive.submit(()->callTracked(payload));sessions.computeIfAbsent(session,k->ConcurrentHashMap.newKeySet()).add(pending);return pending.get();}catch(RejectedExecutionException e){throw new ApiError(429,"interactive_busy","对话调用繁忙，请稍后重试。");}
        catch(CancellationException e){throw new ApiError(499,"call_cancelled","对话已取消；已发送调用的状态会单独保存。");}
        catch(InterruptedException e){if(pending!=null)pending.cancel(true);Thread.currentThread().interrupt();throw new ApiError(503,"interrupted","对话等待中断。");}
        // 远端失败已由 callTracked 转成 ApiError/RemoteError；能走到这里的通常是本地处理异常（空指针、类初始化失败等）。
        // 此前一律压成「接口调用失败」，用户既看不到原因也拿不到线索，这里保留类型与消息并写入引擎日志。
        catch(ExecutionException e){Throwable cause=e.getCause()==null?e:e.getCause();if(cause instanceof ApiError a)throw a;
            if(cause instanceof RemoteError r)throw new ApiError(502,r.code,r.getMessage());
            System.err.println("provider_call_failed:"+cause.getClass().getName()+":"+cause.getMessage());cause.printStackTrace(System.err);
            throw new ApiError(500,"provider_call_failed_internal","调用未完成（本地处理异常 "+cause.getClass().getSimpleName()+"）："+(cause.getMessage()==null?"无附加信息":cause.getMessage()));}
        finally{if(pending!=null){Set<Future<?>> set=sessions.get(session);if(set!=null){set.remove(pending);if(set.isEmpty())sessions.remove(session,set);}}}
    }
    JsonObject cancel(String session){int cancelled=0;Set<Future<?>> calls=sessions.get(session);if(calls!=null)for(Future<?> call:calls)if(call.cancel(true))cancelled++;return Json.obj("sessionId",session,"cancelled",cancelled);}
    JsonObject callTracked(JsonObject p){JsonObject provider=get(Json.required(p,"providerId"));Credential capturedCredential=credentialFor(provider,new JsonObject());String model=Json.required(p,"model");JsonArray messages=Json.array(p,"messages");if(messages.isEmpty())throw new ApiError(400,"messages_required","对话消息不能为空。");
        boolean stream=Json.bool(p,"stream",false);
        JsonObject body=body(provider,model,messages,Json.array(p,"tools"),Json.bool(p,"structured",false),stream);store.requireSpace(0);
        store.tx(c->{Store.event(c,"call.queued",Json.str(p,"runId",null),null,null,Json.obj("purpose","chat","sessionId",p.get("sessionId"),"providerId",provider.get("id")));return null;});
        Permit permit;try{permit=awaitPermit(provider,capturedCredential);}catch(ApiError e){store.tx(c->{Store.event(c,"call.not_sent",Json.str(p,"runId",null),null,null,Json.obj("sessionId",p.get("sessionId"),"code",e.code,"requestsReserved",0));return null;});throw e;}
        String attempt=Json.id(),runId=Json.str(p,"runId",null);String scope=runId==null?Budgets.scope(p,"chat-"+attempt):store.read(c->Json.str(Store.document(c,"runs",runId),"budgetScopeId",runId));JsonObject data=Json.obj("id",attempt,"sessionId",p.get("sessionId"),"budgetScopeId",scope,"providerId",provider.get("id"),"model",model,"status","sent","sentAt",Json.now(),"usage",JsonNull.INSTANCE,"purpose","chat");
        data.add("priceSnapshot",Costs.snapshot(provider,model));Costs.attach(data);
        try{
            store.tx(c->{Budgets.ensure(c,scope,Json.number(p,"maxRequests",Long.MAX_VALUE),false);Costs.reserve(c,scope,Json.object(data,"priceSnapshot"));Budgets.reserve(c,scope);if(runId!=null){JsonObject run=Store.document(c,"runs",runId);long used=Json.number(run,"requestsUsed",0),max=Json.number(run,"maxRequests",Long.MAX_VALUE);if(used>=max)throw new ApiError(409,"budget_exhausted","关联任务请求预算已用尽。");run.addProperty("requestsUsed",used+1);Store.update(c,"UPDATE runs SET data=? WHERE id=?",run,runId);}
                Store.update(c,"INSERT INTO attempts(id,run_id,group_id,status,data) VALUES(?,?,?,?,?)",attempt,runId,permit.group,"sent",data);Store.event(c,"call.sent",runId,null,attempt,Json.obj("purpose","chat","sessionId",p.get("sessionId")));return null;});
            // 增量事件是可丢失的观察通知；事件总线异常不能让已收到的完整远端响应被误记为失败。
            java.util.function.Consumer<String> onDelta=fragment->{try{store.tx(c->{Store.event(c,"call.delta",runId,null,attempt,Json.obj("sessionId",p.get("sessionId"),"delta",fragment));return null;});}catch(RuntimeException ignored){}};
            Reply reply=complete(provider,body,capturedCredential,onDelta);data.addProperty("status","completed");data.add("usage",reply.usage);data.addProperty("completedAt",Json.now());finish(attempt,data,runId);
            return Json.obj("content",reply.content,"toolCalls",reply.tools,"usage",reply.usage,"attemptId",attempt,"budget",store.read(c->Budgets.view(c,scope)));
        }catch(RemoteError e){data.addProperty("status",e.unknown?"unknown":"failed");data.addProperty("errorCode",e.code);data.add("usage",e.usage);finish(attempt,data,runId);throw new ApiError(502,e.code,e.getMessage());}
        finally{release(permit);}
    }
    void finish(String id,JsonObject data,String run){Costs.attach(data);store.tx(c->{Store.update(c,"UPDATE attempts SET status=?,data=? WHERE id=?",Json.required(data,"status"),data,id);Store.event(c,"call."+Json.required(data,"status"),run,null,id,Json.obj("usage",data.get("usage"),"cost",data.get("cost"),"errorCode",data.get("errorCode")));return null;});}
    /**
     * 读取接口模型列表，并把结果登记进 provider 文档。
     * 只返回不落库的话，扫描结果一刷新就丢，模型选择器只能退回「每个接口一个已保存模型」的旧行为。
     * 不触碰 revision / capabilities / updatedAt：列模型既不是配置变更，也不代表任何能力通过验证。
     * 落库前比对 revision，请求期间配置被改过就重读快照重试；仍冲突则如实报错——
     * 静默放弃会让界面照常弹出「已登记」，实际却没存上。
     */
    JsonObject models(String id){
        for(int attempt=0;attempt<3;attempt++){
            JsonObject p=get(id);JsonObject raw=request(p,"/models",null);
            // 保留接口返回顺序并去重：同一模型名重复出现时下拉里只应有一条。
            LinkedHashSet<String> names=new LinkedHashSet<>();
            for(JsonElement e:Json.array(raw,"data")){JsonObject m=e.getAsJsonObject();JsonElement value=m.get("id");
                if(value==null||!value.isJsonPrimitive()||!value.getAsJsonPrimitive().isString())continue;
                String name=value.getAsString().trim();if(name.isEmpty())continue;
                names.add(name.length()>MAX_MODEL_NAME?name.substring(0,MAX_MODEL_NAME):name);
                if(names.size()>=MAX_MODELS)break;}
            JsonArray list=new JsonArray();for(String name:names)list.add(name);
            JsonArray snapshot=list.deepCopy();
            Boolean written=store.tx(c->{JsonObject current=Store.document(c,"providers",id);
                if(Json.integer(current,"revision",0)!=Json.integer(p,"revision",0))return Boolean.FALSE;
                current.add("models",snapshot);current.addProperty("modelsFetchedAt",Json.now());Store.update(c,"UPDATE providers SET data=? WHERE id=?",current,id);return Boolean.TRUE;});
            if(Boolean.TRUE.equals(written))return Json.obj("models",list);
        }
        throw new ApiError(409,"models_conflict","接口配置在读取模型列表期间被修改，清单未登记，请重试一次。");
    }
    JsonObject capabilities(JsonObject p){JsonObject provider=get(Json.required(p,"providerId"));JsonObject result=Json.obj("text","unverified","tools","unverified","image","unverified","multiImage","unverified","structured","unverified","connection","unverified","revision",provider.get("revision"));
        JsonObject saved=Json.object(Json.object(provider,"capabilities"),Json.required(p,"model"));for(var e:saved.entrySet()){result.add(e.getKey(),Json.object(saved,e.getKey()).get("status"));}result.add("tests",saved);return result;}
    static String capabilityImage(int index)throws Exception{
        // 由编码器产生完整 PNG，避免手抄 Base64 的 CRC 错误被误判为远端不支持图片。
        var picture=new java.awt.image.BufferedImage(64,64,java.awt.image.BufferedImage.TYPE_INT_RGB);var graphics=picture.createGraphics();
        try{graphics.setColor(java.awt.Color.WHITE);graphics.fillRect(0,0,64,64);graphics.setColor(index==0?java.awt.Color.RED:java.awt.Color.BLUE);if(index==0)graphics.fillRect(12,12,40,40);else graphics.fillOval(12,12,40,40);}finally{graphics.dispose();}
        var bytes=new java.io.ByteArrayOutputStream();if(!javax.imageio.ImageIO.write(picture,"png",bytes))throw new java.io.IOException("PNG encoder unavailable");return "data:image/png;base64,"+Base64.getEncoder().encodeToString(bytes.toByteArray());
    }
    JsonObject test(JsonObject p){String id=Json.required(p,"providerId"),model=Json.required(p,"model"),cap=Json.required(p,"capability");
        if(!Set.of("connection","text","image","multiImage","structured","tools").contains(cap))throw new ApiError(400,"capability_unknown","不支持该能力测试。");
        JsonObject provider=get(id);JsonObject result=Json.obj("status","unverified","testedAt",Json.now(),"revision",provider.get("revision"),"model",model);
        try{
            if(cap.equals("connection")){models(id);result.addProperty("status","verified");result.addProperty("message","模型列表接口可连接；不代表模型可调用。");}
            else{
                JsonArray tools=new JsonArray(),messages=new JsonArray();JsonArray content=Json.arr(Json.obj("type","text","text",cap.equals("tools")?"Call the report_status tool once with status='ok'.":cap.equals("structured")?"Return exactly a JSON object with ok=true.":"Reply OK. If images are attached, state their count."));
                if(cap.equals("image")||cap.equals("multiImage")){content.add(Json.obj("type","image_url","image_url",Json.obj("url",capabilityImage(0))));if(cap.equals("multiImage"))content.add(Json.obj("type","image_url","image_url",Json.obj("url",capabilityImage(1))));}
                if(cap.equals("tools"))tools.add(Json.obj("type","function","function",Json.obj("name","report_status","description","Report test status","parameters",Json.obj("type","object","properties",Json.obj("status",Json.obj("type","string")),"required",Json.arr("status")))));
                messages.add(Json.obj("role","user","content",content));JsonObject response=chat(Json.obj("providerId",id,"model",model,"messages",messages,"tools",tools,"structured",cap.equals("structured")));
                if(cap.equals("tools")){JsonArray calls=Json.array(response,"toolCalls");if(calls.size()!=1)throw new ApiError(422,"tools_not_demonstrated","本次响应未按约定调用一次 report_status，能力仍未验证。");JsonObject call=calls.get(0).getAsJsonObject(),arguments=Json.parse(Json.required(call,"arguments"));if(!Json.str(call,"name","").equals("report_status")||!Json.str(arguments,"status","").equals("ok"))throw new ApiError(422,"tools_not_demonstrated","工具名称或 status 参数不符合能力测试约定。");}
                if(!cap.equals("tools")&&Json.str(response,"content","").isBlank())throw new ApiError(422,"text_not_demonstrated","本次响应没有可用文本，能力仍未验证。");
                if(cap.equals("structured")){JsonElement ok=Json.parse(Json.required(response,"content")).get("ok");if(ok==null||!ok.isJsonPrimitive()||!ok.getAsJsonPrimitive().isBoolean()||!ok.getAsBoolean())throw new ApiError(422,"structured_not_demonstrated","结构化响应未返回布尔 ok=true，能力仍未验证。");}
                result.addProperty("status","verified");result.addProperty("message",cap.equals("image")||cap.equals("multiImage")?"图片请求被接口接受并返回文本；这不代表定位质量已验证。":"本次能力测试通过。");
            }
        }catch(Exception e){result.addProperty("message",e instanceof ApiError a?a.getMessage():e instanceof RemoteError r?r.getMessage():"响应未符合测试结构，能力仍未验证。");}
        store.tx(c->{JsonObject current=Store.document(c,"providers",id);if(Json.integer(current,"revision",0)==Json.integer(provider,"revision",0)){JsonObject caps=Json.object(current,"capabilities"),byModel=Json.object(caps,model);byModel.add(cap,result);caps.add(model,byModel);current.add("capabilities",caps);Store.update(c,"UPDATE providers SET data=? WHERE id=?",current,id);}return null;});return result;
    }
    static boolean sensitiveName(String name){String n=name.toLowerCase(Locale.ROOT).replace("-","").replace("_","");return n.matches(".*(authorization|apikey|secret|password|cookie).*|key|token|accesstoken|refreshtoken|xauthtoken");}
    JsonElement redact(JsonElement value){return redact(value,null);}
    JsonElement redact(JsonElement value,Credential sentCredential){if(value==null)return JsonNull.INSTANCE;if(value.isJsonObject()){JsonObject o=new JsonObject();for(var e:value.getAsJsonObject().entrySet())o.add(e.getKey(),sensitiveName(e.getKey())?Json.element("[redacted]"):redact(e.getValue(),sentCredential));return o;}
        if(value.isJsonArray()){JsonArray a=new JsonArray();for(JsonElement e:value.getAsJsonArray())a.add(redact(e,sentCredential));return a;}
        if(value.isJsonPrimitive()&&value.getAsJsonPrimitive().isString()){String s=value.getAsString();if(s.startsWith("data:image/"))return Json.element("[image reference]");for(Credential credential:keys.values())if(!credential.key.isEmpty())s=s.replace(credential.key,"[redacted]");if(sentCredential!=null&&!sentCredential.key.isEmpty())s=s.replace(sentCredential.key,"[redacted]");return Json.element(s);}return value.deepCopy();}
    void close(){closing=true;for(Set<Future<?>> calls:sessions.values())for(Future<?> call:calls)call.cancel(true);for(Runnable waiting:interactive.shutdownNow())if(waiting instanceof Future<?> f)f.cancel(true);client.shutdownNow();try{interactive.awaitTermination(5,TimeUnit.SECONDS);}catch(InterruptedException e){Thread.currentThread().interrupt();}keys.clear();}
}
