// server/llm.js - Groq SDK integration with JSON mode, strict shape validation, and retry
require('dotenv').config();
const Groq = require('groq-sdk');
const { buildRecitedSentencePrompt, buildKeyPointsPrompt, buildFollowupPrompt } = require('./prompts');

const DEFAULT_MODEL = 'qwen/qwen3.8-27b';

/**
 * Check if a real Groq API key is configured.
 */
function hasValidApiKey() {
  const key = process.env.GROQ_API_KEY;
  return Boolean(key && key.trim() !== '' && !key.includes('your_groq_api_key'));
}

/**
 * Format Groq API errors into user-friendly messages for the UI.
 * Handles missing key, 401 invalid key, 429 rate limit, and model-not-found.
 */
function formatGroqError(err) {
  if (!hasValidApiKey()) {
    return new Error('Groq API key is missing. Please set GROQ_API_KEY in .env (get a free key at https://console.groq.com).');
  }

  const msg = err.message || '';
  const status = err.status || (err.response && err.response.status);

  if (status === 401 || msg.includes('401') || msg.toLowerCase().includes('invalid api key')) {
    return new Error('Invalid Groq API key (401). Please check your GROQ_API_KEY in .env.');
  }

  if (status === 429 || msg.includes('429') || msg.toLowerCase().includes('rate limit') || msg.toLowerCase().includes('rate_limit_exceeded')) {
    return new Error('Groq rate limit exceeded (429). Please wait a few seconds and retry.');
  }

  if (status === 404 || msg.includes('404') || msg.toLowerCase().includes('model_not_found') || msg.toLowerCase().includes('model not found') || msg.toLowerCase().includes('does not exist')) {
    const currentModel = process.env.LLM_MODEL || DEFAULT_MODEL;
    return new Error(`Groq model not found ("${currentModel}"). Please check your model name in .env against https://console.groq.com/docs/models.`);
  }

  return new Error(`Groq error: ${msg}`);
}

/**
 * Clean markdown fences and parse raw text into JSON.
 */
function cleanAndParseJson(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    throw new Error('LLM returned an empty response.');
  }

  let cleaned = rawText.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '');
  cleaned = cleaned.replace(/\s*```$/i, '');
  cleaned = cleaned.trim();

  try {
    return JSON.parse(cleaned);
  } catch (initialErr) {
    const match = cleaned.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (innerErr) {
        // Fall through
      }
    }
    throw new Error(`JSON parse error: ${initialErr.message}`);
  }
}

/**
 * Validate shape and types for Job A (Recited sentence analysis).
 * Expected keys: recited_sentence, type, hidden_assumption.
 */
function validateRecitedSentenceOutput(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Expected output to be a JSON object.');
  }

  const validTypes = ['definition', 'analogy', 'buzzword', 'none'];
  const type = data.type ? String(data.type).toLowerCase() : 'none';
  if (!validTypes.includes(type)) {
    throw new Error(`Field "type" must be one of: ${validTypes.join(', ')}.`);
  }

  if (!('recited_sentence' in data) || (data.recited_sentence !== null && typeof data.recited_sentence !== 'string')) {
    throw new Error('Field "recited_sentence" must be a string or null.');
  }

  return {
    recited_sentence: data.recited_sentence ? data.recited_sentence.trim() : null,
    type: type,
    hidden_assumption: data.hidden_assumption ? String(data.hidden_assumption).trim() : null
  };
}

/**
 * Validate shape and types for Job B (Key-point checking).
 */
function validateKeyPointsOutput(data, expectedKeyPoints) {
  if (!data || typeof data !== 'object') {
    throw new Error('Expected output to be a JSON object.');
  }

  const list = Array.isArray(data) ? data : data.key_points;
  if (!Array.isArray(list)) {
    throw new Error('Output must contain a "key_points" array.');
  }

  const expectedIds = new Set(expectedKeyPoints.map(kp => Number(kp.id)));
  const seenIds = new Set();
  const normalized = [];

  for (const item of list) {
    if (!item || typeof item !== 'object') {
      throw new Error('Each key point entry in "key_points" must be an object.');
    }

    const kpId = Number(item.key_point_id);
    if (isNaN(kpId) || !expectedIds.has(kpId)) {
      throw new Error(`key_point_id ${item.key_point_id} does not match any valid key point for this case.`);
    }

    if (typeof item.present !== 'boolean') {
      throw new Error(`Field "present" for key_point_id ${kpId} must be a boolean (true or false).`);
    }

    if (item.evidence !== undefined && typeof item.evidence !== 'string') {
      throw new Error(`Field "evidence" for key_point_id ${kpId} must be a string.`);
    }

    seenIds.add(kpId);
    normalized.push({
      key_point_id: kpId,
      present: item.present,
      evidence: item.present && typeof item.evidence === 'string' ? item.evidence.trim() : ''
    });
  }

  for (const expKp of expectedKeyPoints) {
    if (!seenIds.has(Number(expKp.id))) {
      throw new Error(`Missing evaluation for required key_point_id ${expKp.id}.`);
    }
  }

  return normalized;
}

/**
 * Validate shape and types for Job C (Follow-up question writing).
 * Output must be a JSON object with a non-empty followup_question string.
 */
function validateFollowupOutput(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Expected output to be a JSON object.');
  }

  if (!('followup_question' in data) || typeof data.followup_question !== 'string' || !data.followup_question.trim()) {
    throw new Error('Field "followup_question" must be a non-empty string.');
  }

  return {
    followup_question: data.followup_question.trim()
  };
}

/**
 * Call Groq chat.completions.create with JSON mode and 1-shot retry on validation error.
 */
async function callGroqWithValidation({ systemPrompt, userPrompt, temperature, validator, retryHint }) {
  if (!hasValidApiKey()) {
    console.warn('[LLM] No active GROQ_API_KEY found in .env. Using built-in conceptual evaluator fallback.');
    return null;
  }

  const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY
  });

  const model = process.env.LLM_MODEL || DEFAULT_MODEL;

  async function executeCall(promptText) {
    let completion;
    try {
      completion = await groq.chat.completions.create({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: promptText }
        ],
        model: model,
        temperature: temperature,
        response_format: { type: 'json_object' }
      });
    } catch (apiErr) {
      throw formatGroqError(apiErr);
    }

    const content = completion.choices && completion.choices[0] && completion.choices[0].message && completion.choices[0].message.content;
    if (!content) {
      throw new Error('Groq returned empty response content.');
    }

    let parsed;
    try {
      parsed = cleanAndParseJson(content);
    } catch (parseErr) {
      throw new Error(`Groq JSON parsing error: ${parseErr.message}`);
    }

    return validator(parsed);
  }

  try {
    return await executeCall(userPrompt);
  } catch (err1) {
    console.warn(`[Groq] Attempt 1 validation/parse failed: ${err1.message}. Retrying once with schema reminder...`);
    try {
      const retryPrompt = `${userPrompt}\n\nCRITICAL RETRY NOTICE: Your previous output failed validation: ${err1.message}. ${retryHint || 'Output ONLY the required JSON object with exact keys and types.'}`;
      return await executeCall(retryPrompt);
    } catch (err2) {
      console.error(`[Groq] Attempt 2 also failed: ${err2.message}`);
      throw err2;
    }
  }
}

/**
 * Fallback evaluator when no GROQ_API_KEY is configured.
 */
function mockFindRecitedSentence(ideaTitle, explanationText) {
  const text = (explanationText || '').trim();
  const sentences = text.match(/[^.!?]+[.!?]+|\s*[^.!?]+$/g) || [text];

  const buzzwords = [
    'security reasons', 'for security', 'best practice', 'scalability',
    'industry standard', 'safer', 'more safe', 'it is safer',
    'just standard', 'standard way', 'because of security', 'to be secure'
  ];

  const analogies = [
    'like a waiter', 'like a kitchen', 'like a restaurant', 'like a brain',
    'like a postal', 'like a traffic', 'like a policeman', 'is like a'
  ];

  const definitions = [
    'a backend is', 'the backend is a', 'is defined as', 'storage means',
    'a database is where', 'the server is a computer that'
  ];

  for (const sentence of sentences) {
    const sLower = sentence.toLowerCase();
    for (const buzz of buzzwords) {
      if (sLower.includes(buzz)) {
        return {
          recited_sentence: sentence.trim(),
          type: 'buzzword',
          hidden_assumption: 'Assumes citing "security" or standard practice explains the mechanism preventing abuse.'
        };
      }
    }

    for (const analogy of analogies) {
      if (sLower.includes(analogy)) {
        return {
          recited_sentence: sentence.trim(),
          type: 'analogy',
          hidden_assumption: 'Assumes the metaphor directly mirrors the physical constraints of computing memory and network boundaries.'
        };
      }
    }

    for (const def of definitions) {
      if (sLower.includes(def)) {
        return {
          recited_sentence: sentence.trim(),
          type: 'definition',
          hidden_assumption: 'Assumes describing the role of a component explains why an app cannot function without it.'
        };
      }
    }
  }

  return {
    recited_sentence: null,
    type: 'none',
    hidden_assumption: null
  };
}

/**
 * Fallback evaluator for key points when no key is present.
 */
function mockCheckKeyPoints(learnerAnswer, keyPoints) {
  const answer = (learnerAnswer || '').trim().toLowerCase();

  const vaguePhrases = [
    "it's insecure", "its insecure", "it is insecure",
    "for security reasons", "security reasons",
    "bad things happen", "bad things can happen", "something bad happens",
    "best practice", "not best practice",
    "it's bad", "its bad", "not safe", "unsecure",
    "they can hack it", "it's more secure that way", "its more secure that way",
    "by using a different account", "it keeps a record", "it's about storage", "its about storage"
  ];

  const isPurelyVague = vaguePhrases.some(v => answer === v || answer.replace(/[.!?]/g, '') === v);

  return keyPoints.map(kp => {
    if (isPurelyVague) {
      return {
        key_point_id: kp.id,
        present: false,
        evidence: ''
      };
    }

    const kpText = kp.text.toLowerCase();
    let present = false;
    let evidence = '';

    if (kpText.includes('price (1)') || kpText.includes('changed price')) {
      if (answer.includes('1') || answer.includes('changed price') || answer.includes('saved at 1') || answer.includes('order goes through')) {
        present = true;
        evidence = learnerAnswer.slice(0, 50);
      }
    } else if (kpText.includes('edited by the user') || kpText.includes('browser can be edited') || kpText.includes('clear or edit it')) {
      if (answer.includes('devtools') || answer.includes('browser') || answer.includes('client') || answer.includes('user can change') || answer.includes('inspect') || answer.includes('clear')) {
        present = true;
        evidence = learnerAnswer.slice(0, 50);
      }
    } else if (kpText.includes('recompute') || kpText.includes('verify the price') || kpText.includes('does not enforce')) {
      if (answer.includes('recompute') || answer.includes('verify') || answer.includes('check the price') || answer.includes('server-side validation') || answer.includes('validate on server') || answer.includes('enforce')) {
        present = true;
        evidence = learnerAnswer.slice(0, 50);
      }
    } else if (kpText.includes('empty list')) {
      if (answer.includes('empty') || answer.includes('nothing') || answer.includes('blank')) {
        present = true;
        evidence = learnerAnswer.slice(0, 50);
      }
    } else if (kpText.includes('shared place') || kpText.includes('each device keeps its own copy')) {
      if (answer.includes('local') || answer.includes('separate') || answer.includes('no server') || answer.includes('not synced') || answer.includes('own copy') || answer.includes('shared')) {
        present = true;
        evidence = learnerAnswer.slice(0, 50);
      }
    } else if (kpText.includes('read the key')) {
      if (answer.includes('read') || answer.includes('see') || answer.includes('steal') || answer.includes('source') || answer.includes('inspect') || answer.includes('view')) {
        present = true;
        evidence = learnerAnswer.slice(0, 50);
      }
    } else if (kpText.includes('billed to the developer') || kpText.includes('make requests')) {
      if (answer.includes('bill') || answer.includes('use') || answer.includes('cost') || answer.includes('free') || answer.includes('quota') || answer.includes('drain')) {
        present = true;
        evidence = learnerAnswer.slice(0, 50);
      }
    } else if (kpText.includes('already sent to the browser')) {
      if (answer.includes('already sent') || answer.includes('downloaded') || answer.includes('received') || answer.includes('no') || answer.includes('public')) {
        present = true;
        evidence = learnerAnswer.slice(0, 50);
      }
    } else if (kpText.includes('notes are gone') || kpText.includes('empty')) {
      if (answer.includes('gone') || answer.includes('lost') || answer.includes('deleted') || answer.includes('empty') || answer.includes('disappear')) {
        present = true;
        evidence = learnerAnswer.slice(0, 50);
      }
    } else if (kpText.includes('restarts') || kpText.includes('memory') || kpText.includes('running program')) {
      if (answer.includes('restart') || answer.includes('ram') || answer.includes('memory') || answer.includes('process') || answer.includes('variable')) {
        present = true;
        evidence = learnerAnswer.slice(0, 50);
      }
    } else if (kpText.includes('database') || kpText.includes('outlasts the program') || kpText.includes('persistent')) {
      if (answer.includes('database') || answer.includes('disk') || answer.includes('persist') || answer.includes('storage') || answer.includes('saved')) {
        present = true;
        evidence = learnerAnswer.slice(0, 50);
      }
    } else if (kpText.includes('cannot tell the name') || kpText.includes('does not know it')) {
      if (answer.includes('cannot') || answer.includes('does not know') || answer.includes('not know') || answer.includes('not remember')) {
        present = true;
        evidence = learnerAnswer.slice(0, 50);
      }
    } else if (kpText.includes('nothing is remembered between calls') || kpText.includes('each call only carries')) {
      if (answer.includes('stateless') || answer.includes('nothing') || answer.includes('between calls') || answer.includes('each call') || answer.includes('forget')) {
        present = true;
        evidence = learnerAnswer.slice(0, 50);
      }
    } else if (kpText.includes('not a grade') || kpText.includes('never told what to do')) {
      if (answer.includes('not a grade') || answer.includes('no grade') || answer.includes('never told') || answer.includes('no instructions')) {
        present = true;
        evidence = learnerAnswer.slice(0, 50);
      }
    } else if (kpText.includes('instructions have to travel') || kpText.includes('one package')) {
      if (answer.includes('instructions') || answer.includes('package') || answer.includes('same call') || answer.includes('prompt')) {
        present = true;
        evidence = learnerAnswer.slice(0, 50);
      }
    } else {
      const significantWords = kpText.split(/\s+/).filter(w => w.length > 4);
      const matchCount = significantWords.filter(w => answer.includes(w)).length;
      if (matchCount >= 2 && !isPurelyVague) {
        present = true;
        evidence = learnerAnswer.slice(0, 50);
      }
    }

    return {
      key_point_id: kp.id,
      present,
      evidence: present ? (evidence || learnerAnswer.slice(0, 40)) : ''
    };
  });
}

/**
 * Fallback follow-up writer when no key is configured.
 */
function mockWriteFollowupQuestion({ ideaTitle, casePrompt, learnerAnswer }) {
  return {
    followup_question: "When the request is sent from the user's browser, what exact step does the application take next to process that data?"
  };
}

/**
 * AI Job A: Find recited sentence in learner's explanation (WITHOUT follow-up).
 * Temperature: 0.3
 * Output: { recited_sentence, type, hidden_assumption }
 */
async function findRecitedSentence(ideaTitle, explanationText) {
  const { systemPrompt, userPrompt } = buildRecitedSentencePrompt(ideaTitle, explanationText);

  let result = null;
  try {
    result = await callGroqWithValidation({
      systemPrompt,
      userPrompt,
      temperature: 0.3,
      validator: validateRecitedSentenceOutput,
      retryHint: 'Ensure you output a valid JSON object with keys: recited_sentence, type, hidden_assumption.'
    });
  } catch (err) {
    console.error('[Groq] Error during findRecitedSentence:', err.message);
    throw err;
  }

  if (!result) {
    result = mockFindRecitedSentence(ideaTitle, explanationText);
  }

  return result;
}

/**
 * AI Job B: Check key points against learner's case answer.
 * Temperature: 0
 * Output: Array of { key_point_id, present, evidence }
 */
async function checkKeyPoints(casePrompt, caseTheme, learnerAnswer, keyPoints) {
  const { systemPrompt, userPrompt } = buildKeyPointsPrompt(casePrompt, caseTheme, learnerAnswer, keyPoints);

  let result = null;
  try {
    result = await callGroqWithValidation({
      systemPrompt,
      userPrompt,
      temperature: 0,
      validator: (data) => validateKeyPointsOutput(data, keyPoints),
      retryHint: 'Ensure you output a valid JSON object with key "key_points" containing an array of { key_point_id, present, evidence }.'
    });
  } catch (err) {
    console.error('[Groq] Error during checkKeyPoints:', err.message);
    throw err;
  }

  if (!result) {
    result = mockCheckKeyPoints(learnerAnswer, keyPoints);
  }

  return result;
}

/**
 * AI Job C: Write targeted follow-up question after Case 1 failure.
 * Temperature: 0.3
 * Output: { followup_question }
 */
async function writeFollowupQuestion(params, ...rest) {
  const { systemPrompt, userPrompt } = buildFollowupPrompt(params, ...rest);

  let result = null;
  try {
    result = await callGroqWithValidation({
      systemPrompt,
      userPrompt,
      temperature: 0.3,
      validator: validateFollowupOutput,
      retryHint: 'Ensure you output a valid JSON object with a single key "followup_question" containing one question string ending in a question mark.'
    });
  } catch (err) {
    console.error('[Groq] Error during writeFollowupQuestion:', err.message);
    throw err;
  }

  if (!result) {
    result = mockWriteFollowupQuestion(params);
  }

  return result;
}

module.exports = {
  findRecitedSentence,
  checkKeyPoints,
  writeFollowupQuestion,
  cleanAndParseJson,
  hasValidApiKey,
  formatGroqError,
  validateRecitedSentenceOutput,
  validateKeyPointsOutput,
  validateFollowupOutput
};
