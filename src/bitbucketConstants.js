/**
 * Shared limits and defaults for the Bitbucket repository status board.
 * Keeping them in one place stops the API client, the cache, and the page
 * from drifting apart.
 */

/** Bitbucket Cloud REST API origin. Pagination links must stay on this host. */
export const BITBUCKET_API_ROOT = 'https://api.bitbucket.org/2.0';

/** Workspace that owns the repositories watched by this project. */
export const DEFAULT_BITBUCKET_WORKSPACE = 'gchtech';

/**
 * Repositories shown when BITBUCKET_REPOSITORIES is not set.
 * ubid-backend is the pull-request list the board is modeled on.
 * The other slugs are the Bitbucket clones already present beside this app.
 */
export const DEFAULT_BITBUCKET_REPOSITORIES = Object.freeze([
  'ubid-backend',
  'gch-account-service',
  'gch-auth0',
  'gch-brand-service',
  'rcs-frontend',
]);

/** Views the status page can request. Drafts are open pull requests with draft=true. */
export const PULL_REQUEST_VIEWS = Object.freeze(['OPEN', 'DRAFT', 'MERGED', 'DECLINED']);

/** Where a developer creates a scoped Atlassian API token. */
export const BITBUCKET_TOKEN_URL = 'https://id.atlassian.com/manage-profile/security/api-tokens';

/** Shown when Bitbucket rejects the token or the process is not configured. */
export const BITBUCKET_SETUP_INSTRUCTIONS = Object.freeze([
  'Create an Atlassian API token with the Bitbucket scopes read:repository:bitbucket, read:pullrequest:bitbucket, and read:pipeline:bitbucket.',
  'Set BITBUCKET_EMAIL and BITBUCKET_API_TOKEN in the environment or in the .env file. BITBUCKET_EMAIL can fall back to ORCA_BITBUCKET_EMAIL or JIRA_EMAIL.',
  'Set REPOSITORIES to a comma-separated list of repository slugs, and BITBUCKET_USERS to the emails or names whose open pull requests should be shown.',
  'Restart the web server after changing the environment so the new token is loaded.',
]);

/** Slugs Bitbucket accepts in repository and workspace paths. */
export const REPOSITORY_SLUG_PATTERN = /^[A-Za-z0-9._-]+$/;

/** How often the browser asks for a new board. */
export const STATUS_REFRESH_INTERVAL_MS = 30000;

/**
 * How long a repository snapshot is reused. This stays longer than the browser
 * interval so a routine poll does not download every repository again.
 * The Refresh button bypasses the cache.
 */
export const STATUS_CACHE_TTL_MS = 60000;

/** Per-request ceiling so one stalled Bitbucket call cannot pin the board. */
export const BITBUCKET_REQUEST_TIMEOUT_MS = 20000;

/** Bitbucket's practical page size for pull request and pipeline collections. */
export const BITBUCKET_PAGE_LENGTH = 50;

/** Two pages is enough for a status board and bounds the number of API calls. */
export const BITBUCKET_MAX_PAGES = 2;

/** Guardrail so a mistyped env value cannot fan out into hundreds of API calls. */
export const MAX_WATCHED_REPOSITORIES = 20;

/** Parallel repository reads. Keeps a five-repository refresh well under rate limits. */
export const REPOSITORY_FETCH_CONCURRENCY = 4;
