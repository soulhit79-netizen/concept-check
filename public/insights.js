// public/insights.js - Fetch and display aggregate metrics from SQL backend with idea filter

(function () {
  'use strict';

  const elements = {
    btnRefresh: document.getElementById('btn-refresh'),
    filterIdeaSelect: document.getElementById('filter-idea-select'),
    statLearners: document.getElementById('stat-learners'),
    statAttempts: document.getElementById('stat-attempts'),
    statPassRate: document.getElementById('stat-pass-rate'),
    statGapsClosed: document.getElementById('stat-gaps-closed'),
    tableLearners: document.getElementById('table-learners'),
    tableCases: document.getElementById('table-cases'),
    tableKeypoints: document.getElementById('table-keypoints'),
    tableRecitedSentences: document.getElementById('table-recited-sentences'),
    tableRecitedTypes: document.getElementById('table-recited-types'),
    followupList: document.getElementById('followup-list')
  };

  let hasPopulatedIdeasDropdown = false;

  async function loadInsights(ideaId = '') {
    try {
      elements.btnRefresh.disabled = true;
      elements.btnRefresh.textContent = 'Loading...';

      const url = ideaId ? `/api/insights?idea_id=${encodeURIComponent(ideaId)}` : '/api/insights';
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Failed to load insights (status ${res.status})`);
      }
      const data = await res.json();

      // Populate filter dropdown once if ideas are returned
      if (!hasPopulatedIdeasDropdown && data.ideas && data.ideas.length > 0) {
        data.ideas.forEach(item => {
          const opt = document.createElement('option');
          opt.value = item.id;
          opt.textContent = item.title;
          elements.filterIdeaSelect.appendChild(opt);
        });
        hasPopulatedIdeasDropdown = true;
      }

      renderKPIs(data);
      renderLearnerStats(data.learnerStats);
      renderCaseStats(data.caseStats);
      renderMissedKeyPoints(data.missedKeyPoints);
      renderRecitationAnalysis(data.commonRecited, data.recitedByType);
      renderFollowupReviews(data.followupReviews);
    } catch (err) {
      console.error('Insights error:', err);
      alert('Error loading insights data: ' + err.message);
    } finally {
      elements.btnRefresh.disabled = false;
      elements.btnRefresh.textContent = 'Refresh Data';
    }
  }

  function renderKPIs(data) {
    const totalLearners = data.learnerStats ? data.learnerStats.length : 0;
    elements.statLearners.textContent = totalLearners;

    let totalAttempts = 0;
    let totalPassed = 0;
    if (data.learnerStats) {
      data.learnerStats.forEach(l => {
        totalAttempts += Number(l.total_attempts || 0);
        totalPassed += Number(l.passed_attempts || 0);
      });
    }
    elements.statAttempts.textContent = totalAttempts;

    const overallRate = totalAttempts > 0
      ? Math.round((totalPassed / totalAttempts) * 100) + '%'
      : '0%';
    elements.statPassRate.textContent = overallRate;

    const gapsClosed = (data.gapsSummary && data.gapsSummary.gaps_closed) || 0;
    const totalGaps = (data.gapsSummary && data.gapsSummary.total_gaps) || 0;
    elements.statGapsClosed.textContent = `${gapsClosed} / ${totalGaps}`;
  }

  function renderLearnerStats(learnerStats) {
    if (!learnerStats || learnerStats.length === 0) {
      elements.tableLearners.innerHTML = '<tr><td colspan="6" class="empty-state">No learner sessions recorded yet.</td></tr>';
      return;
    }

    elements.tableLearners.innerHTML = learnerStats.map(l => {
      const attempts = Number(l.total_attempts || 0);
      const passed = Number(l.passed_attempts || 0);
      const failed = Number(l.failed_attempts || 0);
      const rate = attempts > 0 ? Math.round((passed / attempts) * 100) + '%' : '-';

      return `
        <tr>
          <td><strong style="font-family: var(--font-mono);">${escapeHtml(l.code)}</strong></td>
          <td>${escapeHtml(l.tester_type || 'classmate')}</td>
          <td>${attempts}</td>
          <td style="color: var(--success); font-weight: 600;">${passed}</td>
          <td style="color: var(--danger); font-weight: 600;">${failed}</td>
          <td><strong>${rate}</strong></td>
        </tr>
      `;
    }).join('');
  }

  function renderCaseStats(caseStats) {
    if (!caseStats || caseStats.length === 0) {
      elements.tableCases.innerHTML = '<tr><td colspan="6" class="empty-state">No cases recorded for this filter.</td></tr>';
      return;
    }

    elements.tableCases.innerHTML = caseStats.map(c => {
      const attempts = Number(c.total_attempts || 0);
      const passed = Number(c.passed_attempts || 0);
      const rate = attempts > 0 ? (c.pass_rate !== null ? c.pass_rate + '%' : '0%') : '-';

      return `
        <tr>
          <td>#${c.id}</td>
          <td><strong>${escapeHtml(c.theme)}</strong></td>
          <td>${escapeHtml(c.idea_title)}</td>
          <td>${attempts}</td>
          <td>${passed}</td>
          <td><strong>${rate}</strong></td>
        </tr>
      `;
    }).join('');
  }

  function renderMissedKeyPoints(missedKeyPoints) {
    if (!missedKeyPoints || missedKeyPoints.length === 0) {
      elements.tableKeypoints.innerHTML = '<tr><td colspan="5" class="empty-state">No key point evaluations for this filter.</td></tr>';
      return;
    }

    elements.tableKeypoints.innerHTML = missedKeyPoints.map(kp => {
      const total = Number(kp.total_checks || 0);
      const missed = Number(kp.missed_count || 0);
      const rate = total > 0 ? (kp.miss_rate !== null ? kp.miss_rate + '%' : '0%') : '-';

      return `
        <tr>
          <td><span class="theme-pill" style="margin: 0;">${escapeHtml(kp.case_theme)}</span></td>
          <td>${escapeHtml(kp.key_point_text)}</td>
          <td>${total}</td>
          <td style="color: var(--danger); font-weight: 600;">${missed}</td>
          <td><strong>${rate}</strong></td>
        </tr>
      `;
    }).join('');
  }

  function renderRecitationAnalysis(commonRecited, recitedByType) {
    // Sentences
    if (!commonRecited || commonRecited.length === 0) {
      elements.tableRecitedSentences.innerHTML = '<tr><td colspan="3" class="empty-state">No recited sentences logged yet.</td></tr>';
    } else {
      elements.tableRecitedSentences.innerHTML = commonRecited.map(item => `
        <tr>
          <td style="font-style: italic;">«${escapeHtml(item.recited_sentence)}»</td>
          <td><span class="step-pill" style="margin: 0; font-size: 0.7rem;">${escapeHtml(item.type)}</span></td>
          <td><strong>${item.count}</strong></td>
        </tr>
      `).join('');
    }

    // Types
    if (!recitedByType || recitedByType.length === 0) {
      elements.tableRecitedTypes.innerHTML = '<tr><td colspan="3" class="empty-state">No data yet.</td></tr>';
    } else {
      const total = recitedByType.reduce((sum, item) => sum + Number(item.count), 0);
      elements.tableRecitedTypes.innerHTML = recitedByType.map(item => {
        const pct = total > 0 ? Math.round((item.count / total) * 100) + '%' : '0%';
        return `
          <tr>
            <td><strong>${escapeHtml(item.type)}</strong></td>
            <td>${item.count}</td>
            <td>${pct}</td>
          </tr>
        `;
      }).join('');
    }
  }

  function renderFollowupReviews(followupReviews) {
    if (!followupReviews || followupReviews.length === 0) {
      elements.followupList.innerHTML = '<div class="empty-state">No learner follow-up outcomes recorded yet.</div>';
      return;
    }

    elements.followupList.innerHTML = followupReviews.map(review => `
      <div class="review-card">
        <div class="review-meta">
          <span>Learner: <strong>${escapeHtml(review.learner_code)}</strong> &bull; Gap #${review.gap_id}</span>
          <span>${review.created_at || ''}</span>
        </div>
        ${review.recited_sentence ? `
          <div class="review-quote">
            Recited: «${escapeHtml(review.recited_sentence)}»
          </div>
        ` : ''}
        <div class="review-question">
          Q: ${escapeHtml(review.followup_question)}
        </div>
        <div class="review-outcome">
          <strong>Learner Response:</strong> ${escapeHtml(review.followup_outcome)}
        </div>
      </div>
    `).join('');
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Filter change listener
  elements.filterIdeaSelect.addEventListener('change', () => {
    loadInsights(elements.filterIdeaSelect.value);
  });

  elements.btnRefresh.addEventListener('click', () => {
    loadInsights(elements.filterIdeaSelect.value);
  });

  // Initial load
  loadInsights();

})();
