/**
 * What build is actually running.
 *
 * WHY THIS EXISTS. `/health` returned `{"status":"healthy"}` and nothing else, so there was no way
 * to tell from outside whether a given change was live. A deploy workflow finishing successfully is
 * not the same claim: it says the workflow ran, not that this instance is serving that code — and
 * during an incident those are exactly the two things you need to tell apart.
 *
 * The deploy workflow writes `dist/build-info.json` immediately before packaging the artifact, so
 * the file travels inside the zip and describes the code beside it. Read ONCE at module load: this
 * is on an unauthenticated endpoint that monitoring hits constantly, and a per-request file read
 * would be a free way to add disk I/O to a health check.
 *
 * Absent locally, in tests, and on any build that predates the workflow change — all of which must
 * behave, so a missing file yields nulls rather than throwing.
 */
import { readFileSync } from "fs";
import path from "path";

export interface BuildInfo {
  /** e.g. `backend-20260919-pr2990`. The label Elastic Beanstalk knows this version by. */
  versionLabel: string | null;
  /** Full commit sha. Deliberately NOT exposed by /health — see health() below. */
  commit: string | null;
  builtAt: string | null;
}

const EMPTY: BuildInfo = { versionLabel: null, commit: null, builtAt: null };

function read(): BuildInfo {
  try {
    // `__dirname` is `dist/utils` at runtime, so the file sits one level up, inside dist.
    const raw = readFileSync(path.join(__dirname, "..", "build-info.json"), "utf8");
    const parsed = JSON.parse(raw) as Partial<BuildInfo>;
    return {
      versionLabel: typeof parsed.versionLabel === "string" ? parsed.versionLabel : null,
      commit: typeof parsed.commit === "string" ? parsed.commit : null,
      builtAt: typeof parsed.builtAt === "string" ? parsed.builtAt : null,
    };
  } catch {
    // A local run, a test, or a build made before the workflow wrote this. Not an error.
    return EMPTY;
  }
}

export const buildInfo: BuildInfo = read();

/**
 * The public health payload.
 *
 * `version` only — NOT the commit. `/health` is unauthenticated (`app.ts`), so anything here is
 * world-readable, and a full sha tells anyone precisely which code is running, which is a gift when
 * they are matching against known issues. The version label carries a date and a PR number, which
 * is enough to answer "is my change live?" and materially less useful to someone who is not us.
 * The sha stays in `build-info.json` on the instance for anyone who can already read the disk.
 */
export function healthPayload(): { status: string; version: string | null } {
  return { status: "healthy", version: buildInfo.versionLabel };
}
