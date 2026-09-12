package cn.autolabel.engine;

import com.google.gson.*;
import javax.imageio.*;
import javax.imageio.stream.ImageInputStream;
import java.awt.image.BufferedImage;
import java.io.*;
import java.nio.file.*;
import java.security.*;
import java.util.*;

/** 基准图筛选建议；不写缓存、不合并素材身份，也不改文件或人工版本。 */
final class ImageScreening {
    static final String FEATURE_VERSION="gray77-150-29-r128-box256-round-no-upscale-floor-bins-dhash9x8-bilinear-center-clamp-gt-lsb-row-lap4-interior-pop-v1";
    static final String PLAN_VERSION="screening-content-groups-stable-v1";
    private static final int MAX_INPUTS=10000,ANALYSIS_EDGE=256;
    interface Control {
        default boolean cancelled(){return false;}
        default void progress(JsonObject event){}
    }
    record Feature(String featureVersion,String contentHash,int width,int height,
                   String normalizationVersion,int inputVersion,String dHash64,
                   Double laplacianVariance,int analysisWidth,int analysisHeight,double grayStdDev) {
        Feature {
            if(!FEATURE_VERSION.equals(featureVersion)||contentHash==null||!contentHash.matches("[a-f0-9]{64}")||!Media.NORMALIZATION_VERSION.equals(normalizationVersion)||inputVersion<1||dHash64==null||!dHash64.matches("[a-f0-9]{16}"))throw error(422,"screening_feature_invalid","缓存特征版本或输入绑定无效。");
            dimensions(width,height);int[] shape=shape(width,height);if(analysisWidth!=shape[0]||analysisHeight!=shape[1]||!Double.isFinite(grayStdDev)||grayStdDev<0||grayStdDev>255)throw error(422,"screening_feature_invalid","缓存特征的分析尺寸或灰度分布无效。");
            boolean available=analysisWidth>=3&&analysisHeight>=3;if(available!=(laplacianVariance!=null)||laplacianVariance!=null&&(!Double.isFinite(laplacianVariance)||laplacianVariance<0||laplacianVariance>1040400.000001))throw error(422,"screening_feature_invalid","缓存模糊分数与实际分析尺寸不一致。");
        }
        String cacheKey(){return contentHash+":"+width+"x"+height+":"+normalizationVersion+":"+inputVersion+":"+featureVersion;}
        JsonObject json(){return Json.obj("featureVersion",featureVersion,"contentHash",contentHash,"width",width,"height",height,"normalizationVersion",normalizationVersion,"inputVersion",inputVersion,"dHash64",dHash64,"laplacianVariance",laplacianVariance,"analysisWidth",analysisWidth,"analysisHeight",analysisHeight,"laplacianSamples",Math.max(0,analysisWidth-2)*Math.max(0,analysisHeight-2),"grayStdDev",grayStdDev);}
    }
    private record Input(JsonObject fixed,String id,Path path,String hash,int width,int height,int inputVersion,String status,String partition,String video,String group){}
    private static final class ContentGroup {
        final String hash;final List<Input> members=new ArrayList<>();final Set<String> partitions=new TreeSet<>();Feature feature;Input representative;
        ContentGroup(String hash){this.hash=hash;}
    }
    private static final class SourceGroup {
        final String kind,key;final List<Input> members=new ArrayList<>();final Set<String> partitions=new TreeSet<>();
        SourceGroup(String kind,String key){this.kind=kind;this.key=key;}
    }
    private static final Comparator<Input> REPRESENTATIVE=Comparator.comparingInt((Input item)->rank(item.status)).thenComparing(Input::id);

    static Feature feature(JsonObject frozenInput,Control observer){
        Control control=control(observer);Input input=input(frozenInput);checkpoint(control);progress(control,Json.obj("phase","feature_hashing","assetId",input.id));
        try{
            String before=hash(input.path,control);if(!before.equals(input.hash))throw changed(input.id);BufferedImage image;
            try(ImageInputStream stream=ImageIO.createImageInputStream(input.path.toFile())){
                if(stream==null)throw error(422,"screening_image_invalid","无法读取基准 PNG。");Iterator<ImageReader> readers=ImageIO.getImageReaders(stream);if(!readers.hasNext())throw error(422,"screening_image_invalid","基准图没有可用解码器。");ImageReader reader=readers.next();
                try{reader.setInput(stream,true,false);if(!reader.getFormatName().equalsIgnoreCase("png")||reader.getWidth(0)!=input.width||reader.getHeight(0)!=input.height)throw error(409,"screening_input_mismatch","实际 PNG 格式或尺寸与固定输入不一致。");image=reader.read(0);}finally{reader.dispose();}
            }
            try{
                if(image.getColorModel().hasAlpha()||!image.getColorModel().getColorSpace().isCS_sRGB())throw error(422,"screening_baseline_required","请先归一化到无透明通道的 sRGB 基准 PNG。");
                checkpoint(control);progress(control,Json.obj("phase","feature_decoded","assetId",input.id));int[] shape=shape(input.width,input.height);int w=shape[0],h=shape[1];double[] gray=new double[w*h];
                // 整数灰度公式和不重叠面积分箱保证每个源像素只归入一个分析像素；不依赖图形驱动插值。
                for(int y=0;y<h;y++){checkpoint(control);int y0=y*input.height/h,y1=(y+1)*input.height/h;
                    for(int x=0;x<w;x++){int x0=x*input.width/w,x1=(x+1)*input.width/w;long sum=0;for(int sy=y0;sy<y1;sy++){checkpoint(control);for(int sx=x0;sx<x1;sx++){int rgb=image.getRGB(sx,sy);sum+=(77*((rgb>>>16)&255)+150*((rgb>>>8)&255)+29*(rgb&255)+128)>>>8;}}gray[y*w+x]=(double)sum/((long)(x1-x0)*(y1-y0));}}
                double mean=0,m2=0;int count=0;for(double value:gray){double delta=value-mean;mean+=delta/++count;m2+=delta*(value-mean);}double std=Math.sqrt(Math.max(0,m2/count));
                long bits=0;for(int y=0;y<8;y++)for(int x=0;x<8;x++)if(sample(gray,w,h,x,y)>sample(gray,w,h,x+1,y))bits|=1L<<(y*8+x);
                Double variance=null;if(w>=3&&h>=3){double lapMean=0,lapM2=0;int n=0;for(int y=1;y<h-1;y++){checkpoint(control);for(int x=1;x<w-1;x++){double value=gray[y*w+x-1]+gray[y*w+x+1]+gray[(y-1)*w+x]+gray[(y+1)*w+x]-4*gray[y*w+x];double delta=value-lapMean;lapMean+=delta/++n;lapM2+=delta*(value-lapMean);}}variance=Math.max(0,lapM2/n);}
                checkpoint(control);if(!hash(input.path,control).equals(before))throw changed(input.id);Feature feature=new Feature(FEATURE_VERSION,before,input.width,input.height,Media.NORMALIZATION_VERSION,input.inputVersion,String.format(Locale.ROOT,"%016x",bits),variance,w,h,std);
                progress(control,Json.obj("phase","feature_ready","assetId",input.id,"analysisWidth",w,"analysisHeight",h));return feature;
            }finally{image.flush();}
        }catch(ApiError failure){throw failure;}catch(Exception failure){throw error(422,"screening_image_invalid","基准图片解码或特征提取失败。");}
    }

    static JsonObject plan(JsonArray frozenInputs,List<Feature> features,JsonObject options,Control observer){
        Control control=control(observer);checkpoint(control);if(frozenInputs==null||frozenInputs.isEmpty()||frozenInputs.size()>MAX_INPUTS||features==null||features.size()>MAX_INPUTS)throw error(400,"screening_batch_invalid","筛选任务需要 1～10000 张固定基准图。");
        JsonObject policy=policy(options);List<Input> inputs=new ArrayList<>();Set<String> ids=new HashSet<>();for(JsonElement item:frozenInputs){checkpoint(control);if(!item.isJsonObject())throw error(400,"screening_input_invalid","筛选输入必须是对象。");Input input=input(item.getAsJsonObject());if(!ids.add(input.id))throw error(400,"screening_asset_duplicate","同一素材身份不能在固定列表中出现两次。");inputs.add(input);}inputs.sort(Comparator.comparing(Input::id));
        Map<String,Feature> cache=new HashMap<>();for(Feature feature:features){if(feature==null)throw error(422,"screening_feature_missing","缺少实际特征。");Feature previous=cache.putIfAbsent(feature.cacheKey(),feature);if(previous!=null&&!previous.equals(feature))throw error(422,"screening_feature_conflict","同一固定输入存在冲突的特征。");}
        Map<String,ContentGroup> byHash=new HashMap<>();Map<String,SourceGroup> bySource=new TreeMap<>();Set<String> verifiedPaths=new HashSet<>();Map<String,JsonObject> items=new LinkedHashMap<>();JsonArray unavailableBlur=new JsonArray();
        int bound=0;for(Input input:inputs){checkpoint(control);Feature feature=cache.get(cacheKey(input));if(feature==null)throw error(422,"screening_feature_missing","缺少与当前内容、尺寸和版本匹配的特征。",Json.obj("assetId",input.id));
            try{String pathKey=input.path+"\n"+input.hash;if(verifiedPaths.add(pathKey)&&!hash(input.path,control).equals(input.hash))throw changed(input.id);}catch(ApiError e){throw e;}catch(Exception failure){throw changed(input.id);}
            ContentGroup group=byHash.computeIfAbsent(input.hash,ContentGroup::new);if(group.feature!=null&&!samePixels(group.feature,feature))throw error(422,"screening_feature_conflict","相同内容的特征值冲突。");group.feature=feature;group.members.add(input);if(input.partition!=null)group.partitions.add(input.partition);
            for(String kind:List.of("sourceVideoId","groupId")){String key=kind.equals("sourceVideoId")?input.video:input.group;if(key==null)continue;SourceGroup source=bySource.computeIfAbsent(kind+":"+key,k->new SourceGroup(kind,key));source.members.add(input);if(input.partition!=null)source.partitions.add(input.partition);}
            JsonArray reasons=new JsonArray();JsonObject row=Json.obj("assetId",input.id,"input",input.fixed,"feature",feature.json(),"protected",protectedInput(input),"recommendation",protectedInput(input)?"keep_protected":"keep","reasons",reasons);
            if(Json.bool(policy,"blurEnabled",false)){
                if(feature.laplacianVariance==null){unavailableBlur.add(input.id);reasons.add(Json.obj("code","blur_unexamined","reason","analysis_too_small","analysisWidth",feature.analysisWidth,"analysisHeight",feature.analysisHeight));}
                else if(feature.laplacianVariance<policy.get("blurThreshold").getAsDouble()){reasons.add(Json.obj("code","blur_candidate","score",feature.laplacianVariance,"threshold",policy.get("blurThreshold"),"analysisWidth",feature.analysisWidth,"analysisHeight",feature.analysisHeight,"requiresReview",true));if(!protectedInput(input))row.addProperty("recommendation","review_suggested");}
            }
            items.put(input.id,row);if(++bound%32==0||bound==inputs.size())progress(control,Json.obj("phase","binding","completed",bound,"total",inputs.size()));
        }
        List<ContentGroup> groups=new ArrayList<>(byHash.values());for(ContentGroup group:groups){group.members.sort(Comparator.comparing(Input::id));group.representative=group.members.stream().min(REPRESENTATIVE).orElseThrow();}groups.sort(Comparator.comparing(group->group.representative.id));
        JsonArray exactGroups=new JsonArray(),leakageGroups=new JsonArray();long exactIdentityPairs=0;
        for(ContentGroup group:groups){checkpoint(control);if(group.members.size()<2)continue;exactIdentityPairs+=(long)group.members.size()*(group.members.size()-1)/2;exactGroups.add(Json.obj("contentHash",group.hash,"representativeAssetId",group.representative.id,"members",memberIds(group.members),"partitions",group.partitions,"crossPartition",group.partitions.size()>1));
            for(Input input:group.members){JsonObject row=items.get(input.id);row.addProperty("exactRepresentativeAssetId",group.representative.id);if(!input.id.equals(group.representative.id)){Json.array(row,"reasons").add(Json.obj("code","exact_duplicate_content","representativeAssetId",group.representative.id,"identityPreserved",true));if(Json.bool(policy,"deduplicate",false)&&!protectedInput(input))row.addProperty("recommendation","exclude_suggested");}}
        }
        for(SourceGroup group:bySource.values())if(group.members.size()>1&&group.partitions.size()>1){checkpoint(control);leakageGroups.add(Json.obj("kind",group.kind,"sourceId",group.key,"members",memberIds(group.members),"representativeAssetId",group.members.stream().min(REPRESENTATIVE).orElseThrow().id,"partitions",group.partitions,"requiresReview",true));}
        long total=(long)groups.size()*(groups.size()-1)/2,visited=0,distances=0,aspectSkipped=0,coveredIdentities=0;long identityTotal=(long)inputs.size()*(inputs.size()-1)/2-exactIdentityPairs;List<JsonObject> pairs=new ArrayList<>();String stopped=null;
        boolean near=Json.bool(policy,"nearEnabled",true);int maxComparisons=policy.get("maxComparisons").getAsInt(),maxPairs=policy.get("maxPairs").getAsInt();double tolerance=policy.get("aspectRatioTolerance").getAsDouble();int threshold=policy.get("nearMaxDistance").getAsInt();
        if(near)outer:for(int i=0;i<groups.size();i++)for(int j=i+1;j<groups.size();j++){
            checkpoint(control);if(visited>=maxComparisons){stopped="comparison_budget";break outer;}if(pairs.size()>=maxPairs){stopped="pair_output_limit";break outer;}
            ContentGroup a=groups.get(i),b=groups.get(j);visited++;coveredIdentities+=(long)a.members.size()*b.members.size();Feature fa=a.feature,fb=b.feature;double crossA=(double)fa.width*fb.height,crossB=(double)fb.width*fa.height;double difference=Math.abs(crossA-crossB)/Math.max(crossA,crossB);
            if(difference>tolerance){aspectSkipped++;continue;}distances++;int distance=Long.bitCount(Long.parseUnsignedLong(fa.dHash64,16)^Long.parseUnsignedLong(fb.dHash64,16));
            if(distance<=threshold)pairs.add(Json.obj("leftAssetId",a.representative.id,"rightAssetId",b.representative.id,"leftContentHash",a.hash,"rightContentHash",b.hash,"leftMemberCount",a.members.size(),"rightMemberCount",b.members.size(),"distance",distance,"threshold",threshold,"aspectRatioDifference",difference,"aspectRatioTolerance",tolerance,"lowInformation",fa.grayStdDev<1||fb.grayStdDev<1,"crossPartition",crossPartition(a.partitions,b.partitions),"requiresReview",true,"action","candidate_only"));
            if(visited%1024==0)progress(control,Json.obj("phase","comparing","comparedContentPairs",visited,"totalContentPairs",total));
        }
        pairs.sort(Comparator.comparingInt((JsonObject pair)->pair.get("distance").getAsInt()).thenComparing(pair->Json.required(pair,"leftAssetId")).thenComparing(pair->Json.required(pair,"rightAssetId")));
        JsonArray rows=new JsonArray();items.values().forEach(rows::add);checkpoint(control);return Json.obj("planVersion",PLAN_VERSION,"featureVersion",FEATURE_VERSION,"status",stopped!=null||!unavailableBlur.isEmpty()?"incomplete":"complete","parameters",policy,"items",rows,"exactGroups",exactGroups,"sourceLeakageGroups",leakageGroups,"nearPairs",pairs,
            "nearCheck",Json.obj("status",!near?"disabled":stopped==null?"complete":"incomplete","scope","distinct_content_groups","totalContentPairs",total,"comparedContentPairs",visited,"hammingComparisons",distances,"aspectIncompatibleContentPairs",aspectSkipped,"unexaminedContentPairs",near?total-visited:total,"unexaminedIdentityPairUpperBound",identityTotal-coveredIdentities,"stopReason",stopped,"reportedPairs",pairs.size()),"partitionCheck",Json.obj("status",inputs.stream().allMatch(item->item.partition!=null)?"complete":"incomplete","unassignedInputs",inputs.stream().filter(item->item.partition==null).count()),"unexaminedBlurAssetIds",unavailableBlur,"inputCount",inputs.size(),"distinctContentCount",groups.size(),"identityMerge",false,"changesApplied",false,
            "scoreMeaning","近似距离和缩小分析图的 Laplacian 方差仅用于筛选提示；阈值不是通用准确率或原图清晰度准确率。");
    }

    private static Input input(JsonObject value){
        if(value==null)throw error(400,"screening_input_invalid","缺少固定输入。");bounded(value,new int[]{2048,65536},0);JsonObject fixed=value.deepCopy();String id=text(fixed,"assetId",160),hash=text(fixed,"contentHash",64);if(!hash.matches("[a-f0-9]{64}"))throw error(400,"screening_input_invalid","内容摘要必须是实际 SHA-256。");
        int width=integer(fixed,"width",1,20000),height=integer(fixed,"height",1,20000),version=integer(fixed,"inputVersion",1,Integer.MAX_VALUE);dimensions(width,height);if(!text(fixed,"normalizationVersion",160).equals(Media.NORMALIZATION_VERSION))throw error(409,"screening_normalization_mismatch","筛选需要当前归一化版本的固定基准图。");
        Path path;try{path=Path.of(text(fixed,"inputPath",32767));if(!path.isAbsolute())throw error(400,"screening_input_invalid","基准图必须使用绝对路径。");if(!Files.isRegularFile(path))throw error(404,"screening_input_missing","固定基准图不存在或不可读取。");if(Files.size(path)>Media.MAX_FILE)throw error(413,"screening_input_invalid","基准图文件大小超过 Media 限制。");path=path.toRealPath();}catch(ApiError failure){throw failure;}catch(InvalidPathException failure){throw error(400,"screening_input_invalid","基准图路径无效。");}catch(IOException failure){throw error(404,"screening_input_missing","固定基准图不存在或不可读取。");}
        String status=fixed.has("status")?text(fixed,"status",80):"unlabeled";return new Input(fixed,id,path,hash,width,height,version,status,optional(fixed,"partition"),tag(fixed,"sourceVideoId"),tag(fixed,"groupId"));
    }
    static JsonObject policy(JsonObject options){
        JsonObject input=options==null?new JsonObject():options.deepCopy();boolean blur=bool(input,"blurEnabled",false);JsonObject result=Json.obj("deduplicate",bool(input,"deduplicate",false),"nearEnabled",bool(input,"nearEnabled",true),"blurEnabled",blur,"nearMaxDistance",input.has("nearMaxDistance")?integer(input,"nearMaxDistance",0,64):6,"aspectRatioTolerance",input.has("aspectRatioTolerance")?number(input,"aspectRatioTolerance",0,1):0.02,"maxComparisons",input.has("maxComparisons")?integer(input,"maxComparisons",0,2000000):100000,"maxPairs",input.has("maxPairs")?integer(input,"maxPairs",0,20000):5000);
        if(blur)result.addProperty("blurThreshold",number(input,"blurThreshold",0,Double.MAX_VALUE));return result;
    }
    private static String cacheKey(Input input){return input.hash+":"+input.width+"x"+input.height+":"+Media.NORMALIZATION_VERSION+":"+input.inputVersion+":"+FEATURE_VERSION;}
    private static boolean samePixels(Feature a,Feature b){return a.width==b.width&&a.height==b.height&&a.dHash64.equals(b.dHash64)&&Objects.equals(a.laplacianVariance,b.laplacianVariance)&&a.analysisWidth==b.analysisWidth&&a.analysisHeight==b.analysisHeight&&a.grayStdDev==b.grayStdDev;}
    private static JsonArray memberIds(List<Input> inputs){JsonArray values=new JsonArray();inputs.stream().map(Input::id).sorted().forEach(values::add);return values;}
    private static boolean crossPartition(Set<String> a,Set<String> b){for(String x:a)for(String y:b)if(!x.equals(y))return true;return false;}
    private static int rank(String status){return switch(status){case "confirmed"->0;case "modified"->1;case "candidate"->2;default->3;};}
    private static boolean protectedInput(Input input){return Set.of("modified","confirmed").contains(input.status);}
    private static int[] shape(int width,int height){double factor=Math.min(1,(double)ANALYSIS_EDGE/Math.max(width,height));return new int[]{Math.max(1,(int)Math.round(width*factor)),Math.max(1,(int)Math.round(height*factor))};}
    private static double sample(double[] gray,int width,int height,int x,int y){double sx=Math.max(0,Math.min(width-1,(x+0.5)*width/9-0.5)),sy=Math.max(0,Math.min(height-1,(y+0.5)*height/8-0.5));int x0=(int)Math.floor(sx),y0=(int)Math.floor(sy),x1=Math.min(width-1,x0+1),y1=Math.min(height-1,y0+1);double dx=sx-x0,dy=sy-y0;return (gray[y0*width+x0]*(1-dx)+gray[y0*width+x1]*dx)*(1-dy)+(gray[y1*width+x0]*(1-dx)+gray[y1*width+x1]*dx)*dy;}
    private static String hash(Path path,Control control)throws Exception{MessageDigest digest=MessageDigest.getInstance("SHA-256");try(InputStream stream=Files.newInputStream(path)){byte[] block=new byte[65536];int count;long bytes=0;while((count=stream.read(block))!=-1){checkpoint(control);if((bytes+=count)>Media.MAX_FILE)throw error(413,"screening_input_invalid","读取中的基准图超过 Media 文件大小限制。");digest.update(block,0,count);}}return HexFormat.of().formatHex(digest.digest());}
    private static Control control(Control control){return control==null?new Control(){}:control;}
    private static void checkpoint(Control control){if(Thread.currentThread().isInterrupted()||control.cancelled())throw error(499,"screening_cancelled","图像筛选已取消，未应用任何筛选建议。");}
    private static void progress(Control control,JsonObject value){try{control.progress(value);}catch(RuntimeException ignored){/* 进度观察者不能修改纯计算的结果。 */}}
    private static void dimensions(int width,int height){if(width<1||height<1||width>20000||height>20000||(long)width*height>Media.MAX_PIXELS)throw error(413,"screening_dimensions_exceeded","基准图超过 Media 支持的尺寸范围。");}
    private static String tag(JsonObject input,String key){String direct=optional(input,key),metadata=optional(Json.object(input,"metadata"),key);if(direct!=null&&metadata!=null&&!direct.equals(metadata))throw error(409,"screening_source_conflict","来源分组字段存在冲突。");return direct==null?metadata:direct;}
    private static String optional(JsonObject value,String key){return !value.has(key)||value.get(key).isJsonNull()?null:text(value,key,160);}
    private static String text(JsonObject value,String key,int limit){JsonElement item=value.get(key);if(item==null||!item.isJsonPrimitive()||!item.getAsJsonPrimitive().isString()||item.getAsString().isBlank()||item.getAsString().length()>limit)throw error(400,"screening_input_invalid","字段缺失或无效："+key);return item.getAsString();}
    private static int integer(JsonObject value,String key,int min,int max){try{JsonElement item=value.get(key);if(item==null||!item.isJsonPrimitive()||!item.getAsJsonPrimitive().isNumber())throw new ArithmeticException();int n=item.getAsBigDecimal().intValueExact();if(n<min||n>max)throw new ArithmeticException();return n;}catch(Exception failure){throw error(400,"screening_parameters_invalid","整数字段无效："+key);}}
    private static double number(JsonObject value,String key,double min,double max){try{JsonElement item=value.get(key);if(item==null||!item.isJsonPrimitive()||!item.getAsJsonPrimitive().isNumber())throw new ArithmeticException();double n=item.getAsDouble();if(!Double.isFinite(n)||n<min||n>max)throw new ArithmeticException();return n;}catch(Exception failure){throw error(400,"screening_parameters_invalid","数值字段无效："+key);}}
    private static boolean bool(JsonObject value,String key,boolean fallback){if(!value.has(key))return fallback;JsonElement item=value.get(key);if(!item.isJsonPrimitive()||!item.getAsJsonPrimitive().isBoolean())throw error(400,"screening_parameters_invalid","开关字段无效："+key);return item.getAsBoolean();}
    private static void bounded(JsonElement value,int[] remaining,int depth){if(--remaining[0]<0||depth>12)throw error(413,"screening_input_invalid","固定输入元数据过大。");if(value.isJsonObject())for(var entry:value.getAsJsonObject().entrySet()){remaining[1]-=entry.getKey().length();bounded(entry.getValue(),remaining,depth+1);}else if(value.isJsonArray())for(JsonElement child:value.getAsJsonArray())bounded(child,remaining,depth+1);else if(value.isJsonPrimitive()){JsonPrimitive primitive=value.getAsJsonPrimitive();if(primitive.isString()){String text=value.getAsString();if(text.length()>32767)throw error(413,"screening_input_invalid","固定输入文本过长。");remaining[1]-=text.length();}else if(primitive.isNumber()&&!Double.isFinite(primitive.getAsDouble()))throw error(400,"screening_input_invalid","固定输入数值必须有限。");}if(remaining[1]<0)throw error(413,"screening_input_invalid","固定输入元数据文本总量过大。");}
    private static ApiError changed(String id){return error(409,"screening_content_changed","图片内容与固定特征不一致，未使用过期缓存。",Json.obj("assetId",id));}
    private static ApiError error(int status,String code,String message){return new ApiError(status,code,message);}
    private static ApiError error(int status,String code,String message,JsonObject details){return new ApiError(status,code,message,details);}
}
