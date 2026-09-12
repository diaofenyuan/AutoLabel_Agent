package cn.autolabel.engine;

import com.google.gson.*;
import java.awt.geom.*;

final class RegionGeometry {
    record Region(Area shape,double area,double centerX,double centerY){}
    static Region region(JsonObject annotation){
        String type=Json.required(annotation,"type");JsonArray vertices=type.equals("obb")?Annotations.obb(annotation):Json.array(annotation,"points");if(vertices.size()<3)throw Annotations.error("区域标注缺少合法顶点。");
        Path2D.Double polygon=new Path2D.Double(Path2D.WIND_NON_ZERO);double crossSum=0,xSum=0,ySum=0,originX=Annotations.num(vertices.get(0).getAsJsonObject(),"x"),originY=Annotations.num(vertices.get(0).getAsJsonObject(),"y");
        for(int i=0;i<vertices.size();i++){JsonObject p=vertices.get(i).getAsJsonObject(),q=vertices.get((i+1)%vertices.size()).getAsJsonObject();double x=Annotations.num(p,"x"),y=Annotations.num(p,"y"),nx=Annotations.num(q,"x")-originX,ny=Annotations.num(q,"y")-originY;if(i==0)polygon.moveTo(x,y);else polygon.lineTo(x,y);x-=originX;y-=originY;double cross=x*ny-nx*y;crossSum+=cross;xSum+=(x+nx)*cross;ySum+=(y+ny)*cross;}
        polygon.closePath();if(Math.abs(crossSum)<1e-9)throw Annotations.error("区域面积为零，不能计算重叠。");return new Region(new Area(polygon),Math.abs(crossSum)/2,originX+xSum/(3*crossSum),originY+ySum/(3*crossSum));
    }
    static double area(Area shape){
        // Area 的各连通边界可能方向相反；累计有向面积后取绝对值，孔洞不会被重复当作填充区域。
        PathIterator iterator=shape.getPathIterator(null);double[] point=new double[6];double sum=0,x=0,y=0,startX=0,startY=0;
        while(!iterator.isDone()){int segment=iterator.currentSegment(point);switch(segment){case PathIterator.SEG_MOVETO->{startX=point[0];startY=point[1];x=y=0;}case PathIterator.SEG_LINETO->{double nx=point[0]-startX,ny=point[1]-startY;sum+=x*ny-nx*y;x=nx;y=ny;}case PathIterator.SEG_CLOSE->{}default->throw new ApiError(422,"evaluation_region_invalid","区域交集出现不支持的曲线边界。");}iterator.next();}return Math.abs(sum)/2;
    }
    static double iou(Region a,Region b){if(!a.shape.getBounds2D().intersects(b.shape.getBounds2D()))return 0;Area intersection=(Area)a.shape.clone();intersection.intersect(b.shape);double overlap=area(intersection),union=a.area+b.area-overlap;if(!Double.isFinite(overlap)||union<=0)throw new ApiError(422,"evaluation_region_invalid","区域重叠计算失败。");return Math.max(0,Math.min(1,overlap/union));}
    static double[] center(JsonObject annotation){String type=Json.required(annotation,"type");if(type.equals("obb")||type.equals("segment")){Region region=region(annotation);return new double[]{region.centerX,region.centerY};}JsonObject box=Json.object(annotation,"bbox");return new double[]{Annotations.num(box,"x")+Annotations.num(box,"width")/2,Annotations.num(box,"y")+Annotations.num(box,"height")/2};}
}
