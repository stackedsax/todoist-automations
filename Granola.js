/**
 * Granola — Granola public API client that returns normalised Meeting objects
 * (docs/DESIGN.md "Meeting").
 *
 * API reference: https://docs.granola.ai/ (public API, base https://public-api.granola.ai/v1)
 *   GET /notes                     ?created_after&updated_after&cursor&page_size(<=30)
 *                                  -> {notes: [...], hasMore, cursor}
 *   GET /notes/{id}?include=transcript
 *                                  -> note {id, title, owner, created_at, updated_at, web_url,
 *                                     calendar_event{event_title, invitees, organiser, calendar_event_id,
 *                                     scheduled_start_time, scheduled_end_time}, attendees[{name,email}],
 *                                     folder_membership, summary_text, summary_markdown,
 *                                     transcript[{speaker{source, attribution, name?}, text, start_time, end_time}]}
 *   GET /notes/{id}/transcript     ?cursor&page_size(<=100) -> {transcript, hasMore, cursor}
 * Auth: `Authorization: Bearer <GRANOLA_API_KEY>`.
 * Only notes that have a generated summary are returned by the API; notes still waiting for
 * a summary are caught by Checks (runSummaryCheck), not here.
 *
 * Transcript speaker mapping: speaker.attribution "me" -> "me", "them" -> "them"; when the
 * attribution is missing, a speaker name in identity.myNames -> "me", any other real name
 * (including identity.notMe, e.g. "Alex Blundell") -> "them", otherwise "unknown".
 */
const Granola = {
  BASE: 'https://public-api.granola.ai/v1',
  PAGE_SIZE: 30,
  TRANSCRIPT_PAGE_SIZE: 100,
  MAX_PAGES: 200,

  headers_() {
    return { Authorization: 'Bearer ' + Config.require('GRANOLA_API_KEY'), Accept: 'application/json' };
  },

  get_(path, query) {
    return Http.fetchJson(Granola.BASE + path, { headers: Granola.headers_(), query: query });
  },

  /**
   * List note summaries (raw API objects), following the cursor until hasMore is false.
   * @param {{updatedAfter?: (Date|string), createdAfter?: (Date|string), pageSize?: number,
   *          maxPages?: number, deadline?: {expired: function(): boolean}}} [opts]
   * @return {Object[]} raw note list entries (at least {id, title, created_at, updated_at}),
   *   in API order. Stops early (returning what it has) when the deadline expires.
   */
  listNotes(opts) {
    const o = opts || {};
    const pageSize = Math.min(Granola.PAGE_SIZE, o.pageSize || Granola.PAGE_SIZE);
    const maxPages = o.maxPages || Granola.MAX_PAGES;
    const out = [];
    const seen = {};
    let cursor = null;
    for (let page = 0; page < maxPages; page++) {
      if (page > 0 && o.deadline && o.deadline.expired()) break;
      const res = Granola.get_('/notes', {
        created_after: Granola.iso_(o.createdAfter),
        updated_after: Granola.iso_(o.updatedAfter),
        page_size: pageSize,
        cursor: cursor
      }) || {};
      (res.notes || []).forEach(function (n) {
        if (!n || !n.id || seen[n.id]) return;
        seen[n.id] = true;
        out.push(n);
      });
      if (!res.hasMore || !res.cursor || res.cursor === cursor) break;
      cursor = res.cursor;
    }
    return out;
  },

  /**
   * Fetch one note, as a raw API object with `transcript` filled when requested.
   * With transcript: tries ?include=transcript; on 413 (payload too large) or when the inline
   * transcript is missing, fetches the note without it and pages /notes/{id}/transcript.
   * @param {string} id
   * @param {{transcript?: boolean}} [opts] transcript defaults to true
   */
  getRaw(id, opts) {
    const wantTranscript = !opts || opts.transcript !== false;
    const path = '/notes/' + encodeURIComponent(id);
    if (!wantTranscript) return Granola.get_(path);
    let note;
    try {
      note = Granola.get_(path, { include: 'transcript' });
    } catch (e) {
      if (e && e.status === 413) {
        console.log('[Granola] note ' + id + ' too large with inline transcript; paging /transcript');
        note = Granola.get_(path);
      } else {
        throw e;
      }
    }
    if (note && !Array.isArray(note.transcript)) {
      note.transcript = Granola.fetchTranscript(id);
    }
    return note;
  },

  /**
   * Fetch a note and normalise it to a Meeting.
   * @param {string} id
   * @param {{transcript?: boolean}} [opts] transcript defaults to true
   * @return {Object|null} Meeting
   */
  getNote(id, opts) {
    const raw = Granola.getRaw(id, opts);
    return raw ? Granola.toMeeting(raw) : null;
  },

  /**
   * Page through /notes/{id}/transcript. Returns raw segments, or null when the note has no
   * transcript (404).
   */
  fetchTranscript(id) {
    const out = [];
    let cursor = null;
    for (let page = 0; page < Granola.MAX_PAGES; page++) {
      let res;
      try {
        res = Granola.get_('/notes/' + encodeURIComponent(id) + '/transcript',
          { page_size: Granola.TRANSCRIPT_PAGE_SIZE, cursor: cursor }) || {};
      } catch (e) {
        if (e && e.status === 404 && page === 0) return null;
        throw e;
      }
      (res.transcript || []).forEach(function (s) { out.push(s); });
      if (!res.hasMore || !res.cursor || res.cursor === cursor) break;
      cursor = res.cursor;
    }
    return out;
  },

  /** Raw Granola note -> Meeting (docs/DESIGN.md). */
  toMeeting(raw) {
    const ev = raw.calendar_event || {};
    const start = Util.parseDate(ev.scheduled_start_time) || Util.parseDate(raw.created_at) || Util.now();
    const end = Util.parseDate(ev.scheduled_end_time);
    const title = String(raw.title || ev.event_title || 'Untitled meeting').trim();
    return {
      key: 'granola:' + raw.id,
      source: 'granola',
      sourceId: String(raw.id),
      title: title,
      start: start,
      end: end,
      url: raw.web_url || null,
      attendees: Granola.attendees_(raw),
      organizerEmail: Granola.email_(ev.organiser || ev.organizer),
      calendarEventId: ev.calendar_event_id || null,
      summaryMarkdown: String(raw.summary_markdown || raw.summary_text || ''),
      actionItemsText: null,
      transcript: Array.isArray(raw.transcript) ? Granola.mapTranscript(raw.transcript) : null,
      alsoRecordedBy: [],
      // Extra (not in the DESIGN Meeting shape): lets Meetings advance granola.updatedAfter.
      updatedAt: Util.parseDate(raw.updated_at)
    };
  },

  /** Raw transcript segments -> [{speaker: me|them|unknown, name, text, t}] (empty text dropped). */
  mapTranscript(segments) {
    const list = (segments || []).filter(function (s) { return s && String(s.text || '').trim(); });
    let base = null;
    list.forEach(function (s) {
      const d = typeof s.start_time === 'number' ? null : Util.parseDate(s.start_time);
      if (d && (base === null || d.getTime() < base)) base = d.getTime();
    });
    return list.map(function (s) {
      const sp = s.speaker || {};
      const name = sp.name ? String(sp.name).trim() || null : null;
      return {
        speaker: Granola.speakerOf_(sp),
        name: name,
        text: String(s.text).trim(),
        t: Granola.seconds_(s.start_time, base)
      };
    });
  },

  speakerOf_(sp) {
    const a = String(sp.attribution || '').toLowerCase();
    if (a === 'me') return 'me';
    if (a === 'them') return 'them';
    const name = sp.name ? String(sp.name).trim() : '';
    if (!name || /^speaker\s*\d*$/i.test(name)) return 'unknown';
    if (Config.isMyName(name)) return 'me';
    return 'them';
  },

  /** start_time -> whole seconds from the first segment (numbers are taken as seconds). */
  seconds_(v, base) {
    if (typeof v === 'number' && isFinite(v)) return Math.max(0, Math.round(v));
    if (v !== null && v !== undefined && /^\d+(\.\d+)?$/.test(String(v))) return Math.round(parseFloat(v));
    const d = Util.parseDate(v);
    if (!d || base === null) return null;
    return Math.max(0, Math.round((d.getTime() - base) / 1000));
  },

  /** attendees[] merged with calendar invitees, deduped by email (case-insensitive). */
  attendees_(raw) {
    const out = [];
    const byEmail = {};
    const add = function (a) {
      if (!a) return;
      const email = Granola.email_(a);
      const name = typeof a === 'object' ? (a.name || a.display_name || a.displayName || null) : null;
      if (email) {
        if (byEmail[email]) {
          if (!byEmail[email].name && name) byEmail[email].name = name;
          return;
        }
        byEmail[email] = { name: name, email: email };
        out.push(byEmail[email]);
      } else if (name) {
        if (out.some(function (x) { return !x.email && x.name === name; })) return;
        out.push({ name: name, email: null });
      }
    };
    (raw.attendees || []).forEach(add);
    ((raw.calendar_event && raw.calendar_event.invitees) || []).forEach(add);
    return out;
  },

  /** Email from a string ('a@b.c' or 'Name <a@b.c>') or an object {email}. Lowercased, or null. */
  email_(v) {
    if (!v) return null;
    const s = typeof v === 'object' ? v.email : v;
    return s ? Util.parseEmail(String(s)) : null;
  },

  iso_(v) {
    if (v === null || v === undefined || v === '') return null;
    const d = Util.parseDate(v);
    return d ? d.toISOString() : null;
  }
};
