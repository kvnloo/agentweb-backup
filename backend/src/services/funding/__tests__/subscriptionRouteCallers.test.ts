/**
 * ENG-2113 PR A: every way a chat turn can start (`generateSessionResponse`) is listed here with who starts it. This test FAILS when a call site
 * is added, removed, MOVED to another function, or hidden behind an alias, so nobody can add an entry point that silently inherits (or silently
 * lacks) the subscription-route rules in subscriptionRoute.ts. Only the authenticated owner's plain /generate chat may ever use a customer's plan;
 * every other row must resolve to a `RouteEntry` other than "owner_chat" when route resolution is wired in (PR C), which default-denies them.
 *
 * This is a tripwire, not the guard: the guard is that the resolver is default-deny and that PR C derives `entry` from the call site. When
 * PR C makes `entry`/`fundingChoice` a REQUIRED parameter of generateSessionResponse the compiler enforces the classification and this test can go.
 *
 * To add, move or remove a call site: update EXPECTED in the same change, and classify the new entry in subscriptionRoute.ts (RouteEntry).
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const SRC = join(__dirname, "..", "..", "..");

/** file -> the enclosing function of each call site (sorted), and who starts those turns. */
const EXPECTED: Record<string, { sites: string[]; who: string }> = {
  "controllers/agentModeController.ts": {
    sites: [
      "function runScheduleSelfImprovement", // scheduled self-improvement turn
      "function runVerifiedChatInner", // scheduled / verified chat: its retry loop call ...
      "function runVerifiedChatInner", // ... and its continuation call
      "function scheduleAutoMediaContinuation", // automatic follow-up turn
      "function scheduleAutoWorkPlanContinuation", // automatic follow-up turn
      "method createSessionWithPlan", // plan launch (two call sites)
      "method createSessionWithPlan",
      "method generateConversableResponse", // anonymous visitor through a conversable link
      "method generateResponse", // OWNER_CHAT_SITE: /generate by the authenticated session owner, the ONLY plan-eligible site
      "method generateSharedResponse", // interactive share
    ],
    who: "only generateResponse may ever be plan-eligible",
  },
  "routes/admin.ts": { sites: ["route /gtm-plans/:planId/phases/:phaseId/work-items/:workItemId/start-session"], who: "admin launches a plan work item as the plan owner (admin_launch)" },
  "routes/gtmPlan.ts": { sites: ["route /:planId/phases/:phaseId/work-items/:workItemId/start-session"], who: "gtm plan work item first turn" },
  "routes/slack.ts": { sites: ["function handleMappedSlackThreadResponse"], who: "Slack thread (third-party text possible)" },
  "services/approvalInboxExecution.ts": { sites: ["function resumeOriginSession"], who: "approval inbox resume (server-authored)" },
  "services/conversation/sessionResponder.ts": { sites: ["function handleSessionResponse"], who: "Teams / other transports" },
  "services/emmaEmailService.ts": { sites: ["method processInboundEmail"], who: "email turn (external sender text)" },
  "services/onboardingBrandBuildService.ts": { sites: ["function defaultDeps", "function triggerBrandBuildForUser"], who: "onboarding brand build (background; calls go through an injected dependency)" },
};

/** The one place a turn may use a customer's plan. Every other site must be classified as a different RouteEntry when wiring lands. */
const OWNER_CHAT_SITE = { file: "controllers/agentModeController.ts", site: "method generateResponse" };

/** Known, reviewed aliasing: onboarding injects the function as a dependency (a background caller, never plan-eligible). */
const ALLOWED_ALIASING = ["services/onboardingBrandBuildService.ts: renamed on destructuring or in an object: { generateSessionResponse: d"];

function listTs(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "__tests__" || name === "dist") continue;
      listTs(full, out);
    } else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name) && !/\.d\.ts$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

/** The nearest named function / top-level arrow handler / route above `index`, as a stable label. */
function enclosing(text: string, index: number): string {
  const before = text.slice(0, index);
  const markers = [
    ...before.matchAll(
      /(?:^|\n)[ \t]*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)|(?:^|\n)(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*(?::[^=\n]+)?=\s*(?:async\s*)?(?:\(|[A-Za-z_$][\w$]*\s*=>)|(?:^|\n) {2}(?:async\s+)?(?!(?:if|while|for|switch|catch|return|await|void)\b)([A-Za-z0-9_$]+)\s*\([^)\n]*\)\s*(?::[^{\n]+)?\{|\brouter\.(?:get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g,
    ),
  ];
  const last = markers[markers.length - 1];
  if (!last) return "(module level)";
  return last[1] ? `function ${last[1]}` : last[2] ? `const ${last[2]}` : last[3] ? `method ${last[3]}` : `route ${last[4]}`;
}

function isInComment(text: string, index: number): boolean {
  const lineStart = text.lastIndexOf("\n", index) + 1;
  const prefix = text.slice(lineStart, index).trim();
  return prefix.startsWith("//") || prefix.startsWith("*") || prefix.startsWith("/*");
}

export function scan(): { sites: Record<string, string[]>; aliasing: string[] } {
  const sites: Record<string, string[]> = {};
  const aliasing: string[] = [];
  for (const file of listTs(SRC)) {
    const rel = relative(SRC, file);
    const text = readFileSync(file, "utf8");
    if (!/generateSessionResponse/.test(text)) continue;
    for (const m of text.matchAll(/\bgenerateSessionResponse\s*\(/g)) {
      const i = m.index as number;
      if (isInComment(text, i)) continue;
      if (/function\s+$/.test(text.slice(Math.max(0, i - 12), i))) continue; // the definition itself
      (sites[rel] ??= []).push(enclosing(text, i));
    }
    // Ways to reach it that a call-site scan would miss: bind/call/apply, renaming, assigning, passing it as a value.
    const hiding: Array<[string, RegExp]> = [
      ["bind/call/apply", /\bgenerateSessionResponse\s*\.\s*(?:bind|call|apply)\b/g],
      ["renamed on destructuring or in an object", /[{,]\s*generateSessionResponse\s*:\s*[A-Za-z_$]/g],
      ["assigned to another name", /(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*generateSessionResponse\s*(?:;|$)/gm],
      ["passed as a value", /[(,]\s*generateSessionResponse\s*[,)]/g],
    ];
    for (const [what, re] of hiding) {
      for (const m of text.matchAll(re)) {
        if (isInComment(text, m.index as number)) continue;
        aliasing.push(`${rel}: ${what}: ${m[0].trim().slice(0, 80)}`);
      }
    }
  }
  for (const k of Object.keys(sites)) sites[k].sort();
  return { sites, aliasing };
}

describe("generateSessionResponse call sites are all classified", () => {
  const found = scan();
  it("has exactly the call sites listed in EXPECTED, in the functions listed (a new, moved or removed site must be classified here)", () => {
    const expected = Object.fromEntries(Object.entries(EXPECTED).map(([k, v]) => [k, [...v.sites].sort()]));
    expect(found.sites).toEqual(expected);
  });
  it("has exactly one plan-eligible site, and it is the owner's /generate handler", () => {
    expect(EXPECTED[OWNER_CHAT_SITE.file].sites.filter((x) => x === OWNER_CHAT_SITE.site)).toHaveLength(1);
    const others = Object.entries(found.sites).flatMap(([file, sites]) => sites.map((x) => `${file}#${x}`)).filter((x) => x !== `${OWNER_CHAT_SITE.file}#${OWNER_CHAT_SITE.site}`);
    expect(others.length).toBe(Object.values(found.sites).flat().length - 1);
  });
  it("is never bound, renamed, assigned to another name or passed as a value (which would hide a call site)", () => {
    expect(found.aliasing).toEqual(ALLOWED_ALIASING);
  });
});
