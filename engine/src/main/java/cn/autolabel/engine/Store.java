package cn.autolabel.engine;

import com.google.gson.*;
import java.nio.file.*;
import java.sql.*;
import java.util.*;
import java.util.concurrent.*;

final class Store implements AutoCloseable {
    static final int SCHEMA_VERSION=12;
    interface Work<T> { T run(Connection c) throws Exception; }
    final Path root;
    // 受管原图根默认在数据目录内；桌面可把它指到存储根下的 uploads 目录，使导入复制的训练集可单独配置。
    final Path materialsRoot;
    // 训练产物根默认在数据目录内；桌面可把它指到外部绝对路径，使权重与数据集快照可放到其他磁盘。
    final Path trainingRoot;
    // 配置的训练产物根不可用时的回退事实与原因；null 表示按配置生效，不留空让界面以为一切正常。
    final String trainingRootIssue;
    private final String url;
    private final Connection writer;
    private final ThreadPoolExecutor writes = new ThreadPoolExecutor(1,1,0,TimeUnit.MILLISECONDS,
        new ArrayBlockingQueue<>(512), Thread.ofPlatform().name("sqlite-writer-",0).factory(),new ThreadPoolExecutor.AbortPolicy());
    volatile boolean writeFailed;
    Store(Path root) throws Exception { this(root,null,null); }
    Store(Path root,Path materialsRoot) throws Exception { this(root,materialsRoot,null); }
    Store(Path root,Path materialsRoot,Path trainingRoot) throws Exception {
        this.root=root.toAbsolutePath().normalize(); Files.createDirectories(this.root);
        this.materialsRoot=resolveMaterials(this.root,materialsRoot);
        java.util.concurrent.atomic.AtomicReference<String> trainingIssue=new java.util.concurrent.atomic.AtomicReference<>();
        this.trainingRoot=resolveTraining(this.root,trainingRoot,trainingIssue);
        this.trainingRootIssue=trainingIssue.get();
        if(this.trainingRootIssue!=null)System.err.println(Json.obj("type","training_root_fallback","message",this.trainingRootIssue,"actual",this.trainingRoot.toString()));
        url="jdbc:sqlite:" + this.root.resolve("autolabel.db"); writer=connect();
        try (Statement s=writer.createStatement()) {
            int version; try(ResultSet rs=s.executeQuery("PRAGMA user_version")) {version=rs.getInt(1);}
            if(version>SCHEMA_VERSION) throw new ApiError(409,"database_version_newer","数据目录由更新版本创建，请升级软件后打开。");
            s.execute("PRAGMA journal_mode=WAL"); s.execute("PRAGMA synchronous=FULL");
            // 事件表只增不减，长会话下 WAL 会持续膨胀；显式设置自动 checkpoint 阈值。
            s.execute("PRAGMA wal_autocheckpoint=1000");
            if(version>0&&version<SCHEMA_VERSION)backupBeforeMigration(version);
            writer.setAutoCommit(false);
            s.execute("CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,data TEXT NOT NULL)");
            s.execute("CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),data TEXT NOT NULL,path TEXT NOT NULL)");
            s.execute("CREATE INDEX IF NOT EXISTS assets_project ON assets(project_id)");
            // 导入去重与项目计数走生成列 + 索引：json_extract 全表扫在上万素材时是 O(n²)。
            // 注意用 table_xinfo：虚拟生成列是隐藏列，table_info 不列出它，会把二次打开误判成缺列而重复 ALTER。
            Set<String> assetColumns=new HashSet<>();try(ResultSet columns=s.executeQuery("PRAGMA table_xinfo(assets)")){while(columns.next())assetColumns.add(columns.getString("name"));}
            if(!assetColumns.contains("content_hash"))s.execute("ALTER TABLE assets ADD COLUMN content_hash TEXT GENERATED ALWAYS AS (json_extract(data,'$.contentHash')) VIRTUAL");
            if(!assetColumns.contains("status"))s.execute("ALTER TABLE assets ADD COLUMN status TEXT GENERATED ALWAYS AS (json_extract(data,'$.status')) VIRTUAL");
            s.execute("CREATE INDEX IF NOT EXISTS assets_hash ON assets(project_id,content_hash)");
            s.execute("CREATE INDEX IF NOT EXISTS assets_status ON assets(project_id,status)");
            s.execute("CREATE TABLE IF NOT EXISTS versions(id INTEGER PRIMARY KEY AUTOINCREMENT,asset_id TEXT NOT NULL REFERENCES assets(id),version INTEGER NOT NULL,source TEXT NOT NULL,data TEXT NOT NULL,attempt_id TEXT UNIQUE,created_at TEXT NOT NULL)");
            s.execute("CREATE INDEX IF NOT EXISTS versions_asset ON versions(asset_id,version)");
            s.execute("CREATE TABLE IF NOT EXISTS drafts(asset_id TEXT PRIMARY KEY REFERENCES assets(id),base_version INTEGER NOT NULL,data TEXT NOT NULL,saved_at TEXT NOT NULL)");
            s.execute("CREATE TABLE IF NOT EXISTS providers(id TEXT PRIMARY KEY,data TEXT NOT NULL)");
            s.execute("CREATE TABLE IF NOT EXISTS resources(id TEXT PRIMARY KEY,kind TEXT NOT NULL,data TEXT NOT NULL)");
            s.execute("CREATE TABLE IF NOT EXISTS settings(id TEXT PRIMARY KEY,data TEXT NOT NULL)");
            s.execute("CREATE TABLE IF NOT EXISTS budgets(id TEXT PRIMARY KEY,max_requests INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0)");
            s.execute("CREATE TABLE IF NOT EXISTS exports(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,data TEXT NOT NULL)");
            // 导出格式模板与不可变修订版本同表存放，头部用 kind 区分，沿用资源库的版本化约定。
            s.execute("CREATE TABLE IF NOT EXISTS export_formats(id TEXT PRIMARY KEY,kind TEXT NOT NULL,data TEXT NOT NULL)");
            s.execute("CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL)");
            Set<String> sampleColumns=new HashSet<>();try(ResultSet columns=s.executeQuery("PRAGMA table_info(samples)")){while(columns.next())sampleColumns.add(columns.getString("name"));}
            String sampleDefinition="(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),asset_id TEXT NOT NULL,input_id TEXT NOT NULL,status TEXT NOT NULL,attempt_count INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,active_attempt TEXT,data TEXT NOT NULL,UNIQUE(run_id,input_id))";
            if(!sampleColumns.isEmpty()&&!sampleColumns.contains("input_id")){
                // 输入身份与基准父图分开，旧样本保持原 asset_id 身份及全部尝试关联。
                s.execute("CREATE TABLE samples_v4"+sampleDefinition);s.execute("INSERT INTO samples_v4(id,run_id,asset_id,input_id,status,attempt_count,next_at,active_attempt,data) SELECT id,run_id,asset_id,asset_id,status,attempt_count,next_at,active_attempt,data FROM samples");s.execute("DROP TABLE samples");s.execute("ALTER TABLE samples_v4 RENAME TO samples");
            }else s.execute("CREATE TABLE IF NOT EXISTS samples"+sampleDefinition);
            s.execute("CREATE INDEX IF NOT EXISTS samples_dispatch ON samples(run_id,status,next_at)");
            s.execute("CREATE INDEX IF NOT EXISTS samples_baseline ON samples(run_id,asset_id,status)");
            s.execute("CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY,run_id TEXT,sample_id TEXT,group_id TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL)");
            s.execute("CREATE INDEX IF NOT EXISTS attempts_run ON attempts(run_id)");
            s.execute("CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT NOT NULL,timestamp TEXT NOT NULL,run_id TEXT,asset_id TEXT,attempt_id TEXT,payload TEXT NOT NULL)");
            s.execute("CREATE INDEX IF NOT EXISTS events_run ON events(run_id,sequence)");
            s.execute("CREATE TABLE IF NOT EXISTS evaluation_sets(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),data TEXT NOT NULL)");
            s.execute("CREATE TABLE IF NOT EXISTS truth_versions(set_id TEXT NOT NULL REFERENCES evaluation_sets(id),asset_id TEXT NOT NULL,version INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(set_id,asset_id,version))");
            s.execute("CREATE TABLE IF NOT EXISTS evaluation_set_versions(id TEXT PRIMARY KEY,set_id TEXT NOT NULL REFERENCES evaluation_sets(id),version INTEGER NOT NULL,data TEXT NOT NULL,UNIQUE(set_id,version))");
            s.execute("CREATE TABLE IF NOT EXISTS evaluations(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),data TEXT NOT NULL)");
            s.execute("CREATE TABLE IF NOT EXISTS evaluation_results(id TEXT PRIMARY KEY,evaluation_id TEXT NOT NULL REFERENCES evaluations(id),scheme_id TEXT NOT NULL,asset_id TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(evaluation_id,scheme_id,asset_id))");
            s.execute("CREATE INDEX IF NOT EXISTS evaluation_results_parent ON evaluation_results(evaluation_id,scheme_id,asset_id)");
            s.execute("CREATE TABLE IF NOT EXISTS review_items(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,evaluation_id TEXT,run_id TEXT,sample_id TEXT,asset_id TEXT NOT NULL,candidate_version INTEGER,status TEXT NOT NULL,identity_key TEXT NOT NULL UNIQUE,data TEXT NOT NULL)");
            s.execute("CREATE INDEX IF NOT EXISTS review_items_project ON review_items(project_id,status)");
            s.execute("CREATE TABLE IF NOT EXISTS review_samples(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,data TEXT NOT NULL)");
            s.execute("CREATE TABLE IF NOT EXISTS flow_runs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),status TEXT NOT NULL,data TEXT NOT NULL)");
            s.execute("CREATE INDEX IF NOT EXISTS flow_runs_project ON flow_runs(project_id,status)");
            s.execute("CREATE TABLE IF NOT EXISTS flow_steps(id TEXT PRIMARY KEY,flow_run_id TEXT NOT NULL REFERENCES flow_runs(id),step_id TEXT NOT NULL,position INTEGER NOT NULL,status TEXT NOT NULL,child_run_id TEXT UNIQUE REFERENCES runs(id),data TEXT NOT NULL,UNIQUE(flow_run_id,step_id))");
            s.execute("CREATE INDEX IF NOT EXISTS flow_steps_parent ON flow_steps(flow_run_id,position)");
            s.execute("CREATE TABLE IF NOT EXISTS flow_artifacts(id TEXT PRIMARY KEY,flow_run_id TEXT NOT NULL REFERENCES flow_runs(id),project_id TEXT NOT NULL,step_id TEXT,kind TEXT NOT NULL,data TEXT NOT NULL)");
            s.execute("CREATE TABLE IF NOT EXISTS flow_artifact_items(id TEXT PRIMARY KEY,artifact_id TEXT NOT NULL REFERENCES flow_artifacts(id),asset_id TEXT,position INTEGER NOT NULL,outcome TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(artifact_id,position))");
            s.execute("CREATE INDEX IF NOT EXISTS flow_items_parent ON flow_artifact_items(artifact_id,position)");
            s.execute("CREATE TABLE IF NOT EXISTS run_baselines(run_id TEXT NOT NULL REFERENCES runs(id),asset_id TEXT NOT NULL REFERENCES assets(id),data TEXT NOT NULL,PRIMARY KEY(run_id,asset_id))");
            s.execute("CREATE TABLE IF NOT EXISTS input_results(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),sample_id TEXT NOT NULL REFERENCES samples(id),asset_id TEXT NOT NULL,input_id TEXT NOT NULL,attempt_id TEXT,source TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,data TEXT NOT NULL)");
            s.execute("CREATE INDEX IF NOT EXISTS input_results_sample ON input_results(sample_id,created_at)");
            s.execute("CREATE INDEX IF NOT EXISTS input_results_reuse ON input_results(source,status,json_extract(data,'$.reuseFingerprint'))");
            s.execute("CREATE TABLE IF NOT EXISTS run_asset_results(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),asset_id TEXT NOT NULL,result_set_hash TEXT NOT NULL,candidate_version INTEGER,status TEXT NOT NULL,created_at TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(run_id,asset_id,result_set_hash))");
            s.execute("CREATE INDEX IF NOT EXISTS run_asset_results_parent ON run_asset_results(run_id,asset_id,created_at)");
            s.execute("CREATE TABLE IF NOT EXISTS media_jobs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),kind TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL)");
            s.execute("CREATE INDEX IF NOT EXISTS media_jobs_dispatch ON media_jobs(status)");
            s.execute("CREATE INDEX IF NOT EXISTS media_jobs_project ON media_jobs(project_id,kind)");
            s.execute("CREATE TABLE IF NOT EXISTS video_sources(id TEXT PRIMARY KEY,data TEXT NOT NULL)");
            s.execute("CREATE TABLE IF NOT EXISTS screening_features(id TEXT PRIMARY KEY,data TEXT NOT NULL)");
            s.execute("CREATE TABLE IF NOT EXISTS track_timelines(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),media_job_id TEXT NOT NULL REFERENCES media_jobs(id),template_hash TEXT NOT NULL,version INTEGER NOT NULL,data TEXT NOT NULL,UNIQUE(project_id,media_job_id,template_hash))");
            s.execute("CREATE TABLE IF NOT EXISTS timeline_frames(id TEXT PRIMARY KEY,timeline_id TEXT NOT NULL REFERENCES track_timelines(id),frame_id TEXT NOT NULL,asset_id TEXT NOT NULL REFERENCES assets(id),position INTEGER NOT NULL,data TEXT NOT NULL,UNIQUE(timeline_id,frame_id),UNIQUE(timeline_id,asset_id))");
            s.execute("CREATE INDEX IF NOT EXISTS timeline_frames_order ON timeline_frames(timeline_id,position)");
            s.execute("CREATE TABLE IF NOT EXISTS tracks(id TEXT PRIMARY KEY,timeline_id TEXT NOT NULL REFERENCES track_timelines(id),version INTEGER NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL)");
            s.execute("CREATE INDEX IF NOT EXISTS tracks_timeline ON tracks(timeline_id,status)");
            s.execute("CREATE TABLE IF NOT EXISTS track_versions(id TEXT PRIMARY KEY,track_id TEXT NOT NULL REFERENCES tracks(id),version INTEGER NOT NULL,data TEXT NOT NULL,UNIQUE(track_id,version))");
            s.execute("CREATE TABLE IF NOT EXISTS track_generations(id TEXT PRIMARY KEY,track_id TEXT NOT NULL REFERENCES tracks(id),status TEXT NOT NULL,data TEXT NOT NULL)");
            s.execute("CREATE INDEX IF NOT EXISTS track_generations_dispatch ON track_generations(status)");
            s.execute("CREATE TABLE IF NOT EXISTS track_generation_frames(id TEXT PRIMARY KEY,generation_id TEXT NOT NULL REFERENCES track_generations(id),asset_id TEXT NOT NULL REFERENCES assets(id),status TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(generation_id,asset_id))");
            s.execute("CREATE TABLE IF NOT EXISTS track_contributions(id TEXT PRIMARY KEY,generation_id TEXT NOT NULL REFERENCES track_generations(id),track_id TEXT NOT NULL REFERENCES tracks(id),asset_id TEXT NOT NULL REFERENCES assets(id),data TEXT NOT NULL)");
            s.execute("CREATE INDEX IF NOT EXISTS track_contributions_frame ON track_contributions(track_id,asset_id)");
            s.execute("CREATE TABLE IF NOT EXISTS track_contribution_heads(track_id TEXT NOT NULL REFERENCES tracks(id),asset_id TEXT NOT NULL REFERENCES assets(id),contribution_id TEXT NOT NULL REFERENCES track_contributions(id),PRIMARY KEY(track_id,asset_id))");
            s.execute("CREATE TABLE IF NOT EXISTS track_dirty_frames(track_id TEXT NOT NULL REFERENCES tracks(id),frame_id TEXT NOT NULL,PRIMARY KEY(track_id,frame_id))");
            s.execute("CREATE TABLE IF NOT EXISTS track_generation_plans(generation_id TEXT PRIMARY KEY REFERENCES track_generations(id),data TEXT NOT NULL)");
            // 自动跟踪候选独立持久化，避免伪装成可直接应用的轨迹生成或贡献。
            s.execute("CREATE TABLE IF NOT EXISTS local_tracking_candidates(id TEXT PRIMARY KEY,timeline_id TEXT NOT NULL REFERENCES track_timelines(id),status TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,data TEXT NOT NULL)");
            s.execute("CREATE INDEX IF NOT EXISTS local_tracking_candidates_timeline ON local_tracking_candidates(timeline_id,created_at)");
            // 兼容早期 schema6：当时冻结计划暂存在任务 JSON 中，升级后只拆分一次并保持幂等。
            s.execute("INSERT OR IGNORE INTO track_generation_plans(generation_id,data) SELECT id,json_extract(data,'$.plan') FROM track_generations WHERE json_type(data,'$.plan')='object'");
            s.execute("UPDATE track_generations SET data=json_remove(data,'$.plan') WHERE json_type(data,'$.plan')='object'");
            Set<String> eventColumns=new HashSet<>();try(ResultSet columns=s.executeQuery("PRAGMA table_info(events)")){while(columns.next())eventColumns.add(columns.getString("name"));}
            if(!eventColumns.contains("flow_run_id"))s.execute("ALTER TABLE events ADD COLUMN flow_run_id TEXT");
            if(!eventColumns.contains("step_id"))s.execute("ALTER TABLE events ADD COLUMN step_id TEXT");
            s.execute("CREATE INDEX IF NOT EXISTS events_flow ON events(flow_run_id,sequence)");
            // 软件内模型训练：数据集快照（不可变）、任务、逐轮指标与产物清单分开存放。
            // 逐轮指标独立成表而不是塞进任务 JSON，避免长训练任务的读放大。
            s.execute("CREATE TABLE IF NOT EXISTS training_datasets(id TEXT PRIMARY KEY,project_id TEXT,origin TEXT NOT NULL,task_type TEXT NOT NULL,snapshot_hash TEXT NOT NULL,created_at TEXT NOT NULL,data TEXT NOT NULL)");
            s.execute("CREATE TABLE IF NOT EXISTS training_jobs(id TEXT PRIMARY KEY,dataset_id TEXT NOT NULL REFERENCES training_datasets(id),project_id TEXT,status TEXT NOT NULL,device TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,data TEXT NOT NULL)");
            s.execute("CREATE INDEX IF NOT EXISTS training_jobs_dataset ON training_jobs(dataset_id,created_at)");
            s.execute("CREATE INDEX IF NOT EXISTS training_jobs_dispatch ON training_jobs(status)");
            s.execute("CREATE TABLE IF NOT EXISTS training_epochs(job_id TEXT NOT NULL REFERENCES training_jobs(id),epoch INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(job_id,epoch))");
            s.execute("CREATE TABLE IF NOT EXISTS training_artifacts(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES training_jobs(id),kind TEXT NOT NULL,path TEXT NOT NULL,size INTEGER,hash TEXT,data TEXT NOT NULL)");
            s.execute("CREATE INDEX IF NOT EXISTS training_artifacts_job ON training_artifacts(job_id,kind)");
            // 数据集版本：配方、内容指纹与清单校验值单独成列，便于引用方按状态过滤；其余详情仍在 data 中。
            // number 在项目内递增并唯一；builds 与版本解耦，允许中断后重试图保持版本号不变。
            s.execute("CREATE TABLE IF NOT EXISTS dataset_versions(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),version INTEGER NOT NULL,status TEXT NOT NULL,recipe_hash TEXT,content_hash TEXT,manifest_hash TEXT,created_at TEXT NOT NULL,completed_at TEXT,data TEXT NOT NULL,UNIQUE(project_id,version))");
            s.execute("CREATE INDEX IF NOT EXISTS dataset_versions_project ON dataset_versions(project_id,version DESC)");
            // 被排除项同样入库并带原因码，用于说明遗漏范围；outcome 与 split 作为列便于聚合计数。
            s.execute("CREATE TABLE IF NOT EXISTS dataset_version_items(version_id TEXT NOT NULL REFERENCES dataset_versions(id),position INTEGER NOT NULL,asset_id TEXT,outcome TEXT NOT NULL,split TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(version_id,position))");
            s.execute("CREATE INDEX IF NOT EXISTS dataset_version_items_outcome ON dataset_version_items(version_id,outcome)");
            s.execute("CREATE TABLE IF NOT EXISTS dataset_version_builds(id TEXT PRIMARY KEY,version_id TEXT NOT NULL REFERENCES dataset_versions(id),status TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,data TEXT NOT NULL)");
            s.execute("CREATE INDEX IF NOT EXISTS dataset_version_builds_version ON dataset_version_builds(version_id,created_at DESC)");
            // 抽帧配方：全局记录（不属于任何项目），跟着数据目录与备份一起走；名称在同类配方内唯一。
            s.execute("CREATE TABLE IF NOT EXISTS media_recipes(id TEXT PRIMARY KEY,kind TEXT NOT NULL,name TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(kind,name))");
            s.execute("PRAGMA user_version="+SCHEMA_VERSION); writer.commit(); writer.setAutoCommit(true);
        } catch(Exception e) {try{if(!writer.getAutoCommit())writer.rollback();}finally{writer.close();writes.shutdownNow();}if(e instanceof ApiError a)throw a;ApiError failure=new ApiError(500,"database_migration_failed","数据库升级失败，未提交迁移；请保留原数据目录及迁移备份并查看诊断。原因："+(e.getMessage()==null?e.getClass().getSimpleName():e.getMessage()));failure.initCause(e);throw failure;}
    }
    /** 受管原图根：默认 <数据目录>/originals；自定义时为绝对目录，且不能是磁盘根或数据目录的上级。 */
    private static Path resolveMaterials(Path root,Path materialsRoot)throws Exception{
        if(materialsRoot==null){Path fallback=root.resolve("originals");Files.createDirectories(fallback);return fallback;}
        Path path=materialsRoot.toAbsolutePath().normalize();
        if(!materialsRoot.isAbsolute()||path.getParent()==null||path.equals(root)||root.startsWith(path))throw new ApiError(400,"materials_root_invalid","受管原图目录必须是数据目录之外、非磁盘根的绝对路径。");
        Files.createDirectories(path);return path;
    }
    /**
     * 训练产物根：默认 <数据目录>/training；自定义时为绝对目录，且不能是磁盘根或数据目录的上级。
     * 与受管原图根不同，这里的配置失效（磁盘未接入、无写权限）只回退到默认位置并记录原因：
     * 训练产物属于可重建资源，不能因为它让整个引擎拒绝启动；回退事实由 training.root.status 如实上报。
     */
    private static Path resolveTraining(Path root,Path trainingRoot,java.util.concurrent.atomic.AtomicReference<String> issue){
        Path fallback=root.resolve("training");
        if(trainingRoot==null)return fallback;
        try{
            Path path=trainingRoot.toAbsolutePath().normalize();
            if(!trainingRoot.isAbsolute()||path.getParent()==null||path.equals(root)||root.startsWith(path))
                throw new IllegalArgumentException("训练产物目录必须是数据目录之外、非磁盘根的绝对路径。");
            Files.createDirectories(path);
            Path marker=path.resolve(".autolabel-write-"+Json.id()+".tmp");
            Files.writeString(marker,"autolabel");Files.deleteIfExists(marker);
            return path;
        }catch(Exception failure){
            issue.set((failure.getMessage()==null||failure.getMessage().isBlank()?"训练产物目录不可用。":failure.getMessage())+"已回退到默认的训练产物目录，训练仍可继续。");
            return fallback;
        }
    }
    private void backupBeforeMigration(int version)throws Exception{
        try{Path directory=root.resolve("backups");Files.createDirectories(directory);Path backup=directory.resolve("schema-v"+version+"-"+Json.id()+".db");
            // VACUUM INTO 读取包含 WAL 的一致快照，成功并通过完整性检查后才允许开始结构迁移。
            // 必须另开连接执行：调用方此刻仍握着读取版本与设置 journal_mode 的语句，而 VACUUM INTO 会以
            // "cannot VACUUM - SQL statements in progress" 拒绝同一连接上的请求 —— 那会让任何一次
            // schema 升级在已有数据目录上直接失败。
            try(Connection source=connect();PreparedStatement p=source.prepareStatement("VACUUM INTO ?")){p.setString(1,backup.toString());p.execute();}
            try(Connection check=DriverManager.getConnection("jdbc:sqlite:"+backup);Statement s=check.createStatement();ResultSet result=s.executeQuery("PRAGMA integrity_check")){if(!result.next()||!"ok".equals(result.getString(1)))throw new SQLException("backup integrity failure");}
        }catch(Exception e){throw new ApiError(500,"migration_backup_failed","升级前一致性备份未完成，已停止升级；请检查磁盘空间与备份目录权限。原因："+(e.getMessage()==null?e.getClass().getSimpleName():e.getMessage()));}
    }
    Connection connect() throws SQLException {
        Connection c=DriverManager.getConnection(url);
        try(Statement s=c.createStatement()){s.execute("PRAGMA busy_timeout=5000");s.execute("PRAGMA foreign_keys=ON");}
        return c;
    }
    <T> T read(Work<T> work) {
        try(Connection c=connect()) {c.setAutoCommit(false); try {T result=work.run(c);c.commit();return result;}catch(Exception e){c.rollback();throw e;}}
        catch(ApiError e){throw e;}catch(Exception e){ApiError error=new ApiError(500,"storage_read_failed","读取本地数据失败，请检查数据目录。");error.initCause(e);throw error;}
    }
    <T> T tx(Work<T> work) {
        boolean interrupted=false;
        try {Future<T> pending=writes.submit(()->{
            try {writer.setAutoCommit(false);T result=work.run(writer);writer.commit();return result;}
            catch(Exception e){writer.rollback();if(unrecoverable(e))writeFailed=true;throw e;}
            finally {writer.setAutoCommit(true);}
        });
            // 写入一旦入队就等待明确提交结论，退出中断不能制造“失败却已提交”的歧义。
            for(;;){try{return pending.get();}catch(InterruptedException e){interrupted=true;}}
        }
        catch(RejectedExecutionException e){throw new ApiError(503,"storage_busy","本地写入繁忙，请稍后重试。");}
        catch(ExecutionException e){if(e.getCause() instanceof ApiError a)throw a;if(unrecoverable(e.getCause()))writeFailed=true;throw new ApiError(500,"storage_write_failed","本地写入失败，已停止新调用；请检查磁盘空间与目录权限。");}
        finally{if(interrupted)Thread.currentThread().interrupt();}
    }
    /**
     * writeFailed 是「停止继续写入」的闩锁，只在确实无法继续的存储故障上置位：
     * 8 只读、10 IO 错误、11 损坏、13 磁盘满、14 无法打开、26 非数据库文件。
     * 瞬时争用（SQLITE_BUSY/LOCKED）由 busy_timeout 内部重试，业务参数类异常更不代表数据库损坏；
     * 若把它们也算作不可恢复，一次偶发失败就会让整个引擎永久停摆且只能靠重启恢复。
     */
    static boolean unrecoverable(Throwable failure){
        for(Throwable t=failure;t!=null;t=t.getCause()){
            if(t instanceof SQLException sql){
                int code=sql.getErrorCode();
                return code==8||code==10||code==11||code==13||code==14||code==26;
            }
        }
        return false;
    }
    static PreparedStatement statement(Connection c,String sql,Object... args)throws SQLException{
        PreparedStatement p=c.prepareStatement(sql);for(int i=0;i<args.length;i++)p.setObject(i+1,args[i] instanceof JsonElement e?e.toString():args[i]);return p;
    }
    static int update(Connection c,String sql,Object... args)throws SQLException{try(PreparedStatement p=statement(c,sql,args)){return p.executeUpdate();}}
    static List<JsonObject> rows(Connection c,String sql,Object... args)throws SQLException{
        try(PreparedStatement p=statement(c,sql,args);ResultSet r=p.executeQuery()){
            List<JsonObject> list=new ArrayList<>();ResultSetMetaData m=r.getMetaData();
            while(r.next()){JsonObject row=new JsonObject();for(int i=1;i<=m.getColumnCount();i++)row.add(m.getColumnLabel(i),Json.element(r.getObject(i)));list.add(row);}return list;
        }
    }
    static JsonObject one(Connection c,String sql,Object... args)throws SQLException{List<JsonObject> list=rows(c,sql,args);return list.isEmpty()?null:list.getFirst();}
    static JsonObject document(Connection c,String table,String id)throws SQLException{
        if(!Set.of("projects","assets","providers","runs","resources","exports","evaluation_sets","evaluation_set_versions","evaluations","review_items","review_samples","flow_runs","flow_steps","flow_artifacts","flow_artifact_items","input_results","run_asset_results","media_jobs","video_sources","screening_features","track_timelines","timeline_frames","tracks","track_versions","track_generations","track_generation_frames","track_contributions","local_tracking_candidates","export_formats","training_datasets","training_jobs","dataset_versions","dataset_version_builds").contains(table))throw new IllegalArgumentException();
        JsonObject row=one(c,"SELECT data FROM "+table+" WHERE id=?",id);
        if(row==null)throw new ApiError(404,"not_found","记录不存在。");return Json.parse(row.get("data").getAsString());
    }
    static JsonArray docs(Connection c,String sql,Object... args)throws SQLException{
        JsonArray result=new JsonArray();for(JsonObject row:rows(c,sql,args))result.add(Json.parse(row.get("data").getAsString()));return result;
    }
    static long cursor(Connection c)throws SQLException{return one(c,"SELECT COALESCE(MAX(sequence),0) AS n FROM events").get("n").getAsLong();}
    static void event(Connection c,String type,String run,String asset,String attempt,JsonObject payload)throws SQLException{
        JsonObject context=run==null?null:one(c,"SELECT json_extract(data,'$.flowRunId') AS flow,json_extract(data,'$.stepId') AS step FROM runs WHERE id=?",run);
        flowEvent(c,type,context==null?null:Json.str(context,"flow",null),context==null?null:Json.str(context,"step",null),run,asset,attempt,payload);
    }
    static void flowEvent(Connection c,String type,String flow,String step,String run,String asset,String attempt,JsonObject payload)throws SQLException{
        update(c,"INSERT INTO events(type,timestamp,flow_run_id,step_id,run_id,asset_id,attempt_id,payload) VALUES(?,?,?,?,?,?,?,?)",type,Json.now(),flow,step,run,asset,attempt,payload);
    }
    static JsonArray events(Connection c,long after,String run,String asset,int limit)throws SQLException{
        return events(c,after,run,asset,null,limit);
    }
    static JsonArray events(Connection c,long after,String run,String asset,String flow,int limit)throws SQLException{
        String sql="SELECT * FROM events WHERE sequence>?";List<Object> args=new ArrayList<>(List.of(after));
        if(run!=null){sql+=" AND run_id=?";args.add(run);}if(asset!=null){sql+=" AND asset_id=?";args.add(asset);}if(flow!=null){sql+=" AND flow_run_id=?";args.add(flow);}sql+=" ORDER BY sequence LIMIT ?";args.add(limit);
        JsonArray result=new JsonArray();for(JsonObject r:rows(c,sql,args.toArray())){
            JsonObject e=Json.obj("sequence",r.get("sequence"),"type",r.get("type"),"timestamp",r.get("timestamp"),"payload",Json.parse(r.get("payload").getAsString()));
            if(Json.str(r,"type","").startsWith("media.job.")&&Json.object(e,"payload").has("jobId"))e.add("mediaJobId",Json.object(e,"payload").get("jobId"));
            if(Json.str(r,"type","").startsWith("track."))for(String field:List.of("timelineId","trackId","generationId"))if(Json.object(e,"payload").has(field))e.add(field,Json.object(e,"payload").get(field));
            if(!r.get("run_id").isJsonNull()){e.add("runId",r.get("run_id"));e.addProperty("stepId","api.annotate");}
            if(!r.get("flow_run_id").isJsonNull())e.add("flowRunId",r.get("flow_run_id"));if(!r.get("step_id").isJsonNull())e.add("stepId",r.get("step_id"));
            if(!r.get("asset_id").isJsonNull())e.add("assetId",r.get("asset_id"));if(!r.get("attempt_id").isJsonNull())e.add("attemptId",r.get("attempt_id"));result.add(e);
        }return result;
    }
    void requireSpace(long expected){
        if(writeFailed)throw new ApiError(503,"storage_write_failed","存储发生写入错误，请修复后重启引擎。");
        try{if(Files.getFileStore(root).getUsableSpace()<Math.max(128L*1024*1024,expected))throw new ApiError(507,"disk_space_low","磁盘剩余空间不足，已停止新任务。");}
        catch(java.io.IOException e){throw new ApiError(500,"directory_unavailable","数据目录不可访问。");}
    }
    void snapshotDatabase(Path destination){
        Path target=destination.toAbsolutePath().normalize();boolean interrupted=false;
        if(Files.exists(target))throw new ApiError(409,"backup_output_exists","数据库快照目标已存在，未覆盖原文件。");
        try{
            // 排在既有写事务之后执行；VACUUM INTO 必须处于自动提交状态，不能套用 tx。
            Future<Void> pending=writes.submit(()->{
                if(!writer.getAutoCommit())throw new SQLException("snapshot requires autocommit");
                try(PreparedStatement statement=writer.prepareStatement("VACUUM INTO ?")){statement.setString(1,target.toString());statement.execute();}
                return null;
            });
            for(;;){try{pending.get();break;}catch(InterruptedException e){interrupted=true;}}
            try(Connection check=DriverManager.getConnection("jdbc:sqlite:"+target);Statement statement=check.createStatement();ResultSet result=statement.executeQuery("PRAGMA integrity_check")){
                if(!result.next()||!"ok".equals(result.getString(1)))throw new SQLException("snapshot integrity failure");
            }
        }catch(RejectedExecutionException e){throw new ApiError(503,"storage_busy","存储暂时不能创建备份，请稍后重试。");}
        catch(Exception e){throw new ApiError(500,"backup_database_failed","数据库一致快照未完成，请检查目标目录空间和权限。");}
        finally{if(interrupted)Thread.currentThread().interrupt();}
    }
    @Override public void close(){writes.shutdown();try{writes.awaitTermination(10,TimeUnit.SECONDS);writer.close();}catch(Exception ignored){}}
}
