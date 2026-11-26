/**
 * Matching rules for BITBUCKET_USERS.
 * Bitbucket pull requests usually omit the author email, so an email is also
 * compared to the display name and nickname (victor.diaz@intive.com matches
 * "Victor Diaz"), and to an Atlassian account id when Jira can resolve it.
 */

/**
 * @param {string|undefined} value
 * @returns {string[]}
 */
export function buildIdentityKeys(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return [];

  const keys = new Set([normalized.replace(/^\{|\}$/g, '')]);
  const comparable = normalized.includes('@') ? normalized.split('@')[0] : normalized;
  const looksLikeName = normalized.includes('@') || /[\s.]/.test(normalized);

  if (looksLikeName) {
    keys.add(comparable);
    keys.add(comparable.replace(/\./g, ' ').replace(/\s+/g, ' ').trim());
    keys.add(comparable.replace(/\s+/g, '.'));
    keys.add(comparable.replace(/[.\s_-]+/g, ''));
  }

  return [...keys].filter((key) => key.length >= 3);
}

/**
 * @param {object} author Raw Bitbucket user object or commit author.
 * @returns {string[]}
 */
export function buildAuthorIdentityKeys(author) {
  const keys = new Set();
  const fields = [
    author?.display_name,
    author?.nickname,
    author?.email,
    author?.account_id,
    author?.uuid,
    author?.displayName,
    author?.accountId,
    author?.emailAddress,
    author?.user?.display_name,
    author?.user?.nickname,
    author?.user?.account_id,
    author?.user?.uuid,
    author?.user?.displayName,
    author?.user?.accountId,
    author?.user?.emailAddress,
  ];

  for (const field of fields) {
    for (const key of buildIdentityKeys(field)) {
      keys.add(key);
    }
  }

  if (typeof author?.raw === 'string') {
    const emailMatch = author.raw.match(/<([^>]+)>/);
    if (emailMatch && emailMatch[1]) {
      for (const key of buildIdentityKeys(emailMatch[1])) keys.add(key);
    }
    const namePart = author.raw.replace(/<[^>]+>/, '').trim();
    if (namePart) {
      for (const key of buildIdentityKeys(namePart)) keys.add(key);
    }
  }

  return [...keys];
}

/**
 * @param {object} commit
 * @param {{ identifier: string, keys: Set<string> }[]|undefined} userMatchers
 * @returns {boolean}
 */
export function commitMatchesWatchedUsers(commit, userMatchers) {
  if (!userMatchers || userMatchers.length === 0) return true;
  const authorKeys = buildAuthorIdentityKeys(commit?.author);
  return userMatchers.some((matcher) => authorKeys.some((key) => matcher.keys.has(key)));
}

/**
 * An empty matcher list means "do not filter".
 * @param {object} pullRequest
 * @param {{ identifier: string, keys: Set<string> }[]|undefined} userMatchers
 * @returns {string[]}
 */
export function matchingUserIdentifiers(pullRequest, userMatchers) {
  if (!userMatchers || userMatchers.length === 0) return [];
  const authorKeys = pullRequest.author?.identityKeys || [];
  return userMatchers
    .filter((matcher) => authorKeys.some((key) => matcher.keys.has(key)))
    .map((matcher) => matcher.identifier);
}

/**
 * @param {object} pullRequest
 * @param {{ identifier: string, keys: Set<string> }[]|undefined} userMatchers
 * @returns {boolean}
 */
export function pullRequestMatchesWatchedUsers(pullRequest, userMatchers) {
  if (!userMatchers || userMatchers.length === 0) return true;
  return matchingUserIdentifiers(pullRequest, userMatchers).length > 0;
}

/**
 * @param {string[]} identifiers
 * @param {{ lookup: (identifier: string) => Promise<object|null> }|null} userDirectory
 * @returns {Promise<{ identifier: string, label: string, keys: Set<string> }[]>}
 */
export async function createUserMatchers(identifiers, userDirectory) {
  const matchers = [];

  for (const identifier of identifiers) {
    const keys = new Set(buildIdentityKeys(identifier));
    const resolvedUser = userDirectory ? await userDirectory.lookup(identifier) : null;
    if (resolvedUser) {
      for (const key of buildIdentityKeys(resolvedUser.accountId)) keys.add(key);
      for (const key of buildIdentityKeys(resolvedUser.displayName)) keys.add(key);
      for (const key of buildIdentityKeys(resolvedUser.emailAddress)) keys.add(key);
    }
    const displayName = (resolvedUser?.displayName || '').trim();
    matchers.push({
      identifier,
      label: displayName || identifier,
      keys,
    });
  }

  return matchers;
}
