/**
 * Store — Google Sheet-backed state: ledger, queue, feedback, runs, kv.
 *
 * Each tab is read once per execution with a single getValues() and cached in
 * memory; writes use setValues() on whole rows (appends are batched). Values that
 * Sheets would auto-convert (numbers, dates, formulas) are read back as strings.
 */
const Store = {
  SHEET_NAME: 'Todoist Automations — State',
  MAX_CELL: 49000,

  TABS: {
    ledger: ['key', 'source', 'processedAt', 'outcome', 'taskIds', 'queueIds', 'note'],
    queue: ['id', 'status', 'createdAt', 'source', 'project', 'json'],
    feedback: ['at', 'type', 'queueId', 'sourceKey', 'title', 'detail'],
    runs: ['at', 'job', 'durationMs', 'seen', 'created', 'queued', 'skipped', 'errors', 'note'],
    kv: ['key', 'value']
  },

  ss_: null,
  cache_: {},

  /** Open STATE_SHEET_ID, or create the state spreadsheet and save its id. */
  sheet() {
    if (Store.ss_) return Store.ss_;
    const id = Config.get('STATE_SHEET_ID', null);
    if (id) {
      Store.ss_ = SpreadsheetApp.openById(id);
    } else {
      Store.ss_ = SpreadsheetApp.create(Store.SHEET_NAME);
      Config.set('STATE_SHEET_ID', Store.ss_.getId());
    }
    return Store.ss_;
  },

  /** Drop in-memory caches (tests; or after external edits). */
  reset() {
    Store.ss_ = null;
    Store.cache_ = {};
  },

  /** Tab by name, created with header row on demand. */
  tab_(name) {
    const headers = Store.TABS[name];
    if (!headers) throw new Error('Unknown Store tab: ' + name);
    const ss = Store.sheet();
    let sh = ss.getSheetByName(name);
    if (!sh) {
      sh = ss.insertSheet(name);
      sh.getRange(1, 1, 1, headers.length).setValues([headers]);
      if (sh.setFrozenRows) sh.setFrozenRows(1);
    }
    return sh;
  },

  /** Cached {sheet, rows: string[][]} for a tab (data rows only, row i -> sheet row i+2). */
  load_(name) {
    if (Store.cache_[name]) return Store.cache_[name];
    const sh = Store.tab_(name);
    const width = Store.TABS[name].length;
    const last = sh.getLastRow();
    const rows = last >= 2
      ? sh.getRange(2, 1, last - 1, width).getValues().map(function (r) { return r.map(Store.readCell_); })
      : [];
    Store.cache_[name] = { sheet: sh, rows: rows };
    return Store.cache_[name];
  },

  readCell_(v) {
    if (v === null || v === undefined) return '';
    if (v instanceof Date || (typeof v === 'object' && typeof v.toISOString === 'function')) return v.toISOString();
    return String(v);
  },

  /** Protect strings Sheets would interpret (formulas, numbers, dates) by prefixing an apostrophe. */
  writeCell_(v) {
    if (v === null || v === undefined) return '';
    let s = typeof v === 'string' ? v : (typeof v === 'object' ? JSON.stringify(v) : String(v));
    if (s.length > Store.MAX_CELL) s = s.slice(0, Store.MAX_CELL);
    return s === '' ? '' : "'" + s;
  },

  append_(name, rows) {
    if (!rows.length) return;
    const t = Store.load_(name);
    const start = t.sheet.getLastRow() + 1;
    const width = Store.TABS[name].length;
    t.sheet.getRange(start, 1, rows.length, width).setValues(rows.map(function (r) { return r.map(Store.writeCell_); }));
    rows.forEach(function (r) { t.rows.push(r.map(function (v) { return Store.readCell_(v === null || v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : v)); })); });
  },

  writeRow_(name, index, row) {
    const t = Store.load_(name);
    const width = Store.TABS[name].length;
    t.sheet.getRange(index + 2, 1, 1, width).setValues([row.map(Store.writeCell_)]);
    t.rows[index] = row.map(function (v) { return Store.readCell_(v === null || v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : v)); });
  },

  findIndex_(name, col, value) {
    const rows = Store.load_(name).rows;
    for (let i = rows.length - 1; i >= 0; i--) if (rows[i][col] === value) return i;
    return -1;
  },

  nowIso_() {
    return Util.now().toISOString();
  },

  splitIds_(s) {
    return s ? String(s).split(',').map(function (x) { return x.trim(); }).filter(String) : [];
  },

  // ---------------------------------------------------------------- ledger

  /** Ledger entry for key or null: {key, source, processedAt, outcome, taskIds[], queueIds[], note}. */
  ledgerGet(key) {
    const i = Store.findIndex_('ledger', 0, String(key));
    if (i < 0) return null;
    const r = Store.load_('ledger').rows[i];
    return {
      key: r[0], source: r[1], processedAt: r[2], outcome: r[3],
      taskIds: Store.splitIds_(r[4]), queueIds: Store.splitIds_(r[5]), note: r[6]
    };
  },

  /** True if key has a ledger entry whose outcome is not 'error' (errored keys are retried). */
  ledgerHas(key) {
    const e = Store.ledgerGet(key);
    return !!e && e.outcome !== 'error';
  },

  /**
   * Upsert a ledger entry {key, source?, outcome, taskIds?, queueIds?, note?, processedAt?}.
   * An existing row for the key is overwritten in place.
   */
  ledgerPut(entry) {
    Store.ledgerPutMany([entry]);
  },

  /** Batch ledgerPut. */
  ledgerPutMany(entries) {
    const appends = [];
    entries.forEach(function (e) {
      if (!e || !e.key) throw new Error('ledgerPut: key required');
      const row = [
        String(e.key), e.source || String(e.key).split(':')[0], e.processedAt || Store.nowIso_(),
        e.outcome || 'nothing',
        (e.taskIds || []).join(','), (e.queueIds || []).join(','), e.note || ''
      ];
      const i = Store.findIndex_('ledger', 0, row[0]);
      if (i >= 0) Store.writeRow_('ledger', i, row);
      else {
        const dup = appends.findIndex(function (a) { return a[0] === row[0]; });
        if (dup >= 0) appends[dup] = row; else appends.push(row);
      }
    });
    Store.append_('ledger', appends);
  },

  // ---------------------------------------------------------------- queue

  /** 'q_' + Util.hash(source + sourceId + normalised title). */
  queueId(source, sourceId, title) {
    return 'q_' + Util.hash(String(source) + String(sourceId) + Util.normalizeTitle(title));
  },

  /**
   * Append queue items (each must have `id`; see DESIGN "Queue item").
   * Skips ids already present (or repeated in the batch). Fills createdAt/status defaults.
   * @return {Object[]} the items actually added.
   */
  queueAdd(items) {
    const t = Store.load_('queue');
    const have = {};
    t.rows.forEach(function (r) { have[r[0]] = 1; });
    const added = [];
    (items || []).forEach(function (it) {
      if (!it || !it.id) throw new Error('queueAdd: item.id required');
      if (have[it.id]) return;
      have[it.id] = 1;
      const item = Object.assign({
        status: 'pending', createdAt: Store.nowIso_(), chips: [], dupTaskId: null, dupTaskTitle: null,
        resolvedAt: null, resultTaskId: null, notDuplicate: false
      }, it);
      added.push(item);
    });
    Store.append_('queue', added.map(Store.queueRow_));
    return added;
  },

  queueRow_(item) {
    return [item.id, item.status || 'pending', item.createdAt || '', item.source || '', item.project || '', JSON.stringify(item)];
  },

  queueParse_(r) {
    const item = Util.parseJson(r[5], null) || { id: r[0] };
    item.status = r[1] || item.status;
    return item;
  },

  /** Queue items, oldest first; filter by {status, source, project} (each optional). */
  queueList(filter) {
    const f = filter || {};
    return Store.load_('queue').rows.filter(function (r) {
      return (!f.status || r[1] === f.status) && (!f.source || r[3] === f.source) && (!f.project || r[4] === f.project);
    }).map(Store.queueParse_);
  },

  /** Count of queue items with a status (default 'pending'). */
  queueCount(status) {
    const s = status || 'pending';
    return Store.load_('queue').rows.filter(function (r) { return r[1] === s; }).length;
  },

  /** Queue item by id, or null. */
  queueGet(id) {
    const i = Store.findIndex_('queue', 0, String(id));
    return i < 0 ? null : Store.queueParse_(Store.load_('queue').rows[i]);
  },

  /** Merge patch into an item and persist; returns the updated item. Throws if missing. */
  queueUpdate(id, patch) {
    const i = Store.findIndex_('queue', 0, String(id));
    if (i < 0) throw new Error('Queue item not found: ' + id);
    const item = Object.assign(Store.queueParse_(Store.load_('queue').rows[i]), patch || {}, { id: String(id) });
    Store.writeRow_('queue', i, Store.queueRow_(item));
    return item;
  },

  // ---------------------------------------------------------------- feedback

  /** Append {type, queueId, sourceKey, title, detail, at?}. */
  feedbackAdd(entry) {
    const e = entry || {};
    Store.append_('feedback', [[e.at || Store.nowIso_(), e.type || '', e.queueId || '', e.sourceKey || '', e.title || '',
      e.detail === undefined || e.detail === null ? '' : JSON.stringify(e.detail)]]);
  },

  /** Most recent n (default 20) feedback entries, newest first; optional type filter. */
  feedbackRecent(n, type) {
    const lim = n || 20;
    const out = [];
    const rows = Store.load_('feedback').rows;
    for (let i = rows.length - 1; i >= 0 && out.length < lim; i--) {
      const r = rows[i];
      if (type && r[1] !== type) continue;
      out.push({ at: r[0], type: r[1], queueId: r[2], sourceKey: r[3], title: r[4], detail: Util.parseJson(r[5], r[5] || null) });
    }
    return out;
  },

  // ---------------------------------------------------------------- runs

  /** Append {job, durationMs, seen, created, queued, skipped, errors, note}. */
  runLog(entry) {
    const e = entry || {};
    Store.append_('runs', [[e.at || Store.nowIso_(), e.job || '', e.durationMs || 0, e.seen || 0, e.created || 0,
      e.queued || 0, e.skipped || 0, e.errors || 0, e.note || '']]);
  },

  /** Last n runs (newest first), optionally for one job. Numbers parsed. */
  runsRecent(n, job) {
    const out = [];
    const rows = Store.load_('runs').rows;
    for (let i = rows.length - 1; i >= 0 && out.length < (n || 20); i--) {
      const r = rows[i];
      if (job && r[1] !== job) continue;
      out.push({ at: r[0], job: r[1], durationMs: +r[2] || 0, seen: +r[3] || 0, created: +r[4] || 0,
        queued: +r[5] || 0, skipped: +r[6] || 0, errors: +r[7] || 0, note: r[8] });
    }
    return out;
  },

  // ---------------------------------------------------------------- kv

  /** JSON value for key, or def. */
  kvGet(k, def) {
    const i = Store.findIndex_('kv', 0, String(k));
    if (i < 0) return def === undefined ? null : def;
    const raw = Store.load_('kv').rows[i][1];
    return Util.parseJson(raw, def === undefined ? null : def);
  },

  /** Store any JSON-serialisable value (upsert). */
  kvSet(k, v) {
    const row = [String(k), JSON.stringify(v === undefined ? null : v)];
    const i = Store.findIndex_('kv', 0, row[0]);
    if (i >= 0) Store.writeRow_('kv', i, row);
    else Store.append_('kv', [row]);
  }
};
