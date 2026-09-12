package cn.autolabel.engine;
import com.google.gson.*;
import java.nio.file.*;
/** 覆盖配置删除的活动任务保护、内存凭据清理和重启持久化边界；不访问网络。 */
final class ProviderDeleteTest {
 static int checks;
 static void check(boolean value,String message){checks++;if(!value)throw new AssertionError(message);}
 static void reject(String code,Runnable action){try{action.run();throw new AssertionError("expected "+code);}catch(ApiError e){check(code.equals(e.code),code+" != "+e.code);}}
 public static void main(String[] args)throws Exception{
  Path root=Path.of("engine/build/verification/provider-delete-"+System.currentTimeMillis()).toAbsolutePath();
  try(Engine e=new Engine(root)){
   JsonObject project=e.projects.create(Json.obj("name","删除接口夹具","taskType","detect","classes",Json.arr(Json.obj("id","x","name","对象","color","#123456"))));
   JsonObject provider=e.providers.save(Json.obj("name","待删除接口","baseUrl","https://example.invalid/v1","protocol","chat-completions"));String id=Json.required(provider,"id");e.providers.credential(Json.obj("providerId",id,"key","delete-only-secret"));check(e.providers.credentialBindingVersion(id)==null,"无绑定版本兼容旧凭据");
   String runId=Json.id();e.store.tx(c->{JsonObject run=Json.obj("id",runId,"projectId",project.get("id"),"providerId",id,"status","paused");Store.update(c,"INSERT INTO runs(id,project_id,status,data) VALUES(?,?,?,?)",runId,project.get("id"),"paused",run);return null;});
   reject("provider_in_use",()->e.providers.delete(Json.obj("providerId",id)));check(e.providers.credentialBindingVersion(id)==null,"拒绝删除不清理仍在使用的凭据");
   e.store.tx(c->{Store.update(c,"UPDATE runs SET status='cancelled' WHERE id=?",runId);return null;});JsonObject deleted=e.providers.delete(Json.obj("providerId",id));check(Json.bool(deleted,"deleted",false)&&Json.bool(deleted,"credentialCleared",false),"删除返回凭据清理结果");check(e.providers.credentialBindingVersion(id)==null,"删除清理内存凭据");reject("not_found",()->e.providers.get(id));
   JsonArray events=e.store.read(c->Store.events(c,0,null,null,200));check(events.asList().stream().anyMatch(value->Json.str(value.getAsJsonObject(),"type","").equals("provider.deleted")),"删除事件持久化");
   JsonObject recreated=e.providers.save(Json.obj("name","重新创建接口","baseUrl","https://example.invalid/v1","protocol","chat-completions"));check(!Json.required(recreated,"id").equals(id),"删除后创建新配置使用新身份");
  }
  System.out.println("ProviderDeleteTest passed: "+checks+" checks; no network");
 }
}
