# Concept Check

**Concept Check** is a web application designed to help learners deeply understand Module 2 software architecture concepts. Instead of rewarding memorized definitions or superficial buzzwords, the system:
1. Identifies the exact sentence where a learner stopped reasoning and started reciting a phrase.
2. Formulates **one targeted follow-up question** about what breaks or what happens step by step.
3. Tests the learner against a fresh scenario on a different theme.
4. **Code decides pass/fail** against an objective key point checklist—never an AI's subjective impression of whether someone "understands".

---

## Architecture: How the Pieces Connect

The project connects pedagogical theory with strict, deterministic code evaluation backed by Supabase Postgres:

```
[Learner Explanation]
        │
        ▼ (Job A: llm.js + prompts.js)
  Find Recited Sentence & Hidden Assumption
  (No follow-up generated here)
  Store in `gaps` table with followup_question = ""
        │
        ▼
   [Case 1: "Before"] ──► Unseen case from same concept
        │
        ▼ (Job B: llm.js + prompts.js)
  Strict Key Point Extraction (verbatim quotes)
        │
        ▼
    [judge.js] ──► CODE evaluates: passed = ALL key points present
        │
  ┌─────┴────────────────────────┐
  ▼                              ▼
(Passed)                       (Failed)
"Case 1 passed.                Job C generates targeted follow-up.
No gap found on this one."     Quoted Recited Sentence displayed.
Optional Challenge Case        ONE Follow-up Question asked.
offered on different theme     Learner submits response to followup_outcome.
(gap_id = NULL)                 (Ungraded reflection)
                                 │
                                 ▼
                           [Case 2: "After"] ──► Unseen case from DIFFERENT theme
                                 │
                                 ▼
                           Attempt saved with `gap_id` set!
                           (This retry -> gap link is the core proof of transfer)
                                 │
                                 ▼
                           [Result Screen]
                           Plain summary: Case 1: not passed (X of Y). Follow-up asked.
                           Case 2: passed (X of Y).
                           Appends transfer note only if retry passed.
```

- **Server-Side Only LLM**: All Groq API calls occur exclusively on the server (`server/llm.js`). No keys are exposed to the browser.
- **Supabase Postgres Database**: Connected via Node `pg.Pool` over SSL with row-level security (RLS) enabled on all tables.
- **Strict Anonymity**: No real names are stored. Learners receive auto-generated anonymous codes (`L-001`, `L-014`).
- **SQL-Powered Insights**: `/insights.html` reads directly from Supabase Postgres with pure SQL queries (pass rates, most missed key points, recitation frequencies, and closed gaps).

---

## Directory Structure

```
concept-check/
├── db/
│   └── schema.sql        # Postgres DDL: 9 tables, IDENTITY primary keys, RLS enabled
├── server/
│   ├── index.js          # Express app, async routes, /api/health with DB & LLM check
│   ├── db.js             # PostgreSQL connection pool (pg.Pool) with SSL and query helper
│   ├── migrate.js        # Migration runner executing db/schema.sql idempotently
│   ├── reset-db.js       # Safe table drop (CASCADE) with confirmation prompt & recreate
│   ├── seed-data.js      # 7 Module 2 concepts with blurbs, 35 cases, and key points
│   ├── seed.js           # Idempotent Postgres upsert seeder reading from seed-data.js
│   ├── llm.js            # Groq SDK integration, defensive JSON parsing, retry & validators
│   ├── prompts.js        # Isolated prompt templates for Job A, Job B, and Job C
│   └── judge.js          # Objective code-level pass/fail evaluation and case selection
├── public/
│   ├── index.html        # Single-page learner flow with DB and LLM status pills
│   ├── app.js            # Frontend state machine, health check, idea cards & UI logic
│   ├── styles.css        # Clean, responsive CSS with status badges and cards
│   ├── insights.html     # Real-time metrics dashboard with concept idea filter
│   └── insights.js       # SQL insights fetch and filter rendering
├── tests/
│   ├── vague-answers.test.js # Test script for strict rejection of vague answers
│   └── followup-leak.test.js # Leak test verifying Job C does not leak absent key points
├── .env.example          # Environment variable template with DATABASE_URL instructions
├── .gitignore            # Ignores .env, node_modules, and local database files
├── package.json          # Dependencies and scripts (migrate, seed, reset-db, test, start)
└── README.md             # Project documentation and setup guide
```

---

## Supabase Postgres Setup

### 1. Create a Supabase Project
1. Log in to your [Supabase Dashboard](https://supabase.com).
2. Click **New Project**, choose an organization, name your project (e.g., `concept-check`), set a database password, and select your preferred region.

### 2. Copy the Connection String
1. In the Supabase project dashboard, navigate to **Project Settings** > **Database**.
2. Scroll to **Connection string** and select the **URI** tab.
3. Copy the URI string:
   ```
   postgresql://postgres.[YOUR-PROJECT-REF]:[YOUR-PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres
   ```
   *(or the direct connection on port `5432`)*.
4. Replace `[YOUR-PASSWORD]` with the database password you created in step 1.

### 3. Configure `.env`
Copy `.env.example` to `.env` and paste your connection string:

```bash
cp .env.example .env
```

Edit `.env`:
```env
# Groq API Key
GROQ_API_KEY=gsk_...

# Chat model supporting JSON mode
LLM_MODEL=qwen/qwen3.8-27b

# Supabase Postgres connection string (Server-side only. Never expose to the browser.)
DATABASE_URL=postgresql://postgres.[REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres

# Server Port
PORT=3000
```

> **Security Note**: Never commit `.env` to source control. `.env` is listed in `.gitignore`.

---

## Setup & Run Steps

### 1. Install dependencies
```bash
npm install
```

### 2. Run Database Migrations
Runs `db/schema.sql` to create all 9 tables with IDENTITY columns and enable Row Level Security (safe to run multiple times):
```bash
npm run migrate
```

### 3. Seed Database
Seeds 7 Module 2 architectural concepts, 35 cases, and 75 key points (idempotent upsert):
```bash
npm run seed
```

### 4. Start the Application
```bash
npm start
```
Open **[http://localhost:3000](http://localhost:3000)** in your browser.

- **Main Practice Flow**: `http://localhost:3000` (shows live DB & LLM status pills in the header)
- **Insights & Metrics Dashboard**: `http://localhost:3000/insights.html`
- **Health Check Endpoint**: `http://localhost:3000/api/health`

---

## Database Reset

To reset the database tables, run:
```bash
npm run reset-db
```
This prompts for explicit confirmation (`y/N`), drops all tables using `CASCADE`, and re-runs migration. To bypass the prompt in automated CI pipelines, pass `--yes`:
```bash
npm run reset-db -- --yes
```

---

## Testing

Run both test suites with:
```bash
npm test
```

This runs:
1. `tests/vague-answers.test.js`: Verifies the key-point checker strictly marks vague phrases (`"they can hack it"`, `"for security reasons"`, `"it's about storage"`, etc.) as absent across cases.
2. `tests/followup-leak.test.js`: Verifies that AI Job C follow-up questions end in exactly one `?`, contain zero banned phrases (`think about`, `consider`, `remember`), and do not leak absent key points.

---

## Deployment Notes

When deploying to platforms such as Render, Railway, Fly.io, or AWS:
1. **Set Environment Variables on the Host**:
   - `DATABASE_URL`: Your Supabase connection string.
   - `GROQ_API_KEY`: Your Groq API key from [console.groq.com](https://console.groq.com).
   - `LLM_MODEL`: Set to `qwen/qwen3.8-27b` (or your active Groq chat model).
   - `PORT`: Automatically set by most PaaS hosts (defaults to 3000).
2. **Never check secrets into Git**: Keep `.env` strictly local.
3. **Build & Release Command**:
   ```bash
   npm run migrate && npm run seed && npm start
   ```

---

## Database Schema Reference (Postgres)

- `ideas(id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY, title TEXT)`
- `cases(id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY, idea_id REFERENCES ideas, prompt TEXT, theme TEXT)`
- `key_points(id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY, case_id REFERENCES cases, text TEXT)`
- `learners(id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY, code TEXT UNIQUE, consent BOOLEAN, tester_type TEXT, created_at TIMESTAMPTZ DEFAULT now())`
- `explanations(id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY, learner_id REFERENCES learners, idea_id REFERENCES ideas, text TEXT, created_at TIMESTAMPTZ DEFAULT now())`
- `gaps(id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY, explanation_id REFERENCES explanations, recited_sentence TEXT, type TEXT, hidden_assumption TEXT, followup_question TEXT, followup_outcome TEXT, created_at TIMESTAMPTZ DEFAULT now())`
- `attempts(id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY, learner_id REFERENCES learners, case_id REFERENCES cases, gap_id INTEGER NULL REFERENCES gaps, answer_text TEXT, passed BOOLEAN, created_at TIMESTAMPTZ DEFAULT now())`
- `attempt_points(attempt_id REFERENCES attempts, key_point_id REFERENCES key_points, present BOOLEAN, evidence TEXT, PRIMARY KEY(attempt_id, key_point_id))`
- `schema_migrations(id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY, version TEXT UNIQUE, applied_at TIMESTAMPTZ DEFAULT now())`
