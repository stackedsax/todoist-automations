/**
 * Todoist — API v1 client, project/section resolution, open-task cache, machine lines.
 *
 * Reference: https://developer.todoist.com/api/v1/
 *   GET  /projects, /sections?project_id=, /tasks?project_id=, /tasks/filter?query=, /labels
 *        -> paginated {results: [...], next_cursor: string|null} (param `cursor`, `limit` <= 200)
 *   POST /projects {name}                      -> project
 *   POST /tasks {content, description, project_id, section_id, labels, due_date, due_string, priority}
 *   GET  /tasks/{id}                           -> task
 *   POST /tasks/{id} {…fields}                 -> updated task
 *   POST /tasks/{id}/close | /tasks/{id}/reopen -> 204
 *   POST /tasks/{id}/move {project_id | section_id | parent_id}
 *   DELETE /tasks/{id}                         -> 204
 *   POST /comments {task_id, content}          -> comment
 *   POST /labels {name}                        -> label
 * List handling accepts both {results, next_cursor} and bare arrays.
 */
const Todoist = {
  BASE: 'https://api.todoist.com/api/v1',
  PAGE_LIMIT: 200,
  CACHE_TTL_S: 6 * 3600,
  MACHINE_RE_: /<!--\s*ta:(\{.*?\})\s*-->/g,
  LABELS: ['meeting', 'from-email', 'from-slack', 'waiting', 'check'],

  mem_: { projects: null, sections: {}, openTasks: {}, labels: null },

  /** Clear in-memory caches (and CacheService entries when `all`). */
  resetCache(all) {
    if (all) {
      const c = CacheService.getScriptCache();
      const keys = ['todoist.projects'];
      (Todoist.mem_.projects || []).forEach(function (p) { keys.push('todoist.sections.' + p.id); });
      c.removeAll(keys);
    }
    Todoist.mem_ = { projects: null, sections: {}, openTasks: {}, labels: null };
  },

  // ---------------------------------------------------------------- transport

  /** Authenticated JSON request against the v1 base. */
  api(method, path, opts) {
    const o = opts || {};
    return Http.fetchJson(Todoist.BASE + path, {
      method: method,
      headers: { Authorization: 'Bearer ' + Config.require('TODOIST_API_TOKEN') },
      query: o.query,
      payload: o.body
    });
  },

  /** GET a list endpoint following next_cursor. Returns a flat array. */
  list(path, query) {
    const out = [];
    let cursor = null;
    for (let page = 0; page < 500; page++) {
      const q = Object.assign({ limit: Todoist.PAGE_LIMIT }, query || {});
      if (cursor) q.cursor = cursor;
      const res = Todoist.api('get', path, { query: q });
      if (Array.isArray(res)) return out.concat(res);
      if (!res) break;
      (res.results || []).forEach(function (x) { out.push(x); });
      cursor = res.next_cursor || null;
      if (!cursor) break;
    }
    return out;
  },

  // ---------------------------------------------------------------- projects & sections

  /** Resolve a routing key ("GR", "Waiting") to its real project name via Config.routing().projects. */
  projectName(nameOrKey) {
    if (!nameOrKey) return null;
    const map = Config.routing().projects || {};
    return Object.prototype.hasOwnProperty.call(map, nameOrKey) ? map[nameOrKey] : nameOrKey;
  },

  /** All projects (memory + CacheService 6h). */
  projects() {
    if (Todoist.mem_.projects) return Todoist.mem_.projects;
    const cache = CacheService.getScriptCache();
    const hit = Util.parseJson(cache.get('todoist.projects'), null);
    if (hit) {
      Todoist.mem_.projects = hit;
      return hit;
    }
    const all = Todoist.list('/projects').map(function (p) {
      return { id: String(p.id), name: p.name, inbox_project: !!p.inbox_project, is_archived: !!p.is_archived, parent_id: p.parent_id || null };
    });
    Todoist.mem_.projects = all;
    Todoist.cachePut_('todoist.projects', all);
    return all;
  },

  /** Project object by name or routing key (case-insensitive; "Inbox" also matches inbox_project). */
  project(nameOrKey) {
    const name = Todoist.projectName(nameOrKey);
    if (!name) return null;
    const lower = String(name).toLowerCase();
    const ps = Todoist.projects().filter(function (p) { return !p.is_archived; });
    return ps.find(function (p) { return p.name === name; }) ||
      ps.find(function (p) { return String(p.name).toLowerCase() === lower; }) ||
      (lower === 'inbox' ? ps.find(function (p) { return p.inbox_project; }) : null) || null;
  },

  /** Project id by name or routing key, or null. */
  projectId(nameOrKey) {
    const p = Todoist.project(nameOrKey);
    return p ? p.id : null;
  },

  /** Project id, creating the project if missing. Only intended for "Waiting on others". */
  ensureProject(nameOrKey) {
    const existing = Todoist.projectId(nameOrKey);
    if (existing) return existing;
    const name = Todoist.projectName(nameOrKey);
    const p = Todoist.api('post', '/projects', { body: { name: name } });
    const rec = { id: String(p.id), name: p.name || name, inbox_project: false, is_archived: false, parent_id: null };
    Todoist.projects().push(rec);
    Todoist.cachePut_('todoist.projects', Todoist.mem_.projects);
    return rec.id;
  },

  /** Sections of a project [{id, name, project_id, order}] (memory + CacheService 6h). [] if project missing. */
  sections(projectNameOrKey) {
    const pid = Todoist.projectId(projectNameOrKey);
    if (!pid) return [];
    if (Todoist.mem_.sections[pid]) return Todoist.mem_.sections[pid];
    const key = 'todoist.sections.' + pid;
    const cache = CacheService.getScriptCache();
    let secs = Util.parseJson(cache.get(key), null);
    if (!secs) {
      secs = Todoist.list('/sections', { project_id: pid }).map(function (s) {
        return { id: String(s.id), name: s.name, project_id: String(s.project_id || pid), order: s.section_order || s.order || 0 };
      });
      Todoist.cachePut_(key, secs);
    }
    Todoist.mem_.sections[pid] = secs;
    return secs;
  },

  /** Section names usable for routing (excludes routing.neverUseSections). */
  sectionNames(projectNameOrKey) {
    const never = Todoist.neverUse_();
    return Todoist.sections(projectNameOrKey).map(function (s) { return s.name; })
      .filter(function (n) { return !never[String(n).toLowerCase()]; });
  },

  /** {GR: [names], ISC: [...], ...} for the given routing keys (default GR, ISC, Me, SG). */
  sectionCatalogue(keys) {
    const out = {};
    (keys || ['GR', 'ISC', 'Me', 'SG']).forEach(function (k) {
      try {
        out[k] = Todoist.sectionNames(k);
      } catch (e) {
        console.log('sectionCatalogue ' + k + ': ' + e.message);
        out[k] = [];
      }
    });
    return out;
  },

  /** Section id or null if missing / in neverUseSections. Never creates sections. */
  sectionId(projectNameOrKey, sectionName) {
    if (!sectionName) return null;
    const lower = String(sectionName).trim().toLowerCase();
    if (Todoist.neverUse_()[lower]) return null;
    const s = Todoist.sections(projectNameOrKey).find(function (x) { return String(x.name).trim().toLowerCase() === lower; });
    return s ? s.id : null;
  },

  neverUse_() {
    const m = {};
    (Config.routing().neverUseSections || []).forEach(function (n) { m[String(n).toLowerCase()] = 1; });
    return m;
  },

  cachePut_(key, value) {
    try {
      CacheService.getScriptCache().put(key, JSON.stringify(value), Todoist.CACHE_TTL_S);
    } catch (e) {
      console.log('cache put failed for ' + key + ': ' + e.message);
    }
  },

  // ---------------------------------------------------------------- labels

  /** Ensure personal labels exist (created lazily, once per execution). */
  ensureLabels(names) {
    if (!names || !names.length) return;
    if (!Todoist.mem_.labels) {
      Todoist.mem_.labels = {};
      Todoist.list('/labels').forEach(function (l) { Todoist.mem_.labels[String(l.name).toLowerCase()] = 1; });
    }
    names.forEach(function (n) {
      const k = String(n).toLowerCase();
      if (Todoist.mem_.labels[k]) return;
      Todoist.api('post', '/labels', { body: { name: n } });
      Todoist.mem_.labels[k] = 1;
    });
  },

  // ---------------------------------------------------------------- tasks

  /**
   * Create a task.
   * @param {{content: string, description?: string, projectName?: string, projectId?: string,
   *          sectionName?: string, sectionId?: string, labels?: string[], dueDate?: string,
   *          dueString?: string, priority?: number, parentId?: string}} t
   *   projectName accepts routing keys ("GR", "Waiting"). Unknown sections fall back to project root.
   *   No project -> Todoist Inbox.
   * @return {Object} the created task (API shape).
   */
  createTask(t) {
    const body = { content: String(t.content || '').slice(0, 500) };
    if (!body.content) throw new Error('createTask: content required');
    if (t.description) body.description = String(t.description).slice(0, 16000);
    const pid = t.projectId || (t.projectName ? Todoist.projectId(t.projectName) : null);
    if (t.projectName && !pid) throw new Error('Todoist project not found: ' + t.projectName);
    if (pid) body.project_id = pid;
    const sid = t.sectionId || (t.sectionName && t.projectName ? Todoist.sectionId(t.projectName, t.sectionName) : null);
    if (sid) body.section_id = sid;
    if (t.parentId) body.parent_id = t.parentId;
    if (t.labels && t.labels.length) {
      Todoist.ensureLabels(t.labels);
      body.labels = t.labels;
    }
    if (t.dueDate) body.due_date = t.dueDate;
    else if (t.dueString) body.due_string = t.dueString;
    if (t.priority) body.priority = t.priority;
    const task = Todoist.api('post', '/tasks', { body: body });
    Todoist.rememberTask_(task);
    return task;
  },

  /** GET a task by id (null on 404). */
  getTask(id) {
    try {
      return Todoist.api('get', '/tasks/' + encodeURIComponent(id));
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  },

  /**
   * Update fields. Accepts camelCase {content, description, labels, dueDate, dueString, priority}
   * or raw API keys (due_date, due_string, …). dueDate/dueString null clears via due_string "no date".
   */
  updateTask(id, patch) {
    const p = patch || {};
    const body = {};
    Object.keys(p).forEach(function (k) {
      if (k === 'dueDate') {
        if (p.dueDate) body.due_date = p.dueDate; else body.due_string = 'no date';
      } else if (k === 'dueString') {
        body.due_string = p.dueString || 'no date';
      } else if (k === 'projectName' || k === 'sectionName') {
        throw new Error('updateTask cannot move tasks; use Todoist.moveTask');
      } else body[k] = p[k];
    });
    if (body.labels) Todoist.ensureLabels(body.labels);
    const task = Todoist.api('post', '/tasks/' + encodeURIComponent(id), { body: body });
    Todoist.patchCached_(id, task || body);
    return task;
  },

  /** Move to project (routing key ok) and optional section (falls back to project root). */
  moveTask(id, dest) {
    const pid = Todoist.projectId(dest.projectName);
    if (!pid) throw new Error('Todoist project not found: ' + dest.projectName);
    const sid = dest.sectionName ? Todoist.sectionId(dest.projectName, dest.sectionName) : null;
    const body = sid ? { section_id: sid } : { project_id: pid };
    const res = Todoist.api('post', '/tasks/' + encodeURIComponent(id) + '/move', { body: body });
    Todoist.patchCached_(id, { project_id: pid, section_id: sid });
    return res;
  },

  /** Complete a task. */
  closeTask(id) {
    Todoist.api('post', '/tasks/' + encodeURIComponent(id) + '/close');
    Todoist.forgetTask_(id);
    return true;
  },

  /** Reopen a completed task. */
  reopenTask(id) {
    Todoist.api('post', '/tasks/' + encodeURIComponent(id) + '/reopen');
    return true;
  },

  /** Delete a task. */
  deleteTask(id) {
    Todoist.api('delete', '/tasks/' + encodeURIComponent(id));
    Todoist.forgetTask_(id);
    return true;
  },

  /** Add a comment to a task. */
  addComment(taskId, content) {
    return Todoist.api('post', '/comments', { body: { task_id: String(taskId), content: String(content).slice(0, 15000) } });
  },

  /** Tasks matching a Todoist filter query (GET /tasks/filter). */
  filterTasks(query) {
    return Todoist.list('/tasks/filter', { query: query });
  },

  /**
   * All open tasks in the given projects (routing keys or names; default GR, ISC, Me, SG, Inbox, Waiting).
   * Missing projects are skipped. Each task gets `projectName` (routing key when given). Cached per execution.
   */
  openTasks(opts) {
    const keys = (opts && opts.projectNames) || ['GR', 'ISC', 'Me', 'SG', 'Inbox', 'Waiting'];
    const out = [];
    keys.forEach(function (k) {
      const pid = Todoist.projectId(k);
      if (!pid) return;
      if (!Todoist.mem_.openTasks[pid]) {
        Todoist.mem_.openTasks[pid] = { key: k, tasks: Todoist.list('/tasks', { project_id: pid }) };
      }
      Todoist.mem_.openTasks[pid].tasks.forEach(function (t) {
        t.projectName = k;
        out.push(t);
      });
    });
    return out;
  },

  /** First open task (in openTasks scope) whose machine line has `key`, or null. */
  findByMachineKey(key, opts) {
    return Todoist.openTasks(opts).find(function (t) {
      const m = Todoist.parseMachineLine(t.description);
      return m && m.key === key;
    }) || null;
  },

  /** https://app.todoist.com/app/task/<id> */
  taskUrl(id) {
    return 'https://app.todoist.com/app/task/' + id;
  },

  rememberTask_(task) {
    if (!task || !task.project_id) return;
    const bucket = Todoist.mem_.openTasks[String(task.project_id)];
    if (bucket) bucket.tasks.push(task);
  },

  forgetTask_(id) {
    Object.keys(Todoist.mem_.openTasks).forEach(function (pid) {
      const b = Todoist.mem_.openTasks[pid];
      b.tasks = b.tasks.filter(function (t) { return String(t.id) !== String(id); });
    });
  },

  patchCached_(id, fields) {
    Object.keys(Todoist.mem_.openTasks).forEach(function (pid) {
      Todoist.mem_.openTasks[pid].tasks.forEach(function (t) {
        if (String(t.id) === String(id)) Object.assign(t, fields);
      });
    });
  },

  // ---------------------------------------------------------------- machine line

  /** '<!-- ta:{"key":…} -->' (compact JSON; "--" escaped so the comment cannot terminate early). */
  machineLine(obj) {
    const json = JSON.stringify(obj || {}).replace(/--/g, '-\\u002d').replace(/>/g, '\\u003e');
    return '<!-- ta:' + json + ' -->';
  },

  /** Parse the last machine line in a description, or null. */
  parseMachineLine(description) {
    if (!description) return null;
    const re = new RegExp(Todoist.MACHINE_RE_.source, 'g');
    let m, last = null;
    while ((m = re.exec(String(description))) !== null) last = m[1];
    if (!last) return null;
    return Util.parseJson(last, null);
  },

  /** Description with any machine line removed and `obj`'s machine line appended as the last line. */
  withMachineLine(description, obj) {
    const body = String(description || '').replace(new RegExp(Todoist.MACHINE_RE_.source, 'g'), '').replace(/\s+$/, '');
    return (body ? body + '\n' : '') + Todoist.machineLine(obj);
  }
};
