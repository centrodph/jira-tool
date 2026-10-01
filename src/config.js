import dotenv from 'dotenv';
import path from 'path';

// Load environment variables from .env file
dotenv.config();

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
    outputDir: path.resolve(process.cwd(), outputDir),
  };
}
