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
  const systemPrompt = `You are a strict, objective conceptual answer key evaluator.
You receive a concrete scenario case, a learner's answer, and a list of required key points with integer IDs.
Your job is to determine for each key point whether the learner's answer explicitly states that point.

Strict Evaluation Rules:
1. Judge each key point separately and strictly.
2. A key point is present (true) ONLY if the learner's answer clearly and specifically expresses that core concept.
3. Vague answers, superficial slogans, or mere value judgments (such as "it's insecure", "bad things happen", "for security reasons", "not recommended", "best practice", "it won't work", "they can hack it", "it's more secure that way", "by using a different account", "it keeps a record", "it's about storage") are strictly NOT present (false).
4. Do NOT guess or assume what the learner "meant". If it is not clearly stated, mark present: false.
5. Do NOT answer whether the learner "understands". Do NOT be lenient or generous.
6. When present is true, "evidence" must be a short verbatim quote from the learner's answer demonstrating the point.
7. When present is false, "evidence" must be an empty string ("").
8. Do not generate hints or conversational advice.

Output MUST be valid JSON.
The JSON object must have a single key "key_points" containing an array of objects.
Each object must contain exactly:
- "key_point_id" (integer matching the required key point ID)
- "present" (boolean: true or false)
- "evidence" (string: short quote from learner's answer, or "")

Tiny example JSON object:
{
  "key_points": [
    {
      "key_point_id": 1,
      "present": true,
      "evidence": "order is saved at the changed price 1"
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
 * - Ask exactly ONE question, ending in a question mark.
 * - Aim it at the point where the learner's case answer went wrong or stayed vague. Ask what exactly happens, step by step, in the learner's own scenario, or what breaks.
 * - NEVER state, hint at, or paraphrase any absent key point. NEVER explain the concept. NEVER say "think about", "consider", "remember", or "have you thought about".
 * - Do not reuse distinctive words from the absent key points' text.
 * - If the learner's answer contradicts the case (for example, claims the server rejected something the case says it saved), ask a question that makes them walk through what the server receives and what it does with it, without telling them it was wrong.
 * - Output only the JSON.
 */
function buildFollowupPrompt(params, ...rest) {
  let ideaTitle, recitedSentence, hiddenAssumption, casePrompt, learnerAnswer, absentKeyPoints, presentKeyPoints;
  if (typeof params === 'object' && params !== null && !Array.isArray(params)) {
    ideaTitle = params.ideaTitle;
    recitedSentence = params.recitedSentence;
    hiddenAssumption = params.hiddenAssumption;
    casePrompt = params.casePrompt;
    learnerAnswer = params.learnerAnswer;
    absentKeyPoints = params.absentKeyPoints || params.absentPoints || [];
    presentKeyPoints = params.presentKeyPoints || params.presentPoints || [];
  } else {
    ideaTitle = params;
    recitedSentence = rest[0];
    hiddenAssumption = rest[1];
    casePrompt = rest[2];
    learnerAnswer = rest[3];
    absentKeyPoints = rest[4] || [];
    presentKeyPoints = rest[5] || [];
  }

  const systemPrompt = `You are an expert pedagogy guide creating a single targeted follow-up question.
The learner explained a concept, then attempted Case 1 and failed to state one or more key points.
Your goal is to ask ONE follow-up question that prompts them to reason mechanically about what happens step by step.

Prompt rules:
- Ask exactly ONE question, ending in a question mark.
- Aim it at the point where the learner's case answer went wrong or stayed vague. Ask what exactly happens, step by step, in the learner's own scenario, or what breaks.
- NEVER state, hint at, or paraphrase any absent key point. NEVER explain the concept. NEVER say "think about", "consider", "remember", or "have you thought about".
- Do not reuse distinctive words from the absent key points' text.
- If the learner's answer contradicts the case (for example, claims the server rejected something the case says it saved), ask a question that makes them walk through what the server receives and what it does with it, without telling them it was wrong.
- Output only the JSON.

You MUST respond with a JSON object containing exactly one key:
- "followup_question": "<one question>"

Tiny example JSON object:
{
  "followup_question": "When the customer sends the modified total from DevTools, what does the server do with that number before saving the order?"
}`;

  const absentFormatted = (absentKeyPoints && absentKeyPoints.length > 0)
    ? absentKeyPoints.map(kp => `- "${kp}"`).join('\n')
    : '(None)';

  const presentFormatted = (presentKeyPoints && presentKeyPoints.length > 0)
    ? presentKeyPoints.map(kp => `- "${kp}"`).join('\n')
    : '(None)';

  const promptAndAnswerWords = new Set((`${casePrompt} ${learnerAnswer}`).toLowerCase().match(/[a-z]{4,}/g) || []);
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

  const userPrompt = `Concept Idea:
"${ideaTitle}"

Initial Recited Sentence from explanation:
${recitedSentence ? `"${recitedSentence}"` : '(None identified)'}

Hidden Assumption:
${hiddenAssumption ? `"${hiddenAssumption}"` : '(None)'}

Case 1 Scenario Prompt:
"${casePrompt}"

Learner's Case 1 Answer:
"""
${learnerAnswer}
"""

Key Points already PRESENT in their answer:
${presentFormatted}

Key Points ABSENT from their answer (DO NOT state, hint at, or paraphrase these, and DO NOT reuse distinctive words from them):
${absentFormatted}
${forbiddenSection}
Write the single targeted follow-up question and return the JSON object:`;

  return { systemPrompt, userPrompt };
}

module.exports = {
  buildRecitedSentencePrompt,
  buildKeyPointsPrompt,
  buildFollowupPrompt
};
