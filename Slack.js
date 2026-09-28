/**
 * Slack — Slack capture for every workspace in SLACK_WORKSPACES (docs/DESIGN.md "Slack").
 *
 *  - Explicit: messages Alex reacted to with :todo: (SLACK_TODO_EMOJI) -> a Todoist task straight
 *    away in the workspace's default project (label from-slack, permalink, message text).
 *    Ledger key slack:<ws>:<channel>:<ts>.
 *  - Passive: mentions of Alex and DMs to him (search.messages) since the per-workspace cursor
 *    (kv slack.<ws>.oldest) -> Extract.slack -> triage queue (never direct).
 *    Ledger key slack:<ws>:<channel>:<ts>:scan, so a later :todo: reaction still creates a task.
 *  - Slack.search(query, sinceDate) for Waiting evidence.
 *
 * Slack Web API (user tokens xoxp-, sent as `Authorization: Bearer`; every method answers HTTP 200
 * with {ok: false, error} on failure, and 429 + Retry-After when rate limited — Http retries those):
 *   auth.test          https://docs.slack.dev/reference/methods/auth.test/        -> {ok, user_id, user, team, team_id, url}
 *   reactions.list     https://docs.slack.dev/reference/methods/reactions.list/   ?user&full&limit&cursor
 *                      -> {items: [{type: "message", channel, message: {ts, user, text, reactions: [{name, users, count}]}}],
 *                          response_metadata: {next_cursor}}   (no time filter: we page until nothing new)
 *   search.messages    https://docs.slack.dev/reference/methods/search.messages/  ?query&count(<=100)&page&sort&sort_dir
 *                      -> {messages: {matches: [{channel: {id, name, is_im?, is_mpim?}, ts, user, username, text, permalink}],
 *                          pagination: {page, page_count, per_page, total_count}}}   (scope search:read)
 *   chat.getPermalink  https://docs.slack.dev/reference/methods/chat.getPermalink/ ?channel&message_ts -> {ok, channel, permalink}
 *   users.info         https://docs.slack.dev/reference/methods/users.info/       ?user -> {user: {id, name, real_name, profile: {display_name, real_name, email}}}
 * Search modifiers (after:YYYY-MM-DD is exclusive and day-granular, so we search from the day
 * before the cursor and filter by ts): https://slack.com/help/articles/202528808-Search-in-Slack
 */
const Slack = {
  API: 'https://slack.com/api/',
  RESERVE_MS: 45000,
  MAX_ATTEMPTS: 3,
  FIRST_RUN_DAYS: 2,
  /** Passive search re-reads this far behind the cursor to catch late-indexed messages. */
  PASSIVE_OVERLAP_S: 3600,
  REACTION_PAGE_SIZE: 100,
  MAX_REACTION_PAGES: 5,
  SEARCH_PAGE_SIZE: 100,
  MAX_SEARCH_PAGES: 5,
  EXTRACT_BATCH: 10,
  MAX_PASSIVE: 150,
  MAX_TEXT: 1500,
  /** Search queries for passive capture; {uid} is replaced by the token owner's user id. */
  DEFAULT_QUERIES: ['<@{uid}>', 'to:me'],

  mem_: { me: {}, users: {} },

  // ------------------------------------------------------------------ Web API

  /** Configured workspaces [{name, token, project}] with a token. */
  workspaces() {
    return Config.slackWorkspaces().filter(function (w) { return w && w.name && w.token; });
  },

  /**
   * Call a Web API method. Throws an Error (name 'SlackError', .slackError) when ok is false.
   * @param {{name, token}} ws
   * @param {string} method e.g. 'reactions.list'
   * @param {Object} [params] query parameters
   * @param {string} [httpMethod] 'get' (default) or 'post'
   */
  api(ws, method, params, httpMethod) {
    const res = Http.fetchJson(Slack.API + method, {
      method: httpMethod || 'get',
      headers: { Authorization: 'Bearer ' + ws.token },
      query: params || undefined
    }) || {};
    if (!res.ok) {
      const err = new Error('Slack ' + method + ' failed for ' + ws.name + ': ' + (res.error || 'unknown error'));
      err.name = 'SlackError';
      err.slackError = res.error || null;
      throw err;
    }
    return res;
  },

  /** Token owner {userId, name, team, url} (auth.test; memoised per execution). */
  me(ws) {
    if (!Slack.mem_.me[ws.name]) {
      const r = Slack.api(ws, 'auth.test', null, 'post');
      Slack.mem_.me[ws.name] = { userId: r.user_id, name: r.user || null, team: r.team || null, url: r.url || null };
    }
    return Slack.mem_.me[ws.name];
  },

  /** Display name for a user id (users.info; memory + CacheService 6h). Falls back to the id. */
  userName(ws, uid) {
    if (!uid) return null;
    const k = ws.name + ':' + uid;
    if (Slack.mem_.users[k]) return Slack.mem_.users[k];
    const cacheKey = 'slack.user.' + Util.hash(k, 12);
    let name = null;
    try { name = CacheService.getScriptCache().get(cacheKey); } catch (e) { name = null; }
    if (!name) {
      try {
        const u = (Slack.api(ws, 'users.info', { user: uid }) || {}).user || {};
        const p = u.profile || {};
        name = p.real_name || u.real_name || p.display_name || u.name || uid;
        try { CacheService.getScriptCache().put(cacheKey, name, 21600); } catch (e) { /* cache is best-effort */ }
      } catch (e) {
        name = uid;
      }
    }
    Slack.mem_.users[k] = name;
    return name;
  },

  /** Permalink for a message, or null. */
  permalink(ws, channel, ts) {
    try {
      return Slack.api(ws, 'chat.getPermalink', { channel: channel, message_ts: ts }).permalink || null;
    } catch (e) {
      console.log('[slack] permalink failed for ' + ws.name + ' ' + channel + ' ' + ts + ': ' + Slack.errText_(e));
      return null;
    }
  },

  /**
   * search.messages sorted by timestamp (opts.sortDir, default 'desc') across up to maxPages pages.
   * @param {{count?: number, maxPages?: number, sortDir?: string, deadline?: Object}} [opts]
   * @return {Object[]} raw matches; `.truncated` is true when more pages were left unread
   */
  searchRaw(ws, query, opts) {
    const o = opts || {};
    const count = Math.min(Slack.SEARCH_PAGE_SIZE, o.count || Slack.SEARCH_PAGE_SIZE);
    const maxPages = o.maxPages || Slack.MAX_SEARCH_PAGES;
    const out = [];
    for (let page = 1; page <= maxPages; page++) {
      if (page > 1 && o.deadline && o.deadline.expired()) break;
      const res = Slack.api(ws, 'search.messages', {
        query: query, count: count, page: page, sort: 'timestamp', sort_dir: o.sortDir || 'desc'
      });
      const msgs = res.messages || {};
      (msgs.matches || []).forEach(function (m) { out.push(m); });
      const pg = msgs.pagination || msgs.paging || {};
      const pages = pg.page_count || pg.pages || 1;
      out.truncated = page < pages;
      if (!(msgs.matches || []).length || page >= pages) { out.truncated = false; break; }
    }
    return out;
  },

  /**
   * Waiting evidence: messages matching `query` since `sinceDate`, across all workspaces (or
   * opts.workspace). Never throws; failing workspaces are logged and skipped.
   * @param {string} query Slack search query (modifiers allowed)
   * @param {Date|string} [sinceDate]
   * @param {{workspace?: string, max?: number}} [opts]
   * @return {Object[]} [{source: 'slack', workspace, date: Date, from, title, text, link}] newest first
   */
  search(query, sinceDate, opts) {
    const o = opts || {};
    const max = o.max || 20;
    const since = Util.parseDate(sinceDate);
    const q = String(query || '').trim() + (since ? ' after:' + Util.addDaysIso(since, -1) : '');
    if (!String(query || '').trim()) return [];
    const out = [];
    Slack.workspaces().forEach(function (ws) {
      if (o.workspace && o.workspace !== ws.name) return;
      try {
        Slack.searchRaw(ws, q.trim(), { maxPages: 1, count: Math.min(100, max) }).forEach(function (m) {
          const date = Slack.tsDate_(m.ts);
          if (since && date && date.getTime() < since.getTime()) return;
          const ch = m.channel || {};
          out.push({
            source: 'slack',
            workspace: ws.name,
            date: date,
            from: m.username || m.user || null,
            title: Slack.isDm_(ch) ? 'DM' : '#' + (ch.name || ch.id || '?'),
            text: Util.truncate(String(m.text || ''), Slack.MAX_TEXT),
            link: m.permalink || null
          });
        });
      } catch (e) {
        console.log('[slack] search failed for ' + ws.name + ': ' + Slack.errText_(e));
      }
    });
    out.sort(function (a, b) { return (b.date ? b.date.getTime() : 0) - (a.date ? a.date.getTime() : 0); });
    return out.slice(0, max);
  },

  // ------------------------------------------------------------------ run

  /**
   * One capture run over every workspace (callers hold the lock).
   * @param {{deadline?: Object}} [opts]
   * @return {{job, seen, created, queued, skipped, errors, stoppedEarly, note, workspaces}}
   */
  run(opts) {
    const o = opts || {};
    const deadline = o.deadline || Util.deadline();
    const started = Util.now().getTime();
    const stats = { job: 'slack', seen: 0, created: 0, queued: 0, skipped: 0, errors: 0, stoppedEarly: false, workspaces: {}, notes: [] };
    const ctx = { deadline: deadline, stats: stats, cache: {} };
    const list = Slack.workspaces();
    if (!list.length) stats.notes.push('SLACK_WORKSPACES not set; nothing to do');
    list.forEach(function (ws) {
      if (Slack.outOfTime_(deadline)) { stats.stoppedEarly = true; return; }
      const wsStats = stats.workspaces[ws.name] = { created: 0, queued: 0 };
      try {
        const me = Slack.me(ws);
        wsStats.created = Slack.captureReactions_(ws, me, ctx);
        if (Slack.outOfTime_(deadline)) { stats.stoppedEarly = true; return; }
        wsStats.queued = Slack.capturePassive_(ws, me, ctx);
      } catch (e) {
        stats.errors++;
        stats.notes.push(ws.name + ': ' + Util.truncate(Slack.errText_(e), 160));
        console.log('[slack] ' + ws.name + ' failed: ' + Slack.errText_(e));
      }
    });
    if (stats.stoppedEarly) stats.notes.push('stopped at deadline; will resume');
    stats.note = stats.notes.join('; ');
    delete stats.notes;
    try {
      Store.runLog({
        job: 'slack', durationMs: Util.now().getTime() - started, seen: stats.seen, created: stats.created,
        queued: stats.queued, skipped: stats.skipped, errors: stats.errors, note: Util.truncate(stats.note, 1000)
      });
    } catch (e) {
      console.log('[slack] could not write run log: ' + Slack.errText_(e));
    }
    console.log('[slack] seen=' + stats.seen + ' created=' + stats.created + ' queued=' + stats.queued +
      ' skipped=' + stats.skipped + ' errors=' + stats.errors + (stats.note ? ' — ' + stats.note : ''));
    return stats;
  },

  // ------------------------------------------------------------------ explicit (:todo: reactions)

  emoji() {
    return String(Config.get('SLACK_TODO_EMOJI', 'todo') || 'todo').replace(/^:|:$/g, '').toLowerCase();
  },

  /** True when the message carries the todo reaction from `uid` (skin-tone variants count). */
  hasTodoReaction_(message, uid, emoji) {
    return (message.reactions || []).some(function (r) {
      const name = String(r.name || '').toLowerCase();
      if (name !== emoji && name.indexOf(emoji + '::') !== 0) return false;
      return !uid || !r.users || r.users.indexOf(uid) >= 0;
    });
  },

  /**
   * reactions.list has no time filter and lists newest reactions first, so page until a page
   * brings nothing new. On the very first run (no kv slack.<ws>.reactionsSince yet), :todo:
   * messages older than FIRST_RUN_DAYS are sent to the triage queue (chip "Baseline") instead of
   * becoming tasks: reactions.list gives no reaction time, so an old message may carry a fresh
   * reaction, and a queue item lets Alex decide rather than dropping it.
   * @return {number} tasks created
   */
  captureReactions_(ws, me, ctx) {
    const stats = ctx.stats;
    const emoji = Slack.emoji();
    const kvKey = 'slack.' + ws.name + '.reactionsSince';
    const since = Store.kvGet(kvKey, null);
    const baselineBefore = since ? null : Util.addDays(Util.now(), -Slack.FIRST_RUN_DAYS).getTime() / 1000;

    const fresh = [];
    let cursor = null;
    let complete = true;
    for (let page = 0; page < Slack.MAX_REACTION_PAGES; page++) {
      if (page > 0 && Slack.outOfTime_(ctx.deadline)) { complete = false; break; }
      const res = Slack.api(ws, 'reactions.list', { user: me.userId, full: true, limit: Slack.REACTION_PAGE_SIZE, cursor: cursor || undefined });
      let newOnPage = 0, oldOnPage = 0;
      (res.items || []).forEach(function (it) {
        if (!it || it.type !== 'message' || !it.message || !it.channel) return;
        if (!Slack.hasTodoReaction_(it.message, me.userId, emoji)) return;
        const key = Slack.key_(ws, it.channel, it.message.ts);
        if (Slack.done_(key)) { oldOnPage++; return; }
        if (fresh.some(function (f) { return f.key === key; })) return;
        newOnPage++;
        fresh.push({ key: key, channel: it.channel, message: it.message });
      });
      cursor = res.response_metadata && res.response_metadata.next_cursor;
      if (!cursor) break;
      if (!newOnPage && oldOnPage) break; // everything older has been seen already
    }
    stats.seen += fresh.length;

    const toCreate = [];
    const baseline = [];
    fresh.forEach(function (f) {
      if (baselineBefore !== null && Number(f.message.ts) < baselineBefore) baseline.push(f);
      else toCreate.push(f);
    });
    if (baseline.length) Slack.queueBaseline_(ws, me, baseline, ctx);

    // Oldest first, so a deadline stop leaves the newest for the next run.
    toCreate.sort(function (a, b) { return Number(a.message.ts) - Number(b.message.ts); });
    const suggestions = Slack.suggestTitles_(ws, me, toCreate, ctx);
    let created = 0;
    for (let i = 0; i < toCreate.length; i++) {
      if (Slack.outOfTime_(ctx.deadline)) { complete = false; ctx.stats.stoppedEarly = true; break; }
      const f = toCreate[i];
      try {
        if (Slack.createTodoTask_(ws, me, f, suggestions[f.key] || null)) { created++; stats.created++; }
      } catch (e) {
        Slack.recordError_(f.key, e, stats);
      }
    }
    if (!since && complete) Store.kvSet(kvKey, Util.now().toISOString());
    return created;
  },

  /**
   * Nicer titles/sections for explicit captures from one Extract.slack call. Best-effort: the
   * message text is the fallback title, and nothing here decides whether a task is created.
   * @return {Object} key -> {title, section}
   */
  suggestTitles_(ws, me, list, ctx) {
    const out = {};
    if (!list.length) return out;
    try {
      const catalogue = Slack.catalogue_(ctx);
      const project = Slack.projectKey_(ws);
      const msgs = list.map(function (f) {
        return Slack.extractMsg_(ws, me, {
          key: f.key, channel: f.channel, ts: f.message.ts, user: f.message.user, text: f.message.text,
          isDm: /^D/.test(String(f.channel))
        });
      });
      const items = Extract.slack(msgs, {
        me: me, users: Slack.usersIn_(ws, msgs), project: project, sectionsByProject: catalogue, today: Util.today()
      }) || [];
      items.forEach(function (it) {
        if (!it || !it.ref || !it.title || out[it.ref]) return;
        const section = it.section && (!it.project || it.project === project) &&
          (catalogue[project] || []).indexOf(it.section) >= 0 ? it.section : null;
        out[it.ref] = { title: it.title, section: section, due: it.due || null };
      });
    } catch (e) {
      console.log('[slack] title suggestions failed for ' + ws.name + ' (using message text): ' + Slack.errText_(e));
    }
    return out;
  },

  /**
   * First-run :todo: reactions on messages older than FIRST_RUN_DAYS -> triage queue (never
   * silently dropped). Ledgered 'queued' so later runs leave them to triage.
   * @return {number} queue items added
   */
  queueBaseline_(ws, me, baseline, ctx) {
    const stats = ctx.stats;
    const emoji = Slack.emoji();
    const project = Slack.projectKey_(ws);
    let openTasks = [], notDup = [];
    try { openTasks = Todoist.openTasks() || []; notDup = Slack.notDuplicates_(ctx) || []; } catch (e) {
      console.log('[slack] dedupe unavailable for baseline items: ' + Slack.errText_(e));
    }
    const fin = { project: project === 'Inbox' ? null : project, section: null, routeConfidence: 'med' };
    const perKey = {};
    const items = baseline.map(function (f) {
      const msg = f.message;
      const text = Slack.plainText_(msg.text, ws, me);
      const author = msg.user === me.userId ? 'Alex Scammon' : (Slack.userName(ws, msg.user) || msg.username || 'someone');
      const m = {
        key: f.key, channel: f.channel, channelName: null, ts: msg.ts, isDm: /^D/.test(String(f.channel)),
        userName: author, permalink: msg.permalink || null, isMine: msg.user === me.userId
      };
      const item = {
        title: Slack.fallbackTitle_(msg.text, ws, me), quote: Util.truncate(text || '', Slack.MAX_TEXT),
        why: ':' + emoji + ': reaction found on the first Slack run; the message is older than ' + Slack.FIRST_RUN_DAYS +
          ' days and Slack does not say when the reaction was added',
        kind: 'todo', confidence: 'med'
      };
      const qid = Store.queueId('slack', f.key, item.title);
      let dup = null;
      try { dup = openTasks.length ? Dedupe.matchTask({ id: qid, title: item.title }, openTasks, notDup) : null; } catch (e) { dup = null; }
      const q = Slack.queueItem_(ws, me, m, item, fin, dup, qid);
      q.chips = ['Baseline'].concat(q.chips || []);
      perKey[f.key] = qid;
      return q;
    });
    let added = [];
    try {
      added = Store.queueAdd(items) || [];
    } catch (e) {
      baseline.forEach(function (f) { Slack.recordError_(f.key, e, stats, true); });
      stats.errors++;
      stats.notes.push(ws.name + ': could not queue ' + baseline.length + ' baseline :' + emoji + ': item(s): ' + Util.truncate(Slack.errText_(e), 120));
      return 0;
    }
    Store.ledgerPutMany(baseline.map(function (f) {
      return { key: f.key, source: 'slack', outcome: 'queued', queueIds: [perKey[f.key]], note: 'baseline: :' + emoji + ': before first run -> triage' };
    }));
    stats.queued += added.length;
    stats.notes.push(ws.name + ': ' + baseline.length + ' older :' + emoji + ': message(s) sent to triage (first run)');
    return added.length;
  },

  /** Create the task for one :todo: message (idempotent via machine line) and ledger it. */
  createTodoTask_(ws, me, f, suggestion) {
    const key = f.key;
    const msg = f.message;
    let existing = null;
    try { existing = Todoist.findByMachineKey(key); } catch (e) { existing = null; }
    if (existing) {
      Store.ledgerPut({ key: key, outcome: 'tasks', taskIds: [String(existing.id)], note: 'task already existed' });
      return false;
    }
    const permalink = msg.permalink || Slack.permalink(ws, f.channel, msg.ts);
    const author = msg.user === me.userId ? 'Alex Scammon' : (Slack.userName(ws, msg.user) || msg.username || 'someone');
    const title = (suggestion && suggestion.title) || Slack.fallbackTitle_(msg.text, ws, me);
    const lines = [Slack.originLine_(ws, f.channel, null, msg.ts)];
    if (permalink) lines.push('[Open in Slack](' + permalink + ')');
    lines.push('From: ' + author);
    const text = Slack.plainText_(msg.text, ws, me);
    if (text) lines.push(Util.truncate(text, Slack.MAX_TEXT).split(/\r?\n/).map(function (l) { return '> ' + l; }).join('\n'));
    const task = Todoist.createTask({
      content: title,
      description: Todoist.withMachineLine(lines.join('\n'), { key: key }),
      projectName: Slack.projectKey_(ws),
      sectionName: (suggestion && suggestion.section) || undefined,
      labels: ['from-slack'],
      dueDate: (suggestion && suggestion.due) || undefined
    });
    const taskId = String(task.id);
    const resolved = Slack.resolveQueued_(key, taskId);
    Store.ledgerPut({
      key: key, outcome: 'tasks', taskIds: [taskId], queueIds: resolved,
      note: ':' + Slack.emoji() + ': reaction' + (resolved.length ? '; resolved ' + resolved.length + ' queued suggestion(s)' : '')
    });
    return true;
  },

  /** Pending queue items from the same message are settled by the explicit task. */
  resolveQueued_(sourceKey, taskId) {
    const ids = [];
    try {
      Store.queueList({ status: 'pending', source: 'slack' }).forEach(function (q) {
        if (q.sourceKey !== sourceKey) return;
        Store.queueUpdate(q.id, { status: 'accepted', resolvedAt: Util.now().toISOString(), resultTaskId: taskId });
        ids.push(q.id);
      });
    } catch (e) {
      console.log('[slack] could not settle queued items for ' + sourceKey + ': ' + Slack.errText_(e));
    }
    return ids;
  },

  // ------------------------------------------------------------------ passive (mentions / DMs)

  queries_(me) {
    const list = Config.json('SLACK_SEARCH_QUERIES', null);
    const qs = Array.isArray(list) && list.length ? list : Slack.DEFAULT_QUERIES;
    return qs.map(function (q) { return String(q).replace(/\{uid\}/g, me.userId); });
  },

  /**
   * Mentions and DMs since kv slack.<ws>.oldest (a Slack ts; first run: now − FIRST_RUN_DAYS)
   * -> Extract.slack in batches -> queue. The cursor advances only past messages that were fully
   * handled (or given up after MAX_ATTEMPTS errors).
   * @return {number} queue items added
   */
  capturePassive_(ws, me, ctx) {
    const stats = ctx.stats;
    const kvKey = 'slack.' + ws.name + '.oldest';
    const cursor = Store.kvGet(kvKey, null);
    const oldest = cursor ? Number(cursor) : Util.addDays(Util.now(), -Slack.FIRST_RUN_DAYS).getTime() / 1000;
    const after = Util.addDaysIso(new Date(oldest * 1000), -1);

    const byKey = {};
    let listingCut = false;
    let limitTs = Infinity; // oldest-first listings cut short: never move the cursor past their end
    Slack.queries_(me).forEach(function (q) {
      if (Slack.outOfTime_(ctx.deadline)) { listingCut = true; return; }
      const matches = Slack.searchRaw(ws, q + ' after:' + after, { deadline: ctx.deadline, sortDir: 'asc' });
      if (matches.truncated && matches.length) limitTs = Math.min(limitTs, Number(matches[matches.length - 1].ts));
      matches.forEach(function (m) {
        const ch = m.channel || {};
        // Overlap: search indexing can lag, so a message older than the cursor may appear later.
        // The ':scan' ledger keys stop reprocessing within the overlap.
        if (!ch.id || !m.ts || Number(m.ts) <= oldest - (cursor ? Slack.PASSIVE_OVERLAP_S : 0)) return;
        if (m.user && m.user === me.userId) return; // Alex's own messages
        const key = Slack.key_(ws, ch.id, m.ts);
        if (!byKey[key]) byKey[key] = { key: key, match: m };
      });
    });

    const all = Object.keys(byKey).map(function (k) { return byKey[k]; })
      .sort(function (a, b) { return Number(a.match.ts) - Number(b.match.ts); });
    const state = {}; // key -> 'done' | 'pending'
    const todo = [];
    all.forEach(function (x) {
      if (Slack.done_(x.key + ':scan') || Slack.done_(x.key)) {
        state[x.key] = 'done';
        if (Number(x.match.ts) > oldest) stats.skipped++; // overlap re-sightings are not news
        return;
      }
      todo.push(x);
    });
    const work = todo.slice(0, Slack.MAX_PASSIVE);
    if (todo.length > work.length) stats.notes.push(ws.name + ': ' + (todo.length - work.length) + ' message(s) left for next run');
    todo.slice(Slack.MAX_PASSIVE).forEach(function (x) { state[x.key] = 'pending'; });
    stats.seen += work.length;

    let queued = 0;
    const batches = Util.chunk(work, Slack.EXTRACT_BATCH);
    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b];
      if (Slack.outOfTime_(ctx.deadline)) {
        stats.stoppedEarly = true;
        batches.slice(b).forEach(function (bb) { bb.forEach(function (x) { state[x.key] = 'pending'; }); });
        break;
      }
      try {
        queued += Slack.processBatch_(ws, me, batch, ctx);
        batch.forEach(function (x) { state[x.key] = 'done'; });
      } catch (e) {
        batch.forEach(function (x) {
          state[x.key] = Slack.recordError_(x.key + ':scan', e, stats, true) ? 'done' : 'pending';
        });
        stats.errors++;
        stats.notes.push(ws.name + ': extract batch failed: ' + Util.truncate(Slack.errText_(e), 120));
      }
    }

    if (!listingCut) {
      let next = oldest;
      for (let i = 0; i < all.length; i++) {
        if (state[all[i].key] !== 'done' || Number(all[i].match.ts) > limitTs) break;
        next = Math.max(next, Number(all[i].match.ts));
      }
      if (!all.length && !cursor) next = Util.now().getTime() / 1000 - 60;
      if (next > oldest || !cursor) Store.kvSet(kvKey, Slack.tsString_(next));
    }
    return queued;
  },

  /** Extract, dedupe and queue one batch of search matches; ledger every message. */
  processBatch_(ws, me, batch, ctx) {
    const stats = ctx.stats;
    const catalogue = Slack.catalogue_(ctx);
    const project = Slack.projectKey_(ws);
    const msgs = batch.map(function (x) {
      const m = x.match;
      const ch = m.channel || {};
      return Slack.extractMsg_(ws, me, {
        key: x.key, channel: ch.id, channelName: ch.name || null, ts: m.ts, user: m.user,
        userName: m.username || null, text: m.text, permalink: m.permalink || null, isDm: Slack.isDm_(ch)
      });
    });
    const items = Extract.slack(msgs, {
      me: me, users: Slack.usersIn_(ws, msgs), project: project, sectionsByProject: catalogue,
      feedback: Slack.dismissals_(ctx), today: Util.today()
    }) || [];

    const openTasks = items.length ? Todoist.openTasks() : [];
    const notDup = items.length ? Slack.notDuplicates_(ctx) : [];
    const route = { project: project === 'Inbox' ? null : project, confidence: 'med', reason: 'workspace ' + ws.name };
    const perMsg = {};
    const queueItems = [];
    items.forEach(function (item) {
      if (!item || !item.title) return;
      const m = msgs.find(function (x) { return x.key === item.ref; });
      if (!m) return;
      const qid = Store.queueId('slack', m.key, item.title);
      const fin = Route.finalize(route, item, catalogue) || { project: route.project, section: null, routeConfidence: 'low' };
      let dup = null;
      try {
        dup = Dedupe.matchTask({ id: qid, title: item.title }, openTasks, notDup);
      } catch (e) {
        console.log('[slack] dedupe failed for "' + Util.truncate(item.title, 60) + '": ' + Slack.errText_(e));
      }
      queueItems.push(Slack.queueItem_(ws, me, m, item, fin, dup, qid));
      (perMsg[m.key] = perMsg[m.key] || []).push(qid);
    });
    let added = [];
    if (queueItems.length) added = Store.queueAdd(queueItems) || [];
    stats.queued += added.length;

    Store.ledgerPutMany(msgs.map(function (m) {
      const ids = perMsg[m.key] || [];
      return {
        key: m.key + ':scan', source: 'slack', outcome: ids.length ? 'queued' : 'nothing', queueIds: ids,
        note: m.isDm ? 'dm' : 'mention'
      };
    }));
    return added.length;
  },

  queueItem_(ws, me, m, item, fin, dup, qid) {
    const chips = [];
    if (item.confidence === 'low') chips.push('Low confidence');
    const waiting = item.kind === 'waiting';
    const lines = [Slack.originLine_(ws, m.channel, m.channelName, m.ts, m.isDm)];
    if (m.permalink) lines.push('[Open in Slack](' + m.permalink + ')');
    lines.push('From: ' + (m.userName || 'someone'));
    const quote = String(item.quote || '').trim();
    if (quote) lines.push(quote.split(/\r?\n/).map(function (l) { return '> ' + l; }).join('\n'));
    return {
      id: qid,
      status: 'pending',
      source: 'slack',
      sourceKey: m.key,
      origin: Slack.originLine_(ws, m.channel, m.channelName, m.ts, m.isDm, m.userName),
      link: m.permalink || null,
      title: item.title,
      quote: item.quote || '',
      why: item.why || '',
      kind: waiting ? 'waiting' : 'todo',
      due: item.due || null,
      resurface: waiting ? (item.resurface || null) : null,
      waitOn: waiting ? (item.ownerName || (m.isMine ? null : m.userName) || null) : null,
      waitOnEmail: waiting ? (item.ownerEmail || null) : null,
      project: fin.project || null,
      section: fin.section || null,
      confidence: item.confidence || 'low',
      routeConfidence: fin.routeConfidence || 'low',
      dupTaskId: dup ? String(dup.taskId) : null,
      dupTaskTitle: dup ? dup.title : null,
      chips: chips,
      // Extras for Triage accept (same as Meetings): ready-made description + label.
      description: Todoist.withMachineLine(lines.join('\n'), { key: m.key, q: qid }),
      labels: ['from-slack']
    };
  },

  // ------------------------------------------------------------------ formatting helpers

  /** "Slack · ISC · #general · Thu 24 Sep" / "Slack · GR-OSS · DM from Miro Knejp · Thu 24 Sep" */
  originLine_(ws, channel, channelName, ts, isDm, userName) {
    const parts = ['Slack', ws.name];
    const dm = isDm === undefined ? /^D/.test(String(channel || '')) : isDm;
    if (dm) parts.push(userName ? 'DM from ' + userName : 'DM');
    else if (channelName) parts.push('#' + channelName);
    const d = Slack.tsDate_(ts);
    if (d) parts.push(Util.formatDay(d));
    return parts.join(' · ');
  },

  /** Extract.slack message shape. */
  extractMsg_(ws, me, m) {
    const own = !!(m.user && m.user === me.userId);
    return {
      key: m.key, workspace: ws.name, channel: m.channel, channelName: m.channelName || null, ts: m.ts,
      user: m.user || null,
      userName: own ? 'Alex Scammon' : (m.userName || (m.user ? Slack.userName(ws, m.user) : null)),
      text: String(m.text || ''), permalink: m.permalink || null, isDm: !!m.isDm, isMine: own
    };
  },

  /** uid -> name for users mentioned in the messages (at most 20 lookups). */
  usersIn_(ws, msgs) {
    const out = {};
    const ids = [];
    msgs.forEach(function (m) {
      String(m.text || '').replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, function (all, uid) {
        if (ids.indexOf(uid) < 0) ids.push(uid);
        return all;
      });
    });
    ids.slice(0, 20).forEach(function (uid) { out[uid] = Slack.userName(ws, uid); });
    return out;
  },

  plainText_(text, ws, me) {
    return String(text || '')
      .replace(/<@([A-Z0-9]+)(?:\|([^>]+))?>/g, function (all, uid, label) {
        if (me && uid === me.userId) return '@Alex Scammon';
        return '@' + (label || Slack.userName(ws, uid) || uid);
      })
      .replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1')
      .replace(/<!(here|channel|everyone)>/g, '@$1')
      .replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2 ($1)')
      .replace(/<(https?:[^>]+)>/g, '$1')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
      .trim();
  },

  /** First non-empty line of the message, ≤ 120 chars. */
  fallbackTitle_(text, ws, me) {
    const plain = Slack.plainText_(text, ws, me);
    const line = plain.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean)[0] || '';
    return Util.truncate(line || 'Slack message', 120);
  },

  projectKey_(ws) {
    return ws.project || 'Inbox';
  },

  key_(ws, channel, ts) {
    return 'slack:' + ws.name + ':' + channel + ':' + ts;
  },

  isDm_(ch) {
    return !!(ch && (ch.is_im || ch.is_mpim || /^D/.test(String(ch.id || ''))));
  },

  tsDate_(ts) {
    const n = Number(ts);
    return isFinite(n) && n > 0 ? new Date(Math.round(n * 1000)) : null;
  },

  tsString_(n) {
    return Number(n).toFixed(6);
  },

  // ------------------------------------------------------------------ ledger / caches

  /** In the ledger with a non-error outcome, or errored MAX_ATTEMPTS times. */
  done_(key) {
    if (Store.ledgerHas(key)) return true;
    const e = Store.ledgerGet(key);
    return !!(e && e.outcome === 'error' && Slack.attempts_(e) >= Slack.MAX_ATTEMPTS);
  },

  attempts_(entry) {
    const m = /attempt (\d+)/.exec(String((entry && entry.note) || ''));
    return m ? parseInt(m[1], 10) : (entry && entry.outcome === 'error' ? 1 : 0);
  },

  /** Ledger an error; true when the key has now failed MAX_ATTEMPTS times (given up). */
  recordError_(key, e, stats, quiet) {
    if (!quiet) stats.errors++;
    const prev = Store.ledgerGet(key);
    const n = (prev && prev.outcome === 'error' ? Slack.attempts_(prev) : 0) + 1;
    const msg = Slack.errText_(e);
    try {
      Store.ledgerPut({ key: key, source: 'slack', outcome: 'error', note: 'attempt ' + n + ': ' + Util.truncate(msg, 300) });
    } catch (e2) {
      console.log('[slack] ledger write failed: ' + Slack.errText_(e2));
    }
    if (!quiet) stats.notes.push(key + ' failed: ' + Util.truncate(msg, 120));
    console.log('[slack] ' + key + ' failed: ' + msg + (n >= Slack.MAX_ATTEMPTS ? ' (giving up)' : ''));
    return n >= Slack.MAX_ATTEMPTS;
  },

  catalogue_(ctx) {
    if (!ctx.cache.catalogue) ctx.cache.catalogue = Route.sectionCatalogue();
    return ctx.cache.catalogue;
  },

  dismissals_(ctx) {
    if (!ctx.cache.dismissals) {
      try { ctx.cache.dismissals = Store.feedbackRecent(20, 'dismissed'); } catch (e) { ctx.cache.dismissals = []; }
    }
    return ctx.cache.dismissals;
  },

  notDuplicates_(ctx) {
    if (!ctx.cache.notDup) {
      ctx.cache.notDup = Dedupe.notDuplicateFeedback(200);
    }
    return ctx.cache.notDup;
  },

  outOfTime_(deadline) {
    return deadline.expired() || deadline.remaining() < Slack.RESERVE_MS;
  },

  errText_(e) {
    if (!e) return 'unknown error';
    return (e.name && e.name !== 'Error' ? e.name + ': ' : '') + (e.message || String(e)) +
      (e.status ? ' (HTTP ' + e.status + ')' : '');
  }
};

/** Trigger: every 10 min. Slack :todo: reactions -> tasks; mentions / DMs -> triage queue. */
function runSlack() {
  return Util.withLock('runSlack', function () {
    return Slack.run();
  });
}
