import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import XCostBreakdown, { prettyOperation, UserXBreakdown } from "../XCostBreakdown";

const DATA: UserXBreakdown = {
  userId: "u1",
  start: "2026-07-01",
  end: "2026-07-31",
  costUsd: 0.065,
  callCount: 6,
  byOperation: [
    { operation: "search_tweets", callCount: 5, quantity: 10, costUsd: 0.05 },
    { operation: "post", callCount: 1, quantity: 1, costUsd: 0.015 },
  ],
};

describe("prettyOperation", () => {
  it("humanizes the tool name", () => {
    expect(prettyOperation("search_tweets")).toBe("search tweets");
    expect(prettyOperation("post")).toBe("post");
  });
});

describe("XCostBreakdown", () => {
  it("shows the empty state when there is no X usage", () => {
    render(<XCostBreakdown data={null} view="table" />);
    expect(screen.getByTestId("x-breakdown-empty")).toBeInTheDocument();
    render(<XCostBreakdown data={{ ...DATA, byOperation: [] }} view="table" />);
    expect(screen.getAllByTestId("x-breakdown-empty").length).toBeGreaterThan(0);
  });

  it("renders the total (value-forward, no 'allocated' badge) and a per-tool table", () => {
    render(<XCostBreakdown data={DATA} view="table" />);
    expect(screen.getByTestId("x-breakdown-total")).toHaveTextContent("$0.0650");
    // The dollar figure leads; "allocated" is no longer stamped on the number
    // (it lives in the hover tooltip / the tab footnote instead).
    expect(screen.queryByText("allocated")).not.toBeInTheDocument();
    const table = screen.getByTestId("x-breakdown-table");
    expect(table).toHaveTextContent("search tweets");
    expect(table).toHaveTextContent("post");
  });

  it("renders bars in bars view", () => {
    render(<XCostBreakdown data={DATA} view="bars" />);
    expect(screen.getByTestId("x-breakdown-bars")).toBeInTheDocument();
    expect(screen.queryByTestId("x-breakdown-table")).not.toBeInTheDocument();
    // Two progress bars, one per tool.
    expect(screen.getAllByRole("progressbar").length).toBe(2);
  });
});
