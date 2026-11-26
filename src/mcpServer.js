#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createJiraMcpServer } from './mcp/jiraMcp.js';

async function main() {
  const server = createJiraMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[tool-jira] Jira MCP server running on stdio\n');
}

main().catch((error) => {
  process.stderr.write(`[tool-jira] Fatal MCP startup error: ${error?.stack || error?.message || error}\n`);
  process.exit(1);
});
