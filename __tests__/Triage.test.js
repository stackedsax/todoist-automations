const fs = require('fs');
const path = require('path');
const { loadGas } = require('./helpers/gas');
const { respond } = require('./helpers/mocks');

const BASE = 'https://api.todoist.com/api/v1';
const FILES = ['Config.js', 'Util.js', 'Http.js', 'Store.js', 'Todoist.js', 'Route.js', 'Waiting.js', 'Triage.js'];
const NOW = new Date('2026-09-28T17:00:00Z'); // Mon 10:00 America/Los_Angeles
const PROPS = { TODOIST_API_TOKEN: 't', ANTHROPIC_API_KEY: 'k', CLAUDE_MODEL: 'claude-test', GRANOLA_API_KEY: 'grn' };
const MACHINE_RE = /<!-- ta:(.*) -->/;

const PROJECTS = [
  { id: 'p_inbox', name: 'Inbox', inbox_project: true },
  { id: 'p_gr', name: 'GR' },
  { id: 'p_isc', name: 'ISC' },
  { id: 'p_me', name: 'Me' },
  { id: 'p_sg', name: 'SG' },
  { id: 'p_wait', name: 'Waiting on others' }
];
const SECTIONS = {
  p_gr: ['Reach Out', 'Team Logistics', 'Team Updates', 'Conferences', 'KubeCon / Armada / CNCF Batch', 'Arctos', 'Tech Projects', 'Blogs', 'Hiring', 'EA', 'Generated Tasks'],
  p_isc: ['Reach Out', 'Logistics', 'Marketing', 'Quantum', 'Research', 'ISC Events', 'EA'],
  p_me: ['Immediate', 'Logistics', 'Outreach', 'Tech', 'Cars', 'To Buy'],
  p_sg: [],
  p_wait: []
};
const sectionId = (pid, name) => pid + '_s' + SECTIONS[pid].indexOf(name);

// ------------------------------------------------------------------ Todoist v1 fake (HTTP level)

function fakeTodoist(mocks, opts) {
  const o = opts || {};
  const state = {
    projects: PROJECTS.map(p => Object.assign({}, p)),
    tasks: (o.tasks || []).map(t => Object.assign({ labels: [], section_id: null }, t)),
    labels: ['meeting', 'from-email', 'from-slack', 'waiting', 'check'].map((n, i) => ({ id: 'l' + i, name: n })),
    comments: [],
    deleted: [],
    deletedComments: [],
    nextId: 1000
  };
  const U = mocks.UrlFetchApp;
  const page = items => respond.json({ results: items, next_cursor: null });
  U.__on('GET', BASE + '/projects', () => page(state.projects));
  U.__on('GET', BASE + '/sections', req => page((SECTIONS[req.query.project_id] || []).map((n, i) => ({
    id: req.query.project_id + '_s' + i, name: n, project_id: req.query.project_id, section_order: i
  }))));
  U.__on('GET', BASE + '/labels', () => page(state.labels));
  U.__on('POST', BASE + '/labels', req => {
    const l = { id: 'l' + state.nextId++, name: req.json.name };
    state.labels.push(l);
    return respond.json(l);
  });
  U.__on('GET', BASE + '/tasks', req => page(state.tasks.filter(t => t.project_id === req.query.project_id && !t.deleted)));
  U.__on('POST', BASE + '/tasks', req => {
    if (o.failCreate) return respond.status(400, '{"error":"bad request"}');
    const t = Object.assign({ id: String(state.nextId++), section_id: null, labels: [] }, req.json);
    if (!t.project_id) t.project_id = 'p_inbox';
    if (t.due_date) t.due = { date: t.due_date };
    state.tasks.push(t);
    return respond.json(t);
  });
  U.__on('DELETE', new RegExp('^' + BASE + '/tasks/[^/?]+$'), req => {
    const id = decodeURIComponent(req.url.split('/tasks/')[1]);
    const t = state.tasks.find(x => x.id === id && !x.deleted);
    if (!t) return respond.status(404, 'Task not found');
    t.deleted = true;
    state.deleted.push(id);
    return respond.empty();
  });
  U.__on('POST', BASE + '/comments', req => {
    const t = state.tasks.find(x => x.id === String(req.json.task_id) && !x.deleted);
    if (!t) return respond.status(404, 'Task not found');
    const c = { id: 'c' + state.nextId++, task_id: req.json.task_id, content: req.json.content };
    state.comments.push(c);
    return respond.json(c);
  });
  U.__on('DELETE', new RegExp('^' + BASE + '/comments/[^/?]+$'), req => {
    const id = decodeURIComponent(req.url.split('/comments/')[1]);
    const c = state.comments.find(x => x.id === id && !x.deleted);
    if (!c) return respond.status(404, 'Comment not found');
    c.deleted = true;
    state.deletedComments.push(id);
    return respond.empty();
  });
  return state;
}

// ------------------------------------------------------------------ fixtures

const GN = 'https://notes.granola.ai/d/';

function meetingItem(over) {
  return Object.assign({
    id: 'q_meet1',
    source: 'meeting',
    sourceKey: 'granola:not_69936f98',
    origin: 'Granola · Secure Copy/Paste Internal Sync · Thu 24 Sep',
    link: GN + '69936f98-5231-46a0-b84d-892d55d39b47',
    title: 'Reissue Mihailo\'s C3 credentials via MDM if the corrected username doesn\'t work',
    quote: 'Mihailo to try correct username first; if still broken, Alexander to reissue credentials via MDM.',
    why: 'Alex owns the fallback.',
    kind: 'todo', due: null, resurface: null, waitOn: null, waitOnEmail: null,
    project: 'GR', section: 'Tech Projects', confidence: 'high', routeConfidence: 'med',
    chips: [],
    description: 'Meeting: Secure Copy/Paste Internal Sync · Thu 24 Sep\n[Open in Granola](' + GN + '69936f98)\n> quote\n<!-- ta:{"key":"granola:not_69936f98","q":"q_meet1"} -->',
    labels: ['meeting']
  }, over || {});
}

function emailDupItem(over) {
  return Object.assign({
    id: 'q_mail1',
    source: 'email',
    sourceKey: 'gmail:1877333639310677068',
    origin: 'Email · UTSA · Marcus Rabe · Fri 25 Sep',
    link: 'https://mail.google.com/mail/?authuser=alex@alexscammon.com#all/1877333639310677068',
    title: 'Review the UTSA doc and the Carlos Garcia intro for Marcus',
    quote: 'Can you please have a look at this together with the document I shared about UTSA?',
    why: 'A direct request from Marcus.',
    kind: 'todo', project: 'ISC', section: 'Research', confidence: 'high', routeConfidence: 'high',
    dupTaskId: 't_utsa', dupTaskTitle: 'look at CUDO and UTSA stuff for marcus',
    chips: []
  }, over || {});
}

function waitingItem(over) {
  return Object.assign({
    id: 'q_wait1',
    source: 'meeting',
    sourceKey: 'granola:not_69936f98',
    origin: 'Granola · Secure Copy/Paste Internal Sync · Thu 24 Sep',
    link: GN + '69936f98',
    title: 'Send the full dependency list to Tabatha',
    quote: 'Citrix x2, OmniSight, Qt Core, Qt test, Catch2.',
    why: 'Blocks the C++ rewrite.',
    kind: 'waiting', resurface: '2026-10-01', waitOn: 'Mihailo Marinkovic', waitOnEmail: 'mihailo.marinkovic@gr-oss.io',
    project: 'GR', section: 'Tech Projects', confidence: 'high', routeConfidence: 'high', chips: []
  }, over || {});
}

function setup(opts) {
  const o = opts || {};
  const ctx = loadGas(o.files || FILES, { props: Object.assign({}, PROPS, o.props || {}), timeZone: 'America/Los_Angeles' });
  ctx.Util.now = () => new Date(NOW.getTime());
  ctx.Http.jitter_ = () => 0;
  const todo = fakeTodoist(ctx.__mocks, {
    failCreate: o.failCreate,
    tasks: o.tasks || [
      { id: 't_utsa', content: 'look at CUDO and UTSA stuff for marcus', project_id: 'p_isc' },
      { id: 't_c3', content: 'Provision C3 access for Mihailo and update his password in the MDM system', project_id: 'p_gr' }
    ]
  });
  ctx.Store.queueAdd(o.items || [meetingItem(), emailDupItem(), waitingItem()]);
  if (o.filtered !== undefined) ctx.Store.kvSet('inbox.lastFiltered', o.filtered);
  return { ctx, todo };
}

const calls = (ctx, method, re) => ctx.__mocks.UrlFetchApp.__calls.filter(c => c.method.toLowerCase() === method.toLowerCase() && re.test(c.url));
const feedback = (ctx, type) => ctx.Store.feedbackRecent(100, type);
const machine = desc => JSON.parse((desc.match(MACHINE_RE) || [])[1] || 'null');

// ------------------------------------------------------------------ doGet

describe('doGet', () => {
  test('serves TriageUI with title and viewport meta', () => {
    const { ctx } = setup();
    const out = ctx.doGet({ parameter: {} });
    expect(ctx.HtmlService.createTemplateFromFile).toHaveBeenCalledWith('TriageUI');
    expect(out.__title).toBe('Todo Triage');
    expect(out.__meta.viewport).toBe('width=device-width, initial-scale=1');
    expect(out.getContent()).toContain('google.script.run');
  });
});

// ------------------------------------------------------------------ triageList

describe('triageList', () => {
  test('returns pending items (client shape), live sections without neverUse, and the filtered summary', () => {
    const filteredKv = {
      at: '2026-09-28T14:00:00.000Z', count: 19, seen: 42,
      byReason: { calendar: 6, receipt: 5, noreply: 8 },
      examples: [{ subject: 'Accepted: Nanda + Alex S Connect', from: 'Nanda <n@x.com>', reason: 'calendar' }]
    };
    const { ctx } = setup({ filtered: filteredKv });
    ctx.Store.queueUpdate('q_wait1', { status: 'dismissed' });
    const res = ctx.triageList();
    expect(res.items.map(i => i.id)).toEqual(['q_meet1', 'q_mail1']);
    const m = res.items[0];
    expect(m.description).toBeUndefined();
    expect(m.undo).toBeUndefined();
    expect(m.canUndo).toBe(false);
    expect(m.notDuplicate).toBe(false);
    expect(res.items[1].dupTaskUrl).toBe('https://app.todoist.com/app/task/t_utsa');
    expect(res.sections.GR).toContain('Tech Projects');
    expect(res.sections.GR).not.toContain('Generated Tasks');
    expect(res.sections.SG).toEqual([]);
    expect(res.filtered).toEqual({
      at: filteredKv.at, count: 19, seen: 42, byReason: filteredKv.byReason,
      examples: [{ subject: 'Accepted: Nanda + Alex S Connect', from: 'Nanda <n@x.com>', reason: 'calendar' }]
    });
    expect(res.warnings).toEqual([]);
    // plain JSON (google.script.run cannot return Dates or functions)
    expect(JSON.parse(JSON.stringify(res))).toEqual(res);
  });

  test('empty queue and no inbox sweep yet', () => {
    const { ctx } = setup({ items: [] });
    const res = ctx.triageList();
    expect(res.items).toEqual([]);
    expect(res.filtered).toEqual({ count: 0, examples: [], byReason: {}, at: null, seen: null });
  });

  test('a Todoist 500 on GET /sections is a warning naming the project, not an error', () => {
    const { ctx } = setup();
    // Todoist.sectionCatalogue would swallow this as [] -- Triage must still surface it.
    ctx.__mocks.UrlFetchApp.__on('GET', req => req.url.indexOf(BASE + '/sections') === 0 && req.query.project_id === 'p_gr',
      { status: 500, body: 'internal error' });
    const res = ctx.triageList();
    expect(res.items.length).toBe(3);
    expect(res.sections.GR).toEqual([]);
    expect(res.sections.ISC).toContain('Research');
    expect(res.warnings.length).toBe(1);
    expect(res.warnings[0]).toMatch(/Could not load Todoist sections for GR: HTTP 500/);
  });

  test('every project failing is one warning listing them all', () => {
    const { ctx } = setup();
    ctx.__mocks.UrlFetchApp.__on('GET', req => req.url.indexOf(BASE + '/sections') === 0, { status: 503, body: 'down' });
    const res = ctx.triageList();
    expect(res.sections).toEqual({ GR: [], ISC: [], Me: [], SG: [] });
    expect(res.warnings).toEqual([expect.stringMatching(/for GR, ISC, Me, SG: HTTP 503/)]);
  });
});

// ------------------------------------------------------------------ accept

describe('triageAct accept', () => {
  test('creates the task in project/section with the source label and machine line', () => {
    const { ctx, todo } = setup();
    const res = ctx.triageAct('q_meet1', 'accept');
    const posts = calls(ctx, 'post', /\/tasks$/);
    expect(posts.length).toBe(1);
    const body = posts[0].json;
    expect(body.content).toBe(meetingItem().title);
    expect(body.project_id).toBe('p_gr');
    expect(body.section_id).toBe(sectionId('p_gr', 'Tech Projects'));
    expect(body.labels).toEqual(['meeting']);
    expect(machine(body.description)).toEqual({ key: 'granola:not_69936f98', q: 'q_meet1' });
    expect(body.description).toContain('Meeting: Secure Copy/Paste Internal Sync');

    const task = todo.tasks[todo.tasks.length - 1];
    expect(res.item.status).toBe('accepted');
    expect(res.item.resultTaskId).toBe(task.id);
    expect(res.item.resolvedAt).toBe(NOW.toISOString());
    expect(res.item.canUndo).toBe(true);
    expect(res.message).toBe('Accepted → GR › Tech Projects');
    const stored = ctx.Store.queueGet('q_meet1');
    expect(stored.status).toBe('accepted');
    expect(stored.undo[0]).toMatchObject({ action: 'accept', effect: { type: 'task', taskId: task.id }, prev: { status: 'pending' } });
  });

  test('builds a description when the queue item has none; due date and Inbox fallback', () => {
    const { ctx } = setup({
      items: [meetingItem({ id: 'q_x', description: undefined, labels: undefined, source: 'slack', sourceKey: 'slack:ISC:C1:1.2',
        origin: 'Slack · ISC · #general · Thu 24 Sep', link: 'https://isc.slack.com/archives/C1/p12', project: null, section: 'Logistics', due: '2026-10-02' })]
    });
    ctx.triageAct('q_x', 'accept');
    const body = calls(ctx, 'post', /\/tasks$/)[0].json;
    expect(body.project_id).toBe('p_inbox');
    expect(body.section_id).toBeUndefined();
    expect(body.labels).toEqual(['from-slack']);
    expect(body.due_date).toBe('2026-10-02');
    expect(body.description).toContain('Slack · ISC · #general · Thu 24 Sep');
    expect(body.description).toContain('[Open source](https://isc.slack.com/archives/C1/p12)');
    expect(body.description).toContain('> Mihailo to try');
    expect(machine(body.description)).toEqual({ key: 'slack:ISC:C1:1.2', q: 'q_x' });
  });

  test('accept applies an edit patch first (title) and records feedback', () => {
    const { ctx } = setup();
    ctx.triageAct('q_meet1', 'accept', { title: 'Reissue Mihailo\'s C3 credentials' });
    expect(calls(ctx, 'post', /\/tasks$/)[0].json.content).toBe('Reissue Mihailo\'s C3 credentials');
    const fb = feedback(ctx, 'edited');
    expect(fb.length).toBe(1);
    expect(fb[0].detail).toMatchObject({ field: 'title', from: meetingItem().title, to: 'Reissue Mihailo\'s C3 credentials' });
    // undo restores the original title
    ctx.triageAct('q_meet1', 'undo');
    expect(ctx.Store.queueGet('q_meet1').title).toBe(meetingItem().title);
  });

  test('duplicate -> comment on the existing task, no new task', () => {
    const { ctx, todo } = setup();
    const res = ctx.triageAct('q_mail1', 'accept');
    expect(calls(ctx, 'post', /\/tasks$/).length).toBe(0);
    expect(todo.comments.length).toBe(1);
    expect(todo.comments[0].task_id).toBe('t_utsa');
    expect(todo.comments[0].content).toContain('Also came up: Review the UTSA doc');
    expect(todo.comments[0].content).toContain('[Open source](https://mail.google.com/');
    expect(res.item.status).toBe('accepted');
    expect(res.item.resultTaskId).toBe('t_utsa');
    expect(res.message).toMatch(/comment on “look at CUDO and UTSA stuff for marcus”/);
  });

  test('duplicate whose task is gone -> clear error, item stays pending', () => {
    const { ctx } = setup({ tasks: [] });
    expect(() => ctx.triageAct('q_mail1', 'accept')).toThrow(/no longer exists.*Press u/);
    expect(ctx.Store.queueGet('q_mail1').status).toBe('pending');
  });

  test('notDuplicate -> creates a new task instead of commenting', () => {
    const { ctx, todo } = setup();
    ctx.triageAct('q_mail1', 'undup');
    ctx.triageAct('q_mail1', 'accept');
    expect(todo.comments.length).toBe(0);
    const body = calls(ctx, 'post', /\/tasks$/)[0].json;
    expect(body.project_id).toBe('p_isc');
    expect(body.section_id).toBe(sectionId('p_isc', 'Research'));
    expect(body.labels).toEqual(['from-email']);
  });

  test('waiting item -> Waiting on others task via Waiting.create', () => {
    const { ctx } = setup();
    const res = ctx.triageAct('q_wait1', 'accept');
    const body = calls(ctx, 'post', /\/tasks$/)[0].json;
    expect(body.project_id).toBe('p_wait');
    expect(body.content).toBe('Mihailo Marinkovic: Send the full dependency list to Tabatha');
    expect(body.labels).toEqual(['waiting']);
    expect(body.due_date).toBe('2026-10-01');
    expect(machine(body.description)).toMatchObject({ key: 'granola:not_69936f98', q: 'q_wait1', dest: 'GR/Tech Projects', owner: 'Mihailo Marinkovic' });
    expect(res.item.status).toBe('waiting');
    expect(res.message).toBe('Parked in Waiting on others until Thu 1 Oct');
  });

  test('a Todoist failure leaves the item pending and throws', () => {
    const { ctx } = setup({ failCreate: true });
    expect(() => ctx.triageAct('q_meet1', 'accept')).toThrow();
    const it = ctx.Store.queueGet('q_meet1');
    expect(it.status).toBe('pending');
    expect(it.undo).toBeUndefined();
  });

  test('acting twice is refused', () => {
    const { ctx } = setup();
    ctx.triageAct('q_meet1', 'accept');
    expect(() => ctx.triageAct('q_meet1', 'accept')).toThrow(/Already accepted/);
    expect(calls(ctx, 'post', /\/tasks$/).length).toBe(1);
  });

  test('bad input', () => {
    const { ctx } = setup();
    expect(() => ctx.triageAct('', 'accept')).toThrow(/No suggestion id/);
    expect(() => ctx.triageAct('q_meet1', 'archive')).toThrow(/Unknown action/);
    expect(() => ctx.triageAct('q_nope', 'accept')).toThrow(/no longer exists/);
  });
});

// ------------------------------------------------------------------ dismiss / undup / edit / move / wait

describe('triageAct dismiss', () => {
  test('marks dismissed and records a dismissal for Extract', () => {
    const { ctx } = setup();
    const res = ctx.triageAct('q_meet1', 'dismiss');
    expect(res.item.status).toBe('dismissed');
    expect(res.item.resolvedAt).toBe(NOW.toISOString());
    expect(calls(ctx, 'post', /\/tasks$/).length).toBe(0);
    const fb = feedback(ctx, 'dismissed');
    expect(fb.length).toBe(1);
    expect(fb[0]).toMatchObject({ queueId: 'q_meet1', sourceKey: 'granola:not_69936f98', title: meetingItem().title });
    expect(fb[0].detail).toMatchObject({ source: 'meeting', project: 'GR', quote: meetingItem().quote });
  });
});

describe('triageAct undup', () => {
  test('toggles notDuplicate; each change records a not_duplicate state row (clearing -> cleared: true)', () => {
    const { ctx } = setup();
    let res = ctx.triageAct('q_mail1', 'undup');
    expect(res.item.notDuplicate).toBe(true);
    expect(res.changed).toBe(true);
    expect(res.message).toMatch(/Not a duplicate/);
    let fb = feedback(ctx, 'not_duplicate');
    expect(fb.length).toBe(1);
    expect(fb[0]).toMatchObject({ queueId: 'q_mail1', at: NOW.toISOString() });
    expect(fb[0].detail).toEqual({ dupTaskId: 't_utsa', dupTaskTitle: 'look at CUDO and UTSA stuff for marcus' });
    res = ctx.triageAct('q_mail1', 'undup');
    expect(res.item.notDuplicate).toBe(false);
    fb = feedback(ctx, 'not_duplicate');
    expect(fb.length).toBe(2);
    expect(fb[0].detail).toEqual({ dupTaskId: 't_utsa', dupTaskTitle: 'look at CUDO and UTSA stuff for marcus', cleared: true });
  });

  test('explicit value is idempotent', () => {
    const { ctx } = setup();
    ctx.triageAct('q_mail1', 'undup', { notDuplicate: true });
    const res = ctx.triageAct('q_mail1', 'undup', { notDuplicate: true });
    expect(res.message).toMatch(/Already marked/);
    expect(res.changed).toBe(false);
    expect(ctx.Store.queueGet('q_mail1').undo.length).toBe(1);
    expect(feedback(ctx, 'not_duplicate').length).toBe(1);
  });

  test('refused when no duplicate was detected', () => {
    const { ctx } = setup();
    expect(() => ctx.triageAct('q_meet1', 'undup')).toThrow(/isn't flagged as a duplicate/);
  });
});

describe('triageAct edit', () => {
  test('changes the title and records edited feedback', () => {
    const { ctx } = setup();
    const res = ctx.triageAct('q_meet1', 'edit', { title: '  Reissue   C3 credentials for Mihailo ' });
    expect(res.item.title).toBe('Reissue C3 credentials for Mihailo');
    expect(res.item.status).toBe('pending');
    expect(feedback(ctx, 'edited')[0].detail).toMatchObject({ field: 'title', to: 'Reissue C3 credentials for Mihailo' });
  });

  test('empty title is rejected; unchanged title is a no-op', () => {
    const { ctx } = setup();
    expect(() => ctx.triageAct('q_meet1', 'edit', { title: '   ' })).toThrow(/cannot be empty/);
    const res = ctx.triageAct('q_meet1', 'edit', { title: meetingItem().title });
    expect(res.message).toBe('No change');
    expect(feedback(ctx, 'edited').length).toBe(0);
  });

  test('due date must be ISO', () => {
    const { ctx } = setup();
    expect(() => ctx.triageAct('q_meet1', 'edit', { due: 'Friday' })).toThrow(/YYYY-MM-DD/);
    expect(ctx.triageAct('q_meet1', 'edit', { due: '2026-10-02' }).item.due).toBe('2026-10-02');
  });
});

describe('triageAct move', () => {
  test('quick project keeps a section that exists there, else project root; records rerouted', () => {
    const { ctx } = setup();
    let res = ctx.triageAct('q_meet1', 'move', { project: 'ISC' });
    expect(res.item.project).toBe('ISC');
    expect(res.item.section).toBeNull(); // Tech Projects is not an ISC section
    res = ctx.triageAct('q_mail1', 'move', { project: 'GR' });
    expect(res.item.section).toBeNull();
    const fb = feedback(ctx, 'rerouted');
    expect(fb.length).toBe(2);
    expect(fb[1].detail).toEqual({ from: { kind: 'todo', project: 'GR', section: 'Tech Projects' }, to: { kind: 'todo', project: 'ISC', section: null } });
  });

  test('explicit section is validated against the live catalogue (case-insensitive, canonical spelling)', () => {
    const { ctx } = setup();
    const res = ctx.triageAct('q_meet1', 'move', { project: 'me', section: 'immediate' });
    expect(res.item.project).toBe('Me');
    expect(res.item.section).toBe('Immediate');
    expect(res.message).toBe('Destination set: Me › Immediate. Press s to accept');
    expect(() => ctx.triageAct('q_meet1', 'move', { project: 'GR', section: 'Generated Tasks' })).toThrow(/does not exist in GR/);
    expect(() => ctx.triageAct('q_meet1', 'move', { project: 'Soul Graffiti' })).toThrow(/Unknown project/);
  });

  test('then accept creates the task at the new destination', () => {
    const { ctx } = setup();
    ctx.triageAct('q_meet1', 'move', { project: 'ISC', section: 'Logistics' });
    ctx.triageAct('q_meet1', 'accept');
    const body = calls(ctx, 'post', /\/tasks$/)[0].json;
    expect(body.project_id).toBe('p_isc');
    expect(body.section_id).toBe(sectionId('p_isc', 'Logistics'));
  });

  test('move to Waiting makes it a waiting item that keeps its follow-up destination', () => {
    const { ctx } = setup();
    const res = ctx.triageAct('q_meet1', 'move', { project: 'Waiting' });
    expect(res.item.kind).toBe('waiting');
    expect(res.item.project).toBe('GR');
    ctx.triageAct('q_meet1', 'accept');
    const body = calls(ctx, 'post', /\/tasks$/)[0].json;
    expect(body.project_id).toBe('p_wait');
    expect(machine(body.description).dest).toBe('GR/Tech Projects');
  });

  test('unchanged destination is a no-op', () => {
    const { ctx } = setup();
    const res = ctx.triageAct('q_meet1', 'move', { project: 'GR', section: 'Tech Projects' });
    expect(res.message).toMatch(/unchanged/);
    expect(feedback(ctx, 'rerouted').length).toBe(0);
  });
});

describe('triageAct wait', () => {
  test('parks a todo in Waiting on others with the owner given, default resurface +7d', () => {
    const { ctx } = setup();
    const res = ctx.triageAct('q_meet1', 'wait', { waitOn: 'Mihailo Marinkovic' });
    const body = calls(ctx, 'post', /\/tasks$/)[0].json;
    expect(body.project_id).toBe('p_wait');
    expect(body.content).toMatch(/^Mihailo Marinkovic: /);
    expect(body.due_date).toBe('2026-10-05');
    expect(res.item.status).toBe('waiting');
    expect(res.item.kind).toBe('waiting');
    expect(res.message).toBe('Parked in Waiting on others (Mihailo Marinkovic) until Mon 5 Oct');
    expect(feedback(ctx, 'rerouted')[0].detail.to).toEqual({ kind: 'waiting', waitOn: 'Mihailo Marinkovic' });
  });

  test('without an owner falls back to "Someone"; bad resurface rejected', () => {
    const { ctx } = setup();
    expect(() => ctx.triageAct('q_meet1', 'wait', { resurface: 'next week' })).toThrow(/YYYY-MM-DD/);
    ctx.triageAct('q_meet1', 'wait');
    expect(calls(ctx, 'post', /\/tasks$/)[0].json.content).toMatch(/^Someone: /);
  });
});

// ------------------------------------------------------------------ undo

describe('triageAct undo', () => {
  test('undo accept deletes the created task and restores pending', () => {
    const { ctx, todo } = setup();
    const created = ctx.triageAct('q_meet1', 'accept').item.resultTaskId;
    const res = ctx.triageAct('q_meet1', 'undo');
    expect(todo.deleted).toEqual([created]);
    expect(res.item.status).toBe('pending');
    expect(res.item.resultTaskId).toBeNull();
    expect(res.item.resolvedAt).toBeNull();
    expect(res.item.canUndo).toBe(false);
    expect(res.message).toBe('Undone');
    // can be accepted again
    ctx.triageAct('q_meet1', 'accept');
    expect(calls(ctx, 'post', /\/tasks$/).length).toBe(2);
  });

  test('undo of a duplicate accept deletes the comment', () => {
    const { ctx, todo } = setup();
    ctx.triageAct('q_mail1', 'accept');
    const cid = todo.comments[0].id;
    ctx.triageAct('q_mail1', 'undo');
    expect(todo.deletedComments).toEqual([cid]);
    expect(ctx.Store.queueGet('q_mail1').status).toBe('pending');
  });

  test('undo of a waiting accept deletes the waiting task', () => {
    const { ctx, todo } = setup();
    const id = ctx.triageAct('q_wait1', 'accept').item.resultTaskId;
    ctx.triageAct('q_wait1', 'undo');
    expect(todo.deleted).toEqual([id]);
    expect(ctx.Store.queueGet('q_wait1').status).toBe('pending');
  });

  test('undo wait restores kind todo and deletes the waiting task', () => {
    const { ctx, todo } = setup();
    const id = ctx.triageAct('q_meet1', 'wait', { waitOn: 'Miro' }).item.resultTaskId;
    const res = ctx.triageAct('q_meet1', 'undo');
    expect(todo.deleted).toEqual([id]);
    expect(res.item).toMatchObject({ status: 'pending', kind: 'todo', waitOn: null, project: 'GR' });
  });

  test('task already deleted in Todoist is not an error', () => {
    const { ctx, todo } = setup();
    const id = ctx.triageAct('q_meet1', 'accept').item.resultTaskId;
    todo.tasks.find(t => t.id === id).deleted = true;
    const res = ctx.triageAct('q_meet1', 'undo');
    expect(res.item.status).toBe('pending');
    expect(res.message).toMatch(/already gone/);
  });

  test('undo dismiss restores pending and records that the dismissal was withdrawn', () => {
    const { ctx } = setup();
    ctx.triageAct('q_meet1', 'dismiss');
    const res = ctx.triageAct('q_meet1', 'undo');
    expect(res.item.status).toBe('pending');
    const undone = feedback(ctx, 'undone');
    expect(undone.length).toBe(1);
    expect(undone[0]).toMatchObject({ queueId: 'q_meet1', detail: { action: 'dismiss' } });
  });

  test('undo move/edit/undup restore fields in LIFO order', () => {
    const { ctx } = setup();
    ctx.triageAct('q_mail1', 'move', { project: 'Me', section: 'Outreach' });
    ctx.triageAct('q_mail1', 'edit', { title: 'Review UTSA doc' });
    ctx.triageAct('q_mail1', 'undup');
    let it = ctx.triageAct('q_mail1', 'undo').item;
    expect(it.notDuplicate).toBe(false);
    expect(it.title).toBe('Review UTSA doc');
    it = ctx.triageAct('q_mail1', 'undo').item;
    expect(it.title).toBe(emailDupItem().title);
    expect(it.project).toBe('Me');
    it = ctx.triageAct('q_mail1', 'undo').item;
    expect(it).toMatchObject({ project: 'ISC', section: 'Research' });
    expect(() => ctx.triageAct('q_mail1', 'undo')).toThrow(/Nothing to undo/);
  });

  test('undo stack is capped', () => {
    const { ctx } = setup();
    for (let n = 0; n < 14; n++) ctx.triageAct('q_meet1', 'edit', { title: 'Title ' + n });
    expect(ctx.Store.queueGet('q_meet1').undo.length).toBe(ctx.Triage.UNDO_MAX);
  });

  test('a Todoist error during undo keeps the item accepted', () => {
    const { ctx } = setup();
    ctx.triageAct('q_meet1', 'accept');
    ctx.__mocks.UrlFetchApp.__on('DELETE', /\/tasks\//, { status: 403, body: 'forbidden' });
    expect(() => ctx.triageAct('q_meet1', 'undo')).toThrow(/Could not delete the Todoist task/);
    const it = ctx.Store.queueGet('q_meet1');
    expect(it.status).toBe('accepted');
    expect(it.undo.length).toBe(1);
  });
});

// ------------------------------------------------------------------ review fixes

describe('feedback withdrawal round trip with Dedupe', () => {
  // A title pair Dedupe.matchTask really matches (containment 1.0), so suppression is observable.
  const DUP_TASK = { id: 't_utsa2', content: 'Review the UTSA doc for Marcus', project_id: 'p_isc' };
  const mk = () => {
    const { ctx } = setup({
      files: FILES.concat(['Dedupe.js']),
      tasks: [DUP_TASK],
      items: [emailDupItem({ dupTaskId: 't_utsa2', dupTaskTitle: DUP_TASK.content })]
    });
    let t = NOW.getTime();
    ctx.Util.now = () => new Date(t);
    const tick = () => { t += 60000; };
    // The two ways callers load feedback: Meetings/Slack (type filter) and Dedupe.notDuplicateFeedback.
    const match = () => ({
      typed: ctx.Dedupe.matchTask({ id: 'q_mail1', title: emailDupItem().title }, [DUP_TASK], ctx.Store.feedbackRecent(200, 'not_duplicate')),
      mixed: ctx.Dedupe.matchTask({ id: 'q_mail1', title: emailDupItem().title }, [DUP_TASK], ctx.Dedupe.notDuplicateFeedback())
    });
    return { ctx, tick, match };
  };
  const ids = m => [m.typed ? m.typed.taskId : null, m.mixed ? m.mixed.taskId : null];

  test('baseline: the pair matches, u suppresses it', () => {
    const { ctx, match } = mk();
    expect(ids(match())).toEqual(['t_utsa2', 't_utsa2']);
    ctx.triageAct('q_mail1', 'undup');
    expect(ids(match())).toEqual([null, null]);
  });

  test('u then u: clearing the flag un-suppresses the pair', () => {
    const { ctx, tick, match } = mk();
    ctx.triageAct('q_mail1', 'undup');
    tick();
    ctx.triageAct('q_mail1', 'undup');
    expect(ids(match())).toEqual(['t_utsa2', 't_utsa2']);
  });

  test('u then z: undoing the flag un-suppresses the pair', () => {
    const { ctx, tick, match } = mk();
    ctx.triageAct('q_mail1', 'undup');
    tick();
    ctx.triageAct('q_mail1', 'undo');
    expect(ctx.Store.queueGet('q_mail1').notDuplicate).toBe(false);
    expect(ids(match())).toEqual(['t_utsa2', 't_utsa2']);
    expect(feedback(ctx, 'undone').length).toBe(0); // state rows, not 'undone', for undup
  });

  test('u, u, z: undoing the clear suppresses the pair again', () => {
    const { ctx, tick, match } = mk();
    ctx.triageAct('q_mail1', 'undup');
    tick();
    ctx.triageAct('q_mail1', 'undup');
    tick();
    ctx.triageAct('q_mail1', 'undo');
    expect(ctx.Store.queueGet('q_mail1').notDuplicate).toBe(true);
    expect(ids(match())).toEqual([null, null]);
  });

  test('same-millisecond toggles still resolve newest-first', () => {
    const { ctx, match } = mk();
    ctx.Util.now = () => new Date(NOW.getTime());
    ctx.triageAct('q_mail1', 'undup');
    ctx.triageAct('q_mail1', 'undup');
    expect(ids(match())).toEqual(['t_utsa2', 't_utsa2']);
  });

  test('undo of dismiss/edit/move writes an undone row whose detail.at equals the withdrawn rows\' at', () => {
    const { ctx, tick } = mk();
    ctx.triageAct('q_mail1', 'edit', { title: 'Review UTSA doc' });
    tick();
    ctx.triageAct('q_mail1', 'undo');
    tick();
    ctx.triageAct('q_mail1', 'dismiss');
    tick();
    ctx.triageAct('q_mail1', 'undo');
    const dismissed = feedback(ctx, 'dismissed')[0];
    const edited = feedback(ctx, 'edited')[0];
    const undone = feedback(ctx, 'undone');
    expect(undone.map(u => u.detail.action)).toEqual(['dismiss', 'edit']);
    expect(undone[0].detail.at).toBe(dismissed.at);
    expect(undone[1].detail.at).toBe(edited.at);
    expect(undone.every(u => u.queueId === 'q_mail1')).toBe(true);
  });

  test('undo of an accept without edits writes no undone row; with edits it does', () => {
    const { ctx } = setup();
    ctx.triageAct('q_meet1', 'accept');
    ctx.triageAct('q_meet1', 'undo');
    expect(feedback(ctx, 'undone').length).toBe(0);
    ctx.triageAct('q_meet1', 'accept', { title: 'Reissue C3 credentials' });
    ctx.triageAct('q_meet1', 'undo');
    expect(feedback(ctx, 'undone').map(u => u.detail.action)).toEqual(['accept']);
  });
});

describe('no-op actions push no undo record', () => {
  test('move to the current destination after u: changed false, and z undoes the undup', () => {
    const { ctx } = setup();
    ctx.triageAct('q_mail1', 'undup');
    const res = ctx.triageAct('q_mail1', 'move', { project: 'ISC', section: 'Research' });
    expect(res.changed).toBe(false);
    expect(res.message).toMatch(/unchanged/);
    expect(ctx.Store.queueGet('q_mail1').undo.map(r => r.action)).toEqual(['undup']);
    const it = ctx.triageAct('q_mail1', 'undo').item;
    expect(it.notDuplicate).toBe(false);
    expect(it.project).toBe('ISC');
    expect(() => ctx.triageAct('q_mail1', 'undo')).toThrow(/Nothing to undo/);
  });

  test('unchanged edit and undup-to-current-state report changed false; real actions report true', () => {
    const { ctx } = setup();
    expect(ctx.triageAct('q_meet1', 'edit', { title: meetingItem().title }).changed).toBe(false);
    expect(ctx.triageAct('q_mail1', 'undup', { notDuplicate: false }).changed).toBe(false);
    expect(ctx.Store.queueGet('q_meet1').undo).toBeUndefined();
    expect(ctx.Store.queueGet('q_mail1').undo).toBeUndefined();
    expect(ctx.triageAct('q_meet1', 'edit', { title: 'New title' }).changed).toBe(true);
    expect(ctx.triageAct('q_meet1', 'undo').changed).toBe(true);
    expect(ctx.triageAct('q_meet1', 'accept').changed).toBe(true);
  });
});

describe('sections outage never drops a section', () => {
  const outage = ctx => ctx.__mocks.UrlFetchApp.__on('GET', req => req.url.indexOf(BASE + '/sections') === 0, { status: 500, body: 'down' });

  test('quick move while sections cannot load -> clear error, item unchanged, no feedback', () => {
    const { ctx } = setup();
    outage(ctx);
    expect(() => ctx.triageAct('q_meet1', 'move', { project: 'GR' })).toThrow(/Could not load the Todoist sections for GR.*HTTP 500/);
    expect(() => ctx.triageAct('q_meet1', 'move', { project: 'ISC' })).toThrow(/sections for ISC/);
    const it = ctx.Store.queueGet('q_meet1');
    expect(it).toMatchObject({ project: 'GR', section: 'Tech Projects' });
    expect(it.undo).toBeUndefined();
    expect(feedback(ctx, 'rerouted').length).toBe(0);
  });

  test('explicit section while sections cannot load -> error, not "does not exist"', () => {
    const { ctx } = setup();
    outage(ctx);
    expect(() => ctx.triageAct('q_meet1', 'move', { project: 'Me', section: 'Immediate' })).toThrow(/Could not load the Todoist sections for Me/);
  });

  test('moves that need no section lookup still work (project root, Waiting, item without a section)', () => {
    const { ctx } = setup({ items: [meetingItem(), meetingItem({ id: 'q_nosec', section: null })] });
    outage(ctx);
    expect(ctx.triageAct('q_meet1', 'move', { project: 'ISC', section: null }).item).toMatchObject({ project: 'ISC', section: null });
    expect(ctx.triageAct('q_nosec', 'move', { project: 'Me' }).item).toMatchObject({ project: 'Me', section: null });
    expect(ctx.triageAct('q_nosec', 'move', { project: 'Waiting' }).item.kind).toBe('waiting');
  });
});

describe('accept is safe to retry when saving fails after the Todoist side effect', () => {
  const failQueueUpdateOnce = ctx => {
    const real = ctx.Store.queueUpdate;
    let n = 0;
    ctx.Store.queueUpdate = function (id, patch) {
      if (n++ === 0) throw new Error('Service Spreadsheets timed out');
      return real.call(ctx.Store, id, patch);
    };
  };
  const live = todo => todo.tasks.filter(t => !t.deleted);

  test('new task: deleted again, item pending, retry creates exactly one task', () => {
    const { ctx, todo } = setup();
    const before = live(todo).length;
    failQueueUpdateOnce(ctx);
    expect(() => ctx.triageAct('q_meet1', 'accept')).toThrow(/Could not save the triage state \(Service Spreadsheets timed out\).*removed again, so it is safe to retry/);
    expect(todo.deleted.length).toBe(1);
    expect(live(todo).length).toBe(before);
    expect(ctx.Store.queueGet('q_meet1').status).toBe('pending');
    const res = ctx.triageAct('q_meet1', 'accept');
    expect(res.item.status).toBe('accepted');
    expect(live(todo).length).toBe(before + 1);
    expect(live(todo).filter(t => machine(t.description || '') && machine(t.description).q === 'q_meet1').length).toBe(1);
  });

  test('duplicate comment: deleted again, retry leaves one comment', () => {
    const { ctx, todo } = setup();
    failQueueUpdateOnce(ctx);
    expect(() => ctx.triageAct('q_mail1', 'accept')).toThrow(/comment it created was removed again/);
    ctx.triageAct('q_mail1', 'accept');
    expect(todo.comments.filter(c => !c.deleted).length).toBe(1);
  });

  test('waiting accept and wait are compensated too', () => {
    const { ctx, todo } = setup();
    failQueueUpdateOnce(ctx);
    expect(() => ctx.triageAct('q_wait1', 'accept')).toThrow(/safe to retry/);
    failQueueUpdateOnce(ctx);
    expect(() => ctx.triageAct('q_meet1', 'wait', { waitOn: 'Miro' })).toThrow(/safe to retry/);
    expect(live(todo).filter(t => t.project_id === 'p_wait').length).toBe(0);
    expect(feedback(ctx, 'rerouted').length).toBe(0);
  });

  test('when the compensating delete fails too, the error says to check Todoist', () => {
    const { ctx } = setup();
    failQueueUpdateOnce(ctx);
    ctx.__mocks.UrlFetchApp.__on('DELETE', /\/tasks\//, { status: 403, body: 'forbidden' });
    expect(() => ctx.triageAct('q_meet1', 'accept')).toThrow(/could not be removed: check Todoist before retrying/);
  });

  test('edit feedback in an accept is written only after the state is saved', () => {
    const { ctx } = setup();
    failQueueUpdateOnce(ctx);
    expect(() => ctx.triageAct('q_meet1', 'accept', { title: 'Reissue C3 credentials' })).toThrow();
    expect(feedback(ctx, 'edited').length).toBe(0);
  });

  test('a feedback write failure does not fail or roll back the action', () => {
    const { ctx } = setup();
    ctx.Store.feedbackAdd = () => { throw new Error('sheet busy'); };
    const res = ctx.triageAct('q_meet1', 'dismiss');
    expect(res.item.status).toBe('dismissed');
    expect(res.message).toMatch(/feedback not recorded/);
    expect(ctx.Store.queueGet('q_meet1').status).toBe('dismissed');
  });
});

describe('TriageUI.html call queue', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'TriageUI.html'), 'utf8');
  const block = (html.match(/\/\/ -+ call queue \(begin\)([\s\S]*?)\/\/ -+ call queue \(end\)/) || [])[1];
  const load = () => {
    const pending = [];
    const call = (fn, args, ok, fail) => pending.push({ fn, args, ok, fail });
    const api = new Function('call', block + '; return {queuedCall: queuedCall, state: function(){return {inflight: inflight, queued: callQueue.length}}, MAX: MAX_INFLIGHT};')(call);
    return Object.assign(api, { pending });
  };

  test('never more than MAX_INFLIGHT calls in flight; each completion starts the next', () => {
    const q = load();
    const results = [];
    for (let n = 0; n < 40; n++) q.queuedCall('triageAct', ['q' + n, 'accept', null], r => results.push(r), e => results.push('E' + e.message));
    expect(q.MAX).toBeLessThanOrEqual(5);
    expect(q.pending.length).toBe(q.MAX);
    expect(q.state()).toEqual({ inflight: q.MAX, queued: 40 - q.MAX });
    let done = 0;
    while (done < q.pending.length) {
      const c = q.pending[done++];
      if (done % 7 === 0) c.fail(new Error('x')); else c.ok(c.args[0]);
      expect(q.state().inflight).toBeLessThanOrEqual(q.MAX);
    }
    expect(q.pending.length).toBe(40);
    expect(results.length).toBe(40);
    expect(q.pending.map(c => c.args[0])).toEqual(Array.from({ length: 40 }, (_, n) => 'q' + n));
    expect(q.state()).toEqual({ inflight: 0, queued: 0 });
  });

  test('a synchronous failure (not connected) still drains the queue', () => {
    const fails = [];
    const api = new Function('call', block + '; return queuedCall;')((fn, args, ok, fail) => fail(new Error('Not connected')));
    for (let n = 0; n < 12; n++) api('triageAct', [n], () => {}, e => fails.push(e.message));
    expect(fails.length).toBe(12);
  });

  test('bulk actions and undo use the queue, and no-ops are left out of the undo entry', () => {
    const script = (html.match(/<script>([\s\S]*)<\/script>/) || [])[1] || '';
    expect(script).toContain('queuedCall("triageAct",[i.id,action,patches[n]]');
    expect(script).toContain('queuedCall("triageAct",[i.id,"undo",null]');
    expect(script).not.toMatch(/\bcall\("triageAct"/);
    expect(script).toMatch(/res\.changed===false\)noops\.push/);
  });
});

// ------------------------------------------------------------------ TriageUI.html (static contract)

describe('TriageUI.html', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'TriageUI.html'), 'utf8');
  const script = (html.match(/<script>([\s\S]*)<\/script>/) || [])[1] || '';

  test('script parses and uses google.script.run for both server functions', () => {
    expect(() => new Function(script)).not.toThrow();
    expect(script).toContain('google.script.run');
    expect(script).toMatch(/call\("triageList"/);
    expect(script).toMatch(/[cC]all\("triageAct"/);
    expect(script).toContain('withFailureHandler');
  });

  test('no prototype badge, example items or scriptlet markers', () => {
    expect(html).not.toMatch(/Prototype ·|class="proto"|nothing is sent to Todoist/);
    expect(html).not.toMatch(/example:true|Example: a message/);
    expect(html).not.toContain('<?');
    expect(html).not.toMatch(/Jon Stumpf|Vaish/);
  });

  test('exact keymap: j k x s 1-4 v w e u o Enter z Esc ? f, and no "a" key', () => {
    ['j', 'k', 'x', 's', 'v', 'w', 'e', 'u', 'o', 'Enter', 'z', '?', 'f', '1', '2', '3', '4']
      .forEach(k => expect(script).toContain('k==="' + k + '"'));
    expect(script).toContain('e.key==="Escape"');
    expect(script).not.toMatch(/k===["']a["']/);
    expect(script).not.toMatch(/key===["']a["']/);
  });

  test('both themes via prefers-color-scheme tokens; phone layout', () => {
    expect(html).toMatch(/@media \(prefers-color-scheme: dark\)/);
    expect(html).toMatch(/--bg:#111318/);
    expect(html).toMatch(/max-width:860px/);
    expect(html).toContain('safe-area-inset-bottom');
  });

  test('filtered-emails footer, loading and empty states', () => {
    expect(script).toContain('renderFiltered');
    expect(script).toContain('Filtered out before you saw them');
    expect(script).toContain('skel');
    expect(script).toContain('All caught up.');
    expect(script).toContain('Try again');
  });
});
