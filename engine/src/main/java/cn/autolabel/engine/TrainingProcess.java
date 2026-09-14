package cn.autolabel.engine;

import com.google.gson.*;
import com.google.gson.stream.JsonReader;
import com.google.gson.stream.JsonToken;
import java.io.*;
import java.nio.ByteBuffer;
import java.nio.charset.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;

/**
 * 训练进程桥接：一个实例对应一个 train_worker.py 进程与一个训练任务。
 *
 * 与 LocalInference 的协议族相同，但不复用该类：训练耗时以小时计，而 LocalInference 的单请求超时上限为
 * 600 秒且同一进程只允许一个活动请求。这里没有固定总超时，进度由 worker 的 epoch 事件驱动，
 * 存活判定交给 TrainingJobs 的停滞检测，取消则通过独立请求即时送达。
 * 同时训练天然独占设备，因此不做请求排队与多路复用。
 */
final class TrainingProcess implements AutoCloseable {
    private static final int PROTOCOL=1,REQUEST_LIMIT=8*1024*1024,LINE_LIMIT=16*1024*1024,LOG_LIMIT=256*1024;
    private static final Set<String> TERMINAL=Set.of("finished","failed","cancelled");

    interface Listener {
        void event(JsonObject event);
        void exited(String code,String message);
    }

    private static final class Pending {
        final String id,command;final CompletableFuture<JsonObject> response=new CompletableFuture<>();
        Pending(String id,String command){this.id=id;this.command=command;}
    }

    private final Path python,script;
    private final String workerHash;
    private final Object gate=new Object();
    private final byte[] logs=new byte[LOG_LIMIT];
    private int logStart,logSize;
    private CompletableFuture<Void> ready=new CompletableFuture<>();
    private Process process;
    private Pending pending;
    private Listener listener=null;
    private String jobId,stage;
    private long lastEventAt=System.nanoTime();
    private boolean terminalSeen,closed,stopped;

    TrainingProcess(Path python,Path script)throws Exception{
        this.python=LocalRuntime.python(python.toString());
        if(!Files.isRegularFile(script))throw error(404,"training_worker_missing","训练组件 train_worker.py 缺失，请检查安装文件。");
        this.script=script.toAbsolutePath().normalize();
        this.workerHash=Media.hash(this.script);
    }

    String workerHash(){return workerHash;}
    String stderrTail(int maxBytes){
        synchronized(gate){
            int size=Math.min(logSize,maxBytes),offset=(logStart+logSize-size)%LOG_LIMIT;byte[] bytes=new byte[size];
            for(int index=0;index<size;index++)bytes[index]=logs[(offset+index)%LOG_LIMIT];
            return new String(bytes,StandardCharsets.UTF_8);
        }
    }
    long sinceLastEventMs(){return TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-lastEventAt);}
    String currentStage(){synchronized(gate){return stage;}}
    boolean running(){synchronized(gate){return !stopped&&process!=null&&process.isAlive();}}

    /** 启动进程并等待 ready 握手；训练进程启动失败必须在这里明确失败，而不是留一个半启动任务。 */
    void open()throws Exception{
        synchronized(gate){
            if(closed)throw error(503,"training_closed","训练桥接已关闭。");
            if(process!=null)throw error(500,"training_process_exists","训练进程已存在。");
            try{
                ProcessBuilder builder=new ProcessBuilder(python.toString(),"-u",script.toString());
                builder.directory(script.getParent().toFile());
                // 训练进程不需要接口密钥；保留系统与设备运行变量，固定父进程与离线依赖策略。
                Set<String> allowed=Set.of("SYSTEMROOT","WINDIR","PATH","PATHEXT","TEMP","TMP","USERPROFILE","USERNAME","USER","LOGNAME","LOCALAPPDATA","APPDATA","PROGRAMDATA","PROGRAMFILES","PROGRAMFILES(X86)","COMMONPROGRAMFILES","COMSPEC","NUMBER_OF_PROCESSORS","PROCESSOR_ARCHITECTURE","CUDA_PATH","CUDA_VISIBLE_DEVICES");
                builder.environment().keySet().removeIf(key->!allowed.contains(key.toUpperCase(Locale.ROOT))&&!key.toUpperCase(Locale.ROOT).startsWith("CUDA_PATH_V"));
                builder.environment().put("AUTOLABEL_PARENT_PID",Long.toString(ProcessHandle.current().pid()));
                builder.environment().put("YOLO_AUTOINSTALL","false");
                builder.environment().put("YOLO_VERBOSE","false");
                builder.environment().put("PYTHONUTF8","1");
                process=builder.start();
            }catch(Exception failure){throw error(503,"training_environment_missing","Python 无法启动，请检查所选解释器与可选依赖环境。");}
        }
        Thread.ofVirtual().name("training-stdout").start(this::readStdout);
        Thread.ofVirtual().name("training-stderr").start(this::readStderr);
        try{ready.get(60,TimeUnit.SECONDS);}
        catch(TimeoutException timeout){stop(error(504,"training_timeout","训练进程未在限定时间内就绪，已停止。"));throw error(504,"training_timeout","训练进程未在限定时间内就绪，已停止。");}
        catch(InterruptedException interrupted){Thread.currentThread().interrupt();stop(error(499,"training_cancelled","训练进程启动被中断。"));throw error(499,"training_cancelled","训练进程启动被中断。");}
        catch(ExecutionException failure){
            Throwable cause=failure.getCause();ApiError reason=cause instanceof ApiError api?api:error(502,"training_protocol_invalid","训练进程握手失败。");
            stop(reason);throw reason;
        }
    }

    /** probe / cancel / shutdown 这类短请求；训练本身不走这里，避免长任务占住调用线程。 */
    JsonObject request(String command,JsonObject payload,long timeoutMs)throws Exception{
        Pending current=send(command,payload);
        try{return await(current,timeoutMs);}
        catch(ApiError failure){stop(failure);throw failure;}
    }

    /** 提交训练：只等待启动回执，进度通过 listener 持续送达，不设总超时。 */
    void train(String jobId,JsonObject payload,Listener listener)throws Exception{
        synchronized(gate){
            if(this.jobId!=null)throw error(409,"training_busy","该训练进程已在执行任务。");
            this.jobId=jobId;this.listener=listener;stage="queued";
        }
        Pending current=send("train",payload);
        try{await(current,30000);}
        catch(ApiError failure){failListener(failure);stop(failure);throw failure;}
    }

    private Pending send(String command,JsonObject payload)throws Exception{
        Pending created;
        synchronized(gate){
            if(stopped)throw error(503,"training_worker_exited","训练进程已经退出。");
            if(pending!=null)throw error(409,"training_busy","训练进程正在处理上一项请求。");
            created=pending=new Pending(Json.id(),command);
        }
        byte[] bytes=(Json.obj("id",created.id,"command",command,"payload",payload).toString()+"\n").getBytes(StandardCharsets.UTF_8);
        if(bytes.length>REQUEST_LIMIT)throw error(413,"training_request_too_large","训练请求超过 8 MiB 限制。");
        try{
            synchronized(gate){if(stopped||process==null||!process.isAlive())throw error(503,"training_worker_exited","训练进程已经退出。");}
            process.getOutputStream().write(bytes);process.getOutputStream().flush();
        }catch(ApiError failure){throw failure;}
        catch(IOException failure){ApiError reason=error(503,"training_worker_exited","训练进程输入通道已关闭。");stop(reason);throw reason;}
        return created;
    }

    private JsonObject await(Pending current,long timeoutMs)throws Exception{
        JsonObject envelope;
        try{envelope=current.response.get(timeoutMs,TimeUnit.MILLISECONDS);}
        catch(TimeoutException timeout){throw error(504,"training_timeout","训练进程未在限定时间内响应。");}
        catch(InterruptedException interrupted){Thread.currentThread().interrupt();throw error(499,"training_cancelled","训练请求已中断。");}
        catch(ExecutionException failure){Throwable cause=failure.getCause();throw cause instanceof ApiError api?api:error(503,"training_worker_exited","训练进程未能完成请求。");}
        finally{synchronized(gate){if(pending==current)pending=null;}}
        if(!strictBoolean(envelope,"ok")){
            JsonObject error=Json.object(envelope,"error");
            String code=Json.str(error,"code","training_failed"),message=Json.str(error,"message","训练进程执行失败。");
            if(!code.matches("[a-z][a-z0-9_]{0,99}"))code="training_failed";
            if(message.length()>2000)message=message.substring(0,2000);
            throw error(422,code,message);
        }
        return Json.object(envelope,"data").deepCopy();
    }

    private void readStdout(){
        try(InputStream input=process.getInputStream();ByteArrayOutputStream line=new ByteArrayOutputStream()){
            byte[] block=new byte[8192];int count;
            while((count=input.read(block))!=-1){
                for(int index=0;index<count;index++){
                    if(block[index]=='\n'){
                        if(line.size()==0)throw error(502,"training_protocol_invalid","训练进程标准输出包含空协议行。");
                        byte[] bytes=line.toByteArray();line.reset();
                        String text=StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
                        try(JsonReader reader=new JsonReader(new StringReader(text))){
                            reader.setStrictness(Strictness.STRICT);
                            JsonElement value=JsonParser.parseReader(reader);
                            if(!value.isJsonObject()||reader.peek()!=JsonToken.END_DOCUMENT)throw error(502,"training_protocol_invalid","训练协议每行必须且只能有一个 JSON 对象。");
                            message(value.getAsJsonObject());
                        }
                    }else{
                        if(line.size()>=LINE_LIMIT)throw error(413,"training_response_too_large","训练进程输出超过大小限制。");
                        line.write(block[index]);
                    }
                }
            }
            if(line.size()>0)throw error(502,"training_protocol_invalid","训练进程退出且协议行不完整。");
            exit("training_worker_exited","训练进程已经退出。");
        }catch(ApiError failure){stop(failure);}
        catch(Exception failure){stop(error(502,"training_protocol_invalid","训练标准输出不是有效的 UTF-8 JSON 协议。"));}
    }

    private void message(JsonObject value){
        Pending current=null;JsonObject event=null;Listener target=null;
        synchronized(gate){
            if(stopped)return;
            String type=Json.str(value,"type","");
            switch(type){
                case "ready"->{
                    if(ready.isDone()||Json.integer(value,"protocolVersion",0)!=PROTOCOL)throw error(502,"training_protocol_invalid","训练协议版本不匹配或重复就绪。");
                    ready.complete(null);return;
                }
                case "response"->{
                    current=pending;
                    if(current==null||!current.id.equals(Json.str(value,"id",""))||current.response.isDone())
                        throw error(502,"training_protocol_invalid","训练响应标识错配、重复或已经过期。");
                    if(!strictBoolean(value,"ok")&&(!value.has("error")||!value.get("error").isJsonObject()))
                        throw error(502,"training_protocol_invalid","训练响应缺少错误对象。");
                    pending=null;current.response.complete(value.deepCopy());return;
                }
                case "event"->{
                    String mine=Json.str(value,"jobId","");
                    if(jobId==null||!jobId.equals(mine))throw error(502,"training_protocol_invalid","训练事件不属于当前任务。");
                    if(stage!=null&&TERMINAL.contains(stage))throw error(502,"training_protocol_invalid","训练任务结束后仍收到进度事件。");
                    String next=Json.str(value,"stage","");
                    if(next.isBlank()||next.length()>40)throw error(502,"training_protocol_invalid","训练事件的阶段标识无效。");
                    stage=next;lastEventAt=System.nanoTime();terminalSeen=TERMINAL.contains(next);
                    target=listener;event=value.deepCopy();
                }
                default->throw error(502,"training_protocol_invalid","训练进程返回了未知协议消息。");
            }
        }
        if(event!=null&&target!=null){
            // 监听器只做落库与事件推送，任何异常都不能反向毁掉协议解析。
            try{target.event(event);}catch(RuntimeException ignored){}
        }
    }

    private void readStderr(){
        try(InputStream input=process.getErrorStream()){
            byte[] block=new byte[4096];int count;
            while((count=input.read(block))!=-1)synchronized(gate){
                if(stopped)return;
                for(int index=0;index<count;index++){
                    if(logSize<LOG_LIMIT){logs[(logStart+logSize)%LOG_LIMIT]=block[index];logSize++;}
                    else{logs[logStart]=block[index];logStart=(logStart+1)%LOG_LIMIT;}
                }
            }
        }catch(IOException ignored){/* 进程退出后关闭日志管道，不作为第二个训练结果。 */}
    }

    /** 进程消失：已收到终止事件的算正常结束，否则如实上报为异常退出。 */
    private void exit(String code,String message){
        boolean notify;
        synchronized(gate){
            if(stopped)return;
            stopped=true;stage="exited";
            if(pending!=null){pending.response.completeExceptionally(error(503,code,message));pending=null;}
            notify=!terminalSeen&&listener!=null;
        }
        if(notify)failListener(error(503,code,message));
    }

    private void failListener(ApiError failure){
        Listener target;
        synchronized(gate){target=listener;}
        if(target!=null)try{target.exited(failure.code,failure.getMessage());}catch(RuntimeException ignored){}
    }

    private void stop(ApiError reason){
        Listener target;Process current;
        synchronized(gate){
            if(stopped)return;
            stopped=true;
            if(pending!=null){pending.response.completeExceptionally(reason);pending=null;}
            ready.completeExceptionally(reason);
            // 只有未收到终止事件的任务才需要由退出通知补一个结论，避免覆盖真实的完成状态。
            target=terminalSeen?null:listener;
            current=process;
        }
        if(target!=null)try{target.exited(reason.code,reason.getMessage());}catch(RuntimeException ignored){}
        if(current!=null){
            // 只终止该 Process 及捕获到的后代，不按进程名扫描用户的其他 Python。
            List<ProcessHandle> descendants=current.descendants().toList();
            for(ProcessHandle child:descendants)child.destroyForcibly();
            current.destroyForcibly();
            try{current.waitFor(5,TimeUnit.SECONDS);}catch(InterruptedException interrupted){Thread.currentThread().interrupt();}
            try{current.getOutputStream().close();current.getInputStream().close();current.getErrorStream().close();}catch(IOException ignored){}
        }
    }

    /** 关闭前先要求 worker 收尾；调用方负责在此之前完成取消或等待。 */
    @Override public void close(){
        synchronized(gate){if(closed)return;closed=true;}
        if(running())try{request("shutdown",new JsonObject(),5000);}catch(Exception ignored){}
        stop(error(503,"training_closed","训练桥接已经关闭。"));
    }

    private static boolean strictBoolean(JsonObject value,String field){
        JsonElement element=value.get(field);
        if(element==null||!element.isJsonPrimitive()||!element.getAsJsonPrimitive().isBoolean())throw error(502,"training_protocol_invalid","训练协议布尔字段无效。");
        return element.getAsBoolean();
    }
    private static ApiError error(int status,String code,String message){return new ApiError(status,code,message);}
}
