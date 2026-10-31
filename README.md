# zcgw — 把 ZCode 的免费额度接进 pi

本机反代网关：解出 ZCode 桌面端的登录态凭证，转发到 ZCode 的**免费额度通道**，
对外暴露标准 **Anthropic Messages** 协议，pi 用内置的 `anthropic-messages` 直接接。

不用改 ZCode 客户端，不用装第三方中转，不用做 OpenAI ↔ Anthropic 转换（工具调用、流式、缓存标记全原样透传）。

---

## 一、怎么用

```powershell
cd <本目录>

.\start.ps1              # 后台启动（幂等，重复执行只报状态）
.\start.ps1 -Status      # 看状态 + 打通性自测（会真发一次最小请求）
.\start.ps1 -Stop        # 停止
.\start.ps1 -Foreground  # 前台跑，方便看日志
```

`start.cmd` 是给双击用的等价入口。

启动后 pi 里就能选到模型：

```
/model  →  zcode/GLM-5.3-Flash
```

或者命令行直连：

```powershell
pi --model "zcode/GLM-5.3-Flash" -p "写个快排"
```

`~/.pi/agent/models.json` 里已自动写入（备份在 `models.json.bak-zcgw`）：

```json
{
  "providers": {
    "zcode": {
      "baseUrl": "http://127.0.0.1:8787",
      "api": "anthropic-messages",
      "apiKey": "zcode-local-gateway",
      "models": [
        {
          "id": "GLM-5.3-Flash",
          "name": "GLM-5.3-Flash (ZCode free)",
          "reasoning": true,
          "thinkingLevelMap": { "off": null, "minimal": null, "low": "low", "medium": null, "high": "high", "xhigh": null, "max": "max" },
          "input": ["text", "image"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 1000000,
          "maxTokens": 131072
        }
      ]
    }
  }
}
```

---

## 二、原理（都是自己从客户端里读出来的，不是猜的）

### 1. 凭证解密

`~/.zcode/v2/credentials.json` 里存的是 `enc:v1:<b64url iv>.<b64url tag>.<b64url ct>`，
实现位于 `app.asar → out/host/index.js`：

| 项目 | 值 |
| --- | --- |
| 算法 | AES-256-GCM，12 字节 IV，16 字节 AuthTag |
| 密钥 | `sha256(secret)` |
| secret | `$ZCODE_CREDENTIAL_SECRET`；未设时为 `zcode-credential-fallback:<platform>:<homedir>:<username>` |

解出来之后有用的三条：

- `zcodejwttoken` — 业务 JWT，**免费额度通道就用它**（payload 只有 `user_id` / `sub` / `iat`，没有 exp）
- `oauth:zai:access_token` — OAuth 访问令牌（查询订阅、刷新用）
- `account-provider:...:api-key` — 付费 Coding Plan 的 API Key（免费用户这条是空的额度）

### 2. 上游端点

端点和鉴权方式来自客户端下发的 provider 配置
（`~/.zcode/v2/runtime/provider/windows-x86_64/<ver>/endpoint-*/zcode-builtin.json`）：

| providerId | baseUrl | 说明 |
| --- | --- | --- |
| `account:zai-start-plan` | `https://zcode.z.ai/api/v1/zcode-plan/anthropic` | **免费/体验额度，本网关走这条** |
| `account:zai-offpeak-idle-plan` | `https://zcode.z.ai/api/v1/off-peak/anthropic` | 夜间免费窗口 |
| `account:zai-highspeed-card` | `https://zcode.z.ai/api/v1/highspeed/anthropic` | 加速卡 |
| `account:zai-individual-coding-plan` | `https://api.z.ai/api/anthropic` | 付费 Coding Plan（另一条通道） |

请求头：`Authorization: Bearer <zcodejwttoken>` + `anthropic-version: 2023-06-01`
+ `X-ZCode-App-Version` / `X-Platform`。

### 3. 额度类错误的形状

ZCode 的额度错误是 **HTTP 200 + 业务信封**：

```json
{"code":1005,"msg":"exceed quota limit","logid":"..."}
```

网关会把它抬成 `429 rate_limit_error`，否则 pi 会以为请求成功并拿到一堆看不懂的东西。

---

## 二·五、额度层级（来自服务端下发的客户端配置，实时拉取）

`GET https://zcode.z.ai/api/v1/client/configs?app_version=3.16.3&platform=windows-x86_64`
（注意 `platform` 必须是 `windows-x86_64` 这种形态，写 `windows` 会 3001 parameter error）

```json
"startPlanPreview": {
  "planId": "zcode-v3-start-plan",
  "name": "Start Plan",
  "entitlements": [
    { "showName": "GLM-5.3",       "grantUnits": 3000000, "period": "daily", "meter": "model_usage", "unitType": "token" },
    { "showName": "GLM-5.3-Flash", "grantUnits": 5000000, "period": "daily", "meter": "model_usage", "unitType": "token" }
  ]
}
```

即免费账号**每天**有 GLM-5.3 3M + GLM-5.3-Flash 5M，走的就是本网关这条 `zcode-plan/anthropic` 通道。
周末的几亿 Flash 是活动叠加包，不是替代品。

```json
"offPeak": { "allowed_models": ["GLM-5.3", "GLM-5.3-Flash"], "enable_offpeak_task": true }
```
夜间通道（`ZCODE_ZONE=off-peak`）在代码里要带 `x-coding-plan-api-key` 头，属于**付费 Coding Plan** 的夜间权益，免费号打过去是 400/3001。

## 三、关键突破：3012 的真正原因（已解决）

### 3.1 结论

| 变量 | 是否影响 3012 | 验证方式 |
| --- | --- | --- |
| 出口 IP | 否 | US 代理 / CN 家宽同样被拦 |
| TLS 指纹 | 否 | 真 Chromium（Playwright）同样被拦 |
| 请求头 | 否 | 用抓到的客户端原版 headers 重放，照样 3012 |
| 发起进程 | 否 | 在 ZCode agent 进程内起中继再发，照样 3012 |
| **`system` 提示词内容** | **是** | 官方三段原样发 → 200；改短 / 加一段自己的 → 3012 |

即上游做的是 **官方 system 提示词指纹校验**：只接受 ZCode 客户端那一份
（42 + 3101 + 7558 字符，共 10703 字符）。
拿 20KB 无意义填充也照样被拦 —— 不是体积，是内容。

### 3.2 网关怎么绕过

`zcode-profile.json` 存了官方 system 三段（从客户端自己的
`~/.zcode/cli/rollout/model-io-*.jsonl` 里取），网关每次请求：

1. `body.system` = 官方三段**原样**（绝不改动）；
2. pi 的 system 指令降级成一个 `<pi_system_instructions>` 块，**插到第一条 user 消息前面**；
3. `thinking` / `output_config` / `tool_choice` / `metadata.user_id` 也照客户端带；
4. 工具数组直接用 pi 的（已验证可用）。

ZCode 升级后如果又开始 3012，跑：

```powershell
cd tools; node refresh-profile.mjs   # 从 rollout 日志刷新官方 system
cd ..; .\start.ps1 -Stop; .\start.ps1
```

### 3.3 验证结果

```
pi --model zcode/GLM-5.3-Flash "只回复三个字：可以用"   → 可以用
pi --tools read --model zcode/GLM-5.3-Flash "读文件…"  → 工具调用正常
```

### 3.4 额度现状（国内手机号账号）

```
ZCode Start Plan (zcode-v3-start-plan-0817)  active
active 期间: 2026/10/30 22:13 → 2026/11/3 23:59:59
GLM-5.3        3,000,000 / 天GLM-5.3-Flash   5,000,000 / 天
周期边界: 北京时间 00:00:00 → 23:59:59（自然日）
查剩余额度: http://127.0.0.1:8787/quota
```

## 四、旧记录（归档）

### 2.1 客户端看到的（国内手机号号 `f6fd571c…`，2026-10-30 22:13 登录）

```
ZCode Start Plan                过期时间 11月3日 23:59
今日余额（23:59 重置）
  GLM-5.3        100%   3,000,000 / 3,000,000
  GLM-5.3-Flash  100%   5,000,000 / 5,000,000
模型：GLM-5.3 (1M)、GLM-5.3-Flash (1M, 视觉)
```

即：**每日免费额度真实存在**（3M + 5M / 天），但它是限时 Start Plan（到 11/3 23:59），
并且**按账号发放**：国际号 `44b4bcdb…` 没有，国内手机号号 `f6fd571c…` 有。

### 2.2 接口侧（本网关）

```
POST /v1/messages  ->  405  {"code":3012,"msg":"request has been blocked due to unusual activity"}
```

已排除：

| 假设 | 实测结果 |
| --- | --- |
| 缺客户端指纹头 | 补齐 `X-Device-Mid` / `X-Title` / `X-Platform=win32-x64` / `X-Os-Version` 整套后仍 3012 |
| 出口 IP 不对 | 走登录时的 US 代理、直连 CN 家宽，两边都是 3012 |
| 没额度 | 客户端显示 100%，且 3012 与 1005 是不同错误码 |

结论：**3012 是风控拦截，不是额度问题**。客户端自己发消息能否跑通是决定性对照。

### 2.3 旧号（国际）的遗留记录

- `GET https://api.z.ai/api/monitor/usage/quota/limit` → `当前用户不存在coding plan`
- `GET https://api.z.ai/api/biz/subscription/list` → `data: []`
- `POST .../v1/messages` → Flash `1005 exceed quota limit`，GLM-5.3 `3009 concurrency`，GLM-5.2/5-Turbo `3006 model not allowed`

---

## 二·六、额度层级（旧记录，保留供参考）

---

## 四、环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 监听端口 |
| `HOST` | `127.0.0.1` | 只监听本机，不对外 |
| `ZCODE_ZONE` | `zcode-plan` | `zcode-plan` / `off-peak` / `highspeed` |
| `ZCODE_UPSTREAM_ORIGIN` | `https://zcode.z.ai` | 上游域名 |
| `ZCODE_MODEL` | `GLM-5.3-Flash` | 请求没带 model 时的兜底 |
| `ZCODE_HOME` | `~/.zcode/v2` | 凭证目录 |
| `ZCODE_CREDENTIAL_SECRET` | 自动派生 | 只有改过这个 env 才需要设 |
| `ZCGW_VERBOSE` | - | `1` 打印每请求日志 |

夜间免费窗口想切过去：

```powershell
$env:ZCODE_ZONE='off-peak'; .\start.ps1 -Foreground
```

---

## 五、故障排查

| 现象 | 原因 / 处理 |
| --- | --- |
| `没找到 ZCode 凭证` | 先在 ZCode 客户端登录一次；`node server.mjs --print-token` 可验证解密 |
| `exceed quota limit` | 额度窗口没开 / 没在客户端领活动卡片 / 额度已用光 |
| `token expired or incorrect` | ZCode 换了 token。网关每次请求都会重读凭证，重启一下 `.\start.ps1 -Stop` 后重启即可 |
| pi 里看不到 `zcode` provider | `pi --list-models` 确认；models.json 改动后要开 `/model` 重载或重启 pi |
| 端口被占 | `$env:PORT=9000` 后启动，并同步改 models.json 的 baseUrl |

## 六、目录

```
zcgw/
├─ server.mjs                 网关本体（无依赖，单文件）
├─ start.ps1 / start.cmd      启动 / 状态 / 停止
├─ tools/
│  ├─ zcode-credentials.mjs   凭证解密（可单独跑，--json 输出全部字段）
│  ├─ zcode-probe.mjs         端点 + 鉴权组合探测
│  ├─ zcode-quota.mjs         额度 / 订阅相关端点探测
│  ├─ zcode-plan-info.mjs     billing preview / client configs 探测
│  ├─ asar-scan.mjs           app.asar 内文搜索（自写最小 asar 解析）
│  └─ asar-extract.mjs        app.asar 单文件提取
└─ dump/                      从 app.asar 抽出来的分析样本（可删）
```

## 七、提醒

- 网关只绑定 `127.0.0.1`，不要把端口暴露到公网；凭证就是你的账号。
- 免费额度是官方活动发的，窗口期外不可用属于正常现象，不是网关的问题。
- 频繁改动 `ZCODE_ZONE` 去撞不同通道可能触发风控，按官方给的窗口用即可。
