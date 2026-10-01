import { test, describe } from 'node:test';
import assert from 'node:assert';
import { formatIssueToMarkdown, adfToMarkdown } from '../src/markdownFormatter.js';

describe('adfToMarkdown', () => {
  test('converts simple paragraph and text', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Hello ' },
            { type: 'text', text: 'world', marks: [{ type: 'strong' }] },
          ],
        },
      ],
    };

    const result = adfToMarkdown(doc);
    assert.strictEqual(result, 'Hello **world**');
  });

  test('converts bullet list and code blocks', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Item 1' }] }],
            },
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Item 2' }] }],
            },
          ],
        },
        {
          type: 'codeBlock',
          attrs: { language: 'json' },
          content: [{ type: 'text', text: '{"key": "value"}' }],
        },
      ],
    };

    const result = adfToMarkdown(doc);
    assert.ok(result.includes('- Item 1'));
    assert.ok(result.includes('- Item 2'));
    assert.ok(result.includes('```json\n{"key": "value"}\n```'));
  });
});

describe('formatIssueToMarkdown', () => {
  test('generates YAML frontmatter and sections', () => {
    const mockIssue = {
      key: 'TEST-100',
      fields: {
        summary: 'Test ticket summary',
        issuetype: { name: 'Bug' },
        status: { name: 'In Progress' },
        priority: { name: 'High' },
        resolution: null,
        assignee: { displayName: 'Alice' },
        reporter: { displayName: 'Bob' },
        created: '2026-09-18T10:00:00.000Z',
        updated: '2026-09-18T11:00:00.000Z',
        labels: ['frontend', 'urgent'],
        components: [{ name: 'UI' }],
        fixVersions: [{ name: 'v1.0.0' }],
        subtasks: [
          {
            key: 'TEST-101',
            fields: {
              summary: 'Fix button style',
              status: { name: 'Done' },
              assignee: { displayName: 'Alice' },
            },
          },
        ],
        attachment: [
          {
            id: '123',
            filename: 'screenshot.png',
            size: 2048,
            created: '2026-09-18T10:30:00.000Z',
            author: { displayName: 'Bob' },
          },
        ],
        comment: {
          comments: [
            {
              author: { displayName: 'Alice' },
              created: '2026-09-18T10:45:00.000Z',
              body: 'Working on it now.',
            },
          ],
        },
      },
      renderedFields: {
        description: '<p>This is a <b>bug description</b>.</p>',
        comment: {
          comments: [{ body: '<p>Working on it now.</p>' }],
        },
      },
    };

    const md = formatIssueToMarkdown(mockIssue, 'https://example.atlassian.net');

    // Check frontmatter
    assert.ok(md.startsWith('---\n'));
    assert.ok(md.includes('key: "TEST-100"'));
    assert.ok(md.includes('title: "Test ticket summary"'));
    assert.ok(md.includes('type: "Bug"'));
    assert.ok(md.includes('status: "In Progress"'));
    assert.ok(md.includes('assignee: "Alice"'));
    assert.ok(md.includes('labels: ["frontend", "urgent"]'));

    // Check header and sections
    assert.ok(md.includes('# [TEST-100] Test ticket summary'));
    assert.ok(md.includes('## Description'));
    assert.ok(md.includes('This is a **bug description**.'));
    assert.ok(md.includes('## Sub-Tasks (1)'));
    assert.ok(md.includes('[TEST-101]'));
    assert.ok(md.includes('Fix button style'));
    assert.ok(md.includes('## Attachments (1)'));
    assert.ok(md.includes('`screenshot.png`'));
    assert.ok(md.includes('2 KB'));
    assert.ok(md.includes('## Comments (1)'));
    assert.ok(md.includes('### 💬 Alice — *2026-09-18T10:45:00.000Z*'));
  });
});
