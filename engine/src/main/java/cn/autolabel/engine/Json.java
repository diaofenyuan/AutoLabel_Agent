package cn.autolabel.engine;

import com.google.gson.*;
import java.time.Instant;
import java.util.UUID;

final class Json {
    static final Gson GSON = new GsonBuilder().disableHtmlEscaping().serializeNulls().create();
    static JsonObject obj(Object... pairs) {
        JsonObject result = new JsonObject();
        for (int i = 0; i < pairs.length; i += 2) result.add((String)pairs[i], element(pairs[i + 1]));
        return result;
    }
    static JsonElement element(Object value) { return value instanceof JsonElement e ? e : GSON.toJsonTree(value); }
    static JsonArray arr(Object... values) { JsonArray a = new JsonArray(); for (Object v : values) a.add(element(v)); return a; }
    static JsonObject parse(String s) { return JsonParser.parseString(s).getAsJsonObject(); }
    static String str(JsonObject o, String key, String fallback) { return o.has(key) && !o.get(key).isJsonNull() ? o.get(key).getAsString() : fallback; }
    static String required(JsonObject o, String key) {
        String value = str(o,key,"").strip();
        if (value.isEmpty() || value.length() > 100_000) throw new ApiError(400,"invalid_argument","缺少或无效的字段：" + key);
        return value;
    }
    static int integer(JsonObject o, String key, int fallback) { return o.has(key) && !o.get(key).isJsonNull() ? o.get(key).getAsInt() : fallback; }
    static long number(JsonObject o, String key, long fallback) { return o.has(key) && !o.get(key).isJsonNull() ? o.get(key).getAsLong() : fallback; }
    static double decimal(JsonObject o, String key, double fallback) { return o.has(key) && !o.get(key).isJsonNull() ? o.get(key).getAsDouble() : fallback; }
    static boolean bool(JsonObject o, String key, boolean fallback) { return o.has(key) && !o.get(key).isJsonNull() ? o.get(key).getAsBoolean() : fallback; }
    static JsonArray array(JsonObject o, String key) { return o.has(key) && o.get(key).isJsonArray() ? o.getAsJsonArray(key) : new JsonArray(); }
    static JsonObject object(JsonObject o, String key) { return o.has(key) && o.get(key).isJsonObject() ? o.getAsJsonObject(key) : new JsonObject(); }
    static int bounded(JsonObject o, String key, int fallback, int min, int max) {
        int value = integer(o,key,fallback);
        if (value < min || value > max) throw new ApiError(400,"invalid_argument",key + " 超出允许范围 " + min + "～" + max);
        return value;
    }
    static String id() { return UUID.randomUUID().toString(); }
    static String now() { return Instant.now().toString(); }
}
