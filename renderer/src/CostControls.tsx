import { useEffect, useState } from 'react';
import { request, errorMessage } from './bridge';
import { Button, Field } from './ui';

import type { ModelPricing, BudgetCost, RequestBudget, SchemeCost } from '../../shared/budget';
import { isLocalCost } from '../../shared/budget';
export type Pricing = ModelPricing;
export type CostSummary = BudgetCost;
export type BudgetState = RequestBudget;
export const costReasons:Record<string,string>={pricing_model_mismatch:'单价对应的模型不一致',pricing_incomplete:'单价未完整配置',usage_missing:'接口未返回用量',cached_usage_missing:'未提供缓存输入用量',usage_invalid_or_incomplete:'用量缺失或无效',usage_category_unpriced:'存在未定价的用量类别'};
export function money(value:number,currency:string|null){return `${currency??'币种未定'} ${value.toLocaleString('zh-CN',{maximumFractionDigits:9})}`;}
export function CostView({cost}:{cost?:SchemeCost}){
  // 本机运行没有调用费：直接说「不产生调用费」，不要说成「金额未知」——那是两件事。
  if(isLocalCost(cost))return <div className="cost-summary local-cost"><strong>本机运行 · ¥0</strong><p>不经过任何接口，没有调用费；耗时见指标表的「成本 / 单张耗时」一行。</p></div>;
  return <div className="cost-summary">{cost?<><strong>已知金额 {money(cost.knownCost,cost.currency)}</strong><p>已计价 {cost.knownCalls} 次 · 金额未知 {cost.unknownCalls} 次 · 仍在途 {cost.inFlightCalls} 次</p><small>{cost.limit===null?'未设费用停止阈值':`已知金额停止阈值 ${money(cost.limit,cost.currency)}`}。金额依据接口报告用量与手动单价计算，服务商账单未核验。未知用量不按免费处理；在途请求可能使最终费用超过阈值。</small></>:<p className="muted">费用未记录，金额未知。</p>}</div>;
}
export function BudgetView({budget}:{budget:BudgetState}){return <><p>共享请求：已发送 {budget.requestsUsed} / {budget.maxRequests??'未设上限'} · 剩余 {budget.remaining??'未设上限'}</p><CostView cost={budget.cost}/></>;}
export function BudgetEditor({scopeId,onUpdated,currentBudget}:{scopeId:string;onUpdated?:()=>void;currentBudget?:BudgetState}){
  const [budget,setBudget]=useState<BudgetState|null>(null);const [error,setError]=useState('');const [editing,setEditing]=useState(false);const [amount,setAmount]=useState('');const [currency,setCurrency]=useState('');const [busy,setBusy]=useState(false);
  async function reload(){try{setBudget(await request('budget.get',{budgetScopeId:scopeId}));setError('');}catch(e){setError(errorMessage(e));}}
  useEffect(()=>{let live=true;setBudget(null);void request<BudgetState>('budget.get',{budgetScopeId:scopeId}).then(b=>{if(live){setBudget(b);setError('');}}).catch(e=>{if(live)setError(errorMessage(e));});return()=>{live=false;};},[scopeId]);
  useEffect(()=>{if(currentBudget)setBudget(currentBudget);},[currentBudget]);
  async function save(){setBusy(true);setError('');try{if(amount&&(!/^[A-Z]{3}$/.test(currency)||!Number.isFinite(Number(amount))||Number(amount)<=0))throw new Error('请输入三位币种代码与大于零的停止阈值，留空表示移除阈值。');await request('budget.update',{budgetScopeId:scopeId,costLimit:amount?{currency,amount:Number(amount)}:null});await reload();setEditing(false);onUpdated?.();}catch(e){setError(errorMessage(e));}finally{setBusy(false);}}
  return <section className="budget-editor">{budget&&<BudgetView budget={budget}/>}<div className="actions"><Button disabled={busy} onClick={()=>void reload()}>刷新费用</Button><Button disabled={!budget||busy} onClick={()=>{setEditing(v=>!v);setCurrency(budget?.cost?.currency??'');setAmount(budget?.cost?.limit?.toString()??'');}}>调整费用停止阈值</Button></div>{editing&&<div className="form-stack"><div className="field-grid"><Field label="币种代码"><input maxLength={3} placeholder="例如 CNY、USD" value={currency} onChange={e=>setCurrency(e.target.value.toUpperCase())}/></Field><Field label="已知金额停止阈值" hint="留空并保存会移除费用阈值；请求次数限制仍保留。"><input type="number" min={0} step="any" value={amount} onChange={e=>setAmount(e.target.value)}/></Field></div><p className="muted tiny">这里只调整共享费用阈值，不自动恢复暂停任务。费用阈值不能保证最终账单不超额。</p><div className="actions"><Button disabled={busy} onClick={()=>setEditing(false)}>取消调整</Button><Button busy={busy} onClick={()=>void save()}>保存费用阈值</Button></div></div>}{error&&<p className="inline-error" role="alert">{error}</p>}</section>;
}
