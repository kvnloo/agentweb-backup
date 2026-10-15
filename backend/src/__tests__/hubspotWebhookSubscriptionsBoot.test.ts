/**
 * ENG-2465: the contact.merge subscription is registered at boot, once per build, with no duplicate
 * registration across instances that start together or between a boot run and a config-save run.
 */
const mockBuild: { commit: string | null; versionLabel: string | null } = { commit: 'abc123', versionLabel: 'backend-20261014-pr1' };
jest.mock('../utils/buildInfo', () => ({ get buildInfo() { return mockBuild; } }));
jest.mock('axios');
jest.mock('../utils/secretsManager', () => ({ getHubSpotCredentials: jest.fn() }));

// In-memory stand-in for the queue's atomic insert-if-absent, shared by every "instance" in a test.
const claimed = new Set<string>();
let queueDown = false;
const mockEnqueue = jest.fn(async (source: string, key: string) => {
  if (queueDown) return 'unavailable';
  const id = `${source}_${key}`;
  if (claimed.has(id)) return 'duplicate';
  claimed.add(id);
  return 'enqueued';
});
const mockComplete = jest.fn().mockResolvedValue(undefined);
const mockFailed = jest.fn().mockResolvedValue(undefined);
const mockRegister = jest.fn();
jest.mock('../services/asyncJobQueue', () => ({
  enqueueJob: (...a: any[]) => (mockEnqueue as any)(...a),
  markJobComplete: (...a: any[]) => mockComplete(...a),
  markJobFailed: (...a: any[]) => mockFailed(...a),
  registerProcessor: (...a: any[]) => mockRegister(...a),
  startHeartbeat: jest.fn(() => () => undefined),
}));

import axios from 'axios';
import { getHubSpotCredentials } from '../utils/secretsManager';
import { ensureWebhookSubscriptionsOncePerBuild, SUBSCRIPTION_SYNC_SOURCE } from '../utils/hubspotWebhookSubscriptionsBoot';
import { ensureWebhookSubscriptions } from '../utils/hubspotWebhookSubscriptions';

const get = axios.get as jest.Mock;
const post = axios.post as jest.Mock;
const registeredAtBoot = mockRegister.mock.calls.map((c) => c[0]);   // captured at import time
const bootProcessor = mockRegister.mock.calls.find((c) => c[0] === SUBSCRIPTION_SYNC_SOURCE)![1] as () => Promise<void>;

// A tiny stateful HubSpot app: POST adds a subscription, GET lists them.
let subs: Array<{ eventType: string; propertyName?: string }> = [];
const postedMerge = () => post.mock.calls.filter((c) => c[1]?.eventType === 'contact.merge').length;

beforeEach(() => {
  jest.clearAllMocks();
  claimed.clear(); queueDown = false; subs = [];
  mockBuild.commit = 'abc123'; mockBuild.versionLabel = 'backend-20261014-pr1';
  delete process.env.HUBSPOT_BOOT_SUBSCRIPTIONS;
  (getHubSpotCredentials as jest.Mock).mockResolvedValue({ developerApiKey: 'k', hubspotAppId: 'app1' });
  get.mockImplementation(async () => ({ data: { results: subs.map((s, i) => ({ id: i, active: true, ...s })) } }));
  post.mockImplementation(async (_u: string, body: any) => {
    await new Promise((r) => setImmediate(r));          // a real HTTP call yields: lets concurrent runs interleave
    subs.push({ eventType: body.eventType, propertyName: body.propertyName });
    return { data: { id: 1 } };
  });
});

describe('ensureWebhookSubscriptionsOncePerBuild', () => {
  it('registers a processor for the source so the poller can retry a claim whose owner crashed', () => {
    expect(registeredAtBoot).toContain(SUBSCRIPTION_SYNC_SOURCE);
  });

  it('claims, registers contact.merge, and marks the job complete', async () => {
    expect(await ensureWebhookSubscriptionsOncePerBuild()).toBe('ran');
    expect(postedMerge()).toBe(1);
    expect(mockEnqueue).toHaveBeenCalledWith(SUBSCRIPTION_SYNC_SOURCE, 'abc123', expect.anything(), { claimImmediately: true });
    expect(mockComplete).toHaveBeenCalledWith(SUBSCRIPTION_SYNC_SOURCE, 'abc123');
  });

  /** A separate "instance": its own module state (so its in-process serialiser cannot help), sharing only HubSpot and the queue. */
  const freshInstance = () => {
    let boot: any; let subsMod: any;
    jest.isolateModules(() => {
      boot = require('../utils/hubspotWebhookSubscriptionsBoot');
      subsMod = require('../utils/hubspotWebhookSubscriptions');
    });
    return { boot: boot.ensureWebhookSubscriptionsOncePerBuild as () => Promise<string>, sync: subsMod.ensureWebhookSubscriptions as (a: any[], b: any[]) => Promise<void> };
  };
  const dupes = () => {
    const keys = post.mock.calls.map((c) => `${c[1].eventType}:${c[1].propertyName ?? ''}`);
    return keys.length - new Set(keys).size;
  };

  it('FIVE separate instances booting together: exactly one registers, no subscription is posted twice', async () => {
    const instances = Array.from({ length: 5 }, freshInstance);

    const outcomes = await Promise.all(instances.map((i) => i.boot()));

    expect(outcomes.filter((o) => o === 'ran')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'already-claimed')).toHaveLength(4);
    expect(dupes()).toBe(0);
    expect(postedMerge()).toBe(1);
  });

  it('CONTROL: the same five separate instances WITHOUT the claim do post duplicates (so the test above can fail)', async () => {
    const instances = Array.from({ length: 5 }, freshInstance);

    await Promise.all(instances.map((i) => i.sync([], [])));

    expect(dupes()).toBeGreaterThan(0);
    expect(postedMerge()).toBeGreaterThan(1);
  });

  it('a new build claims again (each deploy tries once)', async () => {
    expect(await ensureWebhookSubscriptionsOncePerBuild()).toBe('ran');
    mockBuild.commit = 'def456';
    subs = [];
    expect(await ensureWebhookSubscriptionsOncePerBuild()).toBe('ran');
    expect(postedMerge()).toBe(2);
  });

  it('the same build restarting does not re-register', async () => {
    await ensureWebhookSubscriptionsOncePerBuild();
    post.mockClear();
    expect(await ensureWebhookSubscriptionsOncePerBuild()).toBe('already-claimed');
    expect(post).not.toHaveBeenCalled();
  });

  it('does NOT run unguarded when the queue is unreachable', async () => {
    queueDown = true;
    expect(await ensureWebhookSubscriptionsOncePerBuild()).toBe('skipped-queue-unavailable');
    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('a claim that throws does not run unguarded and does not throw', async () => {
    mockEnqueue.mockRejectedValueOnce(new Error('boom'));
    await expect(ensureWebhookSubscriptionsOncePerBuild()).resolves.toBe('skipped-queue-unavailable');
    expect(post).not.toHaveBeenCalled();
  });

  it('no build identity (local run, preview, tests) never touches the HubSpot app or the queue', async () => {
    mockBuild.commit = null; mockBuild.versionLabel = null;
    expect(await ensureWebhookSubscriptionsOncePerBuild()).toBe('skipped-no-build');
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it('falls back to the version label when the commit is absent', async () => {
    mockBuild.commit = null;
    await ensureWebhookSubscriptionsOncePerBuild();
    expect(mockEnqueue).toHaveBeenCalledWith(SUBSCRIPTION_SYNC_SOURCE, 'backend-20261014-pr1', expect.anything(), expect.anything());
  });

  it.each(['off', 'OFF', ' off '])('kill switch HUBSPOT_BOOT_SUBSCRIPTIONS=%j', async (v) => {
    process.env.HUBSPOT_BOOT_SUBSCRIPTIONS = v;
    expect(await ensureWebhookSubscriptionsOncePerBuild()).toBe('skipped-disabled');
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('a failed registration is NOT marked complete: the claim goes back to the queue for retry, and nothing throws', async () => {
    post.mockRejectedValue(Object.assign(new Error('403'), { response: { status: 403, data: { message: 'nope' } } }));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(ensureWebhookSubscriptionsOncePerBuild()).resolves.toBe('failed-will-retry');

    expect(mockComplete).not.toHaveBeenCalled();
    expect(mockFailed).toHaveBeenCalledWith(SUBSCRIPTION_SYNC_SOURCE, 'abc123', expect.any(Error));
  });

  const projectBanned = () => Object.assign(new Error('403'), { response: { status: 403, data: {
    status: 'error', category: 'BANNED', subCategory: 'AppProjectAssociationErrors.PROJECT_BASED_APP_WEBHOOK_EDIT_ERROR',
    message: "This app was created by a project `agentweb_hubspot` and it's webhook configuration can't be edited through the API or UI." } } });

  it('HubSpot refusing edits because the app is project-managed: ONE clear warning, the build completes, nothing is retried', async () => {
    post.mockRejectedValue(projectBanned());
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(ensureWebhookSubscriptionsOncePerBuild()).resolves.toBe('ran');

    expect(post).toHaveBeenCalledTimes(1);                   // the remaining 12 would fail identically: not attempted
    expect(mockComplete).toHaveBeenCalled();
    expect(mockFailed).not.toHaveBeenCalled();
    const msgs = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('managed by a HubSpot project'));
    expect(msgs).toHaveLength(1);                            // exactly one warning, not one per subscription
    expect(msgs[0]).toContain('contact.merge');              // names what still has to be added by hand
  });

  it('a different 403 (e.g. a missing scope) is still a retryable failure', async () => {
    post.mockRejectedValue(Object.assign(new Error('403'), { response: { status: 403, data: { category: 'MISSING_SCOPES', message: 'nope' } } }));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(ensureWebhookSubscriptionsOncePerBuild()).resolves.toBe('failed-will-retry');
  });

  it('a transient credentials failure is also retried, not treated as done', async () => {
    (getHubSpotCredentials as jest.Mock).mockRejectedValueOnce(new Error('secrets down'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(ensureWebhookSubscriptionsOncePerBuild()).resolves.toBe('failed-will-retry');
    expect(mockFailed).toHaveBeenCalled();
  });

  it('missing credentials (nothing this environment can do) completes instead of retrying forever', async () => {
    (getHubSpotCredentials as jest.Mock).mockResolvedValue({});
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(ensureWebhookSubscriptionsOncePerBuild()).resolves.toBe('ran');
    expect(mockComplete).toHaveBeenCalled();
    expect(mockFailed).not.toHaveBeenCalled();
  });

  it('an app id without a developer key is also "nothing to do", not a retry loop', async () => {
    (getHubSpotCredentials as jest.Mock).mockResolvedValue({ hubspotAppId: 'app1' });
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(ensureWebhookSubscriptionsOncePerBuild()).resolves.toBe('ran');
    expect(mockFailed).not.toHaveBeenCalled();
  });

  it('the processor the queue poller calls rejects when a registration fails (so the retry counts an attempt)', async () => {
    const processor = bootProcessor;
    post.mockRejectedValue(new Error('boom'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(processor()).rejects.toThrow(/could not be registered/);
    post.mockReset().mockResolvedValue({ data: { id: 1 } });
    await expect(processor()).resolves.toBeUndefined();
  });

  it('every HubSpot call carries a timeout, so a hung socket cannot hold the claim forever', async () => {
    await ensureWebhookSubscriptionsOncePerBuild();
    for (const c of [...get.mock.calls, ...post.mock.calls]) {
      const cfg = c[c.length - 1];
      expect(cfg.timeout).toBeGreaterThan(0);
    }
  });
});

describe('in-process serialisation of ensureWebhookSubscriptions', () => {
  it('a boot run overlapping a config-save run registers each subscription once (the second sees the first)', async () => {
    await Promise.all([ensureWebhookSubscriptions([], []), ensureWebhookSubscriptions([], [])]);
    const keys = post.mock.calls.map((c) => `${c[1].eventType}:${c[1].propertyName ?? ''}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(postedMerge()).toBe(1);
  });

  it('a failing run does not wedge later runs', async () => {
    (getHubSpotCredentials as jest.Mock).mockRejectedValueOnce(new Error('secrets down'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await ensureWebhookSubscriptions([], []);
    await ensureWebhookSubscriptions([], []);
    expect(postedMerge()).toBe(1);
  });
});
