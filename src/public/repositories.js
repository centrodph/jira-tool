/**
 * Live pull-request board.
 * The server caches Bitbucket for a few seconds. This script polls that cache,
 * keeps the last good board on screen when a refresh fails, and filters the
 * current payload locally for search and "needs attention".
 */
(function repositoryStatusPage() {
  try {
    startRepositoryPage();
  } catch (error) {
    const list = document.getElementById('pull-request-list');
    if (list) list.textContent = error.message;
  }

  function startRepositoryPage() {
    const pageConfig = readPageConfig();
    const viewState = createInitialViewState(pageConfig);
    const elements = collectElements();

    elements.sidebarCaption.textContent = repositoryCaption(pageConfig);
    const eyebrow = document.getElementById('content-eyebrow');
    if (eyebrow) eyebrow.textContent = watchedUserHeading(pageConfig);
    elements.boardFootnote.textContent = `Build status uses the newest of the 50 most recent Bitbucket Pipelines in each repository. This board refreshes every ${Math.round(pageConfig.refreshIntervalMs / 1000)} seconds.`;

    bindEvents(elements, viewState, pageConfig);
    renderHeading(elements, viewState, pageConfig);
    updateTabs(elements, viewState, null);
    renderSidebar(elements, viewState, {
      summaries: pageConfig.repositories.map((slug) => ({ slug, pending: true })),
    });
    renderUserFilters(elements, viewState, pageConfig);
    refreshBoard(elements, viewState, pageConfig, { showSpinner: true });
    startPolling(elements, viewState, pageConfig);

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        stopPolling(viewState);
        setLive(elements, 'paused', 'Paused');
        return;
      }
      setLive(elements, 'live', 'Live');
      refreshBoard(elements, viewState, pageConfig, { showSpinner: false });
      startPolling(elements, viewState, pageConfig);
    });
  }

  function readPageConfig() {
    const element = document.getElementById('repository-page-config');
    if (!element) throw new Error('Missing repository page configuration.');
    return JSON.parse(element.textContent);
  }

  function createInitialViewState(pageConfig) {
    const parameters = new URLSearchParams(window.location.search);
    const requestedRepository = parameters.get('repository') || '';
    const requestedState = (parameters.get('state') || 'OPEN').toUpperCase();
    return {
      selectedRepository: pageConfig.repositories.includes(requestedRepository) ? requestedRepository : '',
      pullRequestState: pageConfig.states.includes(requestedState) ? requestedState : 'OPEN',
      searchQuery: '',
      attentionOnly: false,
      selectedUserIds: initialSelectedUserIds(pageConfig),
      board: null,
      loading: false,
      timerId: null,
    };
  }

  function collectElements() {
    return {
      sidebarCaption: requireElement('sidebar-caption'),
      repositoryList: requireElement('repository-list'),
      contentTitle: requireElement('content-title'),
      openBitbucket: requireElement('open-bitbucket'),
      bitbucketListLink: requireElement('bitbucket-list-link'),
      teamsCopyButton: requireElement('teams-copy-button'),
      teamsModal: requireElement('teams-modal'),
      teamsMessageText: requireElement('teams-message-text'),
      modalCloseBtn: requireElement('modal-close-btn'),
      modalCloseAction: requireElement('modal-close-action'),
      modalCopyAction: requireElement('modal-copy-action'),
      modalCopyLabel: requireElement('modal-copy-label'),
      modalCopyAlert: requireElement('modal-copy-alert'),
      modalAlertText: requireElement('modal-alert-text'),
      modalFooterStats: requireElement('modal-footer-stats'),
      teamsIncludeDrafts: requireElement('teams-include-drafts'),
      teamsOnlyConflicts: requireElement('teams-only-conflicts'),
      teamsOnlyUnreviewed: requireElement('teams-only-unreviewed'),
      teamsIncludeDetails: requireElement('teams-include-details'),
      statRow: requireElement('stat-row'),
      userFilters: requireElement('user-filters'),
      stateTabs: requireElement('state-tabs'),
      attentionButton: requireElement('attention-button'),
      searchInput: requireElement('search-input'),
      statusBanner: requireElement('status-banner'),
      pullRequestList: requireElement('pull-request-list'),
      boardFootnote: requireElement('board-footnote'),
      refreshButton: requireElement('refresh-button'),
      liveStatus: requireElement('live-status'),
      liveLabel: requireElement('live-label'),
      syncedAt: requireElement('synced-at'),
    };
  }

  function requireElement(id) {
    const element = document.getElementById(id);
    if (!element) throw new Error(`Missing page element #${id}`);
    return element;
  }

  function bindEvents(elements, viewState, pageConfig) {
    elements.repositoryList.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-repository]');
      if (!button) return;
      const nextRepository = button.dataset.repository || '';
      if (nextRepository === viewState.selectedRepository) return;
      viewState.selectedRepository = nextRepository;
      syncUrl(viewState, pageConfig);
      renderHeading(elements, viewState, pageConfig);
      refreshBoard(elements, viewState, pageConfig, { showSpinner: true });
    });

    elements.stateTabs.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-state]');
      if (!button || button.dataset.state === viewState.pullRequestState) return;
      viewState.pullRequestState = button.dataset.state;
      syncUrl(viewState, pageConfig);
      updateTabs(elements, viewState, viewState.board);
      refreshBoard(elements, viewState, pageConfig, { showSpinner: true });
    });

    elements.attentionButton.addEventListener('click', () => {
      viewState.attentionOnly = !viewState.attentionOnly;
      updateTabs(elements, viewState, viewState.board);
      renderBoard(elements, viewState, pageConfig);
    });

    elements.userFilters.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-user]');
      if (!button) return;
      toggleUserFilter(button.dataset.user, viewState, pageConfig);
      syncUrl(viewState, pageConfig);
      renderFilteredBoard(elements, viewState, pageConfig);
    });

    elements.searchInput.addEventListener('input', () => {
      viewState.searchQuery = elements.searchInput.value;
      renderBoard(elements, viewState, pageConfig);
    });

    elements.refreshButton.addEventListener('click', () => {
      refreshBoard(elements, viewState, pageConfig, { manual: true, showSpinner: false });
    });

    elements.teamsCopyButton.addEventListener('click', async () => {
      await handleTeamsExport(elements, viewState, pageConfig);
    });

    elements.teamsIncludeDrafts.addEventListener('change', () => {
      refreshTeamsModal(elements, viewState, pageConfig);
    });

    elements.teamsOnlyConflicts.addEventListener('change', () => {
      refreshTeamsModal(elements, viewState, pageConfig);
    });

    elements.teamsOnlyUnreviewed.addEventListener('change', () => {
      refreshTeamsModal(elements, viewState, pageConfig);
    });

    elements.teamsIncludeDetails.addEventListener('change', () => {
      refreshTeamsModal(elements, viewState, pageConfig);
    });

    elements.modalCopyAction.addEventListener('click', async () => {
      const text = elements.teamsMessageText.value;
      const html = elements.teamsMessageText.dataset.html || '';
      const copied = await copyToClipboard(text, html);
      if (copied) {
        flashModalAlert(elements, '¡Mensaje copiado de nuevo al portapapeles!');
      }
    });

    elements.modalCloseBtn.addEventListener('click', () => {
      elements.teamsModal.hidden = true;
    });

    elements.modalCloseAction.addEventListener('click', () => {
      elements.teamsModal.hidden = true;
    });

    elements.teamsModal.addEventListener('click', (event) => {
      if (event.target === elements.teamsModal) {
        elements.teamsModal.hidden = true;
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !elements.teamsModal.hidden) {
        elements.teamsModal.hidden = true;
      }
    });
  }

  function syncUrl(viewState, pageConfig) {
    const parameters = new URLSearchParams();
    if (viewState.selectedRepository) parameters.set('repository', viewState.selectedRepository);
    if (viewState.pullRequestState !== 'OPEN') parameters.set('state', viewState.pullRequestState);
    const availableIds = (pageConfig.users || []);
    const selectedIds = viewState.selectedUserIds || [];
    const selectionIsPartial = selectedIds.length > 0 && selectedIds.length < availableIds.length;
    if (selectionIsPartial) {
      parameters.set('users', selectedIds.join(','));
    } else if (selectedIds.length === 0 && availableIds.length > 0) {
      parameters.set('users', 'none');
    }
    const query = parameters.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
  }

  function startPolling(elements, viewState, pageConfig) {
    stopPolling(viewState);
    viewState.timerId = window.setInterval(() => {
      refreshBoard(elements, viewState, pageConfig, { showSpinner: false });
    }, pageConfig.refreshIntervalMs);
  }

  function stopPolling(viewState) {
    if (viewState.timerId) {
      window.clearInterval(viewState.timerId);
      viewState.timerId = null;
    }
  }

  async function refreshBoard(elements, viewState, pageConfig, options) {
    if (viewState.loading) return;
    viewState.loading = true;
    elements.refreshButton.disabled = true;
    if (options.showSpinner) {
      elements.pullRequestList.innerHTML = '<div class="loading"><i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Loading pull requests…</div>';
    }
    if (viewState.board) setLive(elements, 'live', 'Syncing');

    try {
      const board = await requestBoard(viewState, pageConfig, options.manual);
      viewState.board = board;
      showBanner(elements, '', [], '');
      renderHeading(elements, viewState, pageConfig);
      renderFilteredBoard(elements, viewState, pageConfig);
      elements.syncedAt.textContent = `Synced ${formatAge(board.syncedAt)}`;
      setLive(elements, document.hidden ? 'paused' : 'live', document.hidden ? 'Paused' : 'Live');
    } catch (error) {
      setLive(elements, 'error', 'Reconnecting');
      elements.syncedAt.textContent = 'Could not sync';
      showBanner(elements, error.message, error.instructions, error.tokenUrl);
      if (!viewState.board) {
        elements.pullRequestList.innerHTML = '';
        elements.statRow.innerHTML = '';
        renderSidebar(elements, viewState, {
          generatedAt: new Date().toISOString(),
          summaries: pageConfig.repositories.map((slug) => ({
            slug,
            error: 'Unavailable',
          })),
        });
      }
    } finally {
      viewState.loading = false;
      elements.refreshButton.disabled = false;
    }
  }

  async function requestBoard(viewState, pageConfig, manual) {
    const parameters = new URLSearchParams({ state: viewState.pullRequestState });
    if (viewState.selectedRepository) parameters.set('repository', viewState.selectedRepository);
    if (manual) parameters.set('refresh', 'true');

    const response = await fetch(`/api/bitbucket/status?${parameters}`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const failure = new Error(payload.error || `Bitbucket status failed (${response.status}).`);
      failure.instructions = payload.instructions || [];
      failure.tokenUrl = payload.tokenUrl || '';
      throw failure;
    }
    return payload;
  }

  function renderHeading(elements, viewState, pageConfig) {
    const repositoryName = viewState.selectedRepository || 'All repositories';
    elements.contentTitle.textContent = repositoryName;
    document.title = `Pull requests · ${repositoryName} · ${pageConfig.workspace}`;

    if (viewState.selectedRepository) {
      elements.openBitbucket.textContent = 'Create pull request';
      elements.openBitbucket.href = bitbucketUrl(pageConfig.workspace, viewState.selectedRepository, 'new');
      elements.bitbucketListLink.hidden = false;
      elements.bitbucketListLink.textContent = 'View on Bitbucket';
      elements.bitbucketListLink.href = bitbucketUrl(pageConfig.workspace, viewState.selectedRepository, 'list');
      return;
    }

    elements.openBitbucket.textContent = 'Open Bitbucket';
    elements.openBitbucket.href = `https://bitbucket.org/${pageConfig.workspace}`;
    elements.bitbucketListLink.hidden = true;
  }

  function bitbucketUrl(workspace, repositorySlug, kind) {
    const base = `https://bitbucket.org/${workspace}/${repositorySlug}/pull-requests/`;
    return kind === 'new' ? `${base}new` : base;
  }

  function renderSidebar(elements, viewState, board) {
    const summaries = board ? board.summaries : [];
    const stillLoading = !board?.generatedAt;
    const allUnavailable = summaries.length > 0 && summaries.every((summary) => summary.error);
    const openTotal = summaries.reduce((total, summary) => {
      return total + openCountForSummary(summary, viewState);
    }, 0);
    let allDetail = `${openTotal} open`;
    if (stillLoading) allDetail = 'Loading…';
    else if (allUnavailable) allDetail = 'Unavailable';
    const buttons = [
      renderRepositoryButton({
        slug: '',
        name: 'All repositories',
        detail: allDetail,
      }, viewState.selectedRepository),
      ...pageRepositoryButtons(viewState, board),
    ];
    elements.repositoryList.innerHTML = buttons.join('');
  }

  function pageRepositoryButtons(viewState, board) {
    const summaries = board ? board.summaries : [];
    return summaries.map((summary) => {
      let detail = 'Loading…';
      if (summary.pending || !board?.generatedAt) detail = 'Loading…';
      else if (summary.error) detail = 'Unavailable';
      else {
        const openCount = openCountForSummary(summary, viewState);
        const failingCount = countForSummary(summary, 'buildFailedCount', viewState);
        detail = `${openCount} open`;
        if (failingCount) detail += ` · ${failingCount} failing`;
      }
      return renderRepositoryButton({
        slug: summary.slug,
        name: summary.slug,
        detail,
      }, viewState.selectedRepository);
    });
  }

  function renderRepositoryButton(repository, selectedRepository) {
    const selectedClass = repository.slug === selectedRepository ? ' is-selected' : '';
    return `
      <button type="button" class="repository-button${selectedClass}" data-repository="${escapeHtml(repository.slug)}">
        <span class="repository-name">${escapeHtml(repository.name)}</span>
        <span class="repository-detail">${escapeHtml(repository.detail)}</span>
      </button>`;
  }

  function updateTabs(elements, viewState, board) {
    const summaries = selectedSummaries(viewState, board);
    elements.stateTabs.querySelectorAll('button[data-state]').forEach((button) => {
      const stateName = button.dataset.state;
      button.classList.toggle('is-selected', stateName === viewState.pullRequestState);
      button.textContent = tabLabel(stateName, summaries, viewState);
    });
    elements.attentionButton.classList.toggle('is-selected', viewState.attentionOnly);
    elements.attentionButton.setAttribute('aria-pressed', String(viewState.attentionOnly));
  }

  function tabLabel(stateName, summaries, viewState) {
    if (summaries.length === 0) {
      if (stateName === 'OPEN') return 'Open';
      if (stateName === 'DRAFT') return 'Drafts';
      if (stateName === 'MERGED') return 'Merged';
      return 'Declined';
    }
    if (stateName === 'OPEN') return `Open ${sumCount(summaries, 'openCount', viewState)}`;
    if (stateName === 'DRAFT') return `Drafts ${sumCount(summaries, 'draftCount', viewState)}`;
    if (stateName === 'MERGED') return 'Merged';
    return 'Declined';
  }

  function renderStats(elements, viewState, board) {
    const summaries = selectedSummaries(viewState, board);
    const cards = [
      { label: 'Open', value: sumCount(summaries, 'openCount', viewState) },
      { label: 'Drafts', value: sumCount(summaries, 'draftCount', viewState) },
      { label: 'Approved', value: sumCount(summaries, 'approvedCount', viewState) },
      { label: 'Changes requested', value: sumCount(summaries, 'changesRequestedCount', viewState), alert: true },
      { label: 'Sin review', value: sumCount(summaries, 'unreviewedCount', viewState), alert: true },
      { label: 'Conflicts', value: sumCount(summaries, 'conflictCount', viewState), alert: true },
      { label: 'Builds failing', value: sumCount(summaries, 'buildFailedCount', viewState), alert: true },
      { label: 'Builds running', value: sumCount(summaries, 'buildInProgressCount', viewState) },
    ];
    elements.statRow.innerHTML = cards.map((card) => `
      <article class="stat${card.alert && card.value > 0 ? ' is-alert' : ''}">
        <span class="stat-label">${escapeHtml(card.label)}</span>
        <span class="stat-value">${card.value}</span>
      </article>`).join('');
  }

  function selectedSummaries(viewState, board) {
    if (!board) return [];
    if (!viewState.selectedRepository) return board.summaries;
    return board.summaries.filter((summary) => summary.slug === viewState.selectedRepository);
  }

  function sumCount(summaries, fieldName, viewState) {
    return summaries.reduce((total, summary) => total + countForSummary(summary, fieldName, viewState), 0);
  }

  function countForSummary(summary, fieldName, viewState) {
    if (!summary || summary.error) return 0;
    if (!viewState || allUsersSelected(viewState) || !summary.countsByUser) {
      return summary[fieldName] || 0;
    }
    return (viewState.selectedUserIds || []).reduce((total, userId) => {
      return total + (summary.countsByUser[userId]?.[fieldName] || 0);
    }, 0);
  }

  function openCountForSummary(summary, viewState) {
    return countForSummary(summary, 'openCount', viewState);
  }

  function renderBoard(elements, viewState, pageConfig) {
    if (!viewState.board) return;
    const repositories = viewState.board.repositories || [];
    if (repositories.length === 0) {
      elements.pullRequestList.innerHTML = `<p class="empty-copy">${escapeHtml(emptyMessage(viewState, pageConfig))}</p>`;
      return;
    }

    elements.pullRequestList.innerHTML = repositories
      .map((repository) => renderRepositoryGroup(repository, viewState, pageConfig, repositories.length > 1))
      .join('');
    elements.syncedAt.textContent = `Synced ${formatAge(viewState.board.syncedAt)}`;
  }

  function renderRepositoryGroup(repository, viewState, pageConfig, grouped) {
    const rows = filterPullRequests(repository.pullRequests || [], viewState);
    let body;
    if (repository.error) {
      body = `<p class="empty-copy">${escapeHtml(repository.error)}</p>`;
    } else if (rows.length === 0) {
      body = `<p class="empty-copy">${escapeHtml(emptyMessage(viewState, pageConfig))}</p>`;
    } else {
      body = rows.map((pullRequest) => renderPullRequest(pullRequest)).join('');
    }

    const notes = [];
    if (repository.truncated) {
      notes.push('<p class="truncated-note">Showing the latest pull requests. This repository has more.</p>');
    }
    if (repository.pipelinesUnavailable) {
      notes.push('<p class="truncated-note">Pipeline status is unavailable for this repository. Pull requests are still listed.</p>');
    }

    if (!grouped) {
      return `<section class="repository-group">${body}${notes.join('')}</section>`;
    }

    const listUrl = repository.htmlUrl || bitbucketUrl(pageConfig.workspace, repository.slug, 'list');
    return `
      <section class="repository-group">
        <header>
          <h3>${escapeHtml(repository.slug)}</h3>
          <a href="${escapeHtml(listUrl)}" target="_blank" rel="noopener">View pull requests</a>
        </header>
        ${body}
        ${notes.join('')}
      </section>`;
  }

  function renderPullRequest(pullRequest) {
    const attentionClass = needsAttention(pullRequest) ? ' needs-attention' : '';
    const draftBadge = pullRequest.draft ? '<span class="lozenge lozenge-draft">Draft</span>' : '';
    const conflictBadge = renderConflictBadge(pullRequest);
    const reviewedBadge = renderReviewedBadge(pullRequest);
    const approvalBadge = renderApprovalBadge(pullRequest.review);
    const reviewersRow = renderReviewersRow(pullRequest.review?.reviewers || []);

    return `
      <article class="pull-request${attentionClass}">
        <div class="pull-request-main">
          <h3>
            <a href="${escapeHtml(pullRequest.htmlUrl)}" target="_blank" rel="noopener">${escapeHtml(pullRequest.title)}</a>
            ${draftBadge}
          </h3>
          <p class="pull-request-meta">
            <span class="pull-request-id">#${escapeHtml(pullRequest.id)}</span>
            <span>updated ${escapeHtml(formatAge(pullRequest.updatedOn))}</span>
            <span>opened ${escapeHtml(formatAge(pullRequest.createdOn))} by <a class="author-activity-link" href="/activity?user=${encodeURIComponent(pullRequest.author.displayName)}&repository=${encodeURIComponent(pullRequest.repositorySlug)}" title="View activity of ${escapeHtml(pullRequest.author.displayName)}">${escapeHtml(pullRequest.author.displayName)}</a></span>
          </p>
          <p class="branches">
            <span class="branch">${escapeHtml(pullRequest.sourceBranch)}</span>
            <span aria-hidden="true">→</span>
            <span class="branch">${escapeHtml(pullRequest.destinationBranch)}</span>
          </p>
          ${reviewersRow}
        </div>
        <div class="pull-request-status">
          ${renderBuild(pullRequest.build)}
          ${conflictBadge}
          ${reviewedBadge}
          ${approvalBadge}
          <span class="count" title="Comments"><i class="fa-regular fa-comment" aria-hidden="true"></i> ${escapeHtml(pullRequest.commentCount)}</span>
          <span class="count" title="Tasks"><i class="fa-regular fa-square-check" aria-hidden="true"></i> ${escapeHtml(pullRequest.taskCount)}</span>
        </div>
      </article>`;
  }

  function renderReviewedBadge(pullRequest) {
    if (pullRequest.state && pullRequest.state !== 'OPEN' && !pullRequest.draft) {
      return '';
    }
    if (pullRequest.hasBeenReviewed) {
      const label = pullRequest.reviewStateLabel || 'Revisado';
      return `<span class="lozenge review-has-review" title="Este PR ya recibió revisión o comentarios: ${escapeHtml(label)}"><i class="fa-solid fa-clipboard-check" aria-hidden="true"></i> <span>${escapeHtml(label)}</span></span>`;
    }
    return `<span class="lozenge review-unreviewed" title="Este PR aún no ha recibido revisión de ningún revisor"><i class="fa-regular fa-hourglass-half" aria-hidden="true"></i> <span>Sin review aún</span></span>`;
  }

  function renderConflictBadge(pullRequest) {
    if (pullRequest.state && pullRequest.state !== 'OPEN' && !pullRequest.draft) {
      return '';
    }

    if (pullRequest.hasConflict) {
      const conflictFiles = pullRequest.conflict?.files || [];
      const title = conflictFiles.length > 0
        ? `Merge conflicts in: ${conflictFiles.slice(0, 3).join(', ')}${conflictFiles.length > 3 ? '...' : ''}`
        : 'This pull request has merge conflicts that must be resolved';
      const fileCountText = pullRequest.conflict?.count > 1 ? ` (${pullRequest.conflict.count})` : '';
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

  function renderBuild(build) {
    if (!build || build.overall === 'NONE') {
      return '<span class="build-pill build-NONE">No pipeline</span>';
    }
    const className = `build-pill build-${escapeHtml(build.overall)}`;
    const label = escapeHtml(build.label || build.overall);
    if (build.url) {
      return `<a class="${className}" href="${escapeHtml(build.url)}" target="_blank" rel="noopener" title="${escapeHtml(build.name || label)}">${label}</a>`;
    }
    return `<span class="${className}">${label}</span>`;
  }

  function filterPullRequests(pullRequests, viewState) {
    const query = viewState.searchQuery.trim().toLowerCase();
    return pullRequests.filter((pullRequest) => {
      if (!pullRequestMatchesSelectedUsers(pullRequest, viewState)) return false;
      if (viewState.attentionOnly && !needsAttention(pullRequest)) return false;
      if (!query) return true;
      const reviewerNames = (pullRequest.review?.reviewers || []).map((r) => r.displayName).join(' ');
      const conflictTerms = pullRequest.hasConflict ? 'conflict conflicted' : 'clean no conflict';
      const approvalTerms = `${pullRequest.review?.overall || ''} ${pullRequest.review?.label || ''}`;
      const haystack = [
        pullRequest.title,
        pullRequest.author?.displayName,
        pullRequest.sourceBranch,
        pullRequest.destinationBranch,
        pullRequest.id,
        pullRequest.repositorySlug,
        reviewerNames,
        conflictTerms,
        approvalTerms,
      ].join(' ').toLowerCase();
      return haystack.includes(query);
    });
  }

  function needsAttention(pullRequest) {
    return pullRequest.build?.overall === 'FAILED'
      || pullRequest.review?.overall === 'changes_requested'
      || Boolean(pullRequest.hasConflict);
  }

  function initialSelectedUserIds(pageConfig) {
    const availableIds = pageConfig.users || [];
    const requestedParam = new URLSearchParams(window.location.search).get('users');
    if (requestedParam === 'none') return [];
    const requestedIds = (requestedParam || '')
      .split(',')
      .map((value) => value.trim())
      .filter((userId) => availableIds.includes(userId));
    if (requestedIds.length === 0) return [...availableIds];
    return requestedIds;
  }

  function availableUsers(board, pageConfig) {
    if (board?.users?.length && typeof board.users[0] === 'object') return board.users;
    return (pageConfig.users || []).map((userId) => ({ id: userId, label: userId }));
  }

  function allUsersSelected(viewState) {
    const availableIds = viewState.availableUserIds || [];
    if (availableIds.length === 0) return true;
    const selectedIds = viewState.selectedUserIds || [];
    return availableIds.every((userId) => selectedIds.includes(userId));
  }

  function toggleUserFilter(userId, viewState, pageConfig) {
    const availableIds = availableUsers(viewState.board, pageConfig).map((user) => user.id);
    if (userId === '*') {
      const selectedSet = new Set(viewState.selectedUserIds || []);
      const allSelected = availableIds.length > 0 && availableIds.every((id) => selectedSet.has(id));
      if (allSelected) {
        viewState.selectedUserIds = [];
      } else {
        viewState.selectedUserIds = [...availableIds];
      }
      return;
    }
    const selectedIds = new Set(viewState.selectedUserIds || []);
    if (selectedIds.has(userId)) selectedIds.delete(userId);
    else selectedIds.add(userId);
    viewState.selectedUserIds = availableIds.filter((availableId) => selectedIds.has(availableId));
  }

  function renderFilteredBoard(elements, viewState, pageConfig) {
    const users = availableUsers(viewState.board, pageConfig);
    viewState.availableUserIds = users.map((user) => user.id);
    renderUserFilters(elements, viewState, pageConfig);
    renderSidebar(elements, viewState, viewState.board);
    updateTabs(elements, viewState, viewState.board);
    renderStats(elements, viewState, viewState.board);
    renderBoard(elements, viewState, pageConfig);
  }

  function renderUserFilters(elements, viewState, pageConfig) {
    const users = availableUsers(viewState.board, pageConfig);
    viewState.availableUserIds = users.map((user) => user.id);
    if (users.length === 0) {
      elements.userFilters.innerHTML = '';
      return;
    }

    const selectedIds = new Set(viewState.selectedUserIds || []);
    const everyoneSelected = users.every((user) => selectedIds.has(user.id));
    const chips = [
      `<button type="button" data-user="*" class="${everyoneSelected ? 'is-selected' : ''}" aria-pressed="${everyoneSelected}">All</button>`,
      ...users.map((user) => {
        const selected = selectedIds.has(user.id);
        const openCount = openCountForUser(viewState.board, user.id);
        const activityUrl = `/activity?user=${encodeURIComponent(user.id)}&repository=${encodeURIComponent(viewState.selectedRepository)}`;
        return `<button type="button" data-user="${escapeHtml(user.id)}" class="${selected ? 'is-selected' : ''}" aria-pressed="${selected}" title="${escapeHtml(user.id)}">${escapeHtml(user.label)}<span class="user-count">${openCount}</span><a class="user-activity-btn" href="${activityUrl}" title="Ver actividad de ${escapeHtml(user.label)}" onclick="event.stopPropagation();"><i class="fa-solid fa-chart-pie" aria-hidden="true"></i></a></button>`;
      }),
    ];
    elements.userFilters.innerHTML = chips.join('');
  }

  function openCountForUser(board, userId) {
    return (board?.summaries || []).reduce((total, summary) => {
      if (summary.error) return total;
      return total + (summary.countsByUser?.[userId]?.openCount || 0);
    }, 0);
  }

  function pullRequestMatchesSelectedUsers(pullRequest, viewState) {
    const availableIds = viewState.availableUserIds || [];
    if (availableIds.length === 0) return true;
    const selectedIds = viewState.selectedUserIds || [];
    if (selectedIds.length === 0) return false;
    if (selectedIds.length === availableIds.length) return true;
    const matchedUsers = pullRequest.matchedUsers || [];
    if (matchedUsers.length === 0) return true;
    return matchedUsers.some((userId) => selectedIds.includes(userId));
  }

  function repositoryCaption(pageConfig) {
    return `${pageConfig.repositories.length} repositories in ${pageConfig.workspace}`;
  }

  function watchedUserHeading(pageConfig) {
    const users = pageConfig.users || [];
    if (users.length === 0) return 'Pull requests';
    return 'Open pull requests';
  }

  function emptyMessage(viewState, pageConfig) {
    const watchedUsers = pageConfig.users || [];
    if (watchedUsers.length > 0 && (viewState.selectedUserIds || []).length === 0) {
      return 'Select a user to see pull requests.';
    }
    const audience = watchedUsers.length > 0 ? ' for the selected users' : '';
    if (viewState.searchQuery.trim()) return 'No pull requests match that search.';
    if (viewState.attentionOnly) return 'Nothing in this view needs attention.';
    if (viewState.pullRequestState === 'OPEN') return `No open pull requests${audience}.`;
    if (viewState.pullRequestState === 'DRAFT') return `No draft pull requests${audience}.`;
    if (viewState.pullRequestState === 'MERGED') return `No merged pull requests${audience} in the latest page.`;
    return `No declined pull requests${audience} in the latest page.`;
  }

  function showBanner(elements, message, instructions, tokenUrl) {
    if (!message) {
      elements.statusBanner.hidden = true;
      elements.statusBanner.innerHTML = '';
      return;
    }

    const items = (instructions || []).map((instruction) => `<li>${escapeHtml(instruction)}</li>`).join('');
    const tokenLink = tokenUrl
      ? `<p><a href="${escapeHtml(tokenUrl)}" target="_blank" rel="noopener">Create an API token</a></p>`
      : '';
    elements.statusBanner.hidden = false;
    elements.statusBanner.innerHTML = `<p>${escapeHtml(message)}</p>${tokenLink}${items ? `<ul>${items}</ul>` : ''}`;
  }

  function setLive(elements, mode, label) {
    elements.liveStatus.className = `live-status is-${mode}`;
    elements.liveLabel.textContent = label;
  }

  function formatAge(isoTimestamp) {
    const timestampMs = Date.parse(isoTimestamp || '');
    if (Number.isNaN(timestampMs)) return 'an unknown time';
    const deltaSeconds = Math.max(0, Math.round((Date.now() - timestampMs) / 1000));
    if (deltaSeconds < 10) return 'just now';
    if (deltaSeconds < 60) return `${deltaSeconds} seconds ago`;
    const minutes = Math.floor(deltaSeconds / 60);
    if (minutes < 60) return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return days === 1 ? '1 day ago' : `${days} days ago`;
    const months = Math.floor(days / 30);
    return months === 1 ? '1 month ago' : `${months} months ago`;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  let cachedOpenPRs = [];

  async function handleTeamsExport(elements, viewState, pageConfig) {
    const originalContent = elements.teamsCopyButton.innerHTML;
    elements.teamsCopyButton.disabled = true;
    elements.teamsCopyButton.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> <span>Generando…</span>';

    try {
      cachedOpenPRs = await fetchOpenPRsForExport(viewState);
      const options = {
        includeDrafts: elements.teamsIncludeDrafts.checked,
        onlyConflicts: elements.teamsOnlyConflicts.checked,
        onlyUnreviewed: elements.teamsOnlyUnreviewed.checked,
        includeDetails: elements.teamsIncludeDetails.checked,
      };

      const result = buildTeamsMessage(cachedOpenPRs, viewState, pageConfig, options);

      const copied = await copyToClipboard(result.markdown, result.html);

      elements.teamsCopyButton.classList.add('is-copied');
      elements.teamsCopyButton.innerHTML = '<i class="fa-solid fa-check" aria-hidden="true"></i> <span>¡Copiado!</span>';
      setTimeout(() => {
        elements.teamsCopyButton.classList.remove('is-copied');
        elements.teamsCopyButton.innerHTML = originalContent;
      }, 2500);

      elements.teamsMessageText.value = result.markdown;
      elements.teamsMessageText.dataset.html = result.html;
      elements.modalFooterStats.textContent = `${result.total} PRs abiertos · ${result.repoCount} repos · ${result.unreviewedCount} sin review · ${result.conflictsCount} con conflictos`;
      elements.modalAlertText.textContent = copied
        ? '¡Mensaje copiado al portapapeles! Listo para pegar en Microsoft Teams.'
        : 'Selecciona y copia el texto a continuación:';
      elements.teamsModal.hidden = false;
      elements.teamsMessageText.focus();
      elements.teamsMessageText.select();
    } catch (error) {
      alert(`Error al generar mensaje para Teams: ${error.message}`);
      elements.teamsCopyButton.innerHTML = originalContent;
    } finally {
      elements.teamsCopyButton.disabled = false;
    }
  }

  function refreshTeamsModal(elements, viewState, pageConfig) {
    const options = {
      includeDrafts: elements.teamsIncludeDrafts.checked,
      onlyConflicts: elements.teamsOnlyConflicts.checked,
      onlyUnreviewed: elements.teamsOnlyUnreviewed.checked,
      includeDetails: elements.teamsIncludeDetails.checked,
    };
    const result = buildTeamsMessage(cachedOpenPRs, viewState, pageConfig, options);
    elements.teamsMessageText.value = result.markdown;
    elements.teamsMessageText.dataset.html = result.html;
    elements.modalFooterStats.textContent = `${result.total} PRs abiertos · ${result.repoCount} repos · ${result.unreviewedCount} sin review · ${result.conflictsCount} con conflictos`;
  }

  function flashModalAlert(elements, text) {
    elements.modalAlertText.textContent = text;
    elements.modalCopyAlert.style.animation = 'none';
    void elements.modalCopyAlert.offsetWidth;
    elements.modalCopyAlert.style.animation = 'pulse 0.6s ease';
  }

  async function fetchOpenPRsForExport(viewState) {
    if (viewState.pullRequestState === 'OPEN' && viewState.board?.repositories) {
      const allPRs = [];
      for (const repo of viewState.board.repositories) {
        if (Array.isArray(repo.pullRequests)) {
          allPRs.push(...repo.pullRequests);
        }
      }
      return allPRs;
    }

    const parameters = new URLSearchParams({ state: 'OPEN' });
    if (viewState.selectedRepository) {
      parameters.set('repository', viewState.selectedRepository);
    }
    const response = await fetch(`/api/bitbucket/status?${parameters}`);
    if (!response.ok) {
      throw new Error(`Bitbucket status failed (${response.status})`);
    }
    const board = await response.json();
    const allPRs = [];
    for (const repo of (board.repositories || [])) {
      if (Array.isArray(repo.pullRequests)) {
        allPRs.push(...repo.pullRequests);
      }
    }
    return allPRs;
  }

  function buildTeamsMessage(pullRequests, viewState, pageConfig, options) {
    const list = pullRequests.filter((pr) => {
      if (!pullRequestMatchesSelectedUsers(pr, viewState)) return false;
      if (!options.includeDrafts && pr.draft) return false;
      if (options.onlyConflicts && !pr.hasConflict) return false;
      if (options.onlyUnreviewed && pr.hasBeenReviewed) return false;
      return true;
    });

    // Ordenados de los más viejos a los más nuevos (createdOn ascendente)
    list.sort((a, b) => Date.parse(a.createdOn || 0) - Date.parse(b.createdOn || 0));

    // Agrupados por repositorio (repos con el PR más viejo primero)
    const groupedMap = new Map();
    for (const pr of list) {
      const repoSlug = pr.repositorySlug || 'sin-repo';
      if (!groupedMap.has(repoSlug)) {
        groupedMap.set(repoSlug, []);
      }
      groupedMap.get(repoSlug).push(pr);
    }
    const groups = Array.from(groupedMap.entries());

    const total = list.length;
    const repoCount = groups.length;
    const conflictsCount = list.filter((pr) => pr.hasConflict).length;
    const approvedCount = list.filter((pr) => pr.review?.overall === 'approved').length;
    const unreviewedCount = list.filter((pr) => !pr.hasBeenReviewed).length;

    const selectedUsers = viewState.selectedUserIds || [];
    const availableUsersCount = (viewState.availableUserIds || []).length;
    const isFilteredByUser = selectedUsers.length > 0 && selectedUsers.length < availableUsersCount;
    const userFilterLabel = isFilteredByUser ? selectedUsers.join(', ') : '';

    function formatTimeOpenLabel(isoDate) {
      const ms = Date.parse(isoDate || '');
      if (Number.isNaN(ms)) return 'fecha desconocida';
      const diffMs = Math.max(0, Date.now() - ms);
      const hours = Math.floor(diffMs / (1000 * 60 * 60));
      const days = Math.floor(hours / 24);
      if (days >= 2) return `hace ${days} días`;
      if (days === 1) return 'hace 1 día';
      if (hours >= 2) return `hace ${hours} horas`;
      if (hours === 1) return 'hace 1 hora';
      const minutes = Math.max(1, Math.floor(diffMs / (1000 * 60)));
      return minutes === 1 ? 'hace 1 minuto' : `hace ${minutes} minutos`;
    }

    function formatCompactDetails(pr) {
      const parts = [];
      if (pr.author?.displayName) parts.push(`👤 ${pr.author.displayName}`);
      if (pr.hasConflict) parts.push('⚠️ Conflicto');
      const overall = pr.review?.overall;
      if (overall === 'approved') parts.push('✅ Aprobado');
      else if (overall === 'partially_approved') parts.push(`🟡 Aprob. ${pr.review.approvedCount}/${pr.review.reviewerCount}`);
      else if (overall === 'changes_requested') parts.push('❌ Cambios solicitados');
      else if (!pr.hasBeenReviewed) parts.push('⏳ Sin review');
      return parts.join(' · ');
    }

    const mdHeader = `📢 **Pull Requests Abiertos (${total})**`
      + (userFilterLabel ? ` · 👤 ${userFilterLabel}` : '')
      + '\n\n';

    const mdSections = groups.map(([repoSlug, prs]) => {
      const prLines = prs.map((pr) => {
        const draftTag = pr.draft ? ' `[DRAFT]`' : '';
        const ageStr = formatTimeOpenLabel(pr.createdOn);
        const detailSuffix = options.includeDetails ? ` (${formatCompactDetails(pr)})` : '';
        return `- **[#${pr.id} - ${pr.title}](${pr.htmlUrl})**${draftTag} — abierto ${ageStr}${detailSuffix}`;
      }).join('\n');
      return `📦 **${repoSlug}** (${prs.length})\n${prLines}`;
    });

    const mdBody = groups.length > 0
      ? mdSections.join('\n\n')
      : '🎉 *¡No hay pull requests abiertos pendientes!*';

    const markdown = mdHeader + mdBody;

    const htmlSections = groups.map(([repoSlug, prs]) => {
      const itemsHtml = prs.map((pr) => {
        const draftBadge = pr.draft
          ? ' <span style="background:#fff7d6;color:#7f5f01;padding:1px 4px;border-radius:3px;font-size:0.75rem;">DRAFT</span>'
          : '';
        const ageStr = formatTimeOpenLabel(pr.createdOn);
        const detailSuffix = options.includeDetails
          ? ` <span style="color:#626f86;">(${escapeHtml(formatCompactDetails(pr))})</span>`
          : '';
        return `<li><strong><a href="${escapeHtml(pr.htmlUrl)}">#${pr.id} - ${escapeHtml(pr.title)}</a></strong>${draftBadge} — <em>abierto ${escapeHtml(ageStr)}</em>${detailSuffix}</li>`;
      }).join('');
      return `<p><strong>📦 ${escapeHtml(repoSlug)} (${prs.length})</strong></p><ul>${itemsHtml}</ul>`;
    }).join('');

    const html = `<p>📢 <strong>Pull Requests Abiertos (${total})</strong>`
      + (userFilterLabel ? ` · 👤 ${escapeHtml(userFilterLabel)}` : '')
      + `</p>`
      + (groups.length > 0 ? htmlSections : '<p>🎉 <em>¡No hay pull requests abiertos pendientes!</em></p>');

    return {
      markdown,
      html,
      total,
      repoCount,
      conflictsCount,
      approvedCount,
      unreviewedCount,
    };
  }

  async function copyToClipboard(text, html) {
    if (navigator.clipboard && window.ClipboardItem && html) {
      try {
        const plainBlob = new Blob([text], { type: 'text/plain' });
        const htmlBlob = new Blob([html], { type: 'text/html' });
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/plain': plainBlob,
            'text/html': htmlBlob,
          }),
        ]);
        return true;
      } catch {
        // Fallback to writeText below
      }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        // Fallback
      }
    }
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const successful = document.execCommand('copy');
      document.body.removeChild(textarea);
      return successful;
    } catch {
      return false;
    }
  }
}());
