package cn.autolabel.engine;

import com.google.gson.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicLong;

/** 只验证本地额度状态；假凭据不发送网络请求，低频率用可控时钟检查。 */
final class ProvidersQuotaTest {
    private static int checks;
    private static void check(boolean ok,String message){checks++;if(!ok)throw new AssertionError(message);}
    private static final class Clock {
        final AtomicLong nanos=new AtomicLong();
        long wall=1_700_000_000_000L,step;
        long now(){return nanos.getAndAdd(step);}
        long millis(){return wall+TimeUnit.NANOSECONDS.toMillis(nanos.get());}
        void advance(long milliseconds){nanos.addAndGet(TimeUnit.MILLISECONDS.toNanos(milliseconds));}
    }
    private static final class Fixture implements AutoCloseable {
        final Store store;
        final Clock clock=new Clock();
        final Providers providers;
        Fixture(Path path)throws Exception{store=new Store(path);providers=new Providers(store,clock::now,clock::millis);}
        JsonObject provider(String name,String key,String group,int cap,int rpm){
            JsonObject value=Json.obj("name",name,"baseUrl","https://quota-fixture.invalid/v1","concurrency",cap,"requestsPerMinute",rpm);
            if(group!=null)value.addProperty("quotaGroupId",group);
            JsonObject saved=providers.save(value);if(key!=null)credential(saved,key);return saved;
        }
        void credential(JsonObject p,String key){providers.credential(Json.obj("providerId",p.get("id"),"key",key));}
        Providers.Permit take(JsonObject p){Providers.Permit permit=providers.acquire(p);check(permit!=null,"预期取得额度："+Json.required(p,"name"));return permit;}
        int active(String group){return Json.integer(Json.object(providers.limits(),group),"inFlight",0);}
        @Override public void close(){providers.close();store.close();}
    }

    private static void credentialCannotBeSplitByManualGroups(Path root)throws Exception{
        try(Fixture f=new Fixture(root.resolve("same-credential"))){
            JsonObject a=f.provider("same-a","quota-fake-shared","manual-a",4,60000),b=f.provider("same-b","quota-fake-shared","manual-b",1,60000);
            Providers.Permit first=f.take(a);check(first.group().equals("manual-a"),"旧记账组仍是手动组");f.clock.advance(1);
            check(f.providers.acquire(b)==null,"不同手动组仍受同一凭据的最严格并发约束");
            check(!f.providers.limits().has("manual-b"),"失败申请不创建公开占用");f.providers.release(first);
            Providers.Permit second=f.take(b);check(second.group().equals("manual-b"),"另一配置保留自己的旧记账组");
            JsonObject visible=f.providers.limits();check(visible.keySet().equals(Set.of("manual-a","manual-b")),"隐藏凭据门槛不新增公开摘要键");
            check(!visible.toString().contains("quota-fake")&&!visible.toString().contains("credential-"),"公开手动组诊断不暴露凭据或摘要");
            check(first.toString().equals("[permit]"),"Permit 不序列化内部门槛");f.providers.release(second);
        }
    }

    private static void manualGroupAddsIndependentSharedLimit(Path root)throws Exception{
        try(Fixture f=new Fixture(root.resolve("same-manual"))){
            JsonObject a=f.provider("manual-a","quota-fake-a","shared-manual",3,60000),b=f.provider("manual-b","quota-fake-b","shared-manual",1,60000);
            Providers.Permit first=f.take(a);f.clock.advance(1);check(f.providers.acquire(b)==null,"不同凭据仍受手动组最严格并发约束");
            f.providers.release(first);Providers.Permit second=f.take(b);check(f.active("shared-manual")==1,"旧共享组只计一次并发，不因双门槛重复计数");
            f.providers.release(second);check(f.active("shared-manual")==0,"手动组释放后归零");
        }
    }

    private static void crossingGatesAreAcquiredAtomically(Path root)throws Exception{
        try(Fixture f=new Fixture(root.resolve("crossing"))){
            JsonObject a=f.provider("cross-a","quota-fake-a","group-a",1,60000),b=f.provider("cross-b","quota-fake-b","group-b",1,60000);
            JsonObject c=f.provider("cross-c","quota-fake-a","group-b",1,60000),d=f.provider("cross-d","quota-fake-b","group-a",1,60000);
            Providers.Permit first=f.take(a),second=f.take(b);f.clock.advance(2);
            check(f.providers.acquire(c)==null&&f.providers.acquire(d)==null,"交叉占用时两个请求均完整拒绝");
            f.providers.release(first);
            for(int retry=0;retry<3;retry++)check(f.providers.acquire(c)==null,"手动组未空闲时不抢占已经空闲的凭据");
            check(f.providers.acquire(d)==null,"凭据未空闲时不抢占已经空闲的手动组");
            f.providers.release(second);
            Providers.Permit third=f.take(c),fourth=f.take(d);
            check(f.active("group-a")==1&&f.active("group-b")==1,"失败尝试没有消耗速率，也没有留下半份并发");
            f.providers.release(third);f.providers.release(fourth);
        }
    }

    private static void lowRpmAndStrictestIntervals(Path root)throws Exception{
        try(Fixture f=new Fixture(root.resolve("credential-rpm"))){
            JsonObject a=f.provider("fast","quota-fake-shared","fast-group",2,60000);f.provider("slow","quota-fake-shared","slow-group",2,1);
            Providers.Permit first=f.take(a);f.providers.release(first);
            f.clock.advance(59999);check(f.providers.acquire(a)==null,"共享凭据采用 rpm=1，释放不清除频率等待");
            f.clock.wall+=TimeUnit.DAYS.toMillis(2);check(f.providers.acquire(a)==null,"系统挂钟向前跳不能绕过单调时钟频率");
            f.clock.advance(1);Providers.Permit next=f.take(a);f.providers.release(next);
        }
        try(Fixture f=new Fixture(root.resolve("manual-rpm"))){
            JsonObject a=f.provider("fast","quota-fake-a","shared",3,60000);f.provider("seven","quota-fake-b","shared",3,7);
            Providers.Permit first=f.take(a);f.providers.release(first);f.clock.advance(8571);
            check(f.providers.acquire(a)==null,"rpm=7 不能按整毫秒向下取整提前允许");
            f.clock.nanos.addAndGet(428571);check(f.providers.acquire(a)==null,"向上取整前一纳秒仍需等待");
            f.clock.nanos.incrementAndGet();Providers.Permit next=f.take(a);f.providers.release(next);
        }
        try(Fixture f=new Fixture(root.resolve("changed-rpm"))){
            JsonObject p=f.provider("changed","quota-fake-key",null,2,60000);Providers.Permit first=f.take(p);f.providers.release(first);f.clock.advance(1);
            f.providers.save(Json.obj("id",p.get("id"),"requestsPerMinute",1));
            check(f.providers.acquire(p)==null,"旧运行参数也受当前更严格配置限制，不沿用旧的高频截止时间");
            f.clock.advance(59999);Providers.Permit next=f.take(p);f.providers.release(next);
        }
    }

    private static void defaultIdentityAndNamespaces(Path root)throws Exception{
        try(Fixture f=new Fixture(root.resolve("defaults"))){
            JsonObject a=f.provider("no-key-a",null,null,1,60000),b=f.provider("no-key-b",null,null,1,60000);
            Providers.Permit first=f.take(a),second=f.take(b);check(first.group().equals(Json.required(a,"id")),"无凭据使用原 provider 身份");
            f.clock.advance(1);check(f.providers.acquire(a)==null,"同 provider 默认组不能重复占用");f.providers.release(first);f.providers.release(second);
            f.credential(a,"quota-fake-default");f.credential(b,"quota-fake-default");
            Providers.Permit credential=f.take(a);check(credential.group().equals(f.providers.group(b))&&credential.group().startsWith("credential-"),"未设手动组时旧凭据记账身份不变");
            f.clock.advance(1);check(f.providers.acquire(b)==null,"默认组共享同凭据限制");
            JsonObject manual=f.provider("manual-collision","quota-fake-other",credential.group(),1,60000);
            Providers.Permit separate=f.take(manual);check(separate.group().equals(credential.group()),"旧公开组名称允许重合");
            check(f.active(credential.group())==2,"手动名与凭据摘要同名不会误合并内部限额");
            f.providers.release(credential);f.providers.release(separate);
        }
    }

    private static void permitKeepsOriginalGatesAndReleasesOnce(Path root)throws Exception{
        try(Fixture f=new Fixture(root.resolve("changed-identity"));Fixture other=new Fixture(root.resolve("other-owner"))){
            JsonObject p=f.provider("mutable","quota-fake-old","group-old",1,60000),oldPeer=f.provider("old-peer","quota-fake-old",null,1,60000);
            JsonObject newPeer=f.provider("new-peer","quota-fake-new",null,1,60000);
            Providers.Permit original=f.take(p);f.credential(p,"quota-fake-new");
            JsonObject changed=f.providers.save(Json.obj("id",p.get("id"),"quotaGroupId","group-new"));Providers.Permit replacement=f.take(changed);
            f.clock.advance(1);check(f.providers.acquire(oldPeer)==null&&f.providers.acquire(newPeer)==null,"两组在途调用各自占用原凭据");
            f.providers.release(original);Providers.Permit old=f.take(oldPeer);
            f.providers.release(original);f.providers.release(null);other.providers.release(old);f.clock.advance(1);
            check(f.providers.acquire(oldPeer)==null,"重复或跨 owner 释放不能扣掉别人的占用");
            check(f.providers.acquire(newPeer)==null&&f.active("group-new")==1,"释放旧许可不能释放配置变更后的新门槛");
            check(f.active("group-old")==0,"旧记账组归零");
            f.providers.release(old);f.providers.release(replacement);Providers.Permit next=f.take(newPeer);f.providers.release(next);
        }
    }

    private static void capturedCredentialRemainsQuotaIdentity(Path root)throws Exception{
        try(Fixture f=new Fixture(root.resolve("captured-credential"))){
            JsonObject p=f.provider("captured","quota-fake-old","captured-group",2,60000),oldPeer=f.provider("old-peer","quota-fake-old","old-peer-group",1,60000);
            JsonObject newPeer=f.provider("new-peer","quota-fake-new","new-peer-group",1,60000);
            Providers.Credential captured=f.providers.credentialFor(p,new JsonObject());f.credential(p,"quota-fake-new");
            Providers.Permit held=f.providers.acquire(oldPeer);f.clock.advance(1);
            check(held!=null&&captured.bindingVersion==null&&f.providers.acquire(p,captured)==null,"旧版空绑定版本捕获的凭据仍受旧 Key 共享限额约束，不被新绑定替换");
            f.providers.release(held);f.clock.advance(1);Providers.Permit retained=f.providers.awaitPermit(p,captured);f.clock.advance(1);
            Providers.Permit current=f.providers.acquire(newPeer);
            check(retained!=null&&f.providers.acquire(oldPeer)==null&&current!=null,"等待取得的额度占用旧凭据，当前新凭据保持独立可用");
            f.providers.release(retained);f.providers.release(current);
        }
    }

    private static void concurrentCompetition(Path root)throws Exception{
        try(Fixture f=new Fixture(root.resolve("competition"))){
            List<JsonObject> configurations=new ArrayList<>();
            for(int index=0;index<4;index++)configurations.add(f.provider("racer-"+index,"quota-fake-race","race-group-"+index,index==0?2:5,60000));
            f.clock.step=TimeUnit.MILLISECONDS.toNanos(1);
            var pool=Executors.newFixedThreadPool(12);CountDownLatch ready=new CountDownLatch(12),start=new CountDownLatch(1);
            try{
                List<Future<Providers.Permit>> pending=new ArrayList<>();
                for(int index=0;index<12;index++){JsonObject configuration=configurations.get(index%configurations.size());pending.add(pool.submit(()->{ready.countDown();start.await();return f.providers.acquire(configuration);}));}
                check(ready.await(5,TimeUnit.SECONDS),"竞争线程均已就绪");start.countDown();List<Providers.Permit> accepted=new ArrayList<>();
                for(Future<Providers.Permit> result:pending){Providers.Permit permit=result.get(10,TimeUnit.SECONDS);if(permit!=null)accepted.add(permit);}
                check(accepted.size()==2,"并发竞争严格只允许最小并发数的两个许可");
                Providers.Permit repeated=accepted.getFirst();CountDownLatch releaseStart=new CountDownLatch(1);List<Future<?>> releases=new ArrayList<>();
                for(int index=0;index<12;index++)releases.add(pool.submit(()->{try{releaseStart.await();}catch(InterruptedException e){throw new RuntimeException(e);}f.providers.release(repeated);}));
                releaseStart.countDown();for(Future<?> release:releases)release.get(5,TimeUnit.SECONDS);
                int remaining=0;for(var entry:f.providers.limits().entrySet())remaining+=Json.integer(entry.getValue().getAsJsonObject(),"inFlight",0);
                check(remaining==1,"同一许可被竞争释放多次也只减少一次");
                Providers.Permit refill=f.take(configurations.getFirst());check(f.providers.acquire(configurations.getLast())==null,"释放一次仅腾出一个位置");
                f.providers.release(refill);f.providers.release(accepted.getLast());
            }finally{start.countDown();pool.shutdownNow();pool.awaitTermination(5,TimeUnit.SECONDS);}
        }
    }

    public static void main(String[] args)throws Exception{
        if(args.length!=1)throw new IllegalArgumentException("需要独立 .qa 测试目录");Path root=Path.of(args[0]).toAbsolutePath().normalize();
        Path qa=Path.of(".qa").toAbsolutePath().normalize();if(!root.startsWith(qa)||root.equals(qa))throw new IllegalArgumentException("测试目录必须位于仓库 .qa 内");
        Files.createDirectories(root);credentialCannotBeSplitByManualGroups(root);manualGroupAddsIndependentSharedLimit(root);crossingGatesAreAcquiredAtomically(root);
        lowRpmAndStrictestIntervals(root);defaultIdentityAndNamespaces(root);permitKeepsOriginalGatesAndReleasesOnce(root);capturedCredentialRemainsQuotaIdentity(root);concurrentCompetition(root);
        System.out.println("ProvidersQuotaTest: "+checks+" checks passed; no network");
    }
}
