import { REPOSITORY_FETCH_CONCURRENCY } from './bitbucketConstants.js';
import { collectReviewers, summarizeReview } from './pullRequestStatus.js';
import {
  createUserMatchers,
  pullRequestMatchesWatchedUsers,
  commitMatchesWatchedUsers,
  buildAuthorIdentityKeys,
} from './watchedUsers.js';

const ACTIVITY_CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutes cache

/**
 * Runs a mapping function over items with concurrency control.
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

export class BitbucketActivityService {
  /**
   * @param {{ client: object, config: object, logger: object, userDirectory?: object }} dependencies
   */
  constructor(dependencies) {
    this.client = dependencies.client;
    this.config = dependencies.config;
    this.logger = dependencies.logger;
    this.userDirectory = dependencies.userDirectory || null;
    this.activityCache = new Map();
    this.diffstatCache = new Map();
  }

  /**
   * @param {{ user?: string, repository?: string|null, days?: number, bypassCache?: boolean }} query
   * @returns {Promise<object>}
   */
  async getUserActivity(query) {
    const days = Math.max(1, Math.min(180, Number(query.days) || 30));
    const bypassCache = Boolean(query.bypassCache);
    const targetRepoSlug = String(query.repository || '').trim();

    // Determine target repositories
    let targetRepositories = this.config.repositories;
    if (targetRepoSlug) {
      if (!this.config.repositories.includes(targetRepoSlug)) {
        throw new Error(`Repository "${targetRepoSlug}" is not in the watched repository list.`);
      }
      targetRepositories = [targetRepoSlug];
    }

    // Determine target user
    const requestedUser = String(query.user || '').trim();
    const defaultUser = (this.config.users || [])[0] || '';
    const activeUserId = requestedUser || defaultUser;

    const cacheKey = `${activeUserId}:${targetRepositories.sort().join(',')}:${days}`;
    const now = Date.now();
    const cached = this.activityCache.get(cacheKey);
    if (!bypassCache && cached && cached.expiresAtMs > now) {
      return cached.data;
    }

    const cutoffDate = new Date(now - days * 24 * 60 * 60 * 1000);

    // Build user matchers
    const userIdentifiers = activeUserId ? [activeUserId] : (this.config.users || []);
    const matchers = await createUserMatchers(userIdentifiers, this.userDirectory);
    const primaryMatcher = matchers[0] || {
      identifier: activeUserId || 'All users',
      label: activeUserId || 'All users',
      keys: new Set(),
    };

    // Load PRs and Commits across target repositories
    const repoResults = await mapWithConcurrency(
      targetRepositories,
      REPOSITORY_FETCH_CONCURRENCY,
      async (repositorySlug) => {
        return this.loadRepositoryActivity(repositorySlug, cutoffDate, matchers);
      }
    );

    // Flatten PRs and Commits
    const allPullRequests = [];
    const allCommits = [];
    const byRepositoryMap = new Map();

    for (const res of repoResults) {
      if (res.error) continue;
      for (const pr of res.pullRequests) {
        allPullRequests.push(pr);
      }
      for (const commit of res.commits) {
        allCommits.push(commit);
      }

      byRepositoryMap.set(res.repositorySlug, {
        repository: res.repositorySlug,
        prs: res.pullRequests.length,
        linesAdded: res.linesAdded,
        linesRemoved: res.linesRemoved,
        commits: res.commits.length,
      });
    }

    // Sort pull requests by createdOn or updatedOn descending
    allPullRequests.sort((a, b) => new Date(b.createdOn) - new Date(a.createdOn));
    allCommits.sort((a, b) => new Date(b.date) - new Date(a.date));

    // Calculate totals
    const totalPRs = allPullRequests.length;
    let mergedPRs = 0;
    let openPRs = 0;
    let declinedPRs = 0;
    let totalLinesAdded = 0;
    let totalLinesRemoved = 0;

    for (const pr of allPullRequests) {
      if (pr.state === 'MERGED') mergedPRs += 1;
      else if (pr.state === 'OPEN') openPRs += 1;
      else if (pr.state === 'DECLINED') declinedPRs += 1;

      totalLinesAdded += pr.linesAdded || 0;
      totalLinesRemoved += pr.linesRemoved || 0;
    }

    const totalCommits = allCommits.length;

    // Build byRepository list with percentage
    const byRepository = Array.from(byRepositoryMap.values())
      .filter((item) => item.prs > 0 || item.commits > 0)
      .map((item) => {
        const percentage = totalPRs > 0 ? Math.round((item.prs / totalPRs) * 100) : 0;
        return {
          ...item,
          percentage,
        };
      })
      .sort((a, b) => b.prs - a.prs || b.commits - a.commits);

    const data = {
      workspace: this.config.workspace,
      user: {
        id: primaryMatcher.identifier,
        label: primaryMatcher.label,
      },
      availableUsers: (this.config.users || []).map((u) => ({ id: u, label: u })),
      days,
      repositories: targetRepositories,
      selectedRepository: targetRepoSlug || null,
      generatedAt: new Date().toISOString(),
      summary: {
        totalPRs,
        mergedPRs,
        openPRs,
        declinedPRs,
        totalCommits,
        linesAdded: totalLinesAdded,
        linesRemoved: totalLinesRemoved,
      },
      byRepository,
      pullRequests: allPullRequests,
      commits: allCommits,
    };

    this.activityCache.set(cacheKey, {
      expiresAtMs: now + ACTIVITY_CACHE_TTL_MS,
      data,
    });

    return data;
  }

  /**
   * @param {string} repositorySlug
   * @param {Date} cutoffDate
   * @param {object[]} matchers
   * @returns {Promise<object>}
   */
  async loadRepositoryActivity(repositorySlug, cutoffDate, matchers) {
    const workspace = this.config.workspace;
    try {
      // 1. Fetch Pull Requests in all relevant states
      const prResult = await this.client.listPullRequests({
        workspace,
        repositorySlug,
        states: ['OPEN', 'MERGED', 'DECLINED'],
        maxPages: 3,
        stopPredicate: (values) => {
          if (!values || values.length === 0) return false;
          const oldest = values[values.length - 1];
          const itemDate = new Date(oldest.created_on || oldest.updated_on);
          return itemDate < cutoffDate;
        },
      });

      // Filter PRs within cutoff and matching user
      const relevantRawPRs = (prResult.values || []).filter((rawPR) => {
        const created = new Date(rawPR.created_on);
        const updated = new Date(rawPR.updated_on);
        if (created < cutoffDate && updated < cutoffDate) {
          return false;
        }
        if (matchers.length > 0) {
          const authorKeys = buildAuthorIdentityKeys(rawPR.author);
          const matches = matchers.some((m) => authorKeys.some((k) => m.keys.has(k)));
          if (!matches) return false;
        }
        return true;
      });

      // Fetch diffstat for relevant PRs with concurrency limit
      const pullRequests = await mapWithConcurrency(
        relevantRawPRs,
        4,
        async (rawPR) => {
          const diff = await this.getDiffstat(workspace, repositorySlug, rawPR.id, rawPR.state);
          const reviewers = collectReviewers(rawPR);
          const hasConflict = Boolean(
            rawPR.has_conflict || rawPR.hasConflict || (Array.isArray(rawPR.conflicts) && rawPR.conflicts.length > 0)
          );
          const review = summarizeReview(reviewers, { commentCount: Number(rawPR.comment_count) || 0 });
          return {
            id: rawPR.id,
            title: rawPR.title,
            state: rawPR.state,
            draft: Boolean(rawPR.draft),
            repositorySlug,
            createdOn: rawPR.created_on,
            updatedOn: rawPR.updated_on,
            commentCount: rawPR.comment_count || 0,
            taskCount: rawPR.task_count || 0,
            sourceBranch: rawPR.source?.branch?.name || 'unknown',
            destinationBranch: rawPR.destination?.branch?.name || 'main',
            htmlUrl: rawPR.links?.html?.href || `https://bitbucket.org/${workspace}/${repositorySlug}/pull-requests/${rawPR.id}`,
            author: {
              displayName: rawPR.author?.display_name || 'Unknown',
              nickname: rawPR.author?.nickname || '',
              avatarUrl: rawPR.author?.links?.avatar?.href || '',
            },
            linesAdded: diff.linesAdded,
            linesRemoved: diff.linesRemoved,
            review,
            hasBeenReviewed: review.hasBeenReviewed,
            reviewState: review.reviewState,
            reviewStateLabel: review.reviewStateLabel,
            hasConflict,
            conflict: {
              hasConflict,
              count: hasConflict ? 1 : 0,
              files: Array.isArray(rawPR.conflicts) ? rawPR.conflicts : [],
            },
          };
        }
      );

      let repoLinesAdded = 0;
      let repoLinesRemoved = 0;
      for (const pr of pullRequests) {
        repoLinesAdded += pr.linesAdded;
        repoLinesRemoved += pr.linesRemoved;
      }

      // 2. Fetch Commits
      const commitResult = await this.client.listCommits({
        workspace,
        repositorySlug,
        maxPages: 3,
        stopPredicate: (values) => {
          if (!values || values.length === 0) return false;
          const oldest = values[values.length - 1];
          const commitDate = new Date(oldest.date);
          return commitDate < cutoffDate;
        },
      });

      const commits = [];
      for (const rawCommit of commitResult.values || []) {
        const commitDate = new Date(rawCommit.date);
        if (commitDate < cutoffDate) continue;

        if (matchers.length > 0 && !commitMatchesWatchedUsers(rawCommit, matchers)) {
          continue;
        }

        const message = String(rawCommit.message || '').trim();
        const firstLine = message.split('\n')[0] || 'No message';
        const authorName = rawCommit.author?.user?.display_name ||
          rawCommit.author?.raw?.replace(/<[^>]+>/, '').trim() ||
          rawCommit.author?.raw || 'Unknown';

        commits.push({
          hash: rawCommit.hash,
          shortHash: (rawCommit.hash || '').slice(0, 7),
          message: firstLine,
          fullMessage: message,
          date: rawCommit.date,
          repositorySlug,
          authorName,
          htmlUrl: rawCommit.links?.html?.href || `https://bitbucket.org/${workspace}/${repositorySlug}/commits/${rawCommit.hash}`,
        });
      }

      return {
        repositorySlug,
        pullRequests,
        commits,
        linesAdded: repoLinesAdded,
        linesRemoved: repoLinesRemoved,
      };
    } catch (error) {
      this.logger.warn('Failed to load activity for repository', {
        repositorySlug,
        message: error.message,
      });
      return {
        repositorySlug,
        error: error.message,
        pullRequests: [],
        commits: [],
        linesAdded: 0,
        linesRemoved: 0,
      };
    }
  }

  /**
   * Cached diffstat helper.
   * @param {string} workspace
   * @param {string} repositorySlug
   * @param {number|string} pullRequestId
   * @param {string} state
   * @returns {Promise<{ linesAdded: number, linesRemoved: number }>}
   */
  async getDiffstat(workspace, repositorySlug, pullRequestId, state) {
    const key = `${workspace}:${repositorySlug}:${pullRequestId}`;
    if (this.diffstatCache.has(key)) {
      return this.diffstatCache.get(key);
    }

    const diff = await this.client.getPullRequestDiffstat(workspace, repositorySlug, pullRequestId);
    // Closed or merged PRs will never change diffstat, so cache them permanently.
    // Open PRs can also be cached in memory during service lifetime.
    this.diffstatCache.set(key, diff);
    return diff;
  }
}
