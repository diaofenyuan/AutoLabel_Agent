package cn.autolabel.engine;

import com.google.gson.*;
import java.nio.file.*;

/**
 * 存储与对话记录计划 5.4/5.5 验收：受管原图根（materialsRoot）可配置。
 * 覆盖缺省位置、自定义位置、非法路径拒绝、项目删除与备份恢复；全部使用本地合成夹具。
 */
final class MaterialsRootTest {
    private MaterialsRootTest() {}

    static void run(Path root) throws Exception {
        defaults(root.resolve("default"));
        custom(root.resolve("custom"));
        rejectsUnsafe(root.resolve("rejects"));
        deletion(root.resolve("deletion"));
        backup(root.resolve("backup"));
    }

    // ===== 缺省：仍落在数据目录内的 originals，保证既有用户行为不变 =====

    private static void defaults(Path dir) throws Exception {
        Path data = dir.resolve("data");
        try (Engine e = new Engine(data)) {
            check(e.store.materialsRoot.equals(data.toAbsolutePath().normalize().resolve("originals")), "缺省受管原图根仍是数据目录内的 originals");
            JsonObject project = EngineTest.project(e, "detect");
            String assetId = importCopy(e, dir, Json.required(project, "id"), "default.png");
            Path managed = Path.of(sourcePath(e, assetId));
            check(managed.equals(e.store.materialsRoot.resolve(assetId + ".png")) && Files.isRegularFile(managed), "缺省导入复制到受管原图根");
        }
    }

    // ===== 自定义：写入自定义根，且效果图与导出都不能写进去 =====

    private static void custom(Path dir) throws Exception {
        Path data = dir.resolve("data"), materials = dir.resolve("uploads");
        try (Engine e = new Engine(data, Json.obj("materialsRoot", materials.toString()))) {
            Path expected = materials.toAbsolutePath().normalize();
            check(e.store.materialsRoot.equals(expected), "启动参数里的受管原图根生效");
            JsonObject project = EngineTest.project(e, "detect");
            String pid = Json.required(project, "id"), assetId = importCopy(e, dir, pid, "custom.png");
            Path managed = Path.of(sourcePath(e, assetId));
            check(managed.equals(expected.resolve(assetId + ".png")) && Files.isRegularFile(managed), "导入复制落在自定义受管原图根");
            check(!managed.startsWith(e.store.root), "自定义受管原图根位于数据目录之外");

            EngineTest.command(e, "annotation.save", Json.obj("assetId", assetId, "baseVersion", 0, "annotations", Json.arr(EngineTest.label("detect")), "confirm", true));
            rejectsCode("overlay_target_protected", () -> EngineTest.command(e, "annotation.render",
                Json.obj("assetId", assetId, "version", 1, "outputPath", expected.resolve("overlay.png").toString())));
            rejectsCode("export_target_protected", () -> EngineTest.command(e, "export.create",
                Json.obj("projectId", pid, "outputDir", expected.resolve("dataset").toString())));

            JsonObject referenced = EngineTest.command(e, "asset.import", Json.obj("projectId", pid, "paths", Json.arr(image(dir, "reference.png", 4).toString()), "mode", "reference"));
            String referenceId = Json.array(referenced, "assetIds").get(0).getAsString();
            check(!Files.exists(expected.resolve(referenceId + ".png")), "参考模式不复制受管原图");
        }
    }

    // ===== 非法路径：相对路径、与数据目录相同、包含数据目录、磁盘根都拒绝 =====

    private static void rejectsUnsafe(Path dir) throws Exception {
        Path data = dir.resolve("data");
        rejects("materials_root_invalid", data, Json.obj("materialsRoot", "relative/uploads"));
        rejects("materials_root_invalid", data, Json.obj("materialsRoot", data.toString()));
        rejects("materials_root_invalid", data, Json.obj("materialsRoot", dir.toString()));
        rejects("materials_root_invalid", data, Json.obj("materialsRoot", data.toAbsolutePath().getRoot().toString()));
    }

    // ===== 删除：受管原图根内的副本按项目清理，其他项目不受影响 =====

    private static void deletion(Path dir) throws Exception {
        Path data = dir.resolve("data"), materials = dir.resolve("uploads");
        try (Engine e = new Engine(data, Json.obj("materialsRoot", materials.toString()))) {
            JsonObject keep = EngineTest.project(e, "detect"), remove = EngineTest.project(e, "detect");
            String keepId = importCopy(e, dir, Json.required(keep, "id"), "keep.png");
            String removeId = importCopy(e, dir, Json.required(remove, "id"), "remove.png");
            Path keepFile = materials.resolve(keepId + ".png"), removeFile = materials.resolve(removeId + ".png");
            check(Files.isRegularFile(keepFile) && Files.isRegularFile(removeFile), "两个项目各自的受管原图都在自定义根内");

            JsonObject preflight = EngineTest.command(e, "project.delete.preflight", Json.obj("projectId", Json.required(remove, "id")));
            check(Json.number(preflight, "managedBytes", 0) > 0, "删除预检统计自定义根内的受管占用");

            EngineTest.command(e, "project.delete", Json.obj("projectId", Json.required(remove, "id"), "confirmName", Json.required(remove, "name"),
                "removeManagedFiles", true, "createBackup", false));
            check(!Files.exists(removeFile), "删除项目清理自定义根内的受管原图");
            check(Files.isRegularFile(keepFile), "其他项目的受管原图不受影响");
        }
    }

    // ===== 备份：外部受管原图进入备份，恢复后收进新数据目录并可读取 =====

    private static void backup(Path dir) throws Exception {
        Path data = dir.resolve("data"), materials = dir.resolve("uploads"), output = dir.resolve("backups"), parent = dir.resolve("restore");
        Files.createDirectories(output);
        Files.createDirectories(parent);
        try (Engine e = new Engine(data, Json.obj("materialsRoot", materials.toString()))) {
            JsonObject project = EngineTest.project(e, "detect");
            String pid = Json.required(project, "id"), assetId = importCopy(e, dir, pid, "backup.png");
            String hash = Json.str(Json.object(EngineTest.command(e, "asset.get", Json.obj("assetId", assetId)), "metadata"), "sourceHash", "");

            // 备份与恢复都必须在主进程持有的数据维护锁内执行，沿用桌面编排的同一顺序。
            JsonObject backupOwner = Json.obj("operationId", "materials-backup-owner");
            check(Json.bool(EngineTest.command(e, "system.prepareDataMaintenance", backupOwner), "ready", false), "空闲时可进入数据维护");
            JsonObject created = EngineTest.command(e, "backup.create", Json.obj("outputDir", output.toString(), "operationId", "materials-backup-owner"));
            EngineTest.command(e, "system.cancelDataMaintenance", backupOwner);
            String archive = Json.required(created, "backupPath");
            check(Files.isRegularFile(Path.of(archive)), "外部受管原图可完成备份");
            check(Json.bool(EngineTest.command(e, "backup.inspect", Json.obj("backupPath", archive)), "valid", false), "备份可复核");

            JsonObject restoreOwner = Json.obj("operationId", "materials-restore-owner");
            check(Json.bool(EngineTest.command(e, "system.prepareDataMaintenance", restoreOwner), "ready", false), "恢复前可进入数据维护");
            JsonObject restored = EngineTest.command(e, "restore.prepare", Json.obj("backupPath", archive, "targetParent", parent.toString(), "operationId", "materials-restore-owner"));
            EngineTest.command(e, "system.cancelDataMaintenance", restoreOwner);
            Path restoredDir = Path.of(Json.required(restored, "dataDir")), restoredSource = restoredDir.resolve("originals").resolve("imported-" + hash + ".png");
            check(Files.isRegularFile(restoredSource) && Media.hash(restoredSource).equals(hash), "恢复把外部受管原图收进新数据目录且内容一致");

            try (Engine reopened = new Engine(restoredDir)) {
                JsonObject items = EngineTest.command(reopened, "asset.list", Json.obj("projectId", pid));
                String restoredId = Json.array(items, "items").get(0).getAsJsonObject().get("id").getAsString();
                String path = sourcePath(reopened, restoredId);
                check(path.startsWith(restoredDir.toAbsolutePath().normalize().toString()) && Files.isRegularFile(Path.of(path)), "恢复后的素材指向新数据目录内的受管原图");
            }
        }
    }

    // ===== 夹具与断言 =====

    private interface Action { void run() throws Exception; }

    /** 引擎命令大多声明受检异常，这里与 EngineTest.error 同一语义但允许抛出。 */
    private static void rejectsCode(String code, Action action) {
        try { action.run(); throw new AssertionError("Expected " + code); }
        catch (ApiError e) { check(e.code.equals(code), "Expected " + code + " got " + e.code); }
        catch (AssertionError e) { throw e; }
        catch (Exception e) { throw new AssertionError("Expected " + code + " got " + e); }
    }

    private static void rejects(String code, Path data, JsonObject config) {
        rejectsCode(code, () -> new Engine(data, config).close());
    }

    private static String importCopy(Engine e, Path dir, String pid, String name) throws Exception {
        JsonObject result = EngineTest.command(e, "asset.import", Json.obj("projectId", pid, "paths", Json.arr(image(dir, name).toString()), "mode", "copy"));
        check(Json.integer(result, "imported", 0) == 1, "导入一张图片：" + name);
        return Json.array(result, "assetIds").get(0).getAsString();
    }

    private static String sourcePath(Engine e, String assetId) throws Exception {
        return Json.str(Json.object(EngineTest.command(e, "asset.get", Json.obj("assetId", assetId)), "metadata"), "sourcePath", "");
    }

    private static Path image(Path directory, String name) throws Exception {
        return image(directory, name, 0);
    }

    /** 合成图内容由 index 决定；不同用例需要不同内容时才不会被同项目去重跳过。 */
    private static Path image(Path directory, String name, int index) throws Exception {
        Path path = directory.resolve(name);
        Files.createDirectories(path.getParent());
        Media.sample(path, index);
        return path;
    }

    private static void check(boolean ok, String message) {
        EngineTest.check(ok, message);
    }
}
