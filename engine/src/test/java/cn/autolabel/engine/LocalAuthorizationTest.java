package cn.autolabel.engine;

import com.google.gson.*;
import java.nio.file.*;

/**
 * 本地模型授权是跨层契约：桌面 LocalExecutionSettings 按 pathKey 持久化，引擎 LocalRuntime 按同口径核对。
 * 这里锁定两侧共享的判定规则——路径键按平台归一（Windows 折叠大小写，其他平台区分）、摘要必须精确匹配、
 * 非绝对路径的启动授权一律忽略。任一侧单方面改动都会让本地推理在某个平台上静默不可用。
 */
final class LocalAuthorizationTest {
    static void run(Path root)throws Exception{
        Files.createDirectories(root);
        Path model=root.resolve("Authorized.pt");Files.writeString(model,"authorized-bytes");
        String hash=Media.hash(model);
        boolean windows=System.getProperty("os.name","").startsWith("Windows");
        try(Engine engine=new Engine(root.resolve("data"),Json.obj("localModelAuthorizations",Json.arr(Json.obj("path",model.toString(),"modelHash",hash))))){
            EngineTest.check(engine.localRuntime.authorizationMatches(Json.obj("modelPath",model.toString(),"modelHash",hash)),"启动参数里的精确路径与摘要取得授权");
            // 只差大小写的路径在 Windows 上指向同一文件，在大小写敏感平台上是另一个文件。
            JsonObject otherCase=Json.obj("modelPath",root.resolve("authorized.pt").toString(),"modelHash",hash);
            EngineTest.check(engine.localRuntime.authorizationMatches(otherCase)==windows,"路径键按平台归一，与桌面持久化口径一致");
            EngineTest.check(!engine.localRuntime.authorizationMatches(Json.obj("modelPath",model.toString(),"modelHash","0".repeat(64))),"摘要不同不继承同一路径的授权");
        }
        // 相对路径会随工作目录解析到意料之外的文件，启动授权不能采纳。
        try(Engine engine=new Engine(root.resolve("relative"),Json.obj("localModelAuthorizations",Json.arr(Json.obj("path","relative.pt","modelHash",hash))))){
            EngineTest.check(!engine.localRuntime.authorizationMatches(Json.obj("modelPath",model.toString(),"modelHash",hash)),"非绝对路径授权被忽略");
        }
    }
}