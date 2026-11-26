import { REPOSITORY_FETCH_CONCURRENCY } from './bitbucketConstants.js';
import { isCredentialError } from './bitbucketErrors.js';

/**
 * Matches the convention `release/vX.X.X` (and optional 4th hotfix segment `release/vX.X.X.X`
 * or missing `v` prefix `release/X.X.X`).
 */
export const RELEASE_BRANCH_PATTERN = /^release\/v?(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?$/i;

/**
 * Extracts a clean author display name from a Bitbucket commit object.
 * @param {object|null|undefined} commit
 * @returns {string}
 */
export function extractCommitAuthor(commit) {
  if (!commit || !commit.author) return 'Unknown';
  if (commit.author.user?.display_name) return commit.author.user.display_name;
  if (commit.author.user?.displayName) return commit.author.user.displayName;
  if (typeof commit.author.raw === 'string') {
    const raw = commit.author.raw.trim();
    const angleIndex = raw.indexOf('<');
    if (angleIndex > 0) return raw.slice(0, angleIndex).trim();
    return raw || 'Unknown';
  }
  return 'Unknown';
}

/**
 * Parses a raw Bitbucket branch ref into a structured semantic release branch object.
 * Returns null if the branch name does not follow the release convention `release/vX.X.X`.
 * @param {object} rawBranch
 * @param {{ workspace?: string, repositorySlug?: string }} [context]
 * @returns {object|null}
 */
export function parseReleaseBranch(rawBranch, context = {}) {
  const branchName = String(rawBranch?.name || '').trim();
  const match = branchName.match(RELEASE_BRANCH_PATTERN);
  if (!match) return null;

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  const hotfix = match[4] !== undefined ? Number(match[4]) : null;

  const workspace = context.workspace || '';
  const repositorySlug = context.repositorySlug || '';
  const target = rawBranch?.target || {};
  const targetHash = String(target.hash || '');
  const shortHash = targetHash ? targetHash.slice(0, 8) : '';
  const targetDate = target.date || null;
  const targetAuthor = extractCommitAuthor(target);
  const targetMessage = String(target.message || '').split('\n')[0].trim();

  const encodedBranch = branchName.split('/').map(encodeURIComponent).join('/');
  const htmlUrl = rawBranch?.links?.html?.href
    || (workspace && repositorySlug ? `https://bitbucket.org/${workspace}/${repositorySlug}/branch/${encodedBranch}` : '');
  const commitsUrl = workspace && repositorySlug
    ? `https://bitbucket.org/${workspace}/${repositorySlug}/commits/branch/${encodedBranch}`
    : '';

  return {
    name: branchName,
    major,
    minor,
    patch,
    hotfix,
    minorKey: `v${major}.${minor}`,
    minorLabel: `v${major}.${minor}.x`,
    versionLabel: `v${major}.${minor}.${patch}${hotfix !== null ? `.${hotfix}` : ''}`,
    targetHash,
    shortHash,
    targetDate,
    targetAuthor,
    targetMessage,
    htmlUrl,
    commitsUrl,
  };
}

/**
 * Compares two parsed release branches in ascending semantic version order.
 * @param {object} left
 * @param {object} right
 * @returns {number}
 */
export function compareReleaseBranchesAsc(left, right) {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  if (left.patch !== right.patch) return left.patch - right.patch;
  return (left.hotfix ?? -1) - (right.hotfix ?? -1);
}

/**
 * Compares two parsed release branches in descending semantic version order.
 * @param {object} left
 * @param {object} right
 * @returns {number}
 */
export function compareReleaseBranchesDesc(left, right) {
  return compareReleaseBranchesAsc(right, left);
}

/**
 * Groups parsed release branches by `(major, minor)` version and returns the groups
 * ordered from newest minor to oldest minor.
 * @param {object[]} parsedBranches
 * @returns {Array<{ minorKey: string, major: number, minor: number, branches: object[] }>}
 */
export function groupBranchesByMinor(parsedBranches) {
  const sortedAsc = [...parsedBranches].sort(compareReleaseBranchesAsc);
  const groupsMap = new Map();

  for (const branch of sortedAsc) {
    const key = branch.minorKey;
    if (!groupsMap.has(key)) {
      groupsMap.set(key, {
        minorKey: key,
        major: branch.major,
        minor: branch.minor,
        branches: [],
      });
    }
    groupsMap.get(key).branches.push(branch);
  }

  return Array.from(groupsMap.values()).reverse();
}

/**
 * Service that loads release branches (`release/vX.X.X`) across watched repositories,
 * resolves the creation (cut) date and last update date for the last N minor versions
 * (default: 2), and caches snapshots for fast dashboard and Microsoft Teams export.
 */
export class BitbucketReleaseService {
  /**
   * @param {{ client: object, config: object, logger: object }} dependencies
   */
  constructor(dependencies) {
    this.client = dependencies.client;
    this.config = dependencies.config;
    this.logger = dependencies.logger;
    this.repositoryCache = new Map();
    this.inFlightRequests = new Map();
    this.branchLifecycleCache = new Map();
    this.commitCache = new Map();
  }

  /**
   * Loads the release tracking board for all watched repositories (or a single filtered repository).
   * @param {{ repositorySlug?: string|null, minorLimit?: number, bypassCache?: boolean }} [query]
   * @returns {Promise<object>}
   */
  async getReleasesBoard(query = {}) {
    const repositorySlug = query.repositorySlug || null;
    const minorLimit = Math.max(1, Math.min(10, Number(query.minorLimit) || 2));
    const bypassCache = Boolean(query.bypassCache);

    const targetSlugs = repositorySlug ? [repositorySlug] : this.config.repositories;
    const allSnapshots = await this.loadRepositories(this.config.repositories, minorLimit, bypassCache);

    const visibleRepositories = allSnapshots.filter((repo) => targetSlugs.includes(repo.slug));
    const summaries = allSnapshots.map((repo) => ({
      slug: repo.slug,
      totalReleaseBranches: repo.totalReleaseBranches,
      totalMinors: repo.totalMinors,
      latestMinorKey: repo.minors[0]?.minorKey || null,
      latestBranchName: repo.minors[0]?.latestBranchName || null,
      latestCreatedAt: repo.minors[0]?.createdAt || null,
      latestUpdatedAt: repo.minors[0]?.updatedAt || null,
      previousMinorKey: repo.minors[1]?.minorKey || null,
      error: repo.error,
    }));

    return {
      workspace: this.config.workspace,
      generatedAt: new Date().toISOString(),
      syncedAt: oldestTimestamp(visibleRepositories.map((r) => r.loadedAt)),
      refreshIntervalMs: this.config.refreshIntervalMs,
      minorLimit,
      repository: repositorySlug,
      summaries,
      repositories: visibleRepositories,
    };
  }

  /**
   * @param {string[]} repositorySlugs
   * @param {number} minorLimit
   * @param {boolean} bypassCache
   * @returns {Promise<object[]>}
   */
  async loadRepositories(repositorySlugs, minorLimit, bypassCache) {
    return mapWithConcurrency(repositorySlugs, REPOSITORY_FETCH_CONCURRENCY, (slug) => {
      return this.loadRepositoryReleases(slug, minorLimit, bypassCache);
    });
  }

  /**
   * @param {string} repositorySlug
   * @param {number} minorLimit
   * @param {boolean} bypassCache
   * @returns {Promise<object>}
   */
  async loadRepositoryReleases(repositorySlug, minorLimit, bypassCache) {
    const cacheKey = `${this.config.workspace}:${repositorySlug}:minors=${minorLimit}`;
    const nowMs = Date.now();
    const cached = this.repositoryCache.get(cacheKey);

    if (!bypassCache && cached && cached.expiresAtMs > nowMs) {
      return cached.value;
    }

    if (!bypassCache && this.inFlightRequests.has(cacheKey)) {
      return this.inFlightRequests.get(cacheKey);
    }

    const request = this.fetchRepositoryReleases(repositorySlug, minorLimit)
      .then((snapshot) => {
        this.repositoryCache.set(cacheKey, {
          expiresAtMs: Date.now() + (this.config.cacheTtlMs || 60000),
          value: snapshot,
        });
        return snapshot;
      })
      .finally(() => {
        this.inFlightRequests.delete(cacheKey);
      });

    this.inFlightRequests.set(cacheKey, request);
    return request;
  }

  /**
   * Fetches all `release/vX.X.X` branches for a repository, groups them by minor version,
   * and resolves creation (cut) date and last update date for the last `minorLimit` minors.
   * @param {string} repositorySlug
   * @param {number} minorLimit
   * @returns {Promise<object>}
   */
  async fetchRepositoryReleases(repositorySlug, minorLimit) {
    const workspace = this.config.workspace;

    try {
      const branchPage = await this.client.listReleaseBranches({
        workspace,
        repositorySlug,
        prefix: 'release/',
      });

      const rawBranches = Array.isArray(branchPage?.values) ? branchPage.values : [];
      const parsedAsc = rawBranches
        .map((raw) => parseReleaseBranch(raw, { workspace, repositorySlug }))
        .filter(Boolean)
        .sort(compareReleaseBranchesAsc);

      const allMinorGroupsDesc = groupBranchesByMinor(parsedAsc);
      const selectedMinorGroups = allMinorGroupsDesc.slice(0, minorLimit);

      const enrichedMinors = [];
      for (const group of selectedMinorGroups) {
        const enrichedBranches = [];
        for (const branch of group.branches) {
          const branchIndex = parsedAsc.indexOf(branch);
          const previousBranch = branchIndex > 0 ? parsedAsc[branchIndex - 1] : null;
          const lifecycle = await this.resolveBranchLifecycle(repositorySlug, branch, previousBranch);
          enrichedBranches.push({
            ...branch,
            ...lifecycle,
          });
        }

        const initialBranch = enrichedBranches[0];
        const highestBranch = enrichedBranches[enrichedBranches.length - 1];
        const mostRecentBranch = [...enrichedBranches].sort((left, right) => {
          const timeDiff = Date.parse(right.updatedAt || 0) - Date.parse(left.updatedAt || 0);
          if (timeDiff !== 0) return timeDiff;
          return compareReleaseBranchesDesc(left, right);
        })[0];

        const postCutCommitsCount = enrichedBranches.reduce(
          (sum, b) => sum + (b.postCutCommitsCount || 0),
          0
        );

        const createdAt = initialBranch.createdAt;
        const updatedAt = mostRecentBranch.updatedAt;
        const durationDays = computeDaysBetween(createdAt, updatedAt);

        enrichedMinors.push({
          minorKey: group.minorKey,
          major: group.major,
          minor: group.minor,
          initialBranchName: initialBranch.name,
          latestBranchName: highestBranch.name,
          lastUpdatedBranchName: mostRecentBranch.name,
          branchNames: enrichedBranches.map((b) => b.name),
          patchCount: enrichedBranches.length,
          createdAt,
          createdBy: initialBranch.createdBy,
          firstCommitAt: initialBranch.firstCommitAt,
          updatedAt,
          updatedBy: mostRecentBranch.updatedBy,
          latestCommitHash: mostRecentBranch.shortHash,
          latestCommitMessage: mostRecentBranch.targetMessage,
          postCutCommitsCount,
          durationDays,
          htmlUrl: highestBranch.htmlUrl,
          initialHtmlUrl: initialBranch.htmlUrl,
          commitsUrl: mostRecentBranch.commitsUrl,
          branches: enrichedBranches,
        });
      }

      return {
        slug: repositorySlug,
        htmlUrl: `https://bitbucket.org/${workspace}/${repositorySlug}/branches/`,
        totalReleaseBranches: parsedAsc.length,
        totalMinors: allMinorGroupsDesc.length,
        minors: enrichedMinors,
        truncated: Boolean(branchPage?.truncated),
        error: null,
        loadedAt: new Date().toISOString(),
      };
    } catch (error) {
      if (isCredentialError(error)) {
        this.logger.error('Bitbucket authentication failed while loading releases', {
          repositorySlug,
          statusCode: error.statusCode || null,
          message: error.message,
        });
        throw error;
      }

      this.logger.error('Bitbucket repository release lookup failed', {
        repositorySlug,
        statusCode: error.statusCode || null,
        message: error.message,
      });

      return {
        slug: repositorySlug,
        htmlUrl: `https://bitbucket.org/${workspace}/${repositorySlug}/branches/`,
        totalReleaseBranches: 0,
        totalMinors: 0,
        minors: [],
        truncated: false,
        error: error.message || 'Unable to load release branches for this repository.',
        loadedAt: new Date().toISOString(),
      };
    }
  }

  /**
   * Determines when a release branch was cut (`createdAt`) and when it was last updated (`updatedAt`).
   * - `updatedAt` is the date of the HEAD commit on the branch (`branch.targetDate`).
   * - `createdAt` is the date of the fork/cut commit on `main` (or previous release branch) where
   *   this release branch diverged, falling back to the earliest commit on the branch or `targetDate`.
   * @param {string} repositorySlug
   * @param {object} branch
   * @param {object|null} previousBranch
   * @returns {Promise<{ createdAt: string|null, createdBy: string, firstCommitAt: string|null, updatedAt: string|null, updatedBy: string, postCutCommitsCount: number, baseCommitHash: string }>}
   */
  async resolveBranchLifecycle(repositorySlug, branch, previousBranch) {
    const workspace = this.config.workspace;
    const prevKey = previousBranch ? previousBranch.name : '';
    const lifecycleKey = `${workspace}:${repositorySlug}:${branch.name}:${branch.targetHash}:${prevKey}`;

    if (branch.targetHash && this.branchLifecycleCache.has(lifecycleKey)) {
      return this.branchLifecycleCache.get(lifecycleKey);
    }

    let createdAt = branch.targetDate;
    let createdBy = branch.targetAuthor;
    let firstCommitAt = branch.targetDate;
    let postCutCommitsCount = 0;
    let baseCommitHash = branch.targetHash;

    if (typeof this.client?.listBranchCommits === 'function') {
      try {
        const excludes = ['main'];
        if (previousBranch?.name) {
          excludes.push(previousBranch.name);
        }
        const commitPage = await this.client.listBranchCommits({
          workspace,
          repositorySlug,
          include: branch.name,
          excludes,
          maxPages: 2,
        });

        const commits = Array.isArray(commitPage?.values) ? commitPage.values : [];
        postCutCommitsCount = commits.length;

        if (commits.length > 0) {
          const oldestBranchCommit = commits[commits.length - 1];
          firstCommitAt = oldestBranchCommit.date || branch.targetDate;
          createdBy = extractCommitAuthor(oldestBranchCommit) || branch.targetAuthor;
          createdAt = firstCommitAt;

          const parentHash = oldestBranchCommit.parents?.[0]?.hash;
          if (parentHash) {
            baseCommitHash = parentHash;
            const parentCommit = await this.loadCommit(repositorySlug, parentHash);
            if (parentCommit?.date) {
              createdAt = parentCommit.date;
            }
          }
        }
      } catch (error) {
        this.logger.warn('Could not inspect branch commit history for release cut date; using target date', {
          repositorySlug,
          branch: branch.name,
          message: error.message,
        });
      }
    }

    const result = {
      createdAt,
      createdBy,
      firstCommitAt,
      updatedAt: branch.targetDate,
      updatedBy: branch.targetAuthor,
      postCutCommitsCount,
      baseCommitHash: baseCommitHash ? baseCommitHash.slice(0, 8) : '',
    };

    if (branch.targetHash) {
      this.branchLifecycleCache.set(lifecycleKey, result);
    }
    return result;
  }

  /**
   * Loads and caches a single commit by hash.
   * @param {string} repositorySlug
   * @param {string} commitHash
   * @returns {Promise<object|null>}
   */
  async loadCommit(repositorySlug, commitHash) {
    if (!commitHash || typeof this.client?.getCommit !== 'function') return null;
    const cacheKey = `${this.config.workspace}:${repositorySlug}:${commitHash}`;
    if (this.commitCache.has(cacheKey)) {
      return this.commitCache.get(cacheKey);
    }
    const commit = await this.client.getCommit(this.config.workspace, repositorySlug, commitHash);
    if (commit) {
      this.commitCache.set(cacheKey, commit);
    }
    return commit;
  }
}

/**
 * Computes whole days between two ISO timestamps.
 * @param {string|null} startIso
 * @param {string|null} endIso
 * @returns {number}
 */
function computeDaysBetween(startIso, endIso) {
  const startMs = Date.parse(startIso || '');
  const endMs = Date.parse(endIso || '');
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return 0;
  return Math.max(0, Math.round((endMs - startMs) / (1000 * 60 * 60 * 24)));
}

/**
 * @param {string[]} timestamps
 * @returns {string}
 */
function oldestTimestamp(timestamps) {
  const parsed = timestamps
    .map((value) => Date.parse(value || ''))
    .filter((value) => !Number.isNaN(value));
  if (parsed.length === 0) return new Date().toISOString();
  return new Date(Math.min(...parsed)).toISOString();
}

/**
 * Runs `mapper` over `items` with a fixed concurrency limit.
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
