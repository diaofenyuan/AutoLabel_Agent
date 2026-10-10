#!/usr/bin/env python3
"""把本地已打包的安装包发布到更新服务器，并生成客户端可消费的更新清单。

用法：
    python scripts/publish-update.py --package build/release/AutoLabel-Setup-0.1.1-x64.exe \
        --notes "修复若干问题"

设计要点：
1) 清单字段与 desktop/updater.ts 的 manifestSchema 严格对齐（schemaVersion/appId/platform/arch/
   version/releaseNotes/downloadUrl/sha256/size/publishedAt），任一字段不符客户端会直接拒绝更新。
2) 先传安装包、再原子替换清单。顺序反了会让客户端拿到指向尚未上传完成的包的清单，导致下载失败。
3) sha256 与 size 一律实测，不接受人工填写，避免手误造成客户端校验失败。
4) 上传后在服务器端复核大小与摘要，再从公网地址回读清单：磁盘写对不等于客户端能拿到。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import subprocess
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import paramiko

ROOT = Path(__file__).resolve().parent.parent

# 发布目标可用环境变量覆盖，便于将来换服务器而不必改代码。
HOST = os.environ.get("AUTOLABEL_UPDATE_HOST", "139.196.148.174")
BASE_URL = os.environ.get("AUTOLABEL_UPDATE_BASE_URL", f"https://{HOST}")
REMOTE_ROOT = os.environ.get("AUTOLABEL_UPDATE_REMOTE_ROOT", "/var/www/autolabel-update")
SSH_USER = os.environ.get("AUTOLABEL_UPDATE_SSH_USER", "autolabel-publisher")
SSH_PASSWORD = os.environ.get("AUTOLABEL_UPDATE_SSH_PASSWORD")
SSH_PORT = int(os.environ.get("AUTOLABEL_UPDATE_SSH_PORT", "22"))

# 与 updater.ts 中 manifestSchema 的约束保持一致。
APP_ID = "com.autolabel.assistant"
PLATFORM = "win32"
ARCH = "x64"
# 客户端 verifyUpdatePackage 要求安装包的版本资源与这两个值精确一致。
PRODUCT_NAME = "自动标注小助手"
COMPANY_NAME = "AutoLabel"
VERSION_PATTERN = re.compile(r"^AutoLabel-Setup-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-x64\.exe$")


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_exe_identity(path: Path) -> dict:
    """读取安装包的版本资源。客户端安装前会用同样的字段比对（见 update-package.ts），
    这里在发布侧先自查，能避免把一个身份不符的包推给所有用户。"""
    if os.name != "nt":
        return {}
    script = (
        # 显式把管道编码设为 UTF-8：默认编码在中文系统上是 GBK，中文产品名会导致 Python 侧解码失败，
        # 进而在发布时静默跳过身份自查。
        "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);"
        "$v=(Get-Item -LiteralPath $env:AUTOLABEL_PKG).VersionInfo;"
        "@{ productName=$v.ProductName; productVersion=$v.ProductVersion; companyName=$v.CompanyName }|ConvertTo-Json -Compress"
    )
    env = dict(os.environ, AUTOLABEL_PKG=str(path))
    try:
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True, timeout=60, env=env, check=True,
        )
        # 不指定编码，按 UTF-8 显式解码；PowerShell 已在脚本内保证输出为 UTF-8。
        return json.loads(result.stdout.decode("utf-8", "replace").strip().lstrip("﻿"))
    except Exception as error:  # 读取失败不应阻断发布，身份问题由客户端侧兜底校验
        print(f"警告：读取安装包身份信息失败（{error}），跳过本地自查", file=sys.stderr)
        return {}


def version_key(version: str) -> tuple:
    """把版本号转成可比较的元组。发布前用它挡住版本回退：
    线上版本比新包新时发布，会让已升级的用户被判为「已是最新」而拿不到修复。

    预发布标识符的排序规则与 updater.ts 的 compareVersions 保持一致：纯数字段按数值比较
    （否则 rc.10 会被字符串比较判成小于 rc.2），数字段小于非数字段。
    """
    core, _, prerelease = version.partition("-")
    numbers = [int(part) for part in core.split(".")]
    while len(numbers) < 3:
        numbers.append(0)

    # 用元组化的标识符序列表达预发布顺序：空元组代表正式版，排在所有预发布版之后。
    tags: tuple = ()
    if prerelease:
        parts = []
        for item in prerelease.split("."):
            if item.isdigit():
                # (0, 数值, "") 让纯数字段始终小于非数字段 (1, 0, 字符串)。
                parts.append((0, int(item), ""))
            else:
                parts.append((1, 0, item))
        tags = tuple(parts)

    return (numbers[0], numbers[1], numbers[2], 0 if prerelease else 1, tags)


def fetch_live_manifest() -> dict | None:
    """读取线上清单。取不到时返回 None：首次发布或网络异常都不应阻断发布。"""
    try:
        request = urllib.request.Request(f"{BASE_URL}/update-manifest.json", headers={"Cache-Control": "no-cache"})
        with urllib.request.urlopen(request, timeout=15) as response:
            return json.loads(response.read().decode("utf-8"))
    except Exception:
        return None


class Remote:
    """对 paramiko 的薄封装：执行命令与上传文件，统一抛错。"""

    def __init__(self) -> None:
        self.client = paramiko.SSHClient()
        # 发布目标是自有服务器，首次连接记录主机指纹即可；此处不追求严格主机密钥校验。
        self.client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        self.client.connect(
            HOST, port=SSH_PORT, username=SSH_USER, password=SSH_PASSWORD,
            timeout=20, banner_timeout=60, auth_timeout=60,
        )

    def run(self, command: str) -> str:
        _, stdout, stderr = self.client.exec_command(command, timeout=300)
        out = stdout.read().decode("utf-8", "replace")
        err = stderr.read().decode("utf-8", "replace")
        code = stdout.channel.recv_exit_status()
        if code != 0:
            raise RuntimeError(f"远程命令失败({code})：{command}\n{err or out}")
        return out

    def put(self, local: Path, remote: str) -> None:
        sftp = self.client.open_sftp()
        try:
            sftp.put(str(local), remote, confirm=True)
        finally:
            sftp.close()

    def close(self) -> None:
        self.client.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="发布安装包并生成更新清单")
    parser.add_argument("--package", required=True, help="安装包路径")
    parser.add_argument("--notes", default=None, help="更新说明")
    parser.add_argument("--dry-run", action="store_true", help="只生成清单，不上传")
    parser.add_argument("--allow-downgrade", action="store_true", help="允许发布低于线上版本的包（用于回滚）")
    args = parser.parse_args()

    installer = (ROOT / args.package).resolve() if not Path(args.package).is_absolute() else Path(args.package)
    if not installer.is_file():
        print(f"安装包不存在：{installer}", file=sys.stderr)
        return 1

    # 版本号以安装包文件名为准，避免与 package.json 版本脱节。
    match = VERSION_PATTERN.match(installer.name)
    if not match:
        print(f"安装包文件名不符合 AutoLabel-Setup-<version>-x64.exe：{installer.name}", file=sys.stderr)
        return 1
    version = match.group(1)

    # 本地自查安装包身份：客户端安装前会严格比对这三项，不符会直接拒绝安装。
    identity = read_exe_identity(installer)
    if identity:
        problems = []
        if identity.get("productName") != PRODUCT_NAME:
            problems.append(f"productName={identity.get('productName')!r}")
        if identity.get("companyName") != COMPANY_NAME:
            problems.append(f"companyName={identity.get('companyName')!r}")
        if identity.get("productVersion") != version:
            problems.append(f"productVersion={identity.get('productVersion')!r}（清单按文件名推断为 {version}）")
        if problems:
            print(f"安装包身份与发布清单不一致，已中止发布：{'；'.join(problems)}", file=sys.stderr)
            return 1
        print(f"安装包身份校验通过：{PRODUCT_NAME} / {COMPANY_NAME} / {version}")

    # 挡住版本回退：把更旧的版本推上线，会让已升级的用户被判为「已是最新」。
    live = fetch_live_manifest()
    if live and live.get("version"):
        live_version = live["version"]
        if version_key(version) <= version_key(live_version) and not args.allow_downgrade:
            print(
                f"拒绝发布：待发布版本 {version} 不高于线上版本 {live_version}。"
                f"如确需回滚，请显式加 --allow-downgrade。",
                file=sys.stderr,
            )
            return 1
        print(f"线上当前版本：{live_version}")

    print(f"计算安装包摘要：{installer.name}（{installer.stat().st_size / 1024 / 1024:.1f} MB）")
    sha256 = sha256_of(installer)
    size = installer.stat().st_size

    manifest = {
        "schemaVersion": 1,
        "appId": APP_ID,
        "platform": PLATFORM,
        "arch": ARCH,
        "version": version,
        "releaseNotes": args.notes or f"发布 {version}",
        "downloadUrl": f"{BASE_URL}/packages/{installer.name}",
        "sha256": sha256,
        "size": size,
        "publishedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    payload = json.dumps(manifest, ensure_ascii=False, indent=2)
    print(payload)

    if args.dry_run:
        print("\n--dry-run：清单已生成，未上传。")
        return 0

    if not SSH_PASSWORD:
        print("缺少 AUTOLABEL_UPDATE_SSH_PASSWORD 环境变量", file=sys.stderr)
        return 1

    remote = Remote()
    try:
        remote_dir = f"{REMOTE_ROOT}/packages"
        remote_path = f"{remote_dir}/{installer.name}"
        remote.run(f"mkdir -p {remote_dir}")

        print(f"上传安装包到 {remote_path} …")
        remote.put(installer, remote_path)

        # 服务器端复核大小与摘要：本地到服务器的链路上一旦发生截断或损坏，
        # 客户端会在下载后校验失败并丢弃安装包，用户看到的是「更新一直失败」，这里提前拦住。
        remote_size = int(remote.run(f"stat -c %s {remote_path}").strip())
        if remote_size != size:
            raise RuntimeError(f"服务器上的安装包大小异常：期望 {size}，实际 {remote_size}")
        remote_hash = remote.run(f"sha256sum {remote_path} | cut -d' ' -f1").strip()
        if remote_hash != sha256:
            raise RuntimeError(f"服务器上的安装包摘要异常：期望 {sha256}，实际 {remote_hash}")
        print("服务器端大小与摘要校验通过。")

        # 清单原子替换：先写临时文件再 rename，避免客户端在写入过程中读到半截 JSON。
        tmp_path = f"{REMOTE_ROOT}/.update-manifest.json.tmp"
        remote.run(f"cat > {tmp_path} <<'AUTOLABEL_MANIFEST_EOF'\n{payload}\nAUTOLABEL_MANIFEST_EOF")
        remote.run(f"chmod 644 {tmp_path} && mv {tmp_path} {REMOTE_ROOT}/update-manifest.json")

        # 从公网地址回读一次，确认 nginx 真的把新版本发出去，而不是只写到了磁盘。
        request = urllib.request.Request(f"{BASE_URL}/update-manifest.json", headers={"Cache-Control": "no-cache"})
        with urllib.request.urlopen(request, timeout=30) as response:
            served = json.loads(response.read().decode("utf-8"))
        if served.get("version") != version or served.get("sha256") != sha256:
            raise RuntimeError(f"线上回读的清单与预期不一致：{served}")

        print(f"\n发布完成：{version}")
        print(f"  清单地址：{BASE_URL}/update-manifest.json")
        print(f"  安装包：  {manifest['downloadUrl']}")
        print(f"  摘要：    {sha256}")
        return 0
    finally:
        remote.close()


if __name__ == "__main__":
    sys.exit(main())
