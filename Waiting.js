/**
 * Waiting — the "Waiting on others" lifecycle (docs/DESIGN.md "Waiting pipeline").
 *
 * Waiting.create(item) parks something another person owes Alex in the hidden
 * "Waiting on others" project, due on its resurface date (default +7 days), label `waiting`,
 * with a machine line {"key","q","dest","owner","email","since","sinceAt"} so runWaiting can work on it later.
 *
 * runWaiting (daily): for every waiting task due today or earlier, gather evidence since the task
 * was created (Gmail from the owner, Slack via Slack.search when configured, Granola meetings the
 * owner attended), ask Extract.resolution whether it was delivered, then either
 *   - resolved with high confidence -> comment "Auto-closed: <reason> <link>" and close, or
 *   - otherwise -> move to the destination project/section, rename to
 *     "Follow up with <owner>: <title>", due today, comment with any partial evidence.
 *
 * Gmail search operators (from:, to:, newer_than:Nd, {a b} = OR):
 *   https://support.google.com/mail/answer/7190
 */
const Waiting = {
  PROJECT: 'Waiting',
  LABEL: 'waiting',
  DEFAULT_DAYS: 7,
  MAX_TITLE: 120,
  MAX_EVIDENCE: 12,
  GMAIL_THREADS: 10,
  EVIDENCE_TEXT: 2500,
  SLACK_MAX: 6,
  GRANOLA_MAX_FETCH: 40,
  MAX_KEYWORDS: 4,
  COMMENT_EVIDENCE: 3,

  /** Words that say nothing about WHAT is owed (kept out of search keywords). */
  GENERIC_WORDS_: {
    send: 1, sends: 1, sent: 1, share: 1, shared: 1, get: 1, give: 1, provide: 1, deliver: 1, review: 1,
    follow: 1, back: 1, reply: 1, respond: 1, confirm: 1, let: 1, know: 1, alex: 1, scammon: 1, update: 1,
    check: 1, make: 1, sure: 1, please: 1, will: 1, can: 1, us: 1, him: 1, them: 1, his: 1, their: 1,
    over: 1, out: 1, into: 1, before: 1, after: 1, next: 1, week: 1, by: 1, new: 1, some: 1, any: 1
  },

  // ------------------------------------------------------------------ create

  /**
   * Create a waiting task from a queue item or an extracted item.
   * Idempotent per queue id: an open waiting task whose machine line has the same `q` is returned.
   * @param {Object} item queue item ({id, title, waitOn, waitOnEmail, resurface, project, section,
   *   sourceKey, link, origin, quote}) or extracted item ({title, ownerName, ownerEmail, resurface, …})
   * @param {{resurface?: string, key?: string}} [opts]
   * @return {Object} the Todoist task
   */
  create(item, opts) {
    const o = opts || {};
    const it = item || {};
    const title = Util.truncate(String(it.title || '').trim(), Waiting.MAX_TITLE);
    if (!title) throw new Error('Waiting.create: title required');
    const owner = Waiting.ownerOf_(it);
    const email = Util.parseEmail(it.waitOnEmail || it.ownerEmail) || null;
    const today = Util.today();
    const due = Waiting.resurfaceDate_(o.resurface || it.resurface, today);
    const dest = Waiting.destString_(it.project, it.section);
    const key = o.key || it.sourceKey || it.key || null;

    const machine = {};
    if (key) machine.key = key;
    if (it.id) machine.q = it.id;
    if (dest) machine.dest = dest;
    machine.owner = owner;
    if (email) machine.email = email;
    machine.since = today;
    machine.sinceAt = Util.now().toISOString(); // exact start of the evidence window

    Todoist.ensureProject(Waiting.PROJECT);
    if (it.id) {
      const existing = Waiting.openWaitingTasks_().find(function (t) {
        const m = Todoist.parseMachineLine(t.description);
        return m && m.q === it.id;
      });
      if (existing) return existing;
    }

    const lines = [];
    lines.push('Waiting on: ' + owner + (email ? ' <' + email + '>' : ''));
    if (it.origin) lines.push('From: ' + it.origin);
    const link = it.link || it.permalink || null;
    if (link) lines.push('[Open source](' + link + ')');
    lines.push('Then: ' + (dest ? dest.replace('/', ' › ') : 'Inbox'));
    const quote = it.quote ? String(it.quote).trim() : '';
    if (quote) lines.push(quote.split(/\r?\n/).map(function (l) { return '> ' + l; }).join('\n'));

    return Todoist.createTask({
      content: owner + ': ' + title,
      description: Todoist.withMachineLine(lines.join('\n'), machine),
      projectName: Waiting.PROJECT,
      labels: [Waiting.LABEL],
      dueDate: due
    });
  },

  // ------------------------------------------------------------------ run

  /**
   * Process every waiting task due today or earlier.
   * @param {{deadlineMs?: number}} [opts]
   * @return {{seen, closed, resurfaced, skipped, errors, stoppedEarly}}
   */
  run(opts) {
    const o = opts || {};
    const started = Util.now().getTime();
    const deadline = Util.deadline(o.deadlineMs);
    const today = Util.today();
    const stats = { seen: 0, closed: 0, resurfaced: 0, skipped: 0, errors: 0, stoppedEarly: false };

    let due = [];
    try {
      due = Waiting.dueTasks(today);
    } catch (e) {
      stats.errors++;
      console.log('[waiting] could not list waiting tasks: ' + Waiting.errText_(e));
    }
    stats.seen = due.length;
    const ctx = { today: today, deadline: deadline, granola: null, notes: {}, fetches: 0, infos: null };
    ctx.infos = due.map(Waiting.parseTask);

    for (let i = 0; i < ctx.infos.length; i++) {
      if (deadline.expired()) {
        stats.stoppedEarly = true;
        stats.skipped += ctx.infos.length - i;
        console.log('[waiting] deadline reached; ' + (ctx.infos.length - i) + ' task(s) left for the next run');
        break;
      }
      const info = ctx.infos[i];
      try {
        const res = Waiting.process_(info, ctx);
        if (res === 'closed') stats.closed++;
        else stats.resurfaced++;
      } catch (e) {
        stats.errors++;
        console.log('[waiting] task ' + info.taskId + ' failed: ' + Waiting.errText_(e));
      }
    }

    const note = ['closed ' + stats.closed, 'resurfaced ' + stats.resurfaced];
    if (stats.stoppedEarly) note.push('stopped early');
    try {
      Store.runLog({
        job: 'runWaiting', durationMs: Util.now().getTime() - started, seen: stats.seen, created: 0, queued: 0,
        skipped: stats.skipped, errors: stats.errors, note: note.join('; ')
      });
    } catch (e) {
      console.log('[waiting] runLog failed: ' + Waiting.errText_(e));
    }
    console.log('[waiting] ' + stats.seen + ' due; ' + note.join('; ') + '; errors ' + stats.errors);
    return stats;
  },

  /**
   * Open tasks in "Waiting on others" that are due on or before `today`, oldest due first.
   * Tasks without a due date are included only when they carry our machine line and have been
   * waiting DEFAULT_DAYS or more (so nothing we created gets stuck forever).
   * @param {string} [today] YYYY-MM-DD
   */
  dueTasks(today) {
    const day = today || Util.today();
    const out = Waiting.openWaitingTasks_().filter(function (t) {
      const d = Waiting.dueOf_(t);
      if (d) return d <= day;
      const m = Todoist.parseMachineLine(t.description);
      const since = m && Util.isIsoDate(m.since) ? m.since : null;
      return !!since && Util.addDaysIso(since, Waiting.DEFAULT_DAYS) <= day;
    });
    return out.sort(function (a, b) {
      const da = Waiting.dueOf_(a) || '', db = Waiting.dueOf_(b) || '';
      return da < db ? -1 : da > db ? 1 : 0;
    });
  },

  /**
   * Waiting task -> {taskId, task, owner, email, title, dest: {project, section}|null, key, q, since: Date}.
   * Works for our own tasks (machine line) and hand-made "Name: thing" tasks.
   */
  parseTask(task) {
    const m = Todoist.parseMachineLine(task.description) || {};
    const content = String(task.content || '').trim();
    let owner = m.owner ? String(m.owner) : null;
    let title = content;
    const fu = /^follow up with ([^:]{1,80}):\s*(.+)$/i.exec(content);
    if (fu) {
      owner = owner || fu[1].trim();
      title = fu[2].trim();
    } else if (owner && content.toLowerCase().indexOf(owner.toLowerCase() + ':') === 0) {
      title = content.slice(owner.length + 1).trim();
    } else {
      const pre = /^([^:]{1,60}):\s+(.+)$/.exec(content);
      if (pre) {
        owner = owner || pre[1].trim();
        title = pre[2].trim();
      }
    }
    // sinceAt (exact creation time) wins; `since` is a script-TZ calendar date -> local midnight.
    const since = (m.sinceAt ? Util.parseDate(m.sinceAt) : null) ||
      (Util.isIsoDate(m.since) ? Waiting.localMidnight_(m.since) : null) ||
      Util.parseDate(task.added_at) || Util.parseDate(task.created_at) ||
      Util.addDays(Util.now(), -Waiting.DEFAULT_DAYS);
    return {
      taskId: String(task.id),
      task: task,
      owner: owner || null,
      email: Util.parseEmail(m.email) || null,
      title: title || content,
      dest: Waiting.parseDest(m.dest),
      key: m.key || null,
      q: m.q || null,
      machine: m,
      since: since
    };
  },

  /** "ISC/Reach Out" -> {project: 'ISC', section: 'Reach Out'}; "GR" -> {project: 'GR', section: null}; else null. */
  parseDest(dest) {
    if (!dest) return null;
    const s = String(dest);
    const i = s.indexOf('/');
    const project = Route.normalizeKey(i < 0 ? s : s.slice(0, i));
    if (!project) return null;
    const section = i < 0 ? null : s.slice(i + 1).trim() || null;
    return { project: project, section: section };
  },

  // ------------------------------------------------------------------ evidence

  /**
   * Evidence since `info.since`: Gmail, Slack (when configured), Granola meetings with the owner.
   * Each source is independent: one failing source never blocks the others.
   * @return {Object[]} [{source, date, from, title, text, link}] newest first, capped at MAX_EVIDENCE
   */
  gatherEvidence(info, ctx) {
    const c = ctx || { notes: {}, fetches: 0 };
    let out = [];
    const sources = [
      ['gmail', Waiting.gmailEvidence_],
      ['slack', Waiting.slackEvidence_],
      ['granola', Waiting.granolaEvidence_]
    ];
    sources.forEach(function (s) {
      try {
        out = out.concat(s[1](info, c) || []);
      } catch (e) {
        console.log('[waiting] ' + s[0] + ' evidence failed for task ' + info.taskId + ': ' + Waiting.errText_(e));
      }
    });
    out.sort(function (a, b) { return Waiting.ms_(b.date) - Waiting.ms_(a.date); });
    return out.slice(0, Waiting.MAX_EVIDENCE);
  },

  /** Search keywords from the title: informative tokens, owner's name and generic verbs removed. */
  keywords(title, owner) {
    const skip = {};
    Util.tokens(owner || '').forEach(function (t) { skip[t] = 1; });
    return Util.tokens(title || '')
      .filter(function (t) { return t.length >= 3 && !Waiting.GENERIC_WORDS_[t] && !skip[t] && !/^\d+$/.test(t); })
      .sort(function (a, b) { return b.length - a.length; })
      .slice(0, Waiting.MAX_KEYWORDS);
  },

  /** Days for Gmail's newer_than: covering `since` up to now (min 1, max 365). */
  daysSince_(since) {
    const ms = Util.now().getTime() - Util.toDate(since).getTime();
    return Math.max(1, Math.min(365, Math.ceil(ms / 86400000) + 1));
  },

  gmailQueries_(info) {
    const who = info.email || (info.owner ? '"' + String(info.owner).replace(/"/g, '') + '"' : null);
    if (!who) return [];
    const base = 'from:' + who + ' newer_than:' + Waiting.daysSince_(info.since) + 'd';
    const kw = Waiting.keywords(info.title, info.owner);
    const qs = [];
    if (kw.length) qs.push(base + ' {' + kw.join(' ') + '}');
    qs.push(base);
    if (info.email) qs.push('from:me to:' + info.email + ' newer_than:' + Waiting.daysSince_(info.since) + 'd');
    return qs;
  },

  gmailEvidence_(info, ctx) {
    const qs = Waiting.gmailQueries_(info);
    if (!qs.length) return [];
    const sinceMs = Util.toDate(info.since).getTime();
    const seenThreads = {};
    const out = [];
    qs.forEach(function (q) {
      if (Object.keys(seenThreads).length >= Waiting.GMAIL_THREADS) return;
      (GmailApp.search(q, 0, Waiting.GMAIL_THREADS) || []).forEach(function (th) {
        const tid = String(th.getId());
        if (seenThreads[tid] || Object.keys(seenThreads).length >= Waiting.GMAIL_THREADS) return;
        seenThreads[tid] = 1;
        const link = typeof th.getPermalink === 'function' ? th.getPermalink() : 'https://mail.google.com/mail/#all/' + tid;
        th.getMessages().forEach(function (msg) {
          const date = msg.getDate();
          if (!date || date.getTime() < sinceMs) return;
          const from = msg.getFrom() || '';
          const fromEmail = Util.parseEmail(from);
          const relevant = info.email
            ? fromEmail === info.email || (Config.isMyEmail(fromEmail) && String(msg.getTo() + ',' + msg.getCc()).toLowerCase().indexOf(info.email) >= 0)
            : !Waiting.isMe_(Waiting.displayName_(from), fromEmail) && Waiting.nameMatches_(from, info.owner);
          if (!relevant) return;
          out.push({
            source: 'gmail', date: date, from: from, title: msg.getSubject() || '',
            text: Util.truncate(msg.getPlainBody() || '', Waiting.EVIDENCE_TEXT), link: link
          });
        });
      });
    });
    return out;
  },

  /**
   * Slack evidence via Slack.search(query, sinceDate) when Slack.js and SLACK_WORKSPACES exist.
   * Query = the item's keywords (Slack ANDs terms, so the owner's name is left to the model), or
   * the owner's name when there are no keywords. Result fields are read defensively.
   */
  slackEvidence_(info, ctx) {
    if (typeof Slack === 'undefined' || !Slack || typeof Slack.search !== 'function') return [];
    if (!Config.slackWorkspaces().length) return [];
    const kw = Waiting.keywords(info.title, info.owner).slice(0, 3);
    const query = kw.length ? kw.join(' ') : (info.owner || '');
    if (!query) return [];
    const res = Slack.search(query, Util.toDate(info.since)) || [];
    const list = Array.isArray(res) ? res : (res.messages || res.matches || []);
    return list.slice(0, Waiting.SLACK_MAX).map(function (m) {
      // Slack.search returns evidence-shaped rows {source, workspace, date, from, title, text, link};
      // raw search.messages fields (ts, username, channel.name, permalink) are accepted as well.
      const ts = Number(m.ts);
      const channel = m.channelName || (m.channel && m.channel.name) || null;
      return {
        source: 'slack' + (m.workspace ? ' ' + m.workspace : ''),
        date: m.date ? Util.parseDate(m.date) : (isFinite(ts) && ts > 0 ? new Date(ts * 1000) : null),
        from: m.from || m.userName || m.username || m.user || null,
        title: m.title || (channel ? '#' + channel : null),
        text: Util.truncate(String(m.text || ''), Waiting.EVIDENCE_TEXT),
        link: m.link || m.permalink || null
      };
    }).filter(function (e) { return e.text; });
  },

  /** Granola notes created since the task, where the owner is an attendee (list shared per run). */
  granolaEvidence_(info, ctx) {
    if (!Config.get('GRANOLA_API_KEY') || typeof Granola === 'undefined') return [];
    if (!info.email && !info.owner) return [];
    if (!ctx.granola) {
      const earliest = (ctx.infos || [info]).reduce(function (min, x) {
        return Math.min(min, Util.toDate(x.since).getTime());
      }, Util.toDate(info.since).getTime());
      try {
        ctx.granola = Granola.listNotes({ createdAfter: new Date(earliest), deadline: ctx.deadline }) || [];
      } catch (e) {
        // One failure disables Granola for the rest of the run instead of a retry cycle per task.
        ctx.granola = [];
        console.log('[waiting] Granola listNotes failed; skipping Granola evidence this run: ' + Waiting.errText_(e));
      }
    }
    const sinceMs = Util.toDate(info.since).getTime();
    const out = [];
    ctx.granola
      .filter(function (n) { return Waiting.ms_(n.created_at) >= sinceMs; })
      .sort(function (a, b) { return Waiting.ms_(b.created_at) - Waiting.ms_(a.created_at); })
      .forEach(function (n) {
        let m = ctx.notes[n.id];
        if (m === undefined) {
          if (ctx.fetches >= Waiting.GRANOLA_MAX_FETCH || (ctx.deadline && ctx.deadline.expired())) return;
          ctx.fetches++;
          m = Granola.getNote(n.id, { transcript: false }) || null;
          ctx.notes[n.id] = m;
        }
        if (!m) return;
        const attended = (m.attendees || []).some(function (a) {
          if (!a) return false;
          // Alex attends every meeting of his own: never let his entry stand in for the owner.
          if (Waiting.isMe_(a.name, a.email)) return false;
          if (info.email && a.email && String(a.email).toLowerCase() === info.email) return true;
          return !!(a.name && info.owner && Waiting.nameMatches_(a.name, info.owner));
        });
        if (!attended) return;
        out.push({
          source: 'granola', date: m.start, from: null, title: m.title,
          text: Util.truncate(m.summaryMarkdown || '', Waiting.EVIDENCE_TEXT), link: m.url || null
        });
      });
    return out;
  },

  // ------------------------------------------------------------------ private

  process_(info, ctx) {
    const evidence = Waiting.gatherEvidence(info, ctx);
    const res = Extract.resolution({
      title: info.title, ownerName: info.owner, ownerEmail: info.email, createdAt: info.since
    }, evidence, { today: ctx.today }) || { resolved: false, confidence: 'low', reason: 'No verdict.', evidenceLink: null };

    if (res.resolved === true && res.confidence === 'high') {
      Todoist.addComment(info.taskId, 'Auto-closed: ' + res.reason + (res.evidenceLink ? ' ' + res.evidenceLink : ''));
      Todoist.closeTask(info.taskId);
      return 'closed';
    }

    // Rename + due today + comment first and move LAST: if anything fails, the task is still in
    // Waiting on others (due today, so the next run retries it; parseTask reads "Follow up with").
    const dest = info.dest && Route.isKey(info.dest.project) ? info.dest : { project: 'Inbox', section: null };
    const owner = info.owner || info.email || 'them';
    const machine = Object.assign({}, info.machine, { resurfaced: ctx.today });
    Todoist.updateTask(info.taskId, {
      content: Util.truncate('Follow up with ' + owner + ': ' + info.title, 500),
      dueDate: ctx.today,
      description: Todoist.withMachineLine(info.task.description || '', machine)
    });
    Todoist.addComment(info.taskId, Waiting.resurfaceComment_(res, evidence));
    Todoist.moveTask(info.taskId, { projectName: dest.project, sectionName: dest.section || undefined });
    return 'resurfaced';
  },

  resurfaceComment_(res, evidence) {
    const L = ['Resurfaced from Waiting on others: ' + (res.reason || 'no evidence it was done.') +
      (res.evidenceLink ? ' ' + res.evidenceLink : '')];
    const shown = (evidence || []).slice(0, Waiting.COMMENT_EVIDENCE);
    if (shown.length) {
      L.push('Possibly related since then:');
      shown.forEach(function (e) {
        const d = Util.parseDate(e.date);
        const bits = [e.source];
        if (d) bits.push(Util.formatDay(d));
        if (e.title) bits.push(Util.truncate(e.title, 80));
        L.push('- ' + bits.join(' · ') + (e.link ? ' ' + e.link : ''));
      });
    }
    return L.join('\n');
  },

  openWaitingTasks_() {
    if (!Todoist.projectId(Waiting.PROJECT)) return [];
    return Todoist.openTasks({ projectNames: [Waiting.PROJECT] });
  },

  dueOf_(t) {
    const d = t && t.due && (t.due.date || t.due.datetime);
    return d ? String(d).slice(0, 10) : null;
  },

  ownerOf_(it) {
    const name = String(it.waitOn || it.ownerName || '').trim();
    if (name) return name;
    const email = Util.parseEmail(it.waitOnEmail || it.ownerEmail);
    return email || 'Someone';
  },

  resurfaceDate_(v, today) {
    if (Util.isIsoDate(v)) return v > today ? v : Util.addDaysIso(today, 1);
    return Util.addDaysIso(today, Waiting.DEFAULT_DAYS);
  },

  destString_(project, section) {
    const p = Route.normalizeKey(project);
    if (!p) return null;
    const s = section ? Route.section(p, section) : null;
    return s ? p + '/' + s : p;
  },

  /** True for Alex's own address or name (Config identity; notMe names such as Alex Blundell are not Alex). */
  isMe_(name, email) {
    const e = Util.parseEmail(email || '') || (email ? String(email).trim().toLowerCase() : null);
    if (e && Config.isMyEmail(e)) return true;
    return !!name && Config.isMyName(String(name).trim());
  },

  /** "Priya Shah" from '"Priya Shah" <p@x.com>'. */
  displayName_(from) {
    return String(from || '').replace(/<[^>]*>/g, '').replace(/"/g, '').trim();
  },

  /** Local midnight (script TZ) of 'YYYY-MM-DD' as a Date. */
  localMidnight_(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
    if (!m) return null;
    const utc = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    const offsetMs = function (ms) {
      const z = /^([+-])(\d{2})(\d{2})$/.exec(Util.formatDate(new Date(ms), 'Z'));
      return z ? (z[1] === '-' ? -1 : 1) * (+z[2] * 60 + +z[3]) * 60000 : 0;
    };
    let t = utc - offsetMs(utc);
    t = utc - offsetMs(t); // re-check the offset at the candidate instant (DST days)
    return new Date(t);
  },

  /** Loose person match: every token of the shorter name appears in the other ("Mihailo" ~ "Mihailo Marinkovic <m@x>"). */
  nameMatches_(text, name) {
    if (!text || !name) return false;
    const a = Util.normalizeTitle(String(text).replace(/<[^>]*>/g, ' ')).split(' ').filter(Boolean);
    const b = Util.normalizeTitle(name).split(' ').filter(Boolean);
    if (!a.length || !b.length) return false;
    const short = a.length <= b.length ? a : b;
    const long = a.length <= b.length ? b : a;
    return short.every(function (t) { return long.indexOf(t) >= 0; });
  },

  ms_(v) {
    const d = Util.parseDate(v);
    return d ? d.getTime() : 0;
  },

  errText_(e) {
    if (!e) return 'unknown error';
    return (e.status ? 'HTTP ' + e.status + ': ' : '') + (e.message || String(e));
  }
};

/** Daily trigger: resolve or resurface waiting-on-others tasks. */
function runWaiting() {
  return Util.withLock('runWaiting', function () {
    return Waiting.run();
  });
}
