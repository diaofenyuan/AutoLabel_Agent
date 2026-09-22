import { spawn } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  RUNTIME_DEPENDENCIES, RUNTIME_INDEX_URL, RUNTIME_PYTHON_MINORS,
  type RuntimeSetupPhase, type RuntimeSetupState,
} from '../shared/runtime-setup';
import { ensurePythonEnvRoot } from './storage-paths';
import { DesktopError } from './validation';

/** 依赖含 PyTorch，体积与耗时都按最坏情况留量；总时长有上限，超时即中止而不是无限等。 */
const INSTALL_TIMEOUT_MS = 30 * 60 * 1000;
const PROBE_TIMEOUT_MS = 20000;
const VERIFY_TIMEOUT_MS = 120000;
const LOG_LINES = 40;
/** 镜像地址可由验收替换成不可达地址，用来验证「装不上时明确失败、且不动原有配置」。 */
const setupIndexUrl = () => process.env.AUTOLABEL_RUNTIME_INDEX_URL || RUNTIME_INDEX_URL;

/** 候选解释器按「版本明确 → 泛指」排列，避免装了 3.13 的机器上被 `py -3` 抢先命中。 */
const CANDIDATES: Array<{ label: string; command: string; args: string[] }> = [
  { label: 'py -3.11', command: 'py', args: ['-3.11'] },
  { label: 'py -3.12', command: 'py', args: ['-3.12'] },
  { label: 'py -3.10', command: 'py', args: ['-3.10'] },
  { label: 'py -3', command: 'py', args: ['-3'] },
  { label: 'python', command: 'python', args: [] },
];

const PROBE_SCRIPT = 'import json,sys;print(json.dumps({"executable":sys.executable,"version":"%d.%d.%d"%sys.version_info[:3],"minor":"%d.%d"%sys.version_info[:2]}))';

interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }

/**
 * 子进程统一出口：输出逐行回调（pip 的进度是行式的），总超时到点即杀。
 * 清掉 PYTHONHOME/PYTHONPATH 一类变量：外部环境注入的解释器路径会让新建的 venv 指向别处，
 * 出现「装好了但 import 不到」这种最难查的故障。
 */
function run(command: string, args: string[], options: { timeoutMs: number; env?: Record<string, string>; onLine?: (line: string) => void }): Promise<RunResult> {
  return new Promise(resolve => {
    const env: NodeJS.ProcessEnv = { ...process.env, ...options.env };
    for (const key of ['PYTHONHOME', 'PYTHONPATH', 'PYTHONSTARTUP', 'VIRTUAL_ENV']) delete env[key];
    const child = spawn(command, args, { windowsHide: true, env });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, options.timeoutMs);
    const collect = (target: 'stdout' | 'stderr') => (chunk: Buffer) => {
      const text = chunk.toString('utf8').replace(/\r/g, '\n');
      if (target === 'stdout') stdout += text; else stderr += text;
      if (!options.onLine) return;
      for (const line of text.split('\n')) if (line.trim()) options.onLine(line.trim());
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    child.on('error', error => { clearTimeout(timer); resolve({ code: null, stdout, stderr: `${stderr}${error.message}`, timedOut }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
  });
}

/**
 * 一键准备本地推理环境。
 *
 * 只在用户显式点击时联网：建 <存储根>/python-env，用国内镜像装固定版本依赖，装完把环境记录
 * 写进 autolabel-env.json，最后交给主进程 configure。失败一律保留用户原有的解释器配置——
 * 一次失败的安装不应该让本来能用的环境也消失。
 */
export class RuntimeSetup {
  private state: RuntimeSetupState = this.blank();
  private job?: Promise<void>;
  constructor(private options: {
    /** 存储根；未解析时不给装，避免把几百 MB 装到不知道哪去。 */
    storageRoot: () => string | undefined;
    /** 当前数据目录；保证环境目录不与业务数据互相包含。 */
    dataDirectory: () => string;
    /** 环境就绪后的收尾：由主进程把新解释器交给引擎并写入配置。 */
    onReady: (pythonPath: string) => Promise<void>;
    log?: (message: unknown) => void;
  }) {}

  private blank(): RuntimeSetupState {
    return { phase: 'idle', message: '尚未准备本地推理环境。', indexUrl: setupIndexUrl(),
      dependencies: RUNTIME_DEPENDENCIES.map(dependency => ({ ...dependency })), log: [] };
  }

  /** 状态按值返回，避免调用方改到内部对象。 */
  status(): RuntimeSetupState {
    return { ...this.state, dependencies: this.state.dependencies.map(item => ({ ...item })), log: [...this.state.log],
      ...(this.state.error ? { error: { ...this.state.error } } : {}) };
  }

  private patch(phase: RuntimeSetupPhase, message: string, extra: Partial<RuntimeSetupState> = {}): void {
    this.state = { ...this.state, phase, message, ...extra };
  }

  private appendLog(line: string): void {
    this.state = { ...this.state, log: [...this.state.log, line].slice(-LOG_LINES) };
  }

  private environmentPath(): string {
    const root = this.options.storageRoot();
    if (!root) throw new DesktopError('STORAGE_UNAVAILABLE', '尚未解析存储位置，请到「设置 → 存储位置」确认后再准备本地环境');
    return path.join(root, 'python-env');
  }

  /** 找本机可用的解释器：只认 3.10–3.12，且必须真能跑起来。 */
  private async probePython(): Promise<{ basePython: string; version: string; label: string }> {
    const failures: string[] = [];
    for (const candidate of CANDIDATES) {
      const result = await run(candidate.command, [...candidate.args, '-c', PROBE_SCRIPT], { timeoutMs: PROBE_TIMEOUT_MS });
      if (result.code !== 0) { failures.push(`${candidate.label}：不可用`); continue; }
      const line = result.stdout.split('\n').map(item => item.trim()).find(item => item.startsWith('{'));
      if (!line) { failures.push(`${candidate.label}：输出无法识别`); continue; }
      let parsed: { executable?: string; version?: string; minor?: string };
      try { parsed = JSON.parse(line) as typeof parsed; } catch { failures.push(`${candidate.label}：输出无法解析`); continue; }
      if (!parsed.executable || !parsed.minor) { failures.push(`${candidate.label}：输出不完整`); continue; }
      if (!RUNTIME_PYTHON_MINORS.includes(parsed.minor)) { failures.push(`${candidate.label}：Python ${parsed.version ?? parsed.minor} 不在支持的 ${RUNTIME_PYTHON_MINORS.join(' / ')} 范围内`); continue; }
      return { basePython: parsed.executable, version: parsed.version ?? parsed.minor, label: candidate.label };
    }
    throw new DesktopError('RUNTIME_SETUP_PYTHON_MISSING',
      `没有找到可用的 Python（支持 ${RUNTIME_PYTHON_MINORS.join(' / ')}）。请先安装 Python 官方安装包并勾选 Add to PATH，然后重试。已检查：${failures.join('；')}`);
  }

  /** 依赖装完后的实测：版本对不上就当作没装好，不含糊过去。 */
  private async verify(environment: string): Promise<void> {
    const distributions = RUNTIME_DEPENDENCIES.map(item => item.distributionName ?? item.packageName ?? item.name);
    const script = `import json,importlib.metadata as m;import clip;names=${JSON.stringify(distributions)};print(json.dumps({n:m.version(n) for n in names}))`;
    const result = await run(path.join(environment, 'Scripts', 'python.exe'), ['-c', script], { timeoutMs: VERIFY_TIMEOUT_MS, env: { PYTHONIOENCODING: 'utf-8' } });
    const line = result.stdout.split('\n').map(item => item.trim()).find(item => item.startsWith('{'));
    if (result.code !== 0 || !line) throw new DesktopError('RUNTIME_SETUP_VERIFY_FAILED', '依赖装完后无法导入，环境不完整。请重试；若反复失败，请展开下方输出了解细节。');
    const installed = JSON.parse(line) as Record<string, string>;
    // PyPI 上的 CPU 版轮子自报 2.5.1+cpu 这类本地版本号：比对只认主版本，展示仍用实际值。
    const matches = (expected: string, actual?: string) => !!actual && (actual === expected || actual.split('+')[0] === expected);
    const mismatched = RUNTIME_DEPENDENCIES.filter(dependency => {
      const distribution = dependency.distributionName ?? dependency.packageName ?? dependency.name;
      return !matches(dependency.version, installed[distribution]);
    });
    if (mismatched.length) {
      throw new DesktopError('RUNTIME_SETUP_VERSION_MISMATCH',
        `安装结果与固定版本不一致：${mismatched.map(item => {
          const distribution = item.distributionName ?? item.packageName ?? item.name;
          return `${item.name} 期望 ${item.version}，实际 ${installed[distribution] ?? '未安装'}`;
        }).join('；')}`);
    }
    this.state = { ...this.state, dependencies: this.state.dependencies.map(item => {
      const dependency = RUNTIME_DEPENDENCIES.find(candidate => candidate.name === item.name);
      const distribution = dependency?.distributionName ?? dependency?.packageName ?? item.name;
      return { ...item, installed: installed[distribution] };
    }) };
  }

  /**
   * 启动一键准备。重复调用返回正在进行中的同一份状态，不会并发装两遍。
   * 整个过程在后台跑，界面用 status() 轮询——装 PyTorch 是分钟级操作，不能占住一次请求。
   */
  start(): RuntimeSetupState {
    if (this.job) return this.status();
    let environment: string;
    try { environment = this.environmentPath(); }
    catch (error) {
      const failure = error instanceof DesktopError ? error : new DesktopError('RUNTIME_SETUP_FAILED', '本地环境准备未完成');
      this.state = { ...this.blank(), phase: 'failed', message: failure.message, error: { code: failure.code, message: failure.message } };
      return this.status();
    }
    this.state = { ...this.blank(), phase: 'probing', message: '正在查找本机 Python…', environment, startedAt: new Date().toISOString() };
    this.job = this.runSetup(environment).finally(() => { this.job = undefined; });
    return this.status();
  }

  private async runSetup(environment: string): Promise<void> {
    try {
      await ensurePythonEnvRoot(this.options.storageRoot()!, this.options.dataDirectory());
      const python = await this.probePython();
      this.patch('creating', `已找到 ${python.label}（Python ${python.version}），正在创建独立环境…`, { basePython: python.basePython, pythonVersion: python.version });
      this.appendLog(`使用解释器：${python.basePython}（Python ${python.version}）`);

      // 已有环境不重建：重装依赖比重建整棵树便宜，也避免把上一轮已经下好的几百 MB 再下一次。
      const environmentPython = path.join(environment, 'Scripts', 'python.exe');
      if (await access(environmentPython).then(() => true).catch(() => false)) this.appendLog(`复用已有环境：${environment}`);
      else {
        await mkdir(path.dirname(environment), { recursive: true });
        const created = await run(python.basePython, ['-m', 'venv', environment], { timeoutMs: INSTALL_TIMEOUT_MS, onLine: line => this.appendLog(line) });
        if (created.code !== 0) throw new DesktopError('RUNTIME_SETUP_VENV_FAILED',
          `独立环境创建失败：${created.stderr.trim().split('\n').filter(Boolean).slice(-2).join(' ') || '未知原因'}`);
      }

      this.patch('installing', `正在从国内镜像安装依赖（约 300 MB）：${RUNTIME_DEPENDENCIES.map(item => item.name).join('、')}…`);
      const packages = RUNTIME_DEPENDENCIES.map(dependency => `${dependency.packageName ?? dependency.name}==${dependency.version}`);
      // 镜像回退：主源装不通换阿里云再试；两个源都不通才失败（留日志、不动已有环境）。
      const indices = [...new Set([setupIndexUrl(), 'https://mirrors.aliyun.com/pypi/simple/'])];
      let install: Awaited<ReturnType<typeof run>> | undefined; let usedIndex = indices[0];
      for (const index of indices) {
        usedIndex = index;
        install = await run(environmentPython, ['-m', 'pip', 'install', '--no-input', '--disable-pip-version-check', '--progress-bar', 'off',
          '--index-url', index, ...packages], {
          timeoutMs: INSTALL_TIMEOUT_MS,
          env: { PYTHONIOENCODING: 'utf-8', PIP_INDEX_URL: index },
          onLine: line => {
            this.appendLog(line);
            // pip 输出里只有几行用户看得懂，挑出来当状态文字，其余留在诊断里。
            if (/^Collecting /.test(line)) this.patch('installing', `正在下载 ${line.replace(/^Collecting\s+/, '').trim()}…`);
            else if (/^Installing collected packages/.test(line)) this.patch('installing', '正在安装已下载的依赖…');
          },
        });
        if (install.timedOut) throw new DesktopError('RUNTIME_SETUP_TIMEOUT', `依赖安装超过 ${Math.round(INSTALL_TIMEOUT_MS / 60000)} 分钟未完成，已中止。请检查网络后重试，已下载的部分会复用。`);
        if (install.code === 0) break;
        this.appendLog(`镜像 ${index} 安装失败（退出码 ${install.code}）${index === indices[indices.length - 1] ? '' : '，换下一个镜像重试'}…`);
      }
      if (!install || install.code !== 0) throw new DesktopError('RUNTIME_SETUP_INSTALL_FAILED',
        `依赖安装失败（退出码 ${install?.code ?? '未知'}），已试过 ${indices.length} 个镜像（${indices.join('、')}）。请检查网络后重试，已下载的部分会复用。`);

      this.patch('verifying', '依赖已装完，正在核对版本…');
      await this.verify(environment);
      this.appendLog(`版本核对通过：${this.state.dependencies.map(item => `${item.name} ${item.installed}`).join('、')}`);
      await writeFile(path.join(environment, 'autolabel-env.json'), JSON.stringify({ createdAt: new Date().toISOString(),
        basePython: python.basePython, pythonVersion: python.version, environment, indexUrl: usedIndex,
        dependencies: this.state.dependencies.map(item => ({ name: item.name, version: item.installed })), recordedBy: 'autolabel' }, null, 2));

      this.patch('configuring', '正在交给引擎检测…');
      await this.options.onReady(environmentPython);
      this.state = { ...this.state, phase: 'ready', message: '本地推理环境已就绪，可以直接用本机模型标注。', finishedAt: new Date().toISOString() };
    } catch (error) {
      const failure = error instanceof DesktopError ? error : new DesktopError('RUNTIME_SETUP_FAILED', '本地环境准备未完成');
      this.state = { ...this.state, phase: 'failed', message: failure.message, finishedAt: new Date().toISOString(),
        error: { code: failure.code, message: failure.message } };
      this.appendLog(`[${failure.code}] ${failure.message}`);
      this.options.log?.(`本地推理环境准备未完成：${failure.code}`);
    }
  }

  /** 环境记录文件，用于诊断与回答「这个环境是怎么来的」；没有就返回 null。 */
  async record(): Promise<Record<string, unknown> | null> {
    try { return JSON.parse(await readFile(path.join(this.environmentPath(), 'autolabel-env.json'), 'utf8')) as Record<string, unknown>; }
    catch { return null; }
  }
}
