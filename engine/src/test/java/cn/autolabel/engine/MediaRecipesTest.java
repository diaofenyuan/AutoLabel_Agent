package cn.autolabel.engine;

import com.google.gson.*;
import java.nio.file.*;
import java.sql.*;

/**
 * 抽帧配方（media.recipe.*）验收：内置推荐与用户配方的合并列出、同名更新、持久化、删除保护、
 * 参数边界拒绝，以及 schema 10 → 11 的加表迁移与迁移前备份。全部使用本地合成夹具，不依赖 FFmpeg。
 */
final class MediaRecipesTest {
    private MediaRecipesTest() {}

    static void run(Path root) throws Exception {
        listing(root.resolve("listing"));
        saveAndUpdate(root.resolve("update"));
        validation(root.resolve("validation"));
        persistence(root.resolve("persistence"));
        maintenance(root.resolve("maintenance"));
        migration(root.resolve("migration"));
    }

    // ===== 列出：内置推荐不入库，用户配方与内置一起返回 =====

    private static void listing(Path dir) throws Exception {
        try (Engine e = new Engine(dir.resolve("data"))) {
            JsonArray builtins = list(e);
            check(builtins.size() == 3, "内置推荐配方有三个");
            for (JsonElement element : builtins) {
                JsonObject item = element.getAsJsonObject();
                check(Json.bool(item, "builtin", false) && Json.required(item, "id").startsWith("builtin:"), "内置配方带 builtin 前缀标识");
                check(Json.number(item, "version", 0) == 1, "内置配方版本固定为 1");
            }
            check(e.store.read(c -> Store.one(c, "SELECT COUNT(*) AS n FROM media_recipes").get("n").getAsLong()) == 0L, "只列出内置时不写入配置表");

            JsonObject saved = EngineTest.command(e, "media.recipe.save", Json.obj("name", "园区夜间", "density", "custom", "customMode", "fps", "customValue", 3, "taskType", "detect", "classNames", Json.arr("人", "车", "人")));
            check(!Json.bool(saved, "builtin", true) && Json.number(saved, "version", 0) == 1, "保存后是非内置的第 1 版");
            check(Json.required(saved, "id").startsWith("recipe-"), "用户配方 id 与内置前缀区分开");
            check(Json.array(saved, "classNames").size() == 2, "类别集去重");
            check(list(e).size() == 4, "列表合并内置与用户配方");

            rejectsCode("media_recipe_invalid", () -> EngineTest.command(e, "media.recipe.list", Json.obj("kind", "image_screening")));
        }
    }

    // ===== 保存：同名视为更新，显式 id 走更新分支，内置 id 不可改 =====

    private static void saveAndUpdate(Path dir) throws Exception {
        try (Engine e = new Engine(dir.resolve("data"))) {
            JsonObject first = EngineTest.command(e, "media.recipe.save", Json.obj("name", "监控", "density", "sparse", "format", "jpg", "quality", 5));
            JsonObject second = EngineTest.command(e, "media.recipe.save", Json.obj("name", "监控", "density", "dense", "format", "png"));
            check(Json.required(first, "id").equals(Json.required(second, "id")), "同名保存更新同一条记录");
            check(Json.integer(second, "version", 0) == 2 && Json.required(second, "density").equals("dense"), "版本递增且内容被替换");
            check(Json.required(second, "createdAt").equals(Json.required(first, "createdAt")), "创建时间保持首次保存的值");
            check(list(e).size() == 4, "同名校验没有新增第二条");

            rejectsCode("media_recipe_version_conflict", () -> EngineTest.command(e, "media.recipe.save",
                Json.obj("id", Json.required(second, "id"), "baseVersion", 1, "name", "监控", "density", "dense")));
            JsonObject renamed = EngineTest.command(e, "media.recipe.save", Json.obj("id", Json.required(second, "id"), "baseVersion", 2, "name", "监控 · 白班", "density", "dense"));
            check(Json.required(renamed, "name").equals("监控 · 白班"), "带上正确版本可改名");
            check(list(e).size() == 4, "改名不改变配方数量");

            rejectsCode("media_recipe_builtin", () -> EngineTest.command(e, "media.recipe.save",
                Json.obj("id", "builtin:fixed-camera", "name", "改内置", "density", "dense")));
            rejectsCode("media_recipe_builtin", () -> EngineTest.command(e, "media.recipe.delete", Json.obj("recipeId", "builtin:fixed-camera")));
            rejectsCode("media_recipe_not_found", () -> EngineTest.command(e, "media.recipe.delete", Json.obj("recipeId", "recipe-missing")));

            JsonObject deleted = EngineTest.command(e, "media.recipe.delete", Json.obj("recipeId", Json.required(renamed, "id")));
            check(Json.bool(deleted, "deleted", false) && list(e).size() == 3, "删除用户配方后只剩内置");
        }
    }

    // ===== 参数边界：配方不能存下以后必然被抽帧拒绝的值 =====

    private static void validation(Path dir) throws Exception {
        try (Engine e = new Engine(dir.resolve("data"))) {
            rejectsCode("invalid_argument", () -> EngineTest.command(e, "media.recipe.save", Json.obj("name", "  ")));
            rejectsCode("media_recipe_invalid", () -> EngineTest.command(e, "media.recipe.save", Json.obj("name", "长".repeat(41))));
            rejectsCode("media_recipe_invalid", () -> EngineTest.command(e, "media.recipe.save", Json.obj("name", "档位", "density", "hourly")));
            rejectsCode("media_recipe_invalid", () -> EngineTest.command(e, "media.recipe.save", Json.obj("name", "方式", "customMode", "nth")));
            rejectsCode("media_recipe_invalid", () -> EngineTest.command(e, "media.recipe.save", Json.obj("name", "格式", "format", "webp")));
            rejectsCode("media_recipe_invalid", () -> EngineTest.command(e, "media.recipe.save", Json.obj("name", "适配", "fit", "cover")));
            rejectsCode("media_recipe_invalid", () -> EngineTest.command(e, "media.recipe.save", Json.obj("name", "间隔过小", "customMode", "interval", "customValue", 0.0001)));
            rejectsCode("media_recipe_invalid", () -> EngineTest.command(e, "media.recipe.save", Json.obj("name", "间隔过大", "customMode", "interval", "customValue", 604801)));
            rejectsCode("media_recipe_invalid", () -> EngineTest.command(e, "media.recipe.save", Json.obj("name", "源帧非整数", "customMode", "every_n", "customValue", 1.5)));
            rejectsCode("media_recipe_invalid", () -> EngineTest.command(e, "media.recipe.save", Json.obj("name", "帧率过高", "customMode", "fps", "customValue", 300)));
            rejectsCode("media_recipe_invalid", () -> EngineTest.command(e, "media.recipe.save", Json.obj("name", "宽度越界", "width", 20001)));
            rejectsCode("media_recipe_invalid", () -> EngineTest.command(e, "media.recipe.save", Json.obj("name", "像素过多", "resize", true, "width", 8000, "height", 6000)));
            rejectsCode("media_recipe_invalid", () -> EngineTest.command(e, "media.recipe.save", Json.obj("name", "质量越界", "quality", 40)));
            rejectsCode("media_recipe_invalid", () -> EngineTest.command(e, "media.recipe.save", Json.obj("name", "质量非整数", "quality", 3.5)));
            rejectsCode("media_recipe_invalid", () -> EngineTest.command(e, "media.recipe.save", Json.obj("name", "任务类型", "taskType", "unknown")));

            JsonObject saved = EngineTest.command(e, "media.recipe.save", Json.obj("name", "边界内", "density", "dense", "customMode", "every_n", "customValue", 1000000,
                "resize", true, "width", 8000, "height", 5000, "taskType", "segment", "quality", 31));
            check(Json.decimal(saved, "customValue", 0) == 1000000d && Json.integer(saved, "width", 0) == 8000, "边界值本身可保存");
            check(Json.str(saved, "taskType", "").equals("segment") && Json.array(saved, "classNames").isEmpty(), "任务类型可为空、类别集可为空");
            check(find(e, Json.required(saved, "id")) != null, "保存后的配方出现在列表里");
        }
    }

    // ===== 持久化：重开引擎后仍在，说明配方跟着数据目录走 =====

    private static void persistence(Path dir) throws Exception {
        Path data = dir.resolve("data");
        String id;
        try (Engine e = new Engine(data)) {
            id = Json.required(EngineTest.command(e, "media.recipe.save", Json.obj("name", "持久", "density", "sparse", "note", "跨会话复用")), "id");
        }
        try (Engine reopened = new Engine(data)) {
            JsonObject restored = find(reopened, id);
            if (restored == null) throw new AssertionError("重开后找不到已保存配方");
            check(Json.required(restored, "name").equals("持久") && Json.required(restored, "note").equals("跨会话复用"), "重开后内容一致");
        }
    }

    // ===== 维护期：配方可读，写入被锁住 =====

    private static void maintenance(Path dir) throws Exception {
        try (Engine e = new Engine(dir.resolve("data"))) {
            JsonObject owner = Json.obj("operationId", "recipe-maintenance-owner");
            check(Json.bool(EngineTest.command(e, "system.prepareDataMaintenance", owner), "ready", false), "空闲时可进入数据维护");
            check(list(e).size() == 3, "维护期间仍可读取配方");
            rejectsCode("engine_data_maintenance_locked", () -> EngineTest.command(e, "media.recipe.save", Json.obj("name", "维护期", "density", "dense")));
            EngineTest.command(e, "system.cancelDataMaintenance", owner);
        }
    }

    // ===== 迁移：schema10 的库升级后补出配发表，且迁移前先留一致性备份 =====

    private static void migration(Path dir) throws Exception {
        Path data = dir.resolve("data"), database = data.resolve("autolabel.db");
        try (Engine e = new Engine(data)) {
            check(list(e).size() == 3, "当前版本的库可读取内置配方");
        }
        // 退回 schema10 的形态：用普通连接删掉配发表并把 user_version 写回（与 FlowIntegrationTest 的降级夹具
        // 同一做法）。配发表在 v10 里并不存在，所以升级必须走「先一致性备份、再补表」这条既有路径。
        try (Connection c = DriverManager.getConnection("jdbc:sqlite:" + database); Statement statement = c.createStatement()) {
            statement.execute("DROP TABLE media_recipes");
            statement.execute("PRAGMA user_version=10");
        }
        try (Engine upgraded = new Engine(data)) {
            int version = upgraded.store.read(c -> Store.one(c, "PRAGMA user_version").get("user_version").getAsInt());
            check(version == Store.SCHEMA_VERSION, "旧库升级到当前 schema");
            check(upgraded.store.read(c -> Store.one(c, "SELECT name FROM sqlite_master WHERE type='table' AND name='media_recipes'").get("name").getAsString()).equals("media_recipes"), "迁移补出配发表");
            // 10 → 11 属加表迁移，仍然走同一条「先一致性备份、再改结构」的路径，不能因为只加表就跳过。
            try (var files = Files.list(data.resolve("backups"))) {
                check(files.anyMatch(path -> path.getFileName().toString().startsWith("schema-v10-")), "迁移前先写下一致性备份");
            }
            JsonObject saved = EngineTest.command(upgraded, "media.recipe.save", Json.obj("name", "迁移后", "density", "standard"));
            check(list(upgraded).size() == 4 && Json.number(saved, "version", 0) == 1, "迁移后的库可正常保存配方");
        }
    }

    // ===== 夹具与断言 =====

    private static JsonArray list(Engine e) throws Exception {
        return ((JsonElement) e.command("media.recipe.list", new JsonObject())).getAsJsonArray();
    }

    private static JsonObject find(Engine e, String id) throws Exception {
        for (JsonElement element : list(e)) {
            JsonObject item = element.getAsJsonObject();
            if (Json.str(item, "id", "").equals(id)) return item;
        }
        return null;
    }

    private static void check(boolean ok, String message) {
        EngineTest.check(ok, message);
    }

    private interface Action { void run() throws Exception; }

    private static void rejectsCode(String code, Action action) {
        try { action.run(); throw new AssertionError("Expected " + code); }
        catch (ApiError e) { check(e.code.equals(code), "Expected " + code + " got " + e.code); }
        catch (AssertionError e) { throw e; }
        catch (Exception e) { throw new AssertionError("Expected " + code + " got " + e); }
    }
}
