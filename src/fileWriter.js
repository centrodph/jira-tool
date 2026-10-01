import fs from 'fs';
import path from 'path';

/**
 * Save Markdown content to file and optionally download attachments
 */
export async function saveIssueToMarkdownFile(issue, markdownContent, options = {}) {
  const {
    outputDir = './tickets',
    downloadAttachments = false,
    jiraClient = null,
  } = options;

  const key = issue.key;
  const resolvedOutputDir = path.resolve(process.cwd(), outputDir);
  await fs.promises.mkdir(resolvedOutputDir, { recursive: true });

  let finalMarkdown = markdownContent;
  const downloadedFiles = [];

  // If download attachments is requested
  if (downloadAttachments && jiraClient && issue.fields?.attachment?.length > 0) {
    const attachmentsDir = path.join(resolvedOutputDir, `${key}_attachments`);
    await fs.promises.mkdir(attachmentsDir, { recursive: true });

    for (const att of issue.fields.attachment) {
      const filename = att.filename || `attachment_${att.id}`;
      const destPath = path.join(attachmentsDir, filename);
      const downloadUrl = att.content || `${jiraClient.baseUrl}/rest/api/3/attachment/content/${att.id}`;

      try {
        await jiraClient.downloadAttachment(downloadUrl, destPath);
        downloadedFiles.push({ filename, destPath });

        // Update relative markdown links to local files
        const relativePath = `./${key}_attachments/${encodeURIComponent(filename)}`;
        finalMarkdown = finalMarkdown.replaceAll(downloadUrl, relativePath);
      } catch (err) {
        console.warn(`Warning: Could not download attachment "${filename}": ${err.message}`);
      }
    }
  }

  const filePath = path.join(resolvedOutputDir, `${key}.md`);
  await fs.promises.writeFile(filePath, finalMarkdown, 'utf-8');

  return {
    key,
    filePath,
    downloadedAttachmentsCount: downloadedFiles.length,
    downloadedFiles,
  };
}
