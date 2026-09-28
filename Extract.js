/**
 * Extract — LLM prompts that turn meetings, email threads and Slack messages into Alex's action
 * items, plus the "has this waiting item been resolved?" judgement. Every model output goes
 * through deterministic post-processing (Extract.postProcess) so the rules in docs/DESIGN.md
 * ("Extracted item") hold even when the model slips.
 *
 * Claude is called through Claude.json (forced `emit` tool use; see Claude.js for the Messages
 * API reference: https://docs.anthropic.com/en/api/messages).
 */
const Extract = {
  KINDS: ['todo', 'waiting'],
  CONFIDENCE: ['high', 'med', 'low'],
  /** Only "action" survives post-processing; the rest let the model say why something is not a task. */
  CATEGORIES: ['action', 'decision', 'fyi', 'opinion', 'deferred', 'group', 'others_work', 'done'],
  RANK_: { low: 0, med: 1, high: 2 },

  MAX_TITLE: 120,
  MAX_QUOTE: 300,
  MAX_WHY: 240,
  MAX_DISMISSALS: 20,
  TRANSCRIPT_CHARS: 90000,
  SUMMARY_CHARS: 30000,
  EMAIL_MESSAGE_CHARS: 3000,
  EMAIL_MAX_MESSAGES: 6,
  SLACK_MESSAGE_CHARS: 3000,
  EVIDENCE_CHARS: 2500,

  /** What each Todoist project is for. Override with ROUTING {"projectGuide": {...}}. */
  PROJECT_GUIDE: {
    GR: 'G-Research open source work (GR-OSS team, Armada, CNCF / CNCF Batch Subproject, KubeCon, Arctos, open source hiring and team logistics)',
    ISC: 'Insight Softmax Consulting (ISC): the consulting company Alex co-runs (clients, partners, AWS, HPC, quantum, marketing, company logistics)',
    Me: 'Personal life and household admin (home, cars, purchases, personal tech, family, personal finance)',
    SG: 'SG: the music studio business Alex co-operates (lease, landlord, studio access, members)'
  },

  /** Safety nets applied to title + quote after the model (deferred work, group asks). */
  DEFERRED_RE_: /\b(not the right time|not a priority (right )?now|park(ed|ing)? (this|it|that)|put (this|it|that) on hold|on the back ?burner|revisit (this |it |that )?(later|next (week|month|quarter|year)|in (a few|\d+) (weeks|months))|table (this|it|that) for now|let'?s not (do|pursue) (this|that|it) (yet|now))\b/i,
  GROUP_TITLE_RE_: /^(each|every|all)\s+(member|members|attendee|attendees|participant|participants|person|one)\b|^(everyone|everybody|the team|team members|all members|the group)\b/i,

  // ---------------------------------------------------------------- schemas

  /** JSON schema (tool input) for item lists. `withRef` adds the source reference field. */
  itemsSchema(withRef, withTimestamp) {
    const props = {
      title: { type: 'string', description: 'Imperative, starts with a verb, <= 120 chars, specific; no "Alex will", no trailing period.' },
      kind: { type: 'string', enum: Extract.KINDS, description: 'todo = Alex owns it; waiting = a specific person owes it to Alex or Alex is blocked on it.' },
      owner: { type: 'string', enum: ['me', 'other'], description: 'me for todo; other for waiting.' },
      ownerName: { type: ['string', 'null'], description: 'waiting: full name of the person who owes it. todo: null.' },
      ownerEmail: { type: ['string', 'null'], description: 'waiting: that person\'s email if known, else null.' },
      category: { type: 'string', enum: Extract.CATEGORIES, description: 'action = a real task for Alex (or owed to Alex). Anything else is discarded.' },
      quote: { type: 'string', description: 'Short verbatim supporting quote from the source, <= 300 chars.' },
      why: { type: 'string', description: 'One sentence for the triage UI: who asked or committed and why it is Alex\'s.' },
      due: { type: ['string', 'null'], description: 'YYYY-MM-DD only if stated or clearly implied; else null.' },
      resurface: { type: ['string', 'null'], description: 'waiting only: the deadline the other person gave (YYYY-MM-DD), else null.' },
      confidence: { type: 'string', enum: Extract.CONFIDENCE, description: 'That this is a real, actionable item for Alex.' },
      project: { type: ['string', 'null'], enum: ['GR', 'ISC', 'Me', 'SG', null] },
      section: { type: ['string', 'null'], description: 'Exactly one of the listed sections of the chosen project, or null.' }
    };
    const required = ['title', 'kind', 'owner', 'ownerName', 'category', 'quote', 'why', 'due', 'confidence', 'project', 'section'];
    if (withTimestamp) {
      props.timestampSec = { type: ['number', 'null'], description: 'Seconds into the recording where the quote is (from the [mm:ss] marks), else null.' };
    }
    if (withRef) {
      props.ref = { type: 'string', description: 'The [ref] of the thread/message this item comes from, e.g. T2 or M5.' };
      required.unshift('ref');
    }
    return {
      type: 'object',
      properties: {
        items: { type: 'array', items: { type: 'object', properties: props, required: required } }
      },
      required: ['items']
    };
  },

  RESOLUTION_SCHEMA: {
    type: 'object',
    properties: {
      resolved: { type: 'boolean', description: 'True only if the evidence shows the thing was actually delivered/done.' },
      confidence: { type: 'string', enum: ['high', 'med', 'low'] },
      reason: { type: 'string', description: 'One sentence, citing the evidence.' },
      evidenceRef: { type: ['string', 'null'], description: 'The [E#] ref that best proves it, or null.' }
    },
    required: ['resolved', 'confidence', 'reason', 'evidenceRef']
  },

  // ---------------------------------------------------------------- public API

  /**
   * Extract Alex's items from a normalised Meeting.
   * @param {Object} meeting Meeting (docs/DESIGN.md)
   * @param {{routeHint?: {project, confidence, reason}, sectionHint?: string, sectionsByProject?: Object,
   *          feedback?: Object[], today?: string}} [opts]
   * @return {Object[]} Extracted items
   */
  meeting(meeting, opts) {
    const o = opts || {};
    const catalogue = o.sectionsByProject || Route.sectionCatalogue();
    const system = Extract.systemPrompt('meeting', { feedback: Extract.dismissals_(o.feedback) });
    const user = Extract.meetingPrompt_(meeting, catalogue, o);
    const out = Claude.json({
      system: system, user: user, schema: Extract.itemsSchema(false, true), maxTokens: 4096, temperature: 0,
      description: 'Return Alex Scammon\'s action items from this meeting (possibly none).'
    });
    return Extract.postProcess(out, { source: 'meeting', catalogue: catalogue, today: o.today });
  },

  /**
   * Extract items from a batch of email threads (~8). Each item gets .ref = the thread id.
   * @param {Object[]} threads [{threadId|id, subject, messages: [{from, to, cc, date, plain|text|body}], routeHint?}]
   *   (GmailThread objects are accepted too.)
   * @param {{sectionsByProject?, feedback?, today?}} [opts]
   */
  email(threads, opts) {
    const o = opts || {};
    const list = (threads || []).map(Extract.normalizeThread_).filter(Boolean);
    if (!list.length) return [];
    const catalogue = o.sectionsByProject || Route.sectionCatalogue();
    const refs = {};
    list.forEach(function (t, i) { refs['T' + (i + 1)] = t; });
    const out = Claude.json({
      system: Extract.systemPrompt('email', { feedback: Extract.dismissals_(o.feedback) }),
      user: Extract.emailPrompt_(refs, catalogue, o),
      schema: Extract.itemsSchema(true, false), maxTokens: 4096, temperature: 0,
      description: 'Return Alex Scammon\'s action items from these email threads (possibly none).'
    });
    const refMap = {};
    Object.keys(refs).forEach(function (r) { refMap[r] = refs[r].threadId; });
    return Extract.postProcess(out, { source: 'email', catalogue: catalogue, today: o.today, refs: refMap });
  },

  /**
   * Extract items from Slack mentions / DMs. Each item gets .ref = the message key.
   * @param {Object[]} msgs [{key, workspace, channel, channelName?, ts, user?, userName?, text, permalink?,
   *                          isDm?, isMine?, context?: [{userName, text}]}]
   * @param {{me?: {userId, name}, users?: Object, project?: string, sectionsByProject?, feedback?, today?}} [opts]
   */
  slack(msgs, opts) {
    const o = opts || {};
    const list = (msgs || []).filter(function (m) { return m && m.text; });
    if (!list.length) return [];
    const catalogue = o.sectionsByProject || Route.sectionCatalogue();
    const refs = {};
    list.forEach(function (m, i) { refs['M' + (i + 1)] = m; });
    const out = Claude.json({
      system: Extract.systemPrompt('slack', { feedback: Extract.dismissals_(o.feedback) }),
      user: Extract.slackPrompt_(refs, catalogue, o),
      schema: Extract.itemsSchema(true, false), maxTokens: 4096, temperature: 0,
      description: 'Return Alex Scammon\'s action items from these Slack messages (possibly none).'
    });
    const refMap = {};
    Object.keys(refs).forEach(function (r) { refMap[r] = refs[r].key || r; });
    const items = Extract.postProcess(out, { source: 'slack', catalogue: catalogue, today: o.today, refs: refMap });
    items.forEach(function (it) {
      const m = list.find(function (x) { return (x.key || '') === it.ref; });
      if (m && m.permalink) it.permalink = m.permalink;
    });
    return items;
  },

  /**
   * Has a waiting item been delivered? Never auto-resolves without evidence.
   * @param {{title, ownerName?, ownerEmail?, createdAt?, quote?}} item
   * @param {Object[]} evidence [{source, date?, from?, title?, text, link?}]
   * @param {{today?: string}} [opts]
   * @return {{resolved: boolean, confidence: string, reason: string, evidenceLink: string|null}}
   */
  resolution(item, evidence, opts) {
    const o = opts || {};
    const ev = (evidence || []).filter(function (e) { return e && (e.text || e.title); });
    if (!ev.length) return { resolved: false, confidence: 'low', reason: 'No evidence found since the item was created.', evidenceLink: null };
    const refs = {};
    ev.forEach(function (e, i) { refs['E' + (i + 1)] = e; });
    const raw = Claude.json({
      system: Extract.resolutionSystem_(),
      user: Extract.resolutionPrompt_(item || {}, refs, o),
      schema: Extract.RESOLUTION_SCHEMA, maxTokens: 1024, temperature: 0,
      description: 'Judge whether the waiting item has been resolved.'
    }) || {};
    const conf = Extract.CONFIDENCE.indexOf(raw.confidence) >= 0 ? raw.confidence : 'low';
    const hit = raw.evidenceRef && refs[String(raw.evidenceRef).replace(/[[\]\s]/g, '')];
    const resolved = raw.resolved === true;
    let confidence = conf;
    // Auto-close needs a pointer to the proof: without a valid evidence ref, never high.
    if (resolved && !hit && confidence === 'high') confidence = 'med';
    return {
      resolved: resolved,
      confidence: confidence,
      reason: Util.truncate(Extract.clean_(raw.reason) || (resolved ? 'Evidence suggests it was done.' : 'No clear evidence it was done.'), Extract.MAX_WHY),
      evidenceLink: hit ? (hit.link || null) : null
    };
  },

  // ---------------------------------------------------------------- prompts

  /**
   * System prompt for 'meeting' | 'email' | 'slack'. Carries identity, the extraction rules,
   * project guide and negative examples.
   * @param {string} source
   * @param {{feedback?: Object[]}} [opts] feedback = dismissal rows (already filtered)
   */
  systemPrompt(source, opts) {
    const id = Config.identity();
    const guide = Extract.projectGuide_();
    const noun = { meeting: 'meeting notes and transcripts', email: 'email threads', slack: 'Slack messages' }[source] || 'messages';
    const L = [];
    L.push('You extract personal action items for Alex Scammon from ' + noun + '. Your output feeds his Todoist.');
    L.push('Precision matters more than recall: a task wrongly attributed to Alex is worse than a missed one. Zero items is a normal answer.');
    L.push('');
    L.push('WHO IS ALEX');
    L.push('- Alex Scammon. His names: ' + id.myNames.join(', ') + '.');
    L.push('- His email addresses: ' + id.myEmails.join(', ') + '.');
    if (id.notMe && id.notMe.length) {
      L.push('- NOT ALEX: ' + id.notMe.join(', ') + ' ' + (id.notMe.length > 1 ? 'are different people' : 'is a different person') +
        ' (a colleague in many of the same meetings). Anything said by, assigned to, or volunteered by ' + id.notMe.join(' or ') +
        ' is NEVER Alex Scammon\'s task. Do not create todos for them.');
    }
    L.push('- A bare "Alex" is ambiguous. Treat it as Alex Scammon only when the context makes that certain; otherwise skip the item or mark it low confidence.');
    if (id.assistants && id.assistants.length) {
      L.push('- Assistants: ' + id.assistants.join(', ') + ' (Morasha; transcripts may spell it Marasha or Mirasha) books meetings and handles admin for Alex. ' +
        'She is not Alex. Scheduling she will handle is not Alex\'s task; something she asks Alex to do is.');
    }
    L.push('');
    L.push('WHAT TO EMIT');
    L.push('- kind "todo", owner "me": something Alex himself committed to ("I\'ll send…"), was asked to do and accepted, or clearly must do next. ownerName null.');
    L.push('- kind "waiting", owner "other": a specific named person committed to deliver something TO Alex, or Alex\'s own work is blocked until they do. ' +
      'Put that person in ownerName (and ownerEmail if known). Other people\'s work that Alex does not need back is NOT waiting: drop it.');
    L.push('');
    L.push('WHAT TO DROP (do not emit; if you do, set category to the reason and it will be discarded)');
    L.push('- decision: things agreed or decided ("we\'ll go with X"), unless Alex personally has a concrete follow-up to execute it.');
    L.push('- fyi / opinion: status updates, background, ideas floated, "it would be nice if", general advice.');
    L.push('- deferred: explicitly postponed or rejected ("not the right time", "let\'s park that", "revisit next quarter", "not now").');
    L.push('- group: asks to a group ("each member should…", "everyone please…", "the team will…") unless Alex personally has a named part; then emit only Alex\'s part.');
    L.push('- others_work: tasks owned by anyone other than Alex that nobody owes back to Alex.');
    L.push('- done: already completed within the source itself.');
    L.push('');
    L.push('FIELDS');
    L.push('- title: imperative, starts with a verb, <= 120 characters, specific (what + with whom), e.g. "Send the Last Mile HPC deck to Jon Stumpf". No "Alex will", no trailing period.');
    L.push('- quote: a short verbatim quote (<= 300 chars) that supports the item. why: one sentence on who asked/committed and why it is Alex\'s.');
    L.push('- due: YYYY-MM-DD only when a date is stated or clearly implied (resolve "by Friday" against the source date). Otherwise null. Never invent deadlines.');
    L.push('- resurface: waiting items only, the date the other person promised it; else null.');
    L.push('- confidence: high = explicit commitment by or assignment to Alex with a clear deliverable; med = likely but implicit; low = plausible but uncertain.');
    L.push('- project: one of GR, ISC, Me, SG, or null when unclear. Use the route hint when it fits the content.');
    Object.keys(guide).forEach(function (k) { L.push('    ' + k + ': ' + guide[k]); });
    L.push('- section: copy EXACTLY one section name listed in the catalogue for the chosen project, or null. Never invent or rephrase a section.');
    L.push('- One item per real task: merge repeats of the same task.');

    if (source === 'meeting') {
      L.push('');
      L.push('MEETING RULES');
      L.push('- Transcript lines labelled ALEX are Alex Scammon (the Granola microphone channel is always the note owner, Alex). Lines labelled OTHER are other people, never Alex, whatever the name.');
      L.push('- The AI-generated summary can misattribute ownership (it may say "Alex" meaning Alex Blundell). When a transcript is present, verify ownership there.');
      L.push('- Fireflies action items are grouped by speaker names that are UNRELIABLE: treat them as hints only and never as proof that an item is Alex Scammon\'s.');
      L.push('- timestampSec: seconds from the [mm:ss] mark of the supporting transcript line, else null.');
    } else if (source === 'email') {
      L.push('');
      L.push('EMAIL RULES');
      L.push('- Messages from Alex\'s addresses are written by Alex: commitments he makes there ("I\'ll send it Monday") are todos.');
      L.push('- Judge the latest state of each thread: drop anything answered or resolved later in the thread.');
      L.push('- A reply is a todo only when someone asks Alex a direct question or request that he has not answered yet. Title it with the substance ("Reply to Priya with the Q4 budget numbers"), not just "Reply".');
      L.push('- Newsletters, notifications, marketing, receipts and automated mail: no items.');
      L.push('- ref: the [T#] of the thread each item comes from.');
    } else if (source === 'slack') {
      L.push('');
      L.push('SLACK RULES');
      L.push('- "@Alex Scammon" marks a mention of Alex. Messages marked (from Alex) are written by Alex; his own commitments there are todos.');
      L.push('- Casual chatter, emoji-only replies, thanks and social messages: no items.');
      L.push('- ref: the [M#] of the message each item comes from.');
    }

    const fb = (opts && opts.feedback) || [];
    if (fb.length) {
      L.push('');
      L.push('PREVIOUSLY DISMISSED (negative examples): Alex rejected these suggestions as not real todos for him. Do not suggest them again or anything of the same kind:');
      fb.forEach(function (f) {
        const d = f.detail && typeof f.detail === 'object' ? f.detail : {};
        const reason = d.reason ? ' (reason: ' + Util.truncate(Extract.clean_(d.reason), 120) + ')' : '';
        const src = f.sourceKey ? ' [' + String(f.sourceKey).split(':')[0] + ']' : '';
        L.push('- "' + Util.truncate(Extract.clean_(f.title), 140) + '"' + src + reason);
      });
    }
    return L.join('\n');
  },

  // ---------------------------------------------------------------- post-processing

  /**
   * Deterministic clean-up of the model output. Enforces:
   * - drop empty titles and non-"action" categories; drop deferred/group items (regex safety net)
   * - todo items owned by someone else, or by a notMe person, are dropped
   * - waiting items "owed by" Alex himself become todos
   * - clamp title/quote/why; validate enums and ISO dates; resurface only for waiting
   * - section must exist in catalogue[project] (and not in neverUseSections), else null
   * - near-identical titles within one source (per ref for email/slack) are merged, keeping the higher confidence
   * - refs (email/slack) must be ones we sent; mapped back to the real id in .ref
   * @param {{items?: Object[]}} raw Claude output
   * @param {{source: string, catalogue: Object, refs?: Object, today?: string}} ctx
   * @return {Object[]}
   */
  postProcess(raw, ctx) {
    const c = ctx || {};
    const catalogue = c.catalogue || {};
    const items = (raw && Array.isArray(raw.items)) ? raw.items : [];
    const out = [];
    items.forEach(function (r) {
      const it = Extract.normalizeItem_(r, c, catalogue);
      if (!it) return;
      const same = out.findIndex(function (k) {
        if ((k.ref || null) !== (it.ref || null)) return false;
        return Util.normalizeTitle(k.title) === Util.normalizeTitle(it.title) || Util.tokenJaccard(k.title, it.title) >= 0.8;
      });
      if (same < 0) out.push(it);
      else if (Extract.RANK_[it.confidence] > Extract.RANK_[out[same].confidence]) out[same] = it;
    });
    return out;
  },

  normalizeItem_(r, c, catalogue) {
    if (!r || typeof r !== 'object') return null;
    let title = Extract.clean_(r.title).replace(/^[-*•\d.)\s]+/, '').replace(/[.;:,\s]+$/, '');
    title = title.replace(/^(alex( scammon)?|i)\s+(will|to|should|needs to|must)\s+/i, '');
    if (!title) return null;
    title = title.charAt(0).toUpperCase() + title.slice(1);
    title = Util.truncate(title, Extract.MAX_TITLE);

    const category = r.category ? String(r.category).toLowerCase() : 'action';
    if (category !== 'action') return null;

    const quote = Util.truncate(Extract.clean_(r.quote), Extract.MAX_QUOTE);
    if (Extract.DEFERRED_RE_.test(title) || Extract.DEFERRED_RE_.test(quote)) return null;
    if (Extract.GROUP_TITLE_RE_.test(title)) return null;

    let kind = Extract.KINDS.indexOf(r.kind) >= 0 ? r.kind : null;
    if (!kind) kind = r.owner === 'other' ? 'waiting' : 'todo';
    let ownerName = Extract.clean_(r.ownerName) || null;
    let ownerEmail = Util.parseEmail(r.ownerEmail) || null;
    let owner = r.owner === 'other' ? 'other' : 'me';

    // Anything pinned on a notMe person (e.g. Alex Blundell) is never Alex's todo.
    const notMeInTitle = (Config.identity().notMe || []).some(function (n) {
      return n && Util.normalizeTitle(title).indexOf(Util.normalizeTitle(n)) === 0;
    });
    if (kind === 'waiting' && (Config.isMyName(ownerName) || Config.isMyEmail(ownerEmail))) {
      kind = 'todo';
    }
    if (kind === 'todo') {
      if (owner === 'other' && !Config.isMyName(ownerName) && !Config.isMyEmail(ownerEmail)) return null;
      if (Config.isNotMe(ownerName) || notMeInTitle) return null;
      owner = 'me';
      ownerName = null;
      ownerEmail = null;
    } else {
      owner = 'other';
      if (Config.isMyEmail(ownerEmail)) ownerEmail = null;
    }

    let confidence = Extract.CONFIDENCE.indexOf(r.confidence) >= 0 ? r.confidence : 'low';
    if (kind === 'waiting' && !ownerName && !ownerEmail) confidence = 'low';

    const project = Route.normalizeKey(r.project);
    const section = project ? Route.section(project, r.section, catalogue) : null;

    const item = {
      title: title,
      kind: kind,
      owner: owner,
      ownerName: ownerName,
      ownerEmail: ownerEmail,
      quote: quote,
      why: Util.truncate(Extract.clean_(r.why), Extract.MAX_WHY),
      due: Extract.isoOrNull_(r.due),
      resurface: kind === 'waiting' ? Extract.isoOrNull_(r.resurface) : null,
      confidence: confidence,
      project: project,
      section: section,
      timestampSec: null
    };
    if (c.source === 'meeting') {
      const t = Number(r.timestampSec);
      item.timestampSec = r.timestampSec !== null && r.timestampSec !== undefined && isFinite(t) && t >= 0 ? Math.round(t) : null;
    }
    if (c.refs) {
      const ref = String(r.ref || '').replace(/[[\]\s]/g, '');
      if (!Object.prototype.hasOwnProperty.call(c.refs, ref)) return null;
      item.ref = c.refs[ref];
    }
    return item;
  },

  // ---------------------------------------------------------------- prompt bodies (private)

  meetingPrompt_(m, catalogue, o) {
    const L = [];
    const srcName = m.source === 'fireflies' ? 'Fireflies' : 'Granola';
    L.push('MEETING');
    L.push('Title: ' + Extract.clean_(m.title || '(untitled)'));
    const start = Util.parseDate(m.start);
    if (start) L.push('Date: ' + Util.formatDate(start, 'EEE d MMM yyyy HH:mm') + ' (' + Util.isoDate(start) + ')');
    L.push('Today: ' + (o.today || Util.today()));
    L.push('Source: ' + srcName + (m.source === 'fireflies' ? ' (recorder bot; speaker names come from Fireflies)' : ' (Alex\'s own note; microphone = Alex)') +
      ((m.alsoRecordedBy || []).length ? '; also recorded by ' + m.alsoRecordedBy.map(function (a) { return a.source; }).join(', ') : ''));
    const att = (m.attendees || []).slice(0, 40);
    if (att.length) {
      L.push('Participants:');
      att.forEach(function (a) { L.push('- ' + Extract.personLabel_(a.name, a.email)); });
    }
    if (m.organizerEmail) L.push('Organiser: ' + Extract.personLabel_(null, m.organizerEmail));
    L.push(Extract.routeLine_(o.routeHint, o.sectionHint));
    L.push('');
    L.push(Extract.catalogueBlock_(catalogue));
    if (m.summaryMarkdown) {
      L.push('');
      L.push('AI SUMMARY (' + srcName + '; may misattribute ownership)');
      L.push(Util.truncate(String(m.summaryMarkdown), Extract.SUMMARY_CHARS));
    }
    if (m.actionItemsText) {
      L.push('');
      L.push('FIREFLIES ACTION ITEMS (grouped by speaker name: UNRELIABLE for ownership, hints only)');
      L.push(Util.truncate(String(m.actionItemsText), 10000));
    }
    L.push('');
    if (m.transcript && m.transcript.length) {
      L.push('TRANSCRIPT (ALEX = Alex Scammon; OTHER = someone else)');
      L.push(Extract.transcriptText_(m.transcript, m.transcriptFrom || m.source));
    } else {
      L.push('TRANSCRIPT: not available. Be conservative about ownership: use high confidence only when the summary names Alex Scammon unambiguously.');
    }
    return L.join('\n');
  },

  emailPrompt_(refs, catalogue, o) {
    const L = ['Today: ' + (o.today || Util.today()), '', Extract.catalogueBlock_(catalogue), ''];
    Object.keys(refs).forEach(function (ref) {
      const t = refs[ref];
      L.push('=== [' + ref + '] THREAD: ' + Extract.clean_(t.subject || '(no subject)'));
      if (t.routeHint) L.push(Extract.routeLine_(t.routeHint, null));
      const msgs = t.messages;
      const shown = msgs.slice(-Extract.EMAIL_MAX_MESSAGES);
      if (msgs.length > shown.length) L.push('[' + (msgs.length - shown.length) + ' earlier messages omitted]');
      shown.forEach(function (msg) {
        const fromMe = Config.isMyEmail(Util.parseEmail(msg.from));
        L.push('--- From: ' + Extract.clean_(msg.from) + (fromMe ? ' (from Alex)' : '') +
          (msg.date ? ' · ' + Extract.dateText_(msg.date) : ''));
        if (msg.to) L.push('To: ' + Extract.clean_(msg.to));
        if (msg.cc) L.push('Cc: ' + Extract.clean_(msg.cc));
        L.push(Util.truncate(Extract.stripQuoted_(msg.text), Extract.EMAIL_MESSAGE_CHARS));
      });
      L.push('');
    });
    return L.join('\n');
  },

  slackPrompt_(refs, catalogue, o) {
    const L = ['Today: ' + (o.today || Util.today())];
    if (o.project) L.push('Workspace default project: ' + o.project);
    L.push('', Extract.catalogueBlock_(catalogue), '');
    Object.keys(refs).forEach(function (ref) {
      const m = refs[ref];
      const when = m.ts ? Extract.dateText_(new Date(Number(m.ts) * 1000)) : '';
      const where = m.isDm ? 'DM' : ('#' + (m.channelName || m.channel || '?'));
      const who = m.isMine ? 'Alex Scammon (from Alex)' : Extract.clean_(m.userName || m.user || 'someone');
      L.push('=== [' + ref + '] ' + (m.workspace ? m.workspace + ' · ' : '') + where + (when ? ' · ' + when : ''));
      (m.context || []).slice(-5).forEach(function (cx) {
        L.push('  (context) ' + Extract.clean_(cx.userName || 'someone') + ': ' + Util.truncate(Extract.slackText_(cx.text, o), 600));
      });
      L.push(who + ': ' + Util.truncate(Extract.slackText_(m.text, o), Extract.SLACK_MESSAGE_CHARS));
      L.push('');
    });
    return L.join('\n');
  },

  resolutionSystem_() {
    const id = Config.identity();
    return [
      'You decide whether something another person owed Alex Scammon (' + id.myEmails.join(', ') + ') has been delivered or done.',
      'Resolved = the evidence shows completion: the thing was sent or shared ("here is the deck", an attachment, a link to the finished work), ' +
        'the person confirms it is done, or Alex acknowledges receiving it.',
      'NOT resolved: promises to do it later, partial progress, questions about it, or merely mentioning the topic.',
      'confidence high only with explicit, direct evidence from the owing person (or Alex acknowledging receipt); med when likely; low otherwise.',
      id.notMe && id.notMe.length ? 'Note: ' + id.notMe.join(', ') + ' is not Alex Scammon.' : '',
      'evidenceRef: the [E#] that best proves your answer, or null.'
    ].filter(Boolean).join('\n');
  },

  resolutionPrompt_(item, refs, o) {
    const L = [];
    L.push('Today: ' + (o.today || Util.today()));
    L.push('WAITING ITEM: ' + Extract.clean_(item.title));
    if (item.ownerName || item.ownerEmail) L.push('Owed by: ' + Extract.personLabel_(item.ownerName, item.ownerEmail));
    if (item.createdAt) L.push('Waiting since: ' + Extract.dateText_(item.createdAt));
    if (item.quote) L.push('Original context: "' + Util.truncate(Extract.clean_(item.quote), 300) + '"');
    L.push('');
    L.push('EVIDENCE SINCE THEN');
    Object.keys(refs).forEach(function (ref) {
      const e = refs[ref];
      L.push('=== [' + ref + '] ' + (e.source || 'source') + (e.date ? ' · ' + Extract.dateText_(e.date) : '') +
        (e.from ? ' · from ' + Extract.clean_(e.from) : '') + (e.title ? ' · ' + Extract.clean_(e.title) : ''));
      L.push(Util.truncate(Extract.stripQuoted_(e.text || ''), Extract.EVIDENCE_CHARS));
    });
    return L.join('\n');
  },

  // ---------------------------------------------------------------- helpers (private)

  dismissals_(feedback) {
    let rows = feedback;
    if (rows === undefined) {
      try {
        rows = Store.feedbackRecent(Extract.MAX_DISMISSALS, 'dismissed');
      } catch (e) {
        console.log('Extract: could not read feedback: ' + e.message);
        rows = [];
      }
    }
    return (rows || []).filter(function (f) { return f && f.type === 'dismissed' && f.title; }).slice(0, Extract.MAX_DISMISSALS);
  },

  projectGuide_() {
    const over = Config.routing().projectGuide;
    return Object.assign({}, Extract.PROJECT_GUIDE, over && typeof over === 'object' ? over : {});
  },

  catalogueBlock_(catalogue) {
    const L = ['SECTION CATALOGUE (project: allowed sections; use exactly these names or null)'];
    Route.KEYS.forEach(function (k) {
      const s = (catalogue && catalogue[k]) || [];
      L.push(k + ': ' + (s.length ? s.join(' | ') : '(no sections: use null)'));
    });
    return L.join('\n');
  },

  routeLine_(route, sectionHint) {
    let s = 'Route hint: ';
    if (route && route.project) s += 'project ' + route.project + ' (' + route.confidence + (route.reason ? ': ' + route.reason : '') + ')';
    else s += 'none: decide the project from the content' + (route && route.reason ? ' (' + route.reason + ')' : '');
    if (sectionHint) s += '. Section hint: ' + sectionHint;
    return s;
  },

  personLabel_(name, email) {
    const id = Config.identity();
    const e = Util.parseEmail(email);
    const base = (name ? Extract.clean_(name) : '') + (e ? (name ? ' <' + e + '>' : e) : '');
    if (Config.isNotMe(name)) return base + ' [NOT ALEX: different person]';
    if (Config.isMyEmail(e) || Config.isMyName(name)) return base + ' [ALEX]';
    if (e && (id.assistants || []).some(function (a) { return a.toLowerCase() === e; })) return base + ' [Alex\'s assistant]';
    return base || '(unknown)';
  },

  /** Transcript lines labelled ALEX / OTHER, middle elided when over budget. */
  transcriptText_(transcript, source) {
    const lines = transcript.map(function (seg) { return Extract.segmentLine_(seg, source); }).filter(Boolean);
    const total = lines.reduce(function (n, l) { return n + l.length + 1; }, 0);
    if (total <= Extract.TRANSCRIPT_CHARS) return lines.join('\n');
    // Keep the opening and (larger) closing parts: commitments cluster at the end of meetings.
    const headBudget = Math.floor(Extract.TRANSCRIPT_CHARS * 0.4);
    const tailBudget = Extract.TRANSCRIPT_CHARS - headBudget;
    const head = [];
    let used = 0;
    let i = 0;
    for (; i < lines.length && used + lines[i].length + 1 <= headBudget; i++) { head.push(lines[i]); used += lines[i].length + 1; }
    const tail = [];
    used = 0;
    let j = lines.length - 1;
    for (; j >= i && used + lines[j].length + 1 <= tailBudget; j--) { tail.unshift(lines[j]); used += lines[j].length + 1; }
    return head.concat(['[… ' + (j - i + 1) + ' transcript lines omitted …]'], tail).join('\n');
  },

  segmentLine_(seg, source) {
    if (!seg || !seg.text) return '';
    const text = Extract.clean_(seg.text);
    if (!text) return '';
    const t = typeof seg.t === 'number' && isFinite(seg.t) ? '[' + Extract.mmss_(seg.t) + '] ' : '';
    return t + Extract.speakerLabel_(seg, source) + ': ' + text;
  },

  /**
   * Speaker label. Granola 'me' (microphone) = ALEX; Granola 'them' = OTHER.
   * Named speakers (Fireflies): ALEX only if the name is one of myNames; notMe is flagged loudly;
   * a bare first name "Alex" is flagged as ambiguous.
   */
  speakerLabel_(seg, source) {
    const name = seg.name ? Extract.clean_(seg.name) : '';
    if (seg.speaker === 'me') return 'ALEX';
    if (Config.isNotMe(name)) return 'OTHER (' + name + ', NOT Alex Scammon)';
    if (seg.speaker !== 'them' && Config.isMyName(name)) return 'ALEX';
    if (name && /^alex(ander)?$/i.test(name)) return 'OTHER? (' + name + ': ambiguous, may be ' + (Config.identity().notMe[0] || 'someone else') + ')';
    return 'OTHER' + (name && !Config.isMyName(name) ? ' (' + name + ')' : '');
  },

  mmss_(sec) {
    const s = Math.max(0, Math.floor(sec));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    const pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return (h ? h + ':' + pad(m) : pad(m)) + ':' + pad(r);
  },

  normalizeThread_(t) {
    if (!t) return null;
    if (typeof t.getMessages === 'function') {
      return {
        threadId: String(t.getId()),
        subject: t.getFirstMessageSubject ? t.getFirstMessageSubject() : '',
        messages: t.getMessages().map(function (msg) {
          return {
            from: msg.getFrom(), to: msg.getTo ? msg.getTo() : '', cc: msg.getCc ? msg.getCc() : '',
            date: msg.getDate ? msg.getDate() : null, text: msg.getPlainBody ? msg.getPlainBody() : ''
          };
        })
      };
    }
    const id = t.threadId || t.id;
    if (!id) return null;
    const msgs = (t.messages || []).map(function (msg) {
      return {
        from: msg.from || '', to: msg.to || '', cc: msg.cc || '', date: msg.date || null,
        text: msg.text || msg.plain || Extract.htmlToText_(msg.body || '')
      };
    });
    return { threadId: String(id), subject: t.subject || (t.messages && t.messages[0] && t.messages[0].subject) || '', messages: msgs, routeHint: t.routeHint || null };
  },

  /** Remove quoted history ("On … wrote:", "-----Original Message-----", "> " lines). */
  stripQuoted_(text) {
    let s = String(text || '').replace(/\r\n/g, '\n');
    const cut = [
      /^On .{0,300}wrote:\s*$/m,
      /^-{2,}\s*Original Message\s*-{2,}/mi,
      /^_{5,}\s*$/m,
      /^From: .+\n(Sent|Date): .+/m
    ].map(function (re) { const m = re.exec(s); return m ? m.index : -1; }).filter(function (i) { return i > 0; });
    if (cut.length) s = s.slice(0, Math.min.apply(null, cut));
    return s.split('\n').filter(function (l) { return !/^\s*>/.test(l); }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  },

  htmlToText_(html) {
    return String(html || '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h\d)>/gi, '\n').replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, '\'')
      .replace(/[ \t]+/g, ' ');
  },

  /** Slack mrkdwn -> plain: <@ME> -> @Alex Scammon, <@U…> -> @name, <url|label> -> label. */
  slackText_(text, o) {
    const me = (o && o.me) || {};
    const users = (o && o.users) || {};
    return Extract.clean_(String(text || '')
      .replace(/<@([A-Z0-9]+)(?:\|([^>]+))?>/g, function (all, uid, label) {
        if (me.userId && uid === me.userId) return '@Alex Scammon';
        return '@' + (users[uid] || label || uid);
      })
      .replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1')
      .replace(/<!(here|channel|everyone)>/g, '@$1')
      .replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2 ($1)')
      .replace(/<(https?:[^>]+)>/g, '$1'));
  },

  dateText_(v) {
    const d = Util.parseDate(v);
    return d ? Util.formatDate(d, 'EEE d MMM yyyy HH:mm') : String(v || '');
  },

  isoOrNull_(v) {
    if (!Util.isIsoDate(v)) return null;
    const d = new Date(v + 'T00:00:00Z');
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v ? v : null;
  },

  clean_(s) {
    if (s === null || s === undefined) return '';
    // eslint-disable-next-line no-control-regex
    return String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/\s+/g, ' ').trim();
  }
};
