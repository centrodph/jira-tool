import { getBitbucketConfig } from './bitbucketConfig.js';
import { BitbucketClient } from './bitbucketClient.js';
import { getConfig } from './config.js';
import { JiraClient } from './jiraClient.js';
import { createLogger } from './logger.js';
import { TeamReportService } from './teamReportService.js';
import { renderReportsPage } from './views/reportsPage.js';

const logger = createLogger('team-reports-route');
let reportServiceInstance = null;

/**
 * Resolves Atlassian account directory through Jira
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
        logger.warn('Could not resolve user through Jira directory', { message: error.message });
        return null;
      }
    },
  };
}

/**
 * Gets or initializes the TeamReportService singleton
 * @returns {TeamReportService}
 */
export function getReportService() {
  if (!reportServiceInstance) {
    const bitbucketConfig = getBitbucketConfig();
    const jiraConfig = getConfig();
    const jiraClient = new JiraClient(jiraConfig);

    let bitbucketClient = null;
    if (bitbucketConfig.configured) {
      bitbucketClient = new BitbucketClient({
        email: bitbucketConfig.email,
        apiToken: bitbucketConfig.apiToken,
        logger,
      });
    }

    reportServiceInstance = new TeamReportService({
      jiraClient,
      bitbucketClient,
      bitbucketConfig,
      logger,
      userDirectory: createJiraUserDirectory(),
    });
  }
  return reportServiceInstance;
}

/**
 * Registers Team Report routes on the Express app
 * @param {import('express').Express} app
 */
export function registerReportRoutes(app) {
  // Web View: Team Reports Dashboard (default latest report)
  app.get('/reports', async (req, res) => {
    try {
      const bitbucketConfig = getBitbucketConfig();
      const service = getReportService();
      const reportsList = await service.listReports();
      let activeReport = null;

      if (reportsList.length > 0) {
        activeReport = await service.getReport(reportsList[0].id);
      }

      res.set('Cache-Control', 'no-store');
      res.type('html').send(renderReportsPage({
        workspace: bitbucketConfig.workspace,
        repositories: bitbucketConfig.repositories,
        users: bitbucketConfig.users,
        activeReport,
        reportsList,
      }));
    } catch (err) {
      logger.error('Failed to render reports page', { message: err.message });
      res.status(500).send(`Error loading reports: ${err.message}`);
    }
  });

  // Web View: View specific report by ID
  app.get('/reports/:id', async (req, res) => {
    try {
      const bitbucketConfig = getBitbucketConfig();
      const service = getReportService();
      const reportId = req.params.id;
      const [activeReport, reportsList] = await Promise.all([
        service.getReport(reportId),
        service.listReports(),
      ]);

      if (!activeReport) {
        return res.status(404).send(`Report "${reportId}" not found.`);
      }

      res.set('Cache-Control', 'no-store');
      res.type('html').send(renderReportsPage({
        workspace: bitbucketConfig.workspace,
        repositories: bitbucketConfig.repositories,
        users: bitbucketConfig.users,
        activeReport,
        reportsList,
      }));
    } catch (err) {
      logger.error('Failed to render specific report page', { reportId: req.params.id, message: err.message });
      res.status(500).send(`Error loading report: ${err.message}`);
    }
  });

  // API: Generate new team report asynchronously
  app.post('/api/reports/generate', async (req, res) => {
    try {
      const days = Number(req.body?.days) || 30;
      const service = getReportService();
      logger.info('Received request to generate team report', { days });

      const report = await service.generateReport({ days });

      res.set('Cache-Control', 'no-store');
      res.json({
        success: true,
        reportId: report.id,
        report,
      });
    } catch (err) {
      logger.error('Error generating report', { message: err.message, stack: err.stack });
      res.status(500).json({
        success: false,
        error: err.message || 'Error generating team report',
      });
    }
  });

  // API: List all generated reports
  app.get('/api/reports', async (req, res) => {
    try {
      const service = getReportService();
      const list = await service.listReports();
      res.set('Cache-Control', 'no-store');
      res.json(list);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // API: Get specific report JSON
  app.get('/api/reports/:id', async (req, res) => {
    try {
      const service = getReportService();
      const report = await service.getReport(req.params.id);
      if (!report) {
        return res.status(404).json({ error: `Report ${req.params.id} not found.` });
      }
      res.set('Cache-Control', 'no-store');
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // API: Get report as formatted Markdown
  app.get('/api/reports/:id/markdown', async (req, res) => {
    try {
      const service = getReportService();
      const report = await service.getReport(req.params.id);
      if (!report) {
        return res.status(404).json({ error: `Report ${req.params.id} not found.` });
      }
      const markdown = service.generateMarkdownExport(report);
      res.set('Cache-Control', 'no-store');
      res.json({ id: report.id, markdown });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // API: Delete a report
  app.delete('/api/reports/:id', async (req, res) => {
    try {
      const service = getReportService();
      const deleted = await service.deleteReport(req.params.id);
      if (!deleted) {
        return res.status(404).json({ error: `Report ${req.params.id} not found.` });
      }
      res.json({ success: true, deletedId: req.params.id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
