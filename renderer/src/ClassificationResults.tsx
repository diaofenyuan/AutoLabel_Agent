import { useState } from 'react';
import type { Evaluation, QualityMetrics } from '../../shared/quality';
import type { LabelClass } from './types';
import { Button } from './ui';

export default function ClassificationResults({evaluation,classes=[]}:{evaluation:Evaluation;classes?:LabelClass[]}){
  const rows=[['固定标准类别标签','totalTruthLabels'],['参与分类计算的样本','samples'],['分类正确','correct'],['分类错误','incorrect'],['成功响应但缺少分类','missingPrediction'],['分类正确 / 可计算样本','accuracy']] as const;
  return <section className="classification-results"><p className="muted tiny">正确、错类与缺分类都计入分类分母；执行失败、结果未知和无效候选单独统计。</p><div className="quality-table-scroll"><table className="quality-table"><thead><tr><th>分类指标</th>{evaluation.schemes.map(s=><th key={s.id}>{s.name}</th>)}</tr></thead><tbody>{rows.map(([label,key])=><tr key={key}><th>{label}</th>{evaluation.schemes.map(s=>{const value=key==='totalTruthLabels'?s.metrics.totalTruthLabels:s.metrics.classification?.[key];return <td key={s.id}>{value==null?key==='accuracy'&&s.metrics.notApplicableReasons?.['classification.accuracy']==='zero_denominator'?'不可用（分母为 0）':'不可用':key==='accuracy'?`${(value*100).toFixed(2)}%`:value}</td>;})}</tr>)}</tbody></table></div>
    {evaluation.schemes.map(s=><Confusion key={s.id} name={s.name} data={s.metrics.classification} classes={classes}/>)}
  </section>;
}

function Confusion({name,data,classes}:{name:string;data?:QualityMetrics['classification'];classes:LabelClass[]}){
  const [offset,setOffset]=useState(0);if(!data)return <p className="muted">{name}：分类统计不可用。</p>;
  // 仅对出现的类别建小矩阵；类别多时分页显示稀疏计数，避免合法大模板生成亿级 DOM。
  const ids=[...new Set(data.confusion.flatMap(c=>[c.truthClassId,...(c.predictionClassId?[c.predictionClassId]:[])]))];const labels=new Map(classes.map(c=>[c.id,c.name]));const label=(id:string)=>labels.get(id)??id;
  const counts=new Map(data.confusion.map(c=>[JSON.stringify([c.truthClassId,c.predictionClassId]),c.count]));const sparse=ids.length>24;
  return <div className="confusion-matrix quality-table-scroll"><h3>{name} · 分类混淆矩阵</h3><p className="muted tiny">仅列本次实际出现的类别组合，统计分母保持完整。{sparse?'类别较多，以分页计数表显示。':''}</p><table className="quality-table">{sparse?<><thead><tr><th>标准类别</th><th>模型预测</th><th>样本数</th></tr></thead><tbody>{data.confusion.slice(offset,offset+100).map((c,i)=><tr key={i}><th>{label(c.truthClassId)}</th><td>{c.predictionClassId?label(c.predictionClassId):'缺少分类'}</td><td>{c.count}</td></tr>)}</tbody></>:<><thead><tr><th>标准类别 ↓ / 模型预测 →</th>{ids.map(id=><th key={id}>{label(id)}</th>)}<th>缺少分类</th></tr></thead><tbody>{ids.map(truth=><tr key={truth}><th>{label(truth)}</th>{[...ids,null].map(pred=><td key={pred??'missing'}>{counts.get(JSON.stringify([truth,pred]))??0}</td>)}</tr>)}</tbody></>}</table>{sparse&&<div className="pagination"><Button disabled={offset===0} onClick={()=>setOffset(v=>Math.max(0,v-100))}>上一页组合</Button><span>{offset+1}–{Math.min(offset+100,data.confusion.length)} / {data.confusion.length}</span><Button disabled={offset+100>=data.confusion.length} onClick={()=>setOffset(v=>v+100)}>下一页组合</Button></div>}</div>;
}
