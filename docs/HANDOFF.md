# Handoff: Todoist Automations v2

Branch: `overhaul/meeting-triage`. Contract: `docs/DESIGN.md`. UI reference: `docs/triage-prototype.html`.

## State
- All modules built per DESIGN.md, each reviewed adversarially and fixed. `npm test` and `npm run lint` pass at the last full run (514 tests).
- A cross-module check confirmed every `Module.fn(...)` call resolves and all trigger entrypoints exist.
- The planned integration test (`__tests__/Integration.test.js`) and final completeness critique did NOT run (usage limit).

## Last small edits (after the full test run; re-run tests first)
- Meetings.js / Slack.js: not-duplicate feedback now via `Dedupe.notDuplicateFeedback(200)` (honours undone undups).
- Util.withLock: daily jobs (inbox, waiting, summary check, digest) schedule a one-off 10-min retry when a frequent job holds the lock, instead of skipping a whole day.
- Triggers.js: `runBackfill` added to handlers installTriggers clears. Side effect: `checkSetup` now calls a pending backfill continuation a "legacy trigger" -- reword that warning.

## Remaining TODO
1. Run `npm test && npm run lint`; fix anything from the edits above; add tests for the lock retry.
2. Write `__tests__/Integration.test.js`: load all root files, end-to-end runMeetings with mocked Granola/Todoist/Claude HTTP (speaker "me" item -> direct task in right project/section with machine line; Alex Blundell item -> nothing; waiting item -> queued; second run -> no new tasks), plus triage accept of a queued item.
3. Walk DESIGN.md section by section for gaps.
4. Verify against live docs (were blocked from the build sandbox): Todoist API v1 endpoints (close/move/filter/comments, label auto-create) and Anthropic Messages tool_choice.
5. Known minor open items: Extract dismissal examples still count undone dismissals; Fireflies listSince could pass `transcriptGraceMs` to cut API calls (check Fireflies plan limits, Free = 50 req/day); tasks completed from a failed earlier attempt could be recreated on retry (rare).

## Deploy (Alex)
Script Properties: TODOIST_API_TOKEN, ANTHROPIC_API_KEY, CLAUDE_MODEL=claude-sonnet-5, GRANOLA_API_KEY, FIREFLIES_API_KEY, SLACK_WORKSPACES. Then per README: `clasp push`, deploy web app, `checkSetup`, `runBackfill`, `installTriggers`, disable the old laptop Node job.

## Pushing from Cowork
Cloud sessions can't push to this repo. Working route: connect `~/dev/todoist-automations` and `~/dev/.claude-git`, move commits over with a git bundle, push from the Mac shell with a read-only credential helper reading `~/dev/.claude-git/git-credentials-todoist-automations` (never `credential.helper store`, which writes junk entries into that file).
