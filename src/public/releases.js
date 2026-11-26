/**
 * Release Tracker Dashboard (`release/vX.X.X`).
 * Shows the last 2 minor versions per repository with their creation (cut) date
 * and last update date, and formats rich messages for Microsoft Teams.
 */
(function releaseTrackerPage() {
  try {
    startReleasesPage();
  } catch (error) {
    const container = document.getElementById('releases-container');
    if (container) container.textContent = error.message;
  }

  function startReleasesPage() {
    const pageConfig = readPageConfig();
    const viewState = createInitialViewState(pageConfig);
    const elements = collectElements();

    elements.sidebarCaption.textContent = `${pageConfig.repositories.length} repositories in ${pageConfig.workspace}`;
    elements.releasesFootnote.textContent = `Analiza ramas bajo la convención release/vX.X.X agrupadas por versión minor (vX.Y). Actualización automática cada ${Math.round(pageConfig.refreshIntervalMs / 1000)} segundos.`;

    bindEvents(elements, viewState, pageConfig);
    renderHeading(elements, viewState, pageConfig);
    renderSidebar(elements, viewState, {
      summaries: pageConfig.repositories.map((slug) => ({ slug, pending: true })),
    });
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
    const element = document.getElementById('releases-page-config');
    if (!element) throw new Error('Missing releases page configuration.');
    return JSON.parse(element.textContent);
  }

  function createInitialViewState(pageConfig) {
    const parameters = new URLSearchParams(window.location.search);
    const requestedRepository = parameters.get('repository') || '';
    const requestedView = parameters.get('view') === 'cards' ? 'cards' : 'table';
    const onlyWithReleases = parameters.get('onlyReleases') === '1';

    return {
      selectedRepository: pageConfig.repositories.includes(requestedRepository) ? requestedRepository : '',
      viewMode: requestedView,
      onlyWithReleases,
      searchQuery: '',
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
      teamsOnlyWithReleases: requireElement('teams-only-with-releases'),
      teamsFormatTable: requireElement('teams-format-table'),
      teamsIncludePatches: requireElement('teams-include-patches'),
      teamsIncludeAuthors: requireElement('teams-include-authors'),
      statRow: requireElement('release-stat-row'),
      viewTabs: requireElement('view-tabs'),
      onlyWithReleasesButton: requireElement('only-with-releases-button'),
      searchInput: requireElement('search-input'),
      statusBanner: requireElement('status-banner'),
      copyToast: requireElement('copy-toast'),
      releasesContainer: requireElement('releases-container'),
      releasesFootnote: requireElement('releases-footnote'),
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
      syncUrl(viewState);
      renderHeading(elements, viewState, pageConfig);
      renderAll(elements, viewState, pageConfig);
    });

    elements.viewTabs.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-view]');
      if (!button || button.dataset.view === viewState.viewMode) return;
      viewState.viewMode = button.dataset.view;
      syncUrl(viewState);
      updateToolbarState(elements, viewState);
      renderReleasesView(elements, viewState, pageConfig);
    });

    elements.onlyWithReleasesButton.addEventListener('click', () => {
      viewState.onlyWithReleases = !viewState.onlyWithReleases;
      syncUrl(viewState);
      updateToolbarState(elements, viewState);
      renderReleasesView(elements, viewState, pageConfig);
    });

    elements.searchInput.addEventListener('input', () => {
      viewState.searchQuery = elements.searchInput.value;
      renderReleasesView(elements, viewState, pageConfig);
    });

    elements.refreshButton.addEventListener('click', () => {
      refreshBoard(elements, viewState, pageConfig, { manual: true, showSpinner: false });
    });

    elements.releasesContainer.addEventListener('click', async (event) => {
      const copyRepoBtn = event.target.closest('button[data-copy-repo]');
      if (!copyRepoBtn) return;
      const repoSlug = copyRepoBtn.dataset.copyRepo;
      await handleSingleRepoCopy(repoSlug, copyRepoBtn, elements, viewState);
    });

    elements.teamsCopyButton.addEventListener('click', async () => {
      await handleTeamsExport(elements, viewState, pageConfig);
    });

    const modalCheckboxes = [
      elements.teamsOnlyWithReleases,
      elements.teamsFormatTable,
      elements.teamsIncludePatches,
      elements.teamsIncludeAuthors,
    ];
    for (const checkbox of modalCheckboxes) {
      checkbox.addEventListener('change', () => {
        refreshTeamsModal(elements, viewState, pageConfig);
      });
    }

    elements.modalCopyAction.addEventListener('click', async () => {
      const text = elements.teamsMessageText.value;
      const html = elements.teamsMessageText.dataset.html || '';
      const copied = await copyToClipboard(text, html);
      if (copied) {
        flashModalAlert(elements, '¡Mensaje copiado nuevamente al portapapeles!');
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

  function syncUrl(viewState) {
    const parameters = new URLSearchParams();
    if (viewState.selectedRepository) parameters.set('repository', viewState.selectedRepository);
    if (viewState.viewMode !== 'table') parameters.set('view', viewState.viewMode);
    if (viewState.onlyWithReleases) parameters.set('onlyReleases', '1');
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

  async function refreshBoard(elements, viewState, pageConfig, options = {}) {
    if (viewState.loading) return;
    viewState.loading = true;
    elements.refreshButton.disabled = true;

    if (options.showSpinner && !viewState.board) {
      elements.releasesContainer.innerHTML = '<div class="loading"><i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Analizando ramas release/vX.X.X en Bitbucket…</div>';
    }
    if (viewState.board) setLive(elements, 'live', 'Syncing');

    try {
      const board = await requestReleasesBoard(pageConfig, options.manual);
      viewState.board = board;
      showBanner(elements, '', [], '');
      renderHeading(elements, viewState, pageConfig);
      renderAll(elements, viewState, pageConfig);
      elements.syncedAt.textContent = `Synced ${formatAge(board.syncedAt)}`;
      setLive(elements, document.hidden ? 'paused' : 'live', document.hidden ? 'Paused' : 'Live');
    } catch (error) {
      setLive(elements, 'error', 'Reconnecting');
      elements.syncedAt.textContent = 'Could not sync';
      showBanner(elements, error.message, error.instructions, error.tokenUrl);
      if (!viewState.board) {
        elements.releasesContainer.innerHTML = '';
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

  async function requestReleasesBoard(pageConfig, manual) {
    const parameters = new URLSearchParams({
      minors: String(pageConfig.minorLimit || 2),
    });
    if (manual) parameters.set('refresh', 'true');

    const response = await fetch(`/api/bitbucket/releases?${parameters}`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const failure = new Error(payload.error || `Bitbucket release status failed (${response.status}).`);
      failure.instructions = payload.instructions || [];
      failure.tokenUrl = payload.tokenUrl || '';
      throw failure;
    }
    return payload;
  }

  function renderHeading(elements, viewState, pageConfig) {
    const repositoryName = viewState.selectedRepository || 'All repositories';
    elements.contentTitle.textContent = repositoryName;
    document.title = `Releases · ${repositoryName} · ${pageConfig.workspace}`;

    if (viewState.selectedRepository) {
      elements.openBitbucket.textContent = 'View branches on Bitbucket';
      elements.openBitbucket.href = `https://bitbucket.org/${pageConfig.workspace}/${viewState.selectedRepository}/branches/`;
      return;
    }
    elements.openBitbucket.textContent = 'Open Bitbucket';
    elements.openBitbucket.href = `https://bitbucket.org/${pageConfig.workspace}`;
  }

  function renderAll(elements, viewState, pageConfig) {
    updateToolbarState(elements, viewState);
    renderSidebar(elements, viewState, viewState.board);
    renderStats(elements, viewState);
    renderReleasesView(elements, viewState, pageConfig);
  }

  function updateToolbarState(elements, viewState) {
    elements.viewTabs.querySelectorAll('button[data-view]').forEach((btn) => {
      btn.classList.toggle('is-selected', btn.dataset.view === viewState.viewMode);
    });
    elements.onlyWithReleasesButton.classList.toggle('is-selected', viewState.onlyWithReleases);
    elements.onlyWithReleasesButton.setAttribute('aria-pressed', String(viewState.onlyWithReleases));
  }

  function renderSidebar(elements, viewState, board) {
    const summaries = board?.summaries || [];
    const stillLoading = !board?.generatedAt;
    const reposWithReleases = summaries.filter((s) => !s.error && (s.totalMinors || 0) > 0).length;

    let allDetail = `${reposWithReleases} con releases`;
    if (stillLoading) allDetail = 'Cargando…';

    const buttons = [
      renderRepositoryButton({
        slug: '',
        name: 'All repositories',
        detail: allDetail,
      }, viewState.selectedRepository),
      ...summaries.map((summary) => {
        let detail = 'Cargando…';
        if (summary.pending || stillLoading) {
          detail = 'Cargando…';
        } else if (summary.error) {
          detail = 'No disponible';
        } else if (!summary.latestMinorKey) {
          detail = 'Sin releases';
        } else {
          const prev = summary.previousMinorKey ? ` · ${summary.previousMinorKey}` : '';
          const cutDate = summary.latestCreatedAt ? ` (${formatDateShort(summary.latestCreatedAt)})` : '';
          detail = `${summary.latestMinorKey}${prev}${cutDate}`;
        }
        return renderRepositoryButton({
          slug: summary.slug,
          name: summary.slug,
          detail,
        }, viewState.selectedRepository);
      }),
    ];

    elements.repositoryList.innerHTML = buttons.join('');
  }

  function renderRepositoryButton(repository, selectedRepository) {
    const selectedClass = repository.slug === selectedRepository ? ' is-selected' : '';
    return `
      <button type="button" class="repository-button${selectedClass}" data-repository="${escapeHtml(repository.slug)}">
        <span class="repository-name">${escapeHtml(repository.name)}</span>
        <span class="repository-detail">${escapeHtml(repository.detail)}</span>
      </button>`;
  }

  function getScopedRepositories(viewState) {
    const repositories = viewState.board?.repositories || [];
    if (!viewState.selectedRepository) return repositories;
    return repositories.filter((r) => r.slug === viewState.selectedRepository);
  }

  function filterRepositories(repositories, viewState) {
    const query = viewState.searchQuery.trim().toLowerCase();
    return repositories.filter((repo) => {
      if (viewState.onlyWithReleases && (!repo.minors || repo.minors.length === 0)) {
        return false;
      }
      if (!query) return true;
      const minorTerms = (repo.minors || []).map((m) => [
        m.minorKey,
        m.initialBranchName,
        m.latestBranchName,
        m.createdBy,
        m.updatedBy,
        ...(m.branchNames || []),
        formatDateShort(m.createdAt),
        formatDateShort(m.updatedAt),
      ].join(' ')).join(' ');
      const haystack = `${repo.slug} ${minorTerms}`.toLowerCase();
      return haystack.includes(query);
    });
  }

  function renderStats(elements, viewState) {
    const repositories = getScopedRepositories(viewState);
    if (repositories.length === 0) {
      elements.statRow.innerHTML = '';
      return;
    }

    const activeRepos = repositories.filter((r) => !r.error && (r.minors?.length || 0) > 0);
    const totalReleaseBranches = repositories.reduce((sum, r) => sum + (r.totalReleaseBranches || 0), 0);

    let newestCut = null;
    let newestUpdate = null;

    for (const repo of activeRepos) {
      for (const minor of repo.minors || []) {
        const cutMs = Date.parse(minor.createdAt || '');
        if (!Number.isNaN(cutMs) && (!newestCut || cutMs > newestCut.ms)) {
          newestCut = { ms: cutMs, date: minor.createdAt, repo: repo.slug, minorKey: minor.minorKey, branch: minor.initialBranchName };
        }
        const updMs = Date.parse(minor.updatedAt || '');
        if (!Number.isNaN(updMs) && (!newestUpdate || updMs > newestUpdate.ms)) {
          newestUpdate = { ms: updMs, date: minor.updatedAt, repo: repo.slug, minorKey: minor.minorKey, branch: minor.latestBranchName };
        }
      }
    }

    const cards = [
      {
        label: 'Repos con Releases',
        value: `${activeRepos.length} / ${repositories.length}`,
        sub: `${totalReleaseBranches} ramas release/v* totales`,
      },
      {
        label: 'Último Corte (Creación)',
        value: newestCut ? formatDateShort(newestCut.date) : '—',
        sub: newestCut ? `${newestCut.repo} (${newestCut.branch})` : 'Sin cortes registrados',
      },
      {
        label: 'Última Actualización',
        value: newestUpdate ? formatDateShort(newestUpdate.date) : '—',
        sub: newestUpdate ? `${newestUpdate.repo} (${newestUpdate.branch})` : 'Sin actualizaciones',
      },
      {
        label: 'Convención Activa',
        value: 'release/vX.X.X',
        sub: 'Últimos 2 minor por repositorio',
      },
    ];

    elements.statRow.innerHTML = cards.map((card) => `
      <article class="stat release-stat-card">
        <span class="stat-label">${escapeHtml(card.label)}</span>
        <span class="stat-value">${escapeHtml(card.value)}</span>
        <span class="stat-subtext" title="${escapeHtml(card.sub)}">${escapeHtml(card.sub)}</span>
      </article>`).join('');
  }

  function renderReleasesView(elements, viewState, pageConfig) {
    if (!viewState.board) return;
    const scoped = getScopedRepositories(viewState);
    const filtered = filterRepositories(scoped, viewState);

    if (filtered.length === 0) {
      elements.releasesContainer.innerHTML = `<p class="empty-copy">No se encontraron repositorios con ramas release que coincidan con el filtro actual.</p>`;
      return;
    }

    if (viewState.viewMode === 'cards') {
      elements.releasesContainer.innerHTML = `<div class="releases-cards-grid">${filtered.map((repo) => renderRepositoryCard(repo, pageConfig)).join('')}</div>`;
    } else {
      elements.releasesContainer.innerHTML = renderReleasesTable(filtered, pageConfig);
    }
  }

  function renderReleasesTable(repositories) {
    const rowsHtml = repositories.map((repo) => {
      const latestMinor = repo.minors?.[0] || null;
      const previousMinor = repo.minors?.[1] || null;

      if (repo.error) {
        return `
          <tr class="repo-row is-error">
            <td class="repo-col">
              <div class="repo-cell-main">
                <a class="repo-link" href="${escapeHtml(repo.htmlUrl)}" target="_blank" rel="noopener">${escapeHtml(repo.slug)}</a>
                <span class="repo-branch-count is-error-badge"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> No disponible</span>
              </div>
            </td>
            <td colspan="6" class="empty-minor-cell error-text">${escapeHtml(repo.error)}</td>
            <td class="action-col">—</td>
          </tr>`;
      }

      if (!latestMinor) {
        return `
          <tr class="repo-row is-empty">
            <td class="repo-col">
              <div class="repo-cell-main">
                <a class="repo-link" href="${escapeHtml(repo.htmlUrl)}" target="_blank" rel="noopener">${escapeHtml(repo.slug)}</a>
                <span class="repo-branch-count">0 ramas release</span>
              </div>
            </td>
            <td colspan="6" class="empty-minor-cell">Sin ramas bajo la convención <code>release/vX.X.X</code></td>
            <td class="action-col">—</td>
          </tr>`;
      }

      return `
        <tr class="repo-row">
          <td class="repo-col">
            <div class="repo-cell-main">
              <a class="repo-link" href="${escapeHtml(repo.htmlUrl)}" target="_blank" rel="noopener">${escapeHtml(repo.slug)}</a>
              <span class="repo-branch-count">${repo.totalMinors} minor${repo.totalMinors === 1 ? '' : 's'} · ${repo.totalReleaseBranches} rama${repo.totalReleaseBranches === 1 ? '' : 's'}</span>
            </div>
          </td>
          ${renderMinorTableCells(latestMinor, 'is-latest')}
          ${renderMinorTableCells(previousMinor, 'is-previous')}
          <td class="action-col">
            <button type="button" class="button button-quiet btn-copy-repo" data-copy-repo="${escapeHtml(repo.slug)}" title="Copiar los últimos 2 minor de ${escapeHtml(repo.slug)} para Teams">
              <i class="fa-regular fa-copy" aria-hidden="true"></i>
              <span>Copiar</span>
            </button>
          </td>
        </tr>`;
    }).join('');

    return `
      <div class="releases-table-wrapper">
        <table class="releases-table">
          <thead>
            <tr class="thead-group-row">
              <th rowspan="2" class="repo-col">Repositorio</th>
              <th colspan="3" class="minor-group-header is-latest-group">
                <i class="fa-solid fa-rocket" aria-hidden="true"></i> Último Minor (Actual)
              </th>
              <th colspan="3" class="minor-group-header is-previous-group">
                <i class="fa-solid fa-clock-rotate-left" aria-hidden="true"></i> Penúltimo Minor (Anterior)
              </th>
              <th rowspan="2" class="action-col">Teams</th>
            </tr>
            <tr class="thead-sub-row">
              <th class="minor-col">Versión / Branch</th>
              <th class="date-col">Día Creación (Corte)</th>
              <th class="date-col">Última Actualización</th>
              <th class="minor-col minor-divider">Versión / Branch</th>
              <th class="date-col">Día Creación (Corte)</th>
              <th class="date-col">Última Actualización</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>
      </div>`;
  }

  function renderMinorTableCells(minor, kindClass) {
    const dividerClass = kindClass === 'is-previous' ? ' minor-divider' : '';
    if (!minor) {
      return `
        <td class="minor-col${dividerClass} empty-minor-cell">—</td>
        <td class="date-col empty-minor-cell">—</td>
        <td class="date-col empty-minor-cell">—</td>`;
    }

    const hasPatches = minor.patchCount > 1;
    const branchLabel = hasPatches
      ? `${minor.initialBranchName} ➔ ${minor.latestBranchName.replace(/^release\//, '')}`
      : minor.latestBranchName;

    const patchesListHtml = hasPatches
      ? `<div class="minor-patches-pills">${(minor.branches || []).map((b) => `
          <a class="patch-pill" href="${escapeHtml(b.htmlUrl)}" target="_blank" rel="noopener" title="${escapeHtml(b.name)} · Creado: ${formatDateShort(b.createdAt)} · Actualizado: ${formatDateShort(b.updatedAt)}">
            ${escapeHtml(b.versionLabel)}
          </a>`).join('')}</div>`
      : '';

    return `
      <td class="minor-col${dividerClass}">
        <div class="minor-version-cell">
          <span class="minor-badge ${kindClass}">${escapeHtml(minor.minorKey)}</span>
          <a class="branch-chip" href="${escapeHtml(minor.htmlUrl)}" target="_blank" rel="noopener" title="Ver rama ${escapeHtml(minor.latestBranchName)} en Bitbucket">
            <i class="fa-solid fa-code-branch" aria-hidden="true"></i>
            <span>${escapeHtml(branchLabel)}</span>
          </a>
        </div>
        ${patchesListHtml}
      </td>
      <td class="date-col">
        <div class="date-cell">
          <span class="date-primary" title="${escapeHtml(formatDateTimeFull(minor.createdAt))}">
            <i class="fa-regular fa-calendar-plus date-icon-create" aria-hidden="true"></i>
            ${escapeHtml(formatDateShort(minor.createdAt))}
          </span>
          <span class="date-meta">${escapeHtml(formatAgeSpanish(minor.createdAt))}</span>
        </div>
      </td>
      <td class="date-col">
        <div class="date-cell">
          <span class="date-primary" title="${escapeHtml(formatDateTimeFull(minor.updatedAt))} por ${escapeHtml(minor.updatedBy)}">
            <i class="fa-solid fa-clock-rotate-left date-icon-update" aria-hidden="true"></i>
            ${escapeHtml(formatDateShort(minor.updatedAt))}
          </span>
          <span class="date-meta" title="Último commit por ${escapeHtml(minor.updatedBy)}">
            ${escapeHtml(formatAgeSpanish(minor.updatedAt))} · ${escapeHtml(shortAuthor(minor.updatedBy))}
          </span>
        </div>
      </td>`;
  }

  function renderRepositoryCard(repo) {
    const minors = repo.minors || [];
    const copyButtonHtml = minors.length > 0
      ? `<button type="button" class="button button-quiet btn-copy-repo" data-copy-repo="${escapeHtml(repo.slug)}" title="Copiar ${escapeHtml(repo.slug)} para Teams">
           <i class="fa-regular fa-copy" aria-hidden="true"></i>
           <span>Copiar para Teams</span>
         </button>`
      : '';

    let bodyHtml = '';
    if (repo.error) {
      bodyHtml = `<p class="empty-copy error-text"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> ${escapeHtml(repo.error)}</p>`;
    } else if (minors.length === 0) {
      bodyHtml = `<p class="empty-copy">Este repositorio no tiene ramas bajo la convención <code>release/vX.X.X</code>.</p>`;
    } else {
      bodyHtml = `
        <div class="repo-minors-grid">
          ${renderMinorDetailCard(minors[0], 'Último Minor (Actual)', 'is-latest')}
          ${renderMinorDetailCard(minors[1], 'Penúltimo Minor (Anterior)', 'is-previous')}
        </div>`;
    }

    return `
      <section class="repository-group release-repo-card">
        <header class="release-repo-card-header">
          <div class="release-repo-title-group">
            <h3>
              <a href="${escapeHtml(repo.htmlUrl)}" target="_blank" rel="noopener">${escapeHtml(repo.slug)}</a>
            </h3>
            <span class="repo-branch-count">${repo.totalMinors || 0} minors · ${repo.totalReleaseBranches || 0} ramas release</span>
          </div>
          <div class="release-repo-actions">
            ${copyButtonHtml}
            <a class="text-link" href="${escapeHtml(repo.htmlUrl)}" target="_blank" rel="noopener">Ver ramas en Bitbucket</a>
          </div>
        </header>
        ${bodyHtml}
      </section>`;
  }

  function renderMinorDetailCard(minor, slotTitle, kindClass) {
    if (!minor) {
      return `
        <article class="minor-detail-card is-empty-slot">
          <div class="minor-card-top">
            <span class="minor-slot-label">${escapeHtml(slotTitle)}</span>
          </div>
          <p class="empty-minor-slot-text">Sin segundo minor registrado.</p>
        </article>`;
    }

    const patchesBreakdown = (minor.branches || []).length > 1
      ? `<div class="minor-branches-breakdown">
           <span class="breakdown-title">Ramas en este minor (${minor.branches.length}):</span>
           <ul class="breakdown-list">
             ${minor.branches.map((b) => `
               <li>
                 <a href="${escapeHtml(b.htmlUrl)}" target="_blank" rel="noopener"><code>${escapeHtml(b.name)}</code></a>
                 <span>Creado: <strong>${escapeHtml(formatDateShort(b.createdAt))}</strong> · Actualizado: <strong>${escapeHtml(formatDateShort(b.updatedAt))}</strong> (${escapeHtml(shortAuthor(b.updatedBy))})</span>
               </li>`).join('')}
           </ul>
         </div>`
      : '';

    return `
      <article class="minor-detail-card ${kindClass}">
        <div class="minor-card-top">
          <div>
            <span class="minor-slot-label">${escapeHtml(slotTitle)}</span>
            <div class="minor-heading-row">
              <span class="minor-badge ${kindClass}">${escapeHtml(minor.minorKey)}</span>
              <a class="branch-chip" href="${escapeHtml(minor.htmlUrl)}" target="_blank" rel="noopener">
                <i class="fa-solid fa-code-branch" aria-hidden="true"></i>
                <span>${escapeHtml(minor.latestBranchName)}</span>
              </a>
            </div>
          </div>
          <span class="minor-duration-pill" title="Días entre el corte inicial y la última actualización">
            ${minor.durationDays === 0 ? 'Mismo día' : `${minor.durationDays} día${minor.durationDays === 1 ? '' : 's'} de ciclo`}
          </span>
        </div>

        <div class="minor-dates-grid">
          <div class="minor-date-box">
            <span class="date-box-label"><i class="fa-regular fa-calendar-plus date-icon-create" aria-hidden="true"></i> Día de Creación (Corte)</span>
            <strong class="date-box-value">${escapeHtml(formatDateShort(minor.createdAt))}</strong>
            <span class="date-box-sub">${escapeHtml(formatDateTimeFull(minor.createdAt))} · ${escapeHtml(formatAgeSpanish(minor.createdAt))}</span>
          </div>
          <div class="minor-date-box">
            <span class="date-box-label"><i class="fa-solid fa-clock-rotate-left date-icon-update" aria-hidden="true"></i> Última Actualización</span>
            <strong class="date-box-value">${escapeHtml(formatDateShort(minor.updatedAt))}</strong>
            <span class="date-box-sub">Por ${escapeHtml(minor.updatedBy)} · ${escapeHtml(formatAgeSpanish(minor.updatedAt))}</span>
          </div>
        </div>

        ${minor.latestCommitMessage ? `
          <div class="minor-commit-line" title="${escapeHtml(minor.latestCommitMessage)}">
            <code>${escapeHtml(minor.latestCommitHash)}</code>
            <span>${escapeHtml(minor.latestCommitMessage)}</span>
          </div>` : ''}

        ${patchesBreakdown}
      </article>`;
  }

  async function handleSingleRepoCopy(repoSlug, buttonEl, elements, viewState) {
    const repo = (viewState.board?.repositories || []).find((r) => r.slug === repoSlug);
    if (!repo) return;

    const result = buildTeamsMessage([repo], {
      onlyWithReleases: false,
      formatTable: false,
      includePatches: true,
      includeAuthors: true,
      singleRepo: true,
    });

    const copied = await copyToClipboard(result.markdown, result.html);
    const originalHtml = buttonEl.innerHTML;
    buttonEl.classList.add('is-copied');
    buttonEl.innerHTML = `<i class="fa-solid fa-check" aria-hidden="true"></i> <span>${copied ? '¡Copiado!' : 'Error'}</span>`;
    showCopyToast(elements, copied ? `¡Releases de ${repoSlug} copiados para Teams!` : 'No se pudo copiar al portapapeles.');
    setTimeout(() => {
      buttonEl.classList.remove('is-copied');
      buttonEl.innerHTML = originalHtml;
    }, 2000);
  }

  function showCopyToast(elements, message) {
    if (!elements.copyToast) return;
    elements.copyToast.textContent = message;
    elements.copyToast.hidden = false;
    window.clearTimeout(elements.copyToast._timer);
    elements.copyToast._timer = window.setTimeout(() => {
      elements.copyToast.hidden = true;
    }, 2600);
  }

  async function handleTeamsExport(elements, viewState, pageConfig) {
    if (!viewState.board) return;
    const originalContent = elements.teamsCopyButton.innerHTML;

    try {
      const options = readModalOptions(elements);
      const repositories = filterRepositories(getScopedRepositories(viewState), {
        ...viewState,
        onlyWithReleases: options.onlyWithReleases,
      });

      const result = buildTeamsMessage(repositories, options);
      const copied = await copyToClipboard(result.markdown, result.html);

      elements.teamsCopyButton.classList.add('is-copied');
      elements.teamsCopyButton.innerHTML = '<i class="fa-solid fa-check" aria-hidden="true"></i> <span>¡Copiado!</span>';
      setTimeout(() => {
        elements.teamsCopyButton.classList.remove('is-copied');
        elements.teamsCopyButton.innerHTML = originalContent;
      }, 2500);

      elements.teamsMessageText.value = result.markdown;
      elements.teamsMessageText.dataset.html = result.html;
      elements.modalFooterStats.textContent = `${result.repoCount} repositorios · ${result.minorCount} versiones minor listadas`;
      elements.modalAlertText.textContent = copied
        ? '¡Mensaje copiado al portapapeles! Listo para pegar en Microsoft Teams.'
        : 'Selecciona y copia el texto a continuación:';
      elements.teamsModal.hidden = false;
      elements.teamsMessageText.focus();
      elements.teamsMessageText.select();
    } catch (error) {
      alert(`Error al generar mensaje para Teams: ${error.message}`);
      elements.teamsCopyButton.innerHTML = originalContent;
    }
  }

  function refreshTeamsModal(elements, viewState) {
    if (!viewState.board) return;
    const options = readModalOptions(elements);
    const repositories = filterRepositories(getScopedRepositories(viewState), {
      ...viewState,
      onlyWithReleases: options.onlyWithReleases,
    });
    const result = buildTeamsMessage(repositories, options);
    elements.teamsMessageText.value = result.markdown;
    elements.teamsMessageText.dataset.html = result.html;
    elements.modalFooterStats.textContent = `${result.repoCount} repositorios · ${result.minorCount} versiones minor listadas`;
  }

  function readModalOptions(elements) {
    return {
      onlyWithReleases: elements.teamsOnlyWithReleases.checked,
      formatTable: elements.teamsFormatTable.checked,
      includePatches: elements.teamsIncludePatches.checked,
      includeAuthors: elements.teamsIncludeAuthors.checked,
    };
  }

  function buildTeamsMessage(repositories, options) {
    const now = new Date();
    const timestampStr = `${now.toLocaleDateString('es-ES', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    })} ${now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}`;

    const list = repositories.filter((repo) => {
      if (options.onlyWithReleases) {
        return !repo.error && Array.isArray(repo.minors) && repo.minors.length > 0;
      }
      return true;
    });

    const repoCount = list.length;
    const minorCount = list.reduce((sum, r) => sum + (r.minors?.length || 0), 0);

    if (options.formatTable) {
      return buildTeamsTableMessage(list, options, timestampStr, repoCount, minorCount);
    }

    const mdRepoBlocks = list.map((repo) => {
      const minors = repo.minors || [];
      if (repo.error) {
        return `📦 **${repo.slug}**\n   • ⚠️ *No disponible (${repo.error})*`;
      }
      if (minors.length === 0) {
        return `📦 **${repo.slug}**\n   • ⚪ *Sin ramas release/vX.X.X*`;
      }

      const minorLines = minors.map((m, idx) => {
        const icon = idx === 0 ? '🟢' : '🔹';
        const slotTag = idx === 0 ? 'Último Minor' : 'Minor Anterior';
        const branchLabel = m.patchCount > 1
          ? `\`${m.initialBranchName}\` ➔ \`${m.latestBranchName}\``
          : `\`${m.latestBranchName}\``;
        const createdDate = formatDateShort(m.createdAt);
        const updatedDate = formatDateShort(m.updatedAt);
        const authorSuffix = options.includeAuthors && m.updatedBy ? ` *(por ${m.updatedBy})*` : '';

        let line = `   • ${icon} **${slotTag} ${m.minorKey}** (${branchLabel}) — 📅 **Creación:** ${createdDate} | 🔄 **Últ. actualización:** ${updatedDate}${authorSuffix}`;

        if (options.includePatches && m.patchCount > 1 && Array.isArray(m.branches)) {
          const patchLines = m.branches.map((b) => {
            return `     └ \`${b.name}\`: creado ${formatDateShort(b.createdAt)} · actualizado ${formatDateShort(b.updatedAt)}`;
          }).join('\n');
          line += `\n${patchLines}`;
        }
        return line;
      }).join('\n');

      return `📦 **[${repo.slug}](${repo.htmlUrl})**\n${minorLines}`;
    });

    const mdHeader = options.singleRepo && list.length === 1
      ? `🚀 **Tracking de Releases · ${list[0].slug} (Últimos 2 Minor)**\n`
      : `🚀 **Tracking de Releases por Repositorio (Últimos 2 Minor)**\n`
        + `*Convención: \`release/vX.X.X\` · Día de creación del corte y última actualización*\n\n`;

    const mdBody = mdRepoBlocks.length > 0
      ? mdRepoBlocks.join('\n\n')
      : '⚪ *No hay repositorios con releases para mostrar.*';

    const mdFooter = options.singleRepo
      ? ''
      : `\n\n---\n📊 **Resumen:** ${repoCount} repositorios | 🏷️ ${minorCount} versiones minor\n*Generado el ${timestampStr}*`;

    const markdown = mdHeader + mdBody + mdFooter;

    const htmlItems = list.map((repo) => {
      const minors = repo.minors || [];
      if (repo.error) {
        return `<p>📦 <strong>${escapeHtml(repo.slug)}</strong><br>&nbsp;&nbsp;• ⚠️ <em>No disponible (${escapeHtml(repo.error)})</em></p>`;
      }
      if (minors.length === 0) {
        return `<p>📦 <strong>${escapeHtml(repo.slug)}</strong><br>&nbsp;&nbsp;• ⚪ <em>Sin ramas release/vX.X.X</em></p>`;
      }

      const minorLis = minors.map((m, idx) => {
        const icon = idx === 0 ? '🟢' : '🔹';
        const slotTag = idx === 0 ? 'Último Minor' : 'Minor Anterior';
        const branchHtml = m.patchCount > 1
          ? `<code>${escapeHtml(m.initialBranchName)}</code> ➔ <a href="${escapeHtml(m.htmlUrl)}"><code>${escapeHtml(m.latestBranchName)}</code></a>`
          : `<a href="${escapeHtml(m.htmlUrl)}"><code>${escapeHtml(m.latestBranchName)}</code></a>`;
        const createdDate = formatDateShort(m.createdAt);
        const updatedDate = formatDateShort(m.updatedAt);
        const authorSuffix = options.includeAuthors && m.updatedBy ? ` <em>(por ${escapeHtml(m.updatedBy)})</em>` : '';

        let patchSublist = '';
        if (options.includePatches && m.patchCount > 1 && Array.isArray(m.branches)) {
          const patchItems = m.branches.map((b) =>
            `<li><a href="${escapeHtml(b.htmlUrl)}"><code>${escapeHtml(b.name)}</code></a>: creado <strong>${escapeHtml(formatDateShort(b.createdAt))}</strong> · actualizado <strong>${escapeHtml(formatDateShort(b.updatedAt))}</strong></li>`
          ).join('');
          patchSublist = `<ul>${patchItems}</ul>`;
        }

        return `<li>${icon} <strong>${slotTag} ${escapeHtml(m.minorKey)}</strong> (${branchHtml}) — 📅 <strong>Creación:</strong> ${escapeHtml(createdDate)} | 🔄 <strong>Últ. actualización:</strong> ${escapeHtml(updatedDate)}${authorSuffix}${patchSublist}</li>`;
      }).join('');

      return `<p>📦 <strong><a href="${escapeHtml(repo.htmlUrl)}">${escapeHtml(repo.slug)}</a></strong></p><ul>${minorLis}</ul>`;
    }).join('');

    const html = `<p>🚀 <strong>Tracking de Releases por Repositorio (Últimos 2 Minor)</strong><br>`
      + `<em>Convención: <code>release/vX.X.X</code> · Día de creación del corte y última actualización</em></p>`
      + (htmlItems || '<p>⚪ <em>No hay repositorios con releases para mostrar.</em></p>')
      + (options.singleRepo ? '' : `<hr><p>📊 <strong>Resumen:</strong> ${repoCount} repositorios | 🏷️ ${minorCount} versiones minor<br><small><em>Generado el ${escapeHtml(timestampStr)}</em></small></p>`);

    return {
      markdown,
      html,
      repoCount,
      minorCount,
    };
  }

  function buildTeamsTableMessage(list, options, timestampStr, repoCount, minorCount) {
    const mdLines = [
      `🚀 **Tracking de Releases por Repositorio (Últimos 2 Minor)**`,
      `*Convención: \`release/vX.X.X\` · Día de creación del corte y última actualización*`,
      '',
      '| Repositorio | Último Minor | Creación (Corte) | Últ. Actualización | Minor Anterior | Creación (Corte) | Últ. Actualización |',
      '|---|---|---|---|---|---|---|',
    ];

    for (const repo of list) {
      const m1 = repo.minors?.[0];
      const m2 = repo.minors?.[1];
      const m1Label = m1 ? `**${m1.minorKey}** (\`${m1.latestBranchName}\`)` : '—';
      const m1Created = m1 ? formatDateShort(m1.createdAt) : '—';
      const m1Updated = m1 ? formatDateShort(m1.updatedAt) : '—';
      const m2Label = m2 ? `**${m2.minorKey}** (\`${m2.latestBranchName}\`)` : '—';
      const m2Created = m2 ? formatDateShort(m2.createdAt) : '—';
      const m2Updated = m2 ? formatDateShort(m2.updatedAt) : '—';

      mdLines.push(`| **${repo.slug}** | ${m1Label} | ${m1Created} | ${m1Updated} | ${m2Label} | ${m2Created} | ${m2Updated} |`);
    }

    mdLines.push('', `📊 **Resumen:** ${repoCount} repositorios | 🏷️ ${minorCount} versiones minor · *Generado el ${timestampStr}*`);
    const markdown = mdLines.join('\n');

    const htmlRows = list.map((repo) => {
      const m1 = repo.minors?.[0];
      const m2 = repo.minors?.[1];
      return `<tr>`
        + `<td><strong><a href="${escapeHtml(repo.htmlUrl)}">${escapeHtml(repo.slug)}</a></strong></td>`
        + `<td>${m1 ? `<strong>${escapeHtml(m1.minorKey)}</strong> (<code>${escapeHtml(m1.latestBranchName)}</code>)` : '—'}</td>`
        + `<td>${m1 ? escapeHtml(formatDateShort(m1.createdAt)) : '—'}</td>`
        + `<td>${m1 ? escapeHtml(formatDateShort(m1.updatedAt)) : '—'}</td>`
        + `<td>${m2 ? `<strong>${escapeHtml(m2.minorKey)}</strong> (<code>${escapeHtml(m2.latestBranchName)}</code>)` : '—'}</td>`
        + `<td>${m2 ? escapeHtml(formatDateShort(m2.createdAt)) : '—'}</td>`
        + `<td>${m2 ? escapeHtml(formatDateShort(m2.updatedAt)) : '—'}</td>`
        + `</tr>`;
    }).join('');

    const html = `<p>🚀 <strong>Tracking de Releases por Repositorio (Últimos 2 Minor)</strong><br>`
      + `<em>Convención: <code>release/vX.X.X</code> · Día de creación del corte y última actualización</em></p>`
      + `<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;">`
      + `<thead><tr>`
      + `<th>Repositorio</th><th>Último Minor</th><th>Creación (Corte)</th><th>Últ. Actualización</th>`
      + `<th>Minor Anterior</th><th>Creación (Corte)</th><th>Últ. Actualización</th>`
      + `</tr></thead>`
      + `<tbody>${htmlRows}</tbody>`
      + `</table>`
      + `<p><small>📊 <strong>Resumen:</strong> ${repoCount} repositorios | 🏷️ ${minorCount} versiones minor · <em>Generado el ${escapeHtml(timestampStr)}</em></small></p>`;

    return {
      markdown,
      html,
      repoCount,
      minorCount,
    };
  }

  function flashModalAlert(elements, text) {
    elements.modalAlertText.textContent = text;
    elements.modalCopyAlert.style.animation = 'none';
    void elements.modalCopyAlert.offsetWidth;
    elements.modalCopyAlert.style.animation = 'pulse 0.6s ease';
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

  function formatDateShort(isoDate) {
    const ms = Date.parse(isoDate || '');
    if (Number.isNaN(ms)) return '—';
    return new Date(ms).toLocaleDateString('es-ES', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
  }

  function formatDateTimeFull(isoDate) {
    const ms = Date.parse(isoDate || '');
    if (Number.isNaN(ms)) return 'Fecha desconocida';
    const d = new Date(ms);
    return `${d.toLocaleDateString('es-ES', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    })} ${d.toLocaleTimeString('es-ES', {
      hour: '2-digit',
      minute: '2-digit',
    })}`;
  }

  function formatAgeSpanish(isoTimestamp) {
    const timestampMs = Date.parse(isoTimestamp || '');
    if (Number.isNaN(timestampMs)) return '';
    const days = Math.floor(Math.max(0, Date.now() - timestampMs) / (1000 * 60 * 60 * 24));
    if (days === 0) return 'hoy';
    if (days === 1) return 'ayer';
    if (days < 30) return `hace ${days} días`;
    const months = Math.floor(days / 30);
    return months === 1 ? 'hace 1 mes' : `hace ${months} meses`;
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
    return days === 1 ? '1 day ago' : `${days} days ago`;
  }

  function shortAuthor(author) {
    const clean = String(author || '').trim();
    if (!clean || clean === 'Unknown') return 'Desconocido';
    const parts = clean.split(/\s+/);
    if (parts.length <= 2) return clean;
    return `${parts[0]} ${parts[1]}`;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
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
      textarea.setAttribute('readonly', '');
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
