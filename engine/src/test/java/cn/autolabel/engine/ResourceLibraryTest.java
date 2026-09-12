package cn.autolabel.engine;

import com.google.gson.*;
import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.nio.file.*;
import java.util.*;

public final class ResourceLibraryTest {
    private static int checks;
    private interface Action {void run()throws Exception;}
    private static void check(boolean condition,String message){checks++;if(!condition)throw new AssertionError(message);}
    private static void rejects(String code,Action action)throws Exception{try{action.run();throw new AssertionError("Expected "+code);}catch(ApiError error){check(error.code.equals(code),"Expected "+code+", got "+error.code);}}

    public static void main(String[] args)throws Exception{
        Path root=args.length==0?Files.createTempDirectory("autolabel-resource-test-"):Path.of(args[0]).toAbsolutePath().resolve("resource-test-"+Json.id());
        Files.createDirectories(root);run(root);System.out.println("Resource library: "+checks+" checks passed; isolated data: "+root);
    }

    static void run(Path root)throws Exception{
        try(Store store=new Store(root.resolve("data"))){
            Projects projects=new Projects(store);ResourceLibrary library=new ResourceLibrary(store,projects);
            versioning(store,projects,library);references(root,store,projects,library);pose(root,store,projects,library);
        }
        try(Store reopened=new Store(root.resolve("data"))){
            ResourceLibrary library=new ResourceLibrary(reopened,new Projects(reopened));
            JsonArray refs=library.list(Json.obj("kind","reference","query","更新"));check(refs.size()==1,"reference head survives restart");
            JsonObject head=refs.get(0).getAsJsonObject();JsonObject old=library.get(Json.obj("resourceId",head.get("id"),"version",1));
            check(Json.str(old,"note","").equals("手工核对边界"),"frozen human note survives restart");
            check(Files.isRegularFile(library.referencePath(Json.object(old,"content"))),"reference copy survives restart");
        }
    }

    private static void versioning(Store store,Projects projects,ResourceLibrary library)throws Exception{
        JsonObject project=project(projects,"detect","item","物品"),created=library.save(Json.obj("kind","prompt","name","边界规则","category","检测","note","保留模糊边界约定","content","沿可见边界标注"));
        String id=Json.required(created,"id"),pid=Json.required(project,"id");
        check(Json.integer(created,"version",0)==1,"new resource is version one");
        JsonObject applied=library.apply(Json.obj("projectId",pid,"resourceId",id,"version",1,"fields",Json.arr("prompt")));
        check(Json.str(Json.object(Json.object(applied,"project"),"settings"),"prompt","").equals("沿可见边界标注"),"plain prompt applies to project");
        check(Json.str(Json.object(Json.object(applied,"project"),"settings"),"untouched","").equals("keep"),"unselected setting preserved");
        JsonObject next=library.save(Json.obj("id",id,"baseVersion",1,"kind","prompt","name","边界规则修订","category","检测","note","人工修订","content","第二版规则"));
        check(Json.integer(next,"version",0)==2,"resource update advances version");
        check(library.get(Json.obj("resourceId",id,"version",1)).get("content").getAsString().equals("沿可见边界标注"),"old prompt immutable");
        check(Json.str(Json.object(projects.get(pid),"settings"),"prompt","").equals("沿可见边界标注"),"resource edit does not mutate applied project");
        check(Json.integer(Json.object(Json.object(Json.object(projects.get(pid),"settings"),"resourceOrigins"),"prompt"),"version",0)==1,"project records applied version");
        rejects("resource_version_conflict",()->library.save(Json.obj("id",id,"baseVersion",1,"kind","prompt","name","过期","content","旧修改")));
        rejects("resource_version_conflict",()->library.save(Json.obj("id",id,"kind","prompt","name","缺少版本","content","旧修改")));
        rejects("resource_kind_immutable",()->library.save(Json.obj("id",id,"baseVersion",2,"kind","flow","name","改类型","content",Json.obj("version",1,"steps",new JsonArray()))));
        for(String kind:List.of("reference","resource_version","evaluation_comparison"))rejects("resource_kind_reserved",()->library.save(Json.obj("kind",kind,"name","伪造","content",new JsonObject())));
        rejects("resource_fields_required",()->library.apply(Json.obj("projectId",pid,"resourceId",id)));
        rejects("resource_field_invalid",()->library.apply(Json.obj("projectId",pid,"resourceId",id,"fields",Json.arr("classes"))));
        store.tx(c->{
            Store.update(c,"INSERT INTO resources(id,kind,data) VALUES(?,?,?)","legacy-prompt","prompt",Json.obj("id","legacy-prompt","kind","prompt","name","旧提示词","content","旧内容"));
            Store.update(c,"INSERT INTO resources(id,kind,data) VALUES(?,?,?)","comparison","evaluation_comparison",Json.obj("id","comparison","kind","evaluation_comparison","name","内部比较"));return null;
        });
        check(Json.integer(library.get(Json.obj("resourceId","legacy-prompt")),"version",-1)==0,"legacy head readable as version zero");
        JsonObject migrated=library.save(Json.obj("id","legacy-prompt","baseVersion",0,"kind","prompt","name","已迁移","content","新内容"));
        check(Json.integer(migrated,"version",0)==1,"legacy migrates to first version");
        check(library.get(Json.obj("resourceId","legacy-prompt","version",0)).get("content").getAsString().equals("旧内容"),"legacy history retained");
        check(library.list(new JsonObject()).size()==2,"default list excludes revisions and internal comparison");
        check(library.list(Json.obj("kind","evaluation_comparison")).size()==1,"explicit comparison list remains available");
        check(library.list(Json.obj("query","人工修订","category","检测")).size()==1,"category and note search select latest head");
        check(library.list(Json.obj("query","%_'")).isEmpty(),"query is literal and parameterized");
        check(library.list(Json.obj("limit",1,"offset",1)).size()==1,"resource pagination available");

        JsonObject template=library.save(Json.obj("kind","template","name","检测模板","content",Json.obj("taskType","detect","classes",Json.arr(Json.obj("id","other","name","另一类")),"rules",Json.obj("blur","保留待检查"))));
        JsonObject onlyRules=library.apply(Json.obj("projectId",pid,"resourceId",template.get("id"),"fields",Json.arr("rules")));
        check(Json.array(Json.object(onlyRules,"project"),"classes").get(0).getAsJsonObject().get("id").getAsString().equals("item"),"template does not overwrite unselected classes");
        check(Json.str(Json.object(Json.object(Json.object(onlyRules,"project"),"settings"),"rules"),"blur","").equals("保留待检查"),"template rule applied");
        rejects("resource_template_incompatible",()->library.apply(Json.obj("projectId",project(projects,"classify","item","物品").get("id"),"resourceId",template.get("id"),"fields",Json.arr("classes"))));
        JsonObject flow=library.save(Json.obj("kind","flow","name","图片流程","content",Json.obj("version",1,"name","逐步处理","steps",Json.arr(Json.obj("id","import","kind","import","enabled",true,"parameters",new JsonObject())))));
        check(Json.object(Json.object(Json.object(library.apply(Json.obj("projectId",pid,"resourceId",flow.get("id"),"fields",Json.arr("flow"))),"project"),"settings"),"flow").has("steps"),"flow JSON applies unchanged");
        String largeRule="边界约定".repeat(30_000);JsonObject large=library.save(Json.obj("kind","template","name","完整规则模板","content",Json.obj("taskType","detect","rules",Json.obj("description",largeRule))));
        library.save(Json.obj("id",large.get("id"),"baseVersion",1,"kind","template","name","规则修订","content",Json.obj("taskType","detect","rules",new JsonObject())));
        check(Json.str(Json.object(Json.object(library.get(Json.obj("resourceId",large.get("id"),"version",1)),"content"),"rules"),"description","").equals(largeRule),"stored historical template over 100k reads without external text field limit");
    }

    private static void references(Path root,Store store,Projects projects,ResourceLibrary library)throws Exception{
        JsonObject sourceProject=project(projects,"detect","item","物品"),targetProject=project(projects,"detect","target","目标物品");
        String sourceId=asset(root,projects,Json.required(sourceProject,"id"),"source.png"),targetId=asset(root,projects,Json.required(targetProject,"id"),"target.png");
        rejects("reference_human_required",()->library.addReference(Json.obj("assetId",sourceId,"assetVersion",0,"name","未标注")));
        projects.draft(Json.obj("assetId",sourceId,"baseVersion",0,"annotations",Json.arr(box("item",4))));
        rejects("reference_human_required",()->library.addReference(Json.obj("assetId",sourceId,"assetVersion",0,"name","仅草稿")));
        projects.save(Json.obj("assetId",sourceId,"baseVersion",0,"annotations",Json.arr(box("item",4))));
        store.tx(c->{JsonObject asset=Store.document(c,"assets",sourceId);Json.object(asset,"metadata").addProperty("rootAssetId","known-root");Store.update(c,"UPDATE assets SET data=? WHERE id=?",asset,sourceId);return null;});
        JsonObject reference=library.addReference(Json.obj("assetId",sourceId,"assetVersion",1,"name","人工参考","category","边界","note","手工核对边界"));
        String rid=Json.required(reference,"id");Path frozen=library.referencePath(Json.object(reference,"content"));
        check(!frozen.equals(projects.path(sourceId)),"reference stores independent managed image");
        check(Json.array(Json.object(reference,"content"),"annotations").size()==1,"reference freezes formal annotations");
        check(!Json.object(reference,"content").has("draft"),"reference excludes draft");
        rejects("reference_source_changed",()->library.addReference(Json.obj("assetId",sourceId,"assetVersion",0,"name","过期选择")));
        rejects("reference_class_map_required",()->resolve(store,library,Json.obj("resourceId",rid),targetProject));
        rejects("reference_class_map_invalid",()->resolve(store,library,Json.obj("resourceId",rid,"classMap",new JsonObject()),targetProject));
        rejects("reference_class_map_invalid",()->resolve(store,library,Json.obj("resourceId",rid,"classMap",Json.obj("item","missing")),targetProject));
        JsonObject selection=Json.obj("resourceId",rid,"version",1,"classMap",Json.obj("item","target"));
        JsonObject resolved=resolve(store,library,selection,targetProject);
        check(Json.array(resolved,"annotations").get(0).getAsJsonObject().get("classId").getAsString().equals("target"),"explicit cross-project class mapping works");
        check(Json.required(resolved,"id").equals(sourceId)&&Json.required(resolved,"resourceId").equals(rid),"run snapshot retains source and resource identity");
        check(Json.object(resolved,"metadata").has("sourceHash"),"same-origin fingerprint retained for evaluation isolation");
        check(Json.str(Json.object(resolved,"metadata"),"rootAssetId","").equals("known-root"),"same-origin root retained across projects");
        check(Json.required(resolved,"status").equals("reference"),"reference resolution does not inherit manual confirmation");
        check(Json.required(projects.asset(targetId),"status").equals("unlabeled"),"resolving reference does not edit target asset");
        JsonObject semanticMismatch=project(projects,"detect","item","含义不同");
        rejects("reference_class_map_required",()->resolve(store,library,Json.obj("resourceId",rid),semanticMismatch));
        check(resolve(store,library,Json.obj("resourceId",rid,"classMap",Json.obj("item","item")),semanticMismatch).has("annotations"),"same id with changed meaning requires explicit mapping");
        JsonObject same=project(projects,"detect","item","物品");check(resolve(store,library,Json.obj("resourceId",rid),same).has("inputPath"),"compatible categories need no mapping");

        JsonObject incompatible=library.save(Json.obj("kind","template","name","不兼容类别","content",Json.obj("taskType","detect","classes",Json.arr(Json.obj("id","replacement","name","替换")),"prompt","不得落盘")));
        rejects("annotation_invalid",()->library.apply(Json.obj("projectId",sourceProject.get("id"),"resourceId",incompatible.get("id"),"fields",Json.arr("classes","prompt"))));
        check(!Json.str(Json.object(projects.get(Json.required(sourceProject,"id")),"settings"),"prompt","").equals("不得落盘"),"incompatible application rolls back all selected fields");
        projects.save(Json.obj("assetId",sourceId,"baseVersion",1,"annotations",Json.arr(box("item",12)),"confirm",true));
        JsonObject second=library.addReference(Json.obj("id",rid,"baseVersion",1,"assetId",sourceId,"assetVersion",2,"name","人工参考更新","note","第二版"));
        check(Json.integer(second,"version",0)==2,"explicit reference update versions image and annotations");
        rejects("resource_version_conflict",()->library.addReference(Json.obj("id",rid,"baseVersion",1,"assetId",sourceId,"assetVersion",2,"name","过期参考修改")));
        check(Json.integer(library.get(Json.obj("resourceId",rid)),"version",0)==2&&Files.isRegularFile(frozen),"rejected reference update preserves head and old immutable image");
        check(Json.decimal(Json.object(Json.array(resolve(store,library,selection,targetProject),"annotations").get(0).getAsJsonObject(),"bbox"),"x",0)==4,"old reference preserves original annotation after human edit");
        check(Json.decimal(Json.object(Json.array(Json.object(second,"content"),"annotations").get(0).getAsJsonObject(),"bbox"),"x",0)==12,"new reference contains new human revision");
        Files.move(projects.path(sourceId),root.resolve("moved-source-baseline.png"));
        check(Files.isRegularFile(library.referencePath(resolve(store,library,selection,targetProject))),"reference remains usable after source baseline moves");
        byte[] original=Files.readAllBytes(frozen);Files.writeString(frozen,"changed");
        rejects("reference_snapshot_invalid",()->resolve(store,library,selection,targetProject));Files.write(frozen,original);
        JsonObject traversal=resolved.deepCopy();traversal.addProperty("referenceImage","../outside.png");
        rejects("reference_path_invalid",()->library.referencePath(traversal));
        JsonObject wrongSize=resolved.deepCopy();wrongSize.addProperty("width",999);rejects("reference_snapshot_invalid",()->library.referencePath(wrongSize));
        store.tx(c->{JsonObject asset=Store.document(c,"assets",targetId);asset.addProperty("source","api");asset.addProperty("status","confirmed");Store.update(c,"UPDATE assets SET data=? WHERE id=?",asset,targetId);return null;});
        rejects("reference_human_required",()->library.addReference(Json.obj("assetId",targetId,"assetVersion",0,"name","伪造人工状态")));
    }

    private static void pose(Path root,Store store,Projects projects,ResourceLibrary library)throws Exception{
        JsonObject source=project(projects,"pose","item","物品"),target=project(projects,"pose","item","物品");
        String sourceId=asset(root,projects,Json.required(source,"id"),"pose.png");
        JsonObject annotation=box("item",4);annotation.addProperty("type","pose");annotation.add("keypoints",Json.arr(Json.obj("name","左","x",5,"y",6,"visibility",2),Json.obj("name","右","x",0,"y",0,"visibility",0)));
        projects.save(Json.obj("assetId",sourceId,"baseVersion",0,"annotations",Json.arr(annotation),"confirm",true));
        JsonObject resource=library.addReference(Json.obj("assetId",sourceId,"assetVersion",1,"name","姿态参考")),selection=Json.obj("resourceId",resource.get("id"));
        check(resolve(store,library,selection,target).has("annotations"),"matching pose template resolves");
        JsonObject mismatch=target.deepCopy();Json.object(mismatch,"settings").add("keypointNames",Json.arr("右","左"));
        rejects("reference_template_incompatible",()->resolve(store,library,selection,mismatch));
        JsonObject connectionMismatch=target.deepCopy();Json.object(connectionMismatch,"settings").add("keypointConnections",new JsonArray());
        rejects("reference_template_incompatible",()->resolve(store,library,selection,connectionMismatch));
        rejects("reference_template_incompatible",()->resolve(store,library,selection,project(projects,"detect","item","物品")));
        JsonObject referenceAnnotations=Json.array(resolve(store,library,selection,target),"annotations").get(0).getAsJsonObject();
        check(Json.integer(Json.array(referenceAnnotations,"keypoints").get(1).getAsJsonObject(),"visibility",-1)==0,"unlocated point stays unlocated");
    }

    private static JsonObject resolve(Store store,ResourceLibrary library,JsonObject selection,JsonObject target){return store.read(c->library.resolveReference(c,selection,target));}
    private static JsonObject project(Projects projects,String type,String classId,String name){return projects.create(Json.obj("name","资源验证 "+type,"taskType",type,"classes",Json.arr(Json.obj("id",classId,"name",name,"color","#4488ff")),"settings",Json.obj("untouched","keep","keypointNames",Json.arr("左","右"),"keypointConnections",Json.arr(Json.arr(0,1)))));}
    private static String asset(Path root,Projects projects,String projectId,String name)throws Exception{Path file=root.resolve(name);ImageIO.write(new BufferedImage(64,48,BufferedImage.TYPE_INT_RGB),"png",file.toFile());JsonObject result=projects.importAssets(Json.obj("projectId",projectId,"paths",Json.arr(file.toString())));return Json.array(result,"assetIds").get(0).getAsString();}
    private static JsonObject box(String category,double x){return Json.obj("id","object-one","type","detect","classId",category,"bbox",Json.obj("x",x,"y",4,"width",20,"height",18));}
}
