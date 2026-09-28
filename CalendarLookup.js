/**
 * CalendarLookup — find the calendar event (and which of Alex's calendars it is on) for a Meeting.
 *
 * Searches each calendar in routing.calendars (CalendarApp.getCalendarById) for events that
 * overlap meeting.start ± WINDOW_MIN minutes. Candidates are ranked:
 *   1. calendarEventId match (Granola calendar_event.calendar_event_id vs the event's iCalUID,
 *      tolerating the "@google.com" suffix and recurring-instance "_<timestamp>" suffixes);
 *   2. otherwise a score from title similarity, attendee overlap (people other than Alex) and
 *      start-time proximity. A candidate with no id match needs real evidence (title similarity
 *      >= 0.5, >= 1 shared other attendee, or similarity >= 0.25 within 5 min) so that ad-hoc
 *      notes such as "New note" do not attach to whatever happened to be on the calendar.
 * Ties (same event on several of Alex's calendars) prefer the calendar whose address is a guest
 * or creator of the event, then an accepted/owned event, then routing.calendars order.
 *
 * Apps Script reference: https://developers.google.com/apps-script/reference/calendar/calendar-event
 * (CalendarEvent.getId() returns the iCalUID).
 */
const CalendarLookup = {
  WINDOW_MIN: 15,
  CLOSE_MIN: 5,

  /**
   * @param {Object} meeting Meeting (needs start; uses title, attendees, calendarEventId)
   * @return {{calendarEmail: string, project: string, eventId: string, eventTitle: string,
   *           attendeeEmails: string[], start: Date, end: Date, myStatus: (string|null),
   *           matchedBy: ('id'|'similarity'), score: number}|null}
   */
  find(meeting) {
    if (!meeting || !meeting.start) return null;
    const start = Util.toDate(meeting.start);
    if (isNaN(start.getTime())) return null;
    const win = CalendarLookup.WINDOW_MIN * 60000;
    const from = new Date(start.getTime() - win);
    const to = new Date(start.getTime() + win);
    const calendars = Config.routing().calendars || {};
    const others = CalendarLookup.otherEmails_((meeting.attendees || []).map(function (a) { return a && a.email; }));
    const candidates = [];

    Object.keys(calendars).forEach(function (calEmail, calIndex) {
      let cal;
      try {
        cal = CalendarApp.getCalendarById(calEmail);
      } catch (e) {
        console.log('[CalendarLookup] cannot open calendar ' + calEmail + ': ' + (e && e.message));
        return;
      }
      if (!cal) return;
      let events;
      try {
        events = cal.getEvents(from, to) || [];
      } catch (e) {
        console.log('[CalendarLookup] getEvents failed for ' + calEmail + ': ' + (e && e.message));
        return;
      }
      events.forEach(function (ev) {
        const c = CalendarLookup.candidate_(ev, meeting, start, others, calEmail, calIndex);
        if (c) candidates.push(c);
      });
    });

    if (!candidates.length) return null;
    candidates.sort(function (a, b) {
      return (b.idMatch - a.idMatch) || (b.score - a.score) || (b.calendarAffinity - a.calendarAffinity) ||
        (b.statusRank - a.statusRank) || (a.calIndex - b.calIndex);
    });
    const best = candidates[0];
    return {
      calendarEmail: best.calendarEmail,
      project: calendars[best.calendarEmail] || null,
      eventId: best.eventId,
      eventTitle: best.eventTitle,
      attendeeEmails: best.attendeeEmails,
      start: best.start,
      end: best.end,
      myStatus: best.myStatus,
      matchedBy: best.idMatch ? 'id' : 'similarity',
      score: Math.round(best.score * 1000) / 1000
    };
  },

  candidate_(ev, meeting, start, others, calEmail, calIndex) {
    if (ev.isAllDayEvent && ev.isAllDayEvent()) return null;
    const evStart = ev.getStartTime();
    const diffMin = Math.abs(evStart.getTime() - start.getTime()) / 60000;
    if (diffMin > CalendarLookup.WINDOW_MIN) return null;
    const eventId = String(ev.getId() || '');
    const idMatch = CalendarLookup.idMatches(meeting.calendarEventId, eventId) ? 1 : 0;
    const eventTitle = ev.getTitle() || '';
    const guests = (ev.getGuestList ? ev.getGuestList() : []) || [];
    const attendeeEmails = Util.uniq(guests.map(function (g) {
      return String(g.getEmail() || '').trim().toLowerCase();
    }).filter(Boolean));
    const creators = ((ev.getCreators && ev.getCreators()) || []).map(function (e) { return String(e).toLowerCase(); });
    const evOthers = CalendarLookup.otherEmails_(attendeeEmails.concat(creators));
    const overlap = others.filter(function (e) { return evOthers.indexOf(e) >= 0; }).length;
    const titleSim = Math.max(Util.tokenJaccard(meeting.title || '', eventTitle), Util.containment(meeting.title || '', eventTitle));

    if (!idMatch) {
      const evidence = titleSim >= 0.5 || overlap >= 1 || (titleSim >= 0.25 && diffMin <= CalendarLookup.CLOSE_MIN);
      if (!evidence) return null;
    }
    const overlapFrac = others.length ? overlap / others.length : 0;
    const score = titleSim * 2 + overlapFrac + Math.min(overlap, 3) * 0.1 +
      (1 - diffMin / CalendarLookup.WINDOW_MIN) * 0.5;

    let myStatus = null;
    try { myStatus = ev.getMyStatus ? String(ev.getMyStatus()) : null; } catch (e) { myStatus = null; }
    const owned = ev.isOwnedByMe && ev.isOwnedByMe();
    const statusRank = owned || myStatus === 'OWNER' ? 3 : myStatus === 'YES' ? 2 :
      (myStatus === 'MAYBE' || myStatus === 'INVITED') ? 1 : 0;
    const cal = calEmail.toLowerCase();
    const calendarAffinity = attendeeEmails.indexOf(cal) >= 0 || creators.indexOf(cal) >= 0 ? 1 : 0;

    return {
      idMatch: idMatch, score: score, statusRank: statusRank, calendarAffinity: calendarAffinity,
      calIndex: calIndex, calendarEmail: calEmail, eventId: eventId, eventTitle: eventTitle,
      attendeeEmails: attendeeEmails, start: evStart, end: ev.getEndTime(), myStatus: myStatus
    };
  },

  /**
   * True if a Granola/Google event id and a CalendarEvent iCalUID refer to the same event.
   * Handles "abc@google.com" vs "abc" and recurring instances "abc_20260924T160000Z" vs "abc".
   */
  idMatches(a, b) {
    if (!a || !b) return false;
    const norm = function (s) { return String(s).trim().toLowerCase().replace(/@google\.com$/, ''); };
    const x = norm(a);
    const y = norm(b);
    if (!x || !y) return false;
    return x === y || x.indexOf(y + '_') === 0 || y.indexOf(x + '_') === 0;
  },

  /** Lowercased unique emails excluding Alex's own addresses and his assistants. */
  otherEmails_(emails) {
    const id = Config.identity();
    const skip = {};
    (id.myEmails || []).concat(id.assistants || []).forEach(function (e) { skip[String(e).toLowerCase()] = true; });
    return Util.uniq((emails || []).map(function (e) { return e ? String(e).trim().toLowerCase() : ''; })
      .filter(function (e) { return e && !skip[e]; }));
  }
};
