package cn.autolabel.engine;

import com.google.gson.*;
import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.BooleanSupplier;

public final class LocalInferenceTest {
    private static int checks;
    private static Path python,root,script,model,input;
    private static JsonObject asset,project;
    private interface Action{void run()throws Exception;}
    private static void check(boolean value,String message){checks++;if(!value)throw new AssertionError(message);}
    private static void rejects(String code,Action action)throws Exception{try{action.run();throw new AssertionError("Expected "+code);}catch(ApiError error){check(code.equals(error.code),"Expected "+code+", got "+error.code);}}
    private static void until(BooleanSupplier condition)throws Exception{long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);while(!condition.getAsBoolean()&&System.nanoTime()<deadline)Thread.sleep(10);check(condition.getAsBoolean(),"bounded eventual condition");}

    public static void main(String[] args)throws Exception{
        if(args.length!=1&&args.length!=4&&args.length!=5)throw new IllegalArgumentException("pythonExe [workerScript modelPath imagePath [taskType]]");
        python=Path.of(args[0]).toAbsolutePath();root=Files.createTempDirectory("autolabel-local-inference-");script=root.resolve("fake_worker.py");model=root.resolve("fixture.pt");input=root.resolve("input.png");
        Files.writeString(script,WORKER,StandardCharsets.UTF_8);Files.writeString(model,"isolated model fixture");image(input);asset=Json.obj("id","asset-local","width",64,"height",48,"contentHash",Media.hash(input));project=project("detect");
        if(args.length==1){basic();validation();protocol();lifecycle();batch();}
        else real(Path.of(args[1]),Path.of(args[2]),Path.of(args[3]),args.length==5?args[4]:"segment");
        System.out.println("Local inference: "+checks+" checks passed; isolated fixtures: "+root);
    }

    private static void batch()throws Exception{
        try(LocalInference bridge=bridge()){
            // 哈希短路反例：只翻转一个字节（体积不变）也必须被识破，且恢复字节后继续可用。
            byte[] original=Files.readAllBytes(model);original[0]=(byte)(original[0]^1);Files.write(model,original);
            rejects("local_model_changed",()->predict(bridge,"one-byte-change"));
            original[0]=(byte)(original[0]^1);Files.write(model,original);
            check(predict(bridge,"after-byte-restore").adoptable(),"restored model bytes resume inference");
            LocalInference.BatchItem ok=new LocalInference.BatchItem(request("batch-ok"),asset),stale=new LocalInference.BatchItem(request("batch-stale"),asset);
            stale.request.addProperty("expectedInputHash","0".repeat(64));
            JsonObject markerAsset=asset.deepCopy();markerAsset.addProperty("id","batch-fail");
            JsonObject markerRequest=request("batch-marker");markerRequest.addProperty("assetId","batch-fail");
            List<LocalInference.BatchItem> items=new ArrayList<>();items.add(ok);items.add(stale);items.add(new LocalInference.BatchItem(markerRequest,markerAsset));
            check(bridge.predictBatch(items,project,10000,null)==items,"batch returns per-item outcomes aligned to the request order");
            check(ok.prediction!=null&&ok.failure==null&&ok.prediction.adoptable()&&ok.prediction.annotations().size()==1,"batch sibling with valid input succeeds");
            check("batch-ok".equals(Json.required(ok.prediction.provenance(),"requestId")),"batch result keeps its own request identity");
            check(stale.prediction==null&&stale.failure!=null&&"local_input_changed".equals(stale.failure.code),"stale input hash fails alone inside a batch");
            check(items.get(2).prediction==null&&items.get(2).failure!=null&&"input_changed".equals(items.get(2).failure.code),"worker failed entry becomes per-item batch failure");
        }
    }

    private static JsonObject project(String task){return Json.obj("id","project-local","taskType",task,"classes",Json.arr(Json.obj("id","target","name","目标")),"settings",Json.obj("keypointNames",Json.arr("点一","点二")));}
    private static JsonObject loadParams(){return Json.obj("modelPath",model.toString(),"taskType","detect","device","cpu");}
    private static JsonObject request(String id){return Json.obj("requestId",id,"assetId","asset-local","imagePath",input.toString(),"classMap",Json.obj("0","target","1",null));}
    private static LocalInference bridge()throws Exception{LocalInference bridge=new LocalInference(python,script);bridge.load(loadParams(),10000);return bridge;}
    private static LocalInference.Prediction predict(LocalInference bridge,String id){return bridge.predict(request(id),asset,project,10000,null);}
    private static void image(Path path)throws Exception{ImageIO.write(new BufferedImage(64,48,BufferedImage.TYPE_INT_RGB),"png",path.toFile());}

    private static void basic()throws Exception{
        try(LocalInference bridge=new LocalInference(python,script)){
            JsonObject probe=bridge.probe(10000);check(Json.bool(probe,"available",false),"fake environment is available");check(Json.required(probe,"parentPid").equals(Long.toString(ProcessHandle.current().pid())),"parent pid is explicit");
            if(System.getProperty("os.name").startsWith("Windows"))check(Json.number(probe,"consoleWindow",-1)==0,"direct Java worker has no console window");
            JsonObject loaded=bridge.load(loadParams(),10000);check(loaded.get("observedBackend").isJsonNull(),"load does not invent observed backend");check(Json.required(loaded,"requestedDevice").equals("cpu")&&!loaded.has("device"),"requested device is explicit");check(Json.required(loaded,"modelHash").equals(Media.hash(model)),"loaded model is fixed by actual hash");
            check(Json.required(loaded,"workerHash").equals(Media.hash(script)),"worker source version is fixed at launch");
            List<JsonObject> events=new CopyOnWriteArrayList<>();LocalInference.Prediction prediction=bridge.predict(request("valid"),asset,project,10000,events::add);
            check(prediction.adoptable()&&prediction.annotations().size()==1&&prediction.issues().isEmpty(),"valid geometry becomes adoptable candidate");until(()->events.size()==1);check(Json.required(events.getFirst(),"id").equals("valid"),"event matches true request id");check(Json.required(prediction.provenance(),"inputHash").equals(Media.hash(input)),"input hash is preserved");
            check(Json.required(Json.object(prediction.provenance(),"observedBackend"),"device").equals("cpu"),"actual backend record is preserved");check(Json.bool(Json.object(prediction.provenance(),"environment"),"available",false),"probe environment is recorded");
            rejects("local_request_reused",()->predict(bridge,"valid"));
            LocalInference.Prediction zero=predict(bridge,"zero");check(zero.adoptable()&&zero.annotations().isEmpty()&&Json.required(zero.provenance(),"emptyReason").equals("model_no_targets"),"true negative is distinct from broken geometry");
            LocalInference.Prediction excluded=predict(bridge,"excluded");check(excluded.adoptable()&&Json.required(excluded.provenance(),"emptyReason").equals("all_classes_excluded"),"explicit exclusion remains traceable");
            LocalInference.Prediction geometry=predict(bridge,"geometry");check(!geometry.adoptable()&&geometry.annotations()==null&&!geometry.issues().isEmpty(),"invalid geometry cannot become empty success");check(Json.array(geometry.rawResult(),"annotations").size()==1,"invalid raw object is retained");
            LocalInference.Prediction flagged=predict(bridge,"flagged");check(!flagged.adoptable()&&flagged.annotations()==null&&!flagged.issues().isEmpty(),"worker geometry review blocks adoption even if other geometry validates");
            LocalInference.Prediction onnx=predict(bridge,"onnx");JsonObject backend=Json.object(onnx.provenance(),"observedBackend");check(Json.required(backend,"kind").equals("onnxruntime")&&backend.get("device").isJsonNull()&&Json.array(backend,"providers").size()==2,"ONNX provider list preserved without GPU inference");
            LocalInference.Prediction unknown=predict(bridge,"unknown-backend");check(unknown.provenance().get("observedBackend").isJsonNull(),"missing observed backend remains unknown");
            predict(bridge,"stderr-flood");until(()->Json.str(bridge.status(),"stderr","").endsWith("LOG-END"));check(Json.str(bridge.status(),"stderr","").getBytes(StandardCharsets.UTF_8).length<=256*1024,"stderr drain remains bounded");
            check(bridge.predict(request("observer-error"),asset,project,10000,event->{throw new IllegalStateException("observer fixture");}).adoptable(),"observer error cannot change inference outcome");
            CountDownLatch observerRelease=new CountDownLatch(1);try{check(bridge.predict(request("observer-slow"),asset,project,10000,event->{try{observerRelease.await();}catch(InterruptedException interrupted){Thread.currentThread().interrupt();}}).adoptable(),"blocked observer does not block response");}finally{observerRelease.countDown();}
        }
    }

    private static void validation()throws Exception{
        try(LocalInference bridge=bridge()){
            JsonObject incomplete=request("map-missing");Json.object(incomplete,"classMap").remove("1");rejects("class_map_incomplete",()->bridge.predict(incomplete,asset,project,10000,null));
            JsonObject unknown=request("map-unknown");Json.object(unknown,"classMap").addProperty("1","nonexistent");rejects("class_map_invalid",()->bridge.predict(unknown,asset,project,10000,null));
            JsonObject missing=request("map-none");missing.remove("classMap");rejects("class_map_required",()->bridge.predict(missing,asset,project,10000,null));
            JsonObject wrong=request("input-hash");wrong.addProperty("expectedInputHash","0".repeat(64));rejects("local_input_changed",()->bridge.predict(wrong,asset,project,10000,null));
            JsonObject badModel=request("model-hash");badModel.addProperty("expectedModelHash","0".repeat(64));rejects("local_model_changed",()->bridge.predict(badModel,asset,project,10000,null));
            JsonObject dimensions=asset.deepCopy();dimensions.addProperty("width",65);rejects("local_input_mismatch",()->bridge.predict(request("dimensions"),dimensions,project,10000,null));
            JsonObject fractional=request("fractional");fractional.addProperty("imageSize",32.5);rejects("parameter_invalid",()->bridge.predict(fractional,asset,project,10000,null));
            for(String id:List.of("wrong-hash","wrong-model","wrong-dimensions","wrong-task","wrong-asset"))rejects("local_result_invalid",()->predict(bridge,id));
            rejects("local_input_changed",()->bridge.predict(request("mutate-input"),asset,project,10000,event->{try{Files.writeString(input,"changed during prediction");}catch(Exception failure){throw new RuntimeException(failure);}}));image(input);
            rejects("local_model_changed",()->bridge.predict(request("mutate-model"),asset,project,10000,event->{try{Files.writeString(model,"changed model");}catch(Exception failure){throw new RuntimeException(failure);}}));Files.writeString(model,"isolated model fixture");
            Path failed=root.resolve("fail.pt");Files.writeString(failed,"bad model");JsonObject bad=loadParams();bad.addProperty("modelPath",failed.toString());rejects("model_task_mismatch",()->bridge.load(bad,10000));rejects("model_required",()->predict(bridge,"after-failed-load"));
            bridge.load(loadParams(),10000);JsonObject gpu=loadParams();gpu.addProperty("device","0");rejects("device_unavailable",()->bridge.load(gpu,10000));rejects("model_required",()->predict(bridge,"after-unavailable-gpu"));check(!Json.bool(bridge.status(),"loaded",true),"GPU failure does not fall back to CPU model");
        }
        try(LocalInference bridge=new LocalInference(python,script)){
            JsonObject pose=loadParams();pose.addProperty("taskType","pose");bridge.load(pose,10000);JsonObject request=request("pose-order");request.add("keypointNames",Json.arr("点二","点一"));rejects("keypoint_template_mismatch",()->bridge.predict(request,asset,project("pose"),10000,null));
            JsonObject classify=loadParams();classify.addProperty("taskType","classify");bridge.load(classify,10000);rejects("local_result_invalid",()->bridge.predict(request("zero"),asset,project("classify"),10000,null));
        }
        try(LocalInference bridge=bridge()){
            try{Files.writeString(script,WORKER+"\n");rejects("local_worker_changed",()->predict(bridge,"changed-worker"));check(!Json.bool(bridge.status(),"loaded",true),"changed script cannot retain previous execution version");}
            finally{Files.writeString(script,WORKER);}
        }
    }

    private static void protocol()throws Exception{
        for(String id:List.of("wrong-id","wrong-event","malformed","lenient-json","bad-utf8","bad-boolean","no-annotations","oversize","truncated","exit")){
            try(LocalInference bridge=bridge()){
                String expected=switch(id){case "oversize"->"local_response_too_large";case "truncated","exit"->"local_worker_exited";case "no-annotations"->"local_result_invalid";default->"local_protocol_invalid";};
                rejects(expected,()->predict(bridge,id));if(!id.equals("no-annotations"))until(()->!Json.bool(bridge.status(),"running",true));
            }
        }
        try(LocalInference bridge=bridge()){
            try{predict(bridge,"duplicate");}catch(ApiError error){check(Set.of("local_protocol_invalid","local_worker_exited").contains(error.code),"duplicate is never a second candidate");}
            until(()->!Json.bool(bridge.status(),"running",true));rejects("model_required",()->predict(bridge,"after-duplicate"));bridge.load(loadParams(),10000);check(predict(bridge,"new-generation").adoptable(),"replacement generation accepts its own response");
        }
        Path wrongProtocol=root.resolve("wrong_protocol.py");Files.writeString(wrongProtocol,"import json,time\nprint(json.dumps({'type':'ready','protocolVersion':2}),flush=True)\ntime.sleep(30)\n");
        try(LocalInference bridge=new LocalInference(python,wrongProtocol)){rejects("local_protocol_invalid",()->bridge.probe(5000));}
        Path silent=root.resolve("silent_worker.py");Files.writeString(silent,"import time\ntime.sleep(30)\n");
        try(LocalInference bridge=new LocalInference(python,silent)){rejects("local_timeout",()->bridge.probe(200));until(()->!Json.bool(bridge.status(),"running",true));}
    }

    private static void lifecycle()throws Exception{
        Process unrelated=new ProcessBuilder(python.toString(),"-c","import time; time.sleep(60)").start();
        try(LocalInference bridge=bridge()){
            CompletableFuture<JsonObject> event=new CompletableFuture<>();CompletableFuture<LocalInference.Prediction> result=CompletableFuture.supplyAsync(()->bridge.predict(request("hang-child"),asset,project,30000,event::complete));
            JsonObject started=event.get(10,TimeUnit.SECONDS);long child=Json.number(started,"childPid",0),worker=Json.number(bridge.status(),"pid",0);check(child>0&&worker>0,"owned worker and child are known");
            rejects("local_device_busy",()->bridge.probe(1000));check(!bridge.cancel("different-id"),"unrelated cancellation cannot stop active request");check(bridge.cancel("hang-child"),"matching request cancels");
            rejects("local_cancelled",()->join(result));until(()->ProcessHandle.of(child).map(handle->!handle.isAlive()).orElse(true));until(()->ProcessHandle.of(worker).map(handle->!handle.isAlive()).orElse(true));check(unrelated.isAlive(),"other Python process is untouched");
            check(!bridge.cancel("hang-child")&&!Json.bool(bridge.status(),"loaded",true),"completed cancellation cannot reapply stale result");bridge.load(loadParams(),10000);check(predict(bridge,"after-cancel").adoptable(),"explicit reload works after cancellation");
            rejects("local_timeout",()->bridge.predict(request("hang"),asset,project,200,null));check(!Json.bool(bridge.status(),"loaded",true)&&!Json.bool(bridge.status(),"running",true),"timeout leaves inference incomplete and removes stale model");
        }finally{unrelated.destroyForcibly();unrelated.waitFor(5,TimeUnit.SECONDS);}
        LocalInference closed=bridge();closed.close();rejects("local_closed",()->closed.probe(1000));closed.close();
    }
    private static void join(CompletableFuture<?> future)throws Exception{try{future.get(10,TimeUnit.SECONDS);}catch(ExecutionException failed){if(failed.getCause() instanceof ApiError error)throw error;throw failed;}}

    private static void real(Path worker,Path realModel,Path realImage,String task)throws Exception{
        try(LocalInference bridge=new LocalInference(python,worker)){
            check(Json.bool(bridge.probe(60000),"available",false),"actual local inference environment available");JsonObject loaded=bridge.load(Json.obj("modelPath",realModel.toAbsolutePath().toString(),"taskType",task,"device","cpu"),120000);
            JsonObject mapping=new JsonObject();JsonArray classes=new JsonArray();for(JsonElement item:Json.array(loaded,"classes")){JsonObject category=item.getAsJsonObject();String id="local-"+Json.required(category,"id");mapping.addProperty(Json.required(category,"id"),id);classes.add(Json.obj("id",id,"name",Json.required(category,"name")));}
            Path normalized=root.resolve("real-input.png");BufferedImage image=ImageIO.read(realImage.toFile());ImageIO.write(image,"png",normalized.toFile());JsonObject realAsset=Json.obj("id","real-local","width",image.getWidth(),"height",image.getHeight(),"contentHash",Media.hash(normalized));JsonArray names=new JsonArray();if(task.equals("pose"))for(int i=0;i<17;i++)names.add("point-"+i);JsonObject realProject=Json.obj("id","real-local","taskType",task,"classes",classes,"settings",Json.obj("keypointNames",names));
            LocalInference.Prediction prediction=bridge.predict(Json.obj("requestId",Json.id(),"assetId","real-local","imagePath",normalized.toString(),"classMap",mapping,"confidence",0.25,"imageSize",640),realAsset,realProject,120000,null);
            check(!Json.array(prediction.rawResult(),"annotations").isEmpty(),"actual CPU inference returns nonempty raw candidates");
            try{Annotations.validate(Json.array(prediction.rawResult(),"annotations"),realAsset,realProject);check(prediction.adoptable()&&prediction.annotations()!=null,"valid actual result can be adopted");}
            catch(ApiError geometry){check(!prediction.adoptable()&&prediction.annotations()==null&&!prediction.issues().isEmpty(),"actual invalid geometry remains reviewable raw candidates");System.out.println("Actual geometry review: "+geometry.code+" "+geometry.getMessage());}
            check(Json.required(prediction.provenance(),"requestedDevice").equals("cpu"),"actual run explicitly requested CPU");JsonObject backend=Json.object(prediction.provenance(),"observedBackend");check(Json.required(backend,"kind").equals("pytorch")&&Json.required(backend,"device").equals("cpu"),"actual PyTorch backend reports CPU");check(Json.required(prediction.provenance(),"inputHash").equals(Media.hash(normalized)),"actual response matches frozen normalized image");
            if(task.equals("pose"))check(prediction.adoptable()&&prediction.annotations().size()>0,"actual pose CPU candidate is adoptable");
            System.out.println("Actual local CPU "+task+": "+Json.array(prediction.rawResult(),"annotations").size()+" raw candidates, adoptable="+prediction.adoptable()+", elapsedMs="+prediction.provenance().get("elapsedMs"));
        }
    }

    static final String WORKER="""
        import hashlib,json,os,pathlib,subprocess,sys,time
        def emit(value):
            print(json.dumps(value),flush=True)
        def digest(path):
            return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()
        emit({'type':'ready','protocolVersion':1})
        loaded=None
        for line in sys.stdin:
            request=json.loads(line); rid=request['id']; command=request['command']; payload=request['payload']
            if command=='shutdown':
                emit({'type':'response','id':rid,'ok':True,'data':{'shutdown':True}});break
            if command=='probe':
                console=0
                if os.name=='nt':
                    import ctypes
                    console=ctypes.windll.kernel32.GetConsoleWindow()
                data={'available':True,'parentPid':os.environ.get('AUTOLABEL_PARENT_PID'),'consoleWindow':console}
            elif command=='load':
                loaded=None
                if pathlib.Path(payload['modelPath']).name=='fail.pt' or payload['device']!='cpu':
                    code='model_task_mismatch' if payload['device']=='cpu' else 'device_unavailable'
                    emit({'type':'response','id':rid,'ok':False,'error':{'code':code,'message':'fixture load failed'}});continue
                assert digest(payload['modelPath'])==payload['expectedModelHash']
                loaded={'taskType':payload['taskType'],'modelHash':digest(payload['modelPath']),'requestedDevice':payload['device']}
                data=dict(loaded,loaded=True,classes=[{'id':'0','name':'object'},{'id':'1','name':'ignored'}],observedBackend=None)
            elif command=='batch_predict':
                mode=pathlib.Path(__file__).with_suffix('.mode').read_text() if pathlib.Path(__file__).with_suffix('.mode').exists() else 'normal'
                results=[]
                for index,item in enumerate(payload.get('inputs',[])):
                    item=dict(item);item.setdefault('assetId','batch-%d'%index)
                    if item.get('assetId')=='batch-fail':
                        results.append({'assetId':item.get('assetId'),'status':'failed','errorCode':'input_changed','message':'fixture batch item failed'});continue
                    emit(dict(type='event',id=rid,assetId=item['assetId'],stage='local_inference'))
                    if mode=='hang':time.sleep(30)
                    if mode=='delay':time.sleep(0.5)
                    input_hash=digest(item['imagePath']);assert input_hash==item['expectedInputHash']
                    annotation={'id':'object-1','classId':'target','type':loaded['taskType'],'confidence':0.9,'bbox':{'x':2,'y':3,'width':10,'height':12}}
                    if mode=='geometry':annotation['bbox']['x']=-2
                    results.append(dict(loaded,assetId=item['assetId'],source='local_yolo',inputHash=input_hash,width=64,height=48,annotations=[] if mode=='zero' else [annotation],elapsedMs=1.5,excludedByClassMap=0,observedBackend={'kind':'pytorch','device':'cpu','providers':None},geometryIssues=[],requiresGeometryReview=False))
                data={'results':results,'count':len(results)}
            else:
                event={'type':'event','id':rid,'assetId':payload['assetId'],'stage':'local_inference'}
                if rid=='hang-child':
                    child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
                    event['childPid']=child.pid
                if rid=='wrong-event':event['assetId']='different-asset'
                input_hash=digest(payload['imagePath']);assert input_hash==payload['expectedInputHash']
                emit(event)
                if rid in ('hang','hang-child'):time.sleep(30)
                if rid.startswith('mutate-'):time.sleep(0.2)
                if rid=='exit':sys.exit(4)
                if rid=='truncated':sys.stdout.write('{"type":');sys.stdout.flush();sys.exit(4)
                if rid=='malformed':print('library banner',flush=True);continue
                if rid=='lenient-json':print('{type:"response"}',flush=True);continue
                if rid=='bad-utf8':sys.stdout.buffer.write(bytes([255,10]));sys.stdout.flush();continue
                if rid=='oversize':sys.stdout.write('x'*(32*1024*1024+1));sys.stdout.flush();continue
                if rid=='stderr-flood':sys.stderr.write('L'*(300*1024)+'LOG-END');sys.stderr.flush()
                annotation={'id':'object-1','classId':'target','type':loaded['taskType'],'confidence':0.9,'bbox':{'x':2,'y':3,'width':10,'height':12}}
                if rid=='geometry':annotation['bbox']['x']=-2
                annotations=[] if rid in ('zero','excluded') else [annotation]
                backend={'kind':'pytorch','device':'cpu','providers':None}
                if rid=='onnx':backend={'kind':'onnxruntime','device':None,'providers':['CUDAExecutionProvider','CPUExecutionProvider']}
                data=dict(loaded,assetId=payload['assetId'],source='local_yolo',inputHash=input_hash,width=64,height=48,annotations=annotations,elapsedMs=1.5,excludedByClassMap=1 if rid=='excluded' else 0,observedBackend=backend,geometryIssues=[],requiresGeometryReview=False)
                if rid=='unknown-backend':del data['observedBackend']
                if rid=='flagged':data['geometryIssues']=[{'code':'geometry_out_of_bounds','severity':'error'}];data['requiresGeometryReview']=True
                if rid=='wrong-hash':data['inputHash']='0'*64
                if rid=='wrong-model':data['modelHash']='0'*64
                if rid=='wrong-task':data['taskType']='classify'
                if rid=='wrong-asset':data['assetId']='wrong'
                if rid=='wrong-dimensions':data['width']=65
                if rid=='no-annotations':del data['annotations']
            response={'type':'response','id':'different-id' if rid=='wrong-id' else rid,'ok':'true' if rid=='bad-boolean' else True,'data':data}
            emit(response)
            if rid=='duplicate':emit(response)
        """;
}
