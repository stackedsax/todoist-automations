/**
 * Dedupe — merge the same meeting recorded by several sources, and match extracted items
 * against open Todoist tasks (docs/DESIGN.md "Meeting pipeline" steps 3 and 7).
 */
const Dedupe = {
  /** Max start-time difference for two recordings to be the same meeting. */
  MEETING_WINDOW_MS: 10 * 60 * 1000,
  /** Normalised title similarity (token Jaccard) that, with the time window, marks the same meeting. */
  MEETING_TITLE_SIM: 0.6,
  /** Task-title match thresholds. */
  TASK_JACCARD: 0.5,
  TASK_CONTAINMENT: 0.7,
  /** Containment needs at least this many tokens on the shorter side (one shared word is not a match). */
  MIN_CONTAINMENT_TOKENS: 2,

  /** Source preference: lower wins as primary. */
  SOURCE_RANK_: { granola: 0, fireflies: 1 },

  /**
   * Merge recordings of the same meeting across sources.
   * Same meeting: |start difference| <= 10 min AND (>= 1 shared attendee email other than Alex's
   * OR normalised title similarity >= 0.6). Only recordings from DIFFERENT sources merge.
   * The Granola recording is primary; a secondary's transcript / action items / attendees fill only
   * what the primary lacks. Each result carries alsoRecordedBy [{source, sourceId, url}] and
   * mergedKeys (every source key, primary first) so the caller can ledger all of them.
   * Inputs are not mutated. Output is sorted by start time.
   * @param {Object[]} meetings
   * @return {Object[]}
   */
  mergeMeetings(meetings) {
    const list = (meetings || []).filter(Boolean).slice().sort(function (a, b) {
      const ra = Dedupe.rank_(a), rb = Dedupe.rank_(b);
      if (ra !== rb) return ra - rb;
      return Dedupe.startMs_(a) - Dedupe.startMs_(b);
    });
    const groups = []; // {primary, members: [meeting]}
    list.forEach(function (m) {
      const g = groups.find(function (grp) {
        if (grp.members.some(function (x) { return x.source === m.source; })) return false;
        return Dedupe.sameMeeting(grp.members[0], m);
      });
      if (g) g.members.push(m);
      else groups.push({ members: [m] });
    });
    return groups.map(function (g) { return Dedupe.combine_(g.members); })
      .sort(function (a, b) { return Dedupe.startMs_(a) - Dedupe.startMs_(b); });
  },

  /** True if two meetings look like the same real meeting (see mergeMeetings). */
  sameMeeting(a, b) {
    if (!a || !b) return false;
    const sa = Dedupe.startMs_(a), sb = Dedupe.startMs_(b);
    if (isNaN(sa) || isNaN(sb) || Math.abs(sa - sb) > Dedupe.MEETING_WINDOW_MS) return false;
    if (Dedupe.sharedOtherAttendees_(a, b) >= 1) return true;
    return Dedupe.titleSimilarity(a.title, b.title) >= Dedupe.MEETING_TITLE_SIM;
  },

  /** Normalised title similarity 0..1 (1 for identical normalised titles, else token Jaccard). */
  titleSimilarity(a, b) {
    const na = Util.normalizeTitle(a), nb = Util.normalizeTitle(b);
    if (na && na === nb) return 1;
    return Util.tokenJaccard(a, b);
  },

  /**
   * Best open task that duplicates `item`, or null.
   * Match: token Jaccard >= 0.5 OR containment >= 0.7 (with >= 2 tokens on the shorter side),
   * over the item title vs the task content (markdown links, @labels and "Name:" prefixes stripped).
   * Pairs recorded as `not_duplicate` feedback are skipped, as is item.dupTaskId when item.notDuplicate.
   * @param {{id?: string, title: string, dupTaskId?: string, notDuplicate?: boolean}} item
   * @param {Object[]} openTasks Todoist tasks ({id, content})
   * @param {Object[]} [feedback] Store.feedbackRecent() rows (any type; not_duplicate rows and 'undone' undup reversals are used)
   * @return {{taskId: string, title: string, score: number, jaccard: number, containment: number}|null}
   */
  matchTask(item, openTasks, feedback) {
    if (!item || !item.title) return null;
    const blocked = Dedupe.blockedTaskIds_(item, feedback);
    const itemTokens = Util.tokens(item.title);
    if (!itemTokens.length) return null;
    let best = null;
    (openTasks || []).forEach(function (t) {
      if (!t || t.id === undefined || t.id === null) return;
      const id = String(t.id);
      if (blocked.ids[id]) return;
      const text = Dedupe.taskText(t.content);
      if (blocked.titles[Util.normalizeTitle(text)]) return;
      const s = Dedupe.similarity(item.title, text);
      if (!s.match) return;
      if (!best || s.score > best.score || (s.score === best.score && s.jaccard > best.jaccard)) {
        best = { taskId: id, title: String(t.content || ''), score: s.score, jaccard: s.jaccard, containment: s.containment };
      }
    });
    return best;
  },

  /**
   * Title similarity used by matchTask.
   * @return {{jaccard: number, containment: number, score: number, match: boolean}}
   */
  similarity(a, b) {
    const A = Util.tokens(a), B = Util.tokens(b);
    if (!A.length || !B.length) return { jaccard: 0, containment: 0, score: 0, match: false };
    const j = Util.tokenJaccard(a, b);
    const c = Math.min(A.length, B.length) >= Dedupe.MIN_CONTAINMENT_TOKENS ? Util.containment(a, b) : 0;
    const match = j >= Dedupe.TASK_JACCARD || c >= Dedupe.TASK_CONTAINMENT;
    return { jaccard: j, containment: c, score: Math.max(j, c), match: match };
  },

  /** Task content reduced to comparable text: markdown links -> text, @labels and "Name:" / "Follow up with X:" prefixes removed. */
  taskText(content) {
    return String(content || '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/(^|\s)@[\w-]+/g, ' ')
      .replace(/^\s*follow up with [^:]{1,60}:\s*/i, '')
      .replace(/^\s*[A-Z][\w.'-]*(?: [A-Z][\w.'-]*){0,3}:\s+/, '')
      .trim();
  },

  /**
   * Feedback matchTask needs, newest first: not_duplicate rows plus the 'undone' rows that
   * withdraw an undup (so a reversed "not a duplicate" stops suppressing the pair).
   */
  notDuplicateFeedback(n) {
    const lim = n || 200;
    try {
      return (Store.feedbackRecent(lim * 5) || []).filter(function (f) {
        return f && (f.type === 'not_duplicate' || (f.type === 'undone' && Dedupe.detail_(f).action === 'undup'));
      }).slice(0, lim);
    } catch (e) {
      console.log('Dedupe.notDuplicateFeedback: ' + e.message);
      return [];
    }
  },

  /**
   * Near-duplicate titles within one list (same source): keeps the first of each cluster, where
   * "near" = identical normalised title or token Jaccard >= threshold (default 0.8).
   * @param {Object[]} items with .title
   * @param {number} [threshold]
   */
  uniqueTitles(items, threshold) {
    const th = typeof threshold === 'number' ? threshold : 0.8;
    const kept = [];
    (items || []).forEach(function (it) {
      const dup = kept.some(function (k) {
        const na = Util.normalizeTitle(k.title), nb = Util.normalizeTitle(it.title);
        return na === nb || Util.tokenJaccard(k.title, it.title) >= th;
      });
      if (!dup) kept.push(it);
    });
    return kept;
  },

  // ---------------------------------------------------------------- private

  rank_(m) {
    const r = Dedupe.SOURCE_RANK_[m && m.source];
    return r === undefined ? 9 : r;
  },

  startMs_(m) {
    const d = Util.parseDate(m && m.start);
    return d ? d.getTime() : NaN;
  },

  otherEmails_(m) {
    const out = {};
    ((m && m.attendees) || []).forEach(function (a) {
      const e = a && Util.parseEmail(a.email);
      if (e && !Config.isMyEmail(e)) out[e] = 1;
    });
    const org = m && Util.parseEmail(m.organizerEmail);
    if (org && !Config.isMyEmail(org)) out[org] = 1;
    return out;
  },

  sharedOtherAttendees_(a, b) {
    const A = Dedupe.otherEmails_(a), B = Dedupe.otherEmails_(b);
    return Object.keys(A).filter(function (e) { return B[e]; }).length;
  },

  combine_(members) {
    const primary = Object.assign({}, members[0]);
    const also = (primary.alsoRecordedBy || []).slice();
    const keys = [primary.key];
    members.slice(1).forEach(function (m) {
      also.push({ source: m.source, sourceId: m.sourceId, url: m.url || null });
      keys.push(m.key);
      if ((!primary.transcript || !primary.transcript.length) && m.transcript && m.transcript.length) {
        primary.transcript = m.transcript;
        primary.transcriptFrom = m.source;
        // Whose note the borrowed transcript is (Granola: the microphone belongs to its owner).
        if (m.ownerIsMe !== undefined) primary.transcriptOwnerIsMe = m.ownerIsMe;
        if (m.ownerName !== undefined) primary.transcriptOwnerName = m.ownerName;
        if (m.ownerEmail !== undefined) primary.transcriptOwnerEmail = m.ownerEmail;
      }
      if (!primary.actionItemsText && m.actionItemsText) primary.actionItemsText = m.actionItemsText;
      if (!primary.summaryMarkdown && m.summaryMarkdown) primary.summaryMarkdown = m.summaryMarkdown;
      if ((!primary.attendees || !primary.attendees.length) && m.attendees && m.attendees.length) primary.attendees = m.attendees;
      if (!primary.end && m.end) primary.end = m.end;
      if (!primary.organizerEmail && m.organizerEmail) primary.organizerEmail = m.organizerEmail;
    });
    primary.alsoRecordedBy = also;
    primary.mergedKeys = keys.filter(Boolean);
    return primary;
  },

  /** An undo row is paired with the not_duplicate row its undup wrote when their times agree. */
  UNDO_PAIR_MS_: 5000,

  /**
   * Task ids / titles this item must not be matched against. Feedback is replayed newest-first
   * so the latest state per (item, task) wins:
   *   - type 'not_duplicate'                       -> pair suppressed
   *   - type 'not_duplicate' with detail.cleared   -> pair un-suppressed (toggle-off contract)
   *   - type 'undone' with detail.action 'undup'   -> withdraws the not_duplicate row written by
   *     that undup (matched by detail.at within UNDO_PAIR_MS_, or the next older row when the
   *     undo carries no time); an undo of a toggle-off matches nothing and changes nothing.
   * Other rows are ignored, so callers may pass mixed feedback (see notDuplicateFeedback).
   */
  blockedTaskIds_(item, feedback) {
    const ids = {};
    const titles = {};
    if (item.notDuplicate && item.dupTaskId) ids[String(item.dupTaskId)] = 1;
    const myTitle = Util.normalizeTitle(item.title);
    const rows = [];
    (feedback || []).forEach(function (f, i) {
      if (!f) return;
      const isUndo = f.type === 'undone' && Dedupe.detail_(f).action === 'undup';
      if (f.type !== 'not_duplicate' && !isUndo) return;
      const sameItem = (item.id && f.queueId && f.queueId === item.id) ||
        (f.title && Util.normalizeTitle(f.title) === myTitle);
      if (!sameItem) return;
      rows.push({ f: f, i: i, undo: isUndo, ms: Dedupe.ms_(f.at) });
    });
    // Newest first; rows without a time keep the caller's order (feedbackRecent is newest first).
    rows.sort(function (a, b) {
      if (!isNaN(a.ms) && !isNaN(b.ms) && a.ms !== b.ms) return b.ms - a.ms;
      return a.i - b.i;
    });
    const decided = {};
    const undos = [];
    rows.forEach(function (r) {
      const d = Dedupe.detail_(r.f);
      if (r.undo) {
        undos.push({ ms: Dedupe.ms_(d.at), used: false });
        return;
      }
      const tid = d.taskId || d.dupTaskId;
      const tt = d.taskTitle || d.dupTaskTitle;
      // State is keyed by task id when known (the title rides along), else by task title.
      const key = tid ? 'id:' + String(tid) : (tt ? 't:' + Util.normalizeTitle(Dedupe.taskText(tt)) : null);
      if (!key) return;
      let blocked = d.cleared !== true;
      if (blocked) {
        const u = undos.find(function (x) {
          return !x.used && (isNaN(x.ms) || isNaN(r.ms) || Math.abs(x.ms - r.ms) <= Dedupe.UNDO_PAIR_MS_);
        });
        if (u) { u.used = true; blocked = false; }
      }
      if (decided[key] !== undefined) return;
      decided[key] = blocked;
      if (!blocked) return;
      if (tid) ids[String(tid)] = 1;
      if (tt) titles[Util.normalizeTitle(Dedupe.taskText(tt))] = 1;
    });
    return { ids: ids, titles: titles };
  },

  detail_(f) {
    let d = f && f.detail;
    if (typeof d === 'string') d = Util.parseJson(d, {});
    return d && typeof d === 'object' ? d : {};
  },

  ms_(v) {
    const d = v ? Util.parseDate(v) : null;
    return d ? d.getTime() : NaN;
  }
};
