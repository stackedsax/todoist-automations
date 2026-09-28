const { loadGas } = require('./helpers/gas');
const { respond } = require('./helpers/mocks');

const FILES = ['Config.js', 'Util.js', 'Http.js', 'Store.js', 'Todoist.js', 'Route.js', 'Waiting.js'];
const NOW = new Date('2026-09-28T17:00:00Z'); // 10:00 in America/Los_Angeles
const TODAY = '2026-09-28';
const PROPS = { TODOIST_API_TOKEN: 't', ANTHROPIC_API_KEY: 'k', CLAUDE_MODEL: 'claude-test', GRANOLA_API_KEY: 'grn' };
const CATALOGUE = {
  GR: ['Reach Out', 'Team Logistics', 'Team Updates', 'Conferences', 'KubeCon / Armada / CNCF Batch', 'Arctos', 'Tech Projects', 'Blogs', 'Hiring', 'EA'],
  ISC: ['Reach Out', 'Logistics', 'Marketing', 'Quantum', 'Research', 'ISC Events', 'EA'],
  Me: ['Immediate', 'Logistics', 'Outreach', 'Tech', 'Cars', 'To Buy'],
  SG: []
};

// ------------------------------------------------------------------ fakes

/** In-memory Todoist: real machine-line helpers, fake network methods. */
function fakeTodoist(ctx, opts) {
  const o = opts || {};
  const T = ctx.Todoist;
  const state = {
    projects: { Waiting: o.noWaiting ? null : 'p_wait', GR: 'p_gr', ISC: 'p_isc', Me: 'p_me', SG: 'p_sg', Inbox: 'p_inbox' },
    tasks: (o.tasks || []).map(t => Object.assign({ project_id: 'p_wait', labels: ['waiting'] }, t)),
    comments: [],
    calls: [],
    nextId: 500
  };
  const keyOf = name => (name === 'Waiting on others' ? 'Waiting' : name);
  T.projectId = jest.fn(name => state.projects[keyOf(name)] || null);
  T.ensureProject = jest.fn(name => {
    const k = keyOf(name);
    if (!state.projects[k]) state.projects[k] = 'p_new_' + k;
    return state.projects[k];
  });
  T.sectionCatalogue = jest.fn(() => JSON.parse(JSON.stringify(CATALOGUE)));
  T.openTasks = jest.fn(op => {
    const keys = (op && op.projectNames) || ['GR', 'ISC', 'Me', 'SG', 'Inbox', 'Waiting'];
    return state.tasks.filter(t => !t.closed && keys.some(k => state.projects[keyOf(k)] === t.project_id));
  });
  T.createTask = jest.fn(t => {
    if (o.failCreate) throw new Error('boom');
    const task = {
      id: String(state.nextId++), content: t.content, description: t.description || '',
      project_id: state.projects[keyOf(t.projectName)], labels: t.labels || [],
      due: t.dueDate ? { date: t.dueDate } : null, added_at: NOW.toISOString()
    };
    state.tasks.push(task);
    state.calls.push(['create', t]);
    return task;
  });
  const find = id => state.tasks.find(t => t.id === String(id));
  T.closeTask = jest.fn(id => { state.calls.push(['close', id]); find(id).closed = true; return true; });
  T.moveTask = jest.fn((id, dest) => {
    if (o.failMove && o.failMove(id)) throw Object.assign(new Error('move failed'), { status: 500 });
    state.calls.push(['move', id, dest]);
    const t = find(id);
    t.project_id = state.projects[dest.projectName];
    t.section = dest.sectionName || null;
    return t;
  });
  T.updateTask = jest.fn((id, patch) => {
    state.calls.push(['update', id, patch]);
    const t = find(id);
    if (patch.content) t.content = patch.content;
    if (patch.description !== undefined) t.description = patch.description;
    if ('dueDate' in patch) t.due = patch.dueDate ? { date: patch.dueDate } : null;
    return t;
  });
  T.addComment = jest.fn((id, content) => {
    state.calls.push(['comment', id, content]);
    state.comments.push({ taskId: String(id), content });
    return { id: 'c' + state.comments.length };
  });
  return state;
}

function waitingTask(ctx, over) {
  const o = Object.assign({
    id: 't1', owner: 'Mihailo Marinkovic', email: 'mihailo.marinkovic@gr-oss.io',
    title: 'Send the clipboard C code walkthrough', dest: 'GR/Tech Projects', since: '2026-09-21', due: TODAY,
    key: 'granola:not_sync0924', q: 'q_abc'
  }, over || {});
  const machine = { key: o.key, q: o.q, dest: o.dest, owner: o.owner, email: o.email, since: o.since };
  Object.keys(machine).forEach(k => machine[k] === undefined && delete machine[k]);
  return {
    id: o.id,
    content: (o.owner ? o.owner + ': ' : '') + o.title,
    description: ctx.Todoist.withMachineLine('Waiting on: ' + o.owner, machine),
    due: o.due ? { date: o.due } : null,
    added_at: '2026-09-21T16:00:00.000000Z'
  };
}

function setup(opts) {
  const o = opts || {};
  const ctx = loadGas(FILES, { props: Object.assign({}, PROPS, o.props || {}), timeZone: 'America/Los_Angeles' });
  ctx.Util.now = () => new Date(NOW.getTime());
  const state = fakeTodoist(ctx, o);
  if (o.makeTasks) state.tasks.push(...o.makeTasks(ctx).map(t => Object.assign({ project_id: 'p_wait', labels: ['waiting'] }, t)));
  ctx.Extract = { resolution: jest.fn(o.resolution || (() => ({ resolved: false, confidence: 'low', reason: 'No evidence found since the item was created.', evidenceLink: null }))) };
  ctx.Granola = {
    listNotes: jest.fn(() => (o.notes || []).map(n => n.list)),
    getNote: jest.fn(id => {
      const n = (o.notes || []).find(x => x.list.id === id);
      return n ? n.meeting : null;
    })
  };
  if (o.slack) ctx.Slack = { search: jest.fn(o.slack) };
  return { ctx, state, gmail: ctx.__mocks.GmailApp };
}

const mihailoThread = (over) => Object.assign({
  id: 'th1',
  messages: [
    {
      id: 'm1', from: 'Mihailo Marinkovic <mihailo.marinkovic@gr-oss.io>', to: 'alex@gr-oss.io',
      subject: 'Clipboard C code walkthrough', date: '2026-09-25T15:00:00Z',
      plain: 'Hi Alex, here is the walkthrough of the C code: https://docs.example.com/walkthrough'
    }
  ]
}, over || {});

// ------------------------------------------------------------------ create

describe('Waiting.create', () => {
  test('creates a task in Waiting on others with owner prefix, label, resurface due date and machine line', () => {
    const { ctx, state } = setup();
    const task = ctx.Waiting.create({
      id: 'q_111', title: 'Send the clipboard C code walkthrough', kind: 'waiting',
      waitOn: 'Mihailo Marinkovic', waitOnEmail: 'Mihailo.Marinkovic@gr-oss.io', resurface: '2026-10-02',
      project: 'GR', section: 'tech projects', sourceKey: 'granola:not_sync0924',
      origin: 'Granola · Secure Copy/Paste Internal Sync · Thu 24 Sep', link: 'https://notes.granola.ai/d/not_sync0924',
      quote: 'I will write up a walkthrough of the C code for you.'
    });
    const call = state.calls.find(c => c[0] === 'create')[1];
    expect(call.content).toBe('Mihailo Marinkovic: Send the clipboard C code walkthrough');
    expect(call.projectName).toBe('Waiting');
    expect(call.labels).toEqual(['waiting']);
    expect(call.dueDate).toBe('2026-10-02');
    expect(call.description).toContain('Waiting on: Mihailo Marinkovic <mihailo.marinkovic@gr-oss.io>');
    expect(call.description).toContain('From: Granola · Secure Copy/Paste Internal Sync · Thu 24 Sep');
    expect(call.description).toContain('[Open source](https://notes.granola.ai/d/not_sync0924)');
    expect(call.description).toContain('Then: GR › Tech Projects');
    expect(call.description).toContain('> I will write up a walkthrough');
    const lines = call.description.split('\n');
    expect(lines[lines.length - 1]).toMatch(/^<!-- ta:\{.*\} -->$/);
    expect(ctx.Todoist.parseMachineLine(call.description)).toEqual({
      key: 'granola:not_sync0924', q: 'q_111', dest: 'GR/Tech Projects', owner: 'Mihailo Marinkovic',
      email: 'mihailo.marinkovic@gr-oss.io', since: TODAY, sinceAt: NOW.toISOString()
    });
    expect(ctx.Todoist.ensureProject).toHaveBeenCalledWith('Waiting');
    expect(task.id).toBeDefined();
  });

  test('defaults resurface to +7 days and accepts extracted-item fields (ownerName/ownerEmail)', () => {
    const { ctx, state } = setup();
    ctx.Waiting.create({ title: 'Share the Q4 budget numbers', ownerName: 'Priya Shah', ownerEmail: 'priya@insightsoftmax.com', project: 'ISC', key: 'gmail:th9' });
    const call = state.calls.find(c => c[0] === 'create')[1];
    expect(call.content).toBe('Priya Shah: Share the Q4 budget numbers');
    expect(call.dueDate).toBe('2026-10-05');
    const m = ctx.Todoist.parseMachineLine(call.description);
    expect(m.dest).toBe('ISC');
    expect(m.key).toBe('gmail:th9');
    expect(m.q).toBeUndefined();
    expect(call.description).toContain('Then: ISC');
  });

  test('a resurface date in the past becomes tomorrow; unknown section is dropped from dest; no project -> Inbox', () => {
    const { ctx, state } = setup();
    ctx.Waiting.create({ title: 'Return the signed lease', waitOn: 'Paul Freedman', resurface: '2026-09-01', project: 'SG', section: 'Leases' });
    ctx.Waiting.create({ title: 'Send the photos', waitOnEmail: 'jess@example.com', resurface: 'next week' });
    const [a, b] = state.calls.filter(c => c[0] === 'create').map(c => c[1]);
    expect(a.dueDate).toBe('2026-09-29');
    expect(ctx.Todoist.parseMachineLine(a.description).dest).toBe('SG');
    expect(b.content).toBe('jess@example.com: Send the photos');
    expect(b.dueDate).toBe('2026-10-05');
    expect(ctx.Todoist.parseMachineLine(b.description).dest).toBeUndefined();
    expect(b.description).toContain('Then: Inbox');
  });

  test('is idempotent per queue id', () => {
    const { ctx, state } = setup();
    const item = { id: 'q_dup', title: 'Send the deck', waitOn: 'Jon Stumpf', project: 'ISC' };
    const first = ctx.Waiting.create(item);
    const second = ctx.Waiting.create(item);
    expect(second.id).toBe(first.id);
    expect(state.calls.filter(c => c[0] === 'create')).toHaveLength(1);
  });

  test('creates the Waiting project when missing and requires a title', () => {
    const { ctx, state } = setup({ noWaiting: true });
    ctx.Waiting.create({ id: 'q_new', title: 'Send the deck', waitOn: 'Jon Stumpf' });
    expect(ctx.Todoist.ensureProject).toHaveBeenCalledWith('Waiting');
    expect(state.tasks).toHaveLength(1);
    expect(() => ctx.Waiting.create({ title: '  ' })).toThrow(/title required/);
  });

  test('uses "Someone" when no owner is known and clamps long titles', () => {
    const { ctx, state } = setup();
    ctx.Waiting.create({ title: 'x'.repeat(300) });
    const call = state.calls.find(c => c[0] === 'create')[1];
    expect(call.content.startsWith('Someone: ')).toBe(true);
    expect(call.content.length).toBeLessThanOrEqual('Someone: '.length + 120);
  });
});

// ------------------------------------------------------------------ parsing

describe('Waiting.parseTask / parseDest / dueTasks / keywords', () => {
  test('parses our machine line', () => {
    const { ctx } = setup();
    const info = ctx.Waiting.parseTask(waitingTask(ctx));
    expect(info.owner).toBe('Mihailo Marinkovic');
    expect(info.email).toBe('mihailo.marinkovic@gr-oss.io');
    expect(info.title).toBe('Send the clipboard C code walkthrough');
    expect(info.dest).toEqual({ project: 'GR', section: 'Tech Projects' });
    // `since` is a script-TZ date: local midnight in America/Los_Angeles (PDT), not UTC midnight
    expect(info.since.toISOString()).toBe('2026-09-21T07:00:00.000Z');
  });

  test('since: sinceAt wins; a date is local midnight in the script TZ (PST in winter, UTC when TZ is UTC)', () => {
    const { ctx } = setup();
    const withAt = ctx.Waiting.parseTask(Object.assign(waitingTask(ctx), {
      description: ctx.Todoist.withMachineLine('x', { owner: 'M', since: '2026-09-21', sinceAt: '2026-09-21T18:30:00.000Z' })
    }));
    expect(withAt.since.toISOString()).toBe('2026-09-21T18:30:00.000Z');
    expect(ctx.Waiting.localMidnight_('2026-12-01').toISOString()).toBe('2026-12-01T08:00:00.000Z');
    expect(ctx.Waiting.localMidnight_('2026-11-01').toISOString()).toBe('2026-11-01T07:00:00.000Z'); // DST ends later that day
    expect(ctx.Waiting.localMidnight_('bad')).toBeNull();
    const utc = loadGas(FILES, { props: PROPS, timeZone: 'UTC' });
    expect(utc.Waiting.localMidnight_('2026-09-21').toISOString()).toBe('2026-09-21T00:00:00.000Z');
  });

  test("the owner's promise from the evening before the since date is not evidence", () => {
    const { ctx, gmail } = setup({ props: { GRANOLA_API_KEY: '' } });
    gmail.__addThreads([{
      id: 'th_eve', messages: [
        // 20 Sep 20:00 PDT = 21 Sep 03:00Z: after UTC midnight of the 21st but before local midnight
        { id: 'e1', from: 'mihailo.marinkovic@gr-oss.io', to: 'alex@gr-oss.io', subject: 'Clipboard walkthrough', date: '2026-09-21T03:00:00Z', plain: 'I will send the walkthrough next week.' }
      ]
    }]);
    const ev = ctx.Waiting.gatherEvidence(ctx.Waiting.parseTask(waitingTask(ctx)), { notes: {}, fetches: 0 });
    expect(ev).toEqual([]);
  });

  test('parses hand-made tasks and follow-up names; falls back to added_at', () => {
    const { ctx } = setup();
    const a = ctx.Waiting.parseTask({ id: 'x', content: 'Jon Stumpf: send the HPC deck', description: '', added_at: '2026-09-20T10:00:00Z' });
    expect(a.owner).toBe('Jon Stumpf');
    expect(a.title).toBe('send the HPC deck');
    expect(a.email).toBeNull();
    expect(a.dest).toBeNull();
    expect(a.since.toISOString()).toBe('2026-09-20T10:00:00.000Z');
    const b = ctx.Waiting.parseTask({ id: 'y', content: 'Follow up with Jon: the deck', description: '' });
    expect(b.owner).toBe('Jon');
    expect(b.title).toBe('the deck');
    const c = ctx.Waiting.parseTask({ id: 'z', content: 'Chase the refund', description: '' });
    expect(c.owner).toBeNull();
    expect(c.title).toBe('Chase the refund');
  });

  test('parseDest keeps sections containing slashes', () => {
    const { ctx } = setup();
    expect(ctx.Waiting.parseDest('GR/KubeCon / Armada / CNCF Batch')).toEqual({ project: 'GR', section: 'KubeCon / Armada / CNCF Batch' });
    expect(ctx.Waiting.parseDest('isc')).toEqual({ project: 'ISC', section: null });
    expect(ctx.Waiting.parseDest('Nowhere/Thing')).toBeNull();
    expect(ctx.Waiting.parseDest(null)).toBeNull();
  });

  test('dueTasks: due today or earlier, sorted; undated only when ours and old enough', () => {
    const { ctx } = setup({
      makeTasks: c => [
        waitingTask(c, { id: 'future', due: '2026-10-01' }),
        waitingTask(c, { id: 'today', due: TODAY }),
        waitingTask(c, { id: 'late', due: '2026-09-20' }),
        waitingTask(c, { id: 'timed', due: '2026-09-27T09:00:00' }),
        waitingTask(c, { id: 'undatedOld', due: null, since: '2026-09-20' }),
        waitingTask(c, { id: 'undatedNew', due: null, since: '2026-09-25' }),
        { id: 'manual', content: 'Someone: thing', description: '', due: null },
        Object.assign(waitingTask(c, { id: 'elsewhere', due: '2026-09-01' }), { project_id: 'p_gr' })
      ]
    });
    expect(ctx.Waiting.dueTasks(TODAY).map(t => t.id)).toEqual(['undatedOld', 'late', 'timed', 'today']);
  });

  test('dueTasks is empty when the Waiting project does not exist', () => {
    const { ctx } = setup({ noWaiting: true });
    expect(ctx.Waiting.dueTasks(TODAY)).toEqual([]);
  });

  test('keywords drop generic verbs, owner names and short tokens', () => {
    const { ctx } = setup();
    const kw = ctx.Waiting.keywords('Send Alex the clipboard C code walkthrough', 'Mihailo Marinkovic');
    expect(kw).toEqual(expect.arrayContaining(['clipboard', 'walkthrough', 'code']));
    expect(kw).not.toContain('send');
    expect(kw).not.toContain('alex');
    expect(ctx.Waiting.keywords('Send Jon the deck', 'Jon')).toEqual(['deck']);
  });
});

// ------------------------------------------------------------------ evidence

describe('Waiting.gatherEvidence', () => {
  test('Gmail: keyword query then plain from: query then Alex->owner; messages before creation ignored', () => {
    const { ctx, gmail } = setup();
    gmail.__addThreads([
      mihailoThread(),
      {
        id: 'th0', messages: [
          { id: 'm0', from: 'mihailo.marinkovic@gr-oss.io', to: 'alex@gr-oss.io', subject: 'Old', date: '2026-09-10T10:00:00Z', plain: 'old news' }
        ]
      },
      {
        id: 'th2', messages: [
          { id: 'm2', from: 'Alex Scammon <alex@gr-oss.io>', to: 'mihailo.marinkovic@gr-oss.io', subject: 'Re: walkthrough', date: '2026-09-26T10:00:00Z', plain: 'Thanks, got it!' },
          { id: 'm3', from: 'Alex Scammon <alex@gr-oss.io>', to: 'someone@else.com', subject: 'Unrelated', date: '2026-09-26T11:00:00Z', plain: 'hi' }
        ]
      }
    ]);
    const info = ctx.Waiting.parseTask(waitingTask(ctx));
    const ev = ctx.Waiting.gatherEvidence(info, { notes: {}, fetches: 0 });
    const queries = gmail.search.mock.calls.map(c => c[0]);
    expect(queries[0]).toMatch(/^from:mihailo\.marinkovic@gr-oss\.io newer_than:9d \{/);
    expect(queries[0]).toContain('clipboard');
    expect(queries[0]).toContain('walkthrough');
    expect(queries[1]).toBe('from:mihailo.marinkovic@gr-oss.io newer_than:9d');
    expect(queries[2]).toBe('from:me to:mihailo.marinkovic@gr-oss.io newer_than:9d');
    expect(ev.map(e => e.title)).toEqual(['Re: walkthrough', 'Clipboard C code walkthrough']);
    expect(ev[1]).toMatchObject({ source: 'gmail', link: 'https://mail.google.com/mail/#all/th1' });
    expect(ev[1].text).toContain('here is the walkthrough');
  });

  test('Gmail without an email searches by quoted name and matches the sender by name', () => {
    const { ctx, gmail } = setup({ props: { GRANOLA_API_KEY: '' } });
    gmail.__addThreads([
      {
        id: 'th5', messages: [
          { id: 'm5', from: 'Jon Stumpf <jon@stumpf.example>', to: 'alex@insightsoftmax.com', subject: 'HPC deck', date: '2026-09-26T10:00:00Z', plain: 'Deck attached.' },
          { id: 'm6', from: 'Other Person <o@x.example>', subject: 'HPC deck', date: '2026-09-26T11:00:00Z', plain: 'me too' }
        ]
      }
    ]);
    const info = ctx.Waiting.parseTask({ id: 'x', content: 'Jon Stumpf: send the HPC deck', description: '', added_at: '2026-09-22T10:00:00Z' });
    const ev = ctx.Waiting.gatherEvidence(info, { notes: {}, fetches: 0 });
    expect(gmail.search.mock.calls[0][0]).toMatch(/^from:"Jon Stumpf" newer_than:\d+d \{/);
    expect(ev).toHaveLength(1);
    expect(ev[0].from).toContain('Jon Stumpf');
  });

  test("Gmail by name never counts Alex's own messages as the owner's", () => {
    const { ctx, gmail } = setup({ props: { GRANOLA_API_KEY: '' } });
    gmail.__addThreads([{
      id: 'th_ab', messages: [
        { id: 'a1', from: 'Alex Scammon <alex@insightsoftmax.com>', to: 'team@insightsoftmax.com', subject: 'Deck', date: '2026-09-26T10:00:00Z', plain: 'Here is my deck.' },
        { id: 'a2', from: 'Alex <alex@alexscammon.com>', to: 'x@y.example', subject: 'Deck', date: '2026-09-26T10:30:00Z', plain: 'from my personal address' },
        { id: 'a3', from: 'Alex Blundell <ablundell@partner.example>', to: 'alex@insightsoftmax.com', subject: 'Deck', date: '2026-09-26T11:00:00Z', plain: 'Deck attached.' }
      ]
    }]);
    const info = ctx.Waiting.parseTask({ id: 'x', content: 'Alex: send the partner deck', description: '', added_at: '2026-09-22T10:00:00Z' });
    expect(info.owner).toBe('Alex');
    const ev = ctx.Waiting.gatherEvidence(info, { notes: {}, fetches: 0 });
    expect(ev.map(e => e.from)).toEqual(['Alex Blundell <ablundell@partner.example>']);
  });

  test("Granola: Alex's own attendee entry never counts as the owner attending", () => {
    const notes = [
      {
        list: { id: 'not_me', created_at: '2026-09-24T16:01:12Z' },
        meeting: { title: 'ISC staff', start: new Date('2026-09-24T16:00:00Z'), url: 'u1', summaryMarkdown: 'x', attendees: [{ name: 'Alex Scammon', email: 'alex@insightsoftmax.com' }, { name: 'Priya Shah', email: 'priya@insightsoftmax.com' }] }
      },
      {
        list: { id: 'not_ab', created_at: '2026-09-25T16:01:12Z' },
        meeting: { title: 'Partner sync', start: new Date('2026-09-25T16:00:00Z'), url: 'u2', summaryMarkdown: 'y', attendees: [{ name: 'Alex Scammon', email: 'alex@insightsoftmax.com' }, { name: 'Alex Blundell', email: 'ablundell@partner.example' }] }
      }
    ];
    const { ctx } = setup({ notes });
    const info = ctx.Waiting.parseTask({ id: 'x', content: 'Alex: send the partner deck', description: '', added_at: '2026-09-22T10:00:00Z' });
    const ev = ctx.Waiting.gatherEvidence(info, { notes: {}, fetches: 0 }).filter(e => e.source === 'granola');
    expect(ev.map(e => e.title)).toEqual(['Partner sync']);
  });

  test('Granola: a listNotes failure disables Granola for the rest of the run (no retry per task)', () => {
    const { ctx } = setup({ makeTasks: c => [waitingTask(c, { id: 'a' }), waitingTask(c, { id: 'b' }), waitingTask(c, { id: 'c' })] });
    ctx.Granola.listNotes.mockImplementation(() => { throw Object.assign(new Error('Granola down'), { status: 503 }); });
    const stats = ctx.runWaiting();
    expect(ctx.Granola.listNotes).toHaveBeenCalledTimes(1);
    expect(stats).toMatchObject({ seen: 3, resurfaced: 3, errors: 0 });
    expect(ctx.__mocks.logs.join('\n')).toContain('Granola listNotes failed');
  });

  test('Granola: notes created since the task with the owner attending (list fetched once per run)', () => {
    const notes = [
      {
        list: { id: 'not_a', created_at: '2026-09-24T16:01:12Z' },
        meeting: { title: 'Secure Copy/Paste Internal Sync', start: new Date('2026-09-24T16:00:00Z'), url: 'https://notes.granola.ai/d/not_a', summaryMarkdown: 'Mihailo shared the walkthrough doc.', attendees: [{ name: 'Mihailo Marinkovic', email: 'mihailo.marinkovic@gr-oss.io' }] }
      },
      {
        list: { id: 'not_b', created_at: '2026-09-25T16:01:12Z' },
        meeting: { title: 'Other', start: new Date('2026-09-25T16:00:00Z'), url: 'u', summaryMarkdown: 'x', attendees: [{ name: 'Someone', email: 's@x.com' }] }
      },
      {
        list: { id: 'not_old', created_at: '2026-09-10T16:01:12Z' },
        meeting: { title: 'Old', start: new Date('2026-09-10T16:00:00Z'), url: 'u', summaryMarkdown: 'x', attendees: [{ name: 'Mihailo Marinkovic', email: 'mihailo.marinkovic@gr-oss.io' }] }
      }
    ];
    const { ctx } = setup({ notes });
    const info = ctx.Waiting.parseTask(waitingTask(ctx));
    const run = { notes: {}, fetches: 0, infos: [info, ctx.Waiting.parseTask(waitingTask(ctx, { id: 't2', since: '2026-09-05' }))] };
    const ev = ctx.Waiting.gatherEvidence(info, run);
    expect(ev).toEqual([expect.objectContaining({ source: 'granola', title: 'Secure Copy/Paste Internal Sync', link: 'https://notes.granola.ai/d/not_a' })]);
    // earliest since across the run's tasks
    expect(ctx.Granola.listNotes.mock.calls[0][0].createdAfter.toISOString()).toBe('2026-09-05T07:00:00.000Z');
    ctx.Waiting.gatherEvidence(info, run);
    expect(ctx.Granola.listNotes).toHaveBeenCalledTimes(1);
    expect(ctx.Granola.getNote).toHaveBeenCalledTimes(2); // memoised; old note never fetched
    expect(ctx.Granola.getNote).toHaveBeenCalledWith('not_a', { transcript: false });
  });

  test('Granola skipped without GRANOLA_API_KEY', () => {
    const { ctx } = setup({ props: { GRANOLA_API_KEY: '' } });
    ctx.Waiting.gatherEvidence(ctx.Waiting.parseTask(waitingTask(ctx)), { notes: {}, fetches: 0 });
    expect(ctx.Granola.listNotes).not.toHaveBeenCalled();
  });

  test('Slack: used only when Slack.search and SLACK_WORKSPACES exist; results normalised', () => {
    const slack = jest.fn(() => [
      { workspace: 'GR-OSS', channelName: 'secure-clipboard', ts: '1758900000.000100', userName: 'Mihailo Marinkovic', text: 'Walkthrough is up: <https://docs.example.com/w>', permalink: 'https://gr-oss.slack.com/archives/C1/p1758900000000100' },
      { text: '' }
    ]);
    const { ctx } = setup({ slack, props: { SLACK_WORKSPACES: JSON.stringify([{ name: 'GR-OSS', token: 'xoxp-1', project: 'GR' }]), GRANOLA_API_KEY: '' } });
    const info = ctx.Waiting.parseTask(waitingTask(ctx));
    const ev = ctx.Waiting.gatherEvidence(info, { notes: {}, fetches: 0 }).filter(e => e.source.indexOf('slack') === 0);
    expect(slack).toHaveBeenCalledTimes(1);
    const [query, since] = slack.mock.calls[0];
    expect(query.split(' ')).toEqual(expect.arrayContaining(['clipboard', 'walkthrough']));
    expect(since.toISOString()).toBe('2026-09-21T07:00:00.000Z');
    expect(ev).toEqual([expect.objectContaining({
      source: 'slack GR-OSS', title: '#secure-clipboard', from: 'Mihailo Marinkovic',
      link: 'https://gr-oss.slack.com/archives/C1/p1758900000000100'
    })]);
    expect(ev[0].date.getTime()).toBe(1758900000000);

    const noWs = setup({ slack, props: { GRANOLA_API_KEY: '' } });
    slack.mockClear();
    noWs.ctx.Waiting.gatherEvidence(noWs.ctx.Waiting.parseTask(waitingTask(noWs.ctx)), { notes: {}, fetches: 0 });
    expect(slack).not.toHaveBeenCalled();
  });

  test('Slack: accepts the evidence-shaped rows Slack.search returns', () => {
    const slack = jest.fn(() => [
      { source: 'slack', workspace: 'ISC', date: new Date('2026-09-26T10:00:00Z'), from: 'Priya Shah', title: '#finance', text: 'Budget numbers attached', link: 'https://isc.slack.com/archives/C9/p1' }
    ]);
    const { ctx } = setup({ slack, props: { SLACK_WORKSPACES: JSON.stringify([{ name: 'ISC', token: 'xoxp-2', project: 'ISC' }]), GRANOLA_API_KEY: '' } });
    const info = ctx.Waiting.parseTask({ id: 'p', content: 'Priya Shah: share the Q4 budget numbers', description: '', added_at: '2026-09-22T00:00:00Z' });
    const ev = ctx.Waiting.gatherEvidence(info, { notes: {}, fetches: 0 }).filter(e => e.source.indexOf('slack') === 0);
    expect(ev).toEqual([{ source: 'slack ISC', date: new Date('2026-09-26T10:00:00Z'), from: 'Priya Shah', title: '#finance', text: 'Budget numbers attached', link: 'https://isc.slack.com/archives/C9/p1' }]);
  });

  test('one failing source does not block the others', () => {
    const notes = [{
      list: { id: 'not_a', created_at: '2026-09-24T16:01:12Z' },
      meeting: { title: 'Sync', start: new Date('2026-09-24T16:00:00Z'), url: 'g', summaryMarkdown: 'done', attendees: [{ name: 'Mihailo Marinkovic', email: 'mihailo.marinkovic@gr-oss.io' }] }
    }];
    const { ctx, gmail } = setup({ notes });
    gmail.search.mockImplementation(() => { throw new Error('Gmail quota'); });
    const ev = ctx.Waiting.gatherEvidence(ctx.Waiting.parseTask(waitingTask(ctx)), { notes: {}, fetches: 0 });
    expect(ev.map(e => e.source)).toEqual(['granola']);
  });
});

// ------------------------------------------------------------------ run

describe('runWaiting', () => {
  test('auto-closes when resolved with high confidence', () => {
    const { ctx, state, gmail } = setup({
      makeTasks: c => [waitingTask(c)],
      resolution: (item, ev) => ({ resolved: true, confidence: 'high', reason: 'Mihailo sent the walkthrough on 25 Sep.', evidenceLink: ev[0].link })
    });
    gmail.__addThreads([mihailoThread()]);
    const stats = ctx.runWaiting();
    expect(stats).toMatchObject({ seen: 1, closed: 1, resurfaced: 0, errors: 0 });
    const [item, evidence, opts] = ctx.Extract.resolution.mock.calls[0];
    expect(item).toMatchObject({ title: 'Send the clipboard C code walkthrough', ownerName: 'Mihailo Marinkovic', ownerEmail: 'mihailo.marinkovic@gr-oss.io' });
    expect(evidence[0].source).toBe('gmail');
    expect(opts.today).toBe(TODAY);
    expect(state.calls.map(c => c[0])).toEqual(['comment', 'close']);
    expect(state.comments[0].content).toBe('Auto-closed: Mihailo sent the walkthrough on 25 Sep. https://mail.google.com/mail/#all/th1');
    expect(ctx.Todoist.moveTask).not.toHaveBeenCalled();
    const run = ctx.Store.runsRecent(1, 'runWaiting')[0];
    expect(run).toMatchObject({ job: 'runWaiting', seen: 1, errors: 0 });
    expect(run.note).toContain('closed 1');
  });

  test('resurfaces (rename, due today, comment, then move to dest) when not resolved', () => {
    const { ctx, state } = setup({ makeTasks: c => [waitingTask(c)] });
    const stats = ctx.runWaiting();
    expect(stats).toMatchObject({ seen: 1, closed: 0, resurfaced: 1 });
    expect(ctx.Extract.resolution.mock.calls[0][1]).toEqual([]);
    expect(state.calls.map(c => c[0])).toEqual(['update', 'comment', 'move']);
    expect(state.calls[2][2]).toEqual({ projectName: 'GR', sectionName: 'Tech Projects' });
    const patch = state.calls[0][2];
    expect(patch.content).toBe('Follow up with Mihailo Marinkovic: Send the clipboard C code walkthrough');
    expect(patch.dueDate).toBe(TODAY);
    const m = ctx.Todoist.parseMachineLine(patch.description);
    expect(m).toMatchObject({ key: 'granola:not_sync0924', dest: 'GR/Tech Projects', resurfaced: TODAY });
    expect(state.comments[0].content).toMatch(/^Resurfaced from Waiting on others: No evidence/);
    expect(ctx.Todoist.closeTask).not.toHaveBeenCalled();
  });

  test('resolved but only med confidence resurfaces with the partial evidence listed', () => {
    const { ctx, state, gmail } = setup({
      makeTasks: c => [waitingTask(c)],
      resolution: () => ({ resolved: true, confidence: 'med', reason: 'Mihailo mentioned a draft.', evidenceLink: 'https://mail.google.com/mail/#all/th1' })
    });
    gmail.__addThreads([mihailoThread()]);
    const stats = ctx.runWaiting();
    expect(stats.resurfaced).toBe(1);
    expect(ctx.Todoist.closeTask).not.toHaveBeenCalled();
    const comment = state.comments[0].content;
    expect(comment).toContain('Mihailo mentioned a draft. https://mail.google.com/mail/#all/th1');
    expect(comment).toContain('Possibly related since then:');
    expect(comment).toContain('- gmail · Fri 25 Sep · Clipboard C code walkthrough https://mail.google.com/mail/#all/th1');
  });

  test('without a destination the follow-up goes to Inbox; not-due tasks are untouched', () => {
    const { ctx, state } = setup({
      makeTasks: c => [
        { id: 'manual', content: 'Jon Stumpf: send the HPC deck', description: '', due: { date: '2026-09-27' } },
        waitingTask(c, { id: 'later', due: '2026-10-03' })
      ]
    });
    const stats = ctx.runWaiting();
    expect(stats.seen).toBe(1);
    expect(state.calls.find(c => c[0] === 'move')).toEqual(['move', 'manual', { projectName: 'Inbox', sectionName: undefined }]);
    expect(state.calls[0][2].content).toBe('Follow up with Jon Stumpf: send the HPC deck');
    expect(state.calls.some(c => c[1] === 'later')).toBe(false);
  });

  test('one failing task does not abort the run', () => {
    const { ctx, state } = setup({
      makeTasks: c => [waitingTask(c, { id: 'bad', due: '2026-09-26' }), waitingTask(c, { id: 'good' })],
      failMove: id => id === 'bad'
    });
    const stats = ctx.runWaiting();
    expect(stats).toMatchObject({ seen: 2, resurfaced: 1, errors: 1 });
    expect(state.calls.filter(c => c[0] === 'move').map(c => c[1])).toEqual(['good']);
    expect(ctx.Store.runsRecent(1)[0].errors).toBe(1);
  });

  test('a failure mid-resurface leaves the task in Waiting on others, due today, and the next run finishes it', () => {
    let failUpdate = true;
    const { ctx, state } = setup({ makeTasks: c => [waitingTask(c, { id: 'flaky' })] });
    const realUpdate = ctx.Todoist.updateTask.getMockImplementation();
    ctx.Todoist.updateTask.mockImplementation((id, patch) => {
      if (failUpdate) throw Object.assign(new Error('Todoist 502'), { status: 502 });
      return realUpdate(id, patch);
    });
    expect(ctx.runWaiting()).toMatchObject({ seen: 1, resurfaced: 0, errors: 1 });
    const t = state.tasks.find(x => x.id === 'flaky');
    expect(t.project_id).toBe('p_wait');
    expect(ctx.Todoist.moveTask).not.toHaveBeenCalled();

    failUpdate = false;
    expect(ctx.runWaiting()).toMatchObject({ seen: 1, resurfaced: 1, errors: 0 });
    expect(t.project_id).toBe('p_gr');
    expect(t.content).toBe('Follow up with Mihailo Marinkovic: Send the clipboard C code walkthrough');
    expect(t.due).toEqual({ date: TODAY });

    // a move failure after rename: still in Waiting, renamed, due today -> parsed back correctly
    const again = setup({ makeTasks: c => [waitingTask(c, { id: 'mv' })], failMove: () => true });
    expect(again.ctx.runWaiting().errors).toBe(1);
    const t2 = again.state.tasks.find(x => x.id === 'mv');
    expect(t2.project_id).toBe('p_wait');
    expect(again.ctx.Waiting.dueTasks(TODAY).map(x => x.id)).toEqual(['mv']);
    const info = again.ctx.Waiting.parseTask(t2);
    expect(info).toMatchObject({ owner: 'Mihailo Marinkovic', title: 'Send the clipboard C code walkthrough', dest: { project: 'GR', section: 'Tech Projects' } });
  });

  test('stops at the deadline and leaves the rest for the next run', () => {
    const { ctx } = setup({ makeTasks: c => [waitingTask(c, { id: 'a' }), waitingTask(c, { id: 'b' }), waitingTask(c, { id: 'c' })] });
    let t = NOW.getTime();
    ctx.Util.now = () => new Date(t);
    ctx.Extract.resolution.mockImplementation(() => { t += 200000; return { resolved: false, confidence: 'low', reason: 'nothing', evidenceLink: null }; });
    const stats = ctx.Waiting.run();
    expect(stats).toMatchObject({ seen: 3, resurfaced: 2, skipped: 1, stoppedEarly: true });
    expect(ctx.Store.runsRecent(1)[0].note).toContain('stopped early');
  });

  test('skips when another run holds the lock', () => {
    const { ctx } = setup({ makeTasks: c => [waitingTask(c)] });
    ctx.__mocks.LockService.__available = false;
    expect(ctx.runWaiting()).toBeNull();
    expect(ctx.Extract.resolution).not.toHaveBeenCalled();
  });

  test('no due tasks: logs a run and does nothing', () => {
    const { ctx, state } = setup();
    expect(ctx.runWaiting()).toMatchObject({ seen: 0, closed: 0, resurfaced: 0 });
    expect(state.calls).toEqual([]);
    expect(ctx.Store.runsRecent(1)[0].job).toBe('runWaiting');
  });
});

// ------------------------------------------------------------------ integration with the real Todoist client

describe('Waiting with the real Todoist client (HTTP shapes)', () => {
  test('create posts to the Waiting on others project with label and due_date', () => {
    const ctx = loadGas(FILES, { props: PROPS, timeZone: 'America/Los_Angeles' });
    ctx.Util.now = () => new Date(NOW.getTime());
    ctx.Http.jitter_ = () => 0;
    const U = ctx.__mocks.UrlFetchApp;
    const BASE = 'https://api.todoist.com/api/v1';
    U.__on('GET', BASE + '/projects', respond.json({ results: [{ id: 'p_inbox', name: 'Inbox', inbox_project: true }, { id: 'p_gr', name: 'GR' }, { id: 'p_w', name: 'Waiting on others' }], next_cursor: null }));
    U.__on('GET', BASE + '/sections', respond.json({ results: [{ id: 's_tp', name: 'Tech Projects', project_id: 'p_gr' }], next_cursor: null }));
    U.__on('GET', BASE + '/labels', respond.json({ results: [{ id: 'l1', name: 'waiting' }], next_cursor: null }));
    U.__on('GET', BASE + '/tasks', respond.json({ results: [], next_cursor: null }));
    U.__on('POST', BASE + '/tasks', req => respond.json(Object.assign({ id: '9001' }, req.json)));
    const task = ctx.Waiting.create({ id: 'q_1', title: 'Send the walkthrough', waitOn: 'Mihailo Marinkovic', project: 'GR', section: 'Tech Projects', resurface: '2026-10-01' });
    expect(task.id).toBe('9001');
    const post = U.__find('POST', BASE + '/tasks')[0];
    expect(post.json).toMatchObject({ content: 'Mihailo Marinkovic: Send the walkthrough', project_id: 'p_w', labels: ['waiting'], due_date: '2026-10-01' });
    expect(post.json.section_id).toBeUndefined();
    expect(U.__find('POST', BASE + '/projects')).toHaveLength(0);
  });
});
