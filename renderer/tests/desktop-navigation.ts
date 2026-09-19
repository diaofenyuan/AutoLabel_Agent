/**
 * 桌面验收脚本共用的界面导航。
 *
 * 走查结论：这些验收此前各写一份「按序号点导航」的写法（`.nav-item:nth-child(3)`、
 * `.project-row`、`打开示例`），界面一改版就集体失效，而且失效原因与它们想验的东西无关。
 * 这里按名字导航，界面改版只需改这一处：
 * - 主导航只剩「新对话 / 任务 / 设置」三项，其余视图不再占导航位；
 * - 项目在侧栏按名字列出，打开项目等于进入该项目的会话；
 * - 标注画布从项目概览的素材缩略图进入（概览 → 素材 → 编辑标注）。
 *
 * 每个脚本把自己那套 js / wait 传进来即可，不要求它们统一改造。
 */
export interface UiDriver {
  js: <T = unknown>(code: string) => Promise<T>;
  wait: (expression: string, timeout?: number) => Promise<void>;
}

const q = JSON.stringify;

/**
 * 等上一次导航落定。
 * 页面切换是互斥的（App.tsx 的 transitionOwner）：上一次没结束就点下一次，会被静默丢弃，
 * 表现成「点了没反应」。`main[aria-busy]` 就是这件事的现成信号，不必另加测试钩子。
 */
export async function waitForIdle(driver: UiDriver): Promise<void> {
  await driver.wait(`document.querySelector('main.page')?.getAttribute('aria-busy')==='false'`);
}

/** 按名字点主导航项。 */
export async function gotoNav(driver: UiDriver, label: string): Promise<void> {
  await driver.wait(`[...document.querySelectorAll('.nav-item')].some(node=>node.innerText.trim()===${q(label)}&&!node.disabled)`);
  await driver.js(`([...document.querySelectorAll('.nav-item')].find(node=>node.innerText.trim()===${q(label)})).click()`);
}

/** 回到欢迎页。 */
export async function gotoWelcome(driver: UiDriver): Promise<void> {
  await gotoNav(driver, '新对话');
  await driver.wait(`!!document.querySelector('.onboarding-lanes')`);
}

/** 进入任务页的某一类。任务页的分类是页内标签，不是导航项。 */
export async function gotoTasks(driver: UiDriver, tab: string): Promise<void> {
  await gotoNav(driver, '任务');
  await driver.wait(`!!document.querySelector('.task-kind-tabs')`);
  await driver.wait(`[...document.querySelectorAll('.task-kind-tabs button')].some(node=>node.innerText.trim()===${q(tab)}&&!node.disabled)`);
  await driver.js(`([...document.querySelectorAll('.task-kind-tabs button')].find(node=>node.innerText.trim()===${q(tab)})).click()`);
}

/** 进入设置页的某个区块。高级区块默认折叠，这里会先展开，调用方不必自己记得这一步。 */
export async function gotoSettings(driver: UiDriver, tab: string): Promise<void> {
  await gotoNav(driver, '设置');
  await driver.wait(`!!document.querySelector('.settings-tabs')`);
  const tabVisible = `[...document.querySelectorAll('.settings-tabs button')].some(node=>node.innerText.trim()===${q(tab)})`;
  if (!(await driver.js<boolean>(tabVisible))) {
    await driver.wait(`!!document.querySelector('.settings-advanced-toggle')`);
    await driver.js(`document.querySelector('.settings-advanced-toggle').click()`);
  }
  await driver.wait(`[...document.querySelectorAll('.settings-tabs button')].some(node=>node.innerText.trim()===${q(tab)}&&!node.disabled)`);
  await driver.js(`([...document.querySelectorAll('.settings-tabs button')].find(node=>node.innerText.trim()===${q(tab)})).click()`);
  await driver.wait(`document.querySelector('.settings-tabs button.selected')?.innerText.trim()===${q(tab)}`);
}

/**
 * 本地推理页的解释器入口。
 * 「一键准备」是主入口，手动选解释器折在「高级」里；需要走手动路径的验收先调这里展开，
 * 免得每个脚本各自记一遍折叠状态。
 */
export async function openPythonPicker(driver: UiDriver): Promise<void> {
  await driver.wait(`!!document.querySelector('.local-runtime-advanced-toggle')`);
  if (!(await driver.js<boolean>(`!!document.querySelector('[aria-label="手动选择 Python 解释器"]')`))) {
    await driver.js(`document.querySelector('.local-runtime-advanced-toggle').click()`);
  }
  await driver.wait(`[...document.querySelectorAll('.local-runtime-settings button')].some(node=>node.innerText.trim()==='选择 Python 解释器'&&!node.disabled)`);
}

/**
 * 从侧栏进入某个项目的会话。
 * 与「只看概览」不同：这一步会把该项目的素材加载进应用层，标准答案集的素材选择器读的正是这份数据。
 */
export async function openProjectChat(driver: UiDriver, name: string): Promise<void> {
  await driver.wait(`[...document.querySelectorAll('.sidebar-project .sidebar-row-title')].some(node=>node.innerText.includes(${q(name)}))`);
  await waitForIdle(driver);
  await driver.js(`([...document.querySelectorAll('.sidebar-project')].find(node=>node.innerText.includes(${q(name)}))).querySelector('.sidebar-row').click()`);
  await driver.wait(`!!document.querySelector('.chat-panel textarea')`);
  await waitForIdle(driver);
}

/** 从侧栏打开某个项目的概览页。 */
export async function openProjectOverview(driver: UiDriver, name: string): Promise<void> {
  await driver.wait(`[...document.querySelectorAll('.sidebar-project .sidebar-row-title')].some(node=>node.innerText.includes(${q(name)}))`);
  await waitForIdle(driver);
  await driver.js(`([...document.querySelectorAll('.sidebar-project')].find(node=>node.innerText.includes(${q(name)}))).querySelector('.sidebar-actions button[title="项目概览"]').click()`);
  await driver.wait(`!!document.querySelector('.overview-page')`);
}

/** 打开当前项目的概览页（项目刚被打开、侧栏里它处于选中态时用）。 */
export async function openSelectedProjectOverview(driver: UiDriver): Promise<void> {
  await driver.wait(`!!document.querySelector('.sidebar-project.selected .sidebar-actions button[title="项目概览"]')`);
  await waitForIdle(driver);
  await driver.js(`document.querySelector('.sidebar-project.selected .sidebar-actions button[title="项目概览"]').click()`);
  await driver.wait(`!!document.querySelector('.overview-page')`);
}

/**
 * 画布就绪：素材原图加载完成才算可用。
 * 旧写法等的 `.annotation-canvas image` 是工作台时代的标记，早已随工作台退役；
 * 现在的画布是 `.quality-image img` + 一块可写的 SVG（`svg[aria-label="素材标注画布"]`）。
 */
export async function waitForCanvas(driver: UiDriver): Promise<void> {
  await driver.wait(`!!document.querySelector('.quality-image img')`);
  await driver.wait(`(()=>{const img=document.querySelector('.quality-image img');return !!img&&img.complete&&img.naturalWidth>0;})()`);
  await driver.wait(`!!document.querySelector('svg[aria-label="素材标注画布"]')`);
}

/** 从概览进入第一张素材的人工标注画布。 */
export async function openFirstAssetCanvas(driver: UiDriver): Promise<void> {
  await driver.wait(`!!document.querySelector('.result-thumb')`);
  await driver.js(`document.querySelector('.result-thumb').click()`);
  await driver.wait(`!!document.querySelector('.asset-annotator')`);
  await driver.wait(`[...document.querySelectorAll('dialog[open] button')].some(node=>node.innerText.trim()==='编辑标注'&&!node.disabled)`);
  await driver.js(`([...document.querySelectorAll('dialog[open] button')].find(node=>node.innerText.trim()==='编辑标注')).click()`);
  await waitForCanvas(driver);
}

/** 画布上这张素材的标识。 */
export function canvasAssetId(driver: UiDriver): Promise<string> {
  return driver.js<string>(`new URL(document.querySelector('.quality-image img').src).pathname.slice(1)`);
}

/**
 * 载入示例项目并进入第一张素材的标注画布，返回该素材标识。
 * 这是旧「打开示例」按钮在新界面上的等价路径：改版后示例从欢迎页进入，画布从概览进入。
 */
export async function openExampleCanvas(driver: UiDriver): Promise<string> {
  await gotoWelcome(driver);
  await driver.wait(`!!document.querySelector('.onboarding-lane button')`);
  await driver.js(`([...document.querySelectorAll('.onboarding-lane button')].find(node=>node.innerText.trim()==='载入示例项目')).click()`);
  await driver.wait(`!!document.querySelector('.chat-panel textarea')`);
  await waitForIdle(driver);
  await openSelectedProjectOverview(driver);
  await openFirstAssetCanvas(driver);
  return canvasAssetId(driver);
}
