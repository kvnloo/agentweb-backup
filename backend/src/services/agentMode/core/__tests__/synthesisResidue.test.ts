/**
 * Unit tests for the PURE final-synthesis residue guard (ENG-1054).
 *
 * The production failure this pins: a 215-message session whose closing assistant
 * message was the literal string "}]" — serialization residue, not an answer. The
 * loop shipped it because its only "failed synthesis" check was `!content`.
 */

import {
  isUnusableSynthesis,
  buildExecutedActionsFallback,
  buildExecutedActionsFooter,
  detectFalseCompletionClaim,
  buildFalseClaimCorrectionFooter,
  extractProducedAssetCount,
  assetProducingToolsInPlay,
} from '../synthesisResidue';
import { SYNTHESIS_NUDGE, CONTINUE_PROMPT, ANTI_LOOP_STOP_MESSAGE } from '../termination';
import { buildTurnTimeBudgetNudge, type TurnTimeBudgetState } from '../../../../utils/turnTimeBudget';

function timeBudgetState(remainingSeconds: number): TurnTimeBudgetState {
  return { phase: 'wrap_up', elapsedMs: 0, remainingMs: remainingSeconds * 1000, reserveMs: 0 };
}

describe('isUnusableSynthesis', () => {
  it('flags the exact production residue "}]"', () => {
    expect(isUnusableSynthesis('}]')).toBe(true);
  });

  it('flags other structural-punctuation-only remnants', () => {
    for (const residue of ['}', ']', '}}', '"}]', '},{', '  }]\n', '{"', ':', '",']) {
      expect(isUnusableSynthesis(residue)).toBe(true);
    }
  });

  // Greptile P1: punctuation-only is not the same as unusable. A COMPLETE value is
  // a legitimate answer to "return an empty object" or "show me the list", and
  // discarding it would replace the user's answer with the synthesis-failure recap.
  // Residue never parses; a complete value always does.
  it('does NOT flag short but COMPLETE JSON values', () => {
    for (const valid of ['{}', '[]', '[{}]', '{ }', '[ ]', '[{},{}]', '""', '[""]']) {
      expect(isUnusableSynthesis(valid)).toBe(false);
    }
  });

  it('does NOT flag empty/whitespace content (the existing empty-synthesis ladder owns that)', () => {
    for (const empty of ['', '   ', '\n\t']) {
      expect(isUnusableSynthesis(empty)).toBe(false);
    }
  });

  it('does NOT flag short but genuine answers', () => {
    for (const real of ['Yes.', 'Done', 'OK', '42', 'Paused both campaigns.', '✅', '...', '—']) {
      expect(isUnusableSynthesis(real)).toBe(false);
    }
  });

  it('does NOT flag a long response that merely ends in structural punctuation', () => {
    expect(isUnusableSynthesis('I paused both campaigns. Here is the JSON I used: {"status":"PAUSED"}')).toBe(false);
  });

  // Message 163 of the production session: the model transcribed the preceding
  // tool result back as its own answer — 20,081 chars opening with the loop's own
  // degraded-history marker. Too long for the punctuation rule, same failure.
  it('flags a reply that echoes the loop\'s degraded tool history', () => {
    const echo =
      '[Result of call_meta_marketing_api: {"success":true,"message":"Found 25 ad(s)","ads":['
      + '{"id":"120248669405960585","name":"P3 A1"}'.repeat(200)
      + '\n\n[Content truncated — full response in S3]}}';
    expect(echo.length).toBeGreaterThan(1000);
    expect(isUnusableSynthesis(echo)).toBe(true);
  });

  it('flags a reply that opens with the degraded tool-call marker', () => {
    expect(isUnusableSynthesis('[Previously called call_meta_marketing_api({"action":"UPDATE"})]')).toBe(true);
  });

  // ENG-1224 Variant B / production session d5898ffd: the model echoed the
  // loop's own wall-clock budget nudge ("Do not call any more tools. Write
  // your final answer NOW...") back as its answer instead of following it —
  // the persisted final message was the literal string below.
  describe('leaked internal directive (ENG-1224)', () => {
    it('flags the exact production leak "Do not call any more tools."', () => {
      expect(isUnusableSynthesis(' Do not call any more tools.')).toBe(true);
    });

    it('flags other phrasings of the same injected directive', () => {
      for (const leak of [
        'Do not call any more tools.',
        "don't call any more tools",
        'DO NOT CALL ANY MORE TOOLS.',
        'Stop all searching/pagination immediately.',
        '[SYSTEM WARNING] Do not call any more tools. Write your final answer now.',
      ]) {
        expect(isUnusableSynthesis(leak)).toBe(true);
      }
    });

    it('does NOT flag genuine prose that merely discusses tool-calling policy', () => {
      for (const real of [
        'I have finished the task and will not call any more tools unless you ask me to continue.',
        'As requested, here is a summary of what I found — no further tools were needed.',
      ]) {
        expect(isUnusableSynthesis(real)).toBe(false);
      }
    });

    // "Stop calling tools" and "No more tool calls" were removed from the guard: no
    // code path ever injects either phrase, and being anchored + under the residue
    // length cap they could discard a genuine short answer that happens to open
    // with similar wording.
    it('does NOT flag a genuine answer that opens with similar-but-uninjected wording', () => {
      for (const real of [
        'Stop calling tools that are not needed — the report below is already complete.',
        'No more tool calls were necessary; here are the results you asked for.',
      ]) {
        expect(isUnusableSynthesis(real)).toBe(false);
      }
    });
  });

  // Observed live: driving the synthesis retry into a failure state made the model
  // collapse into a repetition loop and ship 180,180 chars — 30,791 words built
  // from 65 unique tokens — straight into the transcript.
  it('flags a degenerate repetition collapse', () => {
    const collapse = 'If you need to output a code block ensure it is properly enclosed. '
      + 'group '.repeat(20000);
    expect(collapse.length).toBeGreaterThan(100_000);
    expect(isUnusableSynthesis(collapse)).toBe(true);
  });

  it('does NOT flag long genuine prose with a normal vocabulary', () => {
    // ~600 words of varied text — the shape the guard must never touch.
    const words: string[] = [];
    for (let i = 0; i < 600; i++) words.push(`campaign${i} spend${i} result${i}`.split(' ')[i % 3]);
    const prose = words.join(' ');
    expect(prose.split(/\s+/).length).toBeGreaterThan(300);
    expect(isUnusableSynthesis(prose)).toBe(false);
  });

  it('does NOT flag a long but legitimately repetitive status list', () => {
    // A real answer can repeat heavily — 10-15% unique is normal for a table.
    const rows: string[] = [];
    for (let i = 0; i < 400; i++) rows.push(`- Campaign ${i} status PAUSED budget 3000 daily`);
    expect(isUnusableSynthesis(rows.join('\n'))).toBe(false);
  });

  it('does NOT flag a short repetitive answer below the word floor', () => {
    expect(isUnusableSynthesis('yes '.repeat(50))).toBe(false);
  });

  // ENG-1188: a 101-message gemini-3.1-pro-preview work-plan session generated and
  // screenshot-verified the corrected ad assets, then closed with the model echoing
  // the injected synthesis nudge back verbatim instead of writing the delivery
  // message — three repeats in 744 chars, well under isDegenerateRepetition's
  // 1000-char/300-word floor, so the real answer never reached the user even though
  // the guard built for exactly this failure class (ENG-1054/946) was already live.
  it('flags a reply that echoes the injected synthesis nudge back verbatim', () => {
    const echo = `${SYNTHESIS_NUDGE} ${SYNTHESIS_NUDGE} ${SYNTHESIS_NUDGE}`;
    expect(echo.length).toBeLessThan(1000);
    expect(isUnusableSynthesis(echo)).toBe(true);
  });

  // ENG-1188 follow-up: a terminating turn whose ENTIRE content is exactly one bare
  // copy of the nudge is non-empty, so it never re-triggers the empty-synthesis
  // retry ladder in termination.ts either — it must be caught here.
  it('flags a reply that is exactly one bare copy of the nudge', () => {
    expect(isUnusableSynthesis(SYNTHESIS_NUDGE)).toBe(true);
  });

  // Pins the exact >= 2 cutoff used by isNudgeEcho, distinct from the 3-repeat and
  // exact-single-copy cases already covered above.
  it('flags exactly two verbatim copies of the nudge (the boundary)', () => {
    expect(isUnusableSynthesis(`${SYNTHESIS_NUDGE} ${SYNTHESIS_NUDGE}`)).toBe(true);
  });

  it('does NOT flag a single quoted mention of the nudge text', () => {
    expect(
      isUnusableSynthesis(`I saw the system message "${SYNTHESIS_NUDGE}" and then finished the export.`)
    ).toBe(false);
  });

  // ENG-1188 follow-up: `isUnusableSynthesis` is the single choke point for every
  // terminating turn (agentModeService.ts calls it once, on whatever content is
  // about to ship), and CONTINUE_PROMPT / ANTI_LOOP_STOP_MESSAGE are injected by the
  // exact same "push a system nudge, let the model respond again" mechanism as
  // SYNTHESIS_NUDGE — a max_tokens continuation and a same-tool-calls anti-loop
  // warning. A model that echoes either of THOSE back instead of answering is just
  // as unrecoverable and just as unguarded before this, since only SYNTHESIS_NUDGE
  // was recognized.
  it('flags a reply that echoes the continuation nudge back verbatim', () => {
    expect(isUnusableSynthesis(`${CONTINUE_PROMPT} ${CONTINUE_PROMPT}`)).toBe(true);
  });

  it('flags a reply that is exactly one bare copy of the continuation nudge', () => {
    expect(isUnusableSynthesis(CONTINUE_PROMPT)).toBe(true);
  });

  it('flags a reply that echoes the anti-loop STOP message back verbatim', () => {
    expect(isUnusableSynthesis(`${ANTI_LOOP_STOP_MESSAGE} ${ANTI_LOOP_STOP_MESSAGE}`)).toBe(true);
  });

  it('flags a reply that is exactly one bare copy of the anti-loop STOP message', () => {
    expect(isUnusableSynthesis(ANTI_LOOP_STOP_MESSAGE)).toBe(true);
  });

  it('does NOT flag a single quoted mention of the continuation or anti-loop nudges', () => {
    expect(
      isUnusableSynthesis(`I saw the system message "${CONTINUE_PROMPT}" and then finished the export.`)
    ).toBe(false);
    expect(
      isUnusableSynthesis(`I saw the system message "${ANTI_LOOP_STOP_MESSAGE}" and then finished the export.`)
    ).toBe(false);
  });

  // ENG-1188 follow-up: ENG-907's wall-clock nudges (buildTurnTimeBudgetNudge) are
  // injected by the same mechanism as the fixed-string nudges above, but each embeds
  // a live remaining-seconds count, so no injection is byte-identical to another —
  // an exact-string check would never match. A bare echo (or repeat) of either phase
  // is just as unrecoverable a failure as the fixed-string nudges.
  it('flags a reply that is exactly one bare copy of the wrap_up time-budget nudge', () => {
    const nudge = buildTurnTimeBudgetNudge(timeBudgetState(42), 'wrap_up');
    expect(isUnusableSynthesis(nudge)).toBe(true);
  });

  it('flags a reply that is exactly one bare copy of the final_synthesis time-budget nudge', () => {
    const nudge = buildTurnTimeBudgetNudge(timeBudgetState(17), 'final_synthesis');
    expect(isUnusableSynthesis(nudge)).toBe(true);
  });

  it('flags a reply that echoes the time-budget nudge twice, even with drifting seconds counts', () => {
    const first = buildTurnTimeBudgetNudge(timeBudgetState(42), 'final_synthesis');
    const second = buildTurnTimeBudgetNudge(timeBudgetState(41), 'final_synthesis');
    expect(isUnusableSynthesis(`${first} ${second}`)).toBe(true);
  });

  it('does NOT flag a single quoted mention of the time-budget nudge', () => {
    const nudge = buildTurnTimeBudgetNudge(timeBudgetState(42), 'wrap_up');
    expect(isUnusableSynthesis(`I saw the system message "${nudge}" and then finished the export.`)).toBe(false);
  });

  it('does NOT flag prose that merely mentions a tool result', () => {
    for (const real of [
      'The result of call_meta_marketing_api was a success — both campaigns are paused.',
      'Here is what I found. [Result data is summarized below.]',
      '[Note] I previously called the Meta API to pause both campaigns.',
    ]) {
      expect(isUnusableSynthesis(real)).toBe(false);
    }
  });

  it('does NOT flag a large brace blob (only short remnants are residue)', () => {
    expect(isUnusableSynthesis('}'.repeat(200))).toBe(false);
  });

  it('is defensive about non-string input', () => {
    for (const bad of [null, undefined, 42, {}, []] as any[]) {
      expect(isUnusableSynthesis(bad)).toBe(false);
    }
  });
});

describe('buildExecutedActionsFallback', () => {
  it('reports each executed tool with its success/failure counts', () => {
    const text = buildExecutedActionsFallback([
      { name: 'call_meta_marketing_api' },
      { name: 'call_meta_marketing_api' },
      { name: 'call_meta_marketing_api', error: 'boom' },
      { name: 'list_knowledge_base_files' },
    ]);
    expect(text).toContain('call_meta_marketing_api');
    expect(text).toContain('2 succeeded');
    expect(text).toContain('1 failed');
    expect(text).toContain('list_knowledge_base_files');
  });

  it('warns the user not to re-run already-applied actions', () => {
    const text = buildExecutedActionsFallback([{ name: 'call_meta_marketing_api' }]);
    expect(text.toLowerCase()).toContain('already');
  });

  // ENG-1188: the root-cause fix recommendation was a ledger "listing every asset
  // produced (with URLs)" — a truthful recap of tool names is not the same as a
  // deliverable. extractMinimalToolResult (agentModeService.ts) already preserves
  // the URL on every asset-producing tool's result (save_file -> file_url,
  // create_html_file/create_html_from_template -> s3_url, generate_image ->
  // imageUrl, playwright_browser_take_screenshot -> screenshotUrl, generate_video
  // -> videoUrl, generate_voiceover -> audioUrl); the ledger just never read it.
  it('includes the asset URL when a succeeded call carries one', () => {
    const text = buildExecutedActionsFallback([
      { name: 'save_file', result: { success: true, file_url: 'https://s3.example.com/xCures-Master-Banners-V2.html' } },
    ]);
    expect(text).toContain('https://s3.example.com/xCures-Master-Banners-V2.html');
  });

  it('includes one URL per call when the same tool succeeds multiple times', () => {
    const text = buildExecutedActionsFallback([
      { name: 'playwright_browser_take_screenshot', result: { success: true, screenshotUrl: 'https://s3.example.com/a.jpg' } },
      { name: 'playwright_browser_take_screenshot', result: { success: true, screenshotUrl: 'https://s3.example.com/b.jpg' } },
    ]);
    expect(text).toContain('https://s3.example.com/a.jpg');
    expect(text).toContain('https://s3.example.com/b.jpg');
  });

  it('recognizes the URL field for every asset-producing tool extractMinimalToolResult preserves one for', () => {
    const text = buildExecutedActionsFallback([
      { name: 'create_html_file', result: { success: true, s3_url: 'https://s3.example.com/banner.html' } },
      { name: 'generate_image', result: { success: true, imageUrl: 'https://s3.example.com/hero.png' } },
      { name: 'generate_video', result: { success: true, videoUrl: 'https://s3.example.com/ad.mp4' } },
      { name: 'generate_voiceover', result: { success: true, audioUrl: 'https://s3.example.com/vo.mp3' } },
    ]);
    expect(text).toContain('https://s3.example.com/banner.html');
    expect(text).toContain('https://s3.example.com/hero.png');
    expect(text).toContain('https://s3.example.com/ad.mp4');
    expect(text).toContain('https://s3.example.com/vo.mp3');
  });

  it('does NOT include a URL for a failed call, even if the result carries a stale one', () => {
    const text = buildExecutedActionsFallback([
      { name: 'save_file', error: 'boom', result: { file_url: 'https://s3.example.com/stale.html' } },
    ]);
    expect(text).not.toContain('https://s3.example.com/stale.html');
  });

  it('does NOT include a URL for a deferred call', () => {
    const text = buildExecutedActionsFallback([
      { name: 'generate_image', result: { deferred: true, imageUrl: 'https://s3.example.com/not-yet.png' } },
    ]);
    expect(text).not.toContain('https://s3.example.com/not-yet.png');
  });

  it('omits a tool entirely when it produced no URL (e.g. a non-asset tool call)', () => {
    const text = buildExecutedActionsFallback([{ name: 'call_meta_marketing_api', result: { success: true } }]);
    expect(text).toContain('call_meta_marketing_api');
    expect(text.split('\n').filter((l) => l.trim().startsWith('http'))).toHaveLength(0);
  });

  it('never claims work happened when no tools ran', () => {
    const text = buildExecutedActionsFallback([]);
    expect(text).toContain('No actions were taken');
    expect(text).not.toContain('succeeded');
  });

  it('tolerates malformed ledger entries without throwing', () => {
    const text = buildExecutedActionsFallback([null, undefined, {}, { name: '' }] as any[]);
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
  });
});

describe('buildExecutedActionsFooter', () => {
  it('returns null when no tools ran', () => {
    expect(buildExecutedActionsFooter([])).toBeNull();
  });

  it('includes the asset URL alongside the succeeded count', () => {
    const footer = buildExecutedActionsFooter([
      { name: 'save_file', result: { success: true, file_url: 'https://s3.example.com/xCures-Master-Banners-V2.html' } },
    ]);
    expect(footer).toContain('save_file');
    expect(footer).toContain('1 succeeded');
    expect(footer).toContain('https://s3.example.com/xCures-Master-Banners-V2.html');
  });
});

// ENG-1331: a work-plan session generated and screenshot-exported 4 of 12 requested
// display-ad sizes, then closed with "all 12 sizes have been rendered, QA'd, and
// saved" — fluent, well-formed prose, not residue. The ENG-1054 guard above only
// catches junk-shaped output (`isUnusableSynthesis`), so a plausible false claim
// like this sailed straight through it. `detectFalseCompletionClaim` is the
// independent truth check: it never judges whether text "looks like" an answer, it
// parses any "all N <asset noun>" / "N of N" / "N/N" completion claim out of the
// content and compares it against the ledger's actual successful asset-producing
// tool calls.
describe('detectFalseCompletionClaim', () => {
  it.each([
    'All 12 sizes rendered successfully.',
    'All 12 sizes were rendered successfully for the campaign.',
    'All 12 sizes have been rendered successfully, and saved.',
  ])('verifies the production-verb success suffix: %s', content => {
    expect(detectFalseCompletionClaim(content, [])).toEqual({ claimed: 12, actual: 0 });
  });
  // Opslane run 156 on #2963: main corrects each of these; the production
  // predicate must not lose them.
  it.each([
    ['All 6 sizes are ready below.', 6],
    ['All 4 images generated:\n- one\n- two\n- three\n- four', 4],
    ['All 6 sizes generated below.', 6],
    ['All 6 sizes are done.', 6],
  ])('still verifies a production claim that points at a list or says ready: %s', (content, claimed) => {
    expect(detectFalseCompletionClaim(content, [{ name: 'create_html_file', result: { success: false } }])).toEqual({ claimed, actual: 0 });
  });
  it.each([
    'All 4 ads generated leads this week. 4 of 4 ads delivered.',
    '4 of 4 ads delivered impressions this week.',
  ])('does not read ad delivery as asset production after a failed asset tool: %s', content => {
    expect(detectFalseCompletionClaim(content, [{ name: 'create_html_file', result: { success: false } }])).toBeNull();
  });
  it('scans a large read-only analysis without quadratic predicate rescanning', () => {
    const content = 'All 4 ads generated leads in this reporting window. '.repeat(20_000);
    const started = performance.now();
    expect(detectFalseCompletionClaim(content, [])).toBeNull();
    expect(performance.now() - started).toBeLessThan(2000);
  });
  it('still verifies a production claim with a success adverb', () => {
    expect(detectFalseCompletionClaim('All 12 sizes were successfully rendered.', [])).toEqual({ claimed: 12, actual: 0 });
  });
  it.each([
    'All 4 ads were reviewed across the reporting windows.',
    '4 of 4 ads generated leads in the reporting period.',
    '4/4 creatives have delivery. The account generated 20 leads.',
  ])('does not turn read-only analysis into a production claim: %s', content => {
    expect(detectFalseCompletionClaim(content, [{ name: 'get_meta_ads', result: { success: true } }])).toBeNull();
  });

  const fourScreenshots = Array.from({ length: 4 }, (_, i) => ({
    name: 'playwright_browser_take_screenshot',
    result: { success: true, screenshotUrl: `https://s3.example.com/${i + 1}.png` },
  }));

  it('flags an "all N <asset noun>" claim the ledger cannot back up', () => {
    const claim = detectFalseCompletionClaim(
      "All 12 sizes have been rendered, QA'd, and saved for Variant 4.",
      fourScreenshots,
    );
    expect(claim).toEqual({ claimed: 12, actual: 4 });
  });

  it('flags an "N of N" claim', () => {
    expect(detectFalseCompletionClaim('Delivered 12 of 12 banners.', [])).toEqual({ claimed: 12, actual: 0 });
  });

  it('flags an "N/N" claim', () => {
    expect(detectFalseCompletionClaim('12/12 images generated.', [])).toEqual({ claimed: 12, actual: 0 });
  });

  it('does NOT flag when the ledger backs the claim up exactly', () => {
    expect(detectFalseCompletionClaim('All 4 sizes rendered.', fourScreenshots)).toBeNull();
  });

  it('does NOT flag when the ledger over-delivers relative to the claim', () => {
    const claim = detectFalseCompletionClaim('All 4 sizes rendered.', [
      ...fourScreenshots,
      { name: 'playwright_browser_take_screenshot', result: { success: true, screenshotUrl: 'https://s3.example.com/5.png' } },
    ]);
    expect(claim).toBeNull();
  });

  it('does NOT flag text with no completion claim at all', () => {
    expect(detectFalseCompletionClaim('Here are the assets you requested.', [])).toBeNull();
  });

  it('does NOT flag an unrelated "all N" claim with no asset noun nearby', () => {
    expect(detectFalseCompletionClaim('I reviewed all 12 line items in the report.', [])).toBeNull();
  });

  // Live repro: N_OF_N_PATTERN/N_SLASH_N_PATTERN had no noun-proximity requirement,
  // unlike ALL_N_NOUN_PATTERN above, so an unrelated same-number ratio was misread
  // as an asset-completion claim.
  it('does NOT flag an unrelated "N of N" claim with no asset noun nearby', () => {
    expect(detectFalseCompletionClaim('I reviewed 10 of 10 pages in the brief.', [])).toBeNull();
  });

  it('does NOT flag an unrelated "N/N" claim with no asset noun nearby', () => {
    expect(detectFalseCompletionClaim('That covers 3/3 of the brief.', [])).toBeNull();
  });

  it('does NOT flag a claim the model already qualifies as partial', () => {
    expect(detectFalseCompletionClaim('I rendered 4 of the 12 requested sizes.', [])).toBeNull();
  });

  it('does NOT flag empty content', () => {
    expect(detectFalseCompletionClaim('', [])).toBeNull();
  });

  it('counts a failed or deferred asset call as NOT produced', () => {
    const claim = detectFalseCompletionClaim('All 2 images generated.', [
      { name: 'generate_image', result: { success: true, imageUrl: 'https://s3.example.com/a.png' } },
      { name: 'generate_image', error: 'boom' },
      { name: 'generate_image', result: { deferred: true } },
    ]);
    expect(claim).toEqual({ claimed: 2, actual: 1 });
  });

  // ENG-1331 manager follow-up / ENG-1188 anti-pattern: toolCalls is the WHOLE
  // TURN's ledger, which in an AUTOCOMPLETE work-plan session can span multiple
  // steps/variants closed via set_work_plan_status inside the same turn. Without
  // scoping to "since the last step boundary", an earlier variant's successful
  // assets would mask a later variant's shortfall — the exact bug the guard exists
  // to catch.
  it('does NOT let an earlier step/variant\'s assets mask a later step\'s shortfall', () => {
    const claim = detectFalseCompletionClaim(
      "All 12 sizes have been rendered, QA'd, and saved for Variant 4.",
      [
        // Variant 1-3: 40 successful renders, closed out via set_work_plan_status.
        ...Array.from({ length: 40 }, (_, i) => ({
          name: 'playwright_browser_take_screenshot',
          result: { success: true, screenshotUrl: `https://s3.example.com/earlier-${i + 1}.png` },
        })),
        { name: 'set_work_plan_status', result: { success: true } },
        // Variant 4: only 4 of the claimed 12 actually rendered.
        ...fourScreenshots,
      ],
    );
    expect(claim).toEqual({ claimed: 12, actual: 4 });
  });

  it('still counts the whole ledger when no step boundary is present', () => {
    expect(
      detectFalseCompletionClaim('All 4 sizes have been rendered, QA\'d, and saved.', fourScreenshots),
    ).toBeNull();
  });

  it('does NOT treat a FAILED set_work_plan_status call as a step boundary', () => {
    const claim = detectFalseCompletionClaim(
      "All 12 sizes have been rendered, QA'd, and saved for Variant 4.",
      [
        ...Array.from({ length: 40 }, (_, i) => ({
          name: 'playwright_browser_take_screenshot',
          result: { success: true, screenshotUrl: `https://s3.example.com/earlier-${i + 1}.png` },
        })),
        { name: 'set_work_plan_status', error: 'validation failed: insufficient assets' },
        ...fourScreenshots,
      ],
    );
    // The failed call never closed the step, so the earlier 40 are still "this
    // step's" work and legitimately back the claim.
    expect(claim).toBeNull();
  });

  // CodeRabbit (ENG-1331 follow-up, second pass): a set_work_plan_status call the
  // dispatcher collapsed as a same-turn duplicate (duplicateOf set) never actually
  // ran — the call it points at is the real boundary and is its own ledger entry.
  // Treating the duplicate itself as a successful boundary too could point
  // sinceLastStepBoundary at an entry that only looks like the true last boundary
  // in array order. Mirrors tallyExecutedActions' existing duplicateOf exclusion.
  it('does NOT treat a duplicate-collapsed set_work_plan_status call as a step boundary', () => {
    const claim = detectFalseCompletionClaim(
      "All 12 sizes have been rendered, QA'd, and saved for Variant 4.",
      [
        ...Array.from({ length: 40 }, (_, i) => ({
          name: 'playwright_browser_take_screenshot',
          result: { success: true, screenshotUrl: `https://s3.example.com/earlier-${i + 1}.png` },
        })),
        { name: 'set_work_plan_status', result: { success: true } },
        ...fourScreenshots,
        // The model re-emits an identical set_work_plan_status later in the same
        // turn; the dispatcher collapses it as a duplicate of the real call above.
        { name: 'set_work_plan_status', duplicateOf: 'call-id-of-the-real-close', result: { success: true } },
      ],
    );
    // In THIS shape the buggy and fixed code happen to agree (both land on
    // "since the real close, before the trailing duplicate") — kept as a basic
    // sanity check, but the test below is the one that actually distinguishes
    // correct from buggy: it fails without the fix and passes with it.
    expect(claim).toEqual({ claimed: 12, actual: 4 });
  });

  // The scenario that actually distinguishes correct behavior from the bug: a
  // step genuinely finishes and closes itself, and the model then re-emits an
  // identical close as the LAST thing in the turn (collapsed as a duplicate).
  // Naively checking "is the boundary the literal last array element" says NO
  // here (the duplicate follows it) and wrongly falls back to the
  // not-yet-closed-step rule — slicing to just the duplicate call itself, actual
  // = 0, falsely flagging a truthful "all 12 done". The fix must recognize that
  // nothing MEANINGFUL (non-duplicate) follows the real close.
  it('treats a step as self-closing even when a duplicate close trails the real one', () => {
    const claim = detectFalseCompletionClaim(
      "All 12 sizes have been rendered, QA'd, and saved.",
      [
        ...Array.from({ length: 12 }, (_, i) => ({
          name: 'playwright_browser_take_screenshot',
          result: { success: true, screenshotUrl: `https://s3.example.com/${i + 1}.png` },
        })),
        { name: 'set_work_plan_status', result: { success: true } },
        { name: 'set_work_plan_status', duplicateOf: 'call-id-of-the-real-close', result: { success: true } },
      ],
    );
    expect(claim).toBeNull(); // truthful — must NOT be flagged
  });

  // CodeRabbit (ENG-1331 follow-up), confirmed live against production: when a
  // step's OWN assets are immediately followed by its OWN successful
  // set_work_plan_status close (the normal shape in an AUTOCOMPLETE turn — the
  // step finishes and closes itself before the closing synthesis is written),
  // the OLD "since the last successful boundary" rule sliced to nothing (the
  // boundary was the last ledger entry), so a step that genuinely produced all
  // 12 assets and validly closed itself read as actual=0 — a false
  // UNDER-claim slapped onto a truthful message. This is the opposite failure
  // from the masking case above, on the same mechanism.
  it('counts a step\'s own assets when its own successful close is the last ledger entry', () => {
    const claim = detectFalseCompletionClaim(
      "All 12 sizes have been rendered, QA'd, and saved.",
      [
        ...Array.from({ length: 12 }, (_, i) => ({
          name: 'playwright_browser_take_screenshot',
          result: { success: true, screenshotUrl: `https://s3.example.com/${i + 1}.png` },
        })),
        { name: 'set_work_plan_status', result: { success: true } },
      ],
    );
    expect(claim).toBeNull(); // truthful — must NOT be flagged
  });

  it('still catches a shortfall when the step closes itself anyway (self-close does not launder a false claim)', () => {
    const claim = detectFalseCompletionClaim(
      "All 12 sizes have been rendered, QA'd, and saved.",
      [...fourScreenshots, { name: 'set_work_plan_status', result: { success: true } }],
    );
    expect(claim).toEqual({ claimed: 12, actual: 4 });
  });

  it('excludes an EARLIER step\'s assets even when the current step self-closes with nothing after it', () => {
    // Two self-closing steps in sequence: step 1 (40 assets, closes itself),
    // step 2 (4 assets, closes itself) — the claim is about step 2 only.
    const claim = detectFalseCompletionClaim(
      "All 12 sizes have been rendered, QA'd, and saved for Variant 4.",
      [
        ...Array.from({ length: 40 }, (_, i) => ({
          name: 'playwright_browser_take_screenshot',
          result: { success: true, screenshotUrl: `https://s3.example.com/earlier-${i + 1}.png` },
        })),
        { name: 'set_work_plan_status', result: { success: true } },
        ...fourScreenshots,
        { name: 'set_work_plan_status', result: { success: true } },
      ],
    );
    expect(claim).toEqual({ claimed: 12, actual: 4 });
  });

  it('takes the largest claim when multiple numeric completion claims appear', () => {
    const claim = detectFalseCompletionClaim(
      'All 4 sizes for the first variant and all 12 sizes for the second variant were rendered.',
      [{ name: 'playwright_browser_take_screenshot', result: { success: true } }],
    );
    expect(claim).toEqual({ claimed: 12, actual: 1 });
  });
});

describe('assetProducingToolsInPlay', () => {
  it('is true when the ledger contains an asset-producing tool call', () => {
    expect(assetProducingToolsInPlay([{ name: 'generate_image', result: { success: true } }])).toBe(true);
  });

  it('is false for an empty ledger', () => {
    expect(assetProducingToolsInPlay([])).toBe(false);
  });

  // ENG-2076 live repro: a Meta Ads turn's ledger has real tool calls, just none of
  // them in ASSET_PRODUCING_TOOL_NAMES (which has no Meta Ads vocabulary and never
  // will). Distinguishes "no asset-producing call" from "no call at all" — the
  // guard's domain gate must treat both the same way (skip), but this is the shape
  // that actually broke production.
  it('is false when the ledger has calls, but none in ASSET_PRODUCING_TOOL_NAMES', () => {
    expect(
      assetProducingToolsInPlay([
        { name: 'call_meta_marketing_api', result: { success: true } },
        { name: 'list_meta_ads_campaigns', result: { success: true } },
      ]),
    ).toBe(false);
  });

  it('ignores a ledger entry with no name', () => {
    expect(assetProducingToolsInPlay([{ result: { success: true } }])).toBe(false);
  });
});

describe('buildFalseClaimCorrectionFooter', () => {
  it('states both the claimed and actual counts, and the ledger backing them', () => {
    const footer = buildFalseClaimCorrectionFooter(
      { claimed: 12, actual: 4 },
      fourScreenshotsForFooterTest(),
    );
    expect(footer).toContain('12');
    expect(footer).toContain('4');
    expect(footer).toContain('playwright_browser_take_screenshot');
    expect(footer).toContain('https://s3.example.com/1.png');
  });

  // ENG-1331 manager follow-up: the footer must be scoped the same way the claim
  // detection was, or the "only 4 of 12" correction would sit next to a ledger
  // listing 44 successes from an earlier, already-closed step/variant.
  it('scopes its ledger to since the last step boundary, excluding an earlier step\'s assets', () => {
    const footer = buildFalseClaimCorrectionFooter(
      { claimed: 12, actual: 4 },
      [
        { name: 'save_file', result: { success: true, file_url: 'https://s3.example.com/earlier-step.html' } },
        { name: 'set_work_plan_status', result: { success: true } },
        ...fourScreenshotsForFooterTest(),
      ],
    );
    expect(footer).not.toContain('earlier-step.html');
    expect(footer).toContain('playwright_browser_take_screenshot');
  });

  it('handles an empty ledger without throwing', () => {
    const footer = buildFalseClaimCorrectionFooter({ claimed: 12, actual: 0 }, []);
    expect(typeof footer).toBe('string');
    expect(footer).toContain('12');
    expect(footer).toContain('0');
  });
});

function fourScreenshotsForFooterTest() {
  return Array.from({ length: 4 }, (_, i) => ({
    name: 'playwright_browser_take_screenshot',
    result: { success: true, screenshotUrl: `https://s3.example.com/${i + 1}.png` },
  }));
}

// ENG-1331: the work-plan step completion gate's own asset counter
// (extractGeneratedImageFilenames) only recognizes generate_image's marker, so a
// Playwright-screenshot-rendered step could never satisfy expectedAssetCount even
// when it was set. extractProducedAssetCount reads the same persisted
// session.messages toolCalls ledger for every ASSET_PRODUCING_TOOL_NAMES tool.
describe('extractProducedAssetCount', () => {
  function assistantMessage(toolCalls: any[], timestamp?: string) {
    return { role: 'assistant', timestamp, metadata: { timestamp, toolCalls } };
  }

  it('counts successful playwright_browser_take_screenshot calls — the production gap', () => {
    const messages = [
      assistantMessage([
        { name: 'create_html_file', result: { success: true, s3_url: 'https://s3.example.com/template.html' } },
        ...fourScreenshotsForFooterTest(),
      ]),
    ];
    // Max across tool types, not a sum — see the dedicated "does not pad" test below
    // for why. 1 create_html_file + 4 screenshots -> 4, not 5.
    expect(extractProducedAssetCount(messages)).toBe(4);
  });

  // A step like "Render the Full Size Matrix" legitimately calls BOTH
  // create_html_file (a few reusable templates) and playwright_browser_take_
  // screenshot (one per requested size) — real work, not padding. But they are not
  // interchangeable units of the step's deliverable: summing them would let, e.g.,
  // 5 create_html_file calls + 7 screenshots satisfy expectedAssetCount=12 while
  // only 7 of the 12 requested sizes were actually rendered — the exact class of
  // false-completion bug this module exists to catch, just introduced by its own
  // counting instead of the model's prose.
  it('does not let one tool type pad another\'s count toward the total', () => {
    const messages = [
      assistantMessage([
        ...Array.from({ length: 5 }, (_, i) => ({
          name: 'create_html_file',
          result: { success: true, s3_url: `https://s3.example.com/template-${i}.html` },
        })),
        ...Array.from({ length: 7 }, (_, i) => ({
          name: 'playwright_browser_take_screenshot',
          result: { success: true, screenshotUrl: `https://s3.example.com/${i}.png` },
        })),
      ]),
    ];
    // NOT 12 (5 + 7) — only 7 of the primary per-size deliverable actually happened.
    expect(extractProducedAssetCount(messages)).toBe(7);
  });

  it('counts generate_image successes too', () => {
    const messages = [
      assistantMessage([
        { name: 'generate_image', result: { success: true, imageUrl: 'https://s3.example.com/hero.png' } },
      ]),
    ];
    expect(extractProducedAssetCount(messages)).toBe(1);
  });

  it('ignores non-asset-producing tools', () => {
    const messages = [
      assistantMessage([
        { name: 'search_user_assets', result: { success: true, results: [] } },
        { name: 'set_work_plan_status', result: { success: true } },
      ]),
    ];
    expect(extractProducedAssetCount(messages)).toBe(0);
  });

  it('ignores errored, deferred, and reported-failure calls', () => {
    const messages = [
      assistantMessage([
        { name: 'playwright_browser_take_screenshot', error: 'timeout' },
        { name: 'playwright_browser_take_screenshot', result: { deferred: true } },
        { name: 'playwright_browser_take_screenshot', result: { success: false } },
      ]),
    ];
    expect(extractProducedAssetCount(messages)).toBe(0);
  });

  it('ignores non-assistant messages', () => {
    const messages = [
      { role: 'user', metadata: { toolCalls: fourScreenshotsForFooterTest() } },
      { role: 'system', metadata: { toolCalls: fourScreenshotsForFooterTest() } },
    ];
    expect(extractProducedAssetCount(messages as any)).toBe(0);
  });

  it('excludes calls before sinceIso — an earlier step\'s assets do not satisfy a later step', () => {
    const messages = [
      assistantMessage(fourScreenshotsForFooterTest(), '2026-08-18T09:12:00.000Z'),
      assistantMessage(fourScreenshotsForFooterTest(), '2026-08-18T09:20:00.000Z'),
    ];
    expect(extractProducedAssetCount(messages, '2026-08-18T09:15:00.000Z')).toBe(4);
  });

  it('returns 0 for missing or empty message history', () => {
    expect(extractProducedAssetCount(undefined)).toBe(0);
    expect(extractProducedAssetCount([])).toBe(0);
  });

  // ENG-1331 (post-launch hardening): a step author can name exactly which tool(s)
  // count, removing the max-vs-sum ambiguity entirely instead of relying on a
  // heuristic. When named, those tools are SUMMED (the author has already resolved
  // any padding risk by choosing what to name) — unlike the max-based default.
  describe('with an explicit tools allowlist', () => {
    it('sums only the named tool, ignoring a co-occurring unrelated asset-producing tool', () => {
      const messages = [
        assistantMessage([
          { name: 'create_html_file', result: { success: true, s3_url: 'https://s3.example.com/t1.html' } },
          { name: 'create_html_file', result: { success: true, s3_url: 'https://s3.example.com/t2.html' } },
          ...fourScreenshotsForFooterTest(),
        ]),
      ];
      expect(extractProducedAssetCount(messages, undefined, ['playwright_browser_take_screenshot'])).toBe(4);
    });

    it('sums across multiple named tools when the author declares more than one', () => {
      const messages = [
        assistantMessage([
          { name: 'generate_image', result: { success: true, imageUrl: 'https://s3.example.com/a.png' } },
          { name: 'generate_video', result: { success: true, videoUrl: 'https://s3.example.com/b.mp4' } },
        ]),
      ];
      expect(extractProducedAssetCount(messages, undefined, ['generate_image', 'generate_video'])).toBe(2);
    });

    it('ignores a tool call whose name is not in the allowlist even if it is asset-producing', () => {
      const messages = [assistantMessage([
        { name: 'save_file', result: { success: true, file_url: 'https://s3.example.com/report.pdf' } },
      ])];
      expect(extractProducedAssetCount(messages, undefined, ['playwright_browser_take_screenshot'])).toBe(0);
    });

    it('treats an empty tools array the same as omitting it (falls back to max)', () => {
      const messages = [
        assistantMessage([
          { name: 'create_html_file', result: { success: true, s3_url: 'https://s3.example.com/t1.html' } },
          ...fourScreenshotsForFooterTest(),
        ]),
      ];
      expect(extractProducedAssetCount(messages, undefined, [])).toBe(4); // max(1, 4), not sum
    });
  });
});
