import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { getConfig } from './config.js';

/**
 * Jira Client for interacting with Jira Cloud REST API v3
 */
export class JiraClient {
  constructor(config = getConfig()) {
    this.baseUrl = config.baseUrl;
    this.authHeader = config.authHeader;
  }

  /**
   * Helper method to perform authenticated fetch to Jira API
   */
  async request(endpoint, options = {}) {
    const url = endpoint.startsWith('http') ? endpoint : `${this.baseUrl}${endpoint}`;
    const headers = {
      'Authorization': this.authHeader,
      'Accept': 'application/json',
      ...options.headers,
    };

    const response = await fetch(url, {
      ...options,
      headers,
    });

    if (!response.ok) {
      let errorMessage = `Jira API error: ${response.status} ${response.statusText}`;
      try {
        const errorData = await response.json();
        if (errorData.errorMessages && errorData.errorMessages.length > 0) {
          errorMessage = errorData.errorMessages.join(' | ');
        } else if (errorData.errors && Object.keys(errorData.errors).length > 0) {
          errorMessage = Object.entries(errorData.errors)
            .map(([k, v]) => `${k}: ${v}`)
            .join(' | ');
        }
      } catch {
        // response was not JSON
      }

      if (response.status === 401 || response.status === 403) {
        throw new Error(`Authentication failed (HTTP ${response.status}). Check JIRA_EMAIL and JIRA_API_TOKEN in .env: ${errorMessage}`);
      }
      if (response.status === 404) {
        throw new Error(`Resource not found (HTTP 404): ${errorMessage}`);
      }

      throw new Error(errorMessage);
    }

    return response.json();
  }

  /**
   * Test Jira connection and credentials
   */
  async verifyConnection() {
    const user = await this.request('/rest/api/3/myself');
    return user.displayName || user.emailAddress || 'Authenticated User';
  }

  /**
   * Fetch a single Jira issue with rendered HTML fields and field names
   */
  async fetchIssue(issueKeyOrId) {
    const key = issueKeyOrId.trim();
    if (!key) throw new Error('Issue key cannot be empty');

    const endpoint = `/rest/api/3/issue/${encodeURIComponent(key)}?expand=renderedFields,names`;
    try {
      return await this.request(endpoint);
    } catch (err) {
      if (err.message.includes('404') || err.message.includes('does not exist')) {
        throw new Error(`Issue "${key}" not found or you do not have permission to view it.`);
      }
      throw err;
    }
  }

  /**
   * Search Jira issues using JQL
   */
  async searchIssues(jql, maxResults = 50) {
    // Try the new /rest/api/3/search/jql endpoint first
    try {
      const data = await this.request('/rest/api/3/search/jql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jql,
          maxResults,
          fields: ['key', 'summary', 'status', 'issuetype', 'priority', 'assignee'],
        }),
      });
      return data.issues || [];
    } catch (err) {
      // If /search/jql failed with 404, fallback to legacy /rest/api/3/search
      if (err.message.includes('404')) {
        const queryParams = new URLSearchParams({
          jql,
          maxResults: String(maxResults),
          fields: 'key,summary,status,issuetype,priority,assignee',
        });
        const data = await this.request(`/rest/api/3/search?${queryParams.toString()}`);
        return data.issues || [];
      }
      throw err;
    }
  }

  /**
   * Download an attachment file from Jira
   */
  async downloadAttachment(attachmentUrl, destinationPath) {
    const res = await fetch(attachmentUrl, {
      headers: { 'Authorization': this.authHeader },
      redirect: 'follow',
    });

    if (!res.ok) {
      throw new Error(`Failed to download attachment: HTTP ${res.status} ${res.statusText}`);
    }

    await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
    const fileStream = fs.createWriteStream(destinationPath);
    await pipeline(res.body, fileStream);
  }
}
