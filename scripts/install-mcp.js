#!/usr/bin/env node

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_SERVER_NAME = 'tool-jira';
const DEFAULT_HTTP_URL = `http://localhost:${process.env.PORT || 3099}/mcp`;

/**
 * Builds the stdio MCP server config entry compatible with both Cursor (`mcp.json`)
 * and Antigravity (`mcp_config.json`).
 * Uses the absolute Node binary path (`process.execPath`) so GUI apps (Cursor/AGY)
 * work reliably even when nvm/asdf is not loaded in their non-interactive PATH.
 *
 * @param {{ projectRoot?: string, nodePath?: string, env?: Record<string, string> }} [options]
 * @returns {object}
 */
export function buildStdioServerEntry(options = {}) {
  const root = options.projectRoot || PROJECT_ROOT;
  const nodePath = options.nodePath || process.execPath;
  const serverScript = path.join(root, 'src', 'mcpServer.js');
  const entry = {
    command: nodePath,
    args: [serverScript],
  };
  if (options.env && Object.keys(options.env).length > 0) {
    entry.env = { ...options.env };
  }
  return entry;
}

/**
 * Builds the Streamable HTTP MCP server config entry compatible with Cursor and Antigravity.
 * @param {{ url?: string }} [options]
 * @returns {object}
 */
export function buildHttpServerEntry(options = {}) {
  return {
    url: options.url || DEFAULT_HTTP_URL,
  };
}

/**
 * Merges a server entry into an existing MCP config object without touching other servers.
 * @param {object} existingConfig
 * @param {string} serverName
 * @param {object} serverEntry
 * @returns {object}
 */
export function mergeMcpConfig(existingConfig, serverName, serverEntry) {
  const base = existingConfig && typeof existingConfig === 'object' ? { ...existingConfig } : {};
  const existingServers =
    base.mcpServers && typeof base.mcpServers === 'object' ? { ...base.mcpServers } : {};
  existingServers[serverName] = serverEntry;
  return {
    ...base,
    mcpServers: existingServers,
  };
}

/**
 * Removes a server entry from an existing MCP config object without touching other servers.
 * @param {object} existingConfig
 * @param {string} serverName
 * @returns {{ config: object, removed: boolean }}
 */
export function removeMcpConfig(existingConfig, serverName) {
  const base = existingConfig && typeof existingConfig === 'object' ? { ...existingConfig } : {};
  const existingServers =
    base.mcpServers && typeof base.mcpServers === 'object' ? { ...base.mcpServers } : {};
  const removed = Object.prototype.hasOwnProperty.call(existingServers, serverName);
  delete existingServers[serverName];
  return {
    config: {
      ...base,
      mcpServers: existingServers,
    },
    removed,
  };
}

/**
 * Resolves target config file paths for Cursor and Antigravity (AGY).
 * @param {{ cursor?: boolean, cursorProject?: boolean, agy?: boolean, all?: boolean, homeDir?: string, cwd?: string }} flags
 * @returns {Array<{ client: string, path: string }>}
 */
export function resolveTargets(flags = {}) {
  const homeDir = flags.homeDir || os.homedir();
  const cwd = flags.cwd || process.cwd();
  const targets = [];

  const includeCursor = Boolean(flags.all || flags.cursor);
  const includeAgy = Boolean(flags.all || flags.agy);

  if (includeCursor) {
    targets.push({
      client: 'Cursor (global)',
      path: path.join(homeDir, '.cursor', 'mcp.json'),
    });
  }
  if (flags.cursorProject) {
    targets.push({
      client: 'Cursor (project)',
      path: path.join(cwd, '.cursor', 'mcp.json'),
    });
  }
  if (includeAgy) {
    targets.push({
      client: 'Antigravity / AGY (global)',
      path: path.join(homeDir, '.gemini', 'config', 'mcp_config.json'),
    });
  }

  return targets;
}

/**
 * Parses CLI flags.
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const flags = {
    cursor: false,
    cursorProject: false,
    agy: false,
    all: false,
    uninstall: false,
    dryRun: false,
    embedEnv: false,
    transport: 'stdio',
    name: DEFAULT_SERVER_NAME,
    url: DEFAULT_HTTP_URL,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--cursor') flags.cursor = true;
    else if (arg === '--cursor-project') flags.cursorProject = true;
    else if (arg === '--agy') flags.agy = true;
    else if (arg === '--all') flags.all = true;
    else if (arg === '--uninstall') flags.uninstall = true;
    else if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--embed-env') flags.embedEnv = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg === '--transport' && argv[i + 1]) {
      flags.transport = argv[i + 1];
      i += 1;
    } else if (arg === '--name' && argv[i + 1]) {
      flags.name = argv[i + 1];
      i += 1;
    } else if (arg === '--url' && argv[i + 1]) {
      flags.url = argv[i + 1];
      i += 1;
    }
  }

  if (!flags.cursor && !flags.cursorProject && !flags.agy && !flags.all) {
    flags.all = true;
  }

  return flags;
}

function readJsonFileOrEmpty(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, 'utf-8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function loadEmbeddedEnv() {
  const envPath = path.join(PROJECT_ROOT, '.env');
  const parsed = fs.existsSync(envPath) ? dotenv.parse(fs.readFileSync(envPath, 'utf-8')) : {};
  const keys = ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'OUTPUT_PATH'];
  const env = {};
  for (const key of keys) {
    const val = (process.env[key] || parsed[key] || '').trim();
    if (val) env[key] = val;
  }
  return env;
}

function printHelp() {
  console.log(`
Usage: node scripts/install-mcp.js [options]

Install or uninstall the tool-jira MCP server for Cursor and Antigravity (AGY).

Options:
  --all                 Install/uninstall for both Cursor and AGY (default)
  --cursor              Target Cursor global config (~/.cursor/mcp.json)
  --cursor-project      Target Cursor project config (./.cursor/mcp.json)
  --agy                 Target Antigravity global config (~/.gemini/config/mcp_config.json)
  --transport <mode>    Transport mode: "stdio" (default) or "http"
  --url <url>           HTTP MCP URL when --transport http (default: ${DEFAULT_HTTP_URL})
  --name <name>         Server identifier in mcpServers (default: ${DEFAULT_SERVER_NAME})
  --embed-env           Copy JIRA_* env vars from .env into the MCP JSON config
  --dry-run             Preview changes without writing any files
  --uninstall           Remove the MCP server entry from the target config(s)
  -h, --help            Show this help message
`);
}

function runCli() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    printHelp();
    return;
  }

  if (!['stdio', 'http'].includes(flags.transport)) {
    console.error(`Invalid --transport "${flags.transport}". Use "stdio" or "http".`);
    process.exit(1);
  }

  const targets = resolveTargets(flags);
  const env = flags.embedEnv ? loadEmbeddedEnv() : undefined;
  const entry =
    flags.transport === 'http'
      ? buildHttpServerEntry({ url: flags.url })
      : buildStdioServerEntry({ projectRoot: PROJECT_ROOT, env });

  for (const target of targets) {
    const existing = readJsonFileOrEmpty(target.path);

    if (flags.uninstall) {
      const { config, removed } = removeMcpConfig(existing, flags.name);
      if (!removed) {
        console.log(`[skip] ${target.client}: "${flags.name}" not found in ${target.path}`);
        continue;
      }
      if (flags.dryRun) {
        console.log(`[dry-run] Would remove "${flags.name}" from ${target.path}`);
        console.log(JSON.stringify(config, null, 2));
      } else {
        fs.writeFileSync(target.path, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
        console.log(`[removed] ${target.client}: removed "${flags.name}" from ${target.path}`);
      }
      continue;
    }

    const updated = mergeMcpConfig(existing, flags.name, entry);
    if (flags.dryRun) {
      console.log(`[dry-run] Would write "${flags.name}" to ${target.path} (${target.client}):`);
      console.log(JSON.stringify(updated, null, 2));
    } else {
      fs.mkdirSync(path.dirname(target.path), { recursive: true });
      fs.writeFileSync(target.path, `${JSON.stringify(updated, null, 2)}\n`, 'utf-8');
      console.log(`[installed] ${target.client}: added "${flags.name}" to ${target.path}`);
    }
  }

  if (!flags.dryRun && !flags.uninstall) {
    console.log('\nRestart Cursor / Antigravity (or reload MCP servers) to activate the Jira tools.');
  }
}

const isDirectExecution =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  runCli();
}
