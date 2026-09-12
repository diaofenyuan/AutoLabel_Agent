import type { ResolvedConfiguration } from '../../shared/configuration';
import type { Provider } from './types';

export const configurationSource=(source?:string)=>({global:'全局默认',project:'项目设置',step:'当前步骤'} as Record<string,string>)[source??'']??'未设置';
export default function ConfigurationView({value,providers,compact=false}:{value:ResolvedConfiguration;providers:Provider[];compact?:boolean}){
  return <div className={`configuration-view muted tiny ${compact?'compact':''}`}><span>实际接口：{providers.find(p=>p.id===value.providerId)?.name??value.providerId??'未配置'}（{configurationSource(value.sources.providerId)}）</span><span>模型：{value.model??'未配置'}（{configurationSource(value.sources.model)}）</span>{!compact&&<><span>标注规则：{value.prompt?'已设置':'未设置'}（{configurationSource(value.sources.prompt)}）</span><span>并发：{value.concurrency??'接口默认'}（{configurationSource(value.sources.concurrency)}）</span><span>请求上限：{value.maxRequests??'未设置'}（{configurationSource(value.sources.maxRequests)}）</span></>}{value.issues.map((issue,i)=><span className="inline-error" key={i}>{issue.message}</span>)}</div>;
}
