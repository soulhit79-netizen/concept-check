-- db/schema.sql - Supabase Postgres Schema for Concept Check
-- Safe to run multiple times (idempotent)

-- 1. Ideas
CREATE TABLE IF NOT EXISTS ideas (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title TEXT NOT NULL
);

-- 2. Cases
CREATE TABLE IF NOT EXISTS cases (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  idea_id INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  theme TEXT NOT NULL
);

-- 3. Key Points
CREATE TABLE IF NOT EXISTS key_points (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  text TEXT NOT NULL
);

-- 4. Learners
CREATE TABLE IF NOT EXISTS learners (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  consent BOOLEAN NOT NULL,
  tester_type TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 5. Explanations
CREATE TABLE IF NOT EXISTS explanations (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  learner_id INTEGER NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
  idea_id INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 6. Gaps
CREATE TABLE IF NOT EXISTS gaps (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  explanation_id INTEGER NOT NULL REFERENCES explanations(id) ON DELETE CASCADE,
  recited_sentence TEXT,
  type TEXT,
  hidden_assumption TEXT,
  followup_question TEXT NOT NULL,
  followup_outcome TEXT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Ensure columns exist on pre-existing gaps table
ALTER TABLE gaps ADD COLUMN IF NOT EXISTS type TEXT;
ALTER TABLE gaps ADD COLUMN IF NOT EXISTS hidden_assumption TEXT;
ALTER TABLE gaps ADD COLUMN IF NOT EXISTS followup_question TEXT NOT NULL DEFAULT '';
ALTER TABLE gaps ADD COLUMN IF NOT EXISTS followup_outcome TEXT NULL;

-- 7. Attempts
CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  learner_id INTEGER NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  gap_id INTEGER NULL REFERENCES gaps(id) ON DELETE SET NULL,
  answer_text TEXT NOT NULL,
  passed BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 8. Attempt Points (composite primary key)
CREATE TABLE IF NOT EXISTS attempt_points (
  attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  key_point_id INTEGER NOT NULL REFERENCES key_points(id) ON DELETE CASCADE,
  present BOOLEAN NOT NULL,
  evidence TEXT,
  PRIMARY KEY (attempt_id, key_point_id)
);

-- 9. Schema Migrations (tracks migration version)
CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  version TEXT UNIQUE NOT NULL,
  applied_at TIMESTAMPTZ DEFAULT now()
);

-- Enable Row Level Security (RLS) on all tables
-- Direct connection with server-side connection string bypasses RLS,
-- while anon/authenticated roles have no policies and cannot read/write.
ALTER TABLE ideas ENABLE ROW LEVEL SECURITY;
ALTER TABLE cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE key_points ENABLE ROW LEVEL SECURITY;
ALTER TABLE learners ENABLE ROW LEVEL SECURITY;
ALTER TABLE explanations ENABLE ROW LEVEL SECURITY;
ALTER TABLE gaps ENABLE ROW LEVEL SECURITY;
ALTER TABLE attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE attempt_points ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;
