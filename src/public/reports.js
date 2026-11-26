/**
 * Team Performance Reports Dashboard - Client Controller
 */
(function teamReportsApp() {
  const state = {
    activeReport: null,
    reportsList: [],
    sortKey: 'resolved',
    sortAsc: false,
    filterText: '',
    isGenerating: false,
  };

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    loadInitialData();
    bindEvents();

    if (state.activeReport) {
      renderActiveReport();
    } else if (state.reportsList.length > 0) {
      loadReportById(state.reportsList[0].id);
    } else {
      // If no reports exist yet, show welcome prompt to generate the first report
      renderEmptyState();
    }

    renderHistoryUI();
  }

  function loadInitialData() {
    try {
      const initialReportEl = document.getElementById('initial-report-data');
      if (initialReportEl && initialReportEl.textContent.trim()) {
        state.activeReport = JSON.parse(initialReportEl.textContent);
      }
    } catch {
      state.activeReport = null;
    }

    try {
      const initialListEl = document.getElementById('initial-reports-list');
      if (initialListEl && initialListEl.textContent.trim()) {
        state.reportsList = JSON.parse(initialListEl.textContent) || [];
      }
    } catch {
      state.reportsList = [];
    }
  }

  function bindEvents() {
    const generateBtn = document.getElementById('generate-team-report-btn');
    if (generateBtn) {
      generateBtn.addEventListener('click', handleGenerateReport);
    }

    const selectEl = document.getElementById('reports-history-select');
    if (selectEl) {
      selectEl.addEventListener('change', (e) => {
        const reportId = e.target.value;
        if (reportId) loadReportById(reportId);
      });
    }

    const filterInput = document.getElementById('table-filter-input');
    if (filterInput) {
      filterInput.addEventListener('input', (e) => {
        state.filterText = e.target.value.trim().toLowerCase();
        renderTable();
      });
    }

    // Sortable table headers
    document.querySelectorAll('#team-comparison-table th[data-sort]').forEach((th) => {
      th.addEventListener('click', () => {
        const sortKey = th.dataset.sort;
        if (state.sortKey === sortKey) {
          state.sortAsc = !state.sortAsc;
        } else {
          state.sortKey = sortKey;
          state.sortAsc = sortKey === 'name'; // default asc for names, desc for numbers
        }
        renderTable();
      });
    });

    // Teams modal
    const copyTeamsBtn = document.getElementById('report-copy-teams-btn');
    if (copyTeamsBtn) {
      copyTeamsBtn.addEventListener('click', handleCopyTeams);
    }

    const downloadJsonBtn = document.getElementById('report-download-json-btn');
    if (downloadJsonBtn) {
      downloadJsonBtn.addEventListener('click', handleDownloadJson);
    }

    const toggleAllBtn = document.getElementById('drilldown-toggle-all-btn');
    if (toggleAllBtn) {
      toggleAllBtn.addEventListener('click', toggleAllDrilldowns);
    }

    // Modal close events
    const modalCloseBtn = document.getElementById('modal-close-btn');
    const modalCloseAction = document.getElementById('modal-close-action');
    const modalCopyAction = document.getElementById('modal-copy-action');
    const teamsModal = document.getElementById('teams-modal');

    if (modalCloseBtn) modalCloseBtn.addEventListener('click', () => teamsModal.hidden = true);
    if (modalCloseAction) modalCloseAction.addEventListener('click', () => teamsModal.hidden = true);
    if (teamsModal) {
      teamsModal.addEventListener('click', (e) => {
        if (e.target === teamsModal) teamsModal.hidden = true;
      });
    }
    if (modalCopyAction) {
      modalCopyAction.addEventListener('click', async () => {
        const textarea = document.getElementById('teams-message-text');
        if (textarea) {
          await copyTextToClipboard(textarea.value);
          const alertEl = document.getElementById('modal-copy-alert');
          if (alertEl) {
            alertEl.style.display = 'flex';
            setTimeout(() => { alertEl.style.display = 'none'; }, 2500);
          }
        }
      });
    }
  }

  async function handleGenerateReport() {
    if (state.isGenerating) return;

    const btn = document.getElementById('generate-team-report-btn');
    const banner = document.getElementById('generation-progress-banner');
    const originalText = btn.innerHTML;

    state.isGenerating = true;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> <span>Generando…</span>';
    if (banner) banner.hidden = false;

    try {
      const response = await fetch('/api/reports/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days: 30 }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      const result = await response.json();
      state.activeReport = result.report;

      // Update history list
      await refreshHistoryList();

      renderActiveReport();
      renderHistoryUI();

      btn.innerHTML = '<i class="fa-solid fa-check" aria-hidden="true"></i> <span>¡Reporte Generado!</span>';
      setTimeout(() => {
        btn.innerHTML = originalText;
        btn.disabled = false;
      }, 2500);
    } catch (err) {
      alert(`Error al generar el reporte: ${err.message}`);
      btn.innerHTML = originalText;
      btn.disabled = false;
    } finally {
      state.isGenerating = false;
      if (banner) banner.hidden = true;
    }
  }

  async function loadReportById(reportId) {
    try {
      const response = await fetch(`/api/reports/${encodeURIComponent(reportId)}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      state.activeReport = await response.json();
      renderActiveReport();
      renderHistoryUI();
    } catch (err) {
      alert(`No se pudo cargar el reporte: ${err.message}`);
    }
  }

  async function refreshHistoryList() {
    try {
      const response = await fetch('/api/reports');
      if (response.ok) {
        state.reportsList = await response.json();
      }
    } catch {
      // ignore
    }
  }

  function renderActiveReport() {
    const report = state.activeReport;
    if (!report) return;

    // 1. Header Information
    const titleEl = document.getElementById('report-title');
    const dateTextEl = document.getElementById('report-date-text');
    const periodTextEl = document.getElementById('report-period-text');
    const subtitleEl = document.getElementById('report-subtitle');

    if (titleEl) titleEl.textContent = report.title || 'Team Performance Report';
    if (dateTextEl) dateTextEl.textContent = `Generado el ${report.formattedDate || report.createdAt?.slice(0, 10)}`;
    if (periodTextEl) periodTextEl.textContent = `${report.period?.from} al ${report.period?.to} (${report.period?.days || 30} días)`;
    if (subtitleEl) {
      const count = report.members?.length || 0;
      subtitleEl.textContent = `Comparativa de performance para ${count} miembros del equipo: tickets Jira resueltos, tiempos en In-Progress, rebotes QA ➔ Dev y actividad en Bitbucket.`;
    }

    // 2. KPIs
    renderKPIs(report);

    // 3. Visual Charts
    renderCharts(report);

    // 4. Comparative Table
    renderTable();

    // 5. Member Drilldowns
    renderMemberDrilldowns(report);
  }

  function renderKPIs(report) {
    const s = report.teamSummary || {};

    setElText('kpi-total-resolved', formatNum(s.totalResolved || 0));
    setElText('kpi-resolved-breakdown', `Stories: ${s.resolvedByType?.story || 0} · Bugs: ${s.resolvedByType?.bug || 0} · Tasks: ${s.resolvedByType?.task || 0}`);

    setElText('kpi-avg-in-progress', s.avgInProgressFormatted || '0 h');
    setElText('kpi-total-in-progress', `Total equipo: ${Math.round(s.totalInProgressHours || 0)} hrs`);

    setElText('kpi-total-bounces', formatNum(s.totalQaBounces || 0));
    setElText('kpi-bounce-rate', `Tasa de rebote: ${s.teamQaBounceRatePct || 0}%`);

    setElText('kpi-prs-merged', formatNum(s.totalPrsMerged || 0));
    setElText('kpi-prs-created', `${formatNum(s.totalPrsCreated || 0)} PRs creados en Bitbucket`);

    setElText('kpi-prs-reviewed', formatNum(s.totalPrsReviewed || 0));

    const added = s.totalLinesAdded ? `+${formatNum(s.totalLinesAdded)}` : '+0';
    const removed = s.totalLinesRemoved ? `-${formatNum(s.totalLinesRemoved)}` : '-0';
    setElText('kpi-code-lines', `${added} / ${removed}`);
    setElText('kpi-commits-count', `${formatNum(s.totalCommits || 0)} commits en ${report.period?.days || 30} días`);
  }

  function renderCharts(report) {
    const members = report.members || [];
    if (members.length === 0) return;

    // Chart 1: Resolved tickets by member
    const container1 = document.getElementById('chart-resolved-members');
    if (container1) {
      const maxResolved = Math.max(1, ...members.map((m) => m.jira.resolvedCount));
      const html1 = members.map((m) => {
        const total = m.jira.resolvedCount;
        const widthPct = Math.round((total / maxResolved) * 100);
        const storyPct = total > 0 ? (m.jira.resolvedByType.story / total) * 100 : 0;
        const bugPct = total > 0 ? (m.jira.resolvedByType.bug / total) * 100 : 0;
        const taskPct = total > 0 ? (m.jira.resolvedByType.task / total) * 100 : 0;

        return `
          <div class="bar-chart-row">
            <span class="bar-label" title="${escapeHtml(m.displayName)}">${escapeHtml(m.displayName)}</span>
            <div class="bar-track">
              <div class="bar-segment seg-story" style="width: ${storyPct}%;" title="Stories: ${m.jira.resolvedByType.story}"></div>
              <div class="bar-segment seg-bug" style="width: ${bugPct}%;" title="Bugs: ${m.jira.resolvedByType.bug}"></div>
              <div class="bar-segment seg-task" style="width: ${taskPct}%;" title="Tasks: ${m.jira.resolvedByType.task}"></div>
            </div>
            <span class="bar-value">${total}</span>
          </div>`;
      }).join('');
      container1.innerHTML = `<div class="bar-chart-list">${html1}</div>`;
    }

    // Chart 2: In-Progress Hours vs QA Bounces
    const container2 = document.getElementById('chart-efficiency-bounces');
    if (container2) {
      const maxHours = Math.max(1, ...members.map((m) => m.jira.avgInProgressHoursPerTicket));
      const html2 = members.map((m) => {
        const hours = m.jira.avgInProgressHoursPerTicket;
        const widthPct = Math.round((hours / maxHours) * 100);
        const bounces = m.jira.qaBouncesCount;

        return `
          <div class="bar-chart-row">
            <span class="bar-label" title="${escapeHtml(m.displayName)}">${escapeHtml(m.displayName)}</span>
            <div class="bar-track">
              <div class="bar-segment seg-time" style="width: ${widthPct}%;" title="Promedio: ${m.jira.avgInProgressFormatted}"></div>
            </div>
            <span class="bar-value" title="${bounces} rebotes QA">${m.jira.avgInProgressFormatted} <small style="color:${bounces > 0 ? '#ae2e24' : '#216e4e'};">(${bounces}🔄)</small></span>
          </div>`;
      }).join('');
      container2.innerHTML = `<div class="bar-chart-list">${html2}</div>`;
    }

    // Chart 3: Bitbucket PRs Merged vs Reviews
    const container3 = document.getElementById('chart-prs-reviews');
    if (container3) {
      const maxCombined = Math.max(1, ...members.map((m) => m.bitbucket.prsMerged + m.bitbucket.prsReviewed));
      const html3 = members.map((m) => {
        const prs = m.bitbucket.prsMerged;
        const reviews = m.bitbucket.prsReviewed;
        const combined = prs + reviews;
        const prPct = combined > 0 ? (prs / combined) * 100 : 0;
        const revPct = combined > 0 ? (reviews / combined) * 100 : 0;

        return `
          <div class="bar-chart-row">
            <span class="bar-label" title="${escapeHtml(m.displayName)}">${escapeHtml(m.displayName)}</span>
            <div class="bar-track">
              <div class="bar-segment seg-prs" style="width: ${prPct}%;" title="PRs Mergeados: ${prs}"></div>
              <div class="bar-segment seg-reviews" style="width: ${revPct}%;" title="Reviews Realizadas: ${reviews}"></div>
            </div>
            <span class="bar-value" title="${prs} PRs / ${reviews} reviews">${prs} / ${reviews}</span>
          </div>`;
      }).join('');
      container3.innerHTML = `<div class="bar-chart-list">${html3}</div>`;
    }
  }

  function renderTable() {
    const tbody = document.getElementById('team-table-body');
    if (!tbody || !state.activeReport) return;

    let members = [...(state.activeReport.members || [])];

    // Filter
    if (state.filterText) {
      members = members.filter((m) =>
        m.displayName.toLowerCase().includes(state.filterText) ||
        (m.email && m.email.toLowerCase().includes(state.filterText))
      );
    }

    // Sort
    members.sort((a, b) => {
      let valA, valB;
      switch (state.sortKey) {
        case 'name':
          valA = a.displayName.toLowerCase();
          valB = b.displayName.toLowerCase();
          return state.sortAsc ? valA.localeCompare(valB) : valB.localeCompare(valA);
        case 'resolved':
          valA = a.jira.resolvedCount;
          valB = b.jira.resolvedCount;
          break;
        case 'inProgressAvg':
          valA = a.jira.avgInProgressHoursPerTicket;
          valB = b.jira.avgInProgressHoursPerTicket;
          break;
        case 'inProgressTotal':
          valA = a.jira.totalInProgressHours;
          valB = b.jira.totalInProgressHours;
          break;
        case 'qaBounces':
          valA = a.jira.qaBouncesCount;
          valB = b.jira.qaBouncesCount;
          break;
        case 'wip':
          valA = a.jira.currentWipCount;
          valB = b.jira.currentWipCount;
          break;
        case 'prsMerged':
          valA = a.bitbucket.prsMerged;
          valB = b.bitbucket.prsMerged;
          break;
        case 'prsReviewed':
          valA = a.bitbucket.prsReviewed;
          valB = b.bitbucket.prsReviewed;
          break;
        case 'lines':
          valA = a.bitbucket.linesAdded;
          valB = b.bitbucket.linesAdded;
          break;
        default:
          valA = a.jira.resolvedCount;
          valB = b.jira.resolvedCount;
      }
      return state.sortAsc ? valA - valB : valB - valA;
    });

    if (members.length === 0) {
      tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:24px;color:var(--bb-muted);">No se encontraron miembros coincidentes.</td></tr>`;
      return;
    }

    tbody.innerHTML = members.map((m) => {
      const initials = (m.displayName || 'Dev')
        .split(/\s+/)
        .slice(0, 2)
        .map((p) => p[0].toUpperCase())
        .join('');

      let bounceBadgeClass = 'badge-bounce-zero';
      if (m.jira.qaBouncesCount > 2) bounceBadgeClass = 'badge-bounce-high';
      else if (m.jira.qaBouncesCount > 0) bounceBadgeClass = 'badge-bounce-low';

      const highlightHtml = (m.highlights || []).map((h) =>
        `<span class="highlight-chip highlight-${h.type}"><i class="fa-solid ${h.icon}"></i> ${escapeHtml(h.label)}</span>`
      ).join('');

      return `
        <tr data-member="${escapeHtml(m.identifier)}" onclick="toggleMemberDrilldown('${escapeHtml(m.identifier)}')">
          <td>
            <div class="member-cell">
              <span class="member-avatar">${escapeHtml(initials)}</span>
              <div class="member-name-block">
                <span class="member-name">${escapeHtml(m.displayName)}</span>
                <span class="member-email">${escapeHtml(m.email)}</span>
              </div>
            </div>
          </td>
          <td class="num-col">
            <strong>${m.jira.resolvedCount}</strong>
            <span class="type-pill">(${m.jira.resolvedByType.story}S · ${m.jira.resolvedByType.bug}B · ${m.jira.resolvedByType.task}T)</span>
          </td>
          <td class="num-col"><strong>${m.jira.avgInProgressFormatted}</strong></td>
          <td class="num-col">${m.jira.totalInProgressFormatted}</td>
          <td class="num-col">
            <span class="badge-bounce ${bounceBadgeClass}">
              ${m.jira.qaBouncesCount} rebotes (${m.jira.qaBounceRatePct}%)
            </span>
          </td>
          <td class="num-col">${m.jira.currentWipCount}</td>
          <td class="num-col"><strong>${m.bitbucket.prsMerged}</strong></td>
          <td class="num-col"><strong>${m.bitbucket.prsReviewed}</strong></td>
          <td class="num-col">
            <span style="color:#216e4e;">+${formatNum(m.bitbucket.linesAdded)}</span> /
            <span style="color:#ae2e24;">-${formatNum(m.bitbucket.linesRemoved)}</span>
          </td>
          <td>
            <div class="highlight-chips-container">${highlightHtml || '-'}</div>
          </td>
        </tr>`;
    }).join('');
  }

  function renderMemberDrilldowns(report) {
    const container = document.getElementById('member-drilldown-container');
    if (!container) return;

    const members = report.members || [];
    if (members.length === 0) {
      container.innerHTML = '<p class="empty-cell">Sin detalles disponibles.</p>';
      return;
    }

    container.innerHTML = members.map((m) => {
      const initials = (m.displayName || 'Dev')
        .split(/\s+/)
        .slice(0, 2)
        .map((p) => p[0].toUpperCase())
        .join('');

      const resolvedTicketsHtml = (m.jira.resolvedTickets || []).map((t) => `
        <div class="ticket-item">
          <div class="ticket-item-left">
            <a class="ticket-key" href="${escapeHtml(t.url)}" target="_blank" rel="noopener">${escapeHtml(t.key)}</a>
            <span class="ticket-summary" title="${escapeHtml(t.summary)}">${escapeHtml(t.summary)}</span>
          </div>
          <span class="ticket-time" title="Tiempo en In Progress"><i class="fa-regular fa-clock"></i> ${escapeHtml(t.inProgressFormatted)}</span>
        </div>`).join('') || '<p style="color:var(--bb-muted);font-size:0.78rem;">Ningún ticket resuelto en este período.</p>';

      const bouncedTicketsHtml = (m.jira.bouncedTickets || []).map((b) => {
        const transDetails = (b.transitions || []).map((tr) =>
          `<code>${escapeHtml(tr.from)}</code> ➔ <code>${escapeHtml(tr.to)}</code> por ${escapeHtml(tr.author)} (${escapeHtml(tr.date?.slice(0, 10))})`
        ).join('<br>');
        return `
          <div class="bounce-item">
            <strong><a class="ticket-key" href="${escapeHtml(b.url)}" target="_blank" rel="noopener">${escapeHtml(b.key)}</a>: ${escapeHtml(b.summary)}</strong>
            <div class="bounce-transition">${transDetails}</div>
          </div>`;
      }).join('') || '<p style="color:var(--bb-success);font-size:0.78rem;"><i class="fa-solid fa-check"></i> Cero rebotes de QA. ¡Excelente calidad!</p>';

      return `
        <article class="member-accordion-card" id="accordion-${escapeHtml(m.identifier)}">
          <header class="member-accordion-header" onclick="toggleMemberDrilldown('${escapeHtml(m.identifier)}')">
            <div class="accordion-title-left">
              <span class="member-avatar">${escapeHtml(initials)}</span>
              <div>
                <strong>${escapeHtml(m.displayName)}</strong>
                <small style="color:var(--bb-muted);margin-left:6px;">${escapeHtml(m.email)}</small>
              </div>
            </div>
            <div class="accordion-title-right">
              <span class="accordion-stat-pill"><strong>${m.jira.resolvedCount}</strong> tickets resueltos</span>
              <span class="accordion-stat-pill"><strong>${m.jira.avgInProgressFormatted}</strong> prom. In-Progress</span>
              <span class="accordion-stat-pill"><strong style="color:${m.jira.qaBouncesCount > 0 ? '#ae2e24' : '#216e4e'};">${m.jira.qaBouncesCount}</strong> rebotes QA</span>
              <span class="accordion-stat-pill"><strong>${m.bitbucket.prsMerged}</strong> PRs</span>
              <i class="fa-solid fa-chevron-down accordion-toggle-icon" aria-hidden="true"></i>
            </div>
          </header>
          <div class="member-accordion-body">
            <div class="member-detail-grid">
              <div class="detail-subpanel">
                <h4><i class="fa-solid fa-circle-check" style="color:var(--bb-success);"></i> Tickets Resueltos (${m.jira.resolvedTickets?.length || 0})</h4>
                <div class="ticket-item-list">${resolvedTicketsHtml}</div>
              </div>
              <div class="detail-subpanel">
                <h4><i class="fa-solid fa-rotate-left" style="color:#ae2e24;"></i> Rebotes QA ➔ Dev (${m.jira.bouncedTickets?.length || 0})</h4>
                <div class="ticket-item-list">${bouncedTicketsHtml}</div>
              </div>
            </div>
          </div>
        </article>`;
    }).join('');
  }

  function renderHistoryUI() {
    // 1. Selector Dropdown
    const selectEl = document.getElementById('reports-history-select');
    if (selectEl) {
      if (state.reportsList.length === 0) {
        selectEl.innerHTML = '<option value="">Sin reportes previos</option>';
      } else {
        selectEl.innerHTML = state.reportsList.map((r) => {
          const selected = state.activeReport && state.activeReport.id === r.id ? 'selected' : '';
          return `<option value="${escapeHtml(r.id)}" ${selected}>${escapeHtml(r.formattedDate || r.id)} (${r.memberCount} devs)</option>`;
        }).join('');
      }
    }

    // 2. History Grid Cards
    const gridEl = document.getElementById('history-reports-grid');
    if (gridEl) {
      if (state.reportsList.length === 0) {
        gridEl.innerHTML = '<p style="color:var(--bb-muted);font-size:0.85rem;">No hay reportes históricos generados. Haz clic en "Generate team report" para crear el primero.</p>';
        return;
      }

      gridEl.innerHTML = state.reportsList.map((r) => {
        const isActive = state.activeReport && state.activeReport.id === r.id;
        const activeClass = isActive ? ' is-active' : '';

        return `
          <article class="history-card${activeClass}" onclick="loadReportById('${escapeHtml(r.id)}')">
            <div class="history-card-header">
              <span class="history-date"><i class="fa-regular fa-calendar-check" aria-hidden="true"></i> ${escapeHtml(r.formattedDate || r.id)}</span>
              ${isActive ? '<span class="report-badge report-badge-date" style="padding:1px 6px;font-size:0.7rem;">Activo</span>' : ''}
            </div>
            <span class="history-period">Período: ${r.period?.from || ''} al ${r.period?.to || ''}</span>
            <div class="history-stats">
              <span><strong>${r.summary?.totalResolved || 0}</strong> tickets</span>
              <span>·</span>
              <span><strong>${r.summary?.totalQaBounces || 0}</strong> rebotes QA</span>
              <span>·</span>
              <span><strong>${r.summary?.totalPrsMerged || 0}</strong> PRs</span>
            </div>
          </article>`;
      }).join('');
    }
  }

  function renderEmptyState() {
    const titleEl = document.getElementById('report-title');
    if (titleEl) titleEl.textContent = 'Team Performance Report';
    const subtitleEl = document.getElementById('report-subtitle');
    if (subtitleEl) subtitleEl.textContent = 'No hay reportes generados todavía. Haz clic en el botón superior "Generate team report" para analizar los últimos 30 días.';
  }

  window.toggleMemberDrilldown = function(identifier) {
    const card = document.getElementById(`accordion-${identifier}`);
    if (card) {
      card.classList.toggle('is-open');
    }
  };

  let allDrilldownsExpanded = false;
  function toggleAllDrilldowns() {
    allDrilldownsExpanded = !allDrilldownsExpanded;
    const cards = document.querySelectorAll('.member-accordion-card');
    cards.forEach((card) => {
      if (allDrilldownsExpanded) {
        card.classList.add('is-open');
      } else {
        card.classList.remove('is-open');
      }
    });
    const btn = document.getElementById('drilldown-toggle-all-btn');
    if (btn) {
      btn.innerHTML = allDrilldownsExpanded
        ? '<i class="fa-solid fa-angles-up" aria-hidden="true"></i> <span>Colapsar todos</span>'
        : '<i class="fa-solid fa-angles-down" aria-hidden="true"></i> <span>Expandir todos</span>';
    }
  }
  window.toggleAllDrilldowns = toggleAllDrilldowns;

  window.loadReportById = loadReportById;

  async function handleCopyTeams() {
    if (!state.activeReport) return;
    try {
      const response = await fetch(`/api/reports/${encodeURIComponent(state.activeReport.id)}/markdown`);
      let markdown = '';
      if (response.ok) {
        const data = await response.json();
        markdown = data.markdown;
      } else {
        markdown = buildFallbackMarkdown(state.activeReport);
      }

      await copyTextToClipboard(markdown);

      const textarea = document.getElementById('teams-message-text');
      if (textarea) textarea.value = markdown;
      const modal = document.getElementById('teams-modal');
      if (modal) modal.hidden = false;
    } catch (err) {
      alert(`Error al exportar para Teams: ${err.message}`);
    }
  }

  function handleDownloadJson() {
    if (!state.activeReport) return;
    const jsonStr = JSON.stringify(state.activeReport, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${state.activeReport.id}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function buildFallbackMarkdown(report) {
    const s = report.teamSummary || {};
    return `# 📊 Team Performance Report · ${report.period?.days || 30} días\n📅 Generado el ${report.formattedDate}\n\n• Resueltos: ${s.totalResolved}\n• In-Progress Promedio: ${s.avgInProgressFormatted}\n• Rebotes QA: ${s.totalQaBounces} (${s.teamQaBounceRatePct}%)\n• PRs Mergeados: ${s.totalPrsMerged}`;
  }

  async function copyTextToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }

  function setElText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function formatNum(n) {
    return Number(n || 0).toLocaleString('es-ES');
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
})();
