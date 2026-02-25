/**
 * Growth Comparison Script
 *
 * Queries DynamoDB for month-over-month growth metrics across 3 rolling periods.
 * Each period runs from the 25th to the 24th (e.g., Jan 25 – Feb 24).
 *
 * Metrics:
 *   - Agent Mode sessions (from AW-ChatSessions)
 *   - Generated/published articles and posts (from calledFunctions on sessions)
 *   - Generated images (from calledFunctions)
 *   - Approved articles, posts, images (from AW-AssetApprovals)
 *
 * Usage:
 *   node src/scripts/growth-comparison.js                 # defaults to today
 *   node src/scripts/growth-comparison.js 2026-02-24      # explicit end date
 */

const AWS = require("aws-sdk");
const dynamodb = new AWS.DynamoDB.DocumentClient({ region: "us-west-2" });

async function scanAll(tableName, filterExpression, expressionValues, expressionNames) {
  const items = [];
  let lastKey;
  do {
    const params = { TableName: tableName, ...(lastKey && { ExclusiveStartKey: lastKey }) };
    if (filterExpression) {
      params.FilterExpression = filterExpression;
      params.ExpressionAttributeValues = expressionValues;
      if (expressionNames) params.ExpressionAttributeNames = expressionNames;
    }
    const result = await dynamodb.scan(params).promise();
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

function buildRanges(endDateStr) {
  // Parse as local date to avoid UTC timezone shift
  let endDate;
  if (endDateStr) {
    const [y, m, d] = endDateStr.split("-").map(Number);
    endDate = new Date(y, m - 1, d);
  } else {
    endDate = new Date();
  }
  const year = endDate.getFullYear();
  const month = endDate.getMonth(); // 0-indexed
  const day = endDate.getDate();

  const ranges = [];
  for (let i = 0; i < 3; i++) {
    const endMonth = month - i;
    const startMonth = endMonth - 1;
    const ed = new Date(year, endMonth, day);
    const sd = new Date(year, startMonth, day + 1);
    const fmt = (d) => d.toISOString().slice(0, 10);
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const label = `${monthNames[sd.getMonth()]} ${sd.getDate()} - ${monthNames[ed.getMonth()]} ${ed.getDate()}`;
    ranges.push({ label, start: fmt(sd), end: fmt(ed) });
  }
  return ranges;
}

function isInRange(dateStr, range) {
  const date = new Date(dateStr);
  const s = new Date(range.start);
  const e = new Date(range.end);
  e.setHours(23, 59, 59, 999);
  return date >= s && date <= e;
}

function classifyHtml(item) {
  const fn = (item.filename || "").toLowerCase();
  if (fn.includes("social-media-post")) return "post";
  if (fn.includes("linkedin-post") || fn.includes("linkedin_post")) return "post";
  if (fn.includes("x_thread") || fn.includes("twitter-thread") || fn.includes("x-thread")) return "post";
  if (fn.includes("linkedin") && fn.includes("post")) return "post";
  if (fn.startsWith("blog-") || fn.startsWith("blog_")) return "article";
  return "other";
}

const TOOLS = [
  "create_blog_article",
  "publish_blog_article",
  "create_social_media_posts",
  "post_on_connected_account",
  "generate_image",
];

async function main() {
  const endDateArg = process.argv[2];
  const ranges = buildRanges(endDateArg);

  console.log("Fetching data from DynamoDB...");
  const [sessions, approvals] = await Promise.all([
    scanAll("AW-ChatSessions"),
    scanAll("AW-AssetApprovals"),
  ]);

  const agentSessions = sessions.filter((s) => s.portalType === "agent" && !s.archived);
  const approvedItems = approvals.filter((a) => a.status === "approved");

  console.log(`Total agent sessions: ${agentSessions.length}`);
  console.log(`Total approved assets: ${approvedItems.length}\n`);

  const results = ranges.map((range) => {
    const sessionsInRange = agentSessions.filter((s) => isInRange(s.createdAt, range));

    const toolCounts = {};
    for (const tool of TOOLS) toolCounts[tool] = 0;
    sessionsInRange.forEach((session) => {
      if (session.calledFunctions) {
        for (const tool of TOOLS) {
          toolCounts[tool] += session.calledFunctions[tool] || 0;
        }
      }
    });

    const approvedInRange = approvedItems.filter((a) =>
      isInRange(a.updatedAt || a.createdAt, range)
    );
    const approvedImages = approvedInRange.filter((a) => a.assetType === "image").length;
    const approvedHtml = approvedInRange.filter((a) => a.assetType === "html");
    const approvedPosts = approvedHtml.filter((a) => classifyHtml(a) === "post").length;
    const approvedArticles = approvedHtml.filter((a) => classifyHtml(a) === "article").length;

    return {
      label: range.label,
      sessions: sessionsInRange.length,
      generatedArticles: toolCounts["create_blog_article"],
      approvedArticles,
      publishedArticles: toolCounts["publish_blog_article"],
      generatedPosts: toolCounts["create_social_media_posts"],
      approvedPosts,
      publishedPosts: toolCounts["post_on_connected_account"],
      generatedImages: toolCounts["generate_image"],
      approvedImages,
    };
  });

  // Print table
  const cols = results.map((r) => r.label);
  const metrics = [
    { key: "sessions", label: "Agent Mode Sessions" },
    { key: "generatedArticles", label: "Generated Articles" },
    { key: "approvedArticles", label: "Approved Articles" },
    { key: "publishedArticles", label: "Published Articles" },
    { key: "generatedPosts", label: "Generated Posts" },
    { key: "approvedPosts", label: "Approved Posts" },
    { key: "publishedPosts", label: "Published Posts" },
    { key: "generatedImages", label: "Generated Images" },
    { key: "approvedImages", label: "Approved Images" },
  ];

  const colW = 20;
  const labelW = 24;
  const header = "Metric".padEnd(labelW) + cols.map((c) => c.padStart(colW)).join("");
  console.log(header);
  console.log("-".repeat(header.length));

  metrics.forEach(({ key, label }) => {
    const vals = results.map((r) => r[key]);
    const cells = vals.map((v, i) => {
      let cell = String(v);
      if (i < vals.length - 1) {
        const prev = vals[i + 1];
        const diff = v - prev;
        if (diff !== 0) {
          const sign = diff > 0 ? "+" : "";
          const pct = prev > 0 ? `, ${sign}${Math.round((diff / prev) * 100)}%` : "";
          cell += ` (${sign}${diff}${pct})`;
        }
      }
      return cell.padStart(colW);
    });
    console.log(label.padEnd(labelW) + cells.join(""));
  });
}

main().catch((e) => console.error(e));
