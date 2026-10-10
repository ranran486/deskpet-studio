"""手动放置 Electron 二进制。

为什么需要它：npm 的 postinstall 会用管道 spawn 子进程下载解包 Electron，本机 DSH 沙箱禁止
命名管道，`npm install` 因此在 `syscall spawn` 上 EPERM。改用 `npm install --ignore-scripts`
装依赖，再由本脚本用纯 Python（urllib + zipfile，不 spawn 任何进程）把 Electron 运行时放到
node_modules/electron/dist —— 与 electron 自带 install.js 的结果一致。
"""
import json
import hashlib
import pathlib
import shutil
import sys
import urllib.request
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
PKG = ROOT / "node_modules" / "electron" / "package.json"
DIST = ROOT / "node_modules" / "electron" / "dist"
PATH_TXT = ROOT / "node_modules" / "electron" / "path.txt"
CACHE = ROOT / ".runtime" / "cache" / "electron"
MIRRORS = [
    "https://npmmirror.com/mirrors/electron/{v}/electron-v{v}-win32-x64.zip",
    "https://registry.npmmirror.com/-/binary/electron/{v}/electron-v{v}-win32-x64.zip",
]


def log(msg):
    print("[fetch-electron] " + msg, flush=True)


def download(url, dest):
    log("downloading " + url)
    tmp = dest.with_suffix(dest.suffix + ".part")
    req = urllib.request.Request(url, headers={"User-Agent": "deskpet-setup"})
    with urllib.request.urlopen(req, timeout=60) as resp, open(tmp, "wb") as fh:
        total = int(resp.headers.get("Content-Length") or 0)
        done = 0
        last = -1
        while True:
            chunk = resp.read(1024 * 512)
            if not chunk:
                break
            fh.write(chunk)
            done += len(chunk)
            if total:
                pct = done * 100 // total
                if pct >= last + 10:
                    last = pct
                    log("  %d%% (%d/%d MB)" % (pct, done >> 20, total >> 20))
    tmp.replace(dest)
    return dest


def main():
    if not PKG.exists():
        log("没找到 node_modules/electron，请先运行 scripts\\install.cmd")
        return 2
    version = json.loads(PKG.read_text(encoding="utf-8"))["version"]
    exe = DIST / "electron.exe"
    version_file = DIST / "version"
    if exe.exists() and PATH_TXT.exists() and version_file.exists() and version_file.read_text().strip() == version:
        log("已就绪：electron %s → %s" % (version, exe))
        return 0

    CACHE.mkdir(parents=True, exist_ok=True)
    zip_path = CACHE / ("electron-v%s-win32-x64.zip" % version)
    if not zip_path.exists() or zip_path.stat().st_size < 50_000_000:
        ok = False
        for tpl in MIRRORS:
            try:
                download(tpl.format(v=version), zip_path)
                ok = True
                break
            except Exception as exc:  # noqa: BLE001
                log("镜像失败 %s: %s %s" % (tpl, type(exc).__name__, exc))
        if not ok:
            log("所有镜像都失败了")
            return 3

    checksums = CACHE / ("SHASUMS256-%s.txt" % version)
    if not checksums.exists():
        download("https://github.com/electron/electron/releases/download/v%s/SHASUMS256.txt" % version, checksums)
    expected = None
    for line in checksums.read_text(encoding="utf-8").splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1].lstrip("*") == zip_path.name:
            expected = parts[0]
    digest = hashlib.sha256()
    with zip_path.open("rb") as archive:
        for chunk in iter(lambda: archive.read(1024 * 1024), b""):
            digest.update(chunk)
    if not expected or digest.hexdigest() != expected:
        raise RuntimeError("Electron archive SHA-256 does not match upstream; extraction refused")
    if not DIST.resolve().is_relative_to(ROOT.resolve()):
        raise RuntimeError("Electron runtime target escapes the project")
    if DIST.exists():
        shutil.rmtree(DIST, ignore_errors=True)
    DIST.mkdir(parents=True, exist_ok=True)
    log("解包到 node_modules/electron/dist …")
    with zipfile.ZipFile(zip_path) as zf:
        for member in zf.infolist():
            if not (DIST / member.filename).resolve().is_relative_to(DIST.resolve()):
                raise RuntimeError("Electron archive entry escapes the runtime directory")
        zf.extractall(DIST)
    if not exe.exists():
        log("解包后没有 electron.exe，压缩包结构可能变了")
        return 4
    PATH_TXT.write_text("electron.exe", encoding="utf-8")
    log("完成：electron %s → %s" % (version, exe))
    return 0


if __name__ == "__main__":
    sys.exit(main())
