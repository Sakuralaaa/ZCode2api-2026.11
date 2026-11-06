#!/usr/bin/env node
/**
 * zcgw-server — 多账号版 ZCode → Anthropic 反代（服务器部署版）
 *
 * 与本地单账号版 (server.mjs) 的区别：
 *   - 不读 ~/.zcode/v2/credentials.json，改读 ./accounts.json（明文 JWT 数组）或 vault/ 加密库
 *   - 自动多账号轮询：3012/1005 时换下一个号重试
 *   - 对外要求 Authorization: Bearer <GATEWAY_KEY>
 *
 * 部署：
 *   accounts.json: [{ "label": "acc1", "jwt": "eyJ..." }, ...]
 *   GATEWAY_KEY=xxx PORT=8787 node zcgw-server.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { metadataUserId, sessionIdFor, requestId, userIdFromJwt, deviceIdFor } from './zcgw-fingerprint.mjs';
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8787);
const GATEWAY_KEY = process.env.GATEWAY_KEY || '';
const UPSTREAM_ORIGIN = process.env.ZCODE_UPSTREAM_ORIGIN || 'https://zcode.z.ai';
const UPSTREAM_URL = `${UPSTREAM_ORIGIN}/api/v1/zcode-plan/anthropic/v1/messages`;
const APP_VERSION = process.env.ZCODE_APP_VERSION || '3.16.3';
const DEFAULT_MODEL = process.env.ZCODE_MODEL || 'GLM-5.3-Flash';
const VERBOSE = process.env.ZCGW_VERBOSE === '1';
const PROFILE_FILE = path.join(import.meta.dirname, 'zcode-profile.json');
// 数据文件目录：Docker 里指向挂载卷 /app/data，本机默认与程序同目录
const DATA_DIR = process.env.ZCGW_DATA_DIR || import.meta.dirname;

const profile = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8'));
const SESSION_ID = `session_${crypto.randomBytes(16).toString('hex')}`;

/** 把 plan_id / plan 名译成中文意图（活动包 / 每日免费 / 付费套餐） */
function describePlan(id, name) {
  const s = `${id || ''} ${name || ''}`.toUpperCase();
  if (s.includes('WEEKEND') || /(^|[-_ ])WK($|[-_ ])/.test(s)) {
    return { kind: 'promo', kindZh: '臭鸡蛋', nameZh: 'Weekend Build' };
  }
  if (s.includes('OFF-PEAK') || s.includes('OFFPEAK')) {
    return { kind: 'offpeak', kindZh: '夜间不限量', nameZh: '夜间免费 (Off-Peak)' };
  }
  if (s.includes('START-PLAN') || s.includes('START PLAN')) {
    return { kind: 'daily', kindZh: '注册礼包', nameZh: '新号体验包 (Start Plan · 4天)' };
  }
  if (s.includes('CODING-PLAN') || s.includes('CODING PLAN')) {
    return { kind: 'paid', kindZh: '付费套餐', nameZh: '编程套餐 (Coding Plan)' };
  }
  return { kind: 'other', kindZh: '其他', nameZh: name || id || '未知' };
}

/** 账号归属：国内 / 国际（按登录身份判断，可由 accounts.json 的 realm 覆盖） */
function realmFromIdentity(email) {
  const e = String(email || '').trim();
  if (!e) return 'unknown';
  if (/@phone\.local$/i.test(e)) return 'cn';
  if (/^1\d{10}$/.test(e)) return 'cn';
  if (e.includes('@')) return 'intl';
  return 'unknown';
}

function detectRealm(jwt, hint, email) {
  if (hint === 'cn' || hint === 'intl') return hint;
  const byEmail = realmFromIdentity(email);
  if (byEmail !== 'unknown') return byEmail;
  // JWT 里没有 email（只有 user_id），这里只能当兑底
  try {
    const p = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
    const byJwt = realmFromIdentity(p.email);
    if (byJwt !== 'unknown') return byJwt;
  } catch {}
  return 'unknown';
}

/** 身份展示：手机号（服务端已打码）优先，其次真邮箱；未知返回 null */
function displayIdentity(account) {
  const email = String(account.email || '').trim();
  const phone = String(account.phone || '').trim();
  // 真邮箱（国际号）优先；@phone.local 是国产手机号的内部占位，不当邮箱用
  if (email && !/@phone\.local$/i.test(email)) return email;
  if (phone) return phone;
  const raw = email.replace(/@phone\.local$/i, '');
  if (/^1\d{10}$/.test(raw)) return `${raw.slice(0, 3)}****${raw.slice(-4)}`;
  return raw || null;
}

const REALM_ZH = { cn: '国内', intl: '国际', unknown: '未标注' };

/** 安全 JSON：空响应 / 非 JSON 不抛异常（否则一个坏响应就能把进程打死） */
async function safeJson(r) {
  const text = await r.text();
  if (!text) return { __error: 'empty body', __status: r.status };
  try {
    return JSON.parse(text);
  } catch {
    return { __error: text.slice(0, 200), __status: r.status };
  }
}

// ── 账号加载 ──
const ACC_FILE = path.join(DATA_DIR, 'accounts.json');

// ── 官方身份接口（客户端 OEM 的 zai adapter 同款端点）──
// 关键：这个接口认的是 OAuth access_token，不是 zcodejwttoken。
// 返回值带 email / phoneNumber(已打码) / countryCode，正好用来判国内 vs 国际。
const ZAI_ORIGIN = process.env.ZCODE_ZAI_ORIGIN || 'https://api.z.ai';
const CUSTOMERINFO_URL = `${ZAI_ORIGIN}/api/biz/customer/getCustomerInfo`;

async function fetchCustomerInfo(accessToken) {
  if (!accessToken) return null;
  try {
    const r = await fetch(CUSTOMERINFO_URL, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      signal: AbortSignal.timeout(12000),
    });
    const j = await safeJson(r);
    // 这个接口的成功码是 200（不是 0），且外层有 success 字段
    if (j.code !== 200 || !j.data) return null;
    return j.data;
  } catch {
    return null;
  }
}

/** 从官方客户档案判断归属：有邮箱=国际，有手机号=国内，countryCode 兜底 */
function realmFromCustomer(d) {
  if (!d) return 'unknown';
  const email = String(d.email || '').trim();
  const phone = String(d.phoneNumber || '').trim();
  if (email) return 'intl';
  if (phone) return 'cn';
  if (String(d.countryCode || '') === '+86') return 'cn';
  return 'unknown';
}

/** 把一次 customerInfo 结果合并回 accounts.json 的记录；有变更返回 true */
function mergeCustomerInfo(rec, d) {
  if (!d) return false;
  let changed = false;
  const email = String(d.email || '').trim();
  const phone = String(d.phoneNumber || '').trim();
  const realm = realmFromCustomer(d);
  const nick = String(d.nickName || d.customerName || '').trim();

  // 手机号账号的 email 是空的：把历史的 xxx@phone.local 占位清掉，改用真实打码手机号
  if (phone && rec.phone !== phone) { rec.phone = phone; changed = true; }
  if (phone && rec.email && /@phone\.local$/i.test(rec.email)) { rec.email = null; changed = true; }
  if (email && rec.email !== email) { rec.email = email; changed = true; }
  if (realm !== 'unknown' && rec.realm !== realm) { rec.realm = realm; changed = true; }
  if (d.countryCode && rec.countryCode !== d.countryCode) { rec.countryCode = d.countryCode; changed = true; }
  if (nick && !rec.name) { rec.name = nick; changed = true; }
  return changed;
}

/** 读本地 ZCode 客户端的 oauth:zai:access_token（当前登录号才有） */
function localAccessToken() {
  try {
    const f = path.join(zcodeDir(), 'credentials.json');
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    const at = decryptCredential(raw['oauth:zai:access_token'] ?? '').trim();
    const jwt = decryptCredential(raw['zcodejwttoken'] ?? '').trim();
    if (!at.startsWith('eyJ') || !jwt.startsWith('eyJ')) return null;
    return { accessToken: at, uid: userIdFromJwt(jwt) };
  } catch {
    return null;
  }
}

/** 启动时把本地客户端的 access_token 补给对应账号（免重新登录） */
function seedLocalAccessToken() {
  try {
    const local = localAccessToken();
    if (!local) return 0;
    const arr = JSON.parse(fs.readFileSync(ACC_FILE, 'utf8'));
    let n = 0;
    for (const a of arr) {
      if (userIdFromJwt(a.jwt) === local.uid && !a.zaiAccessToken) {
        a.zaiAccessToken = local.accessToken;
        n += 1;
      }
    }
    if (n) fs.writeFileSync(ACC_FILE, JSON.stringify(arr, null, 2));
    return n;
  } catch {
    return 0;
  }
}

/** 对所有带 access_token 的账号刷一遍真实身份（不调会报错，只吞异常） */
let lastIdentifyAt = 0;
async function identifyAll(force = false) {
  if (!force && Date.now() - lastIdentifyAt < 5 * 60_000) return { updated: 0, skipped: true };
  lastIdentifyAt = Date.now();
  let arr;
  try {
    arr = JSON.parse(fs.readFileSync(ACC_FILE, 'utf8'));
  } catch {
    return { updated: 0, total: 0, withToken: 0 };
  }
  let updated = 0;
  for (const rec of arr) {
    if (!rec.zaiAccessToken) continue;
    const d = await fetchCustomerInfo(rec.zaiAccessToken);
    if (d && mergeCustomerInfo(rec, d)) updated += 1;
  }
  if (updated) {
    fs.writeFileSync(ACC_FILE, JSON.stringify(arr, null, 2));
    accounts = readAccountFile();
    log(`自动识别账号身份：更新 ${updated} 个`);
  }
  return { updated, total: arr.length, withToken: arr.filter((a) => a.zaiAccessToken).length };
}

/** 解本地 ZCode 客户端的加密凭证（单账号回退模式用） */
function credentialSecret() {
  if (process.env.ZCODE_CREDENTIAL_SECRET) return process.env.ZCODE_CREDENTIAL_SECRET;
  let user = 'unknown';
  try {
    user = os.userInfo().username;
  } catch {}
  return `zcode-credential-fallback:${os.platform()}:${os.homedir()}:${user}`;
}

function zcodeDir() {
  return process.env.ZCODE_HOME || path.join(os.homedir(), '.zcode', 'v2');
}

function decryptCredential(value) {
  const PREFIX = 'enc:v1:';
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) return value;
  const parts = value.slice(PREFIX.length).split('.');
  if (parts.length !== 3) throw new Error('unsupported ciphertext');
  const [iv, tag, ct] = parts.map((p) => Buffer.from(p, 'base64url'));
  const key = crypto.createHash('sha256').update(credentialSecret()).digest();
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

/** 读本地 ZCode 登录态里的 JWT；读不到返回 null */
function localJwt() {
  try {
    const f = path.join(zcodeDir(), 'credentials.json');
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    return decryptCredential(raw['zcodejwttoken'] ?? '').trim() || null;
  } catch {
    return null;
  }
}

function loadAccounts() {
  // 优先用 accounts.json；没有就回退到本地 ZCode 客户端凭证（单账号模式）
  if (fs.existsSync(ACC_FILE)) return readAccountFile();

  const jwt = localJwt();
  if (!jwt) {
    // 不退出：先把服务和面板跑起来，在面板里登录纳管账号后即可使用
    console.log('还没有任何 ZCode 账号：打开管理面板，用「登录」按钮纳管账号后即可调用 /v1 接口');
    return [];
  }
  console.log('未找到 accounts.json，使用本地 ZCode 客户端凭证（单账号模式）');
  const uid = userIdFromJwt(jwt);
  return [
    {
      label: `local-${uid.slice(0, 8)}`,
      jwt,
      uid,
      local: true, // 每次请求重读客户端凭证，客户端刷新 token 后自动跟上
      deviceId: deviceIdFor(uid),
      sessionId: sessionIdFor(uid),
      cooldownUntil: 0,
      failures: 0,
      consecutiveFails: 0,
      inFlight: 0,
      degradeUntil: 0,
      lastSuccess: null,
      lastErr: null,
    },
  ];
}

function readAccountFile() {
  const arr = JSON.parse(fs.readFileSync(ACC_FILE, 'utf8'));
  return arr
    .filter((a) => a.jwt?.startsWith('eyJ'))
    .map((a) => {
      const uid = userIdFromJwt(a.jwt);
      const realm = detectRealm(a.jwt, a.realm, a.email);
      return {
        label: a.label || (uid ?? a.jwt.slice(20, 28)),
        jwt: a.jwt,
        uid,
        email: a.email || null,
        phone: a.phone || null,
        countryCode: a.countryCode || null,
        name: a.name || null,
        realm,
        realmZh: REALM_ZH[realm],
        identity: displayIdentity({ email: a.email, phone: a.phone, realm }),
        hasAccessToken: !!a.zaiAccessToken,
        weight: Number(a.weight) || 1,
        // 指纹按账号派生：同号恒定、跨号隔离（见 zcgw-fingerprint.mjs）
        deviceId: a.deviceId || deviceIdFor(uid),
        sessionId: sessionIdFor(uid),
        cooldownUntil: 0,
        failures: 0,
        consecutiveFails: 0,
        inFlight: 0,
        degradeUntil: 0,
        lastSuccess: null,
        lastErr: null,
      };
    });
}

/** 把新账号写回 accounts.json（保留已有账号） */
function persistAccount(jwt, label, extra = {}) {
  const arr = fs.existsSync(ACC_FILE) ? JSON.parse(fs.readFileSync(ACC_FILE, 'utf8')) : [];
  const uid = userIdFromJwt(jwt);
  const email = extra.email || null;
  const realm = extra.realm || detectRealm(jwt, null, email);
  const accessToken = extra.accessToken || null;
  const existing = arr.find((a) => userIdFromJwt(a.jwt) === uid);
  if (existing) {
    if (email) existing.email = email;
    if (extra.name) existing.name = extra.name;
    if (extra.phone) existing.phone = extra.phone;
    if (accessToken) existing.zaiAccessToken = accessToken;
    if (realm !== 'unknown') existing.realm = realm;
    fs.writeFileSync(ACC_FILE, JSON.stringify(arr, null, 2));
    return { added: false, label: existing.label };
  }
  arr.push({
    label,
    jwt,
    email,
    name: extra.name || null,
    realm,
    ...(accessToken ? { zaiAccessToken: accessToken } : {}),
  });
  fs.writeFileSync(ACC_FILE, JSON.stringify(arr, null, 2));
  return { added: true, label };
}

let accounts = loadAccounts();

// ── 调度参数：环境变量为默认值，面板可在线改（持久化到 pool-settings.json）──
const SETTINGS_FILE = path.join(DATA_DIR, 'pool-settings.json');

// 调度设置的可调范围（面板表单校验用）
const POOL_LIMITS = {
  maxInFlight: [1, 20],
  breakerThreshold: [2, 10],
  breakerCooldownMin: [5, 360],
  blockedCooldownMin: [1, 120],
  quotaCooldownMin: [5, 360],
  busyCooldownSec: [10, 900],
  stickyTtlMin: [1, 240],
  topN: [1, 10],
  idleWeightPerHour: [0, 5],
  idleWeightMax: [0, 20],
  minPickGapMs: [0, 2000],
  weightBalFactor: [0, 20],
  weightSuccFactor: [0, 10],
};

const POOL_DEFAULTS = {
  maxInFlight: 5,
  breakerThreshold: 3,
  breakerCooldownMin: 30,
  blockedCooldownMin: 10,
  quotaCooldownMin: 30,
  busyCooldownSec: 90,
  stickyTtlMin: 30,
  topN: 3,
  idleWeightPerHour: 0.5,
  idleWeightMax: 5,
  minPickGapMs: 120,
  weightBalFactor: 10,
  weightSuccFactor: 3,
};

function clamp(v, [lo, hi]) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function readSettings() {
  const env = {
    maxInFlight: process.env.ZCGW_MAX_INFLIGHT,
    breakerThreshold: process.env.ZCGW_BREAKER_THRESHOLD,
    breakerCooldownMin: process.env.ZCGW_BREAKER_COOLDOWN_MS ? Number(process.env.ZCGW_BREAKER_COOLDOWN_MS) / 60000 : undefined,
    blockedCooldownMin: process.env.ZCGW_BLOCKED_COOLDOWN_MS ? Number(process.env.ZCGW_BLOCKED_COOLDOWN_MS) / 60000 : undefined,
    quotaCooldownMin: process.env.ZCGW_QUOTA_COOLDOWN_MS ? Number(process.env.ZCGW_QUOTA_COOLDOWN_MS) / 60000 : undefined,
    busyCooldownSec: process.env.ZCGW_BUSY_COOLDOWN_MS ? Number(process.env.ZCGW_BUSY_COOLDOWN_MS) / 1000 : undefined,
    stickyTtlMin: process.env.ZCGW_STICKY_TTL_MS ? Number(process.env.ZCGW_STICKY_TTL_MS) / 60000 : undefined,
    topN: process.env.ZCGW_TOPN,
  };
  const out = { ...POOL_DEFAULTS };
  for (const k of Object.keys(POOL_DEFAULTS)) {
    if (env[k] !== undefined && env[k] !== '') out[k] = clamp(env[k], POOL_LIMITS[k]);
  }
  try {
    const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    for (const k of Object.keys(POOL_DEFAULTS)) {
      if (saved[k] !== undefined) out[k] = clamp(saved[k], POOL_LIMITS[k]);
    }
    out.__fromFile = true;
  } catch {}
  return out;
}

const POOL = readSettings();
const STATE_FILE = path.join(DATA_DIR, 'pool-state.json');

function applyPoolSettings(body) {
  const applied = {};
  for (const k of Object.keys(POOL_DEFAULTS)) {
    if (body[k] === undefined) continue;
    const v = clamp(body[k], POOL_LIMITS[k]);
    POOL[k] = v;
    applied[k] = v;
  }
  try {
    const cur = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ ...cur, ...applied }, null, 2));
  } catch {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(applied, null, 2));
  }
  log('调度参数已更新:', JSON.stringify(applied));
  return applied;
}

/** sessionKey -> {label, expireAt}。目的：让同一会话尽量落在同一号上，保住 prompt cache */
const sticky = new Map();
const lastPickAt = new Map(); // label -> ts，防惊群窗口
let lastPick = null; // 上一次抽中的号（同进程内防连击）

// ── 调度状态持久化：重启不丢冷却/降权/统计 ──
function savePoolState() {
  try {
    const data = {
      version: 1,
      savedAt: Date.now(),
      accounts: accounts.map((a) => ({
        uid: a.uid,
        cooldownUntil: a.cooldownUntil || 0,
        degradeUntil: a.degradeUntil || 0,
        consecutiveFails: a.consecutiveFails || 0,
        failures: a.failures || 0,
        successCount: a.successCount || 0,
        errTotal: a.errTotal || 0,
        lastSuccess: a.lastSuccess || null,
        lastUsedAt: a.lastUsedAt || 0,
      })),
    };
    fs.writeFileSync(POOL.stateFile, JSON.stringify(data));
  } catch {}
}

function loadPoolState() {
  try {
    const data = JSON.parse(fs.readFileSync(POOL.stateFile, 'utf8'));
    let n = 0;
    for (const a of accounts) {
      const s = data.accounts?.find((x) => x.uid === a.uid);
      if (!s) continue;
      // 冷却已过期的直接丢弃，防止带着旧冷却启动
      a.cooldownUntil = s.cooldownUntil > Date.now() ? s.cooldownUntil : 0;
      a.degradeUntil = s.degradeUntil > Date.now() ? s.degradeUntil : 0;
      a.consecutiveFails = s.consecutiveFails || 0;
      a.failures = s.failures || 0;
      a.successCount = s.successCount || 0;
      a.errTotal = s.errTotal || 0;
      a.lastSuccess = s.lastSuccess || null;
      a.lastUsedAt = s.lastUsedAt || 0;
      n++;
    }
    if (n) log(`已恢复账号池调度状态 ${n} 个（pool-state.json）`);
  } catch {}
}
const persistState = debounce(savePoolState, 2000);
function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function stickyGet(key) {
  if (!key) return null;
  const hit = sticky.get(key);
  if (!hit) return null;
  if (hit.expireAt <= Date.now()) {
    sticky.delete(key);
    return null;
  }
  return hit.label;
}

/** 每次命中都滚动续期（参考 workbuddy2api TTL 滚动） */
function stickySet(key, label) {
  if (!key) return;
  sticky.set(key, { label, expireAt: Date.now() + POOL.stickyTtlMs });
  if (sticky.size > 2000) {
    const now = Date.now();
    for (const [k, v] of sticky) if (v.expireAt <= now) sticky.delete(k);
  }
}

function stickyUnbind(key) {
  if (key) sticky.delete(key);
}

/**
 * 加权随机选号（参考 workbuddy2api 三因子 + Top-N + 防惊群）：
 *   weight = 余额占比 ×10 + 闲置补偿 + 成功率 ×3
 * 余额来自最近一次 /quota 的缓存（quotaCache），没有就用中性值。
 */
let quotaCache = new Map(); // label -> { remaining, total, ts }
function setQuotaCache(list) {
  for (const a of list) {
    if (!a.label) continue;
    const rem = (a.balances ?? []).reduce((s, b) => s + (b.remaining || 0), 0);
    const tot = (a.balances ?? []).reduce((s, b) => s + (b.total || 0), 0);
    quotaCache.set(a.label, { remaining: rem, total: tot, ts: Date.now() });
  }
}

function weightOf(acc, maxRemaining, now) {
  const qc = quotaCache.get(acc.label);
  const remaining = qc?.remaining || 0;
  // 0) 账号手动权重（面板可调，默认 1）：直接乘在总分上
  const manual = Math.max(0, Math.min(20, Number(acc.weight) || 1));
  // 1) 余额占比 ×10：余额多的多干活；没数据给中性 5
  const balFactor = maxRemaining > 0 ? (remaining / maxRemaining) * POOL.weightBalFactor : POOL.weightBalFactor / 2;
  // 2) 闲置补偿：1 小时没干活 +0.5，封顶 5；从未用过给满分
  const idleHours = acc.lastUsedAt ? (now - acc.lastUsedAt) / 3600_000 : 999;
  const idleWeight = Math.min(idleHours * POOL.idleWeightPerHour, POOL.idleWeightMax);
  // 3) 成功率 ×3：无记录给中性 1.5
  const totalReq = (acc.successCount || 0) + (acc.errTotal || 0);
  const successRate = totalReq >= 5 ? (acc.successCount || 0) / totalReq : 0.5;
  const succWeight = successRate * POOL.weightSuccFactor;
  return (balFactor + idleWeight + succWeight) * manual;
}

function pickAccount(sessionKey) {
  const now = Date.now();

  const usable = (a) =>
    a.cooldownUntil <= now && a.inFlight < POOL.maxInFlight && a.degradeUntil <= now;

  // 1) 粘性：优先回到上次那个号
  const pinned = stickyGet(sessionKey);
  if (pinned) {
    const acc = accounts.find((a) => a.label === pinned);
    if (acc && usable(acc)) return acc;
  }

  // 2) 健康过滤
  let candidates = accounts.filter(usable);

  // 3) 防惊群：把 POOL.minPickGapMs 内刚被选过的号排到队尾而不是剔除（号少时避免无谓的全冷却兑底）
  if (candidates.length > 1 && lastPick) {
    const gap = now - (lastPickAt.get(lastPick) || 0);
    if (gap < POOL.minPickGapMs) {
      candidates = [...candidates.filter((a) => a.label !== lastPick), ...candidates.filter((a) => a.label === lastPick)];
    }
  }

  if (!candidates.length) {
    // 全冷却兑底：从非永久禁用的号里选最早恢复的顶班（参考 workbuddy2api 全冷却兜底）
    const recovering = accounts
      .filter((a) => a.inFlight < POOL.maxInFlight)
      .sort((x, y) => Math.min(x.cooldownUntil, x.degradeUntil) - Math.min(y.cooldownUntil, y.degradeUntil));
    if (recovering.length) {
      log(`[pool] 全部冷却中，选最早恢复的 ${recovering[0].label} 顶班`);
      return recovering[0];
    }
    return null;
  }

  // 4) 权重计算 + Top-N 截断 + 加权随机
  const maxRemaining = Math.max(1, ...candidates.map((a) => quotaCache.get(a.label)?.remaining || 0));
  const scored = candidates
    .map((a) => ({ a, w: weightOf(a, maxRemaining, now) }))
    .sort((x, y) => y.w - x.w)
    .slice(0, Math.max(1, Math.min(POOL.topN, candidates.length)));

  const totalW = scored.reduce((s, x) => s + x.w, 0);
  let roll = Math.random() * totalW;
  let picked = scored[scored.length - 1].a; // 兑底
  for (const x of scored) {
    roll -= x.w;
    if (roll <= 0) {
      picked = x.a;
      break;
    }
  }

  lastPick = picked.label;
  lastPickAt.set(picked.label, now);
  return picked;
}

function markFailure(acc, ms) {
  acc.failures = (acc.failures || 0) + 1;
  acc.errTotal = (acc.errTotal || 0) + 1;
  acc.consecutiveFails = (acc.consecutiveFails || 0) + 1;
  // 已在更长的冷却中 → 不推进不延长（防止重试把冷却越叠越厚，参考 workbuddy2api）
  if (acc.cooldownUntil > Date.now() && acc.cooldownUntil >= Date.now() + ms) {
    persistState();
    return;
  }
  acc.cooldownUntil = Date.now() + ms;
  if (acc.consecutiveFails >= POOL.breakerThreshold) {
    // 连败降权：30m 起每次翻倍封顶 6h（参考 workbuddy2api breaker 指数退避）
    const blows = acc.consecutiveFails - POOL.breakerThreshold + 1;
    const cd = Math.min(POOL.breakerCooldownMs * 2 ** (blows - 1), 6 * 3600_000);
    acc.degradeUntil = Date.now() + cd;
    log(`[${acc.label}] 连败 ${acc.consecutiveFails} 次，降权 ${Math.round(cd / 60000)}min 至 ${new Date(acc.degradeUntil).toISOString()}`);
  }
  persistState();
}

function markSuccess(acc) {
  acc.consecutiveFails = 0;
  acc.failures = 0;
  acc.successCount = (acc.successCount || 0) + 1;
  acc.lastSuccess = new Date().toISOString();
  acc.lastUsedAt = Date.now();
  acc.lastErr = null;
  persistState();
}

/** 从请求里取粘性会话键（参考 workbuddy2api 提取顺序）：
 *  显式头 → metadata.conversation_id → metadata.user_id → 首条 user 文本指纹 */
function sessionKeyOf(req, inbound) {
  const hdr =
    req.headers['x-zcgw-session'] || req.headers['x-session-id'] || req.headers['x-conversation-id'];
  if (hdr) return String(hdr);
  const meta = inbound?.metadata ?? {};
  const fromMeta = meta.conversation_id || meta.conversationId || meta.user_id || inbound?.conversation_id;
  if (fromMeta) return `conv:${fromMeta}`;
  const msgs = inbound?.messages ?? [];
  const first = msgs.find((m) => m.role === 'user');
  if (!first) return null;
  const text =
    typeof first.content === 'string'
      ? first.content
      : (first.content ?? []).map((b) => b?.text ?? '').join('');
  if (!text) return null;
  return crypto.createHash('sha256').update(text.slice(0, 2000)).digest('hex').slice(0, 16);
}

// ── helpers ──
const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);

const urlPathnameOf = (req) => { try { return new URL(req.url, 'http://x').pathname; } catch { return req.url; } };

function upstreamHeaders(acc) {
  // local 模式：重读客户端凭证，token 刷新后自动跟上
  if (acc.local) {
    const fresh = localJwt();
    if (fresh) acc.jwt = fresh;
  }
  return {
    ...(profile.headers || {}),
    authorization: `Bearer ${acc.jwt}`,
    'x-api-key': acc.jwt,
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'mid-conversation-system-2026-04-07',
    'user-agent': `ZCode/${APP_VERSION} ai-sdk/provider-utils/4.0.27 runtime/node.js/24`,
    'http-referer': UPSTREAM_ORIGIN,
    'x-zcode-app-version': APP_VERSION,
    'x-title': 'Z Code@electron',
    'x-release-channel': 'production',
    'x-platform': 'linux-x64',
    'x-os-category': 'linux',
    'x-os-version': '5.15.0',
    'x-client-timezone': 'Asia/Shanghai',
    'x-client-language': 'zh-CN',
    'x-device-mid': acc.deviceId, // 缺这个 header，billing/balance 会回 3001
    'x-session-id': acc.sessionId,
    'x-query-id': crypto.randomUUID(),
    'x-request-id': requestId(),
    'x-zcode-trace-id': crypto.randomUUID(),
    'x-zcode-agent': 'glm',
    'x-zcode-query-source': 'main_turn',
    'x-zcode-session-type': 'main',
    accept: 'text/event-stream, application/json',
  };
}

function buildUserId(acc) {
  return metadataUserId(acc.uid);
}

function buildUpstreamBody(inbound, acc) {
  const msgs = JSON.parse(JSON.stringify(inbound.messages ?? []));
  let sysText = '';
  if (typeof inbound.system === 'string') sysText = inbound.system;
  else if (Array.isArray(inbound.system)) {
    sysText = inbound.system.map((b) => (typeof b === 'string' ? b : b?.text ?? '')).filter(Boolean).join('\n\n');
  }
  if (sysText.trim()) {
    const banner = `<pi_system_instructions>\n${sysText}\n</pi_system_instructions>`;
    const firstUser = msgs.find((m) => m.role === 'user');
    if (firstUser) {
      if (typeof firstUser.content === 'string') firstUser.content = `${banner}\n\n${firstUser.content}`;
      else if (Array.isArray(firstUser.content)) firstUser.content.unshift({ type: 'text', text: banner });
    } else msgs.unshift({ role: 'user', content: banner });
  }
  return {
    model: inbound.model || DEFAULT_MODEL,
    max_tokens: Math.min(Number(inbound.max_tokens) || profile.max_tokens || 128000, profile.max_tokens || 128000),
    stream: inbound.stream !== false,
    metadata: { user_id: buildUserId(acc) },
    system: profile.system,
    messages: msgs,
    tool_choice: profile.tool_choice ?? { type: 'auto' },
    thinking: profile.thinking ?? { type: 'enabled' },
    output_config: profile.output_config ?? { effort: 'low' },
    ...(Array.isArray(inbound.tools) && inbound.tools.length ? { tools: inbound.tools } : {}),
  };
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

function sendJson(res, status, payload) {
  const buf = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
  res.end(buf);
}

// ── 多密钥分发（对外反代网关的 API Key）──
const KEYS_FILE = path.join(DATA_DIR, 'keys.json');
const USAGE_FILE = path.join(DATA_DIR, 'usage.jsonl');
const KEY_PREFIX = 'zck_';

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function readKeys() {
  try {
    const obj = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
    return Array.isArray(obj.keys) ? obj : { version: 1, keys: [] };
  } catch {
    return { version: 1, keys: [] };
  }
}

function writeKeys(db) {
  try {
    fs.writeFileSync(KEYS_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    log('写 keys.json 失败:', e.message);
  }
}

let keyDb = readKeys();

function newKeyMaterial() {
  const full = KEY_PREFIX + crypto.randomBytes(24).toString('hex');
  return { full, prefix: full.slice(0, 12), hash: sha256(full) };
}

/** 对外可见的密钥视图（绝不含 hash） */
function publicKey(k) {
  const now = Date.now();
  const exhausted = k.quotaTokens > 0 && k.usedTokens >= k.quotaTokens;
  const expired = k.expiresAt > 0 && now > k.expiresAt;
  return {
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    enabled: !!k.enabled,
    realm: k.realm || '',
    realmZh: REALM_ZH[k.realm] || '不限',
    expiresAt: k.expiresAt || 0,
    expired,
    exhausted,
    models: k.models ?? [],
    ipAllowlist: k.ipAllowlist ?? [],
    quotaTokens: k.quotaTokens || 0,
    usedTokens: k.usedTokens || 0,
    requests: k.requests || 0,
    createdAt: k.createdAt || 0,
    lastUsedAt: k.lastUsedAt || 0,
    note: k.note || '',
    status: !k.enabled ? 'disabled' : expired ? 'expired' : exhausted ? 'exhausted' : 'ok',
  };
}

function clientIp(req) {
  if (!req || !req.headers) return '';
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  let ip = xff || req.socket?.remoteAddress || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip;
}

// ── 全局 IP 管控 + 拦截审计（参考 wb2api security 页）──
const SEC_FILE = path.join(DATA_DIR, 'security.json');
const security = {
  enabled: false,          // 总开关；关=不检查 IP 规则
  mode: 'blacklist',       // blacklist(默认放行，命中拒绝) | whitelist(默认拒绝，命中放行)
  rules: [],               // [{ type:'allow'|'deny', cidr:'1.2.3.4/32', note:'', createdAt }]
  blockedLog: [],          // 拦截审计（环形 500 条）
};

try {
  if (fs.existsSync(SEC_FILE)) Object.assign(security, JSON.parse(fs.readFileSync(SEC_FILE, 'utf8')));
} catch {}

function saveSecurity() {
  try {
    fs.writeFileSync(SEC_FILE, JSON.stringify({
      enabled: security.enabled,
      mode: security.mode,
      rules: security.rules.slice(-200),
      blockedLog: security.blockedLog.slice(-500),
    }, null, 2));
  } catch {}
}

/** IPv4/IPv6-CIDR 匹配（v4 用整型段，v6 前缀逐段比） */
function ipMatch(ip, cidr) {
  if (!cidr || cidr === '0.0.0.0/0') return true;
  const [range, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr ?? 32);
  if (range.includes(':') !== ip.includes(':')) {
    // v4-mapped v6 归一
    if (ip.includes(':') && /^::ffff:\d+\.\d+\.\d+\.\d+$/.test(ip)) return ipMatch(ip.slice(7), cidr);
    return false;
  }
  if (!range.includes(':')) {
    const toInt = (s) => s.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
    const a = toInt(ip), b = toInt(range);
    if (Number.isNaN(a) || Number.isNaN(b)) return ip === range;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (a & mask) === (b & mask);
  }
  const pa = ip.split(':'), pb = range.split(':');
  const seg = Math.ceil(bits / 16);
  for (let i = 0; i < seg; i++) {
    if ((parseInt(pa[i] || '0', 16) >> (16 - Math.min(16, bits - i * 16))) !==
        (parseInt(pb[i] || '0', 16) >> (16 - Math.min(16, bits - i * 16)))) return false;
  }
  return true;
}

/** 返回命中的拒绝/放行规则或 null；只在 security.enabled 时有意义 */
function secCheckIp(ip) {
  if (!security.enabled) return { allowed: true };
  const hits = security.rules.filter((r) => ipMatch(ip, r.cidr));
  const deny = hits.find((r) => r.type === 'deny');
  if (security.mode === 'whitelist') {
    const allow = hits.find((r) => r.type === 'allow');
    return allow ? { allowed: true } : { allowed: false, reason: `IP ${ip} 不在白名单` };
  }
  return deny ? { allowed: false, reason: `IP ${ip} 命中黑名单` } : { allowed: true };
}

function secLogBlocked(req, pathname, reason, apiKeyOk) {
  security.blockedLog.push({
    t: Date.now(),
    ip: clientIp(req),
    path: pathname,
    reason,
    ua: String(req.headers['user-agent'] || '').slice(0, 120),
    hadKey: apiKeyOk === undefined ? undefined : !!apiKeyOk,
  });
  if (security.blockedLog.length > 500) security.blockedLog = security.blockedLog.slice(-500);
  saveSecurity();
}

/** 校验对外密钥；无 key 且无 GATEWAY_KEY 时放行（本机自用模式） */
function authenticate(req, model) {
  // 兼容两种风格：Anthropic 的 x-api-key 与 OpenAI 风格 Authorization: Bearer
  const got = (
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim() ||
    String(req.headers['x-api-key'] || '').trim()
  );
  const active = keyDb.keys.filter((k) => !k.deleted);

  // openMode（无任何 key）仅限本机回环访问；对外网卡一律拒绝，防止删光 key 后裸奍
  const openMode = !active.length && !GATEWAY_KEY;
  const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(clientIp(req));

  if (!got) {
    if (openMode && loopback) return { ok: true, key: null };
    return { ok: false, status: 401, message: '缺少 API Key' };
  }
  if (GATEWAY_KEY && got === GATEWAY_KEY) {
    return { ok: true, key: { id: 0, name: 'master', models: [], ipAllowlist: [], quotaTokens: 0, usedTokens: 0, requests: 0 } };
  }
  const h = sha256(got);
  const k = active.find((x) => x.hash === h);
  if (!k) {
    if (openMode && loopback) return { ok: true, key: null };
    return { ok: false, status: 401, message: 'API Key 无效' };
  }
  if (!k.enabled) return { ok: false, status: 403, message: 'API Key 已禁用' };
  if (k.expiresAt > 0 && Date.now() > k.expiresAt) return { ok: false, status: 403, message: 'API Key 已过期' };
  if (k.quotaTokens > 0 && (k.usedTokens || 0) >= k.quotaTokens) {
    return { ok: false, status: 429, message: 'API Key 配额已用尽' };
  }
  if ((k.ipAllowlist ?? []).length) {
    const ip = clientIp(req);
    if (!k.ipAllowlist.includes(ip)) return { ok: false, status: 403, message: `IP ${ip} 不在白名单` };
  }
  if ((k.models ?? []).length && model && !k.models.includes(model)) {
    return { ok: false, status: 403, message: `该 Key 不允许使用模型 ${model}` };
  }
  return { ok: true, key: k };
}

// ── 管理面板登录鉴权（管理员密码 + HMAC 签名会话 Cookie）──
// 除 /health 与模型 API（/v1/* 等，走 zck_ 密钥鉴权）外，所有管理接口与面板都要先登录。
// 密码来源优先级：环境变量 ADMIN_PASSWORD > DATA_DIR/admin.json 里的 scrypt 哈希 > 首次启动随机生成。
const ADMIN_FILE = path.join(DATA_DIR, 'admin.json');
const ADMIN_ENV_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_COOKIE_SECURE = String(process.env.ADMIN_COOKIE_SECURE || '').trim(); // '1' 总是 Secure；'0' 从不；空 = 按 https 自动判断
const SESSION_COOKIE = 'zcgw_session';
const SESSION_TTL_MS = 7 * 24 * 3600_000;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
// 进程内部自调用（启动刷余额、周末抢领）专用令牌：每次启动随机，只认回环来源
const INTERNAL_TOKEN = crypto.randomBytes(32).toString('hex');
const LOOPBACK_IPS = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];

function scryptAsync(password, salt, keylen, opts) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, opts, (err, dk) => (err ? reject(err) : resolve(dk)));
  });
}

/** 生成 scrypt$N$r$p$salt$hash 格式的口令哈希 */
function scryptHashSync(password) {
  const { N, r, p, keylen } = SCRYPT_PARAMS;
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(password), salt, keylen, { N, r, p, maxmem: SCRYPT_MAXMEM });
  return `scrypt$${N}$${r}$${p}$${salt.toString('hex')}$${dk.toString('hex')}`;
}

/** 常数时间校验口令 */
async function scryptVerify(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltHex, hashHex] = parts;
  const expected = Buffer.from(hashHex, 'hex');
  if (!expected.length) return false;
  let dk;
  try {
    dk = await scryptAsync(String(password), Buffer.from(saltHex, 'hex'), expected.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT_MAXMEM,
    });
  } catch {
    return false;
  }
  return dk.length === expected.length && crypto.timingSafeEqual(dk, expected);
}

function randomAdminPassword(len = 20) {
  // 去掉易混字符（0/O/1/l/I）
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < len; i++) s += abc[crypto.randomInt(abc.length)];
  return s;
}

function writeAdminFile() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(ADMIN_FILE, JSON.stringify(adminCfg, null, 2), { mode: 0o600 });
    try { fs.chmodSync(ADMIN_FILE, 0o600); } catch {}
    return true;
  } catch (e) {
    log('写 admin.json 失败:', e.message);
    return false;
  }
}

let adminCfg = {};
let adminFirstPassword = ''; // 仅首次生成时在启动日志里打印一次，打印后清空
try {
  if (fs.existsSync(ADMIN_FILE)) {
    const obj = JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8'));
    if (obj && typeof obj === 'object') adminCfg = obj;
  }
} catch (e) {
  log(`WARNING: admin.json 解析失败（${e.message}），将重新初始化管理员凭据`);
}
{
  let dirty = false;
  if (typeof adminCfg.sessionSecret !== 'string' || adminCfg.sessionSecret.length < 32) {
    adminCfg.sessionSecret = crypto.randomBytes(32).toString('hex');
    dirty = true;
  }
  if (!Array.isArray(adminCfg.revoked)) adminCfg.revoked = [];
  if (!ADMIN_ENV_PASSWORD && !adminCfg.passwordHash) {
    adminFirstPassword = randomAdminPassword();
    adminCfg.passwordHash = scryptHashSync(adminFirstPassword);
    adminCfg.createdAt = Date.now();
    adminCfg.updatedAt = Date.now();
    dirty = true;
  }
  if (dirty && !writeAdminFile() && adminFirstPassword) {
    log('WARNING: admin.json 写入失败，本次生成的初始密码只在本进程内有效，重启后会重新生成');
  }
  // 存量文件也收紧权限
  try { if (fs.existsSync(ADMIN_FILE)) fs.chmodSync(ADMIN_FILE, 0o600); } catch {}
}
// 环境变量密码：启动时在内存里做一次 scrypt（随机盐），校验路径与文件密码一致
const ADMIN_ENV_HASH = ADMIN_ENV_PASSWORD ? scryptHashSync(ADMIN_ENV_PASSWORD) : '';

/** 当前密码指纹：参与会话签名，改密码 / 换 ADMIN_PASSWORD 后旧会话全部失效 */
function adminPwFingerprint() {
  const material = ADMIN_ENV_PASSWORD ? `env:${ADMIN_ENV_PASSWORD}` : `file:${adminCfg.passwordHash || ''}`;
  return crypto.createHmac('sha256', adminCfg.sessionSecret).update(material).digest('hex').slice(0, 32);
}

async function verifyAdminPassword(pw) {
  if (typeof pw !== 'string' || !pw || pw.length > 1024) return false;
  return scryptVerify(pw, ADMIN_ENV_PASSWORD ? ADMIN_ENV_HASH : adminCfg.passwordHash);
}

function signSession(payloadB64) {
  return crypto.createHmac('sha256', adminCfg.sessionSecret)
    .update(`${payloadB64}.${adminPwFingerprint()}`).digest('base64url');
}

function issueSession() {
  const now = Date.now();
  const payload = Buffer.from(JSON.stringify({
    v: 1, iat: now, exp: now + SESSION_TTL_MS, n: crypto.randomBytes(12).toString('hex'),
  })).toString('base64url');
  return { token: `${payload}.${signSession(payload)}`, exp: now + SESSION_TTL_MS };
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k && !(k in out)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

/** 校验会话 Cookie；有效返回 payload，否则 null */
function verifySession(req) {
  const tok = parseCookies(req)[SESSION_COOKIE];
  if (!tok || tok.length > 512) return null;
  const dot = tok.lastIndexOf('.');
  if (dot <= 0) return null;
  const payloadB64 = tok.slice(0, dot);
  const got = Buffer.from(tok.slice(dot + 1));
  const want = Buffer.from(signSession(payloadB64));
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  let p;
  try { p = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')); } catch { return null; }
  if (!p || p.v !== 1 || !(p.exp > Date.now())) return null;
  if (adminCfg.revoked.some((r) => r.n === p.n)) return null;
  return p;
}

function requestIsHttps(req) {
  if (req.socket?.encrypted) return true;
  return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https';
}

function sessionCookie(req, value, maxAgeSec) {
  const secure = ADMIN_COOKIE_SECURE === '1' || (ADMIN_COOKIE_SECURE !== '0' && requestIsHttps(req));
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

/** CSRF：有 Origin 必须同源；无 Origin 时看 Referer；都没有（curl 等非浏览器客户端）放行 */
function sameOriginRequest(req) {
  const hosts = new Set(
    [req.headers.host, String(req.headers['x-forwarded-host'] || '').split(',')[0]]
      .map((h) => String(h || '').trim().toLowerCase()).filter(Boolean),
  );
  const match = (u) => {
    try { return hosts.has(new URL(u).host.toLowerCase()); } catch { return false; }
  };
  if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return false;
  const origin = req.headers.origin;
  if (origin !== undefined) return origin !== 'null' && match(origin);
  const ref = req.headers.referer;
  if (ref) return match(ref);
  return true;
}

// ── 登录防爆破：按来源 IP 计数，连续失败 5 次后指数退避锁定（30s 起，封顶 15 分钟）──
const LOGIN_FREE_TRIES = 5;
const LOGIN_BASE_LOCK_MS = 30_000;
const LOGIN_MAX_LOCK_MS = 15 * 60_000;
const loginFails = new Map(); // ip -> { fails, lockedUntil, lastAt }

function loginLockRemaining(ip) {
  const e = loginFails.get(ip);
  return e && e.lockedUntil > Date.now() ? e.lockedUntil - Date.now() : 0;
}

function noteLoginFail(req, ip, what) {
  const now = Date.now();
  const e = loginFails.get(ip) || { fails: 0, lockedUntil: 0, lastAt: 0 };
  e.fails += 1;
  e.lastAt = now;
  let lockMs = 0;
  if (e.fails >= LOGIN_FREE_TRIES) {
    lockMs = Math.min(LOGIN_MAX_LOCK_MS, LOGIN_BASE_LOCK_MS * 2 ** Math.min(10, e.fails - LOGIN_FREE_TRIES));
    e.lockedUntil = now + lockMs;
  }
  loginFails.set(ip, e);
  const ua = String(req.headers['user-agent'] || '').slice(0, 80);
  log(`[admin] ${what}失败 ip=${ip} 连续第 ${e.fails} 次${lockMs ? `，锁定 ${Math.round(lockMs / 1000)} 秒` : ''} ua=${ua}`);
  secLogBlocked(req, '/auth/login', `管理面板${what}失败（第 ${e.fails} 次${lockMs ? `，锁定 ${Math.round(lockMs / 1000)}s` : ''}）`);
  return { fails: e.fails, lockMs, left: Math.max(0, LOGIN_FREE_TRIES - e.fails) };
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of loginFails) {
    if (e.lockedUntil < now && now - e.lastAt > 3600_000) loginFails.delete(ip);
  }
  const before = adminCfg.revoked.length;
  adminCfg.revoked = adminCfg.revoked.filter((r) => r.exp > now);
  if (adminCfg.revoked.length !== before) writeAdminFile();
}, 10 * 60_000).unref();

async function readSmallBody(req, limit = 8192) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('请求体过大'), { status: 413 });
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  if (String(req.headers['content-type'] || '').includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  try { return JSON.parse(raw); } catch { return {}; }
}

function serveLoginPage(res) {
  const f = path.join(import.meta.dirname, 'login.html');
  const buf = fs.existsSync(f)
    ? fs.readFileSync(f)
    : Buffer.from('<!doctype html><meta charset="utf-8"><title>登录</title><p>login.html 缺失</p>');
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': buf.length,
    'cache-control': 'no-store, must-revalidate',
    'x-frame-options': 'DENY',
  });
  res.end(buf);
}

async function handleAdminLogin(req, res) {
  const ip = clientIp(req);
  const wait = loginLockRemaining(ip);
  if (wait > 0) {
    const sec = Math.ceil(wait / 1000);
    log(`[admin] 登录被拒（锁定中，还剩 ${sec} 秒）ip=${ip}`);
    res.setHeader('retry-after', String(sec));
    return sendJson(res, 429, { error: `尝试次数过多，请 ${sec} 秒后再试`, retryAfter: sec });
  }
  const body = await readSmallBody(req);
  if (!(await verifyAdminPassword(body.password))) {
    const r = noteLoginFail(req, ip, '登录');
    if (r.lockMs) {
      const sec = Math.ceil(r.lockMs / 1000);
      res.setHeader('retry-after', String(sec));
      return sendJson(res, 429, { error: `密码错误次数过多，已锁定 ${sec} 秒`, retryAfter: sec });
    }
    return sendJson(res, 401, { error: '密码错误', remainingTries: r.left });
  }
  loginFails.delete(ip);
  const s = issueSession();
  log(`[admin] 登录成功 ip=${ip}`);
  res.setHeader('set-cookie', sessionCookie(req, s.token, Math.floor(SESSION_TTL_MS / 1000)));
  return sendJson(res, 200, { ok: true, expiresAt: s.exp });
}

function handleAdminLogout(req, res) {
  const p = verifySession(req);
  if (p) {
    adminCfg.revoked.push({ n: p.n, exp: p.exp });
    adminCfg.revoked = adminCfg.revoked.filter((r) => r.exp > Date.now()).slice(-500);
    writeAdminFile();
    log(`[admin] 已退出登录 ip=${clientIp(req)}`);
  }
  res.setHeader('set-cookie', sessionCookie(req, '', 0));
  return sendJson(res, 200, { ok: true });
}

async function handleAdminPassword(req, res) {
  if (ADMIN_ENV_PASSWORD) {
    return sendJson(res, 409, { error: '当前密码由环境变量 ADMIN_PASSWORD 管理，请修改环境变量后重启服务' });
  }
  const ip = clientIp(req);
  const wait = loginLockRemaining(ip);
  if (wait > 0) {
    const sec = Math.ceil(wait / 1000);
    res.setHeader('retry-after', String(sec));
    return sendJson(res, 429, { error: `尝试次数过多，请 ${sec} 秒后再试`, retryAfter: sec });
  }
  const body = await readSmallBody(req);
  const next = typeof body.newPassword === 'string' ? body.newPassword : '';
  if (next.length < 8 || next.length > 256) return sendJson(res, 400, { error: '新密码长度需在 8～256 个字符之间' });
  // 注意：当前密码错返回 403 而不是 401，免得面板把人踢回登录页
  if (!(await verifyAdminPassword(body.currentPassword))) {
    noteLoginFail(req, ip, '修改密码（当前密码校验）');
    return sendJson(res, 403, { error: '当前密码不正确' });
  }
  loginFails.delete(ip);
  adminCfg.passwordHash = scryptHashSync(next);
  adminCfg.updatedAt = Date.now();
  adminCfg.revoked = [];
  if (!writeAdminFile()) return sendJson(res, 500, { error: '写入 admin.json 失败，密码未持久化' });
  log(`[admin] 管理员密码已修改，旧会话全部失效 ip=${ip}`);
  // 指纹已变：给当前浏览器重新签一张，其余会话全部作废
  const s = issueSession();
  res.setHeader('set-cookie', sessionCookie(req, s.token, Math.floor(SESSION_TTL_MS / 1000)));
  return sendJson(res, 200, { ok: true });
}

/** 模型 API（走 zck_ 密钥鉴权，不受面板登录影响） */
function isModelApiPath(pathname) {
  const p = pathname.replace(/^\/v1\/v1(?=\/|$)/, '/v1');
  return p === '/v1' || p.startsWith('/v1/') || p === '/models' || p === '/messages' || p === '/chat/completions';
}

function isInternalCall(req) {
  const tok = String(req.headers['x-zcgw-internal'] || '');
  if (!tok || !LOOPBACK_IPS.includes(req.socket?.remoteAddress || '')) return false;
  const a = Buffer.from(tok), b = Buffer.from(INTERNAL_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * 管理面板闸门：返回 true 表示已经响应（登录页 / 401 / 403 / 认证接口），false 表示放行到原路由。
 */
function adminGate(req, res, url) {
  const p = url.pathname;
  if (req.method === 'GET' && p === '/health') return false;
  if (isModelApiPath(p)) return false;

  const fail = (e) => {
    log('[admin] 处理出错:', e?.message ?? String(e));
    if (!res.headersSent) sendJson(res, e?.status || 500, { error: e?.message || '服务端错误' });
    else res.end();
  };
  const csrfOk = () => {
    if (sameOriginRequest(req)) return true;
    log(`[admin] 拒绝跨站请求 ${req.method} ${p} ip=${clientIp(req)} origin=${req.headers.origin || '-'} referer=${req.headers.referer || '-'}`);
    sendJson(res, 403, { error: '跨站请求被拒绝（Origin/Referer 与 Host 不一致）' });
    return false;
  };

  if (req.method === 'GET' && p === '/login') {
    if (verifySession(req)) {
      res.writeHead(302, { location: '/', 'cache-control': 'no-store' });
      res.end();
      return true;
    }
    serveLoginPage(res);
    return true;
  }
  if (req.method === 'POST' && p === '/auth/login') {
    if (csrfOk()) handleAdminLogin(req, res).catch(fail);
    return true;
  }
  if (req.method === 'POST' && p === '/auth/logout') {
    if (csrfOk()) handleAdminLogout(req, res);
    return true;
  }

  if (isInternalCall(req)) return false;

  const session = verifySession(req);
  if (!session) {
    if (req.method === 'GET' && (p === '/' || p === '/dashboard')) {
      serveLoginPage(res);
      return true;
    }
    sendJson(res, 401, { error: '未登录或登录已过期，请先登录管理面板', code: 'unauthorized' });
    return true;
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !csrfOk()) return true;

  if (req.method === 'GET' && p === '/auth/me') {
    sendJson(res, 200, { ok: true, expiresAt: session.exp, envManaged: !!ADMIN_ENV_PASSWORD });
    return true;
  }
  if (req.method === 'POST' && p === '/auth/password') {
    handleAdminPassword(req, res).catch(fail);
    return true;
  }
  return false;
}

// ── 用量采集（内存环形 + jsonl 落盘）──
const USAGE_MAX = 6000;
let usageLog = [];

try {
  if (fs.existsSync(USAGE_FILE)) {
    const lines = fs.readFileSync(USAGE_FILE, 'utf8').trim().split('\n').slice(-USAGE_MAX);
    for (const l of lines) {
      try {
        usageLog.push(JSON.parse(l));
      } catch {}
    }
    log(`已载入历史用量记录 ${usageLog.length} 条`);
  }
} catch {}

function recordUsage(req, rec) {
  // 请求日志带来源 IP 与 UA（wb2api logs 风格，方便事后审计谁在用什么打进来）
  if (req && req.headers) {
    rec.ip = clientIp(req);
    rec.ua = String(req.headers['user-agent'] || '').slice(0, 80) || undefined;
  }
  usageLog.push(rec);
  if (usageLog.length > USAGE_MAX) usageLog = usageLog.slice(-USAGE_MAX);
  try {
    fs.appendFileSync(USAGE_FILE, JSON.stringify(rec) + '\n');
  } catch {}
  
  // 同步累到密钥头上
  if (rec.keyId) {
    const k = keyDb.keys.find((x) => x.id === rec.keyId);
    if (k) {
      k.usedTokens = (k.usedTokens || 0) + (rec.in || 0) + (rec.out || 0) + (rec.cacheRead || 0) + (rec.cacheCreate || 0);
      k.requests = (k.requests || 0) + 1;
      k.lastUsedAt = rec.t;
      writeKeys(keyDb);
    }
  }
}

/** 从文本里抽出所有 `"key": {...}` 的 JSON 对象（支持嵌套，正则拿不下 server_tool_use） */
function extractJsonObjects(text, key) {
  const out = [];
  const needle = `"${key}"`;
  let idx = 0;
  while ((idx = text.indexOf(needle, idx)) !== -1) {
    const i = text.indexOf('{', idx + needle.length);
    if (i === -1) break;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end === -1) break;
    out.push(text.slice(i, end + 1));
    idx = end;
  }
  return out;
}

/** 从 SSE 文本里抽 usage（message_start / message_delta 两处合并取最大） */
function usageFromSse(text) {
  const out = { in: 0, out: 0, cacheRead: 0, cacheCreate: 0 };
  for (const seg of extractJsonObjects(text, 'usage')) {
    try {
      const u = JSON.parse(seg);
      if (u.input_tokens > out.in) out.in = u.input_tokens;
      if (u.output_tokens > out.out) out.out = u.output_tokens;
      if (u.cache_read_input_tokens > out.cacheRead) out.cacheRead = u.cache_read_input_tokens;
      if (u.cache_creation_input_tokens > out.cacheCreate) out.cacheCreate = u.cache_creation_input_tokens;
    } catch {}
  }
  return out;
}

function usageFromJson(obj) {
  const u = obj?.usage ?? {};
  return {
    in: u.input_tokens || 0,
    out: u.output_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    cacheCreate: u.cache_creation_input_tokens || 0,
  };
}

// ── 主处理 ──
/** OpenAI /v1/chat/completions → Anthropic /v1/messages 转换适配 */
function openaiToAnthropic(body) {
  const msgs = [];
  let system = '';
  for (const m of body.messages ?? []) {
    if (m.role === 'system' || m.role === 'developer') {
      system += (typeof m.content === 'string' ? m.content : (m.content ?? []).map((c) => c.text ?? '').join('\n')) + '\n\n';
    } else if (m.role === 'user' || m.role === 'assistant') {
      // OpenAI tool 消息（role=tool）合井成 assistant/tool_result 略复杂，先支持纯文本 + tool_calls 主流场景
      const text = typeof m.content === 'string'
        ? m.content
        : (m.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('');
      msgs.push({ role: m.role, content: text || ' ' });
    } else if (m.role === 'tool') {
      msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: String(m.content ?? '') }] });
    }
  }
  if (!msgs.length) msgs.push({ role: 'user', content: ' ' });
  const out = {
    model: body.model || DEFAULT_MODEL,
    max_tokens: body.max_tokens || body.max_completion_tokens || 8192,
    stream: !!body.stream,
    messages: msgs,
  };
  if (system.trim()) out.system = system.trim();
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.stop) out.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  return out;
}

function anthropicToOpenAI(env, model) {
  const text = (env.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const toolCalls = (env.content ?? []).filter((b) => b.type === 'tool_use').map((b, i) => ({
    id: b.id,
    type: 'function',
    function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
  }));
  const message = { role: 'assistant', content: text || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id: env.id || 'chatcmpl-' + crypto.randomUUID(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: env.stop_reason === 'tool_use' ? 'tool_calls' : env.stop_reason === 'max_tokens' ? 'length' : 'stop' }],
    usage: {
      prompt_tokens: env.usage?.input_tokens || 0,
      completion_tokens: env.usage?.output_tokens || 0,
      total_tokens: (env.usage?.input_tokens || 0) + (env.usage?.output_tokens || 0),
    },
  };
}

async function handleOpenAIChat(req, res) {
  const raw = await readBody(req);
  let body;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return sendJson(res, 400, { error: { message: 'bad JSON', type: 'invalid_request_error' } });
  }
  const inbound = openaiToAnthropic(body);

  // 鉴权 + IP 管控（与 /v1/messages 同一套）
  const sec = secCheckIp(clientIp(req));
  if (!sec.allowed) {
    secLogBlocked(req, urlPathnameOf(req), sec.reason);
    return sendJson(res, 403, { error: { message: sec.reason, type: 'permission_error' } });
  }
  const auth = authenticate(req, inbound.model);
  if (!auth.ok) {
    if (auth.status === 401 || auth.status === 403) secLogBlocked(req, urlPathnameOf(req), auth.message, false);
    return sendJson(res, auth.status, { error: { message: auth.message, type: 'authentication_error' } });
  }
  const reqKey = auth.key;
  const startedAt = Date.now();
  const basePayload = buildUpstreamBody(inbound, { uid: 'placeholder' });
  // OpenAI 入口永远非流式转换（stream:true 的 OpenAI 客户端后续再做 SSE 转发）
  basePayload.stream = false;
  const sessionKey = sessionKeyOf(req, inbound);

  if (accounts.length === 0) {
    return sendJson(res, 503, { error: { message: '还没有可用的 ZCode 账号，请先在管理面板登录纳管账号', type: 'api_error' } });
  }
  const maxAttempts = Math.min(accounts.length, 4);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) stickyUnbind(sessionKey);
    const acc = pickAccount(sessionKey);
    if (!acc) {
      const soonest = Math.min(...accounts.map((a) => Math.max(a.cooldownUntil, a.degradeUntil)));
      return sendJson(res, 429, { error: { message: `所有账号不可用，${Math.ceil((soonest - Date.now()) / 60000)} 分钟后重试`, type: 'rate_limit_error' } });
    }
    acc.lastUsedAt = Date.now();
    const payload = { ...basePayload, metadata: { user_id: buildUserId(acc) } };

    let upstream;
    acc.inFlight += 1;
    try {
      upstream = await fetch(UPSTREAM_URL, {
        method: 'POST',
        headers: upstreamHeaders(acc),
        body: JSON.stringify(payload),
      });
    } catch (e) {
      acc.inFlight -= 1;
      markFailure(acc, 60_000);
      continue;
    }

    const rawBody = await upstream.text().catch(() => '');
    acc.inFlight -= 1;
    let env = null;
    try { env = JSON.parse(rawBody); } catch {}
    const biz = env?.error?.biz_code ?? env?.biz_code;

    if (upstream.ok && env) {
      markSuccess(acc);
      stickySet(sessionKey, acc.label);
      const u = usageFromJson(env);
      recordUsage(req, {
        t: Date.now(), keyId: reqKey?.id || 0, key: reqKey?.name || 'master', acc: acc.label,
        model: inbound.model, in: u.in, out: u.out, cacheRead: u.cacheRead, cacheCreate: u.cacheCreate,
        ms: Date.now() - startedAt, ok: true,
      });
      return sendJson(res, 200, anthropicToOpenAI(env, body.model || inbound.model));
    }

    if (biz === 3012) { markFailure(acc, POOL.blockedCooldownMin * 60_000); stickyUnbind(sessionKey); continue; }
    if (biz === 1005 || biz === 3009) {
      const heavy = acc.consecutiveFails >= 2;
      markFailure(acc, heavy ? POOL.quotaCooldownMin * 60_000 : POOL.busyCooldownSec * 1000);
      continue;
    }
    if (upstream.status >= 500) { markFailure(acc, 60_000); stickyUnbind(sessionKey); continue; }

    // 客户端错误直接透传（OpenAI 风格包装）
    recordUsage(req, {
      t: Date.now(), keyId: reqKey?.id || 0, key: reqKey?.name || 'master', acc: acc.label,
      model: inbound.model, in: 0, out: 0, cacheRead: 0, cacheCreate: 0,
      ms: Date.now() - startedAt, ok: false, err: biz ? String(biz) : `http-${upstream.status}`,
    });
    return sendJson(res, upstream.status, { error: { message: env?.error?.message || rawBody.slice(0, 300) || `upstream ${upstream.status}`, type: 'api_error' } });
  }
  recordUsage(req, {
    t: Date.now(), keyId: reqKey?.id || 0, key: reqKey?.name || 'master', acc: '-',
    model: inbound.model, in: 0, out: 0, cacheRead: 0, cacheCreate: 0,
    ms: Date.now() - startedAt, ok: false, err: 'all-accounts-failed',
  });
  sendJson(res, 502, { error: { message: '所有账号尝试失败', type: 'api_error' } });
}

async function handleMessages(req, res) {
  const raw = await readBody(req);
  let inbound;
  try {
    inbound = JSON.parse(raw.toString('utf8'));
  } catch {
    return sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'bad JSON' } });
  }
  const reqModel = inbound.model || DEFAULT_MODEL;
  // 全局 IP 管控（在密钥鉴权之前；拦截落审计日志）
  const sec = secCheckIp(clientIp(req));
  if (!sec.allowed) {
    secLogBlocked(req, urlPathnameOf(req), sec.reason);
    return sendJson(res, 403, { type: 'error', error: { type: 'permission_error', message: sec.reason } });
  }
  const auth = authenticate(req, reqModel);
  if (!auth.ok) {
    if (auth.status === 401 || auth.status === 403) secLogBlocked(req, urlPathnameOf(req), auth.message, false);
    return sendJson(res, auth.status, {
      type: 'error',
      error: { type: 'authentication_error', message: auth.message },
    });
  }
  const reqKey = auth.key;
  const startedAt = Date.now();
  const basePayload = buildUpstreamBody(inbound, { uid: 'placeholder' });
  const sessionKey = sessionKeyOf(req, inbound);

  if (accounts.length === 0) {
    return sendJson(res, 503, { error: { message: '还没有可用的 ZCode 账号，请先在管理面板登录纳管账号', type: 'api_error' } });
  }
  const maxAttempts = Math.min(accounts.length, 4);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // 重试时先解绑粘性：粘住的号已经失败过，继续粘着只会再撞一次墙
    if (attempt > 0) stickyUnbind(sessionKey);
    const acc = pickAccount(sessionKey);
    if (!acc) {
      const soonest = Math.min(...accounts.map((a) => Math.max(a.cooldownUntil, a.degradeUntil)));
      return sendJson(res, 429, {
        type: 'error',
        error: { type: 'rate_limit_error', message: `所有账号不可用，${Math.ceil((soonest - Date.now()) / 60000)} 分钟后重试` },
      });
    }
    acc.lastUsedAt = Date.now();

    // metadata.user_id 必须按当前账号派生，否则会把不同号关联到同一台设备
    const payload = { ...basePayload, metadata: { user_id: buildUserId(acc) } };

    let upstream;
    acc.inFlight += 1;
    try {
      upstream = await fetch(UPSTREAM_URL, {
        method: 'POST',
        headers: upstreamHeaders(acc),
        body: JSON.stringify(payload),
      });
    } catch (e) {
      acc.inFlight -= 1;
      acc.lastErr = `network: ${e.message}`;
      log(`[${acc.label}] network error: ${e.message}`);
      markFailure(acc, 60_000);
      continue;
    }

    const ctype = upstream.headers.get('content-type') || 'application/json';
    const isStream = ctype.includes('text/event-stream');

    if (!isStream) {
      const buf = Buffer.from(await upstream.arrayBuffer());
      acc.inFlight -= 1;
      const text = buf.toString('utf8');
      let env;
      try {
        env = JSON.parse(text);
      } catch {}
      const biz = env?.code;
      if (biz === 3012) {
        acc.lastErr = '3012 blocked';
        log(`[${acc.label}] 3012 blocked, cooling ${POOL.blockedCooldownMs / 60000}min, next account`);
        markFailure(acc, POOL.blockedCooldownMs);
        stickyUnbind(sessionKey); // 粘住的号失效了，解绑让下一次请求重新选号
        continue;
      }
      if (biz === 1005 || biz === 3009) {
        // 这两个码既是“额度用完”也是“并发超限”，不可一律重罚：
        // 先按瞬态短冷却，连续多次才当真的额度耗尽
        const heavy = acc.consecutiveFails >= 2;
        const ms = heavy ? POOL.quotaCooldownMs : POOL.busyCooldownMs;
        acc.lastErr = `${biz} ${heavy ? 'quota' : 'busy'}`;
        log(`[${acc.label}] ${biz} -> 冷却 ${Math.round(ms / 1000)}s，换下一个号`);
        markFailure(acc, ms);
        stickyUnbind(sessionKey);
        continue;
      }
      if (upstream.status >= 500) {
        acc.lastErr = `http-${upstream.status}`;
        markFailure(acc, 60_000);
        stickyUnbind(sessionKey);
        continue;
      }
      if (upstream.ok) {
        markSuccess(acc);
        stickySet(sessionKey, acc.label);
      }
      const u = upstream.ok ? usageFromJson(env) : { in: 0, out: 0, cacheRead: 0, cacheCreate: 0 };
      recordUsage(req, {
        t: Date.now(),
        keyId: reqKey?.id || 0,
        key: reqKey?.name || 'master',
        acc: acc.label,
        model: payload.model,
        ...u,
        ms: Date.now() - startedAt,
        ok: upstream.ok,
        err: upstream.ok ? '' : biz ? String(biz) : `http-${upstream.status}`,
      });
      res.writeHead(upstream.status, { 'content-type': ctype, 'content-length': buf.length, 'x-zcgw-account': acc.label });
      return res.end(buf);
    }

    if (VERBOSE) log(`[${acc.label}] stream ${upstream.status} model=${payload.model} sticky=${!!sessionKey}`);
    if (upstream.ok) {
      markSuccess(acc);
      stickySet(sessionKey, acc.label);
    }
    res.writeHead(upstream.status, {
      'content-type': ctype,
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-zcgw-account': acc.label,
    });
    if (!upstream.body) {
      acc.inFlight -= 1;
      return res.end();
    }
    const reader = upstream.body.getReader();
    let sseBuf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = Buffer.from(value);
        if (sseBuf.length < 400_000) sseBuf += buf.toString('utf8');
        if (!res.write(buf)) await new Promise((r) => res.once('drain', r));
      }
    } catch (e) {
      if (VERBOSE) log('stream error:', e.message);
    } finally {
      acc.inFlight -= 1;
      const u = upstream.ok ? usageFromSse(sseBuf) : { in: 0, out: 0, cacheRead: 0, cacheCreate: 0 };
      recordUsage(req, {
        t: Date.now(),
        keyId: reqKey?.id || 0,
        key: reqKey?.name || 'master',
        acc: acc.label,
        model: payload.model,
        ...u,
        ms: Date.now() - startedAt,
        ok: upstream.ok,
        err: upstream.ok ? '' : `http-${upstream.status}`,
      });
      res.end();
    }
    return;
  }
  recordUsage(req, {
    t: Date.now(),
    keyId: reqKey?.id || 0,
    key: reqKey?.name || 'master',
    acc: '-',
    model: reqModel,
    in: 0,
    out: 0,
    cacheRead: 0,
    cacheCreate: 0,
    ms: Date.now() - startedAt,
    ok: false,
    err: 'all-accounts-failed',
  });
  sendJson(res, 502, { type: 'error', error: { type: 'api_error', message: '所有账号尝试失败' } });
}

function handlePool(req, res) {
  const now = Date.now();
  sendJson(res, 200, {
    pool: {
      maxInFlight: POOL.maxInFlight,
      topN: POOL.topN,
      stickyTtlMin: POOL.stickyTtlMin,
    },
    stickySessions: sticky.size,
    accounts: accounts.map((a) => ({
      label: a.label,
      userId: a.uid,
      email: a.email,
      phone: a.phone,
      name: a.name,
      identity: a.identity,
      weight: a.weight ?? 1,
      hasAccessToken: a.hasAccessToken,
      realm: a.realm,
      realmZh: a.realmZh,
      local: !!a.local,
      deviceId: a.deviceId || deviceIdFor(a.uid),
      available: a.cooldownUntil <= now && a.degradeUntil <= now && a.inFlight < POOL.maxInFlight,
      cooling: a.cooldownUntil > now,
      cooldownMin: a.cooldownUntil > now ? Math.ceil((a.cooldownUntil - now) / 60000) : 0,
      degraded: a.degradeUntil > now,
      inFlight: a.inFlight,
      failures: a.failures,
      consecutiveFails: a.consecutiveFails,
      successCount: a.successCount || 0,
      errTotal: a.errTotal || 0,
      lastUsedAt: a.lastUsedAt || 0,
      manualWeight: a.weight ?? 1,
      weight: Math.round(weightOf(a, Math.max(1, ...accounts.map((x) => quotaCache.get(x.label)?.remaining || 0)), now) * 10) / 10,
      lastSuccess: a.lastSuccess,
      lastErr: a.lastErr,
      autoClaim: autoClaimDb[a.label]?.last || null,
    })),
    autoClaim: autoClaimInfo(),
  });
}

/** 逐号查余额（billing/balance），同时喂给选号权重缓存 */
async function handleQuota(req, res) {
  const out = [];
  for (const acc of accounts) {
    try {
      const r = await fetch(`${UPSTREAM_ORIGIN}/api/v1/zcode-plan/billing/balance?app_version=${APP_VERSION}`, {
        headers: upstreamHeaders(acc),
        signal: AbortSignal.timeout(20000),
      });
      const j = await safeJson(r);
      const d = j.data ?? {};
      out.push({
        label: acc.label,
        userId: acc.uid,
        email: acc.email,
        name: acc.name,
        identity: acc.identity,
        realm: acc.realm,
        realmZh: acc.realmZh,
        plans: (d.plans ?? []).map((p) => {
          const dp = describePlan(p.plan_id, p.name);
          return {
            id: p.plan_id,
            name: p.name,
            nameZh: dp.nameZh,
            kind: dp.kind,
            kindZh: dp.kindZh,
            status: p.status,
            endsAt: p.ends_at,
          };
        }),
        balances: (d.balances ?? []).map((b) => {
          const db = describePlan(b.plan_id, b.show_name);
          return {
            model: b.show_name,
            kind: db.kind,
            kindZh: db.kindZh,
            typeZh: `${db.kindZh} · ${b.show_name}`,
            remaining: b.remaining_units,
            total: b.total_units,
            periodEnd: b.period_end,
          };
        }),
        error: j.code !== 0 ? j : undefined,
      });
    } catch (e) {

      out.push({ label: acc.label, error: e.message });
    }
  }
  setQuotaCache(out);
  sendJson(res, 200, { accounts: out });
}

// ── 领取额度：发现（marketing/touch + preview + 兜底猜测）→ 铸验证码参数 → billing/claim ──
//
// 2026-11-03 起：billing/preview 基本为空，当日活动包改由营销投放流 GET /api/v1/marketing/touch 下发，
// 且投放按客户端版本灰度（3.16.3 头拿到空 deliveries，3.17.2 才有）。claim 本身不变，但要求
// 阿里云无痕验证参数（X-Aliyun-Captcha-Verify-Param），否则 400 {code:3007,"captcha verify failed"}。
// 参数只能由真实浏览器里的官方 SDK 产出 → 由可选的 captcha sidecar（captcha/ 目录）铸造。
// 领取相关请求用的客户端版本（与模型请求的 APP_VERSION 分开，避免影响对话请求指纹）
const CLAIM_APP_VERSION = process.env.ZCODE_CLAIM_APP_VERSION || '3.17.2';
// captcha sidecar：例 http://zcgw-captcha:8790 ；不设 = 不自动过验证，遇 3007 提示手动领取
const CAPTCHA_URL = String(process.env.CAPTCHA_URL || '').trim().replace(/\/+$/, '');
const CAPTCHA_TOKEN = String(process.env.CAPTCHA_TOKEN || '').trim();
const CAPTCHA_MINT_TIMEOUT_MS = Number(process.env.CAPTCHA_MINT_TIMEOUT_MS || 200_000);
const MANUAL_CLAIM_MSG = '需要在 ZCode 客户端手动领取（触发了人机验证）';

/** 领取类请求的请求头：在通用头基础上换成当前客户端版本，按需带上验证码参数 */
function claimHeaders(acc, captcha) {
  const h = {
    ...upstreamHeaders(acc),
    'user-agent': `ZCode/${CLAIM_APP_VERSION}`,
    'x-zcode-app-version': CLAIM_APP_VERSION,
    accept: 'application/json',
  };
  // 领取不是模型请求，去掉 Anthropic 专属头
  delete h['anthropic-version'];
  delete h['anthropic-beta'];
  if (captcha?.param) {
    h['X-Aliyun-Captcha-Verify-Param'] = captcha.param;
    h['X-Aliyun-Captcha-Verify-Region'] = captcha.region || 'cn';
  }
  return h;
}

// sidecar 状态（面板展示用）
const captchaState = { lastMintAt: 0, lastOkAt: 0, lastResult: '', lastError: '', health: null, healthAt: 0 };

/**
 * 向 sidecar 要一个一次性的验证码参数。
 * 返回 {ok:true, param, region} | {ok:false, reason:'unconfigured'|'challenge'|'timeout'|'error', detail}
 */
async function mintCaptcha() {
  if (!CAPTCHA_URL) return { ok: false, reason: 'unconfigured', detail: '未配置 CAPTCHA_URL' };
  captchaState.lastMintAt = Date.now();
  try {
    const r = await fetch(`${CAPTCHA_URL}/mint`, {
      method: 'POST',
      headers: { authorization: `Bearer ${CAPTCHA_TOKEN}`, 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(CAPTCHA_MINT_TIMEOUT_MS),
    });
    const j = await safeJson(r);
    if (r.ok && typeof j.param === 'string' && j.param.trim()) {
      captchaState.lastOkAt = Date.now();
      captchaState.lastResult = 'ok';
      captchaState.lastError = '';
      return { ok: true, param: j.param.trim(), region: j.region || 'cn' };
    }
    const reason = r.status === 409 || j.error === 'challenge' ? 'challenge' : r.status === 504 ? 'timeout' : 'error';
    const detail = r.status === 401 ? 'CAPTCHA_TOKEN 与 sidecar 不一致（401）' : j.detail || j.error || j.__error || `HTTP ${r.status}`;
    captchaState.lastResult = reason;
    captchaState.lastError = detail;
    return { ok: false, reason, detail };
  } catch (e) {
    const reason = e?.name === 'TimeoutError' ? 'timeout' : 'error';
    captchaState.lastResult = reason;
    captchaState.lastError = e.message;
    return { ok: false, reason, detail: e.message };
  }
}

/** sidecar 健康状态（缓存 60 秒） */
async function captchaStatus(force = false) {
  const base = {
    configured: !!CAPTCHA_URL,
    url: CAPTCHA_URL || null,
    hasToken: !!CAPTCHA_TOKEN,
    lastMintAt: captchaState.lastMintAt,
    lastOkAt: captchaState.lastOkAt,
    lastResult: captchaState.lastResult,
    lastError: captchaState.lastError,
  };
  if (!CAPTCHA_URL) return { ...base, healthy: false };
  if (force || !captchaState.health || Date.now() - captchaState.healthAt > 60_000) {
    try {
      const r = await fetch(`${CAPTCHA_URL}/health`, {
        headers: { authorization: `Bearer ${CAPTCHA_TOKEN}` },
        signal: AbortSignal.timeout(5000),
      });
      const j = await safeJson(r);
      captchaState.health = { healthy: r.ok && j.ok === true, detail: j, error: r.ok ? '' : `HTTP ${r.status}` };
    } catch (e) {
      captchaState.health = { healthy: false, detail: null, error: e.message };
    }
    captchaState.healthAt = Date.now();
  }
  const d = captchaState.health.detail || {};
  return {
    ...base,
    healthy: captchaState.health.healthy,
    // 带了正确 token 才会有这些字段；没有说明 token 不一致
    authorized: d.browser !== undefined,
    browser: d.browser || null,
    browserUp: d.connected ?? null,
    sidecarMints: d.mints ?? null,
    sidecarOk: d.okCount ?? null,
    sidecarLastError: d.lastError || '',
    healthError: captchaState.health.error,
  };
}

/** 验证码失败原因 → 给用户看的说明 */
function manualReason(reason, detail) {
  if (reason === 'unconfigured') return `${MANUAL_CLAIM_MSG}；未配置验证码 sidecar（CAPTCHA_URL）`;
  if (reason === 'challenge') return `${MANUAL_CLAIM_MSG}；阿里云要求可见验证（滑块等），按规则不自动处理`;
  if (reason === 'timeout') return `${MANUAL_CLAIM_MSG}；验证码 sidecar 铸参超时`;
  if (reason === 'rejected') return `${MANUAL_CLAIM_MSG}；上游拒绝了验证码参数（3007，已换新参数重试一次）`;
  return `${MANUAL_CLAIM_MSG}；验证码 sidecar 异常：${detail || '未知错误'}`;
}

// marketing/touch 的 seq：客户端进程内的请求计数（只用于服务端日志定位，不是分页）
let touchSeq = 0;

/** 从营销投放流里找 claim_zcode_plan 按钮（不依赖具体嵌套位置） */
function touchPlansFrom(data) {
  const out = [];
  const deliveries = data?.deliveries;
  if (!Array.isArray(deliveries)) return out;
  for (const dv of deliveries) {
    const ids = [];
    const names = [];
    const walk = (v, depth) => {
      if (!v || typeof v !== 'object' || depth > 12) return;
      if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
      if (v.type === 'claim_zcode_plan' && typeof v.args?.plan_id === 'string' && v.args.plan_id.trim()) ids.push(v.args.plan_id.trim());
      const zp = v.zcode_plan || v.zcodePlan;
      if (zp && typeof zp === 'object' && typeof zp.name === 'string') names.push(zp.name);
      for (const k of Object.keys(v)) walk(v[k], depth + 1);
    }
    walk(dv, 0);
    for (const id of ids) if (!out.some((p) => p.planId === id)) out.push({ planId: id, name: names[0] || id, source: 'touch' });
  }
  return out;
}

/** 营销投放流（v3.17 客户端唯一的活动包来源） */
async function touchPlansFor(acc) {
  try {
    const r = await fetch(`${UPSTREAM_ORIGIN}/api/v1/marketing/touch?seq=${touchSeq++}`, {
      headers: claimHeaders(acc),
      signal: AbortSignal.timeout(20000),
    });
    const j = await safeJson(r);
    if (j.code !== 0) return { plans: [], error: j.msg || j.__error || `HTTP ${r.status}` };
    return { plans: touchPlansFrom(j.data) };
  } catch (e) {
    return { plans: [], error: e.message };
  }
}

/** 可领取的 plan 列表：营销投放流 + preview（preview 自 11-03 起基本为空，保留作兼容） */
async function claimableFor(acc) {
  const [touch, preview] = await Promise.all([
    touchPlansFor(acc),
    (async () => {
      try {
        const r = await fetch(
          `${UPSTREAM_ORIGIN}/api/v1/zcode-plan/billing/preview?app_version=${CLAIM_APP_VERSION}&platform=win32-x64`,
          { headers: claimHeaders(acc), signal: AbortSignal.timeout(20000) },
        );
        return await safeJson(r);
      } catch (e) {
        return { __error: e.message };
      }
    })(),
  ]);
  const plans = [...touch.plans];
  for (const p of preview.data?.plans ?? []) {
    if (plans.some((x) => x.planId === p.plan_id)) continue;
    plans.push({
      planId: p.plan_id,
      name: p.name,
      description: p.description,
      source: 'preview',
      entitlements: (p.entitlements ?? []).map((e) => ({ model: e.show_name, grant: e.grant_units, period: e.period })),
    });
  }
  return {
    plans,
    touchError: touch.error,
    rawCode: preview.code ?? (preview.__error ? -1 : 0),
    rawMsg: preview.msg ?? preview.__error ?? '',
  };
}

/** 从 balance 里看当前已激活的套餐 */
async function activeGrants(acc) {
  try {
    const r = await fetch(`${UPSTREAM_ORIGIN}/api/v1/zcode-plan/billing/balance?app_version=${APP_VERSION}`, {
      headers: upstreamHeaders(acc),
      signal: AbortSignal.timeout(20000),
    });
    const j = await safeJson(r);
    const now = Date.now() / 1000;
    return (j.data?.plans ?? []).filter((p) => p.status === 'active' && (p.ends_at ?? 0) > now);
  } catch {
    return [];
  }
}

/** 单次 claim POST，返回 {code, msg, data} 或 {code:'network'|'http-xxx', msg} */
async function postClaim(acc, pid, captcha) {
  try {
    const r = await fetch(`${UPSTREAM_ORIGIN}/api/v1/zcode-plan/billing/claim`, {
      method: 'POST',
      headers: claimHeaders(acc, captcha),
      body: JSON.stringify({ plan_id: pid }),
      signal: AbortSignal.timeout(CLAIM_TIMEOUT_MS),
    });
    const text = await r.text();
    try {
      const j = JSON.parse(text);
      return { code: j.code, msg: j.data?.message || j.msg || '', data: j.data, status: r.status };
    } catch {
      return { code: `http-${r.status}`, msg: text.slice(0, 80) || '(空响应)', status: r.status };
    }
  } catch (e) {
    return { code: 'network', msg: e.message };
  }
}

/**
 * 领取：营销投放流 / preview 里有就领那些；再按「缺哪类补哪类」试兜底 id。
 * 活动包 id 有日期编码（例：zcode-v3-start-plan-1030-wk = 10月30日周末）。
 * 北京时间 0 点会跳日，所以兜底候选跨 ±1 天。
 *
 * 验证码：配置了 CAPTCHA_URL 时，每个 claim POST 前现铸一个参数（一次性）；
 * 上游回 3007 时换新参数重试一次，仍 3007 → 本账号本轮停止，标记「需手动领取」。
 * 未配置 / sidecar 返回 challenge 或出错 → 同样停止并提示手动领取（不再逐个候选去撞 3007）。
 */
async function claimFor(acc, planId) {
  const candidates = planId ? [planId] : [];
  let offered = [];

  if (!planId) {
    const active = await activeGrants(acc);
    const activeIds = new Set(active.map((p) => p.plan_id));
    const activeKinds = new Set(active.map((p) => describePlan(p.plan_id, p.name).kind));

    const { plans } = await claimableFor(acc);
    offered = plans.filter((p) => !activeIds.has(p.planId));
    for (const p of offered) candidates.push(p.planId);

    const bj = Date.now() + 8 * 3600_000;
    const stamps = [0, -1, 1].map((delta) => {
      const d = new Date(bj + delta * 86400_000);
      return `${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
    });
    const missingKinds = [];
    // 投放流没给东西时才猜兜底 id（每个猜测都要消耗一个验证码参数，能少则少）
    if (!offered.length) {
      if (!activeKinds.has('promo')) {
        for (const s of stamps) candidates.push(`zcode-v3-start-plan-${s}-wk`);
        missingKinds.push('promo');
      }
      // 每日体验包：固定 id、一次性，领过就永久标记 → 只试这一个，不多发请求（多发会 429）
      if (!activeKinds.has('daily')) {
        candidates.push('zcode-v3-start-plan-0817');
        missingKinds.push('daily');
      }
    }

    if (!candidates.length) {
      const first = active[0];
      return {
        ok: true,
        alreadyClaimed: true,
        state: 'active',
        claimed: first?.plan_id,
        msg: first ? `${first.name} 已生效` : '已领取',
      };
    }
  }

  const tried = [];
  const claimed = [];
  const dup = [];
  let manual = null;
  const budgetDefault = CAPTCHA_URL ? 300000 : 25000;
  const deadline = Date.now() + Number(process.env.ZCGW_CLAIM_BUDGET_MS || budgetDefault);
  for (const pid of [...new Set(candidates)]) {
    if (Date.now() > deadline) {
      tried.push({ planId: '(...)', code: 'budget', msg: '候选太多，已超时中止' });
      break;
    }
    let captcha = null;
    if (CAPTCHA_URL) {
      captcha = await mintCaptcha();
      if (!captcha.ok) {
        manual = { reason: captcha.reason, detail: captcha.detail };
        tried.push({ planId: pid, code: `captcha-${captcha.reason}`, msg: captcha.detail });
        log(`[${acc.label}] 验证码铸参失败（${captcha.reason}）：${captcha.detail}`);
        break;
      }
    }
    let r = await postClaim(acc, pid, captcha);
    if (r.code === 3007 && CAPTCHA_URL) {
      // 参数一次性，被拒后换一个新参数只重试一次
      log(`[${acc.label}] claim ${pid} -> 3007，换新验证码参数重试一次`);
      const again = await mintCaptcha();
      if (!again.ok) {
        manual = { reason: again.reason, detail: again.detail };
        tried.push({ planId: pid, code: 3007, msg: MANUAL_CLAIM_MSG });
        break;
      }
      r = await postClaim(acc, pid, again);
    }
    const { code } = r;
    const msg = code === 3007 ? MANUAL_CLAIM_MSG : r.msg;
    tried.push({ planId: pid, code, msg });
    log(`[${acc.label}] claim ${pid} -> ${code} ${r.msg}`);

    if (code === 3007) {
      // 没配 sidecar → 未配置；配了但换参后仍 3007 → 上游拒绝
      manual = { reason: CAPTCHA_URL ? 'rejected' : 'unconfigured', detail: r.msg };
      break;
    }
    if (code === 0 && r.data?.plan) {
      claimed.push({ planId: pid, plan: r.data.plan });
      continue;
    }
    if (code === 1003) {
      dup.push({ planId: pid, msg: r.msg });
      continue;
    }
    // 429 / 3002 频率限制：本轮直接停，别再打
    if (code === 3002 || r.status === 429) break;
    // 1001 套餐不存在 / 1004 暂不符合 / 1005 名额已尽：继续试下一个候选
  }

  if (claimed.length) {
    return {
      ok: true,
      state: 'claimed',
      claimed: claimed.map((c) => c.planId).join(', '),
      claimedList: claimed.map((c) => c.planId),
      expired: dup.map((d) => d.planId),
      ...(manual ? { manual: true, manualMsg: manualReason(manual.reason, manual.detail) } : {}),
      tried,
    };
  }
  if (manual) {
    return {
      ok: false,
      manual: true,
      state: 'manual',
      captcha: manual.reason,
      msg: manualReason(manual.reason, manual.detail),
      offered: offered.map((p) => ({ planId: p.planId, name: p.name })),
      tried,
    };
  }
  if (dup.length) {
    // 缺失的类型回 1003 → 上游确实领过，但不在生效列表里 → 该一次性体验包已过期/用尽
    return {
      ok: true,
      alreadyClaimed: true,
      expired: true,
      state: 'expired',
      claimed: dup[0].planId,
      upstreamMsg: dup[0].msg || '',
      msg: '上游返回 1003（target already exists）：该号此前已领过体验包，当前不在生效列表，体验窗口已结束，无法重复领取',
      tried,
    };
  }
  const last = tried.at(-1);
  return {
    ok: false,
    state: 'none',
    code: last?.code,
    msg: last?.msg || '没有可领取的套餐',
    tried,
  };
}

// ── 自动领取记录：每个账号最近一次领取结果（面板展示），落盘 data/auto-claim.json ──
const AUTO_CLAIM_FILE = path.join(DATA_DIR, 'auto-claim.json');
let autoClaimDb = (() => {
  try { return JSON.parse(fs.readFileSync(AUTO_CLAIM_FILE, 'utf8')) || {}; } catch { return {}; }
})();
function saveAutoClaim() {
  try { fs.writeFileSync(AUTO_CLAIM_FILE, JSON.stringify(autoClaimDb, null, 2)); } catch {}
}
/** 北京时间日期 YYYY-MM-DD */
function bjDate(ts = Date.now()) {
  return new Date(ts + 8 * 3600_000).toISOString().slice(0, 10);
}
/** 把一次 claimFor 结果记到账号上。source: daily | weekend | manual | onboard */
function recordClaim(label, result, source) {
  const rec = autoClaimDb[label] || {};
  const last = {
    at: Date.now(),
    source,
    state: result.state || (result.ok ? (result.alreadyClaimed ? 'active' : 'claimed') : 'error'),
    ok: !!result.ok,
    manual: !!result.manual,
    claimed: result.claimed || '',
    msg: result.manualMsg || result.msg || '',
  };
  rec.last = last;
  if (source === 'daily' || source === 'weekend') {
    const today = bjDate();
    const key = source === 'daily' ? 'daily' : 'weekend';
    const slot = rec[key]?.date === today ? rec[key] : { date: today, attempts: 0 };
    slot.attempts += 1;
    slot.lastAt = last.at;
    slot.state = last.state;
    rec[key] = slot;
  }
  autoClaimDb[label] = rec;
  saveAutoClaim();
}

// ── 自动领取调度 ──
// 每 10 分钟醒一次（不是每次都领）：
//   每日：北京时间 dailyAt 起（默认 09:30）+ 当天随机 0–45 分钟抖动，每个账号每天领一次；
//         结果是「没有可领 / 出错」时同日最多再试 2 次、间隔 ≥3 小时（投放可能迟到），22:00 后不再试；
//         领到 / 已生效 / 已领过 / 需手动领取 → 当天不再碰。
//   周末：周五 18:00 ～ 周日 24:00，缺周末包的号每 ≥60 分钟试一次、每天最多 8 次（抢 1005 名额），
//         领到 / 需手动领取 / 已领过 → 当天停。
//   逐号串行，账号之间随机间隔 20–60 秒，避免集中打上游。
const AUTO_CLAIM = (() => {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'pool-settings.json'), 'utf8')) || {}; } catch {}
  const at = String(process.env.ZCGW_AUTO_CLAIM_AT || '09:30').match(/^(\d{1,2}):(\d{2})$/);
  const h = at ? Math.min(23, Number(at[1])) : 9;
  const m = at ? Math.min(59, Number(at[2])) : 30;
  return {
    enabled: process.env.ZCGW_AUTO_CLAIM !== '0' && saved.autoClaim !== false,
    weekend: process.env.ZCGW_WEEKEND_GRAB !== '0' && saved.weekendGrab !== false,
    dailyAt: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
    dailyStartMin: h * 60 + m,
    dailyEndMin: 22 * 60,
    jitterMin: 45,
    dailyMaxAttempts: 3,
    dailyRetryGapMs: 3 * 3600_000,
    weekendGapMs: 60 * 60_000,
    weekendMaxAttempts: 8,
  };
})();
// 当天的随机抖动（进程内，每个北京日一个值）
const dailyJitter = { date: '', min: 0 };
let autoClaimRunning = false;
const FINAL_STATES = new Set(['claimed', 'active', 'expired', 'manual']);

function bjClock(ts = Date.now()) {
  const d = new Date(ts + 8 * 3600_000);
  return { day: d.getUTCDay(), min: d.getUTCHours() * 60 + d.getUTCMinutes(), date: d.toISOString().slice(0, 10) };
}

function autoClaimInfo() {
  const c = bjClock();
  if (dailyJitter.date !== c.date) Object.assign(dailyJitter, { date: c.date, min: Math.floor(Math.random() * (AUTO_CLAIM.jitterMin + 1)) });
  const startMin = AUTO_CLAIM.dailyStartMin + dailyJitter.min;
  return {
    enabled: AUTO_CLAIM.enabled,
    weekend: AUTO_CLAIM.weekend,
    dailyAt: AUTO_CLAIM.dailyAt,
    todayStart: `${String(Math.floor(startMin / 60)).padStart(2, '0')}:${String(startMin % 60).padStart(2, '0')}`,
    captchaConfigured: !!CAPTCHA_URL,
  };
}

/** 这个账号这一轮要不要领、以什么名义（daily / weekend / null） */
function autoClaimDue(label, now = Date.now()) {
  const c = bjClock(now);
  const rec = autoClaimDb[label] || {};
  const startMin = AUTO_CLAIM.dailyStartMin + dailyJitter.min;
  const d = rec.daily?.date === c.date ? rec.daily : null;
  if (c.min >= startMin && c.min < AUTO_CLAIM.dailyEndMin) {
    if (!d) return 'daily';
    if (!FINAL_STATES.has(d.state) && d.attempts < AUTO_CLAIM.dailyMaxAttempts && now - d.lastAt >= AUTO_CLAIM.dailyRetryGapMs) return 'daily';
  }
  // 当天每日领取已出「需手动领取」，周末抢领也不再去撞验证码
  if (d?.state === 'manual') return null;
  if (AUTO_CLAIM.weekend) {
    const inWindow = (c.day === 5 && c.min >= 18 * 60) || c.day === 6 || c.day === 0;
    if (inWindow) {
      const w = rec.weekend?.date === c.date ? rec.weekend : null;
      if (!w) return 'weekend';
      if (!FINAL_STATES.has(w.state) && w.attempts < AUTO_CLAIM.weekendMaxAttempts && now - w.lastAt >= AUTO_CLAIM.weekendGapMs) return 'weekend';
    }
  }
  return null;
}

async function autoClaimTick() {
  if (!AUTO_CLAIM.enabled || autoClaimRunning) return;
  autoClaimRunning = true;
  try {
    autoClaimInfo(); // 刷新当天抖动
    let first = true;
    for (const acc of [...accounts]) {
      const due = autoClaimDue(acc.label);
      if (!due) continue;
      if (due === 'weekend') {
        // 周末抢领只针对缺周末包的号
        const active = await activeGrants(acc);
        if (active.some((p) => describePlan(p.plan_id, p.name).kind === 'promo')) {
          recordClaim(acc.label, { ok: true, alreadyClaimed: true, state: 'active', msg: '周末包已生效' }, 'weekend');
          continue;
        }
      }
      if (!first) await new Promise((r) => setTimeout(r, 20_000 + Math.floor(Math.random() * 40_000)));
      first = false;
      let r;
      try {
        r = await claimFor(acc);
      } catch (e) {
        r = { ok: false, state: 'error', msg: e.message };
      }
      recordClaim(acc.label, r, due);
      const tag = due === 'daily' ? '[auto-claim]' : '[weekend-grab]';
      if (r.state === 'claimed') log(`${tag} ${acc.label} 领取成功：${r.claimed}`);
      else if (r.state === 'manual') log(`${tag} ${acc.label} ${r.msg}`);
      else if (VERBOSE || r.state === 'error') log(`${tag} ${acc.label} ${r.state}：${r.msg || ''}`);
    }
  } finally {
    autoClaimRunning = false;
  }
}

/** 验证码 sidecar 状态（面板用）：GET /captcha/status */
async function handleCaptchaStatus(req, res, url) {
  sendJson(res, 200, await captchaStatus(url.searchParams.get('refresh') === '1'));
}

/** 可领取的 plan 列表（一键领取的前置） */
async function handleClaimable(req, res) {
  const out = [];
  for (const acc of accounts) {
    try {
      const { plans, rawCode, rawMsg, touchError } = await claimableFor(acc);
      out.push({
        label: acc.label,
        claimable: plans,
        touchError,
        raw: rawCode !== 0 || plans.length === 0 ? { code: rawCode, msg: rawMsg } : undefined,
      });
    } catch (e) {
      out.push({ label: acc.label, error: e.message });
    }
  }
  sendJson(res, 200, { accounts: out });
}

/** 一键领取：POST { label?, planId? } */
async function handleClaim(req, res) {
  const raw = await readBody(req);
  let body = {};
  try {
    body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
  } catch {}

  const targets = body.label ? accounts.filter((a) => a.label === body.label) : accounts;
  const results = [];
  for (const acc of targets) {
    try {
      const r = await claimFor(acc, body.planId);
      recordClaim(acc.label, r, 'manual');
      results.push({ label: acc.label, ...r });
    } catch (e) {
      results.push({ label: acc.label, ok: false, msg: e.message });
    }
  }
  sendJson(res, 200, { results });
}

// ── 无头登录（设备授权流）：登录即纳管，纳管即自动领取 ──
// flow 要落盘：网关重启不该把你正在等的那次授权弄丢
const FLOW_FILE = path.join(DATA_DIR, 'onboard-flows.json');
// 领领取的速度：每个候选 15s 就够，否则一个卡死的候选会拖到分钟级
const CLAIM_TIMEOUT_MS = Number(process.env.ZCGW_CLAIM_TIMEOUT_MS || 15000);

function readFlows() {
  try {
    const obj = JSON.parse(fs.readFileSync(FLOW_FILE, 'utf8'));
    const map = new Map();
    const cut = Date.now() - 20 * 60_000;
    for (const [k, v] of Object.entries(obj)) if (v.createdAt > cut) map.set(k, v);
    return map;
  } catch {
    return new Map();
  }
}

function writeFlows(map) {
  try {
    fs.writeFileSync(FLOW_FILE, JSON.stringify(Object.fromEntries(map), null, 2));
  } catch {}
}

const pendingFlows = readFlows(); // flowId -> { pollToken, createdAt }


/** 读某个账号的余额（统一格式，带中文标签） */
async function quotaOf(acc) {
  const q = await fetch(`${UPSTREAM_ORIGIN}/api/v1/zcode-plan/billing/balance?app_version=${APP_VERSION}`, {
    headers: upstreamHeaders(acc),
    signal: AbortSignal.timeout(20000),
  });
  const qj = await safeJson(q);
  return {
    plans: (qj.data?.plans ?? []).map((p) => {
      const d = describePlan(p.plan_id, p.name);
      return {
        id: p.plan_id,
        name: p.name,
        nameZh: d.nameZh,
        kind: d.kind,
        kindZh: d.kindZh,
        status: p.status,
        endsAt: p.ends_at,
      };
    }),
    balances: (qj.data?.balances ?? []).map((b) => {
      const d = describePlan(b.plan_id, b.show_name);
      return {
        model: b.show_name,
        kind: d.kind,
        kindZh: d.kindZh,
        typeZh: `${d.kindZh} · ${b.show_name}`,
        remaining: b.remaining_units,
        total: b.total_units,
        periodEnd: b.period_end,
      };
    }),
  };
}

/** 手动添加：POST { jwt, label?, email?, accessToken? } —— flow 丢了或想直接粘贴 token 时用 */
async function handleAccountAdd(req, res) {
  const raw = await readBody(req);
  let body = {};
  try {
    body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
  } catch {}
  const jwt = String(body.jwt || '').trim();
  if (!jwt.startsWith('eyJ')) return sendJson(res, 400, { error: 'jwt 格式不对（应以 eyJ 开头）' });
  const uid = userIdFromJwt(jwt);
  if (!uid) return sendJson(res, 400, { error: 'jwt 里解析不出 user_id' });

  // 粘的是 access_token（更长的那个）而不是 zcodejwt 时，也认识一下
  const accessToken = String(body.accessToken || body.zaiAccessToken || '').trim().startsWith('eyJ')
    ? String(body.accessToken || body.zaiAccessToken).trim()
    : null;

  // 有 access_token 就直接查官方客户档案，完全免手填
  let customer = null;
  if (accessToken) customer = await fetchCustomerInfo(accessToken);

  const email = String(customer?.email || body.email || '').trim() || null;
  const phone = String(customer?.phoneNumber || '').trim() || null;
  let realm = realmFromCustomer(customer);
  if (realm === 'unknown') realm = body.realm || realmFromIdentity(email);
  const nick = String(customer?.nickName || customer?.customerName || body.name || '').trim() || null;

  const label = body.label || (nick ? `${nick}-${uid.slice(0, 8)}` : `acc-${uid.slice(0, 8)}`);
  const { added } = persistAccount(jwt, label, { email, phone, name: nick, realm, accessToken });
  accounts = readAccountFile();
  const acc = accounts.find((a) => a.uid === uid);

  let claim = null;
  let quota = null;
  if (acc) {
    try {
      claim = await claimFor(acc);
      recordClaim(acc.label, claim, 'onboard');
      quota = await quotaOf(acc);
    } catch (e) {
      claim = { ok: false, msg: e.message };
    }
  }
  // 只粘了 zcodejwt 也没关系：用 zaiAccessToken 反查客户档案补全身份（免手填）
  if (acc && !acc.email && !acc.phone && acc.zaiAccessToken) {
    try {
      const c = await fetchCustomerInfo(acc.zaiAccessToken);
      if (c) {
        acc.email = c.email || acc.email;
        acc.phone = c.phoneNumber || acc.phone;
        acc.name = c.nickName || c.customerName || acc.name;
        acc.identity = displayIdentity(acc);
        const r2 = realmFromCustomer(c);
        if (r2 !== 'unknown') acc.realm = r2;
        persistAccount(jwt, acc.label, acc);
        accounts = readAccountFile();
      }
    } catch {}
  }
  sendJson(res, 200, {
    status: 'ready',
    added,
    label: acc?.label ?? label,
    userId: uid,
    email: acc?.email ?? email,
    phone: acc?.phone ?? phone,
    identity: acc?.identity ?? displayIdentity({ email, phone }),
    realm: acc?.realm ?? realm,
    hasAccessToken: acc?.hasAccessToken ?? !!accessToken,
    claim,
    quota,
  });
}

/** 重新识别所有账号身份：POST /accounts/identify */
async function handleIdentifyAll(req, res) {
  const seeded = seedLocalAccessToken();
  if (seeded) {
    accounts = readAccountFile();
    log(`从本地 ZCode 客户端补入 access_token ${seeded} 个`);
  }
  const r = await identifyAll(true);
  accounts = readAccountFile();
  sendJson(res, 200, {
    ok: true,
    seeded,
    updated: r.updated ?? 0,
    withToken: r.withToken ?? 0,
    total: r.total ?? 0,
    accounts: accounts.map((a) => ({
      label: a.label,
      identity: a.identity,
      realm: a.realm,
      realmZh: a.realmZh,
      hasAccessToken: a.hasAccessToken,
    })),
  });
}


async function handleOnboardStart(req, res) {
  const pollToken = crypto.randomBytes(32).toString('hex');
  const r = await fetch(`${UPSTREAM_ORIGIN}/api/v1/oauth/cli/init`, {
    method: 'POST',
    headers: { authorization: `Bearer ${pollToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'zai' }),
  });
  const j = await safeJson(r);
  if (j.code !== 0) return sendJson(res, 502, { error: j.msg || 'init 失败', raw: j });
  const { flow_id, authorize_url, expires_at, poll_interval_sec } = j.data;
  pendingFlows.set(flow_id, { pollToken, createdAt: Date.now() });
  writeFlows(pendingFlows);
  log(`onboard flow 已创建 ${flow_id}`);
  sendJson(res, 200, { flowId: flow_id, authorizeUrl: authorize_url, expiresAt: expires_at, pollIntervalSec: poll_interval_sec });
}

async function handleOnboardPoll(req, res, flowId) {
  const flow = pendingFlows.get(flowId);
  if (!flow) return sendJson(res, 404, { error: 'flow 不存在或已过期，请重新发起登录', code: 'flow_missing' });

  const r = await fetch(`${UPSTREAM_ORIGIN}/api/v1/oauth/cli/poll/${encodeURIComponent(flowId)}`, {
    headers: { authorization: `Bearer ${flow.pollToken}` },
  });
  const j = await safeJson(r);
  if (j.code !== 0) return sendJson(res, 502, { error: j.msg || 'poll 失败', raw: j });

  const st = j.data?.status;
  if (st === 'pending') return sendJson(res, 200, { status: 'pending' });
  if (st !== 'ready') return sendJson(res, 200, { status: st });

  // 授权完成：拿 JWT + OAuth access_token → 入库 → 查真实身份 → 立即领取 → 回读余额
  const jwt = j.data.token;
  const uid = userIdFromJwt(jwt);
  const user = j.data.user ?? {};
  // ★ 关键：官方客户端就是从 data.zai.access_token 拿的（zai adapter），以前被我们丢掉了
  const accessToken = j.data.zai?.access_token || j.data.zai?.accessToken || null;

  // 先用官方客户档案查真实邮箱/手机号 → 国内/国际自动判定
  let customer = null;
  if (accessToken) customer = await fetchCustomerInfo(accessToken);

  let email = String(customer?.email || user.email || '').trim() || null;
  let phone = String(customer?.phoneNumber || '').trim() || null;
  let realm = realmFromCustomer(customer);
  if (realm === 'unknown') realm = realmFromIdentity(email);
  const nick = String(customer?.nickName || customer?.customerName || user.name || '').trim() || null;
  const label = nick ? `${nick}-${uid.slice(0, 8)}` : uid.slice(0, 8);

  const { added } = persistAccount(jwt, label, { email, phone, name: nick, realm, accessToken });
  pendingFlows.delete(flowId);
  writeFlows(pendingFlows);
  log(
    `授权完成 uid=${uid} 身份=${displayIdentity({ email, phone }) ?? '-'} ` +
      `归属=${REALM_ZH[realm]} access_token=${accessToken ? '已捕获' : '缺失'} added=${added}`,
  );

  accounts = readAccountFile();
  const acc = accounts.find((a) => a.uid === uid);

  let claim = null;
  let quota = null;
  if (acc) {
    try {
      claim = await claimFor(acc);
      recordClaim(acc.label, claim, 'onboard');
      quota = await quotaOf(acc);
    } catch (e) {
      claim = { ok: false, msg: e.message };
    }
  }

  sendJson(res, 200, {
    status: 'ready',
    added,
    label: acc?.label ?? label,
    userId: uid,
    email: acc?.email ?? email,
    phone: acc?.phone ?? phone,
    identity: acc?.identity ?? displayIdentity({ email, phone }),
    realm: acc?.realm ?? realm,
    hasAccessToken: acc?.hasAccessToken ?? !!accessToken,
    claim,
    quota,
  });
}


/** 修正账号身份信息（邮箱/手机号/昵称/归属）：POST { label, email?, name?, realm? } */
async function handleAccountUpdate(req, res) {
  const raw = await readBody(req);
  let body = {};
  try {
    body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
  } catch {}
  if (!body.label) return sendJson(res, 400, { error: '缺少 label' });

  const arr = fs.existsSync(ACC_FILE) ? JSON.parse(fs.readFileSync(ACC_FILE, 'utf8')) : [];
  const target = arr.find((a) => (a.label || '') === body.label);
  if (!target) return sendJson(res, 404, { error: `找不到账号 ${body.label}` });

  const email = String(body.email || '').trim();
  if (email) {
    target.email = email;
    const r = realmFromIdentity(email);
    target.realm = body.realm || (r === 'unknown' ? target.realm : r);
  }
  if (body.realm === 'cn' || body.realm === 'intl') target.realm = body.realm;
  if (body.name) target.name = String(body.name).trim();
  // 手动权重：0 = 暂停该号（不参与调度，除非全部不可用兑底），默认 1
  if (body.weight !== undefined) {
    const w = Number(body.weight);
    target.weight = Number.isFinite(w) ? Math.max(0, Math.min(20, w)) : 1;
  }

  fs.writeFileSync(ACC_FILE, JSON.stringify(arr, null, 2));
  accounts = readAccountFile();
  const acc = accounts.find((a) => a.label === target.label);
  sendJson(res, 200, {
    ok: true,
    label: acc.label,
    email: acc.email,
    realm: acc.realm,
    weight: acc.weight,
    identity: acc.identity,
  });
}

/** 面板自检：不经过对外密钥鉴权，直接拿一个可用账号打一次小请求 */
async function handleSelfTest(req, res) {
  const acc = accounts.find((a) => a.available) || accounts[0];
  if (!acc) return sendJson(res, 503, { ok: false, error: '没有可用账号' });
  const started = Date.now();
  try {
    const body = buildUpstreamBody(
      { model: DEFAULT_MODEL, max_tokens: 64, messages: [{ role: 'user', content: '请只回复两个字：正常' }] },
      acc,
    );
    body.stream = false;
    const r = await fetch(UPSTREAM_URL, {
      method: 'POST',
      headers: upstreamHeaders(acc),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    const j = await safeJson(r);
    if (j.code && j.code !== 0) {
      return sendJson(res, 502, { ok: false, error: `${j.code} ${j.msg || ''}`, account: acc.label });
    }
    const txt = (j.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
    markSuccess(acc);
    return sendJson(res, 200, { ok: true, account: acc.label, text: txt, ms: Date.now() - started });
  } catch (e) {
    markFailure(acc, 60_000);
    return sendJson(res, 502, { ok: false, error: e.message, account: acc.label });
  }
}

// ── 密钥 / 用量接口 ──
function startOfDay(ts = Date.now()) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function handleKeys(req, res) {
  const active = keyDb.keys.filter((k) => !k.deleted);
  sendJson(res, 200, {
    keys: active.map(publicKey),
    total: active.length,
    masterKeyEnabled: !!GATEWAY_KEY,
    openMode: !active.length && !GATEWAY_KEY,
  });
}

async function handleKeyCreate(req, res) {
  const raw = await readBody(req);
  let body = {};
  try {
    body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
  } catch {}
  const name = String(body.name || '').trim();
  if (!name) return sendJson(res, 400, { error: '请填写密钥名称' });

  const mat = newKeyMaterial();
  const id = (keyDb.keys.reduce((m, k) => Math.max(m, k.id || 0), 0) || 0) + 1;
  const days = Number(body.expiresInDays) || 0;
  const rec = {
    id,
    name,
    prefix: mat.prefix,
    hash: mat.hash,
    enabled: true,
    realm: ['cn', 'intl'].includes(body.realm) ? body.realm : '',
    expiresAt: days > 0 ? Date.now() + days * 86400_000 : 0,
    models: Array.isArray(body.models) ? body.models.filter(Boolean) : [],
    ipAllowlist: Array.isArray(body.ipAllowlist) ? body.ipAllowlist.filter(Boolean) : [],
    quotaTokens: Number(body.quotaTokens) || 0,
    usedTokens: 0,
    requests: 0,
    createdAt: Date.now(),
    lastUsedAt: 0,
    note: String(body.note || ''),
  };
  keyDb.keys.push(rec);
  writeKeys(keyDb);
  log(`新建密钥 ${name} (${mat.prefix}…)`);
  // 完整密钥只在这里返回一次
  sendJson(res, 200, { key: publicKey(rec), secret: mat.full });
}

async function handleKeyUpdate(req, res, id) {
  const k = keyDb.keys.find((x) => x.id === id && !x.deleted);
  if (!k) return sendJson(res, 404, { error: '密钥不存在' });
  const raw = await readBody(req);
  let body = {};
  try {
    body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
  } catch {}

  if (typeof body.name === 'string' && body.name.trim()) k.name = body.name.trim();
  if (typeof body.enabled === 'boolean') k.enabled = body.enabled;
  if (Array.isArray(body.models)) k.models = body.models.filter(Boolean);
  if (Array.isArray(body.ipAllowlist)) k.ipAllowlist = body.ipAllowlist.filter(Boolean);
  if (body.quotaTokens !== undefined) k.quotaTokens = Number(body.quotaTokens) || 0;
  if (body.realm !== undefined) k.realm = ['cn', 'intl'].includes(body.realm) ? body.realm : '';
  if (body.note !== undefined) k.note = String(body.note || '');
  if (body.expiresInDays !== undefined) {
    const d = Number(body.expiresInDays) || 0;
    k.expiresAt = d > 0 ? Date.now() + d * 86400_000 : 0;
  }
  writeKeys(keyDb);
  sendJson(res, 200, { key: publicKey(k) });
}

function handleKeyDelete(req, res, id) {
  const k = keyDb.keys.find((x) => x.id === id && !x.deleted);
  if (!k) return sendJson(res, 404, { error: '密钥不存在' });
  // 软删除：只标记，不物理删文件（便于审计与误删恢复）
  k.deleted = true;
  k.enabled = false;
  k.deletedAt = Date.now();
  writeKeys(keyDb);
  log(`密钥 ${k.name} 已删除（软删除）`);
  sendJson(res, 200, { ok: true, id });
}

function handleKeyReset(req, res, id) {
  const k = keyDb.keys.find((x) => x.id === id && !x.deleted);
  if (!k) return sendJson(res, 404, { error: '密钥不存在' });
  k.usedTokens = 0;
  k.requests = 0;
  writeKeys(keyDb);
  sendJson(res, 200, { key: publicKey(k) });
}

function handleStats(req, res, url) {
  const range = url.searchParams.get('range') || 'today';
  const now = Date.now();
  let from;
  let bucketMs;
  let count;
  if (range === '7d') {
    from = startOfDay(now - 6 * 86400_000);
    bucketMs = 86400_000;
    count = 7;
  } else if (range === '14d') {
    from = startOfDay(now - 13 * 86400_000);
    bucketMs = 86400_000;
    count = 14;
  } else if (range === '30d') {
    from = startOfDay(now - 29 * 86400_000);
    bucketMs = 86400_000;
    count = 30;
  } else {
    from = startOfDay(now);
    bucketMs = 3600_000;
    count = 24;
  }
  const buckets = Array.from({ length: count }, (_, i) => ({
    t: from + i * bucketMs,
    requests: 0,
    tokens: 0,
    fails: 0,
  }));

  const rows = usageLog.filter((r) => r.t >= from);
  const byModel = new Map();
  const byKey = new Map();
  const byAccount = new Map();
  const totals = { requests: 0, ok: 0, fail: 0, in: 0, out: 0, cacheRead: 0, cacheCreate: 0, tokens: 0, msSum: 0 };

  const bump = (map, key, r) => {
    const cur = map.get(key) ?? { name: key, requests: 0, tokens: 0, in: 0, out: 0, cacheRead: 0, cacheCreate: 0, fail: 0 };
    cur.requests += 1;
    cur.in += r.in || 0;
    cur.out += r.out || 0;
    cur.cacheRead += r.cacheRead || 0;
    cur.cacheCreate += r.cacheCreate || 0;
    cur.tokens += (r.in || 0) + (r.out || 0) + (r.cacheRead || 0) + (r.cacheCreate || 0);
    if (!r.ok) cur.fail += 1;
    map.set(key, cur);
  };

  for (const r of rows) {
    const toks = (r.in || 0) + (r.out || 0) + (r.cacheRead || 0) + (r.cacheCreate || 0);
    totals.requests += 1;
    totals.ok += r.ok ? 1 : 0;
    totals.fail += r.ok ? 0 : 1;
    totals.in += r.in || 0;
    totals.out += r.out || 0;
    totals.cacheRead += r.cacheRead || 0;
    totals.cacheCreate += r.cacheCreate || 0;
    totals.tokens += toks;
    totals.msSum += r.ms || 0;
    const bi = Math.floor((r.t - from) / bucketMs);
    if (buckets[bi]) {
      buckets[bi].requests += 1;
      buckets[bi].tokens += toks;
      if (!r.ok) buckets[bi].fails += 1;
    }
    bump(byModel, r.model || 'unknown', r);
    bump(byKey, r.key || 'master', r);
    bump(byAccount, r.acc || '-', r);
  }

  const promptTotal = totals.in + totals.cacheRead + totals.cacheCreate;
  sendJson(res, 200, {
    range,
    from,
    to: now,
    bucketMs,
    totals: {
      ...totals,
      avgMs: totals.requests ? Math.round(totals.msSum / totals.requests) : 0,
      cacheHitRate: promptTotal ? Math.round((totals.cacheRead / promptTotal) * 1000) / 10 : 0,
    },
    buckets,
    byModel: [...byModel.values()].sort((a, b) => b.tokens - a.tokens),
    byKey: [...byKey.values()].sort((a, b) => b.tokens - a.tokens),
    byAccount: [...byAccount.values()].sort((a, b) => b.tokens - a.tokens),
    recent: rows.slice(-50).reverse(),
  });
}

function handleLogs(req, res, url) {
  const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 500);
  const key = url.searchParams.get('key');
  const acc = url.searchParams.get('acc');
  const model = url.searchParams.get('model');
  let rows = usageLog;
  if (key) rows = rows.filter((r) => r.key === key);
  if (acc) rows = rows.filter((r) => r.acc === acc);
  if (model) rows = rows.filter((r) => r.model === model);
  sendJson(res, 200, { total: rows.length, logs: rows.slice(-limit).reverse() });
}

/** 在线修改调度参数（面板「轮换设置」弹窗） */
async function handlePoolSettings(req, res) {
  const raw = await readBody(req);
  let body = {};
  try {
    body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
  } catch {}
  const applied = applyPoolSettings(body);
  sendJson(res, 200, { ok: true, applied, pool: POOL });
}

/** IP 管控规则增删与开关（面板「安全」页） */
async function handleSecurityUpdate(req, res) {
  const raw = await readBody(req);
  let body = {};
  try {
    body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
  } catch {}
  const out = { toggled: false, ruleAdded: false, ruleRemoved: -1 };
  if (typeof body.enabled === 'boolean') { security.enabled = body.enabled; out.toggled = true; }
  if (body.mode === 'blacklist' || body.mode === 'whitelist') security.mode = body.mode;
  if (body.action === 'add' && body.cidr) {
    const cidr = String(body.cidr).trim();
    const type = body.type === 'allow' ? 'allow' : 'deny';
    if (!/^[\da-fA-F.:]+\/\d{1,3}$/.test(cidr) && !/^[\da-fA-F.:]+$/.test(cidr)) {
      return sendJson(res, 400, { error: 'IP/CIDR 格式不对' });
    }
    security.rules.push({ type, cidr: cidr.includes('/') ? cidr : `${cidr}/32`, note: String(body.note || ''), createdAt: Date.now() });
    out.ruleAdded = true;
  }
  if (body.action === 'remove' && body.index !== undefined) {
    const i = Number(body.index);
    if (security.rules[i]) { security.rules.splice(i, 1); out.ruleRemoved = i; }
  }
  saveSecurity();
  log(`[security] enabled=${security.enabled} mode=${security.mode} rules=${security.rules.length}`);
  sendJson(res, 200, { ok: true, ...out, security: { enabled: security.enabled, mode: security.mode, rules: security.rules } });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  // 管理面板登录闸门：/health 与模型 API 之外一律要求登录
  if (adminGate(req, res, url)) return;
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/dashboard')) {
    const f = path.join(import.meta.dirname, 'dashboard.html');
    if (!fs.existsSync(f)) return sendJson(res, 404, { error: 'dashboard.html 缺失' });
    const buf = fs.readFileSync(f);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': buf.length,
      'cache-control': 'no-store, must-revalidate',
    });
    return res.end(buf);
  }
  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, {
      ok: true,
      accounts: accounts.length,
      keys: keyDb.keys.filter((k) => !k.deleted).length,
      upstream: UPSTREAM_URL,
      defaultModel: DEFAULT_MODEL,
      models: [DEFAULT_MODEL],
    });
  }
  if (req.method === 'GET' && url.pathname === '/pool/settings') {
    return sendJson(res, 200, {
      settings: {
        maxInFlight: POOL.maxInFlight,
        breakerThreshold: POOL.breakerThreshold,
        breakerCooldownMin: POOL.breakerCooldownMin,
        blockedCooldownMin: POOL.blockedCooldownMin,
        quotaCooldownMin: POOL.quotaCooldownMin,
        busyCooldownSec: POOL.busyCooldownSec,
        stickyTtlMin: POOL.stickyTtlMin,
        topN: POOL.topN,
        idleWeightPerHour: POOL.idleWeightPerHour,
        idleWeightMax: POOL.idleWeightMax,
        minPickGapMs: POOL.minPickGapMs,
        weightBalFactor: POOL.weightBalFactor,
        weightSuccFactor: POOL.weightSuccFactor,
      },
      limits: POOL_LIMITS,
      fromFile: !!POOL.__fromFile,
    });
  }
  if (req.method === 'POST' && url.pathname === '/pool/settings') return handlePoolSettings(req, res);
  if (req.method === 'GET' && url.pathname === '/security') {
    return sendJson(res, 200, {
      enabled: security.enabled,
      mode: security.mode,
      rules: security.rules,
      blocked: security.blockedLog.slice(-200).reverse(),
      blockedTotal: security.blockedLog.length,
    });
  }
  if (req.method === 'POST' && url.pathname === '/security') return handleSecurityUpdate(req, res);
  if (req.method === 'POST' && url.pathname === '/security/clear-blocked') {
    security.blockedLog = [];
    saveSecurity();
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/pool/reset') {
    for (const a of accounts) {
      a.cooldownUntil = 0;
      a.degradeUntil = 0;
      a.consecutiveFails = 0;
      a.failures = 0;
      a.lastErr = null;
    }
    sticky.clear();
    log('已重置所有账号冷却');
    return sendJson(res, 200, { ok: true, accounts: accounts.length });
  }
  if (req.method === 'GET' && url.pathname === '/pool') return handlePool(req, res);
  if (req.method === 'GET' && url.pathname === '/keys') return handleKeys(req, res);
  if (req.method === 'POST' && url.pathname === '/keys') return handleKeyCreate(req, res);
  {
    const m = url.pathname.match(/^\/keys\/(\d+)\/(update|delete|reset)$/);
    if (m && req.method === 'POST') {
      const id = Number(m[1]);
      if (m[2] === 'update') return handleKeyUpdate(req, res, id);
      if (m[2] === 'delete') return handleKeyDelete(req, res, id);
      return handleKeyReset(req, res, id);
    }
  }
  if (req.method === 'GET' && url.pathname === '/stats') return handleStats(req, res, url);
  if (req.method === 'POST' && url.pathname === '/selftest') return handleSelfTest(req, res);
  if (req.method === 'GET' && url.pathname === '/logs') return handleLogs(req, res, url);
  if (req.method === 'GET' && url.pathname === '/quota') return handleQuota(req, res);
  if (req.method === 'GET' && url.pathname === '/claimable') return handleClaimable(req, res);
  if (req.method === 'POST' && url.pathname === '/claim') return handleClaim(req, res);
  if (req.method === 'GET' && url.pathname === '/captcha/status') return handleCaptchaStatus(req, res, url);
  if (req.method === 'POST' && url.pathname === '/accounts/identify') return handleIdentifyAll(req, res);
  if (req.method === 'POST' && url.pathname === '/accounts/add') return handleAccountAdd(req, res);
  if (req.method === 'POST' && url.pathname === '/accounts/update') return handleAccountUpdate(req, res);
  if (req.method === 'POST' && url.pathname === '/onboard/start') return handleOnboardStart(req, res);
  if (req.method === 'GET' && url.pathname.startsWith('/onboard/poll/')) {
    return handleOnboardPoll(req, res, decodeURIComponent(url.pathname.slice('/onboard/poll/'.length)));
  }
  if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
    // OpenAI 风格模型列表；带 ?api=anthropic 时返回 Anthropic 风格
    const anthropicStyle = url.searchParams.get('api') === 'anthropic';
    const now = Math.floor(Date.now() / 1000);
    const models = [
      { id: 'GLM-5.3-Flash', name: 'GLM-5.3 Flash', context: 1000000, maxOutput: 131072 },
      { id: 'GLM-5.3', name: 'GLM-5.3', context: 1000000, maxOutput: 131072 },
      ...(process.env.ZCODE_EXTRA_MODELS || '').split(',').filter(Boolean).map((m) => ({ id: m.trim(), name: m.trim(), context: 1000000, maxOutput: 131072 })),
    ];
    if (anthropicStyle) {
      return sendJson(res, 200, { data: models.map((m) => ({ type: 'model', id: m.id, display_name: m.name, created_at: '2026-01-01T00:00:00Z', context_window: m.context, max_output_tokens: m.maxOutput })) });
    }
    return sendJson(res, 200, {
      object: 'list',
      data: models.map((m) => ({ id: m.id, object: 'model', created: now, owned_by: 'zcode2api', context_window: m.context, max_output_tokens: m.maxOutput })),
    });
  }
  // /v1/v1/* 双重前缀兼容：用户 baseUrl 误带 /v1 时（Anthropic adapter 会再拼 /v1/messages）
  const path1 = url.pathname.replace(/^\/v1\/v1/, '/v1');
  if (req.method === 'POST' && (path1 === '/v1/chat/completions' || path1 === '/chat/completions')) {
    return handleOpenAIChat(req, res).catch((e) => {
      log('openai handler error:', e);
      if (!res.headersSent) sendJson(res, 500, { error: { message: e.message, type: 'api_error' } });
      else res.end();
    });
  }
  if (req.method === 'POST' && (path1 === '/v1/messages' || path1 === '/messages')) {
    return handleMessages(req, res).catch((e) => {
      log('handler error:', e);
      if (!res.headersSent) sendJson(res, 500, { type: 'error', error: { type: 'api_error', message: e.message } });
      else res.end();
    });
  }
  sendJson(res, 404, { type: 'error', error: { type: 'not_found', message: `no route ${req.method} ${url.pathname}` } });
});

server.listen(PORT, HOST, () => {
  log(`zcgw-server listening on http://${HOST}:${PORT}`);
  log(`accounts: ${accounts.map((a) => a.label).join(', ')}`);
  log(`gateway key: ${GATEWAY_KEY ? '(set)' : '(WARNING: 未设置，任何人可用)'}`);
  log(`scheduler: weighted-random topN=${POOL.topN} sticky=${POOL.stickyTtlMin}min`);

  // 管理面板鉴权状态
  if (ADMIN_ENV_PASSWORD) {
    log('管理面板：已启用登录保护（密码来自环境变量 ADMIN_PASSWORD）');
  } else if (adminFirstPassword) {
    log('══════════════════════════════════════════════════════════════');
    log('  【重要】首次启动，已自动生成管理面板登录密码（只显示这一次）：');
    log(`      ${adminFirstPassword}`);
    log(`  明文不落盘，仅其 scrypt 哈希保存在 ${ADMIN_FILE}（权限 600）`);
    log('  请立即保存；登录后可在面板右上角「修改密码」，或设置环境变量 ADMIN_PASSWORD 覆盖');
    log('  忘记密码：删除 admin.json 后重启，会重新生成并打印新密码');
    log('══════════════════════════════════════════════════════════════');
    adminFirstPassword = '';
  } else {
    log(`管理面板：已启用登录保护（密码哈希来自 ${ADMIN_FILE}）`);
  }

  // 服务器生产环境自检提示（一次性）
  if (HOST === '0.0.0.0') {
    if (!GATEWAY_KEY && keyDb.keys.filter((k) => !k.deleted).length === 0) {
      log('WARNING: 监听 0.0.0.0 且没有任何密钥 —— 任何人都能白嫖你的账号池！');
      log('         服务器部署请在面板「密钥」里建一把 key，或设置 GATEWAY_KEY 环境变量');
    }
    if (!GATEWAY_KEY && keyDb.keys.filter((k) => !k.deleted).length > 0) {
      log(`已启用密钥鉴权（${keyDb.keys.filter((k) => !k.deleted).length} 把），未带 key 的请求将被 401`);
    }
  }

  // 恢复上次的调度状态（冷却/降权/成功率），再启动后台余额刷新喂权重
  loadPoolState();
  const refreshQuotaWeights = async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/quota`, { headers: { 'x-zcgw-internal': INTERNAL_TOKEN } });
      await r.json();
    } catch {}
  };
  setTimeout(refreshQuotaWeights, 3000);
  setInterval(refreshQuotaWeights, 10 * 60_000); // 每 10 分钟刷一次权重缓存
  setInterval(savePoolState, 60_000); // 每分钟落盘一次调度状态

  // 自动领取（每日 + 周末抢领）：见 autoClaimTick()
  if (AUTO_CLAIM.enabled) {
    setTimeout(() => autoClaimTick().catch(() => {}), 60_000);
    setInterval(() => autoClaimTick().catch(() => {}), 10 * 60_000);
    log(`auto-claim: 每日自动领取已启用（北京时间 ${AUTO_CLAIM.dailyAt} 起 + 随机 0–${AUTO_CLAIM.jitterMin} 分钟，逐号串行）` +
      (AUTO_CLAIM.weekend ? '；周末抢领：周五 18:00 ～ 周日 24:00' : '') +
      `；验证码 sidecar：${CAPTCHA_URL ? CAPTCHA_URL : '未配置（遇验证码提示手动领取）'}`);
  } else {
    log('auto-claim: 已关闭（ZCGW_AUTO_CLAIM=0 或 pool-settings.json autoClaim=false）');
  }

  // 启动后自动补齐身份：先吃本地客户端的 access_token，再拿官方客户档案反查邮箱/手机号
  setTimeout(async () => {
    try {
      const seeded = seedLocalAccessToken();
      if (seeded) {
        accounts = readAccountFile();
        log(`已从本地 ZCode 客户端补入 access_token：${seeded} 个账号`);
      }
      const r = await identifyAll(true);
      if (r.withToken) log(`身份自动识别：${r.updated} 个有变更 / ${r.withToken} 个可查（共 ${r.total}）`);
      const missing = accounts.filter((a) => !a.hasAccessToken).length;
      if (missing) log(`另有 ${missing} 个账号没有 access_token，需重新授权一次才能自动识别身份`);
    } catch (e) {
      log('启动身份识别失败:', e?.message ?? String(e));
    }
  }, 700);
});

// 不让单个坏请求 / 空响应把整个网关打死
process.on('unhandledRejection', (e) => log('unhandledRejection:', e?.message ?? String(e)));
process.on('uncaughtException', (e) => log('uncaughtException:', e?.message ?? String(e)));
