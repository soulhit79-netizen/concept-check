// server/seed.js - Idempotent database seeder for Postgres using seed-data.js
require('dotenv').config();
const { getPool, closeDb } = require('./db');
const SEED_DATA = require('./seed-data');

async function seedDatabase(options = {}) {
  if (!process.env.DATABASE_URL) {
    console.error('Seed error: DATABASE_URL is not set in .env.');
    throw new Error('DATABASE_URL is not set in .env');
  }

  let client;
  try {
    const pool = getPool();
    client = await pool.connect();
  } catch (connErr) {
    console.error('Seed connection error:', connErr.message);
    throw connErr;
  }

  try {
    await client.query('BEGIN');

    // Counters for inserted and found items
    let ideasInserted = 0;
    let ideasFound = 0;
    let casesInserted = 0;
    let casesFound = 0;
    let keyPointsInserted = 0;
    let keyPointsFound = 0;

    // Track active case and idea IDs from current seed-data
    const activeCaseIds = new Set();
    const activeIdeaIds = new Set();

    for (const ideaItem of SEED_DATA) {
      const ideaRowRes = await client.query('SELECT id FROM ideas WHERE title = $1', [ideaItem.title]);
      let ideaId;
      if (ideaRowRes.rows.length === 0) {
        const insertRes = await client.query('INSERT INTO ideas (title) VALUES ($1) RETURNING id', [ideaItem.title]);
        ideaId = insertRes.rows[0].id;
        ideasInserted++;
      } else {
        ideaId = ideaRowRes.rows[0].id;
        ideasFound++;
      }
      activeIdeaIds.add(ideaId);

      for (const caseItem of ideaItem.cases) {
        const caseRowRes = await client.query(
          'SELECT id, theme FROM cases WHERE idea_id = $1 AND prompt = $2',
          [ideaId, caseItem.prompt]
        );

        let caseId;
        if (caseRowRes.rows.length === 0) {
          const insertCaseRes = await client.query(
            'INSERT INTO cases (idea_id, prompt, theme) VALUES ($1, $2, $3) RETURNING id',
            [ideaId, caseItem.prompt, caseItem.theme]
          );
          caseId = insertCaseRes.rows[0].id;
          casesInserted++;
        } else {
          caseId = caseRowRes.rows[0].id;
          casesFound++;
          if (caseRowRes.rows[0].theme !== caseItem.theme) {
            await client.query('UPDATE cases SET theme = $1 WHERE id = $2', [caseItem.theme, caseId]);
          }
        }
        activeCaseIds.add(caseId);

        const points = caseItem.points || caseItem.key_points || [];
        const activePointTexts = new Set(points);

        for (const ptText of points) {
          const ptRowRes = await client.query(
            'SELECT id FROM key_points WHERE case_id = $1 AND text = $2',
            [caseId, ptText]
          );
          if (ptRowRes.rows.length === 0) {
            await client.query(
              'INSERT INTO key_points (case_id, text) VALUES ($1, $2)',
              [caseId, ptText]
            );
            keyPointsInserted++;
          } else {
            keyPointsFound++;
          }
        }

        // Check for old key points on this case that are no longer in seed-data.js
        const currentPointsForCase = await client.query(
          'SELECT id, text FROM key_points WHERE case_id = $1',
          [caseId]
        );

        for (const kp of currentPointsForCase.rows) {
          if (!activePointTexts.has(kp.text)) {
            const countAttemptPointsRes = await client.query(
              'SELECT COUNT(*)::int as cnt FROM attempt_points WHERE key_point_id = $1',
              [kp.id]
            );
            const usedCount = countAttemptPointsRes.rows[0].cnt;
            if (usedCount === 0) {
              await client.query('DELETE FROM key_points WHERE id = $1', [kp.id]);
            } else {
              console.warn(`WARNING: Old key point (id: ${kp.id}, "${kp.text.slice(0, 40)}...") is referenced by ${usedCount} attempt_points. Not deleting.`);
            }
          }
        }
      }
    }

    // Remove old seeded cases that no longer appear in seed-data.js ONLY if they have no attempts pointing at them
    const allDbCases = await client.query('SELECT id, idea_id, prompt FROM cases');
    let removedCasesCount = 0;

    for (const dbCase of allDbCases.rows) {
      if (!activeCaseIds.has(dbCase.id)) {
        const countAttemptsRes = await client.query(
          'SELECT COUNT(*)::int as cnt FROM attempts WHERE case_id = $1',
          [dbCase.id]
        );
        const attemptCount = countAttemptsRes.rows[0].cnt;
        if (attemptCount === 0) {
          await client.query('DELETE FROM key_points WHERE case_id = $1', [dbCase.id]);
          await client.query('DELETE FROM cases WHERE id = $1', [dbCase.id]);
          removedCasesCount++;
        }
      }
    }

    if (removedCasesCount > 0) {
      console.log(`Cleaned up ${removedCasesCount} obsolete case(s) with no attempts.`);
    }

    const totalIdeasRes = await client.query('SELECT COUNT(*)::int as cnt FROM ideas');
    const totalCasesRes = await client.query('SELECT COUNT(*)::int as cnt FROM cases');
    const totalPointsRes = await client.query('SELECT COUNT(*)::int as cnt FROM key_points');

    const totalIdeas = totalIdeasRes.rows[0].cnt;
    const totalCases = totalCasesRes.rows[0].cnt;
    const totalPoints = totalPointsRes.rows[0].cnt;

    await client.query('COMMIT');

    console.log(`Seeding complete:`);
    console.log(`  Ideas: ${ideasInserted} inserted, ${ideasFound} found (${totalIdeas} total)`);
    console.log(`  Cases: ${casesInserted} inserted, ${casesFound} found (${totalCases} total)`);
    console.log(`  Key points: ${keyPointsInserted} inserted, ${keyPointsFound} found (${totalPoints} total)`);

    return {
      ideasInserted,
      ideasFound,
      casesInserted,
      casesFound,
      keyPointsInserted,
      keyPointsFound,
      totalIdeas,
      totalCases,
      totalPoints
    };
  } catch (err) {
    if (client) {
      await client.query('ROLLBACK').catch(() => {});
    }
    console.error('Seed query error:', err.message);
    throw err;
  } finally {
    if (client) {
      client.release();
    }
  }
}

if (require.main === module) {
  seedDatabase()
    .then(async () => {
      await closeDb();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('Seed process failed:', err.message);
      await closeDb();
      process.exit(1);
    });
}

module.exports = {
  seedDatabase,
  SEED_DATA
};
