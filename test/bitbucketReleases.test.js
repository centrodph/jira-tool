import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { BitbucketClient } from '../src/bitbucketClient.js';
import { BitbucketRequestError } from '../src/bitbucketErrors.js';
import { parseReleaseQuery } from '../src/bitbucketRoutes.js';
import {
  BitbucketReleaseService,
  compareReleaseBranchesAsc,
  groupBranchesByMinor,
  parseReleaseBranch,
} from '../src/bitbucketReleaseService.js';
import { renderReleasesPage } from '../src/views/releasesPage.js';

const silentLogger = {
  info() {},
  warn() {},
  error() {},
};

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

function branchFixture(name, date, hash = 'abcdef1234567890', author = 'Leonardo Alifraco', message = 'Release commit') {
  return {
    name,
    target: {
      hash,
      date,
      message,
      author: {
        user: { display_name: author },
      },
    },
  };
}

describe('parseReleaseBranch & groupBranchesByMinor', () => {
  test('parses release/vX.X.X branches and ignores non-conforming branch names', () => {
    const valid = parseReleaseBranch(
      branchFixture('release/v1.12.3', '2026-11-18T20:00:00+00:00', '9876543210fedcba', 'Gerardo Perrucci'),
      { workspace: 'gchtech', repositorySlug: 'gch-account-service' },
    );

    assert.ok(valid);
    assert.equal(valid.name, 'release/v1.12.3');
    assert.equal(valid.major, 1);
    assert.equal(valid.minor, 12);
    assert.equal(valid.patch, 3);
    assert.equal(valid.minorKey, 'v1.12');
    assert.equal(valid.versionLabel, 'v1.12.3');
    assert.equal(valid.shortHash, '98765432');
    assert.equal(valid.targetAuthor, 'Gerardo Perrucci');
    assert.equal(valid.htmlUrl, 'https://bitbucket.org/gchtech/gch-account-service/branch/release/v1.12.3');

    assert.equal(parseReleaseBranch({ name: 'main' }), null);
    assert.equal(parseReleaseBranch({ name: 'feature/release/v1.0.0' }), null);
    assert.equal(parseReleaseBranch({ name: 'release/release/v1.3.0' }), null);
    assert.equal(parseReleaseBranch({ name: 'release/test' }), null);
  });

  test('sorts numerically by semver (v0.12 > v0.11 > v0.9 > v0.2) and groups patches by minor', () => {
    const raw = [
      branchFixture('release/v0.2.0', '2026-09-23T13:41:18+00:00'),
      branchFixture('release/v0.12.0', '2026-11-18T20:47:03+00:00'),
      branchFixture('release/v0.9.0', '2026-10-30T14:35:58+00:00'),
      branchFixture('release/v0.11.0', '2026-11-05T20:33:39+00:00'),
      branchFixture('release/v0.2.4', '2026-09-25T15:44:23+00:00'),
      branchFixture('release/v0.2.1', '2026-09-23T14:04:26+00:00'),
    ];

    const parsed = raw.map((b) => parseReleaseBranch(b)).filter(Boolean);
    const groups = groupBranchesByMinor(parsed);

    assert.deepEqual(
      groups.map((g) => g.minorKey),
      ['v0.12', 'v0.11', 'v0.9', 'v0.2'],
    );
    assert.deepEqual(
      groups[3].branches.map((b) => b.name),
      ['release/v0.2.0', 'release/v0.2.1', 'release/v0.2.4'],
    );
  });
});

describe('BitbucketReleaseService', () => {
  test('returns the last 2 minor versions with creation (cut) date and last update date', async () => {
    const mockClient = {
      async listReleaseBranches() {
        return {
          truncated: false,
          values: [
            branchFixture('release/v2.0.0', '2026-08-29T10:29:28+00:00', '11111111aaaa', 'Pablo Szyrko'),
            branchFixture('release/v2.1.0', '2026-09-21T23:24:27+00:00', '22222222bbbb', 'Gustavo Rios'),
            branchFixture('release/v2.2.0', '2026-11-10T10:04:11+00:00', '33333333cccc', 'Pablo Szyrko'),
            branchFixture('release/v2.2.1', '2026-11-11T14:42:21+00:00', '44444444dddd', 'Pablo Szyrko', 'Hotfix prisma'),
          ],
        };
      },
      async listBranchCommits({ include }) {
        if (include === 'release/v2.2.0') {
          return {
            values: [
              { hash: '33333333cccc', date: '2026-11-10T10:04:11+00:00', author: { raw: 'Pablo Szyrko' } },
              {
                hash: 'first220commit',
                date: '2026-10-08T15:56:32+00:00',
                author: { raw: 'Pablo Szyrko' },
                parents: [{ hash: 'cutpoint220hash' }],
              },
            ],
            truncated: false,
          };
        }
        if (include === 'release/v2.2.1') {
          return {
            values: [
              {
                hash: '44444444dddd',
                date: '2026-11-11T14:42:21+00:00',
                author: { raw: 'Pablo Szyrko' },
                parents: [{ hash: '33333333cccc' }],
              },
            ],
            truncated: false,
          };
        }
        if (include === 'release/v2.1.0') {
          return {
            values: [
              {
                hash: '22222222bbbb',
                date: '2026-09-21T23:24:27+00:00',
                author: { raw: 'Gustavo Rios' },
                parents: [{ hash: 'cutpoint210hash' }],
              },
            ],
            truncated: false,
          };
        }
        return { values: [], truncated: false };
      },
      async getCommit(workspace, repoSlug, hash) {
        if (hash === 'cutpoint220hash') {
          return { hash, date: '2026-10-06T17:23:34+00:00' };
        }
        if (hash === 'cutpoint210hash') {
          return { hash, date: '2026-08-31T21:27:31+00:00' };
        }
        if (hash === '33333333cccc') {
          return { hash, date: '2026-11-10T10:04:11+00:00' };
        }
        return null;
      },
    };

    const service = new BitbucketReleaseService({
      client: mockClient,
      logger: silentLogger,
      config: {
        workspace: 'gchtech',
        repositories: ['scr-backend'],
        refreshIntervalMs: 30000,
        cacheTtlMs: 60000,
      },
    });

    const board = await service.getReleasesBoard({ minorLimit: 2 });
    assert.equal(board.repositories.length, 1);

    const repo = board.repositories[0];
    assert.equal(repo.slug, 'scr-backend');
    assert.equal(repo.totalReleaseBranches, 4);
    assert.equal(repo.totalMinors, 3);
    assert.equal(repo.minors.length, 2);

    // Minor 1 (Latest: v2.2 with release/v2.2.0 and release/v2.2.1)
    const latestMinor = repo.minors[0];
    assert.equal(latestMinor.minorKey, 'v2.2');
    assert.equal(latestMinor.initialBranchName, 'release/v2.2.0');
    assert.equal(latestMinor.latestBranchName, 'release/v2.2.1');
    assert.equal(latestMinor.patchCount, 2);
    assert.equal(latestMinor.createdAt, '2026-10-06T17:23:34+00:00');
    assert.equal(latestMinor.updatedAt, '2026-11-11T14:42:21+00:00');
    assert.equal(latestMinor.updatedBy, 'Pablo Szyrko');
    assert.equal(latestMinor.branches.length, 2);

    // Minor 2 (Previous: v2.1 with release/v2.1.0)
    const prevMinor = repo.minors[1];
    assert.equal(prevMinor.minorKey, 'v2.1');
    assert.equal(prevMinor.initialBranchName, 'release/v2.1.0');
    assert.equal(prevMinor.latestBranchName, 'release/v2.1.0');
    assert.equal(prevMinor.createdAt, '2026-08-31T21:27:31+00:00');
    assert.equal(prevMinor.updatedAt, '2026-09-21T23:24:27+00:00');
    assert.equal(prevMinor.updatedBy, 'Gustavo Rios');
  });

  test('isolates per-repository 404 errors while propagating 401 credential errors', async () => {
    const service = new BitbucketReleaseService({
      logger: silentLogger,
      config: {
        workspace: 'gchtech',
        repositories: ['missing-repo', 'gch-auth0'],
        refreshIntervalMs: 30000,
        cacheTtlMs: 60000,
      },
      client: {
        async listReleaseBranches({ repositorySlug }) {
          if (repositorySlug === 'missing-repo') {
            throw new BitbucketRequestError('Repository not found', { statusCode: 404 });
          }
          return {
            values: [branchFixture('release/v1.3.0', '2026-11-19T15:52:28+00:00')],
            truncated: false,
          };
        },
      },
    });

    const board = await service.getReleasesBoard();
    assert.equal(board.repositories[0].error, 'Repository not found');
    assert.deepEqual(board.repositories[0].minors, []);
    assert.equal(board.repositories[1].error, null);
    assert.equal(board.repositories[1].minors[0].minorKey, 'v1.3');
  });
});

describe('parseReleaseQuery', () => {
  const config = { repositories: ['ubid-backend', 'scr-backend'] };

  test('parses valid query parameters and defaults minors to 2', () => {
    assert.deepEqual(parseReleaseQuery({}, config), {
      repositorySlug: null,
      minorLimit: 2,
      bypassCache: false,
    });

    assert.deepEqual(parseReleaseQuery({ repository: 'scr-backend', minors: '3', refresh: 'true' }, config), {
      repositorySlug: 'scr-backend',
      minorLimit: 3,
      bypassCache: true,
    });
  });

  test('rejects invalid repository slugs or out-of-range minor counts', () => {
    assert.throws(() => parseReleaseQuery({ repository: 'unknown-repo' }, config), (err) => err.statusCode === 400);
    assert.throws(() => parseReleaseQuery({ minors: '0' }, config), (err) => err.statusCode === 400);
    assert.throws(() => parseReleaseQuery({ minors: '99' }, config), (err) => err.statusCode === 400);
  });
});

describe('BitbucketClient release methods', () => {
  test('queries refs/branches with release/ filter and lists branch commits with excludes', async () => {
    const requestedUrls = [];
    const client = new BitbucketClient({
      email: 'dev@example.com',
      apiToken: 'token',
      logger: silentLogger,
      fetchImpl: async (url) => {
        requestedUrls.push(String(url));
        return httpResponse(200, { values: [] });
      },
    });

    await client.listReleaseBranches({ workspace: 'gchtech', repositorySlug: 'gch-auth0' });
    assert.match(requestedUrls[0], /\/repositories\/gchtech\/gch-auth0\/refs\/branches\?/);
    assert.match(requestedUrls[0], /name\+%7E\+%22release%2F%22/);

    await client.listBranchCommits({
      workspace: 'gchtech',
      repositorySlug: 'gch-auth0',
      include: 'release/v1.3.0',
      excludes: ['main', 'release/v1.2.0'],
    });
    assert.match(requestedUrls[1], /include=release%2Fv1\.3\.0/);
    assert.match(requestedUrls[1], /exclude=main/);
    assert.match(requestedUrls[1], /exclude=release%2Fv1\.2\.0/);
  });
});

describe('renderReleasesPage', () => {
  test('renders the Release Tracker page, Teams copy modal, and escapes unsafe config', () => {
    const html = renderReleasesPage({
      workspace: 'gchtech',
      repositories: ['gch-account-service', 'scr-backend'],
      refreshIntervalMs: 30000,
      minorLimit: 2,
    });

    assert.match(html, /Release Tracker/);
    assert.match(html, /release\/vX\.X\.X/);
    assert.match(html, /gch-account-service/);
    assert.match(html, /scr-backend/);
    assert.match(html, /teams-copy-button/);
    assert.match(html, /teams-modal/);
    assert.match(html, /repository-assets\/releases\.js/);

    const hostile = renderReleasesPage({
      workspace: '<script>alert(1)</script>',
      repositories: ['ok'],
    });
    assert.equal(hostile.includes('<script>alert(1)</script>'), false);
    assert.match(hostile, /\\u003cscript/);
  });
});
