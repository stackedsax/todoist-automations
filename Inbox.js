/**
 * Inbox — daily email sweep -> triage queue (docs/DESIGN.md "Inbox sweep").
 *
 * 1. GmailApp.search(Inbox.QUERY) (one inbox receives mail for all of Alex's addresses).
 * 2. Skip threads already in the ledger (key gmail:<threadId>:<lastMessageId>, so a new reply
 *    makes the thread eligible again).
 * 3. Deterministic prefilter, counted and logged: Alex sent the last message, noreply/notification
 *    senders, calendar replies/invitations, vendor receipts/invoices, mailing lists
 *    (List-Unsubscribe) not addressed directly to Alex. Filtered threads are ledgered 'nothing'.
 * 4. Up to MAX_THREADS remaining threads (newest first; overflow logged and left for later) go to
 *    Extract.email in batches of BATCH_SIZE; items are routed by recipient address (Route.email,
 *    e.g. To: alex@gr-oss.io -> GR) combined with the LLM suggestion (Route.finalize), matched
 *    against open Todoist tasks (incl. Code.js "@starred" tasks in Inbox) and QUEUED ONLY.
 * 5. kv inbox.lastFiltered = {at, count, byReason, examples, overflow} for the triage UI footer.
 *
 * Gmail search operators: https://support.google.com/mail/answer/7190
 * GmailApp: https://developers.google.com/apps-script/reference/gmail/gmail-app
 */
const Inbox = {
  QUERY: 'in:inbox newer_than:2d -category:promotions -category:social -category:forums',
  MAX_THREADS: 40,
  BATCH_SIZE: 8,
  SEARCH_PAGE: 100,
  SEARCH_MAX: 500,
  EXAMPLES: 10,
  MAX_MESSAGES: 6,
  MESSAGE_CHARS: 4000,
  KV_FILTERED: 'inbox.lastFiltered',

  REASONS: ['replied', 'calendar', 'noreply', 'receipt', 'mailing_list'],

  NOREPLY_RE_: /(^|[._+-])(no-?reply|do-?not-?reply|donotreply|notifications?|notify|alerts?|mailer-daemon|postmaster|bounces?)([._+-]|$)/i,
  CALENDAR_RE_: /^\s*(accepted|declined|tentatively accepted|tentative|invitation|updated invitation|canceled event|cancelled event|new event|event canceled|event cancelled)( with note)?\s*:/i,
  /**
   * Local parts of automated transactional senders. A receipt-looking subject from a vendor domain is
   * dropped only when the sender also looks automated (this, or bulk/auto headers), so a real person
   * at amazon.com / google.com / microsoft.com writing "Re: Invoice for the engagement" is kept.
   */
  AUTOMATED_LOCAL_RE_: /(^|[._+-])(billing|bills?|receipts?|invoices?|invoicing|orders?|order-?updates?|auto-?confirm|confirmations?|shipment(-?tracking)?|shipping|tracking|deliver(y|ies)|payments?|payouts?|accounts?(-?payable|-?receivable)?|statements?|store|shop|digital|transactions?|purchases?|marketplace|renewals?|subscriptions?|memberships?|rewards?|reservations?|bookings?|itinerary|e?tickets?|mailer|automated|auto|system|support|customer-?(service|care|support)|service)([._+-]|\d|$)/i,
  RECEIPT_RE_: /\b(receipt|invoice|your order|order (confirmation|#|number|no\.?)|payment (received|confirmation|processed|successful)|billing statement|your (bill|statement) is|has shipped|shipment|out for delivery|delivered:|subscription (renewal|confirmation)|renewal notice)\b/i,

  /** Senders whose receipts/invoices are dropped (parent domains match). Extend with INBOX_VENDORS (JSON array). */
  VENDORS: [
    'amazon.com', 'amazon.co.uk', 'apple.com', 'uber.com', 'lyft.com', 'doordash.com', 'grubhub.com', 'instacart.com',
    'stripe.com', 'paypal.com', 'venmo.com', 'squareup.com', 'square.com', 'shopify.com', 'google.com', 'github.com',
    'aws.amazon.com', 'airbnb.com', 'expensify.com', 'bill.com', 'intuit.com', 'quickbooks.com', 'zoom.us', 'slack.com',
    'anthropic.com', 'openai.com', 'ups.com', 'fedex.com', 'usps.com', 'dhl.com', 'costco.com', 'target.com', 'ebay.com',
    'etsy.com', 'comcast.net', 'xfinity.com', 'att.com', 'verizon.com', 't-mobile.com', 'pge.com', 'docusign.net',
    'godaddy.com', 'namecheap.com', 'cloudflare.com', 'dropbox.com', 'adobe.com', 'microsoft.com', 'hertz.com', 'delta.com',
    'united.com', 'alaskaair.com', 'southwest.com', 'booking.com', 'expedia.com'
  ],

  // ------------------------------------------------------------------ run

  /**
   * @param {{deadlineMs?: number, query?: string}} [opts]
   * @return {{seen, skipped, filtered, byReason, candidates, overflow, queued, items, errors, stoppedEarly}}
   */
  run(opts) {
    const o = opts || {};
    const started = Util.now().getTime();
    const deadline = Util.deadline(o.deadlineMs);
    const stats = {
      seen: 0, skipped: 0, filtered: 0, byReason: {}, candidates: 0, overflow: 0,
      queued: 0, items: 0, errors: 0, stoppedEarly: false
    };
    Inbox.REASONS.forEach(function (r) { stats.byReason[r] = 0; });

    const threads = Inbox.search_(o.query || Inbox.QUERY);
    stats.seen = threads.length;

    const filteredLedger = [];
    const examples = [];
    const candidates = [];
    for (let i = 0; i < threads.length; i++) {
      if (deadline.expired()) {
        stats.stoppedEarly = true;
        console.log('[inbox] deadline reached while reading threads; ' + (threads.length - i) + ' left for the next sweep');
        break;
      }
      const th = threads[i];
      let info;
      try {
        // Cheap key first (thread id + last message id); bodies and headers only for new threads.
        const k = Inbox.threadKey_(th);
        if (!k) continue;
        if (Store.ledgerHas(k.key)) { stats.skipped++; continue; }
        info = Inbox.threadInfo(th, k.messages);
      } catch (e) {
        stats.errors++;
        console.log('[inbox] could not read a thread: ' + Inbox.errText_(e));
        continue;
      }
      if (!info) continue;
      const reason = Inbox.filterReason(info);
      if (reason) {
        stats.filtered++;
        stats.byReason[reason] = (stats.byReason[reason] || 0) + 1;
        if (examples.length < Inbox.EXAMPLES) {
          examples.push({ subject: Util.truncate(info.subject, 120), from: Util.truncate(info.lastFrom, 120), reason: reason });
        }
        filteredLedger.push({ key: info.key, source: 'gmail', outcome: 'nothing', note: 'filtered: ' + reason });
        continue;
      }
      candidates.push(info);
    }
    if (filteredLedger.length) Store.ledgerPutMany(filteredLedger);

    candidates.sort(function (a, b) { return b.lastDate.getTime() - a.lastDate.getTime(); });
    const work = candidates.slice(0, Inbox.MAX_THREADS);
    stats.candidates = candidates.length;
    stats.overflow = candidates.length - work.length;
    if (stats.overflow) console.log('[inbox] ' + stats.overflow + ' thread(s) over the daily cap of ' + Inbox.MAX_THREADS + '; left for a later sweep');

    const reasonText = Inbox.REASONS.filter(function (r) { return stats.byReason[r]; })
      .map(function (r) { return r + ' ' + stats.byReason[r]; }).join(', ');
    console.log('[inbox] ' + stats.seen + ' thread(s): ' + stats.skipped + ' already processed, ' + stats.filtered +
      ' filtered' + (reasonText ? ' (' + reasonText + ')' : '') + ', ' + work.length + ' to extract');
    try {
      Store.kvSet(Inbox.KV_FILTERED, {
        at: Util.now().toISOString(), count: stats.filtered, byReason: stats.byReason, examples: examples,
        overflow: stats.overflow, seen: stats.seen
      });
    } catch (e) {
      console.log('[inbox] could not save filtered summary: ' + Inbox.errText_(e));
    }

    if (work.length) {
      const ctx = {
        catalogue: Inbox.safe_(function () { return Route.sectionCatalogue(); }, {}),
        dismissals: Inbox.safe_(function () { return Store.feedbackRecent(Extract.MAX_DISMISSALS || 20, 'dismissed'); }, []),
        notDup: Inbox.safe_(function () { return Dedupe.notDuplicateFeedback(200); }, []),
        openTasks: null,
        today: Util.today()
      };
      const batches = Util.chunk(work, Inbox.BATCH_SIZE);
      for (let b = 0; b < batches.length; b++) {
        if (deadline.expired()) {
          stats.stoppedEarly = true;
          const left = batches.slice(b).reduce(function (n, x) { return n + x.length; }, 0);
          console.log('[inbox] deadline reached; ' + left + ' thread(s) left for the next sweep');
          break;
        }
        Inbox.processBatch_(batches[b], ctx, stats);
      }
    }

    const note = ['filtered ' + stats.filtered + (reasonText ? ' (' + reasonText + ')' : '')];
    if (stats.overflow) note.push('overflow ' + stats.overflow);
    if (stats.stoppedEarly) note.push('stopped early');
    try {
      Store.runLog({
        job: 'runInboxSweep', durationMs: Util.now().getTime() - started, seen: stats.seen, created: 0,
        queued: stats.queued, skipped: stats.skipped + stats.filtered, errors: stats.errors, note: note.join('; ')
      });
    } catch (e) {
      console.log('[inbox] runLog failed: ' + Inbox.errText_(e));
    }
    return stats;
  },

  // ------------------------------------------------------------------ thread handling

  /**
   * GmailThread -> plain info used by the filter, Extract.email and routing.
   * @return {{threadId, key, subject, link, lastFrom, lastDate, last: Object, messages: Object[], to, cc}}
   */
  threadInfo(th, messages) {
    const msgs = messages || th.getMessages() || [];
    if (!msgs.length) return null;
    const threadId = String(th.getId());
    const last = msgs[msgs.length - 1];
    const plain = msgs.slice(-Inbox.MAX_MESSAGES).map(function (m) {
      return {
        id: String(m.getId()),
        from: m.getFrom() || '',
        to: m.getTo() || '',
        cc: m.getCc() || '',
        subject: m.getSubject() || '',
        date: m.getDate(),
        text: Util.truncate(m.getPlainBody() || '', Inbox.MESSAGE_CHARS)
      };
    });
    const header = function (name) {
      try { return typeof last.getHeader === 'function' ? String(last.getHeader(name) || '') : ''; } catch (e) { return ''; }
    };
    const subject = (th.getFirstMessageSubject && th.getFirstMessageSubject()) || plain[0].subject || '';
    return {
      threadId: threadId,
      key: 'gmail:' + threadId + ':' + String(last.getId()),
      subject: subject,
      lastSubject: last.getSubject() || '',
      link: typeof th.getPermalink === 'function' ? th.getPermalink() : 'https://mail.google.com/mail/#all/' + threadId,
      lastFrom: last.getFrom() || '',
      lastDate: Util.toDate(last.getDate()),
      lastTo: last.getTo() || '',
      lastCc: last.getCc() || '',
      listUnsubscribe: header('List-Unsubscribe'),
      listId: header('List-Id'),
      precedence: header('Precedence'),
      autoSubmitted: header('Auto-Submitted'),
      messages: plain
    };
  },

  /**
   * Deterministic prefilter. Returns the reason a thread needs no LLM look, or null.
   * Order: replied, calendar, noreply, receipt, mailing_list.
   * Every reason looks at the LAST message only (its sender, subject and headers), so a human reply
   * inside an invitation or receipt thread is still extracted.
   * @param {Object} info Inbox.threadInfo result
   */
  filterReason(info) {
    const fromEmail = Util.parseEmail(info.lastFrom);
    const lastSubject = info.lastSubject || '';
    if (fromEmail && Config.isMyEmail(fromEmail)) return 'replied';
    if (Inbox.CALENDAR_RE_.test(lastSubject)) return 'calendar';
    const local = fromEmail ? fromEmail.split('@')[0] : '';
    if (local && Inbox.NOREPLY_RE_.test(local)) return 'noreply';
    if (fromEmail && Inbox.isVendor_(Util.emailDomain(fromEmail)) && Inbox.RECEIPT_RE_.test(lastSubject) &&
      Inbox.looksAutomated_(local, info)) return 'receipt';
    if ((info.listUnsubscribe || info.listId) && !Inbox.directToMe_(info.lastTo)) return 'mailing_list';
    return null;
  },

  // ------------------------------------------------------------------ private

  processBatch_(batch, ctx, stats) {
    const threads = batch.map(function (info) {
      const routeHint = Inbox.safe_(function () {
        return Route.email({ from: info.lastFrom, messages: info.messages });
      }, { project: null, confidence: 'low', reason: 'no route' });
      info.routeHint = routeHint;
      return { threadId: info.threadId, subject: info.subject, messages: info.messages, routeHint: routeHint };
    });

    let items;
    try {
      items = Extract.email(threads, { sectionsByProject: ctx.catalogue, feedback: ctx.dismissals, today: ctx.today }) || [];
    } catch (e) {
      stats.errors++;
      console.log('[inbox] extraction failed for ' + batch.length + ' thread(s): ' + Inbox.errText_(e));
      Inbox.ledgerSafe_(batch.map(function (info) {
        return { key: info.key, source: 'gmail', outcome: 'error', note: Util.truncate('extract: ' + Inbox.errText_(e), 300) };
      }));
      return;
    }
    stats.items += items.length;

    const byThread = {};
    batch.forEach(function (info) { byThread[info.threadId] = info; });
    if (items.length && !ctx.openTasks) {
      ctx.openTasks = Inbox.safe_(function () { return Todoist.openTasks(); }, []);
    }

    const queue = [];
    const perThread = {};
    items.forEach(function (item) {
      const info = byThread[item.ref];
      if (!info || !item.title) return;
      try {
        const q = Inbox.queueItem_(info, item, ctx);
        queue.push(q);
        (perThread[info.threadId] = perThread[info.threadId] || []).push(q.id);
      } catch (e) {
        stats.errors++;
        console.log('[inbox] could not build queue item for thread ' + info.threadId + ': ' + Inbox.errText_(e));
      }
    });

    let added = [];
    try {
      added = queue.length ? Store.queueAdd(queue) || [] : [];
    } catch (e) {
      stats.errors++;
      console.log('[inbox] queue write failed: ' + Inbox.errText_(e));
      Inbox.ledgerSafe_(batch.map(function (info) {
        return { key: info.key, source: 'gmail', outcome: 'error', note: Util.truncate('queue: ' + Inbox.errText_(e), 300) };
      }));
      return;
    }
    stats.queued += added.length;

    Inbox.ledgerSafe_(batch.map(function (info) {
      const ids = perThread[info.threadId] || [];
      return {
        key: info.key, source: 'gmail', outcome: ids.length ? 'queued' : 'nothing', queueIds: ids,
        note: ids.length ? ids.length + ' item(s)' : ''
      };
    }));
  },

  /** Queue item (DESIGN "Queue item") for one extracted email item, plus Triage accept extras. */
  queueItem_(info, item, ctx) {
    const sourceKey = 'gmail:' + info.threadId;
    const qid = Store.queueId('email', sourceKey, item.title);
    const fin = Route.finalize(info.routeHint, item, ctx.catalogue) || { project: null, section: null, routeConfidence: 'low' };
    let dup = null;
    try {
      dup = Dedupe.matchTask({ id: qid, title: item.title }, ctx.openTasks || [], ctx.notDup);
    } catch (e) {
      console.log('[inbox] dedupe failed: ' + Inbox.errText_(e));
    }
    const waiting = item.kind === 'waiting';
    const chips = [];
    if (item.confidence === 'low') chips.push('Low confidence');
    return {
      id: qid,
      status: 'pending',
      source: 'email',
      sourceKey: sourceKey,
      origin: Inbox.origin(info),
      link: info.link,
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
      // Extras for Triage accept (same convention as Meetings): ready-made description + label.
      description: Inbox.description(info, item, qid),
      labels: ['from-email']
    };
  },

  /** "Email · <subject> · <sender name> · Thu 24 Sep" */
  origin(info) {
    return 'Email · ' + Util.truncate(info.subject || '(no subject)', 80) + ' · ' + Inbox.senderName_(info) +
      ' · ' + Util.formatDay(info.lastDate);
  },

  /**
   * Email: <subject> · <sender> · <Thu 24 Sep>
   * [Open in Gmail](<link>)
   * > <quote>
   * <!-- ta:{"key":"gmail:<threadId>","q":"q_…"} -->
   */
  description(info, item, qid) {
    const lines = ['Email: ' + (info.subject || '(no subject)') + ' · ' + Inbox.senderName_(info) + ' · ' + Util.formatDay(info.lastDate)];
    if (info.link) lines.push('[Open in Gmail](' + info.link + ')');
    const quote = item && item.quote ? String(item.quote).trim() : '';
    if (quote) lines.push(quote.split(/\r?\n/).map(function (l) { return '> ' + l; }).join('\n'));
    return Todoist.withMachineLine(lines.join('\n'), { key: 'gmail:' + info.threadId, q: qid });
  },

  /** Display name of the most recent non-Alex sender ("Priya Shah" from "Priya Shah <p@x.com>"). */
  senderName_(info) {
    const msgs = (info.messages || []).slice().reverse();
    const m = msgs.find(function (x) { return !Config.isMyEmail(Util.parseEmail(x.from)); }) || msgs[0] || { from: info.lastFrom };
    const from = String(m.from || '');
    const name = from.replace(/<[^>]*>/, '').replace(/"/g, '').trim();
    return name || Util.parseEmail(from) || 'unknown sender';
  },

  /** {threadId, key, messages} from getMessages() and the last message id only (no bodies/headers). */
  threadKey_(th) {
    const msgs = th.getMessages() || [];
    if (!msgs.length) return null;
    const threadId = String(th.getId());
    return { threadId: threadId, key: 'gmail:' + threadId + ':' + String(msgs[msgs.length - 1].getId()), messages: msgs };
  },

  /**
   * Automated sender: transactional local part (billing@, receipts@, auto-confirm@, ...) or bulk/auto
   * headers (List-Id, List-Unsubscribe, Precedence: bulk|list|junk, Auto-Submitted other than "no").
   * Auto-Submitted: https://www.rfc-editor.org/rfc/rfc3834
   */
  looksAutomated_(local, info) {
    if (local && Inbox.AUTOMATED_LOCAL_RE_.test(local)) return true;
    const i = info || {};
    if (i.listId || i.listUnsubscribe) return true;
    if (/^\s*(bulk|list|junk)\b/i.test(i.precedence || '')) return true;
    const auto = String(i.autoSubmitted || '').trim().toLowerCase();
    return !!auto && auto !== 'no';
  },

  search_(query) {
    const out = [];
    for (let start = 0; start < Inbox.SEARCH_MAX; start += Inbox.SEARCH_PAGE) {
      const page = GmailApp.search(query, start, Inbox.SEARCH_PAGE) || [];
      page.forEach(function (t) { out.push(t); });
      if (page.length < Inbox.SEARCH_PAGE) break;
    }
    return out;
  },

  directToMe_(to) {
    const found = String(to || '').match(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [];
    return found.some(function (e) { return Config.isMyEmail(e.toLowerCase()); });
  },

  isVendor_(domain) {
    if (!domain) return false;
    const extra = Inbox.safe_(function () { return Config.json('INBOX_VENDORS', []); }, []);
    const list = Inbox.VENDORS.concat(Array.isArray(extra) ? extra : []).map(function (d) { return String(d).toLowerCase(); });
    let d = String(domain).toLowerCase();
    while (d.indexOf('.') > 0) {
      if (list.indexOf(d) >= 0) return true;
      d = d.slice(d.indexOf('.') + 1);
    }
    return false;
  },

  ledgerSafe_(entries) {
    try {
      Store.ledgerPutMany(entries);
    } catch (e) {
      console.log('[inbox] ledger write failed: ' + Inbox.errText_(e));
    }
  },

  safe_(fn, def) {
    try {
      const v = fn();
      return v === undefined || v === null ? def : v;
    } catch (e) {
      console.log('[inbox] ' + Inbox.errText_(e));
      return def;
    }
  },

  errText_(e) {
    if (!e) return 'unknown error';
    return (e.status ? 'HTTP ' + e.status + ': ' : '') + (e.message || String(e));
  }
};

/** Daily trigger: sweep the inbox into the triage queue. */
function runInboxSweep() {
  return Util.withLock('runInboxSweep', function () {
    return Inbox.run();
  });
}
