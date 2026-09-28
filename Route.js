/**
 * Route — deterministic project routing + section catalogue helpers.
 *
 * Project routing order (docs/DESIGN.md "Meeting pipeline" step 5):
 *   1. The calendar the meeting sits on (routing.calendars)            -> high
 *   2. Attendee domains (excluding Alex, his assistants, generic mail)  -> med, or high if unanimous
 *   3. Nothing usable                                                   -> {project: null, confidence: 'low'}
 *      (the LLM's suggestion is then used, capped at low: see Route.finalize)
 *
 * Sections are never invented: every section name that leaves this module either exists in the
 * live Todoist catalogue for that project (Todoist.sectionCatalogue) or is null.
 */
const Route = {
  /** Routing keys that are real destinations for extracted items. */
  KEYS: ['GR', 'ISC', 'Me', 'SG'],

  /** Consumer mail providers: their domain says nothing about the project. */
  GENERIC_DOMAINS: [
    'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.co.uk', 'live.com', 'msn.com',
    'yahoo.com', 'yahoo.co.uk', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com',
    'pm.me', 'gmx.com', 'gmx.net', 'fastmail.com', 'hey.com', 'zoho.com', 'mail.com',
    'resource.calendar.google.com', 'group.calendar.google.com'
  ],

  RANK_: { low: 0, med: 1, high: 2 },

  /**
   * Route a meeting to a project.
   * @param {Object} meeting normalised Meeting (attendees, organizerEmail, calendarEventId)
   * @param {{calendarEmail?: string, eventTitle?: string, attendeeEmails?: string[]}|null} calendarHit
   * @return {{project: string|null, confidence: 'high'|'med'|'low', reason: string}}
   */
  project(meeting, calendarHit) {
    const routing = Config.routing();
    const m = meeting || {};

    // 1. Calendar beats everything.
    if (calendarHit && calendarHit.calendarEmail) {
      const key = Route.lookupCI_(routing.calendars, calendarHit.calendarEmail);
      if (key && Route.isKey(key)) {
        return { project: key, confidence: 'high', reason: 'calendar ' + String(calendarHit.calendarEmail).toLowerCase() };
      }
    }

    // 2. Attendee domains (meeting attendees + calendar attendees + organiser).
    const emails = Route.meetingEmails(m, calendarHit);
    const byDomain = Route.fromEmails(emails);
    const noEvent = !calendarHit && !m.calendarEventId;
    if (byDomain.project) {
      // No calendar event at all: attendee domains are a hint only (DESIGN: route by content, <= low).
      if (noEvent) return { project: byDomain.project, confidence: 'low', reason: 'no calendar event; ' + byDomain.reason };
      return byDomain;
    }
    if (noEvent) return { project: null, confidence: 'low', reason: 'no calendar event; route by content' };
    return byDomain;
  },

  /**
   * Route by a set of participant emails (domain majority).
   * Alex's own addresses, assistants and generic providers are ignored.
   * - every counted participant maps to one project -> high
   * - one project holds a strict majority of the mapped participants -> med
   * - otherwise -> {project: null, confidence: 'low'}
   * @param {string[]} emails
   * @return {{project: string|null, confidence: string, reason: string}}
   */
  fromEmails(emails) {
    const routing = Config.routing();
    const others = Route.otherEmails_(emails);
    if (!others.length) return { project: null, confidence: 'low', reason: 'no external attendees' };

    const votes = {};
    let mapped = 0;
    others.forEach(function (e) {
      const key = Route.domainKey_(Util.emailDomain(e), routing.domains);
      if (!key) return;
      votes[key] = (votes[key] || 0) + 1;
      mapped++;
    });
    if (!mapped) return { project: null, confidence: 'low', reason: 'attendee domains not mapped' };

    const ranked = Object.keys(votes).sort(function (a, b) { return votes[b] - votes[a]; });
    const top = ranked[0];
    const summary = ranked.map(function (k) { return k + ' ' + votes[k]; }).join(', ');
    if (votes[top] === others.length && ranked.length === 1) {
      return { project: top, confidence: 'high', reason: 'all attendee domains → ' + top + ' (' + summary + ')' };
    }
    if (votes[top] * 2 > mapped) {
      return { project: top, confidence: 'med', reason: 'attendee domain majority → ' + top + ' (' + summary + ')' };
    }
    return { project: null, confidence: 'low', reason: 'attendee domains split (' + summary + ')' };
  },

  /**
   * Route an email thread: the Alex address it was sent to (To/Cc) decides, e.g. alex@gr-oss.io -> GR.
   * Falls back to the other participants' domains.
   * @param {{to?: string|string[], cc?: string|string[], from?: string, messages?: Object[]}} thread
   * @return {{project: string|null, confidence: string, reason: string}}
   */
  email(thread) {
    const routing = Config.routing();
    const t = thread || {};
    const addrs = Route.addressList_([t.to, t.cc]);
    (t.messages || []).forEach(function (msg) {
      Route.addressList_([msg.to, msg.cc]).forEach(function (a) { addrs.push(a); });
    });
    const mine = {};
    addrs.forEach(function (a) {
      if (!Config.isMyEmail(a)) return;
      const key = Route.lookupCI_(routing.calendars, a);
      if (key && Route.isKey(key)) mine[key] = true;
    });
    const keys = Object.keys(mine);
    if (keys.length === 1) return { project: keys[0], confidence: 'med', reason: 'sent to ' + Route.myAddressFor_(keys[0], routing) };

    const everyone = addrs.slice();
    Route.addressList_([t.from]).forEach(function (a) { everyone.push(a); });
    (t.messages || []).forEach(function (msg) { Route.addressList_([msg.from]).forEach(function (a) { everyone.push(a); }); });
    const byDomain = Route.fromEmails(everyone);
    if (byDomain.project) {
      // Email domains are a weaker signal than a calendar: never above med.
      return { project: byDomain.project, confidence: 'med', reason: byDomain.reason };
    }
    return keys.length > 1
      ? { project: null, confidence: 'low', reason: 'sent to several of Alex\'s addresses' }
      : byDomain;
  },

  /**
   * Soft section hint ("GR/Arctos") from participant domains via routing.sectionHints, or null.
   * @param {string[]} emails
   */
  sectionHint(emails) {
    const hints = Config.routing().sectionHints || {};
    const counts = {};
    Route.otherEmails_(emails).forEach(function (e) {
      const h = Route.domainKey_(Util.emailDomain(e), hints);
      if (h) counts[h] = (counts[h] || 0) + 1;
    });
    const ranked = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; });
    return ranked.length ? ranked[0] : null;
  },

  /** Emails of the meeting's participants (attendees + organiser). */
  meetingEmails(meeting, calendarHit) {
    const out = [];
    ((meeting && meeting.attendees) || []).forEach(function (a) { if (a && a.email) out.push(a.email); });
    if (meeting && meeting.organizerEmail) out.push(meeting.organizerEmail);
    if (calendarHit && calendarHit.attendeeEmails) calendarHit.attendeeEmails.forEach(function (e) { out.push(e); });
    return out;
  },

  /** Section catalogue {GR: [...], ISC: [...], Me: [...], SG: [...]} (live from Todoist, neverUseSections removed). */
  sectionCatalogue(keys) {
    const cat = Todoist.sectionCatalogue(keys || Route.KEYS);
    const never = Route.neverUse_();
    const out = {};
    Object.keys(cat).forEach(function (k) {
      out[k] = (cat[k] || []).filter(function (n) { return n && !never[String(n).trim().toLowerCase()]; });
    });
    return out;
  },

  /** True if `key` is one of the routable project keys (GR, ISC, Me, SG). */
  isKey(key) {
    return Route.KEYS.indexOf(key) >= 0;
  },

  /** Canonical routing key for a loose value ('gr', 'Soul Graffiti' is not accepted), or null. */
  normalizeKey(key) {
    if (!key) return null;
    const k = String(key).trim().toLowerCase();
    const hit = Route.KEYS.find(function (x) { return x.toLowerCase() === k; });
    return hit || null;
  },

  /**
   * Canonical section name (catalogue spelling) if `section` exists in `project`'s catalogue, else null.
   * neverUseSections always -> null.
   * @param {string|null} project routing key
   * @param {string|null} section
   * @param {Object} [catalogue] {GR: [...]} (defaults to Route.sectionCatalogue())
   */
  section(project, section, catalogue) {
    if (!project || !section) return null;
    const want = String(section).trim().toLowerCase();
    if (!want || Route.neverUse_()[want]) return null;
    const cat = catalogue || Route.sectionCatalogue();
    const names = cat[project] || [];
    const hit = names.find(function (n) { return String(n).trim().toLowerCase() === want; });
    return hit || null;
  },

  /**
   * Combine the deterministic route with the LLM's per-item suggestion.
   * - route high/med: route project wins; if the LLM disagrees, route confidence drops one level.
   * - route low or without a project: the LLM's project (else the route's) is used, routeConfidence 'low'.
   * The section is kept only if it exists in the final project's catalogue.
   * @param {{project, confidence}} route
   * @param {{project?: string, section?: string}} item
   * @param {Object} [catalogue]
   * @return {{project: string|null, section: string|null, routeConfidence: string}}
   */
  finalize(route, item, catalogue) {
    const r = route || {};
    const suggested = Route.normalizeKey(item && item.project);
    let project = Route.normalizeKey(r.project);
    let conf = Route.RANK_[r.confidence] === undefined ? 'low' : r.confidence;
    if (project && conf !== 'low') {
      if (suggested && suggested !== project) conf = conf === 'high' ? 'med' : 'low';
    } else {
      // Weak or no deterministic route: the content (LLM) decides, capped at low.
      project = suggested || project;
      conf = 'low';
    }
    return {
      project: project,
      section: Route.section(project, item && item.section, catalogue),
      routeConfidence: project ? conf : 'low'
    };
  },

  /** Lower of two confidence levels. */
  minConfidence(a, b) {
    const ra = Route.RANK_[a] === undefined ? 0 : Route.RANK_[a];
    const rb = Route.RANK_[b] === undefined ? 0 : Route.RANK_[b];
    return ra <= rb ? (Route.RANK_[a] === undefined ? 'low' : a) : b;
  },

  // ---------------------------------------------------------------- private

  otherEmails_(emails) {
    const id = Config.identity();
    const skip = {};
    (id.myEmails || []).concat(id.assistants || []).forEach(function (e) { skip[String(e).toLowerCase()] = 1; });
    const generic = {};
    Route.GENERIC_DOMAINS.forEach(function (d) { generic[d] = 1; });
    return Util.uniq((emails || []).map(function (e) { return Util.parseEmail(e) || ''; })
      .filter(function (e) {
        if (!e || skip[e]) return false;
        const d = Util.emailDomain(e);
        return !!d && !generic[d];
      }));
  },

  /** routing.domains lookup, also matching parent domains (mail.gresearch.co.uk -> gresearch.co.uk). */
  domainKey_(domain, table) {
    if (!domain || !table) return null;
    let d = String(domain).toLowerCase();
    while (d) {
      const v = Route.lookupCI_(table, d);
      if (v) return v;
      const i = d.indexOf('.');
      if (i < 0) break;
      d = d.slice(i + 1);
      if (d.indexOf('.') < 0) break; // stop at the TLD
    }
    return null;
  },

  lookupCI_(table, key) {
    if (!table || !key) return null;
    const k = String(key).trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(table, k)) return table[k];
    const hit = Object.keys(table).find(function (x) { return x.toLowerCase() === k; });
    return hit ? table[hit] : null;
  },

  addressList_(vals) {
    const out = [];
    (vals || []).forEach(function (v) {
      if (!v) return;
      (Array.isArray(v) ? v : [v]).forEach(function (p) {
        const found = String(p || '').match(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [];
        found.forEach(function (e) { out.push(e.toLowerCase()); });
      });
    });
    return out;
  },

  myAddressFor_(key, routing) {
    return Object.keys(routing.calendars || {}).find(function (e) { return routing.calendars[e] === key; }) || key;
  },

  neverUse_() {
    const m = {};
    (Config.routing().neverUseSections || []).forEach(function (n) { m[String(n).trim().toLowerCase()] = 1; });
    return m;
  }
};
