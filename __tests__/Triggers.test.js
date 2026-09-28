const { loadGas, allFiles } = require('./helpers/gas');
const { respond } = require('./helpers/mocks');

const TD = 'https://api.todoist.com/api/v1';
const SLACK_SCOPES = 'reactions:read,search:read,channels:history,groups:history,im:history,mpim:history,users:read,users:read.email';
const WORKSPACES = [
  { name: 'ISC', token: 'xoxp-isc', project: 'ISC' },
  { name: 'GR-OSS', token: 'xoxp-gr', project: 'GR' }
];
const ALL_PROPS = {
  TODOIST_API_TOKEN: 'tok',
  ANTHROPIC_API_KEY: 'sk-ant',
  CLAUDE_MODEL: 'claude-sonnet-4-5',
  GRANOLA_API_KEY: 'grn',
  SLACK_WORKSPACES: JSON.stringify(WORKSPACES)
};
const SECTIONS = {
  p_gr: ['Reach Out', 'Team Logistics', 'Team Updates', 'Conferences', 'KubeCon / Armada / CNCF Batch', 'Arctos', 'Tech Projects', 'Blogs', 'Hiring', 'EA', 'Generated Tasks'],
  p_isc: ['Reach Out', 'Logistics', 'Marketing', 'Quantum', 'Research', 'ISC Events', 'EA'],
  p_me: ['Immediate', 'Logistics', 'Outreach', 'Tech', 'Cars', 'To Buy'],
  p_sg: []
};

function load(opts) {
  const o = opts || {};
  const ctx = loadGas(undefined, Object.assign({ props: o.props === undefined ? ALL_PROPS : o.props }, o.gas || {}));
  ctx.Http.jitter_ = () => 0;
  return ctx;
}

/** Wire fakes for Todoist, Anthropic, Granola and Slack. Returns mutable state. */
function wire(ctx, opts) {
  const o = opts || {};
  const U = ctx.__mocks.UrlFetchApp;
  const state = {
    projects: (o.projects || [
      { id: 'p_inbox', name: 'Inbox', inbox_project: true },
      { id: 'p_gr', name: 'GR' }, { id: 'p_isc', name: 'ISC' }, { id: 'p_me', name: 'Me' }, { id: 'p_sg', name: 'SG' }
    ]).slice(),
    sections: o.sections || SECTIONS,
    labels: (o.labels || []).map((n, i) => ({ id: 'l' + i, name: n })),
    n: 1
  };
  U.__on('GET', TD + '/projects', () => (o.todoistStatus ? respond.status(o.todoistStatus) : respond.json({ results: state.projects, next_cursor: null })));
  U.__on('POST', TD + '/projects', req => {
    const p = { id: 'p_new' + state.n++, name: req.json.name };
    state.projects.push(p);
    return respond.json(p);
  });
  U.__on('GET', TD + '/sections', req => respond.json({
    results: (state.sections[req.query.project_id] || []).map((n, i) => ({ id: req.query.project_id + '_' + i, name: n, project_id: req.query.project_id })),
    next_cursor: null
  }));
  U.__on('GET', TD + '/labels', respond.json({ results: state.labels, next_cursor: null }));
  U.__on('POST', TD + '/labels', req => {
    const l = { id: 'l' + state.n++, name: req.json.name };
    state.labels.push(l);
    return respond.json(l);
  });
  U.__on('GET', /api\.anthropic\.com\/v1\/models\//, o.claude || respond.json({ type: 'model', id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5' }));
  U.__on('GET', /public-api\.granola\.ai\/v1\/notes/, o.granola || respond.json({ notes: [{ id: 'not_1', title: 'x' }], hasMore: false, cursor: null }));
  U.__on('POST', 'https://slack.com/api/auth.test', o.slack || (req => respond.json(
    { ok: true, user: 'alex', team: req.headers.Authorization.indexOf('isc') >= 0 ? 'ISC' : 'GR-OSS', user_id: 'U1' },
    200, { 'X-OAuth-Scopes': SLACK_SCOPES })));
  return state;
}

const handlers = ctx => ctx.__mocks.ScriptApp.__triggers.map(t => t.getHandlerFunction()).sort();

describe('installTriggers', () => {
  test('installs the full schedule from DESIGN.md', () => {
    const ctx = load();
    const res = ctx.installTriggers();
    expect(res.skipped).toEqual([]);
    expect(handlers(ctx)).toEqual(['createTaskFromStarred', 'runInboxSweep', 'runMeetings', 'runSlack', 'runSummaryCheck', 'runTriageDigest', 'runWaiting']);
    const cfg = Object.fromEntries(ctx.__mocks.ScriptApp.__triggers.map(t => [t.getHandlerFunction(), t.__config]));
    expect(cfg.createTaskFromStarred.everyMinutes).toBe(1);
    expect(cfg.runMeetings.everyMinutes).toBe(10);
    expect(cfg.runSlack.everyMinutes).toBe(10);
    expect(cfg.runInboxSweep).toMatchObject({ everyDays: 1, atHour: 7, nearMinute: 0 });
    expect(cfg.runWaiting).toMatchObject({ everyDays: 1, atHour: 7, nearMinute: 30 });
    expect(cfg.runSummaryCheck).toMatchObject({ everyDays: 1, atHour: 8, nearMinute: 0 });
    expect(cfg.runTriageDigest).toMatchObject({ everyDays: 1, atHour: 8, nearMinute: 15 });
    expect(handlers(ctx)).not.toContain('runBackfill');
    expect(res.installed.find(i => i.handler === 'runWaiting').schedule).toBe('daily ~07:30');
    expect(res.installed.find(i => i.handler === 'runMeetings').schedule).toBe('every 10 min');
  });

  test('is idempotent and removes the legacy processFirefliesEmails trigger, keeping unrelated ones', () => {
    const ctx = load();
    const SA = ctx.__mocks.ScriptApp;
    SA.newTrigger('processFirefliesEmails').timeBased().everyMinutes(5).create();
    SA.newTrigger('createTaskFromStarred').timeBased().everyMinutes(1).create();
    SA.newTrigger('somethingElse').timeBased().everyHours(1).create();

    const first = ctx.installTriggers();
    expect(first.removed).toBe(2);
    const second = ctx.installTriggers();
    expect(second.removed).toBe(7);

    const hs = handlers(ctx);
    expect(hs).toHaveLength(8);
    expect(hs).not.toContain('processFirefliesEmails');
    expect(hs).toContain('somethingElse');
    expect(hs.filter(h => h === 'createTaskFromStarred')).toHaveLength(1);
  });

  test('skips runSlack when no Slack workspaces are configured', () => {
    const props = Object.assign({}, ALL_PROPS);
    delete props.SLACK_WORKSPACES;
    const ctx = load({ props });
    const res = ctx.installTriggers();
    expect(handlers(ctx)).not.toContain('runSlack');
    expect(res.skipped).toEqual([{ handler: 'runSlack', reason: 'no SLACK_WORKSPACES configured' }]);
  });

  test('skips handlers whose function does not exist in the project', () => {
    // Function declarations can't be deleted from the context, so load every file except Waiting.js.
    const files = allFiles().filter(f => f !== 'Waiting.js');
    const ctx = loadGas(files, { props: ALL_PROPS });
    const res = ctx.installTriggers();
    expect(handlers(ctx)).not.toContain('runWaiting');
    expect(res.skipped[0]).toMatchObject({ handler: 'runWaiting' });
    expect(res.skipped[0].reason).toMatch(/not found/);
  });

  test('saves TRIAGE_URL from the deployed web app', () => {
    const ctx = load({ gas: { serviceUrl: 'https://script.google.com/macros/s/ABC/exec' } });
    ctx.installTriggers();
    expect(ctx.Config.get('TRIAGE_URL')).toBe('https://script.google.com/macros/s/ABC/exec');
  });
});

describe('uninstallAllTriggers', () => {
  test('removes every trigger of the project', () => {
    const ctx = load();
    ctx.installTriggers();
    ctx.__mocks.ScriptApp.newTrigger('other').timeBased().everyHours(1).create();
    expect(ctx.uninstallAllTriggers()).toBe(8);
    expect(ctx.__mocks.ScriptApp.__triggers).toHaveLength(0);
  });
});

describe('checkSetup', () => {
  test('happy path: everything verified, Waiting project and labels created, TRIAGE_URL saved', () => {
    const ctx = load();
    const state = wire(ctx);
    const r = ctx.checkSetup();

    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.missingProperties).toEqual([]);
    expect(r.todoist.projects).toEqual({ GR: 'p_gr', ISC: 'p_isc', Me: 'p_me', SG: 'p_sg', Inbox: 'p_inbox' });
    expect(r.todoist.missingSections).toEqual({});
    expect(state.projects.find(p => p.name === 'Waiting on others')).toBeTruthy();
    expect(r.todoist.waitingProjectId).toMatch(/^p_new/);
    expect(state.labels.map(l => l.name).sort()).toEqual(['check', 'from-email', 'from-slack', 'meeting', 'waiting']);
    expect(r.slack).toEqual([
      { name: 'ISC', ok: true, user: 'alex', team: 'ISC', missingScopes: [] },
      { name: 'GR-OSS', ok: true, user: 'alex', team: 'GR-OSS', missingScopes: [] }
    ]);
    expect(r.triageUrl).toBe('https://script.google.com/macros/s/TEST/exec');
    expect(ctx.Config.get('TRIAGE_URL')).toBe(r.triageUrl);
    expect(r.stateSheetUrl).toMatch(/docs\.google\.com\/spreadsheets/);
    expect(ctx.Config.get('STATE_SHEET_ID')).toBeTruthy();
    expect(r.info.join('\n')).toMatch(/Waiting on others" project created/);
    expect(r.info.join('\n')).toMatch(/Claude: model claude-sonnet-4-5/);
    expect(r.info.join('\n')).toMatch(/Granola: API key works/);
    expect(r.info.join('\n')).toMatch(/Fireflies backup: disabled/);
    expect(r.warnings.join('\n')).toMatch(/No triggers installed yet/);

    const anthropic = ctx.__mocks.UrlFetchApp.__calls.find(c => /anthropic/.test(c.url));
    expect(anthropic.url).toBe('https://api.anthropic.com/v1/models/claude-sonnet-4-5');
    expect(anthropic.headers['x-api-key']).toBe('sk-ant');
    expect(anthropic.headers['anthropic-version']).toBe('2023-06-01');
    const granola = ctx.__mocks.UrlFetchApp.__calls.find(c => /granola/.test(c.url));
    expect(granola.query.page_size).toBe('1');
  });

  test('missing required properties are reported without throwing or calling APIs', () => {
    const ctx = load({ props: {} });
    let r;
    expect(() => { r = ctx.checkSetup(); }).not.toThrow();
    expect(r.ok).toBe(false);
    expect(r.missingProperties).toEqual(['TODOIST_API_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_MODEL', 'GRANOLA_API_KEY']);
    expect(r.errors.find(e => /GRANOLA_API_KEY/.test(e))).toMatch(/Settings > Connectors > API keys/);
    expect(r.info.join('\n')).toMatch(/no SLACK_WORKSPACES configured/);
    expect(ctx.__mocks.UrlFetchApp.__calls).toHaveLength(0);
    expect(ctx.__mocks.logs.join('\n')).toMatch(/checkSetup: \d+ problem\(s\) to fix/);
  });

  test('does not recreate an existing Waiting project', () => {
    const ctx = load();
    const state = wire(ctx, {
      projects: [
        { id: 'p_inbox', name: 'Inbox', inbox_project: true }, { id: 'p_gr', name: 'GR' }, { id: 'p_isc', name: 'ISC' },
        { id: 'p_me', name: 'Me' }, { id: 'p_sg', name: 'SG' }, { id: 'p_wait', name: 'Waiting on others' }
      ],
      labels: ['meeting', 'from-email', 'from-slack', 'waiting', 'check']
    });
    const r = ctx.checkSetup();
    expect(r.todoist.waitingProjectId).toBe('p_wait');
    expect(ctx.__mocks.UrlFetchApp.__calls.filter(c => c.method === 'POST' && /todoist/.test(c.url))).toHaveLength(0);
    expect(state.projects).toHaveLength(6);
    expect(r.info.join('\n')).toMatch(/project exists/);
  });

  test('reports missing projects as errors and missing sections as warnings', () => {
    const ctx = load();
    wire(ctx, {
      projects: [{ id: 'p_inbox', name: 'Inbox', inbox_project: true }, { id: 'p_gr', name: 'GR' }, { id: 'p_isc', name: 'ISC' }, { id: 'p_me', name: 'Me' }],
      sections: { p_gr: ['Reach Out'], p_isc: SECTIONS.p_isc, p_me: ['Logistics'] }
    });
    const r = ctx.checkSetup();
    expect(r.ok).toBe(false);
    expect(r.todoist.projects.SG).toBeNull();
    expect(r.errors.join('\n')).toMatch(/project "SG" not found/);
    expect(r.todoist.missingSections.Me).toEqual(['Immediate', 'Outreach', 'Tech', 'Cars', 'To Buy']);
    expect(r.todoist.missingSections.GR).toContain('Arctos');
    expect(r.todoist.missingSections.ISC).toBeUndefined();
    expect(r.warnings.join('\n')).toMatch(/Me is missing section\(s\) Immediate/);
  });

  test('reads live sections even when a stale section list is cached from an earlier execution', () => {
    const ctx = load();
    const state = wire(ctx, { sections: Object.assign({}, SECTIONS, { p_me: ['Immediate'] }) });
    const first = ctx.checkSetup();
    expect(first.todoist.missingSections.Me).toEqual(['Logistics', 'Outreach', 'Tech', 'Cars', 'To Buy']);
    // Stale entries are now in CacheService; Alex adds the sections; a new execution starts.
    expect(ctx.__mocks.CacheService.__script.__store['todoist.sections.p_me']).toBeDefined();
    state.sections = SECTIONS;
    ctx.Todoist.mem_ = { projects: null, sections: {}, openTasks: {}, labels: null };
    const before = ctx.__mocks.UrlFetchApp.__calls.length;
    const second = ctx.checkSetup();
    expect(second.todoist.missingSections.Me).toBeUndefined();
    const refetched = ctx.__mocks.UrlFetchApp.__calls.slice(before)
      .filter(c => c.method === 'GET' && c.url.indexOf(TD + '/sections') === 0 && c.query.project_id === 'p_me');
    expect(refetched).toHaveLength(1);
  });

  test('a stale section cache seeded directly is ignored by checkSetup and refreshed for later jobs', () => {
    const ctx = load();
    wire(ctx);
    const cache = ctx.__mocks.CacheService.getScriptCache();
    cache.put('todoist.sections.p_me', JSON.stringify([{ id: 'old', name: 'Immediate', project_id: 'p_me', order: 1 }]), 21600);
    const r = ctx.checkSetup();
    expect(r.todoist.missingSections.Me).toBeUndefined();
    expect(JSON.parse(cache.get('todoist.sections.p_me')).map(s => s.name)).toEqual(SECTIONS.p_me);
  });

  test('a rejected Todoist token is an error and skips the project checks', () => {
    const ctx = load();
    wire(ctx, { todoistStatus: 401 });
    const r = ctx.checkSetup();
    expect(r.errors.join('\n')).toMatch(/TODOIST_API_TOKEN was rejected \(HTTP 401\)/);
    expect(r.todoist.waitingProjectId).toBeNull();
  });

  test('flags an unknown CLAUDE_MODEL and a rejected Granola key', () => {
    const ctx = load();
    wire(ctx, {
      claude: respond.status(404, '{"type":"error","error":{"type":"not_found_error"}}'),
      granola: respond.status(401, '{"message":"unauthorized"}')
    });
    const r = ctx.checkSetup();
    expect(r.errors.join('\n')).toMatch(/CLAUDE_MODEL "claude-sonnet-4-5" was not found/);
    expect(r.errors.join('\n')).toMatch(/GRANOLA_API_KEY was rejected \(HTTP 401\)/);
  });

  test('Slack: rejected token is an error, missing scopes and bot tokens are warnings', () => {
    const props = Object.assign({}, ALL_PROPS, {
      SLACK_WORKSPACES: JSON.stringify([
        { name: 'ISC', token: 'xoxp-bad', project: 'ISC' },
        { name: 'GR-OSS', token: 'xoxb-bot', project: 'Nope' },
        { name: 'NoToken' }
      ])
    });
    const ctx = load({ props });
    wire(ctx, {
      slack: req => (req.headers.Authorization === 'Bearer xoxp-bad'
        ? respond.json({ ok: false, error: 'invalid_auth' })
        : respond.json({ ok: true, user: 'alex', team: 'GR-OSS' }, 200, { 'X-OAuth-Scopes': 'search:read,users:read' }))
    });
    const r = ctx.checkSetup();
    const errs = r.errors.join('\n');
    const warns = r.warnings.join('\n');
    expect(errs).toMatch(/Slack ISC: token rejected by auth.test \(invalid_auth\)/);
    expect(errs).toMatch(/Slack NoToken: each workspace needs "name" and "token"/);
    expect(warns).toMatch(/Slack GR-OSS: token should be a user token/);
    expect(warns).toMatch(/Slack GR-OSS: "project" should be one of GR, ISC, Me, SG/);
    expect(warns).toMatch(/Slack GR-OSS: token is missing scopes reactions:read, channels:history/);
    expect(r.slack.map(s => s.ok)).toEqual([false, true, false]);
    expect(r.slack[1].missingScopes).toContain('im:history');
  });

  test('invalid JSON properties are errors; a non-array SLACK_WORKSPACES is explained', () => {
    const ctx = load({ props: Object.assign({}, ALL_PROPS, { ROUTING: '{nope', SLACK_WORKSPACES: '{"name":"ISC"}' }) });
    wire(ctx);
    const r = ctx.checkSetup();
    expect(r.errors.join('\n')).toMatch(/Script Property ROUTING is not valid JSON/);
    expect(r.errors.join('\n')).toMatch(/SLACK_WORKSPACES must be a JSON array/);
  });

  test('warns when the web app is not deployed, a legacy trigger remains, or triggers are missing', () => {
    const ctx = load({ gas: { serviceUrl: null } });
    wire(ctx);
    const SA = ctx.__mocks.ScriptApp;
    SA.newTrigger('processFirefliesEmails').timeBased().everyMinutes(5).create();
    SA.newTrigger('runMeetings').timeBased().everyMinutes(10).create();
    const r = ctx.checkSetup();
    const warns = r.warnings.join('\n');
    expect(r.triageUrl).toBeNull();
    expect(warns).toMatch(/Triage web app is not deployed yet/);
    expect(warns).toMatch(/Legacy trigger processFirefliesEmails is still installed/);
    expect(warns).toMatch(/Triggers not installed for createTaskFromStarred, runSlack/);
    expect(r.triggers).toEqual(['processFirefliesEmails', 'runMeetings']);
  });

  test('after installTriggers, the trigger check passes', () => {
    const ctx = load();
    wire(ctx);
    ctx.installTriggers();
    const r = ctx.checkSetup();
    expect(r.warnings.join('\n')).not.toMatch(/Trigger/);
    expect(r.info.join('\n')).toMatch(/Triggers: /);
  });

  test('an unexpected exception in one step is reported and the rest still run', () => {
    const ctx = load();
    wire(ctx);
    ctx.Store.sheet = () => { throw new Error('Sheets down'); };
    const r = ctx.checkSetup();
    expect(r.errors).toEqual(['State sheet: Sheets down']);
    expect(r.triageUrl).toBeTruthy();
  });

  test('warns on odd optional values and a non-LA time zone', () => {
    const ctx = load({
      props: Object.assign({}, ALL_PROPS, { DIRECT_CONFIDENCE: 'very', BACKFILL_DAYS: 'x', FIREFLIES_API_KEY: 'ff' }),
      gas: { timeZone: 'Europe/London' }
    });
    wire(ctx);
    const r = ctx.checkSetup();
    const warns = r.warnings.join('\n');
    expect(warns).toMatch(/DIRECT_CONFIDENCE should be high, med or low/);
    expect(warns).toMatch(/BACKFILL_DAYS should be a positive number/);
    expect(warns).toMatch(/Script time zone is Europe\/London/);
    expect(r.info.join('\n')).toMatch(/Fireflies backup: enabled/);
  });
});
