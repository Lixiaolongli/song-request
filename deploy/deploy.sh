#!/usr/bin/env bash
# 从本机把代码发布到云服务器并重启服务。
#
#   ./deploy/deploy.sh root@1.2.3.4
#   ./deploy/deploy.sh root@1.2.3.4 22          # 指定 SSH 端口
#   PORT=3000 ./deploy/deploy.sh root@1.2.3.4   # 不用 80 端口
#   PUBLIC_URL=https://song.example.com ./deploy/deploy.sh root@1.2.3.4
#
# 首次执行会自动初始化服务器环境（装 Node、pm2），之后执行只做增量发布。
# 服务器上的 data/ 目录（歌单 + 队列 + 主持人密钥）不会被覆盖。

set -euo pipefail

cd "$(dirname "$0")/.."

TARGET="${1:-}"
SSH_PORT="${2:-22}"
REMOTE_DIR="${REMOTE_DIR:-song-request}"
PORT="${PORT:-80}"

[ -n "$TARGET" ] || { echo "用法：$0 <user@host> [ssh端口]" >&2; exit 1; }
[[ "$TARGET" == *@* ]] || { echo "目标要写成 user@host 的形式，比如 root@1.2.3.4" >&2; exit 1; }

HOST_PART="${TARGET#*@}"
if [ -n "${PUBLIC_URL:-}" ]; then
  PUBLIC_URL="${PUBLIC_URL%/}"
elif [ "$PORT" = "80" ]; then
  PUBLIC_URL="http://$HOST_PART"
else
  PUBLIC_URL="http://$HOST_PART:$PORT"
fi

SSH_OPTS=(-o ConnectTimeout=15 -o ServerAliveInterval=30 -p "$SSH_PORT")
ssh_run() { ssh "${SSH_OPTS[@]}" "$TARGET" "$@"; }

log() { printf '\033[36m[deploy]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[deploy] 失败：\033[0m%s\n' "$*" >&2; exit 1; }

log "目标 $TARGET:$SSH_PORT → ~/$REMOTE_DIR"
log "对外地址 $PUBLIC_URL（监听端口 $PORT）"

# ── 1. 同步代码（保留服务器上的 data/ 与 node_modules/）──
log "同步代码…"
command -v rsync >/dev/null 2>&1 || die "本机没有 rsync"
rsync -az --delete \
  -e "ssh ${SSH_OPTS[*]}" \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude 'data/' \
  --exclude 'logs/' \
  --exclude '.DS_Store' \
  ./ "$TARGET:\$HOME/$REMOTE_DIR/" || die "rsync 失败，检查 SSH 能否登录 $TARGET"

# ── 2. 服务器环境初始化 ──
log "检查服务器 Node 环境…"
if ssh_run 'command -v node >/dev/null 2>&1 && [ "$(node -v | sed "s/^v\([0-9]*\).*/\1/")" -ge 18 ] && command -v pm2 >/dev/null 2>&1'; then
  log "环境已就绪：$(ssh_run 'node -v')"
else
  log "首次部署，开始初始化服务器环境（下载 Node 可能要几分钟）…"
  ssh_run "PORT='$PORT' bash -s" < deploy/provision.sh || die "服务器环境初始化失败"
fi

# ── 3. 首次部署时播种歌单，之后一律不动服务器上的 data/ ──
if ! ssh_run "test -f \"\$HOME/$REMOTE_DIR/data/songs.json\""; then
  log "服务器上还没有歌单，上传本地 data/songs.json 作为初始歌单…"
  ssh_run "mkdir -p \"\$HOME/$REMOTE_DIR/data\""
  rsync -az -e "ssh ${SSH_OPTS[*]}" data/songs.json "$TARGET:\$HOME/$REMOTE_DIR/data/"
else
  log "服务器已有歌单，保留不覆盖（改歌单请用控制台「歌单管理」）"
  if [ "${FORCE_SONGS:-}" = "1" ]; then
    log "  → FORCE_SONGS=1，用本地 data/songs.json 覆盖服务器歌单"
    rsync -az -e "ssh ${SSH_OPTS[*]}" data/songs.json "$TARGET:\$HOME/$REMOTE_DIR/data/"
  fi
fi

# ── 4. 安装依赖并用 pm2 启动 ──
log "安装依赖并重启服务…"
REPORT=$(ssh_run "cd \"\$HOME/$REMOTE_DIR\" && PORT='$PORT' PUBLIC_URL='$PUBLIC_URL' bash -s" <<'EOS'
set -euo pipefail
mkdir -p logs
npm install --no-audit --no-fund 2>&1 | tail -2
pm2 startOrReload ecosystem.config.cjs --update-env >/dev/null 2>&1
pm2 save >/dev/null 2>&1 || true
sleep 2
KEY=$(node -e "try{process.stdout.write(String(require('./data/queue.json').hostKey||''))}catch(e){}" 2>/dev/null || true)
echo "HOSTKEY=$KEY"
echo "PM2STATE=$(pm2 jlist 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const a=JSON.parse(s).find(x=>x.name==='song-request');process.stdout.write(a?a.pm2_env.status:'unknown')}catch(e){process.stdout.write('unknown')}})" 2>/dev/null || echo unknown)"
EOS
) || die "远端启动失败"

HOSTKEY=$(printf '%s\n' "$REPORT" | sed -n 's/^HOSTKEY=//p')
PM2STATE=$(printf '%s\n' "$REPORT" | sed -n 's/^PM2STATE=//p')
printf '%s\n' "$REPORT" | grep -v '^HOSTKEY=' | grep -v '^PM2STATE=' | sed 's/^/  /'

[ "$PM2STATE" = "online" ] || log "⚠️  pm2 状态是 $PM2STATE（期望 online），执行 ssh $TARGET 'pm2 logs song-request' 看日志"
[ -n "$HOSTKEY" ] || die "拿不到主持人密钥，服务可能没起来"

# ── 5. 从本机验证公网可达性（能立刻发现安全组没开）──
log "验证公网可达性…"
HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$PUBLIC_URL/" 2>/dev/null || echo 000)
if [ "$HTTP_CODE" = "200" ]; then
  log "✓ $PUBLIC_URL 返回 200，外网可访问"
  REACHABLE=yes
else
  REACHABLE=no
  log "✗ 从本机访问 $PUBLIC_URL 得到 $HTTP_CODE"
fi

cat <<EOF

────────────────────────────────────────────
  部署完成 · pm2 状态 $PM2STATE

  观众点歌      $PUBLIC_URL
  主持人控制台  $PUBLIC_URL/host?host=$HOSTKEY
  主持人密钥    $HOSTKEY
────────────────────────────────────────────
EOF

if [ "$REACHABLE" = no ]; then
  cat <<'EOF'
⚠️  服务在服务器上已经起来了，但从外网访问不到。按顺序排查：

  1. 【最常见】云控制台的「安全组 / 防火墙」没放行端口。
     这一步在阿里云/腾讯云的网页控制台里做，不是在服务器里：
     入方向 → 添加规则 → TCP → 端口按上面用的 → 来源 0.0.0.0/0

  2. 服务器系统防火墙（provision 阶段会提示，如已开启需手动放行）

  3. 服务器是否有公网 IP（轻量服务器默认有，VPC 内网机器需要另配弹性公网 IP）

放行后重新访问上面的地址即可，不用重新部署。
EOF
fi
