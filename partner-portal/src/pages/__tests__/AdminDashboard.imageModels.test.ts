// Importing AdminDashboard pulls in ../config (Vite import.meta.env) and the
// context modules, which jest can't evaluate as-is — mock them so we can import
// the exported IMAGE_API_MODELS constant.
jest.mock("../../config", () => ({
  buildApiUrl: (path: string) => `https://api.test${path}`,
  CUSTOMER_FRONTEND_URL: "https://customer.test",
}));
jest.mock("../../contexts/AuthContext", () => ({
  useAuth: () => ({ token: "test-token", user: { isAdmin: true } }),
}));
jest.mock("../../contexts/AdminContext", () => ({
  useAdmin: () => ({}),
}));

import { IMAGE_API_MODELS } from "../AdminDashboard";

describe("AdminDashboard IMAGE_API_MODELS (admin Agent Mode image-model dropdown)", () => {
  it("offers the GA gemini-3.1-flash-image id", () => {
    expect(IMAGE_API_MODELS).toContain("gemini-3.1-flash-image");
  });

  it("retains the legacy preview id as an alias so a saved default still validates", () => {
    expect(IMAGE_API_MODELS).toContain("gemini-3.1-flash-image-preview");
  });

  it("stays in sync with the other supported image models", () => {
    expect(IMAGE_API_MODELS).toEqual([
      "gemini-3-pro-image-preview",
      "gemini-3.1-flash-image",
      "gemini-3.1-flash-image-preview",
      "gpt-image-1",
      "gpt-image-2",
      "gemini-2.5-flash-image",
    ]);
  });
});
