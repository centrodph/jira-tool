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
  const participatedOn = participant.participated_on || participant.participatedOn || null;
  const hasParticipated = Boolean(
    participatedOn || state === 'approved' || state === 'changes_requested' || participant.approved
  );

  return {
    displayName: user.display_name || user.displayName || user.nickname || 'Reviewer',
    nickname: user.nickname || '',
    accountId: user.account_id || user.uuid || '',
    avatarUrl: user.links?.avatar?.href || '',
    state,
    participatedOn,
    hasParticipated,
  };
}

/**
 * Reviewers carry the approval state. Combines declared reviewers and
 * participants so that all assigned reviewers are shown along with their
 * approval or changes-requested status.
 * @param {object} rawPullRequest
 * @returns {{ displayName: string, avatarUrl: string, state: string, hasParticipated: boolean }[]}
 */
export function collectReviewers(rawPullRequest) {
  const participants = Array.isArray(rawPullRequest.participants) ? rawPullRequest.participants : [];
  const declaredReviewers = Array.isArray(rawPullRequest.reviewers) ? rawPullRequest.reviewers : [];

  const authorKeys = rawPullRequest.author ? buildAuthorIdentityKeys(rawPullRequest.author) : [];
  const authorKeysSet = new Set(authorKeys.map((k) => String(k).toLowerCase()));

  // Map participant reviewer state by user identity
  const participantByUserKey = new Map();
  for (const participant of participants) {
    const user = participant.user || participant;
    const keys = [user.account_id, user.uuid, user.nickname, user.display_name, user.displayName].filter(Boolean);
    for (const key of keys) {
      participantByUserKey.set(String(key).toLowerCase(), participant);
    }
  }

  const collected = [];
  const seenKeys = new Set();

  function markSeen(user) {
    const keys = [user.account_id, user.uuid, user.nickname, user.display_name, user.displayName].filter(Boolean);
    for (const key of keys) {
      seenKeys.add(String(key).toLowerCase());
    }
  }

  function isSeen(user) {
    const keys = [user.account_id, user.uuid, user.nickname, user.display_name, user.displayName].filter(Boolean);
    return keys.some((key) => seenKeys.has(String(key).toLowerCase()));
  }

  // 1. Process declared reviewers
  for (const declared of declaredReviewers) {
    const user = declared.user || declared;
    markSeen(user);
    const keys = [user.account_id, user.uuid, user.nickname, user.display_name, user.displayName].filter(Boolean);
    let matchedParticipant = null;
    for (const key of keys) {
      if (participantByUserKey.has(String(key).toLowerCase())) {
        matchedParticipant = participantByUserKey.get(String(key).toLowerCase());
        break;
      }
    }
    const participantData = matchedParticipant ? { ...declared, ...matchedParticipant } : declared;
    collected.push(mapReviewer(participantData));
  }

  // 2. Add any participant with role === 'REVIEWER' OR who approved / requested changes
  for (const participant of participants) {
    const user = participant.user || participant;
    const userKeys = [user.account_id, user.uuid, user.nickname, user.display_name, user.displayName].filter(Boolean);
    const isAuthor = userKeys.some((k) => authorKeysSet.has(String(k).toLowerCase()));

    const isReviewerRole = String(participant.role || '').toUpperCase() === 'REVIEWER';
    const hasReviewed = Boolean(
      participant.approved
      || participant.state === 'approved'
      || participant.state === 'changes_requested'
    );

    if ((isReviewerRole || hasReviewed) && (!isAuthor || hasReviewed)) {
      if (!isSeen(user)) {
        markSeen(user);
        collected.push(mapReviewer(participant));
      }
    }
  }

  return collected;
}

/**
 * @param {{ displayName: string, state: string, hasParticipated?: boolean }[]} reviewers
 * @param {{ commentCount?: number }} [options]
 * @returns {object}
 */
export function summarizeReview(reviewers, options = {}) {
  const commentCount = Number(options.commentCount) || 0;
  const approvedCount = reviewers.filter((reviewer) => reviewer.state === 'approved').length;
  const changesRequestedCount = reviewers.filter((reviewer) => reviewer.state === 'changes_requested').length;
  const participatedCount = reviewers.filter((reviewer) => reviewer.hasParticipated).length;

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

  // Has this PR had a review?
  const hasBeenReviewed = approvedCount > 0
    || changesRequestedCount > 0
    || participatedCount > 0
    || commentCount > 0;

  let reviewState = 'unreviewed';
  let reviewStateLabel = 'Sin review aún';

  if (approvedCount > 0 && approvedCount === reviewers.length && reviewers.length > 0) {
    reviewState = 'reviewed_approved';
    reviewStateLabel = 'Revisado (Aprobado)';
  } else if (changesRequestedCount > 0) {
    reviewState = 'reviewed_changes_requested';
    reviewStateLabel = 'Revisado (Cambios solicitados)';
  } else if (approvedCount > 0) {
    reviewState = 'reviewed_partially_approved';
    reviewStateLabel = `Revisado (${approvedCount}/${reviewers.length} aprobados)`;
  } else if (participatedCount > 0 || commentCount > 0) {
    reviewState = 'reviewed_with_feedback';
    reviewStateLabel = commentCount > 0 ? `Revisado (${commentCount} comentarios)` : 'Revisado (Con comentarios)';
  } else if (reviewers.length === 0) {
    reviewState = 'no_reviewers';
    reviewStateLabel = 'Sin revisores';
  }

  return {
    overall,
    label: REVIEW_LABELS[overall],
    hasApproval: approvedCount > 0,
    isFullyApproved: reviewers.length > 0 && approvedCount === reviewers.length,
    approvedCount,
    changesRequestedCount,
    reviewerCount: reviewers.length,
    hasBeenReviewed,
    reviewState,
    reviewStateLabel,
    reviewers,
  };
}

/**
 * @param {object} rawPullRequest
 * @param {{ workspace: string, repositorySlug: string, pipelineByPullRequestId?: Map<number, object>, conflictByPullRequestId?: Map<number, object> }} context
 * @returns {object}
 */
export function mapPullRequest(rawPullRequest, context = {}) {
  const reviewers = collectReviewers(rawPullRequest);
  const commentCount = Number(rawPullRequest.comment_count) || 0;
  const review = summarizeReview(reviewers, { commentCount });
  const pipeline = context.pipelineByPullRequestId?.get(rawPullRequest.id) || null;
  const conflictInfo = context.conflictByPullRequestId?.get(rawPullRequest.id) || null;

  const hasConflict = Boolean(
    conflictInfo?.hasConflict
    || rawPullRequest.has_conflict
    || rawPullRequest.hasConflict
    || (Array.isArray(rawPullRequest.conflicts) && rawPullRequest.conflicts.length > 0)
  );
  const conflictCount = Number(
    conflictInfo?.conflictCount
    || (Array.isArray(rawPullRequest.conflicts) ? rawPullRequest.conflicts.length : (hasConflict ? 1 : 0))
  );
  const conflictingFiles = conflictInfo?.conflictingFiles
    || (Array.isArray(rawPullRequest.conflicts) ? rawPullRequest.conflicts : []);

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
    commentCount,
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
    review,
    hasBeenReviewed: review.hasBeenReviewed,
    reviewState: review.reviewState,
    reviewStateLabel: review.reviewStateLabel,
    build: summarizePipeline(pipeline, context),
    hasConflict,
    conflict: {
      hasConflict,
      count: conflictCount,
      files: conflictingFiles,
    },
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
    conflictCount: openPullRequests.filter((pullRequest) => pullRequest.hasConflict).length,
    unreviewedCount: openPullRequests.filter((pullRequest) => !pullRequest.hasBeenReviewed).length,
    latestActivityAt: latestActivityAt || null,
  };
}
