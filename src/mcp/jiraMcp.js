import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { getConfig } from '../config.js';
import { JiraClient } from '../jiraClient.js';
import { adfToMarkdown, formatIssueToMarkdown } from '../markdownFormatter.js';
import { saveIssueToMarkdownFile } from '../fileWriter.js';

/**
 * Wraps a tool handler so errors are returned as structured MCP tool error results
 * instead of crashing the server process.
 * @param {Function} handler
 */
function safeTool(handler) {
  return async (args, extra) => {
    try {
      return await handler(args, extra);
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Error: ${error?.message || String(error)}`,
          },
        ],
      };
    }
  };
}

/**
 * Formats an object as a readable JSON text content block.
 * @param {unknown} data
 */
function jsonResult(data) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

/**
 * Formats plain text or markdown as an MCP text content block.
 * @param {string} text
 */
function textResult(text) {
  return {
    content: [
      {
        type: 'text',
        text,
      },
    ],
  };
}

/**
 * Creates a configured Jira MCP server exposing read and write Jira actions.
 * Credentials are resolved lazily per call so `tools/list` always succeeds even before `.env` is filled in.
 *
 * @param {{ jiraClient?: JiraClient, config?: object }} [dependencies]
 * @returns {McpServer}
 */
export function createJiraMcpServer(dependencies = {}) {
  const server = new McpServer({
    name: 'tool-jira',
    version: '1.0.0',
  });

  function resolveRuntime() {
    if (dependencies.jiraClient) {
      const cfg = dependencies.config || {
        baseUrl: dependencies.jiraClient.baseUrl || '',
        outputDir: './tickets',
      };
      return { client: dependencies.jiraClient, config: cfg };
    }
    const config = dependencies.config || getConfig();
    const client = new JiraClient(config);
    return { client, config };
  }

  // 1. Verify connection / current user
  server.registerTool(
    'jira_whoami',
    {
      title: 'Jira Current User',
      description: 'Verify Jira credentials and return the authenticated user profile (accountId, displayName, emailAddress).',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safeTool(async () => {
      const { client, config } = resolveRuntime();
      const me = await client.getMyself();
      return jsonResult({
        baseUrl: config.baseUrl,
        accountId: me?.accountId || null,
        displayName: me?.displayName || null,
        emailAddress: me?.emailAddress || null,
        active: me?.active ?? null,
        timeZone: me?.timeZone || null,
      });
    }),
  );

  // 2. Get issue details
  server.registerTool(
    'jira_get_issue',
    {
      title: 'Get Jira Issue',
      description: 'Fetch full details of a Jira issue by key (e.g. CS-123), including description, status, assignee, subtasks, linked issues, attachments, and comments.',
      inputSchema: {
        issueKey: z.string().min(1).describe('Jira issue key, e.g. CS-123 or SCRP-37000'),
        format: z.enum(['markdown', 'json']).default('markdown').describe('Return formatted Markdown (default) or compact structured JSON'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safeTool(async ({ issueKey, format }) => {
      const { client, config } = resolveRuntime();
      const issue = await client.fetchIssue(issueKey);
      if (format === 'json') {
        const f = issue.fields || {};
        return jsonResult({
          key: issue.key,
          id: issue.id,
          url: `${config.baseUrl}/browse/${issue.key}`,
          summary: f.summary || '',
          issueType: f.issuetype?.name || null,
          status: f.status?.name || null,
          statusCategory: f.status?.statusCategory?.key || null,
          priority: f.priority?.name || null,
          resolution: f.resolution?.name || null,
          assignee: f.assignee ? { accountId: f.assignee.accountId, displayName: f.assignee.displayName, emailAddress: f.assignee.emailAddress } : null,
          reporter: f.reporter ? { accountId: f.reporter.accountId, displayName: f.reporter.displayName } : null,
          labels: f.labels || [],
          components: (f.components || []).map((c) => c.name),
          parent: f.parent ? { key: f.parent.key, summary: f.parent.fields?.summary || '' } : null,
          created: f.created || null,
          updated: f.updated || null,
          description: typeof f.description === 'string' ? f.description : adfToMarkdown(f.description),
          subtasks: (f.subtasks || []).map((st) => ({
            key: st.key,
            summary: st.fields?.summary || '',
            status: st.fields?.status?.name || '',
          })),
          commentsCount: f.comment?.total ?? (f.comment?.comments?.length || 0),
        });
      }
      const markdown = formatIssueToMarkdown(issue, config.baseUrl);
      return textResult(markdown);
    }),
  );

  // 3. Search issues via JQL
  server.registerTool(
    'jira_search_issues',
    {
      title: 'Search Jira Issues (JQL)',
      description: 'Search Jira issues using a JQL query (e.g. "project = CS AND status != Done ORDER BY updated DESC").',
      inputSchema: {
        jql: z.string().min(1).describe('Valid Jira Query Language (JQL) string'),
        maxResults: z.number().int().min(1).max(100).default(25).describe('Maximum number of issues to return (1-100)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safeTool(async ({ jql, maxResults }) => {
      const { client, config } = resolveRuntime();
      const issues = await client.searchIssues(jql, maxResults);
      const summaryRows = issues.map((issue) => ({
        key: issue.key,
        summary: issue.fields?.summary || '',
        status: issue.fields?.status?.name || '',
        issueType: issue.fields?.issuetype?.name || '',
        priority: issue.fields?.priority?.name || '',
        assignee: issue.fields?.assignee?.displayName || 'Unassigned',
        url: `${config.baseUrl}/browse/${issue.key}`,
      }));
      return jsonResult({
        jql,
        totalReturned: summaryRows.length,
        issues: summaryRows,
      });
    }),
  );

  // 4. List projects
  server.registerTool(
    'jira_list_projects',
    {
      title: 'List Jira Projects',
      description: 'List accessible Jira projects (key, name, projectTypeKey) to discover valid project keys before creating or searching issues.',
      inputSchema: {
        query: z.string().optional().describe('Optional filter string matching project name or key'),
        maxResults: z.number().int().min(1).max(100).default(50).describe('Maximum number of projects to return'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safeTool(async ({ query, maxResults }) => {
      const { client } = resolveRuntime();
      const projects = await client.listProjects({ query, maxResults });
      return jsonResult({
        totalReturned: projects.length,
        projects: projects.map((p) => ({
          id: p.id,
          key: p.key,
          name: p.name,
          projectTypeKey: p.projectTypeKey || null,
          style: p.style || null,
        })),
      });
    }),
  );

  // 5. Get project issue types
  server.registerTool(
    'jira_get_project_issue_types',
    {
      title: 'Get Project Issue Types',
      description: 'List valid issue types (e.g. Story, Bug, Task, Sub-task) for a given Jira project key.',
      inputSchema: {
        projectKey: z.string().min(1).describe('Jira project key, e.g. CS or SCRP'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safeTool(async ({ projectKey }) => {
      const { client } = resolveRuntime();
      const issueTypes = await client.getProjectIssueTypes(projectKey);
      return jsonResult({
        projectKey: projectKey.trim().toUpperCase(),
        issueTypes: issueTypes.map((t) => ({
          id: t.id,
          name: t.name,
          subtask: Boolean(t.subtask),
          description: t.description || '',
        })),
      });
    }),
  );

  // 6. Search users
  server.registerTool(
    'jira_search_users',
    {
      title: 'Search Jira Users',
      description: 'Search Jira users by display name or email address to find their accountId for assigning issues or building JQL queries.',
      inputSchema: {
        query: z.string().min(1).describe('User name or email search query'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safeTool(async ({ query }) => {
      const { client } = resolveRuntime();
      const users = await client.searchUsers(query);
      return jsonResult({
        query,
        totalReturned: users.length,
        users: users.map((u) => ({
          accountId: u.accountId,
          displayName: u.displayName || '',
          emailAddress: u.emailAddress || '',
          active: u.active ?? true,
        })),
      });
    }),
  );

  // 7. Get available workflow transitions
  server.registerTool(
    'jira_get_transitions',
    {
      title: 'Get Issue Transitions',
      description: 'List all available workflow transitions (IDs and target status names) for a Jira issue.',
      inputSchema: {
        issueKey: z.string().min(1).describe('Jira issue key, e.g. CS-123'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safeTool(async ({ issueKey }) => {
      const { client } = resolveRuntime();
      const transitions = await client.getTransitions(issueKey);
      return jsonResult({
        issueKey: issueKey.trim().toUpperCase(),
        transitions: transitions.map((t) => ({
          id: t.id,
          name: t.name,
          toStatus: t.to?.name || '',
          toCategory: t.to?.statusCategory?.key || '',
        })),
      });
    }),
  );

  // 8. Get comments on an issue
  server.registerTool(
    'jira_get_comments',
    {
      title: 'Get Issue Comments',
      description: 'Fetch comments on a Jira issue in readable Markdown format.',
      inputSchema: {
        issueKey: z.string().min(1).describe('Jira issue key, e.g. CS-123'),
        maxResults: z.number().int().min(1).max(100).default(50).describe('Maximum comments to return'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safeTool(async ({ issueKey, maxResults }) => {
      const { client } = resolveRuntime();
      const data = await client.getComments(issueKey, { maxResults });
      const comments = (data.comments || []).map((c) => ({
        id: c.id,
        author: c.author?.displayName || 'Unknown',
        created: c.created || '',
        updated: c.updated || '',
        body: typeof c.body === 'string' ? c.body : adfToMarkdown(c.body),
      }));
      return jsonResult({
        issueKey: issueKey.trim().toUpperCase(),
        total: data.total ?? comments.length,
        comments,
      });
    }),
  );

  // 9. Create issue
  server.registerTool(
    'jira_create_issue',
    {
      title: 'Create Jira Issue',
      description: 'Create a new Jira issue (Task, Story, Bug, Sub-task, etc.) in a project. Description accepts plain text or basic Markdown and is automatically converted to ADF.',
      inputSchema: {
        projectKey: z.string().min(1).describe('Jira project key, e.g. CS'),
        issueType: z.string().min(1).default('Task').describe('Issue type name, e.g. Task, Story, Bug, Sub-task'),
        summary: z.string().min(1).describe('Short issue title / summary'),
        description: z.string().optional().describe('Issue description in plain text or Markdown'),
        priority: z.string().optional().describe('Priority name, e.g. Highest, High, Medium, Low, Lowest'),
        labels: z.array(z.string()).optional().describe('Array of labels to attach'),
        assigneeAccountId: z.string().optional().describe('Atlassian accountId of the assignee (use jira_search_users to find it)'),
        parentKey: z.string().optional().describe('Parent issue or Epic key (e.g. CS-100) for subtasks or child stories'),
        components: z.array(z.string()).optional().describe('Component names to assign'),
        additionalFields: z.record(z.string(), z.unknown()).optional().describe('Optional raw Jira custom fields object (e.g. {"customfield_10016": 3})'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    safeTool(async (params) => {
      const { client, config } = resolveRuntime();
      const created = await client.createIssue(params);
      return jsonResult({
        created: true,
        id: created.id,
        key: created.key,
        url: `${config.baseUrl}/browse/${created.key}`,
      });
    }),
  );

  // 10. Update issue
  server.registerTool(
    'jira_update_issue',
    {
      title: 'Update Jira Issue',
      description: 'Update fields on an existing Jira issue (summary, description, priority, labels, assignee, parent, components, or custom fields).',
      inputSchema: {
        issueKey: z.string().min(1).describe('Jira issue key, e.g. CS-123'),
        summary: z.string().optional().describe('New summary / title'),
        description: z.string().optional().describe('New description (plain text or Markdown, converted to ADF)'),
        priority: z.string().optional().describe('New priority name, e.g. High, Medium, Low'),
        labels: z.array(z.string()).optional().describe('Replace all labels with this list'),
        addLabels: z.array(z.string()).optional().describe('Add these labels without removing existing ones'),
        removeLabels: z.array(z.string()).optional().describe('Remove specific labels'),
        assigneeAccountId: z.string().nullable().optional().describe('Assignee accountId, or null to unassign'),
        parentKey: z.string().optional().describe('New parent / Epic key'),
        components: z.array(z.string()).optional().describe('Replace components with these component names'),
        additionalFields: z.record(z.string(), z.unknown()).optional().describe('Additional raw Jira fields / custom fields'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safeTool(async ({ issueKey, addLabels, removeLabels, ...fieldOptions }) => {
      const { client, config } = resolveRuntime();
      const updateOps = {};
      if ((addLabels && addLabels.length > 0) || (removeLabels && removeLabels.length > 0)) {
        updateOps.labels = [
          ...(addLabels || []).map((label) => ({ add: label })),
          ...(removeLabels || []).map((label) => ({ remove: label })),
        ];
      }

      const key = issueKey.trim().toUpperCase();
      await client.updateIssue(key, fieldOptions, Object.keys(updateOps).length > 0 ? updateOps : undefined);
      return jsonResult({
        updated: true,
        key,
        url: `${config.baseUrl}/browse/${key}`,
      });
    }),
  );

  // 11. Transition issue status
  server.registerTool(
    'jira_transition_issue',
    {
      title: 'Transition Jira Issue Status',
      description: 'Move a Jira issue to another workflow status using either a transitionId OR a target status/transition name (e.g. "In Progress", "Done", "Ready for QA"). Optionally posts a comment.',
      inputSchema: {
        issueKey: z.string().min(1).describe('Jira issue key, e.g. CS-123'),
        transitionId: z.string().optional().describe('Exact transition ID (from jira_get_transitions)'),
        statusName: z.string().optional().describe('Target status name or transition name (case-insensitive, e.g. "In Progress", "Done")'),
        comment: z.string().optional().describe('Optional comment to post with the transition'),
        resolution: z.string().optional().describe('Optional resolution name (e.g. "Done", "Won\'t Do") if required by the transition screen'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    safeTool(async ({ issueKey, transitionId, statusName, comment, resolution }) => {
      const { client, config } = resolveRuntime();
      const key = issueKey.trim().toUpperCase();
      if (!transitionId && !statusName) {
        throw new Error('Provide either transitionId or statusName.');
      }

      let resolvedTransitionId = transitionId;
      let matchedTransition = null;

      if (!resolvedTransitionId) {
        const transitions = await client.getTransitions(key);
        const target = statusName.trim().toLowerCase();
        matchedTransition =
          transitions.find((t) => (t.to?.name || '').toLowerCase() === target)
          || transitions.find((t) => (t.name || '').toLowerCase() === target)
          || transitions.find((t) => (t.to?.name || '').toLowerCase().includes(target) || (t.name || '').toLowerCase().includes(target));

        if (!matchedTransition) {
          const available = transitions.map((t) => `"${t.name}" -> "${t.to?.name || ''}" (id: ${t.id})`).join(', ');
          throw new Error(`No transition matching "${statusName}" found for ${key}. Available transitions: ${available || 'none'}`);
        }
        resolvedTransitionId = matchedTransition.id;
      }

      await client.transitionIssue(key, resolvedTransitionId, { comment, resolution });
      return jsonResult({
        transitioned: true,
        key,
        transitionId: resolvedTransitionId,
        transitionName: matchedTransition?.name || null,
        toStatus: matchedTransition?.to?.name || null,
        url: `${config.baseUrl}/browse/${key}`,
      });
    }),
  );

  // 12. Add comment
  server.registerTool(
    'jira_add_comment',
    {
      title: 'Add Jira Comment',
      description: 'Add a comment to a Jira issue. Accepts plain text or basic Markdown (converted to ADF automatically).',
      inputSchema: {
        issueKey: z.string().min(1).describe('Jira issue key, e.g. CS-123'),
        body: z.string().min(1).describe('Comment content in plain text or Markdown'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    safeTool(async ({ issueKey, body }) => {
      const { client, config } = resolveRuntime();
      const key = issueKey.trim().toUpperCase();
      const comment = await client.addComment(key, body);
      return jsonResult({
        added: true,
        key,
        commentId: comment?.id || null,
        created: comment?.created || null,
        url: `${config.baseUrl}/browse/${key}`,
      });
    }),
  );

  // 13. Assign issue
  server.registerTool(
    'jira_assign_issue',
    {
      title: 'Assign Jira Issue',
      description: 'Assign a Jira issue by accountId, by searching a user name/email, or unassign by passing unassign=true.',
      inputSchema: {
        issueKey: z.string().min(1).describe('Jira issue key, e.g. CS-123'),
        accountId: z.string().optional().describe('Exact Atlassian accountId'),
        userQuery: z.string().optional().describe('User email or display name to resolve automatically if accountId is unknown'),
        unassign: z.boolean().default(false).describe('Set to true to unassign the issue'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safeTool(async ({ issueKey, accountId, userQuery, unassign }) => {
      const { client, config } = resolveRuntime();
      const key = issueKey.trim().toUpperCase();

      if (unassign) {
        await client.assignIssue(key, null);
        return jsonResult({ assigned: true, key, assignee: null, url: `${config.baseUrl}/browse/${key}` });
      }

      let targetAccountId = accountId;
      let resolvedDisplayName = null;

      if (!targetAccountId) {
        if (!userQuery) {
          throw new Error('Provide accountId, userQuery, or set unassign=true.');
        }
        const matches = await client.searchUsers(userQuery);
        if (matches.length === 0) {
          throw new Error(`No Jira user found matching "${userQuery}".`);
        }
        const normalized = userQuery.trim().toLowerCase();
        const exact = matches.find(
          (u) => (u.emailAddress || '').toLowerCase() === normalized || (u.displayName || '').toLowerCase() === normalized,
        );
        const chosen = exact || matches[0];
        targetAccountId = chosen.accountId;
        resolvedDisplayName = chosen.displayName || chosen.emailAddress || targetAccountId;
      }

      await client.assignIssue(key, targetAccountId);
      return jsonResult({
        assigned: true,
        key,
        accountId: targetAccountId,
        displayName: resolvedDisplayName,
        url: `${config.baseUrl}/browse/${key}`,
      });
    }),
  );

  // 14. Link two issues
  server.registerTool(
    'jira_link_issues',
    {
      title: 'Link Jira Issues',
      description: 'Create a relationship link between two Jira issues (e.g. "Relates", "Blocks", "Duplicate").',
      inputSchema: {
        inwardIssueKey: z.string().min(1).describe('Inward issue key (e.g. CS-101)'),
        outwardIssueKey: z.string().min(1).describe('Outward issue key (e.g. CS-102)'),
        linkType: z.string().default('Relates').describe('Issue link type name (e.g. Relates, Blocks, Duplicate, Cloners)'),
        comment: z.string().optional().describe('Optional comment to attach to the link'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    safeTool(async ({ inwardIssueKey, outwardIssueKey, linkType, comment }) => {
      const { client } = resolveRuntime();
      const inward = inwardIssueKey.trim().toUpperCase();
      const outward = outwardIssueKey.trim().toUpperCase();
      await client.linkIssues({
        inwardIssueKey: inward,
        outwardIssueKey: outward,
        linkType,
        comment,
      });
      return jsonResult({
        linked: true,
        inwardIssueKey: inward,
        outwardIssueKey: outward,
        linkType,
      });
    }),
  );

  // 15. Log work
  server.registerTool(
    'jira_log_work',
    {
      title: 'Log Work on Jira Issue',
      description: 'Log time spent (worklog) on a Jira issue (e.g. "2h 30m", "1d", "45m").',
      inputSchema: {
        issueKey: z.string().min(1).describe('Jira issue key, e.g. CS-123'),
        timeSpent: z.string().min(1).describe('Jira duration string, e.g. "1h 30m", "45m", "1d"'),
        comment: z.string().optional().describe('Optional work description'),
        started: z.string().optional().describe('Optional ISO timestamp when work started (defaults to now)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    safeTool(async ({ issueKey, timeSpent, comment, started }) => {
      const { client } = resolveRuntime();
      const key = issueKey.trim().toUpperCase();
      const worklog = await client.addWorklog(key, { timeSpent, comment, started });
      return jsonResult({
        logged: true,
        key,
        worklogId: worklog?.id || null,
        timeSpent: worklog?.timeSpent || timeSpent,
      });
    }),
  );

  // 16. Export issue to local Markdown file
  server.registerTool(
    'jira_export_issue_markdown',
    {
      title: 'Export Jira Issue to Markdown File',
      description: 'Fetch a Jira issue and save it as a local Markdown file (with optional attachment downloads) in the configured tickets directory.',
      inputSchema: {
        issueKey: z.string().min(1).describe('Jira issue key, e.g. CS-123'),
        outputDir: z.string().optional().describe('Optional output directory (defaults to configured OUTPUT_PATH)'),
        downloadAttachments: z.boolean().default(false).describe('Whether to download issue attachments locally'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    safeTool(async ({ issueKey, outputDir, downloadAttachments }) => {
      const { client, config } = resolveRuntime();
      const issue = await client.fetchIssue(issueKey);
      const markdown = formatIssueToMarkdown(issue, config.baseUrl);
      const saved = await saveIssueToMarkdownFile(issue, markdown, {
        outputDir: outputDir || config.outputDir,
        downloadAttachments,
        jiraClient: client,
      });
      return jsonResult({
        exported: true,
        ...saved,
      });
    }),
  );

  return server;
}

/**
 * Registers a stateless Streamable HTTP MCP endpoint (`/mcp`) on an Express app.
 * Allows Cursor, Antigravity, or any MCP HTTP client to connect via `http://localhost:<PORT>/mcp`.
 * @param {import('express').Express} app
 * @param {{ jiraClient?: JiraClient, config?: object }} [dependencies]
 */
export function registerJiraMcpHttpRoute(app, dependencies = {}) {
  app.post('/mcp', async (req, res) => {
    const server = createJiraMcpServer(dependencies);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: error?.message || 'Internal MCP server error' },
          id: null,
        });
      }
    }
  });

  app.get('/mcp', (req, res) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed. Use POST /mcp for stateless Streamable HTTP MCP requests.' },
      id: null,
    });
  });

  app.delete('/mcp', (req, res) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed.' },
      id: null,
    });
  });
}
