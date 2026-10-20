// server/prompts.js - All LLM prompts with explicit JSON formatting rules and examples for Groq

/**
 * Prompt for Job A: Find the recited sentence in a learner's explanation (WITHOUT a follow-up).
 * Rules:
 * - Output JSON: {"recited_sentence": "...verbatim or null", "type": "definition|analogy|buzzword|none", "hidden_assumption": "...or null"}
 * - "recited_sentence" must be copied VERBATIM (word-for-word) from the learner's text. If there is no recitation, set to null.
 * - Recitation means: a definition (says what it is, not why it must exist),
 *   an analogy standing in for a mechanism, or a buzzword ("for security reasons", "best practice", "scalability").
 * - If the explanation has no recitation, return recited_sentence as null, type as "none", hidden_assumption as null.
 */
function buildRecitedSentencePrompt(ideaTitle, explanationText) {
  const systemPrompt = `You are an expert pedagogy analyzer inspecting a learner's conceptual explanation.
Your task is to identify where the learner stopped reasoning mechanically and started reciting a phrase.

Categories of recitation:
1. "definition": states what a thing is or what it does without explaining why it must exist or the failure mechanism.
2. "analogy": uses a metaphor or analogy in place of explaining the underlying computing mechanism.
3. "buzzword": relies on catchphrases like "for security reasons", "best practice", "scalability", "industry standard", "it's safer".
4. "none": the learner explained concrete cause-and-effect mechanisms without falling back to slogans or definitions.

Strict rules:
- Output MUST be valid JSON.
- "recited_sentence": must be copied VERBATIM (word-for-word) from the learner's text. If there is no recitation, set to null.
- "type": must be exactly one of: "definition", "analogy", "buzzword", "none".
- "hidden_assumption": one concise sentence stating what the recited phrase takes for granted without proving, or null if none.
- If the explanation has no recitation (type is "none"), return recited_sentence as null and hidden_assumption as null.

You MUST respond with a JSON object containing exactly these three keys:
- "recited_sentence" (string or null)
- "type" (string: "definition" | "analogy" | "buzzword" | "none")
- "hidden_assumption" (string or null)

Tiny example JSON object:
{
  "recited_sentence": "A backend exists for security reasons.",
  "type": "buzzword",
  "hidden_assumption": "Assumes citing security explains why the client cannot tamper with data."
}`;

  const userPrompt = `Idea being explained:
"${ideaTitle}"

Learner's explanation:
"""
${explanationText}
"""

Analyze the explanation and return the JSON object:`;

  return { systemPrompt, userPrompt };
}

/**
 * Prompt for Job B: Check key points against a case answer.
 * Rules:
 * - Explicitly uses the word "JSON".
 * - Spells out exact keys: "key_points" array of objects with "key_point_id", "present", "evidence".
 * - Includes a tiny example JSON object.
 * - Judge each key point separately and strictly.
 * - A point is present only if the answer clearly states that idea in any wording.
 * - Vague answers ("it's insecure", "bad things happen", "for security reasons", "best practice", "they can hack it", "it's more secure that way", "by using a different account", "it keeps a record", "it's about storage") are NOT present.
 * - Do NOT answer whether the learner understands. Do NOT be kind. Quote evidence or mark absent.
 * - Hint-free: never produce any text for the learner.
 */
function buildKeyPointsPrompt(casePrompt, caseTheme, learnerAnswer, keyPoints) {
  const systemPrompt = `You are a strict, objective conceptual answer key evaluator checking whether a learner's answer expresses specific required key points.

Judge MEANING, not literal wording:
1. For each key point, decide whether the learner's answer clearly expresses that same idea, in any wording. Paraphrases, synonyms, different examples, and extra elaboration all count as present.
2. An idea counts as present only if the answer states it directly or its meaning is plain without any guessing. If a reader would have to infer or assume the idea, mark it absent.
3. Related words alone do not count. Mentioning "browser", "server", "security" or "key" without stating the idea is absent.
4. Vague claims do not count: "it's insecure", "for security reasons", "best practice", "bad things happen", "it's about storage".
5. An answer that contradicts the case or states the opposite of the key point is absent.
6. A key point is judged on its own, not on whether the rest of the answer is good. Do not require the answer to also state the cause or the fix unless the key point itself says so.
7. If the key point has an "or" in it, either alternative counts.
8. Evidence must be an exact quote of 15 words or fewer copied from the learner's answer. If you cannot quote a passage that states the idea, mark it absent with empty evidence ("").
9. Never judge whether the learner "understands" and never write text for the learner.

Worked Example 1 (Paraphrase that counts as present):
Key Point: "The order goes through and is saved at the changed price (1)"
Learner Answer: "The store accepts the transaction for just a single dollar."
Evaluation: present = true, evidence = "store accepts the transaction for just a single dollar"

Worked Example 2 (Keyword-only answer that does NOT count):
Key Point: "Code running in the browser can be edited by the user"
Learner Answer: "The browser and the server communicate using DevTools and code."
Evaluation: present = false, evidence = ""

Output MUST be valid JSON.
The JSON object must have a single key "key_points" containing an array of objects.
Each object must contain exactly:
- "key_point_id" (integer matching the required key point ID)
- "present" (boolean: true or false)
- "evidence" (string: verbatim quote of 15 words or fewer from learner's answer, or "")

Tiny example JSON object:
{
  "key_points": [
    {
      "key_point_id": 1,
      "present": true,
      "evidence": "store accepts the transaction for just a single dollar"
    },
    {
      "key_point_id": 2,
      "present": false,
      "evidence": ""
    }
  ]
}`;

  const keyPointsFormatted = keyPoints
    .map(kp => `- [ID ${kp.id}]: "${kp.text}"`)
    .join('\n');

  const userPrompt = `Case Prompt (${caseTheme}):
"${casePrompt}"

Required Key Points to check:
${keyPointsFormatted}

Learner's answer:
"""
${learnerAnswer}
"""

Evaluate each required key point and return the JSON object:`;

  return { systemPrompt, userPrompt };
}

/**
 * Prompt for Job C: Write targeted follow-up question after Case 1 failure.
 * Rules verbatim from user requirement:
 * 1. The follow-up may use only terms that already appear in the case text or in the learner's own explanation or answer.
 *    It must NOT introduce new technical places, tools or artifacts such as "network tab", "developer tools", "DevTools",
 *    "page source", "JavaScript file", "bundle", "inspect", "request headers".
 * 2. Build the question from the learner's own recited sentence, quoting a short phrase of it, and ask where, how,
 *    or what exactly happens in THIS case. Example shape: "You said [their phrase]. In this case, where exactly would that happen, and what would be found?"
 * 3. Never ask a question whose answer is a single value already implied by the question.
 * 4. Keep the rule: ONE question, no hints, no explanation.
 * 5. Output only the JSON.
 */
function buildFollowupPrompt(params, ...rest) {
  let ideaTitle, recitedSentence, hiddenAssumption, casePrompt, learnerAnswer, absentKeyPoints, presentKeyPoints, explanationText;
  if (typeof params === 'object' && params !== null && !Array.isArray(params)) {
    ideaTitle = params.ideaTitle;
    recitedSentence = params.recitedSentence;
    hiddenAssumption = params.hiddenAssumption;
    casePrompt = params.casePrompt;
    learnerAnswer = params.learnerAnswer;
    absentKeyPoints = params.absentKeyPoints || params.absentPoints || [];
    presentKeyPoints = params.presentKeyPoints || params.presentPoints || [];
    explanationText = params.explanationText || params.explanation;
  } else {
    ideaTitle = params;
    recitedSentence = rest[0];
    hiddenAssumption = rest[1];
    casePrompt = rest[2];
    learnerAnswer = rest[3];
    absentKeyPoints = rest[4] || [];
    presentKeyPoints = rest[5] || [];
    explanationText = rest[6];
  }

  const systemPrompt = `You are an expert pedagogy guide creating a single targeted follow-up question.
The learner explained a concept, then attempted Case 1 and failed to state one or more key points.
Your goal is to ask ONE follow-up question that prompts them to reason mechanically about what happens in this specific case.

Strict rules:
1. Term vocabulary constraint: The follow-up may use ONLY terms that already appear in the case text, in the learner's explanation/recited phrase, or in the learner's answer. It must NOT introduce new technical places, tools, or artifacts such as "network tab", "developer tools", "DevTools", "page source", "JavaScript file", "bundle", "inspect", "request headers" (unless that specific term is already explicitly present in the case scenario or learner's text).
2. Grounded in recited phrase: Build the question from the learner's own recited sentence (or explanation), quoting a short phrase of it in quotation marks, and ask where, how, or what exactly happens in THIS case.
   Example shape: "You said \\"[their phrase]\\". In this case, where exactly would that happen, and what would be found?"
3. No implied-answer questions: Never ask a question whose answer is a single value already implied or revealed by the question itself.
4. Exactly ONE question: Ask exactly one question ending with a question mark. No conversational filler, no extra sentences.
5. No hints, no explanation: NEVER state, hint at, or paraphrase any absent key point. NEVER explain the concept. NEVER say "think about", "consider", "remember", or "have you thought about".
6. Do not reuse distinctive words from the absent key points' text.
7. Output MUST be valid JSON with a single key "followup_question".

Tiny example JSON object:
{
  "followup_question": "You said \\"it can be copied\\". In this case, where does the code with the environment variable travel when a user opens the page?"
}`;

  const absentFormatted = (absentKeyPoints && absentKeyPoints.length > 0)
    ? absentKeyPoints.map(kp => `- "${kp}"`).join('\n')
    : '(None)';

  const presentFormatted = (presentKeyPoints && presentKeyPoints.length > 0)
    ? presentKeyPoints.map(kp => `- "${kp}"`).join('\n')
    : '(None)';

  const combinedContextText = `${casePrompt} ${recitedSentence || ''} ${explanationText || ''} ${learnerAnswer || ''}`.toLowerCase();

  const promptAndAnswerWords = new Set(combinedContextText.match(/[a-z]{4,}/g) || []);
  const commonWords = new Set([
    'what', 'that', 'this', 'from', 'with', 'have', 'been', 'there', 'their',
    'when', 'which', 'your', 'will', 'would', 'could', 'should', 'about', 'other',
    'after', 'where', 'these', 'those', 'than', 'them', 'then', 'they', 'some',
    'such', 'into', 'just', 'more', 'also', 'does', 'doing', 'done', 'each',
    'make', 'made', 'much', 'only', 'very', 'even', 'over', 'down', 'here', 'back',
    'step', 'happens', 'happen', 'instead', 'because', 'first', 'second', 'using',
    'open', 'send', 'sends', 'sent', 'call', 'user', 'page'
  ]);
  const forbiddenWords = [];
  (absentKeyPoints || []).forEach(kp => {
    const words = (kp || '').toLowerCase().match(/[a-z]{4,}/g) || [];
    words.forEach(w => {
      if (!commonWords.has(w) && !promptAndAnswerWords.has(w) && !forbiddenWords.includes(w)) {
        forbiddenWords.push(w);
      }
    });
  });

  const forbiddenSection = forbiddenWords.length > 0
    ? `\nDistinctive words from absent points (YOU MUST NOT USE ANY OF THESE WORDS): ${forbiddenWords.join(', ')}\n`
    : '';

  const technicalTerms = [
    'network tab',
    'developer tools',
    'devtools',
    'page source',
    'javascript file',
    'bundle',
    'inspect',
    'request headers'
  ];
  const forbiddenTechnicalTerms = technicalTerms.filter(term => !combinedContextText.includes(term));
  const technicalWarning = forbiddenTechnicalTerms.length > 0
    ? `\nPROHIBITED TECHNICAL TERMS (these terms do NOT appear in the case or learner text, so you MUST NOT use them): ${forbiddenTechnicalTerms.map(t => `"${t}"`).join(', ')}\n`
    : '';

  const quoteSource = recitedSentence || explanationText || '';

  const userPrompt = `Concept Idea:
"${ideaTitle}"

Learner's Explanation / Recited Phrase:
${quoteSource ? `"${quoteSource}"` : '(None identified)'}

Hidden Assumption:
${hiddenAssumption ? `"${hiddenAssumption}"` : '(None)'}

Case Scenario Prompt:
"${casePrompt}"

Learner's Case Answer:
"""
${learnerAnswer}
"""

Key Points already PRESENT in their answer:
${presentFormatted}

Key Points ABSENT from their answer (DO NOT state, hint at, or paraphrase these):
${absentFormatted}
${forbiddenSection}
${technicalWarning}
Instructions:
- If a recited phrase / explanation is available, begin by quoting a short phrase of it in quotes: e.g. You said "[phrase]". In this case, [ask where, how, or what happens]?
- Use ONLY terms that appear in the case scenario or learner's text. DO NOT introduce new technical artifacts (e.g. network tab, developer tools, DevTools, page source, JavaScript file, bundle, inspect, request headers).
- Exactly ONE question ending with a question mark.

Write the single targeted follow-up question and return the JSON object:`;

  return { systemPrompt, userPrompt };
}

module.exports = {
  buildRecitedSentencePrompt,
  buildKeyPointsPrompt,
  buildFollowupPrompt
};
