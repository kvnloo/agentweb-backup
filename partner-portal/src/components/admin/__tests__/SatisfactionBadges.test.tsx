import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

import { SatisfactionBadges, SatisfactionColumnHeader } from "../SatisfactionBadges";

const SCORE = {
  score: 2,
  reason: "partial",
  dimensions: { goalCompletion: 1, dataAccuracy: 5, outputQuality: 3 },
};

describe("Satisfaction badges — secondary and unvalidated (ENG-2144)", () => {
  it("labels the column unvalidated", () => {
    render(<SatisfactionColumnHeader />);
    expect(screen.getByText("Satisfaction")).toBeInTheDocument();
    expect(screen.getByText("unvalidated")).toBeInTheDocument();
  });

  it("keeps the scores and judges, without red/green verdict colours", () => {
    const { container } = render(
      <SatisfactionBadges
        score={SCORE}
        judgeScores={{ j1: { score: 5, reason: "fine", judgeName: "Fangfang Judge" } }}
        onOverride={jest.fn()}
      />,
    );
    for (const label of ["Default: 2", "G:1", "A:5", "Q:3", "Fangfang Judge: 5"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(container.querySelectorAll(".MuiChip-colorError, .MuiChip-colorSuccess, .MuiChip-colorWarning")).toHaveLength(0);
  });

  it("still opens the admin override from the default score", async () => {
    const onOverride = jest.fn();
    render(<SatisfactionBadges score={{ ...SCORE, adminOverride: true }} onOverride={onOverride} />);
    await userEvent.click(screen.getByText("Default: 2"));
    expect(onOverride).toHaveBeenCalledWith(expect.any(HTMLElement), expect.objectContaining({ score: 2, adminOverride: true }));
  });
});
