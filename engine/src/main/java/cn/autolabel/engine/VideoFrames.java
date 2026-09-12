package cn.autolabel.engine;

import com.google.gson.*;
import com.google.gson.stream.*;
import javax.imageio.*;
import javax.imageio.stream.MemoryCacheImageOutputStream;
import java.awt.image.BufferedImage;
import java.io.*;
import java.math.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import java.util.regex.*;
import java.util.zip.CRC32;

/** 独立媒体工作器；文件完成不等于任务完成，只有末尾来源核验通过才发布完整清单。 */
final class VideoFrames implements AutoCloseable {
    static final String VERSION="video-frames-v1",SELECTION="source-pts-grid-first-v1";
    static final long DISK_MARGIN=128L*1024*1024;
    private static final String FORMATS="mov,matroska,avi,mpegts,mpeg,mpegvideo,h264,hevc";
    private static final int LINE_LIMIT=64*1024,LOG_LIMIT=256*1024;
    private final Path ffmpeg,ffprobe;
    private final AtomicReference<Job> active=new AtomicReference<>();
    private volatile boolean closed;
    interface Control {
        default boolean cancelled(){return false;}
        default long availableBytesLimit(Path directory){return Long.MAX_VALUE;}
        default void progress(JsonObject event){}
    }
    record Extraction(Path manifestPath,JsonObject summary){}
    private static final class Job {
        final String id;final long deadline;final Control control;
        final AtomicReference<ApiError> failure=new AtomicReference<>();
        final ArrayBlockingQueue<JsonObject> progress=new ArrayBlockingQueue<>(32);
        volatile Process process;volatile boolean finished,committed;Thread watcher,observer;
        Job(String id,long timeout,Control control){this.id=id;this.deadline=System.nanoTime()+TimeUnit.MILLISECONDS.toNanos(timeout);this.control=control;}
    }
    private record Frame(long output,long source,long pts,long relative,int range,long bucket){}
    private record Rotation(int degrees,JsonArray matrix){}

    VideoFrames(Path ffmpeg,Path ffprobe){this.ffmpeg=ffmpeg.toAbsolutePath().normalize();this.ffprobe=ffprobe.toAbsolutePath().normalize();}

    JsonObject inspect(JsonObject request,long timeoutMs){
        return inspect(request,timeoutMs,new Control(){});
    }
    JsonObject inspect(JsonObject request,long timeoutMs,Control control){
        JsonObject input=request.deepCopy();Job job=begin(Json.str(input,"jobId",Json.id()),timeoutMs,control==null?new Control(){}:control);
        try{input.addProperty("jobId",job.id);return prepare(input,job);}finally{end(job);}
    }

    Extraction extract(JsonObject frozenPlan,Path generationDirectory,Control control){
        JsonObject fixed=frozenPlan.deepCopy();Job job=begin(text(fixed,"jobId",160),integer(fixed,"timeoutMs",1,86400000),control==null?new Control(){}:control);Path directory=null;
        try{
            if(!VERSION.equals(Json.str(fixed,"version",""))||!SELECTION.equals(Json.str(fixed,"selectionVersion","")))throw error(409,"video_plan_invalid","抽帧计划版本不支持。");
            JsonObject verified=prepare(fixed,job);if(!verified.equals(fixed))throw error(409,"video_plan_changed","来源、工具或抽帧计划已变化，请重新准备。");
            directory=createDirectory(generationDirectory);Path frames=Files.createDirectory(directory.resolve("frames"));Path partial=directory.resolve("frames.partial.jsonl");
            atomicJson(directory.resolve("recipe.json"),fixed);space(directory,job,frameReserve(fixed));
            String filter=filter(fixed);Path filterPath=directory.resolve("filter.txt");Files.writeString(filterPath,filter,StandardCharsets.UTF_8,StandardOpenOption.CREATE_NEW);
            List<String> args=new ArrayList<>(List.of(ffmpeg.toString(),"-hide_banner","-nostdin","-nostats","-loglevel","info","-xerror","-filter_threads","1","-threads","2","-err_detect","explode","-protocol_whitelist","file,pipe","-format_whitelist",FORMATS,"-noautorotate","-copyts","-i",text(fixed,"sourcePath",32767),"-map","0:"+integer(fixed,"streamIndex",0,65535),"-an","-sn","-dn","-/filter:v",filterPath.toString(),"-fps_mode","passthrough","-enc_time_base","-1","-threads:v","1","-frames:v",Long.toString(integer(fixed,"maxFrames",1,100000)+1),"-f","image2pipe","-c:v","png","-pix_fmt","rgb24","pipe:1"));
            String format=text(fixed,"format",8);Process process=start(args,job);Parser parser=new Parser(fixed,job);CompletableFuture<Void> stderr=readLines(process.getErrorStream(),parser::accept,job);
            long count=0,bytes=0,lastProgress=0;
            // image2 的 -fs 不限制累计文件大小；由管道反压和本地限额写流控制真正写入的字节。
            try(InputStream images=new BufferedInputStream(process.getInputStream(),65536);BufferedWriter manifest=Files.newBufferedWriter(partial,StandardCharsets.UTF_8,StandardOpenOption.CREATE_NEW)){
                while(true){
                    checkpoint(job);space(directory,job,frameReserve(fixed));long remaining=integer(fixed,"maxOutputBytes",1,Long.MAX_VALUE)-bytes;String stem=String.format(Locale.ROOT,"frame-%08d",count);Path png=directory.resolve(stem+".png.tmp");
                    if(!readPng(images,png,format.equals("png")?remaining:Media.MAX_FILE,count>=integer(fixed,"maxFrames",1,100000),fixed,job))break;
                    Frame pending;while((pending=parser.output.poll(20,TimeUnit.MILLISECONDS))==null){checkpoint(job);if(stderr.isDone())throw error(502,"video_frame_mismatch","图片没有对应的实际帧元数据。");}
                    if(pending.output!=count)throw error(502,"video_frame_mismatch","图片和元数据序号不一致。");validateImage(png,fixed);Path temporary=png;
                    if(format.equals("jpg")){temporary=directory.resolve(stem+".jpg.tmp");jpeg(png,temporary,remaining,fixed,job);Files.delete(png);}
                    long size=Files.size(temporary);if(size<=0||size>remaining)throw error(413,"video_output_limit","抽帧文件超过累计字节预算。");String imageHash=hash(temporary,job);Path image=frames.resolve(stem+"."+format);Files.move(temporary,image,StandardCopyOption.ATOMIC_MOVE);bytes=Math.addExact(bytes,size);JsonObject item=frame(fixed,parser,pending,image.getFileName().toString(),imageHash,size);
                    manifest.write(item.toString());manifest.newLine();manifest.flush();count++;
                    long now=System.nanoTime();if(now-lastProgress>TimeUnit.MILLISECONDS.toNanos(150)){notify(job,Json.obj("jobId",job.id,"phase","extracting","completedFrames",count,"decodedFrames",parser.decoded,"sourceTimeSeconds",parser.lastSeconds,"outputBytes",bytes));lastProgress=now;}
                }
            }
            while(process.isAlive()||!stderr.isDone()){checkpoint(job);Thread.sleep(10);}join(stderr);checkpoint(job);if(process.exitValue()!=0)throw error(422,"video_decode_failed","视频解码或图片写出失败。",Json.obj("exitCode",process.exitValue(),"stderr",parser.log()));
            if(parser.sourceCount==0)throw error(422,"video_empty","视频没有可解码帧。");if(count!=parser.outputCount||parser.expectedPending()!=0)throw error(502,"video_frame_mismatch","实际帧与时间清单不一致。");
            long actualFiles;try(var paths=Files.list(frames)){actualFiles=paths.count();}if(actualFiles!=count)throw error(502,"video_frame_mismatch","生成目录存在多余或未完整写出的图片。");
            AtomicLong verifiedFrames=new AtomicLong();CompletableFuture<Void> verification=readLines(Files.newInputStream(partial),line->{JsonObject row=parse(line);Path image=directoryFrame(frames,text(row,"imagePath",200));if(Files.isSymbolicLink(image)||Files.size(image)!=integer(row,"bytes",1,Media.MAX_FILE)||!hash(image,job).equals(text(row,"contentHash",64)))throw error(409,"video_output_changed","已写出的抽帧图片发生变化，未发布完成清单。");verifiedFrames.incrementAndGet();},job);while(!verification.isDone()){checkpoint(job);Thread.sleep(10);}join(verification);if(verifiedFrames.get()!=count)throw error(502,"video_frame_mismatch","最终清单的帧数发生变化。");
            if(!hash(Path.of(text(fixed,"sourcePath",32767)),job).equals(text(fixed,"sourceHash",64)))throw error(409,"video_source_changed","来源视频在抽帧期间发生变化，保留未完成产物。");
            checkpoint(job);String manifestHash=hash(partial,job);Path complete=directory.resolve("frames.jsonl");Files.move(partial,complete,StandardCopyOption.ATOMIC_MOVE);
            JsonObject summary=Json.obj("version",VERSION,"jobId",job.id,"status","completed","frameCount",count,"outputBytes",bytes,"sourceHash",fixed.get("sourceHash"),"sourceVideoId",fixed.get("sourceVideoId"),"originPts",Long.toString(parser.origin),"timeBase",fixed.get("timeBase"),"manifestHash",manifestHash,"manifestPath",complete.toString(),"selectionVersion",SELECTION);
            synchronized(job){checkpoint(job);atomicJson(directory.resolve("complete.json"),summary);job.committed=true;}notify(job,summary.deepCopy());return new Extraction(complete,summary);
        }catch(ApiError failure){if(directory!=null)incomplete(directory,job,failure);throw failure;}
        catch(InterruptedException interrupted){Thread.currentThread().interrupt();ApiError failure=error(499,"video_cancelled","抽帧已中断，未发布完成清单。");if(directory!=null)incomplete(directory,job,failure);throw failure;}
        catch(Exception failure){ApiError error=job.failure.get();if(error==null)error=error(500,"video_extract_failed","抽帧未完成，请检查文件、磁盘与媒体环境。");if(directory!=null)incomplete(directory,job,error);throw error;}
        finally{end(job);}
    }

    boolean cancel(String jobId){Job job=active.get();if(job==null||!job.id.equals(jobId))return false;synchronized(job){if(job.committed)return false;fail(job,error(499,"video_cancelled","抽帧已取消，完整帧保留为未完成产物。"));return true;}}
    @Override public void close(){closed=true;Job job=active.get();if(job!=null)cancel(job.id);}

    private JsonObject prepare(JsonObject request,Job job){
        try{
            Path source=Path.of(text(request,"sourcePath",32767));if(!source.isAbsolute()||!Files.isRegularFile(source))throw error(404,"video_source_missing","请选择存在的本地视频文件。");source=source.toRealPath();String digest=hash(source,job);
            if(request.has("sourceHash")&&!digest.equals(text(request,"sourceHash",64)))throw error(409,"video_source_changed","来源视频与固定摘要不一致。");
            String ffmpegVersion=version(ffmpeg,job),ffprobeVersion=version(ffprobe,job);
            JsonObject probe=parse(capture(List.of(ffprobe.toString(),"-v","error","-protocol_whitelist","file,pipe","-format_whitelist",FORMATS,"-show_streams","-show_format","-of","json",source.toString()),job,2*1024*1024));JsonArray streams=Json.array(probe,"streams");JsonObject stream=null;
            for(JsonElement value:streams){JsonObject candidate=value.getAsJsonObject();if(!Json.str(candidate,"codec_type","").equals("video")||Json.integer(Json.object(candidate,"disposition"),"attached_pic",0)!=0)continue;if(!request.has("streamIndex")||integer(candidate,"index",0,65535)==integer(request,"streamIndex",0,65535)){stream=candidate;break;}}
            if(stream==null)throw error(422,"video_stream_missing","视频不存在所选图像流。");int width=(int)integer(stream,"width",1,20000),height=(int)integer(stream,"height",1,20000);dimensions(width,height);
            String reportedSar=Json.str(stream,"sample_aspect_ratio",null);boolean assumedSar=reportedSar==null||Set.of("N/A","unknown").contains(reportedSar);
            // 缺失像素比例的常见容器按方形像素解释，并显式保留该假设；无效的已声明比例仍拒绝。
            long[] tb=rational(text(stream,"time_base",100),"/"),sar=assumedSar?new long[]{1,1}:rational(reportedSar,":");
            if(Set.of("smpte2084","arib-std-b67").contains(Json.str(stream,"color_transfer","")))throw error(422,"video_color_unsupported","HDR 视频需要明确的色调转换，当前抽帧不会猜测为普通 sRGB。");
            Rotation rotation=rotation(stream);int squareWidth=(int)Math.round((double)width*sar[0]/sar[1]);dimensions(squareWidth,height);boolean swap=rotation.degrees==90||rotation.degrees==270;int displayW=swap?height:squareWidth,displayH=swap?squareWidth:height;
            JsonObject size=Json.object(request,"outputSize");int outW=displayW,outH=displayH;String fit=Json.str(size,"fit","contain");if(!Set.of("contain","stretch").contains(fit))throw error(400,"video_size_invalid","尺寸模式必须是 contain 或 stretch。");
            if(!size.isEmpty()){outW=(int)integer(size,"width",1,20000);outH=(int)integer(size,"height",1,20000);if(fit.equals("contain")){double scale=Math.min((double)outW/displayW,(double)outH/displayH);outW=Math.max(1,(int)Math.round(displayW*scale));outH=Math.max(1,(int)Math.round(displayH*scale));}}dimensions(outW,outH);
            JsonArray transform=matrix(rotation.degrees,squareWidth,height);double[] m=new double[6];for(int i=0;i<6;i++)m[i]=transform.get(i).getAsDouble();double sx=(double)squareWidth/width,ox=(double)outW/displayW,oy=(double)outH/displayH;m[0]*=sx*ox;m[1]*=ox;m[2]*=ox;m[3]*=sx*oy;m[4]*=oy;m[5]*=oy;
            JsonArray ranges=Json.array(request,"ranges");if(ranges.isEmpty()||ranges.size()>32)throw error(400,"video_ranges_invalid","请提供 1～32 个互不重叠的时间段。");List<JsonObject> ordered=new ArrayList<>();for(JsonElement item:ranges){JsonObject range=item.getAsJsonObject();double start=number(range,"start",0,604800),end=number(range,"end",0,604800);if(end<=start)throw error(400,"video_ranges_invalid","时间段结束必须晚于开始。");ordered.add(Json.obj("start",start,"end",end));}ordered.sort(Comparator.comparingDouble(r->r.get("start").getAsDouble()));for(int i=1;i<ordered.size();i++)if(ordered.get(i).get("start").getAsDouble()<ordered.get(i-1).get("end").getAsDouble())throw error(400,"video_ranges_overlap","时间段不能重叠。");
            String mode=text(request,"mode",20),format=Json.str(request,"format","png");if(!Set.of("interval","every_n","fps").contains(mode)||!Set.of("png","jpg").contains(format))throw error(400,"video_parameters_invalid","抽帧方式或图片格式不支持。");
            JsonObject fixed=Json.obj("version",VERSION,"selectionVersion",SELECTION,"encodingVersion",format.equals("png")?"ffmpeg-png-rgb24-v1":"java-imageio-jpeg-v1","jobId",job.id,"sourcePath",source.toString(),"sourceHash",digest,"sourceVideoId",request.has("sourceVideoId")?text(request,"sourceVideoId",160):"video-"+digest,"sourceBytes",Files.size(source),"streamIndex",stream.get("index"),"timeBase",Json.obj("numerator",tb[0],"denominator",tb[1]),"ranges",Json.element(ordered),"mode",mode,"format",format,
                "maxFrames",request.has("maxFrames")?integer(request,"maxFrames",1,100000):10000,"maxOutputBytes",request.has("maxOutputBytes")?integer(request,"maxOutputBytes",1,Long.MAX_VALUE):8L*1024*1024*1024,"timeoutMs",request.has("timeoutMs")?integer(request,"timeoutMs",1,86400000):600000,
                "outputSize",size.isEmpty()?new JsonObject():Json.obj("width",integer(size,"width",1,20000),"height",integer(size,"height",1,20000),"fit",fit),"outputWidth",outW,"outputHeight",outH,"codedWidth",width,"codedHeight",height,"squarePixelWidth",squareWidth,"sampleAspectRatio",Json.obj("numerator",sar[0],"denominator",sar[1]),"rotation",rotation.degrees,"displayMatrix",rotation.matrix,"codedVideoToFrame",Json.arr(m[0],m[1],m[2],m[3],m[4],m[5]),"ffmpegVersion",ffmpegVersion,"ffprobeVersion",ffprobeVersion,
                "encoderRuntime",format.equals("jpg")?System.getProperty("java.runtime.version"):null,"sourceMetadata",Json.obj("codec",stream.get("codec_name"),"reportedDuration",Json.object(probe,"format").get("duration"),"reportedFrameRate",stream.get("avg_frame_rate"),"reportedFrameCount",stream.get("nb_frames"),"sampleAspectRatioAssumed",assumedSar,"reportedSampleAspectRatio",reportedSar,"geometryNotice",assumedSar?"来源未声明像素比例，本次按方形像素解释显示尺寸。":null,"colorSpace",stream.get("color_space"),"colorTransfer",stream.get("color_transfer"),"colorPrimaries",stream.get("color_primaries"),"colorRange",stream.get("color_range")));
            if(mode.equals("every_n"))fixed.addProperty("everyNFrames",integer(request,"everyNFrames",1,1000000));else if(mode.equals("fps"))fixed.addProperty("targetFps",number(request,"targetFps",0.001,240));else fixed.addProperty("intervalSeconds",number(request,"intervalSeconds",0.001,604800));
            if(format.equals("jpg"))fixed.addProperty("jpegQuality",request.has("jpegQuality")?integer(request,"jpegQuality",2,31):3);if(!hash(source,job).equals(digest))throw error(409,"video_source_changed","探测期间来源视频发生变化。");return fixed;
        }catch(ApiError e){throw e;}catch(Exception e){throw error(422,"video_probe_failed","无法读取视频流和几何信息。");}
    }

    private static String filter(JsonObject fixed){
        List<String> ranges=new ArrayList<>();String mode=text(fixed,"mode",20);double rate=mode.equals("fps")?fixed.get("targetFps").getAsDouble():mode.equals("interval")?1/fixed.get("intervalSeconds").getAsDouble():0;
        for(JsonElement entry:Json.array(fixed,"ranges")){JsonObject range=entry.getAsJsonObject();String start=range.get("start").getAsString(),end=range.get("end").getAsString();String selection=mode.equals("every_n")?"not(mod(n,"+fixed.get("everyNFrames")+"))":"(isnan(prev_pts)+lt(prev_pts*TB,"+start+")+gt(floor((t-"+start+")*"+rate+"+1e-9),floor((prev_pts*TB-"+start+")*"+rate+"+1e-9)))";ranges.add("(gte(t,"+start+")*lt(t,"+end+")*"+selection+")");}
        JsonArray intervals=Json.array(fixed,"ranges");String lastEnd=intervals.get(intervals.size()-1).getAsJsonObject().get("end").getAsString();
        StringBuilder result=new StringBuilder("showinfo@source=checksum=0,setpts=PTS-STARTPTS,trim=end=").append(lastEnd).append(",select='").append(String.join("+",ranges)).append("',scale=").append(fixed.get("squarePixelWidth")).append(':').append(fixed.get("codedHeight")).append(":flags=bilinear,setsar=1");
        int rotation=(int)integer(fixed,"rotation",0,270);if(rotation==90)result.append(",transpose=cclock");else if(rotation==180)result.append(",hflip,vflip");else if(rotation==270)result.append(",transpose=clock");
        return result.append(",scale=").append(fixed.get("outputWidth")).append(':').append(fixed.get("outputHeight")).append(":flags=bilinear,setsar=1,showinfo@output=checksum=0").toString();
    }

    private static final Pattern FRAME=Pattern.compile("\\bn:\\s*(\\d+)\\s+pts:\\s*(\\S+).*?\\bsar:(\\S+)\\s+s:(\\d+)x(\\d+)");
    private static final Pattern TIME_BASE=Pattern.compile("config in time_base: (\\d+)/(\\d+)");
    private static final class Parser {
        final JsonObject fixed;final Job job;final ArrayBlockingQueue<Frame> output=new ArrayBlockingQueue<>(1024);final Deque<Frame> expected=new ArrayDeque<>();final StringBuilder logs=new StringBuilder();
        final long numerator,denominator;long origin,lastPts,sourceCount,outputCount,lastBucket=-1;int lastRange=-1;volatile long decoded;volatile double lastSeconds;
        Parser(JsonObject fixed,Job job){this.fixed=fixed;this.job=job;numerator=Json.object(fixed,"timeBase").get("numerator").getAsLong();denominator=Json.object(fixed,"timeBase").get("denominator").getAsLong();}
        void accept(String line){
            checkpoint(job);boolean source=line.startsWith("[showinfo@source @"),out=line.startsWith("[showinfo@output @");if(!source&&!out){synchronized(logs){logs.append(line).append('\n');if(logs.length()>LOG_LIMIT/4)logs.delete(0,logs.length()-LOG_LIMIT/4);}return;}
            Matcher tb=TIME_BASE.matcher(line);if(tb.find()){if(Long.parseLong(tb.group(1))!=numerator||Long.parseLong(tb.group(2))!=denominator)throw error(422,"video_timebase_changed","解码时间基准与固定视频流不一致。");return;}
            Matcher frame=FRAME.matcher(line);if(!frame.find()){if(line.contains(" n:"))throw error(502,"video_protocol_invalid","无法解析实际帧时间和尺寸。");return;}
            long n=Long.parseLong(frame.group(1)),pts;try{pts=Long.parseLong(frame.group(2));}catch(NumberFormatException missing){throw error(422,"video_timestamp_invalid","视频帧缺少可用时间戳。");}
            if(source){
                if(n!=sourceCount||sourceCount>0&&pts<=lastPts)throw error(422,"video_timestamp_invalid","视频呈现序号或时间戳重复、倒退，未猜测修复。");
                if(Integer.parseInt(frame.group(4))!=integer(fixed,"codedWidth",1,20000)||Integer.parseInt(frame.group(5))!=integer(fixed,"codedHeight",1,20000))throw error(422,"video_dimensions_changed","视频中途改变了尺寸。");
                boolean unspecified=Json.bool(Json.object(fixed,"sourceMetadata"),"sampleAspectRatioAssumed",false)&&frame.group(3).equals("0/1");long[] sar=unspecified?new long[]{1,1}:rational(frame.group(3),"/");JsonObject ratio=Json.object(fixed,"sampleAspectRatio");if(sar[0]*ratio.get("denominator").getAsLong()!=sar[1]*ratio.get("numerator").getAsLong())throw error(422,"video_geometry_changed","视频中途改变了像素比例。");
                if(sourceCount==0)origin=pts;lastPts=pts;sourceCount++;decoded=sourceCount;long relative=Math.subtractExact(pts,origin);if(relative>9_007_199_254_740_991L)throw error(422,"video_timestamp_invalid","时间戳精度超出可验证范围。");double seconds=(double)relative*numerator/denominator;lastSeconds=seconds;int range=-1;long bucket=-1;JsonArray ranges=Json.array(fixed,"ranges");
                for(int i=0;i<ranges.size();i++){JsonObject item=ranges.get(i).getAsJsonObject();double start=item.get("start").getAsDouble(),end=item.get("end").getAsDouble();if(seconds>=start&&seconds<end){range=i;String mode=Json.required(fixed,"mode");if(mode.equals("every_n")){if(n%fixed.get("everyNFrames").getAsLong()!=0)range=-1;}else{double rate=mode.equals("fps")?fixed.get("targetFps").getAsDouble():1/fixed.get("intervalSeconds").getAsDouble();bucket=(long)Math.floor((seconds-start)*rate+1e-9);if(lastRange==range&&lastBucket==bucket)range=-1;}break;}}
                if(range>=0){lastRange=range;lastBucket=bucket;if(expected.size()>=1024)throw error(413,"video_metadata_limit","媒体元数据积压超过有界缓冲。");expected.add(new Frame(-1,n,pts,relative,range,bucket));}
            }else{
                Frame item=expected.poll();if(item==null||n!=outputCount||pts!=item.relative||Integer.parseInt(frame.group(4))!=integer(fixed,"outputWidth",1,20000)||Integer.parseInt(frame.group(5))!=integer(fixed,"outputHeight",1,20000))throw error(502,"video_frame_mismatch","输出帧与实际来源时间或尺寸不能一一对应。");
                if(!output.offer(new Frame(n,item.source,item.pts,item.relative,item.range,item.bucket)))throw error(413,"video_metadata_limit","抽帧消费速度不足，已停止有界媒体工作。");outputCount++;
            }
        }
        int expectedPending(){return expected.size();}
        String log(){synchronized(logs){return logs.toString();}}
    }

    private static JsonObject frame(JsonObject fixed,Parser parser,Frame frame,String file,String hash,long bytes){
        return Json.obj("frameId",String.format(Locale.ROOT,"frame-%08d",frame.output),"imagePath","frames/"+file,"contentHash",hash,"bytes",bytes,"width",fixed.get("outputWidth"),"height",fixed.get("outputHeight"),"sourceVideoId",fixed.get("sourceVideoId"),"sourceHash",fixed.get("sourceHash"),"streamIndex",fixed.get("streamIndex"),"sourcePresentationIndex",frame.source,"sourcePts",Long.toString(frame.pts),"originPts",Long.toString(parser.origin),"relativePts",Long.toString(frame.relative),"timeBase",fixed.get("timeBase"),"timeSeconds",(double)frame.relative*parser.numerator/parser.denominator,"rangeIndex",frame.range,"bucketIndex",frame.bucket<0?null:frame.bucket,"codedVideoToFrame",fixed.get("codedVideoToFrame"),"selectionVersion",SELECTION);
    }
    private static Rotation rotation(JsonObject stream){
        JsonArray raw=null;Integer rotation=null;for(JsonElement element:Json.array(stream,"side_data_list")){JsonObject side=element.getAsJsonObject();if(!Json.str(side,"side_data_type","").equals("Display Matrix"))continue;if(raw!=null)throw error(422,"video_rotation_unsupported","视频包含冲突的显示矩阵。");String matrix=text(side,"displaymatrix",2000);List<Long> numbers=new ArrayList<>();for(String line:matrix.strip().split("\\R")){int colon=line.indexOf(':');if(colon<0)throw error(422,"video_rotation_unsupported","无法解释视频显示矩阵。");for(String value:line.substring(colon+1).strip().split("\\s+"))numbers.add(Long.parseLong(value));}if(numbers.size()!=9)throw error(422,"video_rotation_unsupported","视频显示矩阵尺寸无效。");raw=Json.element(numbers).getAsJsonArray();long[][] supported={{65536,0,0,0,65536,0,0,0,1073741824},{0,-65536,0,65536,0,0,0,0,1073741824},{-65536,0,0,0,-65536,0,0,0,1073741824},{0,65536,0,-65536,0,0,0,0,1073741824}};for(int i=0;i<supported.length;i++){boolean same=true;for(int j=0;j<9;j++)same&=numbers.get(j)==supported[i][j];if(same)rotation=i*90;}if(rotation==null)throw error(422,"video_rotation_unsupported","仅支持无镜像的 0、90、180、270 度视频显示矩阵。");}
        JsonObject tags=Json.object(stream,"tags");if(tags.has("rotate")){double value=Double.parseDouble(text(tags,"rotate",80));if(!Double.isFinite(value)||value%90!=0)throw error(422,"video_rotation_unsupported","视频旋转角度不受支持。");int tagged=(int)((value%360+360)%360);if(rotation!=null&&rotation!=tagged)throw error(422,"video_rotation_unsupported","旋转标签与显示矩阵不一致。");rotation=tagged;}
        return new Rotation(rotation==null?0:rotation,raw==null?new JsonArray():raw);
    }
    private static JsonArray matrix(int degrees,int width,int height){return Media.matrix(switch(degrees){case 90->8;case 180->3;case 270->6;default->1;},width,height);}

    private Job begin(String id,long timeout,Control control){if(id.isBlank()||id.length()>160||timeout<1||timeout>86400000)throw error(400,"video_parameters_invalid","媒体任务标识或超时时间无效。");if(closed)throw error(503,"video_closed","媒体工作器已关闭。");Job job=new Job(id,timeout,control);if(!active.compareAndSet(null,job))throw error(409,"video_worker_busy","媒体工作器正在执行其他任务。");
        job.watcher=Thread.ofVirtual().start(()->{try{while(!job.finished){checkpoint(job);Thread.sleep(25);}}catch(InterruptedException ignored){}catch(ApiError ignored){}});
        job.observer=Thread.ofVirtual().start(()->{try{while(!job.finished){JsonObject event=job.progress.take();try{job.control.progress(event);}catch(RuntimeException ignored){}}}catch(InterruptedException ignored){}});return job;}
    private void end(Job job){job.finished=true;job.watcher.interrupt();job.observer.interrupt();stop(job.process);if(job.process!=null)try{job.process.waitFor(2,TimeUnit.SECONDS);}catch(InterruptedException interrupted){Thread.currentThread().interrupt();}active.compareAndSet(job,null);}
    private static void checkpoint(Job job){ApiError failed=job.failure.get();if(failed!=null)throw failed;if(job.control.cancelled())fail(job,error(499,"video_cancelled","抽帧已取消。"));if(System.nanoTime()>=job.deadline)fail(job,error(504,"video_timeout","媒体工作超时，已停止自己的进程。"));failed=job.failure.get();if(failed!=null)throw failed;}
    private static void fail(Job job,ApiError reason){synchronized(job){if(job.committed)return;job.failure.compareAndSet(null,reason);stop(job.process);}}
    private static void stop(Process process){if(process==null)return;List<ProcessHandle> children=process.descendants().toList();for(ProcessHandle child:children)child.destroyForcibly();if(process.isAlive())process.destroyForcibly();}
    private Process start(List<String> args,Job job)throws IOException{checkpoint(job);ProcessBuilder builder=new ProcessBuilder(args);builder.redirectInput(ProcessBuilder.Redirect.PIPE);Process process=builder.start();job.process=process;process.getOutputStream().close();checkpoint(job);return process;}
    private String capture(List<String> command,Job job,int limit){
        try{Process process=start(command,job);ByteArrayOutputStream output=new ByteArrayOutputStream();CompletableFuture<Void> stdout=readBytes(process.getInputStream(),output,limit,job),stderr=readLines(process.getErrorStream(),line->{},job);
            while(process.isAlive()||!stdout.isDone()||!stderr.isDone()){checkpoint(job);Thread.sleep(10);}join(stdout);join(stderr);checkpoint(job);if(process.exitValue()!=0)throw error(422,"video_probe_failed","媒体工具无法探测所选文件。");return output.toString(StandardCharsets.UTF_8);
        }catch(ApiError e){throw e;}catch(InterruptedException e){Thread.currentThread().interrupt();throw error(499,"video_cancelled","媒体探测已中断。");}catch(Exception e){throw error(503,"video_environment_missing","FFmpeg 或 ffprobe 无法启动。");}
    }
    private String version(Path executable,Job job){if(!Files.isRegularFile(executable))throw error(503,"video_environment_missing","未找到 FFmpeg 或 ffprobe。");String first=capture(List.of(executable.toString(),"-version"),job,128*1024).lines().findFirst().orElse("");if(first.isBlank())throw error(503,"video_environment_missing","媒体工具未返回有效版本。");return first;}
    private interface LineHandler{void accept(String line)throws Exception;}
    private static CompletableFuture<Void> readLines(InputStream input,LineHandler handler,Job job){CompletableFuture<Void> done=new CompletableFuture<>();Thread.ofVirtual().start(()->{try(input;ByteArrayOutputStream line=new ByteArrayOutputStream()){byte[] block=new byte[8192];int count;while((count=input.read(block))!=-1)for(int i=0;i<count;i++){if(block[i]=='\n'){handler.accept(line.toString(StandardCharsets.UTF_8).stripTrailing());line.reset();}else{if(line.size()>=LINE_LIMIT)throw error(413,"video_metadata_limit","媒体输出行超过限制。");line.write(block[i]);}}if(line.size()>0)handler.accept(line.toString(StandardCharsets.UTF_8));done.complete(null);}catch(Exception failure){ApiError reason=failure instanceof ApiError api?api:error(502,"video_protocol_invalid","媒体输出读取失败。");fail(job,reason);done.completeExceptionally(reason);}});return done;}
    private static CompletableFuture<Void> readBytes(InputStream input,ByteArrayOutputStream output,int limit,Job job){CompletableFuture<Void> done=new CompletableFuture<>();Thread.ofVirtual().start(()->{try(input){byte[] block=new byte[8192];int count;while((count=input.read(block))!=-1){if(output.size()+count>limit)throw error(413,"video_metadata_limit","媒体探测信息超过限制。");output.write(block,0,count);}done.complete(null);}catch(Exception failure){ApiError reason=failure instanceof ApiError api?api:error(502,"video_protocol_invalid","媒体探测输出读取失败。");fail(job,reason);done.completeExceptionally(reason);}});return done;}
    private static void join(CompletableFuture<?> future){try{future.join();}catch(CompletionException error){if(error.getCause() instanceof ApiError api)throw api;throw error;}}
    private static void notify(Job job,JsonObject event){job.progress.offer(event);}
    private static final byte[] PNG_SIGNATURE={(byte)137,80,78,71,13,10,26,10};
    private static boolean readPng(InputStream input,Path path,long remaining,boolean overFrameLimit,JsonObject fixed,Job job)throws Exception{
        int first=input.read();checkpoint(job);if(first<0)return false;if(overFrameLimit)throw error(413,"video_frame_limit","实际帧数超过上限，未发布截断结果。");byte[] signature=new byte[8];signature[0]=(byte)first;exact(input,signature,1,7);if(!Arrays.equals(signature,PNG_SIGNATURE))throw error(502,"video_image_invalid","媒体管道缺少有效 PNG 帧头。");
        try(OutputStream output=limited(path,Math.min(remaining,Media.MAX_FILE),job)){output.write(signature);boolean firstChunk=true;byte[] header=new byte[8],block=new byte[65536],checksum=new byte[4];
            while(true){exact(input,header,0,8);long length=Integer.toUnsignedLong(java.nio.ByteBuffer.wrap(header).getInt());String type=new String(header,4,4,StandardCharsets.US_ASCII);if(length>Media.MAX_FILE||firstChunk&&(!type.equals("IHDR")||length!=13)||type.equals("IEND")&&length!=0)throw error(502,"video_image_invalid","PNG 帧结构超出允许范围。");firstChunk=false;CRC32 crc=new CRC32();crc.update(header,4,4);output.write(header);long unread=length;
                while(unread>0){int size=(int)Math.min(unread,block.length);exact(input,block,0,size);if(type.equals("IHDR")){int w=java.nio.ByteBuffer.wrap(block,0,4).getInt(),h=java.nio.ByteBuffer.wrap(block,4,4).getInt();if(w!=integer(fixed,"outputWidth",1,20000)||h!=integer(fixed,"outputHeight",1,20000))throw error(502,"video_image_invalid","PNG 帧头尺寸与固定输出不一致。");}crc.update(block,0,size);output.write(block,0,size);unread-=size;}exact(input,checksum,0,4);if(Integer.toUnsignedLong(java.nio.ByteBuffer.wrap(checksum).getInt())!=crc.getValue())throw error(502,"video_image_invalid","PNG 帧校验失败。");output.write(checksum);if(type.equals("IEND"))return true;
            }
        }
    }
    private static void exact(InputStream input,byte[] bytes,int start,int length)throws IOException{int count=0,n;while(count<length){n=input.read(bytes,start+count,length-count);if(n<0)throw new EOFException("Incomplete PNG frame");count+=n;}}
    private static Path directoryFrame(Path frames,String relative){if(!relative.matches("frames/frame-[0-9]{8}\\.(png|jpg)"))throw error(502,"video_frame_mismatch","清单图片路径无效。");return frames.resolve(relative.substring(7));}
    private static OutputStream limited(Path path,long max,Job job)throws IOException{return new FilterOutputStream(Files.newOutputStream(path,StandardOpenOption.CREATE_NEW)){
        long count;
        @Override public void write(int b)throws IOException{byte[] one={(byte)b};write(one,0,1);}
        @Override public void write(byte[] bytes,int offset,int length)throws IOException{checkpoint(job);if(length>max-count)throw error(413,"video_output_limit","实际写出字节达到限额，已保留未完成产物。");out.write(bytes,offset,length);count+=length;}
    };}
    private static void jpeg(Path png,Path output,long remaining,JsonObject fixed,Job job)throws IOException{
        BufferedImage image=ImageIO.read(png.toFile());if(image==null)throw error(422,"video_image_invalid","中间帧不能解码。");ImageWriter writer=ImageIO.getImageWritersByFormatName("jpeg").next();
        try(OutputStream bytes=limited(output,Math.min(remaining,Media.MAX_FILE),job);MemoryCacheImageOutputStream encoded=new MemoryCacheImageOutputStream(bytes)){writer.setOutput(encoded);ImageWriteParam settings=writer.getDefaultWriteParam();settings.setCompressionMode(ImageWriteParam.MODE_EXPLICIT);settings.setCompressionQuality((33-integer(fixed,"jpegQuality",2,31))/31f);writer.write(null,new IIOImage(image,null,null),settings);encoded.flush();}finally{writer.dispose();image.flush();}
    }
    private static String hash(Path path,Job job)throws Exception{MessageDigest digest=MessageDigest.getInstance("SHA-256");try(InputStream source=Files.newInputStream(path)){byte[] block=new byte[65536];int n;while((n=source.read(block))!=-1){checkpoint(job);digest.update(block,0,n);}}return HexFormat.of().formatHex(digest.digest());}
    private static Path createDirectory(Path requested)throws IOException{Path path=requested.toAbsolutePath().normalize();if(path.getParent()==null)throw error(400,"video_directory_invalid","请提供专属生成目录。");Path parent=path.getParent().toRealPath();path=parent.resolve(path.getFileName());Files.createDirectory(path);if(!path.equals(path.toRealPath())||Files.isSymbolicLink(path))throw error(400,"video_directory_invalid","生成目录实际位置不一致。");return path;}
    private static long frameReserve(JsonObject fixed){return Math.max(16L*1024*1024,integer(fixed,"outputWidth",1,20000)*integer(fixed,"outputHeight",1,20000)*8);}
    private static void space(Path directory,Job job,long reserve)throws IOException{checkpoint(job);long available=Math.min(Files.getFileStore(directory).getUsableSpace(),job.control.availableBytesLimit(directory));if(available<DISK_MARGIN+reserve)throw error(507,"video_disk_low","抽帧磁盘安全余量不足，未继续写出图片。");}
    private static void validateImage(Path path,JsonObject fixed)throws IOException{BufferedImage image=ImageIO.read(path.toFile());if(image==null)throw error(422,"video_image_invalid","抽帧图片不能完整解码。");try{if(image.getWidth()!=integer(fixed,"outputWidth",1,20000)||image.getHeight()!=integer(fixed,"outputHeight",1,20000))throw error(422,"video_image_invalid","抽帧图片实际尺寸与元数据不一致。");}finally{image.flush();}}
    private static void atomicJson(Path path,JsonObject value)throws IOException{Path temporary=path.resolveSibling(path.getFileName()+".tmp");Files.writeString(temporary,value.toString(),StandardCharsets.UTF_8,StandardOpenOption.CREATE_NEW);Files.move(temporary,path,StandardCopyOption.ATOMIC_MOVE);}
    private static void incomplete(Path directory,Job job,ApiError failure){try{atomicJson(directory.resolve("incomplete.json"),Json.obj("jobId",job.id,"status",failure.code.equals("video_cancelled")?"cancelled":"failed","error",failure.json()));}catch(Exception ignored){}}
    private static void dimensions(int w,int h){if(w<1||h<1||w>20000||h>20000||(long)w*h>Media.MAX_PIXELS)throw error(413,"video_dimensions_exceeded","视频或输出超过支持的像素范围。");}
    private static long[] rational(String value,String separator){String[] pieces=value.split(Pattern.quote(separator),-1);try{long n=Long.parseLong(pieces[0]),d=Long.parseLong(pieces[1]);if(pieces.length!=2||n<=0||d<=0||n>Integer.MAX_VALUE||d>Integer.MAX_VALUE)throw new NumberFormatException();return new long[]{n,d};}catch(Exception invalid){throw error(422,"video_geometry_unsupported","视频时间基准或像素比例未知，不能猜测。");}}
    private static String text(JsonObject value,String key,int limit){JsonElement item=value.get(key);if(item==null||!item.isJsonPrimitive()||!item.getAsJsonPrimitive().isString()||item.getAsString().isBlank()||item.getAsString().length()>limit)throw error(400,"video_parameters_invalid","缺少或无效字段："+key);return item.getAsString();}
    private static long integer(JsonObject value,String key,long min,long max){try{JsonElement item=value.get(key);if(item==null||!item.isJsonPrimitive()||!item.getAsJsonPrimitive().isNumber())throw new ArithmeticException();long number=item.getAsBigDecimal().longValueExact();if(number<min||number>max)throw new ArithmeticException();return number;}catch(Exception invalid){throw error(400,"video_parameters_invalid","整数字段无效："+key);}}
    private static double number(JsonObject value,String key,double min,double max){try{JsonElement item=value.get(key);if(item==null||!item.isJsonPrimitive()||!item.getAsJsonPrimitive().isNumber())throw new ArithmeticException();double number=item.getAsDouble();if(!Double.isFinite(number)||number<min||number>max)throw new ArithmeticException();return number;}catch(Exception invalid){throw error(400,"video_parameters_invalid","数值字段无效："+key);}}
    private static JsonObject parse(String text)throws IOException{try(JsonReader reader=new JsonReader(new StringReader(text))){reader.setStrictness(Strictness.STRICT);JsonObject value=JsonParser.parseReader(reader).getAsJsonObject();if(reader.peek()!=JsonToken.END_DOCUMENT)throw error(502,"video_protocol_invalid","媒体探测返回多余内容。");return value;}}
    private static ApiError error(int status,String code,String message){return new ApiError(status,code,message);}
    private static ApiError error(int status,String code,String message,JsonObject details){return new ApiError(status,code,message,details);}
}
