import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  isStatusInProgress,
  isStatusQA,
  isStatusDone,
  categorizeIssueType,
  calculateInProgressDuration,
  detectQaBounces,
  formatDuration,
  TeamReportService,
} from '../src/teamReportService.js';
import { JiraClient } from '../src/jiraClient.js';
import { buildAuthorIdentityKeys } from '../src/watchedUsers.js';
import { renderReportsPage } from '../src/views/reportsPage.js';

describe('Team Report Status & Duration Helpers', () => {
  test('isStatusInProgress identifies in progress and development statuses', () => {
    assert.equal(isStatusInProgress('In Progress'), true);
    assert.equal(isStatusInProgress('In Development'), true);
    assert.equal(isStatusInProgress('En Progreso'), true);
    assert.equal(isStatusInProgress('Dev'), true);
    assert.equal(isStatusInProgress('Doing'), true);
    assert.equal(isStatusInProgress('Custom Status', 'indeterminate'), true);
    assert.equal(isStatusInProgress('Blocked', 'indeterminate'), false);
    assert.equal(isStatusInProgress('QA', 'indeterminate'), false);
    assert.equal(isStatusInProgress('To Do'), false);
    assert.equal(isStatusInProgress('Done'), false);
  });

  test('isStatusQA identifies QA, testing and review statuses', () => {
    assert.equal(isStatusQA('QA'), true);
    assert.equal(isStatusQA('In QA'), true);
    assert.equal(isStatusQA('Testing'), true);
    assert.equal(isStatusQA('Ready for QA'), true);
    assert.equal(isStatusQA('En pruebas'), true);
    assert.equal(isStatusQA('Code Review'), true);
    assert.equal(isStatusQA('In Progress'), false);
    assert.equal(isStatusQA('To Do'), false);
  });

  test('isStatusDone identifies completed and resolved statuses', () => {
    assert.equal(isStatusDone('Done'), true);
    assert.equal(isStatusDone('Resolved'), true);
    assert.equal(isStatusDone('Closed'), true);
    assert.equal(isStatusDone('Completado'), true);
    assert.equal(isStatusDone('Custom Complete', 'done'), true);
    assert.equal(isStatusDone('In Progress'), false);
  });

  test('categorizeIssueType identifies stories, bugs, and tasks', () => {
    assert.equal(categorizeIssueType('Story'), 'story');
    assert.equal(categorizeIssueType('Historia de usuario'), 'story');
    assert.equal(categorizeIssueType('Bug'), 'bug');
    assert.equal(categorizeIssueType('Defect'), 'bug');
    assert.equal(categorizeIssueType('Task'), 'task');
    assert.equal(categorizeIssueType('Sub-task'), 'task');
    assert.equal(categorizeIssueType('Epic'), 'other');
  });

  test('calculateInProgressDuration calculates multiple segments and formats time', () => {
    const t0 = Date.parse('2026-11-01T10:00:00Z');
    const t1 = Date.parse('2026-11-01T14:00:00Z'); // 4 hours in dev
    const t2 = Date.parse('2026-11-02T10:00:00Z'); // moved to QA
    const t3 = Date.parse('2026-11-02T12:00:00Z'); // bounced back to In Progress
    const t4 = Date.parse('2026-11-02T16:00:00Z'); // 4 hours in dev -> moved to Done

    const changelog = {
      histories: [
        {
          created: '2026-11-01T10:00:00Z',
          items: [{ field: 'status', fromString: 'To Do', toString: 'In Progress' }],
        },
        {
          created: '2026-11-01T14:00:00Z',
          items: [{ field: 'status', fromString: 'In Progress', toString: 'QA' }],
        },
        {
          created: '2026-11-02T12:00:00Z',
          items: [{ field: 'status', fromString: 'QA', toString: 'In Progress' }],
        },
        {
          created: '2026-11-02T16:00:00Z',
          items: [{ field: 'status', fromString: 'In Progress', toString: 'Done' }],
        },
      ],
    };

    const res = calculateInProgressDuration(changelog, '2026-11-01T09:00:00Z', 'Done');
    // Segment 1: 4 hours (10:00 to 14:00). Segment 2: 4 hours (12:00 to 16:00). Total: 8 hours.
    assert.equal(res.inProgressHours, 8);
    assert.equal(res.inProgressFormatted, '8.0 h');
  });

  test('detectQaBounces detects transitions from QA back to In Progress', () => {
    const changelog = {
      histories: [
        {
          created: '2026-11-01T10:00:00Z',
          items: [{ field: 'status', fromString: 'To Do', toString: 'In Progress' }],
        },
        {
          created: '2026-11-01T14:00:00Z',
          items: [{ field: 'status', fromString: 'In Progress', toString: 'Ready for QA' }],
        },
        {
          created: '2026-11-02T10:00:00Z',
          author: { displayName: 'QA Tester' },
          items: [{ field: 'status', fromString: 'QA', toString: 'In Progress' }], // Bounce 1!
        },
        {
          created: '2026-11-03T10:00:00Z',
          items: [{ field: 'status', fromString: 'In Progress', toString: 'Done' }], // Normal forward
        },
      ],
    };

    const res = detectQaBounces(changelog);
    assert.equal(res.qaBounces, 1);
    assert.equal(res.transitions[0].from, 'QA');
    assert.equal(res.transitions[0].to, 'In Progress');
    assert.equal(res.transitions[0].author, 'QA Tester');
  });

  test('formatDuration formats hours, days, and minutes cleanly', () => {
    assert.equal(formatDuration(0), '0 h');
    assert.equal(formatDuration(0.5), '30 m');
    assert.equal(formatDuration(8), '8.0 h');
    assert.equal(formatDuration(48), '2.0 d (48 h)');
  });
});

describe('TeamReportService static report generation and management', () => {
  let tmpReportsDir;

  before(async () => {
    tmpReportsDir = path.join(os.tmpdir(), `team-reports-test-${Date.now()}`);
    await fs.promises.mkdir(tmpReportsDir, { recursive: true });
  });

  after(async () => {
    await fs.promises.rm(tmpReportsDir, { recursive: true, force: true }).catch(() => {});
  });

  test('generates report, calculates Jira & Bitbucket stats, and saves static files', async () => {
    const mockJiraClient = {
      baseUrl: 'https://example.atlassian.net',
      async searchIssuesDetailed() {
        return [
          {
            key: 'CS-101',
            fields: {
              summary: 'Implement OAuth auth flow',
              issuetype: { name: 'Story' },
              status: { name: 'Done', statusCategory: { key: 'done' } },
              created: '2026-11-01T10:00:00Z',
              resolutiondate: '2026-11-05T15:00:00Z',
              assignee: { displayName: 'Victor Diaz', emailAddress: 'victor.diaz@intive.com' },
            },
            changelog: {
              histories: [
                {
                  created: '2026-11-01T12:00:00Z',
                  items: [{ field: 'status', fromString: 'To Do', toString: 'In Progress' }],
                },
                {
                  created: '2026-11-02T12:00:00Z', // 24 hours
                  items: [{ field: 'status', fromString: 'In Progress', toString: 'Done' }],
                },
              ],
            },
          },
          {
            key: 'CS-102',
            fields: {
              summary: 'Fix race condition in token refresh',
              issuetype: { name: 'Bug' },
              status: { name: 'Done', statusCategory: { key: 'done' } },
              created: '2026-11-03T10:00:00Z',
              resolutiondate: '2026-11-07T12:00:00Z',
              assignee: { displayName: 'Victor Diaz', emailAddress: 'victor.diaz@intive.com' },
            },
            changelog: {
              histories: [
                {
                  created: '2026-11-03T11:00:00Z',
                  items: [{ field: 'status', fromString: 'To Do', toString: 'In Progress' }],
                },
                {
                  created: '2026-11-04T11:00:00Z', // 24 hours
                  items: [{ field: 'status', fromString: 'In Progress', toString: 'QA' }],
                },
                {
                  created: '2026-11-04T15:00:00Z', // QA Bounce!
                  items: [{ field: 'status', fromString: 'QA', toString: 'In Progress' }],
                },
                {
                  created: '2026-11-05T15:00:00Z', // 24 hours
                  items: [{ field: 'status', fromString: 'In Progress', toString: 'Done' }],
                },
              ],
            },
          },
        ];
      },
    };

    const mockBitbucketClient = {
      async listPullRequests() {
        return {
          values: [
            {
              id: 1,
              title: 'OAuth integration',
              state: 'MERGED',
              created_on: '2026-11-01T12:00:00Z',
              updated_on: '2026-11-05T12:00:00Z',
              author: { display_name: 'Victor Diaz', account_id: 'acc-1' },
              participants: [
                { user: { display_name: 'Oscar Toro', account_id: 'acc-2' }, approved: true },
              ],
            },
          ],
        };
      },
      async listCommits() {
        return {
          values: [
            {
              hash: 'abc1234',
              date: '2026-11-02T12:00:00Z',
              author: { user: { display_name: 'Victor Diaz' } },
            },
          ],
        };
      },
    };

    const service = new TeamReportService({
      jiraClient: mockJiraClient,
      bitbucketClient: mockBitbucketClient,
      bitbucketConfig: {
        workspace: 'gchtech',
        repositories: ['ubid-backend'],
        users: ['victor.diaz@intive.com', 'oscar.toro@intive.com'],
      },
      reportsDir: tmpReportsDir,
    });

    const report = await service.generateReport({ days: 30 });

    assert.ok(report.id.startsWith('report-'));
    assert.equal(report.period.days, 30);
    assert.equal(report.teamSummary.totalResolved, 2);
    assert.equal(report.teamSummary.totalQaBounces, 1);
    assert.equal(report.teamSummary.totalPrsMerged, 1);
    assert.equal(report.teamSummary.totalCommits, 1);

    const victor = report.members.find((m) => m.identifier === 'victor.diaz@intive.com');
    assert.ok(victor);
    assert.equal(victor.jira.resolvedCount, 2);
    assert.equal(victor.jira.resolvedByType.story, 1);
    assert.equal(victor.jira.resolvedByType.bug, 1);
    assert.equal(victor.jira.qaBouncesCount, 1);
    assert.equal(victor.bitbucket.prsMerged, 1);
    assert.equal(victor.bitbucket.commits, 1);

    const oscar = report.members.find((m) => m.identifier === 'oscar.toro@intive.com');
    assert.ok(oscar);
    assert.equal(oscar.bitbucket.prsReviewed, 1);

    // Verify static storage
    const list = await service.listReports();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, report.id);

    const fetched = await service.getReport(report.id);
    assert.equal(fetched.id, report.id);
    assert.equal(fetched.teamSummary.totalResolved, 2);

    // Verify markdown generation
    const md = service.generateMarkdownExport(report);
    assert.match(md, /Reporte de Rendimiento del Equipo/);
    assert.match(md, /Tickets Jira Resueltos/);
    assert.match(md, /Victor Diaz/);
    assert.match(md, /CS-102/);

    // Verify deletion
    const deleted = await service.deleteReport(report.id);
    assert.equal(deleted, true);
    const afterDelete = await service.getReport(report.id);
    assert.equal(afterDelete, null);
  });
});

describe('renderReportsPage view', () => {
  test('renders navigation, Generate team report button, and embeds config', () => {
    const html = renderReportsPage({
      workspace: 'gchtech',
      repositories: ['ubid-backend'],
      users: ['victor.diaz@intive.com'],
      activeReport: {
        id: 'report-2026-11-18',
        title: 'Team Performance Report',
        formattedDate: '18/11/2026, 14:15',
        period: { days: 30, from: '19/10/2026', to: '18/11/2026' },
        teamSummary: { totalResolved: 12 },
        members: [],
      },
      reportsList: [{ id: 'report-2026-11-18', formattedDate: '18/11/2026, 14:15' }],
    });

    assert.match(html, /Generate team report/);
    assert.match(html, /Team Reports/);
    assert.match(html, /Tickets Jira Resueltos/);
    assert.match(html, /Tiempo Prom\. In-Progress/);
    assert.match(html, /Rebotes QA ➔ In Progress/);
    assert.match(html, /Tabla Comparativa del Equipo/);
    assert.match(html, /report-2026-11-18/);
  });
});

describe('JiraClient REST API v3 and user identity matching', () => {
  test('buildAuthorIdentityKeys handles Jira camelCase fields correctly', () => {
    const jiraAssignee = {
      displayName: 'Victor Diaz',
      accountId: '712020:1c779ff6-39ae-40d4-8f51-5a61a1421315',
    };
    const keys = buildAuthorIdentityKeys(jiraAssignee);
    assert.ok(keys.includes('victor diaz'));
    assert.ok(keys.includes('712020:1c779ff6-39ae-40d4-8f51-5a61a1421315'));
  });

  test('searchIssuesDetailed sends expand as string and supports token pagination', async () => {
    const requests = [];
    const client = new JiraClient({ baseUrl: 'https://test.atlassian.net', authHeader: 'Basic test' });
    client.request = async (endpoint, options) => {
      requests.push({ endpoint, options, body: JSON.parse(options.body) });
      if (requests.length === 1) {
        return {
          issues: [{ key: 'TEST-1', fields: { summary: 'Issue 1' } }],
          nextPageToken: 'token-page-2',
          isLast: false,
        };
      }
      return {
        issues: [{ key: 'TEST-2', fields: { summary: 'Issue 2' } }],
        isLast: true,
      };
    };

    const issues = await client.searchIssuesDetailed('project = TEST', {
      maxResults: 150,
      expand: ['changelog'],
    });

    assert.equal(issues.length, 2);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].endpoint, '/rest/api/3/search/jql');
    assert.equal(requests[0].body.expand, 'changelog');
    assert.equal(typeof requests[0].body.expand, 'string');
    assert.equal(requests[1].body.nextPageToken, 'token-page-2');
  });
});
