import { PULL_REQUEST_VIEWS, STATUS_REFRESH_INTERVAL_MS } from '../bitbucketConstants.js';

/**
 * Escapes text that is inserted into the repository page HTML.
 * @param {string} value
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Serializes the boot config so a `<` inside a value cannot close the script tag.
 * @param {object} value
 * @returns {string}
 */
function serializePageConfig(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/**
 * Renders the live pull-request board. Pull request rows themselves are filled
 * by the browser from /api/bitbucket/status.
 * @param {{ workspace: string, repositories: string[], refreshIntervalMs?: number, states?: string[] }} page
 * @returns {string}
 */
export function renderRepositoriesPage(page) {
  const workspace = escapeHtml(page.workspace);
  const refreshIntervalMs = Number.isFinite(page.refreshIntervalMs)
    ? page.refreshIntervalMs
    : STATUS_REFRESH_INTERVAL_MS;
  const states = Array.isArray(page.states) && page.states.length > 0
    ? page.states
    : [...PULL_REQUEST_VIEWS];
  const clientConfig = serializePageConfig({
    workspace: page.workspace,
    repositories: page.repositories,
    refreshIntervalMs,
    states,
    users: page.users || [],
  });
  const repositoryButtons = page.repositories.map((slug) => `
    <button type="button" class="repository-button" data-repository="${escapeHtml(slug)}">
      <span class="repository-name">${escapeHtml(slug)}</span>
      <span class="repository-detail">Loading…</span>
    </button>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pull requests · ${workspace}</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <link rel="stylesheet" href="/repository-assets/repositories.css">
</head>
<body>
  <header class="topbar">
    <a class="brand" href="/repositories">
      <i class="fa-brands fa-bitbucket" aria-hidden="true"></i>
      <span>${workspace}</span>
    </a>
    <nav class="topnav" aria-label="Application">
      <a href="/">Tickets</a>
      <a href="/repositories" class="is-active" aria-current="page">Pull requests</a>
      <a href="/activity">User Activity</a>
    </nav>
    <div class="topbar-status">
      <button id="refresh-button" class="button button-quiet" type="button">Refresh</button>
      <span id="live-status" class="live-status is-live">
        <span class="live-dot" aria-hidden="true"></span>
        <span id="live-label">Live</span>
      </span>
      <span id="synced-at">Waiting for Bitbucket…</span>
    </div>
  </header>

  <div class="layout">
    <aside class="sidebar">
      <div class="sidebar-heading">
        <h1>Repositories</h1>
        <p id="sidebar-caption"></p>
      </div>
      <div id="repository-list" class="repository-list">
        <button type="button" class="repository-button is-selected" data-repository="">
          <span class="repository-name">All repositories</span>
          <span class="repository-detail">Loading…</span>
        </button>
        ${repositoryButtons}
      </div>
    </aside>

    <main class="content">
      <div class="content-header">
        <div>
          <p class="eyebrow" id="content-eyebrow">Pull requests</p>
          <h2 id="content-title">All repositories</h2>
        </div>
        <div class="content-actions">
          <a id="bitbucket-list-link" class="text-link" href="https://bitbucket.org/${workspace}" target="_blank" rel="noopener">View on Bitbucket</a>
          <a id="open-bitbucket" class="button button-primary" href="https://bitbucket.org/${workspace}" target="_blank" rel="noopener">Open Bitbucket</a>
        </div>
      </div>

      <div id="stat-row" class="stat-row"></div>
      <div id="user-filters" class="user-filters" role="group" aria-label="Filter by user"></div>

      <div class="toolbar">
        <div id="state-tabs" class="tabs" role="tablist" aria-label="Pull request state">
          <button type="button" data-state="OPEN" class="is-selected">Open</button>
          <button type="button" data-state="DRAFT">Drafts</button>
          <button type="button" data-state="MERGED">Merged</button>
          <button type="button" data-state="DECLINED">Declined</button>
        </div>
        <div class="toolbar-actions">
          <button id="attention-button" type="button" aria-pressed="false">Needs attention</button>
          <label class="search">
            <span class="visually-hidden">Search pull requests</span>
            <input id="search-input" type="search" placeholder="Search title, author, or branch" autocomplete="off">
          </label>
        </div>
      </div>

      <div id="status-banner" class="banner" role="alert" hidden></div>
      <div id="pull-request-list" class="pull-request-list">
        <div class="loading"><i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Loading pull requests…</div>
      </div>
      <p id="board-footnote" class="footnote"></p>
    </main>
  </div>

  <script id="repository-page-config" type="application/json">${clientConfig}</script>
  <script src="/repository-assets/repositories.js" defer></script>
</body>
</html>`;
}
