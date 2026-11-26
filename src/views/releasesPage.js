import { STATUS_REFRESH_INTERVAL_MS } from '../bitbucketConstants.js';

/**
 * Escapes text that is inserted into the releases page HTML.
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
 * Serializes the boot config so a `<` inside a value cannot close the script tag.
 * @param {object} value
 * @returns {string}
 */
function serializePageConfig(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/**
 * Renders the Release Tracker page (`/releases`).
 * Displays the last 2 minor versions (`release/vX.X.X`) per repository with their
 * creation (cut) date and last update date, plus one-click copy for Microsoft Teams.
 * @param {{ workspace: string, repositories: string[], refreshIntervalMs?: number, minorLimit?: number }} page
 * @returns {string}
 */
export function renderReleasesPage(page) {
  const workspace = escapeHtml(page.workspace || 'Workspace');
  const refreshIntervalMs = Number.isFinite(page.refreshIntervalMs)
    ? page.refreshIntervalMs
    : STATUS_REFRESH_INTERVAL_MS;
  const minorLimit = Number.isFinite(page.minorLimit) ? page.minorLimit : 2;

  const clientConfig = serializePageConfig({
    workspace: page.workspace,
    repositories: page.repositories || [],
    refreshIntervalMs,
    minorLimit,
  });

  const repositoryButtons = (page.repositories || []).map((slug) => `
    <button type="button" class="repository-button" data-repository="${escapeHtml(slug)}">
      <span class="repository-name">${escapeHtml(slug)}</span>
      <span class="repository-detail">Cargando…</span>
    </button>`).join('');

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Releases · ${workspace}</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <link rel="stylesheet" href="/repository-assets/repositories.css">
  <link rel="stylesheet" href="/repository-assets/releases.css">
</head>
<body>
  <header class="topbar">
    <a class="brand" href="/releases">
      <i class="fa-solid fa-code-branch" aria-hidden="true"></i>
      <span>${workspace}</span>
    </a>
    <nav class="topnav" aria-label="Application">
      <a href="/">Tickets</a>
      <a href="/repositories">Pull requests</a>
      <a href="/activity">User Activity</a>
      <a href="/reports">Team Reports</a>
      <a href="/releases" class="is-active" aria-current="page">Releases</a>
    </nav>
    <div class="topbar-status">
      <button id="refresh-button" class="button button-quiet" type="button">Refresh</button>
      <span id="live-status" class="live-status is-live">
        <span class="live-dot" aria-hidden="true"></span>
        <span id="live-label">Live</span>
      </span>
      <span id="synced-at">Sincronizando con Bitbucket…</span>
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
          <span class="repository-detail">Cargando…</span>
        </button>
        ${repositoryButtons}
      </div>
    </aside>

    <main class="content">
      <div class="content-header">
        <div>
          <p class="eyebrow" id="content-eyebrow">Release Tracker · Convención release/vX.X.X</p>
          <h2 id="content-title">All repositories</h2>
          <p class="releases-subtitle">Últimos 2 minor por repositorio: día de creación del corte (release branch) y fecha de última actualización.</p>
        </div>
        <div class="content-actions">
          <button id="teams-copy-button" class="button button-teams" type="button" title="Copiar resumen de releases (últimos 2 minor por repositorio) para pegar en Microsoft Teams">
            <i class="fa-solid fa-clipboard-list" aria-hidden="true"></i>
            <span>Copiar para Teams</span>
          </button>
          <a id="open-bitbucket" class="button button-primary" href="https://bitbucket.org/${workspace}" target="_blank" rel="noopener">Open Bitbucket</a>
        </div>
      </div>

      <div id="release-stat-row" class="stat-row release-stat-row"></div>

      <div class="toolbar">
        <div id="view-tabs" class="tabs" role="tablist" aria-label="Modo de visualización">
          <button type="button" data-view="table" class="is-selected">
            <i class="fa-solid fa-table" aria-hidden="true"></i> Tabla Resumen
          </button>
          <button type="button" data-view="cards">
            <i class="fa-solid fa-layer-group" aria-hidden="true"></i> Tarjetas por Repo
          </button>
        </div>
        <div class="toolbar-actions">
          <button id="only-with-releases-button" type="button" class="filter-toggle-button" aria-pressed="false">
            <i class="fa-solid fa-filter" aria-hidden="true"></i> Solo con releases
          </button>
          <label class="search">
            <span class="visually-hidden">Buscar repositorio o versión</span>
            <input id="search-input" type="search" placeholder="Buscar repo, versión (ej. v1.3) o autor…" autocomplete="off">
          </label>
        </div>
      </div>

      <div id="status-banner" class="banner" role="alert" hidden></div>
      <div id="copy-toast" class="copy-toast" role="status" aria-live="polite" hidden></div>

      <div id="releases-container" class="releases-container">
        <div class="loading"><i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Analizando ramas release/vX.X.X en Bitbucket…</div>
      </div>

      <p id="releases-footnote" class="footnote"></p>
    </main>
  </div>

  <div id="teams-modal" class="modal-overlay" hidden>
    <div class="modal-card" role="dialog" aria-labelledby="modal-title" aria-modal="true">
      <div class="modal-header">
        <div class="modal-title-group">
          <i class="fa-solid fa-clipboard-list modal-icon" aria-hidden="true"></i>
          <div>
            <h3 id="modal-title">Mensaje para Teams · Tracking de Releases</h3>
            <p class="modal-subtitle" id="modal-subtitle">Últimos 2 minor por repositorio (Creación y Última actualización)</p>
          </div>
        </div>
        <button id="modal-close-btn" class="modal-close" type="button" aria-label="Cerrar">&times;</button>
      </div>
      <div class="modal-body">
        <div class="modal-alert is-success" id="modal-copy-alert">
          <i class="fa-solid fa-circle-check" aria-hidden="true"></i>
          <span id="modal-alert-text">¡Mensaje copiado al portapapeles! Listo para pegar en Microsoft Teams.</span>
        </div>
        <div class="modal-options">
          <label class="modal-option-checkbox">
            <input type="checkbox" id="teams-only-with-releases" checked>
            <span>Solo repos con releases</span>
          </label>
          <label class="modal-option-checkbox">
            <input type="checkbox" id="teams-format-table">
            <span>Formato tabla compacta</span>
          </label>
          <label class="modal-option-checkbox">
            <input type="checkbox" id="teams-include-patches" checked>
            <span>Detalle de patches (ej. v2.2.0, v2.2.1)</span>
          </label>
          <label class="modal-option-checkbox">
            <input type="checkbox" id="teams-include-authors">
            <span>Incluir autor</span>
          </label>
        </div>
        <textarea id="teams-message-text" class="modal-textarea" rows="14" spellcheck="false"></textarea>
      </div>
      <div class="modal-footer">
        <span class="modal-footer-stats" id="modal-footer-stats"></span>
        <div class="modal-footer-actions">
          <button id="modal-close-action" class="button button-quiet" type="button">Cerrar</button>
          <button id="modal-copy-action" class="button button-primary" type="button">
            <i class="fa-solid fa-copy" aria-hidden="true"></i>
            <span id="modal-copy-label">Copiar</span>
          </button>
        </div>
      </div>
    </div>
  </div>

  <script id="releases-page-config" type="application/json">${clientConfig}</script>
  <script src="/repository-assets/releases.js" defer></script>
</body>
</html>`;
}
