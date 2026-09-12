package cn.autolabel.engine;

import com.google.gson.*;
import com.google.gson.stream.JsonWriter;
import javax.imageio.*;
import javax.imageio.event.IIOWriteProgressListener;
import javax.imageio.stream.*;
import java.awt.image.BufferedImage;
import java.io.*;
import java.math.BigDecimal;
import java.nio.channels.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.*;
import java.util.*;
import java.util.stream.Stream;

/** 基准 PNG 的有界、可取消生成器；只发布完整图片，不修改项目或运行记录。 */
final class TransformedImages {
    static final String PIXEL_VERSION = "srgb-pixel-centers-bilinear-v1";
    static final long ENCODING_RESERVE = 16L * 1024 * 1024, DISK_MARGIN = 128L * 1024 * 1024;
    private static final String MANIFEST_KIND = "autolabel-transformed-images-v1";
    private static final byte[] PNG_SIGNATURE = {(byte)137, 80, 78, 71, 13, 10, 26, 10};

    record RenderOptions(String background, long maxResidentBytes) {
        RenderOptions {
            if (background == null || !background.matches("#[0-9a-fA-F]{6}") || maxResidentBytes <= 0)
                throw error(422, "transform_options_invalid", "背景颜色或内存限制无效。");
            background = background.toUpperCase(Locale.ROOT);
        }
    }
    record Estimate(long peakResidentBytes, long bufferPeakBytes, long encodingReserveBytes,
                    long planReserveBytes, long perViewOutputUpperBytes, long totalOutputUpperBytes, int viewCount) {}
    record Generated(Path imagePath, JsonObject inputSnapshot, boolean reusedFile) {}
    interface Control {
        default boolean cancelled() { return false; }
        default boolean paused() { return false; }
        // 只能进一步收紧实际磁盘余量，不能用测试或调度预算替代真实文件系统检查。
        default long availableBytesLimit(Path directory) { return Long.MAX_VALUE; }
        default void progress(String phase, String viewId, long completed, long total) {}
    }

    static Estimate inspect(JsonObject plan, RenderOptions options) {
        return estimate(TransformGeometry.readPlan(plan).json(), options);
    }
    static Session open(Path baselinePng, JsonObject plan, Path generationDirectory, RenderOptions options, Control control) throws IOException {
        JsonObject fixed = TransformGeometry.readPlan(plan).json(); Estimate estimate = estimate(fixed, options);
        Session session = new Session(fixed, options, estimate, control == null ? new Control() {} : control);
        try { session.open(baselinePng, generationDirectory); return session; }
        catch (IOException | RuntimeException | Error failure) {
            try { session.close(); } catch (IOException cleanup) { failure.addSuppressed(cleanup); }
            throw failure;
        }
    }

    static final class Session implements AutoCloseable {
        private final JsonObject plan, baseline, policy;
        private final RenderOptions options;
        private final Estimate estimate;
        private final Control control;
        private final String planHash, recipeHash;
        private final Map<String, JsonObject> views = new LinkedHashMap<>();
        private final JsonArray operations, steps;
        private Path directory, work, viewsDirectory;
        private FileChannel lockChannel;
        private FileLock lock;
        private BufferedImage prefix;
        private int tileIndex = -1;
        private boolean createdDirectory, closed, rendering;
        private String lastProgressPhase, lastProgressView;
        private long lastProgressAt;

        private Session(JsonObject plan, RenderOptions options, Estimate estimate, Control control) {
            this.plan = plan; this.baseline = Json.object(plan, "baseline"); this.options = options;
            this.estimate = estimate; this.control = control; policy = policy(options);
            planHash = digest(plan); recipeHash = digest(Json.obj("planHash", planHash, "renderPolicy", policy));
            operations = Json.array(plan, "operations"); steps = Json.array(plan, "steps");
            for (JsonElement value : Json.array(plan, "views")) {
                JsonObject view = value.getAsJsonObject(); views.put(Json.required(view, "viewId"), view);
            }
            for (int i = 0; i < operations.size(); i++) if (Json.required(operations.get(i).getAsJsonObject(), "kind").equals("tile")) tileIndex = i;
        }
        Estimate estimate() { return estimate; }

        private void open(Path source, Path requestedDirectory) throws IOException {
            if (!Media.NORMALIZATION_VERSION.equals(Json.required(baseline, "normalizationVersion")))
                throw error(422, "baseline_contract_unsupported", "当前基准图归正规则不受此像素生成版本支持。");
            Path target = requestedDirectory.toAbsolutePath().normalize();
            if (target.getParent() == null) throw error(422, "transform_directory_invalid", "请提供专属生成目录。");
            Path parent = target.getParent().toRealPath(); target = parent.resolve(target.getFileName());
            if (Files.exists(target, LinkOption.NOFOLLOW_LINKS)) {
                if (!Files.isDirectory(target, LinkOption.NOFOLLOW_LINKS) || Files.isSymbolicLink(target))
                    throw error(422, "transform_directory_invalid", "生成目录不能是链接或普通文件。");
            } else { Files.createDirectory(target); createdDirectory = true; }
            directory = target.toRealPath();
            if (!directory.equals(target)) throw error(422, "transform_directory_invalid", "生成目录实际位置发生变化。");
            Path lockPath = owned(".session.lock"); rejectLink(lockPath);
            lockChannel = FileChannel.open(lockPath, StandardOpenOption.CREATE, StandardOpenOption.WRITE);
            try { lock = lockChannel.tryLock(); }
            catch (OverlappingFileLockException busy) { throw error(409, "transform_session_busy", "该生成目录正在被使用。"); }
            if (lock == null) throw error(409, "transform_session_busy", "该生成目录正在被使用。");
            checkpoint("preparing_generation", null, 0, 1); requireSpace(estimate.planReserveBytes);
            JsonObject expected = Json.obj("kind", MANIFEST_KIND, "planHash", planHash, "recipeHash", recipeHash,
                "pixelTransformVersion", PIXEL_VERSION, "renderPolicy", policy, "baselineAssetId", baseline.get("assetId"),
                "baselineContentHash", baseline.get("contentHash"), "plan", plan);
            Path manifest = owned("generation.json");
            if (Files.exists(manifest, LinkOption.NOFOLLOW_LINKS)) {
                if (!readJson(manifest, 32L * 1024 * 1024).equals(expected))
                    throw error(409, "transform_generation_mismatch", "目录已有不同的计划、基准图或像素策略，不能复用或覆盖。");
            } else {
                if (!createdDirectory) throw error(409, "transform_generation_unrecognized", "现有目录没有有效生成清单，不能接管。");
                writeJsonAtomic(manifest, expected);
            }
            viewsDirectory = owned("views");
            if (!Files.exists(viewsDirectory, LinkOption.NOFOLLOW_LINKS)) Files.createDirectory(viewsDirectory);
            checkedDirectory(viewsDirectory);
            cleanAbandoned(directory, ".work-"); cleanAbandoned(viewsDirectory, ".partial-");
            work = owned(".work-" + UUID.randomUUID()); Files.createDirectory(work);
            Path copied = work.resolve("baseline.png");
            checkpoint("copying_baseline", null, 0, 1);
            if (!Files.isRegularFile(source, LinkOption.NOFOLLOW_LINKS)) throw error(422, "baseline_missing", "固定基准图片不存在或不是普通文件。");
            long sourceSize = Files.size(source);
            if (sourceSize < 33 || sourceSize > Media.MAX_FILE) throw error(422, "baseline_size_invalid", "固定基准图片大小不符合媒体限制。");
            requireSpace(sourceSize);
            MessageDigest checksum = sha256(); long copiedBytes = 0;
            try (InputStream input = Files.newInputStream(source); OutputStream output = Files.newOutputStream(copied, StandardOpenOption.CREATE_NEW)) {
                byte[] buffer = new byte[65536]; int count;
                while ((count = input.read(buffer)) != -1) {
                    copiedBytes = Math.addExact(copiedBytes, count);
                    if (copiedBytes > Media.MAX_FILE) throw error(422, "baseline_size_invalid", "复制期间基准图片大小超过限制。");
                    checkpoint("copying_baseline", null, copiedBytes, sourceSize); requireSpace(Math.max(0, sourceSize - copiedBytes));
                    checksum.update(buffer, 0, count); output.write(buffer, 0, count);
                }
            }
            if (!HexFormat.of().formatHex(checksum.digest()).equalsIgnoreCase(Json.required(baseline, "contentHash")))
                throw error(409, "baseline_content_changed", "实际基准图内容与固定计划不一致。");
            requirePng(copied, Json.integer(baseline, "width", 0), Json.integer(baseline, "height", 0));
            checkpoint("decoding_baseline", null, 0, 1);
            BufferedImage decoded;
            try (FileImageInputStream input = new FileImageInputStream(copied.toFile())) {
                Iterator<ImageReader> readers = ImageIO.getImageReaders(input);
                if (!readers.hasNext()) throw error(422, "baseline_decode_failed", "基准 PNG 无法解码。");
                ImageReader reader = readers.next();
                try { reader.setInput(input, true, true); decoded = reader.read(0); } finally { reader.dispose(); }
            }
            if (decoded == null || decoded.getColorModel().hasAlpha() || !decoded.getColorModel().getColorSpace().isCS_sRGB()) {
                if (decoded != null) decoded.flush();
                throw error(422, "baseline_not_normalized", "基准图片必须是不透明 sRGB 图像，不能在此重复归正。");
            }
            prefix = decoded;
            if (decoded.getType() != BufferedImage.TYPE_INT_RGB) {
                BufferedImage converted = null;
                try { converted = copy(decoded, 0, 0, decoded.getWidth(), decoded.getHeight(), null, "decoding_baseline"); }
                finally { decoded.flush(); }
                prefix = converted;
            }
            int prefixEnd = tileIndex < 0 ? operations.size() : tileIndex;
            for (int i = 0; i < prefixEnd; i++) {
                BufferedImage next = apply(prefix, i, null);
                prefix.flush(); prefix = next;
            }
            checkpoint("prefix_ready", null, prefixEnd, prefixEnd);
        }

        synchronized Generated render(String viewId) throws IOException {
            if (closed) throw error(409, "transform_session_closed", "图像生成会话已经关闭。");
            if (rendering) throw error(409, "transform_session_busy", "当前会话正在生成另一视图。");
            JsonObject view = views.get(viewId);
            if (view == null) throw error(422, "transform_view_invalid", "所选视图不属于固定计划。");
            rendering = true; Path partial = null; BufferedImage image = null; boolean ownImage = false; Throwable primaryFailure = null;
            try {
                checkpoint("view_start", viewId, 0, 1); checkedDirectory(viewsDirectory);
                Path target = child(viewsDirectory, viewId);
                if (Files.exists(target, LinkOption.NOFOLLOW_LINKS)) {
                    Generated cached = readPublished(target, view);
                    reportCommitted("view_reused", viewId); return cached;
                }
                requireSpace(estimate.perViewOutputUpperBytes);
                if (tileIndex < 0) image = prefix;
                else {
                    JsonObject tile = Json.object(view, "tile");
                    image = copy(prefix, Json.integer(tile, "x", -1), Json.integer(tile, "y", -1),
                        Json.integer(tile, "width", 0), Json.integer(tile, "height", 0), viewId, "cropping_tile"); ownImage = true;
                    for (int i = tileIndex + 1; i < operations.size(); i++) {
                        BufferedImage next = apply(image, i, viewId); image.flush(); image = next;
                    }
                }
                if (image.getWidth() != Json.integer(view, "width", 0) || image.getHeight() != Json.integer(view, "height", 0))
                    throw error(500, "transform_dimensions_mismatch", "生成图片尺寸与几何视图不一致。");
                partial = child(viewsDirectory, ".partial-" + UUID.randomUUID()); Files.createDirectory(partial);
                Path png = partial.resolve("input.png"); writePng(image, png, viewId);
                force(png); requirePng(png, image.getWidth(), image.getHeight());
                String hash = hash(png, viewId, "hashing_output"); long size = Files.size(png);
                JsonObject snapshot = snapshot(view, hash, size);
                Path metadata = partial.resolve("input.json"); writeJson(metadata, snapshot); force(metadata);
                checkpoint("before_publish", viewId, 1, 1); requireSpace(0); checkedDirectory(viewsDirectory); checkedDirectory(partial);
                Files.move(partial, target, StandardCopyOption.ATOMIC_MOVE);
                // 原子发布就是完成点；之后的取消或观察者异常不能将已交付文件改写为失败。
                partial = null;
                Generated result = new Generated(target.resolve("input.png"), snapshot.deepCopy(), false);
                reportCommitted("published", viewId); return result;
            } catch (IOException | RuntimeException | Error failure) {
                primaryFailure = failure; throw failure;
            } finally {
                if (ownImage && image != null) image.flush();
                try { if (partial != null) deleteOwned(partial); }
                catch (IOException cleanup) { if (primaryFailure != null) primaryFailure.addSuppressed(cleanup); else throw cleanup; }
                finally { rendering = false; }
            }
        }

        private Generated readPublished(Path target, JsonObject view) throws IOException {
            checkedDirectory(target);
            Path image = child(target, "input.png"), metadata = child(target, "input.json");
            JsonObject saved = readJson(metadata, 1024 * 1024);
            requirePng(image, Json.integer(view, "width", 0), Json.integer(view, "height", 0));
            String hash = hash(image, Json.required(view, "viewId"), "checking_existing");
            JsonObject expected = snapshot(view, hash, Files.size(image));
            if (!saved.equals(expected)) throw error(409, "transform_view_conflict", "已有 PNG 或输入清单与固定视图不一致，不能复用或覆盖。");
            return new Generated(image, expected, true);
        }
        private JsonObject snapshot(JsonObject view, String hash, long size) {
            return Json.obj("kind", "derived_image", "baselineAssetId", baseline.get("assetId"), "baselineContentHash", baseline.get("contentHash"),
                "planHash", planHash, "recipeHash", recipeHash, "viewId", view.get("viewId"), "inputTransform", view.deepCopy(),
                "pixelTransformVersion", PIXEL_VERSION, "renderPolicy", policy.deepCopy(), "width", view.get("width"), "height", view.get("height"),
                "colorSpace", "sRGB", "contentHash", hash, "fileSize", size);
        }
        private BufferedImage apply(BufferedImage input, int stepIndex, String viewId) throws IOException {
            JsonObject op = operations.get(stepIndex).getAsJsonObject(), step = steps.get(stepIndex).getAsJsonObject();
            if (input.getWidth() != Json.integer(step, "inputWidth", 0) || input.getHeight() != Json.integer(step, "inputHeight", 0))
                throw error(500, "transform_dimensions_mismatch", "像素步骤输入尺寸与计划不一致。");
            return switch (Json.required(op, "kind")) {
                case "crop" -> copy(input, Json.integer(op, "x", 0), Json.integer(op, "y", 0), Json.integer(op, "width", 0), Json.integer(op, "height", 0), viewId, "cropping");
                case "resize" -> resize(input, step, viewId);
                default -> throw error(422, "transform_step_invalid", "当前像素步骤不受支持。");
            };
        }
        private BufferedImage copy(BufferedImage input, int x, int y, int width, int height, String viewId, String phase) throws IOException {
            checkpoint(phase, viewId, 0, height); BufferedImage output = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
            try {
                int[] row = new int[width];
                for (int line = 0; line < height; line++) {
                    if (line % 64 == 0) { checkpoint(phase, viewId, line, height); requireSpace(0); }
                    input.getRGB(x, y + line, width, 1, row, 0, width); output.setRGB(0, line, width, 1, row, 0, width);
                }
                checkpoint(phase, viewId, height, height); return output;
            } catch (IOException | RuntimeException | Error failure) { output.flush(); throw failure; }
        }
        private BufferedImage resize(BufferedImage input, JsonObject step, String viewId) throws IOException {
            int width = Json.integer(step, "outputWidth", 0), height = Json.integer(step, "outputHeight", 0);
            JsonArray forward = Json.array(step, "forward");
            double sx = forward.get(0).getAsDouble(), sy = forward.get(4).getAsDouble(), dx = forward.get(2).getAsDouble(), dy = forward.get(5).getAsDouble();
            checkpoint("resizing", viewId, 0, height); BufferedImage output = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
            try {
                int sourceWidth = input.getWidth(), sourceHeight = input.getHeight(), background = Integer.parseInt(options.background.substring(1), 16);
                int[] left = new int[width], right = new int[width], line = new int[width], row0 = new int[sourceWidth], row1 = new int[sourceWidth];
                double[] wx = new double[width]; boolean[] validX = new boolean[width];
                for (int x = 0; x < width; x++) {
                    double edge = (x + 0.5 - dx) / sx; validX[x] = edge >= 0 && edge < sourceWidth;
                    double index = Math.max(0, Math.min(sourceWidth - 1, edge - 0.5));
                    left[x] = (int)Math.floor(index); right[x] = Math.min(left[x] + 1, sourceWidth - 1); wx[x] = index - left[x];
                }
                for (int y = 0; y < height; y++) {
                    if (y % 64 == 0) { checkpoint("resizing", viewId, y, height); requireSpace(0); }
                    double edge = (y + 0.5 - dy) / sy;
                    if (edge < 0 || edge >= sourceHeight) Arrays.fill(line, background);
                    else {
                        double index = Math.max(0, Math.min(sourceHeight - 1, edge - 0.5)); int top = (int)Math.floor(index), bottom = Math.min(top + 1, sourceHeight - 1);
                        double wy = index - top;
                        input.getRGB(0, top, sourceWidth, 1, row0, 0, sourceWidth); input.getRGB(0, bottom, sourceWidth, 1, row1, 0, sourceWidth);
                        for (int x = 0; x < width; x++) line[x] = !validX[x] ? background : bilinear(row0[left[x]], row0[right[x]], row1[left[x]], row1[right[x]], wx[x], wy);
                    }
                    output.setRGB(0, y, width, 1, line, 0, width);
                }
                checkpoint("resizing", viewId, height, height); return output;
            } catch (IOException | RuntimeException | Error failure) { output.flush(); throw failure; }
        }
        private void writePng(BufferedImage image, Path target, String viewId) throws IOException {
            Iterator<ImageWriter> writers = ImageIO.getImageWritersByFormatName("png");
            if (!writers.hasNext()) throw error(500, "png_writer_missing", "当前 Java 环境缺少 PNG 编码器。");
            ImageWriter writer = writers.next(); RuntimeException[] deferred = {null}; long[] diskCheckedAt = {0};
            writer.addIIOWriteProgressListener(new IIOWriteProgressListener() {
                public void imageStarted(ImageWriter source, int imageIndex) {}
                public void imageComplete(ImageWriter source) {}
                public void thumbnailStarted(ImageWriter source, int imageIndex, int thumbnailIndex) {}
                public void thumbnailProgress(ImageWriter source, float percentageDone) {}
                public void thumbnailComplete(ImageWriter source) {}
                public void writeAborted(ImageWriter source) {}
                public void imageProgress(ImageWriter source, float percentageDone) {
                    if (deferred[0] != null) return;
                    try {
                        checkpoint("encoding_png", viewId, Math.round(percentageDone * 100), 10000);
                        long now = System.nanoTime();
                        if (diskCheckedAt[0] == 0 || now - diskCheckedAt[0] >= 100_000_000 || percentageDone >= 100) {
                            requireSpace(Math.max(0, estimate.perViewOutputUpperBytes - Files.size(target))); diskCheckedAt[0] = now;
                        }
                    } catch (IOException failure) { deferred[0] = new UncheckedIOException(failure); source.abort(); }
                    catch (RuntimeException failure) { deferred[0] = failure; source.abort(); }
                }
            });
            checkpoint("encoding_png", viewId, 0, 10000);
            try (FileImageOutputStream output = new FileImageOutputStream(target.toFile())) {
                writer.setOutput(output); writer.write(null, new IIOImage(image, null, null), writer.getDefaultWriteParam()); output.flush();
            } finally { writer.dispose(); }
            if (deferred[0] instanceof UncheckedIOException failure) throw failure.getCause();
            if (deferred[0] != null) throw deferred[0];
            checkpoint("encoded_png", viewId, 1, 1);
        }
        private String hash(Path path, String viewId, String phase) throws IOException {
            rejectLink(path); MessageDigest digest = sha256(); long total = Files.size(path), read = 0;
            try (InputStream input = Files.newInputStream(path)) {
                byte[] buffer = new byte[65536]; int count;
                while ((count = input.read(buffer)) != -1) {
                    read += count; checkpoint(phase, viewId, read, total); digest.update(buffer, 0, count);
                }
            }
            return HexFormat.of().formatHex(digest.digest());
        }
        private void checkpoint(String phase, String viewId, long completed, long total) {
            checkControl(); long now = System.nanoTime();
            if (!Objects.equals(phase, lastProgressPhase) || !Objects.equals(viewId, lastProgressView)
                || completed == 0 || completed >= total || now - lastProgressAt >= 100_000_000) {
                control.progress(phase, viewId, completed, total); lastProgressPhase = phase; lastProgressView = viewId; lastProgressAt = now;
            }
            checkControl();
        }
        private void checkControl() {
            if (Thread.currentThread().isInterrupted() || control.cancelled()) throw error(409, "transform_cancelled", "图像生成已取消，未发布的文件已停止交付。");
            if (control.paused()) throw error(409, "transform_paused", "图像生成已暂停，可沿原计划继续。");
        }
        private void reportCommitted(String phase, String viewId) {
            try { control.progress(phase, viewId, 1, 1); }
            catch (RuntimeException ignored) { /* 完成点后的进度观察者失败不能撤销已发布图片。 */ }
        }
        private void requireSpace(long expected) throws IOException {
            checkedDirectory(directory);
            long actual = Files.getFileStore(directory).getUsableSpace(), supplied = Math.max(0, control.availableBytesLimit(directory));
            if (Math.min(actual, supplied) < Math.addExact(Math.max(0, expected), DISK_MARGIN))
                throw error(507, "disk_space_low", "目标磁盘余量不足，未完成的 PNG 不会发布。");
        }
        private Path owned(String name) { return child(directory, name); }
        private Path child(Path parent, String name) {
            Path result = parent.resolve(name).normalize();
            if (!result.startsWith(directory) || !result.getParent().equals(parent)) throw error(422, "transform_directory_invalid", "图像生成路径越界。");
            return result;
        }
        private void checkedDirectory(Path path) throws IOException {
            if (!Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS) || Files.isSymbolicLink(path)
                || !path.toRealPath().equals(path.toAbsolutePath().normalize()) || !path.toAbsolutePath().normalize().startsWith(directory))
                throw error(422, "transform_directory_invalid", "专属目录实际位置变化，已停止写入和清理。");
        }
        private void cleanAbandoned(Path parent, String prefix) throws IOException {
            try (Stream<Path> children = Files.list(parent)) {
                for (Path path : children.filter(p -> p.getFileName().toString().matches(java.util.regex.Pattern.quote(prefix) + "[0-9a-fA-F-]{36}")).toList()) deleteOwned(path);
            }
        }
        private void deleteOwned(Path target) throws IOException {
            Path normalized = target.toAbsolutePath().normalize();
            if (directory == null || !normalized.startsWith(directory)) throw new IOException("临时文件清理范围无效。");
            if (!Files.exists(normalized, LinkOption.NOFOLLOW_LINKS)) return;
            // 每层核对真实目录，避免系统联接点或替换目录让清理越出专属范围。
            if (Files.isSymbolicLink(normalized)) { Files.delete(normalized); return; }
            if (Files.isDirectory(normalized, LinkOption.NOFOLLOW_LINKS)) {
                checkedDirectory(normalized);
                try (DirectoryStream<Path> entries = Files.newDirectoryStream(normalized)) { for (Path path : entries) deleteOwned(path); }
            }
            Files.deleteIfExists(normalized);
        }
        // 与 render 串行；外部应通过 Control 取消，不能依赖等待锁的 close 中断工作。
        @Override public synchronized void close() throws IOException {
            if (closed) return;
            if (rendering) throw error(409, "transform_session_busy", "必须先等待当前视图生成退出，再关闭会话。");
            closed = true; IOException failure = null;
            if (prefix != null) { prefix.flush(); prefix = null; }
            try { if (work != null && lock != null && lock.isValid()) deleteOwned(work); } catch (IOException error) { failure = error; }
            try { if (lock != null) lock.release(); } catch (IOException error) { if (failure == null) failure = error; else failure.addSuppressed(error); }
            try { if (lockChannel != null) lockChannel.close(); } catch (IOException error) { if (failure == null) failure = error; else failure.addSuppressed(error); }
            // 释放锁后下一会话即可进入，保留清单、views 与锁文件骨架，绝不再递归删除共享目录。
            if (failure != null) throw failure;
        }
    }

    private static Estimate estimate(JsonObject plan, RenderOptions options) {
        JsonObject baseline = Json.object(plan, "baseline"); JsonArray operations = Json.array(plan, "operations"), steps = Json.array(plan, "steps");
        long current = bytes(Json.integer(baseline, "width", 0), Json.integer(baseline, "height", 0));
        long peak = Math.multiplyExact(current, 2), prefix = 0; boolean tiled = false;
        for (int i = 0; i < operations.size(); i++) {
            JsonObject operation = operations.get(i).getAsJsonObject(), step = steps.get(i).getAsJsonObject();
            long next = bytes(Json.integer(step, "outputWidth", 0), Json.integer(step, "outputHeight", 0));
            if (Json.required(operation, "kind").equals("tile")) { tiled = true; prefix = current; peak = Math.max(peak, prefix + next); }
            else peak = Math.max(peak, (tiled ? prefix : 0) + current + next);
            current = next;
        }
        int views = Json.array(plan, "views").size(); JsonObject view = Json.array(plan, "views").get(0).getAsJsonObject();
        long perView = Math.addExact(bytes(Json.integer(view, "width", 0), Json.integer(view, "height", 0)), 65536);
        long planReserve = 1024L * 1024 + (long)views * 8192 + (long)steps.size() * 2048;
        long totalPeak = Math.addExact(peak, Math.addExact(ENCODING_RESERVE, planReserve));
        if (totalPeak > options.maxResidentBytes) throw error(422, "transform_memory_limit", "按实际图像缓冲及编码余量估算的峰值超过内存限制。");
        return new Estimate(totalPeak, peak, ENCODING_RESERVE, planReserve, perView, Math.multiplyExact(perView, views), views);
    }
    private static long bytes(int width, int height) { return Math.multiplyExact(Math.multiplyExact((long)width, height), 4); }
    private static int bilinear(int a, int b, int c, int d, double wx, double wy) {
        int result = 0;
        for (int shift = 16; shift >= 0; shift -= 8) {
            double top = ((a >>> shift) & 255) * (1 - wx) + ((b >>> shift) & 255) * wx;
            double bottom = ((c >>> shift) & 255) * (1 - wx) + ((d >>> shift) & 255) * wx;
            result |= ((int)Math.floor(top * (1 - wy) + bottom * wy + 0.5)) << shift;
        }
        return result;
    }
    private static JsonObject policy(RenderOptions options) {
        return Json.obj("version", PIXEL_VERSION, "interpolation", "bilinear-v1", "colorSpace", "sRGB", "coordinates", "pixel_centers",
            "coverage", "half_open_source_canvas", "edgeSamples", "clamp", "rounding", "nearest_half_up", "background", options.background);
    }
    private static void requirePng(Path path, int width, int height) throws IOException {
        rejectLink(path);
        if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS) || Files.size(path) < 33) throw error(422, "png_invalid", "PNG 文件不完整。");
        try (DataInputStream input = new DataInputStream(Files.newInputStream(path))) {
            if (!Arrays.equals(input.readNBytes(8), PNG_SIGNATURE) || input.readInt() != 13 || input.readInt() != 0x49484452
                || input.readInt() != width || input.readInt() != height || input.readUnsignedByte() != 8 || input.readUnsignedByte() != 2)
                throw error(422, "baseline_not_normalized", "PNG 必须是尺寸匹配的 8 位不透明 RGB 基准图。");
        }
    }
    private static void rejectLink(Path path) throws IOException {
        if (Files.isSymbolicLink(path)) throw error(422, "transform_directory_invalid", "生成文件路径不能是符号链接。");
    }
    private static JsonObject readJson(Path path, long limit) throws IOException {
        rejectLink(path);
        if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS) || Files.size(path) > limit)
            throw error(409, "transform_manifest_invalid", "输入清单不存在或大小无效。");
        try { return Json.parse(Files.readString(path, StandardCharsets.UTF_8)); }
        catch (JsonParseException | IllegalStateException error) { throw error(409, "transform_manifest_invalid", "输入清单格式无效。"); }
    }
    private static void writeJson(Path path, JsonObject value) throws IOException {
        try (Writer writer = Files.newBufferedWriter(path, StandardCharsets.UTF_8, StandardOpenOption.CREATE_NEW)) { Json.GSON.toJson(value, writer); }
    }
    private static void writeJsonAtomic(Path target, JsonObject value) throws IOException {
        Path temporary = target.resolveSibling(".manifest-" + UUID.randomUUID());
        try { writeJson(temporary, value); force(temporary); Files.move(temporary, target, StandardCopyOption.ATOMIC_MOVE); }
        finally { Files.deleteIfExists(temporary); }
    }
    private static void force(Path file) throws IOException { try (FileChannel channel = FileChannel.open(file, StandardOpenOption.WRITE)) { channel.force(true); } }
    private static String digest(JsonElement value) {
        MessageDigest digest = sha256();
        try (JsonWriter writer = new JsonWriter(new OutputStreamWriter(new DigestOutputStream(OutputStream.nullOutputStream(), digest), StandardCharsets.UTF_8))) {
            writer.setSerializeNulls(true); canonical(writer, value);
        } catch (IOException impossible) { throw new UncheckedIOException(impossible); }
        return HexFormat.of().formatHex(digest.digest());
    }
    private static void canonical(JsonWriter writer, JsonElement value) throws IOException {
        if (value == null || value.isJsonNull()) writer.nullValue();
        else if (value.isJsonObject()) {
            writer.beginObject(); for (String key : new TreeSet<>(value.getAsJsonObject().keySet())) { writer.name(key); canonical(writer, value.getAsJsonObject().get(key)); } writer.endObject();
        } else if (value.isJsonArray()) { writer.beginArray(); for (JsonElement item : value.getAsJsonArray()) canonical(writer, item); writer.endArray(); }
        else if (value.getAsJsonPrimitive().isNumber()) writer.jsonValue(new BigDecimal(value.getAsString()).stripTrailingZeros().toPlainString());
        else if (value.getAsJsonPrimitive().isBoolean()) writer.value(value.getAsBoolean());
        else writer.value(value.getAsString());
    }
    private static MessageDigest sha256() {
        try { return MessageDigest.getInstance("SHA-256"); } catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }
    private static ApiError error(int status, String code, String message) { return new ApiError(status, code, message); }
}
