/**
 * In-memory fakes for the Google Apps Script services used by this project.
 *
 *   const { createMocks } = require('./helpers/mocks');
 *   const mocks = createMocks({ props: { TODOIST_API_TOKEN: 't' } });
 *   mocks.UrlFetchApp.__on('GET', 'https://api.todoist.com/api/v1/projects', { json: { results: [], next_cursor: null } });
 *
 * Every fake is a plain object whose methods are jest.fn() so tests can assert calls.
 * Controllers are exposed as `__`-prefixed members. `mocks.reset()` restores the initial state.
 * `mocks.globals` is the object loadGas() installs into the script context.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

// ------------------------------------------------------------------ UrlFetchApp

function makeResponse(spec) {
  const s = spec || {};
  const status = s.status === undefined ? 200 : s.status;
  let text;
  if (s.text !== undefined) text = s.text;
  else if (s.body !== undefined) text = typeof s.body === 'string' ? s.body : JSON.stringify(s.body);
  else if (s.json !== undefined) text = JSON.stringify(s.json);
  else text = '';
  const headers = Object.assign({}, s.headers || {});
  return {
    getResponseCode: () => status,
    getContentText: () => text,
    getHeaders: () => headers,
    getAllHeaders: () => headers,
    getBlob: () => ({ getDataAsString: () => text, getBytes: () => Array.from(Buffer.from(text)) })
  };
}

function matchUrl(matcher, req) {
  if (typeof matcher === 'function') return !!matcher(req);
  if (matcher instanceof RegExp || (matcher && typeof matcher.test === 'function')) return matcher.test(req.url);
  if (typeof matcher === 'string') return req.url === matcher || req.url.split('?')[0] === matcher;
  return false;
}

function parseQuery(url) {
  const out = {};
  const q = url.split('?')[1];
  if (!q) return out;
  q.split('&').forEach(p => {
    const [k, v = ''] = p.split('=');
    out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' '));
  });
  return out;
}

function createUrlFetchApp() {
  const state = { routes: [], calls: [] };
  const api = {
    /**
     * Register a route. Later registrations win.
     * method: 'GET' | 'POST' | … | '*'
     * matcher: exact URL (query ignored if it matches without) | RegExp on full URL | fn(req) -> bool
     * responder: {status, json|body|text, headers} | fn(req) -> spec | array of specs (consumed in order,
     *            last one repeats) | {throw: Error}
     */
    __on(method, matcher, responder) {
      state.routes.push({ method: String(method).toUpperCase(), matcher, responder, hits: 0 });
      return api;
    },
    __calls: state.calls,
    /** Calls filtered by method and/or URL matcher. */
    __find(method, matcher) {
      return state.calls.filter(c => (!method || method === '*' || c.method === String(method).toUpperCase()) &&
        (!matcher || matchUrl(matcher, c)));
    },
    __reset() {
      state.routes.length = 0;
      state.calls.length = 0;
      api.fetch.mockClear();
    },
    fetch: jest.fn((url, params) => {
      const p = params || {};
      const method = String(p.method || 'get').toUpperCase();
      let json = null;
      if (typeof p.payload === 'string') {
        try { json = JSON.parse(p.payload); } catch (e) { json = null; }
      }
      const req = { url, method, headers: p.headers || {}, payload: p.payload, params: p, json, query: parseQuery(url) };
      state.calls.push(req);
      for (let i = state.routes.length - 1; i >= 0; i--) {
        const r = state.routes[i];
        if (r.method !== '*' && r.method !== method) continue;
        if (!matchUrl(r.matcher, req)) continue;
        let spec = r.responder;
        if (Array.isArray(spec)) spec = spec[Math.min(r.hits, spec.length - 1)];
        r.hits++;
        if (typeof spec === 'function') spec = spec(req);
        if (spec && spec.throw) throw spec.throw;
        const resp = makeResponse(spec);
        if (!p.muteHttpExceptions && resp.getResponseCode() >= 400) {
          throw new Error('Request failed for ' + url + ' returned code ' + resp.getResponseCode());
        }
        return resp;
      }
      throw new Error('UrlFetchApp mock: no route for ' + method + ' ' + url);
    }),
    fetchAll: jest.fn(reqs => reqs.map(r => api.fetch(r.url, r)))
  };
  return api;
}

// ------------------------------------------------------------------ PropertiesService

function createProperties(initial) {
  const store = Object.assign({}, initial || {});
  const obj = {
    __store: store,
    getProperty: jest.fn(k => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null)),
    setProperty: jest.fn((k, v) => { store[k] = String(v); return obj; }),
    deleteProperty: jest.fn(k => { delete store[k]; return obj; }),
    getProperties: jest.fn(() => Object.assign({}, store)),
    setProperties: jest.fn((props, deleteAllOthers) => {
      if (deleteAllOthers) Object.keys(store).forEach(k => delete store[k]);
      Object.keys(props).forEach(k => { store[k] = String(props[k]); });
      return obj;
    }),
    deleteAllProperties: jest.fn(() => { Object.keys(store).forEach(k => delete store[k]); return obj; }),
    getKeys: jest.fn(() => Object.keys(store))
  };
  return obj;
}

function createPropertiesService(initial) {
  const svc = {
    __script: createProperties(initial.script),
    __user: createProperties(initial.user),
    __document: createProperties(initial.document)
  };
  svc.getScriptProperties = jest.fn(() => svc.__script);
  svc.getUserProperties = jest.fn(() => svc.__user);
  svc.getDocumentProperties = jest.fn(() => svc.__document);
  return svc;
}

// ------------------------------------------------------------------ CacheService

function createCache() {
  const store = {};
  const MAX = 100 * 1024;
  const c = {
    __store: store,
    get: jest.fn(k => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null)),
    getAll: jest.fn(keys => {
      const out = {};
      keys.forEach(k => { if (Object.prototype.hasOwnProperty.call(store, k)) out[k] = store[k]; });
      return out;
    }),
    put: jest.fn((k, v) => {
      if (String(k).length > 250) throw new Error('Argument too large: key');
      if (String(v).length > MAX) throw new Error('Argument too large: value');
      store[k] = String(v);
    }),
    putAll: jest.fn(values => { Object.keys(values).forEach(k => c.put(k, values[k])); }),
    remove: jest.fn(k => { delete store[k]; }),
    removeAll: jest.fn(keys => { keys.forEach(k => delete store[k]); })
  };
  return c;
}

function createCacheService() {
  const svc = { __script: createCache(), __user: createCache(), __document: createCache() };
  svc.getScriptCache = jest.fn(() => svc.__script);
  svc.getUserCache = jest.fn(() => svc.__user);
  svc.getDocumentCache = jest.fn(() => svc.__document);
  return svc;
}

// ------------------------------------------------------------------ LockService

function createLockService() {
  const svc = {
    /** Set false to simulate another execution holding the lock. */
    __available: true,
    __held: false
  };
  const lock = {
    tryLock: jest.fn(() => {
      if (!svc.__available || svc.__held) return false;
      svc.__held = true;
      return true;
    }),
    waitLock: jest.fn(() => {
      if (!lock.tryLock()) throw new Error('Lock timeout: another process was holding the lock for too long.');
    }),
    releaseLock: jest.fn(() => { svc.__held = false; }),
    hasLock: jest.fn(() => svc.__held)
  };
  svc.__lock = lock;
  svc.getScriptLock = jest.fn(() => lock);
  svc.getUserLock = jest.fn(() => lock);
  svc.getDocumentLock = jest.fn(() => lock);
  return svc;
}

// ------------------------------------------------------------------ SpreadsheetApp

const ISO_DT = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** Mimic Sheets' value parsing on write: "'x" -> text x, numeric strings -> number, ISO dates -> Date. */
function coerce(v, enabled) {
  if (typeof v !== 'string') return v === null || v === undefined ? '' : v;
  if (v.startsWith("'")) return v.slice(1);
  if (!enabled) return v;
  if (/^-?\d+(\.\d+)?$/.test(v) && v.length < 16) return Number(v);
  if (ISO_DT.test(v)) {
    const d = new Date(v);
    if (!isNaN(d.getTime())) return d;
  }
  return v;
}

function colToIndex(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function createSheet(name, opts) {
  const data = []; // rows of values
  const sheet = {
    __data: data,
    getName: jest.fn(() => sheet.__name),
    setName: jest.fn(n => { sheet.__name = n; return sheet; }),
    getLastRow: jest.fn(() => {
      for (let r = data.length - 1; r >= 0; r--) if (data[r].some(v => v !== '' && v !== null && v !== undefined)) return r + 1;
      return 0;
    }),
    getLastColumn: jest.fn(() => data.reduce((m, row) => {
      for (let c = row.length - 1; c >= 0; c--) if (row[c] !== '') return Math.max(m, c + 1);
      return m;
    }, 0)),
    getMaxRows: jest.fn(() => Math.max(1000, data.length)),
    getMaxColumns: jest.fn(() => 26),
    setFrozenRows: jest.fn(() => sheet),
    getRange: jest.fn((a, b, c, d) => {
      if (typeof a === 'string') {
        const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/i.exec(a);
        if (!m) throw new Error('Mock getRange: unsupported A1 ' + a);
        const c1 = colToIndex(m[1]), r1 = +m[2];
        const c2 = m[3] ? colToIndex(m[3]) : c1, r2 = m[4] ? +m[4] : r1;
        return makeRange(sheet, r1, c1, r2 - r1 + 1, c2 - c1 + 1, opts);
      }
      return makeRange(sheet, a, b, c === undefined ? 1 : c, d === undefined ? 1 : d, opts);
    }),
    getDataRange: jest.fn(() => makeRange(sheet, 1, 1, Math.max(1, sheet.getLastRow()), Math.max(1, sheet.getLastColumn()), opts)),
    appendRow: jest.fn(row => {
      const r = sheet.getLastRow();
      data[r] = row.map(v => coerce(v, opts.coerce));
      return sheet;
    }),
    deleteRow: jest.fn(r => { data.splice(r - 1, 1); return sheet; }),
    deleteRows: jest.fn((r, n) => { data.splice(r - 1, n); return sheet; }),
    clear: jest.fn(() => { data.length = 0; return sheet; }),
    clearContents: jest.fn(() => { data.length = 0; return sheet; }),
    getSheetValues: jest.fn((r, c, nr, nc) => makeRange(sheet, r, c, nr, nc, opts).getValues()),
    autoResizeColumns: jest.fn(() => sheet)
  };
  sheet.__name = name;
  return sheet;
}

function makeRange(sheet, row, col, numRows, numCols, opts) {
  if (row < 1 || col < 1 || numRows < 1 || numCols < 1) {
    throw new Error('Mock getRange: invalid dimensions ' + [row, col, numRows, numCols].join(','));
  }
  const data = sheet.__data;
  const ensure = r => {
    while (data.length < r) data.push([]);
  };
  const get = (r, c) => {
    const rowArr = data[r - 1];
    const v = rowArr ? rowArr[c - 1] : undefined;
    return v === undefined || v === null ? '' : v;
  };
  const range = {
    getRow: () => row,
    getColumn: () => col,
    getNumRows: () => numRows,
    getNumColumns: () => numCols,
    getLastRow: () => row + numRows - 1,
    getValues: jest.fn(() => {
      const out = [];
      for (let r = 0; r < numRows; r++) {
        const line = [];
        for (let c = 0; c < numCols; c++) line.push(get(row + r, col + c));
        out.push(line);
      }
      return out;
    }),
    getDisplayValues: jest.fn(() => range.getValues().map(r => r.map(v => (v instanceof Date ? v.toISOString() : String(v))))),
    getValue: jest.fn(() => get(row, col)),
    setValues: jest.fn(values => {
      if (!Array.isArray(values) || values.length !== numRows) {
        throw new Error('The number of rows in the data does not match the number of rows in the range. The data has ' +
          (values && values.length) + ' but the range has ' + numRows + '.');
      }
      values.forEach((line, r) => {
        if (!Array.isArray(line) || line.length !== numCols) {
          throw new Error('The number of columns in the data does not match the number of columns in the range. The data has ' +
            (line && line.length) + ' but the range has ' + numCols + '.');
        }
        ensure(row + r);
        const arr = data[row + r - 1];
        line.forEach((v, c) => {
          while (arr.length < col + c - 1) arr.push('');
          arr[col + c - 1] = coerce(v, opts.coerce);
        });
      });
      return range;
    }),
    setValue: jest.fn(v => range.setValues([[v]]) && range),
    clearContent: jest.fn(() => {
      for (let r = 0; r < numRows; r++) for (let c = 0; c < numCols; c++) {
        const arr = data[row + r - 1];
        if (arr) arr[col + c - 1] = '';
      }
      return range;
    }),
    setNumberFormat: jest.fn(() => range),
    setFontWeight: jest.fn(() => range)
  };
  return range;
}

function createSpreadsheet(id, name, opts) {
  const sheets = [];
  const ss = {
    __sheets: sheets,
    getId: jest.fn(() => id),
    getName: jest.fn(() => name),
    getUrl: jest.fn(() => 'https://docs.google.com/spreadsheets/d/' + id + '/edit'),
    getSheets: jest.fn(() => sheets.slice()),
    getSheetByName: jest.fn(n => sheets.find(s => s.__name === n) || null),
    insertSheet: jest.fn(n => {
      const nm = n || 'Sheet' + (sheets.length + 1);
      if (sheets.some(s => s.__name === nm)) {
        throw new Error('A sheet with the name "' + nm + '" already exists. Please enter another name.');
      }
      const s = createSheet(nm, opts);
      sheets.push(s);
      return s;
    }),
    deleteSheet: jest.fn(s => {
      const i = sheets.indexOf(s);
      if (i >= 0) sheets.splice(i, 1);
    })
  };
  sheets.push(createSheet('Sheet1', opts));
  return ss;
}

function createSpreadsheetApp(opts) {
  const state = { byId: {}, n: 0 };
  const app = {
    __spreadsheets: state.byId,
    /** Pre-create a spreadsheet with a given id (e.g. to match a STATE_SHEET_ID property). */
    __add(id, name) {
      state.byId[id] = createSpreadsheet(id, name || 'Untitled', opts);
      return state.byId[id];
    },
    create: jest.fn(name => {
      state.n++;
      const id = 'ss_' + state.n;
      state.byId[id] = createSpreadsheet(id, name, opts);
      return state.byId[id];
    }),
    openById: jest.fn(id => {
      if (!state.byId[id]) throw new Error('Unexpected error while getting the method or property openById on object SpreadsheetApp.');
      return state.byId[id];
    }),
    getActiveSpreadsheet: jest.fn(() => Object.values(state.byId)[0] || null),
    flush: jest.fn()
  };
  return app;
}

// ------------------------------------------------------------------ CalendarApp

const GuestStatus = { INVITED: 'INVITED', YES: 'YES', NO: 'NO', MAYBE: 'MAYBE', OWNER: 'OWNER' };

/**
 * Event spec: {id, title, start, end, allDay, location, description, guests:[{email, name, status}],
 *              myStatus, isOwnedByMe, creators:[email], calendarId, tags:{}}
 */
function makeEvent(spec, calendarId) {
  const e = Object.assign({ guests: [], allDay: false, location: '', description: '', myStatus: GuestStatus.YES, isOwnedByMe: false, creators: [], tags: {} }, spec);
  const start = new Date(e.start);
  const end = new Date(e.end || e.start);
  return {
    __spec: e,
    getId: jest.fn(() => e.id),
    getTitle: jest.fn(() => e.title || ''),
    getStartTime: jest.fn(() => new Date(start.getTime())),
    getEndTime: jest.fn(() => new Date(end.getTime())),
    getAllDayStartDate: jest.fn(() => new Date(start.getTime())),
    getAllDayEndDate: jest.fn(() => new Date(end.getTime())),
    isAllDayEvent: jest.fn(() => !!e.allDay),
    isRecurringEvent: jest.fn(() => !!e.recurring),
    getLocation: jest.fn(() => e.location || ''),
    getDescription: jest.fn(() => e.description || ''),
    getMyStatus: jest.fn(() => e.myStatus),
    isOwnedByMe: jest.fn(() => !!e.isOwnedByMe),
    getCreators: jest.fn(() => e.creators.slice()),
    getOriginalCalendarId: jest.fn(() => e.calendarId || calendarId),
    getTag: jest.fn(k => (e.tags[k] === undefined ? null : e.tags[k])),
    setTag: jest.fn((k, v) => { e.tags[k] = v; }),
    getGuestList: jest.fn(() => e.guests.map(g => ({
      getEmail: () => g.email,
      getName: () => g.name || '',
      getGuestStatus: () => g.status || GuestStatus.YES,
      getAdditionalGuests: () => 0
    })))
  };
}

function createCalendarApp() {
  const cals = {};
  const addCalendar = (id, events, name) => {
    const evs = (events || []).map(s => makeEvent(s, id));
    const cal = {
      __events: evs,
      getId: jest.fn(() => id),
      getName: jest.fn(() => name || id),
      getEvents: jest.fn((start, end) => evs.filter(ev => ev.getStartTime() < end && ev.getEndTime() > start)),
      getEventsForDay: jest.fn(day => {
        const s = new Date(day); s.setHours(0, 0, 0, 0);
        const e = new Date(s.getTime() + 86400000);
        return evs.filter(ev => ev.getStartTime() < e && ev.getEndTime() > s);
      }),
      getEventById: jest.fn(eid => evs.find(ev => ev.__spec.id === eid) || null),
      __addEvent(spec) { const ev = makeEvent(spec, id); evs.push(ev); return ev; }
    };
    cals[id] = cal;
    return cal;
  };
  return {
    __calendars: cals,
    /** Add a calendar with event specs; returns the fake calendar. */
    __addCalendar: addCalendar,
    GuestStatus,
    getCalendarById: jest.fn(id => cals[id] || null),
    getAllCalendars: jest.fn(() => Object.values(cals)),
    getDefaultCalendar: jest.fn(() => Object.values(cals)[0] || null),
    getOwnedCalendarById: jest.fn(id => cals[id] || null)
  };
}

// ------------------------------------------------------------------ GmailApp

/**
 * Thread spec: {id, labels:[names], inInbox, messages:[{id, from, to, cc, replyTo, subject, date,
 *               plain, body, starred, unread, headers:{Name: value}}]}
 */
function makeThread(spec) {
  const t = Object.assign({ labels: [], inInbox: true, messages: [] }, spec);
  const thread = { __spec: t };
  const msgs = t.messages.map(ms => {
    const m = Object.assign({ starred: false, unread: false, headers: {}, to: '', cc: '', plain: '', body: '' }, ms);
    const msg = {
      __spec: m,
      getId: jest.fn(() => m.id),
      getFrom: jest.fn(() => m.from || ''),
      getTo: jest.fn(() => m.to || ''),
      getCc: jest.fn(() => m.cc || ''),
      getBcc: jest.fn(() => ''),
      getReplyTo: jest.fn(() => m.replyTo || ''),
      getSubject: jest.fn(() => m.subject || t.subject || ''),
      getDate: jest.fn(() => new Date(m.date)),
      getPlainBody: jest.fn(() => m.plain || ''),
      getBody: jest.fn(() => m.body || m.plain || ''),
      getHeader: jest.fn(name => {
        const k = Object.keys(m.headers).find(h => h.toLowerCase() === String(name).toLowerCase());
        return k ? m.headers[k] : '';
      }),
      isStarred: jest.fn(() => !!m.starred),
      star: jest.fn(() => { m.starred = true; return msg; }),
      unstar: jest.fn(() => { m.starred = false; return msg; }),
      isUnread: jest.fn(() => !!m.unread),
      markRead: jest.fn(() => { m.unread = false; return msg; }),
      isInInbox: jest.fn(() => !!t.inInbox),
      getThread: jest.fn(() => thread)
    };
    return msg;
  });
  Object.assign(thread, {
    __messages: msgs,
    getId: jest.fn(() => t.id),
    getFirstMessageSubject: jest.fn(() => (msgs[0] ? msgs[0].getSubject() : t.subject || '')),
    getMessages: jest.fn(() => msgs.slice()),
    getMessageCount: jest.fn(() => msgs.length),
    getLastMessageDate: jest.fn(() => (msgs.length ? msgs[msgs.length - 1].getDate() : new Date(0))),
    getPermalink: jest.fn(() => 'https://mail.google.com/mail/#all/' + t.id),
    getLabels: jest.fn(() => t.labels.map(n => ({ getName: () => n }))),
    isInInbox: jest.fn(() => !!t.inInbox),
    addLabel: jest.fn(l => { t.labels.push(l.getName()); return thread; }),
    removeLabel: jest.fn(l => { t.labels = t.labels.filter(n => n !== l.getName()); return thread; })
  });
  return thread;
}

function createGmailApp() {
  const state = { threads: [], search: null, labels: {} };
  const app = {
    __threads: state.threads,
    /** Add thread specs; returns the fake threads. */
    __addThreads(specs) {
      const made = specs.map(makeThread);
      made.forEach(t => state.threads.push(t));
      return made;
    },
    /** Custom search: fn(query, start, max, threads) -> threads. Default returns all threads. */
    __setSearch(fn) { state.search = fn; },
    search: jest.fn((query, start, max) => {
      const all = state.search ? state.search(query, start, max, state.threads.slice()) : state.threads.slice();
      const s = start || 0;
      return max ? all.slice(s, s + max) : all.slice(s);
    }),
    getThreadById: jest.fn(id => state.threads.find(t => t.__spec.id === id) || null),
    getMessageById: jest.fn(id => {
      for (const t of state.threads) {
        const m = t.__messages.find(x => x.__spec.id === id);
        if (m) return m;
      }
      return null;
    }),
    getUserLabelByName: jest.fn(n => state.labels[n] || null),
    createLabel: jest.fn(n => {
      state.labels[n] = { getName: () => n };
      return state.labels[n];
    })
  };
  return app;
}

// ------------------------------------------------------------------ HtmlService

function makeHtmlOutput(content) {
  const out = {
    __content: content || '',
    __title: '',
    __meta: {},
    getContent: jest.fn(() => out.__content),
    setContent: jest.fn(c => { out.__content = c; return out; }),
    append: jest.fn(c => { out.__content += c; return out; }),
    setTitle: jest.fn(t => { out.__title = t; return out; }),
    getTitle: jest.fn(() => out.__title),
    addMetaTag: jest.fn((k, v) => { out.__meta[k] = v; return out; }),
    setXFrameOptionsMode: jest.fn(() => out),
    setSandboxMode: jest.fn(() => out),
    setFaviconUrl: jest.fn(() => out),
    setWidth: jest.fn(() => out),
    setHeight: jest.fn(() => out)
  };
  return out;
}

function readRootFile(name) {
  const p = path.join(ROOT, /\.html$/.test(name) ? name : name + '.html');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

function createHtmlService() {
  return {
    XFrameOptionsMode: { ALLOWALL: 'ALLOWALL', DEFAULT: 'DEFAULT' },
    SandboxMode: { IFRAME: 'IFRAME', NATIVE: 'NATIVE', EMULATED: 'EMULATED' },
    createHtmlOutput: jest.fn(c => makeHtmlOutput(c)),
    createHtmlOutputFromFile: jest.fn(n => makeHtmlOutput(readRootFile(n))),
    /** Template evaluate() returns the raw file (scriptlets are NOT executed). */
    createTemplateFromFile: jest.fn(n => {
      const tpl = { __file: n, evaluate: jest.fn(() => makeHtmlOutput(readRootFile(n))) };
      return tpl;
    }),
    createTemplate: jest.fn(c => ({ evaluate: jest.fn(() => makeHtmlOutput(c)) }))
  };
}

// ------------------------------------------------------------------ ContentService

function createContentService() {
  const make = c => {
    const o = { __content: c, __mime: 'TEXT' };
    o.getContent = jest.fn(() => o.__content);
    o.setMimeType = jest.fn(m => { o.__mime = m; return o; });
    o.setContent = jest.fn(x => { o.__content = x; return o; });
    return o;
  };
  return {
    MimeType: { JSON: 'JSON', TEXT: 'TEXT', HTML: 'HTML' },
    createTextOutput: jest.fn(c => make(c || ''))
  };
}

// ------------------------------------------------------------------ ScriptApp

function createScriptApp(opts) {
  const state = { triggers: [], n: 0, url: opts.serviceUrl === undefined ? 'https://script.google.com/macros/s/TEST/exec' : opts.serviceUrl };
  const makeBuilder = handler => {
    const cfg = { handler, type: 'CLOCK' };
    const b = {
      timeBased: jest.fn(() => b),
      everyMinutes: jest.fn(n => { cfg.everyMinutes = n; return b; }),
      everyHours: jest.fn(n => { cfg.everyHours = n; return b; }),
      everyDays: jest.fn(n => { cfg.everyDays = n; return b; }),
      everyWeeks: jest.fn(n => { cfg.everyWeeks = n; return b; }),
      atHour: jest.fn(h => { cfg.atHour = h; return b; }),
      nearMinute: jest.fn(m => { cfg.nearMinute = m; return b; }),
      onWeekDay: jest.fn(d => { cfg.onWeekDay = d; return b; }),
      inTimezone: jest.fn(tz => { cfg.timezone = tz; return b; }),
      after: jest.fn(ms => { cfg.after = ms; return b; }),
      at: jest.fn(d => { cfg.at = d; return b; }),
      create: jest.fn(() => {
        state.n++;
        const id = 'trigger_' + state.n;
        const t = {
          __config: cfg,
          getHandlerFunction: jest.fn(() => handler),
          getUniqueId: jest.fn(() => id),
          getEventType: jest.fn(() => 'CLOCK'),
          getTriggerSource: jest.fn(() => 'CLOCK')
        };
        state.triggers.push(t);
        return t;
      })
    };
    return b;
  };
  return {
    __triggers: state.triggers,
    __setServiceUrl(u) { state.url = u; },
    EventType: { CLOCK: 'CLOCK', ON_OPEN: 'ON_OPEN', ON_EDIT: 'ON_EDIT' },
    TriggerSource: { CLOCK: 'CLOCK', SPREADSHEETS: 'SPREADSHEETS' },
    WeekDay: { MONDAY: 'MONDAY', TUESDAY: 'TUESDAY', WEDNESDAY: 'WEDNESDAY', THURSDAY: 'THURSDAY', FRIDAY: 'FRIDAY', SATURDAY: 'SATURDAY', SUNDAY: 'SUNDAY' },
    newTrigger: jest.fn(makeBuilder),
    getProjectTriggers: jest.fn(() => state.triggers.slice()),
    deleteTrigger: jest.fn(t => {
      const i = state.triggers.indexOf(t);
      if (i >= 0) state.triggers.splice(i, 1);
    }),
    getService: jest.fn(() => ({ getUrl: jest.fn(() => state.url), isEnabled: jest.fn(() => !!state.url) })),
    getOAuthToken: jest.fn(() => 'oauth-token'),
    getScriptId: jest.fn(() => 'script-id')
  };
}

// ------------------------------------------------------------------ Session

function createSession(opts) {
  const s = { __email: opts.userEmail || 'alex@alexscammon.com', __tz: opts.timeZone || 'America/Los_Angeles' };
  const user = { getEmail: jest.fn(() => s.__email) };
  s.getEffectiveUser = jest.fn(() => user);
  s.getActiveUser = jest.fn(() => user);
  s.getScriptTimeZone = jest.fn(() => s.__tz);
  s.getTemporaryActiveUserKey = jest.fn(() => 'temp-key');
  return s;
}

// ------------------------------------------------------------------ Utilities

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function zonedParts(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short'
  });
  const p = {};
  fmt.formatToParts(date).forEach(x => { p[x.type] = x.value; });
  const y = +p.year, mo = +p.month, d = +p.day, h = +p.hour % 24, mi = +p.minute, s = +p.second;
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  const offsetMin = Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
  const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  return { y, mo, d, h, mi, s, ms: date.getTime() % 1000, dow, offsetMin };
}

/** Subset of java.text.SimpleDateFormat used by Utilities.formatDate. */
function formatDate(date, tz, pattern) {
  const dt = date instanceof Date || (date && typeof date.getTime === 'function') ? new Date(date.getTime()) : new Date(date);
  if (isNaN(dt.getTime())) throw new Error('Invalid argument: date');
  const zone = tz === 'GMT' || tz === 'UTC' || tz === 'Etc/GMT' ? 'UTC' : tz;
  const p = zonedParts(dt, zone);
  const pad = (n, w) => String(n).padStart(w, '0');
  const off = sep => {
    const sign = p.offsetMin < 0 ? '-' : '+';
    const a = Math.abs(p.offsetMin);
    return sign + pad(Math.floor(a / 60), 2) + sep + pad(a % 60, 2);
  };
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "'") {
      if (pattern[i + 1] === "'") { out += "'"; i += 2; continue; }
      i++;
      while (i < pattern.length) {
        if (pattern[i] === "'" && pattern[i + 1] === "'") { out += "'"; i += 2; continue; }
        if (pattern[i] === "'") { i++; break; }
        out += pattern[i++];
      }
      continue;
    }
    if (!/[A-Za-z]/.test(ch)) { out += ch; i++; continue; }
    let n = 1;
    while (pattern[i + n] === ch) n++;
    i += n;
    switch (ch) {
      case 'y': out += n === 2 ? pad(p.y % 100, 2) : pad(p.y, n); break;
      case 'M': out += n >= 4 ? MONTHS[p.mo - 1] : n === 3 ? MONTHS[p.mo - 1].slice(0, 3) : pad(p.mo, n); break;
      case 'd': out += pad(p.d, n); break;
      case 'E': out += n >= 4 ? DAYS[p.dow] : DAYS[p.dow].slice(0, 3); break;
      case 'u': out += String(p.dow === 0 ? 7 : p.dow); break;
      case 'H': out += pad(p.h, n); break;
      case 'k': out += pad(p.h === 0 ? 24 : p.h, n); break;
      case 'h': out += pad(p.h % 12 === 0 ? 12 : p.h % 12, n); break;
      case 'm': out += pad(p.mi, n); break;
      case 's': out += pad(p.s, n); break;
      case 'S': out += pad(p.ms, 3).slice(0, n); break;
      case 'a': out += p.h < 12 ? 'AM' : 'PM'; break;
      case 'Z': out += off(''); break;
      case 'X': out += p.offsetMin === 0 ? 'Z' : off(n >= 3 ? ':' : ''); break;
      case 'z': out += zone === 'UTC' ? 'UTC' : off(':'); break;
      default: throw new Error('Mock formatDate: unsupported pattern letter ' + ch);
    }
  }
  return out;
}

function toBuffer(value, charset) {
  if (Array.isArray(value)) return Buffer.from(value.map(b => (b + 256) % 256));
  if (value && typeof value.getBytes === 'function') return toBuffer(value.getBytes());
  return Buffer.from(String(value), charset === 'US_ASCII' ? 'ascii' : 'utf8');
}

const toSigned = buf => Array.from(buf).map(b => (b > 127 ? b - 256 : b));

function createUtilities() {
  const u = {
    __sleeps: [],
    DigestAlgorithm: { MD2: 'MD2', MD5: 'MD5', SHA_1: 'SHA_1', SHA_256: 'SHA_256', SHA_384: 'SHA_384', SHA_512: 'SHA_512' },
    MacAlgorithm: { HMAC_MD5: 'HMAC_MD5', HMAC_SHA_1: 'HMAC_SHA_1', HMAC_SHA_256: 'HMAC_SHA_256', HMAC_SHA_384: 'HMAC_SHA_384', HMAC_SHA_512: 'HMAC_SHA_512' },
    Charset: { UTF_8: 'UTF_8', US_ASCII: 'US_ASCII' }
  };
  const algo = a => ({ MD5: 'md5', SHA_1: 'sha1', SHA_256: 'sha256', SHA_384: 'sha384', SHA_512: 'sha512' })[String(a).replace(/^HMAC_/, '')];
  u.computeDigest = jest.fn((alg, value, charset) => toSigned(crypto.createHash(algo(alg)).update(toBuffer(value, charset)).digest()));
  u.computeHmacSignature = jest.fn((alg, value, key, charset) =>
    toSigned(crypto.createHmac(algo(alg), toBuffer(key, charset)).update(toBuffer(value, charset)).digest()));
  u.computeHmacSha256Signature = jest.fn((value, key, charset) => u.computeHmacSignature('HMAC_SHA_256', value, key, charset));
  u.base64Encode = jest.fn((v, charset) => toBuffer(v, charset).toString('base64'));
  u.base64EncodeWebSafe = jest.fn((v, charset) => toBuffer(v, charset).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'));
  u.base64Decode = jest.fn(s => toSigned(Buffer.from(String(s), 'base64')));
  u.base64DecodeWebSafe = jest.fn(s => toSigned(Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64')));
  u.newBlob = jest.fn((data, contentType, name) => {
    const buf = toBuffer(data);
    return {
      getBytes: () => toSigned(buf),
      getDataAsString: () => buf.toString('utf8'),
      getContentType: () => contentType || null,
      getName: () => name || null
    };
  });
  u.formatDate = jest.fn(formatDate);
  u.sleep = jest.fn(ms => { u.__sleeps.push(ms); });
  u.getUuid = jest.fn(() => crypto.randomUUID());
  return u;
}

// ------------------------------------------------------------------ Logger / console

function createLogger(logs) {
  return {
    log: jest.fn((...a) => { logs.push(a.map(String).join(' ')); }),
    getLog: jest.fn(() => logs.join('\n')),
    clear: jest.fn(() => { logs.length = 0; })
  };
}

function createConsole(logs, quiet) {
  const rec = level => jest.fn((...a) => {
    logs.push((level === 'log' ? '' : level.toUpperCase() + ' ') + a.map(x => (typeof x === 'string' ? x : safeJson(x))).join(' '));
    if (!quiet) console[level](...a);
  });
  return { log: rec('log'), info: rec('info'), warn: rec('warn'), error: rec('error') };
}

function safeJson(x) {
  try {
    return x instanceof Error ? x.stack || x.message : JSON.stringify(x);
  } catch (e) {
    return String(x);
  }
}

// ------------------------------------------------------------------ factory

/**
 * @param {{props?: Object, userProps?: Object, userEmail?: string, timeZone?: string,
 *          serviceUrl?: string|null, coerce?: boolean, quiet?: boolean}} [options]
 *   props       initial Script Properties
 *   coerce      mimic Sheets auto-typing on writes (default true)
 *   quiet       swallow console output (default true); logs always recorded in mocks.logs
 */
function createMocks(options) {
  const opts = Object.assign({ coerce: true, quiet: true }, options || {});
  const m = {};
  m.build_ = () => {
    m.logs = [];
    m.UrlFetchApp = createUrlFetchApp();
    m.PropertiesService = createPropertiesService({ script: opts.props, user: opts.userProps });
    m.CacheService = createCacheService();
    m.LockService = createLockService();
    m.SpreadsheetApp = createSpreadsheetApp(opts);
    m.CalendarApp = createCalendarApp();
    m.GmailApp = createGmailApp();
    m.HtmlService = createHtmlService();
    m.ContentService = createContentService();
    m.ScriptApp = createScriptApp(opts);
    m.Session = createSession(opts);
    m.Utilities = createUtilities();
    m.Logger = createLogger(m.logs);
    m.console = createConsole(m.logs, opts.quiet);
    m.props = m.PropertiesService.__script.__store;
    m.globals = {
      UrlFetchApp: m.UrlFetchApp, PropertiesService: m.PropertiesService, CacheService: m.CacheService,
      LockService: m.LockService, SpreadsheetApp: m.SpreadsheetApp, CalendarApp: m.CalendarApp,
      GmailApp: m.GmailApp, HtmlService: m.HtmlService, ContentService: m.ContentService,
      ScriptApp: m.ScriptApp, Session: m.Session, Utilities: m.Utilities, Logger: m.Logger, console: m.console
    };
  };
  /** Rebuild every fake from the original options (fresh state, fresh jest.fn()s). */
  m.reset = () => {
    m.build_();
    if (m.__context) Object.assign(m.__context, m.globals);
    return m;
  };
  m.build_();
  return m;
}

/** Convenience response specs for UrlFetchApp.__on. */
const respond = {
  json: (json, status, headers) => ({ status: status || 200, json, headers }),
  status: (status, body, headers) => ({ status, body: body || '', headers }),
  empty: () => ({ status: 204, text: '' }),
  networkError: msg => ({ throw: new Error(msg || 'Address unavailable') })
};

module.exports = { createMocks, respond, formatDate, makeEvent, makeThread, GuestStatus };
