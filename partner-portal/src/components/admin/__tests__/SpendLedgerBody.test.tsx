import React from "react";
import { render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";

import SpendLedgerBody, {
  MAX_ROWS_PER_CUT,
  usdFromMicro,
  committedMicroUsd,
  committedPercent,
  shortInstant,
  shortDay,
  allowanceComparison,
  partialCoverageCaption,
  enforcementCounter,
  EnforcementState,
  SpendLedgerPayload,
  MonthlyProjection,
} from "../SpendLedgerBody";

const projection = (over: Partial<MonthlyProjection> = {}): MonthlyProjection => ({
  settledMicroUsd: 55_000,
  reservedMicroUsd: 0,
  includedAllowanceMicroUsd: 200_000_000,
  purchasedCreditsMicroUsd: 0,
  adminAdjustmentMicroUsd: 0,
  migrationAdjustmentMicroUsd: 0,
  usableAllowanceMicroUsd: 200_000_000,
  remainingMicroUsd: 199_945_000,
  overspentMicroUsd: 0,
  unlimited: false,
  policyMode: "full_choice",
  settledEventCount: 2,
  reservedEventCount: 0,
  voidedEventCount: 0,
  excludedEventCount: 0,
  ...over,
});

const payload = (over: Partial<SpendLedgerPayload> = {}): SpendLedgerPayload => ({
  billingUserId: "owner-1",
  requestedUserId: "owner-1",
  billingMonth: "2026-09",
  daily: [{ date: "2026-09-04", settledMicroUsd: 55_000, reservedMicroUsd: 0, eventCount: 2 }],
  byProvider: [
    { key: "apollo", settledMicroUsd: 40_000, reservedMicroUsd: 0, eventCount: 1, percentOfSettled: 72.7 },
    { key: "twitter", settledMicroUsd: 15_000, reservedMicroUsd: 0, eventCount: 1, percentOfSettled: 27.3 },
  ],
  byFeature: [
    { key: "lead-finder", settledMicroUsd: 55_000, reservedMicroUsd: 0, eventCount: 2, percentOfSettled: 100 },
  ],
  byMember: [
    { key: "member-1", settledMicroUsd: 55_000, reservedMicroUsd: 0, eventCount: 2, percentOfSettled: 100 },
  ],
  bySession: [
    { key: "(unattributed)", settledMicroUsd: 55_000, reservedMicroUsd: 0, eventCount: 2, percentOfSettled: 100 },
  ],
  inFlight: [],
  inFlightMicroUsd: 0,
  settledMicroUsd: 55_000,
  eventCount: 2,
  projection: projection(),
  pause: {
    paused: false,
    reason: null,
    settledMicroUsd: 55_000,
    reservedMicroUsd: 0,
    usableAllowanceMicroUsd: 200_000_000,
    overspentMicroUsd: 0,
    topProviders: [],
  },
  ...over,
});

describe("SpendLedgerBody pure helpers", () => {
  it("keeps sub-cent vendor spend visible instead of rounding it to $0.00", () => {
    // An X owned-read is $0.001 and an enrich.so validation $0.0005. Two
    // decimals would render the rows this screen exists to itemise as nothing.
    expect(usdFromMicro(1_000)).toBe("$0.0010");
    expect(usdFromMicro(500)).toBe("$0.0005");
    expect(usdFromMicro(0)).toBe("$0.00");
    expect(usdFromMicro(55_000)).toBe("$0.0550");
    expect(usdFromMicro(200_000_000)).toBe("$200.00");
  });

  it("puts the sign outside the currency symbol for a reversal", () => {
    // `$-5.00` reads as a malformed figure rather than money taken back, and an
    // admin reversal is the one place a negative amount is legitimate here.
    expect(usdFromMicro(-5_000_000)).toBe("-$5.00");
    expect(usdFromMicro(-1_000)).toBe("-$0.0010");
  });

  it("counts committed money as settled plus reserved", () => {
    // ENG-1250 §4's admission basis. Settled alone next to the allowance would
    // make a pause look unexplained by the numbers shown beside it.
    expect(committedMicroUsd({ settledMicroUsd: 10, reservedMicroUsd: 5 })).toBe(15);
  });

  it("reports no allowance percentage for an uncapped tier", () => {
    // "No policy" is not "zero dollars" — a percentage here would be a division
    // by an allowance that does not exist.
    expect(committedPercent(projection({ unlimited: true }))).toBeNull();
    expect(committedPercent(projection({ usableAllowanceMicroUsd: 0 }))).toBeNull();
    expect(
      committedPercent(projection({ settledMicroUsd: 50_000_000, usableAllowanceMicroUsd: 200_000_000 })),
    ).toBeCloseTo(25, 5);
  });

  it("renders an instant in UTC, and passes an unparseable one through", () => {
    expect(shortInstant("2026-09-04T10:05:00.000Z")).toBe("Sep 4, 10:05 UTC");
    expect(shortInstant("not-a-date")).toBe("not-a-date");
  });
});

describe("SpendLedgerBody", () => {
  it("renders nothing without a payload", () => {
    const { container } = render(<SpendLedgerBody data={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows settled spend, in-flight and allowance as three separate figures (AC2, AC4)", () => {
    render(
      <SpendLedgerBody
        data={payload({
          settledMicroUsd: 10_000,
          inFlightMicroUsd: 90_000,
          inFlight: [
            {
              eventId: "evt-r",
              occurredAt: "2026-09-04T10:00:00.000Z",
              provider: "v0",
              operation: "landing_page_generation",
              costMicroUsd: 90_000,
              actingUserId: "member-1",
            },
          ],
          projection: projection({ settledMicroUsd: 10_000, reservedMicroUsd: 90_000, reservedEventCount: 1 }),
        })}
      />,
    );

    // A reservation is never folded into settled spend.
    expect(screen.getByTestId("spend-ledger-settled")).toHaveTextContent("$0.0100");
    expect(screen.getByTestId("spend-ledger-inflight")).toHaveTextContent("$0.0900");
    // And it is itemised, because a pause has to be explained against it.
    expect(within(screen.getByTestId("spend-ledger-inflight-table")).getByText("v0")).toBeInTheDocument();
  });

  // SUPERSEDES "states why an account is paused, from the same events it
  // reports (AC3)". ENG-1874: `explainPause` compares committed spend against
  // the usable allowance, and those have different bases — the ledger holds
  // vendor spend only, the allowance covers LLM too. A pause claim built on
  // that is wrong, not merely weak, so it is withheld rather than shown.
  it("withholds the pause explanation while the ledger cannot substantiate it (ENG-1874)", () => {
    render(
      <SpendLedgerBody
        data={payload({
          pause: {
            paused: true,
            reason: "Committed spend $210.00 reached the cap against a usable allowance of $200.00.",
            settledMicroUsd: 210_000_000,
            reservedMicroUsd: 0,
            usableAllowanceMicroUsd: 200_000_000,
            overspentMicroUsd: 10_000_000,
            topProviders: [],
          },
          projection: projection({ settledMicroUsd: 210_000_000, overspentMicroUsd: 10_000_000, remainingMicroUsd: 0 }),
        })}
      />,
    );

    expect(screen.queryByTestId("spend-ledger-pause")).not.toBeInTheDocument();
    expect(screen.queryByText(/reached the cap/)).not.toBeInTheDocument();
    // The spend itself is still reported — only the comparison is withheld.
    expect(screen.getByTestId("spend-ledger-settled")).toBeInTheDocument();
  });

  it("shows no allowance, remaining or percentage figure at all (ENG-1874 AC1)", () => {
    render(<SpendLedgerBody data={payload()} />);

    // The comparison is invalid regardless of the tier, so nothing conditional
    // survives here — not "Uncapped", not a floored $0.00, not a percentage.
    expect(screen.queryByTestId("spend-ledger-allowance")).not.toBeInTheDocument();
    expect(screen.queryByTestId("spend-ledger-remaining")).not.toBeInTheDocument();
    expect(screen.queryByText(/of allowance committed/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Usable allowance/)).not.toBeInTheDocument();
  });

  it("states why those figures are absent, rather than leaving a hole (ENG-1874)", () => {
    render(<SpendLedgerBody data={payload()} />);

    const note = screen.getByTestId("spend-ledger-basis-note");
    expect(note).toHaveTextContent("vendor spend only");
    // Naming the reason matters: an unexplained omission reads as a bug, and
    // the next reader would try to restore the comparison.
    expect(note).toHaveTextContent("withheld");
  });

  it("withholds allowance adjustments along with the allowance (ENG-1874)", () => {
    // An adjustment shown next to no balance invites the reader to
    // reconstruct the comparison this change exists to remove.
    render(
      <SpendLedgerBody
        data={payload({
          projection: projection({
            purchasedCreditsMicroUsd: 50_000_000,
            adminAdjustmentMicroUsd: -5_000_000,
            usableAllowanceMicroUsd: 245_000_000,
          }),
        })}
      />,
    );
    expect(screen.queryByTestId("spend-ledger-adjustments")).not.toBeInTheDocument();
    expect(screen.queryByText("Purchased credits")).not.toBeInTheDocument();
  });

  it("hides the adjustments block entirely when there are none", () => {
    render(<SpendLedgerBody data={payload()} />);
    expect(screen.queryByTestId("spend-ledger-adjustments")).not.toBeInTheDocument();
  });

  it("says a month has no events rather than showing $0.00 spent (AC5)", () => {
    render(
      <SpendLedgerBody
        data={payload({
          eventCount: 0,
          settledMicroUsd: 0,
          daily: [],
          byProvider: [],
          byFeature: [],
          byMember: [],
          bySession: [],
          projection: projection({ settledMicroUsd: 0, settledEventCount: 0, remainingMicroUsd: 200_000_000 }),
        })}
      />,
    );
    const empty = screen.getByTestId("spend-ledger-empty");
    expect(empty).toHaveTextContent("No spend recorded");
    expect(empty).toHaveTextContent("not the same as $0.00 spent");
    // The slice tables are not rendered at all, rather than as empty grids.
    expect(screen.queryByTestId("spend-slice-byProvider")).not.toBeInTheDocument();
  });

  it("shows an unattributed bucket as its own row rather than dropping it (AC6)", () => {
    render(<SpendLedgerBody data={payload()} />);
    const bySession = screen.getByTestId("spend-slice-bySession");
    expect(within(bySession).getByText("(unattributed)")).toBeInTheDocument();
  });

  it("names the billing owner when the admin opened an org member", () => {
    // The ledger is partitioned by billing root, so opening a member shows the
    // ORG's spend. Unsaid, an org-wide figure reads as one person's.
    render(<SpendLedgerBody data={payload({ requestedUserId: "member-1", billingUserId: "owner-1" })} />);
    const note = screen.getByTestId("spend-ledger-billing-subject");
    expect(note).toHaveTextContent("owner-1");
    expect(note).toHaveTextContent("member-1");
  });

  it("says nothing about billing subjects when the admin opened the owner", () => {
    render(<SpendLedgerBody data={payload()} />);
    expect(screen.queryByTestId("spend-ledger-billing-subject")).not.toBeInTheDocument();
  });

  it("warns when the usage policy could not be evaluated, so the state is not read as measured", () => {
    render(
      <SpendLedgerBody
        data={payload({ projection: projection({ policyModeError: "hardCostThresholdMicroUsd must be a number" }) })}
      />,
    );
    expect(screen.getByTestId("spend-ledger-policy-error")).toHaveTextContent("must be a number");
  });

  it("warns when events were excluded, because that should never happen", () => {
    render(<SpendLedgerBody data={payload({ projection: projection({ excludedEventCount: 3 }) })} />);
    expect(screen.getByTestId("spend-ledger-excluded")).toHaveTextContent("3 ledger events");
  });

  it("renders every slice cut, and the daily trend", () => {
    render(<SpendLedgerBody data={payload()} />);
    for (const id of ["byProvider", "byFeature", "byMember", "bySession"]) {
      expect(screen.getByTestId(`spend-slice-${id}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId("spend-ledger-daily")).toHaveTextContent("2026-09-04");
    expect(within(screen.getByTestId("spend-slice-byProvider")).getByText("apollo")).toBeInTheDocument();
  });

  it("caps an unbounded cut and counts the tail rather than dropping it", () => {
    // bySession is one row per session in the month. Rendering all of them is a
    // slow modal; hiding them silently would make the visible rows look like the
    // whole month, so the remainder is stated and the totals still include it.
    const many = Array.from({ length: MAX_ROWS_PER_CUT + 7 }, (_, i) => ({
      key: `session-${i}`,
      settledMicroUsd: 1_000,
      reservedMicroUsd: 0,
      eventCount: 1,
      percentOfSettled: 1,
    }));
    render(<SpendLedgerBody data={payload({ bySession: many })} />);

    const cut = screen.getByTestId("spend-slice-bySession");
    expect(within(cut).getAllByText(/^session-/)).toHaveLength(MAX_ROWS_PER_CUT);
    const more = screen.getByTestId("spend-slice-bySession-more");
    expect(more).toHaveTextContent("7 more");
    expect(more).toHaveTextContent("included in every total above");
  });

  it("caps the open-reservations table the same way", () => {
    const many = Array.from({ length: MAX_ROWS_PER_CUT + 3 }, (_, i) => ({
      eventId: `evt-${i}`,
      occurredAt: "2026-09-04T10:00:00.000Z",
      provider: "v0",
      operation: "landing_page_generation",
      costMicroUsd: 1_000,
      actingUserId: "member-1",
    }));
    render(
      <SpendLedgerBody
        data={payload({
          inFlight: many,
          inFlightMicroUsd: many.length * 1_000,
          projection: projection({ reservedMicroUsd: many.length * 1_000, reservedEventCount: many.length }),
        })}
      />,
    );

    const table = screen.getByTestId("spend-ledger-inflight-table");
    expect(within(table).getAllByText("v0")).toHaveLength(MAX_ROWS_PER_CUT);
    expect(screen.getByTestId("spend-ledger-inflight-more")).toHaveTextContent("3 more not shown");
    // The headline still counts every reservation, capped rendering or not.
    expect(screen.getByTestId("spend-ledger-inflight")).toHaveTextContent("$0.0280");
  });

  it("adds no remainder note when a cut fits", () => {
    render(<SpendLedgerBody data={payload()} />);
    expect(screen.queryByTestId("spend-slice-byProvider-more")).not.toBeInTheDocument();
    expect(screen.queryByTestId("spend-ledger-inflight-more")).not.toBeInTheDocument();
  });

  it("states an empty cut instead of rendering an empty table", () => {
    render(<SpendLedgerBody data={payload({ bySession: [] })} />);
    expect(screen.getByTestId("spend-slice-bySession")).toHaveTextContent("Nothing recorded for this cut");
  });
});

// ── ENG-1934: LLM spend on the ledger ───────────────────────────────────────
// The ENG-1874 tests above use a payload with no `llmLedger` — exactly what a
// backend that predates ENG-1934 returns — and keep proving that case stays
// withheld. These cover a backend that reports coverage.

const coverage = (
  month: "none" | "partial" | "full",
  recording = true,
  missingLlmMicroUsd: number | null = month === "partial" ? 12_340_000 : month === "full" ? 0 : null,
) => ({
  llmLedger: {
    recording,
    startedOn: "2026-09-14",
    month,
    ledgerLlmMicroUsd: 50_000_000,
    aggregateLlmMicroUsd: missingLlmMicroUsd == null ? null : 50_000_000 + missingLlmMicroUsd,
    missingLlmMicroUsd,
  },
});

describe("SpendLedgerBody with LLM ledger coverage (ENG-1934)", () => {
  it("decides the comparison from coverage, withholding whenever LLM spend cannot be in the total", () => {
    expect(allowanceComparison({})).toBe("withheld");
    expect(allowanceComparison(coverage("none"))).toBe("withheld");
    expect(allowanceComparison(coverage("partial"))).toBe("partial");
    expect(allowanceComparison(coverage("full"))).toBe("full");
    expect(shortDay("2026-09-14")).toBe("Sep 14");
    expect(partialCoverageCaption(coverage("partial").llmLedger)).toBe(
      "Understated: $12.34 of LLM spend is not in the ledger",
    );
  });

  it("a fully covered month shows allowance, remaining and percentage, with no understatement warning", () => {
    render(
      <SpendLedgerBody
        data={payload({
          billingMonth: "2026-10",
          ...coverage("full"),
          projection: projection({ settledMicroUsd: 50_000_000, remainingMicroUsd: 150_000_000 }),
        })}
      />,
    );

    expect(screen.getByTestId("spend-ledger-allowance")).toHaveTextContent("$200.00");
    expect(screen.getByTestId("spend-ledger-remaining")).toHaveTextContent("$150.00");
    expect(screen.getByText("25.0% of allowance committed")).toBeInTheDocument();
    expect(screen.queryByTestId("spend-ledger-partial-coverage")).not.toBeInTheDocument();
    expect(screen.getByTestId("spend-ledger-basis-note")).toHaveTextContent("LLM and vendor spend");
  });

  it("partial coverage states the MEASURED gap IN the figure's caption, not a footnote", () => {
    render(<SpendLedgerBody data={payload(coverage("partial"))} />);

    const remaining = screen.getByTestId("spend-ledger-remaining").parentElement!;
    expect(within(remaining).getByTestId("spend-ledger-partial-coverage")).toHaveTextContent(
      "Understated: $12.34 of LLM spend is not in the ledger",
    );
  });

  it("a ledger that holds MORE than the usage records is called overstated, not understated", () => {
    const over = coverage("partial");
    over.llmLedger.missingLlmMicroUsd = 0;
    (over.llmLedger as any).excessLlmMicroUsd = 5_000_000;

    expect(partialCoverageCaption(over.llmLedger)).toBe(
      "Overstated: the ledger holds $5.00 more LLM spend than usage records",
    );
  });

  it("an unmeasured month says so rather than claiming a gap or completeness", () => {
    render(<SpendLedgerBody data={payload(coverage("partial", true, null))} />);

    expect(screen.getByTestId("spend-ledger-partial-coverage")).toHaveTextContent("Unverified");
  });

  it("an uncapped tier still gets the caption — its total is just as incomplete (CodeRabbit, PR #2904)", () => {
    render(<SpendLedgerBody data={payload({ ...coverage("partial"), projection: projection({ unlimited: true }) })} />);

    expect(screen.getByTestId("spend-ledger-allowance")).toHaveTextContent("Uncapped");
    expect(screen.getByTestId("spend-ledger-partial-coverage")).toHaveTextContent("Understated");
  });

  it("a month that ended before recording began stays withheld, and says why in terms of that month", () => {
    render(<SpendLedgerBody data={payload({ billingMonth: "2026-08", ...coverage("none") })} />);

    expect(screen.queryByTestId("spend-ledger-allowance")).not.toBeInTheDocument();
    expect(screen.queryByText(/of allowance committed/)).not.toBeInTheDocument();
    const note = screen.getByTestId("spend-ledger-basis-note");
    expect(note).toHaveTextContent("2026-08 ended before LLM spend was recorded here (from Sep 14)");
    expect(note).toHaveTextContent("withheld");
  });

  it("restores adjustments beside the allowance they change", () => {
    render(
      <SpendLedgerBody
        data={payload({
          ...coverage("full"),
          projection: projection({ purchasedCreditsMicroUsd: 50_000_000, adminAdjustmentMicroUsd: -5_000_000 }),
        })}
      />,
    );

    const adjustments = screen.getByTestId("spend-ledger-adjustments");
    expect(within(adjustments).getByText("Purchased credits")).toBeInTheDocument();
    expect(within(adjustments).getByText("-$5.00")).toBeInTheDocument();
  });

  it("still withholds the pause explanation — the live gate counts LLM only, this total counts both", () => {
    render(
      <SpendLedgerBody
        data={payload({
          ...coverage("full"),
          pause: {
            paused: true,
            reason: "Committed spend $210.00 reached the cap against a usable allowance of $200.00.",
            settledMicroUsd: 210_000_000,
            reservedMicroUsd: 0,
            usableAllowanceMicroUsd: 200_000_000,
            overspentMicroUsd: 10_000_000,
            topProviders: [],
          },
        })}
      />,
    );

    expect(screen.queryByTestId("spend-ledger-pause")).not.toBeInTheDocument();
    expect(screen.queryByText(/reached the cap/)).not.toBeInTheDocument();
    expect(screen.getByTestId("spend-ledger-basis-note")).toHaveTextContent("do not explain a pause");
  });

  it("warns when the backend has LLM recording switched off", () => {
    render(<SpendLedgerBody data={payload(coverage("full", false))} />);

    expect(screen.getByTestId("spend-ledger-llm-recording-off")).toHaveTextContent("SPEND_LEDGER_LLM_DUAL_WRITE=false");
  });

  it("labels the provider cut for both LLM providers and vendors", () => {
    render(<SpendLedgerBody data={payload(coverage("full"))} />);

    expect(within(screen.getByTestId("spend-slice-byProvider")).getByText("By provider")).toBeInTheDocument();
  });
});

// ── ENG-1886: the enforcer's own pause decision ─────────────────────────────

describe("SpendLedgerBody enforcement state (ENG-1886)", () => {
  const live = (over: Partial<Extract<EnforcementState, { available: true }>> = {}): EnforcementState => ({
    available: true,
    month: "2026-09",
    paused: false,
    usageMode: "full_choice",
    gatedBy: "cost",
    used: 187.23,
    limit: 200,
    percentUsed: 93.6,
    resetsOn: "2026-10-01",
    usagePolicyVersion: "v3",
    ...over,
  });

  it("AC1: says plainly when the account is paused now, against which counter and threshold", () => {
    render(<SpendLedgerBody data={payload({ enforcement: live({ paused: true, usageMode: "paused", used: 204.1, percentUsed: 102.1 }) })} />);

    const card = screen.getByTestId("spend-ledger-enforcement");
    expect(card).toHaveTextContent("Paused now by the usage cap (mode: paused)");
    expect(card).toHaveTextContent("Enforcer's counter (LLM cost): $204.10 of $200.00 (102.1%) · resets Oct 1");
  });

  it("says when the account is not paused", () => {
    render(<SpendLedgerBody data={payload({ enforcement: live() })} />);

    expect(screen.getByTestId("spend-ledger-enforcement")).toHaveTextContent("Not paused: the usage cap is admitting work");
  });

  it("an uncapped account says no cap is configured, not that a cap is admitting work (CodeRabbit, PR #2922)", () => {
    render(<SpendLedgerBody data={payload({ enforcement: live({ gatedBy: "none", limit: null }) })} />);

    const card = screen.getByTestId("spend-ledger-enforcement");
    expect(card).toHaveTextContent("Not paused: no usage cap is configured");
    expect(card).not.toHaveTextContent("the usage cap is admitting work");
  });

  it("AC3: distinguishes the enforcer's counter from the ledger total", () => {
    render(<SpendLedgerBody data={payload({ enforcement: live() })} />);

    expect(screen.getByTestId("spend-ledger-enforcement")).toHaveTextContent(
      "This is the counter that decides admission (AW-Users), not the ledger total below. The two can differ.",
    );
  });

  it("reads a token-gated account in tokens, and an uncapped one as having no cap", () => {
    expect(enforcementCounter(live({ gatedBy: "tokens", used: 1_200_000, limit: 3_000_000, percentUsed: 40 }) as any)).toBe(
      "1,200,000 tokens of 3,000,000 tokens (40.0%)",
    );
    expect(enforcementCounter(live({ gatedBy: "none", limit: null }) as any)).toBe("no cap configured");
  });

  it("never claims a pause for a past month", () => {
    render(
      <SpendLedgerBody
        data={payload({ billingMonth: "2026-08", enforcement: { available: false, reason: "not-current-month", currentMonth: "2026-09" } })}
      />,
    );

    const card = screen.getByTestId("spend-ledger-enforcement");
    expect(card).toHaveTextContent("Pause state is only known for the current month (2026-09)");
    expect(card).not.toHaveTextContent("Paused now");
  });

  it("says it could not read the state instead of implying either answer", () => {
    render(<SpendLedgerBody data={payload({ enforcement: { available: false, reason: "unreadable", message: "x" } })} />);

    expect(screen.getByTestId("spend-ledger-enforcement")).toHaveTextContent("Could not read whether this account is paused");
  });

  it("AC4: the shadow ledger pause is still never rendered, even when it says paused", () => {
    render(
      <SpendLedgerBody
        data={payload({
          enforcement: live({ paused: false }),
          pause: {
            paused: true,
            reason: "Committed spend $210.00 reached the cap against a usable allowance of $200.00.",
            settledMicroUsd: 210_000_000,
            reservedMicroUsd: 0,
            usableAllowanceMicroUsd: 200_000_000,
            overspentMicroUsd: 10_000_000,
            topProviders: [],
          },
        })}
      />,
    );

    expect(screen.queryByText(/reached the cap/)).not.toBeInTheDocument();
    expect(screen.getByTestId("spend-ledger-enforcement")).toHaveTextContent("Not paused");
  });

  it("renders nothing about enforcement for a backend that does not send it", () => {
    render(<SpendLedgerBody data={payload()} />);

    expect(screen.queryByTestId("spend-ledger-enforcement")).not.toBeInTheDocument();
  });
});

// ── ENG-1841: rows the server left out are still stated ─────────────────────

describe("SpendLedgerBody with server-bounded rows (ENG-1841)", () => {
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      key: `s${i}`,
      settledMicroUsd: 1_000,
      reservedMicroUsd: 0,
      eventCount: 1,
      percentOfSettled: 1,
    }));

  it("counts rows the server omitted in 'of N' and 'more not shown'", () => {
    render(
      <SpendLedgerBody
        data={payload({
          bySession: rows(100),
          omitted: { bySession: { rows: 407, eventCount: 407, settledMicroUsd: 407_000, reservedMicroUsd: 0 } },
        })}
      />,
    );

    expect(screen.getByTestId("spend-slice-bySession-more")).toHaveTextContent(
      `Showing the ${MAX_ROWS_PER_CUT} largest of 507 — ${507 - MAX_ROWS_PER_CUT} more not shown, but included in every total above.`,
    );
  });

  it("states a remainder even when the server list alone fits on screen", () => {
    render(
      <SpendLedgerBody
        data={payload({
          bySession: rows(3),
          omitted: { bySession: { rows: 2, eventCount: 2, settledMicroUsd: 2_000, reservedMicroUsd: 0 } },
        })}
      />,
    );

    expect(screen.getByTestId("spend-slice-bySession-more")).toHaveTextContent("Showing the 3 largest of 5 — 2 more not shown");
  });

  it("counts omitted open reservations too", () => {
    const inFlight = Array.from({ length: 30 }, (_, i) => ({
      eventId: `r${i}`,
      occurredAt: "2026-09-04T10:00:00.000Z",
      provider: "v0",
      operation: "generate",
      costMicroUsd: 1_000,
      actingUserId: "member-1",
    }));
    render(
      <SpendLedgerBody
        data={payload({
          inFlight,
          inFlightMicroUsd: 40_000,
          omitted: { inFlight: { rows: 10, eventCount: 10, settledMicroUsd: 0, reservedMicroUsd: 10_000 } },
          projection: projection({ reservedMicroUsd: 40_000, reservedEventCount: 40 }),
        })}
      />,
    );

    expect(screen.getByTestId("spend-ledger-inflight-more")).toHaveTextContent(
      `Showing the ${MAX_ROWS_PER_CUT} most recent of 40 open reservations — ${40 - MAX_ROWS_PER_CUT} more not shown`,
    );
  });

  it("AC4: without omitted rows the screen is exactly as before", () => {
    render(<SpendLedgerBody data={payload({ bySession: rows(3) })} />);

    expect(screen.queryByTestId("spend-slice-bySession-more")).not.toBeInTheDocument();
  });
});
