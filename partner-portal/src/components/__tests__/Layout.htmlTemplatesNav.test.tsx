/// <reference path="../../types/assets.d.ts" />

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Layout from "../Layout";

const mockUseAuth = jest.fn();

jest.mock("../../contexts/AuthContext", () => ({
  useAuth: () => mockUseAuth(),
}));

jest.mock("../../assets/logo.svg", () => "logo.svg");
jest.mock("../ChatSupport", () => () => <div>ChatSupport</div>);

describe("Layout html templates navigation", () => {
  it("keeps Admin direct and exposes HTML Templates through the Build menu", () => {
    mockUseAuth.mockReturnValue({
      user: { isAdmin: true },
      logout: jest.fn(),
      hasRole: jest.fn().mockReturnValue(false),
    });

    render(
      <MemoryRouter initialEntries={["/tasks"]}>
        <Routes>
          <Route path="/" element={<Layout />}>
            <Route path="tasks" element={<div>Tasks Page</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByRole("link", { name: "Admin" })).toHaveAttribute("href", "/admin");
    expect(screen.queryByRole("link", { name: "HTML Templates" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Build" }));
    const htmlTemplatesLink = screen.getByRole("menuitem", { name: "HTML Templates" });
    expect(htmlTemplatesLink).toHaveAttribute("href", "/html-templates");
  });

  it("does not show HTML Templates nav button for non-admin users", () => {
    mockUseAuth.mockReturnValue({
      user: { isAdmin: false },
      logout: jest.fn(),
      hasRole: jest.fn().mockReturnValue(false),
    });

    render(
      <MemoryRouter initialEntries={["/tasks"]}>
        <Routes>
          <Route path="/" element={<Layout />}>
            <Route path="tasks" element={<div>Tasks Page</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    );

    expect(screen.queryByRole("link", { name: "HTML Templates" })).not.toBeInTheDocument();
  });
});
