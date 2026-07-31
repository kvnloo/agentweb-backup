import { render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import XCostBreakdownBody, { XOrgUsageRollup } from "../XCostBreakdownBody";

const SOLO: XOrgUsageRollup = {
  userId: "u1",
  month: "2026-07",
  isOrg: false,
  ownerUserId: "u1",
  ownerEmail: "u1@example.com",
  selectedIsOwner: true,
  selectedRole: "owner",
  totalCostUsd: 0.065,
  totalCallCount: 6,
  members: [
    { userId: "u1", email: "u1@example.com", orgRole: "owner", isSelected: true, costUsd: 0.065, callCount: 6, byOperation: [] },
  ],
  byOperation: [
    { operation: "search_tweets", callCount: 5, quantity: 10, costUsd: 0.05 },
    { operation: "post", callCount: 1, quantity: 1, costUsd: 0.015 },
  ],
};

const ORG: XOrgUsageRollup = {
  userId: "member1",
  month: "2026-07",
  isOrg: true,
  ownerUserId: "owner1",
  ownerEmail: "owner@example.com",
  selectedIsOwner: false,
  selectedRole: "member",
  totalCostUsd: 0.07,
  totalCallCount: 3,
  members: [
    { userId: "member1", email: "member@example.com", orgRole: "member", isSelected: true, costUsd: 0.05, callCount: 2, byOperation: [] },
    { userId: "owner1", email: "owner@example.com", orgRole: "owner", isSelected: false, costUsd: 0.02, callCount: 1, byOperation: [] },
  ],
  byOperation: [
    { operation: "search_tweets", callCount: 2, quantity: 10, costUsd: 0.05 },
    { operation: "post", callCount: 1, quantity: 1, costUsd: 0.02 },
  ],
};

describe("XCostBreakdownBody", () => {
  it("renders nothing when rollup is null", () => {
    const { container } = render(<XCostBreakdownBody rollup={null} view="table" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("solo user: shows the total and per-tool table, no members table", () => {
    render(<XCostBreakdownBody rollup={SOLO} view="table" />);
    expect(screen.getByTestId("x-breakdown-total")).toHaveTextContent("$0.0650");
    expect(screen.queryByTestId("x-members-table")).not.toBeInTheDocument();
    expect(screen.queryByTestId("x-member-note")).not.toBeInTheDocument();
    const table = screen.getByTestId("x-breakdown-table");
    expect(table).toHaveTextContent("search tweets");
  });

  it("org: rolls up total, shows the per-member table and the member note", () => {
    render(<XCostBreakdownBody rollup={ORG} view="table" />);
    expect(screen.getByTestId("x-breakdown-total")).toHaveTextContent("$0.0700");
    // Member note appears because the clicked user is a member.
    expect(screen.getByTestId("x-member-note")).toBeInTheDocument();
    const members = screen.getByTestId("x-members-table");
    expect(within(members).getByTestId("x-member-row-member1")).toHaveAttribute("data-selected", "true");
    expect(within(members).getByTestId("x-member-row-owner1")).toHaveAttribute("data-selected", "false");
    expect(within(members).getByTestId("x-member-row-owner1")).toHaveTextContent("$0.0200");
  });

  it("empty spend shows the empty state", () => {
    render(<XCostBreakdownBody rollup={{ ...SOLO, byOperation: [] }} view="table" />);
    expect(screen.getByTestId("x-breakdown-empty")).toBeInTheDocument();
  });

  it("renders bars in bars view", () => {
    render(<XCostBreakdownBody rollup={ORG} view="bars" />);
    expect(screen.getByTestId("x-breakdown-bars")).toBeInTheDocument();
    expect(screen.queryByTestId("x-breakdown-table")).not.toBeInTheDocument();
  });
});
