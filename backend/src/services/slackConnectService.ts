/**
 * Slack Connect provisioning for onboarding (WS3).
 *
 * On signup, auto-create a private "{company}-agentweb" channel, pre-seed the
 * team, send a Slack Connect invite to the signup email so the customer lands
 * in a populated shared channel, post a welcome, and stamp the channel id on
 * the user record.
 *
 * Flag-gated (SLACK_CONNECT_ENABLED) and OFF by default. The mechanism is
 * fully built + unit-tested here against an injected client, but going live
 * is EXTERNAL-HARD: it needs a bot token with the `conversations.connect:write`
 * scope on a paid-plan workspace, plus auto-approve config — Harsha's setup.
 * Until the flag is on this is inert (no behavior change).
 *
 * Best-effort: every failure resolves to a {status:'failed'} result; this must
 * never throw into or block the onboarding cascade.
 */

import { userDb } from "./db";

/** The slice of the Slack WebClient surface this service needs. The real
 *  `@slack/web-api` WebClient satisfies it structurally; tests pass a fake. */
export interface SlackConnectClient {
  conversations: {
    create(args: {
      name: string;
      is_private?: boolean;
    }): Promise<{ ok?: boolean; channel?: { id?: string }; error?: string }>;
    invite(args: {
      channel: string;
      users: string;
    }): Promise<{ ok?: boolean; error?: string }>;
    inviteShared(args: {
      channel: string;
      emails: string[];
    }): Promise<{ ok?: boolean; invite_id?: string; error?: string }>;
  };
  chat: {
    postMessage(args: {
      channel: string;
      text: string;
    }): Promise<{ ok?: boolean; error?: string }>;
  };
}

export type SlackConnectStatus = "disabled" | "skipped" | "created" | "failed";

export interface SlackConnectResult {
  status: SlackConnectStatus;
  channelId?: string;
  inviteId?: string;
  reason?: string;
}

export interface ProvisionInput {
  userId: string;
  companyName?: string;
  /** The account/company email the Connect invite is sent to. */
  companyEmail: string;
  /** Existing linked Connect channel. When present, provisioning is idempotent. */
  existingChannelId?: string;
}

export interface ProvisionDeps {
  client?: SlackConnectClient | null;
  /** Slack user ids to pre-seed the channel with (your team). */
  teamUserIds?: string[];
  /** Override the SLACK_CONNECT_ENABLED flag (tests). */
  enabled?: boolean;
  /** Persist the channel ref. Defaults to userDb.updateUser. */
  persist?: (userId: string, patch: Record<string, unknown>) => Promise<void>;
  now?: () => Date;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Convert a company name into a Slack-channel-safe slug: lowercase, only
 * a-z0-9 and single hyphens, trimmed, capped. Returns "" if nothing usable.
 */
export function slugifyForSlackChannel(name: string): string {
  return (name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60)
    .replace(/-$/g, "");
}

function domainSlugFromEmail(email: string): string {
  const at = email.indexOf("@");
  if (at < 0) return "";
  const host = email.slice(at + 1);
  const label = host.split(".")[0] ?? "";
  return slugifyForSlackChannel(label);
}

function defaultClient(): SlackConnectClient | null {
  if (!process.env.SLACK_BOT_TOKEN) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { WebClient } = require("@slack/web-api");
    return new WebClient(process.env.SLACK_BOT_TOKEN) as unknown as SlackConnectClient;
  } catch {
    return null;
  }
}

/**
 * Provision a Slack Connect channel for a freshly-onboarded account. Returns a
 * status; never throws.
 */
export async function provisionOnboardingSlackConnect(
  input: ProvisionInput,
  deps: ProvisionDeps = {},
): Promise<SlackConnectResult> {
  const persist: (userId: string, patch: Record<string, unknown>) => Promise<void> =
    deps.persist ??
    (async (userId, patch) => {
      await userDb.updateUser(userId, patch as any);
    });
  const now = deps.now ?? (() => new Date());

  if (input.existingChannelId) {
    return {
      status: "created",
      channelId: input.existingChannelId,
      reason: "slack connect channel already linked",
    };
  }

  const enabled = deps.enabled ?? process.env.SLACK_CONNECT_ENABLED === "true";
  if (!enabled) {
    await persistAttempt(persist, input.userId, {
      slackConnectStatus: "disabled",
      slackConnectAttemptedAt: now().toISOString(),
    });
    return { status: "disabled" };
  }

  const email = (input.companyEmail || "").trim();
  if (!EMAIL_RE.test(email)) {
    await persistAttempt(persist, input.userId, {
      slackConnectStatus: "skipped",
      slackConnectAttemptedAt: now().toISOString(),
      slackConnectError: "no usable company email",
    });
    return { status: "skipped", reason: "no usable company email" };
  }

  const slug =
    slugifyForSlackChannel(input.companyName ?? "") || domainSlugFromEmail(email);
  if (!slug) {
    await persistAttempt(persist, input.userId, {
      slackConnectStatus: "skipped",
      slackConnectAttemptedAt: now().toISOString(),
      slackConnectInviteEmail: email,
      slackConnectError: "could not derive a channel slug",
    });
    return { status: "skipped", reason: "could not derive a channel slug" };
  }

  const client = deps.client !== undefined ? deps.client : defaultClient();
  if (!client) {
    await persistAttempt(persist, input.userId, {
      slackConnectStatus: "skipped",
      slackConnectAttemptedAt: now().toISOString(),
      slackConnectInviteEmail: email,
      slackConnectError: "no slack client (token missing)",
    });
    return { status: "skipped", reason: "no slack client (token missing)" };
  }

  const channelName = `${slug}-agentweb`.slice(0, 80);
  const teamUserIds = deps.teamUserIds ?? envTeamUserIds();
  const attemptedAt = now().toISOString();

  try {
    // 1. Create the private channel.
    const created = await client.conversations.create({
      name: channelName,
      is_private: true,
    });
    const channelId = created?.channel?.id;
    if (!created?.ok || !channelId) {
      const reason = `create failed: ${created?.error ?? "unknown"}`;
      await persistAttempt(persist, input.userId, {
        slackConnectStatus: "failed",
        slackConnectAttemptedAt: attemptedAt,
        slackConnectInviteEmail: email,
        slackConnectError: reason,
      });
      return { status: "failed", reason };
    }

    // 2. Pre-seed the team (non-fatal — a populated channel is nicer but an
    //    invite failure shouldn't abort the Connect invite).
    if (teamUserIds.length > 0) {
      try {
        await client.conversations.invite({ channel: channelId, users: teamUserIds.join(",") });
      } catch {
        /* non-fatal */
      }
    }

    // 3. Slack Connect invite to the customer email — the step that makes it
    //    a cross-org shared channel.
    const shared = await client.conversations.inviteShared({
      channel: channelId,
      emails: [email],
    });
    if (!shared?.ok) {
      const reason = `inviteShared failed: ${shared?.error ?? "unknown"}`;
      await persistAttempt(persist, input.userId, {
        slackConnectStatus: "failed",
        slackConnectAttemptedAt: attemptedAt,
        slackConnectInviteEmail: email,
        slackConnectError: reason,
      });
      return {
        status: "failed",
        channelId,
        reason,
      };
    }

    // 4. Welcome message so the channel isn't silent on arrival (non-fatal).
    try {
      await client.chat.postMessage({
        channel: channelId,
        text: `Welcome${input.companyName ? ` ${input.companyName}` : ""}! This is your private Slack Connect channel with the AgentWeb team — drop questions here anytime.`,
      });
    } catch {
      /* non-fatal */
    }

    // 5. Link the channel to the account.
    try {
      await persist(input.userId, {
        slackConnectStatus: "created",
        slackConnectChannelId: channelId,
        slackConnectInvitedAt: now().toISOString(),
        slackConnectAttemptedAt: attemptedAt,
        slackConnectInviteEmail: email,
        ...(shared.invite_id ? { slackConnectInviteId: shared.invite_id } : {}),
        slackConnectError: null,
      });
    } catch {
      /* non-fatal — the channel exists even if the stamp write blips */
    }

    return { status: "created", channelId, inviteId: shared.invite_id };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await persistAttempt(persist, input.userId, {
      slackConnectStatus: "failed",
      slackConnectAttemptedAt: attemptedAt,
      slackConnectInviteEmail: email,
      slackConnectError: reason,
    });
    return {
      status: "failed",
      reason,
    };
  }
}

async function persistAttempt(
  persist: (userId: string, patch: Record<string, unknown>) => Promise<void>,
  userId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  try {
    await persist(userId, patch);
  } catch {
    /* best-effort: Slack status must not block onboarding */
  }
}

function envTeamUserIds(): string[] {
  return (process.env.SLACK_CONNECT_TEAM_USER_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
