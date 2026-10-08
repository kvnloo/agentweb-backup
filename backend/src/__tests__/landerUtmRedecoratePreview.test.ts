import {
  previewLanderUtmRedecoration,
  type LanderUtmPreviewDependencies,
} from "../services/landerUtmRedecoratePreview";

const deployed = (overrides: Record<string, unknown> = {}) => ({
  id: "lander-1",
  userId: "user-1",
  name: "One",
  status: "deployed" as const,
  deployedUrl: "https://one.example",
  ...overrides,
});

function dependencies(overrides: Partial<LanderUtmPreviewDependencies> = {}): LanderUtmPreviewDependencies {
  return {
    listLanders: jest.fn().mockResolvedValue([deployed()]),
    getCustomerDefault: jest.fn().mockResolvedValue({
      utm_source: "meta",
      utm_medium: "paid",
    }),
    readDeployedLinks: jest.fn().mockResolvedValue([
      {
        location: "app/page.tsx:12",
        href: "https://customer.example/demo?utm_source=old&utm_campaign=retired&gclid=keep-me",
      },
    ]),
    ...overrides,
  };
}

describe("UTM redecorate dry-run preview (ENG-728)", () => {
  it("reports exact per-link parameter changes without exposing a write boundary", async () => {
    const deps = dependencies();

    const result = await previewLanderUtmRedecoration({ userId: "user-1" }, deps);

    expect(result).toEqual({
      rows: [
        {
          landerId: "lander-1",
          name: "One",
          status: "changed",
          changes: [
            {
              location: "app/page.tsx:12",
              before: "https://customer.example/demo?utm_source=old&utm_campaign=retired&gclid=keep-me",
              after: "https://customer.example/demo?utm_source=meta&utm_medium=paid&gclid=keep-me&aw_lander=1",
              params: {
                added: { utm_medium: "paid", aw_lander: "1" },
                updated: { utm_source: { from: "old", to: "meta" } },
                removed: { utm_campaign: "retired" },
              },
            },
          ],
        },
      ],
      summary: { changed: 1, noChange: 0, skipped: 0, errors: 0, linkChanges: 1 },
    });
    expect(Object.keys(deps).sort()).toEqual([
      "getCustomerDefault",
      "listLanders",
      "readDeployedLinks",
    ]);
  });

  it("is idempotent when deployed links already carry resolved values", async () => {
    const deps = dependencies({
      readDeployedLinks: jest.fn().mockResolvedValue([
        {
          location: "app/page.tsx:12",
          href: "https://customer.example/demo?utm_source=meta&utm_medium=paid&aw_lander=1",
        },
      ]),
    });

    const result = await previewLanderUtmRedecoration({ userId: "user-1" }, deps);

    expect(result.rows).toEqual([
      { landerId: "lander-1", name: "One", status: "no_change", changes: [] },
    ]);
    expect(result.summary).toEqual({ changed: 0, noChange: 1, skipped: 0, errors: 0, linkChanges: 0 });
  });

  it("skips overridden landers unless that lander is explicitly selected", async () => {
    const page = deployed({ utmOverride: { utm_campaign: "lander-launch" } });
    const readDeployedLinks = jest.fn().mockResolvedValue([
      { location: "app/page.tsx:8", href: "https://customer.example/demo" },
    ]);
    const deps = dependencies({
      listLanders: jest.fn().mockResolvedValue([page]),
      readDeployedLinks,
    });

    const skipped = await previewLanderUtmRedecoration({ userId: "user-1" }, deps);
    expect(skipped.rows).toEqual([
      {
        landerId: "lander-1",
        name: "One",
        status: "skipped",
        reason: "explicit_per_lander_override",
        changes: [],
      },
    ]);
    expect(readDeployedLinks).not.toHaveBeenCalled();

    const selected = await previewLanderUtmRedecoration(
      { userId: "user-1", selectedLanderIds: ["lander-1"] },
      deps,
    );
    expect(selected.rows[0]).toMatchObject({ status: "changed" });
    expect((selected.rows[0] as any).changes[0].after).toContain("utm_campaign=lander-launch");

    const emptyOverrideDeps = dependencies({
      listLanders: jest.fn().mockResolvedValue([deployed({ utmOverride: {} })]),
    });
    const inherited = await previewLanderUtmRedecoration({ userId: "user-1" }, emptyOverrideDeps);
    expect(inherited.rows[0]).toMatchObject({ status: "changed" });
  });

  it.each([
    { utm_source: "" },
    { gclid: "forbidden" },
    ["not-a-config"],
  ])("reports corrupt overrides as errors instead of skipping them: %p", async (utmOverride) => {
    const deps = dependencies({
      listLanders: jest.fn().mockResolvedValue([deployed({ utmOverride })]),
    });
    const result = await previewLanderUtmRedecoration({ userId: "user-1" }, deps);
    expect(result.rows[0]).toMatchObject({ landerId: "lander-1", status: "error" });
    expect(result.summary).toMatchObject({ skipped: 0, errors: 1, noChange: 0 });
    expect(deps.readDeployedLinks).not.toHaveBeenCalled();
  });

  it("never proposes removing gclid or fbclid", async () => {
    const deps = dependencies({
      getCustomerDefault: jest.fn().mockResolvedValue(null),
      readDeployedLinks: jest.fn().mockResolvedValue([
        {
          location: "app/page.tsx:4",
          href: "https://customer.example/?utm_source=old&gclid=g-1&fbclid=f-1",
        },
      ]),
    });

    const result = await previewLanderUtmRedecoration({ userId: "user-1" }, deps);
    const change = (result.rows[0] as any).changes[0];
    expect(change.params.removed).toEqual({ utm_source: "old" });
    expect(change.after).toContain("gclid=g-1");
    expect(change.after).toContain("fbclid=f-1");
  });

  it("preserves repeated non-managed query parameters", async () => {
    const deps = dependencies({
      readDeployedLinks: jest.fn().mockResolvedValue([
        {
          location: "app/page.tsx:5",
          href: "https://customer.example/?choice=one&choice=two",
        },
      ]),
    });

    const result = await previewLanderUtmRedecoration({ userId: "user-1" }, deps);

    expect(result.rows[0]).toMatchObject({ status: "changed" });
    expect((result.rows[0] as any).changes[0].after).toContain("choice=one&choice=two");
  });

  it.each([
    ["missing", null],
    ["corrupt", [{ location: "app/page.tsx:1", href: "not a url" }]],
    ["blank location", [{ location: "   ", href: "https://customer.example/demo" }]],
  ])("reports a %s deployed record as an error row", async (_label, links) => {
    const deps = dependencies({ readDeployedLinks: jest.fn().mockResolvedValue(links as any) });

    const result = await previewLanderUtmRedecoration({ userId: "user-1" }, deps);

    expect(result.rows[0]).toMatchObject({ landerId: "lander-1", status: "error" });
    expect(result.summary).toEqual({ changed: 0, noChange: 0, skipped: 0, errors: 1, linkChanges: 0 });
  });

  it("reports deployment read failures and remains side-effect free across repeated runs", async () => {
    const deps = dependencies({
      readDeployedLinks: jest.fn().mockRejectedValue(new Error("deployment unavailable")),
    });

    const first = await previewLanderUtmRedecoration({ userId: "user-1" }, deps);
    const second = await previewLanderUtmRedecoration({ userId: "user-1" }, deps);

    expect(first).toEqual(second);
    expect(first.rows[0]).toMatchObject({ status: "error", error: "deployment unavailable" });
  });
});
