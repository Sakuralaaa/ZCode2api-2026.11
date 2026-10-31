<div align="center">

# ZCode2API

**智谱 ZCode 账号池管理控制台 · Anthropic / OpenAI 双协议反代网关**

把 ZCode 客户端专属额度（GLM-5.3 / GLM-5.3-Flash）变成标准 API：Web 面板纳管账号、加权调度轮换、多密钥分发、IP 管控、用量审计 —— **单文件 Node 服务，零 npm 依赖，Docker 一键部署**。

![Node.js](https://img.shields.io/badge/Node.js-24-339933?logo=nodedotjs&logoColor=white)
![零依赖](https://img.shields.io/badge/npm%20依赖-0-22c55e)
![Docker](https://img.shields.io/badge/Docker-一键部署-2496ED?logo=docker&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-22c55e)

[![Release](https://img.shields.io/github/v/release/angusdevgo/zcode2api?color=22c55e&label=Release)](https://github.com/angusdevgo/zcode2api/releases)
[![Issues](https://img.shields.io/github/issues/angusdevgo/zcode2api?color=f59e0b&label=反馈)](https://github.com/angusdevgo/zcode2api/issues)
[![Stars](https://img.shields.io/github/stars/angusdevgo/zcode2api?color=f5c542&label=Stars)](https://github.com/angusdevgo/zcode2api/stargazers)

**简体中文** ｜ 界面预览见下文

<p align="center">
  <strong>⚠️ 使用边界：</strong>本项目只用于管理<strong>本人自愿注册与授权</strong>的账号；禁止批量注册、账号交易、代注册、接码、绕过平台风控，以及任何商业转售或盈利性用途。使用即表示你已阅读并同意<a href="#使用边界与免责声明">完整免责声明</a>。
</p>

</div>

---

## 这是什么

智谱的 ZCode 客户端自带专属额度（GLM-5.3 旗舰与 GLM-5.3-Flash），但只够官方客户端用：新号有注册礼包，周期活动有专项额度 —— 分散在每个号里，只能在客户端里一点点消耗。

本项目把这些额度**聚合成一个标准 API 入口**，并补全运营所需的一切：

| 没有 ZCode2API 时 | 有了之后 |
|---|---|
| 每个号的额度只能在客户端里用 | 全部额度汇入一个 API，任意工具调用 |
| 官方客户端没有批量管理 | Web 面板纳管：登录、领额度、看余额、调权重 |
| 只有一种私有协议 | 同时提供 **Anthropic Messages** 与 **OpenAI Chat Completions** 双协议 |
| 限流了只能干等 | 自动冷却换号、指数退避熔断、粘性会话保缓存 |
| 想分享给朋友没门道 | 多密钥分发：各自独立有效期 / 配额 / 模型 / IP 白名单 |
| 不知道谁用了多少 | 每次调用的模型、Token、延迟、来源 IP 全量留痕 |
| 部署要装一堆依赖 | **单文件 Node 服务，零 npm 依赖**；Docker 镜像 ~60MB |

设计取向与常见"多账号脚本"不同：**不碰账号安全边界** —— 不做自动注册、不绕风控、不碰签名算法；所有指纹参数来自官方客户端自身行为的如实复刻（公开仓库已脱敏），账号凭据由使用者本人通过官方登录流获取。

---

## 功能亮点

### 账号管理

- **登录即纳管** —— 设备授权流 / 粘贴 Token 两种方式；登录成功自动识别身份（手机号 / 邮箱 / 国内国际归属）、自动领取可用额度
- **额度总览** —— 按套餐类型与模型实时聚合（周期活动额度 / 新号注册礼包 / 付费套餐），进度条 + 临期预警
- **手动权重** —— 每个账号 0~20 的调度权重：高的多吃额度，0 = 暂停（冻结额度）；实际权重 = 自动分 × 手动权重
- **身份自动识别** —— 用 OAuth access_token 反查官方客户档案，免手填
- **指纹隔离** —— 每账号独立派生 device_id / session_id，多号不共享设备痕迹

### 反代网关（对外 `/v1`）

- **双协议** —— `POST /v1/messages`（Anthropic，Claude Code / pi 直连）+ `POST /v1/chat/completions`（OpenAI，任意主流工具直连）+ `GET /v1/models`
- **协议双向转换** —— system 合并、tool 消息、stop 参数、usage 字段全量映射；上游返回原样转译，客户端无感
- **流式支持** —— Anthropic 路径原生 SSE 透传
- **多密钥分发** —— 每把密钥独立设有效期、总 token 配额、模型白名单、IP 白名单；`zck_` 前缀，库里只存哈希，完整 key 只显示一次
- **全量审计** —— 每次调用记密钥、来源 IP、UA、模型、Token（入/出/缓存）、延迟与命中账号

### 调度与容错

- **加权随机选号** —— `余额占比 + 闲置补偿 + 成功率` 三因子 × 手动权重，Top-N 截断 + 防惊群
- **会话粘性** —— 同会话 30 分钟滚动续期固定同号（保 prompt cache 命中），失败自动解绑换号，成功跟随
- **差异化冷却** —— 风控 10 分钟 / 限流首犯 90 秒 / 惯犯 30 分钟 / 上游 5xx 60 秒；连败熔断指数翻倍封顶 6 小时；全冷却时最早恢复者兜底
- **在线调参** —— 全部调度参数面板可改、热生效、持久化，无需重启

### 安全与运营

- **IP 管控** —— 全局黑/白名单（IPv4/IPv6 CIDR），拦截审计保留 500 条（IP / 路径 / UA / 原因）
- **openMode 防裸奔** —— 删光密钥只放行 `127.0.0.1`，外部一律 401
- **用量统计** —— 14 天趋势图、按模型 / 密钥 / 聚合、今日 Token、缓存命中率
- **面板即运维** —— 五页单页应用（仪表盘 / 账号 / 密钥 / 统计 / 安全），由网关自身伺服，无需额外部署前端

---

## 界面预览

**仪表盘** —— 账号池健康度、近 14 天调用趋势、额度分类总览、账号健康快照

```
┌─────────────────────────────────────────────────────────────────┐
│  账号总数    有效期内    即将过期    臭鸡蛋余额     今日 Token     │
│     3          3           0         15.00 亿        12.1 万      │
├──────────────────────────────┬──────────────────────────────────┤
│  近 14 天调用趋势（面积图）   │  反代上游                         │
│      ╱╲    ╱╱╲               │  连接状态        ● 正常           │
│  ───╱  ╲──╱    ╲──           │  健康账号  3 │ 冷却中  0          │
│                    ╱╲        │  在途请求  0 │ 粘性    0          │
├──────────────────────────────┴──────────────────────────────────┤
│  额度分类总览                                                     │
│  [臭鸡蛋] GLM-5.3-Flash   1,499,898,130 / 1,500,000,000  100%    │
│  [注册礼包] GLM-5.3 旗舰        6,000,000 / 6,000,000    100%    │
└─────────────────────────────────────────────────────────────────┘
```

另有**账号管理**（权重滑杆 + 额度进度条 + 身份徽章）、**密钥**（额度 / 白名单 / 一键复制示例配置）、**用量统计**（多维聚合 + 请求级审计）、**安全**（CIDR 规则 + 拦截日志）四页，界面风格为深浅双主题的自适应卡片布局。

---

## 快速开始

服务器部署需要 Docker（1 核 1G 起）；本机自用只需 Node.js 22+。三种方式任选：

### Docker Compose（推荐，服务器）

```bash
git clone https://github.com/angusdevgo/zcode2api.git
cd zcode2api
docker compose up -d --build
```

数据落在宿主机 `./data/`，升级 = `git pull && docker compose up -d --build`。

### Docker 单容器

```bash
# 端口只绑本机：公网访问请走反向代理（HTTPS + 访问控制），直接暴露管理面风险高
docker run -d --name zcode2api -p 127.0.0.1:8787:8787 -v /opt/zcode2api/data:/app/data angusdevgo/zcode2api:latest
```

### 裸机（零依赖）

```bash
node zcgw-server.mjs        # 只要 Node.js >= 22，无任何 npm install
```

启动后浏览器打开 `http://<IP>:8787/`：

1. **账号页** → 登录 ZCode 账号（设备授权流，或粘贴客户端 Token）→ 自动领取额度
2. **密钥页** → 新建一把 key（完整 key 只显示一次，立即复制）
3. 客户端接入（见下）

> 生产环境强烈建议套 nginx + TLS（`proxy_buffering off` 保 SSE 流式；透传 `X-Forwarded-For` 供 IP 管控），并在面板「安全」页启用 IP 白名单。

---

## 使用指南

日常就三步：**纳管账号 → 分发密钥 → 客户端指到面板地址**。

<details>
<summary><b>Anthropic 风格接入（Claude Code、pi 等）</b></summary>

```jsonc
// ~/.pi/agent/models.json（其它工具同理：baseUrl + apiKey + model 名）
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
<summary><b>OpenAI 风格接入（ChatBox、NextChat、LobeChat 等）</b></summary>

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
| `GET` | `/pool` `/quota` `/keys` `/stats` `/logs` `/security` `/pool/settings` | 面板 | 管理面板后端 |
| `POST` | `/claim` `/pool/reset` `/selftest` | 面板 | 领取额度 / 解除冷却 / 连通自检 |
| `POST` | `/accounts/add` `/accounts/update` `/accounts/identify` | 面板 | 账号纳管 / 修改 / 身份识别 |
| `POST` | `/onboard/start` `/onboard/poll/{flowId}` | 面板 | 设备授权登录流 |
| `POST` | `/keys` `/keys/{id}/update` `/keys/{id}/delete` `/keys/{id}/reset` | 面板 | 密钥管理 |
| `GET/POST` | `/security` `/security/clear-blocked` | 面板 | IP 管控规则与审计 |

> 上游对接：所有 `/v1/*` 请求最终转发至 `https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages`，转发前完成密钥鉴权 → IP 管控 → 账号派生指纹 → 协议转换。

---

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `HOST` / `PORT` | `0.0.0.0` / `8787` | 监听地址 |
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
| `data/pool-state.json` | 冷却 / 成功率状态（重启恢复，过期冷却自动清理） |
| `data/security.json` | IP 管控规则 + 拦截审计（500 条环形） |
| `data/onboard-flows.json` | 进行中的登录授权流（重启不丢） |
| `zcode-profile.json` | ZCode 客户端指纹档案（请求头基底；公开仓库已脱敏运行时痕迹字段） |

> 示例文件见 `data/*.example.json`。备份 = 打包整个 `data/` 目录。

---

## 安全说明

- 密钥只在创建时显示一次，库里只存 SHA-256 哈希；账号凭据不返回前端
- 存在 ≥1 把密钥即强制鉴权；**删光密钥只放行 `127.0.0.1`**（openMode 防裸奔设计），外部一律 401
- 入站 IP 黑 / 白名单（支持 IPv4/IPv6 CIDR）；拦截审计保留 IP / 路径 / UA / 原因
- 每次请求留痕来源 IP 与 User-Agent（仅元数据，**不记录对话内容**）
- 敏感文件建议 `chmod 600` + 独立系统用户运行（Docker 镜像已用非 root 用户）

---

## 已知限制

- **OpenAI 流式**：`stream: true` 的 OpenAI 请求当前返回整体 JSON（多数工具可容错）；Anthropic `/v1/messages` 为原生 SSE 透传
- **指纹时效**：`zcode-profile.json` 取自特定版本客户端（3.16.3），上游更新后可能需要重新抓取
- **额度语义**：新号注册礼包为一次性（4 天窗口内每日重置），周期活动额度按官方节奏发放；本项目如实呈现，不做任何"额度增强"
- **请求内容不留存**：仅记录元数据（模型、状态、Token、延迟、来源），以保护隐私

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
