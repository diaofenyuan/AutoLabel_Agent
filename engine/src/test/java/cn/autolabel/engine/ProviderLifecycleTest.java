package cn.autolabel.engine;

import com.google.gson.*;
import java.nio.file.*;

/** 验证接口删除的运行保护、配置删除和引擎内存凭据清理，不发起外部请求。 */
public final class ProviderLifecycleTest {
    private static int checks;
    private static void check(boolean value,String message){checks++;if(!value)throw new AssertionError(message);}
    private static void rejects(String code,Runnable action){try{action.run();throw new AssertionError("应拒绝 "+code);}catch(ApiError error){check(error.code.equals(code),"错误码 "+error.code+" != "+code);}}
    public static void main(String[] args)throws Exception{
        Path root=Files.createTempDirectory("autolabel-provider-lifecycle-");
        try(Engine engine=new Engine(root)){
            JsonObject provider=engine.providers.save(Json.obj("name","生命周期夹具","baseUrl","https://example.invalid/v1","protocol","chat-completions"));
            String id=Json.required(provider,"id");
            engine.providers.credential(Json.obj("providerId",id,"key","lifecycle-secret"));
            engine.store.tx(c->{JsonObject run=Json.obj("id","active-run","projectId","p","providerId",id,"status","paused");Store.update(c,"INSERT INTO runs(id,project_id,status,data) VALUES(?,?,?,?)","active-run","p","paused",run);return null;});
            rejects("provider_in_use",()->engine.providers.delete(Json.obj("providerId",id)));
            check(engine.providers.list().size()==1,"受保护删除保留配置");
            engine.store.tx(c->{Store.update(c,"UPDATE runs SET status='cancelled' WHERE id='active-run'");return null;});
            JsonObject result=engine.providers.delete(Json.obj("providerId",id));
            check(Json.bool(result,"deleted",false)&&Json.bool(result,"credentialCleared",false),"删除返回清理结果");
            check(engine.providers.list().isEmpty(),"配置已删除");
            rejects("not_found",()->engine.providers.credential(Json.obj("providerId",id,"key","new-secret")));
            rejects("not_found",()->engine.providers.delete(Json.obj("providerId",id)));
        }
        System.out.println("Provider lifecycle: "+checks+" checks passed; no network calls.");
    }
}
