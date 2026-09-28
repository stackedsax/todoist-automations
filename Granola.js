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
 * Note ownership: with the Personal notes scope the API also returns notes shared with Alex
 * (owned by someone else) -- https://docs.granola.ai/ ("Notes you own", "Notes directly shared
 * with you", "Notes in private folders shared with you"). Note/NoteSummary carry
 * `owner {name, email}` (https://docs.granola.ai/api-reference/get-note.md). In a note someone
 * else owns, attribution "me" / source "microphone" describe THE OWNER's mic, not Alex's.
 * Meetings therefore carry `ownerEmail` and `ownerIsMe` (extras beyond the DESIGN shape).
 * A note with no owner at all is treated as Alex's; see owner_().
 *
 * Transcript speaker mapping (first rule that applies):
 *   1. speaker.attribution: in Alex's note "me" -> "me", "them" -> "them". In someone else's
 *      note "me" -> "them" (the owner; name defaults to the owner's name) and "them" -> only
 *      decided by the name (it could be Alex), else "unknown".
 *   2. speaker.name (diarization_label and generic "Speaker 2" / "Speaker A" are ignored):
 *      identity.notMe (e.g. "Alex Blundell") -> "them"; identity.myNames -> "me"; a bare first
 *      name shared with Alex (e.g. just "Alex") -> "unknown"; any other real name -> "them".
 *   3. speaker.source, only in Alex's own note and only when the transcript is dual-stream
 *      (some segment has source "speaker", as on macOS): "microphone" -> "me",
 *      "speaker" -> "them". iOS transcripts are a single "microphone" stream with
 *      diarization labels, so the source says nothing there.
 *   4. otherwise "unknown".
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
    const owner = Granola.owner_(raw);
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
      transcript: Array.isArray(raw.transcript) ? Granola.mapTranscript(raw.transcript, owner) : null,
      alsoRecordedBy: [],
      // Extras (not in the DESIGN Meeting shape): updatedAt lets Meetings advance
      // granola.updatedAfter; ownerEmail/ownerIsMe let Meetings/Dedupe prefer Alex's own notes.
      updatedAt: Util.parseDate(raw.updated_at),
      ownerEmail: owner.email,
      ownerName: owner.name,
      ownerIsMe: owner.isMe
    };
  },

  /**
   * Note owner -> {name, email, isMe}. isMe: the owner email is in identity.myEmails; with no
   * owner email, the owner name is in identity.myNames (a bare "Alex" is NOT enough); a note
   * with no owner info at all is assumed to be Alex's (the API key is his).
   */
  owner_(raw) {
    const o = raw && raw.owner;
    const email = Granola.email_(o);
    const name = o && typeof o === 'object' && o.name ? String(o.name).trim() || null : null;
    let isMe;
    if (email) isMe = Config.isMyEmail(email);
    else if (name) isMe = Config.isMyName(name);
    else isMe = true;
    return { name: name, email: email, isMe: isMe };
  },

  /**
   * Raw transcript segments -> [{speaker: me|them|unknown, name, text, t}] (empty text dropped).
   * @param {Object[]} segments
   * @param {{isMe?: boolean, name?: string}} [owner] the note owner (default: Alex)
   */
  mapTranscript(segments, owner) {
    const own = { isMe: !owner || owner.isMe !== false, name: owner && owner.name ? owner.name : null };
    const list = (segments || []).filter(function (s) { return s && String(s.text || '').trim(); });
    const dualStream = list.some(function (s) {
      return s.speaker && String(s.speaker.source || '').toLowerCase() === 'speaker';
    });
    let base = null;
    list.forEach(function (s) {
      const d = typeof s.start_time === 'number' ? null : Util.parseDate(s.start_time);
      if (d && (base === null || d.getTime() < base)) base = d.getTime();
    });
    return list.map(function (s) {
      const sp = s.speaker || {};
      let name = sp.name ? String(sp.name).trim() || null : null;
      const speaker = Granola.speakerOf_(sp, own, dualStream);
      if (!name && !own.isMe && own.name && speaker === 'them' &&
        (String(sp.attribution || '').toLowerCase() === 'me' ||
          (!sp.attribution && String(sp.source || '').toLowerCase() === 'microphone' && dualStream))) {
        name = own.name;
      }
      return {
        speaker: speaker,
        name: name,
        text: String(s.text).trim(),
        t: Granola.seconds_(s.start_time, base)
      };
    });
  },

  /** See the header for the rules. `own` = {isMe, name}; dualStream = transcript has source "speaker". */
  speakerOf_(sp, own, dualStream) {
    const mine = !own || own.isMe !== false;
    const a = String(sp.attribution || '').toLowerCase();
    const src = String(sp.source || '').toLowerCase();
    if (mine && a === 'me') return 'me';
    if (mine && a === 'them') return 'them';
    if (!mine && a === 'me') return 'them'; // the owner's own mic
    if (!mine && !a && src === 'microphone' && dualStream) return 'them';
    const byName = Granola.speakerByName_(sp.name);
    if (byName) return byName;
    if (mine && !a && dualStream) {
      if (src === 'microphone') return 'me';
      if (src === 'speaker') return 'them';
    }
    return 'unknown';
  },

  /** me|them|unknown from a speaker name, or null when the name is missing or generic. */
  speakerByName_(raw) {
    const name = raw ? String(raw).trim() : '';
    if (!name || /^speaker(\s*[a-z0-9]+)?$/i.test(name)) return null;
    if (Config.isNotMe(name)) return 'them';
    if (Config.isMyName(name)) return 'me';
    return Granola.sharesMyFirstName_(name) ? 'unknown' : 'them';
  },

  /** True for a bare first name shared with Alex (e.g. "Alex"), which could be anyone called Alex. */
  sharesMyFirstName_(name) {
    const n = String(name || '').trim().toLowerCase();
    if (!n || /\s/.test(n)) return false;
    return Config.identity().myNames.some(function (m) {
      return String(m).trim().split(/\s+/)[0].toLowerCase() === n;
    });
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
