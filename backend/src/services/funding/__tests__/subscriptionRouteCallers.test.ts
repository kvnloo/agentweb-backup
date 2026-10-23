/**
 * ENG-2113 PR A: every way a chat turn can start (`generateSessionResponse`) is listed here with who starts it. This test FAILS when a new call
 * site appears or one disappears, so nobody can add an entry point that silently inherits (or silently lacks) the subscription-route rules in
 * subscriptionRoute.ts. Only the authenticated owner's plain /generate chat may ever use a customer's plan; every other row must resolve as
 * `RouteEntry` other than "owner_chat" when the route resolution is wired in (PR C), which default-denies them.
 *
 * To add or remove a call site: update the table below in the same change, and classify the new entry in subscriptionRoute.ts (RouteEntry).
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const SRC = join(__dirname, "..", "..", "..");

/** file (relative to src) -> number of call sites and who starts those turns */
const EXPECTED: Record<string, { calls: number; who: string }> = {
  "controllers/agentModeController.ts": {
    calls: 10,
    who:
      "1 owner_chat (/generate by the authenticated owner: the ONLY plan-eligible site) + 9 not eligible: media continuation, work-plan continuation, " +
      "verified-chat retry loop (scheduled/verified), verified-chat continuation, reflection turn, interactive share, conversable visitor, " +
      "plan launch (x2 call sites)",
  },
  "routes/gtmPlan.ts": { calls: 1, who: "gtm plan first turn" },
  "routes/admin.ts": { calls: 1, who: "admin launches a plan turn as the plan owner (admin_launch)" },
  "routes/slack.ts": { calls: 1, who: "Slack thread turn (third-party text possible)" },
  "services/emmaEmailService.ts": { calls: 1, who: "email turn (external sender text)" },
  "services/onboardingBrandBuildService.ts": { calls: 2, who: "onboarding brand build (background)" },
  "services/approvalInboxExecution.ts": { calls: 1, who: "approval inbox resume (server-authored)" },
  "services/conversation/sessionResponder.ts": { calls: 1, who: "Teams / other transports" },
};

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

function scan(): { calls: Record<string, number>; aliasing: string[] } {
  const calls: Record<string, number> = {};
  const aliasing: string[] = [];
  for (const file of listTs(SRC)) {
    const rel = relative(SRC, file);
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
      if (!/\bgenerateSessionResponse\b/.test(line)) return;
      if (/\bfunction\s+generateSessionResponse\b/.test(line)) return; // the definition
      const n = (line.match(/\bgenerateSessionResponse\s*\(/g) ?? []).length;
      if (n > 0) calls[rel] = (calls[rel] ?? 0) + n;
      // Ways to call it that this count would miss: bind/call/apply, or assigning the function to another name.
      if (/\bgenerateSessionResponse\s*\.\s*(bind|call|apply)\b/.test(line)) aliasing.push(`${rel}:${i + 1}: ${t.slice(0, 100)}`);
      if (/(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*generateSessionResponse\s*(?:;|$)/.test(line)) aliasing.push(`${rel}:${i + 1}: ${t.slice(0, 100)}`);
    });
  }
  return { calls, aliasing };
}

describe("generateSessionResponse call sites are all classified", () => {
  const found = scan();
  it("has exactly the call sites listed in EXPECTED (a new or removed site must be classified here)", () => {
    const actual = Object.fromEntries(Object.entries(found.calls).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, v]));
    const expected = Object.fromEntries(Object.entries(EXPECTED).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, v.calls]));
    expect(actual).toEqual(expected);
  });
  it("is never aliased, bound or applied under another name (which would hide a call site from this test)", () => {
    expect(found.aliasing).toEqual([]);
  });
});
