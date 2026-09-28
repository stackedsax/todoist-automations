/**
 * Code.js — starred Gmail -> Todoist Inbox (the original automation, kept as-is in spirit).
 *
 * Every minute: each starred message becomes an Inbox task "<subject> @starred" whose
 * description links back to the email, carries a cleaned copy of the body and ends with the
 * machine line <!-- ta:{"key":"gmail-star:<messageId>"} -->. The message is unstarred only after
 * its task exists. One failing message is logged and left starred (retried next minute); it never
 * aborts the rest of the run.
 *
 * Todoist API v1 create task: POST https://api.todoist.com/api/v1/tasks
 * (https://developer.todoist.com/api/v1/#tag/Tasks/operation/create_task_api_v1_tasks_post),
 * via Todoist.createTask (Http retries 429/5xx).
 */

/** Max chars of email body copied into the task description (Todoist allows 16k; keep room for the machine line). */
const STARRED_BODY_MAX_ = 8000;
/** Upper bound on starred threads handled per run. */
const STARRED_THREAD_MAX_ = 50;
/**
 * CacheService key holding the signature of the last error-only run that was written to the runs tab.
 * A message that fails every minute (e.g. a persistent Todoist 400) would otherwise append ~1,440 rows
 * a day; identical failures are logged to the runs tab at most once per STARRED_ERROR_RELOG_S_.
 */
const STARRED_ERROR_SIG_KEY_ = 'starred.lastErrorSig';
/** Re-log an unchanged failure at most every 6 hours (the CacheService TTL maximum). */
const STARRED_ERROR_RELOG_S_ = 21600;

/** Trigger: every 1 min. Starred Gmail messages -> Todoist Inbox tasks, then unstar. */
function createTaskFromStarred() {
  // Fail loudly (once) on missing configuration: nothing can work without the token.
  Config.require('TODOIST_API_TOKEN');

  // A user lock (not the script lock the long jobs share) so a slow minute cannot overlap the next
  // one and double-create, while runMeetings etc. never starve this job.
  const lock = LockService.getUserLock();
  if (!lock.tryLock(1000)) {
    console.log('[createTaskFromStarred] previous run still active; skipping');
    return null;
  }
  const started = Util.now().getTime();
  const stats = { seen: 0, created: 0, skipped: 0, errors: 0 };
  const failed = [];
  try {
    const threads = GmailApp.search('is:starred', 0, STARRED_THREAD_MAX_) || [];
    threads.forEach(function (thread) {
      let messages;
      try {
        messages = thread.getMessages() || [];
      } catch (e) {
        stats.errors++;
        let tid = '?';
        try { tid = thread.getId(); } catch (e2) { /* ignore */ }
        failed.push('thread:' + tid);
        console.log('[createTaskFromStarred] could not read thread: ' + starredErr_(e));
        return;
      }
      messages.forEach(function (message) {
        if (!message || !message.isStarred()) return;
        stats.seen++;
        try {
          const outcome = starredMessageToTask_(message);
          stats[outcome]++;
        } catch (e) {
          stats.errors++;
          let id = '?';
          try { id = message.getId(); } catch (e2) { /* ignore */ }
          failed.push('msg:' + id);
          console.log('[createTaskFromStarred] message ' + id + ' failed; left starred for retry: ' + starredErr_(e));
        }
      });
    });
  } finally {
    lock.releaseLock();
  }
  if (stats.seen > 0 || stats.errors > 0) console.log('[createTaskFromStarred] ' + JSON.stringify(stats));
  if (starredShouldLogRun_(stats, failed)) {
    try {
      Store.runLog({
        job: 'createTaskFromStarred', durationMs: Util.now().getTime() - started, seen: stats.seen, created: stats.created,
        queued: 0, skipped: stats.skipped, errors: stats.errors, note: ''
      });
    } catch (e) {
      console.log('[createTaskFromStarred] could not write run log: ' + starredErr_(e));
    }
  }
  return stats;
}

/**
 * Whether this run earns a row in the runs tab. Runs that created or skipped (recovered) something
 * always do. Error-only runs do the first time a given set of failures appears, then again only
 * after STARRED_ERROR_RELOG_S_ or when the set changes. Runs with nothing to report never do.
 */
function starredShouldLogRun_(stats, failed) {
  let cache = null;
  try { cache = CacheService.getScriptCache(); } catch (e) { cache = null; }
  const sig = stats.errors > 0 ? Util.hash(failed.slice().sort().join('|')) : null;
  if (stats.created > 0 || stats.skipped > 0) {
    // Progress resets the throttle, so a later identical failure is logged again.
    starredCacheSet_(cache, sig);
    return true;
  }
  if (!sig) return false;
  let last = null;
  try { last = cache ? cache.get(STARRED_ERROR_SIG_KEY_) : null; } catch (e) { last = null; }
  if (last === sig) return false;
  starredCacheSet_(cache, sig);
  return true;
}

function starredCacheSet_(cache, sig) {
  if (!cache) return;
  try {
    if (sig) cache.put(STARRED_ERROR_SIG_KEY_, sig, STARRED_ERROR_RELOG_S_);
    else cache.remove(STARRED_ERROR_SIG_KEY_);
  } catch (e) { /* throttle is best-effort */ }
}

/**
 * Create the task for one starred message (unless one already exists for it) and unstar it.
 * @return {'created'|'skipped'}
 */
function starredMessageToTask_(message) {
  const messageId = message.getId();
  const key = 'gmail-star:' + messageId;

  // A previous run may have created the task but failed to unstar: don't duplicate it.
  const existing = Todoist.findByMachineKey(key, { projectNames: ['Inbox'] });
  if (existing) {
    message.unstar();
    return 'skipped';
  }

  const subject = String(message.getSubject() || '').trim() || '(no subject)';
  const link = gmailMessageLink_(messageId);
  const bodyText = Util.truncate(cleanEmailBody(extractCleanBodySimple(message) || ''), STARRED_BODY_MAX_);
  const description = Todoist.withMachineLine('[View original email](' + link + ')\n\n' + bodyText, { key: key });

  Todoist.createTask({ content: subject + ' @starred', description: description });
  message.unstar();
  return 'created';
}

/** https://mail.google.com/mail/?authuser=<me>#all/<messageId> (authuser keeps multi-account browsers on the right inbox). */
function gmailMessageLink_(messageId) {
  let email = '';
  try { email = Session.getEffectiveUser().getEmail() || ''; } catch (e) { email = ''; }
  return email
    ? 'https://mail.google.com/mail/?authuser=' + email + '#all/' + messageId
    : 'https://mail.google.com/mail/#all/' + messageId;
}

function starredErr_(e) {
  if (!e) return 'unknown error';
  return (e.message || String(e)) + (e.status ? ' (HTTP ' + e.status + ')' : '');
}

/** Legacy helper: (re)install only the starred-email trigger. Prefer installTriggers(). */
function createTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'createTaskFromStarred') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('createTaskFromStarred')
    .timeBased()
    .everyMinutes(1)
    .create();
  console.log('Trigger created successfully - will run every minute');
}

function extractCleanBodySimple(message) {
  if (!message || typeof message.getPlainBody !== 'function') return '';

  const plain = message.getPlainBody();
  if (plain && plain.trim().length > 20) return plain;

  let html = message.getBody() || '';
  html = html.replace(/<style[\s\S]*?<\/style>/gi, '');
  html = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<\/?[^>]+(>|$)/g, '');  // strip tags
  return html.replace(/\s+/g, ' ').trim().slice(0, 3000);
}

function walkHtmlAndExtract(element) {
  const tag = element.getName().toLowerCase();
  const invisible = ['style', 'script', 'head', 'meta', 'noscript'];
  if (invisible.includes(tag)) return '';

  // Special case: link conversion
  if (tag === 'a' && element.getAttribute('href')) {
    const url = element.getAttribute('href').getValue();
    const text = extractTextContent(element);
    return `[${text}](${url})`;
  }

  // Aggregate text and recurse into children
  let text = '';
  if (element.getText()) text += element.getText();

  const children = element.getChildren();
  for (let i = 0; i < children.length; i++) {
    text += walkHtmlAndExtract(children[i]);
  }

  return text.replace(/\s+/g, ' ').trim() + ' ';
}

function extractTextContent(element) {
  let text = element.getText() || '';
  element.getChildren().forEach(child => {
    text += extractTextContent(child);
  });
  return text.trim();
}

function cleanEmailBody(bodyText) {
  bodyText = String(bodyText || '');

  // Remove long bare URLs (especially trackers)
  bodyText = bodyText.replace(/https?:\/\/[^\s]*?(list\.[^\s]+|actionnetwork\.org)[^\s)]+/gi, '');

  // Remove lines that include unsubscribe/update contact
  bodyText = bodyText.replace(/^.*(unsubscribe|update.*contact|privacy policy|stop receiving).*$/gim, '');

  // Optional: strip after first unsubscribe mention
  const cutIndex = bodyText.search(/(unsubscribe|stop receiving)/i);
  if (cutIndex > 0) bodyText = bodyText.slice(0, cutIndex);

  // Clean up spacing
  return bodyText.replace(/\n{3,}/g, '\n\n').trim();
}
