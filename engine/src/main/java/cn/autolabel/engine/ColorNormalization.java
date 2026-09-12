package cn.autolabel.engine;

import javax.imageio.ImageReader;
import javax.imageio.metadata.IIOMetadataNode;
import java.awt.Color;
import java.awt.color.*;
import java.awt.image.*;
import java.io.*;
import java.util.zip.InflaterInputStream;
import org.w3c.dom.Node;

final class ColorNormalization {
    static ICC_Profile pngProfile(ImageReader reader)throws Exception{
        Node root=reader.getImageMetadata(0).getAsTree("javax_imageio_png_1.0");
        for(Node node=root.getFirstChild();node!=null;node=node.getNextSibling())if(node.getNodeName().equals("iCCP")){
            try{byte[] compressed=(byte[])((IIOMetadataNode)node).getUserObject();
                try(InputStream in=new InflaterInputStream(new ByteArrayInputStream(compressed))){byte[] profile=in.readNBytes(4*1024*1024+1);if(profile.length>4*1024*1024)throw new IOException();return ICC_Profile.getInstance(profile);}
            }catch(Exception e){throw new ApiError(422,"color_profile_invalid","PNG 内嵌 ICC 颜色配置无效或过大，请先转换为 sRGB 图片。");}
        }return null;
    }
    static BufferedImage flatten(BufferedImage decoded,ICC_Profile profile,Color background){
        int w=decoded.getWidth(),h=decoded.getHeight();BufferedImage flat=new BufferedImage(w,h,BufferedImage.TYPE_INT_RGB);
        if(profile==null){var g=flat.createGraphics();g.setColor(background);g.fillRect(0,0,w,h);g.drawImage(decoded,0,0,null);g.dispose();return flat;}
        try{
            ICC_ColorSpace sourceSpace=new ICC_ColorSpace(profile);ColorConvertOp conversion=new ColorConvertOp(sourceSpace,ColorSpace.getInstance(ColorSpace.CS_sRGB),null);
            // PNG 解码器保留 iCCP 元数据但不代为应用；用原始色值转换后才在 sRGB 中合成透明通道。
            if(sourceSpace.getNumComponents()==1&&decoded.getRaster().getNumBands()<=2){Raster gray=decoded.getRaster().createChild(0,0,w,h,0,0,new int[]{0});conversion.filter(gray,flat.getRaster());}
            else if(sourceSpace.getNumComponents()==3){BufferedImage encoded=new BufferedImage(w,h,BufferedImage.TYPE_INT_RGB);int[] row=new int[w];for(int y=0;y<h;y++){decoded.getRGB(0,y,w,1,row,0,w);encoded.setRGB(0,y,w,1,row,0,w);}conversion.filter(encoded.getRaster(),flat.getRaster());encoded.flush();}
            else throw new IllegalArgumentException();
            if(decoded.getColorModel().hasAlpha())for(int y=0;y<h;y++)for(int x=0;x<w;x++){int alpha=decoded.getRGB(x,y)>>>24,rgb=flat.getRGB(x,y);int r=blend((rgb>>16)&255,background.getRed(),alpha),g=blend((rgb>>8)&255,background.getGreen(),alpha),b=blend(rgb&255,background.getBlue(),alpha);flat.setRGB(x,y,(r<<16)|(g<<8)|b);}
            return flat;
        }catch(Exception e){throw new ApiError(422,"color_profile_unsupported","图片 ICC 配置与像素通道不兼容，请先转换为 sRGB。");}
    }
    private static int blend(int value,int bg,int alpha){return (value*alpha+bg*(255-alpha)+127)/255;}
}
