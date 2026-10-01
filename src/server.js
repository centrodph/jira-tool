import express from 'express';
import path from 'path';
import fs from 'fs';
import { marked } from 'marked';
import { getConfig } from './config.js';
import { JiraClient } from './jiraClient.js';
import { formatIssueToMarkdown } from './markdownFormatter.js';
import { saveIssueToMarkdownFile } from './fileWriter.js';

const app = express();
const config = getConfig();
const client = new JiraClient(config);

const PORT = process.env.PORT || 3099;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static tickets folder (for attachments and direct access)
app.use('/tickets', express.static(config.outputDir));

// Helper: Parse Frontmatter from Markdown string
function parseFrontmatter(content) {
  const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---/;
  const match = content.match(frontmatterRegex);
  if (!match) return { metadata: {}, body: content };

  const frontmatterStr = match[1];
  const body = content.slice(match[0].length).trim();
  const metadata = {};

  for (const line of frontmatterStr.split('\n')) {
    const idx = line.indexOf(':');
    if (idx !== -1) {
      const key = line.slice(0, idx).trim();
      let val = line.slice(idx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      metadata[key] = val;
    }
  }

  return { metadata, body };
}

// API: Get list of saved tickets
app.get('/api/tickets', async (req, res) => {
  try {
    const dir = config.outputDir;
    if (!fs.existsSync(dir)) {
      return res.json({ tickets: [] });
    }

    const files = await fs.promises.readdir(dir);
    const mdFiles = files.filter(f => f.endsWith('.md'));

    const tickets = await Promise.all(
      mdFiles.map(async (filename) => {
        const filePath = path.join(dir, filename);
        const stat = await fs.promises.stat(filePath);
        const content = await fs.promises.readFile(filePath, 'utf-8');
        const { metadata } = parseFrontmatter(content);
        const key = filename.replace(/\.md$/, '');

        return {
          key,
          filename,
          title: metadata.title || key,
          type: metadata.type || 'Unknown',
          status: metadata.status || 'Unknown',
          priority: metadata.priority || 'None',
          assignee: metadata.assignee || 'Unassigned',
          updated: metadata.updated || stat.mtime.toISOString(),
          size: stat.size,
          mtime: stat.mtime,
        };
      })
    );

    // Sort by most recently modified
    tickets.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));

    res.json({ tickets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Get single ticket detail
app.get('/api/tickets/:key', async (req, res) => {
  try {
    const key = req.params.key.toUpperCase();
    const filePath = path.join(config.outputDir, `${key}.md`);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: `Ticket file ${key}.md not found.` });
    }

    const rawContent = await fs.promises.readFile(filePath, 'utf-8');
    const { metadata, body } = parseFrontmatter(rawContent);

    // Convert relative markdown links (e.g. ./KEY_attachments/file.jpg) to static server path (/tickets/KEY_attachments/file.jpg)
    const processedBody = body.replace(/\.\/([^\s)]+_attachments\/[^\s)]+)/g, '/tickets/$1');
    const html = marked.parse(processedBody);

    res.json({
      key,
      metadata,
      rawContent,
      html,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Delete ticket
app.delete('/api/tickets/:key', async (req, res) => {
  try {
    const key = req.params.key.toUpperCase();
    const filePath = path.join(config.outputDir, `${key}.md`);
    const attachmentsDir = path.join(config.outputDir, `${key}_attachments`);

    if (fs.existsSync(filePath)) {
      await fs.promises.unlink(filePath);
    }
    if (fs.existsSync(attachmentsDir)) {
      await fs.promises.rm(attachmentsDir, { recursive: true, force: true });
    }

    res.json({ success: true, message: `Ticket ${key} deleted.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Submit & Fetch Jira ticket(s)
app.post('/api/tickets/fetch', async (req, res) => {
  try {
    const { ticketInput, jql, downloadAttachments = false } = req.body;
    let keys = [];

    if (ticketInput && ticketInput.trim()) {
      keys = ticketInput
        .split(/[\s,]+/)
        .map(k => k.trim().toUpperCase())
        .filter(Boolean);
    }

    if (jql && jql.trim()) {
      const searchResults = await client.searchIssues(jql.trim(), 20);
      for (const issue of searchResults) {
        if (issue.key && !keys.includes(issue.key)) {
          keys.push(issue.key);
        }
      }
    }

    if (keys.length === 0) {
      return res.status(400).json({ error: 'Please provide at least one ticket key or a valid JQL query.' });
    }

    const saved = [];
    const errors = [];

    for (const key of keys) {
      try {
        const issue = await client.fetchIssue(key);
        const markdown = formatIssueToMarkdown(issue, config.baseUrl);
        const saveResult = await saveIssueToMarkdownFile(issue, markdown, {
          outputDir: config.outputDir,
          downloadAttachments,
          jiraClient: client,
        });
        saved.push(saveResult);
      } catch (err) {
        errors.push({ key, error: err.message });
      }
    }

    res.json({
      success: true,
      savedCount: saved.length,
      saved,
      errors,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve UI HTML
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Jira Ticket Markdown Manager</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <style>
    :root {
      --bg-primary: #0f172a;
      --bg-secondary: #1e293b;
      --bg-card: #334155;
      --accent: #3b82f6;
      --accent-hover: #2563eb;
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --border-color: #475569;
      --success: #10b981;
      --danger: #ef4444;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg-primary);
      color: var(--text-main);
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }

    header {
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border-color);
      padding: 1rem 1.5rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    header .title {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      font-size: 1.25rem;
      font-weight: 700;
    }
    header .title i { color: var(--accent); }
    header .jira-url {
      font-size: 0.85rem;
      color: var(--text-muted);
      background: var(--bg-primary);
      padding: 0.35rem 0.75rem;
      border-radius: 6px;
      border: 1px solid var(--border-color);
    }

    .app-container {
      display: flex;
      flex: 1;
      overflow: hidden;
    }

    /* Sidebar: Ticket List */
    .sidebar {
      width: 340px;
      background: var(--bg-secondary);
      border-right: 1px solid var(--border-color);
      display: flex;
      flex-direction: column;
    }
    .sidebar-header {
      padding: 1rem;
      border-bottom: 1px solid var(--border-color);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .sidebar-header h2 {
      font-size: 1rem;
      color: var(--text-main);
    }
    .search-box {
      padding: 0.75rem 1rem;
      border-bottom: 1px solid var(--border-color);
    }
    .search-box input {
      width: 100%;
      background: var(--bg-primary);
      border: 1px solid var(--border-color);
      color: var(--text-main);
      padding: 0.5rem 0.75rem;
      border-radius: 6px;
      font-size: 0.9rem;
    }
    .ticket-list {
      flex: 1;
      overflow-y: auto;
      list-style: none;
    }
    .ticket-item {
      padding: 0.85rem 1rem;
      border-bottom: 1px solid var(--border-color);
      cursor: pointer;
      transition: background 0.15s ease;
      display: flex;
      flex-direction: column;
      gap: 0.35rem;
    }
    .ticket-item:hover { background: rgba(255, 255, 255, 0.05); }
    .ticket-item.active {
      background: rgba(59, 130, 246, 0.15);
      border-left: 4px solid var(--accent);
    }
    .ticket-item-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .ticket-key {
      font-weight: 700;
      color: var(--accent);
      font-size: 0.95rem;
    }
    .badge {
      font-size: 0.75rem;
      padding: 0.15rem 0.4rem;
      border-radius: 4px;
      background: var(--bg-card);
      color: var(--text-muted);
    }
    .ticket-title {
      font-size: 0.85rem;
      color: var(--text-main);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .ticket-meta {
      font-size: 0.75rem;
      color: var(--text-muted);
      display: flex;
      gap: 0.75rem;
    }

    /* Main Content Area */
    .main-content {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      background: var(--bg-primary);
    }

    /* Form Section */
    .form-panel {
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border-color);
      padding: 1.25rem 1.5rem;
    }
    .form-row {
      display: flex;
      gap: 1rem;
      align-items: flex-end;
      flex-wrap: wrap;
    }
    .form-group {
      display: flex;
      flex-direction: column;
      gap: 0.4rem;
      flex: 1;
      min-width: 220px;
    }
    .form-group label {
      font-size: 0.85rem;
      font-weight: 600;
      color: var(--text-muted);
    }
    .form-group input[type="text"] {
      background: var(--bg-primary);
      border: 1px solid var(--border-color);
      color: var(--text-main);
      padding: 0.6rem 0.8rem;
      border-radius: 6px;
      font-size: 0.9rem;
    }
    .checkbox-group {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.85rem;
      color: var(--text-muted);
      cursor: pointer;
      user-select: none;
      padding-bottom: 0.4rem;
    }
    .btn {
      background: var(--accent);
      color: white;
      border: none;
      padding: 0.65rem 1.25rem;
      border-radius: 6px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s ease;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .btn:hover { background: var(--accent-hover); }
    .btn:disabled { opacity: 0.6; cursor: not-allowed; }
    .btn-danger { background: var(--danger); }
    .btn-danger:hover { background: #dc2626; }

    /* Viewer Area */
    .viewer {
      flex: 1;
      overflow-y: auto;
      padding: 2rem;
    }
    .viewer-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--border-color);
      padding-bottom: 1rem;
      margin-bottom: 1.5rem;
    }
    .viewer-tabs {
      display: flex;
      gap: 0.5rem;
    }
    .tab-btn {
      background: transparent;
      border: 1px solid var(--border-color);
      color: var(--text-muted);
      padding: 0.4rem 0.8rem;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.85rem;
    }
    .tab-btn.active {
      background: var(--bg-card);
      color: var(--text-main);
      border-color: var(--accent);
    }

    /* Markdown Render Styling */
    .markdown-body {
      line-height: 1.6;
      color: #e2e8f0;
    }
    .markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4 {
      color: var(--text-main);
      margin-top: 1.5rem;
      margin-bottom: 0.75rem;
      border-bottom: 1px solid var(--border-color);
      padding-bottom: 0.3rem;
    }
    .markdown-body p { margin-bottom: 1rem; }
    .markdown-body table {
      width: 100%;
      border-collapse: collapse;
      margin: 1rem 0;
    }
    .markdown-body th, .markdown-body td {
      border: 1px solid var(--border-color);
      padding: 0.6rem 0.8rem;
      text-align: left;
    }
    .markdown-body th { background: var(--bg-secondary); }
    .markdown-body code {
      background: #1e293b;
      padding: 0.2rem 0.4rem;
      border-radius: 4px;
      font-family: monospace;
    }
    .markdown-body pre code {
      display: block;
      padding: 1rem;
      overflow-x: auto;
    }
    .markdown-body blockquote {
      border-left: 4px solid var(--accent);
      padding-left: 1rem;
      color: var(--text-muted);
      margin: 1rem 0;
    }
    .markdown-body img {
      max-width: 100%;
      border-radius: 6px;
      margin: 1rem 0;
    }
    .raw-textarea {
      width: 100%;
      height: 500px;
      background: var(--bg-secondary);
      color: var(--text-main);
      font-family: monospace;
      padding: 1rem;
      border: 1px solid var(--border-color);
      border-radius: 6px;
      resize: vertical;
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--text-muted);
      gap: 1rem;
    }
    .empty-state i { font-size: 3rem; color: var(--border-color); }
    .status-msg {
      margin-top: 0.5rem;
      font-size: 0.85rem;
    }
    .status-success { color: var(--success); }
    .status-error { color: var(--danger); }
  </style>
</head>
<body>

  <header>
    <div class="title">
      <i class="fa-solid fa-file-lines"></i>
      <span>Jira Ticket Markdown Manager</span>
    </div>
    <div class="jira-url">
      <i class="fa-solid fa-link"></i> ${config.baseUrl}
    </div>
  </header>

  <div class="app-container">

    <!-- Sidebar -->
    <div class="sidebar">
      <div class="sidebar-header">
        <h2>Saved Tickets</h2>
        <span class="badge" id="ticket-count">0</span>
      </div>
      <div class="search-box">
        <input type="text" id="search-input" placeholder="Filter tickets..." oninput="filterTickets()">
      </div>
      <ul class="ticket-list" id="ticket-list">
        <!-- Rendered dynamically -->
      </ul>
    </div>

    <!-- Main Content -->
    <div class="main-content">

      <!-- Form Panel -->
      <div class="form-panel">
        <form id="fetch-form" onsubmit="handleFetch(event)">
          <div class="form-row">
            <div class="form-group">
              <label for="ticket-input"><i class="fa-solid fa-ticket"></i> Ticket Key(s)</label>
              <input type="text" id="ticket-input" placeholder="e.g. RCS-575, RCS-274">
            </div>

            <div class="form-group">
              <label for="jql-input"><i class="fa-solid fa-magnifying-glass"></i> Or JQL Search Query</label>
              <input type="text" id="jql-input" placeholder="e.g. project = RCS order by created desc">
            </div>

            <div class="form-group" style="flex: 0;">
              <label>&nbsp;</label>
              <label class="checkbox-group">
                <input type="checkbox" id="attachments-input">
                <span>Download Attachments</span>
              </label>
            </div>

            <button type="submit" class="btn" id="submit-btn">
              <i class="fa-solid fa-cloud-arrow-down"></i>
              <span>Fetch & Save</span>
            </button>
          </div>
          <div id="form-status" class="status-msg"></div>
        </form>
      </div>

      <!-- Markdown Viewer -->
      <div class="viewer" id="viewer">
        <div class="empty-state">
          <i class="fa-solid fa-book-open"></i>
          <p>Select a ticket from the left sidebar or submit a ticket key above to convert.</p>
        </div>
      </div>

    </div>

  </div>

  <script>
    let currentTickets = [];
    let activeKey = null;
    let currentViewMode = 'rendered'; // 'rendered' or 'raw'

    async function loadTickets() {
      try {
        const res = await fetch('/api/tickets');
        const data = await res.json();
        currentTickets = data.tickets || [];
        document.getElementById('ticket-count').textContent = currentTickets.length;
        renderTicketList(currentTickets);
      } catch (err) {
        console.error('Failed to load tickets:', err);
      }
    }

    function renderTicketList(tickets) {
      const listEl = document.getElementById('ticket-list');
      if (tickets.length === 0) {
        listEl.innerHTML = '<li style="padding:1rem; color:var(--text-muted); text-align:center;">No saved tickets yet</li>';
        return;
      }

      listEl.innerHTML = tickets.map(t => \`
        <li class="ticket-item \${t.key === activeKey ? 'active' : ''}" onclick="selectTicket('\${t.key}')">
          <div class="ticket-item-top">
            <span class="ticket-key">\${t.key}</span>
            <span class="badge">\${t.status}</span>
          </div>
          <div class="ticket-title" title="\${escapeHtml(t.title)}">\${escapeHtml(t.title)}</div>
          <div class="ticket-meta">
            <span><i class="fa-solid fa-user"></i> \${escapeHtml(t.assignee)}</span>
            <span><i class="fa-solid fa-tag"></i> \${t.type}</span>
          </div>
        </li>
      \`).join('');
    }

    function filterTickets() {
      const query = document.getElementById('search-input').value.toLowerCase();
      const filtered = currentTickets.filter(t => 
        t.key.toLowerCase().includes(query) ||
        t.title.toLowerCase().includes(query) ||
        t.assignee.toLowerCase().includes(query)
      );
      renderTicketList(filtered);
    }

    async function selectTicket(key) {
      activeKey = key;
      renderTicketList(currentTickets);
      const viewer = document.getElementById('viewer');
      viewer.innerHTML = '<div class="empty-state"><i class="fa-solid fa-spinner fa-spin"></i><p>Loading ticket...</p></div>';

      try {
        const res = await fetch(\`/api/tickets/\${key}\`);
        if (!res.ok) throw new Error('Ticket not found');
        const data = await res.json();
        renderViewer(data);
      } catch (err) {
        viewer.innerHTML = \`<div class="empty-state status-error"><i class="fa-solid fa-circle-exclamation"></i><p>\${err.message}</p></div>\`;
      }
    }

    function renderViewer(ticket) {
      const viewer = document.getElementById('viewer');
      const meta = ticket.metadata;

      viewer.innerHTML = \`
        <div class="viewer-header">
          <div>
            <h2>[\${ticket.key}] \${escapeHtml(meta.title || ticket.key)}</h2>
            <p style="font-size:0.85rem; color:var(--text-muted); margin-top:0.25rem;">
              Updated: \${meta.updated || ''} | Jira URL: <a href="\${meta.url || '#'}" target="_blank" style="color:var(--accent);">Open in Jira <i class="fa-solid fa-external-link" style="font-size:0.75rem;"></i></a>
            </p>
          </div>
          <div style="display:flex; gap:0.75rem; align-items:center;">
            <div class="viewer-tabs">
              <button class="tab-btn \${currentViewMode === 'rendered' ? 'active' : ''}" onclick="switchView('rendered')">Preview</button>
              <button class="tab-btn \${currentViewMode === 'raw' ? 'active' : ''}" onclick="switchView('raw')">Raw Markdown</button>
            </div>
            <button class="btn btn-danger" onclick="deleteTicket('\${ticket.key}')" title="Delete Ticket">
              <i class="fa-solid fa-trash"></i>
            </button>
          </div>
        </div>

        <div id="view-rendered" style="display:\${currentViewMode === 'rendered' ? 'block' : 'none'};">
          <div class="markdown-body">\${ticket.html}</div>
        </div>

        <div id="view-raw" style="display:\${currentViewMode === 'raw' ? 'block' : 'none'};">
          <textarea class="raw-textarea" readonly>\${escapeHtml(ticket.rawContent)}</textarea>
        </div>
      \`;
    }

    function switchView(mode) {
      currentViewMode = mode;
      const renderedEl = document.getElementById('view-rendered');
      const rawEl = document.getElementById('view-raw');
      if (renderedEl && rawEl) {
        renderedEl.style.display = mode === 'rendered' ? 'block' : 'none';
        rawEl.style.display = mode === 'raw' ? 'block' : 'none';
      }
      document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.textContent.toLowerCase().includes(mode));
      });
    }

    async function handleFetch(event) {
      event.preventDefault();
      const ticketInput = document.getElementById('ticket-input').value;
      const jql = document.getElementById('jql-input').value;
      const attachments = document.getElementById('attachments-input').checked;
      const btn = document.getElementById('submit-btn');
      const statusEl = document.getElementById('form-status');

      if (!ticketInput.trim() && !jql.trim()) {
        statusEl.className = 'status-msg status-error';
        statusEl.textContent = 'Please enter a ticket key or JQL query.';
        return;
      }

      btn.disabled = true;
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Fetching...';
      statusEl.className = 'status-msg';
      statusEl.textContent = 'Fetching ticket data from Jira...';

      try {
        const res = await fetch('/api/tickets/fetch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ticketInput,
            jql,
            downloadAttachments: attachments
          })
        });

        const data = await res.json();
        if (!res.ok || !data.success) {
          throw new Error(data.error || 'Failed to fetch tickets.');
        }

        statusEl.className = 'status-msg status-success';
        statusEl.textContent = \`Successfully saved \${data.savedCount} ticket(s)!\`;
        
        await loadTickets();
        if (data.saved.length > 0) {
          selectTicket(data.saved[0].key);
        }

        document.getElementById('ticket-input').value = '';
      } catch (err) {
        statusEl.className = 'status-msg status-error';
        statusEl.textContent = err.message;
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-cloud-arrow-down"></i> Fetch & Save';
      }
    }

    async function deleteTicket(key) {
      if (!confirm(\`Are you sure you want to delete \${key}.md?\`)) return;
      try {
        await fetch(\`/api/tickets/\${key}\`, { method: 'DELETE' });
        activeKey = null;
        document.getElementById('viewer').innerHTML = '<div class="empty-state"><i class="fa-solid fa-book-open"></i><p>Select a ticket from the sidebar</p></div>';
        loadTickets();
      } catch (err) {
        alert('Failed to delete: ' + err.message);
      }
    }

    function escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    // Initial load
    loadTickets();
  </script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`\n🚀 Jira Markdown Web Application is running!`);
  console.log(`👉 Open in your browser: http://localhost:${PORT}\n`);
});
