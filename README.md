# 🎤 扫码点歌

路演 / 现场演出的扫码点歌小工具。观众扫二维码打开网页，从**你预设的歌单**里挑一首；你在**主持人控制台**看到实时队列，决定先唱哪首。

不用注册微信小程序、不用审核、不用打包 App，`node server.js` 就能跑。

---

## 快速开始

```bash
cd song-request
npm install        # 只有第一次需要，装一个生成二维码的库
node server.js     # 启动
```

启动后终端会打印：

```
  🎤 扫码点歌已启动

  观众点歌（手机需与本机同一 WiFi）
    http://192.168.31.7:3000

  主持人控制台  http://192.168.31.7:3000/host?host=kXXXXXXXXXX
  主持人密钥    kXXXXXXXXXX

  歌单 30 首 · 队列 0 条 · 点歌开放中
```

- **观众端**：`/` —— 把控制台「二维码」标签页里的观众二维码打印出来或投屏，观众扫码即可
- **主持人控制台**：`/host?host=密钥` —— 自己用，队列管理 + 歌单管理 + 二维码

按 `Ctrl+C` 停止，队列和歌单会自动存盘，下次启动还在。

---

## 换掉歌单

默认放的是 30 首常见的路演翻唱曲目，**大概率不是你朋友会唱的那些**，记得换。两种方式：

**方式一：控制台里改**（推荐，现场也能临时加）
主持人控制台 →「歌单管理」标签页 → 填歌名/歌手/分类 → 加入歌单。旧的点右边「删除」。改动会立刻同步到所有观众的手机。

**方式二：直接改文件**
编辑 `data/songs.json`：

```json
[
  { "title": "平凡之路", "artist": "朴树", "tag": "民谣" },
  { "title": "海阔天空", "artist": "Beyond", "tag": "摇滚" }
]
```

- `title` 必填，`artist` 和 `tag` 可留空
- `tag` 用来在观众端生成分类筛选条（民谣 / 摇滚 / 流行…），不填就只出现在「全部」里
- 改完重启服务生效

> 已经点过的歌会连歌名歌手一起存进队列，所以**从歌单里删掉某首歌，不会影响历史记录**。

---

## 主持人控制台怎么用

| 区域 | 能做什么 |
|---|---|
| 开放点歌开关 | 想讲话 / 换场时先关掉，观众端会提示"暂停点歌" |
| 正在演唱 | 「唱完了」归档、「放回队列」撤回 |
| 待唱队列 | 「唱这首」标记为正在唱、「置顶」插队、「跳过」、「删除」 |
| 已结束 | 「重新入队」捞回来，或一键清空 |
| 歌单管理 | 现场临时加歌 / 删歌 |
| 二维码 | 观众码（贴出去）+ 控制台码（自己手机扫，密钥已带在链接里） |

队列每条会显示点歌人昵称、留言（比如"送给今天过生日的小王"）和多久之前点的。

**「控制台二维码」别贴给观众** —— 拿到那个链接的人能改队列。

---

## 让手机能访问到

### 情况 A：室内，有 WiFi（最简单）
电脑和观众手机连**同一个 WiFi**，扫终端打印的 `http://192.168.31.x:3000` 那个码就行。
适合小型演出、店里、排练房。人多的场子别指望观众都连得上你家 WiFi。

### 情况 B：户外 / 观众用自己的流量（需要公网地址）
观众手机走 4G/5G，就必须有一个公网能访问的地址。三条路，按省事程度排：

**1. 内网穿透（当天就能用，适合一次性活动）**
```bash
# Cloudflare Tunnel，免费、不用注册、自带 https
cloudflared tunnel --url http://localhost:3000
# 或 ngrok（需注册）
ngrok http 3000
```
拿到公网地址后，**用这个公网地址打开控制台**，二维码会自动跟着变成公网地址：
```bash
PUBLIC_URL=https://xxxx.trycloudflare.com node server.js
```
缺点：电脑得一直开着、不能断网；免费穿透地址每次重启都会变，二维码要重新打印。

> 大陆网络实测提醒：`npm i -g cloudflared` 能装上但**下不到二进制**（它要去 GitHub release 拉，那个 CDN 连不上），装完 `bin/` 是空的、执行会一直挂住。要用的话去 [cloudflared 官方页](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) 手动下 `cloudflared-darwin-arm64.tgz`，或者直接用 Homebrew（`brew install cloudflared`，同样依赖 GitHub，可能也慢）。

**2. 云服务器（最稳，适合要办好几场）**
买台最便宜的轻量服务器（阿里云 / 腾讯云，几十块一个月），一条命令发布：
```bash
./deploy/deploy.sh root@服务器IP
```
详见下面的 [部署到云服务器](#部署到云服务器)。电脑关了也不影响。

> 顺带说一下 **Cloudflare Pages / Workers 这条路走不通**：这个应用是常驻进程 + 内存队列 + SSE 长连接，Workers 是"来一个请求跑一次就销毁"的模型，没有共享内存也没有文件系统，要迁过去得改用 Durable Objects 重写状态层。而且实测 `*.workers.dev` 域名从大陆 TCP 连接直接超时（`dash.cloudflare.com` 和 `api.trycloudflare.com` 都通，就它不通），观众那边也打不开。

**3. 电脑开热点（完全没网的场地）**
笔记本开手机热点，观众连这个热点，再扫局域网地址。
缺点：观众得先连热点，多一步操作，现场容易乱；且他们连了热点就没自己的网了。

> 有些路由器默认开了「AP 隔离 / 访客网络」，同一 WiFi 下的设备互相 ping 不通，扫码就会一直转圈。遇到这种情况换手机热点，或者直接上云服务器。

---

## 部署到云服务器

适合要办好几场、或者现场网络靠不住的情况。电脑关了服务照样跑。

### 1. 买服务器

阿里云 / 腾讯云的**轻量应用服务器**就够，最低配（2 核 2G）绰绰有余。镜像选 Ubuntu 22.04 / Debian 12 / Alibaba Cloud Linux 都行。买完记下**公网 IP** 和 root 密码（或 SSH 密钥）。

### 2. 放行端口（最容易漏的一步）

在云厂商的**网页控制台**里操作，不是在服务器里：

> 轻量应用服务器 → 防火墙（或 ECS → 安全组）→ 添加规则 → TCP → 端口 `80` → 来源 `0.0.0.0/0`

不做这步的话，服务在服务器上跑得好好的，但外面谁都访问不到。`deploy.sh` 结尾会从你本机 curl 一次公网地址，不通就直接把这段排查步骤打出来。

### 3. 一条命令发布

```bash
./deploy/deploy.sh root@服务器IP
```

首次执行会自动：同步代码 → 从 npmmirror 装 Node 22 → 装 pm2 → 配开机自启 → `npm install` → 起服务 → 打印主持人密钥。之后再执行就只做增量发布，几秒完事。

成功的话结尾会打印：

```
────────────────────────────────────────────
  部署完成 · pm2 状态 online

  观众点歌      http://1.2.3.4
  主持人控制台  http://1.2.3.4/host?host=kXXXXXXXXXX
  主持人密钥    kXXXXXXXXXX
────────────────────────────────────────────
```

**把这个密钥记下来**，它是控制台唯一的凭证。

### 常用变体

```bash
./deploy/deploy.sh root@1.2.3.4 2222              # SSH 不是默认 22 端口
PORT=3000 ./deploy/deploy.sh root@1.2.3.4         # 不用 80（安全组记得跟着改）
PUBLIC_URL=https://song.example.com ./deploy/deploy.sh root@1.2.3.4   # 已有域名
FORCE_SONGS=1 ./deploy/deploy.sh root@1.2.3.4     # 用本地歌单覆盖服务器歌单
REMOTE_DIR=sr-prod ./deploy/deploy.sh root@1.2.3.4 # 换服务器上的目录名
```

默认**不会覆盖服务器上的 `data/`** —— 现场用控制台加过的歌、排好的队列、主持人密钥都留着。只有服务器上还没有 `songs.json` 时才会上传本地歌单做初始化。要强制刷歌单就用 `FORCE_SONGS=1`。

### 日常运维

```bash
ssh root@服务器IP 'pm2 logs song-request'      # 看日志
ssh root@服务器IP 'pm2 restart song-request'   # 重启
ssh root@服务器IP 'pm2 status'                 # 看状态
```

改了代码想发新版本：再跑一次 `./deploy/deploy.sh root@服务器IP` 就行。想回退：`git checkout` 到旧提交，然后再跑一次同样的命令。

备份 / 迁移数据（队列 + 歌单 + 密钥都在这两个文件里）：
```bash
ssh root@服务器IP 'cd ~/song-request && tar czf - data' > backup.tgz
```

### 关于 HTTP + IP 的取舍

直接用 `http://IP` 最省事，**不用备案**，当天就能上。代价是没有 https，主持人密钥在 URL 里明文传输 —— 同一网络下有人抓包就能拿到，进而操作你的队列。

对路演这种一次性、低对抗的场景通常可以接受。真在意的话有两条路：
- 用境外服务器 + 域名 + Let's Encrypt 证书（不用备案）
- 用国内服务器 + 已备案域名，前面挂个 Nginx 做 TLS 终结，`PUBLIC_URL` 填 https 地址

---

## 上传到 GitHub

代码库已经初始化好了，主持人密钥所在的 `data/queue.json` 在 `.gitignore` 里，**不会被提交上去**。

大陆网络直连 `github.com:443` 经常超时，所以走 `ssh.github.com:443`。这个仓库已经配好了 repo 级的 `core.sshCommand`，不用改你的 `~/.ssh/config`：

```bash
git config --local --get core.sshCommand
# ssh -o HostName=ssh.github.com -p 443
```

**步骤：**

1. 先确认 SSH 通了（第一次会让你确认 GitHub 的 host key，输 `yes`）：
   ```bash
   ssh -T -o HostName=ssh.github.com -p 443 git@github.com
   # 期望看到：Hi <你的用户名>! You've successfully authenticated...
   ```
   如果报 `Permission denied (publickey)`，说明本机还没有 SSH key 或者没加到 GitHub：
   ```bash
   ssh-keygen -t ed25519 -C "你的邮箱"
   cat ~/.ssh/id_ed25519.pub     # 复制输出，贴到 github.com/settings/keys
   ```

2. 去 <https://github.com/new> 建一个**空仓库**（不要勾 Add README / .gitignore / license，否则会和本地历史冲突）。

3. 关联远端并推送：
   ```bash
   git remote add origin git@github.com:<你的用户名>/song-request.git
   git push -u origin main
   ```

之后每次改完代码：
```bash
git add -A && git commit -m "改动说明" && git push
```

> 服务器上不需要 clone 这个仓库，`deploy.sh` 是直接从你本机 rsync 上去的。推 GitHub 主要是为了备份和多台电脑之间同步代码。

---

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3000` | 监听端口。被占用时换：`PORT=3001 node server.js` |
| `BIND` | `0.0.0.0` | 监听地址。只想本机访问用 `127.0.0.1` |
| `PUBLIC_URL` | 自动识别 | 强制指定二维码指向的地址，用穿透/云服务器时**建议显式设置** |
| `MAX_PENDING` | `2` | 每人最多同时排几首，防止一个人刷屏 |
| `MAX_WAITING` | `60` | 队列总长度上限 |

---

## 演出前检查清单

- [ ] 歌单已经换成他真会唱的歌（默认那 30 首是示例）
- [ ] 电脑/服务器已启动，终端能访问
- [ ] 用**手机**（不是电脑）扫一次观众码，确认能打开、能点歌
- [ ] 打开控制台，确认能看到刚才手机上点的那首歌（说明实时同步通了）
- [ ] 观众码已打印 / 投屏 / 贴在显眼位置
- [ ] 如果走公网：确认观众用手机流量（不连 WiFi）也能打开
- [ ] 电脑设成不休眠、不断网，电源接好
- [ ] 开场前在控制台点一次「清空全部」，把测试数据清掉

**走云服务器的话再加这几项：**

- [ ] 云控制台的安全组 / 防火墙已放行监听端口（不做这步外面全打不开）
- [ ] `deploy.sh` 结尾那行是 `✓ ... 返回 200，外网可访问`
- [ ] 主持人密钥已抄下来，控制台地址存进手机书签
- [ ] `ssh root@服务器IP 'pm2 status'` 显示 `online`
- [ ] 提前一天部署完，别等到演出当天现买服务器

---

## 常见问题

**扫出来一直转圈 / 打不开**
手机和电脑不在同一个网络。用公网地址时检查 `PUBLIC_URL` 有没有设对。

**页面右上角显示"重连中…"**
网络抖了一下，通常几秒内自动恢复（SSE 会自己重连）。一直不恢复就让对方在微信里点右上角 →「在浏览器打开」。

**想清掉历史数据重新来**
```bash
rm data/queue.json && node server.js
```
这会清空队列并生成新的主持人密钥。歌单在 `data/songs.json`，不受影响。

**同一首歌被好几个人点了**
正常，会各占一个队列位置，按顺序唱。同一个人重复点同一首会被拦住。

---

## 技术实现

- 后端：Node 原生 `http`，无框架。实时推送用 **SSE**（`EventSource`），比 WebSocket 简单，断线自动重连
- 前端：原生 JS，无构建步骤。所有用户输入（昵称、留言）都用 `textContent` 渲染，不走 `innerHTML`
- 存储：`data/queue.json`（队列 + 密钥 + 开关状态）、`data/songs.json`（歌单），写操作会合并防抖
- 鉴权：主持人接口靠 URL 里的 `host` 密钥，服务端首次启动生成并持久化
- 唯一第三方依赖：`qrcode`（生成二维码图片）。没装也能跑，只是控制台二维码位置显示提示文字
- 测试：`npm test` 跑 `test/integration.mjs`，59 条断言全走 HTTP 层（起一个真实服务进程 + 隔离的临时数据目录），覆盖 SSE 同步、越权拦截、注入截断、主持人全部操作、重启后数据持久化

目录结构：

```
song-request/
├── server.js               # 服务端：静态托管 + SSE + REST
├── package.json
├── ecosystem.config.cjs    # pm2 配置（必须单实例，见文件内注释）
├── data/
│   ├── songs.json          # 预设歌单（可手改，进版本库）
│   └── queue.json          # 运行时队列 + 主持人密钥（自动生成，已 gitignore）
├── public/
│   ├── index.html          # 观众端
│   ├── app.js
│   ├── host.html           # 主持人控制台
│   ├── host.js
│   └── style.css
├── deploy/
│   ├── provision.sh        # 服务器上的一次性环境初始化（Node + pm2）
│   └── deploy.sh           # 本机执行的发布脚本（rsync + 重启 + 公网自检）
└── test/
    └── integration.mjs     # 端到端集成测试
```
