import { createHash } from 'crypto';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { getBitbucketConfig } from './bitbucketConfig.js';
import { BitbucketClient } from './bitbucketClient.js';
import { PULL_REQUEST_VIEWS, REPOSITORY_SLUG_PATTERN } from './bitbucketConstants.js';
import { BitbucketRequestError } from './bitbucketErrors.js';
import { BitbucketStatusService } from './bitbucketStatusService.js';
import { getConfig } from './config.js';
import { JiraClient } from './jiraClient.js';
import { createLogger } from './logger.js';
import { renderRepositoriesPage } from './views/repositoriesPage.js';
import { renderActivityPage } from './views/activityPage.js';
import { renderReleasesPage } from './views/releasesPage.js';
import { BitbucketActivityService } from './bitbucketActivityService.js';
import { BitbucketReleaseService } from './bitbucketReleaseService.js';

const logger = createLogger('bitbucket-status');
let cachedService = null;
let cachedSignature = '';
let cachedActivityService = null;
let cachedActivitySignature = '';
let cachedReleaseService = null;
let cachedReleaseSignature = '';

/**
 * Reads the board query. Unknown repositories are rejected so this route
 * cannot be used as an open proxy to every slug in the workspace.
 * @param {object} query
 * @param {{ repositories: string[] }} bitbucketConfig
 * @returns {{ state: string, repositorySlug: string|null, bypassCache: boolean }}
 */
export function parseStatusQuery(query, bitbucketConfig) {
  const state = String(query.state || 'OPEN').trim().toUpperCase();
  if (!PULL_REQUEST_VIEWS.includes(state)) {
    throw new BitbucketRequestError('Unknown pull request view.', { statusCode: 400 });
  }

  const repositorySlug = String(query.repository || '').trim();
  if (repositorySlug && !REPOSITORY_SLUG_PATTERN.test(repositorySlug)) {
    throw new BitbucketRequestError('Repository slug is not valid.', { statusCode: 400 });
  }
  if (repositorySlug && !bitbucketConfig.repositories.includes(repositorySlug)) {
    throw new BitbucketRequestError(
      `"${repositorySlug}" is not in the watched repository list.`,
      { statusCode: 400 },
    );
  }

  const refresh = query.refresh === 'true' || query.refresh === '1';
  return {
    state,
    repositorySlug: repositorySlug || null,
    bypassCache: refresh,
  };
}

/**
 * Validates query parameters for the release tracker endpoint.
 * @param {object} query
 * @param {{ repositories: string[] }} bitbucketConfig
 * @returns {{ repositorySlug: string|null, minorLimit: number, bypassCache: boolean }}
 */
export function parseReleaseQuery(query, bitbucketConfig) {
  const repositorySlug = String(query.repository || '').trim();
  if (repositorySlug && !REPOSITORY_SLUG_PATTERN.test(repositorySlug)) {
    throw new BitbucketRequestError('Repository slug is not valid.', { statusCode: 400 });
  }
  if (repositorySlug && !bitbucketConfig.repositories.includes(repositorySlug)) {
    throw new BitbucketRequestError(
      `"${repositorySlug}" is not in the watched repository list.`,
      { statusCode: 400 },
    );
  }

  const rawMinors = query.minors !== undefined ? Number(query.minors) : 2;
  if (!Number.isInteger(rawMinors) || rawMinors < 1 || rawMinors > 10) {
    throw new BitbucketRequestError('Minor count must be an integer between 1 and 10.', { statusCode: 400 });
  }

  const refresh = query.refresh === 'true' || query.refresh === '1';
  return {
    repositorySlug: repositorySlug || null,
    minorLimit: rawMinors,
    bypassCache: refresh,
  };
}

/**
 * Recreates the cached service when the token or the watched list changes.
 * @param {object} bitbucketConfig
 * @returns {BitbucketStatusService}
 */
function getStatusService(bitbucketConfig) {
  const signature = createHash('sha256')
    .update([
      bitbucketConfig.email,
      bitbucketConfig.apiToken,
      bitbucketConfig.workspace,
      bitbucketConfig.repositories.join(','),
      (bitbucketConfig.users || []).join(','),
    ].join('\n'))
    .digest('hex');

  if (!cachedService || cachedSignature !== signature) {
    const client = new BitbucketClient({
      email: bitbucketConfig.email,
      apiToken: bitbucketConfig.apiToken,
      logger,
    });
    cachedService = new BitbucketStatusService({
      client,
      config: bitbucketConfig,
      logger,
      userDirectory: createJiraUserDirectory(),
    });
    cachedSignature = signature;
    logger.info('Prepared Bitbucket status service', {
      workspace: bitbucketConfig.workspace,
      repositoryCount: bitbucketConfig.repositories.length,
      userCount: (bitbucketConfig.users || []).length,
    });
  }

  return cachedService;
}

/**
 * @param {object} bitbucketConfig
 * @returns {BitbucketActivityService}
 */
function getActivityService(bitbucketConfig) {
  const signature = createHash('sha256')
    .update([
      bitbucketConfig.email,
      bitbucketConfig.apiToken,
      bitbucketConfig.workspace,
      bitbucketConfig.repositories.join(','),
      (bitbucketConfig.users || []).join(','),
    ].join('\n'))
    .digest('hex');

  if (!cachedActivityService || cachedActivitySignature !== signature) {
    const client = new BitbucketClient({
      email: bitbucketConfig.email,
      apiToken: bitbucketConfig.apiToken,
      logger,
    });
    cachedActivityService = new BitbucketActivityService({
      client,
      config: bitbucketConfig,
      logger,
      userDirectory: createJiraUserDirectory(),
    });
    cachedActivitySignature = signature;
  }

  return cachedActivityService;
}

/**
 * @param {object} bitbucketConfig
 * @returns {BitbucketReleaseService}
 */
function getReleaseService(bitbucketConfig) {
  const signature = createHash('sha256')
    .update([
      bitbucketConfig.email,
      bitbucketConfig.apiToken,
      bitbucketConfig.workspace,
      bitbucketConfig.repositories.join(','),
    ].join('\n'))
    .digest('hex');

  if (!cachedReleaseService || cachedReleaseSignature !== signature) {
    const client = new BitbucketClient({
      email: bitbucketConfig.email,
      apiToken: bitbucketConfig.apiToken,
      logger,
    });
    cachedReleaseService = new BitbucketReleaseService({
      client,
      config: bitbucketConfig,
      logger,
    });
    cachedReleaseSignature = signature;
    logger.info('Prepared Bitbucket release service', {
      workspace: bitbucketConfig.workspace,
      repositoryCount: bitbucketConfig.repositories.length,
    });
  }

  return cachedReleaseService;
}

/**
 * Resolves a BITBUCKET_USERS email to the Atlassian account that Bitbucket
 * stores on the pull request author. A lookup failure leaves name matching in place.
 * @returns {{ lookup: (identifier: string) => Promise<object|null> }}
 */
function createJiraUserDirectory() {
  const jiraClient = new JiraClient(getConfig());
  return {
    async lookup(identifier) {
      try {
        const matches = await jiraClient.searchUsers(identifier);
        const normalizedIdentifier = identifier.trim().toLowerCase();
        const exactEmailMatch = matches.find((user) => {
          return (user.emailAddress || '').toLowerCase() === normalizedIdentifier;
        });
        const namePart = normalizedIdentifier.split('@')[0].replace(/[._-]/g, ' ');
        const nameMatch = matches.find((user) => {
          const dName = (user.displayName || '').toLowerCase();
          return dName.includes(namePart) || namePart.includes(dName);
        });
        const resolvedUser = exactEmailMatch || (matches.length === 1 ? matches[0] : null) || nameMatch;
        if (!resolvedUser) return null;
        return {
          accountId: resolvedUser.accountId || '',
          displayName: resolvedUser.displayName || '',
          emailAddress: resolvedUser.emailAddress || '',
        };
      } catch (error) {
        logger.warn('Could not resolve a watched user through Jira', { message: error.message });
        return null;
      }
    },
  };
}

/**
 * @param {import('express').Express} app
 */
export function registerBitbucketRoutes(app) {
  const publicDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
  app.use('/repository-assets', express.static(publicDirectory));

  app.get('/repositories', (req, res) => {
    const bitbucketConfig = getBitbucketConfig();
    res.set('Cache-Control', 'no-store');
    res.type('html').send(renderRepositoriesPage({
      workspace: bitbucketConfig.workspace,
      repositories: bitbucketConfig.repositories,
      users: bitbucketConfig.users,
      refreshIntervalMs: bitbucketConfig.refreshIntervalMs,
      states: PULL_REQUEST_VIEWS,
    }));
  });

  app.get('/activity', (req, res) => {
    const bitbucketConfig = getBitbucketConfig();
    res.set('Cache-Control', 'no-store');
    res.type('html').send(renderActivityPage({
      workspace: bitbucketConfig.workspace,
      repositories: bitbucketConfig.repositories,
      users: bitbucketConfig.users,
      refreshIntervalMs: bitbucketConfig.refreshIntervalMs,
    }));
  });

  app.get('/releases', (req, res) => {
    const bitbucketConfig = getBitbucketConfig();
    res.set('Cache-Control', 'no-store');
    res.type('html').send(renderReleasesPage({
      workspace: bitbucketConfig.workspace,
      repositories: bitbucketConfig.repositories,
      refreshIntervalMs: bitbucketConfig.refreshIntervalMs,
      minorLimit: 2,
    }));
  });

  app.get('/api/bitbucket/releases', async (req, res) => {
    try {
      const bitbucketConfig = getBitbucketConfig();
      if (!bitbucketConfig.configured) {
        throw new BitbucketRequestError(bitbucketConfig.configurationError, {
          statusCode: 503,
          instructions: bitbucketConfig.instructions,
          tokenUrl: bitbucketConfig.tokenUrl,
        });
      }

      const releaseQuery = parseReleaseQuery(req.query, bitbucketConfig);
      const board = await getReleaseService(bitbucketConfig).getReleasesBoard(releaseQuery);
      res.set('Cache-Control', 'no-store');
      res.json(board);
    } catch (error) {
      const statusCode = error.statusCode || 500;
      logger.error('Bitbucket releases request failed', {
        statusCode,
        message: error.message,
      });
      res.status(statusCode).json({
        error: error.message || 'Unexpected Bitbucket releases error.',
        instructions: error.instructions || [],
        tokenUrl: error.tokenUrl || '',
      });
    }
  });

  app.get('/api/bitbucket/user-activity', async (req, res) => {
    try {
      const bitbucketConfig = getBitbucketConfig();
      if (!bitbucketConfig.configured) {
        throw new BitbucketRequestError(bitbucketConfig.configurationError, {
          statusCode: 503,
          instructions: bitbucketConfig.instructions,
          tokenUrl: bitbucketConfig.tokenUrl,
        });
      }

      const activityService = getActivityService(bitbucketConfig);
      const activity = await activityService.getUserActivity({
        user: req.query.user,
        repository: req.query.repository,
        days: req.query.days,
        bypassCache: req.query.refresh === 'true' || req.query.refresh === '1',
      });

      res.set('Cache-Control', 'no-store');
      res.json(activity);
    } catch (error) {
      const statusCode = error.statusCode || 500;
      logger.error('Bitbucket user activity request failed', {
        statusCode,
        message: error.message,
      });
      res.status(statusCode).json({
        error: error.message || 'Unexpected user activity error.',
        instructions: error.instructions || [],
        tokenUrl: error.tokenUrl || '',
      });
    }
  });

  app.get('/api/bitbucket/status', async (req, res) => {
    try {
      const bitbucketConfig = getBitbucketConfig();
      if (!bitbucketConfig.configured) {
        throw new BitbucketRequestError(bitbucketConfig.configurationError, {
          statusCode: 503,
          instructions: bitbucketConfig.instructions,
          tokenUrl: bitbucketConfig.tokenUrl,
        });
      }

      const statusQuery = parseStatusQuery(req.query, bitbucketConfig);
      const board = await getStatusService(bitbucketConfig).getBoard(statusQuery);
      res.set('Cache-Control', 'no-store');
      res.json(board);
    } catch (error) {
      const statusCode = error.statusCode || 500;
      logger.error('Bitbucket status request failed', {
        statusCode,
        message: error.message,
      });
      res.status(statusCode).json({
        error: error.message || 'Unexpected Bitbucket status error.',
        instructions: error.instructions || [],
        tokenUrl: error.tokenUrl || '',
      });
    }
  });
}
