import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Load environment variables from CWD .env first, then fallback to this project's .env
// so MCP stdio servers launched from arbitrary directories (Cursor / AGY) still find credentials.
dotenv.config();
dotenv.config({ path: path.join(PROJECT_ROOT, '.env') });

export function getConfig() {
  const baseUrl = (process.env.JIRA_BASE_URL || '').trim().replace(/\/+$/, '');
  const email = (process.env.JIRA_EMAIL || '').trim();
  const apiToken = (process.env.JIRA_API_TOKEN || '').trim();
  const outputDir = (process.env.OUTPUT_PATH || process.env.OUTPUT_DIR || './tickets').trim();

  const missingVars = [];
  if (!baseUrl) missingVars.push('JIRA_BASE_URL');
  if (!email) missingVars.push('JIRA_EMAIL');
  if (!apiToken) missingVars.push('JIRA_API_TOKEN');

  if (missingVars.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missingVars.join(', ')}.\n` +
      `Please ensure these are defined in your .env file or environment.`
    );
  }

  const authHeader = 'Basic ' + Buffer.from(`${email}:${apiToken}`).toString('base64');

  return {
    baseUrl,
    email,
    apiToken,
    authHeader,
    outputDir: path.isAbsolute(outputDir) ? outputDir : path.resolve(PROJECT_ROOT, outputDir),
  };
}
