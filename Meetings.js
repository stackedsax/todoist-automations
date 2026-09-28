/**
 * Meetings — orchestrates meeting notes -> Todoist tasks / triage queue
 * (docs/DESIGN.md "Meeting pipeline", steps 1-9).
 *
 *   runMeetings()  every 10 min: new/updated Granola notes (+ Fireflies when configured) since the
 *                  kv cursors; confident items become tasks, everything else goes to the queue.
 *   runBackfill()  manual: the last BACKFILL_DAYS days, EVERYTHING to the queue (chip "Backfill"),
 *                  resumable across executions via kv `backfill.cursor`.
 *
 * Guarantees
 * - Ledger: every processed source key (both keys when Granola + Fireflies merged) is ledgered with
 *   outcome tasks|queued|nothing, or error (retried every run). Only meeting-specific failures count
 *   towards MAX_ATTEMPTS (outages/config errors never do); giving up needs MAX_ATTEMPTS failures over
 *   at least GIVE_UP_MS and queues an "Extraction failed" triage item, so nothing is dropped silently.
 * - Retries are idempotent: tasks a failed attempt already created are found by their machine line.
 * - Cursor `granola.updatedAfter` only advances over a contiguous run (by updated_at) of fully
 *   processed notes, and never when the listing itself was cut short by the deadline.
 * - One failing meeting (or item) is logged and counted; the run carries on.
 * - Cross-run source dedupe: a Fireflies recording that arrives after its Granola twin was already
 *   processed (or vice versa) is matched against kv `meetings.recent` and ledgered as nothing.
 *   Fireflies-only recordings wait FIREFLIES_GRACE_MS for their Granola twin (incremental mode).
 */
const Meetings = {
  /** Stop starting new meetings when less than this much of the budget is left (an LLM call). */
  RESERVE_MS: 45000,
  /**
   * Give up on a meeting after this many meeting-specific failures spanning at least GIVE_UP_MS
   * (systemic failures never count). Giving up queues an "Extraction failed" item for triage.
   */
  MAX_ATTEMPTS: 3,
  GIVE_UP_MS: 24 * 3600 * 1000,
  /** A backfill window stops re-arming its continuation trigger after this many runs. */
  BACKFILL_MAX_RUNS: 30,
  /** Default look-back for the first incremental run. */
  FIRST_RUN_DAYS: 2,
  /** A Fireflies-only recording younger than this (from its start) waits for its Granola twin. */
  FIREFLIES_GRACE_MS: 3 * 3600 * 1000,
  /** fireflies.fromDate never advances later than now minus this (late summaries). */
  FIREFLIES_LAG_MS: 24 * 3600 * 1000,
  /** Recent processed-meeting fingerprints kept for cross-run source dedupe. */
  RECENT_KEEP_MS: 4 * 24 * 3600 * 1000,
  RECENT_MAX: 120,
  MAX_ATTENDEES: 8,
  RANK_: { low: 0, med: 1, high: 2 },
  SOURCE_LABEL_: { granola: 'Granola', fireflies: 'Fireflies' },

  KV_GRANOLA: 'granola.updatedAfter',
  KV_FIREFLIES: 'fireflies.fromDate',
  KV_BACKFILL: 'backfill.cursor',
  KV_RECENT: 'meetings.recent',

  /**
   * Run the pipeline once (callers hold the lock).
   * @param {{backfill?: boolean, deadline?: Object}} [opts]
   * @return {{job, seen, created, queued, skipped, errors, processed, deferred, stoppedEarly,
   *           complete, cursor, note}} run summary (also written to Store.runLog)
   */
  run(opts) {
    const o = opts || {};
    const backfill = !!o.backfill;
    const deadline = o.deadline || Util.deadline();
    const stats = {
      job: backfill ? 'backfill' : 'meetings', seen: 0, created: 0, queued: 0, skipped: 0, errors: 0,
      processed: 0, deferred: 0, stoppedEarly: false, complete: false, cursor: null, notes: []
    };
    const ctx = { backfill: backfill, deadline: deadline, stats: stats, cache: {} };
    const started = Util.now().getTime();
    try {
      Meetings.runInner_(ctx);
    } catch (e) {
      // Only whole-run failures land here (listing, Store); per-meeting errors are handled inside.
      stats.errors++;
      stats.notes.push('run failed: ' + Meetings.errText_(e));
      console.log('[' + stats.job + '] run failed: ' + Meetings.errText_(e));
    }
    stats.note = stats.notes.join('; ');
    delete stats.notes;
    try {
      Store.runLog({
        job: stats.job, durationMs: Util.now().getTime() - started, seen: stats.seen, created: stats.created,
        queued: stats.queued, skipped: stats.skipped, errors: stats.errors, note: Util.truncate(stats.note, 1000)
      });
    } catch (e) {
      console.log('[' + stats.job + '] could not write run log: ' + Meetings.errText_(e));
    }
    console.log('[' + stats.job + '] seen=' + stats.seen + ' created=' + stats.created + ' queued=' + stats.queued +
      ' skipped=' + stats.skipped + ' errors=' + stats.errors + (stats.note ? ' — ' + stats.note : ''));
    return stats;
  },

  runInner_(ctx) {
    const stats = ctx.stats;
    const now = Util.now();
    let window = null;
    if (ctx.backfill) {
      window = Meetings.backfillWindow_(now);
      ctx.window = window;
    }

    // 1. Granola.
    const granolaCursor = ctx.backfill ? null : Store.kvGet(Meetings.KV_GRANOLA, null);
    const updatedAfter = granolaCursor || Util.addDays(now, -Meetings.FIRST_RUN_DAYS).toISOString();
    const listOpts = ctx.backfill ? { createdAfter: window.from } : { updatedAfter: updatedAfter };
    listOpts.deadline = ctx.deadline;
    const notes = Granola.listNotes(listOpts) || [];
    const listingCut = ctx.deadline.expired();
    stats.seen += notes.length;

    const noteState = {}; // id -> 'done' | 'pending'
    const meetings = [];
    let fetchCut = false;
    notes.slice().sort(Meetings.byUpdated_).forEach(function (n) {
      const key = 'granola:' + n.id;
      if (Meetings.alreadyDone_(key, stats)) { noteState[n.id] = 'done'; return; }
      if (fetchCut || Meetings.outOfTime_(ctx.deadline)) { fetchCut = true; noteState[n.id] = 'pending'; return; }
      try {
        const m = Granola.getNote(n.id, { transcript: true });
        if (!m) {
          Store.ledgerPut({ key: key, outcome: 'nothing', note: 'note not found' });
          stats.skipped++;
          noteState[n.id] = 'done';
          return;
        }
        if (!m.updatedAt && n.updated_at) m.updatedAt = Util.parseDate(n.updated_at);
        meetings.push(m);
        noteState[n.id] = 'pending';
      } catch (e) {
        noteState[n.id] = Meetings.recordError_([key], e, stats, {
          source: 'granola', title: n.title, start: n.created_at, key: key
        }) ? 'done' : 'pending';
      }
    });

    // 2. Fireflies (backup source).
    // ffFrom stays null (cursor untouched) unless the listing ran and was complete; ffIncomplete
    // keeps a backfill window open when Fireflies was skipped, cut short or failed.
    const ffMeetings = [];
    let ffFrom = null;
    let ffIncomplete = false;
    let ffCut = false;
    const ffPending = []; // Fireflies meetings left for later (start times drive the cursor)
    if (Meetings.firefliesEnabled_()) {
      if (Meetings.outOfTime_(ctx.deadline)) {
        // Granola already used the budget: do not spend what is left fetching transcripts
        // that the merge loop would throw away. Cursor stays; next run lists again.
        ffIncomplete = true;
        ffCut = true;
      } else {
        const from = ctx.backfill ? window.from
          : (Store.kvGet(Meetings.KV_FIREFLIES, null) || Util.addDays(now, -Meetings.FIRST_RUN_DAYS).toISOString());
        try {
          const listed = Fireflies.listSince(from, {
            toDate: ctx.backfill ? window.to : undefined,
            deadline: ctx.deadline,
            skipIds: function (id) { return Meetings.alreadyDone_('fireflies:' + id, null); }
          }) || [];
          stats.seen += listed.length;
          // Fireflies.listSince returns the recordings it could not fetch before the deadline with
          // `deferred: true` (transcript not loaded). They are pending: never processed this run,
          // and they hold the cursor at or before their start.
          listed.forEach(function (m) {
            if (m && m.deferred) { ffPending.push(m); ffCut = true; } else if (m) ffMeetings.push(m);
          });
          if (ffCut) ffIncomplete = true;
          ffFrom = from;
        } catch (e) {
          ffIncomplete = true;
          if (e && e.name === 'FirefliesIncompleteError') {
            // Listing itself cut at the deadline: not an error, just resume next run.
            ffCut = true;
            console.log('[' + stats.job + '] ' + Meetings.errText_(e));
          } else {
            stats.errors++;
            stats.notes.push('fireflies listing failed: ' + Meetings.errText_(e));
            console.log('[' + stats.job + '] Fireflies listing failed: ' + Meetings.errText_(e));
          }
        }
      }
    }

    // 3. Merge across sources.
    const merged = Dedupe.mergeMeetings(meetings.concat(ffMeetings)) || [];
    const recent = Meetings.recentLoad_(now);
    let stopped = false;

    merged.forEach(function (m) {
      const keys = Meetings.keysOf_(m);
      if (stopped || Meetings.outOfTime_(ctx.deadline)) {
        stopped = true;
        if (m.source === 'fireflies') ffPending.push(m);
        return;
      }
      // Cross-run twin already processed from the other source?
      const twin = Meetings.recentTwin_(m, recent);
      if (twin) {
        Store.ledgerPutMany(keys.map(function (k) {
          return { key: k, outcome: 'nothing', note: 'same meeting as ' + twin.key + ' (already processed)' };
        }));
        stats.skipped++;
        Meetings.markDone_(keys, noteState);
        return;
      }
      // Fireflies-only: give Granola a chance to deliver the primary note first.
      if (!ctx.backfill && m.source === 'fireflies' && !(m.alsoRecordedBy || []).length &&
        Meetings.granolaConfigured_() && now.getTime() - Util.toDate(m.start).getTime() < Meetings.FIREFLIES_GRACE_MS) {
        stats.deferred++;
        ffPending.push(m);
        return;
      }
      try {
        Meetings.processMeeting_(m, ctx);
        stats.processed++;
        Meetings.markDone_(keys, noteState);
        recent.push(Meetings.fingerprint_(m));
      } catch (e) {
        if (Meetings.recordError_(keys, e, stats, m)) Meetings.markDone_(keys, noteState);
        else if (m.source === 'fireflies') ffPending.push(m);
      }
    });

    stats.stoppedEarly = stopped || fetchCut || listingCut || ffCut;
    if (stats.stoppedEarly) stats.notes.push('stopped at deadline; will resume');
    if (stats.deferred) stats.notes.push(stats.deferred + ' Fireflies-only meeting(s) waiting for Granola');

    try { Meetings.recentSave_(recent, now); } catch (e) { console.log('[meetings] recent save failed: ' + Meetings.errText_(e)); }

    // 9. Cursors.
    if (ctx.backfill) {
      window.runs = (window.runs || 0) + 1;
      const allDone = !stats.stoppedEarly && notes.every(function (n) { return noteState[n.id] === 'done'; }) &&
        !ffPending.length && !ffIncomplete;
      window.complete = allDone;
      if (allDone) window.completedAt = now.toISOString();
      Store.kvSet(Meetings.KV_BACKFILL, window);
      stats.complete = allDone;
      stats.cursor = window;
      let more = !allDone;
      if (more && window.runs >= Meetings.BACKFILL_MAX_RUNS) {
        more = false;
        stats.notes.push('backfill still incomplete after ' + window.runs + ' runs; not re-arming — check the errors and run runBackfill again');
      } else if (!allDone) {
        stats.notes.push('backfill incomplete (run ' + window.runs + ')');
      }
      Meetings.scheduleContinuation_(more);
      return;
    }

    if (!listingCut) {
      const next = Meetings.nextGranolaCursor_(notes, noteState, granolaCursor);
      if (next && next !== granolaCursor) Store.kvSet(Meetings.KV_GRANOLA, next);
      stats.cursor = next || granolaCursor;
    } else {
      stats.cursor = granolaCursor;
    }
    if (ffFrom) {
      const nextFf = Meetings.nextFirefliesCursor_(ffFrom, ffMeetings, ffPending, now);
      if (nextFf && nextFf !== ffFrom) Store.kvSet(Meetings.KV_FIREFLIES, nextFf);
    }
  },

  // ------------------------------------------------------------------ per meeting (steps 4-8)

  /**
   * Route, extract, dedupe and create/queue the items of one (merged) meeting, then ledger it.
   * Throws only when nothing reliable happened (extract / queue write failed); item-level task
   * creation failures fall back to the queue.
   */
  processMeeting_(m, ctx) {
    const stats = ctx.stats;
    const keys = Meetings.keysOf_(m);

    // 4-5. Calendar + route.
    let hit = null;
    try {
      hit = CalendarLookup.find(m);
    } catch (e) {
      console.log('[meetings] calendar lookup failed for ' + m.key + ': ' + Meetings.errText_(e));
    }
    const route = Route.project(m, hit) || { project: null, confidence: 'low', reason: 'no route' };
    let sectionHint = null;
    try { sectionHint = Route.sectionHint(Route.meetingEmails(m, hit)); } catch (e) { sectionHint = null; }
    const catalogue = Meetings.catalogue_(ctx);

    // 6. Extract.
    const items = Extract.meeting(m, {
      routeHint: route, sectionHint: sectionHint, sectionsByProject: catalogue,
      feedback: Meetings.dismissals_(ctx), today: Util.today()
    }) || [];

    const openTasks = items.length ? Todoist.openTasks() : [];
    const notDup = items.length ? Meetings.notDuplicates_(ctx) : [];
    const taskIds = [];
    const queueItems = [];
    const queueIds = [];
    let itemErrors = 0;

    // Tasks an earlier, failed attempt at this meeting already created (machine line key/q), so a
    // retry neither re-creates them nor queues them as "duplicates" of Alex's own new tasks.
    const ownEarlier = Meetings.ownTasks_(openTasks, keys);

    items.forEach(function (item) {
      if (!item || !item.title) return;
      const qid = Store.queueId('meeting', m.key, item.title);
      const mine = ownEarlier.byQ[qid];
      if (mine) {
        if (taskIds.indexOf(mine) < 0) taskIds.push(mine);
        return;
      }
      const fin = Route.finalize(route, item, catalogue) || { project: null, section: null, routeConfidence: 'low' };
      // 7. Existing-task match.
      let dup = null;
      try {
        dup = Dedupe.matchTask({ id: qid, title: item.title }, openTasks, notDup);
      } catch (e) {
        console.log('[meetings] dedupe failed for "' + Util.truncate(item.title, 60) + '": ' + Meetings.errText_(e));
      }
      if (dup && ownEarlier.ids[String(dup.taskId)]) {
        // Same item as a task this meeting produced on an earlier attempt (title re-worded by the
        // extractor): already captured.
        if (taskIds.indexOf(String(dup.taskId)) < 0) taskIds.push(String(dup.taskId));
        return;
      }
      // 8. Decision.
      const reason = Meetings.decide_(item, fin, dup, ctx.backfill);
      if (reason === 'direct') {
        try {
          const task = Todoist.createTask({
            content: item.title,
            description: Meetings.description(m, item, { q: qid }),
            projectName: fin.project,
            sectionName: fin.section || undefined,
            labels: ['meeting'],
            dueDate: item.due || undefined
          });
          taskIds.push(String(task.id));
          stats.created++;
          return;
        } catch (e) {
          itemErrors++;
          stats.errors++;
          console.log('[meetings] task create failed for "' + Util.truncate(item.title, 60) + '" (queued instead): ' +
            Meetings.errText_(e));
          queueItems.push(Meetings.queueItem_(m, item, fin, dup, qid, ctx.backfill, ['Create failed']));
          return;
        }
      }
      queueItems.push(Meetings.queueItem_(m, item, fin, dup, qid, ctx.backfill, []));
    });

    // Past this point tasks may exist in Todoist: a failure must carry their ids into the error
    // ledger entry (recordError_ reads e.partialTaskIds), and the retry recognises them above.
    try {
      if (queueItems.length) {
        const added = Store.queueAdd(queueItems) || [];
        stats.queued += added.length;
        queueItems.forEach(function (q) { queueIds.push(q.id); });
      }

      // 9. Ledger every source key of this meeting.
      const outcome = taskIds.length ? 'tasks' : queueIds.length ? 'queued' : 'nothing';
      const noteBits = [];
      if (items.length) noteBits.push(items.length + ' item(s)');
      if (itemErrors) noteBits.push(itemErrors + ' create error(s)');
      if (ctx.backfill) noteBits.push('backfill');
      Store.ledgerPutMany(keys.map(function (k, i) {
        const bits = noteBits.slice();
        if (i > 0) bits.unshift('merged into ' + keys[0]);
        return { key: k, outcome: outcome, taskIds: taskIds, queueIds: queueIds, note: bits.join('; ') };
      }));
      return { outcome: outcome, taskIds: taskIds, queueIds: queueIds };
    } catch (e) {
      if (taskIds.length && e && typeof e === 'object') e.partialTaskIds = taskIds.slice();
      throw e;
    }
  },

  /**
   * 'direct' when the item may become a task straight away, else a short queue reason.
   * Direct: not backfill, kind todo, item confidence >= DIRECT_CONFIDENCE (default high),
   * route confidence high, a known project, no duplicate.
   */
  decide_(item, fin, dup, backfill) {
    if (backfill) return 'backfill';
    if (item.kind !== 'todo') return 'waiting';
    if (dup) return 'duplicate';
    if (!fin.project) return 'no project';
    if (fin.routeConfidence !== 'high') return 'route ' + fin.routeConfidence;
    const need = Meetings.RANK_[Config.directConfidence()];
    const have = Meetings.RANK_[item.confidence];
    if (have === undefined || have < (need === undefined ? 2 : need)) return 'confidence ' + item.confidence;
    return 'direct';
  },

  queueItem_(m, item, fin, dup, qid, backfill, extraChips) {
    const chips = [];
    if (backfill) chips.push('Backfill');
    if (item.confidence === 'low') chips.push('Low confidence');
    (extraChips || []).forEach(function (c) { if (chips.indexOf(c) < 0) chips.push(c); });
    const waiting = item.kind === 'waiting';
    return {
      id: qid,
      status: 'pending',
      source: 'meeting',
      sourceKey: m.key,
      origin: Meetings.origin(m),
      link: Meetings.sourceLink_(m, item),
      title: item.title,
      quote: item.quote || '',
      why: item.why || '',
      kind: waiting ? 'waiting' : 'todo',
      due: item.due || null,
      resurface: waiting ? (item.resurface || null) : null,
      waitOn: waiting ? (item.ownerName || null) : null,
      waitOnEmail: waiting ? (item.ownerEmail || null) : null,
      project: fin.project || null,
      section: fin.section || null,
      confidence: item.confidence || 'low',
      routeConfidence: fin.routeConfidence || 'low',
      dupTaskId: dup ? String(dup.taskId) : null,
      dupTaskTitle: dup ? dup.title : null,
      chips: chips,
      // Extras for Triage accept (not in the DESIGN queue shape): ready-made task description + label.
      description: Meetings.description(m, item, { q: qid }),
      labels: ['meeting'],
      timestampSec: typeof item.timestampSec === 'number' ? item.timestampSec : null
    };
  },

  // ------------------------------------------------------------------ formatting

  /**
   * Task description (DESIGN "Task description format (meeting)"):
   *   Meeting: <title> · <Thu 24 Sep>
   *   [Open in Granola](<url>)  ·  [Fireflies](<ff url>?t=<sec>)     (only links that exist)
   *   Attendees: <names, max 8>
   *   > <quote>
   *   <!-- ta:{"key":"granola:not_xxx","q":"q_abc"} -->
   * @param {Object} m Meeting
   * @param {Object} item extracted item (quote, timestampSec)
   * @param {{q?: string}} [extra] machine-line fields
   */
  description(m, item, extra) {
    const lines = [];
    lines.push('Meeting: ' + (m.title || 'Untitled meeting') + ' · ' + Util.formatDay(Util.toDate(m.start)));
    const links = Meetings.links_(m, item);
    if (links.length) lines.push(links.map(function (l) { return '[' + l.label + '](' + l.url + ')'; }).join('  ·  '));
    const names = Meetings.attendeeNames_(m);
    if (names.length) {
      const shown = names.slice(0, Meetings.MAX_ATTENDEES);
      lines.push('Attendees: ' + shown.join(', ') +
        (names.length > shown.length ? ' +' + (names.length - shown.length) + ' more' : ''));
    }
    const quote = item && item.quote ? String(item.quote).trim() : '';
    if (quote) lines.push(quote.split(/\r?\n/).map(function (l) { return '> ' + l; }).join('\n'));
    const machine = { key: m.key };
    if (extra && extra.q) machine.q = extra.q;
    return Todoist.withMachineLine(lines.join('\n'), machine);
  },

  /** "Granola · Secure Copy/Paste Internal Sync · Thu 24 Sep" */
  origin(m) {
    return (Meetings.SOURCE_LABEL_[m.source] || String(m.source || 'Meeting')) + ' · ' +
      (m.title || 'Untitled meeting') + ' · ' + Util.formatDay(Util.toDate(m.start));
  },

  /** [{label, url}] for the primary recording and any other recordings of the same meeting. */
  links_(m, item) {
    const out = [];
    const recs = [{ source: m.source, url: m.url }].concat(m.alsoRecordedBy || []);
    const tsFromFireflies = m.source === 'fireflies' || m.transcriptFrom === 'fireflies';
    const sec = item && typeof item.timestampSec === 'number' && item.timestampSec >= 0 ? Math.round(item.timestampSec) : null;
    recs.forEach(function (r) {
      if (!r || !r.url) return;
      if (r.source === 'granola') {
        if (!out.some(function (l) { return l.source === 'granola'; })) out.push({ source: 'granola', label: 'Open in Granola', url: r.url });
      } else if (r.source === 'fireflies') {
        if (out.some(function (l) { return l.source === 'fireflies'; })) return;
        const url = sec !== null && tsFromFireflies ? Meetings.withT_(r.url, sec) : r.url;
        out.push({ source: 'fireflies', label: 'Fireflies', url: url });
      } else {
        out.push({ source: r.source, label: String(r.source || 'Source'), url: r.url });
      }
    });
    return out;
  },

  /** Best single link for the triage row: the primary recording (Fireflies with ?t= when known). */
  sourceLink_(m, item) {
    const links = Meetings.links_(m, item);
    const primary = links.find(function (l) { return l.source === m.source; }) || links[0];
    return primary ? primary.url : null;
  },

  withT_(url, sec) {
    return url + (url.indexOf('?') >= 0 ? '&' : '?') + 't=' + sec;
  },

  /** Attendee display names (email when no name), excluding Alex himself. */
  attendeeNames_(m) {
    const out = [];
    (m.attendees || []).forEach(function (a) {
      if (!a) return;
      if (a.email && Config.isMyEmail(a.email)) return;
      if (a.name && Config.isMyName(a.name)) return;
      const label = a.name ? String(a.name).trim() : (a.email ? String(a.email).trim() : '');
      if (label && out.indexOf(label) < 0) out.push(label);
    });
    return out;
  },

  /**
   * Open tasks whose machine line says this meeting (any of its keys) created them.
   * @return {{byQ: Object<string,string>, ids: Object<string,boolean>}} qid -> task id; task id set
   */
  ownTasks_(openTasks, keys) {
    const out = { byQ: {}, ids: {} };
    (openTasks || []).forEach(function (t) {
      if (!t || !t.description) return;
      let ml = null;
      try { ml = Todoist.parseMachineLine(t.description); } catch (e) { ml = null; }
      if (!ml || keys.indexOf(ml.key) < 0) return;
      out.ids[String(t.id)] = true;
      if (ml.q) out.byQ[ml.q] = String(t.id);
    });
    return out;
  },

  // ------------------------------------------------------------------ ledger / cursor helpers

  keysOf_(m) {
    const keys = (m.mergedKeys && m.mergedKeys.length) ? m.mergedKeys.slice() : [m.key];
    if (keys.indexOf(m.key) < 0) keys.unshift(m.key);
    return Util.uniq(keys.filter(Boolean));
  },

  /**
   * True if `key` needs no work: in the ledger with a non-error outcome (a given-up meeting is
   * ledgered 'queued' with its "Extraction failed" queue item). Counts a skip when stats is passed.
   */
  alreadyDone_(key, stats) {
    if (Store.ledgerHas(key)) { if (stats) stats.skipped++; return true; }
    return false;
  },

  /** Counted (meeting-specific) failures so far, from the ledger note "attempt N …". */
  attempts_(entry) {
    if (!entry || entry.outcome !== 'error') return 0;
    const m = /attempt (\d+)/.exec(String(entry.note || ''));
    return m ? parseInt(m[1], 10) : 1;
  },

  /** When the first counted failure happened (ledger note "… first <ISO> …"), or null. */
  firstFailure_(entry) {
    if (!entry || entry.outcome !== 'error') return null;
    const m = /first (\d{4}-\d\d-\d\dT[\d:.]+Z)/.exec(String(entry.note || ''));
    return m ? Util.parseDate(m[1]) : null;
  },

  /**
   * True for failures that say nothing about this meeting: the service or our config is down
   * (network, 401/403/408/429/5xx/529, overloaded, credits, missing Script Property). They are
   * ledgered as errors (retried) but do NOT count towards MAX_ATTEMPTS, so an outage never makes
   * us give up on the notes in its window.
   */
  isSystemic_(e) {
    if (!e) return false;
    const status = Number(e.status);
    if (e.name === 'HttpError' && (status === 0 || status === 401 || status === 403 || status === 408 ||
      status === 429 || status >= 500)) return true;
    const msg = String(e.message || e);
    return /Missing Script Property|overloaded|rate.?limit|credit balance|timed? ?out|Service invoked too many times|Exceeded maximum execution time|Address unavailable|DNS error/i.test(msg);
  },

  /**
   * Ledger an error for every key. Meeting-specific failures count an attempt; systemic ones
   * (isSystemic_) do not. After MAX_ATTEMPTS counted failures spanning at least GIVE_UP_MS, the
   * meeting is given up VISIBLY: a queue item "Pull the todos from <title> by hand" (chip
   * "Extraction failed", link to the source) is added and the keys are ledgered 'queued' with
   * it. Returns true when given up (treated as done for the cursor).
   * @param {string[]} keys source keys of the meeting
   * @param {Error} e
   * @param {Object} stats
   * @param {{title?, start?, url?, source?, key?}} [info] meeting (or listing) data for the queue item
   */
  recordError_(keys, e, stats, info) {
    stats.errors++;
    const msg = Meetings.errText_(e);
    const systemic = Meetings.isSystemic_(e);
    const now = Util.now();
    const partialTaskIds = (e && e.partialTaskIds) || [];
    let n = 0;
    let first = null;
    keys.forEach(function (k) {
      const prev = Store.ledgerGet(k);
      n = Math.max(n, Meetings.attempts_(prev));
      const f = Meetings.firstFailure_(prev);
      if (f && (!first || f < first)) first = f;
    });
    if (!systemic) n++;
    if (n > 0 && !first) first = now;
    const gaveUp = !systemic && n >= Meetings.MAX_ATTEMPTS &&
      now.getTime() - first.getTime() >= Meetings.GIVE_UP_MS;

    if (gaveUp) {
      try {
        const q = Meetings.failedQueueItem_(keys, info || {}, n, msg, stats.job === 'backfill');
        Store.queueAdd([q]);
        stats.queued++;
        Store.ledgerPutMany(keys.map(function (k) {
          return {
            key: k, outcome: 'queued', taskIds: partialTaskIds, queueIds: [q.id],
            note: 'gave up after ' + n + ' attempts (first ' + first.toISOString() + '): ' + Util.truncate(msg, 250)
          };
        }));
        console.log('[' + stats.job + '] ' + keys.join(' + ') + ' failed: ' + msg + ' (gave up; queued for manual review)');
        stats.notes.push(keys[0] + ' gave up after ' + n + ' attempts (queued for review): ' + Util.truncate(msg, 120));
        return true;
      } catch (e3) {
        // Could not make it visible: keep it as an error so it is retried rather than dropped.
        console.log('[meetings] could not queue the failed meeting: ' + Meetings.errText_(e3));
      }
    }

    const label = systemic ? 'transient, attempt ' + n : 'attempt ' + n;
    const when = first ? ' (first ' + first.toISOString() + ')' : '';
    const entries = keys.map(function (k) {
      return { key: k, outcome: 'error', taskIds: partialTaskIds, note: label + when + ': ' + Util.truncate(msg, 300) };
    });
    try { Store.ledgerPutMany(entries); } catch (e2) { console.log('[meetings] ledger write failed: ' + Meetings.errText_(e2)); }
    console.log('[' + stats.job + '] ' + keys.join(' + ') + ' failed (' + label + '): ' + msg);
    stats.notes.push(keys[0] + ' failed (' + label + '): ' + Util.truncate(msg, 120));
    return false;
  },

  /** The triage item that stands in for a meeting we gave up extracting. */
  failedQueueItem_(keys, info, attempts, msg, backfill) {
    const key = keys[0];
    const source = info.source || String(key).split(':')[0];
    const title = info.title || 'Untitled meeting';
    const start = Util.parseDate(info.start);
    const chips = ['Extraction failed'];
    if (backfill) chips.push('Backfill');
    return {
      id: Store.queueId('system', key, 'Extraction failed'),
      status: 'pending',
      source: 'system',
      sourceKey: key,
      origin: (Meetings.SOURCE_LABEL_[source] || source) + ' · ' + title + (start ? ' · ' + Util.formatDay(start) : ''),
      link: info.url || null,
      title: Util.truncate('Pull the todos from "' + title + '" by hand', 120),
      quote: '',
      why: 'Automatic extraction failed ' + attempts + ' times: ' + Util.truncate(msg, 200),
      kind: 'todo', due: null, resurface: null, waitOn: null, waitOnEmail: null,
      project: null, section: null, confidence: 'low', routeConfidence: 'low',
      dupTaskId: null, dupTaskTitle: null,
      chips: chips
    };
  },

  markDone_(keys, noteState) {
    keys.forEach(function (k) {
      if (k.indexOf('granola:') === 0) noteState[k.slice('granola:'.length)] = 'done';
    });
  },

  byUpdated_(a, b) {
    const ta = Meetings.ms_(a.updated_at), tb = Meetings.ms_(b.updated_at);
    return ta - tb;
  },

  ms_(v) {
    const d = Util.parseDate(v);
    return d ? d.getTime() : 0;
  },

  /**
   * Max updated_at of the contiguous (by updated_at) prefix of done notes. Never moves backwards.
   * @return {string|null} ISO timestamp
   */
  nextGranolaCursor_(notes, noteState, current) {
    const sorted = notes.slice().sort(Meetings.byUpdated_);
    let best = current ? Meetings.ms_(current) : 0;
    let moved = false;
    for (let i = 0; i < sorted.length; i++) {
      if (noteState[sorted[i].id] !== 'done') break;
      const t = Meetings.ms_(sorted[i].updated_at);
      if (t > best) { best = t; moved = true; }
    }
    return moved ? new Date(best).toISOString() : current;
  },

  /**
   * Fireflies cursor: the start of the earliest recording still pending, else the latest start
   * processed, clamped to at most now − FIREFLIES_LAG_MS, and never earlier than the current value.
   */
  nextFirefliesCursor_(from, seen, pending, now) {
    const fromMs = Meetings.ms_(from);
    let target;
    if (pending.length) {
      target = Math.min.apply(null, pending.map(function (m) { return Util.toDate(m.start).getTime(); }));
    } else if (seen.length) {
      target = Math.max.apply(null, seen.map(function (m) { return Util.toDate(m.start).getTime(); }));
    } else {
      target = now.getTime();
    }
    target = Math.min(target, now.getTime() - Meetings.FIREFLIES_LAG_MS);
    return target > fromMs ? new Date(target).toISOString() : from;
  },

  // ------------------------------------------------------------------ backfill

  /** Current (or new) backfill window {from, to, startedAt, runs, complete}. */
  backfillWindow_(now) {
    const cur = Store.kvGet(Meetings.KV_BACKFILL, null);
    if (cur && cur.from && !cur.complete) return cur;
    return {
      from: Util.addDays(now, -Config.backfillDays()).toISOString(),
      to: now.toISOString(),
      startedAt: now.toISOString(),
      runs: 0,
      complete: false
    };
  },

  /**
   * Replace any pending runBackfill continuation trigger; add a one-off one (1 min) when more
   * work remains, so a long backfill finishes without re-running it by hand.
   */
  scheduleContinuation_(more) {
    try {
      ScriptApp.getProjectTriggers().forEach(function (t) {
        if (t.getHandlerFunction() === 'runBackfill') ScriptApp.deleteTrigger(t);
      });
      if (more) ScriptApp.newTrigger('runBackfill').timeBased().after(60 * 1000).create();
    } catch (e) {
      console.log('[backfill] could not schedule continuation (run runBackfill again): ' + Meetings.errText_(e));
    }
  },

  // ------------------------------------------------------------------ cross-run source dedupe

  fingerprint_(m) {
    return {
      key: m.key, source: m.source,
      start: Util.toDate(m.start).toISOString(),
      title: Util.truncate(m.title || '', 80),
      emails: (m.attendees || []).map(function (a) { return a && a.email; }).filter(Boolean).slice(0, 10),
      org: m.organizerEmail || null,
      also: (m.alsoRecordedBy || []).map(function (r) { return r.source; })
    };
  },

  recentLoad_(now) {
    const list = Store.kvGet(Meetings.KV_RECENT, []) || [];
    const cutoff = now.getTime() - Meetings.RECENT_KEEP_MS;
    return (Array.isArray(list) ? list : []).filter(function (f) { return f && Meetings.ms_(f.start) >= cutoff; });
  },

  recentSave_(list, now) {
    const cutoff = now.getTime() - Meetings.RECENT_KEEP_MS;
    const keep = list.filter(function (f) { return Meetings.ms_(f.start) >= cutoff; }).slice(-Meetings.RECENT_MAX);
    Store.kvSet(Meetings.KV_RECENT, keep);
  },

  /** A recently processed meeting from a different source that is the same real meeting, or null. */
  recentTwin_(m, recent) {
    const sources = [m.source].concat((m.alsoRecordedBy || []).map(function (r) { return r.source; }));
    for (let i = recent.length - 1; i >= 0; i--) {
      const f = recent[i];
      if (f.key === m.key) continue;
      const fSources = [f.source].concat(f.also || []);
      if (fSources.some(function (s) { return sources.indexOf(s) >= 0; })) continue;
      const other = {
        source: f.source, start: Util.parseDate(f.start), title: f.title, organizerEmail: f.org,
        attendees: (f.emails || []).map(function (e) { return { email: e }; })
      };
      if (Dedupe.sameMeeting(m, other)) return f;
    }
    return null;
  },

  // ------------------------------------------------------------------ per-run caches

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
      try {
        ctx.cache.notDup = typeof Dedupe.notDuplicateFeedback === 'function'
          ? Dedupe.notDuplicateFeedback(200) : Store.feedbackRecent(200, 'not_duplicate');
      } catch (e) { ctx.cache.notDup = []; }
    }
    return ctx.cache.notDup;
  },

  // ------------------------------------------------------------------ misc

  outOfTime_(deadline) {
    return deadline.expired() || deadline.remaining() < Meetings.RESERVE_MS;
  },

  firefliesEnabled_() {
    return !!Config.get('FIREFLIES_API_KEY');
  },

  granolaConfigured_() {
    return !!Config.get('GRANOLA_API_KEY');
  },

  errText_(e) {
    if (!e) return 'unknown error';
    return (e.name && e.name !== 'Error' ? e.name + ': ' : '') + (e.message || String(e)) +
      (e.status ? ' (HTTP ' + e.status + ')' : '');
  }
};

/** Trigger: every 10 min. Meeting notes -> tasks / triage queue. */
function runMeetings() {
  return Util.withLock('runMeetings', function () {
    return Meetings.run({ backfill: false });
  });
}

/**
 * Manual: queue everything from the last BACKFILL_DAYS days (chip "Backfill"). Resumable: a new
 * window starts only after the previous one completed; a one-off trigger continues unfinished work.
 */
function runBackfill() {
  let ran = false;
  const res = Util.withLock('runBackfill', function () {
    ran = true;
    return Meetings.run({ backfill: true });
  });
  if (!ran) {
    // Lock busy (usually runMeetings): retry in a minute rather than silently breaking the
    // continuation chain (or ignoring a manual start).
    console.log('[backfill] lock busy; retrying in 1 min');
    Meetings.scheduleContinuation_(true);
  }
  return res;
}
