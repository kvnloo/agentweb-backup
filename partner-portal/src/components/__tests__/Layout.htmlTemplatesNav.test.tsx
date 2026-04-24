/// <reference path="../../types/assets.d.ts" />

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Layout from "../Layout";

const mockUseAuth = jest.fn();

jest.mock("../../contexts/AuthContext", () => ({
  useAuth: () => mockUseAuth(),
}));

jest.mock("../../assets/logo.svg", () => "logo.svg");
jest.mock("../ChatSupport", () => () => <div>ChatSupport</div>);

describe("Layout html templates navigation", () => {
  it("shows HTML Templates nav button for admin users with correct href", () => {
    mockUseAuth.mockReturnValue({
      user: { isAdmin: true },
      logout: jest.fn(),
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

    const htmlTemplatesLink = screen.getByRole("link", { name: "HTML Templates" });
    expect(htmlTemplatesLink).toBeInTheDocument();
    expect(htmlTemplatesLink).toHaveAttribute("href", "/html-templates");
  });

  it("does not show HTML Templates nav button for non-admin users", () => {
    mockUseAuth.mockReturnValue({
      user: { isAdmin: false },
      logout: jest.fn(),
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
