package cn.autolabel.engine;

import com.google.gson.*;
import java.nio.file.*;
import java.util.*;

final class YoloImporter {
    private final Store store;private final Projects projects;
    YoloImporter(Store store,Projects projects){this.store=store;this.projects=projects;}
    JsonObject importLabels(JsonObject p)throws Exception{
        String pid=Json.required(p,"projectId"),space=Json.required(p,"labelSpace");if(!Set.of("source","baseline").contains(space))throw new ApiError(400,"label_space_required","请明确标签使用 source 源文件坐标还是 baseline 基准图坐标。");
        JsonObject project=projects.get(pid),classMap=Json.object(p,"classMap");String type=Json.required(project,"taskType");if(type.equals("classify"))throw new ApiError(422,"classification_import_unsupported","分类数据使用类别文件夹结构，当前标签文本导入入口支持 Detect、Pose、OBB、Segment。");
        if(classMap.isEmpty())throw new ApiError(400,"class_map_required","请明确 YOLO 类别编号到项目类别 ID 的映射。");
        for(var entry:classMap.entrySet())if(!entry.getKey().matches("0|[1-9][0-9]*")||!entry.getValue().isJsonPrimitive())throw new ApiError(400,"class_map_invalid","类别映射应使用非负整数编号和稳定类别 ID。");
        JsonArray items=Json.array(p,"items").deepCopy();
        if(items.isEmpty()){
            Path directory=Path.of(Json.required(p,"labelsDir")).toAbsolutePath().normalize();if(!Files.isDirectory(directory))throw new ApiError(400,"directory_unavailable","标签目录不可访问。");
            Set<String> selected=new HashSet<>();for(JsonElement e:Json.array(p,"assetIds"))selected.add(e.getAsString());if(p.has("assetIds")&&selected.isEmpty())throw new ApiError(400,"asset_selection_empty","请选择素材。");
            JsonArray assets=store.read(c->Store.docs(c,"SELECT data FROM assets WHERE project_id=?",pid));Map<String,Integer> names=new HashMap<>();for(JsonElement e:assets){String name=stem(Json.required(e.getAsJsonObject(),"name"));names.merge(name,1,Integer::sum);}
            for(JsonElement e:assets){JsonObject asset=e.getAsJsonObject();String id=Json.required(asset,"id");if(!selected.isEmpty()&&!selected.contains(id))continue;String basename=stem(Json.required(asset,"name"));items.add(Json.obj("assetId",id,"labelPath",directory.resolve(basename+".txt").toString(),"ambiguous",names.get(basename)>1));}
            if(!selected.isEmpty()&&items.size()!=selected.size())throw new ApiError(400,"asset_project_mismatch","所选素材不属于当前项目。");
        }
        if(items.isEmpty())throw new ApiError(400,"asset_selection_empty","没有可导入标签的素材。");if(items.size()>10000)throw new ApiError(413,"import_batch_too_large","单次标签导入最多 10000 张。");
        JsonArray errors=new JsonArray(),saved=new JsonArray();Set<String> seen=new HashSet<>();
        for(JsonElement entry:items){JsonObject item=entry.getAsJsonObject();String aid=Json.required(item,"assetId");try{
            if(!seen.add(aid))throw new ApiError(400,"asset_duplicate","同一素材不能重复导入。");if(Json.bool(item,"ambiguous",false))throw new ApiError(409,"label_name_ambiguous","同名素材无法唯一对应标签，请通过 items 明确对应文件。");
            JsonObject asset=projects.asset(aid);if(!Json.required(asset,"projectId").equals(pid))throw new ApiError(400,"asset_project_mismatch","素材不属于当前项目。");
            if((Json.integer(asset,"version",0)>0||asset.has("draft"))&&!item.has("baseVersion"))throw new ApiError(409,"annotation_existing","该素材已有正式标注或草稿，请明确 baseVersion 后再导入替换。");
            Path path=Path.of(Json.required(item,"labelPath")).toAbsolutePath().normalize();if(!Files.isRegularFile(path))throw new ApiError(404,"label_missing","对应标签文件不存在，原标注保持不变。");if(Files.size(path)>2L*1024*1024)throw new ApiError(413,"label_too_large","单个标签文件不能超过 2 MiB。");
            JsonArray annotations=parse(Files.readString(path).replaceFirst("^\uFEFF",""),asset,project,classMap,space);
            JsonObject result=projects.save(Json.obj("assetId",aid,"baseVersion",Json.integer(item,"baseVersion",Json.integer(asset,"version",0)),"annotations",annotations,"confirm",Json.bool(p,"confirm",false)),"imported_yolo",Json.obj("labelSpace",space,"fileName",path.getFileName().toString(),"labelHash",Media.hash(path),"importedAt",Json.now(),"sourceToBaselineApplied",space.equals("source"),"classMap",classMap));saved.add(result);
        }catch(Exception e){if(e instanceof ApiError a&&a.status>=500)throw a;errors.add(Json.obj("assetId",aid,"code",e instanceof ApiError a?a.code:"label_read_failed","message",e instanceof ApiError a?a.getMessage():"标签读取或解析失败，原标注保持不变。"));}}
        return Json.obj("imported",saved.size(),"errors",errors,"items",saved);
    }
    static String stem(String name){int dot=name.lastIndexOf('.');return dot>0?name.substring(0,dot):name;}
    static JsonArray parse(String text,JsonObject asset,JsonObject project,JsonObject classMap,String space){
        JsonObject metadata=Json.object(asset,"metadata");boolean source=space.equals("source");int width=source?Json.integer(metadata,"sourceWidth",0):Json.integer(asset,"width",0),height=source?Json.integer(metadata,"sourceHeight",0):Json.integer(asset,"height",0);
        if(width<1||height<1)throw new ApiError(422,"source_transform_missing","素材缺少原始尺寸或坐标变换，不能猜测标签方向。");JsonArray matrix=source?Json.array(metadata,"sourceToBaseline"):Json.arr(1,0,0,0,1,0);if(matrix.size()!=6)throw new ApiError(422,"source_transform_missing","素材缺少完整源图坐标变换。");
        String type=Json.required(project,"taskType");JsonArray names=Json.array(Json.object(project,"settings"),"keypointNames"),result=new JsonArray();int lineNo=0;
        for(String line:text.split("\\R")){lineNo++;if(line.isBlank())continue;String[] fields=line.strip().split("\\s+");
            try{
                if(!fields[0].matches("0|[1-9][0-9]*")||!classMap.has(fields[0]))throw new ApiError(422,"label_class_unmapped","YOLO 类别编号未映射："+fields[0]);
                JsonObject a=Json.obj("id",Json.id(),"classId",classMap.get(fields[0]),"type",type);
                if(type.equals("detect")||type.equals("pose")){
                    int required=type.equals("detect")?5:5+names.size()*3;if(fields.length!=required||type.equals("pose")&&names.isEmpty())throw new ApiError(422,"label_columns_invalid","标签列数与任务及关键点模板不一致（Pose 使用 x y visibility 三维格式）。");
                    double cx=unit(fields[1])*width,cy=unit(fields[2])*height,w=unit(fields[3])*width,h=unit(fields[4])*height;
                    if(w<=0||h<=0||cx-w/2< -1e-6||cy-h/2< -1e-6||cx+w/2>width+1e-6||cy+h/2>height+1e-6)throw new ApiError(422,"label_geometry_invalid","标签框超出源图范围或宽高无效。");
                    JsonArray corners=Json.arr(point(cx-w/2,cy-h/2,matrix),point(cx+w/2,cy-h/2,matrix),point(cx+w/2,cy+h/2,matrix),point(cx-w/2,cy+h/2,matrix));a.add("bbox",bounds(corners));
                    if(type.equals("pose")){JsonArray keypoints=new JsonArray();for(int i=0;i<names.size();i++){double x=unit(fields[5+3*i])*width,y=unit(fields[6+3*i])*height;String visibility=fields[7+3*i];if(!visibility.matches("[012]"))throw new ApiError(422,"label_visibility_invalid","关键点可见性必须为 0、1、2。");int v=Integer.parseInt(visibility);JsonObject k=v==0?Json.obj("x",0,"y",0):point(x,y,matrix);k.add("name",names.get(i));k.addProperty("visibility",v);keypoints.add(k);}a.add("keypoints",keypoints);}
                }else{if(type.equals("obb")&&fields.length!=9||type.equals("segment")&&(fields.length<7||fields.length%2!=1))throw new ApiError(422,"label_columns_invalid","OBB 需要四个顶点，Segment 至少三个顶点。");
                    JsonArray points=new JsonArray();for(int i=1;i<fields.length;i+=2)points.add(point(unit(fields[i])*width,unit(fields[i+1])*height,matrix));a.add("points",points);}
                result.add(a);
            }catch(ApiError e){throw new ApiError(e.status,e.code,"第 "+lineNo+" 行："+e.getMessage());}catch(Exception e){throw new ApiError(422,"label_format_invalid","第 "+lineNo+" 行不是有效 YOLO 标签。");}
        }return Annotations.validate(result,asset,project);
    }
    static double unit(String raw){double value;try{value=Double.parseDouble(raw);}catch(Exception e){throw new ApiError(422,"label_number_invalid","标签坐标必须为数值。");}if(!Double.isFinite(value)||value<0||value>1)throw new ApiError(422,"label_number_invalid","YOLO 归一化坐标必须在 0～1 内。");return value;}
    static JsonObject point(double x,double y,JsonArray m){return Json.obj("x",m.get(0).getAsDouble()*x+m.get(1).getAsDouble()*y+m.get(2).getAsDouble(),"y",m.get(3).getAsDouble()*x+m.get(4).getAsDouble()*y+m.get(5).getAsDouble());}
    static JsonObject bounds(JsonArray points){double minX=Double.POSITIVE_INFINITY,minY=minX,maxX=Double.NEGATIVE_INFINITY,maxY=maxX;for(JsonElement e:points){JsonObject p=e.getAsJsonObject();double x=Annotations.num(p,"x"),y=Annotations.num(p,"y");minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);}return Json.obj("x",minX,"y",minY,"width",maxX-minX,"height",maxY-minY);}
}
