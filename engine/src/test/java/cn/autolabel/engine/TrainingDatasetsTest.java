package cn.autolabel.engine;

import com.google.gson.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.sql.*;
import java.util.*;

/**
 * 阶段 9A 验收：数据集体检、快照不可变、参数边界与 schema 9 迁移。
 * 全部使用本地合成夹具，不发起任何外部请求。
 */
final class TrainingDatasetsTest {
    private TrainingDatasetsTest() {}

    static void run(Path root) throws Exception {
        healthChecks(root.resolve("health"));
        parameterChecks(root.resolve("parameters"));
        exportReference(root.resolve("export"));
        migration(root.resolve("migration"));
    }

    // ===== 路径 A：体检与快照 =====

    private static void healthChecks(Path root) throws Exception {
        Path data = root.resolve("data");
        try (Engine e = new Engine(data)) {
            Path base = root.resolve("healthy");
            image(base.resolve("train"), "a.png", 0, "0 0.5 0.5 0.2 0.2\n");
            image(base.resolve("val"), "b.png", 1, "0 0.4 0.4 0.3 0.3\n");
            JsonObject created = create(e, base, Json.obj("taskType", "detect", "classNames", Json.arr("cat")));
            EngineTest.check(Json.str(created, "status", "").equals("ready"), "健康数据集可用");
            EngineTest.check(Json.number(Json.object(Json.object(created, "inspection"), "summary"), "images", 0) == 2, "统计两张图片");
            EngineTest.check(Json.array(created, "files").size() == 2, "快照保存逐图清单");
            EngineTest.check(created.get("snapshotHash").getAsString().length() == 64, "快照指纹长度");
            String hash = Json.array(created, "files").get(0).getAsJsonObject().get("hash").getAsString();
            Path directory = data.resolve("training").resolve("datasets").resolve(Json.required(created, "id"));
            Path copied = directory.resolve(Json.array(created, "files").get(0).getAsJsonObject().get("image").getAsString());
            EngineTest.check(Files.isRegularFile(copied) && Media.hash(copied).equals(hash), "快照副本内容与哈希一致");
            EngineTest.check(Files.isRegularFile(directory.resolve("data.yaml")), "生成 data.yaml");
            EngineTest.check(Files.readString(directory.resolve("data.yaml")).contains("train: images/train"), "data.yaml 使用受管相对路径");

            // 缺标签文件不能被当作合法无目标图。
            Path missing = root.resolve("missing");
            image(missing.resolve("train"), "a.png", 0, "0 0.5 0.5 0.2 0.2\n");
            image(missing.resolve("val"), "b.png", 1, null);
            JsonObject invalid = create(e, missing, Json.obj("taskType", "detect", "classNames", Json.arr("cat")));
            EngineTest.check(Json.str(invalid, "status", "").equals("invalid"), "缺标签文件阻断");
            EngineTest.check(hasCode(invalid, "training_label_missing"), "缺标签错误码可定位");
            EngineTest.check(!Files.isDirectory(data.resolve("training").resolve("datasets").resolve(Json.required(invalid, "id"))), "不可用时不留副本");

            // 标签坐标越界与类别编号越界。
            Path outOfRange = root.resolve("out-of-range");
            image(outOfRange.resolve("train"), "a.png", 0, "0 1.5 0.5 0.2 0.2\n");
            image(outOfRange.resolve("val"), "b.png", 1, "0 0.4 0.4 0.3 0.3\n");
            EngineTest.check(hasCode(create(e, outOfRange, Json.obj("taskType", "detect", "classNames", Json.arr("cat"))), "training_label_format_invalid"), "越界坐标被识别");
            Path badClass = root.resolve("bad-class");
            image(badClass.resolve("train"), "a.png", 0, "5 0.5 0.5 0.2 0.2\n");
            image(badClass.resolve("val"), "b.png", 1, "0 0.4 0.4 0.3 0.3\n");
            EngineTest.check(hasCode(create(e, badClass, Json.obj("taskType", "detect", "classNames", Json.arr("cat"))), "training_class_index_out_of_range"), "类别越界被识别");

            // 孤标签必须显式报错。
            Path orphan = root.resolve("orphan");
            image(orphan.resolve("train"), "a.png", 0, "0 0.5 0.5 0.2 0.2\n");
            image(orphan.resolve("val"), "b.png", 1, "0 0.4 0.4 0.3 0.3\n");
            Files.writeString(orphan.resolve("val").resolve("labels").resolve("ghost.txt"), "0 0.5 0.5 0.2 0.2\n", StandardCharsets.UTF_8);
            EngineTest.check(hasCode(create(e, orphan, Json.obj("taskType", "detect", "classNames", Json.arr("cat"))), "training_label_orphan"), "孤标签被识别");

            // 空标签是显式无目标，可训练但必须有提示。
            Path empty = root.resolve("empty");
            image(empty.resolve("train"), "a.png", 0, "\n");
            image(empty.resolve("val"), "b.png", 1, "0 0.4 0.4 0.3 0.3\n");
            JsonObject emptyDataset = create(e, empty, Json.obj("taskType", "detect", "classNames", Json.arr("cat")));
            EngineTest.check(Json.str(emptyDataset, "status", "").equals("ready"), "空标签不阻断");
            EngineTest.check(hasCode(emptyDataset, "training_empty_label"), "空标签有提示");

            // 跨划分内容重复只是提示，不阻断。
            Path overlap = root.resolve("overlap");
            Files.createDirectories(overlap.resolve("train").resolve("images"));
            Files.createDirectories(overlap.resolve("train").resolve("labels"));
            Files.createDirectories(overlap.resolve("val").resolve("images"));
            Files.createDirectories(overlap.resolve("val").resolve("labels"));
            Path shared = overlap.resolve("source.png");
            Media.sample(shared, 2);
            for (String split : List.of("train", "val")) {
                Files.copy(shared, overlap.resolve(split).resolve("images").resolve("same.png"));
                Files.writeString(overlap.resolve(split).resolve("labels").resolve("same.txt"), "0 0.5 0.5 0.2 0.2\n", StandardCharsets.UTF_8);
            }
            JsonObject duplicated = create(e, overlap, Json.obj("taskType", "detect", "classNames", Json.arr("cat")));
            EngineTest.check(Json.str(duplicated, "status", "").equals("ready"), "跨集合重复不阻断");
            EngineTest.check(hasCode(duplicated, "training_split_overlap"), "跨集合重复有提示");

            // 任务类型与类别表无法判定时阻断。
            EngineTest.check(hasCode(create(e, base, new JsonObject()), "training_task_undetermined"), "任务类型无法判定时阻断");
            EngineTest.check(hasCode(create(e, base, Json.obj("taskType", "detect")), "training_classes_undetermined"), "类别表无法判定时阻断");
        }
    }

    private static void image(Path split, String name, int index, String label) throws Exception {
        Path images = split.resolve("images"), labels = split.resolve("labels");
        Files.createDirectories(images);
        Files.createDirectories(labels);
        Media.sample(images.resolve(name), index);
        if (label != null) Files.writeString(labels.resolve(stem(name) + ".txt"), label, StandardCharsets.UTF_8);
    }

    private static String stem(String name) { int dot = name.lastIndexOf('.'); return dot > 0 ? name.substring(0, dot) : name; }

    private static JsonObject create(Engine e, Path base, JsonObject extra) throws Exception {
        JsonObject payload = extra.deepCopy();
        payload.addProperty("source", "upload");
        payload.addProperty("trainDir", base.resolve("train").toString());
        payload.addProperty("valDir", base.resolve("val").toString());
        return EngineTest.command(e, "training.dataset.create", payload);
    }

    private static boolean hasCode(JsonObject dataset, String code) {
        for (JsonElement element : Json.array(Json.object(dataset, "inspection"), "issues")) {
            if (Json.str(element.getAsJsonObject(), "code", "").equals(code)) return true;
        }
        return false;
    }

    // ===== 参数边界 =====

    private static void parameterChecks(Path root) throws Exception {
        try (Engine e = new Engine(root.resolve("data"))) {
            Path base = root.resolve("healthy");
            image(base.resolve("train"), "a.png", 0, "0 0.5 0.5 0.2 0.2\n");
            image(base.resolve("val"), "b.png", 1, "0 0.4 0.4 0.3 0.3\n");
            JsonObject dataset = create(e, base, Json.obj("taskType", "detect", "classNames", Json.arr("cat")));
            String datasetId = Json.required(dataset, "id");
            EngineTest.error("training_parameter_invalid", guard(() -> preflight(e, datasetId, field("epochs", 0))));
            EngineTest.error("training_parameter_invalid", guard(() -> preflight(e, datasetId, field("learningRate", new JsonPrimitive(Double.NaN)))));
            EngineTest.error("training_parameter_invalid", guard(() -> preflight(e, datasetId, field("imgsz", 100))));
            EngineTest.error("training_parameter_invalid", guard(() -> preflight(e, datasetId, field("device", "gpu-2"))));
            EngineTest.error("training_parameter_unknown", guard(() -> preflight(e, datasetId, field("epoch", 10))));
            // 环境不可用时不猜测能力，直接给出可操作提示。
            JsonObject runtime = EngineTest.command(e, "training.runtime.get", new JsonObject());
            EngineTest.check(runtime.has("workerAvailable") && runtime.has("issue"), "环境探测返回可操作状态");
        }
    }

    private static JsonObject field(String key, Object value) {
        JsonObject parameters = new JsonObject();
        parameters.add(key, value instanceof JsonElement element ? element : Json.GSON.toJsonTree(value));
        return Json.obj("parameters", parameters);
    }

    /** EngineTest.error 只接受 Runnable，这里把受检异常转成非受检，ApiError 原样抛出以保留错误码断言。 */
    private static Runnable guard(Body body) {
        return () -> {
            try { body.run(); }
            catch (ApiError api) { throw api; }
            catch (Exception failure) { throw new AssertionError(failure); }
        };
    }
    private interface Body { void run() throws Exception; }

    private static void preflight(Engine e, String datasetId, JsonObject payload) throws Exception {
        JsonObject request = payload.deepCopy();
        request.addProperty("datasetId", datasetId);
        EngineTest.command(e, "training.job.preflight", request);
    }

    // ===== 路径 B：引用已完成的 AI 标注导出 =====

    private static void exportReference(Path root) throws Exception {
        Path data = root.resolve("data");
        try (Engine e = new Engine(data)) {
            JsonObject project = EngineTest.project(e, "detect");
            String projectId = Json.required(project, "id");
            JsonArray assets = EngineTest.importSamples(e, projectId, 3);
            for (JsonElement asset : assets) {
                EngineTest.command(e, "annotation.save", Json.obj("assetId", asset.getAsString(), "baseVersion", 0,
                    "annotations", Json.arr(EngineTest.label("detect")), "confirm", true));
            }
            // 默认导出格式即 YOLO + data.yaml；传部分 format 会被要求补全目录模板，这里不重复指定。
            JsonObject exported = EngineTest.command(e, "export.create", Json.obj("projectId", projectId,
                "outputDir", root.resolve("datasets").toString(), "trainRatio", 0.6));
            EngineTest.check(Json.str(exported, "status", "").equals("completed"), "导出完成");
            JsonObject dataset = EngineTest.command(e, "training.dataset.create", Json.obj("projectId", projectId,
                "source", "export", "exportId", Json.required(exported, "id")));
            EngineTest.check(Json.str(dataset, "status", "").equals("ready"), "导出可接入训练");
            EngineTest.check(Json.number(Json.object(Json.object(dataset, "inspection"), "summary"), "images", 0) == 3, "导出素材全部进入快照");
            Path directory = data.resolve("training").resolve("datasets").resolve(Json.required(dataset, "id"));
            JsonObject first = Json.array(dataset, "files").get(0).getAsJsonObject();
            EngineTest.check(Media.hash(directory.resolve(Json.required(first, "image"))).equals(Json.required(first, "hash")), "快照副本与导出哈希一致");
            String snapshotHash = Json.required(dataset, "snapshotHash");
            // 清单被外部改动后：既不能据此新建快照，已生成的快照仍可逐文件复核。
            Path manifest = Path.of(Json.required(exported, "manifestPath"));
            Files.writeString(manifest, Files.readString(manifest).replace("taskType", "taskType "), StandardCharsets.UTF_8);
            String exportId = Json.required(exported, "id");
            EngineTest.error("export_manifest_changed", guard(() -> EngineTest.command(e, "training.dataset.create",
                Json.obj("projectId", projectId, "source", "export", "exportId", exportId))));
            EngineTest.check(Json.required(EngineTest.command(e, "training.dataset.get", Json.obj("datasetId", Json.required(dataset, "id"))), "snapshotHash").equals(snapshotHash), "快照指纹不受源清单改动影响");
            for (JsonElement element : Json.array(dataset, "files")) {
                JsonObject file = element.getAsJsonObject();
                EngineTest.check(Media.hash(directory.resolve(Json.required(file, "image"))).equals(Json.required(file, "hash")), "快照仍可逐文件复核");
            }
        }
    }

    // ===== schema 8 → 9 迁移 =====

    private static void migration(Path data) throws Exception {
        try (Engine e = new Engine(data)) {
            JsonObject project = EngineTest.project(e, "detect");
            EngineTest.importSamples(e, Json.required(project, "id"), 2);
        }
        Path database = data.resolve("autolabel.db");
        try (Connection c = DriverManager.getConnection("jdbc:sqlite:" + database); Statement s = c.createStatement()) {
            for (String table : List.of("training_datasets", "training_jobs", "training_epochs", "training_artifacts")) s.execute("DROP TABLE IF EXISTS " + table);
            s.execute("PRAGMA user_version=8");
        }
        try (Engine e = new Engine(data)) {
            EngineTest.check(e.projects.list().size() == 1, "迁移后项目数量不变");
            EngineTest.check(Json.number(EngineTest.command(e, "training.dataset.list", new JsonObject()), "total", -1) == 0, "迁移后训练数据集表可用");
        }
        List<Path> backups = Files.list(data.resolve("backups")).filter(path -> path.getFileName().toString().contains("schema-v8")).toList();
        EngineTest.check(!backups.isEmpty(), "迁移前生成一致性备份");
        try (Connection c = DriverManager.getConnection("jdbc:sqlite:" + backups.getFirst()); Statement s = c.createStatement(); ResultSet r = s.executeQuery("PRAGMA integrity_check")) {
            EngineTest.check(r.next() && r.getString(1).equals("ok"), "迁移前备份通过完整性检查");
        }
    }
}
