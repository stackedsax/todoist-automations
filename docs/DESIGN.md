# Todoist Automations v2 — Design Spec

This is the contract every module is built against. If code and this doc disagree, fix the code (or flag the doc change explicitly in your summary).

## Goals

1. Capture Alex's todos from **Granola** (primary) and **Fireflies** (backup) meeting notes, **email**, and **Slack** (ISC + GR-OSS workspaces).
2. Only Alex's own items become tasks. Items other people owe him go to a hidden **Waiting on others** project and resurface on a date, auto-closing when evidence shows they're done.
3. Route to the right Todoist **project and section**. Confident items go straight in; everything uncertain goes to a keyboard-driven **triage queue** (Apps Script web app, ported from `docs/triage-prototype.html`).
4. Never duplicate (ledger + existing-task similarity check), never silently skip (run log + missing-summary check).
5. Runs entirely on Google Apps Script. No laptop dependency.

## Runtime constraints (Google Apps Script, V8)

- All `.js` files at repo root share ONE global scope. No `require`, no `import`, no `module.exports` in production files. Private helpers end with `_` (Apps Script convention; also hides them from the script runner menu).
- Namespacing: each module exposes one global object, e.g. `const Granola = { ... }` — EXCEPT trigger entrypoints, which must be top-level `function` declarations (listed below).
- Max 6 min per execution. Every long job uses `Util.deadline(ms)` and stops cleanly (saving its cursor) at ~4.5 min.
- Overlapping runs: wrap each entrypoint in `Util.withLock(name, fn)` (LockService script lock, `tryLock(5000)`; if lock not acquired, log and return).
- HTTP only via `Http.fetchJson(url, opts)` (UrlFetchApp with `muteHttpExceptions: true`, retries with backoff on 429/5xx, honours `Retry-After`, max 3 attempts, throws `HttpError`-shaped `Error` with `.status` and `.body`).
- No `console.log` of secrets or full email bodies.
- `Date.now()` is fine in Apps Script; for testability, modules get "now" from `Util.now()` (returns `new Date()`; tests can stub it).

## Files and ownership

| File | Global | Purpose |
|---|---|---|
| `Config.js` | `Config` | Script Properties access, defaults, identity, routing tables |
| `Util.js` | `Util` | now, deadline, withLock, hashing, text normalisation, date helpers |
| `Http.js` | `Http` | fetchJson with retry |
| `Store.js` | `Store` | Google Sheet–backed state: ledger, queue, feedback, runs, kv |
| `Todoist.js` | `Todoist` | Todoist API v1 client + project/section resolution + open-task cache |
| `Claude.js` | `Claude` | Anthropic Messages API with forced tool-use JSON output |
| `Granola.js` | `Granola` | Granola public API client → `Meeting` objects |
| `Fireflies.js` | `Fireflies` | Fireflies GraphQL client → `Meeting` objects (REPLACES the old email-parsing file entirely) |
| `CalendarLookup.js` | `CalendarLookup` | Find the calendar event (and which of Alex's calendars) for a meeting |
| `Route.js` | `Route` | Deterministic project routing + section catalogue |
| `Dedupe.js` | `Dedupe` | Merge same meeting across sources; match items against open Todoist tasks |
| `Extract.js` | `Extract` | LLM prompts: meetings, email, Slack, waiting-resolution |
| `Meetings.js` | `Meetings` + entrypoints | Orchestrates meeting → task/queue |
| `Waiting.js` | `Waiting` + entrypoints | Waiting-on-others lifecycle |
| `Inbox.js` | `Inbox` + entrypoints | Daily email sweep → queue |
| `Slack.js` | `Slack` + entrypoints | Slack capture (`:todo:` reactions → tasks; mentions/DMs → queue); evidence search |
| `Checks.js` | `Checks` + entrypoints | Missing Granola summary check; daily triage digest task |
| `Triage.js` | `Triage` + `doGet` + server fns | Web app backend |
| `TriageUI.html` | — | Web app front end (HtmlService), ported from the prototype |
| `Code.js` | (existing) | Starred Gmail → Todoist. Keep behaviour; fix robustness (see below) |
| `Triggers.js` | entrypoints | `installTriggers`, `uninstallAllTriggers`, `checkSetup` |
| `appsscript.json` | — | Manifest: scopes, webapp, timezone |

Tests live in `__tests__/`. Shared harness: `__tests__/helpers/gas.js` exports `loadGas(fileList)` which evals the named root files into one shared context with mocks from `__tests__/helpers/mocks.js` (UrlFetchApp, PropertiesService, CacheService, LockService, SpreadsheetApp, CalendarApp, GmailApp, HtmlService, ScriptApp, Session, Utilities). Mocks must be resettable per test. Each module has `__tests__/<Module>.test.js`.

## Trigger entrypoints (top-level functions)

| Function | Schedule (installed by `installTriggers`) |
|---|---|
| `createTaskFromStarred` | every 1 min (existing) |
| `runMeetings` | every 10 min |
| `runSlack` | every 10 min |
| `runInboxSweep` | daily ~07:00 script TZ |
| `runWaiting` | daily ~07:30 |
| `runSummaryCheck` | daily ~08:00 |
| `runTriageDigest` | daily ~08:15 |
| `runBackfill` | manual only: `runBackfill()` processes the last `BACKFILL_DAYS` (default 28) days, sending EVERYTHING to the triage queue (never direct), resumable across executions via kv cursor |

`installTriggers` is idempotent: deletes existing triggers for these handler names (and the legacy `processFirefliesEmails`) before creating. Manifest timezone: `America/Los_Angeles`.

## Script Properties (Config)

Required: `TODOIST_API_TOKEN`, `ANTHROPIC_API_KEY`, `CLAUDE_MODEL`, `GRANOLA_API_KEY`.
Optional: `FIREFLIES_API_KEY`, `SLACK_WORKSPACES` (JSON array `[{"name":"ISC","token":"xoxp-…","project":"ISC"},{"name":"GR-OSS","token":"xoxp-…","project":"GR"}]`), `ROUTING` (JSON override, merged over defaults), `IDENTITY` (JSON override), `BACKFILL_DAYS`, `DIRECT_CONFIDENCE` (default `high`), `STATE_SHEET_ID` (set automatically), `TRIAGE_URL` (set automatically from `ScriptApp.getService().getUrl()` when available).

`Config.get(key, default)`, `Config.require(key)` (throws `Missing Script Property: KEY` listing how to set it), `Config.json(key, default)`, `Config.identity()`, `Config.routing()`.

### Identity defaults

```js
{
  myNames: ["Alex Scammon", "Alexander Scammon", "A Scammon", "Alex S", "AlexS", "Alexander"],
  notMe: ["Alex Blundell"],          // a colleague in most ISC meetings — NEVER treat as Alex
  myEmails: ["alex@insightsoftmax.com", "alex@gr-oss.io", "alex@alexscammon.com"],
  assistants: ["morasha@insightsoftmax.com"]  // Morasha books meetings for Alex; "Marasha"/"Mirasha" in transcripts
}
```

### Routing defaults

```js
{
  projects: { GR: "GR", ISC: "ISC", Me: "Me", SG: "SG", Inbox: "Inbox", Waiting: "Waiting on others" },
  calendars: { "alex@gr-oss.io": "GR", "alex@insightsoftmax.com": "ISC", "alex@alexscammon.com": "Me" },
  domains: {
    "gr-oss.io": "GR", "gresearch.co.uk": "GR", "gresearch.com": "GR", "armadaproject.io": "GR",
    "nmc2.ai": "GR", "arctosalliance.org": "GR", "cncf.io": "GR", "linuxfoundation.org": "GR",
    "insightsoftmax.com": "ISC"
  },
  sectionHints: {             // soft hints passed to the LLM, not hard rules
    "arctosalliance.org": "GR/Arctos", "cncf.io": "GR/KubeCon / Armada / CNCF Batch", "armadaproject.io": "GR/KubeCon / Armada / CNCF Batch"
  },
  neverUseSections: ["Generated Tasks"]
}
```

Section catalogue is read live from Todoist (`Todoist.sections(projectName)`), cached 6h in CacheService. Current sections (for tests/fixtures):
- GR: Reach Out, Team Logistics, Team Updates, Conferences, KubeCon / Armada / CNCF Batch, Arctos, Tech Projects, Blogs, Hiring, EA
- ISC: Reach Out, Logistics, Marketing, Quantum, Research, ISC Events, EA
- Me: Immediate, Logistics, Outreach, Tech, Cars, To Buy
- SG: (none)

## Core data types

### Meeting (normalised, from Granola or Fireflies)
```js
{
  key: "granola:not_xxx" | "fireflies:01ABC…",
  source: "granola" | "fireflies",
  sourceId: "not_xxx",
  title: "Secure Copy/Paste Internal Sync",
  start: Date, end: Date|null,
  url: "https://notes.granola.ai/…" | "https://app.fireflies.ai/view/<id>",
  attendees: [{name, email}],
  organizerEmail: "…"|null,
  calendarEventId: "…"|null,         // Granola calendar_event.calendar_event_id
  summaryMarkdown: "…",               // Granola summary_markdown || summary_text; Fireflies overview + action_items
  actionItemsText: "…"|null,          // Fireflies summary.action_items (grouped by speaker names — UNRELIABLE for ownership)
  transcript: [{speaker: "me"|"them"|"unknown", name: string|null, text, t: seconds|null}] | null,
  alsoRecordedBy: []                  // filled by Dedupe.mergeMeetings: [{source, sourceId, url}]
}
```

### Extracted item (from Extract.*)
```js
{
  title: "Send the Last Mile HPC deck to Jon Stumpf",   // imperative, ≤ 120 chars, starts with a verb
  kind: "todo" | "waiting",          // todo = Alex owns it; waiting = someone owes Alex / blocks Alex
  owner: "me" | "other",
  ownerName: "Mihailo Marinkovic" | null,
  ownerEmail: "…" | null,
  quote: "…",                        // short supporting quote from the source, ≤ 300 chars
  why: "…",                          // one sentence for the triage UI
  due: "YYYY-MM-DD" | null,          // only if stated or clearly implied
  resurface: "YYYY-MM-DD" | null,    // waiting only: stated deadline, else null (caller defaults +7d)
  confidence: "high" | "med" | "low",// that this is a real, actionable item for Alex
  project: "GR" | "ISC" | "Me" | "SG" | null,   // LLM suggestion
  section: "Reach Out" | … | null,   // must be an existing section of that project, else null
  timestampSec: number | null        // meeting only, for deep links (Fireflies ?t=)
}
```
Rules the extractor MUST follow (put these in the prompt and test the post-processing):
- Drop decisions, FYIs, opinions, things explicitly deferred ("not the right time"), and items for groups ("each member…", "the team…") unless Alex personally has a part.
- Ownership: Granola transcript `speaker: "me"` = Alex. Names in `identity.notMe` are never Alex. Fireflies action-item groupings by name are hints only.
- Keep `waiting` only for items someone owes Alex or that block his work. Everyone else's work is dropped.
- Post-process: drop items with empty title; clamp lengths; nullify sections not in the catalogue or in `neverUseSections`; dedupe near-identical titles within one source.

### Queue item (Store "queue" sheet; one JSON blob per row + indexed columns)
```js
{
  id: "q_<hash>",                    // stable: Util.hash(source + sourceId + normalised title)
  createdAt: ISO, status: "pending" | "accepted" | "dismissed" | "waiting",
  source: "meeting" | "email" | "slack" | "system",
  sourceKey: "granola:not_xxx" | "gmail:<threadId>" | "slack:<ws>:<channel>:<ts>" | "check:<date>",
  origin: "Granola · Secure Copy/Paste Internal Sync · Thu 24 Sep",
  link: "https://…",
  title, quote, why, kind, due, resurface, waitOn, waitOnEmail,
  project, section, confidence, routeConfidence: "high"|"med"|"low",
  dupTaskId: string|null, dupTaskTitle: string|null,
  chips: ["Backfill"|"Low confidence"|"Example"…],
  resolvedAt: ISO|null, resultTaskId: string|null, notDuplicate: boolean
}
```

## Store (Google Sheet)

`Store.sheet()` opens `STATE_SHEET_ID` or creates a spreadsheet "Todoist Automations — State" and saves its id. Tabs (created on demand with header rows):
- `ledger`: key, source, processedAt, outcome (`tasks`|`queued`|`nothing`|`error`), taskIds (comma), queueIds (comma), note
- `queue`: id, status, createdAt, source, project, json
- `feedback`: at, type (`dismissed`|`not_duplicate`|`edited`|`rerouted`), queueId, sourceKey, title, detail(json)
- `runs`: at, job, durationMs, seen, created, queued, skipped, errors, note
- `kv`: key, value (cursors, e.g. `granola.updatedAfter`, `fireflies.fromDate`, `slack.<ws>.oldest`, `backfill.cursor`)

API: `ledgerHas(key)`, `ledgerPut(entry)`, `queueAdd(items)` (skips ids already present, returns added), `queueList({status})`, `queueGet(id)`, `queueUpdate(id, patch)`, `feedbackAdd(entry)`, `feedbackRecent(n)`, `runLog(entry)`, `kvGet(k, default)`, `kvSet(k, v)`. Batch reads/writes (`getValues`/`setValues`) — never cell-by-cell loops.

## Todoist client (API v1, base `https://api.todoist.com/api/v1`)

Verify every endpoint against https://developer.todoist.com/api/v1/ (list endpoints return `{results, next_cursor}`; handle both that and bare arrays). Needed:
- `projects()` (cached), `projectId(name)`, `ensureProject(name)` (only for "Waiting on others"), `sections(projectName)` (cached), `sectionId(projectName, sectionName)` (returns null if missing — never auto-create sections)
- `createTask({content, description, projectName, sectionName, labels, dueDate, dueString})` → task
- `addComment(taskId, content)`, `closeTask(id)`, `updateTask(id, patch)`, `moveTask(id, {projectName, sectionName})`
- `openTasks({projectNames})` → all open tasks in GR, ISC, Me, SG, Inbox, Waiting (paginated, cached for the run in memory)
- Task descriptions always end with a machine line: `<!-- ta:{"key":"granola:not_xxx","q":"q_abc"} -->` so future runs can recognise their own tasks. (Todoist renders it as text; keep it on the last line, short.)
- Labels: `meeting`, `from-email`, `from-slack`, `waiting`, `check`. Create labels lazily if the API requires existing labels (verify).

## Claude client

`Claude.json({system, user, schema, maxTokens})`: POST `https://api.anthropic.com/v1/messages` with headers `x-api-key`, `anthropic-version: 2023-06-01`; model `Config.require('CLAUDE_MODEL')`; one tool named `emit` whose `input_schema` is `schema`; `tool_choice: {type: "tool", name: "emit"}`; return the tool_use block's `input`. Truncate user content to ~150k chars with a marker. Retries via Http.

## Meeting pipeline (`runMeetings`)

1. Lock + deadline. Cursor `granola.updatedAfter` (default: now − 2 days on first run). `Granola.listNotes({updatedAfter})` → for each note id not in ledger (key `granola:<id>`), `Granola.getNote(id, {transcript: true})` (fallback to `/transcript` pagination on 413 or when inline transcript missing). Notes with no summary are not returned by the API — that's handled by `runSummaryCheck`.
2. If `FIREFLIES_API_KEY` set: `Fireflies.listSince(fromDate)` → meetings not in ledger.
3. `Dedupe.mergeMeetings(meetings)`: same meeting if |start difference| ≤ 10 min AND (attendee email overlap ≥ 1 other person OR normalised title similarity ≥ 0.6). Prefer Granola as primary; attach Fireflies transcript only if primary lacks one; record `alsoRecordedBy`. Ledger BOTH keys when processed.
4. `CalendarLookup.find(meeting)` → `{calendarEmail, eventTitle, attendeeEmails}|null` (search Alex's calendars in `routing.calendars` for events overlapping `start` ±15 min; prefer matching `calendarEventId`/iCalUID, then title similarity). Needs `CalendarApp.getCalendarById`.
5. `Route.project(meeting, calendarHit)` → `{project, confidence, reason}`: calendar email → high; else attendee domains (excluding Alex's own emails and generic providers) majority → med (high if unanimous); else null/low (LLM suggestion used, capped at low confidence).
6. `Extract.meeting(meeting, {routeHint, sectionsByProject, feedback})` → items.
7. For each item: `Dedupe.matchTask(item, openTasks, feedback)` → `{taskId, title, score}|null` (normalised token Jaccard ≥ 0.5 or containment ≥ 0.7 over titles; skip pairs recorded as `not_duplicate` in feedback).
8. Decision:
   - `kind:"todo"`, confidence high, route confidence high, no dup, project known → **create task directly** (project/section, label `meeting`, description below).
   - everything else (todo med/low, any route < high, dup found, waiting items) → **queue**.
   - Backfill mode → queue everything, chip "Backfill".
9. Ledger each processed meeting key (both sources if merged) with outcome. `Store.runLog`. Advance cursor to max `updated_at` seen only for fully processed notes.

Task description format (meeting):
```
Meeting: <title> · <Wed 24 Sep>
[Open in Granola](<url>)  ·  [Fireflies](<ff url>?t=<sec>)   ← only links that exist
Attendees: <names, max 8>
> <quote>
<!-- ta:{…} -->
```

## Waiting pipeline

- Project `Waiting on others` (ensureProject). Task: content `<ownerName>: <title>`, due = `resurface` (default +7 days), label `waiting`, description with source link, owner email, destination project/section, machine line containing `{"key":…,"dest":"ISC/Reach Out","owner":"…"}`.
- `runWaiting` (daily): for waiting tasks due ≤ today: gather evidence since task creation — Gmail (`from:<ownerEmail> newer_than:Nd` + keyword terms), Slack (`Slack.search(ownerName terms)` if configured), Granola meetings with that attendee since. `Extract.resolution(item, evidence)` → `{resolved: bool, confidence, reason, evidenceLink}`. If resolved && confidence high → close task + comment "Auto-closed: <reason> <link>". Else → move to dest project/section, rename to `Follow up with <ownerName>: <title>`, due today, comment with any partial evidence.

## Inbox sweep (`runInboxSweep`, daily)

- Gmail query: `in:inbox newer_than:2d -category:promotions -category:social -category:forums` (single inbox: alex@alexscammon.com receives mail for all three addresses). Skip threads in ledger (`gmail:<threadId>:<lastMessageId>`).
- Deterministic prefilter (count and log what's dropped): sender matches noreply/no-reply/notifications/alerts, calendar replies (`Accepted:`/`Declined:`/`Invitation:`/`Updated invitation`), receipts/invoices from known vendors, last message is from one of `myEmails` (Alex already replied), mailing lists with `List-Unsubscribe` and no direct To.
- Remaining threads (cap 40/day, log overflow) → `Extract.email(threads)` in batches of ~8 → items → dedupe vs open tasks (including `@starred` tasks created by Code.js) → **queue only** (never direct). Route project by recipient address (`To:` alex@gr-oss.io → GR, etc.) + LLM.
- Store filtered summary counts in kv `inbox.lastFiltered` for the triage UI footer.

## Slack (`runSlack`, every 10 min)

- Per workspace in `SLACK_WORKSPACES` (user tokens `xoxp-`; scopes documented in README: `reactions:read`, `search:read`, `channels:history`, `groups:history`, `im:history`, `mpim:history`, `users:read`, `users:read.email`, `chat:write` not needed).
- Explicit capture: `reactions.list` (user = token owner, `full=true`) → messages with reaction `todo` added since cursor → **create task directly** in the workspace's default project (LLM may pick section) with label `from-slack`, permalink (`chat.getPermalink`), message text. Ledger key `slack:<ws>:<channel>:<ts>`.
- Passive: `search.messages` for `to:me` / `<@UID>` mentions and DMs (`is:dm`) since cursor → `Extract.slack(msgs)` → queue.
- `Slack.search(query, sinceDate)` exported for Waiting evidence.
- Emoji name configurable (`SLACK_TODO_EMOJI`, default `todo`).

## Checks

- `runSummaryCheck` (daily): Calendar events in the last 7 days on Alex's calendars where Alex accepted (or is organiser), ≥ 1 other attendee, duration ≥ 10 min, not all-day, has a conferencing link or location. Match to Granola notes (listNotes created in window; match by `calendar_event_id` or start ±15 min + title similarity). Unmatched events = "no Granola note or no summary yet". Maintain ONE Todoist task in Me › Immediate titled `Open N Granola notes without summaries` (update content/description if exists — find via machine line key `check:summaries`; close it if N = 0). Description lists each event: title, date, calendar link (`event.getId()` based URL is fine to omit; include title + time) and `https://notes.granola.ai/` hint.
- `runTriageDigest` (daily): if pending queue count > 0, maintain ONE task in Me › Immediate `Triage N suggestions` with the web app URL, due today; close it when count = 0.

## Triage web app

- `doGet(e)` → `HtmlService.createTemplateFromFile('TriageUI')` evaluated, `setTitle('Todo Triage')`, `addMetaTag('viewport', 'width=device-width, initial-scale=1')`, `setXFrameOptionsMode(ALLOWALL)` not needed.
- Server functions (called via `google.script.run`): `triageList()` → `{items: pending queue items, sections: {GR:[…],…}, filtered: {count, examples}}`; `triageAct(id, action, patch)` where action ∈ `accept | dismiss | wait | move | edit | undup | undo` → performs the Todoist side effect and returns the updated item + a human message. `accept` on a dup (and not `notDuplicate`) → `addComment(dupTaskId, …)`; accept on `kind:"waiting"` → Waiting pipeline create; else create task in project/section. `undo` reverses the last action for that item where possible (delete created task / reopen / restore status) — keep an undo record in the item JSON.
- Feedback: dismiss / undup / edit / reroute append to `feedback`; `Extract.*` includes the 20 most recent dismissals as negative examples.
- UI: port the prototype's layout, theming and exact keymap: `j/k` move, `x` select, `s` accept, `1-4` GR/ISC/Me/SG, `v` project/section picker, `w` waiting, `e` dismiss, `u` not-a-duplicate toggle, `o` open source, `Enter` edit, `z` undo, `Esc` clears selection / closes overlays, `?` help, `f` filtered list. No `a` key. Optimistic UI with rollback on server error (toast the error). Works on phone (tap row → detail; buttons). Remove the "Prototype" badge and example items; show real data. Loading and empty states.

## Code.js (starred email) fixes

- Keep the entrypoint name and behaviour (task with subject + `@starred`, unstar after).
- Do not throw on one failed message: log, leave it starred, continue.
- Gmail link: `https://mail.google.com/mail/?authuser=<Session.getEffectiveUser().getEmail()>#all/<messageId>`.
- Add the machine line `<!-- ta:{"key":"gmail-star:<messageId>"} -->`.
- Fix the currently failing test in `__tests__/Code.test.js` if it's a test bug; if it's a code bug, fix the code.

## Removed

- Old `Fireflies.js` email parsing (recap emails, `FIREFLIES_*` props, Gmail label). Replace the file.
- The laptop Node job is outside this repo; README tells Alex to disable it once v2 runs.
- `.claspignore` must include all new root `.js` files and `TriageUI.html`, and exclude `docs/`, `__tests__/`.

## Webhooks (later phase — do not implement now)

Document in README: Granola webhook → small verifier (Cloudflare Worker) → calls the Apps Script web app with a shared secret to trigger `runMeetings` early. Polling stays as a fallback. Test plan: register endpoint, record short desktop + phone notes, observe event types and latency.

## Testing requirements

- Every module: unit tests with mocked services and realistic fixtures (use the real shapes above; Granola note fixtures based on the Sep 24 "Secure Copy/Paste Internal Sync" and "New note" meetings; Fireflies fixture with "Alex Blundell" action items that must NOT become Alex's).
- Critical behaviours with explicit tests: Alex Blundell exclusion; decisions/deferred items dropped; calendar routing beats domains; notes without calendar events route by content with ≤ low route confidence; ledger prevents reprocessing; cursor only advances past fully processed notes; deadline stop saves progress; one failing item doesn't abort the run; duplicate → queue not task; `not_duplicate` feedback suppresses a match; waiting auto-close vs resurface; summary-check single task maintained idempotently; triage accept/dismiss/undup/undo side effects.
- `npm test` and `npm run lint` must pass. Update `eslint.config.js` globals (all module globals + Apps Script services) and `package.json` lint script to cover all root `.js` files.
