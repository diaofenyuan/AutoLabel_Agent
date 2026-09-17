import { useEffect, useState } from 'react';
import { Plus, Server, RefreshCw, Save, KeyRound, CheckCircle2, Circle, ExternalLink, ChevronRight } from 'lucide-react';
import { useApp } from './context';
import { request, errorMessage, isDemo } from './bridge';
import { providerCapabilities, requiredProviderCapabilities } from '../../shared/protocol';
import { Button, Field, Modal, Notice } from './ui';
import ModelCombobox from './ModelCombobox';
import type { Provider, Preferences } from './types';
import LocalModels from './LocalModels';

interface Form {id?:string;name:string;baseUrl:string;protocol:string;model:string;concurrency:number;requestsPerMinute:number;timeoutMs:number;maxRetries:number;maxImages:number}
const empty:Form={name:'',baseUrl:'',protocol:'chat-completions',model:'',concurrency:4,requestsPerMinute:60,timeoutMs:120000,maxRetries:2,maxImages:8};
function providerForm(prefs:Preferences,provider?:Provider):Form {
  if(!provider)return {...empty,concurrency:prefs.concurrency,timeoutMs:prefs.timeout*1000,maxRetries:prefs.retries};
  // 只发送可编辑字段，避免把服务端返回的凭据状态等元数据写回严格接口。
  return {id:provider.id,name:provider.name,baseUrl:provider.baseUrl,protocol:provider.protocol,model:provider.model??'',concurrency:provider.concurrency??prefs.concurrency,requestsPerMinute:provider.requestsPerMinute??60,timeoutMs:provider.timeoutMs??prefs.timeout*1000,maxRetries:provider.maxRetries??prefs.retries,maxImages:provider.maxImages??8};
}
const capabilityNames:Record<string,string>={connection:'连接',text:'文本输入',image:'图片输入',multiImage:'多图输入',structured:'结构化输出',tools:'工具调用'};
type Test={status:string;message?:string;testedAt?:string};
/**
 * 能力清单与必需集都取自共享常量，与桌面校验、引擎支持集同源。
 * 必需四项是「这个模型能否承担对话与标注」的最低线；多图输入与工具调用按接口能力可选，
 * 一键验证同样会执行并展示结果，但不参与默认模型能否写入的判断。
 */
const capabilityOrder=providerCapabilities;
const requiredCapabilities=new Set<string>(requiredProviderCapabilities);
function describeFailures(results:Record<string,Test>,required:boolean){
  return capabilityOrder.filter(cap=>requiredCapabilities.has(cap)===required)
    .filter(cap=>results[cap]?.status!=='verified').map(cap=>capabilityNames[cap]).join('、');
}
export default function AiSettings(){
  const [kind,setKind]=useState<'api'|'local'>('api');
  const {providers,refreshProviders,prefs,savePrefs,notify}=useApp();
  const [form,setForm]=useState<Form>(()=>providerForm(prefs,providers[0]));
  const [key,setKey]=useState('');const [tests,setTests]=useState<Record<string,Test>>({});
  // 候选模型直接从接口配置里派生（引擎把「获取模型列表」的结果登记在 provider.models）。
  // 用临时 state 装列表的话，切换接口/切设置页重挂载就丢，重新进来只剩空下拉——这正是记忆丢失的根因。
  const modelNames=providers.find(provider=>provider.id===form.id)?.models??[];
  const [busy,setBusy]=useState('');const [error,setError]=useState('');const [advanced,setAdvanced]=useState(false);
  const [deletePrompt,setDeletePrompt]=useState<Provider|null>(null);
  const [headers,setHeaders]=useState(()=>JSON.stringify(providers[0]?.headers??{},null,2));const [extra,setExtra]=useState(()=>JSON.stringify(providers[0]?.extraParameters??{},null,2));
  const [roles,setRoles]=useState({chatProviderId:prefs.chatProviderId,chatModel:prefs.chatModel,annotationProviderId:prefs.annotationProviderId,annotationModel:prefs.annotationModel});
  const [credentialSaved,setCredentialSaved]=useState(false);
  const [pricing,setPricing]=useState(()=>priceForm(providers[0]));
  useEffect(()=>{let active=true;setTests({});if(form.id&&form.model)void request<{tests?:Record<string,Test>}>('provider.capabilities',{providerId:form.id,model:form.model}).then(data=>{if(active)setTests(data.tests??{});}).catch(()=>{});return()=>{active=false;};},[form.id,form.model]);
  function select(provider?:Provider){setPricing(priceForm(provider));setForm(providerForm(prefs,provider));setHeaders(JSON.stringify(provider?.headers??{},null,2));setExtra(JSON.stringify(provider?.extraParameters??{},null,2));setKey('');setTests({});setError('');setCredentialSaved(false);}
  function set<K extends keyof Form>(field:K,value:Form[K]){setForm(f=>({...f,[field]:value}));}
  async function save(event:React.FormEvent){event.preventDefault();setBusy('save');setError('');try{
    const parsedHeaders=JSON.parse(headers);const parsedExtra=JSON.parse(extra);
    if(Array.isArray(parsedHeaders)||Array.isArray(parsedExtra)||typeof parsedHeaders!=='object'||!parsedHeaders||typeof parsedExtra!=='object'||!parsedExtra)throw new Error('扩展配置必须为 JSON 对象。');
    const price=pricing.enabled?{model:pricing.model.trim(),currency:pricing.currency,...Object.fromEntries(['inputPerMillion','cachedInputPerMillion','outputPerMillion'].filter(k=>pricing[k as keyof typeof pricing]!=='').map(k=>[k,Number(pricing[k as keyof typeof pricing])]))}:null;
    if(price&&(!price.model||!/^[A-Z]{3}$/.test(price.currency)))throw new Error('费用单价需要明确的模型名称和三位币种代码。');
    const provider=await request<Provider>('provider.save',{...form,pricing:price,...(form.model?{model:form.model}:{model:undefined}),headers:parsedHeaders,extraParameters:parsedExtra});
    setForm(f=>({...f,id:provider.id}));setTests({});await refreshProviders();
    if(key){await request('credential.set',{providerId:provider.id,key});setKey('');setCredentialSaved(true);}
    notify(key?'接口与凭据已保存。':'接口配置已保存。能力状态需重新验证。');
  }catch(e){setError(errorMessage(e));}finally{setBusy('');}}
  async function listModels(){if(!form.id){setError('请先保存接口配置。');return;}setBusy('models');setError('');try{const data=await request<{models:string[]}>('provider.models',{providerId:form.id});
    // 引擎把清单登记在接口配置里；刷新后上面的派生值与本组件、对话页模型选择器都会跟着更新。
    await refreshProviders();
    notify(data.models.length?`接口返回 ${data.models.length} 个候选模型，已登记到该接口，可在对话页的模型选择器里直接选用。`:'接口没有返回任何模型，请核对地址与权限。',!data.models.length);}catch(e){setError(errorMessage(e));}finally{setBusy('');}}
  /**
   * 一键验证并设为默认模型。
   *
   * 首次配置原先是 8～10 步：保存接口 → 填测试模型 → 能力逐项点测试 → 分别选对话与标注模型。
   * 这里一次跑完全部六项能力并逐项落状态，让按钮结果与下方表格完全一致。
   * 只有必需的四项（连接 / 文本输入 / 图片输入 / 结构化输出）全部通过才写入默认模型；
   * 多图输入与工具调用失败只提示、不阻断——前者按接口能力可选，后者还取决于模型能否严格按约定调用。
   * 不在中途 return：停下会让界面停在「部分已验证」，用户仍不知道剩余项的结论，还得逐项再点一遍。
   */
  async function verifyAll(){
    if(!form.id||!form.model.trim()){setError('请先保存接口并填写用于测试的模型名称。');return;}
    setBusy('all');setError('');
    try{
      const results:Record<string,Test>={};
      for(const cap of capabilityOrder){
        const result=await request<Test>('provider.test',{providerId:form.id,model:form.model,capability:cap});
        results[cap]=result;setTests(data=>({...data,[cap]:result}));
      }
      const blocking=describeFailures(results,true);
      if(blocking){setError(`必需能力未通过：${blocking}。默认模型未改动，请修正后重试。`);return;}
      const model=form.model.trim(),optional=describeFailures(results,false);
      await savePrefs({...prefs,chatProviderId:form.id,chatModel:model,annotationProviderId:form.id,annotationModel:model});
      // roles 是独立的本地表单状态，不同步会让下方「模型职责」继续显示写入前的旧值。
      setRoles({chatProviderId:form.id,chatModel:model,annotationProviderId:form.id,annotationModel:model});
      notify(optional?`必需四项能力验证通过，已把 ${model} 设为对话与标注的默认模型。${optional}未通过，可按需单独重试。`
        :`六项能力全部验证通过，已把 ${model} 设为对话与标注的默认模型。`,Boolean(optional));
    }catch(e){setError(errorMessage(e));}finally{setBusy('');}
  }
  async function test(capability:string){if(!form.id||!form.model.trim()){setError('请先保存接口并填写用于测试的模型名称。');return;}setBusy(capability);setError('');try{const result=await request<Test>('provider.test',{providerId:form.id,model:form.model,capability});setTests(data=>({...data,[capability]:result}));notify(`${capabilityNames[capability]}：${result.status==='verified'?'验证通过':result.message||'尚未验证通过'}`,result.status!=='verified');}catch(e){setError(errorMessage(e));}finally{setBusy('');}}
  async function removeProvider(){if(!deletePrompt)return;const providerId=deletePrompt.id;setBusy('delete');setError('');try{const result=await request<{deleted:boolean;providerId:string;credentialCleared:boolean}>('provider.delete',{providerId});const next={...prefs};let changed=false;if(next.chatProviderId===providerId){next.chatProviderId='';next.chatModel='';changed=true;}if(next.annotationProviderId===providerId){next.annotationProviderId='';next.annotationModel='';changed=true;}if(changed)await savePrefs(next);await refreshProviders();select();setDeletePrompt(null);notify(result.credentialCleared?'接口已删除，关联凭据已清理。':'接口已删除。');}catch(e){setError(errorMessage(e));setDeletePrompt(null);}finally{setBusy('');}}
  return <section className="settings-section ai-settings"><div className="section-toolbar"><h2>软件 AI 配置</h2>{kind==='api'&&<Button className="primary" onClick={()=>select()}><Plus size={14}/>添加接口</Button>}</div><p className="muted">接口与凭据、本地模型，以及对话与标注各自使用的默认模型。这里的默认值是新建会话与任务的初值；会话内切换只影响该会话。</p><div className="tabs model-kind-tabs"><button disabled={Boolean(busy)} className={kind==='api'?'selected':''} onClick={()=>setKind('api')}>在线接口</button><button disabled={Boolean(busy)} className={kind==='local'?'selected':''} onClick={()=>setKind('local')}>本地模型</button></div>
    {kind==='local'?<LocalModels/>:<div className="models-layout"><aside className="provider-list"><h2>接口配置</h2>{providers.length?providers.map(provider=><button key={provider.id} className={form.id===provider.id?'selected':''} onClick={()=>select(provider)}><Server size={17}/><div><strong>{provider.name}</strong><small>{provider.protocol==='responses'?'Responses':'Chat Completions'}</small></div><ChevronRight size={13}/></button>):<div className="provider-empty"><div className="provider-empty-icon"><Server size={20}/><span/></div><strong>还没有接口</strong><p>添加一个 OpenAI 兼容接口后，可读取模型并验证能力。</p></div>}<button className="provider-add" onClick={()=>select()}><Plus size={15}/>添加接口</button></aside>
    <div className="model-content"><form onSubmit={save} className="provider-form"><h2>{form.id?'接口设置':'添加接口'}</h2><div className="field-grid"><Field label="接口名称"><input required value={form.name} onChange={e=>set('name',e.target.value)} placeholder="例如：我的 OpenAI 兼容接口"/></Field><Field label="接口协议"><select value={form.protocol} onChange={e=>set('protocol',e.target.value)}><option value="chat-completions">Chat Completions</option><option value="responses">Responses</option></select></Field></div><Field label="API 基础地址"><input type="url" required value={form.baseUrl} onChange={e=>set('baseUrl',e.target.value)} placeholder="https://api.example.com/v1" autoComplete="url"/></Field><Field label="API Key" hint={isDemo?'浏览器演示不保存或发送凭据，请在桌面版本配置。':'凭据通过桌面安全通道保存，不写入普通配置。留空保留原凭据。'}><div className="input-icon"><KeyRound size={15}/><input type="password" disabled={isDemo} autoComplete="new-password" value={key} onChange={e=>setKey(e.target.value)} placeholder={isDemo?'演示模式不可用':credentialSaved?'已安全保存，留空保留':'输入 API Key'}/></div></Field><button className="text-button advanced-toggle" type="button" onClick={()=>setAdvanced(v=>!v)}>高级请求配置（并发 / 频率 / 超时 / 重试 / 图片上限）<ChevronRight className={advanced?'rotate-90':''} size={13}/></button>{advanced&&<div className="advanced-fields"><div className="field-grid">{([['concurrency','并发上限',1,32],['requestsPerMinute','每分钟请求数',1,60000],['timeoutMs','超时（毫秒）',1000,600000],['maxRetries','最大重试数',0,6],['maxImages','单次图片上限',1,64]] as const).map(([key,label,min,max])=><Field label={label} key={key} hint={key==='maxImages'?'包括参考图片和目标图片，默认 8 张；此配置不保证服务商支持同样数量。':key==='timeoutMs'?'超过这个时间没返回就判为「结果未知」：请求可能已在服务商那边处理或计费，且不会自动重发。大图与高并发更容易触发，可适当调大。':undefined}><input aria-label={label} type="number" min={min} max={max} value={form[key]} onChange={e=>set(key,Number(e.target.value))}/></Field>)}</div><Field label="附加请求头 · JSON"><textarea className="code" rows={3} value={headers} onChange={e=>setHeaders(e.target.value)}/></Field><Field label="附加参数 · JSON"><textarea className="code" rows={3} value={extra} onChange={e=>setExtra(e.target.value)}/></Field></div>}<div className="pricing-form"><label className="checkbox-row"><input type="checkbox" checked={pricing.enabled} onChange={e=>setPricing(p=>({...p,enabled:e.target.checked}))}/>配置手动费用单价</label>{pricing.enabled&&<><p className="muted tiny">每份接口配置保存一个模型的单价。缺失单价或用量将显示未知；填写 0 表示你明确确认该项免费。旧运行使用创建时的价格快照。</p><div className="field-grid"><Field label="单价对应模型"><input aria-label="单价对应模型" value={pricing.model} onChange={e=>setPricing(p=>({...p,model:e.target.value}))}/></Field><Field label="单价币种"><input aria-label="单价币种" maxLength={3} placeholder="例如 CNY、USD" value={pricing.currency} onChange={e=>setPricing(p=>({...p,currency:e.target.value.toUpperCase()}))}/></Field>{([['inputPerMillion','输入 / 百万 token'],['cachedInputPerMillion','缓存输入 / 百万 token'],['outputPerMillion','输出 / 百万 token']] as const).map(([key,label])=><Field key={key} label={label}><input aria-label={label} type="number" min={0} max={1e9} step="any" placeholder="未配置，金额未知" value={pricing[key]} onChange={e=>setPricing(p=>({...p,[key]:e.target.value}))}/></Field>)}</div></>}</div>{error&&<p className="inline-error" role="alert">{error}</p>}<div className="actions"><Button className="primary" type="submit" busy={busy==='save'} disabled={Boolean(busy)&&busy!=='save'}><Save size={14}/>保存接口</Button>{form.id&&!isDemo&&<Button type="button" className="danger" disabled={Boolean(busy)} onClick={()=>setDeletePrompt(providers.find(provider=>provider.id===form.id)??null)}>删除接口</Button>}</div></form>
    <section className="model-section"><div className="section-toolbar"><h2>模型与能力验证</h2><Button disabled={!form.id||Boolean(busy)} onClick={()=>void listModels()}><RefreshCw size={13}/>获取模型列表</Button></div><Field label="用于测试的模型" hint="候选列表来自接口登记的模型清单，不表示账号权限或模型能力。也可以手动填写模型名称。"><ModelCombobox value={form.model} onChange={v=>set('model',v)} options={modelNames} placeholder="输入或选择模型名称"/></Field><div className="capability-table">{capabilityOrder.map(cap=>{const label=capabilityNames[cap],result=tests[cap];return <div className="capability-row" key={cap}><span>{label}</span><span className={result?.status==='verified'?'good':'muted'}>{result?.status==='verified'?<CheckCircle2 size={14}/>:<Circle size={13}/>} {result?.status==='verified'?'已验证':result?.status==='unsupported'?'不支持':'未验证'}</span><small>{result?.testedAt?new Date(result.testedAt).toLocaleString('zh-CN'):'尚无测试记录'}</small><Button busy={busy===cap} disabled={!form.id||!form.model||Boolean(busy)} onClick={()=>void test(cap)}>测试</Button></div>;})}</div><div className="actions"><Button busy={busy==='all'} disabled={!form.id||!form.model||Boolean(busy)} onClick={()=>void verifyAll()}>一键验证并设为默认模型</Button></div>
      <p className="muted tiny">一键验证会依次请求全部六项能力：连接、文本输入、图片输入、结构化输出、多图输入与工具调用。其中前四项是必需能力，全部通过后把该模型写入对话与标注的默认设置；多图输入与工具调用未通过只提示，不阻断默认模型写入。测试会向所选接口发送实际请求，并可能产生调用费用。「图片输入」与「多图输入」用的是引擎内置的 64×64 小图：验证通过只说明接口接受图片格式，<strong>不代表真实尺寸的大图不会超时</strong>。大图是否可用要结合上面「高级请求配置」里的超时设置，以及任务中心「重试未知样本」一起判断。</p></section>
    <section className="model-section"><h2>模型职责</h2><div className="role-grid">{(['chat','annotation'] as const).map(role=><div key={role}><h3>{role==='chat'?'对话模型':'标注模型'}</h3><p className="muted">{role==='chat'?'理解要求、解释规则并组织工具':'接收图片，生成可编辑的候选标注'}</p><Field label="接口"><select value={roles[`${role}ProviderId`]} onChange={e=>setRoles(r=>({...r,[`${role}ProviderId`]:e.target.value}))}><option value="">未配置</option>{providers.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></Field><Field label="模型名称"><input value={roles[`${role}Model`]} onChange={e=>setRoles(r=>({...r,[`${role}Model`]:e.target.value}))} placeholder="模型 ID"/></Field></div>)}</div><div className="actions"><Button busy={busy==='roles'} onClick={()=>{setBusy('roles');void savePrefs({...prefs,...roles}).then(()=>notify('默认模型职责已保存。')).catch(e=>notify(errorMessage(e),true)).finally(()=>setBusy(''));}}><Save size={14}/>保存模型选择</Button></div></section>
    <Notice><span>未通过工具调用验证的模型可用于普通对话。标注前，请验证图片与结构化输出能力。</span><ExternalLink size={13}/></Notice>
    </div></div>}
    {deletePrompt&&<Modal title="删除接口" onClose={()=>{if(!busy)setDeletePrompt(null);}}><div className="form-stack"><p>确定删除“{deletePrompt.name}”？</p><Notice>此操作会删除接口配置并清理桌面内存中的凭据。正在使用该接口的未结束任务会由引擎拒绝删除，已发送请求不会被伪造为成功。</Notice>{error&&<p className="inline-error" role="alert">{error}</p>}<div className="modal-actions"><Button type="button" disabled={busy==='delete'} onClick={()=>setDeletePrompt(null)}>取消</Button><Button type="button" className="danger" busy={busy==='delete'} onClick={()=>void removeProvider()}>确认删除</Button></div></div></Modal>}
  </section>;
}

function priceForm(provider?:Provider){const p=provider?.pricing;return {enabled:Boolean(p),model:p?.model??'',currency:p?.currency??'',inputPerMillion:p?.inputPerMillion?.toString()??'',cachedInputPerMillion:p?.cachedInputPerMillion?.toString()??'',outputPerMillion:p?.outputPerMillion?.toString()??''};}
