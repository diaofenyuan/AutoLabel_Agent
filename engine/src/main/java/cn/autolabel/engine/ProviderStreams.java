package cn.autolabel.engine;

import com.google.gson.*;
import com.google.gson.stream.JsonReader;
import com.google.gson.stream.JsonToken;
import java.io.*;
import java.math.BigDecimal;
import java.nio.ByteBuffer;
import java.nio.charset.*;
import java.util.*;
import java.util.function.Consumer;

/** 只处理一次响应的协议；网络关闭、超时、重试和记账仍由请求所有者决定。 */
final class ProviderStreams {
    static final int MAX_BYTES = 8 * 1024 * 1024;
    static final int MAX_TOOLS = 128;
    private static final int MAX_DEPTH = 64;
    private static final int MAX_JSON_NODES = 100_000;
    private final boolean responses;
    private final Consumer<String> onText;
    private boolean used, firstLine = true, skipLf, hasData, sawChoice;
    private int bytes, eventBytes;
    private ByteArrayOutputStream line = new ByteArrayOutputStream();
    private StringBuilder data = new StringBuilder(), text = new StringBuilder(), refusal = new StringBuilder();
    private String event = "", finish;
    private JsonElement lastUsage = JsonNull.INSTANCE;
    private final JsonObject metadata = new JsonObject();
    private final TreeMap<Integer, Tool> tools = new TreeMap<>();

    static final class StreamError extends IOException {
        final String code;
        StreamError(String code, String message) { super(message); this.code = code; }
    }

    private static final class Tool {
        final StringBuilder id = new StringBuilder(), name = new StringBuilder(), arguments = new StringBuilder();
        boolean hasArguments;
    }

    ProviderStreams(String protocol, Consumer<String> onText) {
        if (!Set.of("chat-completions", "responses").contains(protocol)) throw new IllegalArgumentException("不支持的流式协议");
        this.responses = protocol.equals("responses");
        this.onText = onText == null ? ignored -> {} : onText;
    }

    JsonElement usage() { return lastUsage.deepCopy(); }

    JsonObject read(InputStream input) throws IOException {
        Objects.requireNonNull(input);
        if (used) throw new IllegalStateException("每个读取器只能接收一次响应");
        used = true;
        byte[] buffer = new byte[8192];
        try {
            while (true) {
                if (Thread.currentThread().isInterrupted()) throw new InterruptedIOException("流式响应读取已中断");
                int count = input.read(buffer);
                if (count < 0) throw failure("provider_stream_incomplete", "接口流提前结束，尚未收到完整终态；远端结果未知。");
                for (int index = 0; index < count; index++) {
                    if (++bytes > MAX_BYTES) throw limit();
                    int value = buffer[index] & 255;
                    if (skipLf) {
                        skipLf = false;
                        if (value == '\n') continue;
                    }
                    if (value == '\n' || value == '\r') {
                        skipLf = value == '\r';
                        JsonObject completed = acceptLine();
                        if (completed != null) return completed;
                    } else {
                        if (line.size() >= MAX_BYTES) throw limit();
                        line.write(value);
                    }
                }
            }
        } finally {
            // 只保留 usage 供失败记账，不把原始事件或大文本缓存在已结束的读取器中。
            line = null; data = null; text = null; refusal = null; tools.clear(); metadata.keySet().clear();
        }
    }

    private JsonObject acceptLine() throws IOException {
        String value;
        try {
            value = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(line.toByteArray())).toString();
        } catch (CharacterCodingException invalid) {
            throw failure("provider_stream_invalid", "接口流包含无效 UTF-8 文本。");
        }
        line = new ByteArrayOutputStream();
        if (firstLine) { firstLine = false; if (value.startsWith("\uFEFF")) value = value.substring(1); }
        if (value.isEmpty()) {
            String body = data.toString(), kind = event;
            boolean present = hasData;
            data = new StringBuilder(); event = ""; hasData = false; eventBytes = 0;
            return present ? acceptEvent(kind, body) : null;
        }
        if (value.charAt(0) == ':') return null;
        int colon = value.indexOf(':');
        String key = colon < 0 ? value : value.substring(0, colon);
        String content = colon < 0 ? "" : value.substring(colon + 1);
        if (content.startsWith(" ")) content = content.substring(1);
        if (key.equals("event")) event = content;
        if (key.equals("data")) {
            int size = content.getBytes(StandardCharsets.UTF_8).length + (hasData ? 1 : 0);
            if ((long) eventBytes + size > MAX_BYTES) throw limit();
            eventBytes += size;
            if (hasData) data.append('\n');
            data.append(content); hasData = true;
        }
        return null;
    }

    private JsonObject acceptEvent(String kind, String body) throws IOException {
        if (!responses && body.equals("[DONE]")) return finishChat();
        if (body.equals("[DONE]")) throw failure("provider_stream_incomplete", "Responses 流缺少 response.completed 终态。");
        JsonObject value = object(parse(body), "接口事件必须为 JSON 对象。");
        captureUsage(value);
        if (value.has("response") && value.get("response").isJsonObject()) captureUsage(value.getAsJsonObject("response"));
        if (kind.equals("error") || (value.has("error") && !value.get("error").isJsonNull()))
            throw failure("provider_stream_error", "接口流返回错误，未生成完整响应。");
        return responses ? acceptResponse(kind, value) : acceptChat(value);
    }

    private void captureUsage(JsonObject value) throws StreamError {
        JsonElement usage = value.get("usage");
        if (usage == null || usage.isJsonNull()) return;
        if (!usage.isJsonObject()) throw failure("provider_stream_invalid", "接口 usage 结构无效。");
        lastUsage = usage;
    }

    private JsonObject acceptChat(JsonObject value) throws IOException {
        for (String key : List.of("id", "model")) {
            if (!value.has(key) || value.get(key).isJsonNull()) continue;
            String field = string(value.get(key), "接口响应标识无效。");
            if (metadata.has(key) && !metadata.get(key).getAsString().equals(field))
                throw failure("provider_stream_invalid", "同一接口流中的响应标识发生变化。");
            metadata.addProperty(key, field);
        }
        if (value.has("created") && !metadata.has("created")) metadata.add("created", value.get("created"));
        JsonArray choices = array(value.get("choices"), "Chat 流缺少 choices 数组。");
        boolean found = false;
        for (JsonElement element : choices) {
            JsonObject choice = object(element, "Chat 流的 choice 结构无效。");
            int index = integer(choice.get("index"), Integer.MAX_VALUE, "Chat 流的 choice 序号无效。");
            if (index != 0) continue;
            if (found || finish != null) throw failure("provider_stream_invalid", "Chat 流在 choice 终态之后继续返回内容或重复终态。");
            found = true; sawChoice = true;
            JsonObject delta = object(choice.get("delta"), "Chat 流缺少 delta 对象。");
            if (delta.has("role") && !delta.get("role").isJsonNull() && !string(delta.get("role"), "角色格式无效。").equals("assistant"))
                throw failure("provider_stream_invalid", "Chat 流返回了非 assistant 角色。");
            if (delta.has("function_call")) throw failure("provider_stream_invalid", "接口使用了未支持的旧工具增量格式。");
            if (delta.has("content") && !delta.get("content").isJsonNull()) {
                String fragment = string(delta.get("content"), "Chat 文本增量必须为字符串。");
                text.append(fragment);
                if (!fragment.isEmpty()) onText.accept(fragment);
            }
            if (delta.has("refusal") && !delta.get("refusal").isJsonNull()) refusal.append(string(delta.get("refusal"), "拒绝文本增量无效。"));
            if (delta.has("tool_calls") && !delta.get("tool_calls").isJsonNull()) acceptTools(array(delta.get("tool_calls"), "工具增量必须为数组。"));
            JsonElement reason = choice.get("finish_reason");
            if (reason != null && !reason.isJsonNull()) {
                finish = string(reason, "Chat 终态原因无效。");
                if (!Set.of("stop", "tool_calls", "length", "content_filter").contains(finish))
                    throw failure("provider_incomplete", "接口返回了未支持的终态，不能视为完整响应。");
            }
        }
        return null;
    }

    private void acceptTools(JsonArray fragments) throws StreamError {
        Set<Integer> seen = new HashSet<>();
        for (JsonElement element : fragments) {
            JsonObject value = object(element, "工具增量结构无效。");
            int index = integer(value.get("index"), MAX_TOOLS - 1, "工具序号无效或超过 128 个工具的上限。");
            if (!seen.add(index)) throw failure("provider_stream_invalid", "同一事件重复返回了工具序号。");
            Tool tool = tools.computeIfAbsent(index, ignored -> new Tool());
            if (value.has("type") && !value.get("type").isJsonNull() && !string(value.get("type"), "工具类型无效。").equals("function"))
                throw failure("provider_stream_invalid", "接口流返回了未支持的工具类型。");
            append(tool.id, value.get("id"), "工具 ID 增量无效。");
            if (value.has("function") && !value.get("function").isJsonNull()) {
                JsonObject function = object(value.get("function"), "工具函数增量结构无效。");
                append(tool.name, function.get("name"), "工具名称增量无效。");
                JsonElement arguments = function.get("arguments");
                if (arguments != null && !arguments.isJsonNull()) {
                    tool.arguments.append(string(arguments, "工具参数增量必须为字符串。"));
                    tool.hasArguments = true;
                }
            }
            if (tool.id.length() > 100_000 || tool.name.length() > 100_000)
                throw failure("provider_stream_invalid", "工具标识或名称超过允许长度。");
        }
    }

    private JsonObject finishChat() throws IOException {
        if (!sawChoice || finish == null) throw failure("provider_stream_incomplete", "Chat 流缺少 choice 的完成原因；不能采用未完成工具。");
        if (Set.of("length", "content_filter").contains(finish)) throw failure("provider_incomplete", "模型响应被截断或过滤。");
        if (finish.equals("tool_calls") != !tools.isEmpty()) throw failure("provider_tool_incomplete", "工具数量与接口完成原因不一致。");
        JsonArray calls = new JsonArray();
        Set<String> ids = new HashSet<>();
        int index = 0;
        for (var entry : tools.entrySet()) {
            Tool tool = entry.getValue();
            if (entry.getKey() != index++ || !tool.hasArguments) throw failure("provider_tool_incomplete", "工具增量不完整，不能生成工具调用。");
            String id = completeField(tool.id.toString()), name = completeField(tool.name.toString());
            if (!ids.add(id)) throw failure("provider_tool_incomplete", "接口返回了重复工具 ID。");
            validateArguments(tool.arguments.toString());
            calls.add(Json.obj("id", id, "type", "function", "function", Json.obj("name", name, "arguments", tool.arguments.toString())));
        }
        JsonObject message = Json.obj("role", "assistant", "content", text.toString());
        if (!calls.isEmpty()) message.add("tool_calls", calls);
        if (!refusal.isEmpty()) message.addProperty("refusal", refusal.toString());
        JsonObject raw = metadata.deepCopy();
        raw.addProperty("object", "chat.completion");
        raw.add("choices", Json.arr(Json.obj("index", 0, "message", message, "finish_reason", finish)));
        raw.add("usage", usage());
        return raw;
    }

    private JsonObject acceptResponse(String eventKind, JsonObject value) throws IOException {
        String type = value.has("type") ? string(value.get("type"), "Responses 事件类型无效。") : eventKind;
        if (type.isEmpty() || (!eventKind.isEmpty() && !eventKind.equals("message") && !eventKind.equals(type)))
            throw failure("provider_stream_invalid", "Responses 事件类型缺失或与 SSE 事件名不一致。");
        if (Set.of("error", "response.error", "response.failed", "response.incomplete").contains(type))
            throw failure(type.equals("response.incomplete") ? "provider_incomplete" : "provider_stream_error", "接口未完成响应或返回失败终态。");
        if (type.equals("response.output_text.delta")) {
            String fragment = string(value.get("delta"), "Responses 文本增量必须为字符串。");
            if (!fragment.isEmpty()) onText.accept(fragment);
        }
        if (!type.equals("response.completed")) return null;
        JsonObject response = object(value.get("response"), "Responses 完成事件缺少完整 response。");
        if (!"completed".equals(string(response.get("status"), "Responses 完成状态无效。"))
                || nonNull(response, "error") || nonNull(response, "incomplete_details"))
            throw failure("provider_incomplete", "Responses 完成事件仍包含未完成状态或错误。");
        JsonArray output = array(response.get("output"), "Responses 完成事件缺少完整 output 数组。");
        int count = 0;
        Set<String> ids = new HashSet<>();
        for (JsonElement element : output) {
            JsonObject item = object(element, "Responses 输出项结构无效。");
            String itemType = string(item.get("type"), "Responses 输出项类型无效。");
            if (nonNull(item, "status") && !"completed".equals(string(item.get("status"), "Responses 输出项状态无效。")))
                throw failure("provider_incomplete", "Responses 含有未完成的输出项。");
            if (itemType.equals("function_call")) {
                if (++count > MAX_TOOLS) throw failure("provider_stream_limit", "单次响应不能超过 128 个工具。");
                String id = completeField(string(item.get("call_id"), "完整工具缺少 call_id。"));
                completeField(string(item.get("name"), "完整工具缺少名称。"));
                if (!ids.add(id)) throw failure("provider_tool_incomplete", "接口返回了重复工具 ID。");
                validateArguments(string(item.get("arguments"), "完整工具缺少参数。"));
            }
            if (item.has("content")) for (JsonElement part : array(item.get("content"), "Responses 消息内容必须为数组。")) {
                JsonObject content = object(part, "Responses 消息内容项无效。");
                if ("output_text".equals(string(content.get("type"), "Responses 内容类型无效。")))
                    string(content.get("text"), "Responses 完整文本必须为字符串。");
            }
        }
        // delta 只负责显示，最终文本、工具参数及其他输出以已完成 response 为准。
        return response;
    }

    private static boolean nonNull(JsonObject value, String key) { return value.has(key) && !value.get(key).isJsonNull(); }

    private static void append(StringBuilder target, JsonElement value, String message) throws StreamError {
        if (value != null && !value.isJsonNull()) target.append(string(value, message));
    }

    private static String completeField(String value) throws StreamError {
        if (value.isBlank() || value.length() > 100_000) throw failure("provider_tool_incomplete", "工具标识或名称缺失、无效或超过长度限制。");
        return value;
    }

    private static void validateArguments(String value) throws IOException {
        try {
            if (!parse(value).isJsonObject()) throw failure("provider_tool_incomplete", "工具参数必须为完整 JSON 对象。");
        } catch (StreamError invalid) {
            throw failure("provider_tool_incomplete", "工具参数不是完整的有效 JSON 对象，不能执行部分工具。");
        }
    }

    private static String string(JsonElement value, String message) throws StreamError {
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()) throw failure("provider_stream_invalid", message);
        return value.getAsString();
    }

    private static JsonObject object(JsonElement value, String message) throws StreamError {
        if (value == null || !value.isJsonObject()) throw failure("provider_stream_invalid", message);
        return value.getAsJsonObject();
    }

    private static JsonArray array(JsonElement value, String message) throws StreamError {
        if (value == null || !value.isJsonArray()) throw failure("provider_stream_invalid", message);
        return value.getAsJsonArray();
    }

    private static int integer(JsonElement value, int max, String message) throws StreamError {
        try {
            if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isNumber()) throw new ArithmeticException();
            int number = value.getAsBigDecimal().intValueExact();
            if (number < 0 || number > max) throw new ArithmeticException();
            return number;
        } catch (NumberFormatException | ArithmeticException invalid) { throw failure("provider_stream_invalid", message); }
    }

    private static JsonElement parse(String value) throws IOException {
        try (JsonReader reader = new JsonReader(new StringReader(value))) {
            reader.setLenient(false);
            JsonElement result = readJson(reader, 0, new int[] { 0 });
            if (reader.peek() != JsonToken.END_DOCUMENT) throw failure("provider_stream_invalid", "JSON 后存在额外内容。");
            return result;
        } catch (StreamError error) { throw error; }
        catch (IOException | IllegalStateException | NumberFormatException invalid) {
            throw failure("provider_stream_invalid", "接口流包含无效 JSON。");
        }
    }

    private static JsonElement readJson(JsonReader reader, int depth, int[] nodes) throws IOException {
        if (depth > MAX_DEPTH || ++nodes[0] > MAX_JSON_NODES) throw failure("provider_stream_limit", "接口 JSON 结构超过深度或节点上限。");
        return switch (reader.peek()) {
            case BEGIN_OBJECT -> {
                JsonObject object = new JsonObject(); reader.beginObject();
                while (reader.hasNext()) {
                    String key = reader.nextName();
                    if (object.has(key)) throw failure("provider_stream_invalid", "接口 JSON 包含重复字段。");
                    object.add(key, readJson(reader, depth + 1, nodes));
                }
                reader.endObject(); yield object;
            }
            case BEGIN_ARRAY -> {
                JsonArray array = new JsonArray(); reader.beginArray();
                while (reader.hasNext()) array.add(readJson(reader, depth + 1, nodes));
                reader.endArray(); yield array;
            }
            case STRING -> new JsonPrimitive(reader.nextString());
            case NUMBER -> {
                String raw = reader.nextString();
                if (raw.length() > 128) throw failure("provider_stream_limit", "接口数值长度超过上限。");
                BigDecimal number = new BigDecimal(raw);
                if (!Double.isFinite(number.doubleValue())) throw failure("provider_stream_invalid", "接口 JSON 包含非有限数字。");
                yield new JsonPrimitive(number);
            }
            case BOOLEAN -> new JsonPrimitive(reader.nextBoolean());
            case NULL -> { reader.nextNull(); yield JsonNull.INSTANCE; }
            default -> throw failure("provider_stream_invalid", "接口 JSON 结构不完整。");
        };
    }

    private static StreamError limit() { return failure("response_too_large", "接口流累计超过 8 MiB，已停止接收与解析。"); }
    private static StreamError failure(String code, String message) { return new StreamError(code, message); }
}
