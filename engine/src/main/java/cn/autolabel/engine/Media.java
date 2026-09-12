package cn.autolabel.engine;

import com.drew.imaging.ImageMetadataReader;
import com.drew.metadata.exif.ExifIFD0Directory;
import com.google.gson.*;
import javax.imageio.*;
import javax.imageio.stream.ImageInputStream;
import java.awt.*;
import java.awt.image.BufferedImage;
import java.io.*;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.Iterator;

final class Media {
    static final String NORMALIZATION_VERSION="srgb-exif-alpha-v2";
    static final long MAX_FILE=128L*1024*1024, MAX_PIXELS=40_000_000;
    record Normalized(Path path,int width,int height,String hash,JsonObject metadata){}
    private final Store store;
    Media(Store store){this.store=store;ImageIO.setUseCache(false);}
    synchronized Normalized normalize(Path source,String assetId,String background,boolean copy)throws Exception{
        if(!Files.isRegularFile(source))throw new ApiError(400,"file_missing","图片不存在或不可读取。");
        if(Files.size(source)>MAX_FILE)throw new ApiError(413,"image_too_large","单张图片文件不能超过 128 MiB。");
        store.requireSpace(Files.size(source)*4+128L*1024*1024);
        String format;BufferedImage decoded;java.awt.color.ICC_Profile pngProfile=null;
        try(ImageInputStream input=ImageIO.createImageInputStream(source.toFile())){
            if(input==null)throw new ApiError(400,"image_corrupt","无法读取图片。");
            Iterator<ImageReader> readers=ImageIO.getImageReaders(input);
            if(!readers.hasNext())throw new ApiError(415,"image_format_unsupported","目前支持实际编码为 JPEG、PNG 的图片。");
            ImageReader reader=readers.next();
            try{reader.setInput(input,true,false);format=reader.getFormatName().toLowerCase();
                if(!format.equals("jpeg")&&!format.equals("png"))throw new ApiError(415,"image_format_unsupported","目前支持 JPEG、PNG。");
                int w=reader.getWidth(0),h=reader.getHeight(0);
                if(w<1||h<1||(long)w*h>MAX_PIXELS||w>20000||h>20000)throw new ApiError(413,"image_dimensions_exceeded","图片超过 4000 万像素或单边 20000 像素。");
                decoded=reader.read(0);if(format.equals("png"))pngProfile=ColorNormalization.pngProfile(reader);
            }finally{reader.dispose();}
        }
        int orientation=1;
        try{ExifIFD0Directory exif=ImageMetadataReader.readMetadata(source.toFile()).getFirstDirectoryOfType(ExifIFD0Directory.class);
            if(exif!=null&&exif.containsTag(ExifIFD0Directory.TAG_ORIENTATION))orientation=exif.getInt(ExifIFD0Directory.TAG_ORIENTATION);
        }catch(Exception ignored){/* 图片已解码；缺失或损坏的可选元数据不能替代实际像素校验。 */}
        if(orientation<1||orientation>8)orientation=1;
        Color bg;
        try{bg=Color.decode(background);}catch(Exception e){throw new ApiError(400,"invalid_background","透明背景应使用 #RRGGBB 颜色。");}
        int sw=decoded.getWidth(),sh=decoded.getHeight();boolean swap=orientation>=5;
        BufferedImage flat=ColorNormalization.flatten(decoded,pngProfile,bg);decoded.flush();
        BufferedImage normalized=new BufferedImage(swap?sh:sw,swap?sw:sh,BufferedImage.TYPE_INT_RGB);
        // ImageIO 解码颜色空间后合成到 sRGB RGB 基准图，EXIF 仅在此处应用一次。
        for(int y=0;y<sh;y++)for(int x=0;x<sw;x++){
            int dx=x,dy=y;
            switch(orientation){case 2->dx=sw-1-x;case 3->{dx=sw-1-x;dy=sh-1-y;}case 4->dy=sh-1-y;
                case 5->{dx=y;dy=x;}case 6->{dx=sh-1-y;dy=x;}case 7->{dx=sh-1-y;dy=sw-1-x;}case 8->{dx=y;dy=sw-1-x;}}
            normalized.setRGB(dx,dy,flat.getRGB(x,y));
        }
        flat.flush();Path dir=store.root.resolve("media");Files.createDirectories(dir);
        Path destination=dir.resolve(assetId+".png"),temporary=dir.resolve(assetId+".tmp");
        if(!ImageIO.write(normalized,"png",temporary.toFile()))throw new IOException("PNG writer unavailable");
        Files.move(temporary,destination,StandardCopyOption.ATOMIC_MOVE);normalized.flush();
        String sourceHash=hash(source);Path original=source.toAbsolutePath().normalize();
        if(copy){Path originals=store.root.resolve("originals");Files.createDirectories(originals);original=originals.resolve(assetId+(format.equals("jpeg")?".jpg":".png"));Files.copy(source,original);}
        JsonObject metadata=Json.obj("normalizationVersion",NORMALIZATION_VERSION,"inputVersion",1,"sourceWidth",sw,"sourceHeight",sh,
            "exifOrientation",orientation,"sourceToBaseline",matrix(orientation,sw,sh),"colorSpace","sRGB","alphaBackground",background,
            "sourceHash",sourceHash,"sourcePath",original.toString(),"importMode",copy?"copy":"reference","originalFormat",format,"pngIccApplied",pngProfile!=null);
        return new Normalized(destination,swap?sh:sw,swap?sw:sh,hash(destination),metadata);
    }
    // 标注使用像素边界坐标，仿射平移取宽高；像素中心索引映射使用宽高减一。
    static JsonArray matrix(int o,int w,int h){return switch(o){case 2->Json.arr(-1,0,w,0,1,0);case 3->Json.arr(-1,0,w,0,-1,h);case 4->Json.arr(1,0,0,0,-1,h);case 5->Json.arr(0,1,0,1,0,0);case 6->Json.arr(0,-1,h,1,0,0);case 7->Json.arr(0,-1,h,-1,0,w);case 8->Json.arr(0,1,0,-1,0,w);default->Json.arr(1,0,0,0,1,0);};}
    static String hash(Path path)throws Exception{MessageDigest digest=MessageDigest.getInstance("SHA-256");try(InputStream in=Files.newInputStream(path)){byte[] b=new byte[65536];int n;while((n=in.read(b))!=-1)digest.update(b,0,n);}return HexFormat.of().formatHex(digest.digest());}
    static void sample(Path target,int index)throws IOException{
        BufferedImage image=new BufferedImage(960,640,BufferedImage.TYPE_INT_RGB);Graphics2D g=image.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING,RenderingHints.VALUE_ANTIALIAS_ON);
        g.setPaint(new GradientPaint(0,0,new Color(232,239,244),960,640,new Color(197,211,220)));g.fillRect(0,0,960,640);
        g.setColor(new Color(180,194,202));g.fillRect(0,480,960,160);
        int x=170+index*27,y=155+index*13;
        g.setColor(new Color(42,56,74,30));g.fillOval(x-25,440,480,65);
        g.setColor(index%2==0?new Color(66,118,196):new Color(199,141,73));g.fillRoundRect(x,y,360,260,18,18);
        g.setColor(new Color(255,255,255,65));g.fillRoundRect(x+18,y+18,324,15,8,8);
        g.setColor(new Color(238,242,245));g.fillRoundRect(x+100,y+80,160,95,10,10);
        g.setColor(new Color(47,62,82));g.setFont(new Font(Font.SANS_SERIF,Font.BOLD,28));g.drawString("SAMPLE "+(index+1),x+107,y+137);
        g.dispose();ImageIO.write(image,"png",target.toFile());image.flush();
    }
}
