import { useState } from 'react';
import { Bell, Check, CircleHelp, Search, Settings2 } from 'lucide-react';
import { Badge, Button, Empty, Field, IconButton, InlineError, Loading, Modal, Notice, PageHeader, StatusDot, TextButton, ToastMessage } from './ui';
import './foundation-samples.css';

export default function FoundationSamples() {
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState('标准');
  const [dark, setDark] = useState(false);
  const [showDialog, setShowDialog] = useState(false);
  const [showToast, setShowToast] = useState(true);
  return <main className="foundation-samples">
    <PageHeader title="基础组件样例" description="交互控件、状态提示与页面骨架 · 仅开发模式可见" actions={
      <Button onClick={() => { const next = !dark; setDark(next); document.documentElement.dataset.theme = next ? 'dark' : 'light'; }}>{dark ? '切换浅色' : '切换深色'}</Button>
    } />
    <section className="foundation-sample-section">
      <h2>按钮与图标按钮</h2>
      <div className="foundation-sample-grid">
        <div><small>默认 / 悬停 / 焦点 / 按下</small><div className="foundation-sample-row"><Button>默认</Button><Button className="primary">主要操作</Button><IconButton label="搜索"><Search size={16}/></IconButton><TextButton>文本操作</TextButton></div></div>
        <div><small>禁用 / 加载</small><div className="foundation-sample-row"><Button disabled>不可用</Button><Button busy={busy} onClick={() => { setBusy(true); window.setTimeout(() => setBusy(false), 1200); }}>{busy ? '处理中' : '开始加载'}</Button></div></div>
        <div><small>焦点状态</small><div className="foundation-sample-row"><Button autoFocus>键盘焦点</Button><IconButton label="设置" active><Settings2 size={16}/></IconButton></div></div>
      </div>
    </section>
    <section className="foundation-sample-section">
      <h2>输入、选择与选中</h2>
      <div className="foundation-sample-fields">
        <Field label="普通输入"><input placeholder="请输入内容" /></Field>
        <Field label="错误输入" hint="地址格式不正确" hintId="foundation-url-error"><input aria-invalid="true" aria-describedby="foundation-url-error" defaultValue="不是有效地址" /></Field>
        <Field label="禁用输入"><input disabled defaultValue="正在读取配置" /></Field>
        <Field label="选项"><select defaultValue="detect"><option value="detect">目标检测</option><option value="pose">关键点</option></select></Field>
        <Field label="错误选项" hint="请选择有效类型" hintId="foundation-select-error"><select aria-invalid="true" aria-describedby="foundation-select-error" defaultValue=""><option value="" disabled>请选择</option><option value="detect">目标检测</option><option value="pose">关键点</option></select></Field>
        <Field label="禁用选择"><select disabled defaultValue="locked"><option value="locked">等待读取</option></select></Field>
      </div>
      <div className="foundation-sample-segmented">
        <div><small>选择状态</small><div className="segmented" role="group" aria-label="显示密度">{['紧凑', '标准', '宽松'].map(item => <button key={item} type="button" aria-pressed={selected === item} onClick={() => setSelected(item)}>{item}</button>)}</div></div>
        <div><small>禁用状态</small><div className="segmented" role="group" aria-label="不可用的密度选项"><button type="button" disabled>不可用</button></div></div>
      </div>
      <div className="foundation-sample-row"><Badge>普通标签</Badge><Badge tone="success"><Check size={12}/>已完成</Badge><Badge tone="warning"><Bell size={12}/>待确认</Badge><Badge tone="error">失败</Badge></div>
    </section>
    <section className="foundation-sample-section">
      <h2>状态与提示</h2>
      <div className="foundation-sample-columns">
        <Notice>这是帮助用户理解当前选项的说明。</Notice>
        <Notice tone="warning">这是需要注意但仍可继续的情况。</Notice>
        <InlineError>操作未完成，请检查输入后重试。</InlineError>
        <InlineError tone="warning" live="polite">结果需要人工核对，不会自动确认。</InlineError>
        <Loading compact label="正在读取模型列表…" />
        <div className="foundation-engine-samples"><span className="engine-chip ready"><StatusDot state="ready"/>引擎已连接</span><span className="engine-chip disconnected"><StatusDot state="disconnected"/>引擎已中断</span></div>
      </div>
      <div className="foundation-sample-row"><Button onClick={() => setShowToast(true)}>显示提示</Button></div>
    </section>
    <section className="foundation-sample-section">
      <h2>页面骨架</h2>
      <Empty icon={<CircleHelp size={23}/>} title="还没有项目" description="导入图片或载入示例，开始一段标注工作。"><Button className="primary">导入图片</Button></Empty>
      <div className="foundation-sample-row"><Button onClick={() => setShowDialog(true)}>打开对话框样例</Button></div>
    </section>
    {showDialog && <Modal title="确认操作" onClose={() => setShowDialog(false)}><div className="form-stack"><p>对话框沿用系统背景、边框、焦点和圆角令牌。</p><div className="modal-actions"><Button onClick={() => setShowDialog(false)}>取消</Button><Button className="primary" onClick={() => setShowDialog(false)}>确定</Button></div></div></Modal>}
    {showToast && <ToastMessage message="更改已保存。" action={{ label: '查看', onClick: () => setShowToast(false) }} onClose={() => setShowToast(false)} />}
  </main>;
}
