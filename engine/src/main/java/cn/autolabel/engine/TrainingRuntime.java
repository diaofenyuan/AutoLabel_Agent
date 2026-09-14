package cn.autolabel.engine;

import com.google.gson.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;

/**
 * 训练运行时：环境探测与设备选择。
 *
 * 训练复用与本地推理相同的 Python 解释器（ultralytics / torch 等可选依赖只装一份），
 * 但使用独立的 train_worker.py 进程：LocalInference 的单请求超时上限为 600 秒且一进程只允许一个活动请求，
 * 无法承载小时级训练，因此这里只沿用行级 JSON 协议而不复用该类。
 * 设备选择只在启动前进行，回退必须如实记录请求设备与实际设备，运行中不做自动降级。
 */
final class TrainingRuntime implements AutoCloseable {
    /** gpu-auto 回退到 cpu 的显存下限；未探测到显存的设备不触发回退。 */
    static final long MIN_GPU_MEMORY_MB=2048;

    private final LocalRuntime localRuntime;
    private final Path worker;private final Path python;private final LocalInference bridge;
    /** 设备占用表：训练独占设备，与推理槽互相排斥，不排队也不共享显存。 */
    private final Map<String,String> claims=new ConcurrentHashMap<>();
    private JsonObject environment=new JsonObject();
    private boolean closed;

    TrainingRuntime(LocalRuntime localRuntime,JsonObject startup)throws Exception{
        this.localRuntime=localRuntime;
        worker=optional(startup,"trainingWorkerPath");
        // 解释器沿用已配置的本地执行环境；未配置时保留空值，由状态与预检给出可操作提示。
        Path resolved=null;
        Path configured=optional(startup,"localPythonPath");
        if(configured!=null)try{resolved=LocalRuntime.python(configured.toString());}catch(Exception ignored){resolved=null;}
        python=resolved;
        bridge=new LocalInference(python==null?Path.of("python"):python,worker==null?Path.of("train_worker.py"):worker);
    }

    private static Path optional(JsonObject startup,String field)throws Exception{
        if(!startup.has(field)||startup.get(field).isJsonNull())return null;
        return Path.of(Json.required(startup,field)).toAbsolutePath().normalize();
    }

    /** 启动训练 worker 执行一次环境探测；环境不可用时返回状态并附带 issue，而不是让整个页面失败。 */
    JsonObject probe(JsonObject p){
        FlowPlans.keys(p);
        if(!configured()||!workerAvailable())return state();
        try{synchronized(this){environment=bridge.probe(60000);}}
        catch(ApiError failure){synchronized(this){environment=Json.obj("available",false,"code",failure.code,"message",failure.getMessage());}}
        return state();
    }

    /** 预检入口：必须拿到一次成功的探测结果，否则明确拒绝而不是猜测环境能力。 */
    JsonObject requireEnvironment()throws Exception{
        if(closed)throw error(503,"training_closed","训练运行时已停止。");
        if(!configured())throw error(409,"local_python_required","请先在设置中配置 Python 环境，训练与本地推理共用该解释器。");
        if(!workerAvailable())throw error(409,"training_worker_missing","训练组件 train_worker.py 缺失，请检查安装文件。");
        if(!Json.bool(environment,"available",false))probe(new JsonObject());
        if(!Json.bool(environment,"available",false))
            throw error(409,"training_environment_unavailable","当前 Python 环境缺少可用的 Ultralytics 或 PyTorch，无法训练。");
        return state();
    }

    /** 训练任务专用的进程桥接；一个任务一个进程，不复用推理桥接的长连接。 */
    TrainingProcess newProcess()throws Exception{
        requireEnvironment();
        return new TrainingProcess(python,worker);
    }

    /**
     * 训练占用设备：被其他训练任务占用时返回 false，由调用方保持排队而不是排队抢占。
     * 占用表不参与本类的监视器锁，避免与 LocalRuntime 形成交叉加锁。
     */
    boolean claim(String device,String jobId){
        if(closed)return false;
        String holder=claims.putIfAbsent(device,jobId);
        return holder==null||holder.equals(jobId);
    }
    void release(String device){claims.remove(device);}
    List<String> claimed(){return List.copyOf(claims.keySet());}

    synchronized JsonObject state(){
        JsonObject result=Json.obj("configured",configured(),"workerAvailable",workerAvailable(),"available",Json.bool(environment,"available",false),
            "cudaAvailable",Json.bool(environment,"cudaAvailable",false),"devices",Json.array(environment,"devices").deepCopy(),
            "defaultDevice","gpu-auto","minimumGpuMemoryMb",MIN_GPU_MEMORY_MB,"busyBy",busyBy(),"busyByTraining",Json.GSON.toJsonTree(claimed()),
            "capabilities",Json.object(environment,"capabilities").deepCopy());
        for(String field:List.of("pythonVersion","ultralyticsVersion","torchVersion","numpyVersion","opencvVersion")){
            if(environment.has(field))result.add(field,environment.get(field).deepCopy());
        }
        try{if(workerAvailable())result.addProperty("workerHash",Media.hash(worker));}catch(Exception ignored){}
        if(environment.has("code"))result.add("issue",Json.obj("code",environment.get("code"),"message",environment.get("message")));
        else if(!configured())result.add("issue",Json.obj("code","local_python_required","message","请先在设置中配置 Python 环境。"));
        else if(!workerAvailable())result.add("issue",Json.obj("code","training_worker_missing","message","训练组件 train_worker.py 缺失，请检查安装文件。"));
        return result;
    }

    /** 训练与推理共享设备：这里只报告被推理占用的设备，训练自身的占用在任务调度里登记。 */
    private JsonArray busyBy(){
        JsonArray result=new JsonArray();
        for(JsonElement element:Json.array(localRuntime.state(),"slots")){
            JsonObject slot=element.getAsJsonObject();
            if(Json.bool(slot,"busy",false))result.add(Json.str(slot,"device",""));
        }
        return result;
    }

    /** 启动前设备解析；用户显式指定 GPU 时拒绝而不是回退。 */
    static JsonObject resolveDevice(JsonObject state,String requested){
        List<JsonObject> gpus=new ArrayList<>();
        for(JsonElement element:Json.array(state,"devices")){
            JsonObject device=element.getAsJsonObject();
            if(!Json.str(device,"id","cpu").equals("cpu"))gpus.add(device);
        }
        if(requested.equals("cpu"))return Json.obj("device","cpu");
        if(requested.equals("gpu-auto")){
            if(gpus.isEmpty())return fallback(Json.bool(state,"cudaAvailable",false)?"没有可用的 CUDA 设备":"当前解释器未检测到 CUDA");
            JsonObject best=null;
            for(JsonObject gpu:gpus)if(best==null||Json.number(gpu,"freeMemoryMb",Long.MAX_VALUE)>Json.number(best,"freeMemoryMb",Long.MAX_VALUE))best=gpu;
            // 未报告显存时不据猜测回退，只按设备存在性选择。
            if(Json.number(best,"freeMemoryMb",Long.MAX_VALUE)<MIN_GPU_MEMORY_MB)
                return fallback("可用显存低于 "+MIN_GPU_MEMORY_MB+" MiB");
            return Json.obj("device",Json.required(best,"id"));
        }
        for(JsonObject gpu:gpus)if(Json.required(gpu,"id").equals(requested))return Json.obj("device",requested);
        throw error(409,"training_device_unavailable","所选 GPU 当前不可用，请改选其他设备或 cpu 后重试。");
    }

    private static JsonObject fallback(String reason){
        return Json.obj("device","cpu","fallback",Json.obj("requested","gpu-auto","actual","cpu","reason",reason));
    }

    @Override public void close(){
        synchronized(this){if(closed)return;closed=true;}
        bridge.close();
    }

    private boolean configured(){return python!=null&&Files.isRegularFile(python);}
    private boolean workerAvailable(){return worker!=null&&Files.isRegularFile(worker);}
    private static ApiError error(int status,String code,String message){return new ApiError(status,code,message);}
}
