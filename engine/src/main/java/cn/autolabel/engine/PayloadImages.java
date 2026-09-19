package cn.autolabel.engine;

import com.google.gson.*;
import javax.imageio.*;
import javax.imageio.plugins.jpeg.JPEGImageWriteParam;
import javax.imageio.stream.ImageInputStream;
import javax.imageio.stream.ImageOutputStream;
import java.awt.*;
import java.awt.image.BufferedImage;
import java.io.IOException;
import java.nio.file.*;
import java.util.Iterator;
import java.util.Locale;

/**
 * 发送副本：把基准图裁成「只标注这块区域」并按长边缩放后再发给模型。
 *
 * 两个动机都来自实测，不是拍脑袋：
 * - 4K 竖屏帧里的小目标（桌上的手办）整图发给视觉模型时框会偏松；裁到目标所在区域后目标相对变大，框更贴。
 * - 同一张 4K PNG 有 3 MB 以上，实测某个接口在 3.4 MB 上跑了十几分钟仍失败，缩到 0.16 MB 后正常返回。
 *
 * 无论怎么变，**坐标基准必须说清楚**：发给模型的 target 尺寸写的是副本的真实像素尺寸，
 * 模型按副本坐标返回，再由 {@link #mapBack} 逆映射回基准图坐标后才进校验。
 * 副本按「基准图内容哈希 + 配方」缓存，重复运行不重复编码。
 */
final class PayloadImages {
    static final String VERSION = "payload-v1";
    private static final int MAX_EDGE_LIMIT = 8192;
    private static final int MIN_EDGE = 64;
    private static final int QUALITY_MIN = 40, QUALITY_MAX = 100;
    private static final long MAX_SOURCE_PIXELS = 40_000_000L;
    /** 区域最小边长（相对值）：过小的区域会把目标切掉，直接拒绝而不是猜。 */
    private static final double MIN_REGION_SPAN = 0.02;

    private PayloadImages() {}

    /** 区域用相对基准图的 0～1 比例表示：与显示尺寸、归一化结果解耦，界面按画布比例给值。 */
    record Region(double left, double top, double right, double bottom) {}
    record Recipe(Integer maxEdge, int quality, Region region) {
        static Recipe none() { return new Recipe(null, 92, null); }
        boolean identity() { return maxEdge == null && region == null; }
        String fingerprint() {
            return (maxEdge == null ? "edge-full" : "edge-" + maxEdge) + "-q" + quality + "-"
                + (region == null ? "region-full" : String.format(Locale.ROOT, "region-%.4f_%.4f_%.4f_%.4f", region.left(), region.top(), region.right(), region.bottom()));
        }
    }
    /** 一次请求要用的副本：尺寸、相对基准图的偏移与缩放，以及它是不是派生出来的。 */
    record Payload(Path path, int width, int height, int sourceWidth, int sourceHeight, double offsetX, double offsetY, double scale, boolean derived) {
        double backX(double value) { return offsetX + value / scale; }
        double backY(double value) { return offsetY + value / scale; }
        long bytes() throws IOException { return Files.size(path); }
    }

    /** 读取运行里冻结的配方。缺省为空配方（原图直发），保证既有运行行为不变。 */
    static Recipe recipe(JsonObject run) {
        JsonElement raw = run.get("payload");
        if (raw == null || !raw.isJsonObject()) return Recipe.none();
        JsonObject value = raw.getAsJsonObject();
        Integer maxEdge = value.has("maxEdge") && !value.get("maxEdge").isJsonNull() ? Json.integer(value, "maxEdge", 0) : null;
        int quality = value.has("quality") && !value.get("quality").isJsonNull() ? Json.integer(value, "quality", 92) : 92;
        Region region = null;
        if (value.has("region") && value.get("region").isJsonObject()) {
            JsonObject item = value.getAsJsonObject("region");
            region = new Region(Json.decimal(item, "left", 0), Json.decimal(item, "top", 0), Json.decimal(item, "right", 1), Json.decimal(item, "bottom", 1));
        }
        return validate(new Recipe(maxEdge, quality, region));
    }

    /** 创建运行时就校验配方：越界或退化区域在提交阶段报错，而不是等跑到一半才发现。 */
    static Recipe validate(Recipe recipe) {
        if (recipe.maxEdge() != null && (recipe.maxEdge() < MIN_EDGE || recipe.maxEdge() > MAX_EDGE_LIMIT))
            throw new ApiError(400, "payload_max_edge_invalid", "发送副本的长边应在 " + MIN_EDGE + "～" + MAX_EDGE_LIMIT + " 像素之间。");
        if (recipe.quality() < QUALITY_MIN || recipe.quality() > QUALITY_MAX)
            throw new ApiError(400, "payload_quality_invalid", "发送副本的 JPEG 质量应在 " + QUALITY_MIN + "～" + QUALITY_MAX + " 之间。");
        Region region = recipe.region();
        if (region != null) {
            if (region.left() < 0 || region.top() < 0 || region.right() > 1 || region.bottom() > 1)
                throw new ApiError(400, "payload_region_out_of_bounds", "标注区域必须落在图片范围内（相对比例 0～1）。");
            if (region.right() - region.left() < MIN_REGION_SPAN || region.bottom() - region.top() < MIN_REGION_SPAN)
                throw new ApiError(400, "payload_region_too_small", "标注区域太小，请放大到画面的 " + Math.round(MIN_REGION_SPAN * 100) + "% 以上。");
        }
        return recipe;
    }

    /** 校验并规范化创建运行时的配方：只保留白名单字段，越界在提交阶段就报错。 */
    static JsonObject freeze(JsonObject raw) {
        Integer maxEdge = raw.has("maxEdge") && !raw.get("maxEdge").isJsonNull() ? Json.integer(raw, "maxEdge", 0) : null;
        int quality = raw.has("quality") && !raw.get("quality").isJsonNull() ? Json.integer(raw, "quality", 92) : 92;
        Region region = null;
        if (raw.has("region") && !raw.get("region").isJsonNull()) {
            JsonObject item = Json.object(raw, "region");
            region = new Region(Json.decimal(item, "left", 0), Json.decimal(item, "top", 0), Json.decimal(item, "right", 1), Json.decimal(item, "bottom", 1));
        }
        Recipe recipe = validate(new Recipe(maxEdge, quality, region));
        JsonObject frozen = Json.obj("version", VERSION, "quality", recipe.quality());
        frozen.add("maxEdge", recipe.maxEdge() == null ? JsonNull.INSTANCE : new JsonPrimitive(recipe.maxEdge()));
        frozen.add("region", recipe.region() == null ? JsonNull.INSTANCE : Json.obj("left", recipe.region().left(), "top", recipe.region().top(),
            "right", recipe.region().right(), "bottom", recipe.region().bottom()));
        return frozen;
    }

    /** 记进调用尝试的事实：实发尺寸与体积、原始尺寸与体积，供任务详情核对「到底发出去了什么」。 */
    static JsonObject facts(Payload payload, long sourceBytes) throws Exception {
        return Json.obj("version", VERSION, "derived", payload.derived(), "width", payload.width(), "height", payload.height(),
            "sourceWidth", payload.sourceWidth(), "sourceHeight", payload.sourceHeight(), "bytes", payload.bytes(), "sourceBytes", sourceBytes);
    }

    /** 只读图片头拿尺寸：4K 图整解码一次不便宜，缓存命中时不该为它付出代价。 */
    private static int[] dimensions(Path path) throws IOException {
        try (ImageInputStream stream = ImageIO.createImageInputStream(path.toFile())) {
            if (stream == null) return null;
            Iterator<ImageReader> readers = ImageIO.getImageReaders(stream);
            if (!readers.hasNext()) return null;
            ImageReader reader = readers.next();
            try { reader.setInput(stream); return new int[]{reader.getWidth(0), reader.getHeight(0)}; }
            finally { reader.dispose(); }
        }
    }

    static Payload prepare(Path source, Recipe recipe, Path cacheRoot) throws Exception {
        int[] size = dimensions(source);
        if (size == null) throw new ApiError(422, "payload_image_unreadable", "基准图片无法解码，不能生成发送副本。");
        int sourceWidth = size[0], sourceHeight = size[1];
        if ((long) sourceWidth * sourceHeight > MAX_SOURCE_PIXELS)
            throw new ApiError(422, "payload_image_too_large", "基准图片像素过多，不能生成发送副本。");
        if (recipe.identity()) return new Payload(source, sourceWidth, sourceHeight, sourceWidth, sourceHeight, 0, 0, 1, false);

        int cropX = 0, cropY = 0, cropWidth = sourceWidth, cropHeight = sourceHeight;
        Region region = recipe.region();
        if (region != null) {
            cropX = (int) Math.floor(region.left() * sourceWidth);
            cropY = (int) Math.floor(region.top() * sourceHeight);
            cropWidth = Math.max(1, (int) Math.round((region.right() - region.left()) * sourceWidth));
            cropHeight = Math.max(1, (int) Math.round((region.bottom() - region.top()) * sourceHeight));
            cropX = Math.max(0, Math.min(cropX, sourceWidth - 1));
            cropY = Math.max(0, Math.min(cropY, sourceHeight - 1));
            cropWidth = Math.min(cropWidth, sourceWidth - cropX);
            cropHeight = Math.min(cropHeight, sourceHeight - cropY);
        }
        double scale = 1;
        if (recipe.maxEdge() != null) scale = Math.min(1, recipe.maxEdge() / (double) Math.max(cropWidth, cropHeight));
        int width = Math.max(1, (int) Math.round(cropWidth * scale)), height = Math.max(1, (int) Math.round(cropHeight * scale));

        Files.createDirectories(cacheRoot);
        Path cached = cacheRoot.resolve(Media.hash(source) + "-" + recipe.fingerprint() + ".jpg");
        if (Files.exists(cached)) return new Payload(cached, width, height, sourceWidth, sourceHeight, cropX, cropY, scale, true);

        BufferedImage decoded = ImageIO.read(source.toFile());
        if (decoded == null) throw new ApiError(422, "payload_image_unreadable", "基准图片无法解码，不能生成发送副本。");
        BufferedImage target = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
        Graphics2D graphics = target.createGraphics();
        try {
            // JPEG 没有透明通道：先铺白底，避免带 alpha 的素材裁出来发黑。
            graphics.setColor(Color.WHITE); graphics.fillRect(0, 0, width, height);
            graphics.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
            graphics.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
            graphics.drawImage(decoded, 0, 0, width, height, cropX, cropY, cropX + cropWidth, cropY + cropHeight, null);
        } finally { graphics.dispose(); }
        Path temporary = Files.createTempFile(cacheRoot, "payload-", ".tmp");
        try {
            writeJpeg(target, temporary, recipe.quality());
            try { Files.move(temporary, cached, StandardCopyOption.ATOMIC_MOVE); }
            catch (AtomicMoveNotSupportedException ignored) { Files.move(temporary, cached, StandardCopyOption.REPLACE_EXISTING); }
        } finally { Files.deleteIfExists(temporary); }
        return new Payload(cached, width, height, sourceWidth, sourceHeight, cropX, cropY, scale, true);
    }

    private static void writeJpeg(BufferedImage image, Path target, int quality) throws IOException {
        ImageWriter writer = ImageIO.getImageWritersByFormatName("jpeg").next();
        try (ImageOutputStream stream = ImageIO.createImageOutputStream(target.toFile())) {
            writer.setOutput(stream);
            JPEGImageWriteParam parameters = new JPEGImageWriteParam(Locale.ROOT);
            parameters.setCompressionMode(ImageWriteParam.MODE_EXPLICIT);
            parameters.setCompressionQuality(quality / 100f);
            writer.write(null, new IIOImage(image, null, null), parameters);
        } finally { writer.dispose(); }
    }

    /**
     * 把模型按副本坐标返回的标注逆映射回基准图坐标。
     * 只做换算，不做截断：映射后越界交给既有的几何校验报错，不静默改数。
     */
    static JsonArray mapBack(JsonArray annotations, Payload payload) {
        if (!payload.derived()) return annotations;
        JsonArray result = new JsonArray();
        for (JsonElement entry : annotations) {
            JsonObject annotation = entry.getAsJsonObject().deepCopy();
            if (annotation.has("bbox") && annotation.get("bbox").isJsonObject()) {
                JsonObject bbox = annotation.getAsJsonObject("bbox");
                bbox.addProperty("x", payload.backX(Json.decimal(bbox, "x", 0)));
                bbox.addProperty("y", payload.backY(Json.decimal(bbox, "y", 0)));
                bbox.addProperty("width", Json.decimal(bbox, "width", 0) / payload.scale());
                bbox.addProperty("height", Json.decimal(bbox, "height", 0) / payload.scale());
            }
            if (annotation.has("points") && annotation.get("points").isJsonArray())
                for (JsonElement point : annotation.getAsJsonArray("points")) mapPoint(point.getAsJsonObject(), payload);
            if (annotation.has("keypoints") && annotation.get("keypoints").isJsonArray())
                for (JsonElement point : annotation.getAsJsonArray("keypoints")) mapPoint(point.getAsJsonObject(), payload);
            result.add(annotation);
        }
        return result;
    }

    private static void mapPoint(JsonObject point, Payload payload) {
        if (!point.has("x") || !point.has("y")) return;
        point.addProperty("x", payload.backX(Json.decimal(point, "x", 0)));
        point.addProperty("y", payload.backY(Json.decimal(point, "y", 0)));
    }
}
