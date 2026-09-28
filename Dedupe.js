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
   * @param {Object[]} [feedback] Store.feedbackRecent() rows (any type; only not_duplicate is used)
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

  /** not_duplicate feedback (newest first) for callers that don't already hold it. */
  notDuplicateFeedback(n) {
    try {
      return Store.feedbackRecent(n || 200, 'not_duplicate');
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

  blockedTaskIds_(item, feedback) {
    const ids = {};
    const titles = {};
    if (item.notDuplicate && item.dupTaskId) ids[String(item.dupTaskId)] = 1;
    const myTitle = Util.normalizeTitle(item.title);
    (feedback || []).forEach(function (f) {
      if (!f || f.type !== 'not_duplicate') return;
      const sameItem = (item.id && f.queueId && f.queueId === item.id) ||
        (f.title && Util.normalizeTitle(f.title) === myTitle);
      if (!sameItem) return;
      const d = (f.detail && typeof f.detail === 'object') ? f.detail : {};
      const tid = d.taskId || d.dupTaskId;
      if (tid) ids[String(tid)] = 1;
      const tt = d.taskTitle || d.dupTaskTitle;
      if (tt) titles[Util.normalizeTitle(Dedupe.taskText(tt))] = 1;
    });
    return { ids: ids, titles: titles };
  }
};
