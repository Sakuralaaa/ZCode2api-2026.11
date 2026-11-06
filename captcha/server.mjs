// zcgw-captcha — ZCode 领取额度用的阿里云「无痕验证」参数铸造服务（sidecar）
//
// 只做一件事：在真实浏览器引擎里加载阿里云官方 SDK（o.alicdn.com 的 AliyunCaptcha.js），
// 按 ZCode 客户端同款场景配置调用 startTracelessVerification()，把 success 回调给出的
// captchaVerifyParam 交给网关，网关再放进 billing/claim 的 X-Aliyun-Captcha-Verify-Param 头。
//
// 边界（硬规则）：
//   - 只走官方 SDK 的正常无痕流程；不逆向、不复刻阿里云的签名 / 密钥 / 行为包加密
//   - 不解任何可见挑战（滑块、拼图等）：SDK 一旦升级为可见挑战，本次直接放弃，返回 409，
//     网关据此提示「需要在 ZCode 客户端手动领取」
//   - 不做额外的反检测（stealth）注入，只设置一个正常的 UA
//
// 接口：
//   POST /mint    → 200 {param, region, ms, tries} | 409 {error:"challenge"} | 504 {error:"timeout"} | 502 {error, detail}
//   GET  /health  → 200 {ok, browser, connected, mints, lastMintAt, lastError, config}
// 鉴权：Authorization: Bearer $CAPTCHA_TOKEN（未设置 CAPTCHA_TOKEN 时拒绝启动，除非 CAPTCHA_ALLOW_NO_TOKEN=1）
// 依赖：playwright-core + 浏览器（官方 mcr.microsoft.com/playwright 镜像自带）

import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import * as pw from 'playwright-core';

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8790);
const TOKEN = process.env.CAPTCHA_TOKEN || '';
const BROWSER = (process.env.CAPTCHA_BROWSER || 'firefox').toLowerCase(); // firefox | chromium
const HEADFUL = process.env.CAPTCHA_HEADFUL === '1'; // 1 = 有头模式（需 DISPLAY，镜像里由 entrypoint 起 Xvfb）
const UPSTREAM_ORIGIN = process.env.ZCODE_UPSTREAM_ORIGIN || 'https://zcode.z.ai';
const MINT_BUDGET_MS = Number(process.env.CAPTCHA_MINT_BUDGET_MS || 180_000); // 单次 /mint 总预算（含 F008 退避）
const ATTEMPT_TIMEOUT_MS = Number(process.env.CAPTCHA_ATTEMPT_TIMEOUT_MS || 45_000); // 单次尝试超时
const MAX_TRIES = 4;
const F008_BACKOFF_MS = [30_000, 45_000, 60_000]; // F008 = 同一设备状态重复铸参被去重，需冷却 30–60s
const CONFIG_TTL_MS = 10 * 60_000;
const REGION_OVERRIDE = process.env.CAPTCHA_REGION || ''; // 一般不设：默认跟随 client/configs 下发的 region
const DEBUG = process.env.CAPTCHA_DEBUG === '1';

// 场景配置兜底值（与 ZCode 客户端一致；正常情况下从 client/configs 动态读取）
const FALLBACK_CONFIG = { enabled: true, sceneId: '11xygtvd', prefix: 'no8xfe', region: 'cn' };

// 一个正常的桌面 UA（按引擎区分，避免 UA 与引擎自相矛盾）；可用 CAPTCHA_UA 覆盖
const DEFAULT_UA = {
  firefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0',
  chromium: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
};
const UA = process.env.CAPTCHA_UA || DEFAULT_UA[BROWSER] || DEFAULT_UA.firefox;

const PAGE_URL = pathToFileURL(path.join(import.meta.dirname, 'page.html')).href;

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const dbg = (...a) => DEBUG && log('[debug]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!TOKEN && process.env.CAPTCHA_ALLOW_NO_TOKEN !== '1') {
  console.error('CAPTCHA_TOKEN 未设置：拒绝启动（网关与本服务需配置同一个随机长串）');
  process.exit(1);
}

// ── 场景配置：GET client/configs → data.configs.captcha，缓存 10 分钟 ──
let cfgCache = { at: 0, value: null, source: 'none' };
async function getConfig() {
  if (cfgCache.value && Date.now() - cfgCache.at < CONFIG_TTL_MS) return cfgCache.value;
  try {
    const r = await fetch(`${UPSTREAM_ORIGIN}/api/v1/client/configs`, { signal: AbortSignal.timeout(15_000) });
    const j = await r.json();
    const c = j?.data?.configs?.captcha ?? j?.data?.captcha;
    if (c && typeof c === 'object' && c.sceneId) {
      cfgCache = {
        at: Date.now(),
        source: 'remote',
        value: {
          enabled: c.enabled !== false,
          sceneId: String(c.sceneId),
          prefix: String(c.prefix || FALLBACK_CONFIG.prefix),
          region: String(REGION_OVERRIDE || c.region || FALLBACK_CONFIG.region),
        },
      };
      return cfgCache.value;
    }
    throw new Error('client/configs 里没有 captcha 段');
  } catch (e) {
    log('读取 client/configs 失败，使用内置场景配置：', e.message);
    // 失败也缓存 1 分钟，避免每次 mint 都去打
    cfgCache = { at: Date.now() - CONFIG_TTL_MS + 60_000, source: 'fallback', value: { ...FALLBACK_CONFIG, ...(REGION_OVERRIDE ? { region: REGION_OVERRIDE } : {}) } };
    return cfgCache.value;
  }
}

// ── 浏览器：常驻复用；崩溃 / 断开后下次 mint 自动重启 ──
let browser = null;
let context = null;
let page = null;
let launching = null;

async function launchBrowser() {
  const type = BROWSER === 'chromium' ? pw.chromium : pw.firefox;
  const opts = { headless: !HEADFUL };
  if (BROWSER === 'firefox') {
    // 不读系统代理设置（容器里通常没有；本地有 HTTP(S)_PROXY 时 Firefox 也直连）
    opts.firefoxUserPrefs = { 'network.proxy.type': 0 };
  } else {
    // 容器里以非 root 运行；/dev/shm 很小时用磁盘
    opts.args = ['--disable-dev-shm-usage', '--lang=zh-CN'];
  }
  if (process.env.CAPTCHA_PROXY) opts.proxy = { server: process.env.CAPTCHA_PROXY };
  log(`启动浏览器 ${BROWSER}（${HEADFUL ? '有头 / Xvfb' : '无头'}）`);
  const b = await type.launch(opts);
  b.on('disconnected', () => {
    log('浏览器已断开，下次铸参时重启');
    if (browser === b) { browser = null; context = null; page = null; }
  });
  const ctx = await b.newContext({
    userAgent: UA,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    viewport: { width: 1280, height: 800 },
  });
  browser = b;
  context = ctx;
  page = null;
}

async function ensurePage() {
  if (!browser || !browser.isConnected()) {
    if (!launching) launching = launchBrowser().finally(() => { launching = null; });
    await launching;
  }
  if (!page || page.isClosed()) {
    page = await context.newPage();
    page.on('crash', () => { log('页面崩溃，下次重建'); page = null; });
    if (DEBUG) page.on('console', (m) => dbg('console:', m.text().slice(0, 200)));
  }
  return page;
}

async function resetBrowser() {
  const b = browser;
  browser = null; context = null; page = null;
  try { await b?.close(); } catch {}
}

// 页面里跑一次无痕验证。返回 {param} | {challenge:true} | {error, code}
async function attemptOnce(cfg) {
  const p = await ensurePage();
  // 每次铸参都重新加载页面：销毁旧 SDK 实例，避免复用已消费的 certify 状态
  await p.goto(PAGE_URL, { waitUntil: 'load', timeout: 30_000 });
  await p.waitForFunction('typeof window.initAliyunCaptcha === "function"', null, { timeout: 30_000 });
  return p.evaluate(
    ({ cfg, timeoutMs }) =>
      new Promise((resolve) => {
        let done = false;
        const finish = (v) => {
          if (done) return;
          done = true;
          clearInterval(watch);
          clearTimeout(timer);
          resolve(v);
        };
        const str = (x) => {
          try { return typeof x === 'string' ? x : JSON.stringify(x); } catch { return String(x); }
        };
        const codeOf = (x) => {
          const s = str(x) || '';
          const m = s.match(/F0\d\d/);
          return m ? m[0] : (x && (x.code || x.Code)) || '';
        };
        // 可见挑战检测：SDK 升级为滑块 / 拼图 / 弹窗时这些元素会出现且可见 —— 一律放弃，不去解
        const visibleChallenge = () => {
          const sel = [
            '[id^="aliyunCaptcha-sliding"]', '[id^="aliyunCaptcha-puzzle"]', '[id^="aliyunCaptcha-img"]',
            '[id^="aliyunCaptcha-window"]', '#aliyunCaptcha-mask', '[id^="aliyunCaptcha-captcha-body"]',
          ].join(',');
          for (const el of document.querySelectorAll(sel)) {
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            if (r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0') return true;
          }
          return false;
        };
        const watch = setInterval(() => { if (visibleChallenge()) finish({ challenge: true }); }, 250);
        const timer = setTimeout(() => finish({ error: 'timeout', code: 'timeout' }), timeoutMs);
        try {
          window.AliyunCaptchaConfig = { region: cfg.region, prefix: cfg.prefix };
          window.initAliyunCaptcha({
            SceneId: cfg.sceneId,
            prefix: cfg.prefix,
            region: cfg.region,
            mode: 'popup',
            language: 'cn',
            element: '#zcode-aliyun-captcha-element',
            button: '#zcode-aliyun-captcha-button',
            getInstance: (inst) => {
              try { inst.startTracelessVerification(); } catch (e) { finish({ error: 'start: ' + str(e && e.message), code: '' }); }
            },
            success: (v) => {
              const param = typeof v === 'string' ? v : v && v.captchaVerifyParam;
              if (param && String(param).trim()) finish({ param: String(param).trim() });
              else finish({ error: 'success 回调没有参数', code: '' });
            },
            fail: (f) => finish(visibleChallenge() ? { challenge: true } : { error: 'fail: ' + str(f), code: codeOf(f) }),
            onError: (e) => finish({ error: 'onError: ' + str(e), code: codeOf(e) }),
          });
        } catch (e) {
          finish({ error: 'init: ' + str(e && e.message), code: '' });
        }
      }),
    { cfg, timeoutMs: ATTEMPT_TIMEOUT_MS },
  );
}

// 校验 param 形态：base64(JSON{certifyId, sceneId, ...})
function looksLikeParam(param) {
  try {
    const j = JSON.parse(Buffer.from(param, 'base64').toString('utf8'));
    return !!(j && j.certifyId);
  } catch {
    return false;
  }
}

const stats = { mints: 0, okCount: 0, challenge: 0, timeout: 0, failed: 0, lastMintAt: 0, lastOkAt: 0, lastError: '' };

async function mint() {
  const started = Date.now();
  const cfg = await getConfig();
  let lastErr = '';
  for (let i = 1; i <= MAX_TRIES; i++) {
    const left = MINT_BUDGET_MS - (Date.now() - started);
    if (left < 5_000) break;
    let r;
    try {
      r = await Promise.race([
        attemptOnce(cfg),
        sleep(Math.min(left, ATTEMPT_TIMEOUT_MS + 35_000)).then(() => ({ error: 'timeout', code: 'timeout' })),
      ]);
    } catch (e) {
      // 浏览器 / 页面异常：重启浏览器后重试
      r = { error: e.message, code: 'browser' };
      log(`第 ${i} 次铸参异常，重启浏览器：${e.message}`);
      await resetBrowser();
    }
    if (r.param) {
      if (!looksLikeParam(r.param)) {
        lastErr = 'SDK 返回的参数格式不对';
        log(`第 ${i} 次：${lastErr}`);
        continue;
      }
      return { status: 200, body: { param: r.param, region: cfg.region, ms: Date.now() - started, tries: i } };
    }
    if (r.challenge) {
      log(`第 ${i} 次：SDK 升级为可见挑战，按规则放弃（需手动领取）`);
      // 页面停在挑战上，丢掉它，下次重新开
      try { await page?.close(); } catch {}
      page = null;
      return { status: 409, body: { error: 'challenge', msg: '触发了可见人机验证，需在 ZCode 客户端手动领取' } };
    }
    lastErr = `${r.code || ''} ${r.error || ''}`.trim();
    if (r.code === 'F008') {
      const wait = F008_BACKOFF_MS[Math.min(i - 1, F008_BACKOFF_MS.length - 1)];
      const remain = MINT_BUDGET_MS - (Date.now() - started);
      log(`第 ${i} 次：F008 冷却，${Math.round(wait / 1000)}s 后重载页面重试`);
      if (i >= MAX_TRIES || remain < wait + 10_000) break;
      await sleep(wait);
      continue;
    }
    log(`第 ${i} 次铸参失败：${lastErr}`);
    if (i < MAX_TRIES) await sleep(3_000);
  }
  const timedOut = Date.now() - started >= MINT_BUDGET_MS - 5_000 || /timeout|F008/.test(lastErr);
  return timedOut
    ? { status: 504, body: { error: 'timeout', detail: lastErr || '铸参超时' } }
    : { status: 502, body: { error: 'failed', detail: lastErr || '铸参失败' } };
}

// 串行化：同一时刻只铸一个（param 一次性 + F008 去重，并发只会互相挤兑）
let queue = Promise.resolve();
function serialized(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

function authOk(req) {
  if (!TOKEN) return true;
  const h = String(req.headers.authorization || '');
  const got = h.startsWith('Bearer ') ? h.slice(7) : '';
  const a = Buffer.from(got), b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function send(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/health') {
    // /health 不带鉴权只回存活；带上正确 token 才回详细状态
    if (!authOk(req)) return send(res, 200, { ok: true });
    return send(res, 200, {
      ok: true,
      browser: BROWSER,
      headful: HEADFUL,
      connected: !!browser?.isConnected(),
      config: cfgCache.value ? { ...cfgCache.value, source: cfgCache.source } : null,
      ...stats,
    });
  }
  if (req.method === 'POST' && url.pathname === '/mint') {
    if (!authOk(req)) return send(res, 401, { error: 'unauthorized' });
    req.resume();
    stats.mints++;
    stats.lastMintAt = Date.now();
    try {
      const r = await serialized(mint);
      if (r.status === 200) { stats.okCount++; stats.lastOkAt = Date.now(); stats.lastError = ''; log(`铸参成功 ${r.body.param.length}B，用时 ${r.body.ms}ms，第 ${r.body.tries} 次`); }
      else if (r.status === 409) { stats.challenge++; stats.lastError = 'challenge'; }
      else if (r.status === 504) { stats.timeout++; stats.lastError = r.body.detail; }
      else { stats.failed++; stats.lastError = r.body.detail; }
      return send(res, r.status, r.body);
    } catch (e) {
      stats.failed++;
      stats.lastError = e.message;
      return send(res, 502, { error: 'failed', detail: e.message });
    }
  }
  send(res, 404, { error: 'not_found' });
});

server.listen(PORT, HOST, () => {
  log(`zcgw-captcha listening on http://${HOST}:${PORT}（浏览器 ${BROWSER}${HEADFUL ? ' 有头' : ' 无头'}）`);
  // 预热：先读配置、拉起浏览器（失败无所谓，mint 时会再试）
  getConfig().catch(() => {});
  ensurePage().catch((e) => log('预热浏览器失败：', e.message));
});

const shutdown = async () => {
  log('收到退出信号，关闭浏览器');
  server.close();
  await resetBrowser();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('unhandledRejection', (e) => log('unhandledRejection:', e?.message ?? String(e)));
