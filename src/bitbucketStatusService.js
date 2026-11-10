import { REPOSITORY_FETCH_CONCURRENCY } from './bitbucketConstants.js';
import { isCredentialError } from './bitbucketErrors.js';
import {
  indexPipelinesByPullRequestId,
  mapPullRequest,
  selectPullRequestsForView,
  summarizeRepository,
} from './pullRequestStatus.js';
import { createUserMatchers, matchingUserIdentifiers } from './watchedUsers.js';

/** Account ids do not change during a session, so user lookup can stay warm. */
const USER_MATCHER_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Loads pull requests for the watched repositories and shapes them into one board.
 * Open snapshots are always loaded so the sidebar counts stay stable while the
 * user looks at drafts, merged, or declined pull requests.
 */
export class BitbucketStatusService {
  /**
   * @param {{ client: object, config: object, logger: object }} dependencies
   */
  constructor(dependencies) {
    this.client = dependencies.client;
    this.config = dependencies.config;
    this.logger = dependencies.logger;
    this.userDirectory = dependencies.userDirectory || null;
    this.snapshotCache = new Map();
    this.snapshotRequests = new Map();
    this.userMatcherCache = null;
  }

  /**
   * @param {{ state?: string, repositorySlug?: string|null, bypassCache?: boolean }} query
   * @returns {Promise<object>}
   */
  async getBoard(query) {
    const viewState = query.state || 'OPEN';
    const repositorySlug = query.repositorySlug || null;
    const bypassCache = Boolean(query.bypassCache);
    const userMatchers = await this.getUserMatchers();
    const openSnapshots = (await this.loadSnapshots(this.config.repositories, 'OPEN', bypassCache))
      .map((snapshot) => this.scopeSnapshot(snapshot, userMatchers));
    const summaries = openSnapshots.map((snapshot) => this.toSummary(snapshot));

    // Drafts are a filter over the open collection. Merged and declined are
    // separate Bitbucket queries, and only for the repositories on screen.
    const detailState = viewState === 'DRAFT' || viewState === 'OPEN' ? 'OPEN' : viewState;
    const detailSlugs = repositorySlug ? [repositorySlug] : this.config.repositories;
    const detailSnapshots = detailState === 'OPEN'
      ? openSnapshots.filter((snapshot) => detailSlugs.includes(snapshot.repositorySlug))
      : (await this.loadSnapshots(detailSlugs, detailState, bypassCache))
        .map((snapshot) => this.scopeSnapshot(snapshot, userMatchers));

    return {
      workspace: this.config.workspace,
      generatedAt: new Date().toISOString(),
      syncedAt: oldestTimestamp(detailSnapshots.map((snapshot) => snapshot.loadedAt)),
      refreshIntervalMs: this.config.refreshIntervalMs,
      state: viewState,
      repository: repositorySlug,
      users: userMatchers.map((matcher) => ({
        id: matcher.identifier,
        label: matcher.label,
      })),
      summaries,
      repositories: detailSnapshots.map((snapshot) => this.toRepositoryView(snapshot, viewState)),
    };
  }

  /**
   * @param {string[]} repositorySlugs
   * @param {string} pullRequestState
   * @param {boolean} bypassCache
   * @returns {Promise<object[]>}
   */
  async loadSnapshots(repositorySlugs, pullRequestState, bypassCache) {
    return mapWithConcurrency(repositorySlugs, REPOSITORY_FETCH_CONCURRENCY, (repositorySlug) => {
      return this.loadSnapshot(repositorySlug, pullRequestState, bypassCache);
    });
  }

  /**
   * @param {string} repositorySlug
   * @param {string} pullRequestState
   * @param {boolean} bypassCache
   * @returns {Promise<object>}
   */
  async loadSnapshot(repositorySlug, pullRequestState, bypassCache) {
    const cacheKey = `${this.config.workspace}:${repositorySlug}:${pullRequestState}`;
    const nowMs = Date.now();
    const cachedEntry = this.snapshotCache.get(cacheKey);

    if (!bypassCache && cachedEntry && cachedEntry.expiresAtMs > nowMs) {
      return cachedEntry.value;
    }

    // Two polls that miss the cache together must share one Bitbucket read.
    if (!bypassCache && this.snapshotRequests.has(cacheKey)) {
      return this.snapshotRequests.get(cacheKey);
    }

    const snapshotRequest = this.fetchRepositorySnapshot(repositorySlug, pullRequestState)
      .then((snapshot) => {
        this.snapshotCache.set(cacheKey, {
          expiresAtMs: Date.now() + this.config.cacheTtlMs,
          value: snapshot,
        });
        return snapshot;
      })
      .finally(() => {
        this.snapshotRequests.delete(cacheKey);
      });

    this.snapshotRequests.set(cacheKey, snapshotRequest);
    return snapshotRequest;
  }

  /**
   * Keeps only pull requests opened by BITBUCKET_USERS. An empty user list
   * leaves the snapshot unchanged.
   * @returns {Promise<Set<string>[]>}
   */
  async getUserMatchers() {
    const users = this.config.users || [];
    if (users.length === 0) return [];

    const cacheKey = users.join('\n');
    const nowMs = Date.now();
    if (
      this.userMatcherCache
      && this.userMatcherCache.key === cacheKey
      && this.userMatcherCache.expiresAtMs > nowMs
    ) {
      return this.userMatcherCache.matchers;
    }

    const matchers = await createUserMatchers(users, this.userDirectory);
    this.userMatcherCache = {
      key: cacheKey,
      expiresAtMs: nowMs + USER_MATCHER_CACHE_TTL_MS,
      matchers,
    };
    this.logger.info('Resolved watched Bitbucket users', { userCount: users.length });
    return matchers;
  }

  /**
   * @param {object} snapshot
   * @param {Set<string>[]} userMatchers
   * @returns {object}
   */
  scopeSnapshot(snapshot, userMatchers) {
    if (!userMatchers.length) return snapshot;
    const pullRequests = [];
    for (const pullRequest of snapshot.pullRequests) {
      const matchedUsers = matchingUserIdentifiers(pullRequest, userMatchers);
      if (matchedUsers.length === 0) continue;
      pullRequests.push({ ...pullRequest, matchedUsers });
    }
    return { ...snapshot, pullRequests };
  }

  /**
   * @param {string} repositorySlug
   * @param {string} pullRequestState
   * @returns {Promise<object>}
   */
  async fetchRepositorySnapshot(repositorySlug, pullRequestState) {
    const location = {
      workspace: this.config.workspace,
      repositorySlug,
    };

    try {
      const [pullRequestPage, pipelineResult] = await Promise.all([
        this.client.listPullRequests({ ...location, state: pullRequestState }),
        this.loadPipelines(location),
      ]);
      const pipelineByPullRequestId = indexPipelinesByPullRequestId(pipelineResult.values);
      const pullRequests = pullRequestPage.values
        .map((rawPullRequest) => mapPullRequest(rawPullRequest, {
          ...location,
          pipelineByPullRequestId,
        }))
        .sort((left, right) => Date.parse(right.updatedOn || 0) - Date.parse(left.updatedOn || 0));

      return {
        repositorySlug,
        pullRequests,
        truncated: Boolean(pullRequestPage.truncated),
        pipelinesUnavailable: pipelineResult.unavailable,
        error: null,
        loadedAt: new Date().toISOString(),
      };
    } catch (error) {
      if (isCredentialError(error)) {
        this.logger.error('Bitbucket authentication failed', {
          repositorySlug,
          statusCode: error.statusCode || null,
          message: error.message,
        });
        throw error;
      }

      this.logger.error('Bitbucket repository snapshot failed', {
        repositorySlug,
        pullRequestState,
        statusCode: error.statusCode || null,
        message: error.message,
      });

      return {
        repositorySlug,
        pullRequests: [],
        truncated: false,
        pipelinesUnavailable: false,
        error: error.message || 'Unable to load this repository.',
        loadedAt: new Date().toISOString(),
      };
    }
  }

  /**
   * Pipeline permission or "pipelines not enabled" failures leave pull requests visible.
   * A bad token still rejects the whole board.
   * @param {{ workspace: string, repositorySlug: string }} location
   * @returns {Promise<{ values: object[], unavailable: boolean }>}
   */
  async loadPipelines(location) {
    try {
      const pipelinePage = await this.client.listPipelines(location);
      return { values: pipelinePage.values || [], unavailable: false };
    } catch (error) {
      if (isCredentialError(error)) throw error;
      this.logger.warn('Bitbucket pipeline status is unavailable', {
        repositorySlug: location.repositorySlug,
        statusCode: error.statusCode || null,
        message: error.message,
      });
      return { values: [], unavailable: true };
    }
  }

  /**
   * @param {object} snapshot
   * @returns {object}
   */
  toSummary(snapshot) {
    const counts = summarizeRepository(snapshot.pullRequests);
    return {
      slug: snapshot.repositorySlug,
      ...counts,
      countsByUser: summarizeCountsByUser(snapshot.pullRequests),
      error: snapshot.error,
      pipelinesUnavailable: snapshot.pipelinesUnavailable,
    };
  }

  /**
   * @param {object} snapshot
   * @param {string} viewState
   * @returns {object}
   */
  toRepositoryView(snapshot, viewState) {
    const slug = snapshot.repositorySlug;
    const workspace = this.config.workspace;
    return {
      slug,
      htmlUrl: `https://bitbucket.org/${workspace}/${slug}/pull-requests/`,
      newPullRequestUrl: `https://bitbucket.org/${workspace}/${slug}/pull-requests/new`,
      error: snapshot.error,
      truncated: snapshot.truncated,
      pipelinesUnavailable: snapshot.pipelinesUnavailable,
      loadedAt: snapshot.loadedAt,
      pullRequests: snapshot.error ? [] : selectPullRequestsForView(snapshot.pullRequests, viewState),
    };
  }
}

/**
 * @param {string[]} timestamps
 * @returns {string}
 */
/**
 * Per-user counts so the page can recalculate the summary for a subset of BITBUCKET_USERS.
 * A pull request opened by one watched user is counted only for that user.
 * @param {object[]} pullRequests
 * @returns {object}
 */
function summarizeCountsByUser(pullRequests) {
  const countsByUser = {};

  function increment(userId, fieldName) {
    if (!countsByUser[userId]) {
      countsByUser[userId] = {
        openCount: 0,
        draftCount: 0,
        approvedCount: 0,
        changesRequestedCount: 0,
        buildFailedCount: 0,
        buildInProgressCount: 0,
      };
    }
    countsByUser[userId][fieldName] += 1;
  }

  for (const pullRequest of pullRequests) {
    const matchedUsers = pullRequest.matchedUsers || [];
    for (const userId of matchedUsers) {
      if (pullRequest.draft) {
        increment(userId, 'draftCount');
        continue;
      }
      increment(userId, 'openCount');
      if (pullRequest.review?.overall === 'approved') increment(userId, 'approvedCount');
      if (pullRequest.review?.overall === 'changes_requested') increment(userId, 'changesRequestedCount');
      if (pullRequest.build?.overall === 'FAILED') increment(userId, 'buildFailedCount');
      if (pullRequest.build?.overall === 'INPROGRESS') increment(userId, 'buildInProgressCount');
    }
  }

  return countsByUser;
}

function oldestTimestamp(timestamps) {
  const parsed = timestamps
    .map((value) => Date.parse(value || ''))
    .filter((value) => !Number.isNaN(value));
  if (parsed.length === 0) return new Date().toISOString();
  return new Date(Math.min(...parsed)).toISOString();
}

/**
 * Runs `mapper` over `items` with a fixed number of workers.
 * The index increment happens before the first await, so two workers cannot
 * take the same item.
 * @template T, R
 * @param {T[]} items
 * @param {number} concurrencyLimit
 * @param {(item: T, index: number) => Promise<R>} mapper
 * @returns {Promise<R[]>}
 */
async function mapWithConcurrency(items, concurrencyLimit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.min(Math.max(concurrencyLimit, 1), items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
