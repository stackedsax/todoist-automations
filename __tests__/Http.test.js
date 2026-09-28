const { loadGas } = require('./helpers/gas');
const { respond } = require('./helpers/mocks');

const URL = 'https://api.example.com/v1/thing';
const load = () => {
  const ctx = loadGas(['Config.js', 'Util.js', 'Http.js']);
  ctx.Http.jitter_ = () => 0; // deterministic backoff
  return ctx;
};

describe('Http.fetchJson', () => {
  test('GET parses JSON and sends muteHttpExceptions', () => {
    const ctx = load();
    ctx.__mocks.UrlFetchApp.__on('GET', URL, respond.json({ ok: true }));
    expect(ctx.Http.fetchJson(URL)).toEqual({ ok: true });
    const call = ctx.__mocks.UrlFetchApp.__calls[0];
    expect(call.params.muteHttpExceptions).toBe(true);
    expect(call.method).toBe('GET');
  });

  test('POST encodes object payload as JSON with content type and headers', () => {
    const ctx = load();
    ctx.__mocks.UrlFetchApp.__on('POST', URL, req => respond.json({ echo: req.json }));
    const res = ctx.Http.fetchJson(URL, { method: 'post', headers: { Authorization: 'Bearer t' }, payload: { a: 1 } });
    expect(res).toEqual({ echo: { a: 1 } });
    const call = ctx.__mocks.UrlFetchApp.__calls[0];
    expect(call.params.contentType).toBe('application/json');
    expect(call.headers.Authorization).toBe('Bearer t');
  });

  test('string payload passes through with custom content type', () => {
    const ctx = load();
    ctx.__mocks.UrlFetchApp.__on('POST', URL, respond.json({}));
    ctx.Http.fetchJson(URL, { method: 'post', payload: 'a=1', contentType: 'application/x-www-form-urlencoded' });
    const call = ctx.__mocks.UrlFetchApp.__calls[0];
    expect(call.payload).toBe('a=1');
    expect(call.params.contentType).toBe('application/x-www-form-urlencoded');
  });

  test('query builder skips nulls, encodes, repeats arrays', () => {
    const ctx = load();
    expect(ctx.Http.query({ a: 'x y', b: null, c: undefined, d: [1, 2] })).toBe('?a=x%20y&d=1&d=2');
    expect(ctx.Http.query({})).toBe('');
    expect(ctx.Http.query(null)).toBe('');
    ctx.__mocks.UrlFetchApp.__on('GET', URL, respond.json([]));
    ctx.Http.fetchJson(URL, { query: { cursor: 'abc' } });
    expect(ctx.__mocks.UrlFetchApp.__calls[0].url).toBe(URL + '?cursor=abc');
  });

  test('empty 204 body returns null', () => {
    const ctx = load();
    ctx.__mocks.UrlFetchApp.__on('POST', URL, respond.empty());
    expect(ctx.Http.fetchJson(URL, { method: 'post' })).toBeNull();
  });

  test('retries 5xx with exponential backoff then succeeds', () => {
    const ctx = load();
    ctx.__mocks.UrlFetchApp.__on('GET', URL, [respond.status(502), respond.status(503), respond.json({ ok: 1 })]);
    expect(ctx.Http.fetchJson(URL)).toEqual({ ok: 1 });
    expect(ctx.__mocks.UrlFetchApp.__calls).toHaveLength(3);
    expect(ctx.__mocks.Utilities.__sleeps).toEqual([1000, 2000]);
  });

  test('honours Retry-After seconds on 429 (case-insensitive header)', () => {
    const ctx = load();
    ctx.__mocks.UrlFetchApp.__on('GET', URL, [respond.status(429, 'slow down', { 'Retry-After': '4' }), respond.json({ ok: 1 })]);
    ctx.Http.fetchJson(URL);
    expect(ctx.__mocks.Utilities.__sleeps).toEqual([4000]);
  });

  test('Retry-After HTTP date and cap', () => {
    const ctx = load();
    ctx.Util.now = () => new Date('2026-09-24T10:00:00Z');
    expect(ctx.Http.retryAfterMs_('Thu, 24 Sep 2026 10:00:05 GMT')).toBe(5000);
    expect(ctx.Http.retryAfterMs_('999')).toBe(30000);
    expect(ctx.Http.retryAfterMs_('bogus')).toBeNull();
    expect(ctx.Http.retryAfterMs_(undefined)).toBeNull();
  });

  test('gives up after 3 attempts with HttpError-shaped error', () => {
    const ctx = load();
    ctx.__mocks.UrlFetchApp.__on('GET', URL, respond.status(500, '{"error":"down"}'));
    let err;
    try { ctx.Http.fetchJson(URL + '?token=secret'); } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err.status).toBe(500);
    expect(err.body).toBe('{"error":"down"}');
    expect(err.name).toBe('HttpError');
    expect(err.message).toMatch(/HTTP 500 GET https:\/\/api\.example\.com\/v1\/thing/);
    expect(err.message).not.toMatch(/secret/);
    expect(ctx.__mocks.UrlFetchApp.__calls).toHaveLength(3);
  });

  test('4xx (non-429) is not retried', () => {
    const ctx = load();
    ctx.__mocks.UrlFetchApp.__on('GET', URL, respond.status(404, 'nope'));
    expect(() => ctx.Http.fetchJson(URL)).toThrow(expect.objectContaining({ status: 404 }));
    expect(ctx.__mocks.UrlFetchApp.__calls).toHaveLength(1);
  });

  test('maxAttempts option', () => {
    const ctx = load();
    ctx.__mocks.UrlFetchApp.__on('GET', URL, respond.status(503));
    expect(() => ctx.Http.fetchJson(URL, { maxAttempts: 1 })).toThrow();
    expect(ctx.__mocks.UrlFetchApp.__calls).toHaveLength(1);
  });

  test('network exceptions are retried, then thrown with status 0', () => {
    const ctx = load();
    ctx.__mocks.UrlFetchApp.__on('GET', URL, [respond.networkError('DNS error'), respond.json({ ok: 1 })]);
    expect(ctx.Http.fetchJson(URL)).toEqual({ ok: 1 });

    const ctx2 = load();
    ctx2.__mocks.UrlFetchApp.__on('GET', URL, respond.networkError('Timeout'));
    expect(() => ctx2.Http.fetchJson(URL)).toThrow(expect.objectContaining({ status: 0, body: 'Timeout' }));
  });

  test('request returns status, lower-cased headers, text and json', () => {
    const ctx = load();
    ctx.__mocks.UrlFetchApp.__on('GET', URL, { status: 200, text: 'not json', headers: { 'X-Thing': 'v' } });
    const r = ctx.Http.request(URL);
    expect(r).toEqual({ status: 200, headers: { 'x-thing': 'v' }, text: 'not json', json: null });
  });
});
