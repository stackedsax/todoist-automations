const { loadGas } = require('./helpers/gas');
const { createMocks } = require('./helpers/mocks');

const FILES = ['Config.js', 'Util.js', 'Http.js', 'Store.js', 'Slack.js'];
const NOW = new Date('2026-09-25T18:00:00Z');
const NOW_S = NOW.getTime() / 1000;
const WORKSPACES = [
  { name: 'ISC', token: 'xoxp-isc', project: 'ISC' },
  { name: 'GR-OSS', token: 'xoxp-gr', project: 'GR' }
];
const PROPS = { TODOIST_API_TOKEN: 't', ANTHROPIC_API_KEY: 'k', CLAUDE_MODEL: 'claude-test', SLACK_WORKSPACES: JSON.stringify(WORKSPACES) };
const CATALOGUE = {
  GR: ['Reach Out', 'Team Logistics', 'Team Updates', 'Conferences', 'KubeCon / Armada / CNCF Batch', 'Arctos', 'Tech Projects', 'Blogs', 'Hiring', 'EA'],
  ISC: ['Reach Out', 'Logistics', 'Marketing', 'Quantum', 'Research', 'ISC Events', 'EA'],
  Me: ['Immediate', 'Logistics', 'Outreach', 'Tech', 'Cars', 'To Buy'],
  SG: []
};
const ME = { 'xoxp-isc': 'U0ALEXISC', 'xoxp-gr': 'U0ALEXGR' };
const USERS = { U0MARCUS: 'Marcus Rabe', U0MIRO: 'Miro Knejp', U0ALEXISC: 'Alex Scammon', U0ALEXGR: 'Alex Scammon' };

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
const ts = (secondsAgo, frac) => (NOW_S - secondsAgo).toFixed(0) + '.' + (frac || '000100');

// ------------------------------------------------------------------ fake Slack server

function makeSlack() {
  const s = {
    reactions: { 'xoxp-isc': [], 'xoxp-gr': [] }, // arrays of pages (each page: items[])
    search: { 'xoxp-isc': {}, 'xoxp-gr': {} },   // base query -> matches
    authFail: {},
    searchFail: {},
    permalinks: 0
  };
  return s;
}

function tokenOf(req) {
  return String((req.headers && req.headers.Authorization) || '').replace('Bearer ', '');
}

function installSlack(mocks, s) {
  const U = mocks.UrlFetchApp;
  U.__on('*', /slack\.com\/api\/auth\.test/, req => {
    const tok = tokenOf(req);
    if (s.authFail[tok]) return { json: { ok: false, error: s.authFail[tok] } };
    return { json: { ok: true, user_id: ME[tok], user: 'alex', team: tok === 'xoxp-isc' ? 'ISC' : 'GR-OSS', url: 'https://x.slack.com/' } };
  });
  U.__on('GET', /slack\.com\/api\/reactions\.list/, req => {
    const pages = s.reactions[tokenOf(req)] || [];
    const idx = req.query.cursor ? Number(req.query.cursor.replace('c', '')) : 0;
    const items = pages[idx] || [];
    return { json: { ok: true, items, response_metadata: { next_cursor: idx + 1 < pages.length ? 'c' + (idx + 1) : '' } } };
  });
  U.__on('GET', /slack\.com\/api\/search\.messages/, req => {
    const tok = tokenOf(req);
    if (s.searchFail[tok]) return { json: { ok: false, error: s.searchFail[tok] } };
    const base = req.query.query.replace(/\s+after:\S+$/, '');
    let matches = (s.search[tok][base] || []).slice();
    matches.sort((a, b) => req.query.sort_dir === 'asc' ? Number(a.ts) - Number(b.ts) : Number(b.ts) - Number(a.ts));
    const per = Number(req.query.count);
    const page = Number(req.query.page);
    const pageCount = Math.max(1, Math.ceil(matches.length / per));
    matches = matches.slice((page - 1) * per, page * per);
    return { json: { ok: true, messages: { matches, pagination: { page, page_count: pageCount, per_page: per, total_count: matches.length } } } };
  });
  U.__on('GET', /slack\.com\/api\/chat\.getPermalink/, req => {
    s.permalinks++;
    return { json: { ok: true, channel: req.query.channel, permalink: 'https://x.slack.com/archives/' + req.query.channel + '/p' + req.query.message_ts.replace('.', '') } };
  });
  U.__on('GET', /slack\.com\/api\/users\.info/, req => {
    const name = USERS[req.query.user];
    if (!name) return { json: { ok: false, error: 'user_not_found' } };
    return { json: { ok: true, user: { id: req.query.user, name: name.split(' ')[0].toLowerCase(), real_name: name, profile: { real_name: name, display_name: name.split(' ')[0] } } } };
  });
}

const reactionItem = (channel, t, text, over) => ({
  type: 'message', channel,
  message: Object.assign({ type: 'message', ts: t, user: 'U0MARCUS', text, reactions: [{ name: 'todo', users: ['U0ALEXISC'], count: 1 }] }, over || {})
});

const match = (channel, t, text, over) => Object.assign({
  channel: typeof channel === 'string' ? { id: channel, name: channel.toLowerCase(), is_im: /^D/.test(channel) } : channel,
  ts: t, user: 'U0MARCUS', username: 'marcus', text,
  permalink: 'https://x.slack.com/archives/' + (typeof channel === 'string' ? channel : channel.id) + '/p' + t.replace('.', '')
}, over || {});

// ------------------------------------------------------------------ fakes for other modules

function makeFakes(state) {
  const Todoist = {
    createTask: jest.fn(t => {
      if (state.failCreate && state.failCreate(t)) throw new Error('Todoist 500');
      const task = Object.assign({ id: String(7000 + state.tasks.length) }, t);
      state.tasks.push(task);
      return task;
    }),
    openTasks: jest.fn(() => state.open),
    findByMachineKey: jest.fn(key => state.tasks.concat(state.open).find(t => {
      const m = /<!-- ta:(.*) -->/.exec(t.description || '');
      return m && JSON.parse(m[1]).key === key;
    }) || null),
    withMachineLine: jest.fn((d, obj) => (d ? d + '\n' : '') + '<!-- ta:' + JSON.stringify(obj) + ' -->')
  };
  const Extract = {
    slack: jest.fn((msgs, opts) => {
      state.extractCalls.push({ msgs, opts });
      if (state.extractError) throw state.extractError;
      const out = [];
      msgs.forEach(m => {
        const fn = state.items[m.text];
        if (fn) (typeof fn === 'function' ? fn(m) : fn).forEach(it => out.push(Object.assign({ ref: m.key }, it)));
      });
      return out;
    })
  };
  const Route = {
    sectionCatalogue: jest.fn(() => CATALOGUE),
    finalize: jest.fn((route, it) => {
      const strong = route.project && route.confidence !== 'low';
      const project = strong ? route.project : (it.project || route.project || null);
      let conf = strong ? route.confidence : 'low';
      if (strong && it.project && it.project !== route.project) conf = 'low';
      const section = project && (CATALOGUE[project] || []).indexOf(it.section) >= 0 ? it.section : null;
      return { project, section, routeConfidence: conf };
    })
  };
  const Dedupe = {
    matchTask: jest.fn((it, tasks) => {
      const t = (tasks || []).find(x => norm(x.content) === norm(it.title));
      return t ? { taskId: String(t.id), title: t.content, score: 1 } : null;
    })
  };
  return { Todoist, Extract, Route, Dedupe };
}

const item = over => Object.assign({
  title: 'Send Marcus the Q3 AWS partner report', kind: 'todo', owner: 'me', ownerName: null, ownerEmail: null,
  quote: 'can you send me the Q3 AWS partner report?', why: 'Marcus asked Alex directly.', due: null, resurface: null,
  confidence: 'high', project: 'ISC', section: 'Reach Out'
}, over || {});

function makeState() {
  return { tasks: [], open: [], items: {}, extractCalls: [], extractError: null, failCreate: null };
}

function setup(opts) {
  const o = opts || {};
  const state = o.state || makeState();
  const slack = o.slack || makeSlack();
  let mocks = o.mocks;
  if (!mocks) {
    mocks = createMocks({ props: Object.assign({}, PROPS, o.props || {}) });
    installSlack(mocks, slack);
  }
  const fakes = makeFakes(state);
  const ctx = loadGas(FILES, { mocks, globals: fakes });
  let clock = (o.now || NOW).getTime();
  ctx.Util.now = () => new Date(clock);
  ctx.Http.jitter_ = () => 0;
  ctx.advance = ms => { clock += ms; };
  ctx.state = state;
  ctx.slack = slack;
  ctx.fakes = fakes;
  return ctx;
}

/** Next trigger execution over the same Script Properties, sheet, fake Slack and state. */
const next = (prev, opts) => setup(Object.assign({ state: prev.state, slack: prev.slack, mocks: prev.__mocks }, opts || {}));

/** Mark workspaces as having run before, so reactions are not treated as a first-run baseline. */
function notFirstRun(ctx) {
  WORKSPACES.forEach(w => ctx.Store.kvSet('slack.' + w.name + '.reactionsSince', '2026-09-01T00:00:00Z'));
}

const slackCalls = (ctx, method) => ctx.__mocks.UrlFetchApp.__calls.filter(c => c.url.indexOf('/api/' + method) >= 0);

// ------------------------------------------------------------------ tests

describe('entrypoint', () => {
  test('runSlack is a top-level function that runs under the lock', () => {
    const ctx = setup();
    expect(typeof ctx.runSlack).toBe('function');
    const res = ctx.runSlack();
    expect(res.job).toBe('slack');
    expect(ctx.__mocks.LockService.getScriptLock).toHaveBeenCalled();
  });

  test('skips when another run holds the lock', () => {
    const ctx = setup();
    ctx.__mocks.LockService.__available = false;
    expect(ctx.runSlack()).toBeNull();
    expect(slackCalls(ctx, 'auth.test')).toHaveLength(0);
  });

  test('no SLACK_WORKSPACES: no Slack calls, run logged', () => {
    const ctx = setup({ props: { SLACK_WORKSPACES: '' } });
    const res = ctx.Slack.run();
    expect(res.created + res.queued + res.errors).toBe(0);
    expect(res.note).toMatch(/SLACK_WORKSPACES not set/);
    expect(ctx.__mocks.UrlFetchApp.__calls).toHaveLength(0);
    expect(ctx.Store.runsRecent(5)[0].job).toBe('slack');
  });
});

describe('Web API client', () => {
  test('sends the user token as a Bearer header and returns the body', () => {
    const ctx = setup();
    const me = ctx.Slack.me(WORKSPACES[0]);
    expect(me).toEqual({ userId: 'U0ALEXISC', name: 'alex', team: 'ISC', url: 'https://x.slack.com/' });
    const call = slackCalls(ctx, 'auth.test')[0];
    expect(call.method).toBe('POST');
    expect(call.headers.Authorization).toBe('Bearer xoxp-isc');
    ctx.Slack.me(WORKSPACES[0]);
    expect(slackCalls(ctx, 'auth.test')).toHaveLength(1); // memoised
  });

  test('ok:false becomes a SlackError with the Slack error code', () => {
    const ctx = setup();
    ctx.slack.authFail['xoxp-isc'] = 'invalid_auth';
    let err;
    try { ctx.Slack.me(WORKSPACES[0]); } catch (e) { err = e; }
    expect(err.name).toBe('SlackError');
    expect(err.slackError).toBe('invalid_auth');
    expect(err.message).toMatch(/auth\.test failed for ISC: invalid_auth/);
  });

  test('rate limits are retried by Http (Retry-After honoured)', () => {
    const ctx = setup();
    ctx.__mocks.UrlFetchApp.__on('GET', /users\.info/, [
      { status: 429, headers: { 'Retry-After': '2' }, json: { ok: false, error: 'ratelimited' } },
      { json: { ok: true, user: { id: 'U1', real_name: 'Ada Lovelace', profile: {} } } }
    ]);
    expect(ctx.Slack.userName(WORKSPACES[0], 'U1')).toBe('Ada Lovelace');
    expect(ctx.__mocks.Utilities.__sleeps[0]).toBe(2000);
  });

  test('userName caches and falls back to the id when lookup fails', () => {
    const ctx = setup();
    expect(ctx.Slack.userName(WORKSPACES[0], 'U0MIRO')).toBe('Miro Knejp');
    expect(ctx.Slack.userName(WORKSPACES[0], 'U0MIRO')).toBe('Miro Knejp');
    expect(slackCalls(ctx, 'users.info')).toHaveLength(1);
    expect(ctx.Slack.userName(WORKSPACES[0], 'U0NOBODY')).toBe('U0NOBODY');
    // the cache survives into the next execution (CacheService)
    const ctx2 = next(ctx);
    expect(ctx2.Slack.userName(WORKSPACES[0], 'U0MIRO')).toBe('Miro Knejp');
    expect(slackCalls(ctx2, 'users.info').filter(c => c.query.user === 'U0MIRO')).toHaveLength(1);
  });

  test('permalink returns null on failure instead of throwing', () => {
    const ctx = setup();
    ctx.__mocks.UrlFetchApp.__on('GET', /chat\.getPermalink/, { json: { ok: false, error: 'message_not_found' } });
    expect(ctx.Slack.permalink(WORKSPACES[0], 'C1', '1.2')).toBeNull();
  });
});

describe(':todo: reactions -> direct tasks', () => {
  test('creates one task in the workspace project with label, permalink, text and machine line', () => {
    const ctx = setup();
    notFirstRun(ctx);
    const t1 = ts(3600);
    ctx.slack.reactions['xoxp-isc'] = [[
      reactionItem('C0SALES', t1, '<@U0ALEXISC> can you send me the Q3 AWS partner report?')
    ]];
    ctx.state.items['<@U0ALEXISC> can you send me the Q3 AWS partner report?'] = [item()];
    const res = ctx.Slack.run();
    expect(res.created).toBe(1);
    expect(res.errors).toBe(0);
    const task = ctx.state.tasks[0];
    expect(task.content).toBe('Send Marcus the Q3 AWS partner report');
    expect(task.projectName).toBe('ISC');
    expect(task.sectionName).toBe('Reach Out');
    expect(task.labels).toEqual(['from-slack']);
    const key = 'slack:ISC:C0SALES:' + t1;
    expect(task.description).toContain('[Open in Slack](https://x.slack.com/archives/C0SALES/p' + t1.replace('.', '') + ')');
    expect(task.description).toContain('From: Marcus Rabe');
    expect(task.description).toContain('> @Alex Scammon can you send me the Q3 AWS partner report?');
    expect(task.description.split('\n').pop()).toBe('<!-- ta:' + JSON.stringify({ key }) + ' -->');
    const l = ctx.Store.ledgerGet(key);
    expect(l.outcome).toBe('tasks');
    expect(l.taskIds).toEqual([task.id]);
    // reactions.list asked for the token owner's reactions, full
    const rl = slackCalls(ctx, 'reactions.list')[0];
    expect(rl.query.user).toBe('U0ALEXISC');
    expect(rl.query.full).toBe('true');
    // Extract got the explicit message with the workspace default project
    expect(ctx.state.extractCalls[0].opts.project).toBe('ISC');
    expect(ctx.state.extractCalls[0].opts.me.userId).toBe('U0ALEXISC');
  });

  test('falls back to the message text when Extract fails or returns nothing; section from another project is ignored', () => {
    const ctx = setup();
    notFirstRun(ctx);
    ctx.slack.reactions['xoxp-gr'] = [[
      reactionItem('C0ARMADA', ts(600), 'Review <https://github.com/armadaproject/armada/pull/42|PR 42> before release\nthanks!', {
        reactions: [{ name: 'todo', users: ['U0ALEXGR'] }]
      }),
      reactionItem('C0ARMADA', ts(500), 'Book the KubeCon booth', { reactions: [{ name: 'todo', users: ['U0ALEXGR'] }] })
    ]];
    ctx.state.items['Book the KubeCon booth'] = [item({ title: 'Book the KubeCon booth', project: 'ISC', section: 'Reach Out' })];
    ctx.Slack.run();
    const titles = ctx.state.tasks.map(t => t.content);
    expect(titles).toEqual(['Review PR 42 (https://github.com/armadaproject/armada/pull/42) before release', 'Book the KubeCon booth']);
    expect(ctx.state.tasks.every(t => t.projectName === 'GR')).toBe(true);
    expect(ctx.state.tasks[1].sectionName).toBeUndefined();

    const ctx2 = setup();
    notFirstRun(ctx2);
    ctx2.state.extractError = new Error('Claude 529');
    ctx2.slack.reactions['xoxp-isc'] = [[reactionItem('C1', ts(60), 'Renew the AWS partner agreement')]];
    const res = ctx2.Slack.run();
    expect(res.created).toBe(1);
    expect(ctx2.state.tasks[0].content).toBe('Renew the AWS partner agreement');
  });

  test('only messages with the todo reaction from Alex; skin tones and SLACK_TODO_EMOJI respected; non-messages ignored', () => {
    const ctx = setup({ props: { SLACK_TODO_EMOJI: ':todo_list:' } });
    notFirstRun(ctx);
    ctx.slack.reactions['xoxp-isc'] = [[
      reactionItem('C1', ts(100), 'eyes only', { reactions: [{ name: 'eyes', users: ['U0ALEXISC'] }] }),
      reactionItem('C1', ts(90), 'someone else ticked it', { reactions: [{ name: 'todo_list', users: ['U0MARCUS'] }] }),
      reactionItem('C1', ts(80), 'plain todo is not the configured emoji', { reactions: [{ name: 'todo', users: ['U0ALEXISC'] }] }),
      reactionItem('C1', ts(70), 'Ship the invoice', { reactions: [{ name: 'todo_list::skin-tone-3', users: ['U0ALEXISC'] }] }),
      { type: 'file', file: { id: 'F1' } }
    ]];
    ctx.Slack.run();
    expect(ctx.state.tasks.map(t => t.content)).toEqual(['Ship the invoice']);
  });

  test('ledger prevents re-creating the task on the next run; paging stops at already-seen pages', () => {
    const ctx = setup();
    notFirstRun(ctx);
    const page0 = [reactionItem('C1', ts(100), 'Send the NDA to Dipsea')];
    const page1 = [reactionItem('C1', ts(86400 * 20), 'Old one')];
    ctx.slack.reactions['xoxp-isc'] = [page0, page1];
    ctx.Slack.run();
    expect(ctx.state.tasks.map(t => t.content).sort()).toEqual(['Old one', 'Send the NDA to Dipsea']);
    expect(slackCalls(ctx, 'reactions.list').filter(c => c.headers.Authorization === 'Bearer xoxp-isc')).toHaveLength(2);

    const iscCalls = c => slackCalls(c, 'reactions.list').filter(x => x.headers.Authorization === 'Bearer xoxp-isc').length;
    const before = iscCalls(ctx);
    const ctx2 = next(ctx);
    const res = ctx2.Slack.run();
    expect(res.created).toBe(0);
    expect(ctx2.state.tasks).toHaveLength(2);
    // first page was entirely known -> no second page request
    expect(iscCalls(ctx2) - before).toBe(1);
  });

  test('first run: :todo: on messages older than two days go to triage (Baseline), recent ones become tasks', () => {
    const ctx = setup();
    const old = ts(86400 * 10);
    ctx.slack.reactions['xoxp-isc'] = [[
      reactionItem('C1', ts(3600), 'Recent thing'),
      reactionItem('C1', old, 'Ancient thing')
    ]];
    const res = ctx.Slack.run();
    expect(ctx.state.tasks.map(t => t.content)).toEqual(['Recent thing']);
    const key = 'slack:ISC:C1:' + old;
    const q = ctx.Store.queueList({ status: 'pending', source: 'slack' }).filter(x => x.sourceKey === key);
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ title: 'Ancient thing', kind: 'todo', project: 'ISC', labels: ['from-slack'] });
    expect(q[0].chips).toContain('Baseline');
    expect(ctx.Store.ledgerGet(key)).toMatchObject({ outcome: 'queued', queueIds: [q[0].id] });
    expect(ctx.Store.ledgerGet(key).note).toMatch(/baseline/);
    expect(res.queued).toBeGreaterThanOrEqual(1);
    expect(res.note || JSON.stringify(res)).toMatch(/sent to triage/);
    expect(ctx.Store.kvGet('slack.ISC.reactionsSince')).toBe(NOW.toISOString());
    // not queued again, and never turned into a task behind triage's back
    const ctx1 = next(ctx);
    ctx1.slack.reactions['xoxp-isc'] = [[reactionItem('C1', old, 'Ancient thing')]];
    ctx1.Slack.run();
    expect(ctx1.Store.queueList({ status: 'pending', source: 'slack' }).filter(x => x.sourceKey === key)).toHaveLength(1);
    expect(ctx1.state.tasks.map(t => t.content)).not.toContain('Ancient thing');
    // later runs create tasks for old messages reacted to later
    const ctx2 = next(ctx);
    const older = ts(86400 * 30);
    ctx2.slack.reactions['xoxp-isc'] = [[reactionItem('C1', older, 'Reacted today on an old message')]];
    ctx2.Slack.run();
    expect(ctx2.state.tasks.map(t => t.content)).toContain('Reacted today on an old message');
  });

  test('an existing task with the same machine key is reused, not duplicated', () => {
    const ctx = setup();
    notFirstRun(ctx);
    const t1 = ts(100);
    const key = 'slack:ISC:C1:' + t1;
    ctx.state.open.push({ id: '555', content: 'Already there', description: 'x\n<!-- ta:' + JSON.stringify({ key }) + ' -->' });
    ctx.slack.reactions['xoxp-isc'] = [[reactionItem('C1', t1, 'Already there')]];
    const res = ctx.Slack.run();
    expect(res.created).toBe(0);
    expect(ctx.fakes.Todoist.createTask).not.toHaveBeenCalled();
    expect(ctx.Store.ledgerGet(key)).toMatchObject({ outcome: 'tasks', taskIds: ['555'] });
  });

  test('settles a pending queue suggestion from the same message', () => {
    const ctx = setup();
    notFirstRun(ctx);
    const t1 = ts(100);
    const key = 'slack:ISC:C1:' + t1;
    ctx.Store.queueAdd([{ id: 'q_same', source: 'slack', sourceKey: key, title: 'Do the thing', project: 'ISC' },
      { id: 'q_other', source: 'slack', sourceKey: 'slack:ISC:C1:1.1', title: 'Other', project: 'ISC' }]);
    ctx.slack.reactions['xoxp-isc'] = [[reactionItem('C1', t1, 'Do the thing')]];
    ctx.Slack.run();
    expect(ctx.Store.queueGet('q_same')).toMatchObject({ status: 'accepted', resultTaskId: ctx.state.tasks[0].id });
    expect(ctx.Store.queueGet('q_other').status).toBe('pending');
    expect(ctx.Store.ledgerGet(key).queueIds).toEqual(['q_same']);
  });

  test('one failing create does not abort the run and is retried next time', () => {
    const ctx = setup();
    notFirstRun(ctx);
    ctx.state.failCreate = t => t.content === 'Bad one';
    ctx.slack.reactions['xoxp-isc'] = [[reactionItem('C1', ts(200), 'Bad one'), reactionItem('C1', ts(100), 'Good one')]];
    const res = ctx.Slack.run();
    expect(res.created).toBe(1);
    expect(res.errors).toBe(1);
    expect(ctx.Store.ledgerGet('slack:ISC:C1:' + ts(200))).toMatchObject({ outcome: 'error' });
    const ctx2 = next(ctx);
    ctx2.state.failCreate = null;
    const res2 = ctx2.Slack.run();
    expect(res2.created).toBe(1);
    expect(ctx2.state.tasks.map(t => t.content)).toEqual(['Good one', 'Bad one']);
  });
});

describe('mentions / DMs -> triage queue', () => {
  function withMentions(ctx) {
    notFirstRun(ctx);
    ctx.Store.kvSet('slack.ISC.oldest', ts(7200, '000000'));
    const s = ctx.slack.search['xoxp-isc'];
    s['<@U0ALEXISC>'] = [
      match('C0SALES', ts(3000), '<@U0ALEXISC> can you send me the Q3 AWS partner report?'),
      match('C0SALES', ts(2000), '<@U0ALEXISC> FYI the offsite moved to Tuesday'),
      match('C0SALES', ts(7200 + 3600 + 600), '<@U0ALEXISC> too old (before cursor and overlap)'),
      match('C0SALES', ts(1000), 'my own message mentioning <@U0ALEXISC>', { user: 'U0ALEXISC', username: 'alex' })
    ];
    s['to:me'] = [
      match({ id: 'D0MARCUS', name: 'U0MARCUS', is_im: true }, ts(1500), 'I will get you the signed SOW by Friday'),
      // same message returned by both queries
      match('C0SALES', ts(3000), '<@U0ALEXISC> can you send me the Q3 AWS partner report?')
    ];
    ctx.state.items['<@U0ALEXISC> can you send me the Q3 AWS partner report?'] = [item()];
    ctx.state.items['I will get you the signed SOW by Friday'] = [item({
      title: 'Get the signed SOW from Marcus', kind: 'waiting', owner: 'other', ownerName: 'Marcus Rabe',
      ownerEmail: 'marcus@insightsoftmax.com', resurface: '2026-09-25', confidence: 'med', section: null, project: null
    })];
  }

  test('queues extracted items with origin, link, routing and a machine-lined description', () => {
    const ctx = setup();
    withMentions(ctx);
    const res = ctx.Slack.run();
    expect(res.queued).toBe(2);
    expect(res.created).toBe(0);
    const q = ctx.Store.queueList({ status: 'pending' });
    expect(q).toHaveLength(2);
    const todo = q.find(x => x.kind === 'todo');
    const key = 'slack:ISC:C0SALES:' + ts(3000);
    expect(todo).toMatchObject({
      source: 'slack', sourceKey: key, title: 'Send Marcus the Q3 AWS partner report', project: 'ISC', section: 'Reach Out',
      routeConfidence: 'med', confidence: 'high', link: 'https://x.slack.com/archives/C0SALES/p' + ts(3000).replace('.', ''),
      origin: 'Slack · ISC · #c0sales · Fri 25 Sep', labels: ['from-slack'], dupTaskId: null
    });
    expect(todo.id).toBe(ctx.Store.queueId('slack', key, todo.title));
    expect(todo.description).toContain('<!-- ta:' + JSON.stringify({ key, q: todo.id }) + ' -->');
    const waiting = q.find(x => x.kind === 'waiting');
    expect(waiting).toMatchObject({
      waitOn: 'Marcus Rabe', waitOnEmail: 'marcus@insightsoftmax.com', resurface: '2026-09-25', project: 'ISC',
      origin: 'Slack · ISC · DM from marcus · Fri 25 Sep'
    });

    // Extract saw each message once, own + pre-cursor messages dropped, DM flagged
    const sent = ctx.state.extractCalls.filter(c => c.opts.feedback !== undefined).flatMap(c => c.msgs);
    expect(sent.map(m => m.text).sort()).toEqual([
      '<@U0ALEXISC> FYI the offsite moved to Tuesday',
      '<@U0ALEXISC> can you send me the Q3 AWS partner report?',
      'I will get you the signed SOW by Friday'
    ]);
    expect(sent.find(m => m.isDm).channel).toBe('D0MARCUS');
    expect(sent.every(m => m.workspace === 'ISC')).toBe(true);

    // search queries: mention + to:me, with after: the day before the cursor, oldest first
    const qs = slackCalls(ctx, 'search.messages').filter(c => c.headers.Authorization === 'Bearer xoxp-isc').map(c => c.query);
    expect(qs.map(x => x.query)).toEqual(['<@U0ALEXISC> after:2026-09-24', 'to:me after:2026-09-24']);
    expect(qs[0].sort).toBe('timestamp');
    expect(qs[0].sort_dir).toBe('asc');

    // ledger (:scan keys) and cursor
    expect(ctx.Store.ledgerGet(key + ':scan')).toMatchObject({ outcome: 'queued', queueIds: [todo.id] });
    expect(ctx.Store.ledgerGet('slack:ISC:C0SALES:' + ts(2000) + ':scan')).toMatchObject({ outcome: 'nothing' });
    expect(ctx.Store.kvGet('slack.ISC.oldest')).toBe(Number(ts(1500)).toFixed(6));
  });

  test('second run finds nothing new; SLACK_SEARCH_QUERIES overrides the queries', () => {
    const ctx = setup();
    withMentions(ctx);
    ctx.Slack.run();
    const ctx2 = next(ctx);
    ctx2.state.extractCalls.length = 0;
    const res = ctx2.Slack.run();
    expect(res.queued).toBe(0);
    expect(ctx2.state.extractCalls).toHaveLength(0);

    const ctx3 = setup({ props: { SLACK_SEARCH_QUERIES: JSON.stringify(['<@{uid}> is:thread']) } });
    notFirstRun(ctx3);
    ctx3.Slack.run();
    const q3 = slackCalls(ctx3, 'search.messages').filter(c => c.headers.Authorization === 'Bearer xoxp-isc');
    expect(q3.map(c => c.query.query.replace(/ after:.*/, ''))).toEqual(['<@U0ALEXISC> is:thread']);
  });

  test('a duplicate of an open task is queued with dupTaskId', () => {
    const ctx = setup();
    withMentions(ctx);
    ctx.state.open.push({ id: '4242', content: 'Send Marcus the Q3 AWS partner report' });
    ctx.Slack.run();
    const todo = ctx.Store.queueList({ status: 'pending' }).find(x => x.kind === 'todo');
    expect(todo).toMatchObject({ dupTaskId: '4242', dupTaskTitle: 'Send Marcus the Q3 AWS partner report' });
  });

  test('a message already captured by a :todo: reaction is not queued again', () => {
    const ctx = setup();
    withMentions(ctx);
    const t = ts(3000);
    ctx.slack.reactions['xoxp-isc'] = [[reactionItem('C0SALES', t, '<@U0ALEXISC> can you send me the Q3 AWS partner report?')]];
    const res = ctx.Slack.run();
    expect(res.created).toBe(1);
    const q = ctx.Store.queueList({ status: 'pending' });
    expect(q.find(x => x.sourceKey === 'slack:ISC:C0SALES:' + t)).toBeUndefined();
  });

  test('Extract failure: nothing queued, cursor held, retried; given up after three attempts', () => {
    const ctx = setup();
    withMentions(ctx);
    ctx.state.extractError = new Error('Claude overloaded');
    const cursor = ctx.Store.kvGet('slack.ISC.oldest');
    const res = ctx.Slack.run();
    expect(res.errors).toBeGreaterThanOrEqual(1);
    expect(res.queued).toBe(0);
    expect(ctx.Store.kvGet('slack.ISC.oldest')).toBe(cursor);
    expect(ctx.Store.ledgerGet('slack:ISC:C0SALES:' + ts(3000) + ':scan')).toMatchObject({ outcome: 'error' });

    const ctx2 = next(ctx);
    ctx2.Slack.run();
    expect(ctx2.Store.kvGet('slack.ISC.oldest')).toBe(cursor);
    const ctx3 = next(ctx2);
    ctx3.Slack.run();
    expect(ctx3.Store.ledgerGet('slack:ISC:C0SALES:' + ts(3000) + ':scan').note).toMatch(/attempt 3/);
    expect(ctx3.Store.kvGet('slack.ISC.oldest')).toBe(Number(ts(1500)).toFixed(6)); // gave up -> moves on
  });

  test('first run with no mentions sets the cursor to now', () => {
    const ctx = setup();
    ctx.Slack.run();
    expect(Number(ctx.Store.kvGet('slack.ISC.oldest'))).toBeCloseTo(NOW_S - 60, 0);
    const q = slackCalls(ctx, 'search.messages')[0].query.query;
    expect(q).toMatch(/after:2026-09-22$/); // now − 2 days − 1 day (after: is exclusive)
  });

  test('a late-indexed message just behind the cursor is still queued; already-scanned ones are not re-extracted', () => {
    const ctx = setup();
    notFirstRun(ctx);
    ctx.Store.kvSet('slack.ISC.oldest', ts(7200, '000000'));
    const sIsc = ctx.slack.search['xoxp-isc'];
    sIsc['<@U0ALEXISC>'] = [match('C0SALES', ts(1000), '<@U0ALEXISC> newer message')];
    sIsc['to:me'] = [];
    ctx.state.items['<@U0ALEXISC> newer message'] = [item({ title: 'Reply about the newer message' })];
    ctx.Slack.run();
    const cursor = ctx.Store.kvGet('slack.ISC.oldest');
    expect(cursor).toBe(Number(ts(1000)).toFixed(6));

    // Next run: search now also returns an OLDER message (before the cursor) that was indexed late.
    const ctx2 = next(ctx);
    const s2 = ctx2.slack.search['xoxp-isc'];
    s2['<@U0ALEXISC>'] = [
      match('C0SALES', ts(1000), '<@U0ALEXISC> newer message'),
      match('C0SALES', ts(1800), '<@U0ALEXISC> late-indexed ask')
    ];
    s2['to:me'] = [];
    ctx2.state.items['<@U0ALEXISC> late-indexed ask'] = [item({ title: 'Answer the late-indexed ask' })];
    const before = ctx2.state.extractCalls.length;
    const res2 = ctx2.Slack.run();
    const sent = ctx2.state.extractCalls.slice(before).filter(c => c.opts.feedback !== undefined).flatMap(c => c.msgs.map(m => m.text));
    expect(sent).toEqual(['<@U0ALEXISC> late-indexed ask']);
    expect(res2.skipped).toBe(0); // overlap re-sightings are not counted as skips
    expect(ctx2.Store.queueList({ status: 'pending' }).map(q => q.title)).toContain('Answer the late-indexed ask');
    expect(ctx2.Store.kvGet('slack.ISC.oldest')).toBe(cursor); // cursor never moves backwards
  });

  test('a truncated oldest-first listing never moves the cursor past what was read', () => {
    const ctx = setup();
    notFirstRun(ctx);
    ctx.Slack.MAX_SEARCH_PAGES = 1;
    ctx.Slack.SEARCH_PAGE_SIZE = 2;
    ctx.Store.kvSet('slack.ISC.oldest', ts(7200, '000000'));
    ctx.slack.search['xoxp-isc']['<@U0ALEXISC>'] = [
      match('C1', ts(3000), 'a'), match('C1', ts(2000), 'b'), match('C1', ts(1000), 'c')
    ];
    ctx.slack.search['xoxp-isc']['to:me'] = [match('D1', ts(500), 'd')];
    ctx.Slack.run();
    expect(ctx.Store.kvGet('slack.ISC.oldest')).toBe(Number(ts(2000)).toFixed(6));
  });

  test('deadline: stops before extracting and keeps the cursor', () => {
    const ctx = setup();
    withMentions(ctx);
    const cursor = ctx.Store.kvGet('slack.ISC.oldest');
    let calls = 0;
    // plenty of time for the listing, then out of time
    const deadline = { expired: () => false, remaining: () => (++calls > 3 ? 1000 : 200000), elapsed: () => 0 };
    const res = ctx.Slack.run({ deadline });
    expect(res.stoppedEarly).toBe(true);
    expect(res.note).toMatch(/deadline/);
    expect(ctx.Store.kvGet('slack.ISC.oldest')).toBe(cursor);
    expect(ctx.Store.queueList({ status: 'pending' })).toHaveLength(0);
  });

  test('one failing workspace does not stop the others', () => {
    const ctx = setup();
    notFirstRun(ctx);
    ctx.slack.authFail['xoxp-isc'] = 'token_revoked';
    ctx.slack.reactions['xoxp-gr'] = [[reactionItem('C1', ts(100), 'Update the Armada roadmap', { reactions: [{ name: 'todo', users: ['U0ALEXGR'] }] })]];
    const res = ctx.Slack.run();
    expect(res.errors).toBe(1);
    expect(res.note).toMatch(/ISC: .*token_revoked/);
    expect(res.created).toBe(1);
    expect(ctx.state.tasks[0].projectName).toBe('GR');
    expect(ctx.Store.runsRecent(1)[0]).toMatchObject({ job: 'slack', created: 1, errors: 1 });
  });
});

describe('Slack.search (Waiting evidence)', () => {
  test('searches every workspace since the date and returns evidence newest first', () => {
    const ctx = setup();
    ctx.slack.search['xoxp-isc']['from:@marcus SOW'] = [
      match('C0SALES', ts(4000), 'Signed SOW attached'),
      match('C0SALES', ts(86400 * 9), 'too old')
    ];
    ctx.slack.search['xoxp-gr']['from:@marcus SOW'] = [match({ id: 'D9', is_im: true }, ts(100), 'SOW done')];
    const ev = ctx.Slack.search('from:@marcus SOW', new Date(NOW.getTime() - 7 * 86400000));
    expect(ev.map(e => e.text)).toEqual(['SOW done', 'Signed SOW attached']);
    expect(ev[1]).toMatchObject({ source: 'slack', workspace: 'ISC', from: 'marcus', title: '#c0sales', link: expect.stringContaining('/archives/C0SALES/') });
    expect(ev[0].title).toBe('DM');
    expect(ev[0].date).toBeInstanceOf(Date);
    const q = slackCalls(ctx, 'search.messages')[0].query;
    expect(q.query).toBe('from:@marcus SOW after:2026-09-17');
    expect(q.sort_dir).toBe('desc');
  });

  test('tolerates a failing workspace, supports opts.workspace, and returns [] when unconfigured', () => {
    const ctx = setup();
    ctx.slack.searchFail['xoxp-isc'] = 'missing_scope';
    ctx.slack.search['xoxp-gr']['armada'] = [match('C1', ts(10), 'armada release')];
    expect(ctx.Slack.search('armada').map(e => e.workspace)).toEqual(['GR-OSS']);
    expect(ctx.Slack.search('armada', null, { workspace: 'ISC' })).toEqual([]);
    expect(ctx.Slack.search('')).toEqual([]);
    const ctx2 = setup({ props: { SLACK_WORKSPACES: '' } });
    expect(ctx2.Slack.search('anything')).toEqual([]);
  });
});
