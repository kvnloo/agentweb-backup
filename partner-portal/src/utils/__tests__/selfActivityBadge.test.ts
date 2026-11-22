import { staffOperatedBadge } from "../selfActivityBadge";

describe("staffOperatedBadge (ENG-1271)", () => {
  it("flags an account the backend marks staffOperatedSuspect", () => {
    const badge = staffOperatedBadge({
      selfActivity: { selfActiveRecently: false, lastSelfActiveAt: null, staffOperatedSuspect: true },
    });
    expect(badge).not.toBeNull();
    expect(badge?.label).toBe("Staff-operated?");
    expect(badge?.tooltip).toMatch(/no customer self-activity/i);
  });

  it("mentions the last self-active date when one exists", () => {
    const badge = staffOperatedBadge({
      selfActivity: {
        selfActiveRecently: false,
        lastSelfActiveAt: "2026-07-01T00:00:00.000Z",
        staffOperatedSuspect: true,
      },
    });
    expect(badge?.tooltip).toContain("2026-07-01");
  });

  it("returns null for a self-active customer", () => {
    expect(
      staffOperatedBadge({
        selfActivity: { selfActiveRecently: true, lastSelfActiveAt: "2026-10-01T00:00:00.000Z", staffOperatedSuspect: false },
      }),
    ).toBeNull();
  });

  it("returns null when the field is absent or malformed (older backend)", () => {
    expect(staffOperatedBadge({})).toBeNull();
    expect(staffOperatedBadge({ selfActivity: null as any })).toBeNull();
    expect(staffOperatedBadge({ selfActivity: { staffOperatedSuspect: "yes" } as any })).toBeNull();
  });

  it("returns null for a malformed lastSelfActiveAt", () => {
    expect(
      staffOperatedBadge({ selfActivity: { selfActiveRecently: false, lastSelfActiveAt: "not-a-date", staffOperatedSuspect: true } }),
    ).toBeNull();
    expect(
      staffOperatedBadge({ selfActivity: { selfActiveRecently: false, lastSelfActiveAt: 42, staffOperatedSuspect: true } as any }),
    ).toBeNull();
  });
});
