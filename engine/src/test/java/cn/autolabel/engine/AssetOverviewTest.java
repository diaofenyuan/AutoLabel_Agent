package cn.autolabel.engine;

import com.google.gson.*;
import java.nio.file.Path;
import java.sql.Connection;
import java.util.*;

/** 项目概览状态筛选、整项目计数及跨页 ID 读取的本地夹具验收。 */
final class AssetOverviewTest {
    private AssetOverviewTest() {}

    static void run(Path root) throws Exception {
        try (Engine e = new Engine(root.resolve("data"))) {
            String projectId = Json.required(EngineTest.project(e, "detect"), "id");
            JsonArray ids = EngineTest.importSamples(e, projectId, 8);
            String confirmed = id(ids, 0), candidate = id(ids, 1), empty = id(ids, 2);
            String failed = id(ids, 3), unknown = id(ids, 4), unlabeled = id(ids, 5);
            String other = id(ids, 6), outsideWindow = id(ids, 7);
            setAsset(e, confirmed, "confirmed", true);
            setAsset(e, candidate, "candidate", true);
            setAsset(e, empty, "candidate", false);
            setAsset(e, failed, "candidate", true);
            setAsset(e, unknown, "candidate", false);
            setAsset(e, unlabeled, "unlabeled", false);
            setAsset(e, other, "modified", true);
            setAsset(e, outsideWindow, "candidate", true);

            String[] runs = insertRuns(e, projectId, 21);
            e.store.tx(c -> {
                sample(c, runs[20], confirmed, "failed");
                sample(c, runs[20], candidate, "succeeded");
                sample(c, runs[20], empty, "succeeded");
                sample(c, runs[19], failed, "succeeded");
                sample(c, runs[20], failed, "failed");
                sample(c, runs[20], unknown, "unknown");
                sample(c, runs[0], outsideWindow, "failed");
                sample(c, runs[20], outsideWindow, "succeeded");
                return null;
            });

            JsonObject first = EngineTest.command(e, "asset.list", Json.obj("projectId", projectId, "limit", 3));
            check(Json.integer(first, "total", -1) == 8 && Json.array(first, "items").size() == 3, "素材分页返回整项目总数和当前页");
            check(assetId(Json.array(first, "items"), 0).equals(id(ids, 0)) && assetId(Json.array(first, "items"), 2).equals(id(ids, 2)), "素材页按导入顺序稳定分页");
            JsonObject second = EngineTest.command(e, "asset.list", Json.obj("projectId", projectId, "offset", 3, "limit", 3));
            check(Json.array(second, "items").size() == 3 && !assetId(Json.array(first, "items"), 2).equals(assetId(Json.array(second, "items"), 0)), "相邻素材页不重叠");

            JsonObject counts = Json.object(first, "filterCounts");
            check(Json.integer(counts, "all", -1) == 8 && Json.integer(counts, "candidate", -1) == 2
                && Json.integer(counts, "empty", -1) == 1 && Json.integer(counts, "failed", -1) == 2
                && Json.integer(counts, "confirmed", -1) == 1 && Json.integer(counts, "unlabeled", -1) == 1
                && Json.integer(counts, "other", -1) == 1, "全项目筛选计数覆盖各结果状态");
            JsonObject rawCounts = Json.object(first, "statusCounts");
            check(Json.integer(rawCounts, "candidate", -1) == 5 && Json.integer(rawCounts, "confirmed", -1) == 1
                && Json.integer(rawCounts, "unlabeled", -1) == 1 && Json.integer(rawCounts, "modified", -1) == 1, "原始素材状态计数也按全项目统计");

            JsonObject failedPage = EngineTest.command(e, "asset.list", Json.obj("projectId", projectId, "resultFilter", "failed", "limit", 10));
            check(Json.integer(failedPage, "total", -1) == 2 && hasState(failedPage, failed, "failed") && hasState(failedPage, unknown, "failed"), "failed 与 unknown 样本都筛为失败");
            check(hasState(EngineTest.command(e, "asset.list", Json.obj("projectId", projectId, "assetIds", Json.arr(confirmed))), confirmed, "confirmed"), "人工确认优先于最近运行失败");
            check(Json.integer(EngineTest.command(e, "asset.list", Json.obj("projectId", projectId, "resultFilter", "candidate")), "total", -1) == 2,
                "最近 20 次以外的失败不会覆盖较新的成功样本");

            JsonObject page0 = EngineTest.command(e, "asset.listIds", Json.obj("projectId", projectId, "resultFilter", "failed", "limit", 1));
            JsonObject page1 = EngineTest.command(e, "asset.listIds", Json.obj("projectId", projectId, "resultFilter", "failed", "offset", 1, "limit", 1));
            check(Json.integer(page0, "total", -1) == 2 && Json.integer(page1, "total", -1) == 2
                && !id(Json.array(page0, "ids"), 0).equals(id(Json.array(page1, "ids"), 0)), "asset.listIds 返回完整筛选总数并支持无重叠分页");
            JsonObject allIds = EngineTest.command(e, "asset.listIds", Json.obj("projectId", projectId, "limit", 500));
            check(Json.array(allIds, "ids").size() == 8 && Json.integer(allIds, "total", -1) == 8, "全选 ID 覆盖项目全部素材");
            EngineTest.error("asset_result_filter_invalid", () -> e.projects.listAssetIds(Json.obj("projectId", projectId, "resultFilter", "invalid")));
        }
    }

    private static String id(JsonArray values, int index) { return values.get(index).getAsString(); }
    private static String assetId(JsonArray values, int index) { return Json.required(values.get(index).getAsJsonObject(), "id"); }
    private static boolean hasState(JsonObject page, String assetId, String state) {
        for (JsonElement item : Json.array(page, "items")) {
            JsonObject asset = item.getAsJsonObject();
            if (Json.required(asset, "id").equals(assetId)) return Json.required(asset, "resultState").equals(state);
        }
        return false;
    }
    private static void check(boolean value, String message) { EngineTest.check(value, message); }

    private static void setAsset(Engine e, String id, String status, boolean annotated) {
        e.store.tx(c -> {
            JsonObject asset = Store.document(c, "assets", id);
            asset.addProperty("status", status);
            asset.add("annotations", annotated ? Json.arr(Json.obj("id", "fixture")) : new JsonArray());
            Store.update(c, "UPDATE assets SET data=? WHERE id=?", asset, id);
            return null;
        });
    }
    private static String[] insertRuns(Engine e, String projectId, int count) {
        return e.store.tx(c -> {
            String[] ids = new String[count];
            for (int i = 0; i < count; i++) {
                String id = Json.id();
                String createdAt = String.format(Locale.ROOT, "2026-09-01T00:00:%02dZ", i);
                JsonObject run = Json.obj("id", id, "projectId", projectId, "status", "completed", "createdAt", createdAt);
                Store.update(c, "INSERT INTO runs(id,project_id,status,data) VALUES(?,?,?,?)", id, projectId, "completed", run);
                ids[i] = id;
            }
            return ids;
        });
    }
    private static void sample(Connection c, String runId, String assetId, String status) throws Exception {
        String id = Json.id();
        Store.update(c, "INSERT INTO samples(id,run_id,asset_id,input_id,status,data) VALUES(?,?,?,?,?,?)",
            id, runId, assetId, assetId, status, Json.obj("id", id, "assetId", assetId, "status", status));
    }
}
