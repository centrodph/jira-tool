import { BITBUCKET_API_ROOT, BITBUCKET_MAX_PAGES, BITBUCKET_PAGE_LENGTH, BITBUCKET_REQUEST_TIMEOUT_MS } from './bitbucketConstants.js';
import { BitbucketRequestError, createBitbucketHttpError } from './bitbucketErrors.js';

/**
 * Thin client for the Bitbucket Cloud REST endpoints the status board needs.
 * Pull request rows come from the pullrequests collection. Build state comes
 * from the recent pipelines collection so a repository costs two requests
 * instead of one request per pull request.
 */
export class BitbucketClient {
  /**
   * @param {{ email: string, apiToken: string, logger: { info: Function, warn: Function, error: Function }, fetchImpl?: typeof fetch, timeoutMs?: number }} options
   */
  constructor(options) {
    if (!options.email || !options.apiToken) {
      throw new BitbucketRequestError('Bitbucket credentials are missing.', { statusCode: 503 });
    }

    this.logger = options.logger;
    this.fetchImpl = options.fetchImpl || fetch;
    this.timeoutMs = options.timeoutMs || BITBUCKET_REQUEST_TIMEOUT_MS;
    // Basic auth is the form Atlassian API tokens use against Bitbucket Cloud.
    this.authorizationHeader = `Basic ${Buffer.from(`${options.email}:${options.apiToken}`).toString('base64')}`;
  }

  /**
   * @param {{ workspace: string, repositorySlug: string, state?: string, states?: string[], maxPages?: number, stopPredicate?: Function }} query
   * @returns {Promise<{ values: object[], truncated: boolean }>}
   */
  async listPullRequests(query) {
    const parameters = new URLSearchParams({
      pagelen: String(BITBUCKET_PAGE_LENGTH),
      sort: '-updated_on',
    });
    if (Array.isArray(query.states)) {
      for (const state of query.states) {
        parameters.append('state', state);
      }
    } else if (query.state) {
      parameters.set('state', query.state);
    }

    const path = `/repositories/${encodeURIComponent(query.workspace)}/${encodeURIComponent(query.repositorySlug)}/pullrequests?${parameters}`;
    return this.collectPages(path, {
      repositorySlug: query.repositorySlug,
      maxPages: query.maxPages || BITBUCKET_MAX_PAGES,
      stopPredicate: query.stopPredicate,
    });
  }

  /**
   * Lists recent commits for a repository.
   * @param {{ workspace: string, repositorySlug: string, maxPages?: number, stopPredicate?: (values: object[]) => boolean }} query
   * @returns {Promise<{ values: object[], truncated: boolean }>}
   */
  async listCommits(query) {
    const parameters = new URLSearchParams({
      pagelen: '100',
    });
    const path = `/repositories/${encodeURIComponent(query.workspace)}/${encodeURIComponent(query.repositorySlug)}/commits?${parameters}`;
    return this.collectPages(path, {
      repositorySlug: query.repositorySlug,
      maxPages: query.maxPages || 2,
      stopPredicate: query.stopPredicate,
    });
  }

  /**
   * Fetches diffstat lines added and removed for a pull request.
   * @param {string} workspace
   * @param {string} repositorySlug
   * @param {number|string} pullRequestId
   * @returns {Promise<{ linesAdded: number, linesRemoved: number }>}
   */
  async getPullRequestDiffstat(workspace, repositorySlug, pullRequestId) {
    const path = `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repositorySlug)}/pullrequests/${encodeURIComponent(pullRequestId)}/diffstat`;
    try {
      const res = await this.collectPages(path, {
        repositorySlug,
        maxPages: 2,
      });
      let linesAdded = 0;
      let linesRemoved = 0;
      for (const entry of res.values) {
        linesAdded += Number(entry.lines_added) || 0;
        linesRemoved += Number(entry.lines_removed) || 0;
      }
      return { linesAdded, linesRemoved };
    } catch (error) {
      this.logger.warn('Could not load PR diffstat', {
        repositorySlug,
        pullRequestId,
        message: error.message,
      });
      return { linesAdded: 0, linesRemoved: 0 };
    }
  }

  /**
   * Newest pipelines first, so the first match for a pull request is its latest run.
   * @param {{ workspace: string, repositorySlug: string }} query
   * @returns {Promise<{ values: object[], truncated: boolean }>}
   */
  async listPipelines(query) {
    const parameters = new URLSearchParams({
      pagelen: String(BITBUCKET_PAGE_LENGTH),
      sort: '-created_on',
    });
    const path = `/repositories/${encodeURIComponent(query.workspace)}/${encodeURIComponent(query.repositorySlug)}/pipelines/?${parameters}`;
    return this.collectPages(path, {
      repositorySlug: query.repositorySlug,
      maxPages: 1,
    });
  }

  /**
   * Follows Bitbucket `next` links, but only while they stay on the official API host.
   * @param {string} initialPath
   * @param {{ repositorySlug: string, maxPages: number }} options
   * @returns {Promise<{ values: object[], truncated: boolean }>}
   */
  async collectPages(initialPath, options) {
    const values = [];
    let nextUrl = `${BITBUCKET_API_ROOT}${initialPath}`;
    let pageCount = 0;
    let truncated = false;

    while (nextUrl && pageCount < options.maxPages) {
      // Never send the API token to a host Bitbucket did not own. A bad `next`
      // link stops the walk and keeps the pages already collected.
      if (!this.isBitbucketApiUrl(nextUrl)) {
        this.logger.error('Stopped pagination because the next URL left the Bitbucket API', {
          repositorySlug: options.repositorySlug,
        });
        truncated = true;
        break;
      }

      const payload = await this.getJson(nextUrl, options.repositorySlug);
      if (Array.isArray(payload.values)) {
        values.push(...payload.values);
        if (typeof options.stopPredicate === 'function' && options.stopPredicate(payload.values)) {
          break;
        }
      }
      pageCount += 1;
      nextUrl = typeof payload.next === 'string' ? payload.next : '';
    }

    if (nextUrl) {
      // Another page exists. Keep the board responsive instead of walking the whole history.
      truncated = true;
    }

    return { values, truncated };
  }

  /**
   * @param {string} url
   * @returns {boolean}
   */
  isBitbucketApiUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' && parsed.hostname === 'api.bitbucket.org';
    } catch {
      return false;
    }
  }

  /**
   * @param {string} url
   * @param {string} repositorySlug
   * @returns {Promise<object>}
   */
  async getJson(url, repositorySlug) {
    let response;
    try {
      response = await this.fetchImpl(url, {
        headers: {
          Authorization: this.authorizationHeader,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof BitbucketRequestError) throw error;
      if (error.name === 'TimeoutError' || error.name === 'AbortError') {
        this.logger.error('Bitbucket request timed out', { repositorySlug, timeoutMs: this.timeoutMs });
        throw new BitbucketRequestError('Bitbucket did not respond before the timeout.', {
          statusCode: 504,
          cause: error,
        });
      }
      this.logger.error('Bitbucket network request failed', { repositorySlug, message: error.message });
      throw new BitbucketRequestError('Could not reach Bitbucket. Check the network connection.', {
        statusCode: 502,
        cause: error,
      });
    }

    if (!response.ok) {
      const bitbucketMessage = await this.readErrorMessage(response);
      this.logger.error('Bitbucket API returned an error', {
        repositorySlug,
        statusCode: response.status,
        message: bitbucketMessage,
      });
      throw createBitbucketHttpError(response.status, bitbucketMessage);
    }

    try {
      return await this.readJsonBody(response);
    } catch (error) {
      if (error instanceof BitbucketRequestError) throw error;
      throw new BitbucketRequestError('Bitbucket returned a response that was not valid JSON.', {
        statusCode: 502,
        cause: error,
      });
    }
  }

  /**
   * @param {{ text?: Function, json?: Function }} response
   * @returns {Promise<object>}
   */
  async readJsonBody(response) {
    if (typeof response.json === 'function') {
      return response.json();
    }
    const text = await response.text();
    return JSON.parse(text);
  }

  /**
   * @param {{ text?: Function }} response
   * @returns {Promise<string>}
   */
  async readErrorMessage(response) {
    if (typeof response.text !== 'function') {
      return 'Unknown Bitbucket error';
    }

    const body = await response.text();
    if (!body) return 'Unknown Bitbucket error';

    try {
      const parsed = JSON.parse(body);
      return parsed?.error?.message || parsed?.message || body.slice(0, 300);
    } catch {
      return body.slice(0, 300);
    }
  }
}
