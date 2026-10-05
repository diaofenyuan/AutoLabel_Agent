package cn.autolabel.engine;

import javax.imageio.*;
import javax.imageio.stream.ImageInputStream;
import javax.imageio.stream.MemoryCacheImageOutputStream;
import java.awt.*;
import java.awt.image.BufferedImage;
import java.io.*;
import java.nio.file.*;
import java.util.Iterator;
import java.util.concurrent.Semaphore;

/**
 * 网格缩略图：长边 256 的 JPEG 缓存，按基准图内容哈希定址。
 *
 * 以前网格直接加载全尺寸归一化 PNG（几 MB 一张），滚动一次就是几十兆流量；缩略图是可重建缓存
 * （备份排除表里的 thumbnail-cache 就是它），删掉整个目录也能从基准图原样重建，不进任何清单。
 *
 * 解码按需降采样：ImageIO.read 会把整张原图（12MP 约 48MB）解进堆里，而媒体信号量允许 64 个
 * 请求同时进来（引擎没设 -Xmx，堆上限是物理内存的四分之一），一屏懒生成就可能把堆吃光——
 * OutOfMemoryError 会被 Main 的 Throwable 兜底成 500 internal_error。这里先用 ImageReader 读尺寸，
 * 再按整数倍降采样解码，单次解码的峰值内存只与缩略图尺寸有关，与原图大小无关。
 */
final class Thumbnails {
    static final int LONG_EDGE = 256;
    /** 解码目标长边：给最终缩放留一倍余量，同时把解码尺寸压到原图的一个零头。 */
    private static final int DECODE_EDGE = LONG_EDGE * 2;
    /** 同时解码的图片数量上限，兜住不支持降采样的解码器（第三方格式插件）。 */
    private static final Semaphore DECODES = new Semaphore(4);

    private Thumbnails() {}

    /** 缓存文件名只取哈希前 16 位、且只保留十六进制字符：异常来源的哈希不能把路径带出缓存目录。 */
    static String cacheKey(String contentHash) {
        String hash = contentHash == null ? "" : contentHash.strip();
        if (hash.isEmpty()) throw new ApiError(422, "media_invalid", "基准图片缺少内容哈希，无法生成缩略图。");
        StringBuilder key = new StringBuilder(Math.min(16, hash.length()));
        for (int index = 0; index < hash.length() && key.length() < 16; index += 1) {
            char character = hash.charAt(index);
            key.append(Character.digit(character, 16) >= 0 ? character : '_');
        }
        return key.toString();
    }

    /** 整数降采样倍数：长边不超过两倍目标尺寸时按原样解码（1）。 */
    static int subsampleStep(int width, int height) {
        int longest = Math.max(width, height);
        if (longest <= DECODE_EDGE) return 1;
        return (longest + DECODE_EDGE - 1) / DECODE_EDGE;
    }

    static Path file(Path dataRoot, Path source, String contentHash) throws IOException {
        Path directory = Files.createDirectories(dataRoot.resolve("thumbnail-cache"));
        Path cached = directory.resolve(cacheKey(contentHash) + ".jpg");
        if (Files.isRegularFile(cached)) return cached;
        BufferedImage image = decode(source);
        try {
            int width = image.getWidth(), height = image.getHeight();
            double scale = (double) LONG_EDGE / Math.max(width, height);
            int w = scale >= 1 ? width : Math.max(1, (int) Math.round(width * scale));
            int h = scale >= 1 ? height : Math.max(1, (int) Math.round(height * scale));
            BufferedImage tiny = new BufferedImage(w, h, BufferedImage.TYPE_INT_RGB);
            Graphics2D graphics = tiny.createGraphics();
            try { graphics.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR); graphics.drawImage(image, 0, 0, w, h, null); } finally { graphics.dispose(); }
            // 并发请求可能同时为同一张图生成缩略图，临时文件必须独立；最终缓存仍由先完成者写入。
            Path temporary = Files.createTempFile(directory, cached.getFileName() + ".", ".tmp");
            try {
                try (OutputStream out = Files.newOutputStream(temporary, StandardOpenOption.WRITE, StandardOpenOption.TRUNCATE_EXISTING); MemoryCacheImageOutputStream buffer = new MemoryCacheImageOutputStream(out)) {
                    ImageWriter writer = ImageIO.getImageWritersByFormatName("jpeg").next();
                    try { writer.setOutput(buffer); ImageWriteParam settings = writer.getDefaultWriteParam(); settings.setCompressionMode(ImageWriteParam.MODE_EXPLICIT); settings.setCompressionQuality(0.8f); writer.write(null, new IIOImage(tiny, null, null), settings); buffer.flush(); } finally { writer.dispose(); }
                }
                try { Files.move(temporary, cached); } catch (FileAlreadyExistsException concurrent) { /* 并发生成时保留先到的那份 */ }
            } finally { Files.deleteIfExists(temporary); }
            tiny.flush();
            return cached;
        } finally { image.flush(); }
    }

    /** 先读尺寸再按倍数降采样解码；解码并发有上限，异常图片与「没有可用解码器」都按 422 报告。 */
    private static BufferedImage decode(Path source) throws IOException {
        acquire();
        try (ImageInputStream stream = ImageIO.createImageInputStream(source.toFile())) {
            if (stream == null) throw undecodable();
            Iterator<ImageReader> readers = ImageIO.getImageReaders(stream);
            if (!readers.hasNext()) throw undecodable();
            ImageReader reader = readers.next();
            try {
                // 只读第一帧、只向前读：解码器不必为了寻址把整段数据留在内存里。
                reader.setInput(stream, true, true);
                int width = reader.getWidth(0), height = reader.getHeight(0);
                if (width <= 0 || height <= 0) throw undecodable();
                ImageReadParam parameters = reader.getDefaultReadParam();
                int step = subsampleStep(width, height);
                if (step > 1) parameters.setSourceSubsampling(step, step, 0, 0);
                BufferedImage image = reader.read(0, parameters);
                if (image == null) throw undecodable();
                return image;
            } finally { reader.dispose(); }
        } finally { DECODES.release(); }
    }

    private static ApiError undecodable() { return new ApiError(422, "media_invalid", "基准图片不能解码，无法生成缩略图。"); }

    private static void acquire() throws IOException {
        try { DECODES.acquire(); }
        catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); throw new IOException("缩略图生成被中断。", interrupted); }
    }
}
