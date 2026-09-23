import type { DesktopBridge, Annotation, Asset, Project } from '../../shared/protocol';
import type { ChatSessionSummary } from '../../shared/chat';
import type { Provider, Resource } from './types';
import { defaultPreferences } from './types';

interface DemoData {
  projects: Project[]; assets: Asset[]; providers: Provider[]; resources: Resource[];
  settings: Record<string, unknown>;
}
const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const makeProject = (name: string, taskType: Project['taskType'] = 'detect'): Project => ({
  id: id(), name, description: '', taskType,
  classes: [{ id: 'vehicle', name: '车辆', color: '#4a83ff' }, { id: 'person', name: '行人', color: '#ba6de2' }],
  createdAt: now(), updatedAt: now(), assetCount: 0, annotatedCount: 0, confirmedCount: 0, settings: {},
});
function createExample(data: DemoData): Project {
  const existing = data.projects.find(p => p.settings.demoExample);
  if (existing) return existing;
  const project = makeProject('城市场景 · 人工示例');
  project.description = '合成图片与预置人工框，仅用于体验编辑。';
  project.settings.demoExample = true;
  project.assetCount = 1; project.annotatedCount = 1;
  data.projects.push(project);
  data.assets.push({ id: id(), projectId: project.id, name: 'street_001.png', width: 1586, height: 992,
    contentHash: 'bundled-synthetic-example-v1', status: 'modified', version: 1, source: '预置人工示例 / 合成图片',
    mediaUrl: './example-street.png', thumbnailUrl: './example-street.png',
    annotations: [
      { id: id(), classId: 'vehicle', type: 'detect', bbox: { x: 221, y: 483, width: 537, height: 350 } },
      { id: id(), classId: 'vehicle', type: 'detect', bbox: { x: 771, y: 512, width: 314, height: 202 } },
    ],
  });
  return project;
}
function freshData(): DemoData {
  const data: DemoData = { projects: [], assets: [], providers: [], settings: { ...defaultPreferences }, resources: [
    { id: 'demo-prompt', kind: 'prompt', name: '通用目标检测提示词', content: '识别图片中的目标，严格使用项目类别。返回每个对象的 classId、type 和原图像素 bbox；不可定位时不猜测。', updatedAt: now() },
    { id: 'demo-template', kind: 'template', name: '四点关键点模板', content: { taskType: 'pose', keypointNames: ['左上', '右上', '右下', '左下'] }, updatedAt: now() },
  ] };
  createExample(data);
  return data;
}
const database = new Promise<IDBDatabase>((resolve, reject) => {
  const open = indexedDB.open('autolabel-isolated-demo-v1', 1);
  open.onupgradeneeded = () => open.result.createObjectStore('workspace');
  open.onsuccess = () => resolve(open.result);
  open.onerror = () => reject(new Error('浏览器演示存储不可用，请使用桌面版本。'));
});
async function readData(): Promise<DemoData> {
  const db = await database;
  return new Promise((resolve, reject) => {
    const req = db.transaction('workspace').objectStore('workspace').get('data');
    req.onsuccess = () => {
      if (req.result) { resolve(req.result); return; }
      // 请求队列串行初始化；首次读取就持久化 ID，下一条打开命令才能引用同一项目。
      const seeded = freshData();
      void writeData(seeded).then(() => resolve(seeded), reject);
    };
    req.onerror = () => reject(req.error);
  });
}
async function writeData(data: DemoData) {
  const db = await database;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('workspace', 'readwrite');
    tx.objectStore('workspace').put(data, 'data');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(new Error('浏览器存储失败，当前改动尚未保存。'));
    tx.onabort = () => reject(new Error('浏览器存储事务中断。'));
  });
}
let queue = Promise.resolve();
const files = new Map<string, File>();
/** 演示模式的对话记录只留在当前浏览器内存，不落盘；桌面版本才写入 chats 目录。 */
const demoChatSessions: ChatSessionSummary[] = [];
function chooseImages(): Promise<string[]> {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/png,image/jpeg'; input.multiple = true;
    input.onchange = () => resolve(Array.from(input.files ?? []).map(file => { const key = id(); files.set(key, file); return key; }));
    input.oncancel = () => resolve([]);
    input.click();
  });
}
async function fileImage(file: File) {
  const url = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file); });
  const image = new Image(); image.src = url; await image.decode();
  return { url, width: image.naturalWidth, height: image.naturalHeight };
}
async function dispatch(command: string, p: Record<string, unknown>): Promise<unknown> {
  const data = await readData();
  const project = data.projects.find(item => item.id === p.projectId);
  const asset = data.assets.find(item => item.id === p.assetId);
  let result: unknown;
  switch (command) {
    case 'project.list': return data.projects;
    case 'project.open': if (!project) throw new Error('项目不存在。'); return project;
    case 'project.example': result = createExample(data); break;
    case 'project.create': {
      const created = makeProject(String(p.name), p.taskType as Project['taskType']);
      created.description = String(p.description ?? '');
      if (Array.isArray(p.classes) && p.classes.length) created.classes = p.classes as Project['classes'];
      data.projects.push(created); result = created; break;
    }
    case 'project.update': {
      if (!project) throw new Error('项目不存在。');
      for (const key of ['name', 'description', 'classes'] as const) if (p[key] !== undefined) Object.assign(project, { [key]: p[key] });
      if (p.settings) project.settings = { ...project.settings, ...(p.settings as Record<string, unknown>) };
      project.updatedAt = now(); result = project; break;
    }
    case 'asset.list': { const list = data.assets.filter(item => item.projectId === p.projectId && (!p.status || item.status === p.status)); return { items: list.slice(Number(p.offset ?? 0), Number(p.offset ?? 0) + Number(p.limit ?? 500)), total: list.length }; }
    case 'asset.get': if (!asset) throw new Error('素材不存在。'); return asset;
    case 'asset.import': {
      if (!project) throw new Error('请先打开项目。');
      const errors: string[] = []; let imported = 0;
      for (const path of p.paths as string[]) {
        const file = files.get(path); if (!file) { errors.push('文件选择已失效，请重新选择。'); continue; }
        try {
          if (!['image/png', 'image/jpeg'].includes(file.type)) throw new Error('仅支持 PNG 和 JPEG');
          if (file.size > 32 * 1024 * 1024) throw new Error('演示单图上限为 32 MB');
          const image = await fileImage(file);
          data.assets.push({ id: id(), projectId: project.id, name: file.name, width: image.width, height: image.height,
            mediaUrl: image.url, thumbnailUrl: image.url, contentHash: id(), source: '浏览器导入，仅存于当前浏览器', status: 'unlabeled', annotations: [], version: 0 });
          imported++; files.delete(path);
        } catch (e) { errors.push(`${file.name}：${e instanceof Error ? e.message : '解码失败'}`); }
      }
      result = { imported, skipped: 0, errors }; break;
    }
    case 'annotation.save':
    case 'annotation.draft': {
      if (!asset) throw new Error('素材不存在。');
      if (asset.version !== p.baseVersion) throw new Error('素材已被更新，请重新打开图片后合并改动。');
      if (command === 'annotation.draft') { asset.draft = p.annotations as Annotation[]; result = { savedAt: now() }; }
      else { asset.annotations = p.annotations as Annotation[]; delete asset.draft; asset.version++; asset.status = p.confirm ? 'confirmed' : 'modified'; result = asset; }
      break;
    }
    case 'chat.history.list': return { sessions: [...demoChatSessions].sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt)), total: demoChatSessions.length };
    case 'chat.history.get': { const found = demoChatSessions.find(item => item.id === p.sessionId); if (!found) throw new Error('对话不存在或已删除。'); return { ...found, messages: [] }; }
    case 'chat.history.status': return { root: '浏览器演示（仅内存）', sessions: demoChatSessions.length, messages: demoChatSessions.reduce((sum, item) => sum + item.messageCount, 0), bytes: 0, trash: { entries: 0, bytes: 0, retentionDays: 7 } };
    case 'chat.history.trash.list': return { entries: [], retentionDays: 7 };
    case 'chat.history.ensure': {
      const sessionId = String(p.sessionId);
      let session = demoChatSessions.find(item => item.id === sessionId);
      if (!session) {
        session = { id: sessionId, title: String(p.title ?? '新对话') || '新对话', titleSource: 'auto', pinned: false, pinOrder: 0,
          ...(typeof p.projectId === 'string' && p.projectId ? { projectId: p.projectId } : {}), providerId: '', model: '',
          createdAt: now(), updatedAt: now(), lastMessageAt: now(), messageCount: 0, status: 'active' };
        demoChatSessions.push(session);
      }
      return session;
    }
    case 'chat.history.rename': { const session = demoChatSessions.find(item => item.id === p.sessionId); if (!session) throw new Error('对话不存在或已删除。'); session.title = String(p.title); session.titleSource = 'user'; session.updatedAt = now(); return session; }
    case 'chat.history.pin': { const session = demoChatSessions.find(item => item.id === p.sessionId); if (!session) throw new Error('对话不存在或已删除。'); session.pinned = p.pinned === true; session.pinOrder = session.pinned ? Math.max(0, ...demoChatSessions.map(item => item.pinOrder)) + 1 : 0; return session; }
    case 'chat.history.delete': { const ids = new Set(p.sessionIds as string[]); const removed = demoChatSessions.filter(item => ids.has(item.id)).length; for (let i = demoChatSessions.length - 1; i >= 0; i--) if (ids.has(demoChatSessions[i].id)) demoChatSessions.splice(i, 1); return { removed }; }
    case 'chat.history.clear': { const removed = demoChatSessions.length; demoChatSessions.length = 0; return { removed }; }
    case 'chat.history.restore': case 'chat.history.purge': return { removed: 0, restored: 0 };
    case 'chat.history.export': throw new Error('浏览器演示不支持导出对话记录，请在桌面版本中使用。');
    case 'provider.list': return data.providers;
    case 'provider.save': {
      const provider: Provider = { id: String(p.id || id()), name: String(p.name), baseUrl: String(p.baseUrl), protocol: String(p.protocol), model: String(p.model ?? ''), hasCredential: false };
      data.providers = [...data.providers.filter(item => item.id !== provider.id), provider]; result = provider; break;
    }
    case 'credential.set': throw new Error('演示模式不保存 API Key。请在桌面版本中安全配置。');
    case 'provider.models': case 'provider.test': case 'provider.testAll': case 'run.create': case 'agent.chat': case 'chat.send':
      throw new Error('当前是隔离的浏览器演示，未连接模型或 Java 引擎。请在桌面版本使用此功能。');
    case 'agent.cancel': return { status: 'cancelled' };
    case 'run.list': case 'event.list': case 'export.list': return [];
    case 'review.suggestions': return { confidenceThreshold: null, trainingSuggestion: { assetIds: [], count: 0, reason: '演示模式没有复核数据；桌面版会在复核与评测后给出送训建议（只建议不自动改）。' } };
    case 'event.snapshot': return { sequence: 0 };
    case 'resource.list': return data.resources.filter(item => !p.kind || item.kind === p.kind);
    case 'resource.save': {
      const resource: Resource = { id: String(p.id || id()), kind: String(p.kind), name: String(p.name), content: p.content, updatedAt: now() };
      data.resources = [...data.resources.filter(item => item.id !== resource.id), resource]; result = resource; break;
    }
    case 'settings.get': return data.settings;
    case 'settings.save': data.settings = { ...data.settings, ...(p.settings as Record<string, unknown>) }; result = data.settings; break;
    case 'diagnostics.get': return { mode: '浏览器演示', storage: '当前浏览器 IndexedDB', engine: '未连接', apiCalls: 0 };
    case 'export.preflight': return { issues: [], summary: { assets: data.assets.filter(item => item.projectId === p.projectId && (!Array.isArray(p.assetIds) || p.assetIds.includes(item.id))).length, note: '浏览器演示仅下载内部 JSON，YOLO 数据集由桌面引擎导出。' } };
    case 'export.format.list': return demoExportFormats(String(p.taskType ?? 'detect'));
    case 'export.format.get': return demoExportFormats(String(p.taskType ?? 'detect'))[0];
    case 'export.format.save': case 'export.format.delete':
      throw new Error('浏览器演示不保存导出格式模板，请在桌面版本中管理。');
    case 'media.recipe.list': return [];
    case 'media.recipe.save': case 'media.recipe.delete':
      throw new Error('浏览器演示不保存抽帧配方，请在桌面版本中管理。');
    case 'export.create': {
      const selected = data.assets.filter(item => item.projectId === p.projectId && (!Array.isArray(p.assetIds) || p.assetIds.includes(item.id)) && (!p.onlyConfirmed || item.status === 'confirmed'));
      if (!selected.length) throw new Error('没有符合条件的素材。');
      const blob = new Blob([JSON.stringify({ format: 'autolabel-demo-v1', project, assets: selected }, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'autolabel-demo.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      return { id: id(), path: '', status: 'demo_download' };
    }
    default: throw new Error(`演示模式尚不支持操作：${command}`);
  }
  for (const item of data.projects) {
    const assets = data.assets.filter(a => a.projectId === item.id);
    item.assetCount = assets.length; item.annotatedCount = assets.filter(a => a.annotations.length > 0).length; item.confirmedCount = assets.filter(a => a.status === 'confirmed').length;
  }
  await writeData(data);
  return result;
}
/** 演示模式只回放内置预设的可读摘要；真正的路径模板校验与落盘仍由桌面引擎完成。 */
function demoExportFormats(taskType: string) {
  const support: Record<string, string[]> = { yolo: ['detect', 'obb', 'segment', 'pose', 'classify'], coco: ['detect', 'segment', 'pose'], voc: ['detect'], csv: ['detect', 'obb', 'segment', 'pose', 'classify'] };
  const names: Record<string, string> = { yolo: 'YOLO 文本标签', coco: 'COCO JSON', voc: 'Pascal VOC XML', csv: '平铺 CSV 索引' };
  const classify = taskType === 'classify';
  return Object.keys(support).filter(format => support[format].includes(taskType)).map(format => ({
    id: `builtin:${format}`, version: 1, name: names[format], category: '内置预设', builtin: true, source: 'builtin', taskType,
    note: '浏览器演示不执行导出，仅展示可选格式。',
    labelFormat: format, precision: 8, naming: 'assetId', includeDataYaml: format === 'yolo' && !classify, cocoFileName: '{name}.png', csvBom: true, csvColumns: [],
    layout: { image: 'images/{split}/{name}.png', classifyImage: '{split}/{classId4}/{name}.png',
      label: classify ? '' : format === 'voc' ? 'annotations/{name}.xml' : format === 'yolo' ? 'labels/{split}/{name}.txt' : '',
      index: format === 'coco' ? 'annotations/instances_{split}.json' : format === 'csv' ? 'annotations.csv' : format === 'voc' ? 'ImageSets/{split}.txt' : '' },
  }));
}
export const demoBridge: DesktopBridge = {
  request<T>(command: string, payload: Record<string, unknown> = {}): Promise<T> {
    // 串行提交演示写入，避免自动草稿和确认保存互相覆盖。
    const result = queue.then(() => dispatch(command, payload));
    queue = result.then(() => {}, () => {});
    return result as Promise<T>;
  },
  onEvent: () => () => {}, onEngineStatus: () => () => {},
  engineStatus: async () => ({ state: 'disconnected', message: '浏览器演示 · 未连接引擎' }),
  restartEngine: async () => ({ state: 'disconnected', message: '请在桌面应用中启动本地引擎。' }),
  setWindowDirty: async () => {},
  chooseFiles: options => options.kind === 'images' ? chooseImages() : Promise.reject(new Error('目录、视频与模型文件请选择桌面版本。')),
  // 浏览器里没有真实文件系统：目录枚举只属于桌面能力，演示态如实拒绝而不是返回假数据。
  listDirectory: async () => { throw new Error('列出目录内容需要桌面版本。'); },
  transcodeVideo: async () => { throw new Error('转码需要桌面版本调用本机 FFmpeg。'); },
  discardTranscode: async () => {},
  saveFile: async () => null,
  openPath: async () => { throw new Error('浏览器不能打开本地目录。'); },
  windowAction: async () => {},
};
