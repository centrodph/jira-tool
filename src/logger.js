/**
 * Structured logger for operational messages.
 * Details are JSON so they stay machine-readable, and sensitive keys are
 * redacted before anything is written.
 */

const SENSITIVE_DETAIL_PATTERN = /token|authorization|password|secret|email|credential/i;

/**
 * Removes values that must never appear in logs.
 * @param {object|undefined} details
 * @returns {object|undefined}
 */
function sanitizeDetails(details) {
  if (!details || typeof details !== 'object') {
    return undefined;
  }

  const sanitized = {};
  for (const [key, value] of Object.entries(details)) {
    sanitized[key] = SENSITIVE_DETAIL_PATTERN.test(key) ? '[redacted]' : value;
  }
  return sanitized;
}

/**
 * @param {string} scope Logical component name included with every line.
 * @returns {{ info: Function, warn: Function, error: Function }}
 */
export function createLogger(scope) {
  /**
   * @param {'info'|'warn'|'error'} level
   * @param {string} message
   * @param {object} [details]
   */
  function write(level, message, details) {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      scope,
      message,
    };
    const sanitizedDetails = sanitizeDetails(details);
    if (sanitizedDetails) {
      entry.details = sanitizedDetails;
    }

    const line = JSON.stringify(entry);
    if (level === 'error') {
      console.error(line);
    } else if (level === 'warn') {
      console.warn(line);
    } else {
      console.log(line);
    }
  }

  return {
    info: (message, details) => write('info', message, details),
    warn: (message, details) => write('warn', message, details),
    error: (message, details) => write('error', message, details),
  };
}
