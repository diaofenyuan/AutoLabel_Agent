package cn.autolabel.engine;

import javax.imageio.*;
import javax.imageio.stream.MemoryCacheImageOutputStream;
import java.awt.*;
import java.awt.image.BufferedImage;
import java.io.*;
import java.nio.file.*;

/**
 * 网格缩略图：长边 256 的 JPEG 缓存，按基准图内容哈希定址。
 *
 * 以前网格直接加载全尺寸归一化 PNG（几 MB 一张），滚动一次就是几十兆流量；缩略图是可重建缓存
 * （备份排除表里的 thumbnail-cache 就是它），删掉整个目录也能从基准图原样重建，不进任何清单。
 */
final class Thumbnails {
    static final int LONG_EDGE = 256;

    private Thumbnails() {}

    static Path file(Path dataRoot, Path source, String contentHash) throws IOException {
        Path directory = Files.createDirectories(dataRoot.resolve("thumbnail-cache"));
        Path cached = directory.resolve(contentHash.substring(0, 16) + ".jpg");
        if (Files.isRegularFile(cached)) return cached;
        BufferedImage image = ImageIO.read(source.toFile());
        if (image == null) throw new ApiError(422, "media_invalid", "基准图片不能解码，无法生成缩略图。");
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
}
