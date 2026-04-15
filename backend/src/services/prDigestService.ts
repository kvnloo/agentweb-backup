import { getGitHubOrgToken } from "../utils/secretsManager";

const REPOS = ["agentweb", "agentweb-customer-portal"];
const GITHUB_API = "https://api.github.com";

interface PullRequest {
  number: number;
  title: string;
  html_url: string;
  user: { login: string };
  merged_at: string;
  body: string | null;
  additions: number;
  deletions: number;
  changed_files: number;
}

interface PRDigestResult {
  repo: string;
  prs: PullRequest[];
}

/**
 * Fetch merged PRs from GitHub repos within a time range.
 */
export async function fetchMergedPRs(
  sinceISO: string,
  untilISO: string
): Promise<PRDigestResult[]> {
  const { token, org } = await getGitHubOrgToken();
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const results: PRDigestResult[] = [];

  for (const repo of REPOS) {
    const prs = await fetchRepoPRs(org, repo, sinceISO, untilISO, headers);
    results.push({ repo, prs });
  }

  return results;
}

async function fetchRepoPRs(
  org: string,
  repo: string,
  sinceISO: string,
  untilISO: string,
  headers: Record<string, string>
): Promise<PullRequest[]> {
  const sinceDate = new Date(sinceISO);
  const untilDate = new Date(untilISO);

  // Fetch recently closed PRs (merged PRs have state=closed)
  // GitHub search API: merged within the date range
  const query = `repo:${org}/${repo} is:pr is:merged base:main merged:${sinceISO}..${untilISO}`;
  const url = `${GITHUB_API}/search/issues?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=100`;

  const searchRes = await fetch(url, { headers });
  if (!searchRes.ok) {
    const errorText = await searchRes.text();
    console.error(`GitHub search API error for ${repo}:`, searchRes.status, errorText);
    return [];
  }

  const searchData = await searchRes.json();
  const items = searchData.items || [];

  // Fetch full PR details (additions, deletions, changed_files)
  const prs: PullRequest[] = [];
  for (const item of items) {
    const prUrl = `${GITHUB_API}/repos/${org}/${repo}/pulls/${item.number}`;
    const prRes = await fetch(prUrl, { headers });
    if (!prRes.ok) continue;

    const prData = await prRes.json();
    if (!prData.merged_at) continue;

    const mergedAt = new Date(prData.merged_at);
    if (mergedAt >= sinceDate && mergedAt <= untilDate) {
      prs.push({
        number: prData.number,
        title: prData.title,
        html_url: prData.html_url,
        user: { login: prData.user?.login || "unknown" },
        merged_at: prData.merged_at,
        body: prData.body,
        additions: prData.additions || 0,
        deletions: prData.deletions || 0,
        changed_files: prData.changed_files || 0,
      });
    }
  }

  return prs;
}

/**
 * Format PR digest results into a readable summary string.
 */
export function formatDigestText(results: PRDigestResult[]): string {
  const totalPRs = results.reduce((sum, r) => sum + r.prs.length, 0);

  if (totalPRs === 0) {
    return "No PRs were merged in the specified time range.";
  }

  const lines: string[] = [];
  lines.push(`*Daily PR Digest* - ${totalPRs} PR(s) merged\n`);

  for (const { repo, prs } of results) {
    if (prs.length === 0) continue;

    lines.push(`\n*${repo}* (${prs.length} PR${prs.length > 1 ? "s" : ""}):`);
    lines.push("---");

    for (const pr of prs) {
      lines.push(`  *<${pr.html_url}|#${pr.number}: ${pr.title}>*`);
      lines.push(`  Author: @${pr.user.login} | ${pr.changed_files} files (+${pr.additions}, -${pr.deletions})`);
      if (pr.body) {
        const summary = pr.body.length > 200 ? pr.body.slice(0, 200) + "..." : pr.body;
        // Strip markdown headers and excessive whitespace
        const cleaned = summary.replace(/#{1,6}\s/g, "").replace(/\n{2,}/g, "\n").trim();
        if (cleaned) {
          lines.push(`  > ${cleaned}`);
        }
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

/**
 * Format PR digest results into Slack blocks.
 */
export function formatDigestSlackBlocks(results: PRDigestResult[]): object[] {
  const totalPRs = results.reduce((sum, r) => sum + r.prs.length, 0);
  const blocks: object[] = [];

  blocks.push({
    type: "header",
    text: { type: "plain_text", text: `Daily PR Digest - ${totalPRs} PR(s) merged` },
  });

  for (const { repo, prs } of results) {
    if (prs.length === 0) continue;

    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${repo}* (${prs.length} PR${prs.length > 1 ? "s" : ""})`,
      },
    });

    for (const pr of prs) {
      let text = `*<${pr.html_url}|#${pr.number}: ${pr.title}>*\n`;
      text += `Author: \`${pr.user.login}\` | ${pr.changed_files} files (+${pr.additions}, -${pr.deletions})`;
      if (pr.body) {
        const summary = pr.body.length > 150 ? pr.body.slice(0, 150) + "..." : pr.body;
        const cleaned = summary.replace(/#{1,6}\s/g, "").replace(/\n{2,}/g, "\n").trim();
        if (cleaned) {
          text += `\n> ${cleaned}`;
        }
      }
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text },
      });
    }
  }

  return blocks;
}
