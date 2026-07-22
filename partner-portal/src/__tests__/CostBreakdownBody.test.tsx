import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import CostBreakdownBody, { OrgUsageRollup } from "../components/admin/CostBreakdownBody";

// These tests mount the REAL modal-body component against org-rollup fixtures
// (the server-computed shape) — no re-implemented mirror, so display logic can't
// silently drift from what ships. Covers the ENG-200 fix: org-wide rollup,
// per-member breakdown, member "charged to owner" note, and the removal of the
// false per-member "leak" alarm.

const mkRollup = (o: Partial<OrgUsageRollup> = {}): OrgUsageRollup => ({
  userId: "u",
  month: "2026-07",
  isOrg: false,
  ownerUserId: "u",
  ownerEmail: "u@example.com",
  ownerSubscriptionType: null,
  selectedIsOwner: true,
  selectedRole: "owner",
  grossBurnUsd: 0,
  countedUsd: 0,
  countedSource: "none",
  unchargedUsd: 0,
  coveragePct: 0,
  members: [],
  byModel: [],
  ...o,
});

const model = (m: string, costUsd: number, callCount = 1, totalTokens = 1000) => ({
  model: m,
  costUsd,
  callCount,
  totalTokens,
});

describe("CostBreakdownBody — org rollup", () => {
  it("member view: rolls up org-wide burn, notes spend is charged to the owner, no leak alarm", () => {
    const r = mkRollup({
      isOrg: true,
      ownerUserId: "owner",
      ownerEmail: "owner@org.com",
      selectedIsOwner: false,
      selectedRole: "member",
      grossBurnUsd: 40,
      countedUsd: 100,
      countedSource: "current",
      unchargedUsd: 0,
      coveragePct: 250,
      members: [
        { userId: "member", email: "member@org.com", orgRole: "member", isSelected: true, burnUsd: 30, callCount: 5, totalTokens: 9000, byModel: [] },
        { userId: "owner", email: "owner@org.com", orgRole: "owner", isSelected: false, burnUsd: 10, callCount: 2, totalTokens: 3000, byModel: [] },
      ],
      byModel: [model("anthropic.claude-opus-4-8", 40, 7, 12000)],
    });
    render(<CostBreakdownBody rollup={r} view="table" costAllowanceMap={{}} />);

    expect(screen.getByTestId("rollup-gross")).toHaveTextContent("$40.00");
    expect(screen.getByTestId("rollup-counted")).toHaveTextContent("$100.00");
    // Member note names the owner and explains the deduction target.
    expect(screen.getByTestId("member-charged-note")).toHaveTextContent("owner@org.com");
    // Per-member breakdown present; the clicked member is highlighted.
    expect(screen.getByTestId("members-table")).toBeInTheDocument();
    expect(screen.getByTestId("member-row-member")).toHaveAttribute("data-selected", "true");
    expect(screen.getByTestId("member-row-owner")).toHaveAttribute("data-selected", "false");
    // Counter is ahead of tracked burn (100 > 40) → info note, NOT a leak alarm.
    expect(screen.getByTestId("counter-ahead-note")).toBeInTheDocument();
    // The old false-positive copy must be gone.
    expect(screen.queryByText(/escaping the cap/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Absorbed by platform/i)).not.toBeInTheDocument();
  });

  it("owner view: surfaces uncharged burn-only spend as coverage, not an alarm", () => {
    const r = mkRollup({
      isOrg: true,
      ownerUserId: "owner",
      ownerEmail: "owner@org.com",
      selectedIsOwner: true,
      selectedRole: "owner",
      grossBurnUsd: 50,
      countedUsd: 20,
      countedSource: "current",
      unchargedUsd: 30,
      coveragePct: 40,
      members: [
        { userId: "owner", email: "owner@org.com", orgRole: "owner", isSelected: true, burnUsd: 40, callCount: 3, totalTokens: 8000, byModel: [] },
        { userId: "m", email: "m@org.com", orgRole: "member", isSelected: false, burnUsd: 10, callCount: 1, totalTokens: 2000, byModel: [] },
      ],
      byModel: [model("anthropic.claude-opus-4-8", 40), model("gemini-3.5-flash", 10)],
    });
    render(<CostBreakdownBody rollup={r} view="table" costAllowanceMap={{}} />);

    expect(screen.getByTestId("rollup-coverage")).toHaveTextContent("40%");
    expect(screen.getByTestId("rollup-uncharged")).toHaveTextContent("$30.00 not charged");
    // Owner is not a member → no "charged to owner" note.
    expect(screen.queryByTestId("member-charged-note")).not.toBeInTheDocument();
    // No counter-ahead note (counted 20 < burn 50).
    expect(screen.queryByTestId("counter-ahead-note")).not.toBeInTheDocument();
    // Per-model rollup (org-wide), highest spend first.
    expect(screen.getByTestId("burn-anthropic.claude-opus-4-8")).toHaveTextContent("$40.0000");
  });

  it("solo user: no members table and no owner note", () => {
    const r = mkRollup({
      isOrg: false,
      grossBurnUsd: 3,
      countedUsd: 4,
      countedSource: "current",
      unchargedUsd: 0,
      coveragePct: 133.3,
      members: [{ userId: "u", email: "u@example.com", orgRole: null, isSelected: true, burnUsd: 3, callCount: 2, totalTokens: 1500, byModel: [] }],
      byModel: [model("gpt-5.2-chat", 3, 2, 1500)],
    });
    render(<CostBreakdownBody rollup={r} view="table" costAllowanceMap={{}} />);

    expect(screen.queryByTestId("members-table")).not.toBeInTheDocument();
    expect(screen.queryByTestId("member-charged-note")).not.toBeInTheDocument();
    expect(screen.getByTestId("rollup-gross")).toHaveTextContent("$3.00");
    expect(screen.getByTestId("rollup-counted")).toHaveTextContent("$4.00");
  });

  it("empty burn: explanatory alert, counted still shown, coverage dash", () => {
    const r = mkRollup({ grossBurnUsd: 0, countedUsd: 5, countedSource: "current", byModel: [] });
    render(<CostBreakdownBody rollup={r} view="table" costAllowanceMap={{}} />);

    expect(screen.getByRole("alert")).toHaveTextContent("No per-model burn has been recorded");
    expect(screen.getByTestId("rollup-counted")).toHaveTextContent("$5.00");
    expect(screen.getByTestId("rollup-coverage")).toHaveTextContent("—");
  });

  it("bars view: quota bar reads counted vs the OWNER's tier cap", () => {
    const r = mkRollup({
      isOrg: true,
      ownerSubscriptionType: "Starter",
      selectedRole: "owner",
      grossBurnUsd: 320,
      countedUsd: 300,
      countedSource: "current",
      unchargedUsd: 20,
      coveragePct: 93.75,
      members: [{ userId: "owner", email: "o@org.com", orgRole: "owner", isSelected: true, burnUsd: 320, callCount: 9, totalTokens: 5000, byModel: [] }],
      byModel: [model("anthropic.claude-opus-4-8", 300), model("gpt-4o", 20)],
    });
    render(<CostBreakdownBody rollup={r} view="bars" costAllowanceMap={{ Starter: 360 }} />);

    const bar = screen.getByTestId("quota-bar");
    expect(bar).toHaveAttribute("data-pct", "83"); // 300/360 ≈ 83%
    expect(screen.getByText(/\$300\.00 \/ \$360\.00 \(83%\)/)).toBeInTheDocument();
    // Bars view shows model bars, not the table.
    expect(screen.getByTestId("bar-anthropic.claude-opus-4-8")).toHaveAttribute("data-share", "93.8");
    expect(screen.queryByTestId("burn-anthropic.claude-opus-4-8")).not.toBeInTheDocument();
  });

  it("bars view, unlimited owner tier: shows the unlimited notice, no quota bar", () => {
    const r = mkRollup({
      isOrg: true,
      ownerSubscriptionType: "Basic",
      grossBurnUsd: 10,
      countedUsd: 5,
      unchargedUsd: 5,
      coveragePct: 50,
      members: [{ userId: "owner", email: "o@org.com", orgRole: "owner", isSelected: true, burnUsd: 10, callCount: 2, totalTokens: 2000, byModel: [] }],
      byModel: [model("gpt-4o", 10)],
    });
    render(<CostBreakdownBody rollup={r} view="bars" costAllowanceMap={{ Basic: null }} />);

    expect(screen.queryByTestId("quota-bar")).not.toBeInTheDocument();
    expect(screen.getByText(/no cost cap \(unlimited\)/i)).toBeInTheDocument();
  });
});
