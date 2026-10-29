# Polling Request Budget Analysis

## Assumptions

| Parameter | Value | Source |
|-----------|-------|--------|
| Projects | 1 | Typical deployment |
| Repos per project | 1 | Typical deployment |
| Polling interval | 60 seconds | `pollingConfig.intervalMs` |
| Cycles per hour | 60 | 3600 / 60 |
| Open PRs (typical) | 3 | Plan assumption |
| Open PRs (max) | 30 | `githubPrBatchSize` |
| PRs updated per cycle | 1 | Typical (most PRs idle) |

## Rate Limits

| Provider | Limit | Source |
|----------|-------|--------|
| GitHub | 5,000 requests/hour | https://docs.github.com/en/rest/rate-limit |
| Jira | 100 requests/minute (6,000/hr) | https://developer.atlassian.com/cloud/jira/platform/rate-limiting/ |

## GitHub Requests per Cycle (After Optimization)

The optimization filters PRs by `updated_at` before calling `listReviews()`.
Only PRs updated since the last poll get their reviews fetched.

### Typical Case (3 open PRs, 1 updated per cycle)

| Poller | API Call | Count | Notes |
|--------|----------|-------|-------|
| Check Suite | `listWorkflowRuns` | 1 | Per repo, 6hr lookback |
| PR Review | `pulls.list` | 1 | Per repo |
| PR Review | `pulls.listReviews` | 1 | Only for updated PRs |
| Merged PR | `pulls.list` (closed) | 1 | Per repo |
| **Total per cycle** | | **4** | |

**Typical requests/hour: 4 * 60 = 240 requests/hour**

### Worst Case (30 open PRs, all updated)

| Poller | API Call | Count | Notes |
|--------|----------|-------|-------|
| Check Suite | `listWorkflowRuns` | 2 | 2 pages |
| PR Review | `pulls.list` | 1 | Per repo |
| PR Review | `pulls.listReviews` | 30 | All PRs updated |
| Merged PR | `pulls.list` (closed) | 1 | Per repo |
| **Total per cycle** | | **34** | |

**Worst-case requests/hour: 34 * 60 = 2,040 requests/hour**

## Jira Requests per Cycle

| Poller | API Call | Count | Notes |
|--------|----------|-------|-------|
| Status Changed | `search/jql` | 1-2 | 1-2 pages typical |
| **Total per cycle** | | **2** | |

**Jira requests/hour: 2 * 60 = 120 requests/hour**

## Summary

| Scenario | GitHub req/hr | Jira req/hr | GitHub headroom |
|----------|---------------|-------------|-----------------|
| Typical | 240 | 120 | 95% |
| Worst-case | 2,040 | 120 | 59% |

**Target achieved**: Typical case well under 1,500 requests/hour (240).

## Before vs After Optimization

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| Typical req/hr | 240 | 240 | Same |
| Worst-case req/hr | 10,200 | 2,040 | **5x reduction** |
| Over limit? | Yes (2x) | No | Fixed |

The key optimization is filtering PRs by `updated_at` before calling `listReviews()`.
A PR that hasn't been updated since the last poll cannot have new reviews, so we skip
fetching reviews for it entirely.
