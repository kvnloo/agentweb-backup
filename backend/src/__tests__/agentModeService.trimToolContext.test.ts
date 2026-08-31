/**
 * Characterization + performance test for AgentModeService.trimToolMessagesForContext().
 *
 * Increment B3 of the AgentMode restructure: the trimming was re-derived on the
 * whole history every loop iteration (O(n^2) over a session). This suite:
 *
 *  1. Pins the CURRENT observable output (behavior-preserving): the production
 *     method must produce output deeply identical to a golden reference that
 *     replicates the original naive nested-loop algorithm, across a long
 *     synthetic session and across the real incremental (append-once-per-turn)
 *     calling pattern.
 *  2. Asserts the per-call work is sub-quadratic — measured implementation-
 *     neutrally by counting `role` property reads through a Proxy, for growing
 *     session sizes. The original nested scan grew ~quadratically; the fixed
 *     version grows ~linearly.
 *  3. Guards the install_skills splice/reorder path: updateConversationContext
 *     mutates the SAME messages array in place (splice remove + reinsert) before
 *     trimToolMessagesForContext runs. An earlier per-array length-guarded WeakMap
 *     memo served stale absolute indices after such a mutation and DIVERGED from
 *     the original algorithm; an independent review caught it and the memo was
 *     removed. These tests pin behavior on the post-splice array.
 *
 * The golden reference below is a faithful copy of the algorithm as it stood
 * before the fix. DO NOT "simplify" it to match the new implementation — its
 * entire purpose is to be an independent oracle of the prior behavior.
 *
 * TWO deliberate divergences have been folded into the oracle since:
 *  - ENG-940's follow-up changed which results the tool-content preserve window
 *    protects (the N most recent AT-RISK results, not the N most recent results
 *    outright).
 *  - ENG-1310 changed the compressed-preview TEXT itself: the placeholder now
 *    explicitly tells the model the preview is not a verified source and names
 *    the recovery path (re-read via read_tool_response/search_tool_response, or
 *    re-run the source tool), instead of a bare "[Tool: name — preview...]" that
 *    silently disappeared a few turns later with nothing pointing back at it.
 * Both are intended behavior changes, not drift, so the oracle encodes them too —
 * each is marked at the point of use. Everything else must still match byte for
 * byte, and the performance and splice/reorder guarantees are unaffected.
 */

// ─── Golden reference: the ORIGINAL trimToolMessagesForContext algorithm ──────
// Mirrors the static config constants from agentModeService.ts at the time of
// the fix so the oracle trims identically to production.
const REF_LARGE_TOOL_RESULT_LIMIT: Record<string, number> = {
  read_market_strategy: 50000,
  search_tool_response: 20000,
  read_tool_response: 60000,
  read_brand_guidelines: 15000,
  read_knowledge_base_files: 10000,
  read_page_source: 8000,
};
const REF_LARGE_TOOL_ARG_TRIM: Record<string, { fields: string[]; limit: number }> = {
  create_blog_article: { fields: ['content_draft'], limit: 500 },
  update_html_file: { fields: ['html_content', 'css_content'], limit: 200 },
};

function goldenTrim(
  messages: any[],
  recentToPreserve = 3,
  maxToolContentLength = 8000,
): any[] {
  const toolIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'tool') toolIndices.push(i);
  }
  if (toolIndices.length <= recentToPreserve) return messages;

  const preserveSet = new Set(toolIndices.slice(-recentToPreserve));

  // ENG-940 follow-up: the tool-content window preserves the N most recent
  // AT-RISK results (those over their trim limit) rather than the N most recent
  // results outright, so a result the trimmer would never touch cannot evict one
  // it would destroy. The recency-based `preserveSet` above still drives the
  // assistant-argument logic, which is unchanged.
  const atRiskIndices = toolIndices.filter(
    (i) =>
      typeof messages[i].content === 'string' &&
      messages[i].content.length > (REF_LARGE_TOOL_RESULT_LIMIT[messages[i].name] || maxToolContentLength),
  );
  const atRiskPreserveSet = new Set(atRiskIndices.slice(-recentToPreserve));

  const oldAssistantIndices = new Set<number>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      const toolCallIds = new Set(msg.tool_calls.map((tc: any) => tc.id));
      let allOld = true;
      for (let j = i + 1; j < messages.length; j++) {
        if (messages[j].role === 'tool' && toolCallIds.has(messages[j].tool_call_id)) {
          if (preserveSet.has(j)) {
            allOld = false;
            break;
          }
        }
      }
      if (allOld) oldAssistantIndices.add(i);
    }
  }

  return messages.map((msg, idx) => {
    if (msg.role === 'tool' && !atRiskPreserveSet.has(idx) && typeof msg.content === 'string') {
      const limit = REF_LARGE_TOOL_RESULT_LIMIT[msg.name] || maxToolContentLength;
      if (msg.content.length > limit) {
        // ENG-1310 divergence: none of buildSyntheticSession's fixtures carry a
        // "[Full response stored at S3 key: …]" header, so the S3-ref branch of the
        // real function is never exercised here — this mirrors production's
        // no-ref path exactly (see agentModeService.ts's trimToolMessagesForContext).
        const preview = msg.content.slice(0, 200).replace(/\n/g, ' ').trim();
        const recoveryHint = `re-run ${msg.name} if you need the full result`;
        return {
          ...msg,
          content: `[Tool: ${msg.name} — compressed for context; this preview is NOT a verified source — do not restate any number or figure from it, or from your own earlier reply, as confirmed; ${recoveryHint}. preview: ${preview}...]`,
        };
      }
    }
    if (msg.role === 'assistant' && oldAssistantIndices.has(idx) && msg.tool_calls?.length) {
      let modified = false;
      const newToolCalls = msg.tool_calls.map((tc: any) => {
        const trimSpec = REF_LARGE_TOOL_ARG_TRIM[tc.function?.name];
        if (!trimSpec) return tc;
        let args: Record<string, any>;
        try {
          args = JSON.parse(tc.function.arguments || '{}');
        } catch {
          return tc;
        }
        let changed = false;
        for (const field of trimSpec.fields) {
          if (typeof args[field] === 'string' && args[field].length > trimSpec.limit) {
            args[field] = args[field].slice(0, trimSpec.limit) + '[…trimmed]';
            changed = true;
          }
        }
        if (!changed) return tc;
        modified = true;
        return { ...tc, function: { ...tc.function, arguments: JSON.stringify(args) } };
      });
      if (modified) return { ...msg, tool_calls: newToolCalls };
    }
    return msg;
  });
}

// ─── Synthetic session generator ─────────────────────────────────────────────
// Produces a realistic AgentMode message history: a system + user preamble, then
// `turns` assistant->tool round-trips. Tool content / arg sizes alternate between
// large and small, and some turns use the trim-eligible tools, so every branch of
// the trimming logic is exercised over a long session.
function buildSyntheticSession(turns: number): any[] {
  const messages: any[] = [
    { role: 'system', content: 'You are a helpful agent.' },
    { role: 'user', content: 'Do a big multi-step task.' },
  ];
  const toolNames = [
    'search_web',
    'read_page_source',
    'read_market_strategy',
    'read_knowledge_base_files',
    'create_blog_article',
    'update_html_file',
    'small_tool',
  ];
  for (let t = 0; t < turns; t++) {
    const id = `tc_${t}`;
    const name = toolNames[t % toolNames.length];
    const big = t % 2 === 0;

    let argsObj: Record<string, any> = {};
    if (name === 'create_blog_article') {
      argsObj = { title_draft: `Title ${t}`, content_draft: 'C'.repeat(big ? 5000 : 100) };
    } else if (name === 'update_html_file') {
      argsObj = { html_content: 'H'.repeat(big ? 4000 : 50), css_content: 'S'.repeat(big ? 4000 : 50) };
    } else {
      argsObj = { query: `q${t}` };
    }

    messages.push({
      role: 'assistant',
      content: t % 3 === 0 ? `thinking ${t}` : null,
      tool_calls: [{ id, function: { name, arguments: JSON.stringify(argsObj) } }],
    });
    messages.push({
      role: 'tool',
      tool_call_id: id,
      name,
      content: big ? 'R'.repeat(12000) : `small result ${t}`,
    });
  }
  // Final assistant wrap-up with no tool calls.
  messages.push({ role: 'assistant', content: 'All done.' });
  return messages;
}

describe('trimToolMessagesForContext — characterization (behavior-preserving)', () => {
  let AgentModeService: any;

  beforeAll(async () => {
    const mod = await import('../services/agentModeService');
    AgentModeService = mod.AgentModeService;
  });

  it('produces output deeply identical to the original algorithm on a long session', () => {
    const service = new AgentModeService();
    const messages = buildSyntheticSession(60); // ~123 messages
    const expected = goldenTrim(structuredClone(messages));
    const actual = service.trimToolMessagesForContext(structuredClone(messages));
    expect(actual).toEqual(expected);
  });

  it('matches the original across the real incremental calling pattern (append per turn)', () => {
    // Simulate the AgentMode loop: the SAME messages array reference grows by an
    // assistant+tool pair each iteration, and trimToolMessagesForContext is called
    // every iteration. The memoized impl must still match a fresh golden run each time.
    const service = new AgentModeService();
    const live: any[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'go' },
    ];
    const full = buildSyntheticSession(40);
    const appendPairs = full.slice(2, full.length - 1); // assistant/tool pairs only

    for (let k = 0; k < appendPairs.length; k++) {
      live.push(appendPairs[k]);
      // Only assert after a tool message is appended (matches loop cadence after a turn).
      if (live[live.length - 1].role === 'tool') {
        const memoized = service.trimToolMessagesForContext(live);
        const golden = goldenTrim(structuredClone(live));
        expect(memoized).toEqual(golden);
      }
    }
  });

  it('returns the same array reference unchanged when at/under the preserve threshold', () => {
    const service = new AgentModeService();
    const messages = buildSyntheticSession(2); // <= 3 tool messages
    const result = service.trimToolMessagesForContext(messages);
    expect(result).toBe(messages); // identity preserved, exactly like the original
  });

  it('does not mutate the input array on a long session', () => {
    const service = new AgentModeService();
    const messages = buildSyntheticSession(50);
    const snapshot = structuredClone(messages);
    service.trimToolMessagesForContext(messages);
    expect(messages).toEqual(snapshot);
  });
});

describe('trimToolMessagesForContext — sub-quadratic work', () => {
  let AgentModeService: any;

  beforeAll(async () => {
    const mod = await import('../services/agentModeService');
    AgentModeService = mod.AgentModeService;
  });

  // Count `role` property reads across all message objects during a single call.
  // This is an implementation-neutral proxy for total work: the original nested
  // forward-scan read `role` ~O(n^2) times; the fixed version reads it ~O(n).
  function countRoleReads(messages: any[], call: (m: any[]) => void): number {
    let reads = 0;
    const proxied = messages.map((m) =>
      new Proxy(m, {
        get(target, prop, receiver) {
          if (prop === 'role') reads++;
          return Reflect.get(target, prop, receiver);
        },
      }),
    );
    call(proxied);
    return reads;
  }

  it('scales sub-quadratically: 4x the session is far less than 16x the work', () => {
    const small = buildSyntheticSession(50); // ~103 msgs
    const large = buildSyntheticSession(200); // ~403 msgs, ~4x

    // Fresh service per measurement so the WeakMap memo does not carry across.
    const smallReads = countRoleReads(small, (m) =>
      new AgentModeService().trimToolMessagesForContext(m),
    );
    const largeReads = countRoleReads(large, (m) =>
      new AgentModeService().trimToolMessagesForContext(m),
    );

    // Quadratic growth at 4x size would be ~16x the reads. Linear is ~4x.
    // Assert comfortably below quadratic (allow generous headroom: <= 6x).
    const ratio = largeReads / smallReads;
    expect(ratio).toBeLessThan(6);
  });

  it('a single call on a long established session stays linear (Map-only, no memo)', () => {
    const service = new AgentModeService();
    const base = buildSyntheticSession(120); // long, established session

    // Run once to mirror an established session before the measured call.
    service.trimToolMessagesForContext(base);

    // Append one more assistant+tool turn and re-trim. The unsafe per-array WeakMap
    // memo was removed after review (it served stale indices on the install_skills
    // splice path); the tool_call_id -> index Map alone keeps each call O(n) and
    // far below the original O(n^2) nested forward scan.
    base.push({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'tc_new', function: { name: 'search_web', arguments: '{}' } }],
    });
    base.push({ role: 'tool', tool_call_id: 'tc_new', name: 'search_web', content: 'r' });

    let reads = 0;
    const proxied = base.map((m) =>
      new Proxy(m, {
        get(target, prop, receiver) {
          if (prop === 'role') reads++;
          return Reflect.get(target, prop, receiver);
        },
      }),
    );
    // A single call on a long array must stay linear (<= ~4 reads/message:
    // 1 tool-scan + 1 old-assistant loop + 1 map pass, plus a little slack).
    service.trimToolMessagesForContext(proxied);
    expect(reads).toBeLessThan(base.length * 5);
  });
});

describe('trimToolMessagesForContext — splice/reorder safety on the same array ref', () => {
  let AgentModeService: any;

  beforeAll(async () => {
    const mod = await import('../services/agentModeService');
    AgentModeService = mod.AgentModeService;
  });

  // Regression for the install_skills splice path. updateConversationContext()
  // does messages.splice(idx, 1) (remove the old skill-context message wherever it
  // sits) then messages.splice(1, 0, …) (reinsert near the top) on the SAME
  // messages array reference, in place. When the removed element and the reinserted
  // element are at DIFFERENT positions, every absolute index between them shifts —
  // even though the total length is unchanged (net-zero). A length-guarded memo
  // (`cached.length <= messages.length`) sees no length growth, walks an empty
  // tail, and serves STALE absolute indices against the shifted array, producing a
  // wrong preserveSet / oldAssistantIndices and a trimmed output that DIVERGES from
  // the original algorithm. The Map-only implementation recomputes the scan against
  // the live array each call, so it must still match the golden oracle exactly.
  //
  // This test FAILS against the memo'd version of #1878 and PASSES after the memo
  // is dropped.
  it('matches the original after a net-zero splice/reorder on the SAME array ref', () => {
    const service = new AgentModeService();
    // Establish a session and prime the (former) memo with a first trim call.
    const live = buildSyntheticSession(30); // ~63 messages, well past preserve threshold
    const first = service.trimToolMessagesForContext(live);
    expect(first).toEqual(goldenTrim(structuredClone(live)));

    // Mirror updateConversationContext's install_skills mutation: it relocates the
    // skill-context message to near the top. Here we model a stale skill-context
    // message that had drifted to the END of the history being removed and a fresh
    // one reinserted at index 1 — exactly the remove-then-reinsert shape of
    // updateConversationContext, with NET-ZERO length. Inserting at index 1 shifts
    // EVERY subsequent message (including all preserved tail tool results) down by
    // one, so the absolute indices the memo cached no longer match the live array.
    expect(live[live.length - 1].role).not.toBe('tool'); // the trailing wrap-up assistant
    live.splice(live.length - 1, 1); // remove the stale/relocated skill-context stand-in
    live.splice(1, 0, { role: 'assistant', content: 'Installed Skills: foo, bar' });
    expect(live.length).toBe(63); // net-zero confirmed

    // The original algorithm run on the post-splice array is the oracle.
    const expected = goldenTrim(structuredClone(live));
    const actual = service.trimToolMessagesForContext(live);
    expect(actual).toEqual(expected);
  });

  it('matches the original after a length-changing splice/reorder on the SAME array ref', () => {
    const service = new AgentModeService();
    const live = buildSyntheticSession(30);
    service.trimToolMessagesForContext(live); // prime

    // Remove one element and reinsert two — a length delta this time — still on
    // the same array reference. The recomputed scan must track the new layout.
    live.splice(1, 1);
    live.splice(1, 0,
      { role: 'assistant', content: 'Available Skills: alpha' },
      { role: 'assistant', content: 'Installed Skills: alpha' },
    );

    const expected = goldenTrim(structuredClone(live));
    const actual = service.trimToolMessagesForContext(live);
    expect(actual).toEqual(expected);
  });
});
