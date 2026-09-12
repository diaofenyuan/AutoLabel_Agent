package cn.autolabel.engine;

import com.google.gson.*;
import java.math.BigDecimal;
import java.sql.Connection;
import java.util.*;

final class Costs {
    static final List<String> RATES=List.of("inputPerMillion","cachedInputPerMillion","outputPerMillion");
    static BigDecimal number(JsonObject value,String key,BigDecimal min,BigDecimal max){
        try{JsonElement item=value.get(key);if(item==null||!item.isJsonPrimitive()||!item.getAsJsonPrimitive().isNumber())throw new Exception();BigDecimal n=item.getAsBigDecimal();if(n.compareTo(min)<0||n.compareTo(max)>0)throw new Exception();return n;}catch(Exception e){throw new ApiError(400,"cost_number_invalid",key+" 必须为允许范围内的有限数值。");}
    }
    static long integer(JsonObject value,String key,long min,long max){try{return number(value,key,BigDecimal.valueOf(min),BigDecimal.valueOf(max)).longValueExact();}catch(ArithmeticException e){throw new ApiError(400,"cost_number_invalid",key+" 必须为整数。");}}
    static String currency(JsonObject value){String currency=Json.required(value,"currency");if(!currency.matches("[A-Z]{3}"))throw new ApiError(400,"pricing_currency_invalid","币种应为三位大写标识，不会自动换算币种。");return currency;}
    static JsonObject validatePrice(JsonObject value){JsonObject result=Json.obj("model",Json.required(value,"model"),"currency",currency(value));for(String key:RATES)if(value.has(key))result.addProperty(key,number(value,key,BigDecimal.ZERO,new BigDecimal("1000000000")));return result;}
    static JsonObject snapshot(JsonObject provider,String model){JsonObject result=Json.object(provider,"pricing").deepCopy();result.addProperty("providerId",Json.str(provider,"id",""));result.addProperty("providerRevision",Json.integer(provider,"revision",0));result.addProperty("priceSavedAt",Json.str(provider,"updatedAt",""));result.addProperty("requestedModel",model);result.addProperty("source","user_configured");return result;}
    static String priceProblem(JsonObject price){if(!Json.str(price,"model","").equals(Json.str(price,"requestedModel",Json.str(price,"model",""))))return "pricing_model_mismatch";if(!price.has("currency")||RATES.stream().anyMatch(k->!price.has(k)))return "pricing_incomplete";return null;}
    static JsonObject unknown(JsonObject price,String reason){return Json.obj("status","unknown","currency",price.get("currency"),"amount",null,"reason",reason,"basis","reported_usage_user_prices","providerBilledAmount",null);}
    static JsonObject calculate(JsonObject price,JsonElement usage){
        String problem=priceProblem(price);if(problem!=null)return unknown(price,problem);if(usage==null||!usage.isJsonObject())return unknown(price,"usage_missing");JsonObject value=usage.getAsJsonObject();
        try{boolean responses=value.has("input_tokens");String inputKey=responses?"input_tokens":"prompt_tokens",outputKey=responses?"output_tokens":"completion_tokens";long input=integer(value,inputKey,0,1_000_000_000_000L),output=integer(value,outputKey,0,1_000_000_000_000L);JsonObject details=Json.object(value,responses?"input_tokens_details":"prompt_tokens_details"),out=Json.object(value,responses?"output_tokens_details":"completion_tokens_details");
            // 缓存输入属于输入总量；推理输出也包含在输出总量中，不能重复加价。未定价的额外计费类别保留未知。
            for(JsonObject part:List.of(details,out))for(String key:List.of("audio_tokens","cache_write_tokens"))if(part.has(key)&&integer(part,key,0,1_000_000_000_000L)>0)return unknown(price,"usage_category_unpriced");
            Long cached=details.has("cached_tokens")?integer(details,"cached_tokens",0,input):null;BigDecimal inputRate=price.get("inputPerMillion").getAsBigDecimal(),cacheRate=price.get("cachedInputPerMillion").getAsBigDecimal(),outputRate=price.get("outputPerMillion").getAsBigDecimal();
            if(cached==null&&inputRate.compareTo(cacheRate)!=0)return unknown(price,"cached_usage_missing");long cache=cached==null?0:cached;BigDecimal amount=inputRate.multiply(BigDecimal.valueOf(input-cache)).add(cacheRate.multiply(BigDecimal.valueOf(cache))).add(outputRate.multiply(BigDecimal.valueOf(output))).movePointLeft(6);
            return Json.obj("status","known","currency",price.get("currency"),"amount",amount,"basis","reported_usage_user_prices","providerBilledAmount",null,"tokens",Json.obj("input",input,"cachedInput",cached,"output",output));
        }catch(Exception error){return unknown(price,"usage_invalid_or_incomplete");}
    }
    static void attach(JsonObject attempt){attempt.add("cost",calculate(Json.object(attempt,"priceSnapshot"),attempt.get("usage")));}
    static JsonObject config(Connection c,String scope)throws Exception{JsonObject row=Store.one(c,"SELECT data FROM settings WHERE id=?","cost-budget:"+scope);return row==null?new JsonObject():Json.parse(row.get("data").getAsString());}
    static void saveConfig(Connection c,String scope,JsonObject value)throws Exception{Store.update(c,"INSERT INTO settings(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data","cost-budget:"+scope,value);}
    static JsonObject view(Connection c,String scope)throws Exception{return totals(Store.rows(c,"SELECT a.status,a.data FROM attempts a LEFT JOIN runs r ON r.id=a.run_id WHERE COALESCE(json_extract(a.data,'$.budgetScopeId'),json_extract(r.data,'$.budgetScopeId'),r.id)=?",scope),config(c,scope));}
    static JsonObject runView(Connection c,String run)throws Exception{return totals(Store.rows(c,"SELECT status,data FROM attempts WHERE run_id=?",run),new JsonObject());}
    static JsonObject totals(List<JsonObject> rows,JsonObject config){
        String currency=Json.str(config,"currency",null);BigDecimal known=BigDecimal.ZERO;int unknown=0,inFlight=0,priced=0;
        for(JsonObject row:rows){
            JsonObject attempt=Json.parse(row.get("data").getAsString()),cost=Json.object(attempt,"cost");boolean sent=Json.required(row,"status").equals("sent");if(sent)inFlight++;
            if(Json.str(cost,"status","").equals("known")){String unit=Json.str(cost,"currency",null);if(currency==null)currency=unit;if(Objects.equals(currency,unit)){known=known.add(cost.get("amount").getAsBigDecimal());priced++;}else unknown++;}else if(!sent)unknown++;
        }
        return Json.obj("currency",currency,"knownCost",known,"knownCalls",priced,"unknownCalls",unknown,"inFlightCalls",inFlight,"limit",config.get("limit"),"control","observed_cost_stop","hardLimit",false,"basis","reported_usage_user_prices","providerBilledAmount",null);
    }
    static void update(Connection c,String scope,JsonElement limit)throws Exception{JsonObject config=config(c,scope);if(limit==null||limit.isJsonNull()){config.remove("limit");}else{
            if(!limit.isJsonObject())throw new ApiError(400,"cost_limit_invalid","费用阈值必须包含币种与金额。");JsonObject value=limit.getAsJsonObject();String currency=currency(value);BigDecimal amount=number(value,"amount",BigDecimal.ZERO,new BigDecimal("1000000000000"));if(amount.signum()==0)throw new ApiError(400,"cost_limit_invalid","费用阈值必须大于零。");String old=Json.str(view(c,scope),"currency",null);if(old!=null&&!old.equals(currency))throw new ApiError(409,"budget_currency_mismatch","同一预算不能混用币种，请使用新的预算范围。");config.addProperty("currency",currency);config.addProperty("limit",amount);
        }saveConfig(c,scope,config);Store.event(c,"budget.cost_updated",null,null,null,Json.obj("budgetScopeId",scope,"costLimit",limit,"hardLimit",false));}
    static String blockReason(Connection c,String scope,JsonObject price)throws Exception{JsonObject config=config(c,scope),view=view(c,scope);String currency=Json.str(price,"currency",null),stored=Json.str(view,"currency",null);if(currency!=null&&stored!=null&&!currency.equals(stored))return "budget_currency_mismatch";
        if(!config.has("limit"))return null;if(priceProblem(price)!=null)return "budget_pricing_unknown";if(Json.integer(view,"unknownCalls",0)>0)return "budget_cost_unknown";if(view.get("knownCost").getAsBigDecimal().compareTo(config.get("limit").getAsBigDecimal())>=0)return "budget_cost_exhausted";return null;}
    static void reserve(Connection c,String scope,JsonObject price)throws Exception{String reason=blockReason(c,scope,price);if(reason!=null)throw new ApiError(409,reason,"费用预算暂不允许继续发送：请检查单价、未知用量、币种或费用阈值。");String currency=Json.str(price,"currency",null);if(currency!=null){JsonObject config=config(c,scope);if(!config.has("currency")){config.addProperty("currency",currency);saveConfig(c,scope,config);}}}
    static JsonObject estimate(JsonObject provider,JsonObject p){long requests=integer(p,"requests",1,1_000_000),input=integer(p,"inputTokensPerRequest",0,1_000_000_000),output=integer(p,"outputTokensPerRequest",0,1_000_000_000);Long cached=p.has("cachedInputTokensPerRequest")?integer(p,"cachedInputTokensPerRequest",0,input):null;JsonObject details=new JsonObject();if(cached!=null)details.addProperty("cached_tokens",cached);JsonObject price=snapshot(provider,Json.required(p,"model")),cost=calculate(price,Json.obj("input_tokens",input,"output_tokens",output,"input_tokens_details",details));return Json.obj("source","explicit_token_assumptions","requests",requests,"assumptions",Json.obj("inputTokensPerRequest",input,"cachedInputTokensPerRequest",cached,"outputTokensPerRequest",output),"priceSnapshot",price,"currency",cost.get("currency"),"estimatedCost",Json.str(cost,"status","").equals("known")?cost.get("amount").getAsBigDecimal().multiply(BigDecimal.valueOf(requests)):null,"reason",cost.get("reason"),"hardLimit",false);}
}
