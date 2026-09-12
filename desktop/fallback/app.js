const labels = { starting: '正在启动', ready: '已连接', disconnected: '连接中断', error: '启动失败', stopped: '已停止' };
async function refresh() {
  try {
    const data = await window.autoLabel.request('diagnostics.get');
    document.querySelector('#engine').textContent = labels[data.engine.state];
    document.querySelector('#version').textContent = data.engine.version ? `引擎 ${data.engine.version} · 协议 ${data.engine.protocolVersion}` : '引擎尚未完成启动握手';
    document.querySelector('#runtime').textContent = data.runtimeFound ? '已找到运行时' : '运行时待准备';
    document.querySelector('#vault').textContent = data.credentialProtection ? '已启用' : '当前不可用';
    document.querySelector('#status').textContent = data.engine.message || (data.engine.state === 'ready' ? '引擎连接正常。可返回工作台继续处理项目。' : '查看详情了解当前本地状态。');
    document.querySelector('#details').textContent = JSON.stringify(data, null, 2);
  } catch { document.querySelector('#status').textContent = '桌面通信不可用，请重新启动应用。'; }
}
document.querySelector('#refresh').addEventListener('click', refresh);
document.querySelector('#save').addEventListener('click', async event => {
  event.target.disabled = true;
  try { await window.autoLabel.request('diagnostics.save'); }
  catch { document.querySelector('#status').textContent = '诊断文件未能保存，请重新选择保存位置。'; }
  finally { event.target.disabled = false; }
});
document.querySelector('#restart').addEventListener('click', async event => {
  event.target.disabled = true;
  try { await window.autoLabel.restartEngine(); } finally { event.target.disabled = false; await refresh(); }
});
window.autoLabel?.onEngineStatus(refresh);
for (const button of document.querySelectorAll('[data-window]')) {
  button.addEventListener('click', () => {
    void window.autoLabel.windowAction(button.dataset.window).catch(() => {
      document.querySelector('#status').textContent = '窗口操作未完成，请稍后重试。';
    });
  });
}
void refresh();
