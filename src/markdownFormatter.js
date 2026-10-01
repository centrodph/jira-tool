import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

/**
 * Configure Turndown for clean GitHub Flavored Markdown conversion
 */
function createTurndownService() {
  const turndown = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    strongDelimiter: '**',
  });

  // Enable GFM plugin (tables, task lists, strikethrough)
  turndown.use(gfm);

  // Custom rule for Jira Panels / Callouts
  turndown.addRule('jiraPanels', {
    filter: (node) => node.nodeName === 'DIV' && (
      node.classList.contains('panel') ||
      node.classList.contains('info-macro') ||
      node.classList.contains('warning-macro') ||
      node.classList.contains('note-macro')
    ),
    replacement: (content) => {
      const trimmed = content.trim();
      if (!trimmed) return '';
      return '\n\n' + trimmed.split('\n').map(line => `> ${line}`).join('\n') + '\n\n';
    },
  });

  // Custom rule for user mentions
  turndown.addRule('jiraUserMentions', {
    filter: (node) => node.nodeName === 'A' && node.classList.contains('user-hover'),
    replacement: (content, node) => {
      const name = (content || node.textContent || '').trim();
      return `**${name.startsWith('@') ? name : '@' + name}**`;
    },
  });

  // Custom rule for Jira status badges
  turndown.addRule('jiraLozenge', {
    filter: (node) => node.nodeName === 'SPAN' && (
      node.classList.contains('aui-lozenge') ||
      node.classList.contains('jira-issue-status-lozenge')
    ),
    replacement: (content) => `\`${content.trim()}\``,
  });

  // Custom rule for Jira inline code or tt tags
  turndown.addRule('jiraInlineCode', {
    filter: ['tt', 'kbd'],
    replacement: (content) => `\`${content.trim()}\``,
  });

  return turndown;
}

const turndownService = createTurndownService();

/**
 * Convert ADF (Atlassian Document Format) JSON to Markdown as fallback
 */
export function adfToMarkdown(node) {
  if (!node) return '';

  if (typeof node === 'string') return node;

  const type = node.type;

  switch (type) {
    case 'doc':
      return (node.content || []).map(adfToMarkdown).join('\n\n').trim();

    case 'paragraph': {
      const inner = (node.content || []).map(adfToMarkdown).join('');
      return inner;
    }

    case 'heading': {
      const level = Math.min(Math.max(node.attrs?.level || 1, 1), 6);
      const hashes = '#'.repeat(level);
      const text = (node.content || []).map(adfToMarkdown).join('');
      return `${hashes} ${text}`;
    }

    case 'text': {
      let text = node.text || '';
      if (node.marks) {
        for (const mark of node.marks) {
          if (mark.type === 'strong') text = `**${text}**`;
          else if (mark.type === 'em') text = `*${text}*`;
          else if (mark.type === 'strike') text = `~~${text}~~`;
          else if (mark.type === 'code') text = `\`${text}\``;
          else if (mark.type === 'link') text = `[${text}](${mark.attrs?.href || ''})`;
        }
      }
      return text;
    }

    case 'bulletList':
      return (node.content || [])
        .map(item => `- ${adfToMarkdown(item).trim()}`)
        .join('\n');

    case 'orderedList':
      return (node.content || [])
        .map((item, idx) => `${idx + 1}. ${adfToMarkdown(item).trim()}`)
        .join('\n');

    case 'listItem':
      return (node.content || []).map(adfToMarkdown).join('\n').trim();

    case 'codeBlock': {
      const lang = node.attrs?.language || '';
      const code = (node.content || []).map(c => c.text || '').join('');
      return `\`\`\`${lang}\n${code}\n\`\`\``;
    }

    case 'blockquote': {
      const quote = (node.content || []).map(adfToMarkdown).join('\n');
      return quote.split('\n').map(l => `> ${l}`).join('\n');
    }

    case 'rule':
      return '---';

    case 'mention':
      return `**@${node.attrs?.text || 'user'}**`;

    case 'hardBreak':
      return '\n';

    case 'inlineCard':
      return `[${node.attrs?.url || 'link'}](${node.attrs?.url || ''})`;

    case 'table': {
      const rows = (node.content || []).map(adfToMarkdown);
      return rows.join('\n');
    }

    case 'tableRow': {
      const cells = (node.content || []).map(c => adfToMarkdown(c).replace(/\n/g, ' '));
      return `| ${cells.join(' | ')} |`;
    }

    case 'tableHeader':
    case 'tableCell':
      return (node.content || []).map(adfToMarkdown).join(' ').trim();

    default:
      if (node.content) {
        return (node.content || []).map(adfToMarkdown).join('');
      }
      return '';
  }
}

/**
 * Format bytes to readable human string
 */
function formatBytes(bytes, decimals = 1) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

/**
 * Escape string for YAML frontmatter
 */
function yamlEscape(str) {
  if (str === null || str === undefined) return 'null';
  if (typeof str === 'number' || typeof str === 'boolean') return String(str);
  const s = String(str).trim();
  if (s === '') return '""';
  if (/^[\w\-\s]+$/.test(s) && !s.includes('\n')) {
    return JSON.stringify(s);
  }
  return JSON.stringify(s);
}

/**
 * Helper to convert rich field (rendered HTML or ADF) to Markdown
 */
function toMarkdown(renderedHtml, rawField) {
  if (renderedHtml && typeof renderedHtml === 'string' && renderedHtml.trim()) {
    return turndownService.turndown(renderedHtml).trim();
  }
  if (rawField) {
    if (typeof rawField === 'object') {
      return adfToMarkdown(rawField).trim();
    }
    if (typeof rawField === 'string') {
      return rawField.trim();
    }
  }
  return '';
}

/**
 * Shift markdown headings by a given offset to maintain document hierarchy
 */
function shiftHeadings(markdown, offset = 3) {
  return markdown.replace(/^(#{1,6})\s+(.+)$/gm, (_, hashes, title) => {
    const newLevel = Math.min(hashes.length + offset, 6);
    return `${'#'.repeat(newLevel)} ${title}`;
  });
}

/**
 * Format complete Jira issue into clean Markdown document
 */
export function formatIssueToMarkdown(issue, baseUrl) {
  const fields = issue.fields || {};
  const renderedFields = issue.renderedFields || {};
  const names = issue.names || {};

  const key = issue.key;
  const summary = fields.summary || 'No Summary';
  const issueType = fields.issuetype?.name || 'Unknown';
  const status = fields.status?.name || 'Unknown';
  const priority = fields.priority?.name || 'None';
  const resolution = fields.resolution?.name || 'Unresolved';
  const assignee = fields.assignee?.displayName || 'Unassigned';
  const reporter = fields.reporter?.displayName || 'Unknown';
  const creator = fields.creator?.displayName || reporter;
  const created = fields.created || '';
  const updated = fields.updated || '';
  const resolutionDate = fields.resolutiondate || null;
  const labels = fields.labels || [];
  const components = (fields.components || []).map(c => c.name);
  const fixVersions = (fields.fixVersions || []).map(v => v.name);
  const issueUrl = `${baseUrl.replace(/\/+$/, '')}/browse/${key}`;

  // Find Sprint info
  let sprints = [];
  const sprintField = fields.customfield_10020 || Object.entries(fields).find(([k]) => {
    return names[k] && /sprint/i.test(names[k]);
  })?.[1];

  if (Array.isArray(sprintField)) {
    sprints = sprintField.map(s => (typeof s === 'string' ? s : s.name)).filter(Boolean);
  } else if (sprintField && typeof sprintField === 'object' && sprintField.name) {
    sprints = [sprintField.name];
  } else if (typeof sprintField === 'string') {
    sprints = [sprintField];
  }

  // Find Story Points
  let storyPoints = null;
  const spField = fields.customfield_10016 || Object.entries(fields).find(([k]) => {
    return names[k] && /story\s*point/i.test(names[k]);
  })?.[1];
  if (typeof spField === 'number') {
    storyPoints = spField;
  }

  // Find Parent / Epic
  let parentKey = null;
  let parentSummary = null;
  if (fields.parent) {
    parentKey = fields.parent.key;
    parentSummary = fields.parent.fields?.summary || '';
  } else {
    const epicField = fields.customfield_10014 || Object.entries(fields).find(([k]) => {
      return names[k] && /epic\s*link/i.test(names[k]);
    })?.[1];
    if (typeof epicField === 'string') parentKey = epicField;
  }

  // Find Acceptance Criteria custom field if any
  let acceptanceCriteriaMd = '';
  const acEntry = Object.entries(fields).find(([k]) => {
    return names[k] && /acceptance\s*criteria/i.test(names[k]);
  });
  if (acEntry) {
    const [acKey, acVal] = acEntry;
    const acRendered = renderedFields[acKey];
    acceptanceCriteriaMd = toMarkdown(acRendered, acVal);
  }

  // Description
  const descriptionMd = toMarkdown(renderedFields.description, fields.description) || '_No description provided._';

  // Subtasks
  const subtasks = fields.subtasks || [];

  // Linked issues
  const issueLinks = fields.issuelinks || [];

  // Attachments
  const attachments = fields.attachment || [];

  // Comments
  const comments = fields.comment?.comments || [];
  const renderedComments = renderedFields.comment?.comments || [];

  // 1. YAML Frontmatter
  const frontmatterLines = [
    '---',
    `key: ${yamlEscape(key)}`,
    `title: ${yamlEscape(summary)}`,
    `type: ${yamlEscape(issueType)}`,
    `status: ${yamlEscape(status)}`,
    `priority: ${yamlEscape(priority)}`,
    `resolution: ${yamlEscape(resolution)}`,
    `assignee: ${yamlEscape(assignee)}`,
    `reporter: ${yamlEscape(reporter)}`,
    `creator: ${yamlEscape(creator)}`,
    `created: ${yamlEscape(created)}`,
    `updated: ${yamlEscape(updated)}`,
    resolutionDate ? `resolved: ${yamlEscape(resolutionDate)}` : null,
    `labels: [${labels.map(yamlEscape).join(', ')}]`,
    `components: [${components.map(yamlEscape).join(', ')}]`,
    `fixVersions: [${fixVersions.map(yamlEscape).join(', ')}]`,
    parentKey ? `parent: ${yamlEscape(parentKey)}` : null,
    sprints.length > 0 ? `sprints: [${sprints.map(yamlEscape).join(', ')}]` : null,
    storyPoints !== null ? `storyPoints: ${storyPoints}` : null,
    `url: ${yamlEscape(issueUrl)}`,
    '---',
  ].filter(line => line !== null);

  const frontmatter = frontmatterLines.join('\n');

  // 2. Document Header & Metadata Card
  let content = `${frontmatter}\n\n# [${key}] ${summary}\n\n`;

  content += `> **Type:** ${issueType} | **Status:** \`${status}\` | **Priority:** ${priority} | **Resolution:** ${resolution}\n`;
  content += `> **Assignee:** ${assignee} | **Reporter:** ${reporter}\n`;
  if (sprints.length > 0) {
    content += `> **Sprint:** ${sprints.join(', ')}\n`;
  }
  if (parentKey) {
    const parentLink = `[${parentKey}](${baseUrl.replace(/\/+$/, '')}/browse/${parentKey})`;
    content += `> **Parent / Epic:** ${parentLink}${parentSummary ? ` - ${parentSummary}` : ''}\n`;
  }
  if (labels.length > 0) {
    content += `> **Labels:** ${labels.map(l => `\`${l}\``).join(', ')}\n`;
  }
  content += `> **Jira URL:** [${issueUrl}](${issueUrl})\n\n`;

  // 3. Description Section
  content += `## Description\n\n${descriptionMd}\n\n`;

  // 4. Acceptance Criteria (if present)
  if (acceptanceCriteriaMd) {
    content += `## Acceptance Criteria\n\n${acceptanceCriteriaMd}\n\n`;
  }

  // 5. Subtasks Section
  if (subtasks.length > 0) {
    content += `## Sub-Tasks (${subtasks.length})\n\n`;
    content += `| Status | Key | Summary | Assignee |\n`;
    content += `|---|---|---|---|\n`;
    for (const sub of subtasks) {
      const subKey = sub.key;
      const subUrl = `${baseUrl.replace(/\/+$/, '')}/browse/${subKey}`;
      const subSummary = sub.fields?.summary || '';
      const subStatus = sub.fields?.status?.name || 'Open';
      const subAssignee = sub.fields?.assignee?.displayName || 'Unassigned';
      content += `| \`${subStatus}\` | [${subKey}](${subUrl}) | ${subSummary.replace(/\|/g, '\\|')} | ${subAssignee} |\n`;
    }
    content += '\n';
  }

  // 6. Linked Issues Section
  if (issueLinks.length > 0) {
    content += `## Linked Issues (${issueLinks.length})\n\n`;
    content += `| Relationship | Linked Issue | Status |\n`;
    content += `|---|---|---|\n`;
    for (const link of issueLinks) {
      const type = link.type?.name || 'Related';
      let rel = type;
      let linkedIssue = null;

      if (link.outwardIssue) {
        rel = link.type?.outward || type;
        linkedIssue = link.outwardIssue;
      } else if (link.inwardIssue) {
        rel = link.type?.inward || type;
        linkedIssue = link.inwardIssue;
      }

      if (linkedIssue) {
        const linkKey = linkedIssue.key;
        const linkUrl = `${baseUrl.replace(/\/+$/, '')}/browse/${linkKey}`;
        const linkSummary = linkedIssue.fields?.summary || '';
        const linkStatus = linkedIssue.fields?.status?.name || 'Open';
        content += `| ${rel} | [${linkKey}](${linkUrl}) ${linkSummary.replace(/\|/g, '\\|')} | \`${linkStatus}\` |\n`;
      }
    }
    content += '\n';
  }

  // 7. Attachments Section
  if (attachments.length > 0) {
    content += `## Attachments (${attachments.length})\n\n`;
    content += `| Filename | Size | Author | Date | Download / View |\n`;
    content += `|---|---|---|---|---|\n`;
    for (const att of attachments) {
      const name = att.filename || 'attachment';
      const sizeStr = formatBytes(att.size);
      const author = att.author?.displayName || 'Unknown';
      const date = (att.created || '').split('T')[0] || '';
      const downloadUrl = att.content || `${baseUrl}/rest/api/3/attachment/content/${att.id}`;
      content += `| \`${name}\` | ${sizeStr} | ${author} | ${date} | [Download](${downloadUrl}) |\n`;
    }
    content += '\n';
  }

  // 8. Comments Section
  if (comments.length > 0) {
    content += `## Comments (${comments.length})\n\n`;
    for (let i = 0; i < comments.length; i++) {
      const comment = comments[i];
      const author = comment.author?.displayName || 'Unknown';
      const createdTime = comment.created || '';
      const renderedBody = renderedComments[i]?.body;
      const rawBody = comment.body;
      const commentRawMd = toMarkdown(renderedBody, rawBody) || '_Empty comment_';
      const commentMd = shiftHeadings(commentRawMd, 1);

      content += `### 💬 ${author} — *${createdTime}*\n\n`;
      content += `${commentMd}\n\n---\n\n`;
    }
  }

  return content;
}
