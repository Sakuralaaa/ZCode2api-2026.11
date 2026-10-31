/**
 * zcgw-fingerprint — 设备指纹稳定派生（借鉴 workbuddy2api-hub 的 derive_id 思路）
 *
 * 为什么需要：
 *   ZCode 客户端把设备标识放在 body.metadata.user_id 里：
 *     {"device_id":"<uuid>","account_uuid":"","session_id":"session_<hex>"}
 *   官方口径是「一个进程 = 一台设备」。网关是一个长驻进程冒充多台设备，
 *   如果所有账号共用同一个 device_id：
 *     - 所有号会被上游关联成同一台机器（这是账号池最大的破绽）；
 *   如果每次随机：
 *     - 同一账号的设备指纹来回漂移，本身就是异常特征。
 *
 * 所以：device_id / session_id 都必须「按账号派生 + 恒定不变」。
 */
import crypto from 'node:crypto';

/** 由 uid + salt 派生稳定的 UUIDv4 形状标识 */
export function deriveId(uid, salt) {
  const seed = `${salt}:${uid || 'anonymous'}`;
  const h = crypto.createHash('md5').update(seed, 'utf8').digest('hex');
  // 对齐 UUIDv4 形态：第 13 位固定 4，第 17 位固定 a
  const patched = `${h.slice(0, 12)}4${h.slice(13, 16)}a${h.slice(17)}`;
  return `${patched.slice(0, 8)}-${patched.slice(8, 12)}-${patched.slice(12, 16)}-${patched.slice(16, 20)}-${patched.slice(20, 32)}`;
}

export function deviceIdFor(uid) {
  return deriveId(uid, 'machine');
}

/** 每账号一个稳定的「客户端实例」 */
export function sessionIdFor(uid) {
  return `session_${crypto.createHash('sha256').update(`session:${uid}`).digest('hex').slice(0, 32)}`;
}

/** 请求 id：32 位无连字符 hex，每条随机（与账号无关，否则是稳定网关特征） */
export function requestId() {
  return crypto.randomUUID().replace(/-/g, '');
}

/** 从 JWT 里取 user_id（无需校验签名，仅用于派生） */
export function userIdFromJwt(jwt) {
  try {
    return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8')).user_id ?? null;
  } catch {
    return null;
  }
}

/** 组 ZCode 要求的 metadata.user_id 字符串 */
export function metadataUserId(uid) {
  return JSON.stringify({
    device_id: deviceIdFor(uid),
    account_uuid: '',
    session_id: sessionIdFor(uid),
  });
}
