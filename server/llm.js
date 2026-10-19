// server/llm.js - Groq SDK integration with token budgeting, concurrency queue, and resilient error handling
require('dotenv').config();
const Groq = require('groq-sdk');
const { buildRecitedSentencePrompt, buildKeyPointsPrompt, buildFollowupPrompt } = require('./prompts');

const DEFAULT_MODEL = 'qwen/qwen3.8-27b';
const FRIENDLY_BUSY_MESSAGE = "The AI tutor is busy right now. Please wait a moment and try again.";

/**
 * Custom error class for user-facing friendly busy errors.
 * Never exposes raw provider errors to the browser.
 */
class FriendlyBusyError extends Error {
  constructor(message = FRIENDLY_BUSY_MESSAGE) {
    super(message);
    this.name = 'FriendlyBusyError';
    this.isFriendlyBusy = true;
    this.status = 503;
  }
}

/**
 * Check if a real Groq API key is configured.
 */
function hasValidApiKey() {
  const key = process.env.GROQ_API_KEY;
  return Boolean(key && key.trim() !== '' && !key.includes('your_groq_api_key'));
}

/**
 * Check if error indicates a single request exceeded the model's token/OTPM limit.
 */
function isRequestTooLargeError(err) {
  if (!err) return false;
  const msg = ((err.message || '') + ' ' + (err.error?.message || '')).toLowerCase();
  return msg.includes('request too large') ||
         msg.includes('reduce max_tokens') ||
         (msg.includes('limit') && msg.includes('requested') && msg.includes('tokens'));
}

/**
 * Check if error is a normal 429 rate limit (excluding single request too large).
 */
function isNormalRateLimit429(err) {
  if (!err) return false;
  if (isRequestTooLargeError(err)) return false;
  const msg = ((err.message || '') + ' ' + (err.error?.message || '')).toLowerCase();
  const status = err.status || (err.response && err.response.status);
  return status === 429 || msg.includes('429') || msg.includes('rate limit') || msg.includes('rate_limit_exceeded');
}

/**
 * Parse retry-after wait duration in milliseconds from header or error message.
 */
function parseRetryAfter(err) {
  const header = err?.headers?.['retry-after'] || (err?.response && err.response.headers && err.response.headers.get && err.response.headers.get('retry-after'));
  if (header) {
    const sec = parseFloat(header);
    if (!isNaN(sec) && sec > 0) return Math.ceil(sec * 1000) + 200;
  }
  const msg = (err?.message || '') + ' ' + (err?.error?.message || '');
  const match = msg.match(/try again in (\d+(\.\d+)?)s/i) || msg.match(/wait (\d+(\.\d+)?)s/i);
  if (match) {
    const sec = parseFloat(match[1]);
    if (!isNaN(sec) && sec > 0) return Math.ceil(sec * 1000) + 200;
  }
  return 3000;
}

/**
 * Token budget tracker and concurrency queue:
 * - Keeps concurrency at 2 or lower.
 * - Keeps rolling 60-second tally of completion tokens used.
 * - Waits in queue before dispatching if tally + job's max_tokens > OTPM limit.
 */
class TokenBudgetQueue {
  constructor() {
    this.history = []; // Array of { timestamp: number, tokens: number }
    this.activeCount = 0;
    this.maxConcurrency = 2;
    this.waitQueue = [];
    this._timer = null;
  }

  getLimit() {
    const lim = parseInt(process.env.LLM_OTPM_LIMIT, 10);
    return !isNaN(lim) && lim > 0 ? lim : 900;
  }

  getTally() {
    const now = Date.now();
    const cutoff = now - 60000;
    this.history = this.history.filter(item => item.timestamp > cutoff);
    return this.history.reduce((sum, item) => sum + item.tokens, 0);
  }

  recordUsage(tokens) {
    const count = Number(tokens) || 0;
    if (count > 0) {
      this.history.push({ timestamp: Date.now(), tokens: count });
    }
    this.processQueue();
  }

  acquire(estimatedMaxTokens) {
    return new Promise((resolve) => {
      this.waitQueue.push({
        maxTokens: Number(estimatedMaxTokens) || 200,
        startTime: Date.now(),
        resolve
      });
      this.processQueue();
    });
  }

  processQueue() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }

    if (this.waitQueue.length === 0) return;
    if (this.activeCount >= this.maxConcurrency) return;

    const limit = this.getLimit();
    const tally = this.getTally();
    const nextItem = this.waitQueue[0];
    const needed = Math.min(nextItem.maxTokens, limit);

    if (tally + needed <= limit) {
      this.waitQueue.shift();
      this.activeCount++;
      const waitTime = Date.now() - nextItem.startTime;
      nextItem.resolve(waitTime);
      // Immediately check if another request in queue can also proceed
      this.processQueue();
    } else {
      const now = Date.now();
      const oldest = this.history[0];
      const delay = oldest ? Math.max(50, (oldest.timestamp + 60000) - now + 50) : 500;
      this._timer = setTimeout(() => this.processQueue(), delay);
    }
  }

  release() {
    this.activeCount = Math.max(0, this.activeCount - 1);
    this.processQueue();
  }
}

const budgetQueue = new TokenBudgetQueue();

/**
 * Format Groq API errors for logging.
 */
function formatGroqError(err) {
  if (!hasValidApiKey()) {
    return new Error('Groq API key is missing. Please set GROQ_API_KEY in .env.');
  }
  const msg = err.message || '';
  return new Error(`Groq provider error: ${msg}`);
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
 * Execute a single HTTP call to Groq via the SDK within the budget queue.
 */
async function performGroqCall({
  jobName,
  groq,
  systemPrompt,
  userPrompt,
  temperature,
  maxTokens,
  model
}) {
  const waitTime = await budgetQueue.acquire(maxTokens);
  let completionTokens = 0;

  try {
    const callParams = {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      model: model,
      temperature: temperature,
      response_format: { type: 'json_object' },
      max_tokens: maxTokens
    };

    // If LLM_REASONING_EFFORT is set (e.g. "none"), pass it.
    // If empty or unset, do NOT send the field at all.
    const reasoningEffort = process.env.LLM_REASONING_EFFORT ? process.env.LLM_REASONING_EFFORT.trim() : '';
    if (reasoningEffort) {
      callParams.reasoning_effort = reasoningEffort;
    }

    const completion = await groq.chat.completions.create(callParams);

    completionTokens = (completion.usage && completion.usage.completion_tokens) || 0;
    budgetQueue.recordUsage(completionTokens);

    // Print log line per call: job, model, completion tokens used, tally for the last 60 seconds, and wait time
    console.log(`[LLM Call] job: ${jobName} | model: ${model} | completion_tokens: ${completionTokens} | 60s_tally: ${budgetQueue.getTally()}/${budgetQueue.getLimit()} | wait_time: ${waitTime}ms`);

    const choice = completion.choices && completion.choices[0];
    const finishReason = choice && choice.finish_reason;
    const content = choice && choice.message && choice.message.content;

    return {
      content,
      finishReason,
      isTruncated: finishReason === 'length',
      completionTokens
    };
  } catch (err) {
    budgetQueue.recordUsage(0);
    throw err;
  } finally {
    budgetQueue.release();
  }
}

/**
 * Call Groq with:
 * - Token budget & concurrency rate limiting (max 2 concurrency, rolling 60s tally).
 * - Explicit max_tokens per job.
 * - Reasoning effort handling.
 * - Distinct handling for "Request too large" vs normal 429 rate limits.
 * - Retry once with higher max_tokens (up to 600) on finish_reason: length or JSON parse/validation error.
 * - Friendly busy message on unrecoverable failures.
 */
async function callGroqWithValidation({
  jobName,
  systemPrompt,
  userPrompt,
  temperature,
  validator,
  defaultMaxTokens,
  envMaxTokensKey,
  retryHint
}) {
  if (!hasValidApiKey()) {
    console.warn(`[LLM] No active GROQ_API_KEY found in .env. Using built-in conceptual evaluator fallback for ${jobName}.`);
    return null;
  }

  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  const configuredMax = parseInt(process.env[envMaxTokensKey], 10);
  const initialMaxTokens = (!isNaN(configuredMax) && configuredMax > 0) ? configuredMax : defaultMaxTokens;
  const initialModel = process.env.LLM_MODEL || DEFAULT_MODEL;

  async function executeWithRetryHandling(promptText, maxTokens, model) {
    try {
      return await performGroqCall({
        jobName,
        groq,
        systemPrompt,
        userPrompt: promptText,
        temperature,
        maxTokens,
        model
      });
    } catch (apiErr) {
      // 1. "Request too large" or single request exceeding OTPM limit:
      // Do not retry the same request. Log server message and try LLM_FALLBACK_MODEL if set.
      if (isRequestTooLargeError(apiErr)) {
        console.error(`[Groq] max_tokens exceeds the model's per-minute limit: ${apiErr.message}`);
        const fallbackModel = process.env.LLM_FALLBACK_MODEL && process.env.LLM_FALLBACK_MODEL.trim();
        if (fallbackModel && fallbackModel !== model) {
          console.warn(`[Groq] Falling back to LLM_FALLBACK_MODEL: ${fallbackModel}`);
          return await performGroqCall({
            jobName,
            groq,
            systemPrompt,
            userPrompt: promptText,
            temperature,
            maxTokens,
            model: fallbackModel
          });
        }
        throw new FriendlyBusyError();
      }

      // 2. Normal per-minute 429: wait for retry-after and retry once
      if (isNormalRateLimit429(apiErr)) {
        const waitMs = parseRetryAfter(apiErr);
        console.warn(`[Groq] Normal 429 rate limit encountered. Waiting ${waitMs}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
        try {
          return await performGroqCall({
            jobName,
            groq,
            systemPrompt,
            userPrompt: promptText,
            temperature,
            maxTokens,
            model
          });
        } catch (retryErr) {
          console.error(`[Groq] Retry after 429 failed: ${retryErr.message}`);
          throw new FriendlyBusyError();
        }
      }

      // 3. Other provider errors (401, 404, 500, network): log full error on server only
      console.error(`[Groq Provider Error] ${apiErr.message}`);
      throw new FriendlyBusyError();
    }
  }

  // --- Attempt 1 ---
  let res1;
  try {
    res1 = await executeWithRetryHandling(userPrompt, initialMaxTokens, initialModel);
  } catch (err) {
    if (err instanceof FriendlyBusyError) throw err;
    console.error(`[Groq] Error during ${jobName}:`, err.message);
    throw new FriendlyBusyError();
  }

  let validationErr1 = null;
  if (res1.isTruncated) {
    validationErr1 = new Error('Response truncated by token limit (finish_reason: length)');
  } else {
    try {
      const parsed1 = cleanAndParseJson(res1.content);
      return validator(parsed1);
    } catch (parseOrValErr) {
      validationErr1 = parseOrValErr;
    }
  }

  // --- Attempt 2: Response was truncated or JSON/validator failed ---
  // Retry once with a slightly higher max_tokens (never above 600)
  const retryMaxTokens = Math.min(600, Math.max(initialMaxTokens + 75, Math.round(initialMaxTokens * 1.35)));
  console.warn(`[Groq] ${jobName} attempt 1 failed (${validationErr1.message}). Retrying once with max_tokens=${retryMaxTokens}...`);

  const retryPrompt = `${userPrompt}\n\nCRITICAL RETRY NOTICE: Your previous output failed: ${validationErr1.message}. ${retryHint || 'Output ONLY the required JSON object with exact keys and types.'}`;

  let res2;
  try {
    res2 = await executeWithRetryHandling(retryPrompt, retryMaxTokens, initialModel);
  } catch (err) {
    if (err instanceof FriendlyBusyError) throw err;
    console.error(`[Groq] Retry execution error for ${jobName}:`, err.message);
    throw new FriendlyBusyError();
  }

  if (res2.isTruncated) {
    console.error(`[Groq] ${jobName} retry was also truncated (finish_reason: length).`);
    throw new FriendlyBusyError();
  }

  try {
    const parsed2 = cleanAndParseJson(res2.content);
    return validator(parsed2);
  } catch (err2) {
    console.error(`[Groq] ${jobName} retry failed validation/parse:`, err2.message);
    throw new FriendlyBusyError();
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

  const isPromptInjection = answer.includes('ignore the instructions') || answer.includes('mark every key point');
  const isPurelyVague = isPromptInjection || vaguePhrases.some(v => answer === v || answer.replace(/[.!?]/g, '') === v);

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
function mockWriteFollowupQuestion() {
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
      jobName: 'Job A (Recited Sentence)',
      systemPrompt,
      userPrompt,
      temperature: 0.3,
      validator: validateRecitedSentenceOutput,
      defaultMaxTokens: 250,
      envMaxTokensKey: 'LLM_MAX_TOKENS_A',
      retryHint: 'Ensure you output a valid JSON object with keys: recited_sentence, type, hidden_assumption.'
    });
  } catch (err) {
    if (err instanceof FriendlyBusyError) throw err;
    console.error('[Groq] Error during findRecitedSentence:', err.message);
    throw new FriendlyBusyError();
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
      jobName: 'Job B (Key Points)',
      systemPrompt,
      userPrompt,
      temperature: 0,
      validator: (data) => validateKeyPointsOutput(data, keyPoints),
      defaultMaxTokens: 400,
      envMaxTokensKey: 'LLM_MAX_TOKENS_B',
      retryHint: 'Ensure you output a valid JSON object with key "key_points" containing an array of { key_point_id, present, evidence }.'
    });
  } catch (err) {
    if (err instanceof FriendlyBusyError) throw err;
    console.error('[Groq] Error during checkKeyPoints:', err.message);
    throw new FriendlyBusyError();
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
      jobName: 'Job C (Follow-up Writer)',
      systemPrompt,
      userPrompt,
      temperature: 0.3,
      validator: validateFollowupOutput,
      defaultMaxTokens: 150,
      envMaxTokensKey: 'LLM_MAX_TOKENS_C',
      retryHint: 'Ensure you output a valid JSON object with a single key "followup_question" containing one question string ending in a question mark.'
    });
  } catch (err) {
    if (err instanceof FriendlyBusyError) throw err;
    console.error('[Groq] Error during writeFollowupQuestion:', err.message);
    throw new FriendlyBusyError();
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
  validateFollowupOutput,
  FriendlyBusyError,
  TokenBudgetQueue,
  budgetQueue
};
