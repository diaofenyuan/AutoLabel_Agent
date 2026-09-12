package cn.autolabel.engine;

import com.google.gson.*;
import java.nio.file.*;
import java.util.*;

/** 离线验证 LocalInference 对 worker track_sequence 的身份、workerHash 和事件桥接。 */
final class LocalTrackingBridgeTest {
    static int checks;
    static void check(boolean ok,String message){checks++;if(!ok)throw new AssertionError(message);}
    private static void run(Path pythonRoot,boolean requiresReview)throws Exception{
        Path root=Files.createTempDirectory("autolabel-track-bridge-"), worker=root.resolve("worker.py"), model=root.resolve("model.pt");Files.writeString(model,"fixture-model");
        Files.writeString(worker,"import sys,json,hashlib\n"+
            "def out(x): print(json.dumps(x,ensure_ascii=False),flush=True)\n"+
            "out({'type':'ready','protocolVersion':1})\n"+
            "for line in sys.stdin:\n"+
            " r=json.loads(line); p=r['payload']; c=r['command'];\n"+
            " if c=='load': out({'type':'response','id':r['id'],'ok':True,'data':{'loaded':True,'taskType':'detect','modelHash':p['expectedModelHash'],'requestedDevice':p['device'],'classes':[{'id':'0','name':'target'}],'observedBackend':{'kind':'pytorch','device':'cpu'}}})\n"+
            " elif c=='track_sequence':\n"+
            "  out({'type':'event','id':r['id'],'stage':'local_tracking','inputId':p['frames'][0]['inputId'],'frameIndex':0,'framesTotal':len(p['frames'])})\n"+
            "  h=hashlib.sha256(open(__file__,'rb').read()).hexdigest(); out({'type':'response','id':r['id'],'ok':True,'data':{'sequenceId':p['sequenceId'],'sourceVideoId':p['sourceVideoId'],'sourceVideoHash':p['sourceVideoHash'],'templateHash':p['templateHash'],'source':'local_tracking','taskType':'detect','modelHash':p['expectedModelHash'],'requiresTrackingReview':"+(requiresReview?"True":"False")+",'provenance':{'workerHash':h},'frames':[],'tracks':[]}})\n");
        try(LocalInference bridge=new LocalInference(pythonRoot,worker)){
            JsonObject loaded=bridge.load(Json.obj("modelPath",model.toString(),"taskType","detect","device","cpu"),10000);String hash=Media.hash(model);check(Json.required(loaded,"modelHash").equals(hash),"模型载入指纹固定");List<JsonObject> events=new ArrayList<>();
            JsonObject request=Json.obj("requestId","track-1","sequenceId","sequence-1","sourceVideoId","video-1","sourceVideoHash","a".repeat(64),"expectedModelHash",hash,"templateHash","b".repeat(64),"classMap",Json.obj("0","target"),"cadence",Json.obj("numerator","1","denominator","10"),"frames",Json.arr(Json.obj("inputId","i1"),Json.obj("inputId","i2")));
            JsonObject result=bridge.trackSequence(request,10000,events::add);check(Json.str(result,"source","").equals("local_tracking"),"worker 跟踪响应保持原始协议");check(Json.bool(result,"requiresTrackingReview",false)==requiresReview&&Engine.trackingReviewRequired(result)==requiresReview,"worker 复核诊断原样透传");check(events.size()==1&&Json.str(events.get(0),"stage","").equals("local_tracking"),"跟踪进度事件经过桥接");
        }finally{Files.deleteIfExists(worker);Files.deleteIfExists(model);Files.deleteIfExists(root);}
    }
    public static void main(String[] args)throws Exception{
        if(args.length==0){System.out.println("LocalTrackingBridgeTest skipped: python path not supplied");return;}
        Path pythonRoot=Path.of(args[0]);run(pythonRoot,false);run(pythonRoot,true);
        System.out.println("LocalTrackingBridgeTest passed: "+checks+" checks; no network");
    }
}
