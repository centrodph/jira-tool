#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import prompts from 'prompts';
import path from 'path';

import { getConfig } from './config.js';
import { JiraClient } from './jiraClient.js';
import { formatIssueToMarkdown } from './markdownFormatter.js';
import { saveIssueToMarkdownFile } from './fileWriter.js';

const program = new Command();

program
  .name('jira-to-md')
  .description('Export Jira tickets to clean GitHub-Flavored Markdown files')
  .version('1.0.0')
  .argument('[ticketKeys...]', 'One or more Jira ticket keys (e.g. PROJ-123 PROJ-124)')
  .option('-q, --jql <query>', 'JQL search query to fetch matching tickets')
  .option('-o, --output <dir>', 'Output directory for markdown files (default: from .env or ./tickets)')
  .option('-a, --attachments', 'Download attachment files locally into ticket folder', false)
  .option('-m, --max <number>', 'Maximum tickets to fetch when using JQL search', '20')
  .option('--stdout', 'Print markdown to terminal stdout instead of saving to disk', false);

program.parse(process.argv);

const options = program.opts();
const ticketKeys = program.args;

async function runInteractive(config, client) {
  console.log(chalk.bold.cyan('\n🏷️  Jira to Markdown Exporter'));
  console.log(chalk.gray(`Instance: ${config.baseUrl}`));

  const spinner = ora('Checking connection to Jira...').start();
  try {
    const user = await client.verifyConnection();
    spinner.succeed(chalk.green(`Connected to Jira as ${chalk.bold(user)}`));
  } catch (err) {
    spinner.fail(chalk.red(`Failed to connect to Jira: ${err.message}`));
    process.exit(1);
  }

  const response = await prompts([
    {
      type: 'select',
      name: 'mode',
      message: 'What would you like to export?',
      choices: [
        { title: 'Ticket key(s) (e.g., RCS-575, RCS-274)', value: 'keys' },
        { title: 'Search using JQL query', value: 'jql' },
      ],
      initial: 0,
    },
    {
      type: (prev) => (prev === 'keys' ? 'text' : null),
      name: 'keys',
      message: 'Enter Jira ticket key(s) (comma or space separated):',
      validate: (val) => (val.trim() ? true : 'Please enter at least one ticket key'),
    },
    {
      type: (prev, values) => (values.mode === 'jql' ? 'text' : null),
      name: 'jql',
      message: 'Enter JQL query:',
      initial: 'order by created desc',
      validate: (val) => (val.trim() ? true : 'Please enter a JQL query'),
    },
    {
      type: 'confirm',
      name: 'attachments',
      message: 'Download attachments locally?',
      initial: false,
    },
    {
      type: 'text',
      name: 'outputDir',
      message: 'Output directory:',
      initial: config.outputDir,
    },
  ]);

  if (!response.mode) {
    console.log(chalk.yellow('\nOperation cancelled.'));
    process.exit(0);
  }

  let selectedKeys = [];
  if (response.mode === 'keys') {
    selectedKeys = response.keys
      .split(/[\s,]+/)
      .map((k) => k.trim().toUpperCase())
      .filter(Boolean);
  }

  return {
    ticketKeys: selectedKeys,
    jql: response.jql,
    outputDir: response.outputDir || config.outputDir,
    downloadAttachments: response.attachments,
    maxResults: 20,
    stdout: false,
  };
}

async function processTickets({ client, config, keys, outputDir, downloadAttachments, stdout }) {
  const results = [];
  const errors = [];

  for (const key of keys) {
    const spinner = ora(`Fetching ${chalk.bold(key)}...`).start();
    try {
      const issue = await client.fetchIssue(key);
      const markdown = formatIssueToMarkdown(issue, config.baseUrl);

      if (stdout) {
        spinner.stop();
        console.log(markdown);
        results.push({ key, stdout: true });
      } else {
        spinner.text = `Saving ${chalk.bold(key)} to Markdown...`;
        const saveResult = await saveIssueToMarkdownFile(issue, markdown, {
          outputDir,
          downloadAttachments,
          jiraClient: client,
        });
        spinner.succeed(
          chalk.green(
            `Saved ${chalk.bold(key)} → ${chalk.cyan(path.relative(process.cwd(), saveResult.filePath))}` +
            (saveResult.downloadAttachmentsCount > 0
              ? ` (${saveResult.downloadAttachmentsCount} attachments)`
              : '')
          )
        );
        results.push(saveResult);
      }
    } catch (err) {
      spinner.fail(chalk.red(`Failed ${chalk.bold(key)}: ${err.message}`));
      errors.push({ key, error: err.message });
    }
  }

  return { results, errors };
}

async function main() {
  let config;
  try {
    config = getConfig();
  } catch (err) {
    console.error(chalk.red('\nConfiguration Error:'), err.message);
    process.exit(1);
  }

  const client = new JiraClient(config);

  let runConfig;

  // If arguments or options were provided on CLI
  if (ticketKeys.length > 0 || options.jql) {
    runConfig = {
      ticketKeys: ticketKeys.map((k) => k.toUpperCase().trim()).filter(Boolean),
      jql: options.jql,
      outputDir: options.output || config.outputDir,
      downloadAttachments: Boolean(options.attachments),
      maxResults: parseInt(options.max, 10) || 20,
      stdout: Boolean(options.stdout),
    };
  } else {
    // Run interactive prompt
    runConfig = await runInteractive(config, client);
  }

  let finalKeys = [...runConfig.ticketKeys];

  // If JQL search is specified
  if (runConfig.jql) {
    const spinner = ora(`Searching Jira with JQL: "${chalk.cyan(runConfig.jql)}"...`).start();
    try {
      const issues = await client.searchIssues(runConfig.jql, runConfig.maxResults);
      if (issues.length === 0) {
        spinner.warn(chalk.yellow('No issues matched your JQL query.'));
        return;
      }
      spinner.succeed(chalk.green(`Found ${issues.length} matching issue(s).`));
      for (const issue of issues) {
        if (issue.key && !finalKeys.includes(issue.key)) {
          finalKeys.push(issue.key);
        }
      }
    } catch (err) {
      spinner.fail(chalk.red(`JQL Search Error: ${err.message}`));
      process.exit(1);
    }
  }

  if (finalKeys.length === 0) {
    console.log(chalk.yellow('No ticket keys to process.'));
    return;
  }

  console.log(chalk.gray(`\nProcessing ${finalKeys.length} ticket(s)...\n`));
  const { results, errors } = await processTickets({
    client,
    config,
    keys: finalKeys,
    outputDir: runConfig.outputDir,
    downloadAttachments: runConfig.downloadAttachments,
    stdout: runConfig.stdout,
  });

  if (!runConfig.stdout) {
    console.log('\n' + chalk.bold('Summary:'));
    console.log(chalk.green(`  ✔ Successfully saved: ${results.length}`));
    if (errors.length > 0) {
      console.log(chalk.red(`  ✖ Errors encountered: ${errors.length}`));
    }
    console.log(chalk.gray(`  📁 Output directory: ${path.resolve(runConfig.outputDir)}\n`));
  }
}

main().catch((err) => {
  console.error(chalk.red('Unexpected error:'), err);
  process.exit(1);
});
