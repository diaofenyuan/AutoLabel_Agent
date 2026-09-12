import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { DesktopError } from './validation';
import type { UpdateManifest } from './updater';

interface ExecutableIdentity { productName: string; productVersion: string; companyName: string; signature: string; publisher: string | null }
export async function readExecutableIdentity(filename: string): Promise<ExecutableIdentity> {
  const file = await open(filename, 'r');
  try {
    const signature = Buffer.alloc(2); await file.read(signature, 0, 2, 0);
    if (signature.toString('ascii') !== 'MZ') throw new DesktopError('UPDATE_PACKAGE_INVALID', '更新文件不是 Windows 安装程序');
  } finally { await file.close(); }
  // 使用固定系统脚本只读版本资源；路径通过 stdin JSON 传入，不拼接命令，也不执行待验包。
  const script = `$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $p=[Console]::In.ReadToEnd()|ConvertFrom-Json; $v=(Get-Item -LiteralPath $p.path).VersionInfo; $s=Get-AuthenticodeSignature -LiteralPath $p.path; @{ productName=$v.ProductName; productVersion=$v.ProductVersion; companyName=$v.CompanyName; signature=[string]$s.Status; publisher=if($s.SignerCertificate){$s.SignerCertificate.Subject}else{$null} }|ConvertTo-Json -Compress`;
  return new Promise((resolve, reject) => {
    const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    // 从 PowerShell 7 启动应用时不能让其模块目录污染系统 Windows PowerShell 5。
    const env = { ...process.env }; delete env.PSModulePath; delete env.PSModuleAnalysisCachePath;
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env });
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new DesktopError('UPDATE_VERIFY_TIMEOUT', '安装包身份检查超时，请稍后重试')); }, 30000);
    child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { output += chunk; if (output.length > 65536) child.kill(); });
    child.stderr.resume(); child.stdin.on('error', () => undefined);
    child.once('error', () => { clearTimeout(timer); reject(new DesktopError('UPDATE_VERIFY_UNAVAILABLE', '系统安装包验证工具不可用')); });
    child.once('exit', code => {
      clearTimeout(timer);
      if (code !== 0) { reject(new DesktopError('UPDATE_PACKAGE_INVALID', '无法读取安装包身份信息')); return; }
      try { resolve(JSON.parse(output.replace(/^\uFEFF/, '')) as ExecutableIdentity); }
      catch { reject(new DesktopError('UPDATE_PACKAGE_INVALID', '安装包身份信息无效')); }
    });
    child.stdin.end(JSON.stringify({ path: filename }));
  });
}
export async function verifyUpdatePackage(filename: string, manifest: UpdateManifest, trustedPublisher?: string): Promise<void> {
  const info = await readExecutableIdentity(filename);
  if (info.productName !== '自动标注小助手' || info.companyName !== 'AutoLabel' || info.productVersion !== manifest.version) throw new DesktopError('UPDATE_PACKAGE_IDENTITY_MISMATCH', '安装包的应用名称或版本与更新清单不一致');
  if (trustedPublisher && (info.signature !== 'Valid' || info.publisher !== trustedPublisher)) throw new DesktopError('UPDATE_PUBLISHER_MISMATCH', '更新安装包的签名发布者与当前应用不一致');
  if (!['Valid', 'NotSigned'].includes(info.signature)) throw new DesktopError('UPDATE_SIGNATURE_INVALID', '安装包数字签名无效');
}
