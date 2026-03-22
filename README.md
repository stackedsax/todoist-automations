# Todoist Automations

[![CI](https://github.com/stackedsax/todoist-automations/workflows/CI/badge.svg)](https://github.com/stackedsax/todoist-automations/actions/workflows/ci.yml)
[![CodeQL](https://github.com/stackedsax/todoist-automations/workflows/CodeQL/badge.svg)](https://github.com/stackedsax/todoist-automations/actions/workflows/codeql.yml)
[![Security Audit](https://github.com/stackedsax/todoist-automations/workflows/Security%20Audit/badge.svg)](https://github.com/stackedsax/todoist-automations/actions/workflows/dependency-audit.yml)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

A collection of Google Apps Script automations that create Todoist tasks from various sources.

## Integrations

### Gmail Stars → Todoist
Watches for starred Gmail messages and creates a Todoist task for each one, including a link back to the original email and cleaned body text. Unstars the message after processing.

### Fireflies Meeting Recaps → Todoist
Watches for Fireflies.ai meeting recap emails (via Gmail label), extracts action items assigned to a configured person, and creates one Todoist task per action item. Routes tasks to different Todoist projects based on which email account received the recap.

## Shared Setup

Both integrations run as a single Google Apps Script project deployed via [clasp](https://github.com/google/clasp).

### 1. Clone this repository

```bash
git clone https://github.com/stackedsax/todoist-automations.git
cd todoist-automations
```

### 2. Install dependencies

```bash
npm install
```

### 3. Enable the Google Apps Script API

1. Go to https://script.google.com/home/usersettings
2. Turn on the **Google Apps Script API** toggle

### 4. Create and deploy the Apps Script project

```bash
npx clasp login
npx clasp create --title "Todoist Automations" --type standalone
npx clasp push
npx clasp open
```

### 5. Set your Todoist API token

1. Go to [Todoist Integrations](https://todoist.com/prefs/integrations) and copy your API token
2. In the Apps Script editor: **Project Settings → Script Properties**
3. Add property: `TODOIST_API_TOKEN` = your token

---

## Integration Setup

### Gmail Stars → Todoist

No additional configuration needed beyond the shared setup above.

**Create the trigger** — run this once in the Apps Script editor:
```javascript
createTrigger()
```
This creates a 1-minute time-based trigger for `createTaskFromStarred`.

**How it works:**
1. Searches Gmail for starred messages
2. Creates a Todoist task with the email subject + `@starred`
3. Includes a link to the original email and cleaned body text in the description
4. Unstars the email

---

### Fireflies Meeting Recaps → Todoist

#### Configuration

Run these one-time setup functions in the Apps Script editor.

**1. Create a setup wrapper function** (paste into the editor, run once, then delete):
```javascript
function setup() {
  setupFirefliesLabel();
  setFirefliesPersonName('Jane Smith');
  setFirefliesRouting([
    { "domain": "example.com", "project": "My Project", "section": "Generated Tasks" },
    { "domain": "other.com", "project": "Other Project" }
  ]);
}
```

- `setupFirefliesLabel()` creates a `Fireflies` Gmail label and prints filter instructions
- `setFirefliesPersonName()` sets whose action items to extract (case-insensitive substring match — `"Jane"` matches `"Jane Smith"`)
- `setFirefliesRouting()` maps sender email domains to Todoist projects/sections

The routing is based on the `To:` header of the incoming email, which Fireflies preserves even when emails are forwarded. Each routing rule can optionally specify a `section` — the section will be created automatically if it doesn't exist.

**2. Create a Gmail filter**

In Gmail Settings → Filters and Blocked Addresses → Create a new filter:
- **From:** `fred@fireflies.ai`
- **Apply label:** `Fireflies`

**3. Create the trigger** — run once in the Apps Script editor:
```javascript
createFirefliesTrigger()
```
This creates a 5-minute time-based trigger for `processFirefliesEmails`.

**How it works:**
1. Searches Gmail for unread messages with the `Fireflies` label
2. Extracts the Action Items section from each recap email
3. Filters action items assigned to the configured person
4. Creates one Todoist task per action item, routed to the correct project and section
5. Marks the email as read

Each task description includes:
- Meeting title
- Link to the Fireflies recap
- Link to the Gmail message
- Timestamp within the recording

---

## Local Development

```bash
# Push code changes to Apps Script
npx clasp push

# Open the Apps Script editor
npx clasp open
```

Files pushed to Apps Script:
- `Code.js` — Gmail Stars integration
- `Fireflies.js` — Fireflies integration
- `appsscript.json` — project manifest and OAuth scopes

## Troubleshooting

**"Todoist API token not found"** — set `TODOIST_API_TOKEN` in Script Properties

**"Fireflies person name not set"** — run `setFirefliesPersonName()` as described above

**Todoist project not found error** — the project name in `setFirefliesRouting()` must exactly match the name in Todoist (case-sensitive)

**Emails not being processed** — confirm the `Fireflies` Gmail label is applied to the emails and they are marked unread

**Tasks missing for long meetings** — timestamps longer than `mm:ss` (e.g. `1:02:34`) are handled correctly
