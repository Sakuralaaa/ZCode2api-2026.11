<div align="center">

# ZCode2API

**智谱 ZCode 账号池管理控制台 · Anthropic / OpenAI 双协议反代网关**

把 ZCode 客户端专属额度（GLM-5.3 / GLM-5.3-Flash）反向代理成标准 API：多账号加权调度轮换、Web 面板纳管、多密钥分发、IP 管控、用量审计 —— **单文件 Node 服务，零 npm 依赖，Docker 一键部署**。

![Node.js](https://img.shields.io/badge/Node.js-24-339933?logo=nodedotjs&logoColor=white)
![零依赖](https://img.shields.io/badge/npm%20依赖-0-22c55e)
![Docker](https://img.shields.io/badge/Docker-一键部署-2496ED?logo=docker&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-22c55e)

[![Release](https://img.shields.io/github/v/release/angusdevgo/zcode2api?color=22c55e&label=Release)](https://github.com/angusdevgo/zcode2api/releases)
[![Issues](https://img.shields.io/github/issues/angusdevgo/zcode2api?color=f59e0b&label=反馈)](https://github.com/angusdevgo/zcode2api/issues)
[![Stars](https://img.shields.io/github/stars/angusdevgo/zcode2api?color=f5c542&label=Stars)](https://github.com/angusdevgo/zcode2api/stargazers)

**简体中文** ｜ 本项目在 [LINUX DO](https://linux.do) 社区发布与交流

<p align="center">
  <strong>⚠️ 使用边界：</strong>本项目只用于管理<strong>本人自愿注册与授权</strong>的账号；禁止批量注册、账号交易、代注册、接码、绕过平台风控，以及任何商业转售或盈利性用途。使用即表示你已阅读并同意<a href="#使用边界与免责声明">完整免责声明</a>。
</p>

</div>

---

## 这是什么

智谱的 ZCode 桌面客户端自带专属额度（GLM-5.3 旗舰与 GLM-5.3-Flash），但被锁在客户端里：新号注册礼包（4 天 × 每天 3M + 5M）、周期活动额度（周末数亿 Flash）分散在每个账号上，只能开客户端一点点消耗。

本项目在 ZCode 客户端与你的应用之间架一层**反向代理网关**：

- **上游**：如实复刻 ZCode 客户端对 `zcode.z.ai` 的请求（端点、鉴权、指纹、system 提示词均来自客户端自身行为的逆向分析，公开仓库已脱敏），把客户端的免费额度通道转发出来
- **下游**：对外暴露标准的 **Anthropic Messages API** 与 **OpenAI Chat Completions API**，任意支持自定义 base_url 的工具即填即用
- **中间**：多账号池加权调度、多密钥分发、IP 管控、用量审计，全部可视化

| 没有反代时 | 有了 ZCode2API |
|---|---|
| 每个号的额度只能在客户端里用 | 全部额度汇入一个 API 入口，任意工具调用 |
| 只有一种私有协议 | 同时提供 **Anthropic** 与 **OpenAI** 双协议 |
| 限流了只能干等 | 自动冷却换号、指数退避熔断、粘性会话保缓存 |
| 想分给朋友/多设备没门道 | 多密钥分发：各自独立有效期 / 配额 / 模型 / IP 白名单 |
| 不知道谁用了多少 | 每次调用的模型、Token、延迟、来源 IP 全量留痕 |
| 部署要装一堆依赖 | **单文件 Node 服务，零 npm 依赖**；Docker 镜像 ~60MB |

**重要说明（3012 风控原理）**：上游对请求体中的 `system` 提示词做**内容指纹校验**——只接受 ZCode 客户端官方那份 10703 字符的原文。本网关的解法是：`system` 字段原样透传官方三段，应用的 system 指令降级为一个块插入首条 user 消息。这是整个项目能跑通的关键，也是唯一的"逆向"点，详见 `zcode-profile.json`。

---

## 功能亮点

### 账号管理

- **登录即纳管** —— 设备授权流 / 粘贴 Token 两种方式；登录成功自动识别身份（手机号 / 邮箱 / 国内国际归属）、自动领取可用额度
- **额度总览** —— 按套餐类型与模型实时聚合（周期活动额度 / 新号注册礼包 / 付费套餐），进度条 + 临期预警
- **手动权重** —— 每个账号 0~20 的调度权重：高的多吃额度，0 = 暂停（冻结额度）；实际权重 = 自动分 × 手动权重
- **身份自动识别** —— 用 OAuth access_token 反查官方客户档案，免手填
- **指纹隔离** —— 每账号独立派生 device_id / session_id，多号不共享设备痕迹
- **隐私模式** —— 一键脱敏邮箱 / 手机号 / 昵称，截图分享不泄密

### 反代网关（对外 `/v1`）

- **双协议** —— `POST /v1/messages`（Anthropic，Claude Code 等直连）+ `POST /v1/chat/completions`（OpenAI，任意主流工具直连）+ `GET /v1/models`
- **协议双向转换** —— system 合并、tool 消息、stop 参数、usage 字段全量映射；客户端无感
- **流式支持** —— Anthropic 路径原生 SSE 透传
- **多密钥分发** —— 每把密钥独立设有效期、总 token 配额、模型白名单、IP 白名单；`zck_` 前缀，库里只存哈希，完整 key 只显示一次
- **全量审计** —— 每次调用记密钥、来源 IP、UA、模型、Token（入/出/缓存）、延迟与命中账号

### 调度与容错

- **加权随机选号** —— `余额占比 + 闲置补偿 + 成功率` 三因子 × 手动权重，Top-N 截断 + 防惊群
- **会话粘性** —— 同会话 30 分钟滚动续期固定同号（保 prompt cache 命中），失败自动解绑换号，成功跟随
- **差异化冷却** —— 风控 10 分钟 / 限流首犯 90 秒 / 惯犯 30 分钟 / 上游 5xx 60 秒；连败熔断指数翻倍封顶 6 小时；全冷却时最早恢复者兜底
- **周末额度自动抢领** —— 周五 18:00（北京）起每 10 分钟自动试领，开闸即抢、抢到即停，不再错过限量名额
- **在线调参** —— 全部调度参数面板可改、热生效、持久化，无需重启

### 安全与运营

- **面板登录保护** —— 管理面板与全部管理接口需管理员密码登录（scrypt 哈希 + HMAC 签名会话 Cookie，7 天有效）；登录失败按 IP 指数退避锁定，管理接口带 CSRF 同源校验
- **IP 管控** —— 全局黑/白名单（IPv4/IPv6 CIDR），拦截审计保留 500 条（IP / 路径 / UA / 原因）
- **openMode 防裸奔** —— 删光密钥只放行 `127.0.0.1`，外部一律 401
- **用量统计** —— 14 天趋势图、按模型 / 密钥 / 账号聚合、今日 Token、缓存命中率
- **面板即运维** —— 五页单页应用（仪表盘 / 账号 / 密钥 / 统计 / 安全），由网关自身伺服，无需额外部署前端

---

## 界面预览

**仪表盘** —— 账号池健康度、近 14 天调用趋势、额度分类总览、账号健康快照

```
┌─────────────────────────────────────────────────────────────────┐
│  账号总数    有效期内    即将过期    活动额度余额    今日 Token    │
│     4          4           0         15.00 亿         12.1 万     │
├──────────────────────────────┬──────────────────────────────────┤
│  近 14 天调用趋势（面积图）   │  反代上游                         │
│      ╱╲    ╱╱╲               │  连接状态        ● 正常           │
│  ───╱  ╲──╱    ╲──           │  健康账号  4 │ 冷却中  0          │
│                    ╱╲        │  在途请求  0 │ 粘性    2          │
├──────────────────────────────┴──────────────────────────────────┤
│  额度分类总览                                                     │
│  [活动额度] GLM-5.3-Flash  1,499,898,130 / 1,500,000,000  100%   │
│  [注册礼包] GLM-5.3 旗舰       6,000,000 / 6,000,000      100%   │
└─────────────────────────────────────────────────────────────────┘
```

另有**账号管理**（权重调整 + 额度进度条 + 身份徽章 + 脱敏开关）、**密钥**（配额 / 白名单 / 接入示例）、**用量统计**（多维聚合 + 请求级审计）、**安全**（CIDR 规则 + 拦截日志）四页。

---

## 快速开始

服务器部署需要 Docker（1 核 1G 起）；本机自用只需 Node.js 22+。三种方式任选：

### Docker 单容器（推荐，GHCR 预构建镜像）

本仓库由 GitHub Actions 自动构建多架构镜像（`linux/amd64` / `linux/arm64`），推荐直接使用：

| 镜像 | 说明 |
|---|---|
| `ghcr.io/sakuralaaa/zcode2api-2026.11:latest` | **推荐**：本仓库 main 分支最新构建（含面板登录保护） |
| `ghcr.io/sakuralaaa/zcode2api-2026.11:sha-<短提交号>` | 固定到某次提交，便于回滚 |
| `ghcr.io/sakuralaaa/zcode2api-2026.11:<版本号>` | 打 `v*` 标签时生成的语义化版本 |
| `angusdevgo/zcode2api:latest` | 上游原版镜像（**不含**面板登录保护，不建议暴露到公网） |

```bash
# 端口只绑本机：公网访问请走反向代理（HTTPS），并设置管理员密码
docker run -d --name zcode2api -p 127.0.0.1:8787:8787 \
  -e ADMIN_PASSWORD='换成你自己的强密码' \
  -v /opt/zcode2api/data:/app/data \
  ghcr.io/sakuralaaa/zcode2api-2026.11:latest
```

> 如果拉取时报 `unauthorized` / `denied`：GHCR 包默认是私有的，需要仓库主人在 GitHub「Packages → zcode2api-2026.11 → Package settings」里改成 Public，或先 `docker login ghcr.io` 再拉。

### Docker Compose（服务器）

```bash
git clone https://github.com/Sakuralaaa/ZCode2api-2026.11.git
cd ZCode2api-2026.11
# 编辑 docker-compose.yml 填 ADMIN_PASSWORD（或留空，用日志里打印的初始密码）
docker compose up -d --build
```

数据落在宿主机 `./data/`，升级 = `git pull && docker compose up -d --build`。也可以按 `docker-compose.yml` 顶部注释改用 GHCR 镜像，免本地构建。

### 裸机（零依赖）

```bash
node zcgw-server.mjs        # 只要 Node.js >= 22，无任何 npm install
```

启动后浏览器打开 `http://<IP>:8787/`，先用**管理员密码**登录（见下方「管理面板登录」）：

1. **账号页** → 登录 ZCode 账号（设备授权流，或粘贴客户端 Token）→ 自动识别身份并领取额度
2. **密钥页** → 新建一把 key（完整 key 只显示一次，立即复制）
3. 把你的应用指向网关（见下）

> 生产环境强烈建议套 nginx + TLS（`proxy_buffering off` 保 SSE；传 `X-Forwarded-For`（用 `$remote_addr` 覆盖，防伪造）供 IP 管控与登录防爆破、`X-Forwarded-Proto` 供登录 Cookie 判断 HTTPS），并在面板「安全」页启用 IP 白名单。

### 管理面板登录

面板（`/`）和所有管理接口都需要先登录；`/health` 与 `/v1/*` 模型 API 不受影响（模型 API 照旧用 `zck_` 密钥鉴权）。

- **设置了 `ADMIN_PASSWORD`**：以环境变量为准（优先级最高，覆盖 `admin.json` 里的密码），面板内不能改，改环境变量后重启即可，旧会话自动失效
- **没设置 `ADMIN_PASSWORD`**：首次启动自动生成一个 20 位随机密码，**只在启动日志里打印一次**（带「【重要】首次启动」字样），磁盘上只保存其 scrypt 哈希（`data/admin.json`，权限 600）：

```bash
docker compose logs zcgw | grep -A1 首次启动     # Compose
docker logs zcode2api 2>&1 | grep -A1 首次启动   # 单容器
```

- 登录后可在面板右上角「修改密码」；改密后其他设备的会话全部失效
- **忘记密码**：删除 `data/admin.json` 后重启，会重新生成并打印新密码（所有会话随之失效）

---

## 客户端接入

日常就三步：**纳管账号 → 分发密钥 → 应用指向网关地址**。

<details>
<summary><b>Anthropic 风格（Claude Code 等）</b></summary>

```jsonc
{
  "baseUrl": "http://127.0.0.1:8787",     // 不带 /v1 后缀
  "apiKey": "zck_面板上建的那把",
  "models": ["GLM-5.3-Flash", "GLM-5.3"]
}
```

> 如果客户端需要显式声明模型参数：`contextWindow: 1000000`（上下文 1M）、`maxTokens: 131072`（单次输出上限 128K）。
</details>

<details>
<summary><b>OpenAI 风格（ChatBox、NextChat、LobeChat、Open WebUI 等）</b></summary>

```
Base URL:  http://127.0.0.1:8787/v1        # OpenAI 风格带 /v1
API Key:   zck_xxxxxxxx
Model:     GLM-5.3-Flash
```
</details>

<details>
<summary><b>curl 验证</b></summary>

```bash
# Anthropic 风格
curl http://127.0.0.1:8787/v1/messages \
  -H "x-api-key: zck_xxx" -H "content-type: application/json" \
  -d '{"model":"GLM-5.3-Flash","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}'

# OpenAI 风格
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer zck_xxx" -H "content-type: application/json" \
  -d '{"model":"GLM-5.3-Flash","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}'
```
</details>

> 两种鉴权头都认：`x-api-key`（Anthropic 风格）与 `Authorization: Bearer`（OpenAI 风格）。

---

## 调度器原理

每个新会话从健康账号池中选号（同会话粘住不动）：

```
weight = (余额占比 ×10 + 闲置补偿 0.5/h 封顶5 + 成功率 ×3) × 账号手动权重 0~20
──────────────────────────────────────────────────────────────────────
→ Top-N 截断 → 加权随机
```

| 事件 | 处理 |
|---|---|
| `3012` 风控拦截 | 冷却 10 分钟 + 解绑粘性 |
| `1005/3009` 限流 | 首次按并发瞬态 90s，连犯升级 30 分钟 |
| 连败 ≥ 阈值（默认 3） | 熔断 30 分钟起步，指数翻倍封顶 6 小时 |
| 上游 5xx | 冷却 60 秒换号重试（最多 4 轮） |
| 全部冷却 | 选最早恢复的号兜底顶班 |
| 手动权重 `0` | 暂停该号（额度冻结，兜底才会启用） |

---

## 接口说明

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| `POST` | `/v1/messages` | 网关密钥 | Anthropic Messages API 兼容（流式 SSE / 非流式） |
| `POST` | `/v1/chat/completions` | 网关密钥 | OpenAI Chat Completions 兼容（非流式整体返回） |
| `GET` | `/v1/models` | 无 | 模型列表（`?api=anthropic` 切换 Anthropic 风格） |
| `GET` | `/health` | 无 | 存活探测（含账号/密钥计数） |
| `GET` | `/login` | 无 | 管理面板登录页（未登录访问 `/` 也会显示登录页） |
| `POST` | `/auth/login` | 无（防爆破 + 同源校验） | 管理员密码登录，下发会话 Cookie |
| `POST` | `/auth/logout` | 无 | 退出登录（吊销当前会话） |
| `GET` | `/auth/me` | 面板登录 | 当前登录状态 |
| `POST` | `/auth/password` | 面板登录 | 修改管理员密码（`ADMIN_PASSWORD` 管理时不可用） |
| `GET` | `/` `/dashboard` | 面板登录 | 管理面板 |
| `GET` | `/pool` `/quota` `/keys` `/stats` `/logs` `/security` `/pool/settings` `/claimable` | 面板登录 | 管理面板后端 |
| `POST` | `/claim` `/pool/reset` `/pool/settings` `/selftest` | 面板登录 | 领取额度 / 解除冷却 / 调度参数 / 连通自检 |
| `POST` | `/accounts/add` `/accounts/update` `/accounts/identify` | 面板登录 | 账号纳管 / 修改 / 身份识别 |
| `POST` / `GET` | `/onboard/start` `/onboard/poll/{flowId}` | 面板登录 | 设备授权登录流 |
| `POST` | `/keys` `/keys/{id}/update` `/keys/{id}/delete` `/keys/{id}/reset` | 面板登录 | 密钥管理 |
| `GET/POST` | `/security` `/security/clear-blocked` | 面板登录 | IP 管控规则与审计 |

> 「面板登录」= 需要有效的会话 Cookie，未登录返回 `401 {"code":"unauthorized"}`；其中改状态的请求（POST 等）还要求 `Origin` / `Referer` 与 `Host` 同源（不带 Origin 的命令行客户端放行）。

> 上游对接：所有 `/v1/*` 请求最终转发至 `https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages`（免费额度通道），转发前完成密钥鉴权 → IP 管控 → 账号派生指纹 → 协议转换。

---

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `HOST` / `PORT` | `0.0.0.0` / `8787` | 监听地址 |
| `ADMIN_PASSWORD` | 空 | 管理面板登录密码；设置后优先于 `data/admin.json`。留空则首次启动自动生成并打印在启动日志里 |
| `ADMIN_COOKIE_SECURE` | 空（自动） | 会话 Cookie 的 `Secure` 标记：空 = 按 `X-Forwarded-Proto: https` 自动判断；`1` = 总是带（HTTPS 反代后推荐）；`0` = 从不带 |
| `GATEWAY_KEY` | 空 | 主密钥（面板密钥之外的备份通道） |
| `ZCGW_DATA_DIR` | 程序目录 | 数据目录（Docker 里指 `/app/data`） |
| `ZCGW_MAX_INFLIGHT` | `5` | 单号在途上限 |
| `ZCGW_TOPN` | `3` | 加权随机候选窗口 |
| `ZCGW_STICKY_TTL_MS` | `1800000` | 粘性会话 TTL |
| `ZCGW_BUSY_COOLDOWN_MS` | `90000` | 限流首犯冷却 |
| `ZCGW_QUOTA_COOLDOWN_MS` | `1800000` | 限流惯犯冷却 |
| `ZCGW_BLOCKED_COOLDOWN_MS` | `600000` | 风控冷却 |
| `ZCGW_BREAKER_THRESHOLD` | `3` | 熔断连败阈值 |
| `ZCODE_UPSTREAM_ORIGIN` | `https://zcode.z.ai` | 上游地址 |
| `ZCODE_EXTRA_MODELS` | 空 | 额外模型 id（逗号分隔，进 `/v1/models`） |

---

## 数据文件

| 文件 | 说明 |
|---|---|
| `data/accounts.json` | 账号 JWT（**敏感**，chmod 600，勿入 git） |
| `data/keys.json` | 对外密钥（SHA-256 哈希） |
| `data/usage.jsonl` | 用量流水（环形 6000 条） |
| `data/pool-settings.json` | 调度参数（面板在线修改后落盘） |
| `data/pool-state.json` | 冷却 / 成功率状态（重启恢复） |
| `data/security.json` | IP 管控规则 + 拦截审计（500 条环形） |
| `data/onboard-flows.json` | 进行中的登录授权流（重启不丢） |
| `data/admin.json` | 管理员密码 scrypt 哈希 + 会话签名密钥（**敏感**，自动 chmod 600；删掉即重置密码） |
| `zcode-profile.json` | ZCode 客户端指纹档案（请求头基底 + 官方 system 原文；公开仓库已脱敏运行时痕迹字段） |

> 示例文件见 `data/*.example.json`。备份 = 打包整个 `data/` 目录。

---

## 安全说明

- **管理面板强制登录**：除 `/health` 与 `/v1/*` 模型 API 外，面板与所有管理接口（账号、密钥、调度、统计、日志、安全、领取额度、设备授权流……）都要求管理员登录，未登录一律 401
- 管理员密码只存 scrypt 哈希，常数时间比对；会话 Cookie 用 HMAC-SHA256 签名，`HttpOnly` + `SameSite=Strict`，HTTPS 下带 `Secure`，有效期 7 天；签名里含密码指纹，**改密码即全部旧会话失效**，退出登录会吊销当前会话
- 登录防爆破：同一来源 IP 连续失败 5 次后锁定，锁定时长从 30 秒起指数翻倍、封顶 15 分钟；每次失败写入启动日志和「安全」页拦截日志
- CSRF 防护：改状态的管理请求校验 `Origin` / `Referer` 与 `Host` 同源，叠加 `SameSite=Strict`
- 来源 IP 取 `X-Forwarded-For` 首段：**请务必只让反向代理访问网关端口**（默认已只绑 `127.0.0.1`），并让反代覆盖而不是追加该头（nginx：`proxy_set_header X-Forwarded-For $remote_addr;`），否则客户端可伪造 IP 绕过按 IP 的锁定与管控
- 密钥只在创建时显示一次，库里只存 SHA-256 哈希；账号凭据不返回前端
- 存在 ≥1 把密钥即强制鉴权；**删光密钥只放行 `127.0.0.1`**（openMode 防裸奔设计），外部一律 401
- 入站 IP 黑 / 白名单（支持 IPv4/IPv6 CIDR）；拦截审计保留 IP / 路径 / UA / 原因
- 每次请求留痕来源 IP 与 User-Agent（仅元数据，**不记录对话内容**）
- 敏感文件建议 `chmod 600` + 独立系统用户运行（Docker 镜像已用非 root 用户）

---

## 已知限制

- **OpenAI 流式**：`stream: true` 的 OpenAI 请求当前返回整体 JSON（多数工具可容错）；Anthropic `/v1/messages` 为原生 SSE 透传
- **指纹时效**：`zcode-profile.json` 取自特定版本客户端（3.16.3），上游客户端升级后如遇 3012 需重新抓取
- **额度语义**：新号注册礼包为一次性（4 天窗口内每日重置），周期活动额度限量发放、按官方节奏开闸；本项目如实呈现，不做任何"额度增强"
- **请求内容不留存**：仅记录元数据（模型、状态、Token、延迟、来源），以保护隐私

---

## 更新日志与反馈

- **反馈问题**：[提交 Issue](https://github.com/angusdevgo/zcode2api/issues) —— 请附上版本号与错误日志，并**先移除其中的密钥、Token 等敏感信息**
- **交流**：欢迎在 [LINUX DO](https://linux.do) 社区发帖 @ 分享使用经验

---

## 使用边界与免责声明

**本项目的初衷是方便个人管理本人自愿注册的账号、聚合自有额度自用，不是为批量运营或商业牟利设计的。**

允许的用途：

- 管理你本人注册并授权的智谱账号；
- 在自己的设备或内网中学习、研究和自用。

禁止的用途：

- 批量注册、代注册、接码，以及买卖、出租或交易账号；
- 盗号、撞库、绕过实名认证、风控、区域限制或其他平台安全机制；
- 将本项目或其派生服务用于对外收费、转售、引流或其他盈利性用途；
- 任何违反智谱服务条款、当地法律法规或侵犯他人权益的用途。

使用者应自行确认账号授权与使用方式合法合规。因滥用、误用或违反上述边界导致的封号、额度清零、数据丢失、服务中断或法律责任，由使用者自行承担；项目作者与贡献者不对使用者的行为负责，也不提供任何形式的担保。

本项目与智谱（Z.ai）、ZCode 官方无隶属或合作关系；相关商标归其权利人所有。项目按 [MIT](LICENSE) 许可「按现状」提供。

---

## License

[MIT](LICENSE)
