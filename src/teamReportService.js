import fs from 'fs';
import path from 'path';
import { createLogger } from './logger.js';
import { createUserMatchers, buildAuthorIdentityKeys } from './watchedUsers.js';

const logger = createLogger('team-report');

/**
 * Detects if a status name or category represents "In Progress" / Active Development
 * @param {string} statusName
 * @param {string} [categoryKey]
 * @returns {boolean}
 */
export function isStatusInProgress(statusName, categoryKey = '') {
  const norm = String(statusName || '').trim().toLowerCase();
  if (categoryKey === 'indeterminate') {
    if (isStatusQA(norm) || /\b(blocked|bloqueado|on hold|paused|pausado|waiting|espera)\b/i.test(norm)) {
      return false;
    }
    return true;
  }
  return /\b(in\s*progress|en\s*progreso|en\s*curso|in\s*development|development|dev\b|doing|wip|working|desarrollo)\b/i.test(norm);
}

/**
 * Detects if a status name represents QA / Testing / Verification / Review
 * @param {string} statusName
 * @returns {boolean}
 */
export function isStatusQA(statusName) {
  const norm = String(statusName || '').trim().toLowerCase();
  return /\b(qa|quality|testing|test\b|pruebas|verification|validaci|code\s*review|peer\s*review|review|staging)\b/i.test(norm);
}

/**
 * Detects if a status name represents Done / Resolved / Closed
 * @param {string} statusName
 * @param {string} [categoryKey]
 * @returns {boolean}
 */
export function isStatusDone(statusName, categoryKey = '') {
  const norm = String(statusName || '').trim().toLowerCase();
  if (categoryKey === 'done') return true;
  return /\b(done|resolved|closed|completado|finalizado|terminado|listo|ready\s*to\s*deploy|deployed|released)\b/i.test(norm);
}

/**
 * Categorizes a Jira issue type name into story, bug, task, or other
 * @param {string} typeName
 * @returns {'story'|'bug'|'task'|'other'}
 */
export function categorizeIssueType(typeName) {
  const norm = String(typeName || '').toLowerCase();
  if (norm.includes('story') || norm.includes('historia')) return 'story';
  if (norm.includes('bug') || norm.includes('error') || norm.includes('defect')) return 'bug';
  if (norm.includes('task') || norm.includes('tarea')) return 'task';
  return 'other';
}

/**
 * Calculates time spent in In Progress from changelog histories
 * @param {object} changelog
 * @param {string} createdDate
 * @param {string} currentStatusName
 * @param {number} [nowMs]
 * @returns {{ inProgressMs: number, inProgressHours: number, inProgressFormatted: string }}
 */
export function calculateInProgressDuration(changelog, createdDate, currentStatusName, nowMs = Date.now()) {
  const histories = Array.isArray(changelog?.histories) ? [...changelog.histories] : [];
  histories.sort((a, b) => Date.parse(a.created || 0) - Date.parse(b.created || 0));

  let inProgressMs = 0;
  let activeStartMs = null;
  let currentInProgress = false;

  for (const history of histories) {
    const timestamp = Date.parse(history.created || 0);
    if (Number.isNaN(timestamp)) continue;

    const statusItem = (history.items || []).find((item) => String(item.field || '').toLowerCase() === 'status');
    if (!statusItem) continue;

    const fromStatus = statusItem.fromString || '';
    const toStatus = statusItem.toString || '';

    const wasInProgress = isStatusInProgress(fromStatus);
    const nowInProgress = isStatusInProgress(toStatus);

    if (!wasInProgress && nowInProgress) {
      activeStartMs = timestamp;
      currentInProgress = true;
    } else if (wasInProgress && !nowInProgress) {
      if (activeStartMs !== null) {
        inProgressMs += Math.max(0, timestamp - activeStartMs);
        activeStartMs = null;
      }
      currentInProgress = false;
    }
  }

  if (currentInProgress && activeStartMs !== null) {
    inProgressMs += Math.max(0, nowMs - activeStartMs);
  } else if (histories.length === 0 && isStatusInProgress(currentStatusName)) {
    const createdMs = Date.parse(createdDate || 0);
    if (!Number.isNaN(createdMs)) {
      inProgressMs = Math.max(0, nowMs - createdMs);
    }
  }

  const inProgressHours = Math.round((inProgressMs / (1000 * 60 * 60)) * 10) / 10;
  return {
    inProgressMs,
    inProgressHours,
    inProgressFormatted: formatDuration(inProgressHours),
  };
}

/**
 * Detects transitions from QA / Testing back to In Progress / Development (Rebotes QA)
 * @param {object} changelog
 * @returns {{ qaBounces: number, transitions: object[] }}
 */
export function detectQaBounces(changelog) {
  const histories = Array.isArray(changelog?.histories) ? changelog.histories : [];
  const transitions = [];

  for (const history of histories) {
    const statusItem = (history.items || []).find((item) => String(item.field || '').toLowerCase() === 'status');
    if (!statusItem) continue;

    const fromStatus = statusItem.fromString || '';
    const toStatus = statusItem.toString || '';

    const isFromQA = isStatusQA(fromStatus);
    const isToDev = isStatusInProgress(toStatus) || /\b(to\s*do|backlog|reopened|reabierto|por\s*hacer|draft)\b/i.test(toStatus);

    if (isFromQA && isToDev) {
      transitions.push({
        date: history.created || '',
        from: fromStatus,
        to: toStatus,
        author: history.author?.displayName || 'Unknown',
      });
    }
  }

  return {
    qaBounces: transitions.length,
    transitions,
  };
}

/**
 * Formats duration in hours to a friendly string (e.g. 2.4 d (58 h), 18.5 h, 45 m)
 * @param {number} hours
 * @returns {string}
 */
export function formatDuration(hours) {
  if (!hours || hours <= 0) return '0 h';
  if (hours < 1) {
    const minutes = Math.round(hours * 60);
    return `${minutes} m`;
  }
  if (hours < 24) {
    return `${hours.toFixed(1)} h`;
  }
  const days = Math.round((hours / 24) * 10) / 10;
  return `${days.toFixed(1)} d (${hours.toFixed(0)} h)`;
}

export class TeamReportService {
  /**
   * @param {{ jiraClient?: object, bitbucketClient?: object, bitbucketConfig?: object, logger?: object, reportsDir?: string, userDirectory?: object }} [options]
   */
  constructor(options = {}) {
    this.jiraClient = options.jiraClient || null;
    this.bitbucketClient = options.bitbucketClient || null;
    this.bitbucketConfig = options.bitbucketConfig || { repositories: [], users: [], workspace: '' };
    this.logger = options.logger || logger;
    this.reportsDir = options.reportsDir || path.resolve(process.cwd(), 'reports');
    this.userDirectory = options.userDirectory || null;
  }

  /**
   * Ensures the reports directory exists
   */
  async ensureReportsDir() {
    await fs.promises.mkdir(this.reportsDir, { recursive: true });
  }

  /**
   * Lists all statically generated reports
   * @returns {Promise<object[]>}
   */
  async listReports() {
    await this.ensureReportsDir();
    const files = await fs.promises.readdir(this.reportsDir);
    const reportFiles = files.filter((f) => f.startsWith('report-') && f.endsWith('.json'));

    const summaries = await Promise.all(
      reportFiles.map(async (filename) => {
        try {
          const filePath = path.join(this.reportsDir, filename);
          const content = await fs.promises.readFile(filePath, 'utf-8');
          const data = JSON.parse(content);
          return {
            id: data.id || filename.replace(/\.json$/, ''),
            filename,
            title: data.title || 'Team Performance Report',
            createdAt: data.createdAt || '',
            formattedDate: data.formattedDate || '',
            period: data.period || { days: 30 },
            memberCount: Array.isArray(data.members) ? data.members.length : 0,
            summary: data.teamSummary || {},
          };
        } catch (err) {
          this.logger.warn('Failed to parse report file', { filename, error: err.message });
          return null;
        }
      })
    );

    return summaries
      .filter(Boolean)
      .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
  }

  /**
   * Reads a single statically stored report
   * @param {string} reportId
   * @returns {Promise<object|null>}
   */
  async getReport(reportId) {
    await this.ensureReportsDir();
    const safeId = path.basename(reportId).replace(/\.json$/, '');
    const filePath = path.join(this.reportsDir, `${safeId}.json`);

    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      return JSON.parse(content);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  /**
   * Deletes a statically stored report
   * @param {string} reportId
   * @returns {Promise<boolean>}
   */
  async deleteReport(reportId) {
    await this.ensureReportsDir();
    const safeId = path.basename(reportId).replace(/\.json$/, '');
    const filePath = path.join(this.reportsDir, `${safeId}.json`);
    const mdPath = path.join(this.reportsDir, `${safeId}.md`);

    try {
      await fs.promises.unlink(filePath);
      await fs.promises.unlink(mdPath).catch(() => {});
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') return false;
      throw err;
    }
  }

  /**
   * Saves report data to disk
   * @param {object} report
   * @returns {Promise<string>}
   */
  async saveReport(report) {
    await this.ensureReportsDir();
    const safeId = report.id;
    const jsonPath = path.join(this.reportsDir, `${safeId}.json`);
    const mdPath = path.join(this.reportsDir, `${safeId}.md`);

    await fs.promises.writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf-8');
    const markdown = this.generateMarkdownExport(report);
    await fs.promises.writeFile(mdPath, markdown, 'utf-8');

    return jsonPath;
  }

  /**
   * Generates a new team performance report asynchronously
   * @param {{ days?: number, users?: string[] }} [options]
   * @returns {Promise<object>}
   */
  async generateReport(options = {}) {
    const days = Math.max(1, Math.min(180, Number(options.days) || 30));
    const now = new Date();
    const cutoffDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const reportId = `report-${now.toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;

    const dateOptions = { day: '2-digit', month: '2-digit', year: 'numeric' };
    const timeOptions = { hour: '2-digit', minute: '2-digit' };
    const formattedDate = `${now.toLocaleDateString('es-ES', dateOptions)} ${now.toLocaleTimeString('es-ES', timeOptions)}`;
    const fromDateStr = cutoffDate.toLocaleDateString('es-ES', dateOptions);
    const toDateStr = now.toLocaleDateString('es-ES', dateOptions);

    this.logger.info('Starting team report generation', { days, reportId });

    // 1. Resolve team members
    const configuredUsers = options.users || this.bitbucketConfig.users || [];
    const matchers = await createUserMatchers(configuredUsers, this.userDirectory);

    // Initial member map
    const memberMap = new Map();
    for (const matcher of matchers) {
      memberMap.set(matcher.identifier.toLowerCase(), {
        identifier: matcher.identifier,
        displayName: matcher.label || matcher.identifier,
        email: matcher.identifier.includes('@') ? matcher.identifier : '',
        matcher,
        jira: {
          resolvedCount: 0,
          resolvedByType: { story: 0, bug: 0, task: 0, other: 0 },
          totalInProgressHours: 0,
          avgInProgressHoursPerTicket: 0,
          totalInProgressFormatted: '0 h',
          avgInProgressFormatted: '0 h',
          qaBouncesCount: 0,
          ticketsPassedThroughQA: 0,
          qaBounceRatePct: 0,
          currentWipCount: 0,
          resolvedTickets: [],
          bouncedTickets: [],
        },
        bitbucket: {
          prsCreated: 0,
          prsMerged: 0,
          prsDeclined: 0,
          prsReviewed: 0,
          commits: 0,
          linesAdded: 0,
          linesRemoved: 0,
          netLines: 0,
        },
        highlights: [],
      });
    }

    // 2. Fetch and process Jira issues
    const jiraIssues = await this.loadJiraIssues(days, memberMap);
    this.processJiraIssues(jiraIssues, cutoffDate, memberMap);

    // 3. Fetch and process Bitbucket PRs & Commits
    await this.loadBitbucketActivity(cutoffDate, memberMap);

    // 4. Calculate member aggregates, rates, and highlights
    const members = Array.from(memberMap.values());
    for (const member of members) {
      // Average In-Progress hours per resolved ticket
      if (member.jira.resolvedCount > 0) {
        member.jira.avgInProgressHoursPerTicket = Math.round(
          (member.jira.totalInProgressHours / member.jira.resolvedCount) * 10
        ) / 10;
        member.jira.avgInProgressFormatted = formatDuration(member.jira.avgInProgressHoursPerTicket);
      }
      member.jira.totalInProgressFormatted = formatDuration(member.jira.totalInProgressHours);

      // QA Bounce rate
      const qaTotal = member.jira.ticketsPassedThroughQA || member.jira.resolvedCount;
      if (qaTotal > 0) {
        member.jira.qaBounceRatePct = Math.round((member.jira.bouncedTickets.length / qaTotal) * 100);
      }

      // Net lines of code
      member.bitbucket.netLines = member.bitbucket.linesAdded - member.bitbucket.linesRemoved;
    }

    // Assign highlights
    this.assignHighlights(members);

    // 5. Calculate Team Summary
    const teamSummary = this.calculateTeamSummary(members);

    const report = {
      id: reportId,
      title: `Team Performance Report · Últimos ${days} días`,
      createdAt: now.toISOString(),
      formattedDate,
      period: {
        days,
        from: fromDateStr,
        to: toDateStr,
        cutoffIso: cutoffDate.toISOString(),
      },
      teamSummary,
      members: members.map((m) => ({
        identifier: m.identifier,
        displayName: m.displayName,
        email: m.email,
        jira: m.jira,
        bitbucket: m.bitbucket,
        highlights: m.highlights,
      })),
    };

    // Save report statically
    await this.saveReport(report);
    this.logger.info('Team report generated and saved successfully', { reportId });

    return report;
  }

  /**
   * Fetches Jira issues updated in the last X days with changelog.
   * If member identifiers/accountIds are available, targets the team's issues specifically
   * so company-wide issues don't crowd out the team's tickets.
   * @param {number} days
   * @param {Map<string, object>} [memberMap]
   * @returns {Promise<object[]>}
   */
  async loadJiraIssues(days, memberMap = null) {
    if (!this.jiraClient || typeof this.jiraClient.searchIssuesDetailed !== 'function') {
      return [];
    }

    // Collect account IDs from member matchers
    const accountIds = [];
    if (memberMap) {
      for (const member of memberMap.values()) {
        if (member.matcher?.keys) {
          for (const key of member.matcher.keys) {
            // Match Atlassian accountId formats (e.g. 712020:... or 24-char hex)
            if (/^[0-9a-f]{24}$|^[0-9a-f]{5,}:[0-9a-f-]+$/i.test(key)) {
              if (!accountIds.includes(key)) accountIds.push(key);
            }
          }
        }
      }
    }

    try {
      let issues = [];

      // 1. If we have team account IDs, query the team specifically
      if (accountIds.length > 0) {
        const idList = accountIds.map((id) => `"${id}"`).join(', ');
        const teamJql = `(assignee in (${idList}) OR reporter in (${idList})) AND updated >= "-${days}d" ORDER BY updated DESC`;
        try {
          issues = await this.jiraClient.searchIssuesDetailed(teamJql, {
            maxResults: 200,
            expand: 'changelog',
          });
        } catch (teamQueryErr) {
          this.logger.warn('Team-targeted JQL failed, falling back to generic query', {
            error: teamQueryErr.message,
          });
        }
      }

      // 2. If no issues found or no account IDs, fallback to generic updated query
      if (!issues || issues.length === 0) {
        const fallbackJql = `updated >= "-${days}d" ORDER BY updated DESC`;
        issues = await this.jiraClient.searchIssuesDetailed(fallbackJql, {
          maxResults: 150,
          expand: 'changelog',
        });
      }

      return issues || [];
    } catch (err) {
      this.logger.warn('Could not query Jira issues for report', { message: err.message });
      return [];
    }
  }

  /**
   * Processes Jira issues to compute resolved tickets, in-progress duration, and QA bounces
   * @param {object[]} issues
   * @param {Date} cutoffDate
   * @param {Map<string, object>} memberMap
   */
  processJiraIssues(issues, cutoffDate, memberMap) {
    for (const issue of issues) {
      const fields = issue.fields || {};
      const assignee = fields.assignee || {};
      const status = fields.status || {};
      const issueType = fields.issuetype || {};
      const category = categorizeIssueType(issueType.name);

      // Match assignee to a team member
      const member = this.findMatchingMember(assignee, memberMap);
      if (member && assignee.displayName && (!member.displayName || member.displayName.includes('@'))) {
        member.displayName = assignee.displayName;
      }

      // Changelog analysis
      const inProgressInfo = calculateInProgressDuration(
        issue.changelog,
        fields.created,
        status.name
      );
      const qaBounceInfo = detectQaBounces(issue.changelog);

      const hasQaPass = (issue.changelog?.histories || []).some((h) =>
        (h.items || []).some((i) => i.field === 'status' && isStatusQA(i.fromString || i.toString))
      );

      // Check if resolved within period
      const resolutionDateMs = Date.parse(fields.resolutiondate || '');
      const isDone = isStatusDone(status.name, status.statusCategory?.key);
      const isResolvedInPeriod = (!Number.isNaN(resolutionDateMs) && resolutionDateMs >= cutoffDate.getTime())
        || (isDone && Date.parse(fields.updated || '') >= cutoffDate.getTime());

      // Check if currently In Progress (WIP)
      const isCurrentlyWIP = isStatusInProgress(status.name, status.statusCategory?.key);

      if (member) {
        if (isCurrentlyWIP) {
          member.jira.currentWipCount += 1;
        }

        if (hasQaPass) {
          member.jira.ticketsPassedThroughQA += 1;
        }

        if (qaBounceInfo.qaBounces > 0) {
          member.jira.qaBouncesCount += qaBounceInfo.qaBounces;
          member.jira.bouncedTickets.push({
            key: issue.key,
            summary: fields.summary || issue.key,
            issueType: issueType.name || 'Task',
            bouncesCount: qaBounceInfo.qaBounces,
            transitions: qaBounceInfo.transitions,
            url: this.jiraClient?.baseUrl ? `${this.jiraClient.baseUrl}/browse/${issue.key}` : '',
          });
        }

        if (isResolvedInPeriod) {
          member.jira.resolvedCount += 1;
          member.jira.resolvedByType[category] = (member.jira.resolvedByType[category] || 0) + 1;
          member.jira.totalInProgressHours += inProgressInfo.inProgressHours;
          member.jira.resolvedTickets.push({
            key: issue.key,
            summary: fields.summary || issue.key,
            issueType: issueType.name || 'Task',
            category,
            priority: fields.priority?.name || 'Medium',
            resolvedAt: fields.resolutiondate || fields.updated || '',
            inProgressHours: inProgressInfo.inProgressHours,
            inProgressFormatted: inProgressInfo.inProgressFormatted,
            qaBounces: qaBounceInfo.qaBounces,
            url: this.jiraClient?.baseUrl ? `${this.jiraClient.baseUrl}/browse/${issue.key}` : '',
          });
        }
      }
    }
  }

  /**
   * Fetches Bitbucket pull requests and commits for the team
   * @param {Date} cutoffDate
   * @param {Map<string, object>} memberMap
   */
  async loadBitbucketActivity(cutoffDate, memberMap) {
    if (!this.bitbucketClient || !this.bitbucketConfig.repositories?.length) {
      return;
    }

    const workspace = this.bitbucketConfig.workspace;

    await Promise.all(
      this.bitbucketConfig.repositories.map(async (repoSlug) => {
        try {
          const prResult = await this.bitbucketClient.listPullRequests({
            workspace,
            repositorySlug: repoSlug,
            states: ['OPEN', 'MERGED', 'DECLINED'],
            maxPages: 3,
          });

          const rawPRs = prResult.values || [];
          for (const rawPR of rawPRs) {
            const updatedDate = new Date(rawPR.updated_on || rawPR.created_on);
            if (updatedDate < cutoffDate) continue;

            // 1. Match PR Author
            const authorMember = this.findMatchingMember(rawPR.author, memberMap);
            if (authorMember) {
              authorMember.bitbucket.prsCreated += 1;
              if (rawPR.state === 'MERGED') authorMember.bitbucket.prsMerged += 1;
              else if (rawPR.state === 'DECLINED') authorMember.bitbucket.prsDeclined += 1;
            }

            // 2. Match PR Reviewers
            const participants = Array.isArray(rawPR.participants) ? rawPR.participants : [];
            for (const participant of participants) {
              const user = participant.user || participant;
              const reviewerMember = this.findMatchingMember(user, memberMap);
              if (reviewerMember && reviewerMember !== authorMember) {
                const participated = participant.approved
                  || participant.state === 'approved'
                  || participant.state === 'changes_requested'
                  || participant.participated_on;
                if (participated) {
                  reviewerMember.bitbucket.prsReviewed += 1;
                }
              }
            }
          }

          // Commits
          if (typeof this.bitbucketClient.listCommits === 'function') {
            try {
              const commitResult = await this.bitbucketClient.listCommits({
                workspace,
                repositorySlug: repoSlug,
                maxPages: 2,
              });
              for (const commit of commitResult.values || []) {
                const commitDate = new Date(commit.date);
                if (commitDate < cutoffDate) continue;
                const commitAuthor = commit.author?.user || { displayName: commit.author?.raw || '' };
                const member = this.findMatchingMember(commitAuthor, memberMap);
                if (member) {
                  member.bitbucket.commits += 1;
                }
              }
            } catch {
              // Commit fetch error ignored
            }
          }
        } catch (err) {
          this.logger.warn('Could not read Bitbucket repo activity', { repoSlug, error: err.message });
        }
      })
    );
  }

  /**
   * Finds matching member from user object (email, displayName, accountId)
   * @param {object} user
   * @param {Map<string, object>} memberMap
   * @returns {object|null}
   */
  findMatchingMember(user, memberMap) {
    if (!user) return null;
    const authorKeys = buildAuthorIdentityKeys(user);

    for (const member of memberMap.values()) {
      if (member.matcher?.keys) {
        const matches = authorKeys.some((k) => member.matcher.keys.has(k));
        if (matches) return member;
      }
      const normEmail = String(member.email || '').toLowerCase();
      const normName = String(member.displayName || '').toLowerCase();
      const normUserEmail = String(user.emailAddress || user.email || '').toLowerCase();
      const normUserName = String(user.displayName || user.display_name || '').toLowerCase();

      if (normEmail && normUserEmail && normEmail === normUserEmail) return member;
      if (normName && normUserName && normName === normUserName) return member;
    }

    return null;
  }

  /**
   * Assigns badge highlights (e.g. Top Resolver, Zero QA Bounces, Top Reviewer)
   * @param {object[]} members
   */
  assignHighlights(members) {
    if (members.length === 0) return;

    let maxResolved = 0;
    let maxReviews = 0;
    let maxPrsMerged = 0;

    for (const m of members) {
      if (m.jira.resolvedCount > maxResolved) maxResolved = m.jira.resolvedCount;
      if (m.bitbucket.prsReviewed > maxReviews) maxReviews = m.bitbucket.prsReviewed;
      if (m.bitbucket.prsMerged > maxPrsMerged) maxPrsMerged = m.bitbucket.prsMerged;
    }

    for (const m of members) {
      m.highlights = [];

      if (m.jira.resolvedCount > 0 && m.jira.resolvedCount === maxResolved) {
        m.highlights.push({ label: 'Top Resolver', icon: 'fa-trophy', type: 'gold' });
      }

      if (m.jira.resolvedCount >= 2 && m.jira.qaBouncesCount === 0) {
        m.highlights.push({ label: 'Cero Rebotes QA', icon: 'fa-shield-halved', type: 'green' });
      }

      if (m.bitbucket.prsReviewed > 0 && m.bitbucket.prsReviewed === maxReviews) {
        m.highlights.push({ label: 'Top Reviewer', icon: 'fa-magnifying-glass', type: 'blue' });
      }

      if (m.bitbucket.prsMerged > 0 && m.bitbucket.prsMerged === maxPrsMerged) {
        m.highlights.push({ label: 'Code Champion', icon: 'fa-rocket', type: 'purple' });
      }

      if (m.jira.resolvedCount >= 2 && m.jira.avgInProgressHoursPerTicket > 0 && m.jira.avgInProgressHoursPerTicket <= 24) {
        m.highlights.push({ label: 'Ciclo Rápido', icon: 'fa-bolt', type: 'yellow' });
      }
    }
  }

  /**
   * Calculates overall team summary
   * @param {object[]} members
   * @returns {object}
   */
  calculateTeamSummary(members) {
    let totalResolved = 0;
    let totalStories = 0;
    let totalBugs = 0;
    let totalTasks = 0;
    let totalOther = 0;
    let totalInProgressHours = 0;
    let totalQaBounces = 0;
    let totalTicketsPassedThroughQA = 0;
    let totalCurrentWip = 0;
    let totalPrsCreated = 0;
    let totalPrsMerged = 0;
    let totalPrsReviewed = 0;
    let totalCommits = 0;
    let totalLinesAdded = 0;
    let totalLinesRemoved = 0;

    for (const m of members) {
      totalResolved += m.jira.resolvedCount;
      totalStories += m.jira.resolvedByType.story || 0;
      totalBugs += m.jira.resolvedByType.bug || 0;
      totalTasks += m.jira.resolvedByType.task || 0;
      totalOther += m.jira.resolvedByType.other || 0;
      totalInProgressHours += m.jira.totalInProgressHours;
      totalQaBounces += m.jira.qaBouncesCount;
      totalTicketsPassedThroughQA += m.jira.ticketsPassedThroughQA;
      totalCurrentWip += m.jira.currentWipCount;

      totalPrsCreated += m.bitbucket.prsCreated;
      totalPrsMerged += m.bitbucket.prsMerged;
      totalPrsReviewed += m.bitbucket.prsReviewed;
      totalCommits += m.bitbucket.commits;
      totalLinesAdded += m.bitbucket.linesAdded;
      totalLinesRemoved += m.bitbucket.linesRemoved;
    }

    const avgInProgressHoursTeam = totalResolved > 0
      ? Math.round((totalInProgressHours / totalResolved) * 10) / 10
      : 0;

    const teamQaBounceRatePct = totalTicketsPassedThroughQA > 0
      ? Math.round((totalQaBounces / totalTicketsPassedThroughQA) * 100)
      : (totalResolved > 0 ? Math.round((totalQaBounces / totalResolved) * 100) : 0);

    const avgResolvedPerMember = members.length > 0
      ? Math.round((totalResolved / members.length) * 10) / 10
      : 0;

    return {
      memberCount: members.length,
      totalResolved,
      avgResolvedPerMember,
      resolvedByType: {
        story: totalStories,
        bug: totalBugs,
        task: totalTasks,
        other: totalOther,
      },
      totalInProgressHours: Math.round(totalInProgressHours * 10) / 10,
      avgInProgressHours: avgInProgressHoursTeam,
      avgInProgressFormatted: formatDuration(avgInProgressHoursTeam),
      totalQaBounces,
      teamQaBounceRatePct,
      totalCurrentWip,
      totalPrsCreated,
      totalPrsMerged,
      totalPrsReviewed,
      totalCommits,
      totalLinesAdded,
      totalLinesRemoved,
      netLines: totalLinesAdded - totalLinesRemoved,
    };
  }

  /**
   * Generates formatted Markdown for Microsoft Teams / reports
   * @param {object} report
   * @returns {string}
   */
  generateMarkdownExport(report) {
    const summary = report.teamSummary || {};
    const members = report.members || [];

    const lines = [
      `# 📊 Reporte de Rendimiento del Equipo · ${report.period?.days || 30} días`,
      `📅 **Generado:** ${report.formattedDate} | ⏱️ **Período:** ${report.period?.from} al ${report.period?.to}`,
      `👥 **Miembros del equipo:** ${summary.memberCount || members.length}`,
      '',
      '---',
      '### 📈 Resumen Ejecutivo del Equipo',
      `• 🎯 **Tickets Jira Resueltos:** **${summary.totalResolved}** (${summary.avgResolvedPerMember} por dev)`,
      `   └ 📖 Stories: ${summary.resolvedByType?.story || 0} | 🐛 Bugs: ${summary.resolvedByType?.bug || 0} | 📋 Tasks: ${summary.resolvedByType?.task || 0}`,
      `• ⏱️ **Tiempo Promedio en In-Progress:** **${summary.avgInProgressFormatted}** por ticket`,
      `• 🔄 **Rebotes QA ➔ In-Progress:** **${summary.totalQaBounces} rebotes** (Tasa de rebote: ${summary.teamQaBounceRatePct}%)`,
      `• 🔀 **Pull Requests Mergeados:** **${summary.totalPrsMerged}** (${summary.totalPrsCreated} creados)`,
      `• 🔍 **Revisiones de Código (PR Reviews):** **${summary.totalPrsReviewed}** realizadas`,
      `• 💻 **Volumen de Código:** +${summary.totalLinesAdded?.toLocaleString()} / -${summary.totalLinesRemoved?.toLocaleString()} líneas (${summary.totalCommits} commits)`,
      '',
      '---',
      '### 🏆 Comparativa por Miembro del Equipo',
      '| Miembro | Tickets Resueltos | Tiempo Prom. In-Progress | Rebotes QA | WIP Actual | PRs Mergeados | Reviews | Highlights |',
      '| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :--- |',
    ];

    for (const m of members) {
      const typeBreakdown = `(${m.jira.resolvedByType.story}S / ${m.jira.resolvedByType.bug}B / ${m.jira.resolvedByType.task}T)`;
      const bounceText = `${m.jira.qaBouncesCount} (${m.jira.qaBounceRatePct}%)`;
      const badges = (m.highlights || []).map((h) => h.label).join(', ') || '-';

      lines.push(
        `| **${m.displayName}** | **${m.jira.resolvedCount}** ${typeBreakdown} | ${m.jira.avgInProgressFormatted} | ${bounceText} | ${m.jira.currentWipCount} | ${m.bitbucket.prsMerged} | ${m.bitbucket.prsReviewed} | ${badges} |`
      );
    }

    // Detail of QA Bounces if any
    const allBounces = [];
    for (const m of members) {
      for (const t of m.jira.bouncedTickets || []) {
        allBounces.push({ member: m.displayName, ...t });
      }
    }

    if (allBounces.length > 0) {
      lines.push('');
      lines.push('---');
      lines.push('### ⚠️ Detalle de Rebotes (QA ➔ In Progress)');
      for (const b of allBounces) {
        const transDetails = (b.transitions || []).map((tr) => `\`${tr.from}\` ➔ \`${tr.to}\` por ${tr.author}`).join(', ');
        lines.push(`• **${b.key}** (${b.summary}) — *${b.member}*: ${b.bouncesCount} rebote(s) [${transDetails}]`);
      }
    }

    lines.push('');
    lines.push('---');
    lines.push(`*Reporte estático generado por Jira & Bitbucket Dashboard · ${report.id}*`);

    return lines.join('\n');
  }
}
