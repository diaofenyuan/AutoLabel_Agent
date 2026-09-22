import type { BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gotoWelcome, openFirstAssetCanvas, openProjectChat, openSelectedProjectOverview } from './desktop-navigation';

/**
 * 直达标注验收：不依赖对话模型也能开始标注。
 *
 * 背景：对话里的一切操作都要求一个「能调工具的对话模型」，没配或模型不支持工具调用时，
 * 连「用内置模型标注（无需 API Key）」都走不通——发送直接被拦截。本次验收断言：
 * 1. 没有配置对话模型时，发送仍被明确拦下（原路径没被放宽）；
 * 2. 输入卡的「开始标注」能直接用**标注模型**建任务，全程不经过对话；
 * 3. 结果落成候选（candidate），人工已确认的内容不受影响；
 * 4. 项目没有类别时，弹层给出原因并禁用开始按钮，而不是让用户点了才发现。
 * 5. 画布精修可用：方向键 1px / Shift 10px 微调、滚轮缩放、中键拖拽平移。
 * 6. 结果筛选芯片（全部/有候选/无目标/失败/已确认/未处理）计数与网格一致，筛选态下全选只选筛选结果。
 *
 * 夹具是一个回环服务商：只回一份合法标注 JSON，classId 用项目里真实存在的类别。
 */
export async function checkDesktopDirectRun(window: BrowserWindow, output: string): Promise<void> {
  let calls = 0;
  // 夹具累计记下每次请求里带的参考帧：参考必须真的作为 role=reference 的示例发出去，而不是被悄悄丢掉。
  const seenReferences: Array<{ assetId?: string; objects: number }> = [];
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const part of request) raw += part;
    calls++;
    const body = raw ? JSON.parse(raw) : {};
    let assetId: string | undefined;
    for (const message of body.messages ?? []) {
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (part?.type !== 'text') continue;
        try {
          const parsed = JSON.parse(part.text);
          if (parsed?.role === 'target') assetId = parsed.assetId;
          if (parsed?.role === 'reference') seenReferences.push({ assetId: parsed.assetId, objects: Array.isArray(parsed.annotations) ? parsed.annotations.length : 0 });
        } catch { /* 非 JSON 的文本段忽略 */ }
      }
    }
    const content = JSON.stringify({ assetId, annotations: [{ id: 'direct-run-fixture', classId: 'vehicle', type: 'detect', bbox: { x: 221, y: 483, width: 537, height: 350 } }] });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const userData = process.env.AUTOLABEL_TEST_USER_DATA!;
  assert.ok(userData, '直达标注验收需要隔离的 AUTOLABEL_TEST_USER_DATA');
  const fixtures = path.join(userData, 'fixtures', `direct-${Date.now()}`);
  await mkdir(fixtures, { recursive: true });
  const checks: Record<string, unknown>[] = [];
  const js = <T = unknown>(code: string): Promise<T> => window.webContents.executeJavaScript(code);
  const json = JSON.stringify;
  const api = <T = any>(command: string, payload: Record<string, unknown> = {}): Promise<T> => js<T>(`window.autoLabel.request(${json(command)},${json(payload)})`);
  async function waitFor(expression: string, timeout = 25000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await js<boolean>(`(async()=>{try{return !!(await (${expression}))}catch(e){return false}})()`)) return;
      await new Promise(resolve => setTimeout(resolve, 60));
    }
    throw new Error(`等待界面超时：${expression}`);
  }
  async function button(text: string, scope = 'document') {
    await waitFor(`[...${scope}.querySelectorAll('button')].some(b=>b.innerText.trim()===${json(text)}&&!b.disabled)`);
    await js(`([...${scope}.querySelectorAll('button')].find(b=>b.innerText.trim()===${json(text)})).click()`);
  }
  const runStatus = async (runId: string, states: string[]) => {
    await waitFor(`window.autoLabel.request('run.get',{runId:${json(runId)}}).then(r=>${json(states)}.includes(r.status))`, 40000);
    return api<any>('run.get', { runId });
  };
  try {
    window.show();
    await waitFor(`!!document.querySelector('.onboarding-lanes')&&!document.querySelector('.connection-banner')`);

    // ===== 先配好「标注模型」，但**不配对话模型** =====
    const address = server.address() as { port: number };
    const provider = await api<{ id: string }>('provider.save', {
      name: `直达标注夹具-${Date.now()}`, baseUrl: `http://127.0.0.1:${address.port}/v1`,
      protocol: 'chat-completions', timeoutMs: 20000, maxRetries: 0,
    });
    await api('credential.set', { providerId: provider.id, key: 'isolated-direct-run' });
    const settings = await api<Record<string, unknown>>('settings.get');
    await api('settings.save', { settings: { ...settings, annotationProviderId: provider.id, annotationModel: 'fixture-direct', chatProviderId: '', chatModel: '' } });
    // 偏好是开机读入的：改完设置要重新载入界面，才能拿到新的标注模型。
    window.webContents.reload();
    await new Promise(resolve => setTimeout(resolve, 1500));
    await waitFor(`!!document.querySelector('.onboarding-lanes')&&!document.querySelector('.connection-banner')`);
    const reloaded = await api<Record<string, unknown>>('settings.get');
    assert.equal(reloaded.chatProviderId, '', '本次验收必须保持未配置对话模型');

    // ===== 载入示例项目：没有对话模型，发送仍然被拦 =====
    await js(`([...document.querySelectorAll('.onboarding-lane button')].find(node=>node.innerText.trim()==='载入示例项目')).click()`);
    await waitFor(`!!document.querySelector('.chat-panel textarea')`);
    await js(`(()=>{const e=document.querySelector('.chat-panel textarea');e.focus();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'帮我把这些图标注一下');
      e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    // 等输入真的进了 React 状态、发送键变为可用再点，避免点了禁用按钮什么都不发生。
    await waitFor(`document.querySelector('.chat-panel textarea').value.length>0`);
    await waitFor(`!document.querySelector('.chat-panel .send-button').disabled`);
    await new Promise(resolve => setTimeout(resolve, 200));
    await js(`document.querySelector('.chat-panel .send-button').click()`);
    await waitFor(`[...document.querySelectorAll('.toast')].some(node=>node.innerText.includes('对话'))`, 20000);
    const sendBlocked = await js<string>(`[...document.querySelectorAll('.toast')].map(node=>node.innerText).join(' | ')`);
    assert.ok(sendBlocked.includes('对话'), `没有对话模型时发送应被明确拦下，实际提示：${sendBlocked}`);
    checks.push({ check: 'direct-run-chat-still-blocked', toast: sendBlocked.replace(/\s+/g, ' ') });

    // ===== 直达标注：用标注模型直接建任务，不经过对话 =====
    const before = calls;
    await js(`document.querySelector('.chat-panel .direct-run-trigger').click()`);
    await waitFor(`!!document.querySelector('.direct-run .picker-popover')`);
    const panel = await js<{ text: string; startDisabled: boolean }>(`(()=>{const p=document.querySelector('.direct-run .picker-popover');
      const start=[...p.querySelectorAll('button')].find(b=>b.innerText.trim()==='开始标注');
      return { text: p.innerText.replace(/\\s+/g,' ').slice(0,240), startDisabled: Boolean(start?.disabled) };})()`);
    assert.ok(panel.text.includes('fixture-direct'), `弹层应显示当前标注模型，实际：${panel.text}`);
    assert.equal(panel.startDisabled, false, '前置齐全时开始按钮应可用');
    await button('开始标注', `document.querySelector('.direct-run .picker-popover')`);
    await waitFor(`!document.querySelector('.direct-run .picker-popover')`);
    // 运行必须有真实请求发生：夹具服务只回合法 JSON，不依赖调度时机。
    try {
      await waitFor(`window.autoLabel.request('run.list',{}).then(list=>list.some(run=>run.model==='fixture-direct'))`, 20000);
    } catch {
      const diagnostic = await js<{ popover: string; toast: string; runs: unknown }>(`(async()=>({popover:document.querySelector('.direct-run .picker-popover')?.innerText??'(弹层已关闭)',
        toast:[...document.querySelectorAll('.toast')].map(node=>node.innerText).join(' | '), runs: await window.autoLabel.request('run.list',{})}))()`);
      throw new Error(`直达标注没有创建运行：${json(diagnostic)}`);
    }
    const runs = await api<Array<{ id: string; model: string; status: string }>>('run.list', {});
    const direct = runs.find(item => item.model === 'fixture-direct');
    assert.ok(direct, `应创建使用标注模型的运行，实际：${json(runs.map(item => item.model))}`);
    const settled = await runStatus(direct!.id, ['completed', 'completed_with_errors', 'needs_attention', 'cancelled']);
    assert.equal(settled.statistics.succeeded, 1, `直达标注应成功一张，实际：${json(settled.statistics)}`);
    assert.ok(calls > before, '夹具服务应收到真实请求');
    const projectId = (await api<Array<{ id: string }>>('project.list', {}))[0].id;
    const assets = await api<{ items: Array<{ id: string; status: string; annotations?: unknown[] }> }>('asset.list', { projectId, limit: 100 });
    const history = await api<Array<{ version: number; source: string }>>('annotation.history', { assetId: assets.items[0].id });
    // 示例素材自带预置人工标注：结果只能作为候选版本存在，人工内容不能被覆盖。
    assert.ok(history.some(item => item.source === 'api'), `应写入候选版本，实际版本来源：${json(history.map(item => item.source))}`);
    assert.ok((assets.items[0].annotations?.length ?? 0) >= 2, `人工预置标注不应被覆盖，实际：${json(assets.items[0].annotations?.length)}`);
    checks.push({ check: 'direct-run-creates-run-without-chat', runId: direct!.id, model: direct!.model, status: settled.status,
      versionSources: history.map(item => item.source), humanAnnotations: assets.items[0].annotations?.length ?? 0 });

    // ===== 发送副本：默认长边 1920，「原图」能明确关掉；实发尺寸与体积记在运行上 =====
    const defaultRecipe = (await api<{ payload?: { maxEdge?: number | null } }>('run.get', { runId: direct!.id })).payload?.maxEdge ?? null;
    assert.equal(defaultRecipe, 1920, `默认应按长边 1920 生成发送副本，实际：${defaultRecipe}`);
    // 建完任务会落到任务中心；后面的操作都在会话输入卡上，先按项目名回到会话。
    const projectName = (await api<Array<{ id: string; name: string }>>('project.list', {})).find(item => item.id === projectId)?.name;
    assert.ok(projectName, '应能读到项目名');
    const driver = { js, wait: waitFor };
    await openProjectChat(driver, projectName!);
    await js(`document.querySelector('.chat-panel .direct-run-trigger').click()`);
    await waitFor(`!!document.querySelector('.direct-run .picker-popover')`);
    await js(`([...document.querySelectorAll('.direct-run .picker-popover button')].find(node=>node.innerText.trim().startsWith('原图'))).click()`);
    await button('开始标注', `document.querySelector('.direct-run .picker-popover')`);
    await waitFor(`window.autoLabel.request('run.list',{}).then(list=>list.some(run=>run.model==='fixture-direct'&&run.payloadActual&&run.payloadActual.derived===false))`, 20000);
    const plainRuns = await api<Array<{ id: string; payloadActual?: { derived?: boolean; width?: number; bytes?: number; sourceBytes?: number } }>>('run.list', {});
    const plain = plainRuns.find(item => item.payloadActual && item.payloadActual.derived === false);
    assert.ok(plain, `「原图」必须真的按原图发送，实际：${json(plainRuns.map(item => item.payloadActual))}`);
    const baselineWidth = (await api<{ width?: number }>('asset.get', { assetId: assets.items[0].id })).width ?? 0;
    assert.equal(plain!.payloadActual?.width, baselineWidth, '原图发送按基准尺寸声明');
    checks.push({ check: 'direct-run-send-copy-settings', defaultLongEdge: defaultRecipe, plainDerived: plain!.payloadActual?.derived,
      plainWidth: plain!.payloadActual?.width, plainBytes: plain!.payloadActual?.bytes, sourceBytes: plain!.payloadActual?.sourceBytes });

    // ===== 只标注区域：在素材画布上框一块，写进项目设置，下一次运行会带上它 =====
    await openSelectedProjectOverview(driver);
    await openFirstAssetCanvas(driver);
    await js(`([...document.querySelectorAll('.quality-canvas-tools button')].find(node=>node.getAttribute('aria-label')==='只标注这块区域')).click()`);
    const dragged = await js<boolean>(`(()=>{const svg=document.querySelector('svg[aria-label="素材标注画布"]');if(!svg)return false;
      // 每个事件都按当时的矩形算坐标：弹层进场动画会让 rect 变化，沿用首次测量会把点落到元素外。
      const fire=(type,fx,fy)=>{const box=svg.getBoundingClientRect();
        svg.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:1,isPrimary:true,button:0,buttons:1,
          clientX:box.left+box.width*fx,clientY:box.top+box.height*fy}));};
      fire('pointerdown',0.3,0.3);fire('pointermove',0.7,0.7);fire('pointerup',0.7,0.7);return true;})()`);
    assert.equal(dragged, true, '素材画布上应有可框选区域的 SVG');
    await waitFor(`window.autoLabel.request('project.open',{projectId:${json(projectId)}}).then(p=>!!(p.settings&&p.settings.annotationRegion))`, 15000);
    const withRegion = await api<{ settings?: { annotationRegion?: { left: number; top: number; right: number; bottom: number } } }>('project.open', { projectId });
    const region = withRegion.settings?.annotationRegion;
    assert.ok(region, `框选后应把区域写进项目设置，实际：${json(withRegion.settings)}`);
    assert.ok(Math.abs((region!.left ?? 0) - 0.3) < 0.03 && Math.abs((region!.top ?? 0) - 0.3) < 0.03
      && Math.abs((region!.right ?? 0) - 0.7) < 0.03 && Math.abs((region!.bottom ?? 0) - 0.7) < 0.03,
      `区域应落在框选的位置上，实际：${json(region)}`);
    checks.push({ check: 'canvas-region-saved', region });

    // ===== 画布精修：方向键 1px / Shift 10px 微调、滚轮缩放、中键拖拽平移 =====
    // 微调属于未保存改动：关窗前的放弃确认在这一步就放行，验收只看行为、不落改动。
    await js(`(()=>{window.confirm=()=>true;return true})()`);
    const nudgeBefore = await js<number>(`(()=>{const x=document.querySelector('input[aria-label="标注对象x"]');return x?Number(x.value):NaN})()`);
    assert.ok(Number.isFinite(nudgeBefore), '画布应默认选中第一个对象并给出 X 坐标输入框');
    await js(`(()=>{const svg=document.querySelector('svg[aria-label="素材标注画布"]');svg.focus();
      svg.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}));return true})()`);
    await new Promise(resolve => setTimeout(resolve, 150));
    const nudgeOnce = await js<number>(`Number(document.querySelector('input[aria-label="标注对象x"]').value)`);
    assert.ok(Math.abs(nudgeOnce - nudgeBefore - 1) < 0.02, `方向键应把选中对象右移 1px，实际 ${nudgeBefore} → ${nudgeOnce}`);
    await js(`(()=>{const svg=document.querySelector('svg[aria-label="素材标注画布"]');
      svg.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',shiftKey:true,bubbles:true,cancelable:true}));return true})()`);
    await new Promise(resolve => setTimeout(resolve, 150));
    const nudgeShift = await js<number>(`Number(document.querySelector('input[aria-label="标注对象x"]').value)`);
    assert.ok(Math.abs(nudgeShift - nudgeOnce - 10) < 0.02, `Shift+方向键应右移 10px，实际 ${nudgeOnce} → ${nudgeShift}`);
    await js(`(()=>{const viewport=document.querySelector('.quality-image');
      const box=viewport.getBoundingClientRect();
      viewport.dispatchEvent(new WheelEvent('wheel',{deltaY:-120,clientX:box.left+box.width/2,clientY:box.top+box.height/2,bubbles:true,cancelable:true}));return true})()`);
    await waitFor(`parseFloat(document.querySelector('.quality-image-stage').style.width)>100`);
    const refine = await js<{ zoomWidth: string; panScroll: number }>(`(()=>{const viewport=document.querySelector('.quality-image'),stage=document.querySelector('.quality-image-stage');
      const zoomWidth=stage.style.width;
      const svg=document.querySelector('svg[aria-label="素材标注画布"]'),start=viewport.scrollLeft;
      const fire=(type,dx)=>{const b=svg.getBoundingClientRect();svg.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:2,isPrimary:true,button:1,buttons:4,clientX:b.left+b.width/2+dx,clientY:b.top+b.height/2}));};
      fire('pointerdown',0);fire('pointermove',60);fire('pointerup',60);
      return {zoomWidth,panScroll:start-viewport.scrollLeft}})()`);
    assert.ok(parseFloat(refine.zoomWidth) > 100, `滚轮应放大画布，实际 stage 宽度 ${refine.zoomWidth}`);
    assert.ok(refine.panScroll > 10, `中键拖拽应平移视野，scrollLeft 变化 ${refine.panScroll}`);
    checks.push({ check: 'canvas-refine-nudge-zoom-pan', nudge1px: nudgeOnce - nudgeBefore, nudge10px: nudgeShift - nudgeOnce, zoomWidth: refine.zoomWidth, panScroll: refine.panScroll });

    // 画布上的区域要能在直达标注里看到，并且随运行一起发出去。
    await js(`([...document.querySelectorAll('dialog[open] button')].find(node=>node.innerText.trim()==='关闭')).click()`);
    await waitFor(`[...document.querySelectorAll('dialog[open] button')].some(node=>node.innerText.trim()==='确定')`);
    await js(`([...document.querySelectorAll('dialog[open] button')].find(node=>node.innerText.trim()==='确定')).click()`);
    await waitFor(`!document.querySelector('.asset-annotator')`);
    await openProjectChat(driver, projectName!);
    await js(`document.querySelector('.chat-panel .direct-run-trigger').click()`);
    await waitFor(`!!document.querySelector('.direct-run .picker-popover')`);
    const regionPanel = await js<string>(`document.querySelector('.direct-run .picker-popover').innerText.replace(/\\s+/g,' ')`);
    assert.ok(regionPanel.includes('左 30%') && regionPanel.includes('右 70%'), `直达标注应显示已设的区域，实际：${regionPanel.slice(0, 240)}`);
    await button('开始标注', `document.querySelector('.direct-run .picker-popover')`);
    await waitFor(`window.autoLabel.request('run.list',{}).then(list=>list.some(run=>run.payloadActual&&run.payloadActual.width&&run.payloadActual.width<${baselineWidth}))`, 20000);
    const croppedRuns = await api<Array<{ id: string; payloadActual?: { width?: number; height?: number } }>>('run.list', {});
    const cropped = croppedRuns.find(item => item.payloadActual && (item.payloadActual.width ?? 0) < baselineWidth);
    assert.ok(cropped, '带区域的运行必须只发送裁剪后的副本');
    checks.push({ check: 'direct-run-sends-region-copy', croppedWidth: cropped!.payloadActual?.width, croppedHeight: cropped!.payloadActual?.height });

    // ===== 批量确认：勾选多张一次确认，已确认的跳过、人工内容不被改写 =====
    await openSelectedProjectOverview(driver);
    await js(`(()=>{window.confirm=()=>true;return true;})()`);
    await js(`([...document.querySelectorAll('.asset-selection button')].find(node=>node.innerText.trim()==='全选已加载')).click()`);
    await waitFor(`[...document.querySelectorAll('.asset-selection button')].some(node=>node.innerText.trim()==='接受候选并确认'&&!node.disabled)`);
    await js(`([...document.querySelectorAll('.asset-selection button')].find(node=>node.innerText.trim()==='接受候选并确认')).click()`);
    await waitFor(`[...document.querySelectorAll('dialog[open] button')].some(node=>node.innerText.trim()==='确定')`);
    await js(`([...document.querySelectorAll('dialog[open] button')].find(node=>node.innerText.trim()==='确定')).click()`);
    await waitFor(`window.autoLabel.request('asset.list',{projectId:${json(projectId)},limit:100}).then(list=>list.items.every(item=>item.status==='confirmed'))`, 25000);
    const confirmedAssets = await api<{ items: Array<{ status: string; annotations?: unknown[]; version: number }> }>('asset.list', { projectId, limit: 100 });
    const beforeConfirm = assets.items[0].annotations?.length ?? 0;
    assert.ok(confirmedAssets.items.every(item => item.status === 'confirmed'), `批量确认后应全部为已确认，实际：${json(confirmedAssets.items.map(item => item.status))}`);
    assert.equal(confirmedAssets.items[0].annotations?.length ?? 0, beforeConfirm, '确认不应改动人工框的数量');
    // 再点一次：已确认的素材要跳过，而不是重复写一遍版本。
    const versionBefore = confirmedAssets.items[0].version;
    await js(`([...document.querySelectorAll('.asset-selection button')].find(node=>node.innerText.trim()==='接受候选并确认')).click()`);
    await new Promise(resolve => setTimeout(resolve, 400));
    const afterRepeat = await api<{ items: Array<{ version: number }> }>('asset.list', { projectId, limit: 100 });
    assert.equal(afterRepeat.items[0].version, versionBefore, '已经确认过的素材不应再写新版本');
    checks.push({ check: 'bulk-confirm-candidates', statuses: confirmedAssets.items.map(item => item.status), objects: beforeConfirm, repeatVersion: afterRepeat.items[0].version });

    // ===== 结果筛选芯片：计数与网格逐个对得上，筛选态下全选只选筛选结果 =====
    await waitFor(`!!document.querySelector('.result-filters')`);
    const chips = await js<Array<{ key: string; count: number }>>(`[...document.querySelectorAll('.result-filter')].map(node=>({key:node.getAttribute('data-result-filter'),count:Number(node.querySelector('strong').innerText)}))`);
    assert.equal(chips.length, 6, `应有 6 个结果筛选芯片，实际：${json(chips)}`);
    const filterShown: Record<string, number> = {};
    for (const chip of chips) {
      await js(`document.querySelector('.result-filter[data-result-filter=${json(chip.key)}]').click()`);
      await new Promise(resolve => setTimeout(resolve, 150));
      const shown = await js<number>(`document.querySelectorAll('.result-grid .result-thumb-wrap').length`);
      assert.equal(shown, chip.count, `筛选「${chip.key}」应显示 ${chip.count} 张，实际 ${shown}`);
      filterShown[chip.key] = shown;
    }
    const nonAll = chips.find(chip => chip.key !== 'all' && chip.count > 0);
    assert.ok(nonAll, `批量确认后应至少有一个非「全部」芯片有计数，实际：${json(chips)}`);
    await js(`document.querySelector('.result-filter[data-result-filter=${json(nonAll!.key)}]').click()`);
    await new Promise(resolve => setTimeout(resolve, 150));
    const label = await js<string>(`[...document.querySelectorAll('.asset-selection button')].map(node=>node.innerText.trim()).join('|')`);
    assert.ok(label.includes('全选筛选结果'), `筛选态下全选按钮应指向筛选结果，实际：${label}`);
    await js(`([...document.querySelectorAll('.asset-selection button')].find(node=>node.innerText.includes('全选筛选结果'))).click()`);
    const picked = await js<number>(`document.querySelectorAll('.result-grid .result-thumb-wrap.selected').length`);
    assert.equal(picked, nonAll!.count, `全选筛选结果应只选中筛选出的 ${nonAll!.count} 张，实际 ${picked}`);
    await js(`([...document.querySelectorAll('.asset-selection button')].find(node=>node.innerText.trim()==='清空选择')).click()`);
    await js(`document.querySelector('.result-filter[data-result-filter="all"]').click()`);
    checks.push({ check: 'result-filter-chips', shown: filterShown, selectedFilter: nonAll!.key });

    // ===== 参考帧：把一张已人工确认的图当示例发出去，而它自己不被标注 =====
    const extra = path.join(fixtures, 'reference.png');
    await copyFile(path.resolve('renderer/design/codex-projects.png'), extra);
    await writeFile(path.join(userData, 'dialog-fixtures.json'), json([{ kind: 'images', paths: [extra] }]));
    await gotoWelcome(driver);
    await button('导入图片');
    await waitFor(`!!document.querySelector('dialog[open]')&&document.querySelector('dialog[open]').innerText.includes('新建项目')`);
    await button('选择已有项目', "document.querySelector('dialog[open]')");
    await waitFor(`!!document.querySelector('dialog[open] select')`);
    await js(`(()=>{const e=document.querySelector('dialog[open] select');e.value=${json(projectId)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await button('导入并继续', "document.querySelector('dialog[open]')");
    await waitFor(`!!document.querySelector('.chat-panel textarea')`);
    const twoAssets = await api<{ items: Array<{ id: string; status: string }> }>('asset.list', { projectId, limit: 100 });
    assert.equal(twoAssets.items.length, 2, `示例项目应有两张素材，实际：${json(twoAssets.items.map(item => item.id))}`);
    const referenceAsset = twoAssets.items.find(item => item.id !== assets.items[0].id)!;
    // 参考必须是「人工确认过」的素材（引擎的硬要求）：这里手工确认一张。
    const referenceAssetView = await api<{ version: number }>('asset.get', { assetId: referenceAsset.id });
    await api('annotation.save', { assetId: referenceAsset.id, baseVersion: referenceAssetView.version, confirm: true,
      annotations: [{ id: 'reference-box', classId: 'vehicle', type: 'detect', bbox: { x: 40, y: 40, width: 120, height: 90 } }] });
    const confirmedReference = await api<{ status: string }>('asset.get', { assetId: referenceAsset.id });
    assert.equal(confirmedReference.status, 'confirmed', '参考素材必须先人工确认');

    await openProjectChat(driver, projectName!);
    await js(`document.querySelector('.chat-panel .direct-run-trigger').click()`);
    await waitFor(`!!document.querySelector('.direct-run .picker-popover')`);
    await waitFor(`!!document.querySelector('.direct-run .picker-popover .field select')`);
    const referenceOptions = await js<string[]>(`[...document.querySelectorAll('.direct-run .picker-popover .field select option')].map(node=>node.innerText.trim())`);
    assert.ok(referenceOptions.length >= 2, `参考帧下拉里应列出已确认的素材，实际：${json(referenceOptions)}`);
    await js(`(()=>{const e=document.querySelector('.direct-run .picker-popover .field select');e.value=${json(referenceAsset.id)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await button('开始标注', `document.querySelector('.direct-run .picker-popover')`);
    // 用运行快照里的 references 精确定位这次运行（按 total 找会撞上之前那次单素材运行）。
    const hasReferenceRun = `(async()=>{const list=await window.autoLabel.request('run.list',{});for(const run of list){const detail=await window.autoLabel.request('run.get',{runId:run.id});
      if(detail.snapshot&&detail.snapshot.references&&detail.snapshot.references.some(ref=>ref.id===${json(referenceAsset.id)}))return true;}return false;})()`;
    await waitFor(hasReferenceRun, 25000);
    let referenceRunId = '';
    for (const run of await api<Array<{ id: string }>>('run.list', {})) {
      const detail = await api<{ snapshot?: { references?: Array<{ id: string }> } }>('run.get', { runId: run.id });
      if (detail.snapshot?.references?.some(ref => ref.id === referenceAsset.id)) { referenceRunId = run.id; break; }
    }
    const referenceDetail = await api<{ samples: Array<{ assetId: string }> }>('run.get', { runId: referenceRunId });
    assert.equal(referenceDetail.samples.length, 1, '参考帧不应被当成待标注目标');
    assert.notEqual(referenceDetail.samples[0].assetId, referenceAsset.id, '参考帧不在本次目标里');
    const wireReference = seenReferences.find(item => item.assetId === referenceAsset.id);
    assert.ok(wireReference, `请求里必须带 role=reference 的示例帧，实际记录：${json(seenReferences)}`);
    assert.equal(wireReference!.objects, 1, '参考帧要把它的人工标注一起发给模型');
    checks.push({ check: 'direct-run-uses-reference-frame', reference: wireReference, targets: referenceDetail.samples.map(sample => sample.assetId) });

    // ===== 没有类别时必须说清原因并禁用开始 =====
    // 用界面内的「新建项目」建一个空项目：不碰系统文件框，落点更稳。
    await js(`[...document.querySelectorAll('.sidebar-scroll .nav-item')].find(b=>b.innerText.trim()==='新对话').click()`);
    await waitFor(`!!document.querySelector('.onboarding-lanes')`);
    await js(`document.querySelector('.sidebar-group-more[aria-label="新建项目"]').click()`);
    await waitFor(`!!document.querySelector('dialog[open]')`);
    const dialog = "document.querySelector('dialog[open]')";
    await js(`(()=>{const e=${dialog}.querySelector('input[placeholder="给项目起个名字"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${json(`无类别-${Date.now()}`)});
      e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await button('创建项目', dialog);
    await waitFor(`!document.querySelector('dialog[open]')`);
    await waitFor(`!!document.querySelector('.chat-panel .direct-run-trigger')`);
    await js(`document.querySelector('.chat-panel .direct-run-trigger').click()`);
    await waitFor(`!!document.querySelector('.direct-run .picker-popover')`);
    const blocked = await js<{ text: string; startDisabled: boolean }>(`(()=>{const p=document.querySelector('.direct-run .picker-popover');
      const start=[...p.querySelectorAll('button')].find(b=>b.innerText.trim()==='开始标注');
      return { text: p.innerText.replace(/\\s+/g,' '), startDisabled: Boolean(start?.disabled) };})()`);
    assert.ok(blocked.text.includes('还没有类别'), `没有类别时应说明原因，实际：${blocked.text.slice(0, 200)}`);
    assert.equal(blocked.startDisabled, true, '没有类别时开始按钮应禁用');
    // 原因文本要完整记录：截断会让下游汇总断言读不到真正的拦截原因（曾把「还没有类别」截在 160 字之外）。
    checks.push({ check: 'direct-run-blocks-without-classes', reason: blocked.text });
    await writeFile(output, json({ checks, passed: true }));
  } catch (error) {
    await writeFile(output, json({ checks, passed: false, error: error instanceof Error ? error.message : String(error), body: await js(`document.body.innerText`) }));
    throw error;
  } finally {
    server.close();
  }
}
