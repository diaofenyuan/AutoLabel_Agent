package cn.autolabel.engine;

import com.google.gson.*;
import java.awt.Rectangle;
import java.awt.image.BufferedImage;
import java.io.*;
import java.nio.file.*;
import java.util.*;

/**
 * 转换模块（M4 几何部分）：静态裁剪、平铺、缩放对齐、灰度化与语义重映射。
 *
 * 坐标重建一律走 {@link TransformGeometry} 既有口径：plan() 生成视图矩阵，forward() 逐对象映射并给出
 * 截断/越界结论（I7），本类不另写一套变换。像素渲染使用确定性逐像素实现（I6：同配方同内容必然同字节）。
 * 顺序固定：裁剪 → 平铺 → 缩放 → 灰度化；顺序写入清单，因为顺序不同结果不同（5.3.5）。
 * 语义重映射只改标签空间：类别省略会同时丢弃对应标注并逐项计数，重命名保持类别标识不变。
 */
final class DatasetTransforms {
    static final String BOUNDARY_CLIP="clip",BOUNDARY_DROP="drop",BOUNDARY_KEEP="keep",BOUNDARY_REJECT="reject";
    static final String CROSS_CLIP="clip",CROSS_SKIP="skip";
    private static final Set<String> BOUNDARIES=Set.of(BOUNDARY_CLIP,BOUNDARY_DROP,BOUNDARY_KEEP,BOUNDARY_REJECT);
    private static final Set<String> CROSS=Set.of(CROSS_CLIP,CROSS_SKIP);
    private static final int MAX_GRID=100,MAX_NAME=100,MIN_FRACTION=1,MAX_SIDE=20000;

    private DatasetTransforms(){}

    // ===== 配方规范化 =====

    /** 只保留生效值；空配方返回空对象，调用方以 isEmpty() 判定「未启用转换」。 */
    static JsonObject normalize(JsonObject raw){
        keys(raw,"crop","tile","resize","grayscale","remap","boundaries","crossTile","augment");
        JsonObject crop=raw.has("crop")?crop(Json.object(raw,"crop")):null;
        JsonObject tile=raw.has("tile")?tile(Json.object(raw,"tile")):null;
        JsonObject resize=raw.has("resize")?resize(Json.object(raw,"resize")):null;
        boolean gray=Json.bool(raw,"grayscale",false);
        JsonObject remap=raw.has("remap")?remap(Json.object(raw,"remap")):null;
        JsonObject augment=raw.has("augment")?augment(Json.object(raw,"augment")):null;
        String boundaries=choice(raw,"boundaries",BOUNDARY_CLIP,BOUNDARIES),crossTile=choice(raw,"crossTile",CROSS_CLIP,CROSS);
        if(tile==null&&!crossTile.equals(CROSS_CLIP))throw invalid("crossTile 只能在平铺时配置。");
        JsonObject result=new JsonObject();
        if(crop!=null)result.add("crop",crop);
        if(tile!=null)result.add("tile",tile);
        if(resize!=null)result.add("resize",resize);
        if(gray)result.addProperty("grayscale",true);
        if(remap!=null)result.add("remap",remap);
        if(augment!=null&&augment.size()>0)result.add("augment",augment);
        if(!boundaries.equals(BOUNDARY_CLIP))result.addProperty("boundaries",boundaries);
        if(tile!=null&&!crossTile.equals(CROSS_CLIP))result.addProperty("crossTile",crossTile);
        return result;
    }

    // ===== 数据加强（阶段 D）：仅训练集生效（I5），参数由种子确定性推导（I6） =====

    static final int MAX_MULTIPLIER=4,CUTOUT_COVERAGE_PERCENT=50;

    /** 加强配方：倍数 0（关闭）～4；操作为布尔开关，参数区间固定并写入清单，保证跨版本可复核。 */
    private static JsonObject augment(JsonObject raw){
        keys(raw,"multiplier","flip","rotate90","cutout","brightness","contrast","saturation","noise");
        int multiplier=whole(raw,"multiplier",0,0,MAX_MULTIPLIER);
        JsonObject result=new JsonObject();
        if(multiplier>0){
            result.addProperty("multiplier",multiplier);
            if(raw.has("flip")&&!Json.str(raw,"flip","none").isEmpty())result.addProperty("flip",choice(raw,"flip","none",Set.of("none","horizontal","vertical")));
            if(Json.bool(raw,"rotate90",false))result.addProperty("rotate90",true);
            if(Json.bool(raw,"cutout",false))result.addProperty("cutout",true);
            if(Json.bool(raw,"brightness",false))result.addProperty("brightness",true);
            if(Json.bool(raw,"contrast",false))result.addProperty("contrast",true);
            if(Json.bool(raw,"saturation",false))result.addProperty("saturation",true);
            if(Json.bool(raw,"noise",false))result.addProperty("noise",true);
        }
        return result;
    }

    static boolean augmentEnabled(JsonObject transform){
        return enabled(transform)&&Json.integer(Json.object(transform,"augment"),"multiplier",0)>0;
    }

    /** 变体参数：由种子、素材与视图标识、变体序号的哈希确定性推导，不使用可变随机源（I6）。 */
    static JsonObject variantParams(JsonObject augment,String seed,String viewKey,int index){
        String hex=DatasetVersions.hashText(seed+"|"+viewKey+"|aug|"+index);
        JsonObject params=Json.obj("index",index);
        if(Json.bool(augment,"brightness",false))params.addProperty("brightness",(int)Math.round(hexByte(hex,0)/255.0*60));
        if(Json.bool(augment,"contrast",false))params.addProperty("contrast",750+hexByte(hex,1)*500/255);
        if(Json.bool(augment,"saturation",false))params.addProperty("saturation",hexByte(hex,2)*2000/255);
        if(Json.bool(augment,"noise",false))params.addProperty("noise",(int)Math.round(hexByte(hex,3)/255.0*40));
        String flip=Json.str(augment,"flip","none");
        if(flip.equals("horizontal")||flip.equals("vertical")){
            boolean horizontal=hexByte(hex,4)%2==0;
            params.addProperty("flip",true);
            params.addProperty("flipDir",horizontal?"horizontal":"vertical");
        }else params.addProperty("flip",false);
        params.addProperty("rotate90",Json.bool(augment,"rotate90",false)?hexByte(hex,5)%4:0);
        params.addProperty("cutout",Json.bool(augment,"cutout",false)&&hexByte(hex,6)%2==0);
        if(Json.bool(params,"cutout",false)){
            params.addProperty("cutoutX",hexByte(hex,7));
            params.addProperty("cutoutY",hexByte(hex,8));
            params.addProperty("cutoutSize",30+hexByte(hex,9)*30);
        }
        return params;
    }

    private static int hexByte(String hex,int index){return Integer.parseInt(hex.substring(index*2,index*2+2),16);}

    /** 变体标注重建：同一矩阵同时驱动像素与几何；水平翻转依赖调用方传入的关键点对称映射。 */
    static JsonObject mapVariantAnnotation(JsonObject annotation,JsonObject params,int width,int height,Map<String,String> symmetry){
        String type=Json.required(annotation,"type");
        JsonObject out=annotation.deepCopy();
        if(type.equals("detect")||type.equals("pose")){
            JsonObject box=Json.object(annotation,"bbox");
            double[] a=mapVariantPoint(Annotations.num(box,"x"),Annotations.num(box,"y"),params,width,height),
                b=mapVariantPoint(Annotations.num(box,"x")+Annotations.num(box,"width"),Annotations.num(box,"y")+Annotations.num(box,"height"),params,width,height);
            out.add("bbox",Json.obj("x",Math.min(a[0],b[0]),"y",Math.min(a[1],b[1]),
                "width",Math.abs(b[0]-a[0]),"height",Math.abs(b[1]-a[1])));
        }
        if(type.equals("segment")||type.equals("obb")){
            JsonArray input=type.equals("obb")?Annotations.obb(annotation):Json.array(annotation,"points"),output=new JsonArray();
            for(JsonElement point:input){
                JsonObject value=point.getAsJsonObject();
                double[] mapped=mapVariantPoint(Annotations.num(value,"x"),Annotations.num(value,"y"),params,width,height);
                output.add(Json.obj("x",mapped[0],"y",mapped[1]));
            }
            out.add("points",output);out.remove("bbox");out.remove("rotation");
        }
        if(type.equals("pose")){
            String flip=Json.str(params,"flipDir","");
            JsonArray keypoints=new JsonArray();JsonArray source=Json.array(annotation,"keypoints");
            Map<Integer,double[]> mirrored=new HashMap<>();
            for(int i=0;i<source.size();i++){
                JsonObject point=source.get(i).getAsJsonObject();
                double[] mapped=mapVariantPoint(Annotations.num(point,"x"),Annotations.num(point,"y"),params,width,height);
                mirrored.put(i,mapped);
            }
            for(int i=0;i<source.size();i++){
                String name=Json.str(source.get(i).getAsJsonObject(),"name","");
                int sourceIndex=i;
                if(flip.equals("horizontal")&&symmetry.containsKey(name)){
                    String partner=symmetry.get(name);
                    for(int j=0;j<source.size();j++)if(Json.str(source.get(j).getAsJsonObject(),"name","").equals(partner))sourceIndex=j;
                }
                JsonObject sourcePoint=source.get(sourceIndex).getAsJsonObject(),copy=sourcePoint.deepCopy();
                copy.addProperty("name",name);
                double[] position=mirrored.get(sourceIndex);
                if(Json.integer(sourcePoint,"visibility",0)==0){copy.addProperty("x",0);copy.addProperty("y",0);}
                else{copy.addProperty("x",position[0]);copy.addProperty("y",position[1]);}
                keypoints.add(copy);
            }
            out.add("keypoints",keypoints);
        }
        return out;
    }

    /** 变体几何映射：先按 90° 旋转（顺时针），再在旋转后的输出空间应用翻转。 */
    static double[] mapVariantPoint(double x,double y,JsonObject params,int width,int height){
        double px=x,py=y;int rotation=Json.integer(params,"rotate90",0);
        switch(rotation%4){
            case 1->{px=height-y;py=x;}
            case 2->{px=width-x;py=height-y;}
            case 3->{px=y;py=width-x;}
            default->{}
        }
        int outWidth=rotation%2==0?width:height,outHeight=rotation%2==0?height:width;
        String flip=Json.str(params,"flipDir","");
        if(flip.equals("horizontal"))px=outWidth-px;
        if(flip.equals("vertical"))py=outHeight-py;
        return new double[]{px,py};
    }

    /**
     * Cutout 遮挡判定口径（D-4）：以「遮挡矩形覆盖目标外接框的面积比例」为准，
     * 覆盖率达到 50% 即认为目标失效并记录。IoU 在包含情形下受面积比限制，覆盖率才是遮挡的有效度量。
     */
    static double cutoutCoverage(JsonObject annotation,JsonObject params,int width,int height){
        double[] rect=cutoutRect(params,width,height);
        double[] box=bounds(annotation);
        double left=Math.max(rect[0],box[0]),top=Math.max(rect[1],box[1]),
            right=Math.min(rect[0]+rect[2],box[0]+box[2]),bottom=Math.min(rect[1]+rect[3],box[1]+box[3]);
        double intersection=Math.max(0,right-left)*Math.max(0,bottom-top);
        return box[2]*box[3]<=0?0:intersection/(box[2]*box[3]);
    }

    private static double[] cutoutRect(JsonObject params,int width,int height){
        double size=Json.integer(params,"cutoutSize",30)/100.0*Math.min(width,height);
        double x=Json.integer(params,"cutoutX",0)/255.0*Math.max(0,width-size),
            y=Json.integer(params,"cutoutY",0)/255.0*Math.max(0,height-size);
        return new double[]{x,y,size,size};
    }

    private static double[] bounds(JsonObject annotation){
        String type=Json.required(annotation,"type");
        if(type.equals("detect")||type.equals("pose")){
            JsonObject box=Json.object(annotation,"bbox");
            return new double[]{Annotations.num(box,"x"),Annotations.num(box,"y"),Annotations.num(box,"width"),Annotations.num(box,"height")};
        }
        JsonArray points=type.equals("obb")?Annotations.obb(annotation):Json.array(annotation,"points");
        double minX=Double.MAX_VALUE,minY=Double.MAX_VALUE,maxX=-Double.MAX_VALUE,maxY=-Double.MAX_VALUE;
        for(JsonElement point:points){
            double x=Annotations.num(point.getAsJsonObject(),"x"),y=Annotations.num(point.getAsJsonObject(),"y");
            minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);
        }
        return new double[]{minX,minY,maxX-minX,maxY-minY};
    }

    /** 变体像素渲染：旋转 → 翻转 → 亮度/对比度/饱和度 → 噪声 → Cutout，全部为确定性逐像素运算。 */
    static BufferedImage renderVariant(BufferedImage source,JsonObject params){
        BufferedImage image=source;
        int rotation=Json.integer(params,"rotate90",0);
        for(int k=0;k<rotation%4;k++)image=rotate90(image);
        if(Json.bool(params,"flip",false))image=flip(image,Json.str(params,"flipDir","horizontal"));
        image=adjustColors(image,params);
        if(Json.integer(params,"noise",0)>0)image=applyNoise(image,params,Json.integer(params,"index",0));
        if(Json.bool(params,"cutout",false))image=applyCutout(image,params);
        return image;
    }

    private static BufferedImage rotate90(BufferedImage source){
        int width=source.getWidth(),height=source.getHeight();
        BufferedImage output=new BufferedImage(height,width,BufferedImage.TYPE_INT_RGB);
        int[] in=source.getRGB(0,0,width,height,null,0,width),out=new int[height*width];
        for(int y=0;y<height;y++)for(int x=0;x<width;x++)out[x*height+(height-1-y)]=in[y*width+x];
        output.setRGB(0,0,height,width,out,0,height);
        return output;
    }

    private static BufferedImage flip(BufferedImage source,String direction){
        int width=source.getWidth(),height=source.getHeight();
        BufferedImage output=new BufferedImage(width,height,BufferedImage.TYPE_INT_RGB);
        int[] in=source.getRGB(0,0,width,height,null,0,width),out=new int[width*height];
        boolean horizontal=direction.equals("horizontal");
        for(int y=0;y<height;y++)for(int x=0;x<width;x++){
            int sx=horizontal?width-1-x:x,sy=horizontal?y:height-1-y;
            out[y*width+x]=in[sy*width+sx];
        }
        output.setRGB(0,0,width,height,out,0,width);
        return output;
    }

    private static BufferedImage adjustColors(BufferedImage source,JsonObject params){
        int brightness=Json.integer(params,"brightness",0),contrast=Json.integer(params,"contrast",1000),saturation=Json.integer(params,"saturation",1000);
        if(brightness==0&&contrast==1000&&saturation==1000)return source;
        int width=source.getWidth(),height=source.getHeight();
        int[] pixels=source.getRGB(0,0,width,height,null,0,width);
        for(int i=0;i<pixels.length;i++){
            int r=pixels[i]>>16&255,g=pixels[i]>>8&255,b=pixels[i]&255;
            r=clamp((int)Math.round((r-128)*contrast/1000.0+128+brightness),0,255);
            g=clamp((int)Math.round((g-128)*contrast/1000.0+128+brightness),0,255);
            b=clamp((int)Math.round((b-128)*contrast/1000.0+128+brightness),0,255);
            if(saturation!=1000){
                int gray=clamp((int)Math.round(0.299*r+0.587*g+0.114*b),0,255);
                r=clamp((int)Math.round(gray+(r-gray)*saturation/1000.0),0,255);
                g=clamp((int)Math.round(gray+(g-gray)*saturation/1000.0),0,255);
                b=clamp((int)Math.round(gray+(b-gray)*saturation/1000.0),0,255);
            }
            pixels[i]=0xFF000000|r<<16|g<<8|b;
        }
        BufferedImage output=new BufferedImage(width,height,BufferedImage.TYPE_INT_RGB);
        output.setRGB(0,0,width,height,pixels,0,width);
        return output;
    }

    /** 噪声：以坐标与变体序号的整数混合为纯函数，同一输入必然得到同一噪声（I6）。 */
    private static BufferedImage applyNoise(BufferedImage source,JsonObject params,int index){
        int amplitude=Json.integer(params,"noise",0),width=source.getWidth(),height=source.getHeight();
        int[] pixels=source.getRGB(0,0,width,height,null,0,width);
        for(int y=0;y<height;y++)for(int x=0;x<width;x++){
            int i=y*width+x,mix=(x*7919^y*104729^(index+1)*15485863)%amplitude;
            int noise=(mix+amplitude)%amplitude-amplitude/2;
            int r=clamp((pixels[i]>>16&255)+noise,0,255),g=clamp((pixels[i]>>8&255)+noise,0,255),b=clamp((pixels[i]&255)+noise,0,255);
            pixels[i]=0xFF000000|r<<16|g<<8|b;
        }
        BufferedImage output=new BufferedImage(width,height,BufferedImage.TYPE_INT_RGB);
        output.setRGB(0,0,width,height,pixels,0,width);
        return output;
    }

    private static BufferedImage applyCutout(BufferedImage source,JsonObject params){
        double[] rect=cutoutRect(params,source.getWidth(),source.getHeight());
        int x0=clamp((int)Math.round(rect[0]),0,source.getWidth()-1),y0=clamp((int)Math.round(rect[1]),0,source.getHeight()-1),
            x1=clamp((int)Math.round(rect[0]+rect[2]),x0+1,source.getWidth()),y1=clamp((int)Math.round(rect[1]+rect[3]),y0+1,source.getHeight());
        BufferedImage output=new BufferedImage(source.getWidth(),source.getHeight(),BufferedImage.TYPE_INT_RGB);
        output.setRGB(0,0,source.getWidth(),source.getHeight(),source.getRGB(0,0,source.getWidth(),source.getHeight(),null,0,source.getWidth()),0,source.getWidth());
        int[] black=new int[(x1-x0)*(y1-y0)];java.util.Arrays.fill(black,0xFF000000);
        output.setRGB(x0,y0,x1-x0,y1-y0,black,0,x1-x0);
        return output;
    }


    private static JsonObject crop(JsonObject raw){
        keys(raw,"left","top","right","bottom");
        double left=percent(raw,"left"),top=percent(raw,"top"),right=percent(raw,"right"),bottom=percent(raw,"bottom");
        if(right-left<0.001||bottom-top<0.001)throw invalid("裁剪区域至少保留千分之一的边长。");
        return Json.obj("left",left,"top",top,"right",right,"bottom",bottom);
    }

    private static JsonObject tile(JsonObject raw){
        String mode=choice(raw,"mode","rows",Set.of("rows","size","ratio"));
        JsonObject fixed;
        if(mode.equals("rows")){
            keys(raw,"mode","rows","cols","overlapX","overlapY");
            int rows=whole(raw,"rows",1,1,MAX_GRID),cols=whole(raw,"cols",1,1,MAX_GRID);
            fixed=Json.obj("mode",mode,"rows",rows,"cols",cols);
        }else if(mode.equals("size")){
            keys(raw,"mode","width","height","overlapX","overlapY");
            fixed=Json.obj("mode",mode,"width",whole(raw,"width",1,MIN_FRACTION,MAX_SIDE),"height",whole(raw,"height",1,MIN_FRACTION,MAX_SIDE));
        }else{
            keys(raw,"mode","widthRatio","heightRatio","overlapX","overlapY");
            fixed=Json.obj("mode",mode,"widthRatio",percent(raw,"widthRatio"),"heightRatio",percent(raw,"heightRatio"));
        }
        if(raw.has("overlapX"))fixed.addProperty("overlapX",whole(raw,"overlapX",0,0,MAX_SIDE-1));
        if(raw.has("overlapY"))fixed.addProperty("overlapY",whole(raw,"overlapY",0,0,MAX_SIDE-1));
        return fixed;
    }

    private static JsonObject resize(JsonObject raw){
        keys(raw,"width","height","fit","paddingColor");
        JsonObject fixed=Json.obj("width",whole(raw,"width",1,MIN_FRACTION,MAX_SIDE),"height",whole(raw,"height",1,MIN_FRACTION,MAX_SIDE),
            "fit",choice(raw,"fit","contain",Set.of("contain","stretch")));
        if(raw.has("paddingColor"))fixed.addProperty("paddingColor",color(raw,"paddingColor"));
        return fixed;
    }

    private static JsonObject remap(JsonObject raw){
        keys(raw,"omit","rename");
        JsonObject result=new JsonObject();
        JsonArray omit=ids(raw,"omit");
        if(omit.size()>0)result.add("omit",omit);
        if(raw.has("rename")&&!raw.get("rename").isJsonNull()){
            JsonObject rename=Json.object(raw,"rename"),normalized=new JsonObject();
            if(rename.size()>200)throw invalid("重命名条目过多。");
            List<String> names=new ArrayList<>(rename.keySet());Collections.sort(names);
            for(String classId:names){
                JsonElement value=rename.get(classId);
                if(!value.isJsonPrimitive()||!value.getAsJsonPrimitive().isString())throw invalid("重命名目标必须是文本："+classId);
                String name=value.getAsString().strip();
                if(name.isEmpty()||name.length()>MAX_NAME)throw invalid("重命名目标为空或过长："+classId);
                normalized.addProperty(classId,name);
            }
            if(normalized.size()>0)result.add("rename",normalized);
        }
        return result;
    }

    /**
     * 生效类别表：省略的类别连同其标注退出标签空间，重命名只改展示名、保持稳定标识。
     * 结果不得为空、不得出现重复名称（与 TrainingDatasets.parseYaml 的连续性校验同口径）。
     */
    static JsonArray effectiveClasses(JsonArray projectClasses,JsonObject remap){
        Set<String> omit=new LinkedHashSet<>();
        for(JsonElement e:Json.array(remap,"omit"))omit.add(e.getAsString());
        Map<String,String> rename=new HashMap<>();
        for(var entry:Json.object(remap,"rename").entrySet())rename.put(entry.getKey(),entry.getValue().getAsString());
        JsonArray result=new JsonArray();Set<String> names=new HashSet<>();
        for(JsonElement e:projectClasses){
            JsonObject definition=e.getAsJsonObject(),copy=definition.deepCopy();
            String id=Json.required(definition,"id");
            if(omit.contains(id))continue;
            if(rename.containsKey(id))copy.addProperty("name",rename.get(id));
            String name=Json.required(copy,"name");
            if(!names.add(name))throw invalid("重映射后出现重复类别名："+name);
            result.add(copy);
        }
        for(String id:omit)if(projectClasses.asList().stream().noneMatch(e->Json.required(e.getAsJsonObject(),"id").equals(id)))
            throw invalid("省略的类别不存在："+id);
        for(String id:rename.keySet())if(projectClasses.asList().stream().noneMatch(e->Json.required(e.getAsJsonObject(),"id").equals(id)))
            throw invalid("重命名的类别不存在："+id);
        if(result.size()==0)throw invalid("重映射后类别表为空，不能生成版本。");
        return result;
    }

    // ===== 视图计划 =====

    /** 一个素材的转换视图：视图矩阵与逐对象映射交给 TransformGeometry，像素编排由 render() 完成。 */
    record Plan(TransformGeometry.PreparedPlan geometry,JsonArray views,int width,int height){}
    /** 逐对象重建结果：标注、按原因码聚合的计数与「整片拒绝」结论。 */
    record Rebuild(JsonArray annotations,Map<String,Integer> issues,boolean rejected){}

    static boolean enabled(JsonObject transform){return transform!=null&&!transform.isEmpty();}

    /** 固定顺序：裁剪 → 平铺 → 缩放；灰度化不参与几何。 */
    static Plan plan(JsonObject transform,JsonObject asset){
        int width=Json.integer(asset,"width",0),height=Json.integer(asset,"height",0);
        if(width<1||height<1)throw invalid("素材尺寸无效。");
        List<JsonObject> operations=new ArrayList<>();
        if(transform.has("crop")){
            JsonObject crop=Json.object(transform,"crop");
            Rectangle rect=cropRect(crop,width,height);
            operations.add(Json.obj("kind","crop","x",rect.x,"y",rect.y,"width",rect.width,"height",rect.height));
            width=rect.width;height=rect.height;
        }
        if(transform.has("tile")){
            JsonObject tile=Json.object(transform,"tile");
            int overlapX=Json.integer(tile,"overlapX",0),overlapY=Json.integer(tile,"overlapY",0);
            int tileWidth=tileSize(tile,"width","cols","widthRatio",width,overlapX),
                tileHeight=tileSize(tile,"height","rows","heightRatio",height,overlapY);
            if(overlapX>=tileWidth||overlapY>=tileHeight)throw invalid("平铺重叠必须小于瓦片边长。");
            operations.add(Json.obj("kind","tile","width",tileWidth,"height",tileHeight,"overlapX",overlapX,"overlapY",overlapY));
            width=tileWidth;height=tileHeight;
        }
        if(transform.has("resize")){
            JsonObject resize=Json.object(transform,"resize");
            operations.add(Json.obj("kind","resize","width",Json.integer(resize,"width",1),"height",Json.integer(resize,"height",1),
                "fit",Json.str(resize,"fit","contain")));
            width=Json.integer(resize,"width",1);height=Json.integer(resize,"height",1);
        }
        if(operations.isEmpty()){
            // 仅灰度化等无几何操作的配方：单一恒等视图覆盖整图。
            JsonObject baseline=Json.obj("assetId",Json.str(asset,"id","asset"),"contentHash",Json.required(asset,"contentHash"),
                "width",width,"height",height,
                "normalizationVersion",Json.str(asset,"normalizationVersion","baseline-normalized"),
                "inputVersion",Math.max(1,Json.integer(asset,"inputVersion",1)));
            TransformGeometry.PreparedPlan geometry=TransformGeometry.readPlan(TransformGeometry.plan(baseline,Json.arr()));
            return new Plan(geometry,Json.array(geometry.json(),"views"),width,height);
        }
        JsonObject baseline=Json.obj("assetId",Json.str(asset,"id","asset"),"contentHash",Json.required(asset,"contentHash"),
            "width",Json.integer(asset,"width",1),"height",Json.integer(asset,"height",1),
            "normalizationVersion",Json.str(asset,"normalizationVersion","baseline-normalized"),
            "inputVersion",Math.max(1,Json.integer(asset,"inputVersion",1)));
        TransformGeometry.PreparedPlan geometry=TransformGeometry.readPlan(TransformGeometry.plan(baseline,Json.arr(operations.toArray())));
        JsonArray views=Json.array(geometry.json(),"views");
        return new Plan(geometry,views,width,height);
    }

    private static int tileSize(JsonObject tile,String sizeKey,String countKey,String ratioKey,int dimension,int overlap){
        if(Json.str(tile,"mode","").equals("rows")){
            int count=Math.max(1,Json.integer(tile,countKey,1));
            return Math.min(dimension,(int)Math.ceil((dimension+(double)(count-1)*overlap)/count));
        }
        if(Json.str(tile,"mode","").equals("ratio"))return Math.max(1,(int)Math.round(dimension*Json.decimal(tile,ratioKey,1)));
        return Math.min(dimension,Json.integer(tile,sizeKey,1));
    }

    static Rectangle cropRect(JsonObject crop,int width,int height){
        int x=(int)Math.round(Json.decimal(crop,"left",0)*width),y=(int)Math.round(Json.decimal(crop,"top",0)*height);
        int w=(int)Math.round((Json.decimal(crop,"right",1)-Json.decimal(crop,"left",0))*width),
            h=(int)Math.round((Json.decimal(crop,"bottom",1)-Json.decimal(crop,"top",0))*height);
        x=Math.max(0,Math.min(x,width-1));y=Math.max(0,Math.min(y,height-1));
        w=Math.max(1,Math.min(w,width-x));h=Math.max(1,Math.min(h,height-y));
        return new Rectangle(x,y,w,h);
    }

    /**
     * 逐视图标注重建：forward() 给出映射结论；越界策略决定截断对象去留。
     * 完全落在视图外的对象按「排除」计数，不视作阻断（平铺场景中它们属于别的瓦片）。
     */
    static Rebuild forward(TransformGeometry.PreparedPlan plan,String viewId,JsonObject project,JsonArray annotations,String boundaries){
        if(annotations.isEmpty())return new Rebuild(new JsonArray(),new LinkedHashMap<>(),false);
        JsonObject mapping=plan.forward(viewId,annotations,project);
        Map<String,Integer> issues=new LinkedHashMap<>();
        for(JsonElement e:Json.array(mapping,"geometryIssues")){
            String code=Json.str(e.getAsJsonObject(),"code","");
            if(!code.isEmpty())issues.merge(code,1,Integer::sum);
        }
        JsonArray output=new JsonArray();boolean rejected=false;
        for(JsonElement e:Json.array(mapping,"items")){
            JsonObject item=e.getAsJsonObject();
            Set<String> own=new LinkedHashSet<>();
            for(JsonElement gi:Json.array(item,"geometryIssues"))own.add(Json.str(gi.getAsJsonObject(),"code",""));
            boolean cut=own.contains("object_truncated")||own.contains("segment_multi_ring_unsupported");
            JsonObject candidate=item.has("annotation")&&!item.get("annotation").isJsonNull()?Json.object(item,"annotation").deepCopy():null;
            if(candidate!=null&&cut){
                if(boundaries.equals(BOUNDARY_REJECT)){rejected=true;continue;}
                if(boundaries.equals(BOUNDARY_DROP))continue;
                if(boundaries.equals(BOUNDARY_KEEP)){
                    JsonObject raw=Json.object(item,"rawMappedGeometry");
                    JsonObject rescued=Json.obj("id",Json.str(item,"annotationId",""),"type",Json.required(raw,"type"),
                        "classId",Json.str(raw,"classId",""));
                    for(String field:List.of("bbox","points","keypoints","rotation"))if(raw.has(field))rescued.add(field,raw.get(field).deepCopy());
                    candidate=rescued;
                    issues.merge("boundary_kept_unclipped",1,Integer::sum);
                }
            }
            if(Json.str(item,"outcome","").equals("excluded")){issues.merge("object_outside_view",1,Integer::sum);continue;}
            if(candidate!=null)output.add(candidate);
        }
        return new Rebuild(output,issues,rejected);
    }

    // ===== 确定性像素渲染 =====

    /** 按固定顺序渲染单个视图；所有像素运算都是显式循环，不依赖可能随环境变化的图形加速。 */
    static BufferedImage render(BufferedImage source,JsonObject transform,JsonObject view){
        BufferedImage current=source;
        if(transform.has("crop")){
            JsonObject crop=Json.object(transform,"crop");
            Rectangle rect=cropRect(crop,current.getWidth(),current.getHeight());
            current=region(current,rect.x,rect.y,rect.width,rect.height);
        }
        if(transform.has("tile")){
            JsonObject tile=Json.object(view,"tile");
            current=region(current,Json.integer(tile,"x",0),Json.integer(tile,"y",0),Json.integer(tile,"width",1),Json.integer(tile,"height",1));
        }
        if(transform.has("resize")){
            JsonObject resize=Json.object(transform,"resize");
            current=scale(current,Json.integer(resize,"width",1),Json.integer(resize,"height",1),
                Json.str(resize,"fit","contain"),resize.has("paddingColor")?argb(Json.str(resize,"paddingColor","")):0xFF000000);
        }
        if(Json.bool(transform,"grayscale",false))current=grayscale(current);
        return current;
    }

    static BufferedImage decode(Path source,int width,int height)throws IOException{
        BufferedImage image;
        try(InputStream in=Files.newInputStream(source)){image=javax.imageio.ImageIO.read(in);}
        if(image==null)throw invalid("基准图片无法解码。");
        if(image.getWidth()!=width||image.getHeight()!=height)throw new ApiError(409,"dataset_source_changed","基准图片尺寸与记录不一致，版本生成已停止。");
        return image;
    }

    static void writePng(BufferedImage image,Path target)throws IOException{
        Files.createDirectories(target.getParent());
        try(OutputStream out=Files.newOutputStream(target)){
            if(!javax.imageio.ImageIO.write(image,"png",out))throw invalid("PNG 编码失败。");
        }
    }

    private static BufferedImage region(BufferedImage source,int x,int y,int width,int height){
        BufferedImage output=new BufferedImage(width,height,BufferedImage.TYPE_INT_RGB);
        output.setRGB(0,0,width,height,source.getRGB(x,y,width,height,null,0,width),0,width);
        return output;
    }

    /** 双线性缩放：目标像素中心反算源坐标（与 plan 的缩放矩阵同一约定），越界补底色。 */
    private static BufferedImage scale(BufferedImage source,int width,int height,String fit,int background){
        BufferedImage output=new BufferedImage(width,height,BufferedImage.TYPE_INT_RGB);
        int[] pixels=new int[width*height];
        double sx=(double)width/source.getWidth(),sy=(double)height/source.getHeight(),dx=0,dy=0;
        if(fit.equals("contain")){sx=sy=Math.min(sx,sy);dx=(width-source.getWidth()*sx)/2;dy=(height-source.getHeight()*sy)/2;}
        int sw=source.getWidth(),sh=source.getHeight();int[] src=source.getRGB(0,0,sw,sh,null,0,sw);
        for(int py=0;py<height;py++)for(int px=0;px<width;px++){
            double mapX=(px+0.5-dx)/sx,mapY=(py+0.5-dy)/sy;
            if(mapX<0||mapX>=sw||mapY<0||mapY>=sh){pixels[py*width+px]=background;continue;}
            double fx=mapX-0.5,fy=mapY-0.5;int x0=(int)Math.floor(fx),y0=(int)Math.floor(fy);
            double tx=fx-x0,ty=fy-y0;
            int a=clamp(x0,0,sw-1),b=clamp(x0+1,0,sw-1),c=clamp(y0,0,sh-1),d=clamp(y0+1,0,sh-1);
            pixels[py*width+px]=bilinear(src[c*sw+a],src[c*sw+b],src[d*sw+a],src[d*sw+b],tx,ty);
        }
        output.setRGB(0,0,width,height,pixels,0,width);
        return output;
    }

    private static int bilinear(int p00,int p10,int p01,int p11,double tx,double ty){
        int r=channel(p00>>16&255,p10>>16&255,p01>>16&255,p11>>16&255,tx,ty);
        int g=channel(p00>>8&255,p10>>8&255,p01>>8&255,p11>>8&255,tx,ty);
        int b=channel(p00&255,p10&255,p01&255,p11&255,tx,ty);
        return 0xFF000000|r<<16|g<<8|b;
    }
    private static int channel(int v00,int v10,int v01,int v11,double tx,double ty){
        double top=v00+(v10-v00)*tx,bottom=v01+(v11-v01)*tx;
        return clamp((int)Math.round(top+(bottom-top)*ty),0,255);
    }
    private static int clamp(int value,int min,int max){return Math.max(min,Math.min(max,value));}

    private static BufferedImage grayscale(BufferedImage source){
        int width=source.getWidth(),height=source.getHeight();
        int[] pixels=source.getRGB(0,0,width,height,null,0,width);
        for(int i=0;i<pixels.length;i++){
            int value=clamp((int)Math.round(0.299*(pixels[i]>>16&255)+0.587*(pixels[i]>>8&255)+0.114*(pixels[i]&255)),0,255);
            pixels[i]=0xFF000000|value<<16|value<<8|value;
        }
        BufferedImage output=new BufferedImage(width,height,BufferedImage.TYPE_INT_RGB);
        output.setRGB(0,0,width,height,pixels,0,width);
        return output;
    }

    // ===== 估算与参数 =====

    /** 提交前估算：同一尺寸只算一次视图计划，给出总张数；字节估算由调用方按源文件大小推算。 */
    static long estimateViews(JsonObject transform,JsonArray assets){
        Map<String,Integer> cache=new LinkedHashMap<>();
        long views=0;
        for(JsonElement e:assets){
            JsonObject asset=e.getAsJsonObject();
            String key=Json.integer(asset,"width",0)+"x"+Json.integer(asset,"height",0);
            Integer count=cache.get(key);
            if(count==null){count=plan(transform,asset).views().size();cache.put(key,count);}
            views+=count;
        }
        return views;
    }

    private static double percent(JsonObject object,String key){
        double value=Json.decimal(object,key,-1);
        if(!(value>=0&&value<=1))throw invalid(key+" 必须在 0～1 之间。");
        return value;
    }
    private static String color(JsonObject object,String key){
        String value=Json.str(object,key,"");
        if(!value.matches("#[0-9a-fA-F]{6}"))throw invalid(key+" 必须是 #RRGGBB 颜色。");
        return value;
    }
    private static int argb(String hex){
        return 0xFF000000|Integer.parseInt(hex.substring(1,3),16)<<16|Integer.parseInt(hex.substring(3,5),16)<<8|Integer.parseInt(hex.substring(5,7),16);
    }
    private static JsonArray ids(JsonObject object,String key){
        JsonArray source=Json.array(object,key),result=new JsonArray();Set<String> seen=new HashSet<>();
        for(JsonElement e:source){
            if(!e.isJsonPrimitive()||!e.getAsJsonPrimitive().isString())throw invalid(key+" 必须是字符串列表。");
            String value=e.getAsString().strip();
            if(value.isEmpty()||value.length()>100)throw invalid(key+" 存在空值或过长取值。");
            if(seen.add(value))result.add(value);
        }
        return result;
    }
    private static String choice(JsonObject object,String key,String fallback,Set<String> allowed){
        String value=object.has(key)&&!object.get(key).isJsonNull()?Json.str(object,key,""):fallback;
        if(value.isEmpty())value=fallback;
        if(!allowed.contains(value))throw invalid(key+" 只能是 "+String.join(" / ",new TreeSet<>(allowed))+"。");
        return value;
    }
    private static int whole(JsonObject object,String key,int fallback,int min,int max){
        if(!object.has(key)||object.get(key).isJsonNull())return fallback;
        double number=Json.decimal(object,key,0);
        if(number!=Math.rint(number)||number<min||number>max)throw invalid(key+" 超出允许范围 "+min+"～"+max+"。");
        return (int)number;
    }
    private static void keys(JsonObject object,String... allowed){
        Set<String> names=Set.of(allowed);
        for(String name:object.keySet())if(!names.contains(name))throw invalid("不支持的转换参数："+name);
    }
    private static ApiError invalid(String message){return new ApiError(422,"dataset_transform_invalid",message);}
}
