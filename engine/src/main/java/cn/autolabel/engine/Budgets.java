package cn.autolabel.engine;

import com.google.gson.JsonObject;
import java.sql.Connection;

final class Budgets {
    static String scope(JsonObject payload,String fallback){return Json.str(payload,"budgetScopeId",Json.str(payload,"sessionId",fallback));}
    static void ensure(Connection c,String id,long max,boolean update)throws Exception{
        if(max<1)throw new ApiError(400,"budget_invalid","请求上限至少为 1。");
        JsonObject existing=Store.one(c,"SELECT * FROM budgets WHERE id=?",id);
        if(existing==null)Store.update(c,"INSERT INTO budgets(id,max_requests,used) VALUES(?,?,0)",id,max);
        else if(max!=Long.MAX_VALUE&&(update||Json.number(existing,"max_requests",Long.MAX_VALUE)==Long.MAX_VALUE)){
            Store.update(c,"UPDATE budgets SET max_requests=? WHERE id=?",max,id);
            Store.event(c,"budget.updated",null,null,null,Json.obj("budgetScopeId",id,"maxRequests",max,"requestsUsed",existing.get("used")));
        }else if(max!=Long.MAX_VALUE&&max!=Json.number(existing,"max_requests",Long.MAX_VALUE))throw new ApiError(409,"budget_scope_conflict","共享预算上限与已有会话不同，请在预算控制中明确调整。");
    }
    static long reserve(Connection c,String id)throws Exception{
        JsonObject budget=Store.one(c,"SELECT * FROM budgets WHERE id=?",id);if(budget==null)throw new ApiError(409,"budget_scope_missing","共享预算记录不存在。");
        long used=Json.number(budget,"used",0),max=Json.number(budget,"max_requests",Long.MAX_VALUE);
        if(used>=max)throw new ApiError(409,"budget_exhausted","共享请求预算已用尽，请调整上限后恢复。");
        Store.update(c,"UPDATE budgets SET used=used+1 WHERE id=?",id);return used+1;
    }
    static boolean exhausted(Connection c,String id)throws Exception{JsonObject b=Store.one(c,"SELECT * FROM budgets WHERE id=?",id);return b!=null&&Json.number(b,"used",0)>=Json.number(b,"max_requests",Long.MAX_VALUE);}
    static JsonObject view(Connection c,String id)throws Exception{JsonObject b=Store.one(c,"SELECT * FROM budgets WHERE id=?",id);if(b==null)throw new ApiError(404,"budget_scope_missing","共享预算不存在。");long max=Json.number(b,"max_requests",Long.MAX_VALUE),used=Json.number(b,"used",0);return Json.obj("budgetScopeId",id,"requestsUsed",used,"maxRequests",max==Long.MAX_VALUE?null:max,"remaining",max==Long.MAX_VALUE?null:Math.max(0,max-used),"cost",Costs.view(c,id));}
}
