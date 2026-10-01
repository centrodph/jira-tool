# Jira to Markdown Exporter

A Node.js tool to fetch tickets from Jira Cloud and export them into clean GitHub-Flavored Markdown (`.md`) files with YAML frontmatter, subtasks, linked issues, attachments metadata, and comments.

---

## ✨ Features

- **YAML Frontmatter**: Includes issue key, summary, issue type, status, priority, resolution, assignee, reporter, creator, timestamps, sprints, parent/epic, story points, and direct Jira URL.
- **GFM Markdown Conversion**: Converts rich Jira text (HTML and Atlassian Document Format) into clean markdown including headings, bold/italic, tables, code blocks, lists, quotes, and user mentions.
- **Sub-Tasks & Linked Issues**: Generates tables listing all related subtasks and linked issues with status, summary, and links.
- **Attachments**: Summarizes all attachments in a table. Supports downloading attachments locally with `--attachments` (`-a`), automatically relinking images in markdown to the local directory.
- **Comments**: Formats all comments chronologically with author and timestamp.
- **CLI & Interactive Modes**:
  - Run with direct ticket keys (single or multiple).
  - Search tickets using **JQL**.
  - Run interactively with zero arguments for guided prompts.
- **Web UI**: Built-in dashboard to fetch tickets, browse saved exports, and preview rendered HTML or raw Markdown.

---

## 🚀 Setup

### 1. Requirements
- Node.js 18+
- Jira Cloud account with an API token

### 2. Install Dependencies
```bash
npm install
```

### 3. Configure Environment
Create or edit your `.env` file (see `.env.example`):

```env
JIRA_BASE_URL=https://your-domain.atlassian.net
JIRA_EMAIL=your-email@example.com
JIRA_API_TOKEN=your-jira-api-token

# Optional: Default output folder for markdown tickets (defaults to ./tickets)
OUTPUT_PATH=./tickets

# Optional: Server port for Web UI (defaults to 3099)
PORT=3099
```

> **How to get a Jira API Token:**
> 1. Log in to [Atlassian API Tokens](https://id.atlassian.com/manage-profile/security/api-tokens).
> 2. Click **Create API token**.
> 3. Copy the token into your `.env` file.

---

## 🌐 Web UI Interface

Start the web application server:
```bash
npm run web
# or
npm run server
```

Open **`http://localhost:3099`** in your browser to:
- Submit ticket keys or JQL queries through a form.
- Download attachments automatically.
- Browse and search saved tickets in the sidebar.
- Toggle between live HTML preview and raw Markdown.
- Delete or manage saved tickets.

---

## 📖 CLI Usage

### 1. Interactive Mode
Run without arguments to launch the interactive prompt:
```bash
npm start
```
You will be prompted to select whether to enter ticket keys or run a JQL query, choose an output folder, and choose whether to download attachments.

### 2. Export Single or Multiple Tickets
```bash
# Single ticket
npm start PROJ-101

# Multiple tickets
npm start PROJ-101 PROJ-102 PROJ-103
```

### 3. Export by JQL Query
Fetch tickets matching any valid Jira JQL query:
```bash
# Tickets in a project
npm start -- --jql "project = PROJ order by created desc" --max 10

# In-progress tickets assigned to current user
npm start -- --jql "assignee = currentUser() AND status = 'In Progress'"
```

### 4. Download Attachments Locally
Add the `-a` or `--attachments` flag to download all attachments into a `<KEY>_attachments/` subfolder and rewrite markdown image links to point locally:
```bash
npm start PROJ-101 -a
```

### 5. Custom Output Directory
Use `-o` or `--output` to specify where files should be written:
```bash
npm start PROJ-101 -o ./documentation/tickets
```

### 6. Output to Terminal (stdout)
Print directly to stdout (useful for piping into other CLI tools or previewing):
```bash
npm start PROJ-101 --stdout
```

---

## 🛠️ CLI Options Reference

```text
Usage: jira-to-md [options] [ticketKeys...]

Arguments:
  ticketKeys                  One or more Jira ticket keys (e.g. PROJ-101 PROJ-102)

Options:
  -V, --version               output the version number
  -q, --jql <query>           JQL search query to fetch matching tickets
  -o, --output <dir>          Output directory for markdown files
  -a, --attachments          Download attachment files locally into ticket folder
  -m, --max <number>          Maximum tickets to fetch with JQL search (default: 20)
  --stdout                    Print markdown to stdout instead of saving to file
  -h, --help                  display help for command
```

---

## 📄 Output Markdown Example

Each ticket produces a markdown file formatted like this:

```markdown
---
key: "PROJ-101"
title: "Implement authentication service"
type: "Task"
status: "In Progress"
priority: "High"
resolution: "Unresolved"
assignee: "Jane Doe"
reporter: "John Smith"
creator: "John Smith"
created: "2026-09-01T10:00:00.000Z"
updated: "2026-09-02T12:00:00.000Z"
labels: ["backend", "auth"]
components: ["auth-module"]
fixVersions: ["v1.0.0"]
parent: "PROJ-100"
sprints: ["Sprint 1"]
url: "https://your-domain.atlassian.net/browse/PROJ-101"
---

# [PROJ-101] Implement authentication service

> **Type:** Task | **Status:** `In Progress` | **Priority:** High | **Resolution:** Unresolved
> **Assignee:** Jane Doe | **Reporter:** John Smith
> **Sprint:** Sprint 1
> **Parent / Epic:** [PROJ-100](https://your-domain.atlassian.net/browse/PROJ-100) - Core Infrastructure
> **Jira URL:** [https://your-domain.atlassian.net/browse/PROJ-101](https://your-domain.atlassian.net/browse/PROJ-101)

## Description

User authentication flow requirements and details.

![diagram.png](./PROJ-101_attachments/diagram.png)

## Sub-Tasks (1)

| Status | Key | Summary | Assignee |
|---|---|---|---|
| `To Do` | [PROJ-102](https://your-domain.atlassian.net/browse/PROJ-102) | Configure JWT token validation | Jane Doe |

## Attachments (1)

| Filename | Size | Author | Date | Download / View |
|---|---|---|---|---|
| `diagram.png` | 120.5 KB | John Smith | 2026-09-01 | [Download](./PROJ-101_attachments/diagram.png) |

## Comments (1)

### 💬 John Smith — *2026-09-01T11:00:00.000Z*

Initial requirements finalized.

---
```

---

## 🧪 Running Tests

```bash
npm test
```
Runs unit tests validating ADF parsing, markdown conversion, and YAML frontmatter generation.
