import { STATUS_REFRESH_INTERVAL_MS } from '../bitbucketConstants.js';

/**
 * @param {string} value
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * @param {object} value
 * @returns {string}
 */
function serializePageConfig(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/**
 * @param {{ workspace: string, repositories: string[], users?: string[], refreshIntervalMs?: number }} page
 * @returns {string}
 */
export function renderActivityPage(page) {
  const workspace = escapeHtml(page.workspace);
  const clientConfig = serializePageConfig({
    workspace: page.workspace,
    repositories: page.repositories,
    users: page.users || [],
    refreshIntervalMs: page.refreshIntervalMs || STATUS_REFRESH_INTERVAL_MS,
  });

  const repositoryButtons = page.repositories.map((slug) => `
    <button type="button" class="repository-button" data-repository="${escapeHtml(slug)}">
      <span class="repository-name">${escapeHtml(slug)}</span>
      <span class="repository-detail">Select repo</span>
    </button>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>User Activity · ${workspace}</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <link rel="stylesheet" href="/repository-assets/repositories.css">
  <link rel="stylesheet" href="/repository-assets/activity.css">
</head>
<body>
  <header class="topbar">
    <a class="brand" href="/repositories">
      <i class="fa-brands fa-bitbucket" aria-hidden="true"></i>
      <span>${workspace}</span>
    </a>
    <nav class="topnav" aria-label="Application">
      <a href="/">Tickets</a>
      <a href="/repositories">Pull requests</a>
      <a href="/activity" class="is-active" aria-current="page">User Activity</a>
      <a href="/reports">Team Reports</a>
      <a href="/releases">Releases</a>
    </nav>
    <div class="topbar-status">
      <button id="refresh-button" class="button button-quiet" type="button">Refresh</button>
      <span id="live-status" class="live-status is-live">
        <span class="live-dot" aria-hidden="true"></span>
        <span id="live-label">Ready</span>
      </span>
      <span id="synced-at">Waiting…</span>
    </div>
  </header>

  <div class="layout">
    <aside class="sidebar">
      <div class="sidebar-heading">
        <h1>Repositories</h1>
        <p id="sidebar-caption">${page.repositories.length} repositories in ${workspace}</p>
      </div>
      <div id="repository-list" class="repository-list">
        <button type="button" class="repository-button is-selected" data-repository="">
          <span class="repository-name">All repositories</span>
          <span class="repository-detail">Included</span>
        </button>
        ${repositoryButtons}
      </div>

      <div class="sidebar-section">
        <h2 class="sidebar-section-title">Users</h2>
        <div id="sidebar-user-list" class="sidebar-user-list">
          <div class="user-search-wrapper">
            <input type="text" id="user-search-input" placeholder="Search user or email..." autocomplete="off">
          </div>
          <div id="user-chips-container" class="user-chips-container"></div>
        </div>
      </div>
    </aside>

    <main class="content">
      <div class="content-header">
        <div>
          <p class="eyebrow" id="activity-eyebrow">User Activity · Last 30 days</p>
          <h2 id="activity-user-heading">Select a user</h2>
        </div>
        <div class="content-actions">
          <a class="button button-quiet" href="/reports" title="Ver reporte comparativo de rendimiento del equipo">
            <i class="fa-solid fa-chart-line" aria-hidden="true"></i>
            <span>Team Reports</span>
          </a>
          <div class="days-selector" role="group" aria-label="Time range">
            <button type="button" data-days="7">7d</button>
            <button type="button" data-days="15">15d</button>
            <button type="button" data-days="30" class="is-selected">30d</button>
            <button type="button" data-days="60">60d</button>
          </div>
          <a id="open-bitbucket-user" class="button button-primary" href="https://bitbucket.org/${workspace}" target="_blank" rel="noopener">Open Bitbucket</a>
        </div>
      </div>

      <div id="stat-row" class="stat-row activity-stat-row">
        <div class="stat">
          <span class="stat-label">Total PRs</span>
          <span class="stat-value" id="stat-total-prs">-</span>
        </div>
        <div class="stat">
          <span class="stat-label">Merged PRs</span>
          <span class="stat-value" id="stat-merged-prs">-</span>
        </div>
        <div class="stat">
          <span class="stat-label">Open PRs</span>
          <span class="stat-value" id="stat-open-prs">-</span>
        </div>
        <div class="stat">
          <span class="stat-label">Total Commits</span>
          <span class="stat-value" id="stat-commits">-</span>
        </div>
        <div class="stat">
          <span class="stat-label">Lines Added</span>
          <span class="stat-value stat-added" id="stat-lines-added">-</span>
        </div>
        <div class="stat">
          <span class="stat-label">Lines Removed</span>
          <span class="stat-value stat-removed" id="stat-lines-removed">-</span>
        </div>
      </div>

      <div id="status-banner" class="banner" role="alert" hidden></div>

      <!-- Chart and Summary Table Section -->
      <section class="activity-analytics-card" id="analytics-section">
        <div class="chart-container">
          <h3 id="chart-title" class="analytics-card-title">PRs by repository</h3>
          <div id="pie-chart-wrapper" class="pie-chart-wrapper">
            <div class="loading"><i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Loading chart…</div>
          </div>
        </div>

        <div class="table-container">
          <h3 class="analytics-card-title">Repository Breakdown</h3>
          <div class="table-scroll">
            <table class="activity-table" id="repository-summary-table">
              <thead>
                <tr>
                  <th scope="col">Repository</th>
                  <th scope="col" class="num-col">PRs</th>
                  <th scope="col" class="num-col">Lines +</th>
                  <th scope="col" class="num-col">Lines -</th>
                  <th scope="col" class="num-col">Commits</th>
                </tr>
              </thead>
              <tbody id="summary-table-body">
                <tr><td colspan="5" class="empty-cell">Loading breakdown…</td></tr>
              </tbody>
              <tfoot id="summary-table-foot"></tfoot>
            </table>
          </div>
        </div>
      </section>

      <!-- Sub-tabs: Pull Requests and Commits -->
      <div class="activity-tabs-wrapper">
        <div class="toolbar">
          <div id="activity-tabs" class="tabs" role="tablist" aria-label="Activity type">
            <button type="button" data-tab="prs" class="is-selected" id="tab-btn-prs">
              <i class="fa-solid fa-code-pull-request" aria-hidden="true"></i> Pull Requests (<span id="count-badge-prs">0</span>)
            </button>
            <button type="button" data-tab="commits" id="tab-btn-commits">
              <i class="fa-solid fa-code-commit" aria-hidden="true"></i> Commits (<span id="count-badge-commits">0</span>)
            </button>
          </div>
          <div class="toolbar-actions">
            <div id="pr-status-filters" class="tabs pr-status-filters">
              <button type="button" data-status="ALL" class="is-selected">All</button>
              <button type="button" data-status="MERGED">Merged</button>
              <button type="button" data-status="OPEN">Open</button>
              <button type="button" data-status="DECLINED">Declined</button>
            </div>
            <label class="search">
              <span class="visually-hidden">Filter list</span>
              <input id="list-search-input" type="search" placeholder="Search title, message, branch..." autocomplete="off">
            </label>
          </div>
        </div>

        <div id="tab-content-prs" class="tab-pane is-active">
          <div id="prs-list-container" class="pull-request-list"></div>
        </div>

        <div id="tab-content-commits" class="tab-pane" hidden>
          <div id="commits-list-container" class="commits-list"></div>
        </div>
      </div>
    </main>
  </div>

  <script id="activity-page-config" type="application/json">${clientConfig}</script>
  <script src="/repository-assets/activity.js" defer></script>
</body>
</html>`;
}
