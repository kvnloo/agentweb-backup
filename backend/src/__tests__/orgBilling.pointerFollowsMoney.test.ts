/**
 * ENG-954 — why a paying billing owner cannot be released.
 *
 * Harsha: "prove that if the billing owner hops, the remaining billing owner
 * can still work with the stripe credit card."
 *
 * They cannot, and this is the proof. It drives the REAL resolver,
 * `subscriptionService.getUserSubscriptionType` — the same function agent mode,
 * Emma and `/auth/me` call to decide what an org is entitled to — with only the
 * data layer faked. Nothing about the resolution logic is stubbed.
 *
 * The shape of the problem:
 *
 *   Organization.ownerUserId  ->  a USER
 *   that user                 ->  their own stripe_customer_id + subscription
 *   the org's tier            ->  that user's subscriptionType
 *
 * So the pointer selects whose card the org rides on. Stripe cannot reassign a
 * subscription to a different customer, so moving the pointer moves the
 * entitlement WITHOUT moving the money — the org lands on the new owner's
 * subscription, which for a teammate who never paid is nothing.
 *
 * That is the silent downgrade the removal refusal exists to prevent, and this
 * pins the mechanism so nobody removes the refusal thinking it is paperwork.
 */

const mockGetUserById = jest.fn();
const mockGetOrgById = jest.fn();

jest.mock("../services/db", () => ({
  userDb: { getUserById: (id: string) => mockGetUserById(id) },
  orgDb: { getOrgById: (id: string) => mockGetOrgById(id) },
  subscriptionTypeDb: { getSubscriptionType: jest.fn().mockResolvedValue(null) },
}));

import { getUserSubscriptionType } from "../services/subscriptionService";

const ORG = "org-1";
const PAYER = "u-payer";      // holds the Stripe customer and the card
const TEAMMATE = "u-teammate"; // a second owner who never paid
const STAFFER = "u-staffer";   // an ordinary member

/** The org's stored record, with a movable billing pointer. */
let org: { orgId: string; ownerUserId: string };

const users: Record<string, any> = {};

beforeEach(() => {
  jest.clearAllMocks();
  org = { orgId: ORG, ownerUserId: PAYER };

  users[PAYER] = {
    userId: PAYER, orgId: ORG, orgRole: "owner",
    subscriptionType: "Pro",
    subscription_status: "active",
    stripe_customer_id: "cus_PAYER",
    stripe_subscription_id: "sub_PAYER",
  };
  // A real second owner: full authority, no billing relationship whatsoever.
  users[TEAMMATE] = { userId: TEAMMATE, orgId: ORG, orgRole: "owner" };
  users[STAFFER] = { userId: STAFFER, orgId: ORG, orgRole: "member" };

  mockGetUserById.mockImplementation((id: string) => Promise.resolve(users[id] ?? null));
  mockGetOrgById.mockImplementation((id: string) => Promise.resolve(id === ORG ? org : null));
});

describe("the org rides on the billing owner's Stripe subscription", () => {
  it("every member is entitled to Pro while the payer holds the pointer", async () => {
    expect(await getUserSubscriptionType(PAYER)).toBe("Pro");
    expect(await getUserSubscriptionType(TEAMMATE)).toBe("Pro");
    expect(await getUserSubscriptionType(STAFFER)).toBe("Pro");
  });

  it("the entitlement comes from the payer's own record, not from the org", async () => {
    users[PAYER].subscriptionType = "Enterprise";
    expect(await getUserSubscriptionType(STAFFER)).toBe("Enterprise");
    // There is no org-level tier to fall back on — this is the whole coupling.
  });
});

describe("moving the pointer moves the entitlement but NOT the money", () => {
  it("hopping billing to a teammate drops the entire org to Free", async () => {
    expect(await getUserSubscriptionType(STAFFER)).toBe("Pro");

    // Exactly what "the remover inherits billing" does to the stored record.
    org.ownerUserId = TEAMMATE;

    expect(await getUserSubscriptionType(STAFFER)).toBe("Free");
    expect(await getUserSubscriptionType(TEAMMATE)).toBe("Free");
  });

  it("...while the payer's card keeps being charged for an org they left", async () => {
    org.ownerUserId = TEAMMATE;
    delete users[PAYER].orgId; // they have been removed
    delete users[PAYER].orgRole;

    // Untouched: Stripe has no idea anything happened.
    expect(users[PAYER].stripe_customer_id).toBe("cus_PAYER");
    expect(users[PAYER].stripe_subscription_id).toBe("sub_PAYER");
    expect(users[PAYER].subscription_status).toBe("active");
    // Still billing them, now for nobody's benefit.
    expect(await getUserSubscriptionType(PAYER)).toBe("Pro");
  });

  it("the new billing owner cannot use the old card — they have no Stripe customer at all", async () => {
    org.ownerUserId = TEAMMATE;
    expect(users[TEAMMATE].stripe_customer_id).toBeUndefined();
    expect(users[TEAMMATE].subscription_status).toBeUndefined();
    // Which is precisely why the org reads Free: there is nothing to read.
    expect(await getUserSubscriptionType(STAFFER)).toBe("Free");
  });

  it("no error, no exception, no signal — the downgrade is silent", async () => {
    const before = await getUserSubscriptionType(STAFFER);
    org.ownerUserId = TEAMMATE;
    const after = await getUserSubscriptionType(STAFFER);
    expect(before).toBe("Pro");
    expect(after).toBe("Free");
    // Resolution succeeded both times. Nothing threw, nothing warned. A caller
    // asking "what is this org entitled to" is simply told a smaller number.
  });
});

describe("the hop is safe exactly when there is no money on the pointer", () => {
  it("a free org hops with nothing lost — which is why the refusal is conditional", async () => {
    users[PAYER].subscriptionType = "Free";
    delete users[PAYER].subscription_status;
    delete users[PAYER].stripe_customer_id;

    expect(await getUserSubscriptionType(STAFFER)).toBe("Free");
    org.ownerUserId = TEAMMATE;
    expect(await getUserSubscriptionType(STAFFER)).toBe("Free");
  });

  it("a teammate who pays for themselves is unharmed by the hop", async () => {
    // Their own live subscription governs, per the ENG-288 rule.
    users[TEAMMATE].subscriptionType = "Starter";
    users[TEAMMATE].subscription_status = "active";
    org.ownerUserId = TEAMMATE;
    expect(await getUserSubscriptionType(TEAMMATE)).toBe("Starter");
    // But everyone else still lands on the new pointer's tier.
    expect(await getUserSubscriptionType(STAFFER)).toBe("Starter");
  });
});
