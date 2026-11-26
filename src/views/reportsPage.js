/**
 * HTML view template for Team Reports Dashboard
 * @param {{ workspace: string, repositories: string[], users?: string[], activeReport?: object, reportsList?: object[] }} page
 * @returns {string}
 */
export function renderReportsPage(page) {
  const workspace = escapeHtml(page.workspace || 'Workspace');
  const clientConfig = JSON.stringify({
    workspace: page.workspace || '',
    repositories: page.repositories || [],
    users: page.users || [],
    activeReportId: page.activeReport?.id || '',
  }).replace(/</g, '\\u003c');

  const initialReportData = page.activeReport
    ? JSON.stringify(page.activeReport).replace(/</g, '\\u003c')
    : 'null';

  const initialReportsList = JSON.stringify(page.reportsList || []).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Team Performance Reports · ${workspace}</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <link rel="stylesheet" href="/repository-assets/repositories.css">
  <link rel="stylesheet" href="/repository-assets/activity.css">
  <link rel="stylesheet" href="/repository-assets/reports.css">
</head>
<body>
  <header class="topbar">
    <a class="brand" href="/reports">
      <i class="fa-solid fa-chart-pie" aria-hidden="true"></i>
      <span>${workspace}</span>
    </a>
    <nav class="topnav" aria-label="Application">
      <a href="/">Tickets</a>
      <a href="/repositories">Pull requests</a>
      <a href="/activity">User Activity</a>
      <a href="/reports" class="is-active" aria-current="page">Team Reports</a>
      <a href="/releases">Releases</a>
    </nav>
    <div class="topbar-status">
      <button id="generate-team-report-btn" class="button button-primary" type="button" title="Generar nuevo reporte comparativo del equipo para los últimos 30 días">
        <i class="fa-solid fa-chart-line" aria-hidden="true"></i>
        <span>Generate team report</span>
      </button>
    </div>
  </header>

  <main class="reports-main">
    <!-- Sub-header & Report Controls -->
    <section class="reports-header-card">
      <div class="reports-header-top">
        <div class="reports-header-info">
          <div class="reports-title-row">
            <h1 id="report-title">Team Performance Report</h1>
            <span class="report-badge report-badge-date" id="report-date-badge">
              <i class="fa-regular fa-calendar-check" aria-hidden="true"></i>
              <span id="report-date-text">Cargando…</span>
            </span>
            <span class="report-badge report-badge-period" id="report-period-badge">
              <i class="fa-regular fa-clock" aria-hidden="true"></i>
              <span id="report-period-text">Últimos 30 días</span>
            </span>
          </div>
          <p class="reports-subtitle" id="report-subtitle">
            Comparativa de performance del equipo: tickets Jira resueltos, tiempo en In-Progress, rebotes QA ➔ Dev y actividad de Bitbucket.
          </p>
        </div>

        <div class="reports-actions-group">
          <!-- Report History Selector -->
          <div class="reports-history-selector-wrapper">
            <label for="reports-history-select" class="selector-label">
              <i class="fa-solid fa-history" aria-hidden="true"></i> Reportes guardados:
            </label>
            <select id="reports-history-select" class="reports-select">
              <option value="">Cargando historial…</option>
            </select>
          </div>

          <div class="reports-buttons-row">
            <button id="report-copy-teams-btn" class="button button-teams" type="button" title="Copiar resumen para Microsoft Teams">
              <i class="fa-solid fa-clipboard" aria-hidden="true"></i>
              <span>Copiar para Teams</span>
            </button>
            <button id="report-download-json-btn" class="button button-quiet" type="button" title="Descargar datos en formato JSON">
              <i class="fa-solid fa-download" aria-hidden="true"></i>
              <span>JSON</span>
            </button>
            <button id="report-print-btn" class="button button-quiet" type="button" title="Imprimir o guardar como PDF" onclick="window.print()">
              <i class="fa-solid fa-print" aria-hidden="true"></i>
              <span>Imprimir</span>
            </button>
          </div>
        </div>
      </div>
    </section>

    <!-- Async Loading Overlay / Progress Banner -->
    <div id="generation-progress-banner" class="generation-banner" hidden>
      <div class="generation-spinner">
        <i class="fa-solid fa-circle-notch fa-spin" aria-hidden="true"></i>
      </div>
      <div class="generation-message">
        <h4>Generando reporte del equipo de forma asíncrona…</h4>
        <p>Analizando tickets Jira, transiciones de estado, rebotes de QA, pull requests y commits de los últimos 30 días.</p>
      </div>
    </div>

    <!-- KPI Summary Row -->
    <section class="report-kpi-grid" id="report-kpi-grid">
      <article class="kpi-card">
        <div class="kpi-icon kpi-icon-blue"><i class="fa-solid fa-check-circle" aria-hidden="true"></i></div>
        <div class="kpi-data">
          <span class="kpi-label">Tickets Jira Resueltos</span>
          <span class="kpi-value" id="kpi-total-resolved">-</span>
          <span class="kpi-subtext" id="kpi-resolved-breakdown">Stories: 0 · Bugs: 0 · Tasks: 0</span>
        </div>
      </article>

      <article class="kpi-card">
        <div class="kpi-icon kpi-icon-purple"><i class="fa-solid fa-stopwatch" aria-hidden="true"></i></div>
        <div class="kpi-data">
          <span class="kpi-label">Tiempo Prom. In-Progress</span>
          <span class="kpi-value" id="kpi-avg-in-progress">-</span>
          <span class="kpi-subtext" id="kpi-total-in-progress">Total equipo: -</span>
        </div>
      </article>

      <article class="kpi-card kpi-card-alert" id="kpi-card-bounces">
        <div class="kpi-icon kpi-icon-amber"><i class="fa-solid fa-rotate-left" aria-hidden="true"></i></div>
        <div class="kpi-data">
          <span class="kpi-label">Rebotes QA ➔ In Progress</span>
          <span class="kpi-value" id="kpi-total-bounces">-</span>
          <span class="kpi-subtext" id="kpi-bounce-rate">Tasa de rebote: 0%</span>
        </div>
      </article>

      <article class="kpi-card">
        <div class="kpi-icon kpi-icon-green"><i class="fa-solid fa-code-merge" aria-hidden="true"></i></div>
        <div class="kpi-data">
          <span class="kpi-label">PRs Mergeados</span>
          <span class="kpi-value" id="kpi-prs-merged">-</span>
          <span class="kpi-subtext" id="kpi-prs-created">0 PRs creados en Bitbucket</span>
        </div>
      </article>

      <article class="kpi-card">
        <div class="kpi-icon kpi-icon-cyan"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i></div>
        <div class="kpi-data">
          <span class="kpi-label">Reviews Realizadas</span>
          <span class="kpi-value" id="kpi-prs-reviewed">-</span>
          <span class="kpi-subtext">Revisiones de código por el equipo</span>
        </div>
      </article>

      <article class="kpi-card">
        <div class="kpi-icon kpi-icon-teal"><i class="fa-solid fa-code" aria-hidden="true"></i></div>
        <div class="kpi-data">
          <span class="kpi-label">Volumen de Código</span>
          <span class="kpi-value" id="kpi-code-lines">-</span>
          <span class="kpi-subtext" id="kpi-commits-count">0 commits en 30 días</span>
        </div>
      </article>
    </section>

    <!-- Visual Charts Comparison Section -->
    <section class="report-section charts-section">
      <div class="section-header">
        <h2><i class="fa-solid fa-chart-simple" aria-hidden="true"></i> Comparativa Visual del Equipo</h2>
        <span class="section-tag">Últimos 30 días</span>
      </div>

      <div class="charts-grid">
        <!-- Chart 1: Resolved tickets by member -->
        <article class="chart-card">
          <div class="chart-card-header">
            <h3>Tickets Resueltos por Miembro (Jira)</h3>
            <span class="chart-legend-row">
              <span class="legend-dot dot-story"></span> Story
              <span class="legend-dot dot-bug"></span> Bug
              <span class="legend-dot dot-task"></span> Task
            </span>
          </div>
          <div class="chart-container" id="chart-resolved-members"></div>
        </article>

        <!-- Chart 2: In Progress Time vs QA Bounces -->
        <article class="chart-card">
          <div class="chart-card-header">
            <h3>Tiempo In-Progress vs Rebotes QA</h3>
            <span class="chart-subhead">Eficiencia y retrabajo</span>
          </div>
          <div class="chart-container" id="chart-efficiency-bounces"></div>
        </article>

        <!-- Chart 3: Bitbucket PRs & Reviews -->
        <article class="chart-card">
          <div class="chart-card-header">
            <h3>Colaboración: PRs Mergeados vs Reviews</h3>
            <span class="chart-subhead">Aporte y revisión de código</span>
          </div>
          <div class="chart-container" id="chart-prs-reviews"></div>
        </article>
      </div>
    </section>

    <!-- Comparative Table Section -->
    <section class="report-section">
      <div class="section-header">
        <div>
          <h2><i class="fa-solid fa-table-columns" aria-hidden="true"></i> Tabla Comparativa del Equipo</h2>
          <p class="section-subtitle">Haz clic en los encabezados para ordenar o en una fila para ver el desglose detallado.</p>
        </div>
        <div class="table-search-box">
          <i class="fa-solid fa-search" aria-hidden="true"></i>
          <input type="text" id="table-filter-input" placeholder="Filtrar por miembro…">
        </div>
      </div>

      <div class="table-container">
        <table class="report-table" id="team-comparison-table">
          <thead>
            <tr>
              <th data-sort="name">Miembro <i class="fa-solid fa-sort" aria-hidden="true"></i></th>
              <th data-sort="resolved" class="num-col">Tickets Resueltos <i class="fa-solid fa-sort" aria-hidden="true"></i></th>
              <th data-sort="inProgressAvg" class="num-col">Prom. In-Progress <i class="fa-solid fa-sort" aria-hidden="true"></i></th>
              <th data-sort="inProgressTotal" class="num-col">Total In-Progress <i class="fa-solid fa-sort" aria-hidden="true"></i></th>
              <th data-sort="qaBounces" class="num-col">Rebotes QA <i class="fa-solid fa-sort" aria-hidden="true"></i></th>
              <th data-sort="wip" class="num-col">WIP Actual <i class="fa-solid fa-sort" aria-hidden="true"></i></th>
              <th data-sort="prsMerged" class="num-col">PRs Mergeados <i class="fa-solid fa-sort" aria-hidden="true"></i></th>
              <th data-sort="prsReviewed" class="num-col">PRs Revisados <i class="fa-solid fa-sort" aria-hidden="true"></i></th>
              <th data-sort="lines" class="num-col">Líneas (+ / -) <i class="fa-solid fa-sort" aria-hidden="true"></i></th>
              <th>Destacados</th>
            </tr>
          </thead>
          <tbody id="team-table-body">
            <!-- Dynamic rows -->
          </tbody>
        </table>
      </div>
    </section>

    <!-- Detailed Member Drilldown Accordions -->
    <section class="report-section">
      <div class="section-header">
        <div>
          <h2><i class="fa-solid fa-address-card" aria-hidden="true"></i> Detalle Individual por Desarrollador</h2>
          <p class="section-subtitle">Tickets resueltos, tiempo en In-Progress de cada ticket y detalle de rebotes de QA.</p>
        </div>
        <div class="drilldown-actions">
          <button id="drilldown-toggle-all-btn" class="button button-quiet" type="button" title="Expandir o colapsar todos los miembros">
            <i class="fa-solid fa-angles-down" aria-hidden="true"></i>
            <span>Expandir todos</span>
          </button>
        </div>
      </div>

      <div class="member-cards-container" id="member-drilldown-container">
        <!-- Rendered dynamically -->
      </div>
    </section>

    <!-- Historical Reports Drawer / Section -->
    <section class="report-section history-section">
      <div class="section-header">
        <div>
          <h2><i class="fa-solid fa-clock-rotate-left" aria-hidden="true"></i> Historial de Reportes Generados</h2>
          <p class="section-subtitle">Acceso directo a todos los reportes estáticos generados previamente con su fecha de creación.</p>
        </div>
      </div>

      <div class="history-grid" id="history-reports-grid">
        <!-- History cards rendered dynamically -->
      </div>
    </section>
  </main>

  <!-- Teams Modal Export -->
  <div id="teams-modal" class="modal-overlay" hidden>
    <div class="modal-card" role="dialog" aria-labelledby="modal-title" aria-modal="true">
      <div class="modal-header">
        <div class="modal-title-group">
          <i class="fa-solid fa-clipboard-list modal-icon" aria-hidden="true"></i>
          <div>
            <h3 id="modal-title">Reporte para Microsoft Teams</h3>
            <p class="modal-subtitle">Resumen ejecutivo y comparativa de rendimiento</p>
          </div>
        </div>
        <button id="modal-close-btn" class="modal-close" type="button" aria-label="Cerrar">&times;</button>
      </div>
      <div class="modal-body">
        <div class="modal-alert is-success" id="modal-copy-alert">
          <i class="fa-solid fa-circle-check" aria-hidden="true"></i>
          <span id="modal-alert-text">¡Reporte copiado al portapapeles! Listo para pegar en Teams.</span>
        </div>
        <textarea id="teams-message-text" class="modal-textarea" rows="14" spellcheck="false"></textarea>
      </div>
      <div class="modal-footer">
        <span class="modal-footer-stats" id="modal-footer-stats"></span>
        <div class="modal-footer-actions">
          <button id="modal-close-action" class="button button-quiet" type="button">Cerrar</button>
          <button id="modal-copy-action" class="button button-primary" type="button">
            <i class="fa-solid fa-copy" aria-hidden="true"></i>
            <span>Copiar al Portapapeles</span>
          </button>
        </div>
      </div>
    </div>
  </div>

  <script id="reports-page-config" type="application/json">${clientConfig}</script>
  <script id="initial-report-data" type="application/json">${initialReportData}</script>
  <script id="initial-reports-list" type="application/json">${initialReportsList}</script>
  <script src="/repository-assets/reports.js" defer></script>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
