import React from "react";
import { render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";

import SpendLedgerBody, {
  MAX_ROWS_PER_CUT,
  usdFromMicro,
  committedMicroUsd,
  committedPercent,
  shortInstant,
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
    expect(screen.getByTestId("spend-ledger-allowance")).toHaveTextContent("$200.00");
    // And it is itemised, because a pause has to be explained against it.
    expect(within(screen.getByTestId("spend-ledger-inflight-table")).getByText("v0")).toBeInTheDocument();
  });

  it("states why an account is paused, from the same events it reports (AC3)", () => {
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

    expect(screen.getByTestId("spend-ledger-pause")).toHaveTextContent("reached the cap");
    // Overspend replaces "remaining" rather than showing a floored $0.00, which
    // would read as "exactly at the limit".
    expect(screen.getByText("Overspent")).toBeInTheDocument();
    expect(screen.getByTestId("spend-ledger-remaining")).toHaveTextContent("$10.00");
  });

  it("distinguishes an uncapped tier from a zero allowance (AC4)", () => {
    render(<SpendLedgerBody data={payload({ projection: projection({ unlimited: true }) })} />);
    expect(screen.getByTestId("spend-ledger-allowance")).toHaveTextContent("Uncapped");
    expect(screen.getByTestId("spend-ledger-remaining")).toHaveTextContent("—");
    expect(screen.getByText(/not applicable/)).toBeInTheDocument();
  });

  it("itemises adjustments rather than netting them into the allowance (AC4)", () => {
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
    const adj = screen.getByTestId("spend-ledger-adjustments");
    expect(within(adj).getByText("Purchased credits")).toBeInTheDocument();
    expect(within(adj).getByText("$50.00")).toBeInTheDocument();
    // A reversal keeps its sign — netting it away would hide that it happened.
    expect(within(adj).getByText("-$5.00")).toBeInTheDocument();
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
