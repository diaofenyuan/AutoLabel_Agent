import type { BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
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
 * 断言全部走本地 DOM，不点「保存并读取模型列表」：那会向真实服务商发请求，验收不该产生外部调用与费用。
 */
export async function checkDesktopAiPreset(window: BrowserWindow, output: string): Promise<void> {
  const checks: Record<string, unknown>[] = [];
  const js = <T = unknown>(code: string): Promise<T> => window.webContents.executeJavaScript(code);
  const json = JSON.stringify;
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
    await writeFile(output, json({ checks, passed: true }));
  } catch (error) {
    await writeFile(output.replace(/\.json$/, '-failure.png'), (await window.webContents.capturePage()).toPNG());
    await writeFile(output, json({ checks, passed: false, error: error instanceof Error ? error.message : String(error), body: await js(`document.body.innerText`) }));
    throw error;
  }
}
