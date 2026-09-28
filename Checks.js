/**
 * Checks — daily safety nets (docs/DESIGN.md "Checks").
 *
 *  runSummaryCheck: calendar meetings from the last 7 days that have no Granola note with a
 *    summary (the Granola API only returns notes whose summary exists, so "no note" and "no
 *    summary yet" look the same). Keeps ONE task in Me › Immediate, found by its machine line
 *    key `check:summaries`: created, updated in place, or closed when nothing is missing.
 *    Completing the task yourself acknowledges the meetings it listed; they are not listed again.
 *  runTriageDigest: ONE task in Me › Immediate (`check:triage`) "Triage N suggestions" with the
 *    triage web app link, due today; closed when the queue is empty.
 */
const Checks = {
  WINDOW_DAYS: 7,
  /** Meetings that ended less than this long ago are not reported yet (Granola is still summarising). */
  GRACE_MS: 60 * 60 * 1000,
  MIN_MINUTES: 10,
  MATCH_WINDOW_MS: 15 * 60 * 1000,
  TITLE_SIM: 0.5,
  MAX_LISTED: 25,
  SUMMARY_KEY: 'check:summaries',
  TRIAGE_KEY: 'check:triage',
  KV_SUMMARIES: 'checks.summaries',
  GRANOLA_URL: 'https://notes.granola.ai/',
  CONFERENCE_RE_: /(zoom\.us|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|webex\.com|whereby\.com|chime\.aws|gotomeeting\.com|around\.co|meet\.jit\.si|slack\.com\/huddle|tuple\.app)/i,
  GENERIC_NOTE_TITLE_RE_: /^(new note|untitled( note| meeting)?|meeting|call)?$/i,

  // ------------------------------------------------------------------ summary check

  /**
   * @return {{job, seen, missing, created, updated, closed, acknowledged, errors, taskId, note}}
   */
  summaryCheck() {
    const started = Util.now().getTime();
    const stats = { job: 'summaryCheck', seen: 0, missing: 0, created: 0, updated: 0, closed: 0, acknowledged: 0, errors: 0, taskId: null, note: '' };
    try {
      Checks.summaryCheckInner_(stats);
    } catch (e) {
      stats.errors++;
      stats.note = 'failed: ' + Checks.errText_(e);
      console.log('[summaryCheck] failed: ' + Checks.errText_(e));
    }
    Checks.log_(stats, started, { seen: stats.seen, created: stats.created, queued: 0, skipped: stats.acknowledged });
    return stats;
  },

  summaryCheckInner_(stats) {
    const now = Util.now();
    const from = Util.addDays(now, -Checks.WINDOW_DAYS);
    const to = new Date(now.getTime() - Checks.GRACE_MS);
    const events = Checks.meetingEvents(from, to);
    stats.seen = events.length;

    // Granola notes (with summaries) created around the window. If this throws, the task is left alone.
    const notes = events.length ? (Granola.listNotes({ createdAfter: Util.addDays(from, -1) }) || []) : [];
    const unmatched = events.filter(function (ev) { return !Checks.matchNote(ev, notes); });

    const state = Checks.summaryState_(now);
    const existing = Todoist.findByMachineKey(Checks.SUMMARY_KEY);
    // A task we made earlier that is no longer open was completed (or deleted) by Alex: acknowledged.
    if (!existing && state.taskId && !state.closedBySelf) {
      state.acked = Util.uniq(state.acked.concat(state.events));
      stats.acknowledged = state.events.length;
    }
    const missing = unmatched.filter(function (ev) { return state.acked.indexOf(ev.key) < 0; });
    stats.missing = missing.length;

    if (!missing.length) {
      if (existing) {
        Todoist.closeTask(existing.id);
        stats.closed = 1;
      }
      state.taskId = null;
      state.events = [];
      state.closedBySelf = true;
      Checks.saveSummaryState_(state, now);
      stats.note = stats.acknowledged ? stats.acknowledged + ' acknowledged' : '';
      return;
    }

    const content = Checks.summaryTitle(missing.length);
    const description = Checks.summaryDescription(missing);
    let task = existing;
    if (task) {
      const patch = {};
      if (task.content !== content) patch.content = content;
      if (String(task.description || '') !== description) patch.description = description;
      if (Object.keys(patch).length) {
        Todoist.updateTask(task.id, patch);
        stats.updated = 1;
      }
    } else {
      task = Todoist.createTask({
        content: content, description: description, projectName: 'Me', sectionName: 'Immediate', labels: ['check']
      });
      stats.created = 1;
    }
    stats.taskId = String(task.id);
    state.taskId = String(task.id);
    // Only the meetings the task actually lists: completing it acknowledges those, not the overflow.
    state.events = missing.slice(0, Checks.MAX_LISTED).map(function (ev) { return ev.key; });
    state.closedBySelf = false;
    Checks.saveSummaryState_(state, now);
    stats.note = missing.length + ' missing' + (stats.acknowledged ? '; ' + stats.acknowledged + ' acknowledged' : '');
  },

  /** "Open 3 Granola notes without summaries" (singular for one). */
  summaryTitle(n) {
    return n === 1 ? 'Open 1 Granola note without a summary' : 'Open ' + n + ' Granola notes without summaries';
  },

  summaryDescription(missing) {
    const lines = ['Meetings from the last ' + Checks.WINDOW_DAYS + ' days with no Granola note (or no summary yet):'];
    missing.slice(0, Checks.MAX_LISTED).forEach(function (ev) {
      lines.push('- ' + Util.formatDate(ev.start, 'EEE d MMM HH:mm') + ' · ' + Util.truncate(ev.title || 'Untitled event', 100) +
        (ev.project ? ' (' + ev.project + ')' : ''));
    });
    if (missing.length > Checks.MAX_LISTED) lines.push('- … and ' + (missing.length - Checks.MAX_LISTED) + ' more');
    lines.push('Open Granola to generate the summaries: ' + Checks.GRANOLA_URL);
    lines.push('Completing this task marks these meetings as checked.');
    return Todoist.withMachineLine(lines.join('\n'), { key: Checks.SUMMARY_KEY });
  },

  /**
   * Qualifying meetings on Alex's calendars (routing.calendars) between from and to (end ≤ to):
   * accepted or organised by Alex, ≥ 1 other attendee (not Alex, his assistants or rooms),
   * ≥ MIN_MINUTES long, not all-day, with a conferencing link or a location. The same event on
   * several calendars is listed once.
   * @return {Object[]} [{key, id, title, start, end, calendar, project}] sorted by start
   */
  meetingEvents(from, to) {
    const calendars = Config.routing().calendars || {};
    const ignore = (Config.json('SUMMARY_CHECK_IGNORE', []) || []).map(function (s) { return String(s).toLowerCase(); });
    const out = [];
    const seen = {};
    Object.keys(calendars).forEach(function (calId) {
      let cal = null;
      try { cal = CalendarApp.getCalendarById(calId); } catch (e) { cal = null; }
      if (!cal) { console.log('[summaryCheck] calendar not available: ' + calId); return; }
      (cal.getEvents(from, to) || []).forEach(function (ev) {
        if (!Checks.qualifies_(ev, to, calId)) return;
        const title = String(ev.getTitle() || '');
        const lower = title.toLowerCase();
        if (ignore.some(function (s) { return s && lower.indexOf(s) >= 0; })) return;
        const start = ev.getStartTime();
        const id = String(ev.getId() || '');
        // getId() is the iCalUID, shared by every instance of a recurring series, so the id alone
        // is not unique: key on id + start (the same instance on two calendars is still listed once).
        const dedupeKeys = [id ? 'id:' + Checks.baseId_(id) + '@' + start.getTime() : null, 't:' + Util.normalizeTitle(title) + '@' + start.getTime()];
        if (dedupeKeys.some(function (k) { return k && seen[k]; })) return;
        dedupeKeys.forEach(function (k) { if (k) seen[k] = true; });
        out.push({
          key: Util.hash((id ? Checks.baseId_(id) : title) + '|' + start.toISOString(), 16),
          id: id, title: title, start: start, end: ev.getEndTime(), calendar: calId, project: calendars[calId] || null
        });
      });
    });
    out.sort(function (a, b) { return a.start.getTime() - b.start.getTime(); });
    return out;
  },

  qualifies_(ev, to, calId) {
    if (ev.isAllDayEvent()) return false;
    const start = ev.getStartTime(), end = ev.getEndTime();
    if (end.getTime() > to.getTime()) return false;
    if (end.getTime() - start.getTime() < Checks.MIN_MINUTES * 60000) return false;
    if (!Checks.isMine_(ev, calId)) return false;
    const id = Config.identity();
    const assistants = (id.assistants || []).map(function (a) { return String(a).toLowerCase(); });
    const others = (ev.getGuestList() || []).filter(function (g) {
      const email = String(g.getEmail() || '').toLowerCase();
      if (!email || email === String(calId || '').toLowerCase() || Config.isMyEmail(email) || assistants.indexOf(email) >= 0) return false;
      if (/resource\.calendar\.google\.com$/.test(email) || /group\.calendar\.google\.com$/.test(email)) return false;
      return true;
    });
    if (!others.length) return false;
    const where = String(ev.getLocation() || '') + '\n' + String(ev.getDescription() || '');
    return !!String(ev.getLocation() || '').trim() || Checks.CONFERENCE_RE_.test(where);
  },

  /**
   * Did Alex accept or organise this event? getMyStatus()/isOwnedByMe() describe the effective
   * user (the one account the script runs as), not the owner of the calendar being read, so on
   * Alex's other calendars they come back INVITED/false. Also look at the guest entry for the
   * calendar's own address (and Alex's other addresses) and at getCreators().
   * https://developers.google.com/apps-script/reference/calendar/calendar-event#getGuestList(Boolean)
   * https://developers.google.com/apps-script/reference/calendar/calendar-event#getCreators()
   */
  isMine_(ev, calId) {
    const cal = String(calId || '').toLowerCase();
    const isAlex = function (email) {
      const e = String(email || '').toLowerCase();
      return !!e && (e === cal || Config.isMyEmail(e));
    };
    const ok = function (status) { const s = String(status || ''); return s === 'OWNER' || s === 'YES'; };
    if (ev.isOwnedByMe() || ok(ev.getMyStatus())) return true;
    let creators = [];
    try { creators = ev.getCreators() || []; } catch (e) { creators = []; }
    if (creators.some(isAlex)) return true;
    let guests = [];
    try { guests = ev.getGuestList(true) || []; } catch (e) { guests = []; }
    return guests.some(function (g) {
      let email = '', status = '';
      try { email = g.getEmail(); status = g.getGuestStatus(); } catch (e) { return false; }
      return isAlex(email) && ok(status);
    });
  },

  /**
   * The Granola note for an event, or null: same calendar_event_id (ignoring any @suffix), else a
   * start within ±15 min and a similar title (a generic title like "New note" is enough when the
   * note has no calendar event at all).
   */
  matchNote(ev, notes) {
    const evId = ev.id ? Checks.baseId_(ev.id) : null;
    // A recurring series shares one base id, so an id match must also be the same instance: the
    // note's scheduled start within ±15 min of this event's start (no scheduled start: the note
    // was created between 15 min before the start and 15 min after the end).
    const byId = (notes || []).find(function (n) {
      const ce = n && n.calendar_event;
      if (!evId || !ce || !ce.calendar_event_id || Checks.baseId_(ce.calendar_event_id) !== evId) return false;
      const sched = Util.parseDate(ce.scheduled_start_time);
      if (sched) return Math.abs(sched.getTime() - ev.start.getTime()) <= Checks.MATCH_WINDOW_MS;
      const created = Util.parseDate(n.created_at);
      const endMs = (ev.end || ev.start).getTime();
      return !created || (created.getTime() >= ev.start.getTime() - Checks.MATCH_WINDOW_MS &&
        created.getTime() <= endMs + Checks.MATCH_WINDOW_MS);
    });
    if (byId) return byId;
    return (notes || []).find(function (n) {
      if (!n) return false;
      const ce = n.calendar_event || null;
      const t = Util.parseDate(ce && ce.scheduled_start_time) || Util.parseDate(n.created_at);
      if (!t || Math.abs(t.getTime() - ev.start.getTime()) > Checks.MATCH_WINDOW_MS) return false;
      const title = String(n.title || (ce && ce.event_title) || '').trim();
      if (!ce && Checks.GENERIC_NOTE_TITLE_RE_.test(title)) return true;
      const sim = Math.max(Util.tokenJaccard(title, ev.title), Util.containment(title, ev.title));
      return sim >= Checks.TITLE_SIM;
    }) || null;
  },

  /** Google event ids: "abc123@google.com" and "abc123" name the same event. */
  baseId_(id) {
    return String(id || '').split('@')[0].toLowerCase();
  },

  summaryState_(now) {
    const s = Store.kvGet(Checks.KV_SUMMARIES, null) || {};
    return {
      taskId: s.taskId || null,
      events: Array.isArray(s.events) ? s.events : [],
      acked: Array.isArray(s.acked) ? s.acked : [],
      ackedAt: s.ackedAt || null,
      closedBySelf: !!s.closedBySelf
    };
  },

  saveSummaryState_(state, now) {
    // Keys only matter while their events are inside the window; cap the list to stay small.
    Store.kvSet(Checks.KV_SUMMARIES, {
      taskId: state.taskId, events: state.events, acked: state.acked.slice(-300),
      closedBySelf: state.closedBySelf, updatedAt: now.toISOString()
    });
  },

  // ------------------------------------------------------------------ triage digest

  /** @return {{job, pending, created, updated, closed, errors, taskId, url, note}} */
  triageDigest() {
    const started = Util.now().getTime();
    const stats = { job: 'triageDigest', pending: 0, created: 0, updated: 0, closed: 0, errors: 0, taskId: null, url: null, note: '' };
    try {
      Checks.triageDigestInner_(stats);
    } catch (e) {
      stats.errors++;
      stats.note = 'failed: ' + Checks.errText_(e);
      console.log('[triageDigest] failed: ' + Checks.errText_(e));
    }
    Checks.log_(stats, started, { seen: stats.pending, created: stats.created, queued: 0, skipped: 0 });
    return stats;
  },

  triageDigestInner_(stats) {
    const pending = Store.queueList({ status: 'pending' });
    const n = pending.length;
    stats.pending = n;
    const existing = Todoist.findByMachineKey(Checks.TRIAGE_KEY);
    if (!n) {
      if (existing) {
        Todoist.closeTask(existing.id);
        stats.closed = 1;
      }
      return;
    }
    const url = Checks.triageUrl();
    stats.url = url;
    const content = Checks.triageTitle(n);
    const description = Checks.triageDescription(pending, url);
    const today = Util.today();
    let task = existing;
    if (task) {
      const patch = {};
      if (task.content !== content) patch.content = content;
      if (String(task.description || '') !== description) patch.description = description;
      if (!task.due || task.due.date !== today) patch.dueDate = today;
      if (Object.keys(patch).length) {
        Todoist.updateTask(task.id, patch);
        stats.updated = 1;
      }
    } else {
      task = Todoist.createTask({
        content: content, description: description, projectName: 'Me', sectionName: 'Immediate',
        labels: ['check'], dueDate: today
      });
      stats.created = 1;
    }
    stats.taskId = String(task.id);
    stats.note = n + ' pending';
  },

  /** "Triage 5 suggestions" (singular for one). */
  triageTitle(n) {
    return 'Triage ' + n + (n === 1 ? ' suggestion' : ' suggestions');
  },

  triageDescription(pending, url) {
    const lines = [];
    lines.push(url ? '[Open triage](' + url + ')' : 'Triage web app URL unknown: deploy the web app (Deploy > New deployment > Web app) or set Script Property TRIAGE_URL.');
    const bySource = {};
    pending.forEach(function (q) { const s = q.source || 'other'; bySource[s] = (bySource[s] || 0) + 1; });
    const parts = Object.keys(bySource).sort().map(function (s) { return bySource[s] + ' ' + s; });
    if (parts.length) lines.push('Pending: ' + parts.join(', '));
    // Oldest-first queue: the first item's age.
    const oldest = pending.length ? Util.parseDate(pending[0].createdAt) : null;
    if (oldest) lines.push('Oldest: ' + Util.formatDay(oldest));
    return Todoist.withMachineLine(lines.join('\n'), { key: Checks.TRIAGE_KEY });
  },

  /** TRIAGE_URL, else the deployed web app URL (saved to TRIAGE_URL), else null. */
  triageUrl() {
    const saved = Config.get('TRIAGE_URL');
    if (saved) return saved;
    let url = null;
    try { url = ScriptApp.getService().getUrl() || null; } catch (e) { url = null; }
    if (url) {
      try { Config.set('TRIAGE_URL', url); } catch (e) { /* best-effort */ }
    }
    return url;
  },

  // ------------------------------------------------------------------ misc

  log_(stats, started, counts) {
    try {
      Store.runLog({
        job: stats.job, durationMs: Util.now().getTime() - started, seen: counts.seen, created: counts.created,
        queued: counts.queued, skipped: counts.skipped, errors: stats.errors, note: Util.truncate(stats.note || '', 1000)
      });
    } catch (e) {
      console.log('[' + stats.job + '] could not write run log: ' + Checks.errText_(e));
    }
    console.log('[' + stats.job + '] ' + JSON.stringify(stats));
  },

  errText_(e) {
    if (!e) return 'unknown error';
    return (e.name && e.name !== 'Error' ? e.name + ': ' : '') + (e.message || String(e)) +
      (e.status ? ' (HTTP ' + e.status + ')' : '');
  }
};

/** Trigger: daily ~08:00. One Me › Immediate task listing meetings without Granola summaries. */
function runSummaryCheck() {
  return Util.withLock('runSummaryCheck', function () {
    return Checks.summaryCheck();
  });
}

/** Trigger: daily ~08:15. One Me › Immediate task "Triage N suggestions" while the queue is non-empty. */
function runTriageDigest() {
  return Util.withLock('runTriageDigest', function () {
    return Checks.triageDigest();
  });
}
