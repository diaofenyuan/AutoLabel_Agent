import type { BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openProjectChat } from './desktop-navigation';

/** 会话层失败恢复验收：首次调用返回可恢复 HTTP 错误，用户手动重试后流式成功。 */
export async function checkDesktopChatState(window: BrowserWindow, output: string): Promise<void> {
  let calls = 0;
  let streamCancelledByClient = false;
  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* 消耗请求体，确保回环请求正常完成。 */ }
    calls++;
    if (calls === 1) {
      response.writeHead(503, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'local chat fixture unavailable' } }));
      return;
    }
    if (calls === 4) {
      response.writeHead(403, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'local chat fixture permission denied' } }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant' } }] })}\n\n`);
    if (calls === 2) {
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '重试后成功：' } }] })}\n\n`);
      await new Promise(resolve => setTimeout(resolve, 250));
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '流式回复已完成。' } }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' } ] })}\n\n`);
      response.end('data: [DONE]\n\n');
      return;
    }
    // 第三次请求故意保持在途；界面点“停止”后，客户端会中止请求并由 Agent 返回 cancelled。
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '取消前已收到：' } }] })}\n\n`);
    await new Promise<void>(resolve => {
      let settled = false;
      const finish = () => { if (settled) return; settled = true; resolve(); };
      response.once('close', () => { if (!response.writableEnded) streamCancelledByClient = true; finish(); });
      setTimeout(finish, 8000);
    });
    if (!response.writableEnded) response.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

  const checks: Record<string, unknown>[] = [];
  const js = <T = unknown>(code: string): Promise<T> => window.webContents.executeJavaScript(code);
  const json = JSON.stringify;
  async function waitFor(expression: string, timeout = 30000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await js<boolean>(`(async()=>{try{return !!(await (${expression}))}catch{return false}})()`)) return;
      await new Promise(resolve => setTimeout(resolve, 60));
    }
    throw new Error(`等待界面超时：${expression}`);
  }

  try {
    window.show();
    await waitFor(`!!document.querySelector('.onboarding-lanes')&&!document.querySelector('.connection-banner')`);
    const address = server.address() as { port: number };
    const provider = await js<{ id: string }>(`window.autoLabel.request('provider.save',{name:${json(`会话状态夹具-${Date.now()}`)},baseUrl:${json(`http://127.0.0.1:${address.port}/v1`)},protocol:'chat-completions',timeoutMs:10000,maxRetries:0})`);
    await js(`window.autoLabel.request('credential.set',{providerId:${json(provider.id)},key:'isolated-chat-state'})`);
    const settings = await js<Record<string, unknown>>(`window.autoLabel.request('settings.get')`);
    await js(`window.autoLabel.request('settings.save',{settings:{...${json(settings)},chatProviderId:${json(provider.id)},chatModel:'fixture-chat'}})`);
    window.webContents.reload();
    await new Promise(resolve => setTimeout(resolve, 1200));
    await waitFor(`!!document.querySelector('.onboarding-lanes')&&!document.querySelector('.connection-banner')`);

    await js(`([...document.querySelectorAll('.onboarding-lane button')].find(node=>node.innerText.trim()==='载入示例项目')).click()`);
    await waitFor(`!!document.querySelector('.chat-panel textarea')`);
    const project = (await js<Array<{ id: string; name: string }>>(`window.autoLabel.request('project.list')`))[0];
    assert.ok(project, '示例项目应已载入');
    const driver = { js, wait: waitFor };
    await openProjectChat(driver, project.name);

    const prompt = '请说明本地失败重试验收。';
    await js(`(()=>{const input=document.querySelector('.chat-panel textarea');input.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${json(prompt)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await waitFor(`document.querySelector('.chat-panel textarea')?.value===${json(prompt)}&&!document.querySelector('.chat-panel .send-button')?.disabled`);
    await js(`document.querySelector('.chat-panel .send-button').click()`);
    await waitFor(`document.querySelectorAll('.chat-message.assistant.chat-message-failed').length===1&&!!document.querySelector('.chat-message-failed .chat-error-label')&&!![...document.querySelectorAll('.chat-message-failed button')].find(button=>button.innerText.trim()==='重试上一条')`);
    const failed = await js<{ text: string; retry: string; busy: boolean }>(`(()=>{const message=document.querySelector('.chat-message-failed');return {text:message?.innerText.trim()??'',retry:[...message?.querySelectorAll('button')??[]].find(button=>button.innerText.trim()==='重试上一条')?.innerText.trim()??'',busy:!!document.querySelector('.chat-wait')}})()`);
    assert.ok(failed.text.includes('HTTP 503'), `失败消息应保留可读服务端原因：${json(failed)}`);
    assert.ok(failed.text.includes('这次没有完成'), '失败消息应明确标为未完成');
    assert.equal(failed.retry, '重试上一条');
    assert.equal(failed.busy, false, '失败后等待状态应清除');
    assert.equal(calls, 1, '首次失败不应隐式重发');
    checks.push({ check: 'chat-failure-shows-retry', ...failed, requests: calls });

    await js(`([...document.querySelectorAll('.chat-message-failed button')].find(button=>button.innerText.trim()==='重试上一条')).click()`);
    await waitFor(`!!document.querySelector('.chat-wait')&&document.querySelector('.chat-wait').innerText.includes('全项目')`);
    await waitFor(`document.querySelector('.chat-message.assistant.streaming .chat-text')?.innerText.includes('重试后成功：')`);
    const streaming = await js<{ text: string; busy: boolean; completedMessageVisible: boolean }>(`(()=>({text:document.querySelector('.chat-message.assistant.streaming .chat-text')?.innerText.trim()??'',busy:!!document.querySelector('.chat-wait'),completedMessageVisible:[...document.querySelectorAll('.chat-message.assistant:not(.chat-message-failed):not(.streaming) .chat-text')].some(node=>node.innerText.includes('重试后成功：流式回复已完成。'))}))()`);
    assert.equal(streaming.text, '重试后成功：', 'SSE 第一段应先出现在流式消息中');
    assert.equal(streaming.busy, true, '第一段流式内容到达时请求仍在进行');
    assert.equal(streaming.completedMessageVisible, false, '完整回复不应早于后续 SSE 分片显示');
    checks.push({ check: 'chat-streaming-delta-visible', ...streaming });
    await waitFor(`document.querySelectorAll('.chat-message.assistant:not(.chat-message-failed):not(.streaming) .chat-text').length>0&&[...document.querySelectorAll('.chat-message.assistant:not(.chat-message-failed):not(.streaming) .chat-text')].some(node=>node.innerText.includes('重试后成功：流式回复已完成。'))`);
    await waitFor(`!document.querySelector('.chat-wait')`);
    assert.equal(calls, 2, '用户点击重试后应恰好再发一次请求');
    const completed = await js<{ reply: string; failedMessages: number; busy: boolean }>(`(()=>({reply:[...document.querySelectorAll('.chat-message.assistant:not(.chat-message-failed):not(.streaming) .chat-text')].map(node=>node.innerText).find(text=>text.includes('重试后成功：流式回复已完成。'))??'',failedMessages:document.querySelectorAll('.chat-message.assistant.chat-message-failed').length,busy:!!document.querySelector('.chat-wait')}))()`);
    assert.ok(completed.reply.includes('重试后成功：流式回复已完成。'));
    assert.equal(completed.failedMessages, 1, '保留失败消息可供追溯');
    assert.equal(completed.busy, false);
    checks.push({ check: 'chat-retry-stream-completes', ...completed, requests: calls });

    // ===== 停止在途会话：先保留已收到的增量，再显示取消后的下一步 =====
    const cancelPrompt = '请开始一个可停止的本地对话。';
    await js(`(()=>{const input=document.querySelector('.chat-panel textarea');input.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${json(cancelPrompt)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await waitFor(`document.querySelector('.chat-panel textarea')?.value===${json(cancelPrompt)}&&!document.querySelector('.chat-panel .send-button')?.disabled`);
    await js(`document.querySelector('.chat-panel .send-button').click()`);
    await waitFor(`document.querySelector('.chat-message.assistant.streaming .chat-text')?.innerText.includes('取消前已收到：')`);
    await js(`document.querySelector('.chat-panel .send-button[aria-label="停止对话"]').click()`);
    await waitFor(`document.querySelector('.chat-wait')?.innerText.includes('正在请求停止')`);
    await waitFor(`!document.querySelector('.chat-wait')&&[...document.querySelectorAll('.chat-message.assistant:not(.streaming) .chat-text')].some(node=>node.innerText.includes('已停止后续操作'))`, 20000);
    const cancelled = await js<{ reply: string; busy: boolean; requests: number }>(`(()=>({reply:[...document.querySelectorAll('.chat-message.assistant:not(.streaming) .chat-text')].map(node=>node.innerText).find(text=>text.includes('已停止后续操作'))??'',busy:!!document.querySelector('.chat-wait'),requests:${calls}}))()`);
    assert.ok(cancelled.reply.includes('已发出的请求和已提交的任务可在任务中心查看。'), `取消后应说明已发出请求的核对入口：${json(cancelled)}`);
    assert.equal(cancelled.busy, false);
    assert.equal(calls, 3, '点击停止后不得自动再次发送');
    assert.equal(streamCancelledByClient, true, '停止对话应取消仍在等待的上游流式连接');
    checks.push({ check: 'chat-cancel-in-flight', ...cancelled, upstreamCancelled: streamCancelledByClient });

    // ===== 权限不足：要说清核对凭据/模型权限，不伪装成网络断开 =====
    const permissionPrompt = '请验证本地权限不足提示。';
    await js(`(()=>{const input=document.querySelector('.chat-panel textarea');input.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${json(permissionPrompt)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await waitFor(`document.querySelector('.chat-panel textarea')?.value===${json(permissionPrompt)}&&!document.querySelector('.chat-panel .send-button')?.disabled`);
    await js(`document.querySelector('.chat-panel .send-button').click()`);
    await waitFor(`document.querySelectorAll('.chat-message.assistant.chat-message-failed').length===2&&[...document.querySelectorAll('.chat-message-failed')].at(-1)?.innerText.includes('HTTP 403')`);
    const permission = await js<{ text: string; requests: number }>(`(()=>({text:document.querySelectorAll('.chat-message-failed')[1]?.innerText.trim()??'',requests:${calls}}))()`);
    assert.ok(permission.text.includes('权限'), `403 应给出权限核对方向：${json(permission)}`);
    assert.ok(permission.text.includes('provider_auth_failed'), `403 应保留认证/权限错误类别：${json(permission)}`);
    assert.equal(calls, 4, '权限失败不能自动重发');
    checks.push({ check: 'chat-permission-error-next-step', ...permission });

    await import('node:fs/promises').then(({ writeFile }) => writeFile(output, json({ checks, passed: true })));
  } catch (error) {
    await import('node:fs/promises').then(async ({ writeFile }) => {
      await writeFile(output.replace(/\.json$/, '-failure.png'), (await window.webContents.capturePage()).toPNG());
      await writeFile(output, json({ checks, passed: false, calls, error: error instanceof Error ? error.message : String(error), body: await js(`document.body.innerText`) }));
    });
    throw error;
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
