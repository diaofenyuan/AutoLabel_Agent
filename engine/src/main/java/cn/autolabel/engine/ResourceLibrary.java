package cn.autolabel.engine;

import com.google.gson.*;
import javax.imageio.ImageIO;
import javax.imageio.ImageReader;
import javax.imageio.stream.ImageInputStream;
import java.io.IOException;
import java.nio.file.*;
import java.sql.Connection;
import java.util.*;

final class ResourceLibrary {
    private static final Set<String> EDITABLE=Set.of("prompt","template","flow");
    private static final Set<String> TEMPLATE_FIELDS=Set.of("classes","keypointNames","keypointConnections","attributes","rules","occlusionRules","blurRules","prompt");
    private static final String REVISION_KIND="resource_version";
    private final Store store;
    private final Projects projects;

    ResourceLibrary(Store store,Projects projects){this.store=store;this.projects=projects;}

    JsonObject save(JsonObject p){
        Providers.rejectSecrets(p);
        String kind=Json.required(p,"kind");
        if(!EDITABLE.contains(kind))throw error(403,"resource_kind_reserved","此类资源只能通过专用命令生成。");
        JsonElement content=p.get("content");
        if(content==null||content.isJsonNull()||content.toString().length()>2_000_000)throw error(400,"resource_content_invalid","资源内容为空或超过保存上限。");
        if(kind.equals("prompt")){
            if(!content.isJsonPrimitive()||!content.getAsJsonPrimitive().isString()||content.getAsString().isBlank())throw error(400,"resource_content_invalid","提示词资源必须是非空文本。");
        }else if(!content.isJsonObject())throw error(400,"resource_content_invalid","模板和流程必须是 JSON 对象。");
        if(kind.equals("template"))validateTemplate(content.getAsJsonObject());
        if(kind.equals("flow")){
            JsonObject flow=content.getAsJsonObject();
            if(Json.integer(flow,"version",0)!=1||!flow.has("steps")||!flow.get("steps").isJsonArray()||Json.array(flow,"steps").size()>30)throw error(400,"resource_content_invalid","流程版本或步骤数量无效。");
        }
        JsonObject fields=fields(p,kind,content.deepCopy());
        return store.tx(c->commit(c,p,fields));
    }

    JsonArray list(JsonObject p){
        String kind=Json.str(p,"kind",null),query=boundedText(p,"query",500,""),category=Json.str(p,"category",null);
        if(REVISION_KIND.equals(kind)||"local_model".equals(kind))throw error(403,"resource_kind_reserved","此类资源请通过专用版本入口读取。");
        int limit=Json.bounded(p,"limit",500,1,500),offset=Json.bounded(p,"offset",0,0,Integer.MAX_VALUE);
        return store.read(c->{
            String where=kind==null?"kind NOT IN ('resource_version','evaluation_comparison','local_model')":"kind=?";
            List<Object> args=new ArrayList<>();if(kind!=null)args.add(kind);
            if(category!=null){where+=" AND COALESCE(json_extract(data,'$.category'),'')=?";args.add(category);}
            if(!query.isBlank()){
                where+=" AND instr(lower(COALESCE(json_extract(data,'$.name'),'')||' '||COALESCE(json_extract(data,'$.category'),'')||' '||COALESCE(json_extract(data,'$.note'),'')||' '||COALESCE(json_extract(data,'$.content'),'')),?)>0";
                args.add(query.toLowerCase(Locale.ROOT));
            }
            args.add(limit);args.add(offset);
            JsonArray result=Store.docs(c,"SELECT data FROM resources WHERE "+where+" ORDER BY rowid DESC LIMIT ? OFFSET ?",args.toArray());
            for(JsonElement item:result)if(!item.getAsJsonObject().has("version"))item.getAsJsonObject().addProperty("version",0);
            return result;
        });
    }

    JsonObject get(JsonObject p){JsonObject result=raw(p);if(Json.required(result,"kind").equals("local_model"))throw error(403,"resource_kind_reserved","本地模型请使用模型专用入口。");return result;}
    JsonObject raw(JsonObject p){return store.read(c->revision(c,Json.required(p,"resourceId"),p));}

    JsonObject apply(JsonObject p){
        String projectId=Json.required(p,"projectId");JsonObject resource=get(p),project=projects.get(projectId);
        String kind=Json.required(resource,"kind");
        if(!EDITABLE.contains(kind))throw error(422,"resource_application_invalid","人工参考通过任务参考选择使用，不能覆盖项目规则。");
        JsonArray requested=Json.array(p,"fields");
        if(requested.isEmpty()||requested.size()>TEMPLATE_FIELDS.size())throw error(400,"resource_fields_required","请明确选择本次要覆盖的字段。");
        JsonObject update=Json.obj("projectId",projectId),settings=new JsonObject();Set<String> seen=new HashSet<>();
        JsonObject content=kind.equals("prompt")?new JsonObject():Json.object(resource,"content");
        if(kind.equals("template")){
            validateTemplate(content);
            if(!Json.required(content,"taskType").equals(Json.required(project,"taskType")))throw error(422,"resource_template_incompatible","模板与项目的任务类型不同。");
        }
        JsonObject origins=Json.object(Json.object(project,"settings"),"resourceOrigins").deepCopy();
        for(JsonElement item:requested){
            if(!item.isJsonPrimitive()||!item.getAsJsonPrimitive().isString())throw error(400,"resource_field_invalid","覆盖字段必须是字段名称。");
            String field=item.getAsString();if(!seen.add(field))throw error(400,"resource_field_invalid","覆盖字段不能重复。");
            JsonElement value;
            if(kind.equals("prompt")&&field.equals("prompt"))value=resource.get("content");
            else if(kind.equals("flow")&&field.equals("flow"))value=resource.get("content");
            else if(kind.equals("template")&&TEMPLATE_FIELDS.contains(field))value=templateField(content,field);
            else throw error(400,"resource_field_invalid","此资源不支持覆盖字段："+field);
            if(value==null||value.isJsonNull())throw error(400,"resource_field_missing","所选资源不包含字段："+field);
            if(field.equals("classes"))update.add(field,value.deepCopy());else settings.add(field,value.deepCopy());
            origins.add(field,Json.obj("resourceId",resource.get("id"),"version",resource.get("version"),"kind",kind,"appliedAt",Json.now()));
        }
        settings.add("resourceOrigins",origins);update.add("settings",settings);
        if(kind.equals("template")){
            JsonObject resulting=project.deepCopy(),resultingSettings=Json.object(resulting,"settings");
            if(update.has("classes"))resulting.add("classes",update.get("classes"));
            for(var entry:settings.entrySet())resultingSettings.add(entry.getKey(),entry.getValue());
            resulting.add("settings",resultingSettings);validateTemplate(resulting);
        }
        // 项目更新会在同一短事务中核对现有正式标注，失败时规则及来源记录均不落盘。
        JsonObject updated=projects.update(update);
        return Json.obj("project",updated,"resourceId",resource.get("id"),"resourceVersion",resource.get("version"),"fields",requested.deepCopy());
    }

    JsonObject addReference(JsonObject p){
        Providers.rejectSecrets(p);String assetId=Json.required(p,"assetId");int sourceVersion=exactInteger(p,"assetVersion",0);
        JsonObject captured=store.read(c->{
            JsonObject asset=Store.document(c,"assets",assetId);requireHuman(asset,sourceVersion);
            JsonObject project=Store.document(c,"projects",Json.required(asset,"projectId"));
            JsonObject template=templateSnapshot(project,asset);
            return Json.obj("asset",asset,"template",template,"path",Json.required(Store.one(c,"SELECT path FROM assets WHERE id=?",assetId),"path"));
        });
        JsonObject asset=Json.object(captured,"asset"),template=Json.object(captured,"template");
        JsonArray annotations=Annotations.validate(Json.array(asset,"annotations"),asset,template);
        JsonObject metadata=new JsonObject();
        for(String key:List.of("sourceHash","sourceGroup","sourceVideoId","groupId","rootAssetId","parentAssetId","evaluationSourceGroup","normalizationVersion","sourceToBaseline","alphaBackground","inputVersion")){
            JsonElement value=Json.object(asset,"metadata").get(key);if(value!=null)metadata.add(key,value.deepCopy());
        }
        JsonObject content=Json.obj("sourceAssetId",assetId,"sourceProjectId",asset.get("projectId"),"sourceAssetVersion",sourceVersion,
            "source",asset.get("source"),"sourceStatus",asset.get("status"),"name",asset.get("name"),"width",asset.get("width"),"height",asset.get("height"),
            "contentHash",asset.get("contentHash"),"annotations",annotations,"template",template,"metadata",metadata,"frozenAt",Json.now());
        JsonObject resource=fields(p,"reference",content);
        // 文件复制在事务外完成；正式发布前再核对人工版本，数据库只引用已完整写出的受管副本。
        Path copied=null;
        try{
            Path source=Path.of(Json.required(captured,"path"));String expected=Json.required(asset,"contentHash");
            verifyImage(source,expected,Json.integer(asset,"width",0),Json.integer(asset,"height",0));
            store.requireSpace(Files.size(source)+128L*1024*1024);
            Path base=store.root.resolve("resource-library");Files.createDirectories(base);
            if(!base.toRealPath().startsWith(store.root.toRealPath()))throw error(409,"reference_path_invalid","参考保存目录不能指向数据目录之外。");
            Path folder=Files.createDirectory(base.resolve(Json.id()));copied=folder.resolve("input.png");
            Files.copy(source,copied);verifyImage(copied,expected,Json.integer(asset,"width",0),Json.integer(asset,"height",0));
            content.addProperty("referenceImage",store.root.relativize(copied).toString().replace('\\','/'));
            return store.tx(c->{
                JsonObject current=Store.document(c,"assets",assetId);requireHuman(current,sourceVersion);
                if(!Json.required(current,"contentHash").equals(expected)||!Json.array(current,"annotations").equals(Json.array(asset,"annotations")))throw error(409,"reference_source_changed","人工标注或素材在保存期间变化，请重新选择。");
                return commit(c,p,resource);
            });
        }catch(ApiError e){if(copied!=null)discardUnpublished(copied);throw e;}
        catch(IOException e){if(copied!=null)discardUnpublished(copied);throw error(500,"reference_copy_failed","参考图片未能完整保存，请检查数据目录空间和权限。");}
    }

    JsonObject resolveReference(Connection c,JsonObject selection,JsonObject targetProject)throws Exception{
        JsonObject resource=revision(c,Json.required(selection,"resourceId"),selection);
        if(!Json.required(resource,"kind").equals("reference"))throw error(422,"reference_invalid","所选资源不是人工参考。");
        JsonObject content=Json.object(resource,"content"),sourceTemplate=Json.object(content,"template");
        if(!Json.required(sourceTemplate,"taskType").equals(Json.required(targetProject,"taskType")))throw error(422,"reference_template_incompatible","参考与当前项目的任务类型不同。");
        JsonObject sourceSettings=Json.object(sourceTemplate,"settings"),targetSettings=Json.object(targetProject,"settings");
        if(Json.required(targetProject,"taskType").equals("pose")&&(!Json.array(sourceSettings,"keypointNames").equals(Json.array(targetSettings,"keypointNames"))||!Json.array(sourceSettings,"keypointConnections").equals(Json.array(targetSettings,"keypointConnections"))))throw error(422,"reference_template_incompatible","参考的关键点名称、顺序或连接关系与项目模板不同。");
        Map<String,String> sourceClasses=classes(sourceTemplate),targetClasses=classes(targetProject);JsonObject mapping=Json.object(selection,"classMap");
        boolean explicit=selection.has("classMap");
        if(explicit&&!selection.get("classMap").isJsonObject())throw error(400,"reference_class_map_invalid","类别映射必须是对象。");
        if(explicit){
            if(!mapping.keySet().equals(sourceClasses.keySet()))throw error(422,"reference_class_map_invalid","请为参考模板的全部类别提供明确映射。");
            for(var entry:mapping.entrySet())if(!entry.getValue().isJsonPrimitive()||!entry.getValue().getAsJsonPrimitive().isString()||!targetClasses.containsKey(entry.getValue().getAsString()))throw error(422,"reference_class_map_invalid","类别映射引用了不存在的目标类别。");
        }else for(var entry:sourceClasses.entrySet())if(!entry.getValue().equals(targetClasses.get(entry.getKey())))throw error(422,"reference_class_map_required","参考与项目类别 ID 或含义不同，请提供完整类别映射。");
        JsonObject snapshot=Json.obj("id",content.get("sourceAssetId"),"projectId",content.get("sourceProjectId"),"version",content.get("sourceAssetVersion"),
            "resourceId",resource.get("id"),"resourceVersion",resource.get("version"),"name",content.get("name"),"width",content.get("width"),"height",content.get("height"),
            "contentHash",content.get("contentHash"),"referenceImage",content.get("referenceImage"),"metadata",Json.object(content,"metadata").deepCopy(),
            "source","shared_manual_reference","status","reference","note",Json.str(resource,"note",""),"sourceTemplate",sourceTemplate.deepCopy(),"template",targetProject.deepCopy());
        JsonArray annotations=Json.array(content,"annotations").deepCopy();
        if(explicit)for(JsonElement element:annotations){JsonObject annotation=element.getAsJsonObject();String sourceId=Json.required(annotation,"classId");if(!mapping.has(sourceId))throw error(422,"reference_class_map_invalid","参考标注类别未包含在映射中。");annotation.add("classId",mapping.get(sourceId).deepCopy());}
        snapshot.add("annotations",Annotations.validate(annotations,snapshot,targetProject));snapshot.add("classMap",explicit?mapping.deepCopy():new JsonObject());
        snapshot.addProperty("inputPath",referencePath(snapshot).toString());return snapshot;
    }

    Path referencePath(JsonObject snapshot){
        String relative=Json.required(snapshot,"referenceImage");Path base=store.root.resolve("resource-library").toAbsolutePath().normalize();
        try{
            Path part=Path.of(relative),path=store.root.resolve(part).toAbsolutePath().normalize();
            if(part.isAbsolute()||!path.startsWith(base)||!Files.isRegularFile(path)||!path.toRealPath().startsWith(base.toRealPath())||!base.toRealPath().startsWith(store.root.toRealPath()))throw error(409,"reference_path_invalid","参考图片不在受管目录或已经失联。");
            verifyImage(path,Json.required(snapshot,"contentHash"),Json.integer(snapshot,"width",0),Json.integer(snapshot,"height",0));return path;
        }catch(InvalidPathException|IOException e){throw error(409,"reference_snapshot_invalid","固定参考图片不可读取，请恢复资源备份。");}
    }

    JsonObject commit(Connection c,JsonObject p,JsonObject fields)throws Exception{
        String id=Json.str(p,"id",null);JsonObject old=null;
        if(id!=null){old=Store.document(c,"resources",id);if(!Json.required(old,"kind").equals(Json.required(fields,"kind")))throw error(409,"resource_kind_immutable","资源更新不能改变原有类型。");}
        int current=old==null?0:Json.integer(old,"version",0);
        if(old!=null&&(!p.has("baseVersion")||exactInteger(p,"baseVersion",0)!=current))throw error(409,"resource_version_conflict","资源版本已变化，请重新载入后保存。");
        if(old==null&&p.has("baseVersion")&&exactInteger(p,"baseVersion",0)!=0)throw error(409,"resource_version_conflict","新资源的初始版本必须为零。");
        if(id==null)id=Json.id();String now=Json.now();JsonObject result=fields.deepCopy();
        result.addProperty("id",id);result.addProperty("version",current+1);result.addProperty("createdAt",old==null?now:Json.str(old,"createdAt",Json.str(old,"updatedAt",now)));result.addProperty("updatedAt",now);
        if(old!=null&&!old.has("version")){JsonObject legacy=old.deepCopy();legacy.addProperty("version",0);saveRevision(c,id,0,legacy);}
        saveRevision(c,id,current+1,result);
        Store.update(c,"INSERT INTO resources(id,kind,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",id,Json.required(result,"kind"),result);
        Store.event(c,"resource.saved",null,null,null,Json.obj("id",id,"kind",result.get("kind"),"version",result.get("version")));return result;
    }

    private static void saveRevision(Connection c,String id,int version,JsonObject resource)throws Exception{
        String revisionId="resource-version:"+id+":"+version;
        Store.update(c,"INSERT INTO resources(id,kind,data) VALUES(?,?,?)",revisionId,REVISION_KIND,Json.obj("resourceId",id,"version",version,"resource",resource));
    }

    private static JsonObject revision(Connection c,String id,JsonObject p)throws Exception{
        JsonObject head=Store.document(c,"resources",id);String kind=Json.required(head,"kind");
        if(REVISION_KIND.equals(kind))throw error(403,"resource_kind_reserved","请通过资源标识读取指定版本。");
        int current=Json.integer(head,"version",0);head.addProperty("version",current);
        if(!p.has("version")||exactInteger(p,"version",0)==current)return head;
        int requested=exactInteger(p,"version",0);JsonObject row=Store.one(c,"SELECT kind,data FROM resources WHERE id=?","resource-version:"+id+":"+requested);
        if(row==null||!REVISION_KIND.equals(Json.required(row,"kind")))throw error(404,"resource_version_missing","指定的资源版本不存在。");
        JsonObject revision=Json.parse(row.get("data").getAsString());
        if(!id.equals(Json.required(revision,"resourceId")))throw error(409,"resource_version_invalid","资源版本关联不一致。");
        return Json.object(revision,"resource").deepCopy();
    }

    private static JsonObject fields(JsonObject p,String kind,JsonElement content){return Json.obj("kind",kind,"name",boundedText(p,"name",100,null),"category",boundedText(p,"category",100,""),"note",boundedText(p,"note",4000,""),"content",content);}
    private static String boundedText(JsonObject p,String key,int max,String fallback){String value=Json.str(p,key,fallback);if(value==null||value.length()>max||(fallback==null&&value.isBlank()))throw error(400,"resource_field_invalid","资源字段为空或过长："+key);return value.strip();}
    private static int exactInteger(JsonObject p,String key,int minimum){try{JsonElement value=p.get(key);if(value==null||!value.isJsonPrimitive()||!value.getAsJsonPrimitive().isNumber())throw new ArithmeticException();int number=value.getAsBigDecimal().intValueExact();if(number<minimum)throw new ArithmeticException();return number;}catch(Exception e){throw error(400,"resource_version_invalid",key+" 必须是有效的非负整数。");}}
    private static JsonElement templateField(JsonObject template,String field){return template.has(field)?template.get(field):Json.object(template,"settings").get(field);}
    private static void validateTemplate(JsonObject template){TaskTemplates.validate(template,"resource_template_invalid");}
    private static JsonObject templateSnapshot(JsonObject project,JsonObject asset){
        JsonObject stored=Json.object(Json.object(asset,"metadata"),"annotationTemplate");JsonObject settings=new JsonObject();
        for(String field:TEMPLATE_FIELDS)if(!field.equals("classes")){JsonElement value=Json.object(stored,"settings").get(field);if(value==null&&stored.isEmpty()&&Set.of("keypointNames","keypointConnections").contains(field))value=Json.object(project,"settings").get(field);if(value!=null)settings.add(field,value.deepCopy());}
        return Json.obj("taskType",project.get("taskType"),"classes",stored.has("classes")?stored.get("classes").deepCopy():Json.array(project,"classes").deepCopy(),"settings",settings);
    }
    private static void requireHuman(JsonObject asset,int version){
        if(Json.integer(asset,"version",0)!=version)throw error(409,"reference_source_changed","素材的人工版本已变化，请重新载入后加入参考库。");
        if(!Set.of("modified","confirmed").contains(Json.str(asset,"status",""))||!Set.of("manual","preset_manual").contains(Json.str(asset,"source","")))throw error(422,"reference_human_required","请先明确人工修改或确认标注，再加入参考库；候选和草稿不能作为人工参考。");
    }
    private static Map<String,String> classes(JsonObject template){Map<String,String> result=new LinkedHashMap<>();for(JsonElement element:Json.array(template,"classes")){JsonObject category=element.getAsJsonObject();result.put(Json.required(category,"id"),Json.required(category,"name"));}return result;}
    private static void verifyImage(Path file,String hash,int width,int height)throws IOException{
        try{if(!Files.isRegularFile(file)||!Media.hash(file).equals(hash))throw error(409,"reference_snapshot_invalid","参考图片缺失或内容指纹与快照不符。");}
        catch(ApiError e){throw e;}catch(IOException e){throw e;}catch(Exception e){throw error(409,"reference_snapshot_invalid","参考图片指纹无法校验。");}
        // 基准图在导入时已完整解码；读取尺寸时不再次分配整张大图，避免参考数量放大内存使用。
        try(ImageInputStream input=ImageIO.createImageInputStream(file.toFile())){
            if(input==null)throw error(409,"reference_snapshot_invalid","参考图片无法解码。");Iterator<ImageReader> readers=ImageIO.getImageReaders(input);
            if(!readers.hasNext())throw error(409,"reference_snapshot_invalid","参考图片无法解码。");ImageReader reader=readers.next();
            try{reader.setInput(input,true,true);if(!reader.getFormatName().equalsIgnoreCase("png")||reader.getWidth(0)!=width||reader.getHeight(0)!=height)throw error(409,"reference_snapshot_invalid","参考图片尺寸或编码与快照不符。");}finally{reader.dispose();}
        }
    }
    private static boolean validPointIndex(JsonArray points,JsonElement value){try{if(value.getAsJsonPrimitive().isNumber())value.getAsBigDecimal().intValueExact();return OverlayRenderer.pointIndex(points,value)>=0;}catch(Exception e){return false;}}
    private void discardUnpublished(Path file){try{Path base=store.root.resolve("resource-library").toAbsolutePath().normalize(),target=file.toAbsolutePath().normalize();if(target.startsWith(base)){Files.deleteIfExists(target);Files.deleteIfExists(target.getParent());}}catch(IOException ignored){/* 未发布残留可交由依赖清理识别，不删除任何已发布版本。 */}}
    private static ApiError error(int status,String code,String message){return new ApiError(status,code,message);}
}
