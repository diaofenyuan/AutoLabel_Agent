/**
 * 一键准备本地推理环境。
 *
 * 目标：用户不装 Python 依赖也能用本机模型。流程是「探测已有解释器 → 建独立虚拟环境 →
 * 从国内镜像装固定版本依赖 → 交给引擎检测」。依赖版本写死在这里，界面、主进程与验收共用一份，
 * 避免出现「说明里写 2.5.1、实际装的是别的」。
 */
export interface RuntimeDependency {
  name: string;
  version: string;
  /** 一句话说明它在做什么，首次出现时给不懂术语的人一个直白解释。 */
  note: string;
}

/** 固定版本：与仓库里已验证过的运行环境对齐，不跟随上游最新版漂移。 */
export const RUNTIME_DEPENDENCIES: RuntimeDependency[] = [
  { name: 'torch', version: '2.5.1', note: 'PyTorch，模型真正跑起来的计算库（CPU 版）' },
  { name: 'torchvision', version: '0.20.1', note: '与 PyTorch 配套的图像处理库，版本必须成对' },
  { name: 'ultralytics', version: '8.3.247', note: 'YOLO 系列模型的加载与推理实现' },
];

/** 国内 PyPI 镜像；装依赖要几百 MB，直连官方源在国内通常下不动。 */
export const RUNTIME_INDEX_URL = 'https://pypi.tuna.tsinghua.edu.cn/simple';

/** 只接受这三个小版本：再低装不了新依赖，再高本轮没有验证过。 */
export const RUNTIME_PYTHON_MINORS = ['3.10', '3.11', '3.12'];

export type RuntimeSetupPhase = 'idle' | 'probing' | 'creating' | 'installing' | 'verifying' | 'configuring' | 'ready' | 'failed';

export const RUNTIME_SETUP_PHASE_NAMES: Record<RuntimeSetupPhase, string> = {
  idle: '尚未准备',
  probing: '正在查找本机 Python',
  creating: '正在创建独立环境',
  installing: '正在安装推理依赖',
  verifying: '正在核对依赖版本',
  configuring: '正在交给引擎检测',
  ready: '环境已就绪',
  failed: '准备未完成',
};

export interface RuntimeSetupDependencyState {
  name: string;
  version: string;
  note: string;
  /** 装完后实测到的版本；与期望不一致会在界面上直接标出来。 */
  installed?: string;
}

export interface RuntimeSetupState {
  phase: RuntimeSetupPhase;
  /** 面向用户的一句话进度，直接显示，不需要界面再翻译。 */
  message: string;
  /** 虚拟环境目录；未创建时为空。 */
  environment?: string;
  /** 探测到的系统 Python 与版本。 */
  basePython?: string;
  pythonVersion?: string;
  indexUrl: string;
  dependencies: RuntimeSetupDependencyState[];
  /** 最近若干行安装输出，失败时用来定位，不写入任何日志文件。 */
  log: string[];
  startedAt?: string;
  finishedAt?: string;
  error?: { code: string; message: string };
}

export function runtimeSetupBusy(phase: RuntimeSetupPhase): boolean {
  return ['probing', 'creating', 'installing', 'verifying', 'configuring'].includes(phase);
}
