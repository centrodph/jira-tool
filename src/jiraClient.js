import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { getConfig } from './config.js';

/**
 * Converts plain text or basic Markdown into an Atlassian Document Format (ADF v1) document
 * accepted by Jira Cloud REST API v3 for issue descriptions and comments.
 * If an ADF object is already passed in, returns it unchanged.
 * @param {string|object} input
 * @returns {object}
 */
export function textToAdf(input) {
  if (input && typeof input === 'object' && input.type === 'doc') {
    return input;
  }

  const text = String(input ?? '').replace(/\r\n/g, '\n').trim();
  if (!text) {
    return {
      version: 1,
      type: 'doc',
      content: [],
    };
  }

  const lines = text.split('\n');
  const content = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Skip blank lines
    if (!line.trim()) {
      i += 1;
      continue;
    }

    // Fenced code block
    const fenceMatch = line.match(/^```([\w-]*)\s*$/);
    if (fenceMatch) {
      const language = fenceMatch[1] || undefined;
      const codeLines = [];
      i += 1;
      while (i < lines.length && !lines[i].match(/^```\s*$/)) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1; // skip closing ```
      const codeBlock = {
        type: 'codeBlock',
        content: [{ type: 'text', text: codeLines.join('\n') || ' ' }],
      };
      if (language) codeBlock.attrs = { language };
      content.push(codeBlock);
      continue;
    }

    // Heading (# .. ######)
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      content.push({
        type: 'heading',
        attrs: { level: headingMatch[1].length },
        content: parseInlineTextToAdf(headingMatch[2].trim()),
      });
      i += 1;
      continue;
    }

    // Bullet list
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        const itemText = lines[i].replace(/^\s*[-*]\s+/, '').trim();
        items.push({
          type: 'listItem',
          content: [{ type: 'paragraph', content: parseInlineTextToAdf(itemText) }],
        });
        i += 1;
      }
      content.push({ type: 'bulletList', content: items });
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        const itemText = lines[i].replace(/^\s*\d+\.\s+/, '').trim();
        items.push({
          type: 'listItem',
          content: [{ type: 'paragraph', content: parseInlineTextToAdf(itemText) }],
        });
        i += 1;
      }
      content.push({ type: 'orderedList', content: items });
      continue;
    }

    // Paragraph (coalesce consecutive plain lines)
    const paraLines = [];
    while (
      i < lines.length
      && lines[i].trim()
      && !lines[i].match(/^```/)
      && !lines[i].match(/^#{1,6}\s+/)
      && !/^\s*[-*]\s+/.test(lines[i])
      && !/^\s*\d+\.\s+/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i += 1;
    }
    const paraNodes = [];
    paraLines.forEach((pLine, idx) => {
      if (idx > 0) paraNodes.push({ type: 'hardBreak' });
      paraNodes.push(...parseInlineTextToAdf(pLine));
    });
    content.push({ type: 'paragraph', content: paraNodes });
  }

  return {
    version: 1,
    type: 'doc',
    content,
  };
}

/**
 * Parses inline markdown (`code`, **bold**) into ADF text nodes.
 * @param {string} line
 * @returns {object[]}
 */
function parseInlineTextToAdf(line) {
  const nodes = [];
  const tokenRegex = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let lastIndex = 0;
  let match;

  while ((match = tokenRegex.exec(line)) !== null) {
    if (match.index > lastIndex) {
      nodes.push({ type: 'text', text: line.slice(lastIndex, match.index) });
    }
    const token = match[0];
    if (token.startsWith('`') && token.endsWith('`')) {
      nodes.push({ type: 'text', text: token.slice(1, -1), marks: [{ type: 'code' }] });
    } else if (token.startsWith('**') && token.endsWith('**')) {
      nodes.push({ type: 'text', text: token.slice(2, -2), marks: [{ type: 'strong' }] });
    }
    lastIndex = tokenRegex.lastIndex;
  }

  if (lastIndex < line.length) {
    nodes.push({ type: 'text', text: line.slice(lastIndex) });
  }

  return nodes.length > 0 ? nodes : [{ type: 'text', text: line || ' ' }];
}

/**
 * Jira Client for interacting with Jira Cloud REST API v3
 */
export class JiraClient {
  constructor(config = getConfig()) {
    this.baseUrl = config.baseUrl;
    this.authHeader = config.authHeader;
  }

  /**
   * Helper method to perform authenticated fetch to Jira API
   */
  async request(endpoint, options = {}) {
    const url = endpoint.startsWith('http') ? endpoint : `${this.baseUrl}${endpoint}`;
    const headers = {
      'Authorization': this.authHeader,
      'Accept': 'application/json',
      ...options.headers,
    };

    const response = await fetch(url, {
      ...options,
      headers,
    });

    if (!response.ok) {
      let errorMessage = `Jira API error: ${response.status} ${response.statusText}`;
      try {
        const errorData = await response.json();
        if (errorData.errorMessages && errorData.errorMessages.length > 0) {
          errorMessage = errorData.errorMessages.join(' | ');
        } else if (errorData.errors && Object.keys(errorData.errors).length > 0) {
          errorMessage = Object.entries(errorData.errors)
            .map(([k, v]) => `${k}: ${v}`)
            .join(' | ');
        }
      } catch {
        // response was not JSON
      }

      if (response.status === 401 || response.status === 403) {
        throw new Error(`Authentication failed (HTTP ${response.status}). Check JIRA_EMAIL and JIRA_API_TOKEN in .env: ${errorMessage}`);
      }
      if (response.status === 404) {
        throw new Error(`Resource not found (HTTP 404): ${errorMessage}`);
      }

      throw new Error(errorMessage);
    }

    if (response.status === 204) {
      return null;
    }

    const rawText = typeof response.text === 'function' ? await response.text() : '';
    if (!rawText || !rawText.trim()) {
      return typeof response.json === 'function' && typeof response.text !== 'function'
        ? response.json()
        : null;
    }
    return JSON.parse(rawText);
  }

  /**
   * Get the authenticated Jira user profile
   */
  async getMyself() {
    return this.request('/rest/api/3/myself');
  }

  /**
   * Test Jira connection and credentials
   */
  async verifyConnection() {
    const user = await this.getMyself();
    return user.displayName || user.emailAddress || 'Authenticated User';
  }

  /**
   * Fetch a single Jira issue with rendered HTML fields and field names
   */
  async fetchIssue(issueKeyOrId) {
    const key = issueKeyOrId.trim();
    if (!key) throw new Error('Issue key cannot be empty');

    const endpoint = `/rest/api/3/issue/${encodeURIComponent(key)}?expand=renderedFields,names`;
    try {
      return await this.request(endpoint);
    } catch (err) {
      if (err.message.includes('404') || err.message.includes('does not exist')) {
        throw new Error(`Issue "${key}" not found or you do not have permission to view it.`);
      }
      throw err;
    }
  }

  /**
   * Search Jira issues using JQL
   */
  async searchIssues(jql, maxResults = 50) {
    try {
      const data = await this.request('/rest/api/3/search/jql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jql,
          maxResults,
          fields: ['key', 'summary', 'status', 'issuetype', 'priority', 'assignee'],
        }),
      });
      return data.issues || [];
    } catch (err) {
      // Fallback to GET /rest/api/3/search/jql
      const queryParams = new URLSearchParams({
        jql,
        maxResults: String(maxResults),
        fields: 'key,summary,status,issuetype,priority,assignee',
      });
      const data = await this.request(`/rest/api/3/search/jql?${queryParams.toString()}`);
      return data.issues || [];
    }
  }

  /**
   * Search Jira issues with custom fields and expand options (such as changelog)
   * Supports token-based pagination for large result sets.
   * @param {string} jql
   * @param {{ fields?: string[], expand?: string|string[], maxResults?: number }} [options]
   * @returns {Promise<object[]>}
   */
  async searchIssuesDetailed(jql, options = {}) {
    const targetMaxResults = options.maxResults || 100;
    const fields = options.fields || [
      'key',
      'summary',
      'status',
      'issuetype',
      'priority',
      'assignee',
      'reporter',
      'created',
      'resolutiondate',
      'timespent',
      'timeoriginalestimate',
      'customfield_10016',
      'customfield_10026',
    ];
    const expand = options.expand || 'changelog';
    const expandStr = Array.isArray(expand) ? expand.join(',') : (typeof expand === 'string' ? expand : '');

    const allIssues = [];
    let nextPageToken = null;
    const pageSize = Math.min(targetMaxResults, 100);

    do {
      const remaining = targetMaxResults - allIssues.length;
      const currentPageSize = Math.min(pageSize, remaining);
      if (currentPageSize <= 0) break;

      const bodyPayload = {
        jql,
        maxResults: currentPageSize,
        fields,
      };
      if (expandStr) {
        bodyPayload.expand = expandStr;
      }
      if (nextPageToken) {
        bodyPayload.nextPageToken = nextPageToken;
      }

      let data;
      try {
        data = await this.request('/rest/api/3/search/jql', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(bodyPayload),
        });
      } catch (err) {
        // Fallback to GET /rest/api/3/search/jql
        const queryParams = new URLSearchParams({
          jql,
          maxResults: String(currentPageSize),
          fields: fields.join(','),
        });
        if (expandStr) queryParams.set('expand', expandStr);
        if (nextPageToken) queryParams.set('nextPageToken', nextPageToken);
        data = await this.request(`/rest/api/3/search/jql?${queryParams.toString()}`);
      }

      const issues = data.issues || [];
      allIssues.push(...issues);

      nextPageToken = data.nextPageToken;
      if (!nextPageToken || data.isLast || issues.length === 0) {
        break;
      }
    } while (allIssues.length < targetMaxResults);

    return allIssues;
  }

  /**
   * Finds Atlassian accounts by email or display name.
   * The result is used to match Bitbucket pull request authors, who often
   * share the same account id but do not include an email address.
   * @param {string} query
   * @returns {Promise<object[]>}
   */
  async searchUsers(query) {
    const trimmedQuery = String(query || '').trim();
    if (!trimmedQuery) return [];

    const parameters = new URLSearchParams({
      query: trimmedQuery,
      maxResults: '10',
    });
    const data = await this.request(`/rest/api/3/user/search?${parameters.toString()}`);
    return Array.isArray(data) ? data : [];
  }

  /**
   * Download an attachment file from Jira
   */
  async downloadAttachment(attachmentUrl, destinationPath) {
    const res = await fetch(attachmentUrl, {
      headers: { 'Authorization': this.authHeader },
      redirect: 'follow',
    });

    if (!res.ok) {
      throw new Error(`Failed to download attachment: HTTP ${res.status} ${res.statusText}`);
    }

    await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
    const fileStream = fs.createWriteStream(destinationPath);
    await pipeline(res.body, fileStream);
  }

  /**
   * List accessible Jira projects
   * @param {{ query?: string, maxResults?: number }} [options]
   * @returns {Promise<object[]>}
   */
  async listProjects(options = {}) {
    const params = new URLSearchParams({
      maxResults: String(options.maxResults || 50),
    });
    if (options.query && options.query.trim()) {
      params.set('query', options.query.trim());
    }
    const data = await this.request(`/rest/api/3/project/search?${params.toString()}`);
    return Array.isArray(data?.values) ? data.values : [];
  }

  /**
   * Get available issue types for a project
   * @param {string} projectKey
   * @returns {Promise<object[]>}
   */
  async getProjectIssueTypes(projectKey) {
    const key = String(projectKey || '').trim().toUpperCase();
    if (!key) throw new Error('projectKey cannot be empty');

    try {
      const data = await this.request(`/rest/api/3/issue/createmeta/${encodeURIComponent(key)}/issuetypes`);
      if (Array.isArray(data?.issueTypes)) return data.issueTypes;
      if (Array.isArray(data?.values)) return data.values;
    } catch {
      // Fall back to project endpoint
    }
    const project = await this.request(`/rest/api/3/project/${encodeURIComponent(key)}`);
    return Array.isArray(project?.issueTypes) ? project.issueTypes : [];
  }

  /**
   * Create a new Jira issue
   * @param {{ projectKey: string, issueType?: string, summary: string, description?: string|object, priority?: string, labels?: string[], assigneeAccountId?: string, parentKey?: string, components?: string[], additionalFields?: Record<string, unknown> }} params
   * @returns {Promise<{ id: string, key: string, self?: string }>}
   */
  async createIssue(params) {
    const projectKey = String(params.projectKey || '').trim().toUpperCase();
    if (!projectKey) throw new Error('projectKey is required');
    if (!params.summary || !String(params.summary).trim()) throw new Error('summary is required');

    const fields = {
      project: { key: projectKey },
      issuetype: { name: params.issueType || 'Task' },
      summary: String(params.summary).trim(),
    };

    if (params.description !== undefined && params.description !== null && params.description !== '') {
      fields.description = textToAdf(params.description);
    }
    if (params.priority) {
      fields.priority = { name: params.priority };
    }
    if (Array.isArray(params.labels) && params.labels.length > 0) {
      fields.labels = params.labels;
    }
    if (params.assigneeAccountId) {
      fields.assignee = { accountId: params.assigneeAccountId };
    }
    if (params.parentKey) {
      fields.parent = { key: params.parentKey.trim().toUpperCase() };
    }
    if (Array.isArray(params.components) && params.components.length > 0) {
      fields.components = params.components.map((name) => ({ name }));
    }
    if (params.additionalFields && typeof params.additionalFields === 'object') {
      Object.assign(fields, params.additionalFields);
    }

    return this.request('/rest/api/3/issue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    });
  }

  /**
   * Update fields or perform update operations on an existing Jira issue
   * @param {string} issueKey
   * @param {{ summary?: string, description?: string|object, priority?: string, labels?: string[], assigneeAccountId?: string|null, parentKey?: string, components?: string[], additionalFields?: Record<string, unknown> }} fieldOptions
   * @param {object} [updateOps]
   */
  async updateIssue(issueKey, fieldOptions = {}, updateOps = undefined) {
    const key = String(issueKey || '').trim().toUpperCase();
    if (!key) throw new Error('issueKey is required');

    const fields = {};
    if (fieldOptions.summary !== undefined) {
      fields.summary = String(fieldOptions.summary).trim();
    }
    if (fieldOptions.description !== undefined) {
      fields.description = textToAdf(fieldOptions.description);
    }
    if (fieldOptions.priority !== undefined) {
      fields.priority = { name: fieldOptions.priority };
    }
    if (fieldOptions.labels !== undefined) {
      fields.labels = fieldOptions.labels;
    }
    if (fieldOptions.assigneeAccountId !== undefined) {
      fields.assignee = fieldOptions.assigneeAccountId ? { accountId: fieldOptions.assigneeAccountId } : null;
    }
    if (fieldOptions.parentKey !== undefined) {
      fields.parent = { key: fieldOptions.parentKey.trim().toUpperCase() };
    }
    if (fieldOptions.components !== undefined) {
      fields.components = fieldOptions.components.map((name) => ({ name }));
    }
    if (fieldOptions.additionalFields && typeof fieldOptions.additionalFields === 'object') {
      Object.assign(fields, fieldOptions.additionalFields);
    }

    const payload = {};
    if (Object.keys(fields).length > 0) payload.fields = fields;
    if (updateOps && Object.keys(updateOps).length > 0) payload.update = updateOps;

    if (Object.keys(payload).length === 0) {
      throw new Error('No fields or update operations provided.');
    }

    await this.request(`/rest/api/3/issue/${encodeURIComponent(key)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  /**
   * List available workflow transitions for an issue
   * @param {string} issueKey
   * @returns {Promise<object[]>}
   */
  async getTransitions(issueKey) {
    const key = String(issueKey || '').trim().toUpperCase();
    if (!key) throw new Error('issueKey is required');
    const data = await this.request(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`);
    return Array.isArray(data?.transitions) ? data.transitions : [];
  }

  /**
   * Transition an issue to another status
   * @param {string} issueKey
   * @param {string} transitionId
   * @param {{ comment?: string, resolution?: string }} [options]
   */
  async transitionIssue(issueKey, transitionId, options = {}) {
    const key = String(issueKey || '').trim().toUpperCase();
    if (!key) throw new Error('issueKey is required');
    if (!transitionId) throw new Error('transitionId is required');

    const payload = {
      transition: { id: String(transitionId) },
    };
    if (options.resolution) {
      payload.fields = { resolution: { name: options.resolution } };
    }
    if (options.comment) {
      payload.update = {
        comment: [{ add: { body: textToAdf(options.comment) } }],
      };
    }

    await this.request(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  /**
   * List comments on an issue
   * @param {string} issueKey
   * @param {{ maxResults?: number, startAt?: number }} [options]
   */
  async getComments(issueKey, options = {}) {
    const key = String(issueKey || '').trim().toUpperCase();
    if (!key) throw new Error('issueKey is required');
    const params = new URLSearchParams({
      maxResults: String(options.maxResults || 50),
      startAt: String(options.startAt || 0),
    });
    return this.request(`/rest/api/3/issue/${encodeURIComponent(key)}/comment?${params.toString()}`);
  }

  /**
   * Add a comment to a Jira issue
   * @param {string} issueKey
   * @param {string|object} body
   */
  async addComment(issueKey, body) {
    const key = String(issueKey || '').trim().toUpperCase();
    if (!key) throw new Error('issueKey is required');
    if (!body || !String(body).trim()) throw new Error('Comment body cannot be empty');

    return this.request(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: textToAdf(body) }),
    });
  }

  /**
   * Assign or unassign a Jira issue
   * @param {string} issueKey
   * @param {string|null} accountId Pass null to unassign
   */
  async assignIssue(issueKey, accountId) {
    const key = String(issueKey || '').trim().toUpperCase();
    if (!key) throw new Error('issueKey is required');

    await this.request(`/rest/api/3/issue/${encodeURIComponent(key)}/assignee`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: accountId ?? null }),
    });
  }

  /**
   * Create an issue link between two issues
   * @param {{ inwardIssueKey: string, outwardIssueKey: string, linkType?: string, comment?: string }} params
   */
  async linkIssues(params) {
    const inward = String(params.inwardIssueKey || '').trim().toUpperCase();
    const outward = String(params.outwardIssueKey || '').trim().toUpperCase();
    if (!inward || !outward) throw new Error('Both inwardIssueKey and outwardIssueKey are required');

    const payload = {
      type: { name: params.linkType || 'Relates' },
      inwardIssue: { key: inward },
      outwardIssue: { key: outward },
    };
    if (params.comment) {
      payload.comment = { body: textToAdf(params.comment) };
    }

    await this.request('/rest/api/3/issueLink', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  /**
   * Log time spent on an issue
   * @param {string} issueKey
   * @param {{ timeSpent: string, comment?: string, started?: string }} params
   */
  async addWorklog(issueKey, params) {
    const key = String(issueKey || '').trim().toUpperCase();
    if (!key) throw new Error('issueKey is required');
    if (!params?.timeSpent || !String(params.timeSpent).trim()) {
      throw new Error('timeSpent is required (e.g. "2h 30m")');
    }

    const payload = {
      timeSpent: String(params.timeSpent).trim(),
    };
    if (params.comment) {
      payload.comment = textToAdf(params.comment);
    }
    if (params.started) {
      payload.started = params.started;
    }

    return this.request(`/rest/api/3/issue/${encodeURIComponent(key)}/worklog`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }
}
