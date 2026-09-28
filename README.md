# Todoist Automations

[![CI](https://github.com/stackedsax/todoist-automations/workflows/CI/badge.svg)](https://github.com/stackedsax/todoist-automations/actions/workflows/ci.yml)
[![CodeQL](https://github.com/stackedsax/todoist-automations/workflows/CodeQL/badge.svg)](https://github.com/stackedsax/todoist-automations/actions/workflows/codeql.yml)
[![Security Audit](https://github.com/stackedsax/todoist-automations/workflows/Security%20Audit/badge.svg)](https://github.com/stackedsax/todoist-automations/actions/workflows/dependency-audit.yml)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

A Google Apps Script project that captures your todos from meetings, email and Slack, and puts them in Todoist. You get the right project and section, no duplicates, and a fast keyboard triage screen for anything it isn't sure about. Everything runs on Google's servers, so nothing depends on your laptop.

The binding design spec is [`docs/DESIGN.md`](docs/DESIGN.md).

## What v2 does

| Source | How | Where it goes |
|---|---|---|
| **Granola** meeting notes (primary) | Polls the Granola public API every 10 min; reads summary + transcript (`speaker: me` = you) | Confident items go straight into a task; everything else goes to the triage queue |
| **Fireflies** (backup, optional) | Fireflies GraphQL API; merged with the Granola note of the same meeting | Same as Granola |
| **Starred Gmail** | Every minute, each starred message becomes an Inbox task `<subject> @starred`, then it is unstarred | Todoist Inbox |
| **Inbox sweep** | Daily at about 07:00, reads the last 2 days of inbox mail. Noise is filtered out first (no-reply senders, calendar replies, receipts, threads you already answered, mailing lists), then an LLM reads what's left | Triage queue only |
| **Slack** (ISC + GR-OSS) | A `:todo:` reaction from you makes a task straight away. Mentions and DMs are read by the LLM | `:todo:` makes a task; mentions and DMs go to the triage queue |
| **Waiting on others** | Items other people owe you go to a hidden `Waiting on others` project with a resurface date | Daily at about 07:30: auto-closed when email, Slack or meeting evidence shows it's done. Otherwise moved back to its real project as `Follow up with <name>: …`, due today |
| **Checks** | Daily at about 08:00: one task in Me › Immediate listing meetings that have no Granola summary. At about 08:15: one `Triage N suggestions` task linking to the web app | Me › Immediate |

Guarantees:

- **Only your items.** Other people's work is dropped. `Alex Blundell` is never treated as you. Decisions, FYIs and deferred items are dropped.
- **Routing.**
  - The calendar the meeting was on decides the project: `alex@gr-oss.io` is GR, `alex@insightsoftmax.com` is ISC, `alex@alexscammon.com` is Me.
  - If there's no calendar match, the attendees' email domains decide.
  - If neither works, the note's content decides, but that item always goes to triage.
  - Sections are read live from Todoist and are never created automatically.
- **No duplicates.**
  - A ledger in the state sheet records every source item it has processed.
  - Every task description ends with a machine line such as `<!-- ta:{"key":"granola:not_…"} -->`.
  - Each new item is compared with your open tasks. A likely duplicate goes to triage, where you can press `u` if it isn't one.
- **Nothing is skipped silently.** Job runs are recorded in the `runs` tab, and the summary check flags meetings that have no notes.

Trigger schedule (installed by `installTriggers`, script time zone America/Los_Angeles):

| Function | Schedule |
|---|---|
| `createTaskFromStarred` | every 1 min |
| `runMeetings` | every 10 min |
| `runSlack` | every 10 min (only when `SLACK_WORKSPACES` is set) |
| `runInboxSweep` | daily ~07:00 |
| `runWaiting` | daily ~07:30 |
| `runSummaryCheck` | daily ~08:00 |
| `runTriageDigest` | daily ~08:15 |
| `runBackfill` | manual only |

## Setup

### 1. Clone, install, push

```bash
git clone https://github.com/stackedsax/todoist-automations.git
cd todoist-automations
npm install
```

Turn on the **Google Apps Script API** at https://script.google.com/home/usersettings, then:

```bash
npx clasp login
npx clasp create --title "Todoist Automations" --type standalone   # first time only; skip if .clasp.json exists
npx clasp push
npx clasp open
```

`clasp push` uploads only the root `.js` files, `TriageUI.html` and `appsscript.json`, as listed in `.claspignore`. On the first run of any function, Apps Script asks you to authorize Gmail, Calendar, Sheets, external requests and triggers.

### 2. Script Properties

Open the Apps Script editor. Go to **Project Settings** (gear icon) › **Script Properties** › **Add script property**.

| Property | Required | Value |
|---|---|---|
| `TODOIST_API_TOKEN` | yes | Todoist › Settings › Integrations › Developer › API token |
| `GRANOLA_API_KEY` | yes | Granola **desktop app** › Settings › Connectors › API keys › create key (see below) |
| `ANTHROPIC_API_KEY` | yes | https://console.anthropic.com › Settings › API keys |
| `CLAUDE_MODEL` | yes | A current Anthropic model id, e.g. `claude-sonnet-4-5`. `checkSetup` checks that it exists |
| `FIREFLIES_API_KEY` | no | Fireflies › Settings › Developer settings › API key. Makes Fireflies a backup source |
| `SLACK_WORKSPACES` | no | JSON array, see [Slack](#3-slack-optional) |
| `SLACK_TODO_EMOJI` | no | Reaction name that means "make this a task" (default `todo`) |
| `ROUTING` | no | JSON merged over the default routing (projects, calendars, domains, sectionHints, neverUseSections) |
| `IDENTITY` | no | JSON merged over the default identity (myNames, notMe, myEmails, assistants) |
| `BACKFILL_DAYS` | no | Days `runBackfill` covers (default `28`) |
| `DIRECT_CONFIDENCE` | no | Lowest confidence that may create a task directly: `high` (default), `med`, `low` |
| `STATE_SHEET_ID` | auto | Set the first time the state spreadsheet is created |
| `TRIAGE_URL` | auto | Set by `checkSetup`/`installTriggers` from the deployed web app URL |

**Granola API key.**
1. In the Granola desktop app, open **Settings › Connectors › API keys**.
2. Create a key and copy it into `GRANOLA_API_KEY`.

The public API (`https://public-api.granola.ai/v1`) only returns notes that already have a generated summary. Meetings with no summary yet show up in the daily summary-check task.

**Anthropic.** Make an API key in the Anthropic Console, then set `CLAUDE_MODEL` to a model id you have access to. Every extraction call uses forced tool output, so the model must support tool use. All current models do.

### 3. Slack (optional)

Use one **user-token** app per workspace: ISC and GR-OSS. User tokens (`xoxp-…`) act as you, so they can see your reactions, your DMs and search results. A bot token can't.

1. Go to https://api.slack.com/apps › **Create New App** › *From scratch*. Name it something like `Todoist capture` and pick the workspace.
2. Open **OAuth & Permissions**. Under **User Token Scopes** (not Bot Token Scopes), add:
   `reactions:read`, `search:read`, `channels:history`, `groups:history`, `im:history`, `mpim:history`, `users:read`, `users:read.email`
   (`chat:write` is not needed; nothing is ever posted.)
3. Click **Install to Workspace**. GR-OSS may need admin approval. Then copy the **User OAuth Token** (`xoxp-…`).
4. Repeat for the other workspace.
5. Set `SLACK_WORKSPACES`. `project` is the default Todoist project for `:todo:` captures from that workspace:

```json
[{"name":"ISC","token":"xoxp-…","project":"ISC"},{"name":"GR-OSS","token":"xoxp-…","project":"GR"}]
```

`checkSetup` calls `auth.test` for each workspace and reports any missing scopes.

**Make `:todo:` a one-click reaction.**
1. If the workspace doesn't have a `:todo:` emoji yet, add a custom one: open the emoji picker › **Add Emoji**, and name it `todo`. If you pick a different name, set `SLACK_TODO_EMOJI` to it.
2. In Slack, click your profile picture › **Preferences** › **Messages & media** › **Emoji**.
3. Tick **Show one-click reactions on messages** and put `:todo:` in one of the three slots. It now shows up when you hover over any message.
4. Do this in both workspaces.

**Keyboard-only capture (macro tip).**
- `⌘⇧\` opens the reaction picker for the most recent message.
- When a message is focused (arrow keys), `R` opens the picker for that message.
- A Raycast, Keyboard Maestro or BetterTouchTool macro can chain these: `⌘⇧\`, type `todo`, press `Return`. Bound to one hotkey, that files the latest message as a task.

### 4. Deploy the triage web app

In the Apps Script editor: **Deploy › New deployment** › type **Web app**, *Execute as:* **Me**, *Who has access:* **Only myself** › **Deploy**. Bookmark the `/exec` URL (it also appears in the daily `Triage N suggestions` task). After changing code, `npx clasp push` and then **Deploy › Manage deployments › Edit › Version: New version** so the `/exec` URL serves the new code.

### 5. Run `checkSetup`

In the editor, select **`checkSetup`** and click **Run**, then read the execution log. It:

- lists missing required properties and invalid JSON properties;
- checks your Anthropic key and model, your Granola key, and each Slack workspace (token, scopes, project);
- checks that the Todoist projects GR, ISC, Me, SG and Inbox exist, and warns about missing expected sections (for example, Me › Immediate is used by the daily checks);
- **creates the `Waiting on others` project** and the labels `meeting`, `from-email`, `from-slack`, `waiting` and `check`;
- creates or opens the state spreadsheet, and saves `TRIAGE_URL`;
- reports which triggers are installed.

Fix every **Errors** line and run it again. **Warnings** don't block anything.

### 6. Run `runBackfill`

`runBackfill` goes through meeting notes from the last `BACKFILL_DAYS` (default 28). Everything it finds goes to the **triage queue**, marked with a `Backfill` chip, and nothing becomes a task directly. One execution has about 4.5 minutes, so it saves its place (kv `backfill.cursor`) and stops. **Run it again until the `runs` tab stops showing `backfill incomplete`.** Triage the results in the web app. The ledger stops the scheduled runs from processing those meetings again.

### 7. Run `installTriggers`

Select **`installTriggers`** › **Run**. You can run it as often as you like. Each time it:

- deletes this project's managed triggers, including the legacy `processFirefliesEmails` and any old `createTaskFromStarred` trigger;
- creates the schedule shown above;
- leaves triggers it doesn't manage alone.

`uninstallAllTriggers` removes every trigger in the project.

### 8. Retire the old setup

- **Disable the laptop Node job** once v2 has run cleanly for a day. Remove its `crontab -e` line or `launchctl unload` its LaunchAgent plist. Otherwise both systems create tasks.
- The v1 Fireflies email parsing is gone. You can delete the Gmail filter that labelled `fred@fireflies.ai` mail `Fireflies` (and the label), plus any old `FIREFLIES_*` Script Properties **except** `FIREFLIES_API_KEY`.

## Triage web app

Open the `/exec` URL. It shows pending suggestions with their source, the quote they came from, the reason they were suggested, the suggested project and section, and any possible duplicate. Changes appear on screen straight away and roll back with an error toast if the server call fails. On a phone, tap a row to open its details and use the buttons.

| Key | Action |
|---|---|
| `j` / `k` | move down / up |
| `x` | select (multi-select for bulk actions) |
| `s` | accept (create the task, or comment on the duplicate) |
| `1` `2` `3` `4` | set project GR / ISC / Me / SG |
| `v` | project/section picker |
| `w` | send to Waiting on others |
| `e` | dismiss |
| `u` | toggle "not a duplicate" |
| `o` | open the source (Granola, Fireflies, Gmail, Slack) |
| `Enter` | edit title/details |
| `z` | undo the last action on the item |
| `Esc` | clear selection / close overlays |
| `?` | help |
| `f` | show what the inbox sweep filtered out |

Dismissals, "not a duplicate" marks, edits and re-routes are saved to the `feedback` tab. Recent dismissals are shown to the extractor as negative examples, so it learns what you don't want.

## Webhooks (later phase, not implemented)

Polling every 10 minutes stays as the fallback. The planned fast path is:

1. **Granola webhook → small verifier** (a Cloudflare Worker). The Worker checks the webhook signature and drops anything unexpected.
2. The Worker calls the Apps Script web app with a **shared secret**. The web app checks the secret and triggers `runMeetings` early. The ledger makes an early run plus the regular poll harmless.
3. **Test plan:**
   1. Register the Worker endpoint in Granola.
   2. Record a short note on the desktop app and one on the phone.
   3. Log which event types arrive (created, summary ready, updated) and how long after the meeting ends.
   4. Confirm only the summary-ready event needs to trigger a run.

## Development

```bash
npm test        # jest (all modules, mocked Apps Script services: __tests__/helpers)
npm run lint    # eslint over root .js files and __tests__
npx clasp push  # upload to Apps Script
```

Apps Script rules for this repo:
- All root `.js` files share one global scope.
- No `require`, `import` or `module.exports` in production files.
- Each module exposes one global object.
- Trigger entrypoints are top-level `function` declarations.
- Private helpers end with `_`.

## Troubleshooting

Start with the **state spreadsheet**: `checkSetup` prints its URL, or look up `STATE_SHEET_ID`.

- **`runs` tab** has one row per job run, with these columns:
  - `at`: when the job ran
  - `job`: which job ran
  - `durationMs`: how long it took
  - `seen`, `created`, `queued`, `skipped`, `errors`: item counts for that run
  - `note`: extra detail
  - `createTaskFromStarred` runs every minute, so it writes a row only when it created or recovered a task, or when a failure first appears. The same failure repeating is written again at most every 6 hours; every attempt still shows in Executions.
  
  If `errors > 0` or the `note` says something like `backfill incomplete` or `deadline`, check **Executions** in the Apps Script editor for that time.
- **`ledger` tab** has one row per source item: a meeting, email thread or Slack message.
  - Items with outcome `error` are retried on the next run.
  - To force an item to be processed again, delete its row.
- **`queue` tab** holds the triage items. **`kv` tab** holds the cursors, e.g. `granola.updatedAfter` and `slack.<ws>.oldest`. Deleting a cursor makes that source start again from its default window. The ledger still prevents duplicates.

Common issues:

- **`Missing Script Property: X`**: add it under Project Settings › Script Properties, then run `checkSetup`.
- **`another run holds the lock; skipping`**: all jobs except `createTaskFromStarred` share one lock, so a run that starts while another job is still working (for example a long `runMeetings`) skips.
  - For `runMeetings` and `runSlack` this is harmless: they run again 10 minutes later and pick up the work.
  - For the daily jobs (`runInboxSweep`, `runWaiting`, `runSummaryCheck`, `runTriageDigest`) a skip means that job doesn't run until the same time tomorrow. If the `runs` tab has no row for one of them today, run it by hand from the editor.
- **A meeting produced nothing**: Granola only returns notes that have a generated summary. Open the note in Granola and let the summary finish, or check the daily *Open N Granola notes without summaries* task. The next `runMeetings` picks it up.
- **Task landed in the wrong project**: re-route it in triage (`1`-`4`/`v`); that's recorded as feedback. For a systematic fix, add the domain or calendar to `ROUTING`.
- **Section ignored**: sections are never created automatically. Create it in Todoist, then run `checkSetup`: it re-reads every project's section list and refreshes the shared cache, so the scheduled jobs use the new section from their next run. Without that, the cached list can be up to 6 hours old.
- **Slack `invalid_auth` / `missing_scope`**: reinstall the Slack app after adding the user scopes, then update the token in `SLACK_WORKSPACES`.
- **Starred email not turning into a task**: the message stays starred when task creation fails. Look for `[createTaskFromStarred] message … failed` in Executions.
- **Anthropic 404 / model errors**: `CLAUDE_MODEL` is no longer valid. Set a current model id and rerun `checkSetup`.
- **Changes to the web app don't show up**: publish a new version under Deploy › Manage deployments. `clasp push` alone only updates the `/dev` URL.
