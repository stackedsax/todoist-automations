/**
 * Triggers.js — installTriggers, uninstallAllTriggers, checkSetup (docs/DESIGN.md "Trigger entrypoints").
 *
 * Run these by hand from the Apps Script editor (select the function, press Run):
 *   checkSetup()          reports missing Script Properties, Slack workspaces, Todoist projects/sections,
 *                         creates the "Waiting on others" project and the labels, saves TRIAGE_URL.
 *   installTriggers()     idempotent: removes this project's managed triggers (and the legacy
 *                         processFirefliesEmails) then creates the schedule below.
 *   uninstallAllTriggers() removes every trigger of this script project.
 *
 * Daily triggers use atHour/nearMinute, which run in the script time zone (appsscript.json:
 * America/Los_Angeles); Apps Script fires them within ~15 min of the requested time.
 * https://developers.google.com/apps-script/reference/script/clock-trigger-builder
 */

/** The managed schedule. `requires` names a condition checked at install time. */
const TRIGGER_SPECS_ = [
  { handler: 'createTaskFromStarred', everyMinutes: 1 },
  { handler: 'runMeetings', everyMinutes: 10 },
  { handler: 'runSlack', everyMinutes: 10, requires: 'slack' },
  { handler: 'runInboxSweep', atHour: 7, nearMinute: 0 },
  { handler: 'runWaiting', atHour: 7, nearMinute: 30 },
  { handler: 'runSummaryCheck', atHour: 8, nearMinute: 0 },
  { handler: 'runTriageDigest', atHour: 8, nearMinute: 15 }
];

/** Handlers from older versions that installTriggers removes. */
// Legacy handlers plus one-off continuation triggers (backfill) that installTriggers should clear.
const LEGACY_TRIGGER_HANDLERS_ = ['processFirefliesEmails', 'runBackfill'];

const REQUIRED_PROPS_ = ['TODOIST_API_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_MODEL', 'GRANOLA_API_KEY'];

/** Where to get each required property (shown by checkSetup). */
const PROP_HELP_ = {
  TODOIST_API_TOKEN: 'Todoist > Settings > Integrations > Developer > API token',
  ANTHROPIC_API_KEY: 'console.anthropic.com > Settings > API keys',
  CLAUDE_MODEL: 'an Anthropic model id, e.g. claude-sonnet-4-5',
  GRANOLA_API_KEY: 'Granola desktop app > Settings > Connectors > API keys'
};

/** User-token scopes the Slack module needs (docs/DESIGN.md "Slack"). */
const SLACK_SCOPES_ = ['reactions:read', 'search:read', 'channels:history', 'groups:history', 'im:history',
  'mpim:history', 'users:read', 'users:read.email'];

/** Sections the routing and prompts expect (docs/DESIGN.md). Missing ones are warnings only. */
const EXPECTED_SECTIONS_ = {
  GR: ['Reach Out', 'Team Logistics', 'Team Updates', 'Conferences', 'KubeCon / Armada / CNCF Batch', 'Arctos',
    'Tech Projects', 'Blogs', 'Hiring', 'EA'],
  ISC: ['Reach Out', 'Logistics', 'Marketing', 'Quantum', 'Research', 'ISC Events', 'EA'],
  Me: ['Immediate', 'Logistics', 'Outreach', 'Tech', 'Cars', 'To Buy'],
  SG: []
};

/** Project routing keys that must exist in Todoist. */
const REQUIRED_PROJECT_KEYS_ = ['GR', 'ISC', 'Me', 'SG', 'Inbox'];

// ---------------------------------------------------------------------------- entrypoints

/**
 * Idempotently (re)install the trigger schedule.
 * @return {{installed: {handler: string, schedule: string}[], removed: number, skipped: {handler: string, reason: string}[]}}
 */
function installTriggers() {
  const managed = {};
  TRIGGER_SPECS_.forEach(function (s) { managed[s.handler] = true; });
  LEGACY_TRIGGER_HANDLERS_.forEach(function (h) { managed[h] = true; });

  // A backfill still in progress keeps its one-off continuation (Meetings.scheduleContinuation_),
  // so running installTriggers right after runBackfill does not stop it half way.
  const keepBackfill = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'runBackfill'; }) &&
    backfillInProgress_();
  let removed = 0;
  let keptBackfill = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (keepBackfill && t.getHandlerFunction() === 'runBackfill') {
      keptBackfill++;
      return;
    }
    if (managed[t.getHandlerFunction()]) {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });

  const installed = [];
  const skipped = [];
  TRIGGER_SPECS_.forEach(function (spec) {
    const reason = triggerSkipReason_(spec);
    if (reason) {
      skipped.push({ handler: spec.handler, reason: reason });
      return;
    }
    const b = ScriptApp.newTrigger(spec.handler).timeBased();
    if (spec.everyMinutes) b.everyMinutes(spec.everyMinutes);
    else b.everyDays(1).atHour(spec.atHour).nearMinute(spec.nearMinute || 0);
    b.create();
    installed.push({ handler: spec.handler, schedule: triggerScheduleText_(spec) });
  });

  saveTriageUrl_();

  console.log('[installTriggers] removed ' + removed + ' old trigger(s); installed: ' +
    installed.map(function (i) { return i.handler + ' (' + i.schedule + ')'; }).join(', ') +
    (skipped.length ? '; skipped: ' + skipped.map(function (s) { return s.handler + ' (' + s.reason + ')'; }).join(', ') : '') +
    (keptBackfill ? '; kept the pending runBackfill continuation (backfill still in progress)' : ''));
  return { installed: installed, removed: removed, skipped: skipped, keptBackfill: keptBackfill };
}

/**
 * True when the kv backfill cursor describes a window that has not finished. Never throws, and
 * never creates the state spreadsheet (no STATE_SHEET_ID means no backfill has run).
 */
function backfillInProgress_() {
  try {
    if (!Config.get('STATE_SHEET_ID', null)) return false;
    const cur = Store.kvGet(Meetings.KV_BACKFILL, null);
    return !!(cur && cur.from && !cur.complete);
  } catch (e) {
    console.log('[installTriggers] could not read the backfill cursor: ' + (e && e.message));
    return false;
  }
}

/** Delete every trigger of this script project. @return {number} how many were removed */
function uninstallAllTriggers() {
  const all = ScriptApp.getProjectTriggers();
  all.forEach(function (t) { ScriptApp.deleteTrigger(t); });
  console.log('[uninstallAllTriggers] removed ' + all.length + ' trigger(s)');
  return all.length;
}

/**
 * Check configuration and prepare Todoist. Never throws; logs a readable report and returns it.
 * Side effects: creates the "Waiting on others" project and the automation labels if missing,
 * creates/opens the state spreadsheet, saves TRIAGE_URL when the web app is deployed.
 * @return {{ok: boolean, errors: string[], warnings: string[], info: string[],
 *           missingProperties: string[], slack: Object[], todoist: Object, triageUrl: (string|null),
 *           stateSheetUrl: (string|null), triggers: string[]}}
 */
function checkSetup() {
  const r = {
    ok: false, errors: [], warnings: [], info: [],
    missingProperties: [], slack: [], todoist: { projects: {}, missingSections: {}, waitingProjectId: null },
    triageUrl: null, stateSheetUrl: null, triggers: []
  };
  const step = function (name, fn) {
    try {
      fn();
    } catch (e) {
      r.errors.push(name + ': ' + setupErr_(e));
    }
  };

  step('Script Properties', function () { setupCheckProperties_(r); });
  step('Claude', function () { setupCheckClaude_(r); });
  step('Granola', function () { setupCheckGranola_(r); });
  step('Fireflies', function () {
    if (Config.get('FIREFLIES_API_KEY')) r.info.push('Fireflies backup: enabled (FIREFLIES_API_KEY set).');
    else r.info.push('Fireflies backup: disabled (FIREFLIES_API_KEY not set; optional).');
  });
  step('Slack', function () { setupCheckSlack_(r); });
  step('Todoist', function () { setupCheckTodoist_(r); });
  step('State sheet', function () {
    const ss = Store.sheet();
    r.stateSheetUrl = ss.getUrl ? ss.getUrl() : null;
    r.info.push('State sheet: ' + (r.stateSheetUrl || ss.getId()));
  });
  step('Web app', function () {
    r.triageUrl = saveTriageUrl_();
    if (r.triageUrl) r.info.push('Triage web app: ' + r.triageUrl);
    else r.warnings.push('Triage web app is not deployed yet: Deploy > New deployment > Web app (execute as me, only myself), then run checkSetup again.');
  });
  step('Triggers', function () { setupCheckTriggers_(r); });
  step('Time zone', function () {
    const tz = Session.getScriptTimeZone();
    if (tz !== 'America/Los_Angeles') r.warnings.push('Script time zone is ' + tz + ' (expected America/Los_Angeles from appsscript.json).');
  });

  r.ok = r.errors.length === 0;
  console.log(setupReportText_(r));
  return r;
}

// ---------------------------------------------------------------------------- checkSetup steps

function setupCheckProperties_(r) {
  REQUIRED_PROPS_.forEach(function (k) {
    if (!Config.get(k)) {
      r.missingProperties.push(k);
      r.errors.push('Missing Script Property ' + k + ' (' + PROP_HELP_[k] + '). Set it in Project Settings > Script Properties.');
    }
  });
  ['ROUTING', 'IDENTITY', 'SLACK_WORKSPACES'].forEach(function (k) {
    try {
      Config.json(k, null);
    } catch (e) {
      r.errors.push(e.message);
    }
  });
  const dc = Config.get('DIRECT_CONFIDENCE');
  if (dc && ['high', 'med', 'low'].indexOf(String(dc).toLowerCase()) < 0) {
    r.warnings.push('DIRECT_CONFIDENCE should be high, med or low (got "' + dc + '").');
  }
  const bd = Config.get('BACKFILL_DAYS');
  if (bd && !(parseInt(bd, 10) > 0)) r.warnings.push('BACKFILL_DAYS should be a positive number of days (got "' + bd + '").');
}

/**
 * Verify the Anthropic key and CLAUDE_MODEL with GET /v1/models/{model_id}
 * (https://platform.claude.com/docs/en/api/models; headers x-api-key + anthropic-version).
 */
function setupCheckClaude_(r) {
  const key = Config.get('ANTHROPIC_API_KEY');
  const model = Config.get('CLAUDE_MODEL');
  if (!key || !model) return;
  try {
    const m = Http.fetchJson('https://api.anthropic.com/v1/models/' + encodeURIComponent(model), {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    }) || {};
    r.info.push('Claude: model ' + (m.id || model) + (m.display_name ? ' (' + m.display_name + ')' : '') + ' is available.');
  } catch (e) {
    if (e.status === 401 || e.status === 403) r.errors.push('Claude: ANTHROPIC_API_KEY was rejected (HTTP ' + e.status + ').');
    else if (e.status === 404) r.errors.push('Claude: CLAUDE_MODEL "' + model + '" was not found. Use a current model id.');
    else r.warnings.push('Claude: could not verify the model (' + setupErr_(e) + ').');
  }
}

/** One-page GET /notes to prove the Granola key works. */
function setupCheckGranola_(r) {
  if (!Config.get('GRANOLA_API_KEY')) return;
  try {
    const notes = Granola.listNotes({ pageSize: 1, maxPages: 1 });
    r.info.push('Granola: API key works (' + (notes.length ? 'notes visible' : 'no notes yet') + ').');
  } catch (e) {
    if (e.status === 401 || e.status === 403) r.errors.push('Granola: GRANOLA_API_KEY was rejected (HTTP ' + e.status + ').');
    else r.warnings.push('Granola: could not reach the API (' + setupErr_(e) + ').');
  }
}

/**
 * Each SLACK_WORKSPACES entry: shape, auth.test (https://docs.slack.dev/reference/methods/auth.test),
 * and granted scopes from the x-oauth-scopes response header
 * (https://docs.slack.dev/legacy/legacy-authentication/legacy-oauth-scopes/).
 */
function setupCheckSlack_(r) {
  let list;
  try {
    list = Config.json('SLACK_WORKSPACES', []);
  } catch (e) {
    return; // already reported by setupCheckProperties_
  }
  if (!list || (Array.isArray(list) && !list.length)) {
    r.info.push('Slack: no SLACK_WORKSPACES configured (Slack capture disabled; optional).');
    return;
  }
  if (!Array.isArray(list)) {
    r.errors.push('SLACK_WORKSPACES must be a JSON array like [{"name":"ISC","token":"xoxp-…","project":"ISC"}].');
    return;
  }
  const projectKeys = ['GR', 'ISC', 'Me', 'SG'];
  list.forEach(function (ws, i) {
    const name = (ws && ws.name) || '#' + (i + 1);
    const out = { name: name, ok: false, user: null, team: null, missingScopes: [] };
    r.slack.push(out);
    if (!ws || !ws.name || !ws.token) {
      r.errors.push('Slack ' + name + ': each workspace needs "name" and "token".');
      return;
    }
    if (!/^xoxp-/.test(ws.token)) r.warnings.push('Slack ' + name + ': token should be a user token (xoxp-…), not a bot token.');
    if (!ws.project || projectKeys.indexOf(ws.project) < 0) {
      r.warnings.push('Slack ' + name + ': "project" should be one of ' + projectKeys.join(', ') + ' (got ' + JSON.stringify(ws.project || null) + ').');
    }
    let res;
    try {
      res = Http.request('https://slack.com/api/auth.test', { method: 'post', headers: { Authorization: 'Bearer ' + ws.token } });
    } catch (e) {
      r.errors.push('Slack ' + name + ': auth.test failed (' + setupErr_(e) + ').');
      return;
    }
    const j = (res && res.json) || {};
    if (!j.ok) {
      r.errors.push('Slack ' + name + ': token rejected by auth.test (' + (j.error || 'unknown error') + ').');
      return;
    }
    out.ok = true;
    out.user = j.user || null;
    out.team = j.team || null;
    const header = res.headers && res.headers['x-oauth-scopes'];
    if (header) {
      const granted = String(header).split(',').map(function (s) { return s.trim(); });
      out.missingScopes = SLACK_SCOPES_.filter(function (s) { return granted.indexOf(s) < 0; });
      if (out.missingScopes.length) {
        r.warnings.push('Slack ' + name + ': token is missing scopes ' + out.missingScopes.join(', ') + ' (add them under User Token Scopes and reinstall the app).');
      }
    }
    r.info.push('Slack ' + name + ': OK as ' + (out.user || '?') + ' in ' + (out.team || '?') + ' -> project ' + (ws.project || '?') + '.');
  });
}

/** Projects + sections presence, Waiting project and labels. */
function setupCheckTodoist_(r) {
  if (!Config.get('TODOIST_API_TOKEN')) return;
  // Read the live project/section lists, not a 6h-old cache. resetCache(true) can only drop the
  // section-cache keys of projects it already knows, and at the start of an execution it knows none,
  // so fetch the projects first and then drop every project's section-cache entry explicitly.
  Todoist.resetCache(true);
  let projects;
  try {
    projects = Todoist.projects();
  } catch (e) {
    if (e.status === 401 || e.status === 403) r.errors.push('Todoist: TODOIST_API_TOKEN was rejected (HTTP ' + e.status + ').');
    else r.errors.push('Todoist: could not list projects (' + setupErr_(e) + ').');
    return;
  }
  setupDropSectionCache_(projects);
  REQUIRED_PROJECT_KEYS_.forEach(function (k) {
    const p = Todoist.project(k);
    r.todoist.projects[k] = p ? p.id : null;
    if (!p) {
      r.errors.push('Todoist: project "' + Todoist.projectName(k) + '" not found (routing key ' + k + '). Create it, or map the key in the ROUTING property.');
      return;
    }
    const expected = EXPECTED_SECTIONS_[k] || [];
    if (!expected.length) return;
    const have = {};
    Todoist.sections(k).forEach(function (s) { have[String(s.name).toLowerCase()] = true; });
    const missing = expected.filter(function (s) { return !have[s.toLowerCase()]; });
    if (missing.length) {
      r.todoist.missingSections[k] = missing;
      r.warnings.push('Todoist: ' + k + ' is missing section(s) ' + missing.join(', ') + ' (items for them land at the project root).');
    }
  });

  const existed = !!Todoist.projectId('Waiting');
  r.todoist.waitingProjectId = Todoist.ensureProject('Waiting');
  r.info.push('Todoist: "' + Todoist.projectName('Waiting') + '" project ' + (existed ? 'exists' : 'created') + '.');

  try {
    Todoist.ensureLabels(Todoist.LABELS);
    r.info.push('Todoist: labels ' + Todoist.LABELS.join(', ') + ' ready.');
  } catch (e) {
    r.warnings.push('Todoist: could not create labels (' + setupErr_(e) + ').');
  }
}

/** Remove every project's cached section list (CacheService and this execution's memory). */
function setupDropSectionCache_(projects) {
  const keys = (projects || []).map(function (p) { return 'todoist.sections.' + p.id; });
  if (keys.length) CacheService.getScriptCache().removeAll(keys);
  Todoist.mem_.sections = {};
}

function setupCheckTriggers_(r) {
  const handlers = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
  r.triggers = handlers;
  LEGACY_TRIGGER_HANDLERS_.forEach(function (h) {
    if (handlers.indexOf(h) < 0) return;
    if (h === 'runBackfill') r.info.push('Backfill in progress (continuation scheduled).');
    else r.warnings.push('Legacy trigger ' + h + ' is still installed: run installTriggers to remove it.');
  });
  // One-off lock-busy retries (Util.scheduleRetry_) are not the recurring schedule.
  const props = PropertiesService.getScriptProperties();
  const scheduled = ScriptApp.getProjectTriggers().filter(function (t) {
    const retryId = props.getProperty('RETRY_TRIGGER_' + t.getHandlerFunction());
    return !(retryId && retryId === t.getUniqueId());
  }).map(function (t) { return t.getHandlerFunction(); });
  const missing = TRIGGER_SPECS_.filter(function (s) {
    return scheduled.indexOf(s.handler) < 0 && !triggerSkipReason_(s);
  }).map(function (s) { return s.handler; });
  if (!handlers.length) r.warnings.push('No triggers installed yet: run runBackfill (optional), then installTriggers.');
  else if (missing.length) r.warnings.push('Triggers not installed for ' + missing.join(', ') + ': run installTriggers.');
  else r.info.push('Triggers: ' + handlers.join(', ') + '.');
}

// ---------------------------------------------------------------------------- helpers

/** Why a spec can't be installed right now, or null. */
function triggerSkipReason_(spec) {
  const g = typeof globalThis !== 'undefined' ? globalThis : {};
  if (typeof g[spec.handler] !== 'function') return 'function ' + spec.handler + ' not found in this project';
  if (spec.requires === 'slack') {
    let ws = [];
    try { ws = Config.slackWorkspaces(); } catch (e) { ws = []; }
    if (!ws.length) return 'no SLACK_WORKSPACES configured';
  }
  return null;
}

function triggerScheduleText_(spec) {
  if (spec.everyMinutes) return 'every ' + spec.everyMinutes + ' min';
  const mm = String(spec.nearMinute || 0);
  return 'daily ~' + (spec.atHour < 10 ? '0' : '') + spec.atHour + ':' + (mm.length < 2 ? '0' : '') + mm;
}

/** Save the deployed web app URL to TRIAGE_URL. @return {string|null} the URL (saved or existing) */
function saveTriageUrl_() {
  let url = null;
  try { url = ScriptApp.getService().getUrl() || null; } catch (e) { url = null; }
  if (url) {
    try { Config.set('TRIAGE_URL', url); } catch (e) { /* best-effort */ }
    return url;
  }
  return Config.get('TRIAGE_URL');
}

function setupErr_(e) {
  if (!e) return 'unknown error';
  return (e.message || String(e)) + (e.status && !/HTTP/.test(e.message || '') ? ' (HTTP ' + e.status + ')' : '');
}

function setupReportText_(r) {
  const lines = ['checkSetup: ' + (r.ok ? 'OK' : r.errors.length + ' problem(s) to fix')];
  const section = function (title, arr) {
    if (!arr.length) return;
    lines.push('', title + ':');
    arr.forEach(function (s) { lines.push('  - ' + s); });
  };
  section('Errors', r.errors);
  section('Warnings', r.warnings);
  section('OK', r.info);
  return lines.join('\n');
}
