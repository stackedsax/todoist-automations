/**
 * Fireflies — Fireflies.ai GraphQL client that returns normalised Meeting objects
 * (docs/DESIGN.md "Meeting"). Backup source to Granola; only used when FIREFLIES_API_KEY is set.
 * Replaces the old recap-email parser entirely.
 *
 * API reference: https://docs.fireflies.ai/ (GraphQL endpoint https://api.fireflies.ai/graphql,
 * `Authorization: Bearer <FIREFLIES_API_KEY>`).
 *   Query `transcripts(fromDate: DateTime, toDate: DateTime, limit: Int (max 50), skip: Int,
 *     user_id: String, mine: Boolean)` -- https://docs.fireflies.ai/graphql-api/query/transcripts
 *     `user_id` = "meetings that have this user ID as the organizer or participant"; `mine` =
 *     "meetings that have the API key owner as the organizer" (organizer ONLY, so it would drop
 *     meetings Alex merely attended -- not used). No sort order is documented.
 *   Query `user` without id -> the API key owner {user_id email name}
 *     https://docs.fireflies.ai/graphql-api/query/user
 *   Query `transcript(id: String!)`
 *     https://docs.fireflies.ai/graphql-api/query/transcript
 *   Transcript fields used: id title date (epoch ms) duration (minutes) organizer_email
 *     participants [String] meeting_attendees{displayName email name}
 *     summary{overview action_items} sentences{speaker_name text start_time (seconds)} transcript_url
 *     https://docs.fireflies.ai/schema/transcript
 * GraphQL errors arrive as HTTP 200 with an `errors` array; they are thrown as Errors here.
 *
 * Ownership warning: summary.action_items is grouped under speaker names (e.g. "**Alex Blundell**")
 * and is UNRELIABLE for ownership. It is passed through as actionItemsText for the extractor
 * as a hint only. Speaker mapping: identity.myNames -> "me"; identity.notMe and any other real
 * name -> "them"; no name, generic "Speaker N", or a bare first name shared with Alex
 * (e.g. just "Alex") -> "unknown".
 *
 * Whose meetings: on a team/Business key `transcripts` can include teammates' meetings, so the
 * listing is filtered server-side with `user_id` = the key owner's id (from `user`, cached 6h),
 * and client-side: a meeting that lists emails but none of identity.myEmails is dropped.
 *
 * Rate limits (https://docs.fireflies.ai/fundamentals/limits): Free 50 requests/day, Pro 500/day,
 * Business 60/min. listSince makes 1 `user` call per 6h, 1 list call per 50 meetings and 1
 * `transcript` call per meeting whose sentences it fetches; pass needTranscript/transcriptGraceMs
 * to skip sentences for meetings the caller will not process yet.
 */
const Fireflies = {
  URL: 'https://api.fireflies.ai/graphql',
  PAGE_SIZE: 50,
  MAX_PAGES: 40,
  /** Listing pages allowed after the deadline expires before the listing counts as incomplete. */
  LIST_OVERRUN_PAGES: 3,
  USER_CACHE_KEY: 'fireflies.ownerUserId',
  USER_CACHE_SECONDS: 21600,
  ownerId_: undefined,

  LIST_FIELDS_: 'id title date duration organizer_email participants ' +
    'meeting_attendees { displayName email name } summary { overview action_items } transcript_url',

  /** True when FIREFLIES_API_KEY is configured. */
  enabled() {
    return !!Config.get('FIREFLIES_API_KEY');
  },

  /**
   * POST a GraphQL query; returns `data`. Throws on HTTP errors (via Http) or GraphQL `errors`.
   */
  graphql(query, variables) {
    const res = Http.fetchJson(Fireflies.URL, {
      method: 'post',
      headers: { Authorization: 'Bearer ' + Config.require('FIREFLIES_API_KEY') },
      payload: { query: query, variables: variables || {} }
    }) || {};
    if (res.errors && res.errors.length) {
      const msg = res.errors.map(function (e) { return e && e.message ? e.message : String(e); }).join('; ');
      const err = new Error('Fireflies GraphQL error: ' + msg);
      err.name = 'GraphQLError';
      err.errors = res.errors;
      throw err;
    }
    return res.data || {};
  },

  /**
   * The API key owner's Fireflies user_id (memory + CacheService 6h), or null when the `user`
   * query fails (the client-side email guard still applies then).
   */
  ownerUserId() {
    if (Fireflies.ownerId_ !== undefined) return Fireflies.ownerId_;
    let cache = null;
    try { cache = CacheService.getScriptCache(); } catch (e) { cache = null; }
    const hit = cache ? cache.get(Fireflies.USER_CACHE_KEY) : null;
    if (hit) { Fireflies.ownerId_ = hit; return hit; }
    let id = null;
    try {
      const u = Fireflies.graphql('query User { user { user_id email name } }', {}).user;
      id = u && u.user_id ? String(u.user_id) : null;
    } catch (e) {
      console.log('[Fireflies] owner lookup failed; listing without user_id: ' + (e && e.message));
      id = null;
    }
    Fireflies.ownerId_ = id;
    if (id && cache) {
      try { cache.put(Fireflies.USER_CACHE_KEY, id, Fireflies.USER_CACHE_SECONDS); } catch (e) { /* best effort */ }
    }
    return id;
  },

  /**
   * Raw transcript list (no sentences) since `fromDate`, paging with limit/skip, filtered to the
   * key owner's meetings (user_id). The returned array carries `complete`: false when paging was
   * cut (deadline overrun or maxPages) and more meetings may exist.
   * @param {{fromDate?: (Date|string), toDate?: (Date|string), limit?: number, maxPages?: number,
   *          userId?: (string|null), deadline?: {expired: function(): boolean}}} [opts]
   *   userId: override the owner filter (null = no server-side filter).
   *   deadline: once expired, at most LIST_OVERRUN_PAGES more pages are fetched.
   */
  listTranscripts(opts) {
    const o = opts || {};
    const limit = Math.min(Fireflies.PAGE_SIZE, o.limit || Fireflies.PAGE_SIZE);
    const maxPages = o.maxPages || Fireflies.MAX_PAGES;
    const userId = o.userId !== undefined ? o.userId : Fireflies.ownerUserId();
    const q = 'query Transcripts($fromDate: DateTime, $toDate: DateTime, $limit: Int, $skip: Int, $userId: String) {' +
      ' transcripts(fromDate: $fromDate, toDate: $toDate, limit: $limit, skip: $skip, user_id: $userId) { ' +
      Fireflies.LIST_FIELDS_ + ' } }';
    const out = [];
    const seen = {};
    let complete = false;
    let overrun = 0;
    for (let page = 0; page < maxPages; page++) {
      if (page > 0 && o.deadline && o.deadline.expired() && ++overrun > Fireflies.LIST_OVERRUN_PAGES) break;
      const vars = { limit: limit, skip: page * limit };
      const from = Fireflies.iso_(o.fromDate);
      const to = Fireflies.iso_(o.toDate);
      if (from) vars.fromDate = from;
      if (to) vars.toDate = to;
      if (userId) vars.userId = userId;
      const list = Fireflies.graphql(q, vars).transcripts || [];
      list.forEach(function (t) {
        if (!t || !t.id || seen[t.id]) return;
        seen[t.id] = true;
        out.push(t);
      });
      if (list.length < limit) { complete = true; break; }
    }
    out.complete = complete;
    return out;
  },

  /**
   * Client-side guard: false when the meeting lists emails (organizer, participants,
   * attendees) and none of them is one of identity.myEmails.
   */
  isMine_(raw) {
    const emails = [];
    if (raw.organizer_email) emails.push(raw.organizer_email);
    (raw.participants || []).forEach(function (p) {
      String(p || '').split(/[,;]/).forEach(function (x) { if (x.trim()) emails.push(x); });
    });
    (raw.meeting_attendees || []).forEach(function (a) { if (a && a.email) emails.push(a.email); });
    const parsed = emails.map(function (e) { return Util.parseEmail(String(e)); }).filter(Boolean);
    if (!parsed.length) return true;
    return parsed.some(function (e) { return Config.isMyEmail(e); });
  },

  /** One raw transcript including sentences, or null if Fireflies returns none. */
  getTranscript(id) {
    const q = 'query Transcript($id: String!) { transcript(id: $id) { ' + Fireflies.LIST_FIELDS_ +
      ' sentences { speaker_name text start_time } } }';
    return Fireflies.graphql(q, { id: String(id) }).transcript || null;
  },

  /** One transcript as a Meeting (with transcript), or null. */
  get(id) {
    const raw = Fireflies.getTranscript(id);
    return raw ? Fireflies.toMeeting(raw) : null;
  },

  /**
   * Meetings recorded since `fromDate`, oldest first.
   * By default meetings without a summary yet (still processing) are skipped so a later run
   * picks them up, meetings that are not Alex's (isMine_) are dropped, and each meeting's
   * sentences are fetched as its transcript, OLDEST FIRST.
   *
   * Never silently short: if the listing itself is cut at the deadline, this throws
   * (name 'FirefliesIncompleteError') so the caller keeps its cursor. When the deadline expires
   * during the per-meeting sentence fetches, the remaining (newer) meetings are still returned,
   * with transcript null and `deferred: true`, `transcriptDeferred: 'deadline'`; the caller must
   * not process them this run (Meetings' own deadline check treats them as pending).
   * Meetings skipped by needTranscript/transcriptGraceMs come back with transcript null and
   * `transcriptDeferred: 'caller'` / `'grace'` (NOT `deferred`).
   * @param {(Date|string)} fromDate
   * @param {{transcripts?: boolean, includeUnsummarised?: boolean, skipIds?: function(string): boolean,
   *          needTranscript?: function(string, Date): boolean, transcriptGraceMs?: number,
   *          toDate?: (Date|string), deadline?: {expired: function(): boolean}}} [opts]
   *   skipIds(id) -> true to skip (e.g. already in the ledger) before fetching sentences.
   *   needTranscript(id, start) -> false to skip the sentences fetch for that meeting.
   *   transcriptGraceMs: skip the sentences fetch for meetings that started less than this ago
   *     (e.g. Fireflies-only recordings the caller defers while waiting for Granola).
   * @return {Object[]} Meetings
   */
  listSince(fromDate, opts) {
    const o = opts || {};
    const withTranscripts = o.transcripts !== false;
    const raws = Fireflies.listTranscripts({ fromDate: fromDate, toDate: o.toDate, deadline: o.deadline });
    if (raws.complete === false && o.deadline && o.deadline.expired()) {
      const err = new Error('Fireflies listing incomplete at deadline (' + raws.length + ' listed); will retry');
      err.name = 'FirefliesIncompleteError';
      throw err;
    }
    const nowMs = Util.now().getTime();
    const candidates = raws.filter(function (raw) {
      if (o.skipIds && o.skipIds(String(raw.id))) return false;
      if (!o.includeUnsummarised && !Fireflies.hasSummary_(raw)) return false;
      if (!Fireflies.isMine_(raw)) {
        console.log('[Fireflies] skipping ' + raw.id + ': none of my emails among its participants');
        return false;
      }
      return true;
    }).map(function (raw) { return { raw: raw, start: Fireflies.date_(raw.date) }; });
    candidates.sort(function (a, b) {
      return (a.start ? a.start.getTime() : 0) - (b.start ? b.start.getTime() : 0);
    });
    const out = [];
    let cut = false;
    candidates.forEach(function (c) {
      const raw = c.raw;
      if (!withTranscripts) { out.push(Fireflies.toMeeting(raw)); return; }
      let skip = null;
      if (o.transcriptGraceMs && c.start && nowMs - c.start.getTime() < o.transcriptGraceMs) skip = 'grace';
      else if (o.needTranscript && o.needTranscript(String(raw.id), c.start) === false) skip = 'caller';
      if (skip) {
        const m = Fireflies.toMeeting(raw);
        m.transcriptDeferred = skip;
        out.push(m);
        return;
      }
      if (!cut && o.deadline && o.deadline.expired()) cut = true;
      if (cut) {
        const m = Fireflies.toMeeting(raw);
        m.deferred = true;
        m.transcriptDeferred = 'deadline';
        out.push(m);
        return;
      }
      let full = raw;
      try {
        full = Fireflies.getTranscript(raw.id) || raw;
      } catch (e) {
        console.log('[Fireflies] transcript ' + raw.id + ' failed: ' + (e && e.message));
        full = raw;
      }
      out.push(Fireflies.toMeeting(full));
    });
    out.sort(function (a, b) { return a.start.getTime() - b.start.getTime(); });
    return out;
  },

  /** Raw Fireflies transcript -> Meeting. */
  toMeeting(raw) {
    const start = Fireflies.date_(raw.date) || Util.now();
    const minutes = Number(raw.duration);
    const end = isFinite(minutes) && minutes > 0 ? new Date(start.getTime() + Math.round(minutes * 60000)) : null;
    const summary = raw.summary || {};
    const actionItems = Fireflies.text_(summary.action_items);
    return {
      key: 'fireflies:' + raw.id,
      source: 'fireflies',
      sourceId: String(raw.id),
      title: String(raw.title || 'Untitled meeting').trim(),
      start: start,
      end: end,
      url: raw.transcript_url || ('https://app.fireflies.ai/view/' + encodeURIComponent(raw.id)),
      attendees: Fireflies.attendees_(raw),
      organizerEmail: raw.organizer_email ? Util.parseEmail(raw.organizer_email) : null,
      calendarEventId: null,
      summaryMarkdown: Fireflies.summaryMarkdown_(summary),
      actionItemsText: actionItems || null,
      transcript: Array.isArray(raw.sentences) ? Fireflies.mapSentences(raw.sentences) : null,
      alsoRecordedBy: [],
      updatedAt: null
    };
  },

  /**
   * sentences -> [{speaker, name, text, t}], merging consecutive sentences by the same speaker
   * (keeps the first start time) to keep the prompt compact.
   */
  mapSentences(sentences) {
    const out = [];
    (sentences || []).forEach(function (s) {
      if (!s) return;
      const text = String(s.text || '').trim();
      if (!text) return;
      const name = s.speaker_name ? String(s.speaker_name).trim() || null : null;
      const t = Number(s.start_time);
      const last = out[out.length - 1];
      if (last && last.name === name) {
        last.text += ' ' + text;
        return;
      }
      out.push({
        speaker: Fireflies.speakerOf_(name),
        name: name,
        text: text,
        t: s.start_time !== null && s.start_time !== undefined && isFinite(t) ? Math.max(0, Math.round(t)) : null
      });
    });
    return out;
  },

  speakerOf_(name) {
    if (!name || /^speaker(\s*[a-z0-9]+)?$/i.test(name)) return 'unknown';
    if (Config.isNotMe(name)) return 'them';
    if (Config.isMyName(name)) return 'me';
    const n = name.trim().toLowerCase();
    const ambiguous = Config.identity().myNames.some(function (m) {
      return String(m).trim().split(/\s+/)[0].toLowerCase() === n;
    });
    return ambiguous ? 'unknown' : 'them';
  },

  hasSummary_(raw) {
    const s = raw && raw.summary;
    return !!(s && (Fireflies.text_(s.overview) || Fireflies.text_(s.action_items)));
  },

  summaryMarkdown_(summary) {
    const parts = [];
    const overview = Fireflies.text_(summary.overview);
    const items = Fireflies.text_(summary.action_items);
    if (overview) parts.push(overview);
    if (items) parts.push('### Action items\n' + items);
    return parts.join('\n\n');
  },

  /** Fireflies text fields are usually strings; tolerate arrays. */
  text_(v) {
    if (v === null || v === undefined) return '';
    if (Array.isArray(v)) return v.map(function (x) { return String(x).trim(); }).filter(Boolean).join('\n');
    return String(v).trim();
  },

  /** meeting_attendees merged with participants (emails; sometimes one comma-joined string). */
  attendees_(raw) {
    const out = [];
    const byEmail = {};
    const add = function (name, emailRaw) {
      const email = emailRaw ? Util.parseEmail(emailRaw) : null;
      const nm = name ? String(name).trim() || null : null;
      if (email) {
        if (byEmail[email]) {
          if (!byEmail[email].name && nm) byEmail[email].name = nm;
          return;
        }
        byEmail[email] = { name: nm, email: email };
        out.push(byEmail[email]);
      } else if (nm && !out.some(function (x) { return !x.email && x.name === nm; })) {
        out.push({ name: nm, email: null });
      }
    };
    (raw.meeting_attendees || []).forEach(function (a) {
      if (a) add(a.displayName || a.name, a.email);
    });
    (raw.participants || []).forEach(function (p) {
      String(p || '').split(/[,;]/).forEach(function (part) {
        if (part.trim()) add(null, part);
      });
    });
    return out;
  },

  /** `date` is epoch milliseconds (number or numeric string); ISO strings also accepted. */
  date_(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number' || /^\d+(\.\d+)?$/.test(String(v))) {
      const d = new Date(Number(v));
      return isNaN(d.getTime()) ? null : d;
    }
    return Util.parseDate(v);
  },

  iso_(v) {
    if (v === null || v === undefined || v === '') return null;
    const d = Util.parseDate(v);
    return d ? d.toISOString() : null;
  }
};
