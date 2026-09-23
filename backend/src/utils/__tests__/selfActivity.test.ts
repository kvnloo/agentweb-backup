import { deriveSelfActivity } from "../selfActivity";

const now = new Date("2026-09-23T12:00:00.000Z");
const heavyUsage = { month: "2026-09", totalTokens: 126_000_000 };

describe("deriveSelfActivity (ENG-1271)", () => {
  it("staff-operated shape: heavy usage, customer never active -> suspect", () => {
    expect(deriveSelfActivity({ tokenUsage: heavyUsage }, now)).toEqual({
      selfActiveRecently: false,
      lastSelfActiveAt: null,
      staffOperatedSuspect: true,
    });
  });

  it("customer self-operating: recent self-activity + usage -> not suspect", () => {
    const r = deriveSelfActivity(
      { lastActiveAt: "2026-09-20T00:00:00.000Z", tokenUsage: heavyUsage },
      now,
    );
    expect(r.selfActiveRecently).toBe(true);
    expect(r.staffOperatedSuspect).toBe(false);
    expect(r.lastSelfActiveAt).toBe("2026-09-20T00:00:00.000Z");
  });

  it("stale self-activity (>30d) with usage -> suspect", () => {
    const r = deriveSelfActivity(
      { lastActiveAt: "2026-08-01T00:00:00.000Z", tokenUsage: heavyUsage },
      now,
    );
    expect(r.selfActiveRecently).toBe(false);
    expect(r.staffOperatedSuspect).toBe(true);
  });

  it("no usage this month -> not suspect, even if never active", () => {
    expect(deriveSelfActivity({}, now).staffOperatedSuspect).toBe(false);
    expect(
      deriveSelfActivity(
        { tokenUsage: { month: "2026-08", totalTokens: 500 } },
        now,
      ).staffOperatedSuspect,
    ).toBe(false);
  });

  it("unparseable lastActiveAt is treated as absent", () => {
    const r = deriveSelfActivity(
      { lastActiveAt: "not-a-date", tokenUsage: heavyUsage },
      now,
    );
    expect(r.lastSelfActiveAt).toBeNull();
    expect(r.staffOperatedSuspect).toBe(true);
  });
});
