package cn.autolabel.engine;

import com.google.gson.*;
import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.IOException;
import java.nio.file.*;
import java.util.*;

/** 使用真实 PNG、原子目录发布及隔离磁盘目录验证像素与失败边界。 */
final class TransformedImagesTest {
    private static int assertions;
    private static final TransformedImages.RenderOptions OPTIONS = new TransformedImages.RenderOptions("#0000FF", 256L * 1024 * 1024);
    @FunctionalInterface private interface Action { void run() throws Exception; }
    private static final class Control implements TransformedImages.Control {
        boolean cancelled, paused, throwAfterPublish, cancelledDuringEncoding;
        String trigger;
        long available = Long.MAX_VALUE;
        final Map<String, Integer> progress = new HashMap<>();
        Runnable onDecode;
        public boolean cancelled() { return cancelled; }
        public boolean paused() { return paused; }
        public long availableBytesLimit(Path directory) { return available; }
        public void progress(String phase, String view, long done, long total) {
            progress.merge(phase + ":" + view, 1, Integer::sum);
            if (phase.equals("decoding_baseline") && onDecode != null) { Runnable action = onDecode; onDecode = null; action.run(); }
            if (phase.equals(trigger)) {
                if (phase.equals("cropping_tile")) paused = true;
                else if (phase.equals("encoded_png")) available = 0;
                else cancelled = true;
            }
            if ("encoding_progress".equals(trigger) && phase.equals("encoding_png") && done > 0) { cancelled = true; cancelledDuringEncoding = true; }
            if (throwAfterPublish && phase.equals("published")) throw new IllegalStateException("isolated observer failure");
        }
    }
    public static void main(String[] args) throws Exception {
        Path root = Files.createTempDirectory("autolabel-transformed-images-");
        if (args.length == 1 && args[0].equals("session-close")) emptySessionHandoff(root); else run(root);
        System.out.println("TransformedImagesTest passed: " + assertions + " assertions; isolated artifacts: " + root);
    }
    static void run(Path root) throws Exception {
        cropAndIdentity(root); fractionalContain(root); repeatedResize(root); tileAndPrefix(root);
        memoryAndIdentity(root); boundedLargePlan(root); cancellationAndPause(root); publicationBoundary(root); diskAndReuse(root); privateSource(root); emptySessionHandoff(root);
    }
    private static void check(boolean value, String message) { assertions++; if (!value) throw new AssertionError(message); }
    private static void rejects(String code, Action action) throws Exception {
        try { action.run(); throw new AssertionError("Expected " + code); }
        catch (ApiError error) { check(error.code.equals(code), "Expected " + code + " got " + error.code); }
    }
    private static JsonObject resize(int width, int height, String fit) { return Json.obj("kind", "resize", "width", width, "height", height, "fit", fit); }
    private static JsonObject crop(int x, int y, int width, int height) { return Json.obj("kind", "crop", "x", x, "y", y, "width", width, "height", height); }
    private static JsonObject tile(int width, int height, int overlap) { return Json.obj("kind", "tile", "width", width, "height", height, "overlapX", overlap, "overlapY", overlap); }
    private static JsonObject plan(Path source, JsonObject... operations) throws Exception {
        BufferedImage image = ImageIO.read(source.toFile());
        try { return TransformGeometry.plan(Json.obj("assetId", "fixed-baseline", "contentHash", Media.hash(source), "width", image.getWidth(), "height", image.getHeight(),
            "normalizationVersion", Media.NORMALIZATION_VERSION, "inputVersion", 1), Json.arr((Object[])operations)); }
        finally { image.flush(); }
    }
    private static int color(int x, int y) { return ((x * 19) << 16) | ((y * 23) << 8) | ((x + y) * 11); }
    private static Path source(Path root, String name, int width, int height, boolean checker) throws IOException {
        BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
        for (int y = 0; y < height; y++) for (int x = 0; x < width; x++) image.setRGB(x, y, checker ? ((x + y) % 2 == 0 ? 0xFFFFFF : 0) : color(x, y));
        Path path = root.resolve(name + ".png"); ImageIO.write(image, "png", path.toFile()); image.flush(); return path;
    }
    private static BufferedImage rendered(Path source, JsonObject plan, Path directory, String view) throws Exception {
        try (var session = TransformedImages.open(source, plan, directory, OPTIONS, null)) {
            TransformedImages.Generated result = session.render(view);
            check(Media.hash(result.imagePath()).equals(Json.required(result.inputSnapshot(), "contentHash")), "snapshot contains actual PNG hash");
            return ImageIO.read(result.imagePath().toFile());
        }
    }
    private static int rgb(BufferedImage image, int x, int y) { return image.getRGB(x, y) & 0xFFFFFF; }
    private static void noPartial(Path directory) throws IOException {
        if (!Files.exists(directory)) { check(true, "empty uncommitted generation removed"); return; }
        try (var entries = Files.walk(directory)) {
            check(entries.noneMatch(p -> p.getFileName().toString().startsWith(".partial-")), "unpublished view directories cleaned");
        }
    }

    private static void cropAndIdentity(Path root) throws Exception {
        Path source = source(root, "checker", 4, 4, true);
        BufferedImage cropped = rendered(source, plan(source, crop(1, 1, 2, 2)), root.resolve("checker-crop"), "view-00000");
        check(cropped.getWidth() == 2 && cropped.getHeight() == 2, "integer crop actual dimensions");
        for (int y = 0; y < 2; y++) for (int x = 0; x < 2; x++) check(rgb(cropped, x, y) == ((x + y) % 2 == 0 ? 0xFFFFFF : 0), "integer crop preserves checker pixels");
        cropped.flush();
        BufferedImage identity = rendered(source, plan(source), root.resolve("checker-identity"), "view-00000");
        check(rgb(identity, 3, 0) == 0 && rgb(identity, 0, 0) == 0xFFFFFF, "baseline pixels are not rotated or mirrored again"); identity.flush();
    }

    private static void fractionalContain(Path root) throws Exception {
        BufferedImage flat = new BufferedImage(3, 2, BufferedImage.TYPE_INT_RGB);
        for (int y = 0; y < 2; y++) for (int x = 0; x < 3; x++) flat.setRGB(x, y, 0xFF0000);
        Path source = root.resolve("red.png"); ImageIO.write(flat, "png", source.toFile()); flat.flush();
        JsonObject plan = plan(source, resize(8, 8, "contain"));
        BufferedImage image = rendered(source, plan, root.resolve("fractional"), "view-00000");
        check(rgb(image, 3, 0) == 0x0000FF && rgb(image, 3, 7) == 0x0000FF, "fractional padding uses frozen background");
        check(rgb(image, 3, 1) == 0xFF0000 && rgb(image, 3, 6) == 0xFF0000, "fractional content coverage follows pixel centers without rounded destination rectangle");
        double top = Json.decimal(Json.object(Json.array(plan, "views").get(0).getAsJsonObject(), "validInputRect"), "y", 0);
        check(Math.abs(top - 4.0 / 3) < 1e-9, "pixel placement uses exact geometry padding"); image.flush();
        BufferedImage row = new BufferedImage(2, 1, BufferedImage.TYPE_INT_RGB); row.setRGB(0, 0, 0); row.setRGB(1, 0, 0xFFFFFF);
        Path gradient = root.resolve("two-pixels.png"); ImageIO.write(row, "png", gradient.toFile()); row.flush();
        BufferedImage interpolated = rendered(gradient, plan(gradient, resize(4, 1, "stretch")), root.resolve("bilinear"), "view-00000");
        for (int x = 0; x < 4; x++) { int value = new int[]{0, 64, 191, 255}[x]; check(rgb(interpolated, x, 0) == (value * 0x010101), "explicit sRGB bilinear component and rounding policy"); }
        interpolated.flush();
    }

    private static void repeatedResize(Path root) throws Exception {
        BufferedImage impulse = new BufferedImage(5, 1, BufferedImage.TYPE_INT_RGB); impulse.setRGB(2, 0, 0xFFFFFF);
        Path source = root.resolve("impulse.png"); ImageIO.write(impulse, "png", source.toFile()); impulse.flush();
        BufferedImage repeated = rendered(source, plan(source, resize(3, 1, "stretch"), resize(5, 1, "stretch")), root.resolve("double-resize"), "view-00000");
        check(rgb(repeated, 1, 0) == 0x666666 && rgb(repeated, 3, 0) == 0x666666, "two resizes preserve intermediate sampling rather than collapsed affine identity");
        check(rgb(repeated, 2, 0) == 0xFFFFFF && rgb(repeated, 0, 0) == 0, "two resize oracle retains expected peak and edges"); repeated.flush();
    }

    private static void tileAndPrefix(Path root) throws Exception {
        Path source = source(root, "tile-source", 9, 7, false);
        JsonObject plan = plan(source, crop(1, 1, 8, 6), tile(3, 3, 1), crop(1, 1, 2, 2));
        Control control = new Control(); Path directory = root.resolve("tiles");
        try (var session = TransformedImages.open(source, plan, directory, OPTIONS, control)) {
            int prefixProgress = control.progress.getOrDefault("cropping:null", 0);
            check(prefixProgress > 0, "common prefix executed at session preparation");
            for (JsonElement value : Json.array(plan, "views")) {
                JsonObject view = value.getAsJsonObject(), tile = Json.object(view, "tile");
                TransformedImages.Generated generated = session.render(Json.required(view, "viewId"));
                BufferedImage image = ImageIO.read(generated.imagePath().toFile());
                for (int y = 0; y < 2; y++) for (int x = 0; x < 2; x++)
                    check(rgb(image, x, y) == color(2 + Json.integer(tile, "x", 0) + x, 2 + Json.integer(tile, "y", 0) + y), "tile source and ordered suffix align exactly");
                check(generated.inputSnapshot().get("inputTransform").equals(view), "actual PNG is bound to precise tile view"); image.flush();
            }
            check(control.progress.getOrDefault("cropping:null", 0) == prefixProgress, "common prefix not rebuilt for each tile");
            JsonObject lastTile = Json.object(Json.array(plan, "views").get(11).getAsJsonObject(), "tile");
            check(Json.integer(lastTile, "x", -1) == 5 && Json.integer(lastTile, "y", -1) == 3, "non-divisible final tile origins retained");
        }
        check(Files.isRegularFile(directory.resolve("views/view-00011/input.png")), "close retains published final tile");
        try (var entries = Files.list(directory)) { check(entries.noneMatch(p -> p.getFileName().toString().startsWith(".work-")), "close deletes only private source workspace"); }
    }

    private static void memoryAndIdentity(Path root) throws Exception {
        Path source = source(root, "memory-source", 10, 8, false);
        JsonObject plan = plan(source, resize(20, 16, "stretch"), tile(10, 8, 0), resize(30, 20, "stretch"));
        var estimate = TransformedImages.inspect(plan, OPTIONS);
        check(estimate.bufferPeakBytes() == 4000, "peak counts pinned prefix and both suffix buffers by actual RGB backing bytes");
        check(estimate.peakResidentBytes() == estimate.bufferPeakBytes() + estimate.encodingReserveBytes() + estimate.planReserveBytes(), "encoding and plan reserves included in admission");
        Path rejected = root.resolve("memory-rejected");
        rejects("transform_memory_limit", () -> TransformedImages.open(source, plan, rejected,
            new TransformedImages.RenderOptions("#0000FF", estimate.peakResidentBytes() - 1), null));
        check(!Files.exists(rejected), "insufficient memory rejected before directory and image allocation");
        Path directory = root.resolve("memory-identity"); JsonObject saved;
        try (var session = TransformedImages.open(source, plan, directory, OPTIONS, null)) { saved = session.render("view-00000").inputSnapshot(); }
        try (var session = TransformedImages.open(source, plan, directory, new TransformedImages.RenderOptions("#0000ff", OPTIONS.maxResidentBytes() * 2), null)) {
            var reused = session.render("view-00000"); check(reused.reusedFile() && reused.inputSnapshot().equals(saved), "memory limit does not enter pixel identity and verified output can be reused");
        }
    }

    private static void cancellationAndPause(Path root) throws Exception {
        Path source = source(root, "cancel-source", 8, 6, false); JsonObject plan = plan(source, tile(4, 3, 0));
        Control control = new Control(); Path directory = root.resolve("pause-resume");
        try (var session = TransformedImages.open(source, plan, directory, OPTIONS, control)) {
            var first = session.render("view-00000"); String hash = Media.hash(first.imagePath());
            control.trigger = "cropping_tile";
            rejects("transform_paused", () -> session.render("view-00001")); noPartial(directory);
            check(Files.isRegularFile(first.imagePath()) && Media.hash(first.imagePath()).equals(hash), "pause never deletes previously published image");
            control.trigger = null; control.paused = false;
            check(!session.render("view-00001").reusedFile(), "same session resumes an unpublished view along unchanged plan");
            control.trigger = "encoding_progress";
            rejects("transform_cancelled", () -> session.render("view-00002")); noPartial(directory);
            check(control.cancelledDuringEncoding, "cancellation happened inside the actual PNG writer progress callback");
        }
        check(Files.exists(directory.resolve("views/view-00000/input.png")) && !Files.exists(directory.resolve("views/view-00002")), "cancel and close keep completed views only");
        Control before = new Control(); before.trigger = "before_publish"; Path allCancelled = root.resolve("cancel-before-publish");
        try (var session = TransformedImages.open(source, plan, allCancelled, OPTIONS, before)) {
            rejects("transform_cancelled", () -> session.render("view-00000")); noPartial(allCancelled);
        }
        check(Files.isRegularFile(allCancelled.resolve("generation.json")), "cancelled generation keeps valid reusable skeleton after releasing lock");
    }

    private static void boundedLargePlan(Path root) throws Exception {
        Path source = source(root, "many-tiles-source", 100, 100, false);
        JsonObject plan = plan(source, tile(1, 1, 0)); Path directory = root.resolve("many-tiles");
        try (var session = TransformedImages.open(source, plan, directory, OPTIONS, null)) {
            check(session.estimate().viewCount() == 10000, "maximum plan admitted with metadata reservation");
            session.render("view-00000"); session.render("view-09999");
            try (var entries = Files.list(directory.resolve("views"))) {
                check(entries.count() == 2, "10000-view session generates only requested views, not an image batch");
            }
        }
        check(Files.isRegularFile(directory.resolve("views/view-09999/input.png")), "last tile can be rendered directly without constructing preceding images");
    }

    private static void publicationBoundary(Path root) throws Exception {
        Path source = source(root, "commit-source", 4, 4, false); JsonObject plan = plan(source); Control control = new Control();
        control.trigger = "published"; control.throwAfterPublish = true; Path directory = root.resolve("commit-cancel");
        TransformedImages.Generated committed;
        try (var session = TransformedImages.open(source, plan, directory, OPTIONS, control)) {
            committed = session.render("view-00000");
            check(control.cancelled, "cancellation arrives exactly after atomic commit");
        }
        check(Files.isRegularFile(committed.imagePath()) && Files.isRegularFile(committed.imagePath().resolveSibling("input.json")), "post-commit cancel and observer failure still deliver valid committed image and manifest");
        check(Media.hash(committed.imagePath()).equals(Json.required(committed.inputSnapshot(), "contentHash")), "committed image remains immutable after close");
    }

    private static void diskAndReuse(Path root) throws Exception {
        Path source = source(root, "disk-source", 8, 6, false); JsonObject plan = plan(source, tile(4, 3, 0));
        Control control = new Control(); Path directory = root.resolve("disk-failure");
        try (var session = TransformedImages.open(source, plan, directory, OPTIONS, control)) {
            session.render("view-00000"); control.trigger = "encoded_png";
            rejects("disk_space_low", () -> session.render("view-00001")); noPartial(directory);
        }
        check(Files.isRegularFile(directory.resolve("views/view-00000/input.png")) && !Files.exists(directory.resolve("views/view-00001")), "low disk retains published images and rejects partial result");
        Control emptyDisk = new Control(); emptyDisk.available = 0; Path noSpace = root.resolve("initial-disk-failure");
        rejects("disk_space_low", () -> TransformedImages.open(source, plan, noSpace, OPTIONS, emptyDisk));
        check(Files.isDirectory(noSpace) && !Files.exists(noSpace.resolve("generation.json")), "initial low disk leaves unrecognized skeleton without taking cleanup ownership after unlock");
        rejects("transform_generation_unrecognized", () -> TransformedImages.open(source, plan, noSpace, OPTIONS, null));
        rejects("transform_generation_mismatch", () -> TransformedImages.open(source, plan(source, tile(4, 3, 1)), directory, OPTIONS, null));
        rejects("transform_generation_mismatch", () -> TransformedImages.open(source, plan, directory, new TransformedImages.RenderOptions("#FFFFFF", OPTIONS.maxResidentBytes()), null));
        check(Files.isRegularFile(directory.resolve("views/view-00000/input.png")), "different plan or background cannot replace old generation");
        Path image = directory.resolve("views/view-00000/input.png"); Files.write(image, new byte[]{42}, StandardOpenOption.APPEND);
        try (var session = TransformedImages.open(source, plan, directory, OPTIONS, null)) { rejects("transform_view_conflict", () -> session.render("view-00000")); }
        try (var active = TransformedImages.open(source, plan, root.resolve("lock-test"), OPTIONS, null)) {
            rejects("transform_session_busy", () -> TransformedImages.open(source, plan, root.resolve("lock-test"), OPTIONS, null));
            check(Files.isDirectory(root.resolve("lock-test")), "failed second session cannot remove active session directory");
        }
    }

    private static void privateSource(Path root) throws Exception {
        Path source = source(root, "private-source", 4, 4, true); JsonObject plan = plan(source); Control control = new Control();
        Path replacement = source(root, "replacement", 4, 4, false);
        control.onDecode = () -> { try { Files.copy(replacement, source, StandardCopyOption.REPLACE_EXISTING); } catch (IOException error) { throw new RuntimeException(error); } };
        try (var session = TransformedImages.open(source, plan, root.resolve("private-copy"), OPTIONS, control)) {
            BufferedImage image = ImageIO.read(session.render("view-00000").imagePath().toFile());
            check(rgb(image, 0, 0) == 0xFFFFFF && rgb(image, 1, 0) == 0, "decoder reads hash-verified private copy even if original changes afterwards"); image.flush();
        }
        Path wrong = root.resolve("wrong-baseline");
        rejects("baseline_content_changed", () -> TransformedImages.open(source, plan, wrong, OPTIONS, null));
        try (var entries = Files.list(wrong.resolve("views"))) { check(entries.findAny().isEmpty(), "mismatched input hash leaves no published input in reusable skeleton"); }
    }

    private static void emptySessionHandoff(Path root) throws Exception {
        Path source = source(root, "empty-handoff", 5, 3, false), directory = root.resolve("empty-session");
        JsonObject plan = plan(source);
        var first = TransformedImages.open(source, plan, directory, OPTIONS, null); first.close();
        check(Files.isRegularFile(directory.resolve("generation.json")) && Files.isDirectory(directory.resolve("views"))
            && Files.isRegularFile(directory.resolve(".session.lock")), "empty session close retains complete generation skeleton");
        try (var entries = Files.list(directory)) { check(entries.noneMatch(p -> p.getFileName().toString().startsWith(".work-")), "private work removed while first session still owns lock"); }
        try (var second = TransformedImages.open(source, plan, directory, OPTIONS, null)) {
            first.close();
            var generated = second.render("view-00000");
            check(Files.isRegularFile(generated.imagePath()) && !generated.reusedFile(), "next session renders successfully after empty-session handoff and stale close");
            check(Media.hash(generated.imagePath()).equals(Json.required(generated.inputSnapshot(), "contentHash")), "handoff output has verified actual PNG hash");
        }
        check(Files.isRegularFile(directory.resolve("views/view-00000/input.png")), "second session close keeps published output");
    }
}
