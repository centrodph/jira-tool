import { BITBUCKET_SETUP_INSTRUCTIONS, BITBUCKET_TOKEN_URL } from './bitbucketConstants.js';

/**
 * Error for a Bitbucket request or for a status-board configuration problem.
 * statusCode is safe to return from the HTTP API. The message is safe to show
 * in the browser. Credentials are never included.
 */
export class BitbucketRequestError extends Error {
  /**
   * @param {string} message User-facing explanation.
   * @param {{ statusCode?: number, instructions?: string[], tokenUrl?: string, cause?: Error }} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'BitbucketRequestError';
    this.statusCode = options.statusCode || 500;
    this.instructions = options.instructions || [];
    this.tokenUrl = options.tokenUrl || '';
  }
}

/**
 * Authentication and missing-scope failures should stop the whole board.
 * A single repository 403 or 404 should not, because the token may simply
 * lack access to that one slug.
 * @param {Error} error
 * @returns {boolean}
 */
export function isCredentialError(error) {
  if (!error) return false;
  if (error.statusCode === 401) return true;
  const message = String(error.message || '');
  return /no Bitbucket scopes|token is invalid|not supported for this endpoint/i.test(message);
}

/**
 * @param {number} statusCode
 * @param {string} bitbucketMessage
 * @returns {BitbucketRequestError}
 */
export function createBitbucketHttpError(statusCode, bitbucketMessage) {
  const cleanedMessage = (bitbucketMessage || 'Unknown Bitbucket error').trim();
  let message = `Bitbucket request failed (${statusCode}): ${cleanedMessage}`;

  if (statusCode === 404) {
    message = 'Bitbucket could not find that repository, or this token cannot see it.';
  } else if (/no Bitbucket scopes/i.test(cleanedMessage)) {
    message = 'The API token is valid for Atlassian, but it does not include Bitbucket scopes, so pull requests cannot be read.';
  } else if (statusCode === 401 || statusCode === 403) {
    message = `Bitbucket refused the request (${statusCode}): ${cleanedMessage}`;
  }

  const credentialFailure = statusCode === 401 || /no Bitbucket scopes/i.test(cleanedMessage);
  return new BitbucketRequestError(message, {
    statusCode,
    instructions: credentialFailure ? [...BITBUCKET_SETUP_INSTRUCTIONS] : [],
    tokenUrl: credentialFailure ? BITBUCKET_TOKEN_URL : '',
  });
}
