/**
 * WS3: Slack Connect provisioning for onboarding.
 *
 * On signup we auto-create a private "{company}-agentweb" channel, pre-seed
 * the team, send a Slack Connect invite to the signup email, post a welcome,
 * and stamp the channel id on the user record. EXTERNAL-HARD to verify live
 * (needs the bot token + conversations.connect scope + paid-plan Connect),
 * so it's flag-gated (default off) and fully covered here with a fake client.
 */

import {
  provisionOnboardingSlackConnect,
  slugifyForSlackChannel,
} from "../services/slackConnectService";

function fakeClient(overrides: any = {}) {
  const calls: any = { create: [], invite: [], inviteShared: [], postMessage: [] };
  const client = {
    conversations: {
      create: jest.fn(async (a: any) => {
        calls.create.push(a);
        return { ok: true, channel: { id: "C123" } };
      }),
      invite: jest.fn(async (a: any) => {
        calls.invite.push(a);
        return { ok: true };
      }),
      inviteShared: jest.fn(async (a: any) => {
        calls.inviteShared.push(a);
        return { ok: true, invite_id: "I999" };
      }),
    },
    chat: {
      postMessage: jest.fn(async (a: any) => {
        calls.postMessage.push(a);
        return { ok: true };
      }),
    },
    ...overrides,
  };
  return { client, calls };
}

const baseInput = {
  userId: "user-1",
  companyName: "Acme Inc.",
  companyEmail: "founder@acme.com",
};

describe("slugifyForSlackChannel", () => {
  it("lowercases, strips punctuation, collapses spaces to hyphens", () => {
    expect(slugifyForSlackChannel("Acme Inc.")).toBe("acme-inc");
    expect(slugifyForSlackChannel("Foo   Bar!!")).toBe("foo-bar");
    expect(slugifyForSlackChannel("WEIRD..Name__x")).toBe("weird-name-x");
  });
  it("caps length and trims stray hyphens", () => {
    expect(slugifyForSlackChannel("---a---")).toBe("a");
    expect(slugifyForSlackChannel("x".repeat(100)).length).toBeLessThanOrEqual(60);
  });
  it("returns empty string for empty/garbage", () => {
    expect(slugifyForSlackChannel("")).toBe("");
    expect(slugifyForSlackChannel("...")).toBe("");
  });
});

describe("provisionOnboardingSlackConnect", () => {
  it("is a no-op when the feature flag is disabled", async () => {
    const { client } = fakeClient();
    const res = await provisionOnboardingSlackConnect(baseInput, {
      client,
      enabled: false,
    });
    expect(res.status).toBe("disabled");
    expect(client.conversations.create).not.toHaveBeenCalled();
  });

  it("skips when no usable email", async () => {
    const { client } = fakeClient();
    const res = await provisionOnboardingSlackConnect(
      { ...baseInput, companyEmail: "not-an-email" },
      { client, enabled: true },
    );
    expect(res.status).toBe("skipped");
    expect(client.conversations.create).not.toHaveBeenCalled();
  });

  it("skips when no slack client is available", async () => {
    const res = await provisionOnboardingSlackConnect(baseInput, {
      client: null as any,
      enabled: true,
    });
    expect(res.status).toBe("skipped");
  });

  it("happy path: creates channel, invites team, inviteShared, posts, persists", async () => {
    const { client, calls } = fakeClient();
    const persisted: any[] = [];
    const res = await provisionOnboardingSlackConnect(baseInput, {
      client,
      enabled: true,
      teamUserIds: ["UTEAM1", "UTEAM2"],
      persist: async (userId, patch) => {
        persisted.push({ userId, patch });
      },
      now: () => new Date("2026-06-14T00:00:00Z"),
    });
    expect(res.status).toBe("created");
    expect(res.channelId).toBe("C123");
    expect(calls.create[0].name).toBe("acme-inc-agentweb");
    expect(calls.create[0].is_private).toBe(true);
    expect(calls.invite[0].users).toContain("UTEAM1");
    expect(calls.inviteShared[0].emails).toEqual(["founder@acme.com"]);
    expect(calls.postMessage.length).toBe(1);
    expect(persisted[0].userId).toBe("user-1");
    expect(persisted[0].patch.slackConnectChannelId).toBe("C123");
  });

  it("derives the slug from the email domain when companyName is blank", async () => {
    const { client, calls } = fakeClient();
    const res = await provisionOnboardingSlackConnect(
      { ...baseInput, companyName: "" },
      { client, enabled: true },
    );
    expect(res.status).toBe("created");
    expect(calls.create[0].name).toBe("acme-agentweb");
  });

  it("returns failed when channel creation fails", async () => {
    const { client } = fakeClient({
      conversations: {
        create: jest.fn(async () => ({ ok: false, error: "name_taken" })),
        invite: jest.fn(),
        inviteShared: jest.fn(),
      },
    });
    const res = await provisionOnboardingSlackConnect(baseInput, { client, enabled: true });
    expect(res.status).toBe("failed");
    expect(res.reason).toMatch(/name_taken|create/i);
  });

  it("returns failed when the Slack Connect invite fails", async () => {
    const { client } = fakeClient({
      conversations: {
        create: jest.fn(async () => ({ ok: true, channel: { id: "C123" } })),
        invite: jest.fn(async () => ({ ok: true })),
        inviteShared: jest.fn(async () => ({ ok: false, error: "invalid_email" })),
      },
    });
    const res = await provisionOnboardingSlackConnect(baseInput, { client, enabled: true });
    expect(res.status).toBe("failed");
  });

  it("team-invite failure is non-fatal — still created", async () => {
    const { client } = fakeClient({
      conversations: {
        create: jest.fn(async () => ({ ok: true, channel: { id: "C123" } })),
        invite: jest.fn(async () => ({ ok: false, error: "cant_invite" })),
        inviteShared: jest.fn(async () => ({ ok: true, invite_id: "I999" })),
      },
      chat: { postMessage: jest.fn(async () => ({ ok: true })) },
    });
    const res = await provisionOnboardingSlackConnect(baseInput, {
      client,
      enabled: true,
      teamUserIds: ["UTEAM1"],
    });
    expect(res.status).toBe("created");
  });

  it("never throws — a Slack SDK exception resolves to failed", async () => {
    const { client } = fakeClient({
      conversations: {
        create: jest.fn(async () => {
          throw new Error("network down");
        }),
        invite: jest.fn(),
        inviteShared: jest.fn(),
      },
    });
    const res = await provisionOnboardingSlackConnect(baseInput, { client, enabled: true });
    expect(res.status).toBe("failed");
  });
});
