const { loadGas } = require('./helpers/gas');
const { createMocks, GuestStatus } = require('./helpers/mocks');

const FILES = ['Config.js', 'Util.js', 'Store.js', 'Checks.js'];
const NOW = new Date('2026-09-25T15:00:00Z'); // Fri 08:00 PDT
const PROPS = { TODOIST_API_TOKEN: 't', ANTHROPIC_API_KEY: 'k', CLAUDE_MODEL: 'claude-test', GRANOLA_API_KEY: 'grn' };
const MACHINE_RE = /<!-- ta:(.*) -->/;

// ------------------------------------------------------------------ fixtures

const zoom = 'Join Zoom Meeting https://us02web.zoom.us/j/123456789';
const guests = (...emails) => [{ email: 'alex@gr-oss.io', status: GuestStatus.YES }].concat(emails.map(e => ({ email: e, status: GuestStatus.YES })));
// Alex's own guest entry with a given status (e.g. declined / not responded).
const guestsAs = (status, ...emails) => [{ email: 'alex@gr-oss.io', status }].concat(emails.map(e => ({ email: e, status: GuestStatus.YES })));

function grEvents() {
  return [
    { // matched by calendar_event_id
      id: 'sync0924@google.com', title: 'Secure Copy/Paste Internal Sync',
      start: '2026-09-24T16:00:00Z', end: '2026-09-24T16:45:00Z', description: zoom,
      guests: guests('miro@gr-oss.io', 'mihailo.marinkovic@gr-oss.io'), myStatus: GuestStatus.OWNER, isOwnedByMe: true
    },
    { // matched by time + title
      id: 'armada0923', title: 'Armada roadmap review', start: '2026-09-23T17:00:00Z', end: '2026-09-23T17:30:00Z',
      location: 'https://meet.google.com/abc-defg-hij', guests: guests('dave@gr-oss.io')
    },
    { // MISSING: no note
      id: 'cncf0922', title: 'CNCF Batch Subproject', start: '2026-09-22T15:00:00Z', end: '2026-09-22T16:00:00Z',
      description: zoom, guests: guests('abhishek@example.com', 'marlow@example.com')
    },
    // not qualifying:
    { id: 'decl', title: 'Declined sync', start: '2026-09-22T18:00:00Z', end: '2026-09-22T18:30:00Z', description: zoom, guests: guestsAs(GuestStatus.NO, 'x@y.com'), myStatus: GuestStatus.NO },
    { id: 'invited', title: 'Not responded', start: '2026-09-22T19:00:00Z', end: '2026-09-22T19:30:00Z', description: zoom, guests: guestsAs(GuestStatus.INVITED, 'x@y.com'), myStatus: GuestStatus.INVITED },
    { id: 'solo', title: 'Focus time', start: '2026-09-21T16:00:00Z', end: '2026-09-21T18:00:00Z', location: 'Home', guests: [], isOwnedByMe: true, myStatus: GuestStatus.OWNER },
    { id: 'short', title: 'Quick check', start: '2026-09-21T19:00:00Z', end: '2026-09-21T19:05:00Z', description: zoom, guests: guests('x@y.com') },
    { id: 'allday', title: 'KubeCon', start: '2026-09-20T00:00:00Z', end: '2026-09-21T00:00:00Z', allDay: true, location: 'Atlanta', guests: guests('x@y.com') },
    { id: 'nolink', title: 'Hallway chat', start: '2026-09-21T20:00:00Z', end: '2026-09-21T20:30:00Z', guests: guests('x@y.com') },
    { id: 'onlyassist', title: 'Booked by Morasha', start: '2026-09-21T21:00:00Z', end: '2026-09-21T21:30:00Z', description: zoom, guests: guests('morasha@insightsoftmax.com', 'room-1@resource.calendar.google.com') },
    { id: 'recent', title: 'Just ended', start: '2026-09-25T14:00:00Z', end: '2026-09-25T14:30:00Z', description: zoom, guests: guests('x@y.com') },
    { id: 'old', title: 'Last month', start: '2026-09-10T16:00:00Z', end: '2026-09-10T17:00:00Z', description: zoom, guests: guests('x@y.com') }
  ];
}

function iscEvents() {
  return [
    { // MISSING: ISC meeting with a physical location
      id: 'aws0924', title: 'AWS partner QBR', start: '2026-09-24T20:00:00Z', end: '2026-09-24T21:00:00Z',
      location: 'AWS Loft, 525 Market St', guests: [{ email: 'alex@insightsoftmax.com', status: 'YES' }, { email: 'jonathan@amazon.com' }]
    },
    { // the same GR meeting also on the ISC calendar -> listed once
      id: 'cncf0922@google.com', title: 'CNCF Batch Subproject', start: '2026-09-22T15:00:00Z', end: '2026-09-22T16:00:00Z',
      description: zoom, guests: guests('abhishek@example.com')
    },
    { // matched by a generic Granola note at the same time (no calendar event on the note)
      id: 'adhoc0923', title: 'Marcus / Alex', start: '2026-09-23T22:00:00Z', end: '2026-09-23T22:30:00Z', description: zoom,
      guests: [{ email: 'marcus@insightsoftmax.com' }]
    }
  ];
}

function notes() {
  return [
    { id: 'not_sync0924', title: 'Sync notes', created_at: '2026-09-24T16:03:00Z', calendar_event: { calendar_event_id: 'sync0924', scheduled_start_time: '2026-09-24T16:00:00Z', event_title: 'Secure Copy/Paste Internal Sync' } },
    { id: 'not_armada', title: 'Armada roadmap review', created_at: '2026-09-23T17:06:00Z' },
    { id: 'not_new', title: 'New note', created_at: '2026-09-23T22:04:00Z' },
    { id: 'not_other', title: 'Totally different call', created_at: '2026-09-22T15:02:00Z' }
  ];
}

// ------------------------------------------------------------------ fakes

function makeFakes(state) {
  const openList = () => state.tasks.filter(t => !t.closed && !t.deleted);
  const Todoist = {
    findByMachineKey: jest.fn(key => openList().find(t => {
      const m = MACHINE_RE.exec(t.description || '');
      return m && JSON.parse(m[1]).key === key;
    }) || null),
    createTask: jest.fn(t => {
      const task = Object.assign({ id: String(8000 + state.tasks.length), closed: false }, t);
      if (t.dueDate) task.due = { date: t.dueDate };
      state.tasks.push(task);
      return task;
    }),
    updateTask: jest.fn((id, patch) => {
      const t = state.tasks.find(x => x.id === id);
      Object.assign(t, patch);
      if (patch.dueDate) t.due = { date: patch.dueDate };
      return t;
    }),
    closeTask: jest.fn(id => { state.tasks.find(x => x.id === id).closed = true; return true; }),
    withMachineLine: jest.fn((d, obj) => (d ? d + '\n' : '') + '<!-- ta:' + JSON.stringify(obj) + ' -->')
  };
  const Granola = {
    listNotes: jest.fn(opts => {
      state.listCalls.push(opts);
      if (state.granolaError) throw state.granolaError;
      return state.notes.map(n => Object.assign({}, n));
    })
  };
  return { Todoist, Granola };
}

function makeState() {
  return { tasks: [], notes: notes(), listCalls: [], granolaError: null };
}

function setup(opts) {
  const o = opts || {};
  const state = o.state || makeState();
  let mocks = o.mocks;
  if (!mocks) {
    mocks = createMocks({ props: Object.assign({}, PROPS, o.props || {}), timeZone: 'America/Los_Angeles' });
    if (!o.noCalendars) {
      mocks.CalendarApp.__addCalendar('alex@gr-oss.io', grEvents());
      mocks.CalendarApp.__addCalendar('alex@insightsoftmax.com', iscEvents());
      // alex@alexscammon.com deliberately missing (not shared with the script owner)
    }
  }
  const fakes = makeFakes(state);
  const ctx = loadGas(FILES, { mocks, globals: fakes });
  const clock = (o.now || NOW).getTime();
  ctx.Util.now = () => new Date(clock);
  ctx.state = state;
  ctx.fakes = fakes;
  return ctx;
}

const next = (prev, opts) => setup(Object.assign({ state: prev.state, mocks: prev.__mocks }, opts || {}));
const openTasks = ctx => ctx.state.tasks.filter(t => !t.closed);
const machine = t => JSON.parse(MACHINE_RE.exec(t.description)[1]);

// ------------------------------------------------------------------ summary check

describe('runSummaryCheck', () => {
  test('entrypoints are top-level functions and honour the lock', () => {
    const ctx = setup();
    expect(typeof ctx.runSummaryCheck).toBe('function');
    expect(typeof ctx.runTriageDigest).toBe('function');
    ctx.__mocks.LockService.__available = false;
    expect(ctx.runSummaryCheck()).toBeNull();
    expect(ctx.runTriageDigest()).toBeNull();
    expect(ctx.state.tasks).toHaveLength(0);
  });

  test('meetingEvents applies the qualifying rules and lists shared events once', () => {
    const ctx = setup();
    const evs = ctx.Checks.meetingEvents(new Date('2026-09-18T15:00:00Z'), new Date('2026-09-25T14:00:00Z'));
    expect(evs.map(e => e.title)).toEqual([
      'CNCF Batch Subproject', 'Armada roadmap review', 'Marcus / Alex', 'Secure Copy/Paste Internal Sync', 'AWS partner QBR'
    ]);
    expect(evs.find(e => e.title === 'AWS partner QBR').project).toBe('ISC');
    expect(evs.find(e => e.title === 'CNCF Batch Subproject').project).toBe('GR');
  });

  test('creates ONE Me › Immediate task listing unmatched meetings', () => {
    const ctx = setup();
    const res = ctx.runSummaryCheck();
    expect(res).toMatchObject({ seen: 5, missing: 2, created: 1, errors: 0 });
    expect(ctx.state.tasks).toHaveLength(1);
    const t = ctx.state.tasks[0];
    expect(t).toMatchObject({
      content: 'Open 2 Granola notes without summaries', projectName: 'Me', sectionName: 'Immediate', labels: ['check']
    });
    expect(t.description).toContain('- Tue 22 Sep 08:00 · CNCF Batch Subproject (GR)');
    expect(t.description).toContain('- Thu 24 Sep 13:00 · AWS partner QBR (ISC)');
    expect(t.description).not.toContain('Secure Copy/Paste');
    expect(t.description).not.toContain('Armada');
    expect(t.description).toContain('https://notes.granola.ai/');
    expect(machine(t)).toEqual({ key: 'check:summaries' });
    // Granola asked for notes created from a day before the window
    expect(new Date(ctx.state.listCalls[0].createdAfter).toISOString()).toBe('2026-09-17T15:00:00.000Z');
    expect(ctx.Store.runsRecent(1)[0]).toMatchObject({ job: 'summaryCheck', seen: 5, created: 1 });
  });

  test('idempotent: re-running changes nothing; a new summary updates the same task; zero closes it', () => {
    const ctx = setup();
    ctx.runSummaryCheck();
    const ctx2 = next(ctx);
    const res2 = ctx2.runSummaryCheck();
    expect(res2).toMatchObject({ created: 0, updated: 0, missing: 2 });
    expect(ctx2.fakes.Todoist.updateTask).not.toHaveBeenCalled();
    expect(ctx2.state.tasks).toHaveLength(1);

    ctx.state.notes.push({ id: 'not_aws', title: 'AWS partner QBR', created_at: '2026-09-24T20:01:00Z' });
    const ctx3 = next(ctx);
    const res3 = ctx3.runSummaryCheck();
    expect(res3).toMatchObject({ created: 0, updated: 1, missing: 1 });
    expect(ctx3.state.tasks).toHaveLength(1);
    expect(ctx3.state.tasks[0].content).toBe('Open 1 Granola note without a summary');
    expect(ctx3.state.tasks[0].description).not.toContain('AWS partner QBR');

    ctx.state.notes.push({ id: 'not_cncf', title: 'x', created_at: '2026-09-22T15:05:00Z', calendar_event: { calendar_event_id: 'CNCF0922@google.com' } });
    const ctx4 = next(ctx);
    const res4 = ctx4.runSummaryCheck();
    expect(res4).toMatchObject({ closed: 1, missing: 0 });
    expect(openTasks(ctx4)).toHaveLength(0);

    // stays closed, nothing new created
    const ctx5 = next(ctx);
    expect(ctx5.runSummaryCheck()).toMatchObject({ created: 0, closed: 0, missing: 0 });
    expect(ctx5.state.tasks).toHaveLength(1);
  });

  test('completing the task acknowledges its meetings; only new ones bring it back', () => {
    const ctx = setup();
    ctx.runSummaryCheck();
    ctx.state.tasks[0].closed = true; // Alex ticks it off
    const ctx2 = next(ctx);
    const res = ctx2.runSummaryCheck();
    expect(res).toMatchObject({ acknowledged: 2, missing: 0, created: 0 });
    expect(openTasks(ctx2)).toHaveLength(0);

    ctx.__mocks.CalendarApp.__calendars['alex@gr-oss.io'].__addEvent({
      id: 'hire0925', title: 'Deputy candidate interview', start: '2026-09-25T12:00:00Z', end: '2026-09-25T12:45:00Z',
      description: zoom, guests: guests('candidate@example.com')
    });
    const ctx3 = next(ctx);
    const res3 = ctx3.runSummaryCheck();
    expect(res3).toMatchObject({ missing: 1, created: 1 });
    const t = openTasks(ctx3)[0];
    expect(t.content).toBe('Open 1 Granola note without a summary');
    expect(t.description).toContain('Deputy candidate interview');
    expect(t.description).not.toContain('CNCF');
  });

  test('a Granola failure leaves the existing task untouched', () => {
    const ctx = setup();
    ctx.runSummaryCheck();
    const before = JSON.stringify(ctx.state.tasks);
    ctx.state.granolaError = new Error('Granola 503');
    const ctx2 = next(ctx);
    const res = ctx2.runSummaryCheck();
    expect(res.errors).toBe(1);
    expect(res.note).toMatch(/Granola 503/);
    expect(JSON.stringify(ctx2.state.tasks)).toBe(before);
    expect(ctx2.fakes.Todoist.closeTask).not.toHaveBeenCalled();
  });

  test('no calendars available: nothing to report, Granola not called', () => {
    const ctx = setup({ noCalendars: true });
    const res = ctx.runSummaryCheck();
    expect(res).toMatchObject({ seen: 0, missing: 0, created: 0, errors: 0 });
    expect(ctx.state.listCalls).toHaveLength(0);
  });

  test('SUMMARY_CHECK_IGNORE skips matching titles', () => {
    const ctx = setup({ props: { SUMMARY_CHECK_IGNORE: JSON.stringify(['qbr']) } });
    const res = ctx.runSummaryCheck();
    expect(res.missing).toBe(1);
    expect(ctx.state.tasks[0].description).not.toContain('AWS partner QBR');
  });

  test('matchNote: id match ignores @suffix and case; time match needs a similar title', () => {
    const ctx = setup();
    const ev = { id: 'ABC@google.com', title: 'Arctos board meeting', start: new Date('2026-09-23T17:00:00Z') };
    expect(ctx.Checks.matchNote(ev, [{ id: 'n1', calendar_event: { calendar_event_id: 'abc' } }])).toMatchObject({ id: 'n1' });
    expect(ctx.Checks.matchNote(ev, [{ id: 'n2', title: 'Arctos board', created_at: '2026-09-23T17:10:00Z' }])).toMatchObject({ id: 'n2' });
    expect(ctx.Checks.matchNote(ev, [{ id: 'n3', title: 'Arctos board', created_at: '2026-09-23T17:20:00Z' }])).toBeNull();
    expect(ctx.Checks.matchNote(ev, [{ id: 'n4', title: 'Tyre shopping', created_at: '2026-09-23T17:01:00Z' }])).toBeNull();
    expect(ctx.Checks.matchNote(ev, [{ id: 'n5', title: 'New note', created_at: '2026-09-23T16:55:00Z' }])).toMatchObject({ id: 'n5' });
    // a generic title linked to a different calendar event is not enough
    expect(ctx.Checks.matchNote(ev, [{ id: 'n6', title: 'New note', created_at: '2026-09-23T17:00:00Z', calendar_event: { calendar_event_id: 'zzz', scheduled_start_time: '2026-09-23T17:00:00Z' } }])).toBeNull();
  });
});

// ------------------------------------------------------------------ review fixes

describe('summary check: recurring series, other calendars, overflow', () => {
  const standup = (day, extra) => Object.assign({
    id: 'standup@google.com', title: 'GR-OSS standup', recurring: true,
    start: '2026-09-' + day + 'T16:00:00Z', end: '2026-09-' + day + 'T16:15:00Z', description: zoom,
    guests: guests('dave@gr-oss.io', 'caterina@gr-oss.io')
  }, extra || {});

  function recurringSetup(notesList, extraGr) {
    const state = makeState();
    state.notes = notesList;
    const mocks = createMocks({ props: PROPS, timeZone: 'America/Los_Angeles' });
    mocks.CalendarApp.__addCalendar('alex@gr-oss.io', [standup('22'), standup('23'), standup('24')].concat(extraGr || []));
    // the same series also shows on the ISC calendar: still one entry per instance
    mocks.CalendarApp.__addCalendar('alex@insightsoftmax.com', [standup('23')]);
    return setup({ state, mocks });
  }

  test('every instance of a recurring series is checked (shared iCalUID)', () => {
    const ctx = recurringSetup([]);
    const evs = ctx.Checks.meetingEvents(new Date('2026-09-18T15:00:00Z'), new Date('2026-09-25T14:00:00Z'));
    expect(evs).toHaveLength(3);
    expect(evs.map(e => e.start.toISOString())).toEqual([
      '2026-09-22T16:00:00.000Z', '2026-09-23T16:00:00.000Z', '2026-09-24T16:00:00.000Z'
    ]);
    expect(new Set(evs.map(e => e.key)).size).toBe(3);
  });

  test('a note for one instance (id = series base id) does not cover the other instances', () => {
    const ctx = recurringSetup([
      { id: 'n_22', title: 'Standup notes', created_at: '2026-09-22T16:02:00Z', calendar_event: { calendar_event_id: 'standup', scheduled_start_time: '2026-09-22T16:00:00Z' } }
    ]);
    const res = ctx.runSummaryCheck();
    expect(res).toMatchObject({ seen: 3, missing: 2, created: 1 });
    const d = ctx.state.tasks[0].description;
    expect(d).not.toContain('Tue 22 Sep');
    expect(d).toContain('- Wed 23 Sep 09:00 · GR-OSS standup (GR)');
    expect(d).toContain('- Thu 24 Sep 09:00 · GR-OSS standup (GR)');
  });

  test('matchNote by id requires the same instance time', () => {
    const ctx = setup();
    const ev = { id: 'standup@google.com', title: 'GR-OSS standup', start: new Date('2026-09-24T16:00:00Z'), end: new Date('2026-09-24T16:15:00Z') };
    const note = (sched, created) => ({ id: 'n', title: 'x', created_at: created, calendar_event: { calendar_event_id: 'standup', scheduled_start_time: sched } });
    expect(ctx.Checks.matchNote(ev, [note('2026-09-22T16:00:00Z', '2026-09-22T16:01:00Z')])).toBeNull();
    expect(ctx.Checks.matchNote(ev, [note('2026-09-24T16:00:00Z', '2026-09-24T16:01:00Z')])).toMatchObject({ id: 'n' });
    expect(ctx.Checks.matchNote(ev, [note('2026-09-24T16:10:00Z', null)])).toMatchObject({ id: 'n' });
    // no scheduled start: creation time must fall within the meeting (±15 min)
    expect(ctx.Checks.matchNote(ev, [note(null, '2026-09-24T16:20:00Z')])).toMatchObject({ id: 'n' });
    expect(ctx.Checks.matchNote(ev, [note(null, '2026-09-22T16:05:00Z')])).toBeNull();
  });

  test('meetings accepted on a calendar the script does not run as still count', () => {
    const state = makeState();
    state.notes = [];
    const mocks = createMocks({ props: PROPS, timeZone: 'America/Los_Angeles' });
    // Effective user is another account: getMyStatus() says INVITED and isOwnedByMe() false.
    mocks.CalendarApp.__addCalendar('alex@insightsoftmax.com', [
      { id: 'acc', title: 'Accepted on ISC', start: '2026-09-23T17:00:00Z', end: '2026-09-23T17:30:00Z', description: zoom, myStatus: GuestStatus.INVITED,
        guests: [{ email: 'alex@insightsoftmax.com', status: GuestStatus.YES }, { email: 'client@example.com' }] },
      { id: 'org', title: 'Organised on ISC', start: '2026-09-23T18:00:00Z', end: '2026-09-23T18:30:00Z', description: zoom, myStatus: null,
        creators: ['alex@insightsoftmax.com'], guests: [{ email: 'client@example.com' }] },
      { id: 'dec', title: 'Declined on ISC', start: '2026-09-23T19:00:00Z', end: '2026-09-23T19:30:00Z', description: zoom, myStatus: GuestStatus.INVITED,
        guests: [{ email: 'alex@insightsoftmax.com', status: GuestStatus.NO }, { email: 'client@example.com' }] },
      { id: 'inv', title: 'Unanswered on ISC', start: '2026-09-23T20:00:00Z', end: '2026-09-23T20:30:00Z', description: zoom, myStatus: GuestStatus.INVITED,
        guests: [{ email: 'alex@insightsoftmax.com', status: GuestStatus.INVITED }, { email: 'client@example.com' }] }
    ]);
    const ctx = setup({ state, mocks });
    const evs = ctx.Checks.meetingEvents(new Date('2026-09-18T15:00:00Z'), new Date('2026-09-25T14:00:00Z'));
    expect(evs.map(e => e.title)).toEqual(['Accepted on ISC', 'Organised on ISC']);
  });

  test('completing the task acknowledges only the meetings it listed, not the overflow', () => {
    const state = makeState();
    state.notes = [];
    const mocks = createMocks({ props: PROPS, timeZone: 'America/Los_Angeles' });
    const many = Array.from({ length: 30 }, (_, i) => {
      const start = new Date(Date.UTC(2026, 8, 19, 0, 0) + i * 3 * 3600000);
      return { id: 'm' + i, title: 'Client call ' + i, start: start.toISOString(), end: new Date(start.getTime() + 30 * 60000).toISOString(),
        description: zoom, guests: guests('c' + i + '@example.com') };
    });
    mocks.CalendarApp.__addCalendar('alex@gr-oss.io', many);
    const ctx = setup({ state, mocks });
    const res = ctx.runSummaryCheck();
    expect(res.missing).toBe(30);
    expect(ctx.state.tasks[0].description).toContain('… and 5 more');
    ctx.state.tasks[0].closed = true;
    const ctx2 = next(ctx);
    const res2 = ctx2.runSummaryCheck();
    expect(res2).toMatchObject({ acknowledged: 25, missing: 5, created: 1 });
    const t = openTasks(ctx2)[0];
    expect(t.content).toBe('Open 5 Granola notes without summaries');
    expect(t.description).toContain('Client call 29');
    expect(t.description).not.toContain('Client call 0 ');
  });
});

// ------------------------------------------------------------------ triage digest

describe('runTriageDigest', () => {
  const pending = n => Array.from({ length: n }, (_, i) => ({
    id: 'q_' + i, source: i % 2 ? 'email' : 'meeting', sourceKey: 'k' + i, title: 'Item ' + i, project: 'GR'
  }));

  test('creates the digest task with the web app URL (saved to TRIAGE_URL), due today', () => {
    const ctx = setup();
    ctx.__mocks.ScriptApp.__setServiceUrl('https://script.google.com/macros/s/abc/exec');
    ctx.Store.queueAdd(pending(3));
    const res = ctx.runTriageDigest();
    expect(res).toMatchObject({ pending: 3, created: 1, url: 'https://script.google.com/macros/s/abc/exec' });
    const t = ctx.state.tasks[0];
    expect(t).toMatchObject({ content: 'Triage 3 suggestions', projectName: 'Me', sectionName: 'Immediate', labels: ['check'], dueDate: '2026-09-25' });
    expect(t.description).toContain('[Open triage](https://script.google.com/macros/s/abc/exec)');
    expect(t.description).toContain('Pending: 1 email, 2 meeting');
    expect(t.description).toContain('Oldest: Fri 25 Sep');
    expect(machine(t)).toEqual({ key: 'check:triage' });
    expect(ctx.Config.get('TRIAGE_URL')).toBe('https://script.google.com/macros/s/abc/exec');
    expect(ctx.Store.runsRecent(1)[0]).toMatchObject({ job: 'triageDigest', seen: 3, created: 1 });
  });

  test('TRIAGE_URL wins; missing URL gives setup guidance', () => {
    const ctx = setup({ props: { TRIAGE_URL: 'https://example.com/triage' } });
    ctx.__mocks.ScriptApp.__setServiceUrl('https://script.google.com/other');
    expect(ctx.Checks.triageUrl()).toBe('https://example.com/triage');
    const ctx2 = setup();
    ctx2.__mocks.ScriptApp.__setServiceUrl(null); // web app not deployed
    ctx2.Store.queueAdd(pending(1));
    ctx2.runTriageDigest();
    expect(ctx2.state.tasks[0].content).toBe('Triage 1 suggestion');
    expect(ctx2.state.tasks[0].description).toMatch(/set Script Property TRIAGE_URL/);
  });

  test('updates the same task as the count changes and re-dates it; closes it at zero', () => {
    const ctx = setup({ props: { TRIAGE_URL: 'https://example.com/t' } });
    ctx.Store.queueAdd(pending(2));
    ctx.runTriageDigest();
    ctx.state.tasks[0].due = { date: '2026-09-24' }; // yesterday's digest

    const ctx2 = next(ctx);
    expect(ctx2.runTriageDigest()).toMatchObject({ created: 0, updated: 1 });
    expect(ctx2.fakes.Todoist.updateTask).toHaveBeenCalledWith(ctx.state.tasks[0].id, { dueDate: '2026-09-25' });

    const ctx3 = next(ctx);
    expect(ctx3.runTriageDigest()).toMatchObject({ created: 0, updated: 0 });

    ctx3.Store.queueAdd(pending(5));
    const ctx4 = next(ctx);
    ctx4.runTriageDigest();
    expect(ctx4.state.tasks).toHaveLength(1);
    expect(ctx4.state.tasks[0].content).toBe('Triage 5 suggestions');

    ['q_0', 'q_1', 'q_2', 'q_3', 'q_4'].forEach(id => ctx4.Store.queueUpdate(id, { status: 'dismissed' }));
    const ctx5 = next(ctx);
    expect(ctx5.runTriageDigest()).toMatchObject({ pending: 0, closed: 1 });
    expect(openTasks(ctx5)).toHaveLength(0);
    const ctx6 = next(ctx);
    expect(ctx6.runTriageDigest()).toMatchObject({ pending: 0, closed: 0, created: 0 });
  });

  test('empty queue and no task: nothing happens', () => {
    const ctx = setup();
    expect(ctx.runTriageDigest()).toMatchObject({ pending: 0, created: 0, closed: 0, errors: 0 });
    expect(ctx.fakes.Todoist.createTask).not.toHaveBeenCalled();
  });

  test('a Todoist failure is logged, not thrown', () => {
    const ctx = setup();
    ctx.Store.queueAdd(pending(1));
    ctx.fakes.Todoist.createTask.mockImplementation(() => { throw new Error('Todoist 500'); });
    const res = ctx.runTriageDigest();
    expect(res.errors).toBe(1);
    expect(ctx.Store.runsRecent(1)[0]).toMatchObject({ job: 'triageDigest', errors: 1 });
  });
});
