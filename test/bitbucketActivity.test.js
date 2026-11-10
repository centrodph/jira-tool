import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { BitbucketActivityService } from '../src/bitbucketActivityService.js';
import { renderActivityPage } from '../src/views/activityPage.js';
import { commitMatchesWatchedUsers, createUserMatchers } from '../src/watchedUsers.js';

const silentLogger = {
  info() {},
  warn() {},
  error() {},
};

function createMockClient(options = {}) {
  const prs = options.prs || [];
  const commits = options.commits || [];
  const diffstat = options.diffstat || { linesAdded: 15, linesRemoved: 5 };

  return {
    async listPullRequests(query) {
      return { values: prs, truncated: false };
    },
    async listCommits(query) {
      return { values: commits, truncated: false };
    },
    async getPullRequestDiffstat(workspace, repoSlug, prId) {
      return diffstat;
    },
  };
}

describe('renderActivityPage', () => {
  test('renders topbar with User Activity tab and embeds page config', () => {
    const html = renderActivityPage({
      workspace: 'testworkspace',
      repositories: ['repo-alpha', 'repo-beta'],
      users: ['emmanuel@example.com'],
    });

    assert.ok(html.includes('User Activity'));
    assert.ok(html.includes('class="is-active"'));
    assert.ok(html.includes('testworkspace'));
    assert.ok(html.includes('repo-alpha'));
    assert.ok(html.includes('repo-beta'));
    assert.ok(html.includes('id="activity-page-config"'));
    assert.ok(html.includes('emmanuel@example.com'));
  });
});

describe('commitMatchesWatchedUsers', () => {
  test('matches commit by author raw string with email', async () => {
    const matchers = await createUserMatchers(['emmanuel@example.com'], null);
    const commit = {
      hash: 'abc1234',
      author: {
        raw: 'Emmanuel Smith <emmanuel@example.com>',
      },
    };

    assert.equal(commitMatchesWatchedUsers(commit, matchers), true);
  });

  test('matches commit by author user display name', async () => {
    const matchers = await createUserMatchers(['Emmanuel Smith'], null);
    const commit = {
      hash: 'abc1234',
      author: {
        raw: 'esmith <esmith@company.test>',
        user: {
          display_name: 'Emmanuel Smith',
        },
      },
    };

    assert.equal(commitMatchesWatchedUsers(commit, matchers), true);
  });

  test('rejects commit by different author', async () => {
    const matchers = await createUserMatchers(['emmanuel@example.com'], null);
    const commit = {
      hash: 'abc1234',
      author: {
        raw: 'Alice Wonder <alice@example.com>',
      },
    };

    assert.equal(commitMatchesWatchedUsers(commit, matchers), false);
  });
});

describe('BitbucketActivityService', () => {
  test('calculates summary, PRs by repository breakdown, and lines added/removed', async () => {
    const mockPRs = [
      {
        id: 101,
        title: 'Feature alpha',
        state: 'MERGED',
        draft: false,
        created_on: new Date().toISOString(),
        updated_on: new Date().toISOString(),
        author: {
          display_name: 'Emmanuel',
          email: 'emmanuel@example.com',
        },
        source: { branch: { name: 'feat/alpha' } },
        destination: { branch: { name: 'main' } },
      },
      {
        id: 102,
        title: 'Feature beta',
        state: 'OPEN',
        draft: false,
        created_on: new Date().toISOString(),
        updated_on: new Date().toISOString(),
        author: {
          display_name: 'Emmanuel',
          email: 'emmanuel@example.com',
        },
        source: { branch: { name: 'feat/beta' } },
        destination: { branch: { name: 'main' } },
      },
    ];

    const mockCommits = [
      {
        hash: '1122334455667788',
        message: 'fix: alpha bug',
        date: new Date().toISOString(),
        author: {
          raw: 'Emmanuel <emmanuel@example.com>',
        },
      },
    ];

    const client = createMockClient({
      prs: mockPRs,
      commits: mockCommits,
      diffstat: { linesAdded: 50, linesRemoved: 10 },
    });

    const service = new BitbucketActivityService({
      client,
      config: {
        workspace: 'testws',
        repositories: ['ubid-backend'],
        users: ['emmanuel@example.com'],
      },
      logger: silentLogger,
    });

    const result = await service.getUserActivity({
      user: 'emmanuel@example.com',
      days: 30,
    });

    assert.equal(result.workspace, 'testws');
    assert.equal(result.summary.totalPRs, 2);
    assert.equal(result.summary.mergedPRs, 1);
    assert.equal(result.summary.openPRs, 1);
    assert.equal(result.summary.totalCommits, 1);
    // 2 PRs * 50 lines added = 100
    assert.equal(result.summary.linesAdded, 100);
    // 2 PRs * 10 lines removed = 20
    assert.equal(result.summary.linesRemoved, 20);

    assert.equal(result.byRepository.length, 1);
    assert.equal(result.byRepository[0].repository, 'ubid-backend');
    assert.equal(result.byRepository[0].prs, 2);
    assert.equal(result.byRepository[0].percentage, 100);
    assert.equal(result.byRepository[0].linesAdded, 100);
    assert.equal(result.byRepository[0].linesRemoved, 20);
    assert.equal(result.byRepository[0].commits, 1);
  });

  test('filters by specific repository when requested', async () => {
    const client = createMockClient({
      prs: [],
      commits: [],
    });

    const service = new BitbucketActivityService({
      client,
      config: {
        workspace: 'testws',
        repositories: ['repo-a', 'repo-b'],
        users: ['emmanuel@example.com'],
      },
      logger: silentLogger,
    });

    const result = await service.getUserActivity({
      user: 'emmanuel@example.com',
      repository: 'repo-b',
      days: 30,
    });

    assert.deepEqual(result.repositories, ['repo-b']);
    assert.equal(result.selectedRepository, 'repo-b');
  });

  test('rejects un-watched repository request', async () => {
    const client = createMockClient();
    const service = new BitbucketActivityService({
      client,
      config: {
        workspace: 'testws',
        repositories: ['repo-a'],
        users: ['emmanuel@example.com'],
      },
      logger: silentLogger,
    });

    await assert.rejects(
      async () => {
        await service.getUserActivity({
          user: 'emmanuel@example.com',
          repository: 'malicious-repo',
        });
      },
      { message: 'Repository "malicious-repo" is not in the watched repository list.' }
    );
  });
});
