import {
  BITBUCKET_SETUP_INSTRUCTIONS,
  BITBUCKET_TOKEN_URL,
  DEFAULT_BITBUCKET_REPOSITORIES,
  DEFAULT_BITBUCKET_WORKSPACE,
  MAX_WATCHED_REPOSITORIES,
  REPOSITORY_SLUG_PATTERN,
  STATUS_CACHE_TTL_MS,
  STATUS_REFRESH_INTERVAL_MS,
} from './bitbucketConstants.js';

/**
 * Reads Bitbucket settings from the environment.
 * The Jira API token is intentionally not reused: a Jira token has no
 * Bitbucket scopes and would fail every status request.
 */

/**
 * @param {string[]} names Environment variable names, in preference order.
 * @returns {string}
 */
function firstEnvironmentValue(names) {
  for (const name of names) {
    const value = (process.env[name] || '').trim();
    if (value) return value;
  }
  return '';
}

/**
 * @param {string|undefined} rawValue
 * @returns {{ valid: boolean, value: string, error: string }}
 */
function parseWorkspace(rawValue) {
  const value = (rawValue || '').trim() || DEFAULT_BITBUCKET_WORKSPACE;
  if (!REPOSITORY_SLUG_PATTERN.test(value)) {
    return {
      valid: false,
      value: DEFAULT_BITBUCKET_WORKSPACE,
      error: 'BITBUCKET_WORKSPACE contains unsupported characters.',
    };
  }
  return { valid: true, value, error: '' };
}

/**
 * @param {string|undefined} rawValue
 * @returns {{ valid: boolean, value: string[], error: string }}
 */
function parseRepositories(rawValue, variableName) {
  if (!rawValue || !rawValue.trim()) {
    return { valid: true, value: [...DEFAULT_BITBUCKET_REPOSITORIES], error: '' };
  }

  const slugs = [];
  let invalidSlugCount = 0;

  for (const part of rawValue.split(',')) {
    const slug = part.trim();
    if (!slug) continue;
    if (!REPOSITORY_SLUG_PATTERN.test(slug)) {
      invalidSlugCount += 1;
      continue;
    }
    if (!slugs.includes(slug)) slugs.push(slug);
  }

  if (invalidSlugCount > 0) {
    return {
      valid: false,
      value: slugs.slice(0, MAX_WATCHED_REPOSITORIES),
      error: `${variableName} contains a slug with unsupported characters.`,
    };
  }
  if (slugs.length === 0) {
    return {
      valid: false,
      value: [...DEFAULT_BITBUCKET_REPOSITORIES],
      error: `${variableName} did not include any repository slugs.`,
    };
  }
  if (slugs.length > MAX_WATCHED_REPOSITORIES) {
    return {
      valid: false,
      value: slugs.slice(0, MAX_WATCHED_REPOSITORIES),
      error: `Watch at most ${MAX_WATCHED_REPOSITORIES} repositories.`,
    };
  }

  return { valid: true, value: slugs, error: '' };
}

/**
 * BITBUCKET_USERS is a comma-separated list of emails or Bitbucket display names.
 * @param {string|undefined} rawValue
 * @returns {string[]}
 */
function parseUsers(rawValue) {
  if (!rawValue || !rawValue.trim()) return [];

  const users = [];
  for (const part of rawValue.split(',')) {
    const identifier = part.trim();
    if (!identifier || identifier.length > 200) continue;
    const alreadyListed = users.some((existing) => existing.toLowerCase() === identifier.toLowerCase());
    if (!alreadyListed) users.push(identifier);
  }
  return users;
}

/**
 * REPOSITORIES is the list the project tracks. BITBUCKET_REPOSITORIES remains
 * as a fallback for older configuration.
 * @returns {{ variableName: string, rawValue: string|undefined }}
 */
function repositorySetting() {
  if ((process.env.REPOSITORIES || '').trim()) {
    return { variableName: 'REPOSITORIES', rawValue: process.env.REPOSITORIES };
  }
  return { variableName: 'BITBUCKET_REPOSITORIES', rawValue: process.env.BITBUCKET_REPOSITORIES };
}

/**
 * @param {{ missing: string[], workspaceError: string, repositoryError: string }} problems
 * @returns {string}
 */
function buildConfigurationError(problems) {
  const reasons = [];
  if (problems.missing.length > 0) {
    reasons.push(`Set ${problems.missing.join(' and ')}.`);
  }
  if (problems.workspaceError) reasons.push(problems.workspaceError);
  if (problems.repositoryError) reasons.push(problems.repositoryError);
  return `Bitbucket repository status is not configured. ${reasons.join(' ')}`.trim();
}

/**
 * @returns {object} Configuration for the client, the service, and the page.
 */
export function getBitbucketConfig() {
  const email = firstEnvironmentValue([
    'BITBUCKET_EMAIL',
    'ORCA_BITBUCKET_EMAIL',
    'JIRA_EMAIL',
  ]);
  const apiToken = firstEnvironmentValue([
    'BITBUCKET_API_TOKEN',
    'ORCA_BITBUCKET_API_TOKEN',
  ]);
  const workspace = parseWorkspace(process.env.BITBUCKET_WORKSPACE);
  const repositorySource = repositorySetting();
  const repositories = parseRepositories(repositorySource.rawValue, repositorySource.variableName);
  const users = parseUsers(process.env.BITBUCKET_USERS);

  const missing = [];
  if (!email) missing.push('BITBUCKET_EMAIL');
  if (!apiToken) missing.push('BITBUCKET_API_TOKEN');

  const configured = missing.length === 0 && workspace.valid && repositories.valid;
  const configurationError = configured
    ? ''
    : buildConfigurationError({
      missing,
      workspaceError: workspace.error,
      repositoryError: repositories.error,
    });

  return {
    configured,
    configurationError,
    instructions: [...BITBUCKET_SETUP_INSTRUCTIONS],
    tokenUrl: BITBUCKET_TOKEN_URL,
    email,
    apiToken,
    workspace: workspace.value,
    repositories: repositories.value,
    users,
    refreshIntervalMs: STATUS_REFRESH_INTERVAL_MS,
    cacheTtlMs: STATUS_CACHE_TTL_MS,
  };
}
