const { loadGas } = require('./helpers/gas');
const { createMocks } = require('./helpers/mocks');

const FILES = ['Config.js', 'Util.js', 'Store.js', 'Meetings.js'];
const NOW = new Date('2026-09-25T18:00:00Z');
const PROPS = {
  TODOIST_API_TOKEN: 't', ANTHROPIC_API_KEY: 'k', CLAUDE_MODEL: 'claude-test', GRANOLA_API_KEY: 'grn'
};
const CATALOGUE = {
  GR: ['Reach Out', 'Team Logistics', 'Team Updates', 'Conferences', 'KubeCon / Armada / CNCF Batch', 'Arctos', 'Tech Projects', 'Blogs', 'Hiring', 'EA'],
  ISC: ['Reach Out', 'Logistics', 'Marketing', 'Quantum', 'Research', 'ISC Events', 'EA'],
  Me: ['Immediate', 'Logistics', 'Outreach', 'Tech', 'Cars', 'To Buy'],
  SG: []
};

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

// ------------------------------------------------------------------ fixtures

const syncList = () => ({ id: 'not_sync0924', title: 'Secure Copy/Paste Internal Sync', created_at: '2026-09-24T16:01:12Z', updated_at: '2026-09-24T16:48:03Z' });
const newList = () => ({ id: 'not_new0924', title: 'New note', created_at: '2026-09-24T19:10:00Z', updated_at: '2026-09-24T19:40:00Z' });

const syncMeeting = () => ({
  key: 'granola:not_sync0924', source: 'granola', sourceId: 'not_sync0924',
  title: 'Secure Copy/Paste Internal Sync',
  start: new Date('2026-09-24T16:00:00Z'), end: new Date('2026-09-24T16:45:00Z'),
  url: 'https://notes.granola.ai/d/not_sync0924',
  attendees: [
    { name: 'Alex Scammon', email: 'alex@gr-oss.io' },
    { name: 'Miro Knejp', email: 'miro@gr-oss.io' },
    { name: 'Mihailo Marinkovic', email: 'mihailo.marinkovic@gr-oss.io' }
  ],
  organizerEmail: 'alex@gr-oss.io',
  calendarEventId: '5q1h8v0c2k9d3e7f_20260924T160000Z',
  summaryMarkdown: '### Next steps\n- Alex to send the C++ design doc to Miro',
  actionItemsText: null,
  transcript: [{ speaker: 'me', name: null, text: 'I will send the design doc to Miro by Friday.', t: 120 }],
  alsoRecordedBy: [],
  updatedAt: new Date('2026-09-24T16:48:03Z')
});

const newMeeting = () => ({
  key: 'granola:not_new0924', source: 'granola', sourceId: 'not_new0924', title: 'New note',
  start: new Date('2026-09-24T19:10:00Z'), end: null, url: 'https://notes.granola.ai/d/not_new0924',
  attendees: [], organizerEmail: null, calendarEventId: null,
  summaryMarkdown: '- Buy new tyres for the Tacoma', actionItemsText: null,
  transcript: [{ speaker: 'me', name: null, text: 'I need to buy tyres.', t: 5 }],
  alsoRecordedBy: [], updatedAt: new Date('2026-09-24T19:40:00Z')
});

const ffSync = () => ({
  key: 'fireflies:01FFSYNC', source: 'fireflies', sourceId: '01FFSYNC', title: 'Secure Copy/Paste Internal Sync',
  start: new Date('2026-09-24T16:01:00Z'), end: new Date('2026-09-24T16:44:00Z'),
  url: 'https://app.fireflies.ai/view/01FFSYNC',
  attendees: [{ name: 'Miro Knejp', email: 'miro@gr-oss.io' }], organizerEmail: 'alex@gr-oss.io',
  calendarEventId: null, summaryMarkdown: 'Overview', actionItemsText: '**Alex Blundell**\nSend the invoice to AWS',
  transcript: [{ speaker: 'them', name: 'Alex Blundell', text: 'I will send the invoice.', t: 42 }],
  alsoRecordedBy: [], updatedAt: null
});

const item = over => Object.assign({
  title: 'Send the C++ design doc to Miro', kind: 'todo', owner: 'me', ownerName: null, ownerEmail: null,
  quote: 'I will send the design doc to Miro by Friday.', why: 'Alex committed to it.', due: '2026-09-26',
  resurface: null, confidence: 'high', project: 'GR', section: 'Tech Projects', timestampSec: 120
}, over || {});

// ------------------------------------------------------------------ fakes

function makeState() {
  return {
    notes: [syncList(), newList()],
    meetings: { not_sync0924: syncMeeting(), not_new0924: newMeeting() },
    ff: [],
    cal: { 'granola:not_sync0924': { calendarEmail: 'alex@gr-oss.io', project: 'GR', eventTitle: 'Secure Copy/Paste Internal Sync', attendeeEmails: [] } },
    items: {
      'granola:not_sync0924': [item()],
      'granola:not_new0924': [item({ title: 'Buy new tyres for the Tacoma', confidence: 'high', project: 'Me', section: 'Cars', due: null, quote: 'I need to buy tyres.' })]
    },
    open: [],
    failCreate: () => false,
    tasks: []
  };
}

function makeFakes(state) {
  const sameMeeting = (a, b) => Math.abs(new Date(a.start) - new Date(b.start)) <= 10 * 60000 && norm(a.title) === norm(b.title);
  const Granola = {
    listNotes: jest.fn(() => state.notes.map(n => Object.assign({}, n))),
    getNote: jest.fn(id => {
      if (state.getError && state.getError[id]) throw state.getError[id];
      const m = state.meetings[id];
      return m ? Object.assign({}, m) : null;
    })
  };
  const Fireflies = {
    listSince: jest.fn((from, o) => state.ff.filter(m => !(o && o.skipIds && o.skipIds(m.sourceId))).map(m => Object.assign({}, m)))
  };
  const CalendarLookup = {
    find: jest.fn(m => {
      if (state.calThrows) throw new Error('calendar boom');
      return state.cal[m.key] || null;
    })
  };
  const Route = {
    project: jest.fn((m, hit) => {
      if (hit) return { project: hit.project, confidence: 'high', reason: 'calendar ' + hit.calendarEmail };
      return { project: null, confidence: 'low', reason: 'no calendar event; route by content' };
    }),
    meetingEmails: jest.fn(() => []),
    sectionHint: jest.fn(() => null),
    sectionCatalogue: jest.fn(() => CATALOGUE),
    finalize: jest.fn((route, it) => {
      const strong = route.project && route.confidence !== 'low';
      const project = strong ? route.project : (it.project || route.project || null);
      const section = project && (CATALOGUE[project] || []).indexOf(it.section) >= 0 ? it.section : null;
      return { project, section, routeConfidence: strong ? route.confidence : 'low' };
    })
  };
  const Dedupe = {
    mergeMeetings: jest.fn(list => {
      const sorted = list.slice().sort((a, b) => (a.source === 'granola' ? 0 : 1) - (b.source === 'granola' ? 0 : 1));
      const groups = [];
      sorted.forEach(m => {
        const g = groups.find(x => x[0].source !== m.source && sameMeeting(x[0], m));
        if (g) g.push(m); else groups.push([m]);
      });
      return groups.map(g => {
        const p = Object.assign({}, g[0]);
        p.alsoRecordedBy = g.slice(1).map(x => ({ source: x.source, sourceId: x.sourceId, url: x.url }));
        p.mergedKeys = g.map(x => x.key);
        g.slice(1).forEach(x => {
          if (!p.transcript && x.transcript) { p.transcript = x.transcript; p.transcriptFrom = x.source; }
        });
        return p;
      }).sort((a, b) => new Date(a.start) - new Date(b.start));
    }),
    sameMeeting: jest.fn(sameMeeting),
    matchTask: jest.fn((it, tasks, feedback) => {
      const blocked = (feedback || []).filter(f => f.type === 'not_duplicate' && norm(f.title) === norm(it.title))
        .map(f => String(f.detail && f.detail.taskId));
      const t = (tasks || []).find(x => norm(x.content) === norm(it.title) && blocked.indexOf(String(x.id)) < 0);
      return t ? { taskId: String(t.id), title: t.content, score: 1 } : null;
    })
  };
  const Extract = {
    meeting: jest.fn((m) => {
      if (state.onExtract) state.onExtract(m);
      const v = state.items[m.key];
      if (v instanceof Error) throw v;
      return (v || []).map(x => Object.assign({}, x));
    })
  };
  const Todoist = {
    createTask: jest.fn(t => {
      if (state.failCreate(t)) throw new Error('Todoist 500');
      const task = { id: String(9000 + state.tasks.length), content: t.content };
      state.tasks.push(task);
      state.open.push(task);
      return task;
    }),
    openTasks: jest.fn(() => state.open),
    withMachineLine: jest.fn((d, obj) => (d ? d + '\n' : '') + '<!-- ta:' + JSON.stringify(obj) + ' -->')
  };
  return { Granola, Fireflies, CalendarLookup, Route, Dedupe, Extract, Todoist };
}

function setup(opts) {
  const o = opts || {};
  const state = o.state || makeState();
  const mocks = o.mocks || createMocks({ props: Object.assign({}, PROPS, o.props || {}) });
  const fakes = makeFakes(state);
  const ctx = loadGas(FILES, { mocks, globals: fakes });
  let clock = (o.now || NOW).getTime();
  ctx.Util.now = () => new Date(clock);
  ctx.advance = ms => { clock += ms; };
  ctx.state = state;
  ctx.fakes = fakes;
  return ctx;
}

/** A fresh execution over the same mocks + state (the next trigger run). */
function next(prev, opts) {
  return setup(Object.assign({ state: prev.state, mocks: prev.__mocks }, opts || {}));
}

const ledger = (ctx, key) => ctx.Store.ledgerGet(key);
const runs = ctx => ctx.Store.runsRecent(10);

// ------------------------------------------------------------------ tests

describe('entrypoints', () => {
  test('runMeetings and runBackfill are top-level functions', () => {
    const ctx = setup();
    expect(typeof ctx.runMeetings).toBe('function');
    expect(typeof ctx.runBackfill).toBe('function');
  });

  test('skips when another run holds the lock', () => {
    const ctx = setup();
    ctx.__mocks.LockService.__available = false;
    expect(ctx.runMeetings()).toBeNull();
    expect(ctx.fakes.Granola.listNotes).not.toHaveBeenCalled();
  });
});

describe('runMeetings — decisions', () => {
  test('high item on a calendar-routed meeting becomes a task with the description format', () => {
    const ctx = setup();
    ctx.state.notes = [syncList()];
    const res = ctx.runMeetings();
    expect(res.created).toBe(1);
    expect(res.queued).toBe(0);
    const call = ctx.fakes.Todoist.createTask.mock.calls[0][0];
    expect(call).toMatchObject({
      content: 'Send the C++ design doc to Miro', projectName: 'GR', sectionName: 'Tech Projects',
      labels: ['meeting'], dueDate: '2026-09-26'
    });
    const qid = ctx.Store.queueId('meeting', 'granola:not_sync0924', 'Send the C++ design doc to Miro');
    expect(call.description).toBe([
      'Meeting: Secure Copy/Paste Internal Sync · Thu 24 Sep',
      '[Open in Granola](https://notes.granola.ai/d/not_sync0924)',
      'Attendees: Miro Knejp, Mihailo Marinkovic',
      '> I will send the design doc to Miro by Friday.',
      '<!-- ta:{"key":"granola:not_sync0924","q":"' + qid + '"} -->'
    ].join('\n'));
    const l = ledger(ctx, 'granola:not_sync0924');
    expect(l.outcome).toBe('tasks');
    expect(l.taskIds).toEqual(['9000']);
    expect(ctx.Store.queueCount()).toBe(0);
    const r = runs(ctx)[0];
    expect(r).toMatchObject({ job: 'meetings', seen: 1, created: 1, queued: 0, errors: 0 });
  });

  test('note without a calendar event routes by content with low route confidence -> queued', () => {
    const ctx = setup();
    ctx.state.notes = [newList()];
    ctx.runMeetings();
    expect(ctx.fakes.Todoist.createTask).not.toHaveBeenCalled();
    const q = ctx.Store.queueList({ status: 'pending' });
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({
      source: 'meeting', sourceKey: 'granola:not_new0924', title: 'Buy new tyres for the Tacoma',
      project: 'Me', section: 'Cars', routeConfidence: 'low', confidence: 'high', kind: 'todo',
      origin: 'Granola · New note · Thu 24 Sep', link: 'https://notes.granola.ai/d/not_new0924',
      dupTaskId: null, labels: ['meeting']
    });
    expect(q[0].id).toBe(ctx.Store.queueId('meeting', 'granola:not_new0924', 'Buy new tyres for the Tacoma'));
    expect(q[0].description).toMatch(/^Meeting: New note · Thu 24 Sep\n/);
    expect(ledger(ctx, 'granola:not_new0924')).toMatchObject({ outcome: 'queued', queueIds: [q[0].id] });
  });

  test('med / low confidence todos, waiting items and duplicates are queued, not created', () => {
    const ctx = setup();
    ctx.state.notes = [syncList()];
    ctx.state.open = [{ id: '555', content: 'Review the OmniSSA SDK notes' }];
    ctx.state.items['granola:not_sync0924'] = [
      item({ title: 'Book the design review', confidence: 'med' }),
      item({ title: 'Write the clipboard threat model', confidence: 'low' }),
      item({ title: 'Share the OmniSSA SDK build notes', kind: 'waiting', owner: 'other', ownerName: 'Mihailo Marinkovic', ownerEmail: 'mihailo.marinkovic@gr-oss.io', resurface: '2026-10-01' }),
      item({ title: 'Review the OmniSSA SDK notes' }),
      item({ title: 'Send the invoice to AWS', kind: 'waiting', owner: 'other', ownerName: 'Alex Blundell', ownerEmail: null })
    ];
    const res = ctx.runMeetings();
    expect(ctx.fakes.Todoist.createTask).not.toHaveBeenCalled();
    expect(res.queued).toBe(5);
    const byTitle = {};
    ctx.Store.queueList().forEach(q => { byTitle[q.title] = q; });
    expect(byTitle['Book the design review'].chips).toEqual([]);
    expect(byTitle['Write the clipboard threat model'].chips).toEqual(['Low confidence']);
    expect(byTitle['Share the OmniSSA SDK build notes']).toMatchObject({
      kind: 'waiting', waitOn: 'Mihailo Marinkovic', waitOnEmail: 'mihailo.marinkovic@gr-oss.io', resurface: '2026-10-01'
    });
    expect(byTitle['Review the OmniSSA SDK notes']).toMatchObject({ dupTaskId: '555', dupTaskTitle: 'Review the OmniSSA SDK notes' });
    expect(byTitle['Send the invoice to AWS']).toMatchObject({ kind: 'waiting', waitOn: 'Alex Blundell' });
    expect(byTitle['Book the design review'].waitOn).toBeNull();
    expect(ledger(ctx, 'granola:not_sync0924').queueIds).toHaveLength(5);
  });

  test('DIRECT_CONFIDENCE=med lets med items through; route confidence must still be high', () => {
    const ctx = setup({ props: { DIRECT_CONFIDENCE: 'med' } });
    ctx.state.items['granola:not_sync0924'] = [item({ confidence: 'med' })];
    ctx.state.items['granola:not_new0924'] = [item({ title: 'Buy tyres', confidence: 'high', project: 'Me' })];
    const res = ctx.runMeetings();
    expect(res.created).toBe(1);
    expect(res.queued).toBe(1);
    expect(ctx.fakes.Todoist.createTask.mock.calls[0][0].content).toBe('Send the C++ design doc to Miro');
  });

  test('not_duplicate feedback is passed to the matcher and suppresses the match', () => {
    const ctx = setup();
    ctx.state.notes = [syncList()];
    ctx.state.open = [{ id: '777', content: 'Send the C++ design doc to Miro' }];
    ctx.Store.feedbackAdd({ type: 'not_duplicate', title: 'Send the C++ design doc to Miro', detail: { taskId: '777' } });
    ctx.Store.feedbackAdd({ type: 'dismissed', title: 'Order pizza' });
    const res = ctx.runMeetings();
    expect(res.created).toBe(1);
    const fb = ctx.fakes.Dedupe.matchTask.mock.calls[0][2];
    expect(fb.every(f => f.type === 'not_duplicate')).toBe(true);
    const exOpts = ctx.fakes.Extract.meeting.mock.calls[0][1];
    expect(exOpts.feedback.map(f => f.title)).toEqual(['Order pizza']);
    expect(exOpts.sectionsByProject).toBe(CATALOGUE);
    expect(exOpts.routeHint).toMatchObject({ project: 'GR', confidence: 'high' });
    expect(exOpts.today).toBe('2026-09-25');
  });

  test('a duplicate of a task created earlier in the same run is queued with dupTaskId', () => {
    const ctx = setup();
    ctx.state.items['granola:not_new0924'] = [item({ project: 'GR' })]; // same title as the sync item
    ctx.runMeetings();
    expect(ctx.fakes.Todoist.createTask).toHaveBeenCalledTimes(1);
    const q = ctx.Store.queueList();
    expect(q).toHaveLength(1);
    expect(q[0].dupTaskId).toBe('9000');
  });

  test('meeting with no items is ledgered as nothing', () => {
    const ctx = setup();
    ctx.state.items = {};
    const res = ctx.runMeetings();
    expect(ledger(ctx, 'granola:not_sync0924').outcome).toBe('nothing');
    expect(ledger(ctx, 'granola:not_new0924').outcome).toBe('nothing');
    expect(res.processed).toBe(2);
    expect(ctx.fakes.Todoist.openTasks).not.toHaveBeenCalled();
  });

  test('calendar lookup failure is tolerated (route without a hit)', () => {
    const ctx = setup();
    ctx.state.calThrows = true;
    ctx.state.notes = [syncList()];
    const res = ctx.runMeetings();
    expect(res.errors).toBe(0);
    expect(res.queued).toBe(1);
    expect(ctx.fakes.Route.project).toHaveBeenCalledWith(expect.objectContaining({ key: 'granola:not_sync0924' }), null);
  });
});

describe('runMeetings — ledger and cursor', () => {
  test('first run lists from now − 2 days; cursor advances to max updated_at', () => {
    const ctx = setup();
    ctx.runMeetings();
    const opts = ctx.fakes.Granola.listNotes.mock.calls[0][0];
    expect(opts.updatedAfter).toBe('2026-09-23T18:00:00.000Z');
    expect(ctx.fakes.Granola.getNote).toHaveBeenCalledWith('not_sync0924', { transcript: true });
    expect(ctx.Store.kvGet('granola.updatedAfter')).toBe('2026-09-24T19:40:00.000Z');
  });

  test('ledger prevents reprocessing on the next run; saved cursor is used', () => {
    const first = setup();
    first.runMeetings();
    const ctx = next(first);
    const res = ctx.runMeetings();
    expect(ctx.fakes.Granola.listNotes.mock.calls[0][0].updatedAfter).toBe('2026-09-24T19:40:00.000Z');
    expect(ctx.fakes.Granola.getNote).not.toHaveBeenCalled();
    expect(ctx.fakes.Extract.meeting).not.toHaveBeenCalled();
    expect(res).toMatchObject({ seen: 2, skipped: 2, created: 0, queued: 0 });
    expect(first.state.tasks).toHaveLength(1);
  });

  test('one failing meeting does not abort the run and blocks the cursor past it', () => {
    const ctx = setup();
    const third = { id: 'not_later', title: 'Later', updated_at: '2026-09-25T10:00:00Z' };
    ctx.state.notes = [syncList(), newList(), third];
    ctx.state.meetings.not_later = Object.assign(newMeeting(), { key: 'granola:not_later', sourceId: 'not_later', title: 'Later', start: new Date('2026-09-25T09:00:00Z') });
    ctx.state.items['granola:not_new0924'] = new Error('Claude 529 overloaded');
    ctx.state.items['granola:not_later'] = [item({ title: 'Email Jon the deck', project: 'GR' })];
    const res = ctx.runMeetings();
    expect(res.errors).toBe(1);
    expect(res.processed).toBe(2);
    expect(ledger(ctx, 'granola:not_new0924')).toMatchObject({ outcome: 'error' });
    expect(ledger(ctx, 'granola:not_new0924').note).toMatch(/^attempt 1: Claude 529/);
    expect(ledger(ctx, 'granola:not_later').outcome).toBe('queued');
    // Cursor stops at the last note before the failed one.
    expect(ctx.Store.kvGet('granola.updatedAfter')).toBe('2026-09-24T16:48:03.000Z');
    expect(runs(ctx)[0].note).toMatch(/granola:not_new0924 failed/);
  });

  test('errored note is retried, and given up after MAX_ATTEMPTS so the cursor moves on', () => {
    let ctx = setup();
    ctx.state.notes = [newList()];
    ctx.state.items['granola:not_new0924'] = new Error('bad JSON');
    ctx.runMeetings();
    expect(ctx.Store.kvGet('granola.updatedAfter')).toBeNull();
    ctx = next(ctx);
    ctx.runMeetings();
    expect(ctx.fakes.Extract.meeting).toHaveBeenCalledTimes(1);
    expect(ledger(ctx, 'granola:not_new0924').note).toMatch(/^attempt 2:/);
    expect(ctx.Store.kvGet('granola.updatedAfter')).toBeNull();
    ctx = next(ctx);
    ctx.runMeetings();
    expect(ledger(ctx, 'granola:not_new0924').note).toMatch(/^attempt 3:/);
    expect(ctx.Store.kvGet('granola.updatedAfter')).toBe('2026-09-24T19:40:00.000Z');
    ctx = next(ctx);
    const res = ctx.runMeetings();
    expect(ctx.fakes.Granola.getNote).not.toHaveBeenCalled();
    expect(res.skipped).toBe(1);
  });

  test('getNote failure is isolated per note', () => {
    const ctx = setup();
    const err = new Error('HTTP 500'); err.name = 'HttpError'; err.status = 500;
    ctx.state.getError = { not_sync0924: err };
    const res = ctx.runMeetings();
    expect(res.errors).toBe(1);
    expect(ledger(ctx, 'granola:not_sync0924').note).toMatch(/HttpError: HTTP 500 \(HTTP 500\)/);
    expect(ledger(ctx, 'granola:not_new0924').outcome).toBe('queued');
    expect(ctx.Store.kvGet('granola.updatedAfter')).toBeNull();
  });

  test('deadline stop saves progress: processed notes ledgered, cursor at the last done one', () => {
    const ctx = setup();
    ctx.state.onExtract = () => ctx.advance(240000); // each LLM call eats most of the budget
    const res = ctx.runMeetings();
    expect(ctx.fakes.Extract.meeting).toHaveBeenCalledTimes(1);
    expect(res.stoppedEarly).toBe(true);
    expect(ledger(ctx, 'granola:not_sync0924').outcome).toBe('tasks');
    expect(ledger(ctx, 'granola:not_new0924')).toBeNull();
    expect(ctx.Store.kvGet('granola.updatedAfter')).toBe('2026-09-24T16:48:03.000Z');
    expect(runs(ctx)[0].note).toMatch(/stopped at deadline/);
    // Next run picks up the rest.
    const again = next(ctx);
    again.runMeetings();
    expect(again.fakes.Extract.meeting).toHaveBeenCalledTimes(1);
    expect(ledger(again, 'granola:not_new0924').outcome).toBe('queued');
    expect(again.Store.kvGet('granola.updatedAfter')).toBe('2026-09-24T19:40:00.000Z');
  });

  test('listing cut short by the deadline does not move the cursor', () => {
    const ctx = setup();
    ctx.fakes.Granola.listNotes.mockImplementation(() => { ctx.advance(280000); return [syncList()]; });
    ctx.Store.kvSet('granola.updatedAfter', '2026-09-20T00:00:00.000Z');
    const res = ctx.runMeetings();
    expect(res.stoppedEarly).toBe(true);
    expect(ctx.fakes.Granola.getNote).not.toHaveBeenCalled();
    expect(ctx.Store.kvGet('granola.updatedAfter')).toBe('2026-09-20T00:00:00.000Z');
  });

  test('task creation failure for one item queues it instead and continues', () => {
    const ctx = setup();
    ctx.state.notes = [syncList()];
    ctx.state.items['granola:not_sync0924'] = [item({ title: 'Send the deck to Jon' }), item({ title: 'Book the Zurich room' })];
    ctx.state.failCreate = t => t.content === 'Send the deck to Jon';
    const res = ctx.runMeetings();
    expect(res).toMatchObject({ created: 1, queued: 1, errors: 1 });
    const q = ctx.Store.queueList();
    expect(q[0]).toMatchObject({ title: 'Send the deck to Jon', chips: ['Create failed'] });
    expect(ledger(ctx, 'granola:not_sync0924')).toMatchObject({ outcome: 'tasks', taskIds: ['9000'], queueIds: [q[0].id] });
    expect(ledger(ctx, 'granola:not_sync0924').note).toMatch(/1 create error/);
  });

  test('queue writes are idempotent across a reprocess (same ids)', () => {
    const ctx = setup();
    ctx.state.notes = [newList()];
    ctx.runMeetings();
    ctx.Store.ledgerPut({ key: 'granola:not_new0924', outcome: 'error', note: 'attempt 1: forced' });
    const again = next(ctx);
    const res = again.runMeetings();
    expect(again.fakes.Extract.meeting).toHaveBeenCalledTimes(1);
    expect(res.queued).toBe(0);
    expect(again.Store.queueList()).toHaveLength(1);
    expect(ledger(again, 'granola:not_new0924').outcome).toBe('queued');
  });
});

describe('runMeetings — Fireflies', () => {
  test('not called without FIREFLIES_API_KEY', () => {
    const ctx = setup();
    ctx.runMeetings();
    expect(ctx.fakes.Fireflies.listSince).not.toHaveBeenCalled();
  });

  test('same meeting from both sources is processed once; both keys ledgered; both links', () => {
    const ctx = setup({ props: { FIREFLIES_API_KEY: 'ff' } });
    ctx.state.notes = [syncList()];
    ctx.state.ff = [ffSync()];
    const res = ctx.runMeetings();
    expect(ctx.fakes.Extract.meeting).toHaveBeenCalledTimes(1);
    const m = ctx.fakes.Extract.meeting.mock.calls[0][0];
    expect(m.key).toBe('granola:not_sync0924');
    expect(m.alsoRecordedBy).toEqual([{ source: 'fireflies', sourceId: '01FFSYNC', url: 'https://app.fireflies.ai/view/01FFSYNC' }]);
    expect(res.created).toBe(1);
    expect(ledger(ctx, 'granola:not_sync0924').outcome).toBe('tasks');
    const ff = ledger(ctx, 'fireflies:01FFSYNC');
    expect(ff).toMatchObject({ outcome: 'tasks', taskIds: ['9000'] });
    expect(ff.note).toMatch(/merged into granola:not_sync0924/);
    const desc = ctx.fakes.Todoist.createTask.mock.calls[0][0].description;
    // Granola transcript was used, so no Fireflies ?t= deep link.
    expect(desc.split('\n')[1]).toBe('[Open in Granola](https://notes.granola.ai/d/not_sync0924)  ·  [Fireflies](https://app.fireflies.ai/view/01FFSYNC)');
    expect(ctx.fakes.Fireflies.listSince.mock.calls[0][0]).toBe('2026-09-23T18:00:00.000Z');
    // Ledgered Fireflies ids are skipped next time.
    const again = next(ctx);
    again.runMeetings();
    expect(again.fakes.Extract.meeting).not.toHaveBeenCalled();
  });

  test('Fireflies deep link gets ?t= when the transcript came from Fireflies', () => {
    const ctx = setup({ props: { FIREFLIES_API_KEY: 'ff' } });
    const g = syncMeeting(); g.transcript = null;
    ctx.state.meetings.not_sync0924 = g;
    ctx.state.notes = [syncList()];
    ctx.state.ff = [ffSync()];
    ctx.state.items['granola:not_sync0924'] = [item({ timestampSec: 42, confidence: 'med' })];
    ctx.runMeetings();
    const q = ctx.Store.queueList()[0];
    expect(q.description).toContain('[Fireflies](https://app.fireflies.ai/view/01FFSYNC?t=42)');
    expect(q.link).toBe('https://notes.granola.ai/d/not_sync0924');
    expect(q.timestampSec).toBe(42);
  });

  test('Fireflies-only recording waits for Granola during the grace period, then is processed', () => {
    const ctx = setup({ props: { FIREFLIES_API_KEY: 'ff' }, now: new Date('2026-09-24T17:00:00Z') });
    ctx.state.notes = [];
    ctx.state.ff = [ffSync()];
    ctx.state.items['fireflies:01FFSYNC'] = [item({ title: 'Send the AWS invoice', kind: 'waiting', ownerName: 'Alex Blundell', timestampSec: 42 })];
    const res = ctx.runMeetings();
    expect(res.deferred).toBe(1);
    expect(ctx.fakes.Extract.meeting).not.toHaveBeenCalled();
    expect(ledger(ctx, 'fireflies:01FFSYNC')).toBeNull();

    const later = next(ctx, { now: new Date('2026-09-24T20:00:00Z') });
    later.runMeetings();
    expect(later.fakes.Extract.meeting).toHaveBeenCalledTimes(1);
    const q = later.Store.queueList()[0];
    expect(q).toMatchObject({ origin: 'Fireflies · Secure Copy/Paste Internal Sync · Thu 24 Sep', kind: 'waiting', waitOn: 'Alex Blundell' });
    expect(q.link).toBe('https://app.fireflies.ai/view/01FFSYNC?t=42');
    expect(ledger(later, 'fireflies:01FFSYNC').outcome).toBe('queued');
  });

  test('a late Fireflies twin of an already-processed Granola meeting is ledgered as nothing', () => {
    const ctx = setup({ props: { FIREFLIES_API_KEY: 'ff' } });
    ctx.state.notes = [syncList()];
    ctx.runMeetings();
    ctx.state.ff = [ffSync()];
    const again = next(ctx);
    const res = again.runMeetings();
    expect(again.fakes.Extract.meeting).not.toHaveBeenCalled();
    expect(ledger(again, 'fireflies:01FFSYNC')).toMatchObject({ outcome: 'nothing' });
    expect(ledger(again, 'fireflies:01FFSYNC').note).toMatch(/granola:not_sync0924/);
    expect(res.skipped).toBeGreaterThanOrEqual(1);
  });

  test('Fireflies cursor advances to the latest processed start, lagging 24h behind now', () => {
    const now = new Date('2026-09-28T18:00:00Z');
    const ctx = setup({ props: { FIREFLIES_API_KEY: 'ff' }, now });
    ctx.state.notes = [];
    ctx.state.ff = [Object.assign(ffSync(), { start: new Date('2026-09-27T09:00:00Z') })];
    ctx.runMeetings();
    expect(ctx.fakes.Fireflies.listSince.mock.calls[0][0]).toBe('2026-09-26T18:00:00.000Z');
    expect(ctx.Store.kvGet('fireflies.fromDate')).toBe('2026-09-27T09:00:00.000Z');

    const ctx2 = setup({ props: { FIREFLIES_API_KEY: 'ff' }, now });
    ctx2.state.notes = [];
    ctx2.runMeetings();
    expect(ctx2.Store.kvGet('fireflies.fromDate')).toBe('2026-09-27T18:00:00.000Z');
  });

  test('Fireflies cursor stays at or before a recording still waiting for Granola', () => {
    const now = new Date('2026-09-28T18:00:00Z');
    const ctx = setup({ props: { FIREFLIES_API_KEY: 'ff' }, now });
    ctx.state.notes = [];
    ctx.state.ff = [
      Object.assign(ffSync(), { start: new Date('2026-09-27T09:00:00Z') }),
      Object.assign(ffSync(), { key: 'fireflies:02NEW', sourceId: '02NEW', title: 'Standup', start: new Date('2026-09-28T17:00:00Z') })
    ];
    const res = ctx.runMeetings();
    expect(res.deferred).toBe(1);
    expect(ctx.Store.kvGet('fireflies.fromDate')).toBe('2026-09-27T18:00:00.000Z');
    expect(ledger(ctx, 'fireflies:02NEW')).toBeNull();
  });

  test('Fireflies listing failure is logged; Granola still processed', () => {
    const ctx = setup({ props: { FIREFLIES_API_KEY: 'ff' } });
    ctx.fakes.Fireflies.listSince.mockImplementation(() => { throw new Error('GraphQL down'); });
    const res = ctx.runMeetings();
    expect(res.errors).toBe(1);
    expect(res.processed).toBe(2);
    expect(ctx.Store.kvGet('fireflies.fromDate')).toBeNull();
    expect(runs(ctx)[0].note).toMatch(/fireflies listing failed/);
  });
});

describe('runBackfill', () => {
  test('queues everything with chip Backfill over BACKFILL_DAYS; incremental cursor untouched', () => {
    const ctx = setup({ props: { BACKFILL_DAYS: '14' } });
    const res = ctx.runBackfill();
    expect(ctx.fakes.Granola.listNotes.mock.calls[0][0].createdAfter).toBe('2026-09-11T18:00:00.000Z');
    expect(ctx.fakes.Todoist.createTask).not.toHaveBeenCalled();
    expect(res).toMatchObject({ job: 'backfill', queued: 2, created: 0, complete: true });
    ctx.Store.queueList().forEach(q => expect(q.chips).toContain('Backfill'));
    expect(ctx.Store.kvGet('granola.updatedAfter')).toBeNull();
    const cur = ctx.Store.kvGet('backfill.cursor');
    expect(cur).toMatchObject({ from: '2026-09-11T18:00:00.000Z', to: NOW.toISOString(), complete: true, runs: 1 });
    expect(ledger(ctx, 'granola:not_sync0924').note).toMatch(/backfill/);
    expect(runs(ctx)[0].job).toBe('backfill');
    expect(ctx.__mocks.ScriptApp.__triggers).toHaveLength(0);
  });

  test('defaults to 28 days', () => {
    const ctx = setup();
    ctx.runBackfill();
    expect(ctx.fakes.Granola.listNotes.mock.calls[0][0].createdAfter).toBe('2026-08-28T18:00:00.000Z');
  });

  test('resumes the same window across executions and schedules a continuation', () => {
    const ctx = setup({ props: { FIREFLIES_API_KEY: 'ff' } });
    ctx.state.onExtract = () => ctx.advance(240000);
    const res = ctx.runBackfill();
    expect(res.complete).toBe(false);
    expect(ctx.Store.kvGet('backfill.cursor')).toMatchObject({ complete: false, runs: 1, from: '2026-08-28T18:00:00.000Z' });
    expect(ctx.fakes.Fireflies.listSince.mock.calls[0][1].toDate).toBe(NOW.toISOString());
    const trig = ctx.__mocks.ScriptApp.__triggers;
    expect(trig).toHaveLength(1);
    expect(trig[0].__config).toMatchObject({ handler: 'runBackfill', after: 60000 });

    const later = next(ctx, { now: new Date('2026-09-25T18:10:00Z') });
    later.state.onExtract = null;
    const res2 = later.runBackfill();
    expect(later.fakes.Granola.listNotes.mock.calls[0][0].createdAfter).toBe('2026-08-28T18:00:00.000Z');
    expect(res2.complete).toBe(true);
    expect(later.fakes.Extract.meeting).toHaveBeenCalledTimes(1);
    expect(later.Store.kvGet('backfill.cursor')).toMatchObject({ complete: true, runs: 2 });
    expect(later.__mocks.ScriptApp.__triggers).toHaveLength(0);
    expect(later.Store.queueList()).toHaveLength(2);
  });

  test('a completed backfill starts a new window next time', () => {
    const ctx = setup();
    ctx.runBackfill();
    const later = next(ctx, { now: new Date('2026-10-01T18:00:00Z') });
    later.runBackfill();
    expect(later.fakes.Granola.listNotes.mock.calls[0][0].createdAfter).toBe('2026-09-03T18:00:00.000Z');
    expect(later.fakes.Extract.meeting).not.toHaveBeenCalled(); // ledger already has both
  });
});

describe('formatting helpers', () => {
  test('description caps attendees at 8, skips Alex, quotes multi-line text', () => {
    const ctx = setup();
    const m = syncMeeting();
    m.attendees = [{ name: 'Alex Scammon', email: 'alex@gr-oss.io' }, { name: null, email: 'alex@insightsoftmax.com' }]
      .concat(Array.from({ length: 10 }, (_, i) => ({ name: 'Person ' + i, email: 'p' + i + '@x.com' })))
      .concat([{ name: null, email: 'noname@x.com' }]);
    const d = ctx.Meetings.description(m, { quote: 'line one\nline two' }, {});
    const lines = d.split('\n');
    expect(lines[2]).toBe('Attendees: Person 0, Person 1, Person 2, Person 3, Person 4, Person 5, Person 6, Person 7 +3 more');
    expect(lines[3]).toBe('> line one');
    expect(lines[4]).toBe('> line two');
    expect(lines[5]).toBe('<!-- ta:{"key":"granola:not_sync0924"} -->');
  });

  test('description omits missing links, attendees and quote', () => {
    const ctx = setup();
    const m = Object.assign(newMeeting(), { url: null });
    expect(ctx.Meetings.description(m, { quote: '' })).toBe('Meeting: New note · Thu 24 Sep\n<!-- ta:{"key":"granola:not_new0924"} -->');
  });

  test('decide_ rules', () => {
    const ctx = setup();
    const fin = { project: 'GR', section: null, routeConfidence: 'high' };
    expect(ctx.Meetings.decide_(item(), fin, null, false)).toBe('direct');
    expect(ctx.Meetings.decide_(item(), fin, null, true)).toBe('backfill');
    expect(ctx.Meetings.decide_(item({ kind: 'waiting' }), fin, null, false)).toBe('waiting');
    expect(ctx.Meetings.decide_(item(), fin, { taskId: '1' }, false)).toBe('duplicate');
    expect(ctx.Meetings.decide_(item(), Object.assign({}, fin, { project: null }), null, false)).toBe('no project');
    expect(ctx.Meetings.decide_(item(), Object.assign({}, fin, { routeConfidence: 'med' }), null, false)).toBe('route med');
    expect(ctx.Meetings.decide_(item({ confidence: 'med' }), fin, null, false)).toBe('confidence med');
  });
});
