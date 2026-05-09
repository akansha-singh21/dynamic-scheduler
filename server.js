require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();

app.use(cors());
app.use(express.json());

// Prevent browser from caching HTML so clients always get the latest version
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});

app.use(express.static('public'));

const TODAY = () => new Date().toISOString().slice(0, 10);
const TOMORROW = () => new Date(Date.now() + 86400000).toISOString().slice(0, 10);

// ── helper: summarise session logs into readable context ─────
// logs shape: [{date, timeOfDay, slotMinutes, completedIds, skippedIds}]
// tasks shape: [{id, title, area, energy, priority, ...}]
function buildSessionContext(logs, tasks) {
  if (!logs || !logs.length) return 'No session history yet.';

  // only use last 14 days of logs
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 14);
  const recent = logs.filter(s => new Date(s.date) >= cutoff);
  if (!recent.length) return 'No sessions in the last 14 days.';

  // build a lookup map for task details
  const taskMap = {};
  tasks.forEach(t => { taskMap[t.id] = t; });

  // aggregate pattern signals
  const skipsByTimeOfDay = {};   // { morning: { deep: 2, light: 1 }, ... }
  const skipsByArea = {};        // { work: 3, home: 1, ... }
  const completesByTimeOfDay = {};
  const completesByArea = {};
  const totalByArea = {};

  recent.forEach(s => {
    const slot = s.timeOfDay || 'unknown';
    if (!skipsByTimeOfDay[slot]) skipsByTimeOfDay[slot] = {};
    if (!completesByTimeOfDay[slot]) completesByTimeOfDay[slot] = {};

    (s.skippedIds || []).forEach(id => {
      const t = taskMap[id];
      if (!t) return;
      skipsByTimeOfDay[slot][t.energy] = (skipsByTimeOfDay[slot][t.energy] || 0) + 1;
      skipsByArea[t.area] = (skipsByArea[t.area] || 0) + 1;
      totalByArea[t.area] = (totalByArea[t.area] || 0) + 1;
    });

    (s.completedIds || []).forEach(id => {
      const t = taskMap[id];
      if (!t) return;
      completesByTimeOfDay[slot][t.energy] = (completesByTimeOfDay[slot][t.energy] || 0) + 1;
      completesByArea[t.area] = (completesByArea[t.area] || 0) + 1;
      totalByArea[t.area] = (totalByArea[t.area] || 0) + 1;
    });
  });

  // build human-readable summary lines
  const lines = [];

  // recent session list (last 7, most recent first)
  lines.push('=== Recent sessions (last 7) ===');
  [...recent].reverse().slice(0, 7).forEach(s => {
    const done = (s.completedIds || [])
      .map(id => taskMap[id])
      .filter(Boolean)
      .map(t => `${t.title} [${t.area}/${t.energy}]`);
    const skipped = (s.skippedIds || [])
      .map(id => taskMap[id])
      .filter(Boolean)
      .map(t => `${t.title} [${t.area}/${t.energy}]`);
    lines.push(
      `${s.date} ${s.timeOfDay} ${s.slotMinutes}min` +
      (done.length ? ` | completed: ${done.join(', ')}` : '') +
      (skipped.length ? ` | skipped: ${skipped.join(', ')}` : '')
    );
  });

  // skip patterns by time of day
  lines.push('\n=== Skip patterns by time of day ===');
  const slots = ['morning', 'afternoon', 'evening'];
  slots.forEach(slot => {
    const skips = skipsByTimeOfDay[slot] || {};
    const entries = Object.entries(skips).sort((a, b) => b[1] - a[1]);
    if (entries.length) {
      lines.push(`${slot}: frequently skips ${entries.map(([e, n]) => `${e} (${n}x)`).join(', ')}`);
    }
  });

  // completion rate by area
  lines.push('\n=== Completion rate by area ===');
  Object.keys(totalByArea).forEach(area => {
    const done = completesByArea[area] || 0;
    const total = totalByArea[area];
    const rate = Math.round((done / total) * 100);
    lines.push(`${area}: ${rate}% completion rate (${done}/${total} tasks)`);
  });

  // neglected areas (low completion or rarely scheduled)
  const neglected = Object.entries(completesByArea)
    .filter(([area, done]) => {
      const total = totalByArea[area] || 0;
      return total > 0 && done / total < 0.4;
    })
    .map(([area]) => area);
  if (neglected.length) {
    lines.push(`\nNeglected areas (under 40% completion): ${neglected.join(', ')} — consider surfacing these.`);
  }

  return lines.join('\n');
}

// ── JSON parse helper ────────────────────────────────────────
// Claude sometimes embeds literal newline/tab characters inside JSON string
// values (invalid JSON), or omits double-quotes around property names.
// Walk the raw text once to fix control characters inside strings, then
// parse; if that still fails, quote any bare property names and retry.
function parseClaudeJSON(text) {
  const stripped = text.replace(/```json|```/g, '').trim();

  // Pass 1: escape literal control characters inside string values
  let s = '';
  let inString = false;
  let esc = false;
  for (const c of stripped) {
    if (esc) { s += c; esc = false; continue; }
    if (c === '\\' && inString) { s += c; esc = true; continue; }
    if (c === '"') { s += c; inString = !inString; continue; }
    if (inString && (c === '\n' || c === '\r')) { s += '\\n'; continue; }
    if (inString && c === '\t') { s += '\\t'; continue; }
    s += c;
  }

  // Pass 2: direct parse
  try { return JSON.parse(s); } catch {}

  // Pass 3: quote bare property names (e.g. {key: "v"} → {"key": "v"})
  const repaired = s.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":');
  return JSON.parse(repaired);
}

// ── helpers for /api/parse ───────────────────────────────────
function extractMinutesFromText(text) {
  if (!text) return null;
  if (/\ban\s+hour\b/i.test(text)) return 60;
  if (/\bhalf[\s-]*(?:an?\s*)?hour\b/i.test(text)) return 30;
  // hours: "1 hr", "1.5 hours", "1-hour"
  const hrM = text.match(/(?:~|about|approx\.?\s*|around\s+)?(\d+(?:\.\d+)?)\s*[-]?\s*(?:hours|hour|hrs|hr)\b/i);
  if (hrM) return Math.round(parseFloat(hrM[1]) * 60);
  // minutes: "45 min", "45 mins", "45-minute", "~30 minutes"
  const minM = text.match(/(?:~|about|approx\.?\s*|around\s+)?(\d+(?:\.\d+)?)\s*[-]?\s*(?:minutes|minute|mins|min)\b/i);
  if (minM) return Math.round(parseFloat(minM[1]));
  // bare "m": "10m"
  const mM = text.match(/\b(\d+)m\b/i);
  if (mM) return parseInt(mM[1]);
  return null;
}

function inferFallbackMinutes(task) {
  const text = ((task.title || '') + ' ' + (task.area || '')).toLowerCase();
  if (/\b(call|reply|email|text|pay|message|ping)\b/.test(text)) return 10;
  if (/\b(schedule|book|order|confirm|cancel|rsvp)\b/.test(text)) return 15;
  if (/\b(clean|laundry|kitchen|dishes|vacuum|tidy|mop|sweep)\b/.test(text)) return 30;
  if (/\b(review|paperwork|form|admin|invoice|bill|insurance|document)\b/.test(text)) return 30;
  if (/\b(write|draft|plan|research|report|analysis|strategy|prepare)\b/.test(text)) return 60;
  if (/\b(errand|shop|pickup|drop|store|grocery)\b/.test(text)) return 45;
  return 20;
}

function normalizeParsedTask(task, rawLines) {
  const src = task.sourceText || task.sourcetext || task.raw || '';
  // try extraction on sourceText first
  let explicit = extractMinutesFromText(src);
  // if sourceText was stripped by Claude, search original note lines for this task
  if (explicit === null && rawLines?.length) {
    const titleNorm = (task.title || '').toLowerCase().slice(0, 25);
    const matchLine = rawLines.find(l => titleNorm && l.toLowerCase().includes(titleNorm));
    if (matchLine) explicit = extractMinutesFromText(matchLine);
  }
  if (explicit !== null) {
    return { ...task, estimatedMinutes: explicit, estimateSource: 'user_provided', sourceText: src };
  }
  // try all field names Claude might use
  const raw = task.estimatedMinutes ?? task.estimatedMin ?? task.estimated_minutes ??
              task.durationMinutes ?? task.minutes ?? task.duration ?? null;
  const asNum = typeof raw === 'number' ? raw : parseInt(raw);
  if (asNum > 0 && !isNaN(asNum)) {
    return { ...task, estimatedMinutes: asNum, estimateSource: task.estimateSource || 'claude_inferred', sourceText: src };
  }
  // keyword-based safety fallback — never return null
  return { ...task, estimatedMinutes: inferFallbackMinutes(task), estimateSource: 'claude_inferred', sourceText: src };
}

// ── POST /api/parse ──────────────────────────────────────────
app.post('/api/parse', async (req, res) => {
  const { notes, sourceLines } = req.body;
  if (!notes) return res.status(400).json({ error: 'No notes provided' });

  const userApiKey = req.headers['x-anthropic-api-key'];
  const apiKey = userApiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(401).json({ error: 'Claude API key required for personalized planning.' });
  const client = new Anthropic({ apiKey });

  // build structured user content when sourceLines are provided (preferred path)
  const userContent = sourceLines?.length
    ? 'Extract tasks from these source lines. Copy the sourceId exactly as given for each task:\n' +
      JSON.stringify(sourceLines.map(sl => ({ sourceId: sl.sourceId, text: sl.sourceText })))
    : notes;

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      system: `You are a task parser for a busy mom. Extract every distinct task from notes.
Return ONLY a raw JSON array — no markdown, no explanation.
Each element has exactly these fields:
  sourceId     copy exactly from the input sourceId for this line (e.g. "line_0")
  title        string — task description only, without time estimates or due date annotations
  area         one of: kid, home, self, work
  priority     one of: high, med, low
  energy       one of: deep, light, errand
  deadline     string YYYY-MM-DD, or null
  notes        string or null
  sourceText   the original full source line this task came from
  estimatedMinutes  positive integer — NEVER null, NEVER omitted
  estimateSource    "user_provided" or "claude_inferred"

Today is ${TODAY()}. Tomorrow is ${TOMORROW()}.

sourceId rules:
- Each source line has a sourceId (e.g. "line_0", "line_1").
- Copy the sourceId from the matching input line into every task that comes from it.
- Do not invent or modify sourceIds.

estimatedMinutes rules:
1. If sourceText contains an explicit duration, extract it as whole minutes and set estimateSource "user_provided".
   Examples: "10 min"→10, "45 mins"→45, "1 hr"→60, "1.5 hours"→90, "an hour"→60, "half hour"→30.
2. Otherwise infer a realistic estimate and set estimateSource "claude_inferred".
   Use variation — quick call/email → 5–10 | admin/schedule → 15–20 |
   household chore → 25–40 | review/paperwork → 30–45 | write/plan/research → 45–90 | default → 20.
3. estimatedMinutes must be a positive integer. Never null. Never omit it.

Return only the JSON array starting with [`,
      messages: [{ role: 'user', content: userContent }]
    });

    const parsed = parseClaudeJSON(message.content[0].text);
    // accept both [...] and {"tasks":[...]} shapes from Claude
    const rawTasks = Array.isArray(parsed) ? parsed : (parsed.tasks || []);
    // use provided source line texts for server-side normalization fallback
    const rawLines = sourceLines?.map(sl => sl.sourceText) ||
                     notes.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const tasks = rawTasks.map(task => normalizeParsedTask(task, rawLines));
    console.log('[parse] outgoing tasks', tasks.map(t => ({
      title: t.title,
      estimatedMinutes: t.estimatedMinutes,
      estimateSource: t.estimateSource,
      sourceText: t.sourceText
    })));
    res.json({ tasks });
  } catch (err) {
    console.error('/api/parse error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/plan ───────────────────────────────────────────
app.post('/api/plan', async (req, res) => {
  const { tasks, preferences, minutes, timeOfDay, mood, sessionLogs, realtimeInput } = req.body;
  if (!tasks?.length) return res.status(400).json({ error: 'No tasks provided' });

  const userApiKey = req.headers['x-anthropic-api-key'];
  const apiKey = userApiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(401).json({ error: 'Claude API key required for personalized planning.' });
  const client = new Anthropic({ apiKey });

  const normalizedMood = { good: 'default', tired: 'low-energy', scattered: 'hard-to-focus' }[mood] || mood || 'default';

  const MOOD_DEFS = {
    default:          'Balanced planning; prioritize important, timely tasks without special energy or focus constraints.',
    focused:          'Prefer deeper, more cognitively demanding tasks if they fit the available time. Good for writing, planning, strategy, complex admin, or decision-heavy tasks.',
    'low-energy':     'Prefer low-effort, routine, mechanical, or emotionally easy tasks; avoid sustained thinking or complex decisions. Okay to suggest fewer tasks.',
    'hard-to-focus':  'Prefer very short, clearly bounded tasks; break larger tasks into small first steps; avoid vague or open-ended tasks. Good for one email, one call, or a 5-minute starter task.'
  };
  const moodDef = MOOD_DEFS[normalizedMood] || MOOD_DEFS.default;

  const historyContext = buildSessionContext(sessionLogs || [], tasks);

  // build real-time context block — only included if user provided input
  const realtimeBlock = realtimeInput
    ? `=== REAL-TIME CONTEXT (HIGHEST PRIORITY — overrides all other rules) ===
The user has provided the following in-the-moment context. Apply it as a hard constraint, not a preference.

"${realtimeInput}"

CATEGORY/AREA RESTRICTIONS — treat these as strict exclusive filters:
- If the user says they want tasks from a specific category or area (e.g. "only kid tasks", "just work stuff", "home tasks only"), you MUST only return tasks where the area field matches. Do not include any task from any other area, even if it is overdue, high priority, or urgent. Zero exceptions.
- Valid area values: kid, work, self, home. Map the user's words to the closest match (e.g. "kids" → kid, "family" → kid, "personal" → self, "chores" → home).

Other constraints to apply strictly:
- If they mention a hard time constraint (e.g. "45 min nap window"), keep total time under that
- If they mention stress about a specific task, surface it even if not top-scored
- If they mention an upcoming commitment, avoid tasks that would run over into it
- If they mention low energy despite mood selection, treat as Low Energy
`
    : null;

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: `You are a personal day scheduler for a busy mom.
Select the best tasks for the current time slot and return ONLY a raw JSON array — no markdown, no explanation.
Up to 6 items: [{"id":"...","reason":"max 12 words why this fits now","estimatedMin":30}]

${realtimeBlock || '=== REAL-TIME CONTEXT ===\nNo real-time input provided. Use scheduling rules and learning context below.'}

=== USER'S SCHEDULING RULES ===
${preferences || 'No custom rules set.'}

=== MOOD / ENERGY CONTEXT ===
The user selected: ${normalizedMood}
${moodDef}

Mood-based planning rules:
- Do not treat "Low Energy" and "Hard to focus" as the same.
- Low Energy: optimize for low effort — avoid tasks requiring sustained thinking or complex decisions.
- Hard to focus: optimize for short duration and clarity — avoid vague or open-ended tasks; prefer tasks with an obvious start and end.
- Focused: optimize for importance and depth — prefer longer, cognitively demanding tasks if they fit the block.
- Default: use balanced prioritization — no special energy or focus constraints.
- In each returned task reason, briefly explain why the task fits the selected mood.

=== GENERAL SCHEDULING GUIDANCE ===
- Prioritise overdue and due-today deadlines above all else
- Match task energy type to time of day (morning=deep, afternoon=errand, evening=light)
- Total estimated minutes across all picked tasks MUST NOT exceed ${minutes}. This is a hard limit — do not select tasks whose combined estimatedMin would exceed it.
- If a task has estimatedMinutes, use it as-is in your estimatedMin response field; if estimateSource is "user_provided" treat it as a hard constraint. Only estimate freely when estimatedMinutes is absent.
- Balance areas — avoid picking more than 2 tasks from the same area unless urgent
- Today is ${TODAY()}

=== LEARNING CONTEXT (lowest priority — use to personalise but do not override above) ===
${historyContext}

Use the learning context to:
- Avoid suggesting energy types the user consistently skips at this time of day
- Surface neglected areas that haven't been getting done
- Adjust estimated task times based on observed patterns
- Avoid repeating tasks skipped multiple times without explanation

Return only the JSON array starting with [`,
      messages: [{
        role: 'user',
        content: `Time slot: ${minutes} minutes, ${timeOfDay}. Mood: ${normalizedMood}.
Open tasks: ${JSON.stringify(tasks.map(t => ({
  id: t.id,
  title: t.title,
  area: t.area,
  priority: t.priority,
  energy: t.energy,
  deadline: t.deadline,
  estimatedMinutes: t.estimatedMinutes || null
})))}`
      }]
    });

    const plan = parseClaudeJSON(message.content[0].text);
    res.json({ plan });
  } catch (err) {
    console.error('/api/plan error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── start ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Scheduler running at http://localhost:${PORT}`));