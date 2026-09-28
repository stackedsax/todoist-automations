const { loadGas } = require('./helpers/gas');
const { createMocks } = require('./helpers/mocks');

const FILES = ['Config.js', 'Util.js', 'Store.js'];
const NOW = new Date('2026-09-24T18:00:00Z');

function load(opts) {
  const ctx = loadGas(FILES, opts || {});
  ctx.Util.now = () => NOW;
  return ctx;
}

/** Fresh context over the same mocks: simulates the next Apps Script execution. */
function nextExecution(mocks) {
  const ctx = loadGas(FILES, { mocks });
  ctx.Util.now = () => NOW;
  return ctx;
}

const tabValues = (ctx, name) => {
  const ss = ctx.__mocks.SpreadsheetApp.openById(ctx.__mocks.props.STATE_SHEET_ID);
  return ss.getSheetByName(name).getDataRange().getValues();
};

describe('Store.sheet', () => {
  test('creates the state spreadsheet once and saves STATE_SHEET_ID', () => {
    const ctx = load();
    const ss = ctx.Store.sheet();
    expect(ctx.__mocks.SpreadsheetApp.create).toHaveBeenCalledWith('Todoist Automations — State');
    expect(ctx.__mocks.props.STATE_SHEET_ID).toBe(ss.getId());
    ctx.Store.sheet();
    expect(ctx.__mocks.SpreadsheetApp.create).toHaveBeenCalledTimes(1);
  });

  test('opens existing STATE_SHEET_ID', () => {
    const mocks = createMocks({ props: { STATE_SHEET_ID: 'abc' } });
    mocks.SpreadsheetApp.__add('abc', 'existing');
    const ctx = load({ mocks });
    expect(ctx.Store.sheet().getId()).toBe('abc');
    expect(mocks.SpreadsheetApp.create).not.toHaveBeenCalled();
  });

  test('tabs are created on demand with header rows', () => {
    const ctx = load();
    ctx.Store.kvSet('x', 1);
    expect(tabValues(ctx, 'kv')[0]).toEqual(['key', 'value']);
    ctx.Store.ledgerHas('nope');
    expect(tabValues(ctx, 'ledger')[0]).toEqual(['key', 'source', 'processedAt', 'outcome', 'taskIds', 'queueIds', 'note']);
  });
});

describe('ledger', () => {
  test('put/has/get round trip and persists across executions', () => {
    const ctx = load();
    expect(ctx.Store.ledgerHas('granola:not_1')).toBe(false);
    ctx.Store.ledgerPut({ key: 'granola:not_1', outcome: 'tasks', taskIds: ['123', '456'], note: 'ok' });
    expect(ctx.Store.ledgerHas('granola:not_1')).toBe(true);

    const next = nextExecution(ctx.__mocks);
    const e = next.Store.ledgerGet('granola:not_1');
    expect(e).toEqual({
      key: 'granola:not_1', source: 'granola', processedAt: NOW.toISOString(), outcome: 'tasks',
      taskIds: ['123', '456'], queueIds: [], note: 'ok'
    });
  });

  test('numeric-looking task ids survive Sheets auto-typing as strings', () => {
    const ctx = load();
    ctx.Store.ledgerPut({ key: 'k', outcome: 'tasks', taskIds: ['8923232'] });
    const next = nextExecution(ctx.__mocks);
    expect(next.Store.ledgerGet('k').taskIds).toEqual(['8923232']);
  });

  test('error outcomes are not treated as processed (retryable)', () => {
    const ctx = load();
    ctx.Store.ledgerPut({ key: 'granola:bad', outcome: 'error', note: 'boom' });
    expect(ctx.Store.ledgerHas('granola:bad')).toBe(false);
    expect(ctx.Store.ledgerGet('granola:bad').outcome).toBe('error');
  });

  test('ledgerPut upserts in place', () => {
    const ctx = load();
    ctx.Store.ledgerPut({ key: 'k1', outcome: 'error' });
    ctx.Store.ledgerPut({ key: 'k2', outcome: 'nothing' });
    ctx.Store.ledgerPut({ key: 'k1', outcome: 'queued', queueIds: ['q_1'] });
    const rows = tabValues(ctx, 'ledger');
    expect(rows).toHaveLength(3);
    expect(ctx.Store.ledgerGet('k1').outcome).toBe('queued');
    expect(nextExecution(ctx.__mocks).Store.ledgerGet('k1').queueIds).toEqual(['q_1']);
  });

  test('ledgerPutMany batches appends into one setValues and dedupes within batch', () => {
    const ctx = load();
    ctx.Store.ledgerHas('warm'); // create tab
    const sheet = ctx.Store.sheet().getSheetByName('ledger');
    sheet.getRange.mockClear();
    ctx.Store.ledgerPutMany([
      { key: 'granola:a', outcome: 'tasks' },
      { key: 'fireflies:b', outcome: 'tasks' },
      { key: 'granola:a', outcome: 'queued' }
    ]);
    expect(sheet.getRange).toHaveBeenCalledTimes(1);
    expect(ctx.Store.ledgerGet('granola:a').outcome).toBe('queued');
    expect(ctx.Store.ledgerGet('fireflies:b').source).toBe('fireflies');
    expect(() => ctx.Store.ledgerPut({ outcome: 'x' })).toThrow(/key required/);
  });

  test('reads the tab with one getValues per execution', () => {
    const ctx = load();
    ctx.Store.ledgerPutMany([{ key: 'a', outcome: 'tasks' }, { key: 'b', outcome: 'tasks' }]);
    const next = nextExecution(ctx.__mocks);
    const sheet = next.Store.sheet().getSheetByName('ledger');
    sheet.getRange.mockClear();
    for (let i = 0; i < 20; i++) next.Store.ledgerHas('a');
    expect(sheet.getRange).toHaveBeenCalledTimes(1);
  });
});

describe('queue', () => {
  const item = (id, extra) => Object.assign({
    id, source: 'meeting', sourceKey: 'granola:not_1', origin: 'Granola · Sync · Thu 24 Sep',
    link: 'https://notes.granola.ai/d/1', title: 'Send deck', kind: 'todo', project: 'GR', confidence: 'med'
  }, extra || {});

  test('queueId is stable and title-normalised', () => {
    const ctx = load();
    const a = ctx.Store.queueId('meeting', 'granola:not_1', 'Send the deck!');
    const b = ctx.Store.queueId('meeting', 'granola:not_1', 'send the  deck');
    expect(a).toBe(b);
    expect(a).toMatch(/^q_[0-9a-f]{16}$/);
    expect(ctx.Store.queueId('meeting', 'granola:not_2', 'Send the deck')).not.toBe(a);
  });

  test('queueAdd fills defaults, skips existing ids, returns added', () => {
    const ctx = load();
    const added = ctx.Store.queueAdd([item('q_1'), item('q_2'), item('q_1')]);
    expect(added.map(x => x.id)).toEqual(['q_1', 'q_2']);
    expect(added[0]).toMatchObject({ status: 'pending', createdAt: NOW.toISOString(), chips: [], dupTaskId: null, notDuplicate: false });
    expect(ctx.Store.queueAdd([item('q_2'), item('q_3')]).map(x => x.id)).toEqual(['q_3']);
    expect(() => ctx.Store.queueAdd([{ title: 'x' }])).toThrow(/id required/);
  });

  test('indexed columns and JSON persisted; list/get/count across executions', () => {
    const ctx = load();
    ctx.Store.queueAdd([item('q_1'), item('q_2', { source: 'email', project: 'ISC' })]);
    const rows = tabValues(ctx, 'queue');
    expect(rows[0]).toEqual(['id', 'status', 'createdAt', 'source', 'project', 'json']);
    expect(rows[1].slice(0, 5)).toEqual(['q_1', 'pending', NOW.toISOString(), 'meeting', 'GR']);

    const next = nextExecution(ctx.__mocks);
    expect(next.Store.queueList({ status: 'pending' })).toHaveLength(2);
    expect(next.Store.queueList({ source: 'email' }).map(x => x.id)).toEqual(['q_2']);
    expect(next.Store.queueList({ project: 'GR' }).map(x => x.id)).toEqual(['q_1']);
    expect(next.Store.queueList().length).toBe(2);
    expect(next.Store.queueGet('q_1').origin).toBe('Granola · Sync · Thu 24 Sep');
    expect(next.Store.queueGet('nope')).toBeNull();
    expect(next.Store.queueCount()).toBe(2);
  });

  test('queueUpdate merges patch, updates status column, persists', () => {
    const ctx = load();
    ctx.Store.queueAdd([item('q_1'), item('q_2')]);
    const upd = ctx.Store.queueUpdate('q_1', { status: 'accepted', resultTaskId: '999', resolvedAt: NOW.toISOString() });
    expect(upd).toMatchObject({ id: 'q_1', status: 'accepted', resultTaskId: '999', title: 'Send deck' });
    const next = nextExecution(ctx.__mocks);
    expect(next.Store.queueList({ status: 'pending' }).map(x => x.id)).toEqual(['q_2']);
    expect(next.Store.queueGet('q_1').resultTaskId).toBe('999');
    expect(next.Store.queueCount('accepted')).toBe(1);
    expect(() => next.Store.queueUpdate('missing', {})).toThrow(/not found/);
  });

  test('titles that look like formulas are stored as text', () => {
    const ctx = load();
    ctx.Store.queueAdd([item('q_f', { project: '=HYPERLINK("x")' })]);
    const next = nextExecution(ctx.__mocks);
    expect(next.Store.queueGet('q_f').project).toBe('=HYPERLINK("x")');
    expect(tabValues(next, 'queue')[1][4]).toBe('=HYPERLINK("x")');
  });
});

describe('feedback', () => {
  test('feedbackAdd / feedbackRecent newest-first with type filter and limit', () => {
    const ctx = load();
    ctx.Store.feedbackAdd({ type: 'dismissed', queueId: 'q_1', sourceKey: 'granola:1', title: 'A', detail: { reason: 'fyi' } });
    ctx.Store.feedbackAdd({ type: 'not_duplicate', queueId: 'q_2', title: 'B', detail: { taskId: '5' } });
    ctx.Store.feedbackAdd({ type: 'dismissed', queueId: 'q_3', title: 'C' });
    const next = nextExecution(ctx.__mocks);
    expect(next.Store.feedbackRecent().map(f => f.title)).toEqual(['C', 'B', 'A']);
    expect(next.Store.feedbackRecent(1).map(f => f.title)).toEqual(['C']);
    const dis = next.Store.feedbackRecent(20, 'dismissed');
    expect(dis.map(f => f.title)).toEqual(['C', 'A']);
    expect(dis[1].detail).toEqual({ reason: 'fyi' });
    expect(dis[0].detail).toBeNull();
    expect(next.Store.feedbackRecent(5, 'not_duplicate')[0].detail).toEqual({ taskId: '5' });
  });
});

describe('runs', () => {
  test('runLog appends and runsRecent parses numbers', () => {
    const ctx = load();
    ctx.Store.runLog({ job: 'runMeetings', durationMs: 1234, seen: 3, created: 1, queued: 2, skipped: 0, errors: 0, note: 'ok' });
    ctx.Store.runLog({ job: 'runSlack', durationMs: 10 });
    const next = nextExecution(ctx.__mocks);
    const runs = next.Store.runsRecent(10);
    expect(runs.map(r => r.job)).toEqual(['runSlack', 'runMeetings']);
    expect(next.Store.runsRecent(10, 'runMeetings')[0]).toEqual({
      at: NOW.toISOString(), job: 'runMeetings', durationMs: 1234, seen: 3, created: 1, queued: 2, skipped: 0, errors: 0, note: 'ok'
    });
  });
});

describe('kv', () => {
  test('kvGet default, kvSet upsert of JSON values, persisted', () => {
    const ctx = load();
    expect(ctx.Store.kvGet('granola.updatedAfter', 'd')).toBe('d');
    expect(ctx.Store.kvGet('missing')).toBeNull();
    ctx.Store.kvSet('granola.updatedAfter', '2026-09-24T10:00:00Z');
    ctx.Store.kvSet('backfill.cursor', { page: 2, ids: ['a'] });
    ctx.Store.kvSet('count', 5);
    ctx.Store.kvSet('granola.updatedAfter', '2026-09-25T10:00:00Z');
    const next = nextExecution(ctx.__mocks);
    expect(next.Store.kvGet('granola.updatedAfter')).toBe('2026-09-25T10:00:00Z');
    expect(next.Store.kvGet('backfill.cursor')).toEqual({ page: 2, ids: ['a'] });
    expect(next.Store.kvGet('count')).toBe(5);
    expect(tabValues(next, 'kv')).toHaveLength(4);
  });

  test('reset() drops caches', () => {
    const ctx = load();
    ctx.Store.kvSet('a', 1);
    ctx.Store.reset();
    expect(ctx.Store.kvGet('a')).toBe(1);
  });
});
