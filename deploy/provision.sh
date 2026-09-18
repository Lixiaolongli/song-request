#!/usr/bin/env bash
# 在云服务器上一次性初始化运行环境。
# 由 deploy.sh 自动调用，也可以单独跑：bash deploy/provision.sh
#
# Node 二进制和 npm 包都走 npmmirror（淘宝镜像），
# 因为国内服务器访问 nodejs.org 和 registry.npmjs.org 通常很慢甚至超时。

set -euo pipefail

NODE_MAJOR="${NODE_MAJOR:-22}"
MIRROR="https://registry.npmmirror.com/-/binary/node"

log() { printf '\033[36m[provision]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[provision] 失败：\033[0m%s\n' "$*" >&2; exit 1; }

# 装 Node 到 /usr/local 和全局装 pm2 都要写系统目录
SUDO=""
if [ "$(id -u)" != "0" ]; then
  command -v sudo >/dev/null 2>&1 || die "当前用户不是 root 且没有 sudo，请用 root 登录后重跑"
  SUDO="sudo"
  log "非 root 用户，系统级操作将通过 sudo 执行"
fi

# ── 1. 已经有够新的 Node 就跳过安装 ──
node_major_have=0
if command -v node >/dev/null 2>&1; then
  node_major_have=$(node -v | sed 's/^v\([0-9]*\).*/\1/')
  log "检测到已安装 Node $(node -v)"
fi

if [ "$node_major_have" -ge 18 ]; then
  log "Node 版本满足要求（>=18），跳过安装"
else
  case "$(uname -m)" in
    x86_64)  arch=x64 ;;
    aarch64) arch=arm64 ;;
    *) die "不支持的 CPU 架构：$(uname -m)" ;;
  esac

  log "从 npmmirror 查询 Node v${NODE_MAJOR}.x 最新版本…"
  listing=$(curl -fsSL --max-time 30 "$MIRROR/latest-v${NODE_MAJOR}.x/") \
    || die "拉取镜像列表失败，检查服务器能否访问 registry.npmmirror.com"

  if command -v xz >/dev/null 2>&1; then ext=tar.xz; else ext=tar.gz; fi
  tarball=$(printf '%s' "$listing" | grep -oE "node-v[0-9.]+-linux-${arch}\.${ext}" | head -1)
  [ -n "$tarball" ] || tarball=$(printf '%s' "$listing" | grep -oE "node-v[0-9.]+-linux-${arch}\.tar\.gz" | head -1)
  [ -n "$tarball" ] || die "在镜像列表里没找到 linux-${arch} 的包，可改 NODE_MAJOR 指定大版本后重试"

  version=$(printf '%s' "$tarball" | sed -E 's/node-(v[0-9.]+)-linux.*/\1/')
  url="$MIRROR/latest-v${NODE_MAJOR}.x/$tarball"
  log "下载 Node $version ($arch)…"
  tmp=$(mktemp -d)
  curl -fSL --max-time 300 -o "$tmp/$tarball" "$url" || die "下载失败：$url"

  install_root=/usr/local/lib/nodejs
  $SUDO mkdir -p "$install_root"
  log "解压到 $install_root …"
  $SUDO tar -xf "$tmp/$tarball" -C "$install_root"
  $SUDO ln -sfn "$install_root/node-${version}-linux-${arch}" "$install_root/current"
  for bin in node npm npx; do
    $SUDO ln -sfn "$install_root/current/bin/$bin" "/usr/local/bin/$bin"
  done
  rm -rf "$tmp"

  command -v node >/dev/null 2>&1 || die "安装后仍找不到 node，检查 /usr/local/bin 是否在 PATH 里"
  log "Node 安装完成：$(node -v)"
fi

# ── 2. npm 换国内镜像 ──
current_registry=$(npm config get registry 2>/dev/null || echo "")
if [ "$current_registry" != "https://registry.npmmirror.com" ]; then
  log "npm 源：$current_registry → https://registry.npmmirror.com"
  npm config set registry https://registry.npmmirror.com
else
  log "npm 源已经是 npmmirror，跳过"
fi

# ── 3. 安装 pm2（常驻 + 开机自启）──
if command -v pm2 >/dev/null 2>&1; then
  log "pm2 已安装：$(pm2 -v 2>/dev/null | tail -1)"
else
  log "安装 pm2…"
  $SUDO npm install -g pm2 >/dev/null || die "pm2 安装失败"
  log "pm2 安装完成：$(pm2 -v 2>/dev/null | tail -1)"
fi

if command -v systemctl >/dev/null 2>&1; then
  run_user=$(id -un)
  log "配置 pm2 开机自启（用户 $run_user）…"
  $SUDO env PATH="$PATH" pm2 startup systemd -u "$run_user" --hp "$HOME" >/dev/null 2>&1 \
    || log "（开机自启配置未成功，可稍后手动执行：sudo pm2 startup systemd -u $run_user --hp $HOME）"
fi

# ── 4. 防火墙提示 ──
log "检查系统防火墙…"
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  log "  ⚠️  ufw 处于开启状态，需要放行端口：ufw allow ${PORT:-80}/tcp"
elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state 2>/dev/null | grep -q running; then
  log "  ⚠️  firewalld 正在运行，需要放行端口：firewall-cmd --permanent --add-port=${PORT:-80}/tcp && firewall-cmd --reload"
else
  log "  系统防火墙未开启，无需额外放行"
fi

log "环境准备完成"
