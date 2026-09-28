/**
 * Http — JSON over UrlFetchApp with retry/backoff.
 *
 * Retries on 429, 5xx and thrown fetch errors (network/timeouts), up to
 * `maxAttempts` (default 3). Honours Retry-After (seconds or HTTP date, capped).
 * Non-retryable 4xx and exhausted retries throw an Error with `.status` and `.body`.
 */
const Http = {
  MAX_ATTEMPTS: 3,
  BASE_BACKOFF_MS: 1000,
  MAX_RETRY_AFTER_MS: 30000,
  BODY_SNIPPET: 2000,

  /**
   * @param {string} url
   * @param {{method?: string, headers?: Object, payload?: (Object|string), query?: Object,
   *          contentType?: string, maxAttempts?: number}} [opts]
   *   payload objects are JSON-encoded (contentType application/json);
   *   strings are sent as-is. query is appended as a URL query string (null/undefined skipped).
   * @return {*} parsed JSON body, or null for an empty body (e.g. 204).
   */
  fetchJson(url, opts) {
    const res = Http.request(url, opts);
    return res.json;
  },

  /**
   * Like fetchJson but returns {status, headers, text, json}.
   * json is null when the body is empty or not JSON.
   */
  request(url, opts) {
    const o = opts || {};
    const method = String(o.method || 'get').toLowerCase();
    const fullUrl = url + Http.query(o.query);
    const params = { method: method, muteHttpExceptions: true, headers: Object.assign({}, o.headers || {}) };
    if (o.payload !== undefined && o.payload !== null) {
      if (typeof o.payload === 'string') {
        params.payload = o.payload;
        if (o.contentType) params.contentType = o.contentType;
      } else {
        params.payload = JSON.stringify(o.payload);
        params.contentType = o.contentType || 'application/json';
      }
    }
    const maxAttempts = o.maxAttempts || Http.MAX_ATTEMPTS;
    let lastErr = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let resp;
      try {
        resp = UrlFetchApp.fetch(fullUrl, params);
      } catch (e) {
        lastErr = Http.error_(0, method, url, String(e && e.message || e));
        if (attempt < maxAttempts) {
          Utilities.sleep(Http.backoff_(attempt));
          continue;
        }
        throw lastErr;
      }
      const status = resp.getResponseCode();
      const text = resp.getContentText() || '';
      const headers = Http.headers_(resp);
      if (status >= 200 && status < 300) {
        return { status: status, headers: headers, text: text, json: Http.parse_(text) };
      }
      lastErr = Http.error_(status, method, url, text);
      const retryable = status === 429 || status >= 500;
      if (!retryable || attempt >= maxAttempts) throw lastErr;
      const ra = Http.retryAfterMs_(headers['retry-after']);
      Utilities.sleep(ra !== null ? ra : Http.backoff_(attempt));
    }
    throw lastErr;
  },

  /** '?a=1&b=x%20y' from an object (null/undefined values skipped, arrays repeated). '' if empty. */
  query(params) {
    if (!params) return '';
    const parts = [];
    Object.keys(params).forEach(function (k) {
      const v = params[k];
      if (v === null || v === undefined) return;
      (Array.isArray(v) ? v : [v]).forEach(function (x) {
        parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(x)));
      });
    });
    return parts.length ? '?' + parts.join('&') : '';
  },

  parse_(text) {
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  },

  headers_(resp) {
    const raw = (resp.getAllHeaders && resp.getAllHeaders()) || (resp.getHeaders && resp.getHeaders()) || {};
    const out = {};
    Object.keys(raw).forEach(function (k) {
      const v = raw[k];
      out[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
    });
    return out;
  },

  retryAfterMs_(v) {
    if (v === undefined || v === null || v === '') return null;
    let ms;
    if (/^\s*\d+(\.\d+)?\s*$/.test(String(v))) ms = parseFloat(v) * 1000;
    else {
      const t = Date.parse(String(v));
      if (isNaN(t)) return null;
      ms = t - Util.now().getTime();
    }
    return Math.min(Http.MAX_RETRY_AFTER_MS, Math.max(0, Math.round(ms)));
  },

  backoff_(attempt) {
    return Http.BASE_BACKOFF_MS * Math.pow(2, attempt - 1) + Http.jitter_();
  },

  jitter_() {
    return Math.floor(Math.random() * 250);
  },

  /** Error shaped like HttpError; URL query strings are omitted (they may hold tokens). */
  error_(status, method, url, body) {
    const snippet = String(body || '').slice(0, Http.BODY_SNIPPET);
    const err = new Error('HTTP ' + (status || 'fetch-failed') + ' ' + method.toUpperCase() + ' ' +
      String(url).split('?')[0] + (snippet ? ': ' + snippet.slice(0, 300) : ''));
    err.name = 'HttpError';
    err.status = status;
    err.body = snippet;
    return err;
  }
};
