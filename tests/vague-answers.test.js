// tests/vague-answers.test.js - Test that key-point checker strictly rejects vague answers
require('dotenv').config();
const { getPool, closeDb, checkDbConnection } = require('../server/db');
const { seedDatabase, SEED_DATA } = require('../server/seed');
const { checkKeyPoints, hasValidApiKey } = require('../server/llm');
const { getCaseWithKeyPoints } = require('../server/judge');

const VAGUE_ANSWERS = [
  "it's insecure",
  "for security reasons",
  "bad things can happen",
  "best practice",
  "they can hack it",
  "it's more secure that way",
  "by using a different account",
  "it keeps a record",
  "it's about storage"
];

async function runVagueAnswersTest() {
  console.log('===========================================================');
  console.log('    CONCEPT CHECK - VAGUE ANSWER STRICTNESS TEST          ');
  console.log('===========================================================');
  console.log(`LLM Mode: ${hasValidApiKey() ? 'Groq API (' + (process.env.LLM_MODEL || 'qwen/qwen3.8-27b') + ')' : 'Pedagogical Strict Evaluator Fallback'}`);
  console.log('Testing that vague answers are strictly marked as absent.\n');

  let casesToTest = [];

  if (process.env.DATABASE_URL) {
    try {
      const dbCheck = await checkDbConnection();
      if (dbCheck.ok) {
        const pool = getPool();
        const casesRes = await pool.query('SELECT id FROM cases ORDER BY id ASC LIMIT 3');
        if (casesRes.rows.length >= 3) {
          for (const r of casesRes.rows) {
            const cd = await getCaseWithKeyPoints(pool, r.id);
            casesToTest.push(cd);
          }
        }
      }
    } catch (e) {
      console.warn('DB not reachable, falling back to seed-data cases for testing:', e.message);
    }
  }

  if (casesToTest.length < 3) {
    // Fall back to seed-data.js cases so vague answer test can run even without live DB
    casesToTest = SEED_DATA[0].cases.slice(0, 3).map((c, i) => ({
      id: i + 1,
      prompt: c.prompt,
      theme: c.theme,
      key_points: (c.points || []).map((pt, pidx) => ({ id: pidx + 1, text: pt }))
    }));
  }

  let totalTests = 0;
  let passedTests = 0;
  let failedTests = 0;
  const failureDetails = [];

  for (let i = 0; i < casesToTest.length; i++) {
    const caseData = casesToTest[i];

    console.log(`--- [Case ${i + 1}/3] ID ${caseData.id} (Theme: "${caseData.theme}") ---`);
    console.log(`Prompt: "${caseData.prompt.slice(0, 80)}..."`);
    console.log(`Required key points count: ${caseData.key_points.length}`);

    for (const vagueAnswer of VAGUE_ANSWERS) {
      totalTests++;
      process.stdout.write(`  Testing vague answer: "${vagueAnswer}" ... `);

      try {
        const evaluations = await checkKeyPoints(
          caseData.prompt,
          caseData.theme,
          vagueAnswer,
          caseData.key_points
        );

        // Check if ANY point was wrongly marked present
        const wronglyPresent = evaluations.filter(ev => ev.present === true);

        if (wronglyPresent.length === 0) {
          passedTests++;
          console.log('\x1b[32m[PASS]\x1b[0m All key points marked absent');
        } else {
          failedTests++;
          console.log('\x1b[31m[FAIL]\x1b[0m Too lenient! Wrongly marked points as present:');
          wronglyPresent.forEach(wp => {
            const kp = caseData.key_points.find(k => k.id === wp.key_point_id);
            console.log(`     - Point ID ${wp.key_point_id}: "${kp ? kp.text : ''}"`);
            console.log(`       Evidence quoted: "${wp.evidence}"`);
          });
          failureDetails.push({
            caseId: caseData.id,
            theme: caseData.theme,
            answer: vagueAnswer,
            wronglyPresent
          });
        }
      } catch (err) {
        failedTests++;
        console.log(`\x1b[31m[ERROR]\x1b[0m ${err.message}`);
        failureDetails.push({
          caseId: caseData.id,
          theme: caseData.theme,
          answer: vagueAnswer,
          error: err.message
        });
      }
    }
    console.log('');
  }

  console.log('===========================================================');
  console.log('                     TEST SUMMARY                          ');
  console.log('===========================================================');
  console.log(`Total tests executed : ${totalTests}`);
  console.log(`Passed (Strictly Absent): \x1b[32m${passedTests}\x1b[0m`);
  console.log(`Failed (Too Lenient)   : ${failedTests > 0 ? '\x1b[31m' + failedTests + '\x1b[0m' : '0'}`);

  await closeDb();

  if (failedTests === 0) {
    console.log('\n\x1b[32mOVERALL RESULT: PASS\x1b[0m');
    console.log('The key-point checker strictly rejects vague answers without leniency.\n');
    process.exit(0);
  } else {
    console.log('\n\x1b[31mOVERALL RESULT: FAIL\x1b[0m');
    console.log('The checker was too lenient on one or more vague answers.\n');
    process.exit(1);
  }
}

if (require.main === module) {
  runVagueAnswersTest();
}
