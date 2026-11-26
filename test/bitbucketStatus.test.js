import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { getBitbucketConfig } from '../src/bitbucketConfig.js';
import { DEFAULT_BITBUCKET_REPOSITORIES } from '../src/bitbucketConstants.js';
import { BitbucketClient } from '../src/bitbucketClient.js';
import { BitbucketRequestError } from '../src/bitbucketErrors.js';
import { parseStatusQuery } from '../src/bitbucketRoutes.js';
import { BitbucketStatusService } from '../src/bitbucketStatusService.js';
import {
  indexPipelinesByPullRequestId,
  mapPullRequest,
  summarizeRepository,
  summarizeReview,
} from '../src/pullRequestStatus.js';
import { renderRepositoriesPage } from '../src/views/repositoriesPage.js';

const silentLogger = {
  info() {},
  warn() {},
  error() {},
};

const ENVIRONMENT_KEYS = [
  'BITBUCKET_EMAIL',
  'BITBUCKET_API_TOKEN',
  'BITBUCKET_WORKSPACE',
  'BITBUCKET_REPOSITORIES',
  'REPOSITORIES',
  'BITBUCKET_USERS',
  'ORCA_BITBUCKET_EMAIL',
  'ORCA_BITBUCKET_API_TOKEN',
  'JIRA_EMAIL',
  'JIRA_API_TOKEN',
];

/**
 * Runs a callback with a clean Bitbucket environment, then restores the process.
 * @param {object} overrides
 * @param {() => void} callback
 */
function withBitbucketEnv(overrides, callback) {
  const previousValues = new Map();
  for (const key of ENVIRONMENT_KEYS) {
    previousValues.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) process.env[key] = value;
  }

  try {
    callback();
  } finally {
    for (const [key, value] of previousValues) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function httpResponse(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'status',
    async text() {
      return text;
    },
    async json() {
      return JSON.parse(text);
    },
  };
}

function pullRequestFixture(overrides = {}) {
  return {
    id: 12,
    title: 'Add vetting status <script>',
    state: 'OPEN',
    draft: false,
    comment_count: 3,
    task_count: 1,
    created_on: '2026-10-27T12:00:00.000Z',
    updated_on: '2026-10-27T15:00:00.000Z',
    author: {
      display_name: 'Victor Diaz',
      links: { avatar: { href: 'https://example.test/author.png' } },
    },
    source: { branch: { name: 'feature/CS-419' } },
    destination: { branch: { name: 'main' } },
    participants: [
      {
        role: 'PARTICIPANT',
        approved: false,
        state: null,
        user: { display_name: 'Victor Diaz' },
      },
      {
        role: 'REVIEWER',
        approved: false,
        state: 'changes_requested',
        user: { display_name: 'Oscar Toro', links: { avatar: { href: 'https://example.test/reviewer.png' } } },
      },
    ],
    links: { html: { href: 'https://bitbucket.org/gchtech/ubid-backend/pull-requests/12' } },
    ...overrides,
  };
}

describe('getBitbucketConfig', () => {
  test('uses the watched repository defaults and does not reuse a Jira token', () => {
    withBitbucketEnv({
      JIRA_EMAIL: 'jira@example.com',
      JIRA_API_TOKEN: 'jira-token',
      ORCA_BITBUCKET_EMAIL: 'dev@example.com',
      ORCA_BITBUCKET_API_TOKEN: 'bitbucket-token',
    }, () => {
      const config = getBitbucketConfig();
      assert.equal(config.configured, true);
      assert.equal(config.email, 'dev@example.com');
      assert.equal(config.apiToken, 'bitbucket-token');
      assert.equal(config.workspace, 'gchtech');
      assert.deepEqual(config.repositories, [...DEFAULT_BITBUCKET_REPOSITORIES]);
      assert.deepEqual(config.users, []);
    });
  });

  test('reports a missing Bitbucket token instead of borrowing the Jira token', () => {
    withBitbucketEnv({
      JIRA_EMAIL: 'jira@example.com',
      JIRA_API_TOKEN: 'jira-token',
    }, () => {
      const config = getBitbucketConfig();
      assert.equal(config.configured, false);
      assert.match(config.configurationError, /BITBUCKET_API_TOKEN/);
      assert.equal(config.apiToken, '');
    });
  });

  test('parses a unique repository list and rejects unsafe slugs', () => {
    withBitbucketEnv({
      BITBUCKET_EMAIL: 'dev@example.com',
      BITBUCKET_API_TOKEN: 'token',
      BITBUCKET_REPOSITORIES: 'ubid-backend, ubid-backend, gch-auth0',
    }, () => {
      assert.deepEqual(getBitbucketConfig().repositories, ['ubid-backend', 'gch-auth0']);
    });

    withBitbucketEnv({
      BITBUCKET_EMAIL: 'dev@example.com',
      BITBUCKET_API_TOKEN: 'token',
      BITBUCKET_REPOSITORIES: '../etc/passwd',
    }, () => {
      const config = getBitbucketConfig();
      assert.equal(config.configured, false);
      assert.match(config.configurationError, /unsupported characters/);
    });
  });

  test('prefers REPOSITORIES and reads BITBUCKET_USERS', () => {
    withBitbucketEnv({
      BITBUCKET_EMAIL: 'dev@example.com',
      BITBUCKET_API_TOKEN: 'token',
      REPOSITORIES: 'scr-backend, ubid-backend',
      BITBUCKET_REPOSITORIES: 'gch-auth0',
      BITBUCKET_USERS: 'victor.diaz@intive.com, Victor Diaz, victor.diaz@intive.com',
    }, () => {
      const config = getBitbucketConfig();
      assert.deepEqual(config.repositories, ['scr-backend', 'ubid-backend']);
      assert.deepEqual(config.users, ['victor.diaz@intive.com', 'Victor Diaz']);
    });
  });
});

describe('pull request status mapping', () => {
  test('keeps the newest pipeline and summarizes review and build state', () => {
    const pipelineByPullRequestId = indexPipelinesByPullRequestId([
      {
        build_number: 10,
        created_on: '2026-10-27T14:00:00.000Z',
        state: { name: 'COMPLETED', result: { name: 'SUCCESSFUL' } },
        target: { pullrequest: { id: 12 } },
      },
      {
        build_number: 11,
        created_on: '2026-10-27T16:00:00.000Z',
        state: { name: 'COMPLETED', result: { name: 'FAILED' } },
        target: { pullrequest: { id: 12 } },
      },
    ]);

    const pullRequest = mapPullRequest(pullRequestFixture(), {
      workspace: 'gchtech',
      repositorySlug: 'ubid-backend',
      pipelineByPullRequestId,
    });

    assert.equal(pullRequest.build.overall, 'FAILED');
    assert.equal(pullRequest.build.name, 'Pipeline #11');
    assert.equal(pullRequest.build.url, 'https://bitbucket.org/gchtech/ubid-backend/pipelines/results/11');
    assert.equal(pullRequest.review.overall, 'changes_requested');
    assert.equal(pullRequest.review.reviewerCount, 1);
    assert.equal(pullRequest.sourceBranch, 'feature/CS-419');
    assert.equal(pullRequest.destinationBranch, 'main');
  });

  test('marks a pull request approved only when every reviewer approved', () => {
    const partial = summarizeReview([
      { displayName: 'A', state: 'approved' },
      { displayName: 'B', state: 'pending' },
    ]);
    const complete = summarizeReview([
      { displayName: 'A', state: 'approved' },
      { displayName: 'B', state: 'approved' },
    ]);
    assert.equal(partial.overall, 'partially_approved');
    assert.equal(complete.overall, 'approved');
  });

  test('counts drafts separately from open pull request health', () => {
    const counts = summarizeRepository([
      { draft: false, updatedOn: '2026-10-27T12:00:00.000Z', review: { overall: 'approved' }, build: { overall: 'SUCCESSFUL' }, hasConflict: false, hasBeenReviewed: true },
      { draft: true, updatedOn: '2026-10-27T13:00:00.000Z', review: { overall: 'pending' }, build: { overall: 'FAILED' }, hasConflict: false, hasBeenReviewed: false },
      { draft: false, updatedOn: '2026-10-27T14:00:00.000Z', review: { overall: 'changes_requested' }, build: { overall: 'FAILED' }, hasConflict: true, hasBeenReviewed: true },
    ]);
    assert.equal(counts.openCount, 2);
    assert.equal(counts.draftCount, 1);
    assert.equal(counts.approvedCount, 1);
    assert.equal(counts.changesRequestedCount, 1);
    assert.equal(counts.buildFailedCount, 1);
    assert.equal(counts.conflictCount, 1);
    assert.equal(counts.unreviewedCount, 0);
    assert.equal(counts.latestActivityAt, '2026-10-27T14:00:00.000Z');
  });

  test('identifies reviewed vs unreviewed PR status correctly', () => {
    const unreviewedPR = pullRequestFixture({
      id: 201,
      comment_count: 0,
      reviewers: [{ display_name: 'Oscar Toro' }],
      participants: [{ role: 'REVIEWER', user: { display_name: 'Oscar Toro' }, state: null, approved: false }],
    });
    const reviewedWithComments = pullRequestFixture({
      id: 202,
      comment_count: 4,
      reviewers: [{ display_name: 'Jane Doe' }],
      participants: [{ role: 'REVIEWER', user: { display_name: 'Jane Doe' }, state: null, approved: false }],
    });
    const reviewedWithApproval = pullRequestFixture({
      id: 203,
      comment_count: 0,
      reviewers: [{ display_name: 'Jane Doe' }],
      participants: [{ role: 'REVIEWER', user: { display_name: 'Jane Doe' }, state: 'approved', approved: true }],
    });

    const mappedUnreviewed = mapPullRequest(unreviewedPR, { workspace: 'gchtech', repositorySlug: 'ubid-backend' });
    const mappedWithComments = mapPullRequest(reviewedWithComments, { workspace: 'gchtech', repositorySlug: 'ubid-backend' });
    const mappedWithApproval = mapPullRequest(reviewedWithApproval, { workspace: 'gchtech', repositorySlug: 'ubid-backend' });

    assert.equal(mappedUnreviewed.hasBeenReviewed, false);
    assert.equal(mappedUnreviewed.reviewState, 'unreviewed');
    assert.equal(mappedUnreviewed.reviewStateLabel, 'Sin review aún');

    assert.equal(mappedWithComments.hasBeenReviewed, true);
    assert.equal(mappedWithComments.reviewState, 'reviewed_with_feedback');
    assert.equal(mappedWithComments.reviewStateLabel, 'Revisado (4 comentarios)');

    assert.equal(mappedWithApproval.hasBeenReviewed, true);
    assert.equal(mappedWithApproval.reviewState, 'reviewed_approved');
    assert.equal(mappedWithApproval.reviewStateLabel, 'Revisado (Aprobado)');
  });

  test('combines declared reviewers with participants and tracks approval state', () => {
    const rawPR = pullRequestFixture({
      reviewers: [
        { display_name: 'Oscar Toro', account_id: 'oscar-1' },
        { display_name: 'Jane Doe', account_id: 'jane-2' },
      ],
      participants: [
        {
          role: 'PARTICIPANT',
          user: { display_name: 'Author' },
        },
        {
          role: 'REVIEWER',
          approved: true,
          state: 'approved',
          user: { display_name: 'Oscar Toro', account_id: 'oscar-1' },
        },
      ],
    });

    const mapped = mapPullRequest(rawPR, { workspace: 'gchtech', repositorySlug: 'ubid-backend' });
    assert.equal(mapped.review.reviewerCount, 2);
    assert.equal(mapped.review.hasApproval, true);
    assert.equal(mapped.review.isFullyApproved, false);
    assert.equal(mapped.review.overall, 'partially_approved');

    const oscar = mapped.review.reviewers.find((r) => r.displayName === 'Oscar Toro');
    const jane = mapped.review.reviewers.find((r) => r.displayName === 'Jane Doe');
    assert.equal(oscar?.state, 'approved');
    assert.equal(jane?.state, 'pending');
  });

  test('maps merge conflict status from context or raw PR', () => {
    const conflictedPR = pullRequestFixture({
      id: 99,
      has_conflict: true,
      conflicts: ['src/index.js'],
    });

    const cleanPR = pullRequestFixture({
      id: 100,
      has_conflict: false,
    });

    const mappedConflicted = mapPullRequest(conflictedPR, {
      workspace: 'gchtech',
      repositorySlug: 'ubid-backend',
    });
    const mappedClean = mapPullRequest(cleanPR, {
      workspace: 'gchtech',
      repositorySlug: 'ubid-backend',
    });

    assert.equal(mappedConflicted.hasConflict, true);
    assert.equal(mappedConflicted.conflict.hasConflict, true);
    assert.equal(mappedConflicted.conflict.count, 1);
    assert.deepEqual(mappedConflicted.conflict.files, ['src/index.js']);

    assert.equal(mappedClean.hasConflict, false);
    assert.equal(mappedClean.conflict.hasConflict, false);
  });
});

describe('BitbucketStatusService', () => {
  function createService(client, repositories = ['ubid-backend']) {
    return new BitbucketStatusService({
      client,
      logger: silentLogger,
      config: {
        workspace: 'gchtech',
        repositories,
        refreshIntervalMs: 15000,
        cacheTtlMs: 60000,
      },
    });
  }

  test('splits drafts from open pull requests and counts a failed build', async () => {
    let pullRequestCalls = 0;
    const service = createService({
      async listPullRequests() {
        pullRequestCalls += 1;
        return {
          truncated: false,
          values: [
            pullRequestFixture(),
            pullRequestFixture({
              id: 13,
              title: 'Draft work',
              draft: true,
              participants: [],
            }),
          ],
        };
      },
      async listPipelines() {
        return {
          truncated: false,
          values: [{
            build_number: 11,
            created_on: '2026-10-27T16:00:00.000Z',
            state: { name: 'COMPLETED', result: { name: 'FAILED' } },
            target: { pullrequest: { id: 12 } },
          }],
        };
      },
    });

    const openBoard = await service.getBoard({ state: 'OPEN' });
    assert.equal(openBoard.repositories[0].pullRequests.length, 1);
    assert.equal(openBoard.repositories[0].pullRequests[0].id, 12);
    assert.equal(openBoard.summaries[0].openCount, 1);
    assert.equal(openBoard.summaries[0].draftCount, 1);
    assert.equal(openBoard.summaries[0].buildFailedCount, 1);
    assert.equal(openBoard.repositories[0].htmlUrl, 'https://bitbucket.org/gchtech/ubid-backend/pull-requests/');

    const draftBoard = await service.getBoard({ state: 'DRAFT' });
    assert.equal(draftBoard.repositories[0].pullRequests.length, 1);
    assert.equal(draftBoard.repositories[0].pullRequests[0].draft, true);
    assert.equal(pullRequestCalls, 1);
  });

  test('keeps a repository error on that repository and rejects a bad token', async () => {
    const missingService = createService({
      async listPullRequests({ repositorySlug }) {
        if (repositorySlug === 'missing-repo') {
          throw new BitbucketRequestError('missing', { statusCode: 404 });
        }
        return { values: [pullRequestFixture({ id: 20, title: 'Still visible', participants: [] })], truncated: false };
      },
      async listPipelines() {
        return { values: [], truncated: false };
      },
    }, ['missing-repo', 'ubid-backend']);

    const board = await missingService.getBoard({ state: 'OPEN' });
    assert.equal(board.repositories[0].error, 'missing');
    assert.deepEqual(board.repositories[0].pullRequests, []);
    assert.equal(board.repositories[1].error, null);
    assert.equal(board.repositories[1].pullRequests[0].title, 'Still visible');

    const unauthorizedService = createService({
      async listPullRequests() {
        throw new BitbucketRequestError('The API token is valid for Atlassian, but it does not include Bitbucket scopes, so pull requests cannot be read.', {
          statusCode: 401,
        });
      },
      async listPipelines() {
        return { values: [], truncated: false };
      },
    });

    await assert.rejects(
      () => unauthorizedService.getBoard({ state: 'OPEN' }),
      (error) => error.statusCode === 401,
    );
  });

  test('keeps pull requests visible when pipeline status is unavailable', async () => {
    const service = createService({
      async listPullRequests() {
        return { values: [pullRequestFixture({ participants: [] })], truncated: false };
      },
      async listPipelines() {
        throw new BitbucketRequestError('Pipelines are not enabled.', { statusCode: 404 });
      },
    });

    const board = await service.getBoard({ state: 'OPEN' });
    assert.equal(board.repositories[0].pullRequests.length, 1);
    assert.equal(board.repositories[0].pipelinesUnavailable, true);
    assert.equal(board.repositories[0].pullRequests[0].build.overall, 'NONE');
  });

  test('keeps open pull requests authored by the watched users', async () => {
    const service = new BitbucketStatusService({
      logger: silentLogger,
      userDirectory: {
        async lookup() {
          return {
            accountId: 'account-123',
            displayName: 'Victor Diaz',
            emailAddress: 'victor.diaz@intive.com',
          };
        },
      },
      config: {
        workspace: 'gchtech',
        repositories: ['ubid-backend'],
        users: ['victor.diaz@intive.com'],
        refreshIntervalMs: 15000,
        cacheTtlMs: 60000,
      },
      client: {
        async listPullRequests() {
          return {
            truncated: false,
            values: [
              pullRequestFixture({
                author: { display_name: 'Victor Diaz', account_id: 'account-123' },
              }),
              pullRequestFixture({
                id: 50,
                title: 'Someone else',
                author: { display_name: 'Ada Lovelace', account_id: 'account-999' },
                participants: [],
              }),
            ],
          };
        },
        async listPipelines() {
          return { values: [], truncated: false };
        },
      },
    });

    const board = await service.getBoard({ state: 'OPEN' });
    assert.deepEqual(board.users, [{ id: 'victor.diaz@intive.com', label: 'Victor Diaz' }]);
    assert.equal(board.summaries[0].openCount, 1);
    assert.equal(board.summaries[0].countsByUser['victor.diaz@intive.com'].openCount, 1);
    assert.equal(board.repositories[0].pullRequests.length, 1);
    assert.deepEqual(board.repositories[0].pullRequests[0].matchedUsers, ['victor.diaz@intive.com']);
    assert.equal(board.repositories[0].pullRequests[0].title, 'Add vetting status <script>');
  });

  test('falls back to getPullRequest when reviewers and participants are omitted from list response', async () => {
    let singlePRCalls = 0;
    const service = createService({
      async listPullRequests() {
        return {
          values: [
            {
              id: 50,
              title: 'PR without reviewers in list',
            },
          ],
          truncated: false,
        };
      },
      async getPullRequest(workspace, repoSlug, id) {
        singlePRCalls += 1;
        return {
          id,
          reviewers: [{ display_name: 'Fallback Reviewer', account_id: 'rev-1' }],
          participants: [{ role: 'REVIEWER', user: { display_name: 'Fallback Reviewer', account_id: 'rev-1' }, approved: true }],
        };
      },
      async listPipelines() {
        return { values: [], truncated: false };
      },
    });

    const board = await service.getBoard({ state: 'OPEN' });
    assert.equal(singlePRCalls, 1);
    const pr = board.repositories[0].pullRequests[0];
    assert.equal(pr.review.reviewerCount, 1);
    assert.equal(pr.hasBeenReviewed, true);
    assert.equal(board.summaries[0].unreviewedCount, 0);
  });
});

describe('parseStatusQuery', () => {
  const config = { repositories: ['ubid-backend'] };

  test('accepts a watched repository and a manual refresh', () => {
    assert.deepEqual(parseStatusQuery({ state: 'merged', repository: 'ubid-backend', refresh: '1' }, config), {
      state: 'MERGED',
      repositorySlug: 'ubid-backend',
      bypassCache: true,
    });
  });

  test('rejects an unknown view and a repository outside the watch list', () => {
    assert.throws(() => parseStatusQuery({ state: 'SUPERSEDED' }, config), BitbucketRequestError);
    assert.throws(() => parseStatusQuery({ repository: 'not-watched' }, config), (error) => error.statusCode === 400);
    assert.throws(() => parseStatusQuery({ repository: '<script>' }, config), (error) => error.statusCode === 400);
  });
});

describe('BitbucketClient', () => {
  test('explains a token that has no Bitbucket scopes', async () => {
    const client = new BitbucketClient({
      email: 'dev@example.com',
      apiToken: 'token',
      logger: silentLogger,
      fetchImpl: async () => httpResponse(401, { error: { message: 'API Token provided has no Bitbucket scopes.' } }),
    });

    await assert.rejects(
      () => client.listPullRequests({ workspace: 'gchtech', repositorySlug: 'ubid-backend', state: 'OPEN' }),
      (error) => {
        assert.equal(error.statusCode, 401);
        assert.match(error.message, /does not include Bitbucket scopes/);
        assert.ok(error.instructions.length > 0);
        return true;
      },
    );
  });

  test('does not follow a pagination link that leaves the Bitbucket API', async () => {
    const requestedUrls = [];
    const client = new BitbucketClient({
      email: 'dev@example.com',
      apiToken: 'token',
      logger: silentLogger,
      fetchImpl: async (url) => {
        requestedUrls.push(String(url));
        return httpResponse(200, {
          values: [{ id: 1 }],
          next: 'https://evil.example/steal-token',
        });
      },
    });

    const page = await client.listPullRequests({
      workspace: 'gchtech',
      repositorySlug: 'ubid-backend',
      state: 'OPEN',
    });

    assert.equal(requestedUrls.length, 1);
    assert.equal(page.values.length, 1);
    assert.equal(page.truncated, true);
  });

  test('fetches pull request conflicts and handles conflicts vs clean', async () => {
    const client = new BitbucketClient({
      email: 'dev@example.com',
      apiToken: 'token',
      logger: silentLogger,
      fetchImpl: async (url) => {
        if (url.includes('/conflicts')) {
          return httpResponse(200, {
            values: [
              { path: 'src/server.js', type: 'commit_file' },
              { path: 'package.json', type: 'commit_file' },
            ],
          });
        }
        return httpResponse(200, { values: [] });
      },
    });

    const result = await client.getPullRequestConflicts('gchtech', 'ubid-backend', 12);
    assert.equal(result.hasConflict, true);
    assert.equal(result.conflictCount, 2);
    assert.deepEqual(result.conflictingFiles, ['src/server.js', 'package.json']);
  });

  test('requests reviewers and participants in listPullRequests query and fetches single PR details', async () => {
    let capturedUrl = '';
    const client = new BitbucketClient({
      email: 'dev@example.com',
      apiToken: 'token',
      logger: silentLogger,
      fetchImpl: async (url) => {
        capturedUrl = String(url);
        if (capturedUrl.includes('/pullrequests/42')) {
          return httpResponse(200, {
            id: 42,
            reviewers: [{ display_name: 'Oscar' }],
            participants: [{ user: { display_name: 'Oscar' }, approved: true }],
          });
        }
        return httpResponse(200, { values: [] });
      },
    });

    await client.listPullRequests({ workspace: 'gchtech', repositorySlug: 'ubid-backend', state: 'OPEN' });
    assert.match(capturedUrl, /fields=%2Bvalues\.participants%2C%2Bvalues\.reviewers/);

    const singlePR = await client.getPullRequest('gchtech', 'ubid-backend', 42);
    assert.equal(singlePR.id, 42);
    assert.equal(singlePR.reviewers[0].display_name, 'Oscar');
  });
});

describe('renderRepositoriesPage', () => {
  test('renders the pull request board and escapes config that could break the page', () => {
    const html = renderRepositoriesPage({
      workspace: 'gchtech',
      repositories: ['ubid-backend'],
      refreshIntervalMs: 15000,
      states: ['OPEN', 'DRAFT', 'MERGED', 'DECLINED'],
    });
    assert.match(html, /Pull requests/);
    assert.match(html, /ubid-backend/);
    assert.match(html, /teams-copy-button/);
    assert.match(html, /teams-modal/);
    assert.match(html, /teams-only-unreviewed/);
    assert.match(html, /teams-include-details/);
    assert.match(html, /teams-message-text/);
    assert.match(html, /\/api\/bitbucket\/status|repository-page-config/);
    assert.match(html, /repository-assets\/repositories.js/);

    const hostile = renderRepositoriesPage({
      workspace: '<script>alert(1)</script>',
      repositories: ['ok'],
      refreshIntervalMs: 15000,
      states: ['OPEN'],
    });
    assert.equal(hostile.includes('<script>alert(1)</script>'), false);
    assert.match(hostile, /\\u003cscript/);
  });
});
