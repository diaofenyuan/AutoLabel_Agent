package cn.autolabel.engine;

import com.google.gson.*;
import java.util.*;

final class Annotations {
    static final Set<String> TYPES=Set.of("detect","obb","segment","pose","classify");
    static void classes(JsonArray classes){
        Set<String> ids=new HashSet<>(),names=new HashSet<>();
        for(JsonElement e:classes){JsonObject c=e.getAsJsonObject();String id=Json.required(c,"id"),name=Json.required(c,"name");
            if(!ids.add(id)||!names.add(name))throw error("类别 ID 和名称不能重复。");
            if(!Json.str(c,"color","#3b82f6").matches("#[0-9a-fA-F]{6}"))throw error("类别颜色应为 #RRGGBB。");}
    }
    static JsonArray validate(JsonArray input,JsonObject asset,JsonObject project){
        if(input.size()>10000)throw error("单图对象过多。");
        JsonArray annotations=input.deepCopy();Set<String> classes=new HashSet<>(),ids=new HashSet<>();
        for(JsonElement c:Json.array(project,"classes"))classes.add(Json.required(c.getAsJsonObject(),"id"));
        int width=Json.integer(asset,"width",0),height=Json.integer(asset,"height",0);
        String task=Json.required(project,"taskType");JsonArray names=Json.array(Json.object(project,"settings"),"keypointNames");
        if(task.equals("classify")&&annotations.size()>1)throw error("分类导出要求每张图片至多一个类别。");
        for(JsonElement e:annotations){
            if(!e.isJsonObject())throw error("标注对象必须为 JSON 对象。");JsonObject a=e.getAsJsonObject();
            if(!ids.add(Json.required(a,"id")))throw error("标注对象 ID 不能重复。");
            if(!classes.contains(Json.required(a,"classId")))throw error("标注引用了项目中不存在的类别。");
            String type=Json.required(a,"type");if(!type.equals(task))throw error("标注类型与项目任务不一致。");
            switch(type){
                case "detect"->bbox(a,width,height,true);
                case "pose"->{bbox(a,width,height,true);JsonArray points=Json.array(a,"keypoints");
                    if(names.isEmpty())throw error("请先在项目设置 keypointNames 中保存关键点名称及顺序。");
                    if(points.size()!=names.size())throw error("关键点数量与模板不一致。");
                    for(int i=0;i<names.size();i++){JsonObject p=points.get(i).getAsJsonObject();if(!Json.required(p,"name").equals(names.get(i).getAsString()))throw error("关键点名称或顺序与模板不一致。");
                        int v=Json.integer(p,"visibility",-1);if(v<0||v>2)throw error("关键点可见性必须为 0、1、2。");
                        if(v==0){p.addProperty("x",0);p.addProperty("y",0);}else point(p,width,height);}
                }
                case "obb"->{JsonArray corners=obb(a);if(corners.size()!=4)throw error("旋转框必须包含四个矩形顶点。");polygon(corners,width,height,true);}
                case "segment"->polygon(Json.array(a,"points"),width,height,false);
                case "classify"->{}
                default->throw error("不支持的标注类型。");
            }
            if(a.has("confidence")){double v=a.get("confidence").getAsDouble();if(!Double.isFinite(v)||v<0||v>1)throw error("置信度应在 0～1 范围。");}
            JsonElement definitions=Json.object(project,"settings").get("attributes");if(definitions!=null&&definitions.isJsonObject()&&Json.str(definitions.getAsJsonObject(),"kind","").equals("attribute_definitions")){
                if(a.has("attributes")&&!a.get("attributes").isJsonObject())throw new ApiError(422,"annotation_attributes_invalid","标注属性必须为对象。",Json.obj("annotationId",a.get("id")));
                JsonArray issues=TemplateAttributes.validateValues(definitions,Json.object(a,"attributes"));if(!issues.isEmpty())throw new ApiError(422,"annotation_attributes_invalid","标注属性与本次模板不符。",Json.obj("annotationId",a.get("id"),"issues",issues));
            }
        }return annotations;
    }
    static JsonArray validateStored(JsonArray input,JsonObject asset,JsonObject project){
        // 新的必填属性不追溯套用于旧版本；几何和类别仍按当前目标项目核对兼容性。
        JsonObject context=project.deepCopy(),settings=Json.object(context,"settings");JsonElement captured=Json.object(Json.object(Json.object(asset,"metadata"),"annotationTemplate"),"settings").get("attributes");if(captured==null)settings.remove("attributes");else settings.add("attributes",captured.deepCopy());context.add("settings",settings);return validate(input,asset,context);
    }
    static JsonArray validateGeometry(JsonArray input,JsonObject asset,JsonObject project){
        // 原始生成贡献可缺待人工补齐的属性；调用方写正式候选前仍必须走完整 validate。
        JsonObject geometry=project.deepCopy(),settings=Json.object(geometry,"settings");settings.remove("attributes");geometry.add("settings",settings);return validate(input,asset,geometry);
    }
    static double num(JsonObject o,String key){if(!o.has(key))throw error("缺少几何字段："+key);double d=o.get(key).getAsDouble();if(!Double.isFinite(d))throw error("坐标必须为有限数值。");return d;}
    static void point(JsonObject p,int w,int h){double x=num(p,"x"),y=num(p,"y");if(x<0||y<0||x>w||y>h)throw error("坐标超出基准图范围。");}
    static void bbox(JsonObject a,int w,int h,boolean bounds){JsonObject b=Json.object(a,"bbox");double x=num(b,"x"),y=num(b,"y"),bw=num(b,"width"),bh=num(b,"height");
        if(bw<=0||bh<=0)throw error("框的宽高必须大于零。");if(bounds&&(x<0||y<0||x+bw>w+1e-6||y+bh>h+1e-6))throw error("框超出基准图范围。");}
    static JsonArray obb(JsonObject a){
        JsonArray points=Json.array(a,"points");if(!points.isEmpty())return points;
        bbox(a,Integer.MAX_VALUE,Integer.MAX_VALUE,false);JsonObject b=Json.object(a,"bbox");double w=num(b,"width"),h=num(b,"height"),cx=num(b,"x")+w/2,cy=num(b,"y")+h/2;
        double angle=Math.toRadians(Json.decimal(a,"rotation",0));if(!Double.isFinite(angle))throw error("旋转角无效。");JsonArray result=new JsonArray();
        for(double[] p:new double[][]{{-w/2,-h/2},{w/2,-h/2},{w/2,h/2},{-w/2,h/2}})result.add(Json.obj("x",cx+p[0]*Math.cos(angle)-p[1]*Math.sin(angle),"y",cy+p[0]*Math.sin(angle)+p[1]*Math.cos(angle)));
        return result;
    }
    static void polygon(JsonArray points,int w,int h,boolean rectangle){
        if(points.size()<3||points.size()>4096)throw error("轮廓需要 3～4096 个有序顶点。");int n=points.size();double[][] p=new double[n][2];
        for(int i=0;i<n;i++){JsonObject q=points.get(i).getAsJsonObject();point(q,w,h);p[i][0]=num(q,"x");p[i][1]=num(q,"y");}
        double area=0;for(int i=0;i<n;i++){double[] a=p[i],b=p[(i+1)%n];area+=a[0]*b[1]-a[1]*b[0];if(Math.hypot(b[0]-a[0],b[1]-a[1])<1e-7)throw error("轮廓存在重复相邻顶点。");}
        if(Math.abs(area)<1e-6)throw error("轮廓面积必须大于零。");
        for(int i=0;i<n;i++)for(int j=i+1;j<n;j++){if(j==i+1||(i==0&&j==n-1))continue;if(intersects(p[i],p[(i+1)%n],p[j],p[(j+1)%n]))throw error("轮廓存在自相交。");}
        if(rectangle){for(int i=0;i<4;i++){double[] a=p[i],b=p[(i+1)%4],c=p[(i+2)%4];double ux=b[0]-a[0],uy=b[1]-a[1],vx=c[0]-b[0],vy=c[1]-b[1];
            if(Math.abs(ux*vx+uy*vy)>1e-5*Math.hypot(ux,uy)*Math.hypot(vx,vy))throw error("透视四边形不是旋转矩形；保留角点身份时请使用 Pose。");}}
    }
    static boolean intersects(double[] a,double[] b,double[] c,double[] d){return java.awt.geom.Line2D.linesIntersect(a[0],a[1],b[0],b[1],c[0],c[1],d[0],d[1]);}
    static ApiError error(String message){return new ApiError(422,"annotation_invalid",message);}
}
