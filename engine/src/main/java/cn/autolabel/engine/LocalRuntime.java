package cn.autolabel.engine;

import com.google.gson.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;

final class LocalRuntime implements AutoCloseable {
    final LocalModels models;private final Path worker;
    private final Map<String,Slot> slots=new LinkedHashMap<>();private final Map<String,String> authorizations=new HashMap<>();
    private Path python;private JsonObject environment=new JsonObject();private boolean closed;
    private volatile TrainingRuntime trainingOwner;
    final class Slot {
        final String device;final LocalInference bridge;final ThreadPoolExecutor executor;
        boolean busy;volatile boolean cancelRequested;String runId,inputId;JsonObject loaded;
        Slot(String device){this.device=device;bridge=new LocalInference(python,worker,()->cancelRequested);executor=new ThreadPoolExecutor(1,1,0,TimeUnit.MILLISECONDS,new ArrayBlockingQueue<>(1),Thread.ofPlatform().name("local-"+device+"-",0).factory(),new ThreadPoolExecutor.AbortPolicy());}
        void execute(Runnable action){try{executor.execute(()->{try{action.run();}finally{release(this);}});}catch(RejectedExecutionException error){release(this);throw new ApiError(503,"local_queue_busy","本地设备执行槽暂不可用。");}}
    }
    LocalRuntime(LocalModels models,JsonObject startup)throws Exception{
        this.models=models;worker=startup.has("localWorkerPath")&&!startup.get("localWorkerPath").isJsonNull()?Path.of(Json.required(startup,"localWorkerPath")).toAbsolutePath().normalize():null;
        if(startup.has("localPythonPath")&&!startup.get("localPythonPath").isJsonNull())try{python=python(Json.required(startup,"localPythonPath"));}catch(Exception ignored){environment=Json.obj("available",false,"code","local_python_invalid","message","已配置的 Python 不可用，请重新选择。");}
        for(JsonElement value:Json.array(startup,"localModelAuthorizations").size()<=500?Json.array(startup,"localModelAuthorizations"):new JsonArray()){JsonObject item=value.getAsJsonObject();String hash=Json.str(item,"modelHash","");if(hash.matches("[a-f0-9]{64}")){Path path=Path.of(Json.required(item,"path"));if(path.isAbsolute())authorizations.put(pathKey(path),hash);}}
    }
    static Path python(String value)throws Exception{Path path=Path.of(value);if(!path.isAbsolute()||!Files.isRegularFile(path)||!path.getFileName().toString().toLowerCase(Locale.ROOT).endsWith(".exe"))throw new ApiError(400,"local_python_invalid","请选择存在的 Python 可执行文件。");return path.toRealPath();}
    static String device(JsonObject p){String device=Json.str(p,"device","cpu");if(!device.matches("cpu|0|[1-9][0-9]{0,2}"))throw new ApiError(400,"device_invalid","设备须为 cpu 或 0 至 999 的规范编号。");return device;}
    static long timeout(JsonObject p,long fallback){return p.has("timeoutMs")?Costs.integer(p,"timeoutMs",1000,600000):fallback;}
    private static String pathKey(Path path){String value=path.toAbsolutePath().normalize().toString();return System.getProperty("os.name","").startsWith("Windows")?value.toLowerCase(Locale.ROOT):value;}
    JsonObject authorize(JsonObject p)throws Exception{FlowPlans.keys(p,"path","modelHash");Path path=LocalModels.file(FlowPlans.string(p,"path",32767));String hash=FlowPlans.string(p,"modelHash",64);if(!hash.matches("[a-f0-9]{64}")||!Media.hash(path).equals(hash))throw new ApiError(409,"local_model_changed","模型文件与本次授权指纹不一致。");synchronized(this){authorizations.put(pathKey(path),hash);}return Json.obj("authorized",true);}
    synchronized boolean authorizationMatches(JsonObject model){return Json.required(model,"modelHash").equals(authorizations.get(pathKey(Path.of(Json.required(model,"modelPath")))));}
    void requireAuthorized(JsonObject model)throws Exception{Path path=LocalModels.file(Json.required(model,"modelPath"));String hash=Json.required(model,"modelHash");synchronized(this){if(!hash.equals(authorizations.get(pathKey(path))))throw new ApiError(403,"local_model_authorization_required","此数据作用域尚未授权该模型，请通过桌面重新选择模型文件。");}if(!Media.hash(path).equals(hash))throw new ApiError(409,"local_model_changed","模型文件已变化，请登记并授权新版本。");}
    JsonObject configure(JsonObject p)throws Exception{
        FlowPlans.keys(p,"pythonPath");if(!p.has("pythonPath"))throw new ApiError(400,"local_python_invalid","请提供 pythonPath 或 null。");Path next=p.get("pythonPath").isJsonNull()?null:python(FlowPlans.string(p,"pythonPath",32767));List<Slot> previous;
        synchronized(this){if(slots.values().stream().anyMatch(slot->slot.busy))throw new ApiError(409,"local_runtime_busy","本地设备仍在执行，等待保存后再切换 Python。");previous=new ArrayList<>(slots.values());slots.clear();python=next;environment=new JsonObject();}
        for(Slot slot:previous){slot.bridge.close();slot.executor.shutdownNow();}return state();
    }
    private void requireConfigured(){if(closed)throw new ApiError(503,"local_closed","本地运行时已停止。");if(worker==null||!Files.isRegularFile(worker))throw new ApiError(409,"local_worker_missing","本地推理组件缺失，请检查安装文件。");if(python==null||!Files.isRegularFile(python))throw new ApiError(409,"local_python_required","请先通过桌面配置 Python 环境。");}
    /** 训练与推理共享设备：训练占用期间拒绝一切本设备上的推理，不排队、不共享显存。 */
    void shareTrainingRuntime(TrainingRuntime runtime){trainingOwner=runtime;}
    private boolean heldByTraining(String device){TrainingRuntime current=trainingOwner;return current!=null&&current.claimed().contains(device);}
    synchronized boolean deviceBusy(String device){Slot slot=slots.get(device);return slot!=null&&slot.busy;}
    synchronized Slot reserve(String device,String runId,String inputId){requireConfigured();
        if(heldByTraining(device))throw new ApiError(409,"device_busy_by_training","设备 "+device+" 正被训练任务占用，请等待训练结束或改用其他设备。");
        if(!slots.containsKey(device)&&slots.size()>=8)throw new ApiError(409,"local_slot_limit","本地运行时最多保留 8 个设备槽，请释放现有设备后再载入。");Slot slot=slots.computeIfAbsent(device,Slot::new);if(slot.busy)return null;slot.busy=true;slot.cancelRequested=false;slot.runId=runId;slot.inputId=inputId;return slot;}
    synchronized void release(Slot slot){slot.busy=false;slot.runId=null;slot.inputId=null;}
    JsonObject probe(JsonObject p){FlowPlans.keys(p);Slot slot=reserve("cpu",null,null);if(slot==null)throw new ApiError(409,"local_device_busy","CPU 设备正在执行，稍后再检查环境。");try{JsonObject result=slot.bridge.probe(60000);synchronized(this){environment=result.deepCopy();}}finally{release(slot);}return state();}
    JsonObject load(JsonObject p)throws Exception{
        FlowPlans.keys(p,"modelId","modelVersion","device","timeoutMs");JsonObject model=models.snapshot(FlowPlans.string(p,"modelId",128),p.has("modelVersion")?(int)Costs.integer(p,"modelVersion",1,Integer.MAX_VALUE):null);requireAuthorized(model);String device=device(p);Slot slot=reserve(device,null,null);if(slot==null)throw new ApiError(409,"local_device_busy","该设备正在执行其他本地工作。");try{return load(slot,model,timeout(p,120000));}finally{release(slot);}
    }
    JsonObject load(Slot slot,JsonObject model,long timeout)throws Exception{
        requireAuthorized(model);long deadline=System.nanoTime()+TimeUnit.MILLISECONDS.toNanos(timeout);synchronized(this){slot.loaded=null;}JsonObject probed=slot.bridge.probe(Math.min(timeout,60000));synchronized(this){environment=probed.deepCopy();}long remaining=TimeUnit.NANOSECONDS.toMillis(deadline-System.nanoTime());if(remaining<1)throw new ApiError(408,"local_timeout","本地环境检查和模型载入超过总时限。");JsonObject loaded=slot.bridge.load(Json.obj("modelPath",model.get("modelPath"),"expectedModelHash",model.get("modelHash"),"taskType",model.get("taskType"),"device",slot.device),remaining);loaded.add("environment",probed);loaded.addProperty("modelId",Json.required(model,"id"));loaded.addProperty("modelVersion",Json.integer(model,"version",0));loaded.add("model",model.deepCopy());synchronized(this){slot.loaded=loaded.deepCopy();}
        JsonObject visible=model.deepCopy();visible.remove("modelPath");return Json.obj("loaded",true,"model",visible,"requestedDevice",loaded.get("requestedDevice"),"observedBackend",loaded.get("observedBackend"),"classes",loaded.get("classes"),"workerHash",loaded.get("workerHash"),"protocolVersion",1);
    }
    JsonObject freeze(JsonObject p,JsonObject project)throws Exception{
        validateParameters(p);JsonObject model=models.snapshot(Json.required(p,"modelId"),p.has("modelVersion")?(int)Costs.integer(p,"modelVersion",1,Integer.MAX_VALUE):null);if(!Json.required(model,"taskType").equals(Json.required(project,"taskType")))throw new ApiError(422,"model_task_mismatch","本地模型任务类型与项目不一致。");requireAuthorized(model);JsonObject loaded;String device=device(p);
        synchronized(this){requireConfigured();Slot slot=slots.get(device);if(slot==null||slot.loaded==null||!Json.required(model,"id").equals(Json.str(slot.loaded,"modelId",""))||Json.integer(model,"version",0)!=Json.integer(slot.loaded,"modelVersion",-1)||!Json.required(model,"modelHash").equals(Json.str(slot.loaded,"modelHash","")))throw new ApiError(409,"local_model_load_required","请先在所选设备载入该模型版本并明确类别映射。");loaded=slot.loaded.deepCopy();}
        Set<String> expected=new HashSet<>(),targets=new HashSet<>();for(JsonElement value:Json.array(loaded,"classes"))expected.add(Json.required(value.getAsJsonObject(),"id"));for(JsonElement value:Json.array(project,"classes"))targets.add(Json.required(value.getAsJsonObject(),"id"));JsonObject mapping=Json.object(p,"classMap");if(!mapping.keySet().equals(expected))throw new ApiError(422,"class_map_incomplete","模型每个类别都须明确映射，忽略类别请设置 null。");for(JsonElement value:mapping.asMap().values())if(!value.isJsonNull()&&!targets.contains(value.getAsString()))throw new ApiError(422,"class_map_invalid","类别映射不属于冻结项目。");
        JsonObject result=Json.obj("model",model,"parameters",p.deepCopy(),"requestedDevice",device,"workerHash",loaded.get("workerHash"),"classes",loaded.get("classes"),"protocolVersion",1);result.add("environment",Json.object(loaded,"environment").deepCopy());return result;
    }
    /** 显式本地 Detect 跟踪入口；调用已有 worker track_sequence，不复用人工插值结果。 */
    JsonObject trackSequence(JsonObject p)throws Exception{
        FlowPlans.keys(p,"device","timeoutMs","sequenceId","sourceVideoId","sourceVideoHash","expectedModelHash","templateHash","classMap","cadence","frames");
        String device=device(p);long timeout=timeout(p,120000);Slot slot=reserve(device,null,null);if(slot==null)throw new ApiError(409,"local_device_busy","该设备正在执行其他本地工作。");
        try{JsonObject model; synchronized(this){if(slot.loaded==null)throw new ApiError(409,"local_model_load_required","请先载入 Detect 模型后再运行自动跟踪。");model=slot.loaded.deepCopy();}
            if(!"detect".equals(Json.str(model,"taskType",""))||!Json.required(model,"modelHash").equals(Json.required(p,"expectedModelHash")))throw new ApiError(409,"local_model_changed","已载入模型与跟踪快照不一致。");
            JsonObject request=p.deepCopy();request.addProperty("requestId",Json.id());JsonArray frames=Json.array(request,"frames");for(JsonElement value:frames){JsonObject frame=value.getAsJsonObject();if(!frame.has("imagePath"))throw new ApiError(400,"tracking_input_invalid","跟踪帧缺少受管图片路径。");}
            return slot.bridge.trackSequence(request,timeout,ignored->{});
        }finally{release(slot);}
    }
    static void validateParameters(JsonObject p){
        FlowPlans.keys(p,"modelId","modelVersion","device","classMap","confidence","iou","imageSize","maxDetections","timeoutMs","reuseEnabled","forceRerun","reuseMaxAgeSeconds");Runs.validateReuse(p);if(p.has("modelId"))FlowPlans.string(p,"modelId",128);if(p.has("modelVersion"))Costs.integer(p,"modelVersion",1,Integer.MAX_VALUE);device(p);timeout(p,120000);if(p.has("classMap")){if(!p.get("classMap").isJsonObject())throw new ApiError(400,"class_map_invalid","类别映射必须为对象。");for(var entry:p.getAsJsonObject("classMap").entrySet())if(entry.getKey().isBlank()||(!entry.getValue().isJsonNull()&&(!entry.getValue().isJsonPrimitive()||!entry.getValue().getAsJsonPrimitive().isString()||entry.getValue().getAsString().isBlank())))throw new ApiError(400,"class_map_invalid","类别映射值必须为类别标识或 null。");}for(String field:List.of("confidence","iou"))if(p.has(field)){JsonElement value=p.get(field);if(!value.isJsonPrimitive()||!value.getAsJsonPrimitive().isNumber()||!Double.isFinite(value.getAsDouble())||value.getAsDouble()<0||value.getAsDouble()>1)throw new ApiError(400,"parameter_invalid",field+" 必须在 0 和 1 之间。");}if(p.has("imageSize"))Costs.integer(p,"imageSize",32,4096);if(p.has("maxDetections"))Costs.integer(p,"maxDetections",1,10000);
    }
    synchronized JsonObject state(){JsonArray values=new JsonArray();for(Slot slot:slots.values()){JsonObject value=Json.obj("device",slot.device,"busy",slot.busy);if(slot.loaded!=null){value.add("modelId",slot.loaded.get("modelId"));value.add("modelVersion",slot.loaded.get("modelVersion"));for(String field:List.of("classes","workerHash","observedBackend"))if(slot.loaded.has(field))value.add(field,slot.loaded.get(field).deepCopy());}if(slot.runId!=null)value.addProperty("runId",slot.runId);if(slot.inputId!=null)value.addProperty("inputId",slot.inputId);values.add(value);}JsonObject result=Json.obj("configured",python!=null,"workerAvailable",worker!=null&&Files.isRegularFile(worker),"available",python!=null&&worker!=null&&Files.isRegularFile(worker)&&Json.bool(environment,"available",false),"devices",Json.array(environment,"devices"),"slots",values);for(String field:List.of("pythonVersion","ultralyticsVersion","torchVersion","cudaAvailable","onnxruntimeVersion","numpyVersion","opencvVersion"))if(environment.has(field))result.add(field,environment.get(field));try{if(worker!=null&&Files.isRegularFile(worker))result.addProperty("workerHash",Media.hash(worker));}catch(Exception ignored){}if(environment.has("code"))result.add("issue",Json.obj("code",environment.get("code"),"message",environment.get("message")));else if(python==null)result.add("issue",Json.obj("code","local_python_required","message","请先配置 Python 环境。"));else if(worker==null||!Files.isRegularFile(worker))result.add("issue",Json.obj("code","local_worker_missing","message","本地推理组件缺失。"));return result;}
    synchronized int active(){return (int)slots.values().stream().filter(slot->slot.busy).count();}
    void cancel(String runId){List<Slot> selected; synchronized(this){selected=slots.values().stream().filter(slot->Objects.equals(runId,slot.runId)).toList();for(Slot slot:selected){slot.cancelRequested=true;slot.loaded=null;}}for(Slot slot:selected){JsonObject status=slot.bridge.status();if(status.has("requestId")&&!status.get("requestId").isJsonNull())slot.bridge.cancel(Json.required(status,"requestId"));}}
    @Override public void close(){List<Slot> previous;synchronized(this){closed=true;previous=new ArrayList<>(slots.values());}for(Slot slot:previous){slot.bridge.close();slot.executor.shutdownNow();try{slot.executor.awaitTermination(5,TimeUnit.SECONDS);}catch(InterruptedException error){Thread.currentThread().interrupt();}}}
}
