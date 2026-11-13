import React from "react";
import { render, screen } from "@testing-library/react";
import ProductPills from "../ProductPills";

describe("ProductPills (ENG-2906)", () => {
  it("renders a Zoma pill with the signup tooltip as its accessible label", () => {
    render(<ProductPills user={{ signupProduct: "zoma", signupClient: "codex", signupRef: "hn", attributionConfidence: "inferred" }} />);
    const pill = screen.getByText("Zoma");
    expect(pill.closest("[aria-label]")?.getAttribute("aria-label")).toBe("Signed up via Zoma · codex · ref hn (inferred)");
  });

  it("renders Zoma and Emma MCP pills together", () => {
    render(<ProductPills user={{ products: { zoma: {}, emma_mcp: {} } }} />);
    expect(screen.getByText("Zoma")).toBeTruthy();
    expect(screen.getByText("Emma MCP")).toBeTruthy();
  });

  it("renders nothing for a web-only user", () => {
    const { container } = render(<ProductPills user={{ signupProduct: "emma_web" }} />);
    expect(container.textContent).toBe("");
  });
});
