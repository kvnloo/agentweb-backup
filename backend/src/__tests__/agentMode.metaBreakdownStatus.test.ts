/**
 * Unit tests for the Meta breakdown partial-failure helper (ENG-104).
 *
 * Imports ONLY the pure module — no AgentModeService boot, no network. Pins the
 * contract that a missing/errored breakdown section is distinguishable from an
 * empty-but-successful one, and that a partial failure is reported explicitly.
 */

import {
  summarizeBreakdownSections,
  buildToolPartialFailureTelemetry,
} from '../services/agentMode/metaBreakdownStatus';

describe('summarizeBreakdownSections (ENG-104)', () => {
  it('reports no partial failure when all three sections have data', () => {
    const summary = summarizeBreakdownSections({
      demographics: { data: [{ age: '25-34' }] },
      placement: { data: [{ publisher_platform: 'facebook' }] },
      device: { data: [{ impression_device: 'mobile' }] },
    });

    expect(summary.partialFailure).toBe(false);
    expect(summary.sections).toEqual({ demographics: 'ok', placement: 'ok', device: 'ok' });
    expect(summary.unavailableSections).toEqual([]);
    expect(summary.sectionErrors).toEqual({});
  });

  it('treats an empty-but-successful response as ok, not a failure', () => {
    const summary = summarizeBreakdownSections({
      demographics: { data: [] },
      placement: { data: [] },
      device: { data: [] },
    });

    expect(summary.partialFailure).toBe(false);
    expect(summary.sections.demographics).toBe('ok');
  });

  it('flags a single errored section as unavailable with its message captured', () => {
    const summary = summarizeBreakdownSections({
      demographics: { error: { message: 'Unsupported get request', code: 100 } },
      placement: { data: [] },
      device: { data: [] },
    });

    expect(summary.partialFailure).toBe(true);
    expect(summary.sections.demographics).toBe('unavailable');
    expect(summary.sections.placement).toBe('ok');
    expect(summary.unavailableSections).toEqual(['demographics']);
    expect(summary.sectionErrors.demographics).toBe('Unsupported get request (code 100)');
  });

  it('lists every failing section when two fail', () => {
    const summary = summarizeBreakdownSections({
      demographics: { error: { message: 'boom' } },
      placement: { data: [] },
      device: { error: { message: 'kaboom' } },
    });

    expect(summary.partialFailure).toBe(true);
    expect(summary.unavailableSections).toEqual(['demographics', 'device']);
    expect(summary.sectionErrors.device).toBe('kaboom');
  });

  it('treats a null/undefined response as unavailable without crashing', () => {
    const summary = summarizeBreakdownSections({
      demographics: null,
      placement: undefined,
      device: { data: [{ impression_device: 'desktop' }] },
    });

    expect(summary.partialFailure).toBe(true);
    expect(summary.sections.demographics).toBe('unavailable');
    expect(summary.sections.placement).toBe('unavailable');
    expect(summary.sections.device).toBe('ok');
    expect(summary.unavailableSections).toEqual(['demographics', 'placement']);
  });
});

describe('buildToolPartialFailureTelemetry (ENG-104 — telemetry routing)', () => {
  it('builds a payload from a tool result flagged partialFailure, carrying the unavailable sections', () => {
    // The exact shape getMetaAdsMetrics attaches on a partial breakdown failure.
    const result = {
      success: true,
      partialFailure: true,
      unavailableSections: ['demographics', 'device'],
      formattedContent: 'metrics…',
    };
    const payload = buildToolPartialFailureTelemetry('get_meta_ads_metrics', result);
    expect(payload).toEqual({
      toolName: 'get_meta_ads_metrics',
      unavailableSections: ['demographics', 'device'],
    });
  });

  it('returns null for an all-success result (no partialFailure) — the success path emits nothing', () => {
    const result = {
      success: true,
      partialFailure: false,
      unavailableSections: [],
      formattedContent: 'metrics…',
    };
    expect(buildToolPartialFailureTelemetry('get_meta_ads_metrics', result)).toBeNull();
  });

  it('returns null for a result with no partial-failure fields at all (other tools)', () => {
    expect(buildToolPartialFailureTelemetry('save_memory', { success: true })).toBeNull();
    expect(buildToolPartialFailureTelemetry('save_memory', 'plain string')).toBeNull();
    expect(buildToolPartialFailureTelemetry('save_memory', undefined)).toBeNull();
  });

  it('coerces a malformed unavailableSections to an empty array (never throws)', () => {
    const payload = buildToolPartialFailureTelemetry('get_meta_ads_metrics', {
      partialFailure: true,
      unavailableSections: 'demographics', // not an array
    });
    expect(payload).toEqual({ toolName: 'get_meta_ads_metrics', unavailableSections: [] });
  });
});
