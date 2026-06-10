import {
  parseRepo,
  slugFromCommitMessage,
  isChoreCommit,
  chooseBackfillTarget,
} from "../scripts/backfill-landing-page-publish";

describe("backfill-landing-page-publish — parseRepo", () => {
  it("parses owner/repo from a github URL", () => {
    expect(parseRepo("https://github.com/AgentWebPro/lp-foo-123")).toEqual({
      owner: "AgentWebPro",
      repo: "lp-foo-123",
    });
  });

  it("strips a trailing .git", () => {
    expect(parseRepo("https://github.com/Org/repo.git")).toEqual({ owner: "Org", repo: "repo" });
  });

  it("returns null for a non-github URL", () => {
    expect(parseRepo("https://gitlab.com/Org/repo")).toBeNull();
  });
});

describe("backfill-landing-page-publish — slugFromCommitMessage", () => {
  it("extracts the slug from an add-page commit", () => {
    expect(slugFromCommitMessage("Add new page: RetryFix Demo (/retryfix-demo)")).toBe("retryfix-demo");
  });

  it("returns null when there is no (/slug) marker", () => {
    expect(slugFromCommitMessage("Publish landing page changes from draft/abc12345")).toBeNull();
  });
});

describe("backfill-landing-page-publish — isChoreCommit", () => {
  it.each([
    ["chore: inject GTM container GTM-TEST123", true],
    ["chore(gtm): remove container", true],
    ["Add new page: Foo (/foo)", false],
    ["Publish landing page changes from draft/abc12345", false],
  ])("%s → %s", (msg, expected) => {
    expect(isChoreCommit(msg)).toBe(expected);
  });
});

describe("backfill-landing-page-publish — chooseBackfillTarget", () => {
  const head = (over: Partial<{ sha: string; message: string; parentSha?: string }> = {}) => ({
    sha: "headsha",
    message: "Add new page: Foo (/foo)",
    parentSha: "parentsha",
    ...over,
  });

  it("matches a sub-page by slug in a multi-page repo", () => {
    const pages = [
      { id: "1", name: "Foo", slug: "foo" },
      { id: "2", name: "Bar", slug: "bar" },
    ];
    const { target, reason } = chooseBackfillTarget(pages, head());
    expect(reason).toBe("ok");
    expect(target?.id).toBe("1");
  });

  it("does NOT match a sibling page when the slug points elsewhere", () => {
    const pages = [{ id: "2", name: "Bar", slug: "bar" }];
    const { target, reason } = chooseBackfillTarget(pages, head({ message: "Add new page: Foo (/foo)" }));
    expect(reason).toBe("no-match");
    expect(target).toBeNull();
  });

  it("matches the only page when a single-page repo has no slug in the message", () => {
    const pages = [{ id: "1", name: "Solo", slug: undefined }];
    const { target, reason } = chooseBackfillTarget(
      pages,
      head({ message: "Publish landing page changes from draft/abc12345" })
    );
    expect(reason).toBe("ok");
    expect(target?.id).toBe("1");
  });

  it("refuses to guess in a multi-page repo when the message has no slug", () => {
    const pages = [
      { id: "1", name: "A", slug: "a" },
      { id: "2", name: "B", slug: "b" },
    ];
    const { target, reason } = chooseBackfillTarget(
      pages,
      head({ message: "Publish landing page changes from draft/abc12345" })
    );
    expect(reason).toBe("no-match");
    expect(target).toBeNull();
  });

  it("skips chore commits (e.g. GTM injection) — would strip config, not a publish", () => {
    const pages = [{ id: "1", name: "Solo", slug: undefined }];
    const { target, reason } = chooseBackfillTarget(
      pages,
      head({ message: "chore: inject GTM container GTM-TEST123" })
    );
    expect(reason).toBe("chore");
    expect(target).toBeNull();
  });

  it("skips when HEAD has no parent (initial commit — nothing to revert to)", () => {
    const pages = [{ id: "1", name: "Solo", slug: "foo" }];
    const { target, reason } = chooseBackfillTarget(pages, head({ parentSha: undefined }));
    expect(reason).toBe("no-parent");
    expect(target).toBeNull();
  });

  it("flags a matched page that already has a lastPublish record", () => {
    const pages = [{ id: "1", name: "Foo", slug: "foo", lastPublish: { preMergeSha: "x" } }];
    const { target, reason } = chooseBackfillTarget(pages, head());
    expect(reason).toBe("already-has-record");
    expect(target?.id).toBe("1");
  });
});
