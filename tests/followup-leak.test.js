// tests/followup-leak.test.js - Verify Job C does not leak answers or violate rules
require('dotenv').config();
const { writeFollowupQuestion, hasValidApiKey } = require('../server/llm');

const COMMON_STOP_WORDS = new Set([
  'what', 'that', 'this', 'from', 'with', 'have', 'been', 'there', 'their',
  'when', 'which', 'your', 'will', 'would', 'could', 'should', 'about', 'other',
  'after', 'where', 'these', 'those', 'than', 'them', 'then', 'they', 'some',
  'such', 'into', 'just', 'more', 'also', 'does', 'doing', 'done', 'each',
  'make', 'made', 'much', 'only', 'very', 'even', 'over', 'down', 'here', 'back',
  'step', 'happens', 'happen', 'instead', 'because', 'first', 'second', 'using',
  'open', 'send', 'sends', 'sent', 'call', 'user', 'page'
]);

const BANNED_PHRASES = [
  'think about',
  'consider',
  'remember',
  'have you thought about'
];

const BANNED_RULE1_TECHNICAL_TERMS = [
  'network tab',
  'developer tools',
  'devtools',
  'page source',
  'javascript file',
  'bundle',
  'inspect',
  'request headers'
];

const TEST_SCENARIOS = [
  {
    name: 'Learner VITE_API_KEY test (Required)',
    ideaTitle: "Why can't the key live in the browser?",
    recitedSentence: 'it will be visible to other users and it can be copied or stolen',
    explanationText: 'it will be visible to other users and it can be copied or stolen',
    hiddenAssumption: 'Assumes visibility to others explains why frontend variables are not private.',
    casePrompt: 'A developer stores their API key in a frontend environment variable called VITE_API_KEY, thinking it is hidden. Is it safe, and why or why not?',
    learnerAnswer: 'yes it is safe',
    presentPoints: [],
    absentPoints: [
      'No',
      'Frontend variables are bundled into the code sent to the browser, so it can be read there'
    ]
  },
  {
    name: 'Scenario 1: Checkout total manipulation (Required)',
    ideaTitle: 'Why does a backend exist at all?',
    recitedSentence: 'The frontend is what the user sees, and the backend is behind the scenes.',
    hiddenAssumption: 'Assumes the server automatically validates or knows what the user did.',
    casePrompt: "A shop's checkout page works out the total in the browser and sends it to the server, which saves the order. A customer opens DevTools and changes the total from 4,999 to 1 before sending. What happens to the order?",
    learnerAnswer: 'The customer pays 1 and the order is processed because there was no backend to process it',
    presentPoints: [
      'The order goes through and is saved at the changed price (1)'
    ],
    absentPoints: [
      'Code running in the browser can be edited by the user',
      'The server should recompute or verify the price from its own data instead of trusting the browser'
    ]
  },
  {
    name: 'Scenario 2: Browser counter limits (Required)',
    ideaTitle: 'Why does a backend exist at all?',
    recitedSentence: 'A backend handles the business logic and heavy lifting.',
    hiddenAssumption: 'Assumes local browser state is secure and private to the application.',
    casePrompt: 'Your app gives each user 5 free AI requests a day. The counter is kept in the user\'s browser. How could someone get unlimited requests?',
    learnerAnswer: 'They can right-click and open DevTools to reset it',
    presentPoints: [
      'They can clear or edit the stored counter in the browser, or send requests directly from outside the page'
    ],
    absentPoints: [
      'The server must track the count in its own database so the user cannot tamper with it'
    ]
  },
  {
    name: 'Scenario 3: API key in frontend bundle',
    ideaTitle: 'Why does a backend exist at all?',
    recitedSentence: 'Everything is kept safe in the cloud.',
    hiddenAssumption: 'Assumes frontend assets cannot be inspected by users.',
    casePrompt: 'Your app calls a paid AI service. You put your API key in the frontend JavaScript file so the browser can make the request directly. Within hours, someone has used $500 of your credits. How did they get the key?',
    learnerAnswer: 'They hacked into the cloud server and stole the key from the database',
    presentPoints: [],
    absentPoints: [
      'Anyone can view the frontend JavaScript file using DevTools or View Source',
      'Private keys must be kept on the server and never sent to the browser'
    ]
  },
  {
    name: 'Scenario 4: Web crawler GET request deletes account',
    ideaTitle: 'What does an API actually look like on the wire?',
    recitedSentence: 'APIs follow REST architecture conventions.',
    hiddenAssumption: 'Assumes GET requests are strictly read-only and harmless.',
    casePrompt: 'A developer builds an endpoint to delete a user account: GET /api/users/123/delete. A web crawler indexes the site. What happens?',
    learnerAnswer: 'The crawler gets blocked by authentication or returns a 404',
    presentPoints: [],
    absentPoints: [
      'The crawler issues GET requests to all links it finds, so the account gets deleted',
      'GET requests should be safe and read-only; destructive actions must use POST or DELETE'
    ]
  },
  {
    name: 'Scenario 5: JSON file write crash mid-way',
    ideaTitle: 'Why relational databases instead of files?',
    recitedSentence: 'Databases are just files stored on a disk.',
    hiddenAssumption: 'Assumes operating system file writes are atomic and immune to abrupt termination.',
    casePrompt: 'A Node.js server appends each new order to orders.json. While writing a 2MB order during a spike in traffic, the server process runs out of memory and crashes midway through the write. What happens to the file?',
    learnerAnswer: 'The server restarts and resumes writing the remaining bytes',
    presentPoints: [],
    absentPoints: [
      'The file is left half-written or corrupted, making it invalid JSON',
      'Relational databases use transactions (write-ahead log / rollback) to ensure writes are all-or-nothing'
    ]
  }
];

function extractWords(text) {
  if (!text) return [];
  return (text.toLowerCase().match(/[a-z]{4,}/g) || []);
}

function findLeakedWords(question, absentPoints, casePrompt, learnerAnswer, recitedSentence, explanationText) {
  const qWords = new Set(extractWords(question));
  const allowedContextWords = new Set([
    ...extractWords(casePrompt),
    ...extractWords(learnerAnswer),
    ...extractWords(recitedSentence),
    ...extractWords(explanationText)
  ]);

  const leaked = [];
  for (const pt of absentPoints) {
    const ptWords = extractWords(pt);
    for (const w of ptWords) {
      if (COMMON_STOP_WORDS.has(w)) continue;
      if (allowedContextWords.has(w)) continue; // Allowed context words
      if (qWords.has(w)) {
        leaked.push(w);
      }
    }
  }
  return Array.from(new Set(leaked));
}

async function runFollowupLeakTest() {
  console.log('===========================================================');
  console.log('      CONCEPT CHECK - JOB C FOLLOW-UP LEAK TEST           ');
  console.log('===========================================================');
  console.log(`LLM Mode: ${hasValidApiKey() ? 'Groq API (' + (process.env.LLM_MODEL || 'qwen/qwen3.8-27b') + ')' : 'Mock Engine'}\n`);

  let passedCount = 0;
  let flagCount = 0;

  for (let i = 0; i < TEST_SCENARIOS.length; i++) {
    const sc = TEST_SCENARIOS[i];
    console.log(`--- [Scenario ${i + 1}/${TEST_SCENARIOS.length}] ${sc.name} ---`);
    console.log(`Case Prompt: "${sc.casePrompt.slice(0, 75)}..."`);
    console.log(`Learner Answer: "${sc.learnerAnswer}"`);

    try {
      const result = await writeFollowupQuestion(
        sc.ideaTitle,
        sc.recitedSentence,
        sc.hiddenAssumption,
        sc.casePrompt,
        sc.learnerAnswer,
        sc.absentPoints,
        sc.presentPoints
      );

      const question = (result.followup_question || '').trim();
      console.log(`Job C Output: "${question}"`);

      const flags = [];

      // 1. Check question mark count
      const qMarkCount = (question.match(/\?/g) || []).length;
      if (qMarkCount !== 1) {
        flags.push(`Question mark count is ${qMarkCount} (must be exactly 1)`);
      }

      // 2. Check banned phrases
      const lowerQ = question.toLowerCase();
      for (const phrase of BANNED_PHRASES) {
        if (lowerQ.includes(phrase)) {
          flags.push(`Contains banned phrase: "${phrase}"`);
        }
      }

      // 3. Check for distinctive absent key point word overlap (leakage)
      const leakedWords = findLeakedWords(
        question,
        sc.absentPoints,
        sc.casePrompt,
        sc.learnerAnswer,
        sc.recitedSentence,
        sc.explanationText
      );
      if (leakedWords.length > 0) {
        flags.push(`Overlaps with absent key point vocabulary: [${leakedWords.join(', ')}]`);
      }

      // 4. Check for Rule 1 banned technical terms not in learner's text
      const learnerText = `${sc.recitedSentence || ''} ${sc.explanationText || ''} ${sc.learnerAnswer || ''}`.toLowerCase();
      for (const term of BANNED_RULE1_TECHNICAL_TERMS) {
        if (lowerQ.includes(term) && !learnerText.includes(term)) {
          flags.push(`Contains Rule 1 banned technical term not in learner's text: "${term}"`);
        }
      }

      if (flags.length === 0) {
        passedCount++;
        console.log('\x1b[32m[PASS]\x1b[0m Single question, grounded in quote, no banned phrases/terms, no key point leakage\n');
      } else {
        flagCount++;
        console.log('\x1b[33m[FLAG]\x1b[0m Issues detected:');
        flags.forEach(f => console.log(`   - ${f}`));
        console.log('');
      }
    } catch (err) {
      flagCount++;
      console.log(`\x1b[31m[ERROR]\x1b[0m ${err.message}\n`);
    }
  }

  console.log('===========================================================');
  console.log('                FOLLOW-UP LEAK TEST SUMMARY               ');
  console.log('===========================================================');
  console.log(`Total scenarios tested: ${TEST_SCENARIOS.length}`);
  console.log(`Passed cleanly        : \x1b[32m${passedCount}\x1b[0m`);
  console.log(`Flagged / Issues      : ${flagCount > 0 ? '\x1b[33m' + flagCount + '\x1b[0m' : '0'}`);

  if (flagCount === 0) {
    console.log('\n\x1b[32mOVERALL RESULT: PASS\x1b[0m');
    console.log('Job C generated tight, targeted follow-ups without leaking absent points.\n');
    return true;
  } else {
    console.log('\n\x1b[33mOVERALL RESULT: FLAG\x1b[0m');
    console.log('One or more follow-up questions were flagged for inspection.\n');
    return false;
  }
}

if (require.main === module) {
  runFollowupLeakTest().then(success => {
    process.exit(success ? 0 : 1);
  });
}

module.exports = { runFollowupLeakTest };
