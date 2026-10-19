// public/app.js - Plain vanilla JS state machine for Concept Check v2

(function () {
  'use strict';

  // Application State
  const state = {
    learner: null,              // { id, code, tester_type }
    currentIdea: null,          // { id, title }
    currentExplanationId: null, // number
    currentGapId: null,         // number
    currentGap: null,           // { id, recited_sentence, followup_question, type, hidden_assumption }
    currentCase1: null,         // { id, prompt, theme }
    currentCase2: null,         // { id, prompt, theme }
    case1Result: null,          // { passed, passedPoints, totalPoints, followupAsked }
    isChallengeMode: false      // boolean (when Case 1 passed and user does a challenge case)
  };

  // DOM Elements
  const elements = {
    learnerBadge: document.getElementById('learner-badge'),
    dbStatusPill: document.getElementById('db-status-pill'),
    llmStatusPill: document.getElementById('llm-status-pill'),
    errorBanner: document.getElementById('error-banner'),
    errorMessage: document.getElementById('error-message'),
    closeErrorBtn: document.getElementById('close-error-btn'),

    // Screens
    screenConsent: document.getElementById('screen-consent'),
    screenIdeas: document.getElementById('screen-ideas'),
    screenExplain: document.getElementById('screen-explain'),
    screenCase1: document.getElementById('screen-case1'),
    screenCase1Passed: document.getElementById('screen-case1-passed'),
    screenFollowup: document.getElementById('screen-followup'),
    screenCase2: document.getElementById('screen-case2'),
    screenResult: document.getElementById('screen-result'),

    // Consent
    consentCheckbox: document.getElementById('consent-checkbox'),
    testerTypeSelect: document.getElementById('tester-type-select'),
    btnStartConsent: document.getElementById('btn-start-consent'),

    // Ideas
    ideasContainer: document.getElementById('ideas-container'),

    // Explain
    explainIdeaTitle: document.getElementById('explain-idea-title'),
    explanationInput: document.getElementById('explanation-input'),
    explainLoading: document.getElementById('explain-loading'),
    btnSubmitExplanation: document.getElementById('btn-submit-explanation'),
    btnBackToIdeas: document.getElementById('btn-back-to-ideas'),

    // Case 1
    case1ThemePill: document.getElementById('case1-theme-pill'),
    case1Prompt: document.getElementById('case1-prompt'),
    case1Answer: document.getElementById('case1-answer'),
    case1Loading: document.getElementById('case1-loading'),
    btnSubmitCase1: document.getElementById('btn-submit-case1'),

    // Case 1 Passed
    case1PassedKeypoints: document.getElementById('case1-passed-keypoints'),
    btnChallengeCase: document.getElementById('btn-challenge-case'),
    btnPassAnotherIdea: document.getElementById('btn-pass-another-idea'),

    // Follow-up
    recitedContainer: document.getElementById('recited-container'),
    recitedQuote: document.getElementById('recited-quote'),
    hiddenAssumption: document.getElementById('hidden-assumption'),
    followupQuestionText: document.getElementById('followup-question-text'),
    followupAnswer: document.getElementById('followup-answer'),
    followupLoading: document.getElementById('followup-loading'),
    btnSubmitFollowup: document.getElementById('btn-submit-followup'),

    // Case 2
    case2ThemePill: document.getElementById('case2-theme-pill'),
    case2Prompt: document.getElementById('case2-prompt'),
    case2Answer: document.getElementById('case2-answer'),
    case2Loading: document.getElementById('case2-loading'),
    btnSubmitCase2: document.getElementById('btn-submit-case2'),

    // Result
    resultBanner: document.getElementById('result-banner'),
    resultKeypoints: document.getElementById('result-keypoints'),
    btnResultAnotherIdea: document.getElementById('btn-result-another-idea')
  };

  // --- SCREEN SWITCHER ---
  function showScreen(screenEl) {
    clearError();
    const screens = [
      elements.screenConsent,
      elements.screenIdeas,
      elements.screenExplain,
      elements.screenCase1,
      elements.screenCase1Passed,
      elements.screenFollowup,
      elements.screenCase2,
      elements.screenResult
    ];
    screens.forEach(s => {
      if (s) s.classList.remove('active');
    });
    if (screenEl) {
      screenEl.classList.add('active');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  // --- ERROR HANDLING ---
  function showError(msg) {
    elements.errorMessage.textContent = msg || 'An unexpected error occurred.';
    elements.errorBanner.classList.remove('hidden');
    elements.errorBanner.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function clearError() {
    elements.errorBanner.classList.add('hidden');
    elements.errorMessage.textContent = '';
  }

  elements.closeErrorBtn.addEventListener('click', clearError);

  // --- API HELPER ---
  async function apiFetch(endpoint, options = {}) {
    try {
      const res = await fetch(endpoint, {
        headers: {
          'Content-Type': 'application/json',
          ...(options.headers || {})
        },
        ...options
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || `Request failed with status ${res.status}`);
      }
      return data;
    } catch (err) {
      showError(err.message);
      throw err;
    }
  }

  // --- 1. CONSENT STEP ---
  elements.consentCheckbox.addEventListener('change', () => {
    elements.btnStartConsent.disabled = !elements.consentCheckbox.checked;
  });

  elements.btnStartConsent.addEventListener('click', async () => {
    try {
      elements.btnStartConsent.disabled = true;
      elements.btnStartConsent.textContent = 'Registering...';

      const learner = await apiFetch('/api/learners', {
        method: 'POST',
        body: JSON.stringify({
          consent: true,
          tester_type: elements.testerTypeSelect.value
        })
      });

      state.learner = learner;
      sessionStorage.setItem('cc_learner', JSON.stringify(learner));

      // Update badge
      elements.learnerBadge.textContent = `Learner: ${learner.code} (${learner.tester_type})`;
      elements.learnerBadge.style.display = 'inline-block';

      // Load Ideas in array order with blurbs and cases left
      await loadIdeas();
    } catch (err) {
      elements.btnStartConsent.disabled = false;
      elements.btnStartConsent.textContent = 'Begin Session';
    }
  });

  // --- 2. PICK AN IDEA ---
  async function loadIdeas() {
    try {
      const url = state.learner ? `/api/ideas?learner_id=${state.learner.id}` : '/api/ideas';
      const ideas = await apiFetch(url);
      elements.ideasContainer.innerHTML = '';

      ideas.forEach(idea => {
        const card = document.createElement('div');
        const isDisabled = Boolean(idea.disabled);
        card.className = `idea-card ${isDisabled ? 'disabled' : ''}`;
        
        card.innerHTML = `
          <div class="idea-card-content">
            <div class="idea-card-title">${escapeHtml(idea.title)}</div>
            <div class="idea-card-blurb">${escapeHtml(idea.blurb || '')}</div>
            <span class="cases-left-badge ${idea.cases_left === 0 ? 'empty' : ''}">${escapeHtml(idea.cases_left_text)}</span>
          </div>
          <div class="idea-arrow">&rarr;</div>
        `;

        if (!isDisabled) {
          card.addEventListener('click', () => selectIdea(idea));
        } else {
          card.addEventListener('click', () => {
            showError('All cases for this concept have already been attempted. Please choose another concept.');
          });
        }

        elements.ideasContainer.appendChild(card);
      });

      showScreen(elements.screenIdeas);
    } catch (err) {
      showError('Failed to load concepts: ' + err.message);
    }
  }

  function selectIdea(idea) {
    state.currentIdea = idea;
    state.currentExplanationId = null;
    state.currentGapId = null;
    state.currentGap = null;
    state.currentCase1 = null;
    state.currentCase2 = null;
    state.case1Result = null;
    state.isChallengeMode = false;

    elements.explainIdeaTitle.textContent = idea.title;
    elements.explanationInput.value = '';

    showScreen(elements.screenExplain);
  }

  elements.btnBackToIdeas.addEventListener('click', async () => {
    await loadIdeas();
  });

  // --- 3. SUBMIT EXPLANATION ---
  elements.btnSubmitExplanation.addEventListener('click', async () => {
    const text = elements.explanationInput.value.trim();
    if (text.length < 15) {
      showError('Please provide a more complete explanation in your own words (at least a full sentence).');
      return;
    }

    try {
      elements.btnSubmitExplanation.disabled = true;
      elements.explainLoading.style.display = 'flex';
      clearError();

      const result = await apiFetch('/api/explanations', {
        method: 'POST',
        body: JSON.stringify({
          learner_id: state.learner.id,
          idea_id: state.currentIdea.id,
          text: text
        })
      });

      if (result.no_fresh_cases) {
        showError('no fresh case left for this idea. Please select another concept.');
        await loadIdeas();
        return;
      }

      state.currentExplanationId = result.explanation_id;
      state.currentGapId = result.gap_id;
      state.currentCase1 = result.case;

      // DO NOT show the follow-up yet. Transition straight to Case 1.
      elements.case1ThemePill.textContent = `Theme: ${result.case.theme}`;
      elements.case1Prompt.textContent = result.case.prompt;
      elements.case1Answer.value = '';

      showScreen(elements.screenCase1);
    } catch (err) {
      // Error handled in apiFetch
    } finally {
      elements.btnSubmitExplanation.disabled = false;
      elements.explainLoading.style.display = 'none';
    }
  });

  // --- 4. SUBMIT CASE 1 ("BEFORE") ---
  elements.btnSubmitCase1.addEventListener('click', async () => {
    const answer = elements.case1Answer.value.trim();
    if (answer.length < 4) {
      showError('Please provide an answer to the scenario before submitting.');
      return;
    }

    try {
      elements.btnSubmitCase1.disabled = true;
      elements.case1Loading.style.display = 'flex';
      clearError();

      // Case 1 has gap_id: null
      const result = await apiFetch('/api/attempts', {
        method: 'POST',
        body: JSON.stringify({
          learner_id: state.learner.id,
          case_id: state.currentCase1.id,
          gap_id: null,
          answer_text: answer
        })
      });

      const passedCount = (result.evaluations || []).filter(e => e.present).length;
      const totalCount = (result.evaluations || []).length;
      state.case1Result = {
        passed: result.passed,
        passedPoints: passedCount,
        totalPoints: totalCount,
        followupAsked: !result.passed
      };

      if (result.passed) {
        // Case 1 passed: show "no gap found on this one"
        renderKeyPointsList(elements.case1PassedKeypoints, result.evaluations);
        showScreen(elements.screenCase1Passed);
      } else {
        // Case 1 failed: show the recited sentence and ONE follow-up question
        state.currentGap = result.gap;
        renderFollowupScreen(result.gap);
        showScreen(elements.screenFollowup);
      }
    } catch (err) {
      // Error handled
    } finally {
      elements.btnSubmitCase1.disabled = false;
      elements.case1Loading.style.display = 'none';
    }
  });

  // --- 5. RENDER FOLLOW-UP SCREEN ---
  function renderFollowupScreen(gap) {
    elements.followupAnswer.value = '';

    if (gap && gap.recited_sentence) {
      elements.recitedContainer.style.display = 'block';
      elements.recitedQuote.textContent = `«${gap.recited_sentence}»`;
      if (gap.hidden_assumption) {
        elements.hiddenAssumption.textContent = `Hidden assumption: ${gap.hidden_assumption}`;
      } else {
        elements.hiddenAssumption.textContent = '';
      }
    } else {
      // Mechanism explanation with no verbatim recitation
      elements.recitedContainer.style.display = 'block';
      elements.recitedQuote.textContent = `Regarding your explanation of ${state.currentIdea.title}:`;
      elements.hiddenAssumption.textContent = 'Explore the concrete consequence of this mechanism:';
    }

    elements.followupQuestionText.textContent = (gap && gap.followup_question)
      ? gap.followup_question
      : 'What actually breaks or what happens step by step if this is bypassed?';
  }

  // --- 6. SUBMIT FOLLOW-UP & FETCH CASE 2 ---
  elements.btnSubmitFollowup.addEventListener('click', async () => {
    const outcomeText = elements.followupAnswer.value.trim();
    if (outcomeText.length < 5) {
      showError('Please explain what breaks or happens step by step before proceeding.');
      return;
    }

    try {
      elements.btnSubmitFollowup.disabled = true;
      elements.followupLoading.style.display = 'flex';
      clearError();

      const result = await apiFetch(`/api/gaps/${state.currentGapId}/followup`, {
        method: 'POST',
        body: JSON.stringify({
          outcome_text: outcomeText,
          learner_id: state.learner.id,
          idea_id: state.currentIdea.id,
          previous_theme: state.currentCase1.theme
        })
      });

      if (result.no_fresh_cases) {
        showError('no fresh case left for this idea. Please try another concept.');
        await loadIdeas();
        return;
      }

      // Received Case 2: different theme from Case 1
      state.currentCase2 = result.next_case;
      elements.case2ThemePill.textContent = `Theme: ${result.next_case.theme}`;
      elements.case2Prompt.textContent = result.next_case.prompt;
      elements.case2Answer.value = '';

      showScreen(elements.screenCase2);
    } catch (err) {
      // Error handled
    } finally {
      elements.btnSubmitFollowup.disabled = false;
      elements.followupLoading.style.display = 'none';
    }
  });

  // --- 7. CASE 1 PASSED: CHALLENGE CASE OPTION ---
  elements.btnChallengeCase.addEventListener('click', async () => {
    try {
      clearError();
      const res = await apiFetch(`/api/cases/challenge?learner_id=${state.learner.id}&idea_id=${state.currentIdea.id}&previous_theme=${encodeURIComponent(state.currentCase1.theme)}`);

      if (res.no_fresh_cases) {
        showError('no fresh case left for this idea. Please pick another concept.');
        await loadIdeas();
        return;
      }

      state.isChallengeMode = true;
      state.currentCase2 = res.case;
      elements.case2ThemePill.textContent = `Bonus Challenge: ${res.case.theme}`;
      elements.case2Prompt.textContent = res.case.prompt;
      elements.case2Answer.value = '';

      showScreen(elements.screenCase2);
    } catch (err) {
      showError('No additional challenge cases available for this concept.');
    }
  });

  // "Try another idea" from Case 1 passed screen: keeps learner and refreshes picker
  elements.btnPassAnotherIdea.addEventListener('click', async () => {
    await loadIdeas();
  });

  // --- 8. SUBMIT CASE 2 ("AFTER FOLLOW-UP") ---
  elements.btnSubmitCase2.addEventListener('click', async () => {
    const answer = elements.case2Answer.value.trim();
    if (answer.length < 4) {
      showError('Please provide an answer before submitting.');
      return;
    }

    try {
      elements.btnSubmitCase2.disabled = true;
      elements.case2Loading.style.display = 'flex';
      clearError();

      // In retry after follow-up, gap_id IS SET (this retry -> gap link is the core proof)
      const gapIdToSend = state.isChallengeMode ? null : state.currentGapId;

      const result = await apiFetch('/api/attempts', {
        method: 'POST',
        body: JSON.stringify({
          learner_id: state.learner.id,
          case_id: state.currentCase2.id,
          gap_id: gapIdToSend,
          answer_text: answer
        })
      });

      // Render Result Screen
      renderResultScreen(result.passed, result.evaluations);
      showScreen(elements.screenResult);
    } catch (err) {
      // Error handled
    } finally {
      elements.btnSubmitCase2.disabled = false;
      elements.case2Loading.style.display = 'none';
    }
  });

  // --- 9. RENDER RESULT SCREEN ---
  function renderResultScreen(passed, evaluations) {
    elements.resultBanner.className = `result-banner ${passed ? 'pass' : 'fail'}`;

    const c1 = state.case1Result || { passed: false, passedPoints: 0, totalPoints: 0, followupAsked: false };
    const c2PassedCount = (evaluations || []).filter(e => e.present).length;
    const c2TotalCount = (evaluations || []).length;

    const c1Status = c1.passed ? 'passed' : 'not passed';
    const followupStatus = c1.followupAsked ? 'Follow-up asked.' : 'No follow-up.';
    const c2Status = passed ? 'passed' : 'not passed';

    let summary = `Case 1: ${c1Status} (${c1.passedPoints} of ${c1.totalPoints} key points). ${followupStatus} Case 2: ${c2Status} (${c2PassedCount} of ${c2TotalCount} key points).`;

    if (!c1.passed && c1.followupAsked && passed) {
      summary += '\n\nYou did not pass the first case, then passed a different case you had not seen.';
    }

    elements.resultBanner.textContent = summary;
    renderKeyPointsList(elements.resultKeypoints, evaluations);
  }

  function renderKeyPointsList(container, evaluations) {
    container.innerHTML = '';
    evaluations.forEach(ev => {
      const item = document.createElement('div');
      item.className = 'key-point-item';

      const isPresent = Boolean(ev.present);
      const statusLabel = isPresent ? '✓ Present' : '✗ Absent';
      const statusClass = isPresent ? 'present' : 'absent';

      let evidenceHtml = '';
      if (isPresent && ev.evidence) {
        evidenceHtml = `<div class="key-point-evidence">Evidence: "${escapeHtml(ev.evidence)}"</div>`;
      } else if (!isPresent) {
        evidenceHtml = `<div class="key-point-evidence" style="color: #94a3b8;">No mechanical evidence in answer</div>`;
      }

      item.innerHTML = `
        <div class="key-point-header">
          <div class="key-point-text">${escapeHtml(ev.text)}</div>
          <span class="point-status-tag ${statusClass}">${statusLabel}</span>
        </div>
        ${evidenceHtml}
      `;
      container.appendChild(item);
    });
  }

  // --- 10. TRY ANOTHER IDEA ---
  // Keeps the same learner within the session, updates picker counts, and shows picker
  elements.btnResultAnotherIdea.addEventListener('click', async () => {
    await loadIdeas();
  });

  // Utility
  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Health & Status Banner check
  async function checkHealth() {
    try {
      const res = await fetch('/api/health');
      const data = await res.json();

      if (elements.dbStatusPill) {
        if (data.db && data.db.status === 'connected') {
          elements.dbStatusPill.className = 'status-pill status-ok';
          elements.dbStatusPill.textContent = 'DB: Connected';
          elements.dbStatusPill.title = 'Supabase Postgres connection active';
        } else {
          elements.dbStatusPill.className = 'status-pill status-error';
          elements.dbStatusPill.textContent = 'DB: Disconnected';
          elements.dbStatusPill.title = (data.db && data.db.error) || 'Database unavailable';
        }
      }

      if (elements.llmStatusPill) {
        if (data.llm && data.llm.status === 'configured') {
          elements.llmStatusPill.className = 'status-pill status-ok';
          elements.llmStatusPill.textContent = 'LLM: Ready';
          elements.llmStatusPill.title = `Model: ${data.llm.model}`;
        } else {
          elements.llmStatusPill.className = 'status-pill status-error';
          elements.llmStatusPill.textContent = 'LLM: Missing Key';
          elements.llmStatusPill.title = 'Set GROQ_API_KEY in .env';
        }
      }
    } catch (e) {
      if (elements.dbStatusPill) {
        elements.dbStatusPill.className = 'status-pill status-error';
        elements.dbStatusPill.textContent = 'DB: Offline';
      }
      if (elements.llmStatusPill) {
        elements.llmStatusPill.className = 'status-pill status-error';
        elements.llmStatusPill.textContent = 'LLM: Offline';
      }
    }
  }

  // Initial health check
  checkHealth();

  // Auto-resume existing learner if session exists
  const savedLearner = sessionStorage.getItem('cc_learner');
  if (savedLearner) {
    try {
      state.learner = JSON.parse(savedLearner);
      elements.learnerBadge.textContent = `Learner: ${state.learner.code} (${state.learner.tester_type})`;
      elements.learnerBadge.style.display = 'inline-block';
      loadIdeas();
    } catch (e) {
      sessionStorage.removeItem('cc_learner');
    }
  }

})();
