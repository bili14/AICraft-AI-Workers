// llm-cooldown.js — 按 providerId 共享的 LLM 退避冷却桶（防 429 惊群）
// 规则：任一 bot 报 429/5xx/网络错误 → 同桶所有 bot 集体放慢；401/403 也广播。
// ownKey bot 走独立桶（key=providerId#ownHash），不与 shared 互相拖累。
'use strict';
const crypto = require('crypto');

const BACKOFF_CHAIN = [2000, 4000, 8000]; // 连续失败指数升级
const HARD_STOP_MS = 60 * 1000;            // 401/403 长冷却
const RECOVER_AFTER_MS = 120 * 1000;       // 成功后 2 分钟无新错则清零等级

class CooldownBuckets {
  constructor() { this.map = new Map(); }

  // 算桶 key：shared→providerId；own→providerId#own:<hash8>
  static bucketKey({ providerId, keyMode, ownKey }) {
    const base = providerId || 'unknown';
    if (keyMode === 'own' && ownKey) {
      const h = crypto.createHash('sha1').update(String(ownKey)).digest('hex').slice(0, 8);
      return base + '#own:' + h;
    }
    return base;
  }

  report(bucketKey, code) {
    if (!bucketKey) return;
    const now = Date.now();
    let b = this.map.get(bucketKey);
    if (!b) { b = { coolUntilMs: 0, level: 0, lastCode: null, lastTs: 0 }; this.map.set(bucketKey, b); }

    // 距上次成功太久，先降档
    if (now - (b.lastTs || 0) > RECOVER_AFTER_MS) b.level = 0;

    b.lastCode = code;
    b.lastTs = now;

    if (code === 'E_401_AUTH' || code === 'E_403_FORBIDDEN') {
      b.coolUntilMs = now + HARD_STOP_MS;
      b.level = 99; // 熔断级
    } else if (code === 'E_429_RATE_LIMIT' || code === 'E_5XX_UPSTREAM' || code === 'E_NETWORK' || code === 'E_TIMEOUT') {
      b.level = Math.min(b.level + 1, BACKOFF_CHAIN.length);
      const base = BACKOFF_CHAIN[b.level - 1] || BACKOFF_CHAIN[BACKOFF_CHAIN.length - 1];
      const jitter = Math.floor(Math.random() * 800);
      b.coolUntilMs = now + base + jitter;
    }
    // E_BAD_RESPONSE/E_EMPTY_REPLY 不进共享冷却
  }

  // bot 每轮主循环前查询：当前该等多少 ms
  lease(bucketKey) {
    const b = this.map.get(bucketKey);
    if (!b || !b.coolUntilMs) return { delayMs: 0, cooldownUntilMs: 0, cooling: false };
    const remain = b.coolUntilMs - Date.now();
    if (remain <= 0) return { delayMs: 0, cooldownUntilMs: 0, cooling: false };
    return { delayMs: remain, cooldownUntilMs: b.coolUntilMs, cooling: true };
  }

  // 成功上报：降档（由 bot 成功时调用）
  noteSuccess(bucketKey) {
    const b = this.map.get(bucketKey);
    if (b) { b.level = 0; b.coolUntilMs = 0; b.lastCode = null; }
  }

  // hall 广播用：返回扁平列表
  list() {
    const now = Date.now();
    const out = [];
    for (const [k, b] of this.map.entries()) {
      if (b.coolUntilMs > now) out.push({ bucket: k, cooldownUntilMs: b.coolUntilMs, code: b.lastCode, level: b.level });
    }
    return out;
  }
}

module.exports = { CooldownBuckets };
