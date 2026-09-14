package cn.autolabel.engine;

import com.google.gson.*;
import java.nio.file.*;
import java.sql.Connection;
import java.util.*;
import java.util.stream.Stream;

/**
 * 项目删除。SQLite 已启用外键，子表必须按依赖反向显式删除；
 * 磁盘文件只删除能被数据库记录确认属于该项目的受管文件，外部导出目录一律保留。
 */
final class ProjectDeletion {
    private static final Set<String> ACTIVE_TASK=Set.of("queued","running","pausing","paused","cancelling");
    private static final Set<String> ACTIVE_MEDIA=Set.of("queued","running","cancelling");
    private final Engine engine;private final Store store;

    ProjectDeletion(Engine engine){this.engine=engine;this.store=engine.store;}

    private static final String ASSETS="SELECT id FROM assets WHERE project_id=?";
    private static final String RUNS="SELECT id FROM runs WHERE project_id=?";
    private static final String FLOWS="SELECT id FROM flow_runs WHERE project_id=?";
    private static final String SETS="SELECT id FROM evaluation_sets WHERE project_id=?";
    private static final String EVALUATIONS="SELECT id FROM evaluations WHERE project_id=?";
    private static final String TIMELINES="SELECT id FROM track_timelines WHERE project_id=?";
    private static final String TRACKS="SELECT id FROM tracks WHERE timeline_id IN ("+TIMELINES+")";
    private static final String GENERATIONS="SELECT id FROM track_generations WHERE track_id IN ("+TRACKS+")";

    private static long count(Connection c,String sql,Object... args)throws Exception{
        JsonObject row=Store.one(c,sql,args);
        return row==null||row.get("n").isJsonNull()?0L:row.get("n").getAsLong();
    }

    JsonObject preflight(JsonObject p)throws Exception{
        String pid=Json.required(p,"projectId");
        return store.read(c->{
            JsonObject project=engine.projects.project(c,pid);
            JsonObject counts=new JsonObject();
            counts.addProperty("assets",count(c,"SELECT COUNT(*) AS n FROM assets WHERE project_id=?",pid));
            counts.addProperty("versions",count(c,"SELECT COUNT(*) AS n FROM versions WHERE asset_id IN ("+ASSETS+")",pid));
            counts.addProperty("drafts",count(c,"SELECT COUNT(*) AS n FROM drafts WHERE asset_id IN ("+ASSETS+")",pid));
            counts.addProperty("runs",count(c,"SELECT COUNT(*) AS n FROM runs WHERE project_id=?",pid));
            counts.addProperty("samples",count(c,"SELECT COUNT(*) AS n FROM samples WHERE run_id IN ("+RUNS+")",pid));
            counts.addProperty("attempts",count(c,"SELECT COUNT(*) AS n FROM attempts WHERE run_id IN ("+RUNS+")",pid));
            counts.addProperty("exports",count(c,"SELECT COUNT(*) AS n FROM exports WHERE project_id=?",pid));
            counts.addProperty("flowRuns",count(c,"SELECT COUNT(*) AS n FROM flow_runs WHERE project_id=?",pid));
            counts.addProperty("flowSteps",count(c,"SELECT COUNT(*) AS n FROM flow_steps WHERE flow_run_id IN ("+FLOWS+")",pid));
            counts.addProperty("flowArtifacts",count(c,"SELECT COUNT(*) AS n FROM flow_artifacts WHERE project_id=?",pid));
            counts.addProperty("mediaJobs",count(c,"SELECT COUNT(*) AS n FROM media_jobs WHERE project_id=?",pid));
            counts.addProperty("timelines",count(c,"SELECT COUNT(*) AS n FROM track_timelines WHERE project_id=?",pid));
            counts.addProperty("timelineFrames",count(c,"SELECT COUNT(*) AS n FROM timeline_frames WHERE timeline_id IN ("+TIMELINES+")",pid));
            counts.addProperty("tracks",count(c,"SELECT COUNT(*) AS n FROM tracks WHERE timeline_id IN ("+TIMELINES+")",pid));
            counts.addProperty("generations",count(c,"SELECT COUNT(*) AS n FROM track_generations WHERE track_id IN ("+TRACKS+")",pid));
            counts.addProperty("evaluationSets",count(c,"SELECT COUNT(*) AS n FROM evaluation_sets WHERE project_id=?",pid));
            counts.addProperty("evaluationSetVersions",count(c,"SELECT COUNT(*) AS n FROM evaluation_set_versions WHERE set_id IN ("+SETS+")",pid));
            counts.addProperty("truthVersions",count(c,"SELECT COUNT(*) AS n FROM truth_versions WHERE set_id IN ("+SETS+")",pid));
            counts.addProperty("evaluations",count(c,"SELECT COUNT(*) AS n FROM evaluations WHERE project_id=?",pid));
            counts.addProperty("evaluationResults",count(c,"SELECT COUNT(*) AS n FROM evaluation_results WHERE evaluation_id IN ("+EVALUATIONS+")",pid));
            counts.addProperty("reviewItems",count(c,"SELECT COUNT(*) AS n FROM review_items WHERE project_id=?",pid));
            counts.addProperty("reviewSamples",count(c,"SELECT COUNT(*) AS n FROM review_samples WHERE project_id=?",pid));
            counts.addProperty("trainingDatasets",count(c,"SELECT COUNT(*) AS n FROM training_datasets WHERE project_id=?",pid));
            counts.addProperty("trainingJobs",count(c,"SELECT COUNT(*) AS n FROM training_jobs WHERE project_id=?",pid));
            long managedBytes=0;
            for(Path file:managedFiles(c,pid)){try{managedBytes+=Files.size(file);}catch(Exception ignored){/* 枚举与统计之间文件被移走时按 0 计。 */}}
            JsonArray external=new JsonArray();
            for(String path:externalExportPaths(c,pid))external.add(path);
            return Json.obj("projectId",pid,"name",project.get("name"),"counts",counts,"managedBytes",managedBytes,
                "externalExportPaths",external,"blockers",blockers(c,pid));
        });
    }

    private static JsonArray blockers(Connection c,String pid)throws Exception{
        JsonArray blockers=new JsonArray();Set<String> kinds=new LinkedHashSet<>();
        for(JsonObject row:Store.rows(c,"SELECT status FROM runs WHERE project_id=?",pid))
            if(ACTIVE_TASK.contains(Json.str(row,"status",""))&&kinds.add("run"))blockers.add(Json.obj("kind","run","message","还有标注任务正在执行，请等待结束或先取消。"));
        for(JsonObject row:Store.rows(c,"SELECT status FROM flow_runs WHERE project_id=?",pid))
            if(ACTIVE_TASK.contains(Json.str(row,"status",""))&&kinds.add("flowRun"))blockers.add(Json.obj("kind","flowRun","message","还有流程正在执行，请等待结束或先取消。"));
        for(JsonObject row:Store.rows(c,"SELECT status FROM media_jobs WHERE project_id=?",pid))
            if(ACTIVE_MEDIA.contains(Json.str(row,"status",""))&&kinds.add("mediaJob"))blockers.add(Json.obj("kind","mediaJob","message","还有素材处理任务正在执行，请等待结束或先取消。"));
        for(JsonObject row:Store.rows(c,"SELECT status FROM track_generations WHERE track_id IN ("+TRACKS+")",pid))
            if(ACTIVE_TASK.contains(Json.str(row,"status",""))&&kinds.add("trackGeneration"))blockers.add(Json.obj("kind","trackGeneration","message","还有轨迹生成任务正在执行，请等待结束或先取消。"));
        for(JsonObject row:Store.rows(c,"SELECT status FROM training_jobs WHERE project_id=?",pid))
            if(ACTIVE_TASK.contains(Json.str(row,"status",""))&&kinds.add("trainingJob"))blockers.add(Json.obj("kind","trainingJob","message","还有模型训练任务正在执行，请等待结束或先取消。"));
        for(JsonObject row:Store.rows(c,"SELECT data FROM exports WHERE project_id=?",pid)){
            if(!Json.str(Json.parse(Json.required(row,"data")),"status","").equals("writing"))continue;
            if(kinds.add("export"))blockers.add(Json.obj("kind","export","message","还有导出任务正在写入，请等待结束。"));
        }
        return blockers;
    }

    JsonObject delete(JsonObject p)throws Exception{
        String pid=Json.required(p,"projectId");
        String confirm=Json.str(p,"confirmName","");
        boolean removeManaged=Json.bool(p,"removeManagedFiles",false);
        List<Path> files=new ArrayList<>();
        List<String> external=new ArrayList<>();
        JsonObject summary=store.tx(c->{
            JsonObject row=Store.one(c,"SELECT data FROM projects WHERE id=?",pid);
            // 重复删除返回 not_found，不产生半删除状态。
            if(row==null)throw new ApiError(404,"project_not_found","项目不存在或已删除。");
            JsonObject project=Json.parse(Json.required(row,"data"));
            String name=Json.str(project,"name","");
            if(!name.equals(confirm))throw new ApiError(409,"project_confirm_mismatch","项目名称输入不一致，未执行删除。");
            JsonArray blockers=blockers(c,pid);
            if(!blockers.isEmpty())throw new ApiError(409,"project_delete_blocked","项目仍有进行中的任务，请先结束或取消。");
            if(removeManaged)files.addAll(managedFiles(c,pid));
            external.addAll(externalExportPaths(c,pid));
            JsonObject counts=cascade(c,pid);
            Store.update(c,"DELETE FROM projects WHERE id=?",pid);
            Store.event(c,"project.deleted",null,null,null,Json.obj("projectId",pid,"counts",counts,
                "managedFiles",files.size(),"externalExportPaths",external.size()));
            return Json.obj("projectId",pid,"name",name,"counts",counts);
        });
        // 文件删除必须在数据库提交之后：事务回滚无法恢复已删除的磁盘文件。
        int removedFiles=0;long removedBytes=0;JsonArray failures=new JsonArray();
        List<Path> ordered=new ArrayList<>(files);
        ordered.sort(Comparator.comparingInt((Path value)->value.toString().length()).reversed());
        for(Path file:ordered){
            long size=0;try{size=Files.isRegularFile(file)?Files.size(file):0;}catch(Exception ignored){}
            try{Files.deleteIfExists(file);removedFiles++;removedBytes+=size;}
            catch(Exception e){failures.add(Json.obj("path",file.toString(),"message","受管文件删除失败，请手动清理。"));}
        }
        if(removeManaged)for(String directory:managedDirectories(pid))pruneEmpty(Path.of(directory));
        JsonArray externalPaths=new JsonArray();for(String path:external)externalPaths.add(path);
        return Json.obj("deleted",true,"projectId",summary.get("projectId"),"name",summary.get("name"),"counts",summary.get("counts"),
            "removedFiles",removedFiles,"removedBytes",removedBytes,"fileFailures",failures,"externalExportPaths",externalPaths);
    }

    /** 反向级联：子表先于父表，且只影响当前项目。 */
    private JsonObject cascade(Connection c,String pid)throws Exception{
        JsonObject counts=new JsonObject();
        counts.addProperty("flowArtifactItems",Store.update(c,"DELETE FROM flow_artifact_items WHERE artifact_id IN (SELECT id FROM flow_artifacts WHERE project_id=?)",pid));
        counts.addProperty("flowArtifacts",Store.update(c,"DELETE FROM flow_artifacts WHERE project_id=?",pid));
        counts.addProperty("flowSteps",Store.update(c,"DELETE FROM flow_steps WHERE flow_run_id IN ("+FLOWS+")",pid));
        counts.addProperty("flowRuns",Store.update(c,"DELETE FROM flow_runs WHERE project_id=?",pid));
        counts.addProperty("trackGenerationPlans",Store.update(c,"DELETE FROM track_generation_plans WHERE generation_id IN ("+GENERATIONS+")",pid));
        counts.addProperty("trackContributionHeads",Store.update(c,"DELETE FROM track_contribution_heads WHERE track_id IN ("+TRACKS+")",pid));
        counts.addProperty("trackDirtyFrames",Store.update(c,"DELETE FROM track_dirty_frames WHERE track_id IN ("+TRACKS+")",pid));
        counts.addProperty("trackContributions",Store.update(c,"DELETE FROM track_contributions WHERE generation_id IN ("+GENERATIONS+")",pid));
        counts.addProperty("trackGenerationFrames",Store.update(c,"DELETE FROM track_generation_frames WHERE generation_id IN ("+GENERATIONS+")",pid));
        counts.addProperty("trackGenerations",Store.update(c,"DELETE FROM track_generations WHERE track_id IN ("+TRACKS+")",pid));
        counts.addProperty("trackVersions",Store.update(c,"DELETE FROM track_versions WHERE track_id IN ("+TRACKS+")",pid));
        counts.addProperty("tracks",Store.update(c,"DELETE FROM tracks WHERE timeline_id IN ("+TIMELINES+")",pid));
        counts.addProperty("localTrackingCandidates",Store.update(c,"DELETE FROM local_tracking_candidates WHERE timeline_id IN ("+TIMELINES+")",pid));
        counts.addProperty("timelineFrames",Store.update(c,"DELETE FROM timeline_frames WHERE timeline_id IN ("+TIMELINES+")",pid));
        counts.addProperty("timelines",Store.update(c,"DELETE FROM track_timelines WHERE project_id=?",pid));
        counts.addProperty("trainingArtifacts",Store.update(c,"DELETE FROM training_artifacts WHERE job_id IN (SELECT id FROM training_jobs WHERE project_id=?)",pid));
        counts.addProperty("trainingEpochs",Store.update(c,"DELETE FROM training_epochs WHERE job_id IN (SELECT id FROM training_jobs WHERE project_id=?)",pid));
        counts.addProperty("trainingJobs",Store.update(c,"DELETE FROM training_jobs WHERE project_id=?",pid));
        counts.addProperty("trainingDatasets",Store.update(c,"DELETE FROM training_datasets WHERE project_id=?",pid));
        counts.addProperty("evaluationResults",Store.update(c,"DELETE FROM evaluation_results WHERE evaluation_id IN ("+EVALUATIONS+")",pid));
        counts.addProperty("evaluations",Store.update(c,"DELETE FROM evaluations WHERE project_id=?",pid));
        counts.addProperty("truthVersions",Store.update(c,"DELETE FROM truth_versions WHERE set_id IN ("+SETS+")",pid));
        counts.addProperty("evaluationSetVersions",Store.update(c,"DELETE FROM evaluation_set_versions WHERE set_id IN ("+SETS+")",pid));
        counts.addProperty("evaluationSets",Store.update(c,"DELETE FROM evaluation_sets WHERE project_id=?",pid));
        counts.addProperty("reviewItems",Store.update(c,"DELETE FROM review_items WHERE project_id=?",pid));
        counts.addProperty("reviewSamples",Store.update(c,"DELETE FROM review_samples WHERE project_id=?",pid));
        counts.addProperty("inputResults",Store.update(c,"DELETE FROM input_results WHERE run_id IN ("+RUNS+")",pid));
        counts.addProperty("runAssetResults",Store.update(c,"DELETE FROM run_asset_results WHERE run_id IN ("+RUNS+")",pid));
        counts.addProperty("runBaselines",Store.update(c,"DELETE FROM run_baselines WHERE run_id IN ("+RUNS+")",pid));
        counts.addProperty("samples",Store.update(c,"DELETE FROM samples WHERE run_id IN ("+RUNS+")",pid));
        counts.addProperty("attempts",Store.update(c,"DELETE FROM attempts WHERE run_id IN ("+RUNS+")",pid));
        counts.addProperty("runs",Store.update(c,"DELETE FROM runs WHERE project_id=?",pid));
        counts.addProperty("mediaJobs",Store.update(c,"DELETE FROM media_jobs WHERE project_id=?",pid));
        // video_sources 与 screening_features 按内容寻址并被多项目复用，不属于项目数据，不随项目删除。
        counts.addProperty("drafts",Store.update(c,"DELETE FROM drafts WHERE asset_id IN ("+ASSETS+")",pid));
        counts.addProperty("versions",Store.update(c,"DELETE FROM versions WHERE asset_id IN ("+ASSETS+")",pid));
        counts.addProperty("assets",Store.update(c,"DELETE FROM assets WHERE project_id=?",pid));
        counts.addProperty("exports",Store.update(c,"DELETE FROM exports WHERE project_id=?",pid));
        return counts;
    }

    private List<String> externalExportPaths(Connection c,String pid)throws Exception{
        List<String> result=new ArrayList<>();
        for(JsonObject row:Store.rows(c,"SELECT data FROM exports WHERE project_id=?",pid)){
            JsonObject export=Json.parse(Json.required(row,"data"));
            for(String field:List.of("outputDir","path")){
                String value=Json.str(export,field,"");
                if(value.isBlank())continue;
                Path path;
                try{path=Path.of(value).toAbsolutePath().normalize();}catch(Exception e){continue;}
                // 受管目录内的导出结果由受管文件清理处理，只提示用户自行处理外部目录。
                if(!path.startsWith(store.root)&&result.stream().noneMatch(item->item.equalsIgnoreCase(path.toString())))result.add(path.toString());
            }
        }
        return result;
    }

    private List<String> managedDirectories(String pid)throws Exception{
        return store.read(c->{List<String> result=new ArrayList<>();
            result.add(store.root.resolve("examples").resolve(pid).toString());
            for(JsonObject row:Store.rows(c,"SELECT id FROM media_jobs WHERE project_id=?",pid))result.add(store.root.resolve("media-jobs").resolve(Json.required(row,"id")).toString());
            return result;});
    }

    /** 只收集受管目录内、且由数据库记录确认属于该项目的文件。 */
    private List<Path> managedFiles(Connection c,String pid)throws Exception{
        List<Path> files=new ArrayList<>();
        Path root=store.root;
        for(JsonObject row:Store.rows(c,"SELECT id,data FROM assets WHERE project_id=?",pid)){
            String id=Json.required(row,"id");
            addFile(files,root.resolve("media").resolve(id+".png"));
            JsonObject metadata=Json.object(Json.parse(Json.required(row,"data")),"metadata");
            if(Json.str(metadata,"importMode","").equals("copy")){
                String extension=Json.str(metadata,"originalFormat","").equals("jpeg")?".jpg":".png";
                addFile(files,root.resolve("originals").resolve(id+extension));
            }
        }
        for(JsonObject row:Store.rows(c,"SELECT id FROM media_jobs WHERE project_id=?",pid))addTree(files,root.resolve("media-jobs").resolve(Json.required(row,"id")));
        for(JsonObject row:Store.rows(c,"SELECT data FROM input_results WHERE run_id IN ("+RUNS+")",pid)){
            String value=Json.str(Json.parse(Json.required(row,"data")),"path","");
            if(!value.isBlank())addFile(files,Path.of(value));
        }
        addTree(files,root.resolve("examples").resolve(pid));
        return files;
    }

    private void addFile(List<Path> files,Path candidate){
        Path path=confined(candidate);
        if(path==null||!Files.isRegularFile(path))return;
        if(!files.contains(path))files.add(path);
    }
    private void addTree(List<Path> files,Path directory){
        Path base=confined(directory);
        if(base==null||!Files.isDirectory(base))return;
        List<Path> found=new ArrayList<>();
        try(Stream<Path> stream=Files.walk(base,12)){stream.filter(Files::isRegularFile).forEach(found::add);}
        catch(Exception ignored){/* 目录不可访问时按未发现处理，不影响数据库删除。 */}
        for(Path path:found)addFile(files,path);
    }
    /** 删除残留的空目录；只清理仍在受管目录内的层级。 */
    private void pruneEmpty(Path directory)throws Exception{
        Path base=confined(directory);
        if(base==null||!Files.exists(base))return;
        List<Path> ordered=new ArrayList<>();
        try(Stream<Path> stream=Files.walk(base)){stream.forEach(ordered::add);}
        catch(Exception ignored){return;}
        ordered.sort(Comparator.comparingInt((Path value)->value.toString().length()).reversed());
        for(Path path:ordered){
            try(Stream<Path> children=Files.list(path)){if(children.findAny().isEmpty())Files.deleteIfExists(path);}
            catch(Exception ignored){/* 非空目录或有并发访问时保留。 */}
        }
    }
    /** 越界路径一律拒绝，避免删除数据目录之外的任何文件。 */
    private Path confined(Path candidate){
        try{
            Path path=candidate.toAbsolutePath().normalize();
            return path.startsWith(store.root)&&!path.equals(store.root)?path:null;
        }catch(Exception e){return null;}
    }
}
