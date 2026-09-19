package cn.autolabel.engine;

import com.google.gson.*;
import com.google.gson.stream.JsonReader;
import com.google.gson.stream.JsonToken;
import javax.imageio.ImageIO;
import javax.imageio.ImageReader;
import javax.imageio.stream.ImageInputStream;
import java.io.*;
import java.nio.ByteBuffer;
import java.nio.charset.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.Consumer;
import java.util.function.BooleanSupplier;

final class LocalInference implements AutoCloseable {
    private static final int PROTOCOL=1,REQUEST_LIMIT=1024*1024,RESPONSE_LIMIT=32*1024*1024,LOG_LIMIT=256*1024;
    private final Path python,script;
    /** 开放词汇的两个目录：词表缓存与 CLIP 编码器。为空表示未配置，worker 侧按「没有缓存/没有编码器」处理。 */
    private final String vocabularyCache,textEncoder;
    private final BooleanSupplier cancelledByOwner;
    private final Object gate=new Object();
    private final byte[] logs=new byte[LOG_LIMIT];
    private int logStart,logSize;
    private long generation;
    private boolean closed;
    private Session session;
    private Operation active;
    private JsonObject loaded,runtime;

    record Prediction(JsonObject rawResult,JsonArray annotations,JsonArray issues,boolean adoptable,JsonObject provenance){}
    private static final class Operation {
        final String id;final long deadline;final CompletableFuture<Void> aborted=new CompletableFuture<>();long generation;
        Operation(String id,long timeout){this.id=id;deadline=System.nanoTime()+TimeUnit.MILLISECONDS.toNanos(timeout);}
    }
    private static final class Pending {
        final String id,command,assetId;final Consumer<JsonObject> events;final CompletableFuture<JsonObject> response=new CompletableFuture<>();int eventCount;
        Pending(String id,String command,String assetId,Consumer<JsonObject> events){this.id=id;this.command=command;this.assetId=assetId;this.events=events;}
    }
    private record Observation(Consumer<JsonObject> callback,JsonObject event){}
    private static final class Session {
        final Process process;final long generation;final String workerHash;final Set<String> requestIds=new HashSet<>();final CompletableFuture<Void> ready=new CompletableFuture<>();volatile boolean stopped;Pending pending;
        final ArrayBlockingQueue<Observation> observations=new ArrayBlockingQueue<>(64);Thread observer;
        Session(Process process,long generation,String workerHash){this.process=process;this.generation=generation;this.workerHash=workerHash;}
    }

    LocalInference(Path pythonExe,Path workerScript){this(pythonExe,workerScript,()->false,null,null);}
    LocalInference(Path pythonExe,Path workerScript,BooleanSupplier cancelled){this(pythonExe,workerScript,cancelled,null,null);}
    LocalInference(Path pythonExe,Path workerScript,BooleanSupplier cancelled,String vocabularyCache,String textEncoder){python=pythonExe.toAbsolutePath().normalize();script=workerScript.toAbsolutePath().normalize();cancelledByOwner=cancelled;this.vocabularyCache=vocabularyCache;this.textEncoder=textEncoder;}

    JsonObject probe(long timeoutMs){
        Operation operation=begin(Json.id(),timeoutMs);
        try{JsonObject result=call(operation,"probe",new JsonObject(),null);synchronized(gate){check(operation);runtime=result.deepCopy();return result;}}
        finally{finish(operation);}
    }

    JsonObject load(JsonObject parameters,long timeoutMs){
        parameters=parameters.deepCopy();
        Operation operation=begin(Json.str(parameters,"requestId",Json.id()),timeoutMs);synchronized(gate){loaded=null;}
        try{
            Path path=file(parameters,"modelPath",Set.of("pt","onnx"));String expected=Media.hash(path);
            if(parameters.has("expectedModelHash")&&!expected.equals(hashField(parameters,"expectedModelHash")))throw error(409,"local_model_changed","模型内容与运行快照不一致。");
            String task=Json.required(parameters,"taskType"),device=Json.str(parameters,"device","cpu");
            if(!Annotations.TYPES.contains(task))throw error(400,"task_invalid","不支持该本地标注任务。");
            if(!device.matches("cpu|[0-9]{1,3}"))throw error(400,"device_invalid","设备应为 cpu 或单个 GPU 编号。");
            boolean openVocabulary=Json.bool(parameters,"openVocabulary",false);
            JsonObject loadPayload=Json.obj("modelPath",path.toString(),"expectedModelHash",expected,"taskType",task,"device",device);
            if(openVocabulary)loadPayload.addProperty("openVocabulary",true);
            JsonObject result=call(operation,"load",loadPayload,null);
            if(!strictBoolean(result,"loaded")||!task.equals(Json.str(result,"taskType",""))||!expected.equals(Json.str(result,"modelHash",""))||!device.equals(requestedDevice(result)))throw error(502,"local_result_invalid","模型载入响应与固定配置不一致。");
            if(openVocabulary&&!strictBoolean(result,"openVocabulary"))throw error(502,"local_result_invalid","开放词汇模型载入响应缺少标记。");
            verifyModel(path,expected);classes(result);check(operation);
            JsonObject snapshot=result.deepCopy();snapshot.remove("device");snapshot.addProperty("requestedDevice",device);snapshot.add("observedBackend",observed(result));snapshot.addProperty("modelPath",path.toString());snapshot.addProperty("protocolVersion",PROTOCOL);
            synchronized(gate){check(operation);snapshot.addProperty("workerHash",session.workerHash);loaded=snapshot.deepCopy();return snapshot;}
        }catch(ApiError e){synchronized(gate){loaded=null;}throw e;}
        catch(Exception e){synchronized(gate){loaded=null;}throw error(500,"local_model_load_failed","本地模型未能载入，请检查文件和推理环境。");}
        finally{finish(operation);}
    }

    Prediction predict(JsonObject request,JsonObject frozenAsset,JsonObject frozenProject,long timeoutMs,Consumer<JsonObject> events){
        request=request.deepCopy();frozenAsset=frozenAsset.deepCopy();frozenProject=frozenProject.deepCopy();
        Operation operation=begin(Json.required(request,"requestId"),timeoutMs);
        try{
            check(operation);
            JsonObject model;synchronized(gate){if(loaded==null)throw error(409,"model_required","请先成功载入本地模型。");model=loaded.deepCopy();}
            String assetId=Json.required(frozenAsset,"id"),task=Json.required(frozenProject,"taskType"),modelHash=hashField(model,"modelHash"),inputHash=hashField(frozenAsset,"contentHash");
            if(!assetId.equals(Json.required(request,"assetId"))||!task.equals(Json.required(model,"taskType")))throw error(409,"local_input_mismatch","本地模型或素材与冻结任务不一致。");
            if(request.has("expectedInputHash")&&!inputHash.equals(hashField(request,"expectedInputHash")))throw error(409,"local_input_changed","输入图片与运行快照不一致。");
            if(request.has("expectedModelHash")&&!modelHash.equals(hashField(request,"expectedModelHash")))throw error(409,"local_model_changed","已载入模型与运行快照不一致。");
            Path modelPath=Path.of(Json.required(model,"modelPath")),imagePath=file(request,"imagePath",Set.of("png","jpg","jpeg"));verifyModel(modelPath,modelHash);verifyImage(imagePath,inputHash,frozenAsset);
            JsonArray textClasses=request.has("textClasses")?Json.array(request,"textClasses").deepCopy():null;
            JsonObject mapping=mapping(request,model,frozenProject,textClasses),payload=Json.obj("assetId",assetId,"imagePath",imagePath.toString(),"expectedInputHash",inputHash,"classMap",mapping,
                "confidence",number(request,"confidence",0.25,0,1,false),"iou",number(request,"iou",0.7,0,1,false),"imageSize",number(request,"imageSize",640,32,4096,true),"maxDetections",number(request,"maxDetections",300,1,10000,true));
            if(textClasses!=null)payload.add("textClasses",textClasses);
            JsonArray pointNames=Json.array(Json.object(frozenProject,"settings"),"keypointNames");
            if(task.equals("pose")){
                Set<String> names=new HashSet<>();for(JsonElement name:pointNames)if(!name.isJsonPrimitive()||!name.getAsJsonPrimitive().isString()||name.getAsString().isBlank()||!names.add(name.getAsString()))throw error(400,"keypoints_required","关键点名称必须非空且不重复。");
                if(pointNames.isEmpty()||request.has("keypointNames")&&!request.get("keypointNames").equals(pointNames))throw error(409,"keypoint_template_mismatch","本地点序必须与冻结项目模板一致。");payload.add("keypointNames",pointNames.deepCopy());
            }
            long started=System.nanoTime();JsonObject result=call(operation,"predict",payload,events);
            verifyModel(modelPath,modelHash);verifyImage(imagePath,inputHash,frozenAsset);check(operation);
            if(!assetId.equals(Json.str(result,"assetId",""))||!task.equals(Json.str(result,"taskType",""))||!modelHash.equals(Json.str(result,"modelHash",""))||!inputHash.equals(Json.str(result,"inputHash",""))||!Json.required(model,"requestedDevice").equals(requestedDevice(result))||integer(result,"width")!=Json.integer(frozenAsset,"width",0)||integer(result,"height")!=Json.integer(frozenAsset,"height",0))throw error(502,"local_result_invalid","本地推理结果与请求标识、文件、尺寸或模型不一致。");
            if(!result.has("annotations")||!result.get("annotations").isJsonArray()||Json.array(result,"annotations").size()>10000)throw error(502,"local_result_invalid","本地推理未返回合法标注数组。");
            JsonArray annotations=Json.array(result,"annotations"),issues=new JsonArray();
            if(result.has("geometryIssues")){if(!result.get("geometryIssues").isJsonArray())throw error(502,"local_result_invalid","几何问题清单格式无效。");issues=result.getAsJsonArray("geometryIssues").deepCopy();}
            boolean review=result.has("requiresGeometryReview")&&strictBoolean(result,"requiresGeometryReview");JsonArray validated=null;
            int excluded=integer(result,"excludedByClassMap");if(excluded<0||excluded>10000||task.equals("classify")&&annotations.size()!=1)throw error(502,"local_result_invalid","分类结果或类别排除数量无效。");
            double elapsed=number(result,"elapsedMs",-1,0,Double.MAX_VALUE,false);
            try{validated=Annotations.validate(annotations,frozenAsset,frozenProject);}
            catch(Exception geometry){review=true;issues.add(Json.obj("code",geometry instanceof ApiError a?a.code:"annotation_invalid","severity","error","message","本地候选未通过当前结构与几何校验，原始对象已保留。"));}
            boolean adoptable=!review&&issues.isEmpty();if(!adoptable)validated=null;
            JsonObject provenance=Json.obj("requestId",operation.id,"source","local_yolo","modelHash",modelHash,"modelPath",modelPath.toString(),"inputHash",inputHash,"requestedDevice",model.get("requestedDevice"),"observedBackend",observed(result),
                "taskType",task,"parameters",payload,"workerHash",model.get("workerHash"),"protocolVersion",PROTOCOL,"elapsedMs",elapsed,"wallElapsedMs",TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-started),"excludedByClassMap",excluded,"adoptable",adoptable);
            synchronized(gate){provenance.add("environment",runtime==null?JsonNull.INSTANCE:runtime.deepCopy());}
            if(annotations.isEmpty()&&adoptable)provenance.addProperty("emptyReason",excluded>0?"all_classes_excluded":"model_no_targets");
            synchronized(gate){check(operation);return new Prediction(result.deepCopy(),validated,issues,adoptable,provenance);}
        }catch(ApiError e){throw e;}
        catch(Exception e){throw error(500,"local_inference_failed","本地推理未完成，请核对输入和运行环境。");}
        finally{finish(operation);}
    }

    /** 调用 worker 的严格 track_sequence 协议；仅接受 Detect 模型和带完整指纹的真实帧序列。 */
    JsonObject trackSequence(JsonObject request,long timeoutMs,Consumer<JsonObject> events){
        request=request.deepCopy();Operation operation=begin(Json.required(request,"requestId"),timeoutMs);
        try{
            JsonObject model;synchronized(gate){if(loaded==null)throw error(409,"model_required","请先成功载入本地模型。" );model=loaded.deepCopy();}
            if(!"detect".equals(Json.str(model,"taskType","")))throw error(422,"tracking_task_unsupported","自动跟踪首版仅支持 Detect 模型。" );
            String modelHash=hashField(model,"modelHash");if(!modelHash.equals(hashField(request,"expectedModelHash")))throw error(409,"local_model_changed","已载入模型与本次跟踪快照不一致。" );
            Path modelPath=Path.of(Json.required(model,"modelPath"));verifyModel(modelPath,modelHash);if(!request.has("frames")||!request.get("frames").isJsonArray()||Json.array(request,"frames").size()<2)throw error(400,"tracking_input_invalid","跟踪至少需要两帧固定输入。" );
            JsonObject result=call(operation,"track_sequence",request,events);verifyModel(modelPath,modelHash);check(operation);
            if(!Json.required(result,"sequenceId").equals(Json.required(request,"sequenceId"))||!Json.required(result,"sourceVideoId").equals(Json.required(request,"sourceVideoId"))||!modelHash.equals(Json.str(result,"modelHash",""))||!"detect".equals(Json.str(result,"taskType","")))throw error(502,"local_tracking_result_invalid","跟踪结果与固定模型或视频身份不一致。" );
            JsonObject provenance=Json.object(result,"provenance");if(!Json.required(provenance,"workerHash").equals(session.workerHash)||!"local_tracking".equals(Json.str(result,"source","")))throw error(409,"local_worker_changed","跟踪结果未绑定当前已加载的推理组件。" );
            result.addProperty("trackingPerformed",true);result.addProperty("candidateOnly",true);return result;
        }catch(ApiError e){throw e;}catch(Exception e){throw error(500,"local_tracking_failed","本地自动跟踪未完成，请检查推理环境和固定帧。" );}finally{finish(operation);}
    }

    boolean cancel(String requestId){
        Operation operation;Session current;synchronized(gate){if(active==null||!active.id.equals(requestId))return false;operation=active;current=session;operation.aborted.completeExceptionally(error(499,"local_cancelled","本地推理已取消，未采用未完成结果。"));loaded=null;}
        if(current!=null)stop(current,error(499,"local_cancelled","本地推理已取消，未采用未完成结果。"));return true;
    }
    JsonObject status(){synchronized(gate){byte[] bytes=new byte[logSize];for(int i=0;i<logSize;i++)bytes[i]=logs[(logStart+i)%LOG_LIMIT];return Json.obj("running",session!=null&&!session.stopped&&session.process.isAlive(),"busy",active!=null,"requestId",active==null?null:active.id,"pid",session==null?null:session.process.pid(),"generation",generation,"loaded",loaded!=null,"stderr",new String(bytes,StandardCharsets.UTF_8));}}

    private Operation begin(String id,long timeout){
        if(id==null||id.isBlank()||id.length()>160||timeout<1||timeout>600000)throw error(400,"local_request_invalid","请求标识或超时时间无效。");
        synchronized(gate){if(closed)throw error(503,"local_closed","本地推理桥接已关闭。");if(cancelledByOwner.getAsBoolean())throw error(499,"local_cancelled","所属运行已经取消，未启动下一项本地操作。");if(active!=null)throw error(409,"local_device_busy","该推理设备正在处理上一项工作，请保留排队状态。");return active=new Operation(id,timeout);}
    }
    private void finish(Operation operation){synchronized(gate){if(active==operation)active=null;}}
    private void check(Operation operation){
        if(operation.aborted.isCompletedExceptionally())await(operation.aborted,operation);
        synchronized(gate){if(operation.generation!=0&&(session==null||session.stopped||session.generation!=operation.generation))throw error(503,"local_worker_exited","本次推理进程已失效，未采用结果。");}
        if(System.nanoTime()>=operation.deadline){Session current;synchronized(gate){current=session;}ApiError timeout=error(504,"local_timeout","本地推理超时，工作进程已停止；不会自动换设备或重新计算。");operation.aborted.completeExceptionally(timeout);if(current!=null)stop(current,timeout);throw timeout;}
    }
    private Session ensureProcess(Operation operation){
        Session current;
        synchronized(gate){
            check(operation);current=session;if(current!=null&&!current.stopped&&current.process.isAlive()){operation.generation=current.generation;return current;}
            if(!Files.isRegularFile(python)||!Files.isRegularFile(script))throw error(404,"inference_environment_missing","未找到已配置的 Python 或本地推理脚本。");
            try{
                ProcessBuilder builder=new ProcessBuilder(python.toString(),"-u",script.toString());builder.directory(script.getParent().toFile());
                // 推理进程不需要接口密钥；保留系统与设备运行变量，固定父进程和离线依赖策略。
                Set<String> allowed=Set.of("SYSTEMROOT","WINDIR","PATH","PATHEXT","TEMP","TMP","USERPROFILE","USERNAME","USER","LOGNAME","LOCALAPPDATA","APPDATA","PROGRAMDATA","PROGRAMFILES","PROGRAMFILES(X86)","COMMONPROGRAMFILES","COMSPEC","NUMBER_OF_PROCESSORS","PROCESSOR_ARCHITECTURE","CUDA_PATH","CUDA_VISIBLE_DEVICES");
                builder.environment().keySet().removeIf(key->!allowed.contains(key.toUpperCase(Locale.ROOT))&&!key.toUpperCase(Locale.ROOT).startsWith("CUDA_PATH_V"));
                builder.environment().put("AUTOLABEL_PARENT_PID",Long.toString(ProcessHandle.current().pid()));builder.environment().put("YOLO_AUTOINSTALL","false");builder.environment().put("YOLO_VERBOSE","false");builder.environment().put("PYTHONUTF8","1");
                // 开放词汇只读这两个目录：缓存命中就零下载，编码器不在就直接报错，绝不让 worker 自己找地方下。
                if(vocabularyCache!=null)builder.environment().put("AUTOLABEL_VOCAB_CACHE",vocabularyCache);
                if(textEncoder!=null)builder.environment().put("AUTOLABEL_TEXT_ENCODER",textEncoder);
                String workerHash=Media.hash(script);current=new Session(builder.start(),++generation,workerHash);session=current;operation.generation=current.generation;loaded=null;runtime=null;
            }catch(Exception failure){throw error(503,"inference_environment_missing","Python 无法启动，请检查所选解释器与可选依赖环境。");}
        }
        Session started=current;started.observer=Thread.ofVirtual().name("local-events-"+started.generation).start(()->observe(started));Thread.ofVirtual().name("local-stdout-"+started.generation).start(()->readStdout(started));Thread.ofVirtual().name("local-stderr-"+started.generation).start(()->readStderr(started));return started;
    }

    private JsonObject call(Operation operation,String command,JsonObject payload,Consumer<JsonObject> events){
        Session current=ensureProcess(operation);await(current.ready,operation);
        try{if(!Media.hash(script).equals(current.workerHash))throw new IOException("worker changed");}catch(Exception changed){ApiError failure=error(409,"local_worker_changed","推理脚本已变更，请重新载入模型以固定执行版本。");stop(current,failure);throw failure;}
        Pending pending=new Pending(operation.id,command,Json.str(payload,"assetId",null),events);
        byte[] bytes=(Json.obj("id",operation.id,"command",command,"payload",payload).toString()+"\n").getBytes(StandardCharsets.UTF_8);
        if(bytes.length>REQUEST_LIMIT)throw error(413,"local_request_too_large","本地推理请求超过 1 MiB 限制。");
        synchronized(gate){check(operation);if(session!=current||current.stopped)throw error(503,"local_worker_exited","本地推理进程已经退出。");
            // 同一代进程不复用请求编号，迟到响应不能被下一次同名请求接收；集合有固定上限。
            if(current.requestIds.contains(operation.id))throw error(409,"local_request_reused","本代推理进程已经使用过该请求标识。");
            if(current.requestIds.size()>=100000){stop(current,error(409,"local_worker_refresh_required","推理进程已达到请求上限，请重新载入模型。"));throw error(409,"model_required","请重新载入本地模型。");}
            current.requestIds.add(operation.id);current.pending=pending;}
        CompletableFuture<Void> written=new CompletableFuture<>();Thread.ofVirtual().name("local-stdin-"+current.generation).start(()->{
            try{current.process.getOutputStream().write(bytes);current.process.getOutputStream().flush();written.complete(null);}
            catch(IOException e){ApiError failure=error(503,"local_worker_exited","本地推理输入通道已关闭。");written.completeExceptionally(failure);stop(current,failure);}
        });
        await(written,operation);JsonObject envelope=await(pending.response,operation);check(operation);
        if(!strictBoolean(envelope,"ok")){JsonObject error=Json.object(envelope,"error");String code=Json.str(error,"code","local_worker_error"),message=Json.str(error,"message","本地推理失败。");if(!code.matches("[a-z][a-z0-9_]{0,99}"))code="local_worker_error";if(message.length()>2000)message=message.substring(0,2000);throw error(422,code,message);}
        return Json.object(envelope,"data").deepCopy();
    }
    private <T>T await(CompletableFuture<T> future,Operation operation){
        try{long remaining=operation.deadline-System.nanoTime();if(remaining<=0)throw new TimeoutException();CompletableFuture.anyOf(future,operation.aborted).get(remaining,TimeUnit.NANOSECONDS);return future.join();}
        catch(TimeoutException timeout){ApiError failure=error(504,"local_timeout","本地推理超时，工作进程已停止；不会自动换设备或重新计算。");operation.aborted.completeExceptionally(failure);Session current;synchronized(gate){current=session;}if(current!=null)stop(current,failure);throw failure;}
        catch(InterruptedException interrupted){Thread.currentThread().interrupt();cancel(operation.id);throw error(499,"local_cancelled","本地推理已中断，未采用未完成结果。");}
        catch(ExecutionException|CompletionException failed){Throwable cause=failed.getCause();if(cause instanceof ApiError error)throw error;throw error(503,"local_worker_exited","本地推理进程未能完成请求。");}
    }

    private void readStdout(Session current){
        try(InputStream input=current.process.getInputStream();ByteArrayOutputStream line=new ByteArrayOutputStream()){
            byte[] block=new byte[8192];int count;while((count=input.read(block))!=-1){for(int i=0;i<count;i++){
                if(block[i]=='\n'){if(line.size()==0)throw error(502,"local_protocol_invalid","推理标准输出包含空协议行。");byte[] bytes=line.toByteArray();line.reset();String text=StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
                    try(JsonReader reader=new JsonReader(new StringReader(text))){reader.setStrictness(Strictness.STRICT);JsonElement value=JsonParser.parseReader(reader);if(!value.isJsonObject()||reader.peek()!=JsonToken.END_DOCUMENT)throw error(502,"local_protocol_invalid","推理协议每行必须且只能有一个 JSON 对象。");message(current,value.getAsJsonObject());}}
                else{if(line.size()>=RESPONSE_LIMIT)throw error(413,"local_response_too_large","本地推理结果超过大小限制，请降低目标数量或输入规模。");line.write(block[i]);}
            }}
            if(!current.stopped)stop(current,error(503,"local_worker_exited",line.size()>0?"本地推理进程退出且协议行不完整。":"本地推理进程已经退出。"));
        }catch(Exception failure){if(!current.stopped)stop(current,failure instanceof ApiError api?api:error(502,"local_protocol_invalid","推理标准输出不是有效的 UTF-8 JSON 协议。"));}
    }
    private void message(Session current,JsonObject message){
        Pending pending;JsonObject event=null;
        synchronized(gate){
            if(session!=current||current.stopped)return;String type=Json.str(message,"type","");
            if(type.equals("ready")){if(current.ready.isDone()||integer(message,"protocolVersion")!=PROTOCOL)throw error(502,"local_protocol_invalid","本地推理协议版本不匹配或重复就绪。");current.ready.complete(null);return;}
            if(!current.ready.isDone()||(pending=current.pending)==null||!pending.id.equals(Json.str(message,"id",""))||pending.response.isDone())throw error(502,"local_protocol_invalid","推理响应标识错配、重复或已经过期。");
            if(type.equals("event")){
                boolean tracking=pending.command.equals("track_sequence");if((!tracking&&!pending.command.equals("predict"))||(!tracking&&!Objects.equals(pending.assetId,Json.str(message,"assetId",null))||!Json.str(message,"stage","").equals(tracking?"local_tracking":"local_inference"))||++pending.eventCount>256)throw error(502,"local_protocol_invalid","推理事件与当前请求不一致。");event=message.deepCopy();
            }else if(type.equals("response")){
                boolean ok=strictBoolean(message,"ok");if(ok&&(!message.has("data")||!message.get("data").isJsonObject())||!ok&&(!message.has("error")||!message.get("error").isJsonObject()))throw error(502,"local_protocol_invalid","推理响应缺少结果或错误对象。");pending.response.complete(message.deepCopy());return;
            }else throw error(502,"local_protocol_invalid","本地推理返回了未知协议消息。");
        }
        if(event!=null&&pending.events!=null)current.observations.offer(new Observation(pending.events,event));
    }
    private void observe(Session current){
        // 进度观察者不参与协议和结果提交；慢观察者只能丢失进度，不能堵住标准输出。
        try{while(!current.stopped){Observation observation=current.observations.take();if(!current.stopped)try{observation.callback.accept(observation.event);}catch(RuntimeException ignored){}}}
        catch(InterruptedException interrupted){Thread.currentThread().interrupt();}
    }
    private void readStderr(Session current){
        try(InputStream input=current.process.getErrorStream()){byte[] block=new byte[4096];int count;while((count=input.read(block))!=-1)synchronized(gate){if(session!=current||current.stopped)return;for(int i=0;i<count;i++){if(logSize<LOG_LIMIT){logs[(logStart+logSize)%LOG_LIMIT]=block[i];logSize++;}else{logs[logStart]=block[i];logStart=(logStart+1)%LOG_LIMIT;}}}}
        catch(IOException ignored){/* 进程退出后关闭日志管道，不把它当作第二个推理结果。 */}
    }
    private void stop(Session current,ApiError reason){
        synchronized(gate){if(current.stopped)return;current.stopped=true;current.ready.completeExceptionally(reason);if(current.pending!=null)current.pending.response.completeExceptionally(reason);if(active!=null&&active.generation==current.generation)active.aborted.completeExceptionally(reason);if(session==current){session=null;loaded=null;generation++;}}
        current.observations.clear();if(current.observer!=null)current.observer.interrupt();
        // 只终止该 Process 及捕获到的后代，不按进程名称扫描或结束用户的其他 Python。
        List<ProcessHandle> children=current.process.descendants().toList();for(ProcessHandle child:children)child.destroyForcibly();current.process.destroyForcibly();
        try{current.process.waitFor(2000,TimeUnit.MILLISECONDS);}catch(InterruptedException interrupted){Thread.currentThread().interrupt();}
        try{current.process.getOutputStream().close();current.process.getInputStream().close();current.process.getErrorStream().close();}catch(IOException ignored){}
    }
    @Override public void close(){
        Session current;Operation graceful=null;synchronized(gate){if(closed)return;closed=true;current=session;loaded=null;if(active!=null)active.aborted.completeExceptionally(error(499,"local_cancelled","本地推理桥接正在退出。"));else if(current!=null){graceful=new Operation(Json.id(),1000);active=graceful;}}
        if(graceful!=null)try{call(graceful,"shutdown",new JsonObject(),null);}catch(ApiError ignored){}finally{finish(graceful);}
        if(current!=null)stop(current,error(503,"local_closed","本地推理桥接已经关闭。"));
    }

    private static Path file(JsonObject value,String key,Set<String> suffixes)throws IOException{
        Path path=Path.of(Json.required(value,key));String name=path.getFileName()==null?"":path.getFileName().toString(),extension=name.contains(".")?name.substring(name.lastIndexOf('.')+1).toLowerCase(Locale.ROOT):"";
        if(!path.isAbsolute()||!Files.isRegularFile(path)||!suffixes.contains(extension))throw error(404,"local_file_invalid","所选文件不存在、不是绝对路径或格式不支持。");return path.toRealPath();
    }
    private static void verifyModel(Path path,String expected)throws Exception{if(!Files.isRegularFile(path)||!Media.hash(path).equals(expected))throw error(409,"local_model_changed","模型文件在执行期间发生变化，未采用结果。");}
    private static void verifyImage(Path path,String expected,JsonObject asset)throws Exception{
        if(!Files.isRegularFile(path)||Files.size(path)>Media.MAX_FILE||!Media.hash(path).equals(expected))throw error(409,"local_input_changed","输入图片缺失或在执行期间发生变化，未采用结果。");
        try(ImageInputStream input=ImageIO.createImageInputStream(path.toFile())){Iterator<ImageReader> readers=ImageIO.getImageReaders(input);if(!readers.hasNext())throw error(409,"local_input_changed","输入图片无法解码。");ImageReader reader=readers.next();try{reader.setInput(input);if(!Set.of("png","jpeg").contains(reader.getFormatName().toLowerCase(Locale.ROOT))||reader.getWidth(0)!=Json.integer(asset,"width",0)||reader.getHeight(0)!=Json.integer(asset,"height",0))throw error(409,"local_input_mismatch","输入图片尺寸与冻结基准图不一致。");}finally{reader.dispose();}}
    }
    private static Set<String> classes(JsonObject model){
        if(!model.has("classes")||!model.get("classes").isJsonArray())throw error(502,"local_result_invalid","模型未返回类别表。");Set<String> ids=new HashSet<>();for(JsonElement element:Json.array(model,"classes")){JsonObject item=element.getAsJsonObject();String id=Json.required(item,"id");if(!id.matches("[0-9]{1,9}")||!ids.add(id))throw error(502,"local_result_invalid","模型类别编号无效或重复。");Json.required(item,"name");}if(ids.isEmpty())throw error(502,"local_result_invalid","模型类别表为空。");return ids;
    }
    private static JsonObject mapping(JsonObject request,JsonObject model,JsonObject project,JsonArray textClasses){
        if(!request.has("classMap")||!request.get("classMap").isJsonObject())throw error(400,"class_map_required","请明确配置模型类别到项目类别的完整映射。");JsonObject mapping=request.getAsJsonObject("classMap");Set<String> modelClasses,targets=new HashSet<>();
        if(Json.bool(model,"openVocabulary",false)){
            // 开放词汇：类别就是本次请求的 textClasses，下标即类别号，不依赖载入时的自带类别表。
            if(textClasses==null||textClasses.isEmpty())throw error(400,"vocabulary_required","开放词汇模型必须在本次请求中给出类别名。");
            modelClasses=new HashSet<>();for(int index=0;index<textClasses.size();index++)modelClasses.add(Integer.toString(index));
        }else{
            if(textClasses!=null)throw error(400,"vocabulary_unsupported","该模型自带固定类别表，不能临时改类别名。");
            modelClasses=classes(model);
        }
        for(JsonElement element:Json.array(project,"classes"))targets.add(Json.required(element.getAsJsonObject(),"id"));
        if(!mapping.keySet().equals(modelClasses))throw error(400,"class_map_incomplete","模型每个类别都必须映射，忽略类别请明确设为 null。");
        for(JsonElement target:mapping.asMap().values())if(!target.isJsonNull()&&(!target.isJsonPrimitive()||!target.getAsJsonPrimitive().isString()||!targets.contains(target.getAsString())))throw error(400,"class_map_invalid","类别映射引用了不存在的项目类别。");return mapping.deepCopy();
    }
    private static String requestedDevice(JsonObject value){return Json.str(value,"requestedDevice",Json.str(value,"device",""));}
    private static JsonElement observed(JsonObject value){JsonElement backend=value.get("observedBackend");if(backend==null||backend.isJsonNull())return JsonNull.INSTANCE;if(!backend.isJsonObject())throw error(502,"local_result_invalid","实际推理后端信息格式无效。");return backend.deepCopy();}
    private static String hashField(JsonObject value,String field){String hash=Json.required(value,field);if(!hash.matches("[a-f0-9]{64}"))throw error(400,"local_hash_invalid","文件内容摘要无效。");return hash;}
    private static int integer(JsonObject value,String field){try{JsonElement v=value.get(field);if(v==null||!v.isJsonPrimitive()||!v.getAsJsonPrimitive().isNumber())throw new ArithmeticException();return v.getAsBigDecimal().intValueExact();}catch(Exception invalid){throw error(502,"local_result_invalid","推理响应整数字段无效。");}}
    private static boolean strictBoolean(JsonObject value,String field){JsonElement v=value.get(field);if(v==null||!v.isJsonPrimitive()||!v.getAsJsonPrimitive().isBoolean())throw error(502,"local_protocol_invalid","推理协议布尔字段无效。");return v.getAsBoolean();}
    private static double number(JsonObject value,String field,double fallback,double low,double high,boolean integral){try{JsonElement raw=value.get(field);if(raw!=null&&(!raw.isJsonPrimitive()||!raw.getAsJsonPrimitive().isNumber()))throw new ArithmeticException();double n=raw==null?fallback:raw.getAsDouble();if(!Double.isFinite(n)||n<low||n>high||integral&&n!=Math.rint(n))throw new ArithmeticException();return n;}catch(RuntimeException invalid){throw error(400,"parameter_invalid","推理参数或结果数值无效："+field);}}
    private static ApiError error(int status,String code,String message){return new ApiError(status,code,message);}
}
