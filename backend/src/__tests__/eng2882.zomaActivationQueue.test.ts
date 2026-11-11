process.env.ZOMA_REQUIRE_PAYMENT_METHOD = 'true';
import {
  ZomaTrackedUser,
  buildTracker,
  businessDaysBetween,
  dailyFollowUpList,
  helpAlert,
  isStalled,
} from "../services/zomaActivationQueue";

const base: ZomaTrackedUser = { name: "Test", email: "t@x.com", dateInvited: "2026-11-09T15:00:00Z" };
const tue = new Date("2026-11-10T16:00:00Z");

describe("ENG-2882 Zoma activation queue", () => {
  it("a test user moves through every stage with a next action until activated", () => {
    const steps: Array<[Partial<ZomaTrackedUser>, string, string | null]> = [
      [{}, "invited", "Nudge to register"],
      [{ dateRegistered: "2026-11-09T16:00:00Z" }, "registered", "Nudge to start onboarding"],
      [{ onboardingStatus: "in_progress" }, "onboarding", "Help connect ad account"],
      [{ adAccountStatus: "connected" }, "ad_account_connected", "Help launch first ad"],
      [{ firstAdStatus: "launched" }, "activated", null],
    ];
    let u = { ...base };
    for (const [patch, stage, action] of steps) {
      u = { ...u, ...patch };
      const [row] = buildTracker([u], tue);
      expect(row.stage).toBe(stage);
      expect(row.nextAction).toBe(action);
    }
  });

  it("counts business days and skips weekends", () => {
    expect(businessDaysBetween(new Date("2026-11-06T12:00:00Z"), new Date("2026-11-09T12:00:00Z"))).toBe(1); // Fri->Mon
    expect(businessDaysBetween(new Date("2026-11-09T12:00:00Z"), new Date("2026-11-09T11:00:00Z"))).toBe(0);
  });

  it("flags users stalled more than one business day, not over a weekend", () => {
    expect(isStalled(base, tue)).toBe(false);
    expect(isStalled(base, new Date("2026-11-11T16:00:00Z"))).toBe(true);
    expect(isStalled({ ...base, dateInvited: "2026-11-06T15:00:00Z" }, new Date("2026-11-09T16:00:00Z"))).toBe(false);
    expect(isStalled({ ...base, dateInvited: "bad" }, tue)).toBe(true);
    expect(isStalled({ ...base, firstAdStatus: "launched", dateInvited: "2026-01-01" }, tue)).toBe(false);
  });

  it("every unactivated user has a next action; blocker wins", () => {
    const rows = buildTracker(
      [base, { ...base, email: "b@x.com", currentBlocker: "Meta BM verification" }, { ...base, email: "c@x.com", adAccountStatus: "error" }],
      tue,
    );
    expect(rows.every((r) => r.nextAction)).toBe(true);
    expect(rows[1].nextAction).toBe("Resolve blocker: Meta BM verification");
    expect(rows[2].nextAction).toBe("Help fix ad account connection");
  });

  it("daily list: dedupes by email, drops activated and not-yet-due, help first; alert targets Harsha+Fangfang", () => {
    const users: ZomaTrackedUser[] = [
      { ...base, email: "A@x.com", nextFollowUpDate: "2026-11-12" },
      { ...base, email: "a@x.com", nextFollowUpDate: "2026-11-09" },
      { ...base, email: "done@x.com", firstAdStatus: "launched" },
      { ...base, email: "later@x.com", nextFollowUpDate: "2026-11-20" },
      { ...base, email: "stuck@x.com", dateRegistered: "2026-11-09", currentBlocker: "pixel" },
    ];
    const list = dailyFollowUpList(users, tue);
    expect(list.map((r) => r.email)).toEqual(["stuck@x.com", "a@x.com"]);
    const alert = helpAlert(list);
    expect(alert?.notify).toEqual(["Harsha", "Fangfang"]);
    expect(alert?.users.map((r) => r.email)).toEqual(["stuck@x.com"]);
    expect(helpAlert([])).toBeNull();
    expect(buildTracker(users, tue)).toHaveLength(4);
  });

  it("treats offset-free date-times as UTC regardless of server timezone", () => {
    // Invited Mon 23:30 UTC, checked Wed 23:45 UTC = 2 business days -> stalled.
    // A UTC-08 host reading the offset-free string as local time would see only 1.
    const now = new Date("2026-11-11T23:45:00Z");
    expect(isStalled({ ...base, dateInvited: "2026-11-09T23:30:00" }, now)).toBe(true);
    expect(isStalled({ ...base, dateInvited: "2026-11-09T23:30:00Z" }, now)).toBe(true);
    // Explicit offsets are honoured: Mon 23:30-08:00 = Tue 07:30 UTC -> 1 business day.
    expect(isStalled({ ...base, dateInvited: "2026-11-09T23:30:00-08:00" }, now)).toBe(false);
  });
});
