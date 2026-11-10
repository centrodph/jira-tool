import { buildAuthorIdentityKeys } from './watchedUsers.js';

/**
 * Pure mapping from Bitbucket pull request and pipeline payloads to the
 * status-board shape. No network and no logging live here, so the rules can
 * be tested without a token.
 */

const BUILD_LABELS = Object.freeze({
  SUCCESSFUL: 'Successful',
  FAILED: 'Failed',
  INPROGRESS: 'In progress',
  STOPPED: 'Stopped',
  NONE: 'No pipeline',
  UNKNOWN: 'Unknown',
});

const REVIEW_LABELS = Object.freeze({
  approved: 'Approved',
  partially_approved: 'Partially approved',
  changes_requested: 'Changes requested',
  pending: 'Review pending',
  no_reviewers: 'No reviewers',
});

/**
 * @param {string|undefined} value
 * @returns {number}
 */
function timestamp(value) {
  const parsed = Date.parse(value || '');
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * @param {string|undefined} value
 * @returns {string}
 */
function normalizeToken(value) {
  return String(value || '').toUpperCase();
}

/**
 * @param {object[]} pipelines
 * @returns {Map<number, object>}
 */
export function indexPipelinesByPullRequestId(pipelines) {
  const sortedPipelines = [...pipelines].sort((left, right) => {
    return timestamp(right?.created_on) - timestamp(left?.created_on);
  });
  const pipelineByPullRequestId = new Map();

  for (const pipeline of sortedPipelines) {
    const pullRequestId = pipeline?.target?.pullrequest?.id;
    // The first time we see an id it is the newest run, because of the sort above.
    if (!pullRequestId || pipelineByPullRequestId.has(pullRequestId)) continue;
    pipelineByPullRequestId.set(pullRequestId, pipeline);
  }

  return pipelineByPullRequestId;
}

/**
 * @param {object|null|undefined} pipeline
 * @param {{ workspace: string, repositorySlug: string }} location
 * @returns {{ overall: string, label: string, name: string, url: string }}
 */
export function summarizePipeline(pipeline, location) {
  if (!pipeline) {
    return { overall: 'NONE', label: BUILD_LABELS.NONE, name: '', url: '' };
  }

  const stateName = normalizeToken(pipeline.state?.name);
  const resultName = normalizeToken(pipeline.state?.result?.name);
  let overall = 'UNKNOWN';

  if (stateName === 'PENDING' || stateName === 'IN_PROGRESS' || stateName === 'INPROGRESS') {
    overall = 'INPROGRESS';
  } else if (resultName === 'SUCCESSFUL' || stateName === 'SUCCESSFUL') {
    overall = 'SUCCESSFUL';
  } else if (resultName === 'FAILED' || resultName === 'ERROR' || stateName === 'FAILED' || stateName === 'ERROR') {
    overall = 'FAILED';
  } else if (resultName === 'STOPPED' || stateName === 'STOPPED') {
    overall = 'STOPPED';
  }

  const buildNumber = pipeline.build_number;
  const pipelineUrl = buildNumber
    ? `https://bitbucket.org/${location.workspace}/${location.repositorySlug}/pipelines/results/${buildNumber}`
    : '';

  return {
    overall,
    label: BUILD_LABELS[overall],
    name: buildNumber ? `Pipeline #${buildNumber}` : 'Pipeline',
    url: pipelineUrl,
  };
}

/**
 * @param {object} participant
 * @returns {{ displayName: string, avatarUrl: string, state: string }}
 */
function mapReviewer(participant) {
  let state = 'pending';
  if (participant.state === 'changes_requested') {
    state = 'changes_requested';
  } else if (participant.approved || participant.state === 'approved') {
    state = 'approved';
  }

  const user = participant.user || participant;
  return {
    displayName: user.display_name || user.nickname || 'Reviewer',
    avatarUrl: user.links?.avatar?.href || '',
    state,
  };
}

/**
 * Reviewers carry the approval state. The plain reviewers array is only a
 * fallback when Bitbucket has not copied them into participants yet.
 * @param {object} rawPullRequest
 * @returns {{ displayName: string, avatarUrl: string, state: string }[]}
 */
function collectReviewers(rawPullRequest) {
  const participants = Array.isArray(rawPullRequest.participants) ? rawPullRequest.participants : [];
  const reviewers = participants.filter((participant) => participant.role === 'REVIEWER');
  if (reviewers.length > 0) {
    return reviewers.map(mapReviewer);
  }

  const declaredReviewers = Array.isArray(rawPullRequest.reviewers) ? rawPullRequest.reviewers : [];
  return declaredReviewers.map(mapReviewer);
}

/**
 * @param {{ displayName: string, state: string }[]} reviewers
 * @returns {object}
 */
export function summarizeReview(reviewers) {
  const approvedCount = reviewers.filter((reviewer) => reviewer.state === 'approved').length;
  const changesRequestedCount = reviewers.filter((reviewer) => reviewer.state === 'changes_requested').length;

  let overall = 'pending';
  if (changesRequestedCount > 0) {
    overall = 'changes_requested';
  } else if (reviewers.length > 0 && approvedCount === reviewers.length) {
    overall = 'approved';
  } else if (approvedCount > 0) {
    overall = 'partially_approved';
  } else if (reviewers.length === 0) {
    overall = 'no_reviewers';
  }

  return {
    overall,
    label: REVIEW_LABELS[overall],
    approvedCount,
    changesRequestedCount,
    reviewerCount: reviewers.length,
    reviewers,
  };
}

/**
 * @param {object} rawPullRequest
 * @param {{ workspace: string, repositorySlug: string, pipelineByPullRequestId: Map<number, object> }} context
 * @returns {object}
 */
export function mapPullRequest(rawPullRequest, context) {
  const reviewers = collectReviewers(rawPullRequest);
  const pipeline = context.pipelineByPullRequestId.get(rawPullRequest.id) || null;
  const author = rawPullRequest.author || {};
  const pullRequestId = rawPullRequest.id;
  const htmlUrl = rawPullRequest.links?.html?.href
    || `https://bitbucket.org/${context.workspace}/${context.repositorySlug}/pull-requests/${pullRequestId}`;

  return {
    id: pullRequestId,
    repositorySlug: context.repositorySlug,
    title: rawPullRequest.title || `Pull request #${pullRequestId}`,
    state: rawPullRequest.state || 'OPEN',
    draft: Boolean(rawPullRequest.draft),
    commentCount: Number(rawPullRequest.comment_count) || 0,
    taskCount: Number(rawPullRequest.task_count) || 0,
    createdOn: rawPullRequest.created_on || '',
    updatedOn: rawPullRequest.updated_on || '',
    htmlUrl,
    author: {
      displayName: author.display_name || author.nickname || 'Unknown author',
      nickname: author.nickname || '',
      email: author.email || '',
      accountId: author.account_id || '',
      avatarUrl: author.links?.avatar?.href || '',
      identityKeys: buildAuthorIdentityKeys(author),
    },
    sourceBranch: rawPullRequest.source?.branch?.name || 'unknown',
    destinationBranch: rawPullRequest.destination?.branch?.name || 'unknown',
    review: summarizeReview(reviewers),
    build: summarizePipeline(pipeline, context),
  };
}

/**
 * Drafts stay in the open collection on Bitbucket. The board splits them into
 * their own view so the Open tab matches the pull-request page.
 * @param {object[]} pullRequests
 * @param {string} viewState
 * @returns {object[]}
 */
export function selectPullRequestsForView(pullRequests, viewState) {
  if (viewState === 'DRAFT') {
    return pullRequests.filter((pullRequest) => pullRequest.draft);
  }
  if (viewState === 'OPEN') {
    return pullRequests.filter((pullRequest) => !pullRequest.draft);
  }
  return pullRequests;
}

/**
 * Counts used by the repository sidebar and the summary cards.
 * Only non-draft open pull requests affect the health counts.
 * @param {object[]} pullRequests Open collection, including drafts.
 * @returns {object}
 */
export function summarizeRepository(pullRequests) {
  const openPullRequests = pullRequests.filter((pullRequest) => !pullRequest.draft);
  const latestActivityAt = pullRequests.reduce((latest, pullRequest) => {
    return timestamp(pullRequest.updatedOn) > timestamp(latest) ? pullRequest.updatedOn : latest;
  }, '');

  return {
    openCount: openPullRequests.length,
    draftCount: pullRequests.length - openPullRequests.length,
    approvedCount: openPullRequests.filter((pullRequest) => pullRequest.review.overall === 'approved').length,
    changesRequestedCount: openPullRequests.filter((pullRequest) => pullRequest.review.overall === 'changes_requested').length,
    buildFailedCount: openPullRequests.filter((pullRequest) => pullRequest.build.overall === 'FAILED').length,
    buildInProgressCount: openPullRequests.filter((pullRequest) => pullRequest.build.overall === 'INPROGRESS').length,
    latestActivityAt: latestActivityAt || null,
  };
}
