package cn.autolabel.engine;

import com.google.gson.*;
import java.math.BigDecimal;
import java.net.URI;
import java.sql.Connection;
import java.util.*;

final class Costs {
    static final List<String> RATES=List.of("inputPerMillion","cachedInputPerMillion","outputPerMillion");
    /** 参考单价表：由桌面启动参数下发（shared/pricing.ts 是单一来源），引擎不内置、不联网取价；查不到就保持「金额未知」，不猜价。 */
    private static volatile JsonArray referencePrices=new JsonArray();
    static void referencePricing(JsonArray rows){
        JsonArray clean=new JsonArray();
        if(rows!=null)for(JsonElement element:rows){if(clean.size()>=200)break;if(!element.isJsonObject())continue;JsonObject row=element.getAsJsonObject(),value=new JsonObject();
            String host=Json.str(row,"host","").toLowerCase(Locale.ROOT),model=Json.str(row,"model",""),currency=Json.str(row,"currency","");
            if(host.isBlank()||model.isBlank()||!currency.matches("[A-Z]{3}"))continue;
            boolean priced=false;for(String key:RATES)if(row.has(key)&&row.get(key).isJsonPrimitive()&&row.get(key).getAsJsonPrimitive().isNumber()&&row.get(key).getAsBigDecimal().signum()>=0){if(!priced){value.addProperty("host",host);value.addProperty("model",model);value.addProperty("currency",currency);priced=true;}value.add(key,row.get(key));}
            if(!priced)continue;
            value.addProperty("source",Json.str(row,"source",""));value.addProperty("priceAsOf",Json.str(row,"asOf",""));if(row.has("note"))value.addProperty("note",Json.str(row,"note",""));
            clean.add(value);}
        referencePrices=clean;
    }
    private static JsonObject referencePrice(JsonObject provider,String model){
        String host;try{String raw=URI.create(Json.required(provider,"baseUrl")).getHost();if(raw==null)return null;host=raw.toLowerCase(Locale.ROOT);}catch(Exception e){return null;}
        for(JsonElement element:referencePrices){JsonObject row=element.getAsJsonObject();if(host.equals(Json.str(row,"host",""))&&model.equals(Json.str(row,"model","")))return row;}
        return null;
    }
    static BigDecimal number(JsonObject value,String key,BigDecimal min,BigDecimal max){
        try{JsonElement item=value.get(key);if(item==null||!item.isJsonPrimitive()||!item.getAsJsonPrimitive().isNumber())throw new Exception();BigDecimal n=item.getAsBigDecimal();if(n.compareTo(min)<0||n.compareTo(max)>0)throw new Exception();return n;}catch(Exception e){throw new ApiError(400,"cost_number_invalid",key+" 必须为允许范围内的有限数值。");}
    }
    static long integer(JsonObject value,String key,long min,long max){try{return number(value,key,BigDecimal.valueOf(min),BigDecimal.valueOf(max)).longValueExact();}catch(ArithmeticException e){throw new ApiError(400,"cost_number_invalid",key+" 必须为整数。");}}
    static String currency(JsonObject value){String currency=Json.required(value,"currency");if(!currency.matches("[A-Z]{3}"))throw new ApiError(400,"pricing_currency_invalid","币种应为三位大写标识，不会自动换算币种。");return currency;}
    static JsonObject validatePrice(JsonObject value){JsonObject result=Json.obj("model",Json.required(value,"model"),"currency",currency(value));for(String key:RATES)if(value.has(key))result.addProperty(key,number(value,key,BigDecimal.ZERO,new BigDecimal("1000000000")));return result;}
    /** 计价快照：用户手填逐字段优先覆盖参考价；三项齐全即纯用户价，缺的字段才由参考价补齐（明示口径与来源）。 */
    static JsonObject snapshot(JsonObject provider,String model){
        JsonObject user=Json.object(provider,"pricing"),reference=referencePrice(provider,model),result=new JsonObject();boolean referenceUsed=false;
        if(reference!=null){result.addProperty("model",model);result.addProperty("currency",Json.str(reference,"currency",""));for(String key:RATES)if(reference.has(key))result.add(key,reference.get(key));if(reference.has("note"))result.add("priceNote",reference.get("note"));result.addProperty("priceSource",Json.str(reference,"source",""));result.addProperty("priceAsOf",Json.str(reference,"priceAsOf",""));referenceUsed=true;}
        for(var entry:user.entrySet())if(entry.getKey().equals("model")||entry.getKey().equals("currency")||RATES.contains(entry.getKey()))result.add(entry.getKey(),entry.getValue());
        boolean userComplete=user.has("model")&&Json.str(user,"model","").equals(model)&&user.has("currency")&&RATES.stream().allMatch(user::has);
        result.addProperty("providerId",Json.str(provider,"id",""));result.addProperty("providerRevision",Json.integer(provider,"revision",0));result.addProperty("priceSavedAt",Json.str(provider,"updatedAt",""));result.addProperty("requestedModel",model);
        result.addProperty("source",userComplete?"user_configured":referenceUsed?"reference":"user_configured");
        return result;
    }
    static String priceProblem(JsonObject price){if(!Json.str(price,"model","").equals(Json.str(price,"requestedModel",Json.str(price,"model",""))))return "pricing_model_mismatch";if(!price.has("currency")||RATES.stream().anyMatch(k->!price.has(k)))return "pricing_incomplete";return null;}
    /** 计价依据：参考价只用于预估（界面必须标注「参考价」，不冒充实付）。 */
    private static String basis(JsonObject price){return Json.str(price,"source","").equals("reference")?"reported_usage_reference_prices":"reported_usage_user_prices";}
    static JsonObject unknown(JsonObject price,String reason){JsonObject result=Json.obj("status","unknown","currency",price.get("currency"),"amount",null,"reason",reason,"basis",basis(price),"providerBilledAmount",null);if(price.has("priceSource"))result.add("priceSource",price.get("priceSource"));return result;}
    static JsonObject calculate(JsonObject price,JsonElement usage){
        String problem=priceProblem(price);if(problem!=null)return unknown(price,problem);if(usage==null||!usage.isJsonObject())return unknown(price,"usage_missing");JsonObject value=usage.getAsJsonObject();
        try{boolean responses=value.has("input_tokens");String inputKey=responses?"input_tokens":"prompt_tokens",outputKey=responses?"output_tokens":"completion_tokens";long input=integer(value,inputKey,0,1_000_000_000_000L),output=integer(value,outputKey,0,1_000_000_000_000L);JsonObject details=Json.object(value,responses?"input_tokens_details":"prompt_tokens_details"),out=Json.object(value,responses?"output_tokens_details":"completion_tokens_details");
            // 缓存输入属于输入总量；推理输出也包含在输出总量中，不能重复加价。未定价的额外计费类别保留未知。
            for(JsonObject part:List.of(details,out))for(String key:List.of("audio_tokens","cache_write_tokens"))if(part.has(key)&&integer(part,key,0,1_000_000_000_000L)>0)return unknown(price,"usage_category_unpriced");
            Long cached=details.has("cached_tokens")?integer(details,"cached_tokens",0,input):null;BigDecimal inputRate=price.get("inputPerMillion").getAsBigDecimal(),cacheRate=price.get("cachedInputPerMillion").getAsBigDecimal(),outputRate=price.get("outputPerMillion").getAsBigDecimal();
            if(cached==null&&inputRate.compareTo(cacheRate)!=0)return unknown(price,"cached_usage_missing");long cache=cached==null?0:cached;BigDecimal amount=inputRate.multiply(BigDecimal.valueOf(input-cache)).add(cacheRate.multiply(BigDecimal.valueOf(cache))).add(outputRate.multiply(BigDecimal.valueOf(output))).movePointLeft(6);
            JsonObject result=Json.obj("status","known","currency",price.get("currency"),"amount",amount,"basis",basis(price),"providerBilledAmount",null,"tokens",Json.obj("input",input,"cachedInput",cached,"output",output));
            if(price.has("priceSource"))result.add("priceSource",price.get("priceSource"));return result;
        }catch(Exception error){return unknown(price,"usage_invalid_or_incomplete");}
    }
    static void attach(JsonObject attempt){attempt.add("cost",calculate(Json.object(attempt,"priceSnapshot"),attempt.get("usage")));}
    static JsonObject config(Connection c,String scope)throws Exception{JsonObject row=Store.one(c,"SELECT data FROM settings WHERE id=?","cost-budget:"+scope);return row==null?new JsonObject():Json.parse(row.get("data").getAsString());}
    static void saveConfig(Connection c,String scope,JsonObject value)throws Exception{Store.update(c,"INSERT INTO settings(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data","cost-budget:"+scope,value);}
    static JsonObject view(Connection c,String scope)throws Exception{return totals(Store.rows(c,"SELECT a.status,a.data FROM attempts a LEFT JOIN runs r ON r.id=a.run_id WHERE COALESCE(json_extract(a.data,'$.budgetScopeId'),json_extract(r.data,'$.budgetScopeId'),r.id)=?",scope),config(c,scope));}
    static JsonObject runView(Connection c,String run)throws Exception{return totals(Store.rows(c,"SELECT status,data FROM attempts WHERE run_id=?",run),new JsonObject());}
    static JsonObject totals(List<JsonObject> rows,JsonObject config){
        String currency=Json.str(config,"currency",null);BigDecimal known=BigDecimal.ZERO;int unknown=0,inFlight=0,priced=0,reference=0;
        for(JsonObject row:rows){
            JsonObject attempt=Json.parse(row.get("data").getAsString()),cost=Json.object(attempt,"cost");boolean sent=Json.required(row,"status").equals("sent");if(sent)inFlight++;
            if(Json.str(cost,"status","").equals("known")){String unit=Json.str(cost,"currency",null);if(currency==null)currency=unit;if(Objects.equals(currency,unit)){known=known.add(cost.get("amount").getAsBigDecimal());priced++;if(Json.str(cost,"basis","").equals("reported_usage_reference_prices"))reference++;}else unknown++;}else if(!sent)unknown++;
        }
        return Json.obj("currency",currency,"knownCost",known,"knownCalls",priced,"unknownCalls",unknown,"inFlightCalls",inFlight,"limit",config.get("limit"),"control","observed_cost_stop","hardLimit",false,"basis",reference>0&&reference==priced?"reported_usage_reference_prices":"reported_usage_user_prices","referenceCalls",reference,"providerBilledAmount",null);
    }
    static void update(Connection c,String scope,JsonElement limit)throws Exception{JsonObject config=config(c,scope);if(limit==null||limit.isJsonNull()){config.remove("limit");}else{
            if(!limit.isJsonObject())throw new ApiError(400,"cost_limit_invalid","费用阈值必须包含币种与金额。");JsonObject value=limit.getAsJsonObject();String currency=currency(value);BigDecimal amount=number(value,"amount",BigDecimal.ZERO,new BigDecimal("1000000000000"));if(amount.signum()==0)throw new ApiError(400,"cost_limit_invalid","费用阈值必须大于零。");String old=Json.str(view(c,scope),"currency",null);if(old!=null&&!old.equals(currency))throw new ApiError(409,"budget_currency_mismatch","同一预算不能混用币种，请使用新的预算范围。");config.addProperty("currency",currency);config.addProperty("limit",amount);
        }saveConfig(c,scope,config);Store.event(c,"budget.cost_updated",null,null,null,Json.obj("budgetScopeId",scope,"costLimit",limit,"hardLimit",false));}
    static String blockReason(Connection c,String scope,JsonObject price)throws Exception{JsonObject config=config(c,scope),view=view(c,scope);String currency=Json.str(price,"currency",null),stored=Json.str(view,"currency",null);if(currency!=null&&stored!=null&&!currency.equals(stored))return "budget_currency_mismatch";
        if(!config.has("limit"))return null;if(priceProblem(price)!=null)return "budget_pricing_unknown";if(Json.integer(view,"unknownCalls",0)>0)return "budget_cost_unknown";if(view.get("knownCost").getAsBigDecimal().compareTo(config.get("limit").getAsBigDecimal())>=0)return "budget_cost_exhausted";return null;}
    static void reserve(Connection c,String scope,JsonObject price)throws Exception{String reason=blockReason(c,scope,price);if(reason!=null)throw new ApiError(409,reason,switch(reason){
            case "budget_pricing_unknown"->"未手填单价且该模型查不到参考价：请在「在线接口」手填单价，或移除费用阈值后继续。";
            case "budget_cost_unknown"->"已有调用的用量未知、无法核账：请在费用明细核对后重试，或移除费用阈值继续。";
            case "budget_cost_exhausted"->"已知金额已达费用阈值：请调高或移除费用阈值后再继续。";
            case "budget_currency_mismatch"->"同一预算不能混用币种，请使用新的预算范围。";
            default->"费用预算暂不允许继续发送：请检查单价、未知用量、币种或费用阈值。";});String currency=Json.str(price,"currency",null);if(currency!=null){JsonObject config=config(c,scope);if(!config.has("currency")){config.addProperty("currency",currency);saveConfig(c,scope,config);}}}
    /** 历史实际用量均值（同接口同模型最近 20 次已完成调用），用于自动填 token 假设；不改用户显式给定的任何项。 */
    private static JsonObject usageAverage(Connection c,String providerId,String model)throws Exception{
        long input=0,output=0;int samples=0;
        for(JsonObject row:Store.rows(c,"SELECT data FROM attempts WHERE status='completed' AND json_extract(data,'$.providerId')=? AND json_extract(data,'$.model')=? ORDER BY rowid DESC LIMIT 20",providerId,model)){
            JsonObject usage=Json.object(Json.parse(row.get("data").getAsString()),"usage");if(usage.entrySet().isEmpty())continue;
            boolean responses=usage.has("input_tokens");String inputKey=responses?"input_tokens":"prompt_tokens",outputKey=responses?"output_tokens":"completion_tokens";
            if(!usage.has(inputKey)||!usage.has(outputKey))continue;
            try{input+=integer(usage,inputKey,0,1_000_000_000_000L);output+=integer(usage,outputKey,0,1_000_000_000_000L);samples++;}catch(Exception ignored){}
        }
        return samples==0?null:Json.obj("input",input/samples,"output",output/samples,"samples",samples);
    }
    /** token 假设：用户没给的项按历史实际用量均值自动填（可改）；缓存项永不自动填——省略不等于按零计。 */
    static JsonObject estimate(Connection c,JsonObject provider,JsonObject p)throws Exception{
        long requests=integer(p,"requests",1,1_000_000);
        Long input=p.has("inputTokensPerRequest")?integer(p,"inputTokensPerRequest",0,1_000_000_000):null,output=p.has("outputTokensPerRequest")?integer(p,"outputTokensPerRequest",0,1_000_000_000):null;
        Long cached=p.has("cachedInputTokensPerRequest")?integer(p,"cachedInputTokensPerRequest",0,input==null?1_000_000_000:input):null;
        boolean auto=false;int samples=0;
        if(input==null||output==null){JsonObject history=usageAverage(c,Json.str(provider,"id",""),Json.required(p,"model"));if(history!=null){samples=Json.integer(history,"samples",0);if(input==null)input=Json.number(history,"input",0);if(output==null)output=Json.number(history,"output",0);auto=true;}}
        String source=auto?"historical_usage_average":"explicit_token_assumptions";
        JsonObject assumptions=Json.obj("inputTokensPerRequest",input,"cachedInputTokensPerRequest",cached,"outputTokensPerRequest",output),price=snapshot(provider,Json.required(p,"model"));
        if(input==null||output==null)return Json.obj("source",source,"requests",requests,"assumptions",assumptions,"historySamples",samples,"priceSnapshot",price,"currency",price.get("currency"),"estimatedCost",JsonNull.INSTANCE,"reason","token_assumptions_missing","hardLimit",false);
        JsonObject details=new JsonObject();if(cached!=null)details.addProperty("cached_tokens",cached);
        JsonObject cost=calculate(price,Json.obj("input_tokens",input,"output_tokens",output,"input_tokens_details",details));
        return Json.obj("source",source,"requests",requests,"assumptions",assumptions,"historySamples",samples,"priceSnapshot",price,"currency",cost.get("currency"),"estimatedCost",Json.str(cost,"status","").equals("known")?cost.get("amount").getAsBigDecimal().multiply(BigDecimal.valueOf(requests)):null,"reason",cost.get("reason"),"hardLimit",false);
    }
}
