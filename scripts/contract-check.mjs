// 跨层契约门禁：命令从界面/助手到桌面再到引擎、事件从引擎回到界面，都必须在各层同时对齐。
// 这些不一致在源码里看不出来，只有运行时才以「此操作未开放」「其他事件」暴露，所以用静态检查提前拦住。
// 静态不可判定的部分（引擎里动态拼接的事件族）用显式前缀声明，新增族必须先在这里登记。
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => readFileSync(path.join(root, ...parts), 'utf8');
const failures = [];
const fail = message => failures.push(message);

function walk(directory, match) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...walk(full, match));
    else if (match(full)) found.push(full);
  }
  return found;
}

// ---------- 命令：desktop 校验表（界面唯一入口）----------
const validation = read('desktop', 'validation.ts');
const schemas = new Set();
{
  const start = validation.indexOf('const schemas: Record<string, z.ZodType> = {');
  const end = validation.indexOf('\n};', start);
  if (start < 0 || end < 0) throw new Error('未在 desktop/validation.ts 找到命令校验表');
  // 一行可能登记多条命令；嵌套字段名不含点，用「带点的键」区分命令与普通字段。
  for (const m of validation.slice(start, end).matchAll(/'([a-zA-Z][\w]*(?:\.[\w]+)+)':/g)) schemas.add(m[1]);
}

// ---------- 命令：引擎实现 ----------
const engineSource = read('engine', 'src', 'main', 'java', 'cn', 'autolabel', 'engine', 'Engine.java');
const engineCommands = new Set();
for (const m of engineSource.matchAll(/case\s+((?:"[^"]*"\s*,?\s*)+)->/g))
  for (const q of m[1].matchAll(/"([^"]*)"/g)) engineCommands.add(q[1]);

// ---------- 命令：main.ts 本地处理（不经过引擎）----------
const mainSource = read('desktop', 'main.ts');
const localCommands = new Set([...mainSource.matchAll(/validated\.command\s*===\s*'([\w.]+)'/g)].map(m => m[1]));
for (const m of mainSource.matchAll(/\['([^']+)'[^\]]*\]\.includes\(validated\.command\)/g))
  for (const q of m[1].matchAll(/'([\w.]+)'/g)) localCommands.add(q[1]);
const localPrefixes = [...mainSource.matchAll(/validated\.command\.startsWith\('([\w.]+)'\)/g)].map(m => m[1]);
const handledLocally = command => localCommands.has(command) || localPrefixes.some(prefix => command.startsWith(prefix));

// 引擎内部命令：桌面在可信路径上直接调用，界面与助手都不应下发；desktop/security.test.ts 断言这些命令被拒绝。
const ENGINE_INTERNAL = new Map([
  ['flow.input.image', '引擎媒体代理读取固定输入图'],
  ['resource.image', '引擎媒体代理读取资源库图片'],
  ['local.model.authorize', '本地执行授权后向引擎登记模型摘要'],
  ['local.model.resolve', '按模型版本取内部信息'],
  ['media.job.resolve', '按任务 ID 取内部信息'],
  ['training.root.pin', '训练根目录占用检查'],
  ['training.job.artifact', '训练产物下载'],
  ['system.suspend', '休眠协调'],
  ['system.resume', '恢复协调'],
]);

for (const command of schemas) {
  if (!engineCommands.has(command) && !handledLocally(command)) fail(`desktop 校验表登记了 ${command}，但引擎没实现、main.ts 也没本地处理，界面调用只会拿到「未开放」`);
}
for (const command of engineCommands) {
  if (!schemas.has(command) && !ENGINE_INTERNAL.has(command)) fail(`引擎实现了 ${command}，但 desktop 校验表未登记且不在内部命令白名单；新增命令要么开放给界面，要么在脚本里声明为内部命令`);
}
for (const command of ENGINE_INTERNAL.keys()) {
  if (schemas.has(command)) fail(`内部命令 ${command} 出现在 desktop 校验表中，等于直接开放给界面`);
}
const desktopSources = walk(path.join(root, 'desktop'), file => /\.ts$/.test(file) && !/\.test\.ts$/.test(file))
  .map(file => readFileSync(file, 'utf8')).join('\n');
for (const command of ENGINE_INTERNAL.keys()) {
  if (!desktopSources.includes(`'${command}'`)) fail(`内部命令白名单里的 ${command} 已无人调用，请删除该条`);
}

// ---------- 命令：界面与助手使用的命令必须已在校验表登记 ----------
const collect = (directory, pattern, exclude) => {
  const used = new Map();
  for (const file of walk(directory, candidate => /\.tsx?$/.test(candidate) && !exclude.test(candidate))) {
    for (const m of readFileSync(file, 'utf8').matchAll(pattern)) used.set(m[1], path.relative(root, file));
  }
  return used;
};
for (const [command, file] of collect(path.join(root, 'renderer', 'src'), /\b(?:request|invoke)\s*(?:<[^>]*>)?\(\s*'([a-zA-Z][\w.]*)'/g, /\.(?:test|spec)\.tsx?$/)) {
  if (!schemas.has(command)) fail(`${file} 调用了 ${command}，但 desktop 校验表未登记`);
}
const agentCommands = collect(path.join(root, 'agent'), /\.request\s*(?:<[^>]*>)?\(\s*'([a-zA-Z][\w.]*)'/g, /\.test\.ts$/);
for (const [command, file] of agentCommands) {
  if (!schemas.has(command)) fail(`${file} 调用了 ${command}，但 desktop 校验表未登记`);
}
for (const command of agentCommands.keys()) {
  if (ENGINE_INTERNAL.has(command)) fail(`助手调用了内部命令 ${command}，桌面会拒绝，工具应改用开放命令`);
}

// ---------- 事件：引擎发射的静态事件类型 ----------
// 取事件类型实参（到第一个顶层逗号为止），据此区分字面量、三元表达式与动态拼接。
function typeExpressions(source, needle) {
  const found = [];
  let index = 0;
  while ((index = source.indexOf(needle, index)) !== -1) {
    let cursor = index + needle.length;
    let depth = 0;
    let quoted = false;
    let expression = '';
    for (; cursor < source.length; cursor++) {
      const char = source[cursor];
      if (quoted) { expression += char; if (char === '"') quoted = false; continue; }
      if (char === '"') { quoted = true; expression += char; continue; }
      if ('([{'.includes(char)) depth++;
      else if (')]}'.includes(char)) { if (depth === 0) break; depth--; }
      else if (char === ',' && depth === 0) break;
      expression += char;
    }
    found.push(expression.trim());
    index = cursor;
  }
  return found;
}

const engineDirectory = path.join(root, 'engine', 'src', 'main', 'java', 'cn', 'autolabel', 'engine');
const emitted = new Set();
const dynamicPrefixes = new Set();
const classify = (expression, prefix) => {
  const single = /^"([^"]+)"$/.exec(expression);
  if (single) { emitted.add(prefix + single[1]); return; }
  const concatenated = /^"([^"]*)"\s*\+/.exec(expression);
  if (concatenated) { dynamicPrefixes.add(prefix + concatenated[1]); return; }
  // 三元表达式（如 status==="ready"?"engine.resumed":"engine.suspended"）两端都是真实事件类型。
  for (const literal of expression.matchAll(/"([^"]+)"/g)) emitted.add(prefix + literal[1]);
};
for (const file of walk(engineDirectory, candidate => candidate.endsWith('.java') && !candidate.includes('Test'))) {
  const text = readFileSync(file, 'utf8');
  for (const expression of typeExpressions(text, 'Store.event(c,')) classify(expression, '');
  for (const expression of typeExpressions(text, 'Store.flowEvent(c,')) classify(expression, '');
  for (const expression of typeExpressions(text, 'TrackTimelines.event(c,')) classify(expression, 'track.');
  // TrackTimelines.event 自身用裸 event(c,...) 发事件，类型同样带 track. 前缀。
  // 负向前瞻排除 TrackTimelines.event(c,...)，否则会重复并拼出 track.track.。
  if (path.basename(file) === 'TrackTimelines.java')
    for (const expression of typeExpressions(text.replace(/(?<![.\w])event\(c,/g, '\u0000event(c,'), '\u0000event(c,')) classify(expression, 'track.');
}

const eventNames = read('renderer', 'src', 'eventNames.ts');
const known = new Set([...eventNames.matchAll(/'([^']+)':/g)].map(m => m[1]));

// 引擎里以 "前缀"+变量 拼接的事件族：取值随状态机变化，静态只能核对族是否已登记。
const DYNAMIC_EVENT_PREFIXES = new Set([
  'call.', 'dataset.version.', 'flow.', 'flow.step.', 'media.job.', 'run.', 'sample.', 'track.', 'track.generation.', 'training.job.',
]);
for (const type of emitted) if (!known.has(type)) fail(`引擎会发射事件 ${type}，但 renderer/src/eventNames.ts 没有中文名，界面只会显示「其他事件」`);
for (const prefix of dynamicPrefixes) if (!DYNAMIC_EVENT_PREFIXES.has(prefix)) fail(`引擎新增了动态事件族 "${prefix}"+变量，请在脚本里登记该前缀并在 eventNames.ts 补上具体取值`);
for (const prefix of DYNAMIC_EVENT_PREFIXES) if (!dynamicPrefixes.has(prefix)) fail(`脚本登记的动态事件族 ${prefix} 引擎已不再发射，请删除该条`);
for (const type of known) {
  if (emitted.has(type)) continue;
  if ([...dynamicPrefixes].some(prefix => type.startsWith(prefix))) continue;
  fail(`renderer/src/eventNames.ts 的 ${type} 已不再由引擎发射，请删除或更正`);
}

if (failures.length) {
  console.error(`跨层契约检查失败（${failures.length} 项）：`);
  for (const message of failures) console.error(` - ${message}`);
  process.exit(1);
}
console.log(`跨层契约检查通过：命令 校验表 ${schemas.size} / 引擎 ${engineCommands.size} / 内部 ${ENGINE_INTERNAL.size} / 助手 ${agentCommands.size}；事件 ${emitted.size} 种 + ${dynamicPrefixes.size} 族`);