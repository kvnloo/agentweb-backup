/**
 * ENG-402 (Phase 2) — slackApiUrl seam + prod-guard fail-loud.
 *
 * Covers the UNBLOCKED half of ENG-402's acceptance criteria (the twin suite,
 * AC3/AC4, is blocked on Phase 1's `test:twins` wiring reaching main):
 *
 *   AC1 (characterization): with SLACK_API_BASE unset, slackService boots exactly
 *        as before — no seam applied, real Slack, no throw — for every NODE_ENV.
 *   AC2 (prod-guard fail-loud): with SLACK_API_BASE set while NODE_ENV==='production',
 *        boot fails with a named error (no silent swallow, no fallback).
 *
 * The seam is exercised two ways: the pure `resolveSlackApiUrl(env)` helper, and the
 * real module boot via `jest.isolateModules` (proving the helper is actually wired
 * into module load, not just unit-tested in isolation).
 */

import { resolveSlackApiUrl } from "../services/slackService";

describe("ENG-402 slackApiUrl seam — resolveSlackApiUrl (pure)", () => {
  // AC1: no base configured → no seam, undefined, never throws (even in prod).
  it("returns undefined when SLACK_API_BASE is unset (test env)", () => {
    expect(resolveSlackApiUrl({ NODE_ENV: "test" } as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it("returns undefined when SLACK_API_BASE is unset even in production (real Slack, no throw)", () => {
    expect(
      resolveSlackApiUrl({ NODE_ENV: "production" } as NodeJS.ProcessEnv),
    ).toBeUndefined();
  });

  // Seam active: non-production + base set → the base is passed through.
  it("returns the configured base URL outside production", () => {
    const base = "http://127.0.0.1:8123/api/";
    expect(
      resolveSlackApiUrl({ SLACK_API_BASE: base, NODE_ENV: "test" } as NodeJS.ProcessEnv),
    ).toBe(base);
  });

  it("returns the configured base URL when NODE_ENV is unset", () => {
    const base = "http://127.0.0.1:8123/api/";
    expect(resolveSlackApiUrl({ SLACK_API_BASE: base } as NodeJS.ProcessEnv)).toBe(base);
  });

  // AC2: base set in production → fail loud with a named error.
  it("throws a named error when SLACK_API_BASE is set in production", () => {
    expect(() =>
      resolveSlackApiUrl({
        SLACK_API_BASE: "http://127.0.0.1:8123/api/",
        NODE_ENV: "production",
      } as NodeJS.ProcessEnv),
    ).toThrow(/SLACK_API_BASE.*production/is);
  });
});

describe("ENG-402 slackApiUrl seam — module boot (isolateModules)", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...OLD_ENV };
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  // AC1 (boot-level characterization): unset base → module imports cleanly.
  it("boots without throwing when SLACK_API_BASE is unset and a token is present", () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    delete process.env.SLACK_API_BASE;
    process.env.NODE_ENV = "test";
    expect(() => {
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require("../services/slackService");
      });
    }).not.toThrow();
  });

  // AC2 (boot-level fail-loud): base set in production → boot throws named error.
  it("fails boot with a named error when SLACK_API_BASE is set in production", () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    process.env.SLACK_API_BASE = "http://127.0.0.1:8123/api/";
    process.env.NODE_ENV = "production";
    expect(() => {
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require("../services/slackService");
      });
    }).toThrow(/SLACK_API_BASE.*production/is);
  });

  // Seam active in a non-prod twin session → boot succeeds with the base wired in.
  it("boots with the twin base URL applied outside production", () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    process.env.SLACK_API_BASE = "http://127.0.0.1:8123/api/";
    process.env.NODE_ENV = "test";
    expect(() => {
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require("../services/slackService");
      });
    }).not.toThrow();
  });
});
