import { deriveSelfActivity, SELF_ACTIVITY_WINDOW_DAYS } from "../selfActivity";

const now = new Date("2026-09-23T12:00:00.000Z");
const daysAgo = (d: number) => new Date(now.getTime() - d * 24 * 60 * 60 * 1000).toISOString();

// ENG-1250 AC7: "spend this month" is supplied by the caller from the spend ledger, not read
// off the retired legacy counter, so it is an explicit argument here.
describe("deriveSelfActivity (ENG-1271)", () => {
  it("staff-operated shape: spend this month, customer never active -> suspect", () => {
    expect(deriveSelfActivity({}, true, now)).toEqual({
      selfActiveRecently: false,
      lastSelfActiveAt: null,
      staffOperatedSuspect: true,
    });
  });

  it("customer self-operating: recent self-activity + spend -> not suspect", () => {
    const r = deriveSelfActivity({ lastActiveAt: "2026-09-20T00:00:00.000Z" }, true, now);
    expect(r.selfActiveRecently).toBe(true);
    expect(r.staffOperatedSuspect).toBe(false);
    expect(r.lastSelfActiveAt).toBe("2026-09-20T00:00:00.000Z");
  });

  it("stale self-activity (>30d) with spend -> suspect", () => {
    const r = deriveSelfActivity({ lastActiveAt: "2026-08-01T00:00:00.000Z" }, true, now);
    expect(r.selfActiveRecently).toBe(false);
    expect(r.staffOperatedSuspect).toBe(true);
  });

  it("no spend this month -> not suspect, even if never active", () => {
    expect(deriveSelfActivity({}, false, now).staffOperatedSuspect).toBe(false);
    expect(deriveSelfActivity({ lastActiveAt: daysAgo(200) }, false, now).staffOperatedSuspect).toBe(false);
  });

  it("the window boundary is inclusive: exactly SELF_ACTIVITY_WINDOW_DAYS ago is still recent", () => {
    expect(deriveSelfActivity({ lastActiveAt: daysAgo(SELF_ACTIVITY_WINDOW_DAYS) }, true, now).selfActiveRecently).toBe(true);
    expect(deriveSelfActivity({ lastActiveAt: daysAgo(SELF_ACTIVITY_WINDOW_DAYS + 1) }, true, now).selfActiveRecently).toBe(false);
  });

  it("unparseable lastActiveAt is treated as absent", () => {
    const r = deriveSelfActivity({ lastActiveAt: "not-a-date" }, true, now);
    expect(r.lastSelfActiveAt).toBeNull();
    expect(r.staffOperatedSuspect).toBe(true);
  });

  it("does not treat a future lastActiveAt as recent self-activity", () => {
    const r = deriveSelfActivity({ lastActiveAt: "2026-12-01T00:00:00.000Z" }, true, now);
    expect(r.selfActiveRecently).toBe(false);
    expect(r.staffOperatedSuspect).toBe(true);
  });

  it("reports lastSelfActiveAt as a normalised ISO instant", () => {
    expect(deriveSelfActivity({ lastActiveAt: "2026-09-20T09:30:00+00:00" }, false, now).lastSelfActiveAt).toBe(
      "2026-09-20T09:30:00.000Z",
    );
  });
});
