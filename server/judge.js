// server/judge.js - Objective code-level evaluation and case selection
// CODE decides pass/fail, never the LLM's opinion.
// Converted to async/await with parameterized Postgres queries ($1, $2, ...)

/**
 * Objective evaluation function:
 * passed = every key point for that case has present === true.
 * Saves attempt row and attempt_points rows in a single atomic transaction.
 */
async function recordAttemptAndJudge(db, { learnerId, caseId, gapId = null, answerText, keyPointEvaluations }) {
  if (!keyPointEvaluations || keyPointEvaluations.length === 0) {
    throw new Error('Cannot evaluate attempt without key points.');
  }

  // CODE decides: strictly all key points must be present
  const passed = keyPointEvaluations.every(pt => pt.present === true);

  // Acquire client for transaction if db is a Pool
  const client = typeof db.connect === 'function' ? await db.connect() : db;
  const isAcquired = typeof db.connect === 'function';

  try {
    await client.query('BEGIN');

    const insertAttemptRes = await client.query(`
      INSERT INTO attempts (learner_id, case_id, gap_id, answer_text, passed)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id
    `, [learnerId, caseId, gapId || null, answerText, passed]);

    const attemptId = insertAttemptRes.rows[0].id;

    for (const point of keyPointEvaluations) {
      await client.query(`
        INSERT INTO attempt_points (attempt_id, key_point_id, present, evidence)
        VALUES ($1, $2, $3, $4)
      `, [attemptId, point.key_point_id, Boolean(point.present), point.evidence || '']);
    }

    await client.query('COMMIT');

    return {
      attemptId,
      passed,
      evaluations: keyPointEvaluations
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    if (isAcquired) {
      client.release();
    }
  }
}

/**
 * Case selection rule:
 * Case 1 ("before"): first unseen case for that idea for that learner.
 * Never repeat a case for a learner.
 */
async function getUnseenCase1(db, learnerId, ideaId) {
  const res = await db.query(`
    SELECT c.* FROM cases c
    WHERE c.idea_id = $1
      AND c.id NOT IN (
        SELECT case_id FROM attempts WHERE learner_id = $2
      )
    ORDER BY c.id ASC
    LIMIT 1
  `, [ideaId, learnerId]);

  return res.rows[0] || null;
}

/**
 * Case selection rule:
 * Case 2 ("after"): an unseen case from a DIFFERENT theme than case 1.
 * Never repeat a case for a learner.
 */
async function getUnseenCase2(db, learnerId, ideaId, excludedTheme) {
  const res = await db.query(`
    SELECT c.* FROM cases c
    WHERE c.idea_id = $1
      AND c.theme != $2
      AND c.id NOT IN (
        SELECT case_id FROM attempts WHERE learner_id = $3
      )
    ORDER BY c.id ASC
    LIMIT 1
  `, [ideaId, excludedTheme, learnerId]);

  return res.rows[0] || null;
}

/**
 * Fetch case details with its associated key points.
 */
async function getCaseWithKeyPoints(db, caseId) {
  const caseRes = await db.query('SELECT * FROM cases WHERE id = $1', [caseId]);
  if (caseRes.rows.length === 0) return null;

  const caseRow = caseRes.rows[0];
  const keyPointsRes = await db.query(
    'SELECT id, text FROM key_points WHERE case_id = $1 ORDER BY id ASC',
    [caseId]
  );

  return {
    ...caseRow,
    id: Number(caseRow.id),
    idea_id: Number(caseRow.idea_id),
    key_points: keyPointsRes.rows.map(kp => ({
      ...kp,
      id: Number(kp.id),
      case_id: Number(kp.case_id || caseId)
    }))
  };
}

module.exports = {
  recordAttemptAndJudge,
  getUnseenCase1,
  getUnseenCase2,
  getCaseWithKeyPoints
};
