/**
 * User Activity Dashboard - Client Script
 */
(function userActivityApp() {
  const PALETTE = [
    '#e8edff', // soft lavender / periwinkle
    '#fffde6', // soft cream / light yellow
    '#d8ff64', // bright lime
    '#c4d5ff', // soft blue
    '#ffef60', // canary yellow
    '#bdf4e5', // mint teal
    '#ffdcd2', // soft peach / coral
    '#e0d4fc', // soft lilac
    '#d2f0ff', // light sky blue
    '#fce4a6', // warm amber
  ];

  try {
    startActivityPage();
  } catch (err) {
    const banner = document.getElementById('status-banner');
    if (banner) {
      banner.hidden = false;
      banner.textContent = err.message;
    }
  }

  function startActivityPage() {
    const pageConfig = readPageConfig();
    const viewState = createInitialViewState(pageConfig);
    const elements = collectElements();

    bindEvents(elements, viewState, pageConfig);
    renderSidebarRepositories(elements, viewState, pageConfig);
    renderSidebarUsers(elements, viewState, pageConfig, []);
    fetchActivity(elements, viewState, pageConfig);
  }

  function readPageConfig() {
    const element = document.getElementById('activity-page-config');
    if (!element) throw new Error('Missing activity page configuration.');
    return JSON.parse(element.textContent);
  }

  function createInitialViewState(pageConfig) {
    const params = new URLSearchParams(window.location.search);
    const requestedRepo = params.get('repository') || '';
    const requestedDays = parseInt(params.get('days'), 10) || 30;
    const requestedTab = params.get('tab') === 'commits' ? 'commits' : 'prs';
    const requestedUser = params.get('user') || (pageConfig.users && pageConfig.users[0]) || '';

    return {
      selectedUser: requestedUser,
      selectedRepository: pageConfig.repositories.includes(requestedRepo) ? requestedRepo : '',
      days: requestedDays,
      activeTab: requestedTab,
      statusFilter: 'ALL',
      searchQuery: '',
      data: null,
      loading: false,
    };
  }

  function collectElements() {
    return {
      activityUserHeading: requireEl('activity-user-heading'),
      activityEyebrow: requireEl('activity-eyebrow'),
      repositoryList: requireEl('repository-list'),
      userChipsContainer: requireEl('user-chips-container'),
      userSearchInput: requireEl('user-search-input'),
      daysSelector: document.querySelector('.days-selector'),
      refreshButton: requireEl('refresh-button'),
      liveStatus: requireEl('live-status'),
      liveLabel: requireEl('live-label'),
      syncedAt: requireEl('synced-at'),
      statusBanner: requireEl('status-banner'),
      openBitbucketUser: requireEl('open-bitbucket-user'),

      // Stats
      statTotalPRs: requireEl('stat-total-prs'),
      statMergedPRs: requireEl('stat-merged-prs'),
      statOpenPRs: requireEl('stat-open-prs'),
      statCommits: requireEl('stat-commits'),
      statLinesAdded: requireEl('stat-lines-added'),
      statLinesRemoved: requireEl('stat-lines-removed'),

      // Analytics
      chartTitle: requireEl('chart-title'),
      pieChartWrapper: requireEl('pie-chart-wrapper'),
      summaryTableBody: requireEl('summary-table-body'),
      summaryTableFoot: requireEl('summary-table-foot'),

      // Sub-tabs
      tabBtnPrs: requireEl('tab-btn-prs'),
      tabBtnCommits: requireEl('tab-btn-commits'),
      countBadgePrs: requireEl('count-badge-prs'),
      countBadgeCommits: requireEl('count-badge-commits'),
      tabContentPrs: requireEl('tab-content-prs'),
      tabContentCommits: requireEl('tab-content-commits'),
      prStatusFilters: requireEl('pr-status-filters'),
      listSearchInput: requireEl('list-search-input'),
      prsListContainer: requireEl('prs-list-container'),
      commitsListContainer: requireEl('commits-list-container'),
    };
  }

  function requireEl(id) {
    const el = document.getElementById(id);
    if (!el) throw new Error(`Missing page element #${id}`);
    return el;
  }

  function bindEvents(elements, viewState, pageConfig) {
    // Repository buttons
    elements.repositoryList.addEventListener('click', (event) => {
      const btn = event.target.closest('button[data-repository]');
      if (!btn) return;
      const nextRepo = btn.dataset.repository || '';
      if (nextRepo === viewState.selectedRepository) return;
      viewState.selectedRepository = nextRepo;
      syncUrl(viewState);
      renderSidebarRepositories(elements, viewState, pageConfig);
      fetchActivity(elements, viewState, pageConfig);
    });

    // Days selector
    if (elements.daysSelector) {
      elements.daysSelector.addEventListener('click', (event) => {
        const btn = event.target.closest('button[data-days]');
        if (!btn) return;
        const nextDays = parseInt(btn.dataset.days, 10);
        if (!nextDays || nextDays === viewState.days) return;
        viewState.days = nextDays;
        elements.daysSelector.querySelectorAll('button').forEach((b) => {
          b.classList.toggle('is-selected', b === btn);
        });
        syncUrl(viewState);
        fetchActivity(elements, viewState, pageConfig);
      });
    }

    // Refresh
    elements.refreshButton.addEventListener('click', () => {
      fetchActivity(elements, viewState, pageConfig, true);
    });

    // Sub-tabs
    elements.tabBtnPrs.addEventListener('click', () => {
      switchTab('prs', elements, viewState);
    });
    elements.tabBtnCommits.addEventListener('click', () => {
      switchTab('commits', elements, viewState);
    });

    // PR status filters
    elements.prStatusFilters.addEventListener('click', (event) => {
      const btn = event.target.closest('button[data-status]');
      if (!btn) return;
      viewState.statusFilter = btn.dataset.status;
      elements.prStatusFilters.querySelectorAll('button').forEach((b) => {
        b.classList.toggle('is-selected', b === btn);
      });
      renderPRsList(elements, viewState);
    });

    // Search input
    elements.listSearchInput.addEventListener('input', () => {
      viewState.searchQuery = elements.listSearchInput.value.trim().toLowerCase();
      if (viewState.activeTab === 'prs') {
        renderPRsList(elements, viewState);
      } else {
        renderCommitsList(elements, viewState);
      }
    });

    // User search in sidebar
    elements.userSearchInput.addEventListener('input', () => {
      const filter = elements.userSearchInput.value.trim().toLowerCase();
      const available = getAvailableUsers(viewState, pageConfig);
      const filtered = available.filter((u) => {
        return (u.id || '').toLowerCase().includes(filter) || (u.label || '').toLowerCase().includes(filter);
      });
      renderSidebarUsers(elements, viewState, pageConfig, filtered);
    });

    // User selection in sidebar
    elements.userChipsContainer.addEventListener('click', (event) => {
      const btn = event.target.closest('button[data-user]');
      if (!btn) return;
      const nextUser = btn.dataset.user;
      if (nextUser === viewState.selectedUser) return;
      viewState.selectedUser = nextUser;
      syncUrl(viewState);
      renderSidebarUsers(elements, viewState, pageConfig);
      fetchActivity(elements, viewState, pageConfig);
    });
  }

  function switchTab(tab, elements, viewState) {
    viewState.activeTab = tab;
    elements.tabBtnPrs.classList.toggle('is-selected', tab === 'prs');
    elements.tabBtnCommits.classList.toggle('is-selected', tab === 'commits');
    elements.tabContentPrs.hidden = tab !== 'prs';
    elements.tabContentCommits.hidden = tab !== 'commits';
    elements.prStatusFilters.hidden = tab !== 'prs';
    syncUrl(viewState);
  }

  function syncUrl(viewState) {
    const params = new URLSearchParams();
    if (viewState.selectedUser) params.set('user', viewState.selectedUser);
    if (viewState.selectedRepository) params.set('repository', viewState.selectedRepository);
    if (viewState.days !== 30) params.set('days', String(viewState.days));
    if (viewState.activeTab !== 'prs') params.set('tab', viewState.activeTab);
    const query = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
  }

  function renderSidebarRepositories(elements, viewState, pageConfig) {
    const buttons = elements.repositoryList.querySelectorAll('button[data-repository]');
    buttons.forEach((btn) => {
      const repo = btn.dataset.repository;
      const isSelected = repo === viewState.selectedRepository;
      btn.classList.toggle('is-selected', isSelected);
      const detail = btn.querySelector('.repository-detail');
      if (detail) {
        detail.textContent = isSelected ? 'Selected' : (repo === '' ? 'All repos' : 'Filter repo');
      }
    });
  }

  function getAvailableUsers(viewState, pageConfig) {
    const usersMap = new Map();
    (pageConfig.users || []).forEach((u) => usersMap.set(u, { id: u, label: u }));
    if (viewState.data?.availableUsers) {
      viewState.data.availableUsers.forEach((u) => usersMap.set(u.id, u));
    }
    if (viewState.selectedUser && !usersMap.has(viewState.selectedUser)) {
      usersMap.set(viewState.selectedUser, { id: viewState.selectedUser, label: viewState.selectedUser });
    }
    return Array.from(usersMap.values());
  }

  function renderSidebarUsers(elements, viewState, pageConfig, userListOverride) {
    const users = userListOverride || getAvailableUsers(viewState, pageConfig);
    if (users.length === 0) {
      elements.userChipsContainer.innerHTML = '<p class="empty-cell" style="padding:10px 0;font-size:0.8rem;">No users configured</p>';
      return;
    }

    elements.userChipsContainer.innerHTML = users.map((user) => {
      const isSelected = user.id === viewState.selectedUser;
      const initials = (user.label || user.id)
        .split(/[\s.@_-]+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((p) => p[0].toUpperCase())
        .join('') || '?';

      return `
        <button type="button" class="user-chip-button${isSelected ? ' is-selected' : ''}" data-user="${escapeHtml(user.id)}">
          <span style="display:flex;align-items:center;min-width:0;">
            <span class="user-avatar-mini">${escapeHtml(initials)}</span>
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(user.label || user.id)}</span>
          </span>
          ${isSelected ? '<i class="fa-solid fa-check" style="font-size:0.75rem;margin-left:8px;"></i>' : ''}
        </button>`;
    }).join('');
  }

  async function fetchActivity(elements, viewState, pageConfig, manual = false) {
    if (viewState.loading) return;
    viewState.loading = true;
    elements.refreshButton.disabled = true;
    elements.liveLabel.textContent = 'Syncing…';

    const params = new URLSearchParams({
      days: String(viewState.days),
    });
    if (viewState.selectedUser) params.set('user', viewState.selectedUser);
    if (viewState.selectedRepository) params.set('repository', viewState.selectedRepository);
    if (manual) params.set('refresh', '1');

    try {
      const res = await fetch(`/api/bitbucket/user-activity?${params.toString()}`);
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload.error || `Request failed with status ${res.status}`);
      }

      viewState.data = payload;
      elements.statusBanner.hidden = true;
      renderDashboard(elements, viewState, pageConfig);
      elements.syncedAt.textContent = `Synced ${new Date().toLocaleTimeString()}`;
      elements.liveLabel.textContent = 'Live';
    } catch (err) {
      elements.statusBanner.hidden = false;
      elements.statusBanner.textContent = err.message;
      elements.syncedAt.textContent = 'Could not sync';
      elements.liveLabel.textContent = 'Error';
    } finally {
      viewState.loading = false;
      elements.refreshButton.disabled = false;
    }
  }

  function renderDashboard(elements, viewState, pageConfig) {
    const data = viewState.data;
    if (!data) return;

    const userLabel = data.user?.label || viewState.selectedUser || 'User';
    elements.activityUserHeading.textContent = `${userLabel}`;
    const repoScope = viewState.selectedRepository ? `in ${viewState.selectedRepository}` : `across all repositories`;
    elements.activityEyebrow.textContent = `Activity (${viewState.days} days) ${repoScope}`;
    document.title = `${userLabel} · Activity · ${pageConfig.workspace}`;

    elements.chartTitle.textContent = `${userLabel} PRs by repository`;

    // Stats
    const s = data.summary || {};
    elements.statTotalPRs.textContent = formatNumber(s.totalPRs || 0);
    elements.statMergedPRs.textContent = formatNumber(s.mergedPRs || 0);
    elements.statOpenPRs.textContent = formatNumber(s.openPRs || 0);
    elements.statCommits.textContent = formatNumber(s.totalCommits || 0);
    elements.statLinesAdded.textContent = `+${formatNumber(s.linesAdded || 0)}`;
    elements.statLinesRemoved.textContent = `-${formatNumber(s.linesRemoved || 0)}`;

    // Badges in tabs
    elements.countBadgePrs.textContent = String(data.pullRequests?.length || 0);
    elements.countBadgeCommits.textContent = String(data.commits?.length || 0);

    // Update bitbucket profile button
    elements.openBitbucketUser.href = `https://bitbucket.org/${pageConfig.workspace}`;

    // Render Pie Chart
    renderPieChart(elements, data.byRepository || [], data.summary?.totalPRs || 0);

    // Render Summary Table
    renderSummaryTable(elements, data.byRepository || [], s);

    // Render Lists
    renderPRsList(elements, viewState);
    renderCommitsList(elements, viewState);
  }

  function renderPieChart(elements, byRepository, totalPRs) {
    const wrapper = elements.pieChartWrapper;
    if (!byRepository || byRepository.length === 0 || totalPRs === 0) {
      wrapper.innerHTML = `
        <div style="text-align:center;padding:30px 10px;color:var(--bb-muted);">
          <i class="fa-solid fa-chart-pie" style="font-size:3rem;margin-bottom:12px;opacity:0.3;"></i>
          <p style="margin:0;font-size:0.95rem;">No pull requests recorded in this period.</p>
        </div>`;
      return;
    }

    // Filter repos with PRs > 0
    const prRepos = byRepository.filter((r) => r.prs > 0);
    if (prRepos.length === 0) {
      wrapper.innerHTML = `<p class="empty-cell">No pull requests in this period.</p>`;
      return;
    }

    const size = 260;
    const center = size / 2;
    const radius = size / 2 - 12;

    let pathsSvg = '';
    let currentAngle = -Math.PI / 2; // start at top 12 o'clock

    prRepos.forEach((item, index) => {
      const color = PALETTE[index % PALETTE.length];
      const sliceAngle = (item.prs / totalPRs) * 2 * Math.PI;
      const endAngle = currentAngle + sliceAngle;

      const x1 = center + radius * Math.cos(currentAngle);
      const y1 = center + radius * Math.sin(currentAngle);
      const x2 = center + radius * Math.cos(endAngle);
      const y2 = center + radius * Math.sin(endAngle);

      const largeArc = sliceAngle > Math.PI ? 1 : 0;

      let d = '';
      if (prRepos.length === 1 || sliceAngle >= 2 * Math.PI - 0.001) {
        d = `M ${center} ${center - radius} A ${radius} ${radius} 0 1 1 ${center - 0.01} ${center - radius} Z`;
      } else {
        d = `M ${center} ${center} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${radius} ${radius} 0 ${largeArc} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`;
      }

      // Percentage label inside slice
      let labelSvg = '';
      if (item.percentage >= 5) {
        const midAngle = currentAngle + sliceAngle / 2;
        const textRadius = radius * 0.65;
        const tx = center + textRadius * Math.cos(midAngle);
        const ty = center + textRadius * Math.sin(midAngle);
        labelSvg = `<text x="${tx.toFixed(2)}" y="${(ty + 4).toFixed(2)}" font-size="12" font-family="sans-serif" font-weight="600" fill="#172b4d" text-anchor="middle">${item.percentage}%</text>`;
      }

      pathsSvg += `
        <g class="pie-slice" data-repo="${escapeHtml(item.repository)}">
          <path d="${d}" fill="${color}" stroke="#172b4d" stroke-width="2" stroke-linejoin="round" />
          ${labelSvg}
        </g>`;

      currentAngle = endAngle;
    });

    const legendHtml = prRepos.map((item, index) => {
      const color = PALETTE[index % PALETTE.length];
      return `
        <div class="pie-legend-item">
          <span class="pie-legend-swatch" style="background:${color};"></span>
          <span class="pie-legend-label">${escapeHtml(item.repository)} [${item.prs}]</span>
        </div>`;
    }).join('');

    wrapper.innerHTML = `
      <svg class="pie-chart-svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
        <circle cx="${center}" cy="${center}" r="${radius}" fill="#f4f5f7" stroke="#172b4d" stroke-width="2" />
        ${pathsSvg}
      </svg>
      <div class="pie-legend">${legendHtml}</div>`;
  }

  function renderSummaryTable(elements, byRepository, summary) {
    if (!byRepository || byRepository.length === 0) {
      elements.summaryTableBody.innerHTML = `<tr><td colspan="5" class="empty-cell">No repository activity recorded.</td></tr>`;
      elements.summaryTableFoot.innerHTML = '';
      return;
    }

    elements.summaryTableBody.innerHTML = byRepository.map((item) => `
      <tr>
        <td><strong>${escapeHtml(item.repository)}</strong></td>
        <td class="num-col">${formatNumber(item.prs)}</td>
        <td class="num-col stat-added">${formatNumber(item.linesAdded)}</td>
        <td class="num-col stat-removed">${formatNumber(item.linesRemoved)}</td>
        <td class="num-col">${formatNumber(item.commits)}</td>
      </tr>`).join('');

    elements.summaryTableFoot.innerHTML = `
      <tr>
        <td>Total</td>
        <td class="num-col">${formatNumber(summary.totalPRs || 0)}</td>
        <td class="num-col stat-added">${formatNumber(summary.linesAdded || 0)}</td>
        <td class="num-col stat-removed">${formatNumber(summary.linesRemoved || 0)}</td>
        <td class="num-col">${formatNumber(summary.totalCommits || 0)}</td>
      </tr>`;
  }

  function renderPRsList(elements, viewState) {
    const list = viewState.data?.pullRequests || [];
    const q = viewState.searchQuery;
    const filter = viewState.statusFilter;

    const filtered = list.filter((pr) => {
      if (filter !== 'ALL' && pr.state !== filter) return false;
      if (!q) return true;
      const reviewerNames = (pr.review?.reviewers || []).map((r) => r.displayName).join(' ');
      const conflictTerms = pr.hasConflict ? 'conflict conflicted' : 'clean no conflict';
      const approvalTerms = `${pr.review?.overall || ''} ${pr.review?.label || ''}`;
      const haystack = [
        pr.title,
        pr.repositorySlug,
        pr.sourceBranch,
        pr.destinationBranch,
        String(pr.id),
        reviewerNames,
        conflictTerms,
        approvalTerms,
      ].join(' ').toLowerCase();
      return haystack.includes(q);
    });

    if (filtered.length === 0) {
      elements.prsListContainer.innerHTML = `<p class="empty-cell">No pull requests matching current filters.</p>`;
      return;
    }

    elements.prsListContainer.innerHTML = filtered.map((pr) => {
      const stateClass = pr.state === 'MERGED' ? 'lozenge-merged' : (pr.state === 'DECLINED' ? 'lozenge-declined' : 'lozenge-open');
      const draftBadge = pr.draft ? '<span class="lozenge lozenge-draft" style="margin-left:6px;">Draft</span>' : '';
      const conflictBadge = renderConflictBadge(pr);
      const reviewedBadge = renderReviewedBadge(pr);
      const approvalBadge = pr.review ? renderApprovalBadge(pr.review) : '';
      const reviewersRow = renderReviewersRow(pr.review?.reviewers || []);

      return `
        <article class="pull-request">
          <div class="pull-request-main">
            <h3>
              <a href="${escapeHtml(pr.htmlUrl)}" target="_blank" rel="noopener">${escapeHtml(pr.title)}</a>
              ${draftBadge}
            </h3>
            <p class="pull-request-meta">
              <span class="repo-badge">${escapeHtml(pr.repositorySlug)}</span>
              <span class="pull-request-id">#${escapeHtml(pr.id)}</span>
              <span>created ${escapeHtml(formatAge(pr.createdOn))}</span>
              <span>updated ${escapeHtml(formatAge(pr.updatedOn))}</span>
            </p>
            <p class="branches">
              <span class="branch">${escapeHtml(pr.sourceBranch)}</span>
              <span aria-hidden="true">→</span>
              <span class="branch">${escapeHtml(pr.destinationBranch)}</span>
            </p>
            ${reviewersRow}
          </div>
          <div class="pull-request-status">
            <span class="lozenge ${stateClass}">${escapeHtml(pr.state)}</span>
            ${conflictBadge}
            ${reviewedBadge}
            ${approvalBadge}
            <span class="diffstat-badge">
              <span class="diffstat-add">+${formatNumber(pr.linesAdded)}</span>
              <span class="diffstat-del">-${formatNumber(pr.linesRemoved)}</span>
            </span>
            <span class="count" title="Comments"><i class="fa-regular fa-comment" aria-hidden="true"></i> ${escapeHtml(pr.commentCount)}</span>
          </div>
        </article>`;
    }).join('');
  }

  function renderReviewedBadge(pr) {
    if (pr.state && pr.state !== 'OPEN' && !pr.draft) {
      return '';
    }
    if (pr.hasBeenReviewed) {
      const label = pr.reviewStateLabel || 'Revisado';
      return `<span class="lozenge review-has-review" title="Este PR ya recibió revisión o feedback: ${escapeHtml(label)}"><i class="fa-solid fa-clipboard-check" aria-hidden="true"></i> <span>${escapeHtml(label)}</span></span>`;
    }
    return `<span class="lozenge review-unreviewed" title="Este PR aún no ha recibido revisión de ningún revisor"><i class="fa-regular fa-hourglass-half" aria-hidden="true"></i> <span>Sin review aún</span></span>`;
  }

  function renderConflictBadge(pr) {
    if (pr.state && pr.state !== 'OPEN' && !pr.draft) {
      return '';
    }

    if (pr.hasConflict) {
      const conflictFiles = pr.conflict?.files || [];
      const title = conflictFiles.length > 0
        ? `Merge conflicts in: ${conflictFiles.slice(0, 3).join(', ')}${conflictFiles.length > 3 ? '...' : ''}`
        : 'This pull request has merge conflicts that must be resolved';
      const fileCountText = pr.conflict?.count > 1 ? ` (${pr.conflict.count})` : '';
      return `<span class="lozenge lozenge-conflict" title="${escapeHtml(title)}"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> <span>Conflict${escapeHtml(fileCountText)}</span></span>`;
    }

    return `<span class="lozenge lozenge-clean" title="No merge conflicts detected between source and destination branches"><i class="fa-solid fa-code-merge" aria-hidden="true"></i> <span>No conflicts</span></span>`;
  }

  function renderApprovalBadge(review) {
    if (!review) return '';
    const overall = review.overall || 'no_reviewers';
    const approvedCount = review.approvedCount || 0;
    const reviewerCount = review.reviewerCount || 0;
    const changesCount = review.changesRequestedCount || 0;

    let icon = '';
    let label = '';
    let title = '';

    if (overall === 'approved') {
      icon = '<i class="fa-solid fa-circle-check" aria-hidden="true"></i>';
      label = reviewerCount > 1 ? `Approved (${approvedCount}/${reviewerCount})` : 'Approved';
      title = `Approved by ${approvedCount} of ${reviewerCount} reviewer${reviewerCount === 1 ? '' : 's'}`;
    } else if (overall === 'partially_approved') {
      icon = '<i class="fa-solid fa-circle-half-stroke" aria-hidden="true"></i>';
      label = `Partially approved (${approvedCount}/${reviewerCount})`;
      title = `${approvedCount} of ${reviewerCount} reviewers approved. Awaiting remaining reviews.`;
    } else if (overall === 'changes_requested') {
      icon = '<i class="fa-solid fa-circle-xmark" aria-hidden="true"></i>';
      label = changesCount > 1 ? `Changes requested (${changesCount})` : 'Changes requested';
      title = `${changesCount} reviewer${changesCount === 1 ? ' has' : 's have'} requested changes`;
    } else if (overall === 'pending') {
      icon = '<i class="fa-regular fa-clock" aria-hidden="true"></i>';
      label = reviewerCount > 0 ? `Needs approval (0/${reviewerCount})` : 'Review pending';
      title = `Awaiting review from ${reviewerCount} assigned reviewer${reviewerCount === 1 ? '' : 's'}`;
    } else {
      icon = '<i class="fa-solid fa-user-xmark" aria-hidden="true"></i>';
      label = 'No reviewers';
      title = 'No reviewers assigned to this pull request';
    }

    return `<span class="lozenge review-${escapeHtml(overall)}" title="${escapeHtml(title)}">${icon} <span>${escapeHtml(label)}</span></span>`;
  }

  function renderReviewersRow(reviewers) {
    if (!reviewers || reviewers.length === 0) {
      return `
        <div class="pull-request-reviewers-row is-empty">
          <span class="reviewers-label"><i class="fa-solid fa-users" aria-hidden="true"></i> Reviewers:</span>
          <span class="no-reviewers-text">None assigned</span>
        </div>`;
    }

    const chips = reviewers.map((reviewer) => {
      const state = reviewer.state || 'pending';
      let stateIcon = '';
      let stateText = 'Pending';
      let statusClass = 'is-pending';

      if (state === 'approved') {
        stateIcon = '<i class="fa-solid fa-check" aria-hidden="true"></i>';
        stateText = 'Aprobó';
        statusClass = 'is-approved';
      } else if (state === 'changes_requested') {
        stateIcon = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';
        stateText = 'Cambios solicitados';
        statusClass = 'is-changes-requested';
      } else if (reviewer.hasParticipated) {
        stateIcon = '<i class="fa-regular fa-comment-dots" aria-hidden="true"></i>';
        stateText = 'Con comentarios';
        statusClass = 'is-participated';
      } else {
        stateIcon = '<i class="fa-regular fa-clock" aria-hidden="true"></i>';
        stateText = 'Sin revisar';
        statusClass = 'is-pending';
      }

      const initials = (reviewer.displayName || 'Reviewer')
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0].toUpperCase())
        .join('') || '?';

      return `
        <span class="reviewer-chip ${statusClass}" title="${escapeHtml(reviewer.displayName)}: ${stateText}">
          <span class="chip-avatar">${escapeHtml(initials)}</span>
          <span class="chip-name">${escapeHtml(reviewer.displayName)}</span>
          <span class="chip-status">${stateIcon} ${escapeHtml(stateText)}</span>
        </span>`;
    }).join('');

    return `
      <div class="pull-request-reviewers-row">
        <span class="reviewers-label"><i class="fa-solid fa-users" aria-hidden="true"></i> Reviewers:</span>
        <div class="reviewer-chips-list">
          ${chips}
        </div>
      </div>`;
  }

  function renderCommitsList(elements, viewState) {
    const list = viewState.data?.commits || [];
    const q = viewState.searchQuery;

    const filtered = list.filter((c) => {
      if (!q) return true;
      const haystack = [c.message, c.shortHash, c.repositorySlug, c.authorName].join(' ').toLowerCase();
      return haystack.includes(q);
    });

    if (filtered.length === 0) {
      elements.commitsListContainer.innerHTML = `<p class="empty-cell">No commits matching current filters.</p>`;
      return;
    }

    elements.commitsListContainer.innerHTML = filtered.map((c) => `
      <div class="commit-card">
        <div class="commit-main">
          <p class="commit-title">
            <a href="${escapeHtml(c.htmlUrl)}" target="_blank" rel="noopener">${escapeHtml(c.message)}</a>
          </p>
          <div class="commit-meta">
            <span class="repo-badge">${escapeHtml(c.repositorySlug)}</span>
            <span>by ${escapeHtml(c.authorName)}</span>
            <span>${escapeHtml(formatAge(c.date))}</span>
          </div>
        </div>
        <div>
          <a class="commit-hash-pill" href="${escapeHtml(c.htmlUrl)}" target="_blank" rel="noopener">#${escapeHtml(c.shortHash)}</a>
        </div>
      </div>`).join('');
  }

  function formatNumber(num) {
    return Number(num || 0).toLocaleString();
  }

  function formatAge(iso) {
    const timeMs = Date.parse(iso || '');
    if (Number.isNaN(timeMs)) return 'recently';
    const delta = Math.max(0, Math.round((Date.now() - timeMs) / 1000));
    if (delta < 60) return `${delta}s ago`;
    const min = Math.floor(delta / 60);
    if (min < 60) return `${min}m ago`;
    const hrs = Math.floor(min / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    return `${months}mo ago`;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}());
