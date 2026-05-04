# Dynamic Day Scheduler

A personal task management and daily planning app built for busy moms. Uses Claude AI to parse free-form notes into structured tasks and generate personalised session plans based on your energy, mood, time of day, and scheduling preferences. The system learns from your session history over time, adapting recommendations to your actual behaviour.

---

## Features

- **Free-form task ingestion** — paste or type notes in any format; Claude extracts and categorises each task automatically
- **Smart session planning** — AI selects the best tasks for your available time slot based on deadlines, priority, energy type, time of day, and mood
- **Preference-aware scheduling** — plain-language rules (e.g. "no deep work after 6pm") are passed directly to Claude as hard constraints
- **Learning system** — session logs are summarised and sent as context on every plan request, so Claude adapts to your skip patterns and neglected areas over time
- **Session tracking** — mark tasks as done or skipped during a session; completed sessions are logged and shown on the dashboard
- **Quick add** — add a single task instantly without AI parsing
- **Dashboard** — overview of open tasks by area, this week's deadlines, and today's completed tasks

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vanilla HTML/CSS/JS, localStorage |
| Backend | Node.js, Express |
| AI | Anthropic Claude API (`claude-opus-4-5`) |
| Storage | localStorage (browser) — see Roadmap for DB upgrade |

---

## Project Structure

```
dynamic-scheduler/
├── public/
│   └── index.html        # Frontend — all UI, state, and API calls
├── server.js             # Express backend — /api/parse and /api/plan endpoints
├── .env                  # API key (never commit this)
├── .gitignore
├── package.json
└── README.md
```

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org) v18+
- [VS Code](https://code.visualstudio.com)
- Anthropic API key from [console.anthropic.com](https://console.anthropic.com/settings/keys)

### Installation

```bash
# Clone or download the project folder, then:
cd dynamic-scheduler
npm install
```

### Configuration

Create a `.env` file in the root:

```
ANTHROPIC_API_KEY=sk-ant-api03-your-key-here
```

### Run

```bash
node server.js
```

Open your browser to [http://localhost:3000](http://localhost:3000).

---

## API Endpoints

### `POST /api/parse`

Parses free-form notes into structured tasks.

**Request body:**
```json
{ "notes": "Call pediatrician this week. Fix leaking tap asap." }
```

**Response:**
```json
{
  "tasks": [
    { "title": "Call pediatrician", "area": "kid", "priority": "high", "energy": "errand", "deadline": null, "notes": null },
    { "title": "Fix leaking tap", "area": "home", "priority": "high", "energy": "errand", "deadline": null, "notes": "asap" }
  ]
}
```

---

### `POST /api/plan`

Generates a session plan from open tasks, user preferences, and session history.

**Request body:**
```json
{
  "tasks": [...],
  "preferences": "No deep work after 6pm. Kid tasks before 3pm.",
  "minutes": 90,
  "timeOfDay": "morning",
  "mood": "focused",
  "sessionLogs": [...]
}
```

**Response:**
```json
{
  "plan": [
    { "id": "abc123", "reason": "Due today, high priority", "estimatedMin": 20 },
    { "id": "def456", "reason": "Best for morning deep focus", "estimatedMin": 30 }
  ]
}
```

---

## Task Schema

Each task object stored in localStorage:

| Field | Type | Values |
|-------|------|--------|
| `id` | string | auto-generated uid |
| `title` | string | task description |
| `area` | string | `kid`, `work`, `self`, `home` |
| `priority` | string | `high`, `med`, `low` |
| `energy` | string | `deep`, `light`, `errand` |
| `deadline` | string \| null | `YYYY-MM-DD` or `null` |
| `notes` | string \| null | brief context |
| `status` | string | `open`, `done` |
| `createdAt` | string | ISO timestamp |

---

## How the Learning System Works

On every `/api/plan` request, the server calls `buildSessionContext()` which summarises the last 14 days of session logs into three sections passed to Claude's system prompt:

1. **Recent sessions** — last 7 sessions with completed and skipped tasks labelled by area and energy type
2. **Skip patterns by time of day** — e.g. "morning: frequently skips deep (3x)" so Claude stops recommending deep work in slots where you consistently skip it
3. **Completion rate by area** — highlights neglected areas (under 40% completion) so Claude surfaces them proactively

The system improves meaningfully after roughly 5–7 sessions.

---

## Scheduling Logic

Tasks are scored by Claude using the following priority order:

1. Overdue deadlines (+100 pts)
2. Due today (+90 pts)
3. Due tomorrow (+70 pts)
4. Due within 3 days (+50 pts)
5. Priority: high (+40), med (+20), low (+5)
6. Energy fit for time of day and mood (+20/+10/+0)
7. User's custom scheduling rules (hard constraints)
8. Historical skip patterns (soft constraints via learning context)

---

## Roadmap

| Priority | Feature | Notes |
|----------|---------|-------|
| High | Replace localStorage with SQLite | Use `better-sqlite3`. Tasks and logs persist across devices and browser resets |
| High | Structured preferences UI | Time-block pickers that generate instruction text automatically |
| Med | Task editing | Click any task to edit title, area, deadline, priority inline |
| Med | Recurring tasks | `recurrence` field with weekly/daily auto-regeneration |
| Med | Mobile PWA | Add `manifest.json` + service worker so it installs on iPhone/Android |
| Low | Single-user auth | Password protection via `express-session` |
| Low | Morning digest | Daily push notification summarising due-today tasks |
| Low | Export | Download tasks and session history as CSV |

---

## Development with Claude Code

This project is designed to be extended using [Claude Code](https://claude.ai/code) in VS Code. Open the project folder in VS Code, launch the Claude Code panel, and describe features in plain English — Claude Code has full file context and can edit `server.js` and `index.html` directly.

Suggested prompts to get started:
- *"Add a SQLite database to persist tasks instead of localStorage"*
- *"Add an edit button to each task row on the dashboard"*
- *"Parse the preferences instructions into structured time blocks and pass them as JSON to /api/plan"*

---

## Security Notes

- Never commit `.env` — it is listed in `.gitignore`
- The Anthropic API key is only used server-side; it is never exposed to the browser
- localStorage data is browser-local and unencrypted — do not store sensitive personal information in task titles