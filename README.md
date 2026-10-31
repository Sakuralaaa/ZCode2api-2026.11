# ZCode2API

> 智谱 ZCode（GLM-5.3 / GLM-5.3-Flash）多账号反代网关 —— 把 ZCode 客户端专属额度变成标准的 **Anthropic Messages API** 与 **OpenAI Chat Completions API**，带 Web 管理面板、账号池调度、多密钥分发与用量审计。

<p align="center">
  <b>零 npm 依赖 · 单文件 Node 服务 · Docker 一键部署</b>
</p>

---

## ✨ 特性

- **双协议适配** — 同时提供 `POST /v1/messages`（Anthropic）与 `POST /v1/chat/completions`（OpenAI）+ `GET /v1/models`，pi / Claude Code / ChatBox / NextChat / LobeChat 等主流工具即填即用
- **账号池调度** — 加权随机选号：`余额占比 + 闲置补偿 + 成功率` 三因子 × 账号手动权重，Top-N 截断；3012/1005/3009 差异化冷却与指数退避熔断；防惊群窗口
- **会话粘性** — 同一会话 30 分钟滚动续期固定同号（保 prompt cache 命中，实测 74%+）；失败自动解绑换号
- **每账号指纹隔离** — 按账号 uid 派生 device_id / session_id，多号不共享设备痕迹
- **注册礼包自动领取** — 登录即纳管、纳管即自动领取（新号注册礼包 + 周期活动额度），按 kind 补缺不重复
- **多密钥分发** — `zck_` 前缀、SHA-256 哈希存储、完整 key 只显示一次；每把 key 可限有效期 / 总量 / 模型白名单 / IP 白名单
- **Web 管理面板** — 仪表盘（14 天趋势 + 额度总览）、账号管理（在线登录 / 粘贴 Token / 身份自动识别 / 权重调整）、密钥管理、用量统计、安全管控五页
- **安全与审计** — 全局 IP 黑/白名单（CIDR）、鉴权失败与拦截审计日志（保留 500 条）、请求级来源 IP/UA 记录、openMode 仅限回环（删光 key 不会裸奔）
- **在线调参** — 轮换调度全部参数面板可改、热生效、持久化；无需重启
- **用量统计** — 请求级 Token（入/出/缓存）、按模型/密钥/账号聚合、14 天趋势图、来源 IP 审计
- **零依赖** — 只有 Node.js ≥ 22 本体，无任何 npm 包；Docker 镜像基于 alpine ~60MB

## 🏗 架构

```
┌─────────────┐   Anthropic /v1/messages    ┌──────────────────────────────┐
│  pi / Claude │ ──────────────────────────▶ │                              │
│  Code 等     │   OpenAI /v1/chat/...       │   zcgw-server.mjs            │
└─────────────┘                              │  ┌────────────────────────┐  │
                                             │  │ 密钥鉴权 (SHA-256)     │  │
┌─────────────┐                              │  │ IP 黑白名单 (CIDR)     │  │
│  任意 OpenAI │ ──────────────────────────▶ │  │ 加权调度 + 粘性会话     │  │
│  兼容工具    │   /v1/chat/completions      │  │ 协议转换 (双向)         │  │
└─────────────┘                              │  │ 用量记录 + 审计         │  │
                                             │  └───────────┬────────────┘  │
             Web 管理面板 ◀──────────────────│              │ 每账号独立指纹  │
             (dashboard.html)                │              ▼               │
                                             │      https://zcode.z.ai      │
                                             └──────────────────────────────┘
        数据: accounts.json / keys.json / usage.jsonl / pool-*.json / security.json
```

## 🚀 快速开始

### Docker（推荐）

```bash
git clone https://github.com/<you>/zcode2api.git
cd zcode2api
docker compose up -d --build
curl http://127.0.0.1:8787/health
```

打开 `http://<IP>:8787/` → **账号**页登录 ZCode 账号（扫码/粘贴 Token）→ **密钥**页建一把 key → 客户端填 `baseUrl` + `apiKey`，完事。

### 裸机

```bash
node zcgw-server.mjs          # Node >= 22，零依赖
# 数据文件自动生成在程序同目录
```

### 客户端接入

<details>
<summary><b>pi / Anthropic 风格（~/.pi/agent/models.json）</b></summary>

```jsonc
{
  "providers": {
    "zcode": {
      "baseUrl": "http://127.0.0.1:8787",     // 不带 /v1 后缀
      "apiKey": "zck_面板上建的那把",
      "api": "anthropic-messages",
      "models": [
        { "id": "GLM-5.3-Flash", "name": "GLM-5.3 Flash" },
        { "id": "GLM-5.3", "name": "GLM-5.3" }
      ]
    }
  }
}
```
</details>

<details>
<summary><b>OpenAI 风格（任何支持自定义 base_url 的工具）</b></summary>

```
Base URL:  http://127.0.0.1:8787/v1        # OpenAI 风格带 /v1
API Key:   zck_xxxxxxxx
Model:     GLM-5.3-Flash
```
</details>

```bash
# curl 验证
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "x-api-key: zck_xxx" -H "content-type: application/json" \
  -d '{"model":"GLM-5.3-Flash","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}'
```

> 两种鉴权头都认：`x-api-key`（Anthropic 风格）与 `Authorization: Bearer`（OpenAI 风格）。

## 📊 调度器原理

每个新会话从健康账号池中选号（同会话粘住不动）：

```
weight = (余额占比 ×10 + 闲置补偿(0.5/h 封顶5) + 成功率 ×3) × 账号手动权重(0~20)
         ─────────────────────────────────────────────────────────────────────
         → Top-N 截断 → 加权随机
```

| 事件 | 处理 |
|---|---|
| `3012` 风控拦截 | 冷却 10 分钟 + 解绑粘性 |
| `1005/3009` 限流 | 首次按并发瞬态 90s，连犯升级 30 分钟 |
| 连败 ≥ 阈值(3) | 熔断 30 分钟起步，指数翻倍封顶 6 小时 |
| 上游 5xx | 冷却 60 秒换号重试（≤4 个号） |
| 全部冷却 | 选最早恢复的号兜底顶班 |
| 手动权重 `0` | 暂停该号（额度冻结，兜底才会启用） |

所有参数（冷却时长/阈值/权重因子/Top-N/粘性 TTL）在面板「轮换设置」在线调整，热生效。

## 🔐 安全模型

- **密钥**：只存 SHA-256 哈希；存在 ≥1 把 key 即强制鉴权；删光 key 仅放行 `127.0.0.1`（防止误操作裸奔）
- **IP 管控**：黑名单（默认放行）或白名单（默认拒绝），支持 IPv4/IPv6 CIDR；拦截记录（IP/路径/UA/原因）留档 500 条
- **审计**：每次请求记来源 IP + User-Agent + Token 用量 + 命中账号，可按维度检索
- **生产建议**：nginx + TLS 反代（`proxy_buffering off` 保 SSE；透传 `X-Forwarded-For` 供 IP 管控），容器端口只绑 `127.0.0.1`

## 📁 数据文件

| 文件 | 说明 |
|---|---|
| `data/accounts.json` | 账号 JWT（**敏感**，chmod 600，勿入 git） |
| `data/keys.json` | 对外密钥（哈希） |
| `data/usage.jsonl` | 用量流水（环形 6000 条） |
| `data/pool-settings.json` | 调度参数（面板可改） |
| `data/pool-state.json` | 冷却/成功率状态（重启恢复） |
| `data/security.json` | IP 管控规则 + 拦截审计 |
| `data/onboard-flows.json` | 进行中的登录授权流 |
| `zcode-profile.json` | ZCode 客户端指纹档案（请求头基底，公开仓库已脱敏） |

## ⚙️ 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `HOST` / `PORT` | `0.0.0.0` / `8787` | 监听地址 |
| `GATEWAY_KEY` | 空 | 主密钥（面板密钥之外的备份通道） |
| `ZCGW_DATA_DIR` | 程序目录 | 数据目录（Docker 里指 `/app/data`） |
| `ZCGW_MAX_INFLIGHT` | `5` | 单号在途上限 |
| `ZCGW_TOPN` | `3` | 加权随机候选窗口 |
| `ZCGW_STICKY_TTL_MS` | `1800000` | 粘性 TTL |
| `ZCGW_BUSY_COOLDOWN_MS` | `90000` | 限流首犯冷却 |
| `ZCGW_QUOTA_COOLDOWN_MS` | `1800000` | 限流惯犯冷却 |
| `ZCGW_BLOCKED_COOLDOWN_MS` | `600000` | 风控冷却 |
| `ZCGW_BREAKER_THRESHOLD` | `3` | 熔断连败阈值 |
| `ZCODE_UPSTREAM_ORIGIN` | `https://zcode.z.ai` | 上游 |
| `ZCODE_EXTRA_MODELS` | 空 | 额外模型 id（逗号分隔，进 /v1/models） |

## 🗺 API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/messages` | Anthropic Messages（流式 SSE / 非流式） |
| POST | `/v1/chat/completions` | OpenAI Chat Completions |
| GET | `/v1/models` | 模型列表（`?api=anthropic` 切换风格） |
| GET | `/health` / `/pool` / `/quota` / `/keys` / `/stats` / `/logs` / `/security` | 管理面板后端 |
| POST | `/claim`、`/accounts/*`、`/onboard/*`、`/pool/*` | 领取额度 / 账号管理 / 登录流 / 调参 |

## ⚠️ 免责声明

- 本项目是对智谱 ZCode 客户端接口的**个人学习与效率工具**，额度来源于官方活动发放，**请勿用于转售或商业服务**
- 多账号聚合使用存在账号风控风险，**因使用非官方客户端导致的账号限制由使用者自行承担**
- `accounts.json` 内为明文 JWT，请妥善保管服务器权限，**勿提交到公开仓库或网盘**
- 上游接口随时可能变更导致本项目失效，不承诺维护周期

## License

MIT
