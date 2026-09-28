const { loadGas } = require('./helpers/gas');
const { createMocks, respond } = require('./helpers/mocks');

const BASE = 'https://api.todoist.com/api/v1';
const FILES = ['Config.js', 'Util.js', 'Http.js', 'Todoist.js'];

const PROJECTS = [
  { id: 'p_inbox', name: 'Inbox', inbox_project: true },
  { id: 'p_gr', name: 'GR' },
  { id: 'p_isc', name: 'ISC' },
  { id: 'p_me', name: 'Me' },
  { id: 'p_sg', name: 'SG' },
  { id: 'p_old', name: 'Old', is_archived: true }
];
const SECTIONS = {
  p_gr: ['Reach Out', 'Team Logistics', 'Team Updates', 'Conferences', 'KubeCon / Armada / CNCF Batch', 'Arctos', 'Tech Projects', 'Blogs', 'Hiring', 'EA', 'Generated Tasks'],
  p_isc: ['Reach Out', 'Logistics', 'Marketing', 'Quantum', 'Research', 'ISC Events', 'EA'],
  p_me: ['Immediate', 'Logistics', 'Outreach', 'Tech', 'Cars', 'To Buy'],
  p_sg: []
};

/** Minimal Todoist v1 fake on top of the UrlFetchApp mock. */
function fakeTodoist(mocks, opts) {
  const o = opts || {};
  const state = {
    projects: PROJECTS.map(p => Object.assign({}, p)),
    tasks: (o.tasks || []).map(t => Object.assign({}, t)),
    labels: (o.labels || ['meeting']).map((n, i) => ({ id: 'l' + i, name: n })),
    comments: [],
    nextId: 1000
  };
  const U = mocks.UrlFetchApp;
  const page = (items, req, size) => {
    const start = req.query.cursor ? +req.query.cursor : 0;
    const n = size || +req.query.limit || 50;
    const slice = items.slice(start, start + n);
    return respond.json({ results: slice, next_cursor: start + n < items.length ? String(start + n) : null });
  };
  U.__on('GET', BASE + '/projects', req => page(state.projects, req, o.pageSize));
  U.__on('POST', BASE + '/projects', req => {
    const p = { id: 'p_' + state.nextId++, name: req.json.name };
    state.projects.push(p);
    return respond.json(p);
  });
  U.__on('GET', BASE + '/sections', req => {
    const names = SECTIONS[req.query.project_id] || [];
    return page(names.map((n, i) => ({ id: req.query.project_id + '_s' + i, name: n, project_id: req.query.project_id, section_order: i })), req);
  });
  U.__on('GET', BASE + '/labels', req => page(state.labels, req));
  U.__on('POST', BASE + '/labels', req => {
    const l = { id: 'l' + state.nextId++, name: req.json.name };
    state.labels.push(l);
    return respond.json(l);
  });
  U.__on('GET', BASE + '/tasks', req => page(state.tasks.filter(t => t.project_id === req.query.project_id), req, o.pageSize));
  U.__on('POST', BASE + '/tasks', req => {
    const t = Object.assign({ id: String(state.nextId++), section_id: null, labels: [] }, req.json);
    if (!t.project_id) t.project_id = 'p_inbox';
    state.tasks.push(t);
    return respond.json(t);
  });
  U.__on('GET', new RegExp('^' + BASE + '/tasks/[^/?]+$'), req => {
    const id = req.url.split('/').pop();
    const t = state.tasks.find(x => x.id === id);
    return t ? respond.json(t) : respond.status(404, 'Task not found');
  });
  U.__on('POST', new RegExp('^' + BASE + '/tasks/[^/]+$'), req => {
    const id = req.url.split('/').pop();
    const t = state.tasks.find(x => x.id === id);
    Object.assign(t, req.json);
    return respond.json(t);
  });
  U.__on('POST', new RegExp('^' + BASE + '/tasks/[^/]+/(close|reopen|move)$'), req => {
    const parts = req.url.split('/');
    const action = parts.pop();
    const id = parts.pop();
    if (action === 'close') state.tasks = state.tasks.filter(x => x.id !== id);
    if (action === 'move') {
      const t = state.tasks.find(x => x.id === id);
      if (req.json.section_id) { t.section_id = req.json.section_id; t.project_id = req.json.section_id.split('_s')[0]; }
      if (req.json.project_id) { t.project_id = req.json.project_id; t.section_id = null; }
    }
    return respond.empty();
  });
  U.__on('DELETE', new RegExp('^' + BASE + '/tasks/[^/]+$'), req => {
    const id = req.url.split('/').pop();
    state.tasks = state.tasks.filter(x => x.id !== id);
    return respond.empty();
  });
  U.__on('POST', BASE + '/comments', req => {
    const c = Object.assign({ id: 'c' + state.nextId++ }, req.json);
    state.comments.push(c);
    return respond.json(c);
  });
  U.__on('GET', BASE + '/tasks/filter', req => respond.json({ results: state.tasks.filter(t => (t.labels || []).includes(req.query.query.replace('@', ''))), next_cursor: null }));
  return state;
}

function setup(opts) {
  const mocks = createMocks({ props: Object.assign({ TODOIST_API_TOKEN: 'tok' }, (opts && opts.props) || {}) });
  const state = fakeTodoist(mocks, opts);
  const ctx = loadGas(FILES, { mocks });
  return { ctx, mocks, state, T: ctx.Todoist };
}

describe('transport', () => {
  test('sends bearer token, paginates via next_cursor with limit 200', () => {
    const { T, mocks } = setup({ pageSize: 2 });
    expect(T.projects()).toHaveLength(6);
    const calls = mocks.UrlFetchApp.__find('GET', BASE + '/projects');
    expect(calls).toHaveLength(3);
    expect(calls[0].headers.Authorization).toBe('Bearer tok');
    expect(calls[0].query.limit).toBe('200');
    expect(calls[1].query.cursor).toBe('2');
  });

  test('list accepts bare-array responses', () => {
    const mocks = createMocks({ props: { TODOIST_API_TOKEN: 'tok' } });
    mocks.UrlFetchApp.__on('GET', BASE + '/labels', respond.json([{ id: 1, name: 'x' }]));
    const ctx = loadGas(FILES, { mocks });
    expect(ctx.Todoist.list('/labels')).toEqual([{ id: 1, name: 'x' }]);
  });

  test('missing token -> Config.require error', () => {
    const mocks = createMocks();
    const ctx = loadGas(FILES, { mocks });
    expect(() => ctx.Todoist.projects()).toThrow(/Missing Script Property: TODOIST_API_TOKEN/);
  });
});

describe('projects and sections', () => {
  test('projects cached in memory and CacheService (6h)', () => {
    const { T, mocks } = setup();
    T.projects();
    T.projects();
    expect(mocks.UrlFetchApp.__find('GET', BASE + '/projects')).toHaveLength(1);
    const put = mocks.CacheService.__script.put.mock.calls.find(c => c[0] === 'todoist.projects');
    expect(put[2]).toBe(21600);
    // next execution: served from CacheService
    const ctx2 = loadGas(FILES, { mocks });
    expect(ctx2.Todoist.projects()).toHaveLength(6);
    expect(mocks.UrlFetchApp.__find('GET', BASE + '/projects')).toHaveLength(1);
  });

  test('projectId resolves routing keys, case-insensitive names, inbox, skips archived', () => {
    const { T } = setup({ props: { ROUTING: JSON.stringify({ projects: { SG: 'sg' } }) } });
    expect(T.projectId('GR')).toBe('p_gr');
    expect(T.projectId('isc')).toBe('p_isc');
    expect(T.projectId('SG')).toBe('p_sg');
    expect(T.projectId('Inbox')).toBe('p_inbox');
    expect(T.projectId('Old')).toBeNull();
    expect(T.projectId('Waiting')).toBeNull();
    expect(T.projectId(null)).toBeNull();
    expect(T.projectName('Waiting')).toBe('Waiting on others');
  });

  test('ensureProject creates once and updates cache', () => {
    const { T, mocks, state } = setup();
    const id = T.ensureProject('Waiting');
    expect(state.projects.find(p => p.id === id).name).toBe('Waiting on others');
    expect(T.ensureProject('Waiting on others')).toBe(id);
    expect(mocks.UrlFetchApp.__find('POST', BASE + '/projects')).toHaveLength(1);
    const cached = JSON.parse(mocks.CacheService.__script.__store['todoist.projects']);
    expect(cached.some(p => p.name === 'Waiting on others')).toBe(true);
  });

  test('sections cached; sectionId case-insensitive; never auto-created; neverUseSections excluded', () => {
    const { T, mocks } = setup();
    expect(T.sections('GR').map(s => s.name)).toContain('Arctos');
    expect(T.sectionId('GR', 'arctos')).toBe('p_gr_s5');
    expect(T.sectionId('GR', 'Nope')).toBeNull();
    expect(T.sectionId('GR', 'Generated Tasks')).toBeNull();
    expect(T.sectionId('GR', null)).toBeNull();
    expect(T.sectionNames('GR')).not.toContain('Generated Tasks');
    expect(T.sections('Waiting')).toEqual([]);
    expect(mocks.UrlFetchApp.__find('GET', BASE + '/sections')).toHaveLength(1);
    expect(mocks.UrlFetchApp.__find('POST', BASE + '/sections')).toHaveLength(0);
    expect(mocks.CacheService.__script.__store['todoist.sections.p_gr']).toBeDefined();
  });

  test('sectionCatalogue returns names per routing key', () => {
    const { T } = setup();
    const cat = T.sectionCatalogue();
    expect(Object.keys(cat)).toEqual(['GR', 'ISC', 'Me', 'SG']);
    expect(cat.ISC).toEqual(SECTIONS.p_isc);
    expect(cat.SG).toEqual([]);
  });

  test('resetCache(true) clears CacheService entries', () => {
    const { T, mocks } = setup();
    T.sections('GR');
    T.resetCache(true);
    expect(mocks.CacheService.__script.__store['todoist.projects']).toBeUndefined();
    expect(mocks.CacheService.__script.__store['todoist.sections.p_gr']).toBeUndefined();
  });
});

describe('tasks', () => {
  test('createTask maps fields, resolves project/section, ensures labels lazily', () => {
    const { T, mocks, state } = setup();
    const task = T.createTask({
      content: 'Send the Last Mile HPC deck to Jon Stumpf', description: 'desc',
      projectName: 'GR', sectionName: 'Reach Out', labels: ['meeting', 'waiting'], dueDate: '2026-10-01', priority: 2
    });
    const body = mocks.UrlFetchApp.__find('POST', BASE + '/tasks')[0].json;
    expect(body).toEqual({
      content: 'Send the Last Mile HPC deck to Jon Stumpf', description: 'desc', project_id: 'p_gr',
      section_id: 'p_gr_s0', labels: ['meeting', 'waiting'], due_date: '2026-10-01', priority: 2
    });
    expect(task.id).toBeDefined();
    expect(state.labels.map(l => l.name)).toEqual(['meeting', 'waiting']);
    T.createTask({ content: 'x', labels: ['waiting'] });
    expect(mocks.UrlFetchApp.__find('POST', BASE + '/labels')).toHaveLength(1);
    expect(mocks.UrlFetchApp.__find('GET', BASE + '/labels')).toHaveLength(1);
  });

  test('createTask: unknown section falls back to project root; dueString; no project -> inbox', () => {
    const { T, mocks } = setup();
    T.createTask({ content: 'a', projectName: 'Me', sectionName: 'Nope', dueString: 'today' });
    const body = mocks.UrlFetchApp.__find('POST', BASE + '/tasks')[0].json;
    expect(body.section_id).toBeUndefined();
    expect(body.project_id).toBe('p_me');
    expect(body.due_string).toBe('today');
    T.createTask({ content: 'b' });
    expect(mocks.UrlFetchApp.__find('POST', BASE + '/tasks')[1].json.project_id).toBeUndefined();
  });

  test('createTask errors: empty content, unknown project', () => {
    const { T } = setup();
    expect(() => T.createTask({ content: '' })).toThrow(/content required/);
    expect(() => T.createTask({ content: 'x', projectName: 'Nope' })).toThrow(/project not found: Nope/);
  });

  test('openTasks across default projects (skips missing Waiting), paginated, cached per run, tagged', () => {
    const tasks = [
      { id: '1', content: 'GR task', project_id: 'p_gr' },
      { id: '2', content: 'GR task 2', project_id: 'p_gr' },
      { id: '3', content: 'GR task 3', project_id: 'p_gr' },
      { id: '4', content: 'Me task', project_id: 'p_me', description: 'x\n<!-- ta:{"key":"check:summaries"} -->' },
      { id: '5', content: 'Old', project_id: 'p_old' }
    ];
    const { T, mocks } = setup({ tasks, pageSize: 2 });
    const open = T.openTasks();
    expect(open.map(t => t.id)).toEqual(['1', '2', '3', '4']);
    expect(open[0].projectName).toBe('GR');
    expect(open[3].projectName).toBe('Me');
    const n = mocks.UrlFetchApp.__find('GET', BASE + '/tasks').length;
    T.openTasks();
    expect(mocks.UrlFetchApp.__find('GET', BASE + '/tasks').length).toBe(n);
    expect(T.openTasks({ projectNames: ['Me'] }).map(t => t.id)).toEqual(['4']);
    expect(T.findByMachineKey('check:summaries').id).toBe('4');
    expect(T.findByMachineKey('nope')).toBeNull();
  });

  test('created / closed / deleted tasks keep the run cache consistent', () => {
    const { T } = setup({ tasks: [{ id: '1', content: 'a', project_id: 'p_gr' }] });
    T.openTasks();
    const t = T.createTask({ content: 'new', projectName: 'GR' });
    expect(T.openTasks().map(x => x.id)).toEqual(['1', t.id]);
    T.closeTask('1');
    expect(T.openTasks().map(x => x.id)).toEqual([t.id]);
    T.deleteTask(t.id);
    expect(T.openTasks()).toEqual([]);
  });

  test('updateTask maps camelCase, clears due, refuses moves', () => {
    const { T, mocks } = setup({ tasks: [{ id: '1', content: 'a', project_id: 'p_gr' }] });
    T.openTasks();
    T.updateTask('1', { content: 'b', dueDate: '2026-10-02', labels: ['meeting'] });
    let body = mocks.UrlFetchApp.__find('POST', BASE + '/tasks/1')[0].json;
    expect(body).toEqual({ content: 'b', due_date: '2026-10-02', labels: ['meeting'] });
    expect(T.openTasks()[0].content).toBe('b');
    T.updateTask('1', { dueDate: null });
    body = mocks.UrlFetchApp.__find('POST', BASE + '/tasks/1')[1].json;
    expect(body).toEqual({ due_string: 'no date' });
    T.updateTask('1', { dueString: 'today' });
    expect(mocks.UrlFetchApp.__find('POST', BASE + '/tasks/1')[2].json).toEqual({ due_string: 'today' });
    expect(() => T.updateTask('1', { projectName: 'ISC' })).toThrow(/moveTask/);
  });

  test('moveTask uses section_id when section exists, else project_id', () => {
    const { T, mocks, state } = setup({ tasks: [{ id: '1', content: 'a', project_id: 'p_gr' }] });
    T.moveTask('1', { projectName: 'ISC', sectionName: 'Reach Out' });
    expect(mocks.UrlFetchApp.__find('POST', BASE + '/tasks/1/move')[0].json).toEqual({ section_id: 'p_isc_s0' });
    expect(state.tasks[0].project_id).toBe('p_isc');
    T.moveTask('1', { projectName: 'Me' });
    expect(mocks.UrlFetchApp.__find('POST', BASE + '/tasks/1/move')[1].json).toEqual({ project_id: 'p_me' });
    expect(() => T.moveTask('1', { projectName: 'Nope' })).toThrow(/not found/);
  });

  test('closeTask / reopenTask / addComment / getTask / filterTasks', () => {
    const { T, mocks, state } = setup({ tasks: [{ id: '1', content: 'a', project_id: 'p_gr', labels: ['waiting'] }] });
    expect(T.getTask('1').content).toBe('a');
    expect(T.getTask('404')).toBeNull();
    expect(T.filterTasks('@waiting').map(t => t.id)).toEqual(['1']);
    expect(mocks.UrlFetchApp.__find('GET', BASE + '/tasks/filter')[0].query.query).toBe('@waiting');
    T.addComment('1', 'Auto-closed: done');
    expect(state.comments[0]).toMatchObject({ task_id: '1', content: 'Auto-closed: done' });
    expect(T.closeTask('1')).toBe(true);
    expect(T.reopenTask('1')).toBe(true);
    expect(mocks.UrlFetchApp.__find('POST', BASE + '/tasks/1/reopen')).toHaveLength(1);
    expect(T.taskUrl('1')).toBe('https://app.todoist.com/app/task/1');
  });

  test('getTask rethrows non-404 errors', () => {
    const { T, mocks } = setup();
    mocks.UrlFetchApp.__on('GET', BASE + '/tasks/boom', respond.status(403, 'forbidden'));
    expect(() => T.getTask('boom')).toThrow(expect.objectContaining({ status: 403 }));
  });
});

describe('machine line', () => {
  test('machineLine / parseMachineLine round trip', () => {
    const { T } = setup();
    const line = T.machineLine({ key: 'granola:not_xxx', q: 'q_abc' });
    expect(line).toBe('<!-- ta:{"key":"granola:not_xxx","q":"q_abc"} -->');
    const desc = 'Meeting: Sync · Thu 24 Sep\n> quote\n' + line;
    expect(T.parseMachineLine(desc)).toEqual({ key: 'granola:not_xxx', q: 'q_abc' });
  });

  test('nested objects, "--" and ">" in values cannot break the comment', () => {
    const { T } = setup();
    const obj = { key: 'k', dest: 'ISC/Reach Out', owner: 'a -- b -> c', nested: { x: 1 } };
    const line = T.machineLine(obj);
    expect(line.slice(4, -4)).not.toMatch(/--/);
    expect(T.parseMachineLine('text\n' + line)).toEqual(obj);
  });

  test('parse returns null for missing/invalid and picks the last line', () => {
    const { T } = setup();
    expect(T.parseMachineLine(null)).toBeNull();
    expect(T.parseMachineLine('no line')).toBeNull();
    expect(T.parseMachineLine('<!-- ta:{bad} -->')).toBeNull();
    expect(T.parseMachineLine('<!-- ta:{"key":"a"} -->\n<!-- ta:{"key":"b"} -->')).toEqual({ key: 'b' });
  });

  test('withMachineLine replaces any existing line and keeps it last', () => {
    const { T } = setup();
    const d = T.withMachineLine('Body\n<!-- ta:{"key":"old"} -->\n', { key: 'new' });
    expect(d).toBe('Body\n<!-- ta:{"key":"new"} -->');
    expect(T.withMachineLine('', { key: 'x' })).toBe('<!-- ta:{"key":"x"} -->');
  });
});
