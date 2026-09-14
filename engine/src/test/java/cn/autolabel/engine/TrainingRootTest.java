package cn.autolabel.engine;

import com.google.gson.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;

/**
 * 阶段 9 补记验收：训练产物目录可配置（设置页「默认产物目录」）与进度保留策略。
 * 覆盖缺省位置、自定义位置、配置不可用时的回退与原因上报、切换前固定历史记录、超期逐轮指标清理；
 * 全部使用本地合成夹具，不启动训练进程，也不发起任何外部请求。
 */
final class TrainingRootTest {
    private TrainingRootTest() {}

    static void run(Path root) throws Exception {
        defaults(root.resolve("default"));
        custom(root.resolve("custom"));
        fallback(root.resolve("fallback"));
        pinned(root.resolve("pinned"));
        retention(root.resolve("retention"));
    }

    // ===== 缺省：仍落在数据目录内的 training，既有行为不变 =====

    private static void defaults(Path dir) throws Exception {
        Path data = dir.resolve("data");
        try (Engine e = new Engine(data)) {
            Path expected = data.toAbsolutePath().normalize().resolve("training");
            EngineTest.check(e.store.trainingRoot.equals(expected), "缺省训练产物根仍是数据目录内的 training");
            EngineTest.check(e.store.trainingRootIssue == null, "缺省时没有回退原因");
            JsonObject dataset = dataset(e, dir.resolve("fixture"));
            Path snapshot = expected.resolve("datasets").resolve(Json.required(dataset, "id"));
            EngineTest.check(Files.isRegularFile(snapshot.resolve("data.yaml")), "快照落在缺省产物根");
            JsonObject status = EngineTest.command(e, "training.root.status");
            EngineTest.check(!Json.bool(status, "custom", true), "状态报告为默认位置");
            EngineTest.check(Json.required(status, "actualPath").equals(e.store.trainingRoot.toString()), "状态里的实际目录与引擎一致");
            EngineTest.check(Json.required(status, "defaultPath").equals(expected.toString()), "状态带出默认目录");
            EngineTest.check(Json.number(status, "datasets", 0) == 1, "状态统计数据集数量");
            EngineTest.check(Json.number(status, "files", 0) > 0, "状态统计产物占用");
            // 没有固定目录的历史任务按当前产物根解析。
            String jobId = insertJob(e, Json.required(dataset, "id"), null, "succeeded", Json.now());
            Path log = expected.resolve(jobId).resolve("train.log");
            Files.createDirectories(log.getParent());
            Files.writeString(log, "epoch 1/2\n", StandardCharsets.UTF_8);
            JsonObject tail = EngineTest.command(e, "training.job.log", Json.obj("jobId", jobId));
            EngineTest.check(Json.bool(tail, "available", false) && Json.required(tail, "log").contains("epoch 1/2"), "未固定目录的任务按当前产物根读取日志");
        }
    }

    // ===== 自定义：写入外部目录，数据目录内不再产生训练文件 =====

    private static void custom(Path dir) throws Exception {
        Path data = dir.resolve("data"), artifacts = dir.resolve("artifacts");
        try (Engine e = new Engine(data, Json.obj("trainingRoot", artifacts.toString()))) {
            Path expected = artifacts.toAbsolutePath().normalize();
            EngineTest.check(e.store.trainingRoot.equals(expected), "启动参数里的训练产物根生效");
            EngineTest.check(e.store.trainingRootIssue == null, "可用配置不留回退原因");
            JsonObject dataset = dataset(e, dir.resolve("fixture"));
            Path snapshot = expected.resolve("datasets").resolve(Json.required(dataset, "id"));
            EngineTest.check(Files.isRegularFile(snapshot.resolve("data.yaml")), "快照落在自定义产物根");
            EngineTest.check(!snapshot.startsWith(e.store.root), "自定义产物根位于数据目录之外");
            EngineTest.check(!Files.exists(data.resolve("training")), "数据目录内不再产生训练快照");
            JsonObject status = EngineTest.command(e, "training.root.status");
            EngineTest.check(Json.bool(status, "custom", false), "状态报告为自定义位置");
            EngineTest.check(Json.number(status, "bytes", 0) > 0, "状态统计自定义目录占用");
            EngineTest.check(Json.number(status, "unpinned", 0) == 0, "新建数据集已固定目录");
        }
    }

    // ===== 配置不可用：回退到缺省位置并把原因带出来，不静默使用别的目录 =====

    private static void fallback(Path dir) throws Exception {
        Path data = dir.resolve("data"), expected = data.toAbsolutePath().normalize().resolve("training");
        for (String value : List.of("relative/artifacts", data.toString(), dir.toString(), data.toAbsolutePath().getRoot().toString())) {
            try (Engine e = new Engine(data, Json.obj("trainingRoot", value))) {
                EngineTest.check(e.store.trainingRoot.equals(expected), "无效训练产物目录回退到缺省位置：" + value);
                EngineTest.check(e.store.trainingRootIssue != null && !e.store.trainingRootIssue.isBlank(), "回退时如实记录原因：" + value);
                JsonObject status = EngineTest.command(e, "training.root.status");
                EngineTest.check(Json.required(status, "actualPath").equals(expected.toString()), "回退后实际目录为缺省位置：" + value);
                EngineTest.check(status.has("fallbackReason"), "状态里带出回退原因：" + value);
            }
        }
    }

    // ===== 固定：切换产物根前把历史记录钉在原目录，切换后仍能读取与清理 =====

    private static void pinned(Path dir) throws Exception {
        Path data = dir.resolve("data"), artifacts = dir.resolve("artifacts"), original = data.resolve("training");
        String datasetId, jobId;
        try (Engine e = new Engine(data)) {
            JsonObject dataset = dataset(e, dir.resolve("fixture"));
            datasetId = Json.required(dataset, "id");
            // 模拟升级前的历史记录：没有固定目录字段。
            dropDatasetField(e, datasetId, "snapshotDir");
            jobId = insertJob(e, datasetId, null, "succeeded", Json.now());
            EngineTest.check(Json.number(EngineTest.command(e, "training.root.status"), "unpinned", 0) == 2, "未固定的任务与数据集被统计");
            JsonObject pinned = EngineTest.command(e, "training.root.pin");
            EngineTest.check(Json.number(pinned, "datasets", 0) == 1 && Json.number(pinned, "jobs", 0) == 1, "固定动作覆盖数据集与任务");
            EngineTest.check(Json.number(EngineTest.command(e, "training.root.status"), "unpinned", 1) == 0, "固定后不再有待固定记录");
            EngineTest.check(datasetValue(e, datasetId, "snapshotDir").equals(original.resolve("datasets").resolve(datasetId).toString()), "数据集固定在原快照目录");
            EngineTest.check(jobValue(e, jobId, "artifactsDir").equals(original.resolve(jobId).toString()), "任务固定在原产物目录");
            EngineTest.check(Json.number(EngineTest.command(e, "training.root.pin"), "jobs", 1) == 0, "重复固定不重复写入");
        }
        try (Engine e = new Engine(data, Json.obj("trainingRoot", artifacts.toString()))) {
            EngineTest.check(datasetValue(e, datasetId, "snapshotDir").equals(original.resolve("datasets").resolve(datasetId).toString()), "切换产物根不改写历史记录");
            EngineTest.check(Files.isRegularFile(original.resolve("datasets").resolve(datasetId).resolve("data.yaml")), "历史快照文件仍在原目录");
            Path log = original.resolve(jobId).resolve("train.log");
            Files.createDirectories(log.getParent());
            Files.writeString(log, "pinned log\n", StandardCharsets.UTF_8);
            JsonObject tail = EngineTest.command(e, "training.job.log", Json.obj("jobId", jobId));
            EngineTest.check(Json.bool(tail, "available", false) && Json.required(tail, "log").contains("pinned log"), "切换后按记录里的目录读取任务日志");
            // 删除必须清掉记录里那个目录，而不是新产物根下的同名目录。
            EngineTest.command(e, "training.job.delete", Json.obj("jobId", jobId, "confirm", true));
            EngineTest.check(!Files.exists(original.resolve(jobId)), "删除任务清理记录里的原目录");
            EngineTest.check(!Files.exists(artifacts.resolve(jobId)), "新产物根下不产生来路不明的目录");
        }
    }

    // ===== 进度保留：只清理超期的逐轮指标，产物与日志保留 =====

    private static void retention(Path dir) throws Exception {
        Path data = dir.resolve("data");
        String jobId;
        try (Engine e = new Engine(data)) {
            JsonObject dataset = dataset(e, dir.resolve("fixture"));
            jobId = insertJob(e, Json.required(dataset, "id"), null, "succeeded", Json.now());
            insertEpoch(e, jobId, 1);
            insertEpoch(e, jobId, 2);
            Path weights = e.store.trainingRoot.resolve(jobId).resolve("weights");
            Files.createDirectories(weights);
            Files.writeString(weights.resolve("best.pt"), "weights", StandardCharsets.UTF_8);
            EngineTest.check(EngineTest.command(e, "training.job.metrics", Json.obj("jobId", jobId)).getAsJsonArray("items").size() == 2, "先写入两轮真实指标");
            EngineTest.command(e, "settings.save", Json.obj("settings", Json.obj("trainingRetentionDays", 1)));
            age(e, jobId, 2);
        }
        try (Engine e = new Engine(data)) {
            EngineTest.check(EngineTest.command(e, "training.job.metrics", Json.obj("jobId", jobId)).getAsJsonArray("items").size() == 0, "超期逐轮指标按保留策略清理");
            JsonObject job = EngineTest.command(e, "training.job.get", Json.obj("jobId", jobId));
            EngineTest.check(job.has("metricsPrunedAt"), "任务记录说明指标已按保留策略清理");
            EngineTest.check(Json.number(job, "metricsRetentionDays", 0) == 1, "记录保留当时的天数设置");
            EngineTest.check(Json.str(job, "status", "").equals("succeeded"), "清理指标不改写任务状态");
            EngineTest.check(Files.isRegularFile(e.store.trainingRoot.resolve(jobId).resolve("weights").resolve("best.pt")), "权重文件不随指标清理删除");
            EngineTest.check(Json.number(EngineTest.command(e, "training.root.status"), "files", 0) > 0, "产物仍计入占用");
        }
        // 关闭保留策略后不再重复清理标记。
        try (Engine e = new Engine(data)) {
            EngineTest.command(e, "settings.save", Json.obj("settings", Json.obj("trainingRetentionDays", 0)));
        }
        try (Engine e = new Engine(data)) {
            EngineTest.check(jobNumber(e, jobId, "metricsRetentionDays") == 1, "设置为 0 时不改写已清理记录里的保留天数");
            EngineTest.check(EngineTest.command(e, "training.job.get", Json.obj("jobId", jobId)).has("metricsPrunedAt"), "已清理的说明保留在任务记录里");
        }
    }

    // ===== 夹具与断言辅助 =====

    private static JsonObject dataset(Engine e, Path base) throws Exception {
        library(base.resolve("train"), "a.png", 0, "0 0.5 0.5 0.2 0.2\n");
        library(base.resolve("val"), "b.png", 1, "0 0.4 0.4 0.3 0.3\n");
        JsonObject created = EngineTest.command(e, "training.dataset.create", Json.obj("source", "upload",
            "trainDir", base.resolve("train").toString(), "valDir", base.resolve("val").toString(),
            "taskType", "detect", "classNames", Json.arr("cat")));
        EngineTest.check(Json.str(created, "status", "").equals("ready"), "训练数据集快照可用");
        return created;
    }

    private static void library(Path split, String name, int index, String label) throws Exception {
        Path images = split.resolve("images"), labels = split.resolve("labels");
        Files.createDirectories(images);
        Files.createDirectories(labels);
        Media.sample(images.resolve(name), index);
        Files.writeString(labels.resolve(name.substring(0, name.lastIndexOf('.')) + ".txt"), label, StandardCharsets.UTF_8);
    }

    private static String insertJob(Engine e, String datasetId, String artifactsDir, String status, String updatedAt) throws Exception {
        String id = Json.id(), now = Json.now();
        JsonObject data = Json.obj("id", id, "datasetId", datasetId, "taskType", "detect", "status", status, "stage", "finished",
            "device", "cpu", "createdAt", now, "updatedAt", updatedAt, "classNames", Json.arr("cat"), "keypointNames", Json.arr(),
            "parameters", Json.obj(), "epochs", 2, "completedEpochs", 2);
        if (artifactsDir != null) data.addProperty("artifactsDir", artifactsDir);
        e.store.tx(c -> {
            Store.update(c, "INSERT INTO training_jobs(id,dataset_id,project_id,status,device,created_at,updated_at,data) VALUES(?,?,?,?,?,?,?,?)",
                id, datasetId, null, status, "cpu", now, updatedAt, data);
            return null;
        });
        return id;
    }

    private static void insertEpoch(Engine e, String jobId, int epoch) throws Exception {
        JsonObject data = Json.obj("jobId", jobId, "epoch", epoch, "epochs", 2, "elapsedMs", 1000,
            "metrics", Json.obj("mAP50", 0.1, "mAP50_95", 0.05, "precision", 0.2, "recall", 0.3, "boxLoss", 1.0, "clsLoss", 0.5));
        e.store.tx(c -> {
            Store.update(c, "INSERT INTO training_epochs(job_id,epoch,data) VALUES(?,?,?)", jobId, epoch, data);
            return null;
        });
    }

    private static void age(Engine e, String jobId, int days) throws Exception {
        String old = Instant.now().minus(days, ChronoUnit.DAYS).toString();
        e.store.tx(c -> {
            Store.update(c, "UPDATE training_jobs SET updated_at=? WHERE id=?", old, jobId);
            return null;
        });
    }

    /** 任务与数据集记录的业务字段都在 data 列的记录根上（snapshotDir/artifactsDir 同层），直接从根上摘除即可模拟升级前的历史记录。 */
    private static void dropDatasetField(Engine e, String datasetId, String field) throws Exception {
        e.store.tx(c -> {
            JsonObject record = Store.document(c, "training_datasets", datasetId);
            record.remove(field);
            Store.update(c, "UPDATE training_datasets SET data=? WHERE id=?", record, datasetId);
            return null;
        });
    }

    private static String jobValue(Engine e, String jobId, String field) {
        return e.store.read(c -> Json.str(Store.document(c, "training_jobs", jobId), field, ""));
    }

    private static String datasetValue(Engine e, String datasetId, String field) {
        return e.store.read(c -> Json.str(Store.document(c, "training_datasets", datasetId), field, ""));
    }

    private static long jobNumber(Engine e, String jobId, String field) {
        Long value = e.store.read(c -> Json.number(Store.document(c, "training_jobs", jobId), field, 0L));
        return value == null ? 0 : value;
    }
}
