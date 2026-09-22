package cn.autolabel.engine;

import com.google.gson.*;
import java.sql.Connection;
import java.util.*;

/**
 * 抽帧配方：把「同一类素材会反复做出的那组选择」固化成可命名、可复用的记录。
 *
 * 落在引擎库里而不是界面本地存储：配方是用户的长期资产，要跟着数据目录走 —— 换数据目录、迁移到新机器、
 * 从备份恢复之后都应当还在，界面本地存储做不到这些。
 *
 * 内置推荐配方只定义在代码里（id 前缀 {@code builtin:}），不写库：否则以后调整推荐值时，用户会同时看到
 * 「旧推荐」和「新推荐」两个同名项。参数范围取自 Media 的抽帧边界常量，与 VideoFrames.prepare 同源。
 *
 * 配方只记录与素材无关的选项：时间范围随每段视频变化，不进来；任务类型与类别集是「这条配方面向什么
 * 标注」，作为可空的意图信息记录，供界面提示与当前项目核对，不参与抽帧本身。
 */
final class MediaRecipes {
    static final String KIND = "video_extract";
    static final String BUILTIN_PREFIX = "builtin:";
    static final Set<String> DENSITIES = Set.of("scene", "dense", "standard", "sparse", "custom");
    static final Set<String> MODES = Set.of("interval", "every_n", "fps");
    static final Set<String> FORMATS = Set.of("png", "jpg");
    static final Set<String> FITS = Set.of("contain", "stretch");
    private static final int MAX_NAME = 40, MAX_NOTE = 200, MAX_CLASS_NAMES = 500, MAX_CLASS_NAME = 100;
    private final Store store;

    MediaRecipes(Store store) { this.store = store; }

    /** 内置推荐配方与用户保存的配方一起返回，界面一次读取即可列出全部可选配方。 */
    JsonArray list(JsonObject p) {
        String kind = kind(p);
        JsonArray result = builtins();
        for (JsonElement element : store.read(c -> Store.docs(c, "SELECT data FROM media_recipes WHERE kind=? ORDER BY name", kind)))
            result.add(element);
        return result;
    }

    JsonObject save(JsonObject p) {
        Providers.rejectSecrets(p);
        String kind = kind(p);
        String name = Json.required(p, "name").strip();
        if (name.length() > MAX_NAME) throw invalid("配方名称最多 " + MAX_NAME + " 个字符。");
        return store.tx(c -> commit(c, p, kind, name, normalize(p)));
    }

    JsonObject delete(JsonObject p) {
        String id = Json.required(p, "recipeId");
        if (id.startsWith(BUILTIN_PREFIX)) throw new ApiError(403, "media_recipe_builtin", "内置推荐配方不能删除。");
        return store.tx(c -> {
            JsonObject row = Store.one(c, "SELECT data FROM media_recipes WHERE id=?", id);
            if (row == null) throw notFound();
            JsonObject item = Json.parse(Json.required(row, "data"));
            Store.update(c, "DELETE FROM media_recipes WHERE id=?", id);
            Store.event(c, "media.recipe.deleted", null, null, null, Json.obj("recipeId", id, "name", item.get("name"), "version", item.get("version")));
            return Json.obj("recipeId", id, "deleted", true, "version", item.get("version"));
        });
    }

    /**
     * 内置推荐配方：覆盖计划里点名的三类素材，取值都落在默认与既有参数范围内。
     * 不设 taskType 与类别集 —— 推荐配方对任何标注任务都可用，绑死反而会误导用户。
     */
    static JsonArray builtins() {
        JsonArray result = new JsonArray();
        result.add(builtin("phone-portrait", "手机竖屏 · 手持", "dense", "interval", 1d, "png", 3, "手持晃动大，按 0.5 秒一帧取到足够密的帧。"));
        result.add(builtin("fixed-camera", "监控固定机位", "sparse", "interval", 1d, "jpg", 3, "固定机位画面变化慢，按 2 秒一帧并用 JPEG 控制体积。"));
        result.add(builtin("fast-motion", "高速运动 · 车辆与体育", "custom", "fps", 5d, "png", 3, "按目标帧率每秒钟取 5 帧，避免快速运动漏帧。"));
        return result;
    }

    private static JsonObject builtin(String id, String name, String density, String mode, double customValue, String format, int quality, String note) {
        return Json.obj("id", BUILTIN_PREFIX + id, "kind", KIND, "name", name, "builtin", true, "version", 1,
            "density", density, "customMode", mode, "customValue", customValue, "resize", false, "width", 640, "height", 640,
            "fit", "contain", "format", format, "quality", quality, "taskType", null, "classNames", new JsonArray(), "note", note);
    }

    /** 把任意来源的配方输入规整成一份完整记录：缺失字段取默认值，非法取值直接拒绝，不写半份配方。 */
    static JsonObject normalize(JsonObject raw) {
        String note = Json.str(raw, "note", "").strip();
        if (note.length() > MAX_NOTE) throw invalid("配方备注最多 " + MAX_NOTE + " 个字符。");
        JsonObject result = Json.obj("note", note);
        String density = Json.str(raw, "density", "standard");
        if (!DENSITIES.contains(density)) throw invalid("不支持的采样密度档位：" + density + "。");
        String mode = Json.str(raw, "customMode", "interval");
        if (!MODES.contains(mode)) throw invalid("不支持的采样方式：" + mode + "。");
        String format = Json.str(raw, "format", "png");
        if (!FORMATS.contains(format)) throw invalid("不支持的输出格式：" + format + "。");
        String fit = Json.str(raw, "fit", "contain");
        if (!FITS.contains(fit)) throw invalid("不支持的尺寸适配方式：" + fit + "。");
        // 采样值按声明的采样方式校验：即使当前档位不是「自定义」，也要保证存下来的值本身可用。
        double customValue = switch (mode) {
            case "every_n" -> requireInteger(bounded(raw, "customValue", 10d, Media.MIN_EVERY_N, Media.MAX_EVERY_N), "源帧间隔");
            case "fps" -> bounded(raw, "customValue", 1d, Media.MIN_TARGET_FPS, Media.MAX_TARGET_FPS);
            default -> bounded(raw, "customValue", 1d, Media.MIN_INTERVAL_SECONDS, Media.MAX_INTERVAL_SECONDS);
        };
        boolean resize = Json.bool(raw, "resize", false);
        int width = (int) requireInteger(bounded(raw, "width", 640d, 1, Media.MAX_DIMENSION), "输出宽度");
        int height = (int) requireInteger(bounded(raw, "height", 640d, 1, Media.MAX_DIMENSION), "输出高度");
        // 与 VideoFrames 的 dimensions() 同一口径：限制单边与总像素，避免存下必然被拒的尺寸。
        if (resize && (long) width * height > Media.MAX_PIXELS) throw invalid("输出尺寸超过 4000 万像素。");
        int quality = (int) requireInteger(bounded(raw, "quality", 3d, Media.MIN_JPEG_QUALITY, Media.MAX_JPEG_QUALITY), "JPEG 质量");
        String taskType = Json.str(raw, "taskType", null);
        if (taskType != null && !Annotations.TYPES.contains(taskType)) throw invalid("未知标注任务类型：" + taskType + "。");
        result.addProperty("density", density);
        result.addProperty("customMode", mode);
        result.addProperty("customValue", customValue);
        result.addProperty("resize", resize);
        result.addProperty("width", width);
        result.addProperty("height", height);
        result.addProperty("fit", fit);
        result.addProperty("format", format);
        result.addProperty("quality", quality);
        result.add("taskType", taskType == null ? JsonNull.INSTANCE : new JsonPrimitive(taskType));
        result.add("classNames", classNames(raw));
        return result;
    }

    /**
     * 类别集按名称记录，跨项目可移植：类别 id 是项目内的，换项目就对不上，名称才是用户认得的身份。
     * 去重且保持输入顺序，便于与项目当前类别逐项核对。
     */
    private static JsonArray classNames(JsonObject raw) {
        JsonArray source = Json.array(raw, "classNames");
        if (source.size() > MAX_CLASS_NAMES) throw invalid("类别集最多 " + MAX_CLASS_NAMES + " 项。");
        JsonArray result = new JsonArray();
        Set<String> seen = new LinkedHashSet<>();
        for (JsonElement element : source) {
            if (!element.isJsonPrimitive()) throw invalid("类别集的每一项都必须是类别名称。");
            String name = element.getAsString().strip();
            if (name.isEmpty()) continue;
            if (name.length() > MAX_CLASS_NAME) throw invalid("类别名称最多 " + MAX_CLASS_NAME + " 个字符。");
            seen.add(name);
        }
        for (String name : seen) result.add(name);
        return result;
    }

    private JsonObject commit(Connection c, JsonObject p, String kind, String name, JsonObject fields) throws Exception {
        String id = Json.str(p, "id", null);
        JsonObject old = null;
        if (id != null) {
            if (id.startsWith(BUILTIN_PREFIX)) throw new ApiError(403, "media_recipe_builtin", "内置推荐配方不能直接修改，请另存为自定义配方。");
            JsonObject row = Store.one(c, "SELECT data FROM media_recipes WHERE id=?", id);
            if (row == null) throw notFound();
            old = Json.parse(Json.required(row, "data"));
        } else {
            // 同名视为更新：反复保存不会攒出一串无法区分的同名配方。
            JsonObject row = Store.one(c, "SELECT id,data FROM media_recipes WHERE kind=? AND name=?", kind, name);
            if (row != null) { id = Json.required(row, "id"); old = Json.parse(Json.required(row, "data")); }
        }
        int current = old == null ? 0 : Json.integer(old, "version", 1);
        // 版本只在界面显式带上时校验：本地单窗口应用不需要为配方强加乐观锁，但陈旧界面不能悄悄覆盖新内容。
        if (old != null && p.has("baseVersion") && Json.number(p, "baseVersion", -1) != current) throw conflict();
        if (id == null) id = "recipe-" + Json.id();
        String now = Json.now();
        JsonObject result = fields.deepCopy();
        result.addProperty("id", id);
        result.addProperty("kind", kind);
        result.addProperty("name", name);
        result.addProperty("builtin", false);
        result.addProperty("version", current + 1);
        result.addProperty("createdAt", old == null ? now : Json.str(old, "createdAt", now));
        result.addProperty("updatedAt", now);
        Store.update(c, "INSERT INTO media_recipes(id,kind,name,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,name=excluded.name,data=excluded.data", id, kind, name, result);
        Store.event(c, "media.recipe.saved", null, null, null, Json.obj("recipeId", id, "name", name, "version", result.get("version")));
        return result;
    }

    private static String kind(JsonObject p) {
        String kind = Json.str(p, "kind", KIND);
        if (!KIND.equals(kind)) throw invalid("当前只支持抽帧配方：" + kind + "。");
        return kind;
    }

    private static double bounded(JsonObject o, String key, double fallback, double min, double max) {
        double value = o.has(key) && !o.get(key).isJsonNull() ? o.get(key).getAsDouble() : fallback;
        if (!Double.isFinite(value) || value < min || value > max) throw invalid(key + " 需在 " + min + "～" + max + " 之间。");
        return value;
    }

    private static double requireInteger(double value, String label) {
        if (value != Math.rint(value)) throw invalid(label + "必须是整数。");
        return value;
    }

    private static ApiError invalid(String message) { return new ApiError(400, "media_recipe_invalid", message); }
    private static ApiError notFound() { return new ApiError(404, "media_recipe_not_found", "配方不存在或已被删除。"); }
    private static ApiError conflict() { return new ApiError(409, "media_recipe_version_conflict", "配方已在别处更新，请重新载入后再保存。"); }
}
