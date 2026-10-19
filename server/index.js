// server/index.js - Express backend application and API routes with Supabase Postgres
require('dotenv').config();
const express = require('express');
const path = require('path');
const { getPool, query, checkDbConnection } = require('./db');
const { seedDatabase } = require('./seed');
const SEED_DATA = require('./seed-data');
const { findRecitedSentence, checkKeyPoints, writeFollowupQuestion, hasValidApiKey } = require('./llm');
const { recordAttemptAndJudge, getUnseenCase1, getUnseenCase2, getCaseWithKeyPoints } = require('./judge');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Optional auto-seed on startup if DB is connected and empty
(async () => {
  if (process.env.DATABASE_URL) {
    try {
      const dbCheck = await checkDbConnection();
      if (dbCheck.ok) {
        const pool = getPool();
        const tableCheck = await pool.query(`
          SELECT to_regclass('public.ideas') as exists;
        `);
        if (tableCheck.rows[0].exists) {
          const countRes = await pool.query('SELECT COUNT(*)::int as cnt FROM ideas');
          if (countRes.rows[0].cnt === 0) {
            console.log('Database connected and empty. Seeding initial data...');
            await seedDatabase();
          }
        }
      }
    } catch (err) {
      console.warn('[Startup DB Check]', err.message);
    }
  }
})();

// --- API ROUTES ---

/**
 * Health check & configuration status
 * Reports both LLM and DB status
 */
app.get('/api/health', async (req, res) => {
  const dbCheck = await checkDbConnection();
  const llmConfigured = hasValidApiKey();

  const isHealthy = dbCheck.ok && llmConfigured;

  res.status(200).json({
    status: isHealthy ? 'ok' : 'degraded',
    db: {
      status: dbCheck.ok ? 'connected' : 'disconnected',
      error: dbCheck.error || null
    },
    supabase: {
      status: (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) ? 'configured' : 'not_set',
      project_url: process.env.SUPABASE_URL || null,
      project_ref: 'wlyyyvookdbhdlimnbrq'
    },
    llm: {
      status: llmConfigured ? 'configured' : 'missing_key',
      provider: 'Groq',
      model: process.env.LLM_MODEL || 'qwen/qwen3.8-27b'
    }
  });
});

// Alias for backwards compatibility
app.get('/api/status', async (req, res) => {
  const dbCheck = await checkDbConnection();
  res.json({
    status: dbCheck.ok ? 'ok' : 'degraded',
    llm_provider: 'Groq',
    llm_model: process.env.LLM_MODEL || 'qwen/qwen3.8-27b',
    has_api_key: hasValidApiKey(),
    db_connected: dbCheck.ok
  });
});

/**
 * Create a learner with consent and auto-generated code (e.g. L-001, L-014)
 * No real names stored anywhere.
 */
app.post('/api/learners', async (req, res, next) => {
  try {
    const { consent, tester_type } = req.body;

    if (!consent) {
      return res.status(400).json({ error: 'Consent is required to participate.' });
    }

    const pool = getPool();
    // Generate auto code like L-001, L-014
    const maxRes = await pool.query('SELECT COALESCE(MAX(id), 0) as max_id FROM learners');
    const nextNum = Number(maxRes.rows[0].max_id) + 1;
    const code = `L-${String(nextNum).padStart(3, '0')}`;

    const insertRes = await pool.query(`
      INSERT INTO learners (code, consent, tester_type)
      VALUES ($1, $2, $3)
      RETURNING *
    `, [code, Boolean(consent), tester_type || 'classmate']);

    res.status(201).json(insertRes.rows[0]);
  } catch (err) {
    next(err);
  }
});

/**
 * Get all available Module 2 ideas in seed-data.js array order
 * Merges blurb from seed-data.js (not stored in db)
 * Calculates number of cases unseen for current learner
 */
app.get('/api/ideas', async (req, res, next) => {
  try {
    const learnerId = req.query.learner_id ? Number(req.query.learner_id) : null;
    const pool = getPool();

    const result = [];
    // Strict array order from seed-data.js
    for (const item of SEED_DATA) {
      const ideaRes = await pool.query('SELECT id, title FROM ideas WHERE title = $1', [item.title]);
      if (ideaRes.rows.length === 0) continue;

      const ideaRow = ideaRes.rows[0];
      const totalCasesRes = await pool.query('SELECT COUNT(*)::int as total FROM cases WHERE idea_id = $1', [ideaRow.id]);
      const totalCases = totalCasesRes.rows[0].total;

      let attempted = 0;
      if (learnerId) {
        const attemptedRes = await pool.query(`
          SELECT COUNT(DISTINCT case_id)::int as attempted
          FROM attempts
          WHERE learner_id = $1 AND case_id IN (SELECT id FROM cases WHERE idea_id = $2)
        `, [learnerId, ideaRow.id]);
        attempted = attemptedRes.rows[0].attempted;
      }

      const casesLeft = Math.max(0, totalCases - attempted);
      const casesLeftText = casesLeft === 0
        ? 'all cases used'
        : `${casesLeft} of ${totalCases} cases left`;

      result.push({
        id: ideaRow.id,
        title: ideaRow.title,
        blurb: item.blurb || '',
        total_cases: totalCases,
        cases_left: casesLeft,
        cases_left_text: casesLeftText,
        disabled: casesLeft === 0
      });
    }

    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * Learner explains an idea.
 * AI Job A finds recited sentence and creates gap row.
 * DO NOT show the follow-up yet; return Case 1 ("before").
 */
app.post('/api/explanations', async (req, res, next) => {
  try {
    const { learner_id, idea_id, text } = req.body;

    if (!learner_id || !idea_id || !text || text.trim().length === 0) {
      return res.status(400).json({ error: 'learner_id, idea_id, and text are required.' });
    }

    const pool = getPool();
    const ideaRes = await pool.query('SELECT * FROM ideas WHERE id = $1', [idea_id]);
    if (ideaRes.rows.length === 0) {
      return res.status(404).json({ error: 'Idea not found.' });
    }
    const idea = ideaRes.rows[0];

    // 1. Save explanation
    const explRes = await pool.query(`
      INSERT INTO explanations (learner_id, idea_id, text)
      VALUES ($1, $2, $3)
      RETURNING id
    `, [learner_id, idea_id, text.trim()]);
    const explanationId = explRes.rows[0].id;

    // 2. Call AI Job A (server-side only)
    let analysis;
    try {
      analysis = await findRecitedSentence(idea.title, text.trim());
    } catch (llmErr) {
      return res.status(502).json({
        error: `LLM evaluation error: ${llmErr.message}`
      });
    }

    // 3. Store gap row with empty string for followup_question (filled later by Job C if Case 1 fails)
    const gapRes = await pool.query(`
      INSERT INTO gaps (explanation_id, recited_sentence, type, hidden_assumption, followup_question)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id
    `, [
      explanationId,
      analysis.recited_sentence,
      analysis.type || 'none',
      analysis.hidden_assumption,
      ''
    ]);
    const gapId = gapRes.rows[0].id;

    // 4. Case 1 ("before"): select first case in idea's order that learner has not attempted
    const case1 = await getUnseenCase1(pool, learner_id, idea_id);
    if (!case1) {
      return res.status(400).json({
        error: 'no fresh case left for this idea',
        no_fresh_cases: true
      });
    }

    // Do NOT return the follow-up question or recitation yet
    res.json({
      explanation_id: explanationId,
      gap_id: gapId,
      case: {
        id: case1.id,
        prompt: case1.prompt,
        theme: case1.theme
      }
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Submit an attempt for a case (Case 1 or Case 2).
 * Evaluates key points via AI Job B and decides pass/fail via code in judge.js.
 */
app.post('/api/attempts', async (req, res, next) => {
  try {
    const { learner_id, case_id, gap_id, answer_text } = req.body;

    if (!learner_id || !case_id || !answer_text || answer_text.trim().length === 0) {
      return res.status(400).json({ error: 'learner_id, case_id, and answer_text are required.' });
    }

    const pool = getPool();
    const caseData = await getCaseWithKeyPoints(pool, case_id);
    if (!caseData) {
      return res.status(404).json({ error: 'Case not found.' });
    }

    // 1. AI Job B: Check key points strictly (Hint-free, strictly quote or absent)
    let keyPointEvaluations;
    try {
      keyPointEvaluations = await checkKeyPoints(
        caseData.prompt,
        caseData.theme,
        answer_text.trim(),
        caseData.key_points
      );
    } catch (llmErr) {
      return res.status(502).json({
        error: `LLM evaluation error: ${llmErr.message}`
      });
    }

    // 2. CODE decides pass/fail (never the AI's opinion)
    const judgment = await recordAttemptAndJudge(pool, {
      learnerId: learner_id,
      caseId: case_id,
      gapId: gap_id || null,
      answerText: answer_text.trim(),
      keyPointEvaluations
    });

    // Attach key point text to the evaluations for the frontend display
    const detailedEvaluations = judgment.evaluations.map(ev => {
      const kp = caseData.key_points.find(k => k.id === ev.key_point_id);
      return {
        key_point_id: ev.key_point_id,
        text: kp ? kp.text : '',
        present: ev.present,
        evidence: ev.evidence
      };
    });

    // If Case 1 failed and gap_id is not set, run Job C to write the targeted follow-up question
    let gapInfo = null;
    if (!judgment.passed && !gap_id) {
      // Find the latest gap for this learner & idea
      const gapRes = await pool.query(`
        SELECT g.id, g.recited_sentence, g.type, g.hidden_assumption, i.title as idea_title
        FROM gaps g
        JOIN explanations e ON g.explanation_id = e.id
        JOIN ideas i ON e.idea_id = i.id
        WHERE e.learner_id = $1 AND e.idea_id = $2
        ORDER BY g.id DESC
        LIMIT 1
      `, [learner_id, caseData.idea_id]);

      if (gapRes.rows.length > 0) {
        gapInfo = gapRes.rows[0];

        const absentKeyPoints = detailedEvaluations
          .filter(ev => !ev.present)
          .map(ev => ev.text);

        const presentKeyPoints = detailedEvaluations
          .filter(ev => ev.present)
          .map(ev => ev.text);

        try {
          const followupResult = await writeFollowupQuestion({
            ideaTitle: gapInfo.idea_title,
            recitedSentence: gapInfo.recited_sentence,
            hiddenAssumption: gapInfo.hidden_assumption,
            casePrompt: caseData.prompt,
            learnerAnswer: answer_text.trim(),
            absentKeyPoints,
            presentKeyPoints
          });

          // Save the follow-up text in gaps.followup_question
          await pool.query('UPDATE gaps SET followup_question = $1 WHERE id = $2', [
            followupResult.followup_question,
            gapInfo.id
          ]);

          gapInfo.followup_question = followupResult.followup_question;
        } catch (jobCErr) {
          return res.status(502).json({
            error: `Follow-up generation error: ${jobCErr.message}`
          });
        }
      }
    }

    res.json({
      attempt_id: judgment.attemptId,
      passed: judgment.passed,
      case_id: case_id,
      case_theme: caseData.theme,
      evaluations: detailedEvaluations,
      gap: gapInfo
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Record learner's answer to the follow-up question and fetch Case 2
 * Case 2 must be an unseen case from the SAME idea with a DIFFERENT theme than case 1.
 */
app.post('/api/gaps/:id/followup', async (req, res, next) => {
  try {
    const gapId = req.params.id;
    const { outcome_text, learner_id, idea_id, previous_theme } = req.body;

    if (!outcome_text || outcome_text.trim().length === 0) {
      return res.status(400).json({ error: 'Follow-up response text is required.' });
    }

    const pool = getPool();
    // Save response in followup_outcome
    await pool.query('UPDATE gaps SET followup_outcome = $1 WHERE id = $2', [
      outcome_text.trim(),
      gapId
    ]);

    // Select Case 2: unseen case from SAME idea with a DIFFERENT theme than case 1
    const case2 = await getUnseenCase2(pool, learner_id, idea_id, previous_theme);
    if (!case2) {
      return res.json({
        success: true,
        gap_id: Number(gapId),
        no_fresh_cases: true,
        message: 'no fresh case left for this idea'
      });
    }

    res.json({
      success: true,
      gap_id: Number(gapId),
      next_case: {
        id: case2.id,
        prompt: case2.prompt,
        theme: case2.theme
      }
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Fetch challenge case if Case 1 passed (different theme)
 */
app.get('/api/cases/challenge', async (req, res, next) => {
  try {
    const { learner_id, idea_id, previous_theme } = req.query;
    const pool = getPool();
    const caseChallenge = await getUnseenCase2(pool, learner_id, idea_id, previous_theme);
    if (!caseChallenge) {
      return res.json({
        no_fresh_cases: true,
        message: 'no fresh case left for this idea'
      });
    }
    res.json({
      case: {
        id: caseChallenge.id,
        prompt: caseChallenge.prompt,
        theme: caseChallenge.theme
      }
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Insights API - strictly SQL driven, with optional idea_id filter
 */
app.get('/api/insights', async (req, res, next) => {
  try {
    const ideaId = req.query.idea_id ? Number(req.query.idea_id) : null;
    const pool = getPool();

    // Get list of all ideas in database for filter selection
    const ideasListRes = await pool.query('SELECT id, title FROM ideas ORDER BY id ASC');
    const ideasList = ideasListRes.rows;

    // 1. Attempts per learner code with passed/failed counts
    const learnerStatsRes = await pool.query(`
      SELECT 
        l.code,
        l.tester_type,
        COUNT(a.id)::int AS total_attempts,
        SUM(CASE WHEN a.passed = true THEN 1 ELSE 0 END)::int AS passed_attempts,
        SUM(CASE WHEN a.passed = false THEN 1 ELSE 0 END)::int AS failed_attempts
      FROM learners l
      LEFT JOIN attempts a ON l.id = a.learner_id
      GROUP BY l.id, l.code, l.tester_type
      ORDER BY l.id DESC
    `);
    const learnerStats = learnerStatsRes.rows;

    // 2. Pass rate per case (filtered by idea_id if provided)
    let caseStatsQuery = `
      SELECT 
        c.id,
        c.idea_id,
        c.theme,
        c.prompt,
        i.title AS idea_title,
        COUNT(a.id)::int AS total_attempts,
        SUM(CASE WHEN a.passed = true THEN 1 ELSE 0 END)::int AS passed_attempts,
        ROUND(COALESCE(AVG(CASE WHEN a.passed = true THEN 100.0 ELSE 0.0 END), 0), 1) AS pass_rate
      FROM cases c
      JOIN ideas i ON c.idea_id = i.id
      LEFT JOIN attempts a ON c.id = a.case_id
    `;
    const caseParams = [];
    if (ideaId) {
      caseParams.push(ideaId);
      caseStatsQuery += ` WHERE c.idea_id = $1 `;
    }
    caseStatsQuery += ` GROUP BY c.id, c.idea_id, c.theme, c.prompt, i.title ORDER BY c.id ASC `;
    const caseStatsRes = await pool.query(caseStatsQuery, caseParams);
    const caseStats = caseStatsRes.rows;

    // 3. Most missed key points (filtered by idea_id if provided)
    let missedKeyPointsQuery = `
      SELECT 
        kp.id,
        c.idea_id,
        kp.text AS key_point_text,
        c.theme AS case_theme,
        COUNT(ap.attempt_id)::int AS total_checks,
        SUM(CASE WHEN ap.present = false THEN 1 ELSE 0 END)::int AS missed_count,
        ROUND(COALESCE(AVG(CASE WHEN ap.present = false THEN 100.0 ELSE 0.0 END), 0), 1) AS miss_rate
      FROM key_points kp
      JOIN cases c ON kp.case_id = c.id
      LEFT JOIN attempt_points ap ON kp.id = ap.key_point_id
    `;
    const missedParams = [];
    if (ideaId) {
      missedParams.push(ideaId);
      missedKeyPointsQuery += ` WHERE c.idea_id = $1 `;
    }
    missedKeyPointsQuery += ` GROUP BY kp.id, c.idea_id, kp.text, c.theme ORDER BY missed_count DESC, total_checks DESC LIMIT 20 `;
    const missedKeyPointsRes = await pool.query(missedKeyPointsQuery, missedParams);
    const missedKeyPoints = missedKeyPointsRes.rows;

    // 4. Most common recited sentences
    const commonRecitedRes = await pool.query(`
      SELECT 
        recited_sentence,
        type,
        COUNT(*)::int AS count
      FROM gaps
      WHERE recited_sentence IS NOT NULL AND TRIM(recited_sentence) != ''
      GROUP BY recited_sentence, type
      ORDER BY count DESC
      LIMIT 10
    `);
    const commonRecited = commonRecitedRes.rows;

    // 5. Recitation count by type
    const recitedByTypeRes = await pool.query(`
      SELECT 
        COALESCE(type, 'none') AS type,
        COUNT(*)::int AS count
      FROM gaps
      GROUP BY type
      ORDER BY count DESC
    `);
    const recitedByType = recitedByTypeRes.rows;

    // 6. Gaps closed: count of gaps where a failed attempt exists before and a passed attempt exists with that gap_id
    const gapsClosedRes = await pool.query(`
      SELECT COUNT(DISTINCT g.id)::int AS gaps_closed
      FROM gaps g
      JOIN attempts a_after ON a_after.gap_id = g.id AND a_after.passed = true
      JOIN explanations e ON g.explanation_id = e.id
      JOIN cases c ON c.idea_id = e.idea_id
      JOIN attempts a_before ON a_before.learner_id = e.learner_id 
        AND a_before.case_id = c.id
        AND (a_before.gap_id IS NULL OR a_before.gap_id != g.id)
        AND a_before.passed = false
        AND a_before.created_at <= a_after.created_at
    `);
    const gapsClosed = gapsClosedRes.rows[0].gaps_closed;

    const totalGapsRes = await pool.query('SELECT COUNT(*)::int AS total_gaps FROM gaps');
    const totalGaps = totalGapsRes.rows[0].total_gaps;

    // 7. Learner's follow-up outcomes listed for review
    const followupReviewsRes = await pool.query(`
      SELECT 
        g.id AS gap_id,
        l.code AS learner_code,
        g.recited_sentence,
        g.followup_question,
        g.followup_outcome,
        g.created_at
      FROM gaps g
      JOIN explanations e ON g.explanation_id = e.id
      JOIN learners l ON e.learner_id = l.id
      WHERE g.followup_outcome IS NOT NULL AND TRIM(g.followup_outcome) != ''
      ORDER BY g.created_at DESC
      LIMIT 25
    `);
    const followupReviews = followupReviewsRes.rows;

    res.json({
      ideas: ideasList,
      selected_idea_id: ideaId,
      learnerStats,
      caseStats,
      missedKeyPoints,
      commonRecited,
      recitedByType,
      gapsSummary: {
        total_gaps: totalGaps,
        gaps_closed: gapsClosed
      },
      followupReviews
    });
  } catch (err) {
    next(err);
  }
});

// Generic centralized error handler
app.use((err, req, res, next) => {
  console.error('[Server Error]', err);
  res.status(err.status || 500).json({
    error: err.message || 'An unexpected internal server error occurred.'
  });
});

// Start listening if run directly
if (require.main === module) {
  app.listen(PORT, async () => {
    console.log(`Concept Check v2 running on http://localhost:${PORT}`);
    console.log(`LLM Provider: Groq | Model: ${process.env.LLM_MODEL || 'qwen/qwen3.8-27b'}`);
    console.log(`Groq API Key: ${hasValidApiKey() ? 'Configured ✓' : 'Not set (using fallback evaluator)'}`);

    const dbCheck = await checkDbConnection();
    if (dbCheck.ok) {
      console.log('Database: Connected to Supabase Postgres ✓');
    } else {
      console.log(`Database: Not connected (${dbCheck.error})`);
    }
  });
}

module.exports = app;
