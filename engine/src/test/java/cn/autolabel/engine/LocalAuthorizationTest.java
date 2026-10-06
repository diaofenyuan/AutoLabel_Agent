package cn.autolabel.engine;

import com.google.gson.*;
import java.nio.file.*;

/**
 * 本地模型执行授权的跨层契约验收：桌面下发的启动参数 localModelAuthorizations（真实路径 + 实测摘要）
 * 与运行期 local.model.authorize 必须按同一路径身份生效；未授权、摘要不符或非绝对路径的条目都不能取得执行权限。
 *
 * 只使用本地合成夹具：授权闸门位于「本地组件与环境是否配置」之前，因此不依赖真实 Python/worker，
 * 就能把「授权拒绝」和「环境缺失」两种情况区分开，避免授权回归被环境问题掩盖。
 */
final class LocalAuthorizationTest {
    private LocalAuthorizationTest() {}

    static void run(Path root) throws Exception {
        Path data = root.resolve("data"), models = root.resolve("models");
        Files.createDirectories(models);
        Path model = models.resolve("auth-fixture.pt");
        Files.writeString(model, "engine-authorization-fixture");
        String modelHash = Media.hash(model);
        boolean windows = System.getProperty("os.name", "").startsWith("Windows");
        try (Engine direct = new Engine(root.resolve("direct"), Json.obj("localModelAuthorizations", Json.arr(Json.obj("path", model.toString(), "modelHash", modelHash))))) {
            check(direct.localRuntime.authorizationMatches(Json.obj("modelPath", model.toString(), "modelHash", modelHash)), "启动参数里的精确路径与摘要取得授权");
            check(direct.localRuntime.authorizationMatches(Json.obj("modelPath", model.getParent().resolve("AUTH-FIXTURE.PT").toString(), "modelHash", modelHash)) == windows, "路径键按平台归一，与桌面持久化口径一致");
            check(!direct.localRuntime.authorizationMatches(Json.obj("modelPath", model.toString(), "modelHash", "0".repeat(64))), "摘要不同不继承同一路径的授权");
        }
        try (Engine relative = new Engine(root.resolve("relative"), Json.obj("localModelAuthorizations", Json.arr(Json.obj("path", "relative.pt", "modelHash", modelHash))))) {
            check(!relative.localRuntime.authorizationMatches(Json.obj("modelPath", model.toString(), "modelHash", modelHash)), "非绝对路径授权被忽略");
        }

        try (Engine e = new Engine(data)) {
            JsonObject registered = EngineTest.command(e, "local.model.register",
                Json.obj("name", "授权夹具", "taskType", "detect", "modelPath", model.toString()));
            String modelId = Json.required(registered, "id");
            int version = Json.integer(registered, "version", 0);
            check(Json.required(registered, "modelHash").equals(modelHash), "登记按文件实测摘要记录模型身份");

            // 未授权：在「本地组件缺失」之前就以授权拒绝，说明授权是独立的一道闸门。
            rejects("local_model_authorization_required", () -> EngineTest.command(e, "local.model.load",
                Json.obj("modelId", modelId, "modelVersion", version, "device", "cpu")));
            // 摘要不符的授权必须被拒，不能把「用户选过这个路径」当成对任意版本的放行。
            rejects("local_model_changed", () -> EngineTest.command(e, "local.model.authorize",
                Json.obj("path", model.toString(), "modelHash", "0".repeat(64))));
            EngineTest.command(e, "local.model.authorize", Json.obj("path", model.toString(), "modelHash", modelHash));
            // 授权通过后失败原因应转为环境缺失，而不是继续指向授权。
            rejects("local_worker_missing", () -> EngineTest.command(e, "local.model.load",
                Json.obj("modelId", modelId, "modelVersion", version, "device", "cpu")));
        }

        // 重启：桌面把已授权模型并入启动参数，引擎无需再次 authorize 即可放行到环境检查。
        JsonArray authorized = Json.arr(Json.obj("path", model.toString(), "modelHash", modelHash));
        try (Engine e = new Engine(data, Json.obj("localModelAuthorizations", authorized))) {
            rejects("local_worker_missing", () -> EngineTest.command(e, "local.model.load", loadPayload(e)));
        }

        // 无效条目（坏摘要、相对路径）与缺失条目同效：都不能取得授权。
        JsonArray invalid = Json.arr(Json.obj("path", model.toString(), "modelHash", "not-a-hash"),
            Json.obj("path", "relative.pt", "modelHash", modelHash));
        try (Engine e = new Engine(data, Json.obj("localModelAuthorizations", invalid))) {
            rejects("local_model_authorization_required", () -> EngineTest.command(e, "local.model.load", loadPayload(e)));
        }
    }

    /** 只有一个已登记模型时，直接从清单取身份，避免用常量把 id/version 写死。 */
    private static JsonObject loadPayload(Engine e) throws Exception {
        JsonObject listed = EngineTest.command(e, "local.model.list", Json.obj("limit", 10));
        JsonObject item = Json.array(listed, "items").get(0).getAsJsonObject();
        return Json.obj("modelId", Json.required(item, "id"), "modelVersion", Json.integer(item, "version", 0), "device", "cpu");
    }

    // ===== 夹具与断言 =====

    private interface Action { void run() throws Exception; }

    /** 与 EngineTest.error 同语义，但允许被测命令抛出受检异常。 */
    private static void rejects(String code, Action action) {
        try { action.run(); throw new AssertionError("Expected " + code); }
        catch (ApiError e) { check(e.code.equals(code), "Expected " + code + " got " + e.code); }
        catch (AssertionError e) { throw e; }
        catch (Exception e) { throw new AssertionError("Expected " + code + " got " + e); }
    }

    private static void check(boolean ok, String message) {
        EngineTest.check(ok, message);
    }
}
