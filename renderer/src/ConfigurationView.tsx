import type { ResolvedConfiguration } from '../../shared/configuration';
import type { Provider } from './types';

export const configurationSource=(source?:string)=>({global:'全局默认',project:'项目设置',step:'当前步骤'} as Record<string,string>)[source??'']??'未设置';
export default function ConfigurationView({value,providers,compact=false,onConfigure}:{value:ResolvedConfiguration;providers:Provider[];compact?:boolean;onConfigure?:()=>void}){
  const providerName=providers.find(p=>p.id===value.providerId)?.name??value.providerId??'未配置';
  if(compact){
    const ready=Boolean(value.providerId&&value.model&&!value.issues.length);
    return <div className={`configuration-view muted tiny compact ${ready?'ready':'needs-action'}`} role="status" aria-live="polite"><span className="configuration-dot" aria-hidden="true"/><span className="configuration-main">{ready?`当前模型：${value.model}`:'尚未配置对话模型'}</span><span className="configuration-provider">{ready?providerName:'需要选择接口和模型'}</span>{value.issues.slice(0,1).map((issue,i)=><span className="configuration-issue inline-error" key={i}>{issue.message}</span>)}{onConfigure&&<button className="text-button configuration-action" type="button" onClick={onConfigure}>{ready?'调整配置':'去配置'}</button>}</div>;
  }
  return <div className="configuration-view muted tiny"><span>实际接口：{providerName}（{configurationSource(value.sources.providerId)}）</span><span>模型：{value.model??'未配置'}（{configurationSource(value.sources.model)}）</span><span>标注规则：{value.prompt?'已设置':'未设置'}（{configurationSource(value.sources.prompt)}）</span><span>并发：{value.concurrency??'接口默认'}（{configurationSource(value.sources.concurrency)}）</span><span>请求上限：{value.maxRequests??'未设置'}（{configurationSource(value.sources.maxRequests)}）</span>{value.issues.map((issue,i)=><span className="inline-error" key={i}>{issue.message}</span>)}</div>;
}
