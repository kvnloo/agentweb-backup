/**
 * /health tells you WHICH build is answering.
 *
 * Before this it returned `{status:"healthy"}` and nothing else, so "the deploy workflow succeeded"
 * and "this instance is serving that code" could not be told apart — which is exactly the pair you
 * need separated during an incident.
 */
import { healthPayload, buildInfo } from "../utils/buildInfo";

describe("build info on /health", () => {
  it("always reports status, with or without a build file", () => {
    expect(healthPayload().status).toBe("healthy");
  });

  it("reports a null version rather than throwing when the file is absent", () => {
    // Tests run from source, where dist/build-info.json does not exist. A missing file is the
    // normal local and CI case and must never break the health check.
    expect(healthPayload()).toHaveProperty("version");
    expect(buildInfo.versionLabel === null || typeof buildInfo.versionLabel === "string").toBe(true);
  });

  // The commit is deliberately withheld. /health is unauthenticated, so anything here is
  // world-readable, and a full sha names precisely which code is running to anyone matching
  // against known issues. The label carries a date and PR number — enough to answer "is my change
  // live?", materially less useful to someone who is not us. The sha stays in build-info.json on
  // the instance, readable by anyone who can already read the disk.
  it("never exposes the commit sha publicly", () => {
    expect(Object.keys(healthPayload()).sort()).toEqual(["status", "version"]);
    expect(JSON.stringify(healthPayload())).not.toContain("commit");
  });
});
