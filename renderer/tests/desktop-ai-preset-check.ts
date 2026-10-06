import type { BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';

/**
 * 简版 AI 配置验收。
 *
 * 走查结论是：首次配置原先是「接口名称 → 协议 → 基础地址 → Key → 保存 → 读模型 → 选测试模型 → 逐项验能力 → 配模型职责」，
 * 十来个控件里有一半是新人答不上来的问题（协议选哪个、地址填什么）。本次验收断言：
 * 1. 首屏给出常用服务商预设，选中即把基础地址与接口名称填好；
 * 2. 用户自己起的接口名不会被预设覆盖；
 * 3. 简版默认只留「预设 / 名称 / 地址 / Key」，协议、高级请求、能力表与模型职责都要先点「手动配置」才出现；
 * 4. 手动配置里的东西一件没少（六项能力表与两个模型职责都在）。
 *
 * 成功配置走 127.0.0.1 回环夹具，失败配置用保留的不可达回环端口；整个验收不会访问真实服务商。
 */
export async function checkDesktopAiPreset(window: BrowserWindow, output: string): Promise<void> {
  const checks: Record<string, unknown>[] = [];
  const js = <T = unknown>(code: string): Promise<T> => window.webContents.executeJavaScript(code);
  const json = JSON.stringify;
  let modelRequests = 0, chatRequests = 0;
  // 配置成功链路只访问这个本地夹具，不接触外网或真实服务商。
  const apiFixture = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'GET' && request.url === '/v1/models') {
      modelRequests++;
      response.end(JSON.stringify({ data: [{ id: 'fixture-setup-model' }] }));
      return;
    }
    if (request.method === 'POST' && request.url === '/v1/chat/completions') {
      chatRequests++;
      const chunks: Buffer[] = [];
      request.on('data', chunk => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { response_format?: unknown; tools?: Array<{ function?: { name?: string } }> };
        const message: Record<string, unknown> = { role: 'assistant', content: body.response_format ? '{"ok":true}' : 'OK' };
        if (body.tools?.length) message.tool_calls = [{ id: 'fixture-tool-call', type: 'function', function: { name: body.tools[0].function?.name ?? 'report_status', arguments: '{"status":"ok"}' } }];
        response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message }] }));
      });
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'local fixture route not found' }));
  });
  await new Promise<void>((resolve, reject) => {
    apiFixture.once('error', reject);
    apiFixture.listen(0, '127.0.0.1', resolve);
  });
  const fixtureAddress = apiFixture.address();
  assert.ok(fixtureAddress && typeof fixtureAddress === 'object');
  const fixtureBaseUrl = `http://127.0.0.1:${fixtureAddress.port}/v1`;
  const closeFixture = async () => {
    if (!apiFixture.listening) return;
    apiFixture.closeAllConnections();
    await new Promise<void>(resolve => apiFixture.close(() => resolve()));
  };
  async function waitFor(expression: string, timeout = 30000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await js<boolean>(`(async()=>{try{return !!(await (${expression}))}catch(e){return false}})()`)) return;
      await new Promise(resolve => setTimeout(resolve, 60));
    }
    throw new Error(`等待界面超时：${expression}`);
  }
  const valueOf = (placeholder: string) => js<string>(`document.querySelector('input[placeholder=${json(placeholder)}]')?.value ?? ''`);
  const clickPreset = (label: string) => js(`([...document.querySelectorAll('.ai-presets button')].find(node=>node.innerText.includes(${json(label)}))).click()`);
  try {
    window.show();
    await waitFor(`!!document.querySelector('.onboarding-lanes')&&!document.querySelector('.connection-banner')`);
    await js(`[...document.querySelectorAll('.sidebar-bottom .nav-item')].find(node=>node.innerText.trim()==='设置').click()`);
    await waitFor(`!!document.querySelector('.settings-tabs')`);
    await js(`([...document.querySelectorAll('.settings-tabs button')].find(node=>node.innerText.trim()==='软件 AI 配置')).click()`);
    await waitFor(`!!document.querySelector('.ai-presets')`);

    // ===== 预设：选中即填好地址与名称 =====
    const presets = await js<string[]>(`[...document.querySelectorAll('.ai-presets button strong')].map(node=>node.innerText.trim())`);
    for (const label of ['自定义', 'OpenAI', 'DeepSeek', '通义千问', '智谱 GLM', '月之暗面', '硅基流动', '本地 Ollama']) {
      assert.ok(presets.includes(label), `缺少「${label}」预设，实际：${json(presets)}`);
    }
    await clickPreset('本地 Ollama');
    await waitFor(`document.querySelector('input[placeholder=${json('https://api.example.com/v1')}]')?.value==='http://127.0.0.1:11434/v1'`);
    assert.equal(await valueOf('例如：我的 OpenAI 兼容接口'), '本地 Ollama');
    checks.push({ check: 'preset-fills-address', presets: presets.length, baseUrl: await valueOf('https://api.example.com/v1') });

    // ===== 用户自己起的名字不能被预设覆盖 =====
    await js(`(()=>{const e=document.querySelector('input[placeholder=${json('例如：我的 OpenAI 兼容接口')}]');e.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'我的标注接口');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await clickPreset('DeepSeek');
    await waitFor(`document.querySelector('input[placeholder=${json('https://api.example.com/v1')}]')?.value==='https://api.deepseek.com/v1'`);
    const keptName = await valueOf('例如：我的 OpenAI 兼容接口');
    assert.equal(keptName, '我的标注接口', `选预设不应覆盖用户自己填的名称，实际：${keptName}`);
    checks.push({ check: 'preset-keeps-custom-name', name: keptName });

    // ===== 简版默认收起了哪些东西 =====
    const quick = await js<{ capability: boolean; roles: boolean; protocol: boolean; submit: string; keyEnabled: boolean }>(`(()=>({
      capability: !!document.querySelector('.capability-table'),
      roles: !!document.querySelector('#ai-roles'),
      protocol: [...document.querySelectorAll('.provider-form select')].some(select=>[...select.options].some(option=>option.value==='responses')),
      submit: document.querySelector('.provider-form button[type=submit]')?.innerText.trim() ?? '',
      keyEnabled: !document.querySelector('.provider-form input[autocomplete=new-password]')?.disabled
    }))()`);
    assert.equal(quick.capability, false, '简版不应出现六项能力表');
    assert.equal(quick.roles, false, '简版不应出现模型职责');
    assert.equal(quick.protocol, false, '简版不应出现协议选择');
    assert.equal(quick.keyEnabled, true, 'API Key 必须可填');
    assert.ok(quick.submit.includes('保存并读取模型列表'), `简版的主按钮应把保存与读模型并成一步，实际：${quick.submit}`);
    checks.push({ check: 'quick-form-hides-advanced', ...quick });
    // 简版是本次改动的主战场，留一张图核对排版；等设置页的淡入动画收尾再截，否则会拍到半透明的中间帧。
    await waitFor(`getComputedStyle(document.querySelector('.settings-body')).opacity==='1'`);
    await writeFile(output.replace(/\.json$/, '.png'), (await window.webContents.capturePage()).toPNG());

    // ===== 手动配置里一件没少 =====
    await js(`([...document.querySelectorAll('.provider-form .advanced-toggle')].find(node=>node.innerText.includes('手动配置'))).click()`);
    await waitFor(`!!document.querySelector('.capability-table')&&!!document.querySelector('#ai-roles')`);
    assert.ok(await js<boolean>(`[...document.querySelectorAll('.provider-form select')].some(select=>[...select.options].some(option=>option.value==='responses'))`), '手动配置应能改协议');
    assert.equal(await js<number>(`document.querySelectorAll('.capability-table .capability-row').length`), 6, '手动配置应保留六项能力表');
    assert.ok((await js<string>(`document.querySelector('.provider-form button[type=submit]').innerText`)).includes('保存接口'));
    checks.push({ check: 'manual-form-keeps-everything', capabilityRows: 6, roles: true, protocol: true });

    // ===== 本地不可达地址：API 模型列表读取失败必须留在设置页并给出可读错误 =====
    // 使用回环地址的保留端口，不会触达外网，也不依赖真实服务商或产生调用费用。
    await js(`(()=>{const set=(selector,value,prototype)=>{const input=document.querySelector(selector);Object.getOwnPropertyDescriptor(prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));};set('.provider-form input[placeholder="例如：我的 OpenAI 兼容接口"]','本地失败验证',HTMLInputElement.prototype);set('.provider-form input[placeholder="https://api.example.com/v1"]','http://127.0.0.1:1/v1',HTMLInputElement.prototype);set('.provider-form input[autocomplete="new-password"]','local-ui-check-key',HTMLInputElement.prototype);})()`);
    await js(`document.querySelector('.provider-form button[type=submit]').click()`);
    await waitFor(`!!document.querySelector('.provider-form button.danger')`, 15000);
    await js(`([...document.querySelectorAll('.model-section .section-toolbar button')].find(node=>node.innerText.includes('获取模型列表'))).click()`);
    await waitFor(`!!document.querySelector('.provider-form .inline-error[role=alert]')`, 15000);
    const apiFailure = await js<string>(`document.querySelector('.provider-form .inline-error').innerText.trim()`);
    assert.ok(apiFailure.length > 0, 'API 读取失败时应展示可读错误');
    await js(`(()=>{document.querySelector('.toast [aria-label="关闭提示"]')?.click();document.querySelector('.provider-form .inline-error').scrollIntoView({block:'center',behavior:'instant'});return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));})()`);
    await new Promise(resolve => setTimeout(resolve, 220));
    await writeFile(output.replace(/\.json$/, '-api-validation-failure.png'), (await window.webContents.capturePage()).toPNG());
    checks.push({ check: 'api-validation-failed', message: apiFailure, endpoint: 'http://127.0.0.1:1/v1' });

    // ===== 无默认对话模型时，别把「保存过任一 Key」说成已配置 =====
    await js(`([...document.querySelectorAll('.nav-item')].find(node=>node.innerText.trim()==='新对话')).click()`);
    await waitFor(`!!document.querySelector('.onboarding-lanes')`);
    const unconfiguredHome = await js<{ modelText: string; action: string }>(`(()=>{const lane=document.querySelector('.onboarding-lane:nth-child(3)');return {modelText:lane?.innerText??'',action:[...lane.querySelectorAll('button')].map(button=>button.innerText.trim()).join('|')}})()`);
    assert.ok(unconfiguredHome.action.includes('配置 AI'), `未设默认对话模型时应保留配置入口，实际：${unconfiguredHome.action}`);
    assert.ok(!unconfiguredHome.modelText.includes('当前模型：'), '只保存了接口凭据、没有默认对话模型时不应显示已配置');
    checks.push({ check: 'credential-without-chat-default-is-unconfigured', ...unconfiguredHome });

    // ===== 本地接口配置成功后，首页即时显示默认模型和调整入口 =====
    await js(`([...document.querySelectorAll('.sidebar-bottom .nav-item')].find(node=>node.innerText.trim()==='设置')).click()`);
    await waitFor(`!!document.querySelector('.settings-tabs')`);
    await js(`([...document.querySelectorAll('.settings-tabs button')].find(node=>node.innerText.trim()==='软件 AI 配置')).click()`);
    await waitFor(`!!document.querySelector('.ai-presets')`);
    await js(`document.querySelector('.ai-settings > .section-toolbar button.primary').click()`);
    await waitFor(`!!document.querySelector('.provider-form input[placeholder=${json('例如：我的 OpenAI 兼容接口')}]')`);
    await js(`(()=>{const set=(selector,value,prototype)=>{const input=document.querySelector(selector);Object.getOwnPropertyDescriptor(prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));};set('.provider-form input[placeholder="例如：我的 OpenAI 兼容接口"]','本地同步验证',HTMLInputElement.prototype);set('.provider-form input[placeholder="https://api.example.com/v1"]',${json(fixtureBaseUrl)},HTMLInputElement.prototype);set('.provider-form input[autocomplete="new-password"]','local-ui-check-key',HTMLInputElement.prototype);})()`);
    await js(`document.querySelector('.provider-form button[type=submit]').click()`);
    await waitFor(`!!document.querySelector('.ai-quick-model')`, 20000);
    await js(`document.querySelector('.ai-quick-model .combo-toggle').click()`);
    await waitFor(`!![...document.querySelectorAll('.combo-popover .picker-choose')].find(node=>node.innerText.trim()==='fixture-setup-model')`);
    await js(`([...document.querySelectorAll('.combo-popover .picker-choose')].find(node=>node.innerText.trim()==='fixture-setup-model')).click()`);
    await js(`([...document.querySelectorAll('.ai-quick-model button')].find(node=>node.innerText.includes('验证并设为默认模型'))).click()`);
    await waitFor(`!!document.querySelector('.toast')&&document.querySelector('.toast').innerText.includes('fixture-setup-model')`, 30000);
    await js(`([...document.querySelectorAll('.provider-form .advanced-toggle')].find(node=>node.innerText.includes('手动配置'))).click()`);
    await waitFor(`document.querySelectorAll('.capability-table .capability-row').length===6`);
    const capabilityResults = await js<Array<{ name: string; status: string }>>(`([...document.querySelectorAll('.capability-table .capability-row')].map(row=>({name:row.children[0].innerText.trim(),status:row.children[1].innerText.trim()})))`);
    assert.ok(['连接', '文本输入', '图片输入', '结构化输出'].every(name => capabilityResults.find(result => result.name === name)?.status.includes('已验证')),
      `默认模型必须在必需能力验证通过后写回：${json(capabilityResults)}`);
    await js(`([...document.querySelectorAll('.nav-item')].find(node=>node.innerText.trim()==='新对话')).click()`);
    await waitFor(`!!document.querySelector('.onboarding-lanes')`);
    const configuredHome = await js<{ modelText: string; action: string }>(`(()=>{const lane=document.querySelector('.onboarding-lane:nth-child(3)');return {modelText:lane?.innerText??'',action:[...lane.querySelectorAll('button')].map(button=>button.innerText.trim()).join('|')}})()`);
    assert.ok(configuredHome.modelText.includes('当前模型：fixture-setup-model'), `首页应显示刚刚验证的默认模型，实际：${configuredHome.modelText}`);
    assert.ok(configuredHome.action.includes('调整 AI 配置'), `配置完成后入口应变为调整配置，实际：${configuredHome.action}`);
    await js(`document.querySelector('.chat-home .model-picker-trigger')?.click()`);
    await waitFor(`!!document.querySelector('.chat-home .model-picker .picker-choose')`);
    await js(`document.querySelector('.chat-home .model-picker .picker-choose')?.click()`);
    await waitFor(`!document.querySelector('.chat-home .model-picker .picker-popover')`);
    const selectedModel = await js<string>(`document.querySelector('.chat-home .model-picker-trigger')?.innerText.trim() ?? ''`);
    assert.ok(selectedModel.includes('fixture-setup-model'), `选择模型后输入卡应显示当前模型，实际：${selectedModel}`);
    assert.ok(modelRequests >= 2 && chatRequests >= 3, `本地验证请求数不符合预期：models=${modelRequests}, chat=${chatRequests}`);
    checks.push({ check: 'configured-default-reflected-on-home', ...configuredHome, capabilityResults, selectedModel, modelRequests, chatRequests, endpoint: fixtureBaseUrl });
    await writeFile(output, json({ checks, passed: true }));
    await closeFixture();
  } catch (error) {
    await writeFile(output.replace(/\.json$/, '-failure.png'), (await window.webContents.capturePage()).toPNG());
    await writeFile(output, json({ checks, passed: false, error: error instanceof Error ? error.message : String(error), body: await js(`document.body.innerText`) }));
    await closeFixture();
    throw error;
  }
}
