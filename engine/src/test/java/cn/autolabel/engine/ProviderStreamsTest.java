package cn.autolabel.engine;

import com.google.gson.JsonObject;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/** 使用本地 SSE 夹具验证 Chat、Responses 的断片 UTF-8、usage 与完整终态。 */
final class ProviderStreamsTest {
    static int checks;
    static void check(boolean value, String message) { checks++; if (!value) throw new AssertionError(message); }

    public static void main(String[] args) throws Exception {
        List<String> chatFragments = new ArrayList<>();
        String chat = "data: {\"id\":\"c1\",\"model\":\"demo\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"你\"}}]}\n\n"
            + "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"好\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":1}}\n\n"
            + "data: [DONE]\n\n";
        JsonObject chatResult = new ProviderStreams("chat-completions", chatFragments::add).read(new BytewiseInput(chat.getBytes(StandardCharsets.UTF_8)));
        check(String.join("", chatFragments).equals("你好"), "Chat 增量保留断片 UTF-8 文本");
        check(chatResult.getAsJsonArray("choices").get(0).getAsJsonObject().getAsJsonObject("message").get("content").getAsString().equals("你好"), "Chat 终态合并完整文本");
        check(chatResult.getAsJsonObject("usage").get("completion_tokens").getAsInt() == 1, "Chat 终态保留 usage");

        List<String> responseFragments = new ArrayList<>();
        String responses = "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"流\"}\n\n"
            + "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"流式\"}]}],\"usage\":{\"input_tokens\":3,\"output_tokens\":2}}}\n\n";
        JsonObject responseResult = new ProviderStreams("responses", responseFragments::add).read(new BytewiseInput(responses.getBytes(StandardCharsets.UTF_8)));
        check(String.join("", responseFragments).equals("流"), "Responses 发布文本增量");
        check(responseResult.getAsJsonArray("output").get(0).getAsJsonObject().getAsJsonArray("content").get(0).getAsJsonObject().get("text").getAsString().equals("流式"), "Responses 终态采用完整 output");
        check(responseResult.getAsJsonObject("usage").get("output_tokens").getAsInt() == 2, "Responses 终态保留 usage");
        System.out.println("ProviderStreamsTest passed: " + checks + " checks; no network");
    }

    private static final class BytewiseInput extends ByteArrayInputStream {
        BytewiseInput(byte[] bytes) { super(bytes); }
        @Override public synchronized int read(byte[] buffer, int offset, int length) {
            return super.read(buffer, offset, Math.min(length, 1));
        }
    }
}
