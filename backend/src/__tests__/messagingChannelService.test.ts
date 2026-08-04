/**
 * messagingChannelService — the provider-neutral messaging channel seam (ENG-273).
 *
 * AgentWeb was Slack-first and hardcoded: slackService was imported directly by 7
 * services across ~30 call sites. This is the registry + capability model that lets
 * WhatsApp (and later Teams, ENG-272) be a peer channel instead of a third hardcode.
 *
 * Shaped on emailProviderService (ENG-266/302), including its memoized-promise
 * bootstrap — the boolean-flag version of that had a real concurrency bug (ENG-300).
 *
 * Contract under test:
 *   - registry: register/get, descriptive throw for an unregistered channel
 *   - bootstrap: concurrent first-callers all see a populated registry, idempotent
 *   - capabilities: every channel declares one; callers branch on it, never on name
 *   - escaping: per-channel, and Slack's control-character escaping is preserved
 *   - destination resolution: legacy slackChannel/slackChannels normalize at READ
 *     time into messagingChannels — no migration, no backfill
 */

import {
  registerMessagingChannel,
  getMessagingChannel,
  bootstrapMessagingChannels,
  normalizeUserChannels,
  resolveDestination,
  formatForChannel,
  MessagingChannelError,
  MESSAGING_CHANNELS,
  type IMessagingChannel,
  type MessagingChannel,
} from '../services/messagingChannelService';

jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn() },
  orgDb: { getOrgById: jest.fn() },
}));

const { userDb, orgDb } = require('../services/db');

beforeEach(() => {
  jest.clearAllMocks();
});

// ── Registry ───────────────────────────────────────────────────────────────

describe('messaging channel registry', () => {
  it('throws a descriptive error naming the supported channels for an unknown channel', async () => {
    await bootstrapMessagingChannels();
    expect(() => getMessagingChannel('telegram' as MessagingChannel)).toThrow(
      /No messaging channel registered for "telegram"/,
    );
  });

  it('returns a registered channel implementation', async () => {
    // The registry is module-level state, so put the real adapter back afterwards —
    // otherwise every later test in this file reads the fake.
    await bootstrapMessagingChannels();
    const real = getMessagingChannel('slack');
    try {
      const fake = {
        channel: 'slack' as const,
        capabilities: { canEdit: true } as any,
        sendMessage: jest.fn(),
        escape: (s: string) => s,
      } as unknown as IMessagingChannel;
      registerMessagingChannel('slack', fake);
      expect(getMessagingChannel('slack')).toBe(fake);
    } finally {
      registerMessagingChannel('slack', real);
    }
  });
});

/**
 * Every declared channel now has an adapter, so these loops cover the full set.
 * A new channel added to MESSAGING_CHANNELS without a bootstrap entry fails here.
 */
const BOOTSTRAPPED_CHANNELS: MessagingChannel[] = MESSAGING_CHANNELS;

describe('bootstrapMessagingChannels — concurrency (ENG-300 shape)', () => {
  it('gives every concurrent first-caller a populated registry', async () => {
    await Promise.all(Array.from({ length: 5 }, () => bootstrapMessagingChannels()));
    for (const channel of BOOTSTRAPPED_CHANNELS) {
      expect(() => getMessagingChannel(channel)).not.toThrow();
    }
  });

  it('is idempotent across repeated calls', async () => {
    await bootstrapMessagingChannels();
    await bootstrapMessagingChannels();
    expect(getMessagingChannel('slack')).toBe(getMessagingChannel('slack'));
  });
});

// ── Capabilities ───────────────────────────────────────────────────────────

describe('channel capabilities', () => {
  it('every registered channel declares a full capability set', async () => {
    await bootstrapMessagingChannels();
    for (const channel of BOOTSTRAPPED_CHANNELS) {
      const caps = getMessagingChannel(channel).capabilities;
      expect(typeof caps.canEdit).toBe('boolean');
      expect(typeof caps.canDelete).toBe('boolean');
      expect(typeof caps.hasThreads).toBe('boolean');
      expect(typeof caps.hasModals).toBe('boolean');
      expect(typeof caps.canReadHistory).toBe('boolean');
      expect(typeof caps.hasDirectory).toBe('boolean');
      expect(typeof caps.supportsInteractive).toBe('boolean');
      expect(typeof caps.requiresTemplateOutsideWindow).toBe('boolean');
      expect(typeof caps.requiresOptIn).toBe('boolean');
      expect(['channel', 'phone']).toContain(caps.addressing);
    }
  });

  it('Slack declares the capabilities its call sites already rely on', async () => {
    await bootstrapMessagingChannels();
    const caps = getMessagingChannel('slack').capabilities;
    expect(caps.canEdit).toBe(true);
    expect(caps.hasThreads).toBe(true);
    expect(caps.hasModals).toBe(true);
    expect(caps.addressing).toBe('channel');
    // Slack needs no opt-in and has no 24h window — those are WhatsApp-only constraints.
    expect(caps.requiresOptIn).toBe(false);
    expect(caps.requiresTemplateOutsideWindow).toBe(false);
  });
});

// ── Escaping / formatting ──────────────────────────────────────────────────

describe('formatForChannel', () => {
  it('escapes Slack control characters so a title cannot smuggle a broadcast', () => {
    // The exact attack shipNotifyService's escapeSlackText exists to stop: titles are
    // user-authored (anyone can file a public Featurebase post) and land in a SHARED
    // customer channel.
    const out = formatForChannel('<!channel> ping & <http://x|click>', 'slack');
    expect(out).not.toContain('<!channel>');
    expect(out).toContain('&lt;!channel&gt;');
    expect(out).toContain('&amp;');
  });

  it('leaves WhatsApp text alone rather than applying Slack escaping', () => {
    // WhatsApp has no Block Kit and no <!channel> broadcast concept, so Slack's
    // entity escaping would just render literal "&lt;" to the customer.
    const out = formatForChannel('a < b & c', 'whatsapp');
    expect(out).not.toContain('&lt;');
    expect(out).not.toContain('&amp;');
    expect(out).toContain('<');
  });

  it('strips zero-width and bidi control characters', () => {
    // Written as escapes on purpose — these are invisible in an editor, and a
    // literal one here would be silently "cleaned up" by a future formatter.
    const out = formatForChannel('hello\u200Bwo\u202Erld', 'whatsapp');
    expect(out).toBe('helloworld');
  });
});

// ── Read-time normalization (no migration) ─────────────────────────────────

describe('normalizeUserChannels — legacy Slack fields normalize at read time', () => {
  it('reads the modern slackChannels array', () => {
    expect(normalizeUserChannels({ slackChannels: ['C1', 'C2'] })).toEqual([
      { channel: 'slack', destination: 'C1', enabled: true },
      { channel: 'slack', destination: 'C2', enabled: true },
    ]);
  });

  it('falls back to the deprecated singular slackChannel', () => {
    expect(normalizeUserChannels({ slackChannel: 'C9' })).toEqual([
      { channel: 'slack', destination: 'C9', enabled: true },
    ]);
  });

  it('prefers slackChannels over the deprecated slackChannel when both exist', () => {
    const out = normalizeUserChannels({ slackChannels: ['C1'], slackChannel: 'C9' });
    expect(out.map((c) => c.destination)).toEqual(['C1']);
  });

  it('returns an explicit messagingChannels entry as-is', () => {
    const user = {
      messagingChannels: [
        { channel: 'whatsapp' as const, destination: '+14155550123', enabled: true },
      ],
    };
    expect(normalizeUserChannels(user)).toEqual(user.messagingChannels);
  });

  it('lets an explicit slack entry win over the legacy fields for the same channel', () => {
    const out = normalizeUserChannels({
      slackChannels: ['C-legacy'],
      messagingChannels: [{ channel: 'slack' as const, destination: 'C-new', enabled: true }],
    });
    expect(out.filter((c) => c.channel === 'slack').map((c) => c.destination)).toEqual(['C-new']);
  });

  it('keeps legacy Slack alongside an explicit WhatsApp entry', () => {
    const out = normalizeUserChannels({
      slackChannels: ['C1'],
      messagingChannels: [
        { channel: 'whatsapp' as const, destination: '+14155550123', enabled: true },
      ],
    });
    expect(out).toHaveLength(2);
    expect(out.find((c) => c.channel === 'slack')?.destination).toBe('C1');
    expect(out.find((c) => c.channel === 'whatsapp')?.destination).toBe('+14155550123');
  });

  it('returns an empty list for a user with no channels at all', () => {
    expect(normalizeUserChannels({})).toEqual([]);
    expect(normalizeUserChannels(null)).toEqual([]);
    expect(normalizeUserChannels(undefined)).toEqual([]);
  });

  it('ignores malformed entries rather than emitting an unsendable destination', () => {
    const out = normalizeUserChannels({
      messagingChannels: [
        { channel: 'whatsapp', destination: '' },
        { channel: 'bogus', destination: 'x' },
        null,
      ] as any,
    });
    expect(out).toEqual([]);
  });
});

// ── Destination resolution ─────────────────────────────────────────────────

describe('resolveDestination', () => {
  it('resolves a personal channel without touching the org record', async () => {
    await expect(resolveDestination({ slackChannels: ['C1'] }, 'slack')).resolves.toBe('C1');
    expect(orgDb.getOrgById).not.toHaveBeenCalled();
  });

  it('falls back to the org record for an org member with no personal channel', async () => {
    orgDb.getOrgById.mockResolvedValue({ slackChannel: 'C-org' });
    await expect(resolveDestination({ orgId: 'o1' }, 'slack')).resolves.toBe('C-org');
  });

  it("falls back to the org owner's channels when the org record has none", async () => {
    orgDb.getOrgById.mockResolvedValue({ ownerUserId: 'owner1' });
    userDb.getUserById.mockResolvedValue({ slackChannels: ['C-owner'] });
    await expect(resolveDestination({ orgId: 'o1' }, 'slack')).resolves.toBe('C-owner');
  });

  it('returns null when nothing is configured for the channel', async () => {
    await expect(resolveDestination({}, 'slack')).resolves.toBeNull();
    await expect(resolveDestination(null, 'whatsapp')).resolves.toBeNull();
  });

  it('does not resolve a Slack channel for a WhatsApp request', async () => {
    // Cross-channel bleed would post a customer's WhatsApp notification into Slack.
    await expect(resolveDestination({ slackChannels: ['C1'] }, 'whatsapp')).resolves.toBeNull();
  });

  it('skips a disabled channel entry', async () => {
    const user = {
      messagingChannels: [
        { channel: 'whatsapp' as const, destination: '+14155550123', enabled: false },
      ],
    };
    await expect(resolveDestination(user, 'whatsapp')).resolves.toBeNull();
  });

  it('never lets an org lookup failure throw into a notification path', async () => {
    orgDb.getOrgById.mockRejectedValue(new Error('dynamo down'));
    await expect(resolveDestination({ orgId: 'o1' }, 'slack')).resolves.toBeNull();
  });
});

// ── Errors ─────────────────────────────────────────────────────────────────

describe('MessagingChannelError', () => {
  it('is catchable as a base class so a new channel is covered without edits', () => {
    class WhatsAppSendError extends MessagingChannelError {}
    const err = new WhatsAppSendError('nope');
    expect(err).toBeInstanceOf(MessagingChannelError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('WhatsAppSendError');
  });

  it('carries the channel that produced it', () => {
    const err = new MessagingChannelError('boom', 'whatsapp');
    expect(err.channel).toBe('whatsapp');
  });
});
