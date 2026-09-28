/**
 * End-to-end integration: ALL root production files loaded together (one shared global scope,
 * like Apps Script). Only the outside world is faked:
 *   - UrlFetchApp: a stateful fake Todoist API v1 server, the Granola public API and the
 *     Anthropic Messages API, routed by URL;
 *   - SpreadsheetApp / CalendarApp / CacheService / LockService / PropertiesService from mocks.js.
 * Assertions are made on the real HTTP requests the code sends (URL, method, JSON body).
 *
 * Each "execution" (a trigger firing) starts with fresh in-memory module caches, as in Apps
 * Script; Script Properties, CacheService and the state spreadsheet persist between them.
 */
const { loadGas } = require('./helpers/gas');

const NOW = new Date('2026-09-25T17:00:00Z'); // Fri 25 Sep 10:00 America/Los_Angeles
const TODOIST = 'https://api.todoist.com/api/v1';
const GRANOLA = 'https://public-api.granola.ai/v1';
const CLAUDE = 'https://api.anthropic.com/v1/messages';
const TRIAGE_URL = 'https://script.google.com/macros/s/AKfyTRIAGE/exec';

const NOTE_ID = 'not_sync0924';
const NOTE_KEY = 'granola:' + NOTE_ID;
const CAL_EVENT_ID = '5q1h8v0c2k9d3e7f_20260924T160000Z';

const SECTIONS = {
  GR: ['Reach Out', 'Team Logistics', 'Team Updates', 'Conferences', 'KubeCon / Armada / CNCF Batch', 'Arctos',
    'Tech Projects', 'Blogs', 'Hiring', 'EA', 'Generated Tasks'],
  ISC: ['Reach Out', 'Logistics', 'Marketing', 'Quantum', 'Research', 'ISC Events', 'EA'],
  Me: ['Immediate', 'Logistics', 'Outreach', 'Tech', 'Cars', 'To Buy'],
  SG: []
};

// ------------------------------------------------------------------ fixtures

const granolaNote = {
  id: NOTE_ID,
  object: 'note',
  title: 'Secure Copy/Paste Internal Sync',
  owner: { name: 'Alex Scammon', email: 'alex@gr-oss.io' },
  created_at: '2026-09-24T16:00:12Z',
  updated_at: '2026-09-24T16:48:03Z',
  web_url: 'https://notes.granola.ai/d/' + NOTE_ID,
  calendar_event: {
    event_title: 'Secure Copy/Paste Internal Sync',
    invitees: [{ email: 'miro.knejp@gresearch.co.uk' }, { email: 'mihailo.marinkovic@gresearch.co.uk' },
      { email: 'alex.blundell@insightsoftmax.com' }],
    organiser: 'alex@gr-oss.io',
    calendar_event_id: CAL_EVENT_ID,
    scheduled_start_time: '2026-09-24T16:00:00Z',
    scheduled_end_time: '2026-09-24T16:30:00Z'
  },
  attendees: [
    { name: 'Alex Scammon', email: 'alex@gr-oss.io' },
    { name: 'Miro Knejp', email: 'miro.knejp@gresearch.co.uk' },
    { name: 'Mihailo Marinkovic', email: 'mihailo.marinkovic@gresearch.co.uk' },
    { name: 'Alex Blundell', email: 'alex.blundell@insightsoftmax.com' }
  ],
  summary_markdown: '### Secure Copy/Paste\n- C++ rewrite of the clipboard tool is on track\n' +
    '- Alex to send the design doc to Miro\n- Mihailo will share the OmniSSA clipboard API test results\n' +
    '- Alex Blundell to send the AWS invoice to Marcus',
  transcript: [
    { speaker: { source: 'microphone', attribution: 'me' }, text: "Let's go through the C++ rewrite status.",
      start_time: '2026-09-24T16:00:30Z', end_time: '2026-09-24T16:00:34Z' },
    { speaker: { source: 'speaker', attribution: 'them', name: 'Miro Knejp' }, text: 'The clipboard hooks compile now; I need the design doc to finish the interface.',
      start_time: '2026-09-24T16:01:10Z', end_time: '2026-09-24T16:01:18Z' },
    { speaker: { source: 'microphone', attribution: 'me' }, text: "I'll send you the design doc for the C++ rewrite by tomorrow.",
      start_time: '2026-09-24T16:01:35Z', end_time: '2026-09-24T16:01:40Z' },
    { speaker: { source: 'speaker', attribution: 'them', name: 'Mihailo Marinkovic' }, text: "I'll share the OmniSSA clipboard API test results with you by next Friday.",
      start_time: '2026-09-24T16:03:00Z', end_time: '2026-09-24T16:03:06Z' },
    { speaker: { source: 'speaker', attribution: 'them', name: 'Alex Blundell' }, text: "And I'll send the AWS invoice to Marcus this week.",
      start_time: '2026-09-24T16:05:00Z', end_time: '2026-09-24T16:05:04Z' }
  ]
};

/** Plausible `emit` output for the meeting above (Claude is the only thing we script). */
const emitItems = {
  items: [
    {
      title: 'Send the C++ rewrite design doc to Miro', kind: 'todo', owner: 'me', ownerName: null, ownerEmail: null,
      category: 'action', quote: "I'll send you the design doc for the C++ rewrite by tomorrow.",
      why: 'Alex committed to sending Miro the design doc.', due: '2026-09-25', resurface: null,
      confidence: 'high', project: 'GR', section: 'Tech Projects', timestampSec: 65
    },
    {
      title: 'Send the AWS invoice to Marcus', kind: 'todo', owner: 'other', ownerName: 'Alex Blundell',
      ownerEmail: 'alex.blundell@insightsoftmax.com', category: 'action',
      quote: "And I'll send the AWS invoice to Marcus this week.", why: 'Alex Blundell committed to it.',
      due: null, resurface: null, confidence: 'high', project: 'ISC', section: null, timestampSec: 270
    },
    {
      // Mis-labelled by the model as Alex's own (owner "me"), but pinned on Alex Blundell.
      title: 'Book the ISC offsite venue', kind: 'todo', owner: 'me', ownerName: 'Alex Blundell',
      ownerEmail: null, category: 'action', quote: 'Alex, can you book the offsite venue?',
      why: 'Asked of Alex.', due: null, resurface: null, confidence: 'high', project: 'ISC', section: 'Logistics', timestampSec: 280
    },
    {
      title: 'Alex Blundell to renew the AWS partner listing', kind: 'todo', owner: 'me', ownerName: null,
      ownerEmail: null, category: 'action', quote: 'Alex Blundell will renew the listing.',
      why: 'Listing renewal.', due: null, resurface: null, confidence: 'high', project: 'ISC', section: null, timestampSec: 290
    },
    {
      title: 'Share the OmniSSA clipboard API test results', kind: 'waiting', owner: 'other',
      ownerName: 'Mihailo Marinkovic', ownerEmail: 'mihailo.marinkovic@gresearch.co.uk', category: 'action',
      quote: "I'll share the OmniSSA clipboard API test results with you by next Friday.",
      why: 'Mihailo owes Alex the test results.', due: null, resurface: '2026-10-02',
      confidence: 'high', project: 'GR', section: 'Tech Projects', timestampSec: 150
    },
    {
      title: 'Keep the C++ rewrite on the current schedule', kind: 'todo', owner: 'me', ownerName: null, ownerEmail: null,
      category: 'decision', quote: 'The C++ rewrite is on track.', why: 'A decision.', due: null, resurface: null,
      confidence: 'med', project: 'GR', section: null, timestampSec: 0
    }
  ]
};

function calendarEvents() {
  return {
    'alex@gr-oss.io': [
      {
        id: CAL_EVENT_ID + '@google.com', title: 'Secure Copy/Paste Internal Sync',
        start: '2026-09-24T16:00:00Z', end: '2026-09-24T16:30:00Z', location: 'https://meet.google.com/abc-defg-hij',
        isOwnedByMe: true, myStatus: 'OWNER',
        guests: [{ email: 'alex@gr-oss.io', status: 'OWNER' }, { email: 'miro.knejp@gresearch.co.uk', name: 'Miro Knejp' },
          { email: 'mihailo.marinkovic@gresearch.co.uk', name: 'Mihailo Marinkovic' },
          { email: 'alex.blundell@insightsoftmax.com', name: 'Alex Blundell' }]
      },
      {
        id: 'arctos0923steering@google.com', title: 'Arctos Alliance Steering',
        start: '2026-09-23T18:00:00Z', end: '2026-09-23T18:45:00Z', location: '',
        description: 'Join Zoom: https://zoom.us/j/123456789', myStatus: 'YES',
        guests: [{ email: 'alex@gr-oss.io', status: 'YES' }, { email: 'chair@arctosalliance.org', name: 'Arctos Chair' }]
      }
    ],
    'alex@insightsoftmax.com': [],
    'alex@alexscammon.com': []
  };
}

// ------------------------------------------------------------------ fake Todoist API v1 server

function createTodoistServer() {
  const s = { projects: [], sections: [], tasks: [], labels: [], comments: [], n: 100 };
  const nextId = p => p + (++s.n);
  const addProject = (name, extra) => {
    const p = Object.assign({ id: nextId('p'), name, inbox_project: false, is_archived: false, parent_id: null }, extra || {});
    s.projects.push(p);
    return p;
  };
  const inbox = addProject('Inbox', { inbox_project: true });
  const byKey = { Inbox: inbox };
  ['GR', 'ISC', 'Me', 'SG'].forEach(k => {
    byKey[k] = addProject(k);
    SECTIONS[k].forEach((name, i) => s.sections.push({ id: nextId('s'), project_id: byKey[k].id, name, section_order: i + 1 }));
  });
  s.labels.push({ id: nextId('l'), name: 'starred' });
  // An unrelated open task that must not be treated as a duplicate.
  s.tasks.push({
    id: nextId('t'), content: 'Book flights to KubeCon NA', description: '', project_id: byKey.GR.id,
    section_id: s.sections.find(x => x.project_id === byKey.GR.id && x.name === 'Conferences').id,
    labels: [], due: null, checked: false, is_deleted: false
  });

  const page = results => ({ json: { results, next_cursor: null } });
  const err = (status, msg) => ({ status, body: JSON.stringify({ error: msg }) });

  function handle(req) {
    const path = req.url.slice(TODOIST.length).split('?')[0];
    const q = req.query;
    const body = req.json || {};
    const m = req.method;
    if (req.headers.Authorization !== 'Bearer todoist-token') return err(401, 'unauthorized');
    if (m === 'GET' && path === '/projects') return page(s.projects);
    if (m === 'POST' && path === '/projects') {
      if (!body.name) return err(400, 'name required');
      return { json: addProject(body.name) };
    }
    if (m === 'GET' && path === '/sections') return page(s.sections.filter(x => x.project_id === q.project_id));
    if (m === 'GET' && path === '/labels') return page(s.labels);
    if (m === 'POST' && path === '/labels') {
      const l = { id: nextId('l'), name: body.name };
      s.labels.push(l);
      return { json: l };
    }
    if (m === 'GET' && path === '/tasks') {
      return page(s.tasks.filter(t => !t.checked && !t.is_deleted && (!q.project_id || t.project_id === q.project_id)));
    }
    if (m === 'POST' && path === '/tasks') {
      if (!body.content) return err(400, 'content required');
      const pid = body.project_id || inbox.id;
      if (!s.projects.some(p => p.id === pid)) return err(400, 'project not found');
      if (body.section_id && !s.sections.some(x => x.id === body.section_id && x.project_id === pid)) {
        return err(400, 'section not in project');
      }
      const t = {
        id: nextId('t'), content: body.content, description: body.description || '', project_id: pid,
        section_id: body.section_id || null, labels: body.labels || [], priority: body.priority || 1,
        due: body.due_date ? { date: body.due_date, is_recurring: false, string: body.due_date } : null,
        checked: false, is_deleted: false
      };
      s.tasks.push(t);
      return { json: t };
    }
    if (m === 'POST' && path === '/comments') {
      const c = { id: nextId('c'), task_id: body.task_id, content: body.content };
      s.comments.push(c);
      return { json: c };
    }
    let mm = /^\/tasks\/([^/]+)(?:\/(close|reopen|move))?$/.exec(path);
    if (mm) {
      const t = s.tasks.find(x => x.id === decodeURIComponent(mm[1]) && !x.is_deleted);
      if (!t) return err(404, 'task not found');
      if (m === 'DELETE' && !mm[2]) { t.is_deleted = true; return { status: 204, text: '' }; }
      if (m === 'GET' && !mm[2]) return { json: t };
      if (m === 'POST' && mm[2] === 'close') { t.checked = true; return { status: 204, text: '' }; }
      if (m === 'POST' && mm[2] === 'reopen') { t.checked = false; return { status: 204, text: '' }; }
      if (m === 'POST' && !mm[2]) {
        ['content', 'description', 'labels', 'priority'].forEach(k => { if (body[k] !== undefined) t[k] = body[k]; });
        if (body.due_date) t.due = { date: body.due_date, is_recurring: false, string: body.due_date };
        if (body.due_string === 'no date') t.due = null;
        return { json: t };
      }
    }
    return err(404, 'fake Todoist: no route for ' + m + ' ' + path);
  }

  return {
    state: s,
    handle,
    project: k => s.projects.find(p => p.name === k),
    section: (k, name) => s.sections.find(x => x.project_id === s.projects.find(p => p.name === k).id && x.name === name),
    openTasks: () => s.tasks.filter(t => !t.checked && !t.is_deleted)
  };
}

// ------------------------------------------------------------------ world

function world() {
  const props = {
    TODOIST_API_TOKEN: 'todoist-token',
    ANTHROPIC_API_KEY: 'anthropic-key',
    CLAUDE_MODEL: 'claude-sonnet-5',
    GRANOLA_API_KEY: 'granola-key',
    TRIAGE_URL: TRIAGE_URL
  };
  const ctx = loadGas(undefined, { props });
  const mocks = ctx.__mocks;
  const todoist = createTodoistServer();
  const claudeResponses = [];

  const cals = calendarEvents();
  Object.keys(cals).forEach(id => mocks.CalendarApp.__addCalendar(id, cals[id]));

  const U = mocks.UrlFetchApp;
  U.__on('*', req => req.url.indexOf(TODOIST + '/') === 0, req => todoist.handle(req));
  U.__on('GET', req => req.url.split('?')[0] === GRANOLA + '/notes', req => {
    if (req.headers.Authorization !== 'Bearer granola-key') return { status: 401, body: '{}' };
    const { transcript, ...summary } = granolaNote; // eslint-disable-line no-unused-vars
    return { json: { notes: [summary], hasMore: false, cursor: null } };
  });
  U.__on('GET', req => req.url.split('?')[0] === GRANOLA + '/notes/' + NOTE_ID, req => {
    if (req.query.include !== 'transcript') {
      const { transcript, ...rest } = granolaNote; // eslint-disable-line no-unused-vars
      return { json: rest };
    }
    return { json: granolaNote };
  });
  U.__on('POST', CLAUDE, req => {
    const input = claudeResponses.length ? claudeResponses.shift() : { items: [] };
    return {
      json: {
        id: 'msg_1', type: 'message', role: 'assistant', model: req.json.model, stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'emit', input }],
        usage: { input_tokens: 1200, output_tokens: 300 }
      }
    };
  });

  /** A new trigger execution: fresh in-memory caches; Properties/Cache/Sheet persist. */
  const newExecution = () => {
    ctx.Todoist.resetCache(false);
    ctx.Store.reset();
    ctx.Util.now = () => new Date(NOW.getTime());
  };
  newExecution();

  const calls = (method, pathOrRe) => U.__calls.filter(c => c.method === method &&
    (typeof pathOrRe === 'string' ? c.url.split('?')[0] === pathOrRe : pathOrRe.test(c.url)));
  const mark = () => U.__calls.length;
  const since = n => U.__calls.slice(n);

  return { ctx, mocks, todoist, claudeResponses, newExecution, calls, mark, since };
}

function runMeetingsOnce(w) {
  w.newExecution();
  w.claudeResponses.push(JSON.parse(JSON.stringify(emitItems)));
  return w.ctx.runMeetings();
}

// ------------------------------------------------------------------ tests

describe('Integration: runMeetings end to end', () => {
  test('one direct GR task, nothing for Alex Blundell, owed item queued as waiting, ledger; rerun is a no-op', () => {
    const w = world();
    const res = runMeetingsOnce(w);
    expect(res).toMatchObject({ job: 'meetings', created: 1, queued: 1, errors: 0 });

    // Granola: list + note with inline transcript, authenticated.
    const list = w.calls('GET', GRANOLA + '/notes');
    expect(list).toHaveLength(1);
    expect(list[0].headers.Authorization).toBe('Bearer granola-key');
    expect(list[0].query.updated_after).toBe('2026-09-23T17:00:00.000Z'); // first run: now - 2 days
    const noteGets = w.calls('GET', GRANOLA + '/notes/' + NOTE_ID);
    expect(noteGets).toHaveLength(1);
    expect(noteGets[0].query.include).toBe('transcript');

    // Claude: one forced-tool call with the right headers and a transcript that marks who is who.
    const claude = w.calls('POST', CLAUDE);
    expect(claude).toHaveLength(1);
    expect(claude[0].headers['x-api-key']).toBe('anthropic-key');
    expect(claude[0].headers['anthropic-version']).toBe('2023-06-01');
    const cb = claude[0].json;
    expect(cb.model).toBe('claude-sonnet-5');
    expect(cb.tool_choice).toEqual({ type: 'tool', name: 'emit' });
    expect(cb.tools).toHaveLength(1);
    expect(cb.tools[0].name).toBe('emit');
    expect(cb.tools[0].input_schema.type).toBe('object');
    const user = cb.messages[0].content;
    expect(cb.messages[0].role).toBe('user');
    expect(user).toContain('[01:05] ALEX: I\'ll send you the design doc for the C++ rewrite by tomorrow.');
    expect(user).toContain('OTHER (Alex Blundell, NOT Alex Scammon): And I\'ll send the AWS invoice to Marcus this week.');
    expect(user).toContain('Title: Secure Copy/Paste Internal Sync');
    expect(user).toMatch(/Tech Projects/);
    expect(user).not.toMatch(/Generated Tasks/);

    // Todoist: exactly one task created, in GR › Tech Projects, with the DESIGN description.
    const creates = w.calls('POST', TODOIST + '/tasks');
    expect(creates).toHaveLength(1);
    const body = creates[0].json;
    const gr = w.todoist.project('GR');
    expect(body).toEqual({
      content: 'Send the C++ rewrite design doc to Miro',
      description: expect.any(String),
      project_id: gr.id,
      section_id: w.todoist.section('GR', 'Tech Projects').id,
      labels: ['meeting'],
      due_date: '2026-09-25'
    });
    expect(creates[0].headers.Authorization).toBe('Bearer todoist-token');
    const qid = w.ctx.Store.queueId('meeting', NOTE_KEY, 'Send the C++ rewrite design doc to Miro');
    const lines = body.description.split('\n');
    expect(lines).toEqual([
      'Meeting: Secure Copy/Paste Internal Sync · Thu 24 Sep',
      '[Open in Granola](https://notes.granola.ai/d/' + NOTE_ID + ')',
      'Attendees: Miro Knejp, Mihailo Marinkovic, Alex Blundell',
      '> I\'ll send you the design doc for the C++ rewrite by tomorrow.',
      '<!-- ta:{"key":"' + NOTE_KEY + '","q":"' + qid + '"} -->'
    ]);
    expect(w.ctx.Todoist.parseMachineLine(body.description)).toEqual({ key: NOTE_KEY, q: qid });
    // Label created lazily because it did not exist.
    expect(w.calls('POST', TODOIST + '/labels').map(c => c.json.name)).toEqual(['meeting']);

    // Nothing anywhere for Alex Blundell's item (nor the decision).
    const allBodies = JSON.stringify(w.mocks.UrlFetchApp.__calls.filter(c => c.url.indexOf(TODOIST) === 0).map(c => c.json));
    expect(allBodies).not.toMatch(/AWS invoice|offsite venue|partner listing/);
    const queue = w.ctx.Store.queueList({});
    expect(queue.map(q => q.title)).toEqual(['Share the OmniSSA clipboard API test results']);

    // Owed item queued as waiting.
    expect(queue[0]).toMatchObject({
      status: 'pending', source: 'meeting', sourceKey: NOTE_KEY, kind: 'waiting',
      waitOn: 'Mihailo Marinkovic', waitOnEmail: 'mihailo.marinkovic@gresearch.co.uk', resurface: '2026-10-02',
      project: 'GR', section: 'Tech Projects', origin: 'Granola · Secure Copy/Paste Internal Sync · Thu 24 Sep',
      link: 'https://notes.granola.ai/d/' + NOTE_ID, dupTaskId: null
    });

    // Ledger + run log + cursor.
    const task = w.todoist.openTasks().find(t => t.content === body.content);
    const led = w.ctx.Store.ledgerGet(NOTE_KEY);
    expect(led).toMatchObject({ key: NOTE_KEY, outcome: 'tasks' });
    expect(led.taskIds.map(String)).toEqual([String(task.id)]);
    expect(led.queueIds).toEqual([queue[0].id]);
    expect(w.ctx.Store.kvGet('granola.updatedAfter', null)).toBe('2026-09-24T16:48:03.000Z');
    const runs = w.ctx.Store.runsRecent(5, 'meetings');
    expect(runs.length).toBe(1);

    // Second run: the note is listed again but skipped via the ledger.
    const before = w.mark();
    const res2 = runMeetingsOnce(w);
    const after = w.since(before);
    expect(res2).toMatchObject({ created: 0, queued: 0, errors: 0 });
    expect(after.filter(c => c.url === CLAUDE)).toHaveLength(0);
    expect(after.filter(c => c.url.split('?')[0] === GRANOLA + '/notes/' + NOTE_ID)).toHaveLength(0);
    expect(after.filter(c => c.method === 'POST' && c.url.indexOf(TODOIST) === 0)).toHaveLength(0);
    expect(after.filter(c => c.url.split('?')[0] === GRANOLA + '/notes')[0].query.updated_after).toBe('2026-09-24T16:48:03.000Z');
    expect(w.todoist.openTasks()).toHaveLength(2); // pre-existing + ours
    expect(w.ctx.Store.queueList({})).toHaveLength(1);
  });
});

describe('Integration: triage web app', () => {
  test('triageList shows the queued item; accept creates the Waiting task; undo deletes it and restores pending', () => {
    const w = world();
    runMeetingsOnce(w);

    w.newExecution();
    const listed = w.ctx.triageList();
    expect(listed.items).toHaveLength(1);
    const item = listed.items[0];
    expect(item).toMatchObject({ kind: 'waiting', title: 'Share the OmniSSA clipboard API test results', status: 'pending', canUndo: false });
    expect(listed.sections.GR).toContain('Tech Projects');
    expect(listed.sections.GR).not.toContain('Generated Tasks');
    expect(listed.warnings).toEqual([]);

    w.newExecution();
    const before = w.mark();
    const res = w.ctx.triageAct(item.id, 'accept');
    const reqs = w.since(before);

    // "Waiting on others" did not exist: created once.
    const projPosts = reqs.filter(c => c.method === 'POST' && c.url === TODOIST + '/projects');
    expect(projPosts.map(c => c.json)).toEqual([{ name: 'Waiting on others' }]);
    const waitingProject = w.todoist.project('Waiting on others');
    expect(waitingProject).toBeTruthy();

    const creates = reqs.filter(c => c.method === 'POST' && c.url === TODOIST + '/tasks');
    expect(creates).toHaveLength(1);
    const body = creates[0].json;
    expect(body).toMatchObject({
      content: 'Mihailo Marinkovic: Share the OmniSSA clipboard API test results',
      project_id: waitingProject.id,
      labels: ['waiting'],
      due_date: '2026-10-02'
    });
    expect(body.section_id).toBeUndefined();
    const ml = w.ctx.Todoist.parseMachineLine(body.description);
    expect(ml).toMatchObject({
      key: NOTE_KEY, q: item.id, dest: 'GR/Tech Projects', owner: 'Mihailo Marinkovic',
      email: 'mihailo.marinkovic@gresearch.co.uk', since: '2026-09-25'
    });
    expect(body.description.split('\n').pop()).toMatch(/^<!-- ta:\{.*\} -->$/);
    expect(body.description).toContain('Waiting on: Mihailo Marinkovic <mihailo.marinkovic@gresearch.co.uk>');
    expect(reqs.filter(c => c.method === 'POST' && c.url === TODOIST + '/labels').map(c => c.json.name)).toEqual(['waiting']);

    const createdId = String(w.todoist.openTasks().find(t => t.content === body.content).id);
    expect(res.item).toMatchObject({ status: 'waiting', resultTaskId: createdId, canUndo: true });
    expect(w.ctx.Store.queueGet(item.id).status).toBe('waiting');
    expect(w.ctx.triageList().items).toHaveLength(0);

    // Undo.
    w.newExecution();
    const b2 = w.mark();
    const undone = w.ctx.triageAct(item.id, 'undo');
    const r2 = w.since(b2);
    const dels = r2.filter(c => c.method === 'DELETE');
    expect(dels.map(c => c.url)).toEqual([TODOIST + '/tasks/' + encodeURIComponent(createdId)]);
    expect(w.todoist.openTasks().some(t => String(t.id) === createdId)).toBe(false);
    expect(undone.item).toMatchObject({ status: 'pending', resultTaskId: null, canUndo: false });
    const stored = w.ctx.Store.queueGet(item.id);
    expect(stored.status).toBe('pending');
    expect(stored.resolvedAt == null).toBe(true);
    w.newExecution();
    expect(w.ctx.triageList().items.map(i => i.id)).toEqual([item.id]);
  });
});

describe('Integration: daily checks keep exactly one task each', () => {
  test('runSummaryCheck creates one Me › Immediate task, and a second run leaves it alone', () => {
    const w = world();
    runMeetingsOnce(w);

    w.newExecution();
    const b1 = w.mark();
    const s1 = w.ctx.runSummaryCheck();
    const r1 = w.since(b1);
    expect(s1).toMatchObject({ missing: 1, created: 1, errors: 0 });
    // Granola listing for the window.
    const gl = r1.filter(c => c.url.split('?')[0] === GRANOLA + '/notes');
    expect(gl).toHaveLength(1);
    expect(gl[0].query.created_after).toBe('2026-09-17T17:00:00.000Z');
    const creates = r1.filter(c => c.method === 'POST' && c.url === TODOIST + '/tasks');
    expect(creates).toHaveLength(1);
    const body = creates[0].json;
    expect(body).toMatchObject({
      content: 'Open 1 Granola note without a summary',
      project_id: w.todoist.project('Me').id,
      section_id: w.todoist.section('Me', 'Immediate').id,
      labels: ['check']
    });
    expect(body.description).toContain('Arctos Alliance Steering');
    expect(body.description).not.toContain('Secure Copy/Paste'); // has its Granola note
    expect(body.description).toContain('https://notes.granola.ai/');
    expect(w.ctx.Todoist.parseMachineLine(body.description)).toEqual({ key: 'check:summaries' });

    w.newExecution();
    const b2 = w.mark();
    const s2 = w.ctx.runSummaryCheck();
    const r2 = w.since(b2);
    expect(s2).toMatchObject({ missing: 1, created: 0, updated: 0, errors: 0 });
    expect(r2.filter(c => c.method === 'POST' && c.url.indexOf(TODOIST) === 0)).toHaveLength(0);
    expect(w.todoist.openTasks().filter(t => /Granola note/.test(t.content))).toHaveLength(1);
  });

  test('runTriageDigest maintains one "Triage N" task and closes it when the queue empties', () => {
    const w = world();
    runMeetingsOnce(w);

    w.newExecution();
    const b1 = w.mark();
    const d1 = w.ctx.runTriageDigest();
    const r1 = w.since(b1);
    expect(d1).toMatchObject({ pending: 1, created: 1, errors: 0, url: TRIAGE_URL });
    const creates = r1.filter(c => c.method === 'POST' && c.url === TODOIST + '/tasks');
    expect(creates).toHaveLength(1);
    expect(creates[0].json).toMatchObject({
      content: 'Triage 1 suggestion',
      project_id: w.todoist.project('Me').id,
      section_id: w.todoist.section('Me', 'Immediate').id,
      labels: ['check'],
      due_date: '2026-09-25'
    });
    expect(creates[0].json.description).toContain('[Open triage](' + TRIAGE_URL + ')');
    expect(w.ctx.Todoist.parseMachineLine(creates[0].json.description)).toEqual({ key: 'check:triage' });
    const digestId = String(w.todoist.openTasks().find(t => t.content === 'Triage 1 suggestion').id);

    // Second run, same queue: nothing written.
    w.newExecution();
    const b2 = w.mark();
    const d2 = w.ctx.runTriageDigest();
    expect(d2).toMatchObject({ pending: 1, created: 0, updated: 0, taskId: digestId });
    expect(w.since(b2).filter(c => c.method !== 'GET')).toHaveLength(0);
    expect(w.todoist.openTasks().filter(t => /^Triage \d+ suggestion/.test(t.content))).toHaveLength(1);

    // Queue emptied (accepted) -> the digest task is closed.
    w.newExecution();
    const id = w.ctx.triageList().items[0].id;
    w.ctx.triageAct(id, 'accept');
    w.newExecution();
    const b3 = w.mark();
    const d3 = w.ctx.runTriageDigest();
    expect(d3).toMatchObject({ pending: 0, closed: 1 });
    const closes = w.since(b3).filter(c => c.method === 'POST' && /\/close$/.test(c.url));
    expect(closes.map(c => c.url)).toEqual([TODOIST + '/tasks/' + encodeURIComponent(digestId) + '/close']);
    expect(w.todoist.openTasks().filter(t => /^Triage \d+ suggestion/.test(t.content))).toHaveLength(0);
  });
});

describe('Integration: dismissal feedback reaches the extractor, and undo withdraws it', () => {
  test('dismiss adds a negative example to the next Claude prompt; undo removes it', () => {
    const w = world();
    runMeetingsOnce(w);
    const title = 'Share the OmniSSA clipboard API test results';

    w.newExecution();
    const id = w.ctx.triageList().items[0].id;
    w.ctx.triageAct(id, 'dismiss');
    w.newExecution();
    expect(w.ctx.Extract.dismissals_().map(f => f.title)).toEqual([title]);
    expect(w.ctx.Extract.systemPrompt('meeting', { feedback: w.ctx.Extract.dismissals_() })).toContain(title);

    w.newExecution();
    w.ctx.triageAct(id, 'undo');
    w.newExecution();
    expect(w.ctx.Extract.dismissals_()).toEqual([]);
    expect(w.ctx.Extract.systemPrompt('meeting', { feedback: w.ctx.Extract.dismissals_() })).not.toContain(title);
  });
});
