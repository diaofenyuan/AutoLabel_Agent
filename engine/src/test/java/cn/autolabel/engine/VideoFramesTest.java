package cn.autolabel.engine;

import com.google.gson.*;
import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

public final class VideoFramesTest {
    private static Path ffmpeg,ffprobe,root,vfr,cfr,still;
    private static int checks;
    private interface Action{void run()throws Exception;}
    private static void check(boolean value,String message){checks++;if(!value)throw new AssertionError(message);}
    private static void rejects(String code,Action action)throws Exception{try{action.run();throw new AssertionError("Expected "+code);}catch(ApiError failure){check(code.equals(failure.code),"Expected "+code+", got "+failure.code+": "+failure.getMessage());}}

    public static void main(String[] args)throws Exception{
        if(args.length!=2)throw new IllegalArgumentException("ffmpegPath ffprobePath");ffmpeg=Path.of(args[0]).toAbsolutePath();ffprobe=Path.of(args[1]).toAbsolutePath();root=Files.createTempDirectory("autolabel-video-frames-");
        fixtures();selection();geometry();limitsAndCancellation();
        System.out.println("Video frames: "+checks+" checks passed; isolated fixtures: "+root);
    }
    private static void fixtures()throws Exception{
        vfr=root.resolve("variable.mp4");cfr=root.resolve("constant.mp4");still=root.resolve("same-frames.mp4");
        run("-f","lavfi","-i","testsrc2=duration=1:size=64x48:rate=10","-vf","select='not(eq(n,2))*not(eq(n,3))*not(eq(n,7))'","-fps_mode","vfr","-c:v","libx264","-threads","1",vfr.toString());
        run("-f","lavfi","-i","testsrc2=duration=4:size=320x240:rate=60","-c:v","libx264","-threads","1",cfr.toString());
        run("-f","lavfi","-i","color=c=blue:duration=1:size=64x48:rate=4","-c:v","libx264","-threads","1",still.toString());
    }
    private static JsonObject request(Path source){return Json.obj("jobId",Json.id(),"sourcePath",source.toString(),"mode","fps","targetFps",5,"ranges",Json.arr(Json.obj("start",0.05,"end",0.65),Json.obj("start",0.75,"end",1.0)),"format","png","maxFrames",1000,"maxOutputBytes",64L*1024*1024,"timeoutMs",30000);}
    private static List<JsonObject> items(VideoFrames.Extraction result)throws Exception{List<JsonObject> items=new ArrayList<>();for(String line:Files.readAllLines(result.manifestPath(),StandardCharsets.UTF_8))items.add(Json.parse(line));return items;}
    private static List<Long> indices(List<JsonObject> items){return items.stream().map(item->Json.number(item,"sourcePresentationIndex",-1)).toList();}

    private static void selection()throws Exception{
        try(VideoFrames helper=new VideoFrames(ffmpeg,ffprobe)){
            JsonObject fixed=helper.inspect(request(vfr),10000);check(Json.required(fixed,"ffmpegVersion").contains("8.1.1"),"actual configured ffmpeg version recorded");check(Json.required(fixed,"sourceHash").equals(Media.hash(vfr)),"source digest frozen");
            VideoFrames.Extraction result=helper.extract(fixed,root.resolve("fps-vfr"),null);List<JsonObject> rows=items(result);check(indices(rows).equals(List.of(1L,2L,3L,5L)),"VFR time buckets and two half-open segments choose first actual frames");double[] times={0.1,0.4,0.5,0.8};for(int i=0;i<rows.size();i++){JsonObject item=rows.get(i);check(Math.abs(Json.decimal(item,"timeSeconds",-1)-times[i])<1e-8,"actual PTS is retained");check(Media.hash(result.manifestPath().getParent().resolve(Json.required(item,"imagePath"))).equals(Json.required(item,"contentHash")),"actual frame hash matches manifest");}
            check(Files.isRegularFile(result.manifestPath().getParent().resolve("complete.json"))&&Json.required(result.summary(),"status").equals("completed"),"complete marker follows verified manifest");check(Media.hash(result.manifestPath()).equals(Json.required(result.summary(),"manifestHash")),"manifest digest is exact final bytes");
            JsonObject interval=request(vfr);interval.addProperty("mode","interval");interval.remove("targetFps");interval.addProperty("intervalSeconds",0.2);check(indices(items(helper.extract(helper.inspect(interval,10000),root.resolve("interval-vfr"),null))).equals(indices(rows)),"interval uses fixed segment grid without previous-selected drift");
            JsonObject every=request(vfr);every.addProperty("mode","every_n");every.remove("targetFps");every.addProperty("everyNFrames",2);every.add("ranges",Json.arr(Json.obj("start",0,"end",1)));check(indices(items(helper.extract(helper.inspect(every,10000),root.resolve("every-n"),null))).equals(List.of(0L,2L,4L,6L)),"every N uses actual source presentation ordinal");
            JsonObject identical=request(still);identical.addProperty("targetFps",20);identical.add("ranges",Json.arr(Json.obj("start",0,"end",1)));List<JsonObject> staticRows=items(helper.extract(helper.inspect(identical,10000),root.resolve("static"),null));check(staticRows.size()==4,"no duplicate frame synthesis above source FPS");check(staticRows.stream().map(row->Json.required(row,"contentHash")).distinct().count()==1&&staticRows.stream().map(row->Json.required(row,"sourcePts")).distinct().count()==4,"identical pictures retain four distinct source times");
            JsonObject boundary=request(vfr);boundary.addProperty("targetFps",240);boundary.add("ranges",Json.arr(Json.obj("start",0.4,"end",0.5)));check(indices(items(helper.extract(helper.inspect(boundary,10000),root.resolve("half-open"),null))).equals(List.of(2L)),"range end is exclusive");
            JsonObject overlap=request(vfr);overlap.add("ranges",Json.arr(Json.obj("start",0,"end",0.5),Json.obj("start",0.4,"end",0.8)));rejects("video_ranges_overlap",()->helper.inspect(overlap,10000));
            JsonObject corrupt=fixed.deepCopy();corrupt.add("codedVideoToFrame",Json.arr(2,0,0,0,2,0));rejects("video_plan_changed",()->helper.extract(corrupt,root.resolve("tampered-plan"),null));
        }
    }

    private static void geometry()throws Exception{
        Path rotated=root.resolve("rotated.mp4"),mirrored=root.resolve("mirrored.mp4"),reference=root.resolve("autorotated.png"),widePixels=root.resolve("wide-pixels.mp4"),duplicatePts=root.resolve("duplicate-pts.mkv");
        run("-display_rotation","90","-i",vfr.toString(),"-map","0:v:0","-c","copy",rotated.toString());
        run("-display_hflip","-i",vfr.toString(),"-map","0:v:0","-c","copy",mirrored.toString());
        run("-i",rotated.toString(),"-frames:v","1","-c:v","png",reference.toString());
        run("-f","lavfi","-i","testsrc2=duration=0.5:size=64x48:rate=10","-vf","setsar=2/1","-c:v","libx264","-threads","1",widePixels.toString());
        run("-f","lavfi","-i","testsrc2=duration=0.5:size=64x48:rate=10","-vf","setpts=floor(N/2)","-fps_mode","passthrough","-c:v","ffv1","-threads","1",duplicatePts.toString());
        try(VideoFrames helper=new VideoFrames(ffmpeg,ffprobe)){
            JsonObject request=request(rotated);request.addProperty("targetFps",1);request.add("ranges",Json.arr(Json.obj("start",0,"end",0.2)));JsonObject fixed=helper.inspect(request,10000);check(Json.integer(fixed,"rotation",-1)==90&&Json.integer(fixed,"outputWidth",0)==48&&Json.integer(fixed,"outputHeight",0)==64,"display rotation changes output dimensions exactly once");
            VideoFrames.Extraction result=helper.extract(fixed,root.resolve("rotated-output"),null);JsonObject item=items(result).getFirst();BufferedImage expected=ImageIO.read(reference.toFile()),actual=ImageIO.read(result.manifestPath().getParent().resolve(Json.required(item,"imagePath")).toFile());
            check(expected.getWidth()==actual.getWidth()&&expected.getHeight()==actual.getHeight(),"actual rotated dimensions match ffmpeg autorotation");int unequal=0;for(int y=0;y<actual.getHeight();y++)for(int x=0;x<actual.getWidth();x++)if(expected.getRGB(x,y)!=actual.getRGB(x,y))unequal++;expected.flush();actual.flush();check(unequal==0,"explicit rotation pixels match default decoder display orientation");
            check(Json.array(fixed,"codedVideoToFrame").equals(Json.arr(0.0,1.0,0.0,-1.0,0.0,64.0)),"coded video to extracted frame matrix retains pixel-edge convention");rejects("video_rotation_unsupported",()->helper.inspect(request(mirrored),10000));
            JsonObject resized=request(vfr);resized.add("outputSize",Json.obj("width",32,"height",32,"fit","contain"));resized.addProperty("format","jpg");JsonObject scaled=helper.inspect(resized,10000);VideoFrames.Extraction small=helper.extract(scaled,root.resolve("scaled-jpeg"),null);check(Json.integer(scaled,"outputWidth",0)==32&&Json.integer(scaled,"outputHeight",0)==24&&items(small).size()==4,"aspect-preserving resized JPEG has correct time identity");
            JsonObject pixels=request(widePixels);pixels.add("ranges",Json.arr(Json.obj("start",0,"end",0.3)));JsonObject square=helper.inspect(pixels,10000);check(Json.integer(square,"outputWidth",0)==128&&Json.integer(square,"outputHeight",0)==48&&Json.array(square,"codedVideoToFrame").equals(Json.arr(2.0,0.0,0.0,0.0,1.0,0.0)),"non-square SAR is represented by pixel scaling and matrix");check(items(helper.extract(square,root.resolve("square-pixels"),null)).size()==2,"non-square pixel input produces actual normalized frames");
            JsonObject duplicate=request(duplicatePts);duplicate.add("ranges",Json.arr(Json.obj("start",0,"end",0.5)));JsonObject badTime=helper.inspect(duplicate,10000);rejects("video_timestamp_invalid",()->helper.extract(badTime,root.resolve("bad-time"),null));check(!Files.exists(root.resolve("bad-time/complete.json")),"real duplicate timestamps cannot be marked complete");
        }
    }

    private static void limitsAndCancellation()throws Exception{
        try(VideoFrames helper=new VideoFrames(ffmpeg,ffprobe)){
            JsonObject count=request(still);count.add("ranges",Json.arr(Json.obj("start",0,"end",1)));count.addProperty("targetFps",20);count.addProperty("maxFrames",2);Path limited=root.resolve("count-limit");rejects("video_frame_limit",()->helper.extract(helper.inspect(count,10000),limited,null));check(!Files.exists(limited.resolve("complete.json")),"frame limit cannot silently truncate a completed extraction");
            JsonObject bytes=request(vfr);bytes.addProperty("maxOutputBytes",1);Path byteDir=root.resolve("byte-limit");rejects("video_output_limit",()->helper.extract(helper.inspect(bytes,10000),byteDir,null));check(!Files.exists(byteDir.resolve("complete.json")),"output byte limit remains incomplete");try(var paths=Files.walk(byteDir)){long outputBytes=paths.filter(path->path.toString().endsWith(".png")||path.toString().endsWith(".png.tmp")).mapToLong(path->{try{return Files.size(path);}catch(Exception error){throw new RuntimeException(error);}}).sum();check(outputBytes<=1,"PNG image bytes never exceed the configured byte budget");}
            JsonObject jpegBytes=bytes.deepCopy();jpegBytes.addProperty("format","jpg");Path jpegDir=root.resolve("jpeg-byte-limit");rejects("video_output_limit",()->helper.extract(helper.inspect(jpegBytes,10000),jpegDir,null));try(var paths=Files.walk(jpegDir)){check(paths.filter(path->path.toString().endsWith(".jpg.tmp")).allMatch(path->{try{return Files.size(path)<=1;}catch(Exception error){throw new RuntimeException(error);}}),"JPEG writer also limits actual image bytes before publication");}
            JsonObject disk=helper.inspect(request(vfr),10000);Path diskDir=root.resolve("disk-limit");rejects("video_disk_low",()->helper.extract(disk,diskDir,new VideoFrames.Control(){public long availableBytesLimit(Path directory){return 0;}}));check(Files.exists(diskDir.resolve("incomplete.json")),"actual disk checks can be tightened by resource policy");
            JsonObject shortDeadline=request(cfr);shortDeadline.addProperty("timeoutMs",1);JsonObject shortPlan=helper.inspect(shortDeadline,10000);rejects("video_timeout",()->helper.extract(shortPlan,root.resolve("timeout"),null));
            Path mutable=root.resolve("mutable.mp4");Files.copy(cfr,mutable);JsonObject changed=request(mutable);changed.addProperty("targetFps",60);changed.add("ranges",Json.arr(Json.obj("start",0,"end",4)));JsonObject plan=helper.inspect(changed,10000);AtomicBoolean mutated=new AtomicBoolean();Path changedDir=root.resolve("source-changed");
            rejects("video_source_changed",()->helper.extract(plan,changedDir,new VideoFrames.Control(){public long availableBytesLimit(Path directory){try{Path frames=directory.resolve("frames");if(Files.isDirectory(frames))try(var files=Files.list(frames)){if(files.findAny().isPresent()&&mutated.compareAndSet(false,true))Files.write(mutable,new byte[]{1,2,3,4},StandardOpenOption.APPEND);}}catch(Exception failure){throw new RuntimeException(failure);}return Long.MAX_VALUE;}}));check(mutated.get()&&!Files.exists(changedDir.resolve("complete.json")),"source mutation after frames exist prevents final publication");
            JsonObject frameMutation=helper.inspect(request(vfr),10000);AtomicBoolean changedFrame=new AtomicBoolean();Path frameDir=root.resolve("frame-changed");rejects("video_output_changed",()->helper.extract(frameMutation,frameDir,new VideoFrames.Control(){public long availableBytesLimit(Path directory){try(var paths=Files.list(directory.resolve("frames"))){Optional<Path> path=paths.findFirst();if(path.isPresent()&&changedFrame.compareAndSet(false,true))Files.writeString(path.get(),"changed output");}catch(Exception failure){throw new RuntimeException(failure);}return Long.MAX_VALUE;}}));check(changedFrame.get()&&!Files.exists(frameDir.resolve("complete.json")),"modified output cannot pass final hash verification");
            JsonObject cancel=request(cfr);cancel.addProperty("targetFps",60);cancel.add("ranges",Json.arr(Json.obj("start",0,"end",4)));JsonObject cancelPlan=helper.inspect(cancel,10000);Path cancelDir=root.resolve("cancelled");CompletableFuture<Void> begun=new CompletableFuture<>();AtomicBoolean shouldCancel=new AtomicBoolean();
            CompletableFuture<?> running=CompletableFuture.runAsync(()->helper.extract(cancelPlan,cancelDir,new VideoFrames.Control(){public long availableBytesLimit(Path directory){try(var files=Files.list(directory.resolve("frames"))){if(files.findAny().isPresent())begun.complete(null);}catch(Exception ignored){}return Long.MAX_VALUE;}public boolean cancelled(){return shouldCancel.get();}}));
            begun.get(10,TimeUnit.SECONDS);rejects("video_worker_busy",()->helper.inspect(request(vfr),1000));check(!helper.cancel("another-job"),"different job cancellation cannot affect active media");check(helper.cancel(Json.required(cancelPlan,"jobId")),"matching cancellation is accepted");rejects("video_cancelled",()->join(running));check(!Files.exists(cancelDir.resolve("complete.json"))&&Files.isRegularFile(cancelDir.resolve("incomplete.json")),"cancel leaves explicit incomplete artifacts");
            Path occupied=root.resolve("occupied");Files.createDirectory(occupied);Files.writeString(occupied.resolve("keep.txt"),"user-owned");rejects("video_extract_failed",()->helper.extract(helper.inspect(request(vfr),10000),occupied,null));try(var files=Files.list(occupied)){check(Files.readString(occupied.resolve("keep.txt")).equals("user-owned")&&files.count()==1,"existing output directory is never reused or cleaned");}
        }
    }
    private static void join(CompletableFuture<?> future)throws Exception{try{future.get(10,TimeUnit.SECONDS);}catch(ExecutionException failure){if(failure.getCause() instanceof ApiError api)throw api;throw failure;}}
    private static void run(String...args)throws Exception{List<String> command=new ArrayList<>(List.of(ffmpeg.toString(),"-hide_banner","-nostdin","-loglevel","error","-y"));command.addAll(List.of(args));Process process=new ProcessBuilder(command).redirectErrorStream(true).start();CompletableFuture<String> output=CompletableFuture.supplyAsync(()->{try{return new String(process.getInputStream().readNBytes(64*1024),StandardCharsets.UTF_8);}catch(Exception failure){return failure.toString();}});if(!process.waitFor(30,TimeUnit.SECONDS)){process.destroyForcibly();throw new AssertionError("Fixture ffmpeg timed out");}if(process.exitValue()!=0)throw new AssertionError(output.get());}
}
