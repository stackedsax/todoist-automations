/**
 * Util — now, deadline, withLock, hashing, text normalisation, date helpers.
 */
const Util = {
  /** Default soft budget for long jobs: 4.5 minutes (Apps Script hard limit is 6). */
  DEFAULT_BUDGET_MS: 270000,

  STOPWORDS_: {
    a: 1, an: 1, the: 1, and: 1, or: 1, to: 1, of: 1, for: 1, on: 1, in: 1, at: 1, by: 1,
    with: 1, about: 1, from: 1, re: 1, fw: 1, fwd: 1, is: 1, be: 1, it: 1, this: 1, that: 1,
    my: 1, me: 1, our: 1, up: 1
  },

  /** Current time. Tests stub this. */
  now() {
    return new Date();
  },

  /**
   * Soft deadline measured from now.
   * @param {number} [ms=Util.DEFAULT_BUDGET_MS]
   * @return {{remaining: function(): number, expired: function(): boolean, elapsed: function(): number}}
   */
  deadline(ms) {
    const budget = typeof ms === 'number' ? ms : Util.DEFAULT_BUDGET_MS;
    const start = Util.now().getTime();
    return {
      elapsed() { return Util.now().getTime() - start; },
      remaining() { return Math.max(0, budget - (Util.now().getTime() - start)); },
      expired() { return Util.now().getTime() - start >= budget; }
    };
  },

  /**
   * Run fn under the script lock (tryLock 5000ms). If not acquired, log and return null.
   * Otherwise returns fn()'s result; the lock is always released.
   */
  withLock(name, fn) {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(5000)) {
      console.log('[' + name + '] another run holds the lock; skipping');
      return null;
    }
    try {
      return fn();
    } finally {
      lock.releaseLock();
    }
  },

  /** Hex SHA-256 of `s` (UTF-8), truncated to `len` chars (default 16). */
  hash(s, len) {
    const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8);
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
      const b = (bytes[i] + 256) % 256;
      hex += (b < 16 ? '0' : '') + b.toString(16);
    }
    return hex.slice(0, len || 16);
  },

  /** Lower-case, strip accents and punctuation, collapse whitespace. */
  normalizeTitle(s) {
    return String(s || '')
      .normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/['’]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  },

  /** Normalised tokens without stopwords (unique, order preserved). */
  tokens(s) {
    const seen = {};
    const out = [];
    Util.normalizeTitle(s).split(' ').forEach(function (t) {
      if (!t || Util.STOPWORDS_[t] || seen[t]) return;
      seen[t] = 1;
      out.push(t);
    });
    return out;
  },

  /** |A∩B| / |A∪B| over Util.tokens. 0 when either side is empty. */
  tokenJaccard(a, b) {
    const A = Util.tokens(a), B = Util.tokens(b);
    if (!A.length || !B.length) return 0;
    const inter = Util.intersectCount_(A, B);
    return inter / (A.length + B.length - inter);
  },

  /** |A∩B| / min(|A|,|B|) over Util.tokens. 0 when either side is empty. */
  containment(a, b) {
    const A = Util.tokens(a), B = Util.tokens(b);
    if (!A.length || !B.length) return 0;
    return Util.intersectCount_(A, B) / Math.min(A.length, B.length);
  },

  intersectCount_(A, B) {
    const set = {};
    B.forEach(function (t) { set[t] = 1; });
    return A.filter(function (t) { return set[t]; }).length;
  },

  /** Truncate to n chars, appending an ellipsis when cut. */
  truncate(s, n) {
    const str = String(s === null || s === undefined ? '' : s);
    return str.length <= n ? str : str.slice(0, Math.max(0, n - 1)) + '…';
  },

  /** Script time zone (falls back to America/Los_Angeles). */
  tz() {
    try {
      return Session.getScriptTimeZone() || 'America/Los_Angeles';
    } catch (e) {
      return 'America/Los_Angeles';
    }
  },

  /** Utilities.formatDate in the script TZ. */
  formatDate(date, pattern) {
    return Utilities.formatDate(Util.toDate(date), Util.tz(), pattern);
  },

  /** 'Thu 24 Sep' in the script TZ. */
  formatDay(date) {
    return Util.formatDate(date, 'EEE d MMM');
  },

  /** 'YYYY-MM-DD' of `date` (default now) in the script TZ. */
  isoDate(date) {
    return Util.formatDate(date === undefined ? Util.now() : date, 'yyyy-MM-dd');
  },

  /** Today's 'YYYY-MM-DD' in the script TZ. */
  today() {
    return Util.isoDate(Util.now());
  },

  /** New Date `n` days (24h multiples) after `date`. */
  addDays(date, n) {
    return new Date(Util.toDate(date).getTime() + n * 86400000);
  },

  /** Calendar-day arithmetic, DST-safe: ('2026-09-24' | Date, n) -> 'YYYY-MM-DD'. */
  addDaysIso(dateOrIso, n) {
    const iso = typeof dateOrIso === 'string' ? dateOrIso : Util.isoDate(dateOrIso);
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    if (!m) throw new Error('addDaysIso: bad date ' + iso);
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n));
    return d.toISOString().slice(0, 10);
  },

  /** Coerce Date | ISO string | epoch ms to Date. */
  toDate(v) {
    if (v instanceof Date) return v;
    if (v && typeof v.getTime === 'function') return new Date(v.getTime());
    return new Date(v);
  },

  /** Parse ISO/date string to Date, or null when missing/invalid. */
  parseDate(v) {
    if (v === null || v === undefined || v === '') return null;
    const d = Util.toDate(v);
    return isNaN(d.getTime()) ? null : d;
  },

  /** True if s is 'YYYY-MM-DD'. */
  isIsoDate(s) {
    return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  },

  /** Lower-cased domain of an email address, or null. */
  emailDomain(email) {
    const m = /@([^@\s>]+)\s*>?\s*$/.exec(String(email || '').trim());
    return m ? m[1].toLowerCase() : null;
  },

  /** Extract a bare email from 'Name <a@b.c>' or 'a@b.c'. Lower-cased, or null. */
  parseEmail(s) {
    const m = /([A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/.exec(String(s || ''));
    return m ? m[1].toLowerCase() : null;
  },

  /** Split array into chunks of n. */
  chunk(arr, n) {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  },

  /** Unique values, order preserved (optionally by key fn). */
  uniq(arr, keyFn) {
    const seen = {};
    return arr.filter(function (x) {
      const k = keyFn ? keyFn(x) : x;
      if (seen[k]) return false;
      seen[k] = 1;
      return true;
    });
  },

  /** JSON.parse returning `def` on failure. */
  parseJson(s, def) {
    if (s === null || s === undefined || s === '') return def;
    try {
      return JSON.parse(s);
    } catch (e) {
      return def;
    }
  },

  /** Utilities.sleep wrapper. */
  sleep(ms) {
    Utilities.sleep(ms);
  }
};
