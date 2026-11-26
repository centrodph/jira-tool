import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { JiraClient, textToAdf } from '../src/jiraClient.js';
import { createJiraMcpServer } from '../src/mcp/jiraMcp.js';
import {
  buildHttpServerEntry,
  buildStdioServerEntry,
  mergeMcpConfig,
  parseArgs,
  removeMcpConfig,
  resolveTargets,
} from '../scripts/install-mcp.js';

describe('textToAdf', () => {
  test('converts headings, bullet lists, inline formatting, and code blocks into valid ADF v1', () => {
    const adf = textToAdf([
      '## Summary',
      'Check **auth** with `token`',
      '',
      '- Item 1',
      '- Item 2',
      '',
      '```js',
      'console.log(1);',
      '```',
    ].join('\n'));

    assert.equal(adf.type, 'doc');
    assert.equal(adf.version, 1);
    assert.equal(adf.content[0].type, 'heading');
    assert.equal(adf.content[0].attrs.level, 2);
    assert.equal(adf.content[1].type, 'paragraph');
    assert.ok(adf.content[1].content.some((n) => n.text === 'auth' && n.marks?.[0]?.type === 'strong'));
    assert.ok(adf.content[1].content.some((n) => n.text === 'token' && n.marks?.[0]?.type === 'code'));
    assert.equal(adf.content[2].type, 'bulletList');
    assert.equal(adf.content[2].content.length, 2);
    assert.equal(adf.content[3].type, 'codeBlock');
    assert.equal(adf.content[3].attrs.language, 'js');
  });

  test('passes through an existing ADF doc untouched', () => {
    const existing = { version: 1, type: 'doc', content: [] };
    assert.strictEqual(textToAdf(existing), existing);
  });
});

describe('JiraClient action methods', () => {
  test('handles 204 No Content responses cleanly on update, assign, transition, and link', async () => {
    const requests = [];
    const client = new JiraClient({
      baseUrl: 'https://example.atlassian.net',
      authHeader: 'Basic test',
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      requests.push({ url: String(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
      return {
        ok: true,
        status: 204,
        statusText: 'No Content',
        async text() {
          return '';
        },
      };
    };

    try {
      await client.updateIssue('cs-10', { summary: 'New Title', priority: 'High' }, { labels: [{ add: 'backend' }] });
      await client.assignIssue('cs-10', 'acc-123');
      await client.transitionIssue('cs-10', '31', { comment: 'Moving to QA' });
      await client.linkIssues({ inwardIssueKey: 'cs-10', outwardIssueKey: 'cs-11', linkType: 'Blocks' });
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(requests.length, 4);
    assert.equal(requests[0].method, 'PUT');
    assert.match(requests[0].url, /\/rest\/api\/3\/issue\/CS-10$/);
    assert.equal(requests[0].body.fields.summary, 'New Title');
    assert.deepEqual(requests[0].body.update.labels, [{ add: 'backend' }]);

    assert.equal(requests[1].method, 'PUT');
    assert.match(requests[1].url, /\/rest\/api\/3\/issue\/CS-10\/assignee$/);
    assert.deepEqual(requests[1].body, { accountId: 'acc-123' });

    assert.equal(requests[2].method, 'POST');
    assert.match(requests[2].url, /\/rest\/api\/3\/issue\/CS-10\/transitions$/);
    assert.equal(requests[2].body.transition.id, '31');
    assert.equal(requests[2].body.update.comment[0].add.body.type, 'doc');

    assert.equal(requests[3].method, 'POST');
    assert.match(requests[3].url, /\/rest\/api\/3\/issueLink$/);
    assert.equal(requests[3].body.type.name, 'Blocks');
  });
});

describe('Jira MCP Server protocol integration', () => {
  async function setupConnectedPair(mockJiraClient) {
    const server = createJiraMcpServer({
      jiraClient: mockJiraClient,
      config: { baseUrl: 'https://example.atlassian.net', outputDir: '/tmp/jira-mcp-test' },
    });
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return { server, client };
  }

  test('lists all Jira MCP tools and executes read & write actions cleanly', async () => {
    const calls = [];
    const mockJiraClient = {
      baseUrl: 'https://example.atlassian.net',
      async getMyself() {
        return { accountId: 'acc-me', displayName: 'Jane Doe', emailAddress: 'jane@example.com', active: true };
      },
      async searchIssues(jql, maxResults) {
        calls.push({ op: 'searchIssues', jql, maxResults });
        return [
          {
            key: 'CS-101',
            fields: {
              summary: 'Test ticket',
              status: { name: 'In Progress' },
              issuetype: { name: 'Task' },
              priority: { name: 'High' },
              assignee: { displayName: 'Jane Doe' },
            },
          },
        ];
      },
      async createIssue(params) {
        calls.push({ op: 'createIssue', params });
        return { id: '10001', key: 'CS-200' };
      },
      async getTransitions(key) {
        calls.push({ op: 'getTransitions', key });
        return [
          { id: '21', name: 'Start Progress', to: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } },
          { id: '31', name: 'Complete', to: { name: 'Done', statusCategory: { key: 'done' } } },
        ];
      },
      async transitionIssue(key, transitionId, options) {
        calls.push({ op: 'transitionIssue', key, transitionId, options });
      },
      async addComment(key, body) {
        calls.push({ op: 'addComment', key, body });
        return { id: '555', created: '2026-11-20T12:00:00Z' };
      },
      async searchUsers(query) {
        calls.push({ op: 'searchUsers', query });
        return [{ accountId: 'acc-bob', displayName: 'Bob Smith', emailAddress: 'bob@example.com' }];
      },
      async assignIssue(key, accountId) {
        calls.push({ op: 'assignIssue', key, accountId });
      },
      async addWorklog(key, params) {
        calls.push({ op: 'addWorklog', key, params });
        return { id: 'wl-1', timeSpent: params.timeSpent };
      },
    };

    const { server, client } = await setupConnectedPair(mockJiraClient);
    try {
      const listed = await client.listTools();
      const toolNames = listed.tools.map((t) => t.name);
      assert.ok(toolNames.includes('jira_whoami'));
      assert.ok(toolNames.includes('jira_get_issue'));
      assert.ok(toolNames.includes('jira_search_issues'));
      assert.ok(toolNames.includes('jira_create_issue'));
      assert.ok(toolNames.includes('jira_update_issue'));
      assert.ok(toolNames.includes('jira_transition_issue'));
      assert.ok(toolNames.includes('jira_add_comment'));
      assert.ok(toolNames.includes('jira_assign_issue'));
      assert.ok(toolNames.includes('jira_link_issues'));
      assert.ok(toolNames.includes('jira_log_work'));
      assert.equal(toolNames.length, 16);

      // jira_whoami
      const whoami = await client.callTool({ name: 'jira_whoami', arguments: {} });
      const whoamiData = JSON.parse(whoami.content[0].text);
      assert.equal(whoamiData.displayName, 'Jane Doe');

      // jira_create_issue
      const created = await client.callTool({
        name: 'jira_create_issue',
        arguments: {
          projectKey: 'CS',
          issueType: 'Story',
          summary: 'Expose Jira MCP',
          description: 'Installable on Cursor and AGY',
        },
      });
      const createdData = JSON.parse(created.content[0].text);
      assert.equal(createdData.key, 'CS-200');
      assert.equal(createdData.url, 'https://example.atlassian.net/browse/CS-200');

      // jira_transition_issue by statusName (resolves transition id automatically)
      const transitioned = await client.callTool({
        name: 'jira_transition_issue',
        arguments: { issueKey: 'CS-200', statusName: 'Done', comment: 'Shipped!' },
      });
      const transitionedData = JSON.parse(transitioned.content[0].text);
      assert.equal(transitionedData.transitionId, '31');
      assert.equal(transitionedData.toStatus, 'Done');

      // jira_assign_issue by userQuery
      const assigned = await client.callTool({
        name: 'jira_assign_issue',
        arguments: { issueKey: 'CS-200', userQuery: 'bob@example.com' },
      });
      const assignedData = JSON.parse(assigned.content[0].text);
      assert.equal(assignedData.accountId, 'acc-bob');

      // jira_add_comment
      const commented = await client.callTool({
        name: 'jira_add_comment',
        arguments: { issueKey: 'CS-200', body: 'Verified on staging' },
      });
      assert.equal(JSON.parse(commented.content[0].text).commentId, '555');

      // jira_log_work
      const logged = await client.callTool({
        name: 'jira_log_work',
        arguments: { issueKey: 'CS-200', timeSpent: '1h 30m', comment: 'MCP setup' },
      });
      assert.equal(JSON.parse(logged.content[0].text).worklogId, 'wl-1');

      // Error handling returns structured MCP tool error instead of throwing
      const badTransition = await client.callTool({
        name: 'jira_transition_issue',
        arguments: { issueKey: 'CS-200', statusName: 'NonExistentStatus' },
      });
      assert.equal(badTransition.isError, true);
      assert.match(badTransition.content[0].text, /No transition matching/);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('MCP Installer for Cursor & AGY', () => {
  test('merges and removes server config while preserving existing MCP servers', () => {
    const existing = {
      mcpServers: {
        atlassian: { type: 'http', url: 'https://mcp.atlassian.com/v1/mcp/authv2' },
      },
    };

    const stdioEntry = buildStdioServerEntry({
      projectRoot: '/workspace/toolJira',
      nodePath: '/usr/local/bin/node',
    });
    assert.deepEqual(stdioEntry, {
      command: '/usr/local/bin/node',
      args: ['/workspace/toolJira/src/mcpServer.js'],
    });

    const merged = mergeMcpConfig(existing, 'tool-jira', stdioEntry);
    assert.ok(merged.mcpServers.atlassian);
    assert.deepEqual(merged.mcpServers['tool-jira'], stdioEntry);

    const { config: afterRemove, removed } = removeMcpConfig(merged, 'tool-jira');
    assert.equal(removed, true);
    assert.ok(afterRemove.mcpServers.atlassian);
    assert.equal(afterRemove.mcpServers['tool-jira'], undefined);
  });

  test('builds HTTP entry and resolves Cursor and AGY config paths', () => {
    assert.deepEqual(buildHttpServerEntry({ url: 'http://localhost:3099/mcp' }), {
      url: 'http://localhost:3099/mcp',
    });

    const flags = parseArgs(['--all']);
    const targets = resolveTargets({ ...flags, homeDir: '/Users/dev' });
    assert.deepEqual(
      targets.map((t) => t.path),
      [
        '/Users/dev/.cursor/mcp.json',
        '/Users/dev/.gemini/config/mcp_config.json',
      ],
    );
  });
});
