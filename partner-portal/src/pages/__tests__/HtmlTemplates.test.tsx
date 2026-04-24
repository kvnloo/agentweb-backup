import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axios from "axios";
import HtmlTemplates from "../HtmlTemplates";

jest.mock("axios");

jest.mock("../../contexts/AuthContext", () => ({
  useAuth: () => ({ token: "mock-token" }),
}));

jest.mock("../../config", () => ({
  buildApiUrl: (endpoint: string) => endpoint,
}));

let mockBuildPreviewSrcDoc: jest.Mock;
let mockGetPreviewBaseHref: jest.Mock;

jest.mock("../../utils/templatePreview", () => ({
  buildPreviewSrcDoc: (...args: unknown[]) => mockBuildPreviewSrcDoc(...args),
  getPreviewBaseHref: () => mockGetPreviewBaseHref(),
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;

const templateA = {
  template_id: "tpl-a",
  template_name: "Welcome Email",
  type: ["email"],
  subject: "Hi {{user_name}}",
  html_content: "<p>{{user_name}}</p>",
  variables: ["user_name"],
  arrayVariables: [],
  isPublic: true,
  updated_at: "2026-04-24T10:00:00.000Z",
};

const templateB = {
  template_id: "tpl-b",
  template_name: "Landing Hero",
  type: ["landing_page"],
  subject: "",
  html_content: "<section>{{headline}}</section>",
  variables: ["headline"],
  arrayVariables: [],
  isPublic: true,
  updated_at: "2026-04-24T11:00:00.000Z",
};

describe("HtmlTemplates page", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBuildPreviewSrcDoc = jest.fn(
      (_template?: unknown, _options?: unknown) => "<!doctype html><html><body>preview</body></html>"
    );
    mockGetPreviewBaseHref = jest.fn(() => "http://localhost/");
    mockedAxios.get.mockResolvedValue({ data: { templates: [templateA, templateB] } });
    mockedAxios.post.mockResolvedValue({ data: { success: true } });
    mockedAxios.delete.mockResolvedValue({ data: { success: true } });
  });

  it("fetches public templates on mount with auth header and renders rows", async () => {
    render(<HtmlTemplates />);

    await waitFor(() => {
      expect(mockedAxios.get).toHaveBeenCalledWith("/api/html-templates?scope=public", {
        headers: { Authorization: "Bearer mock-token" },
      });
    });

    expect(await screen.findByText("Welcome Email")).toBeInTheDocument();
    expect(screen.getByText("Landing Hero")).toBeInTheDocument();
  });

  it("filters templates by search text", async () => {
    const user = userEvent.setup();
    render(<HtmlTemplates />);

    await screen.findByText("Welcome Email");

    await user.type(screen.getByPlaceholderText("Search templates…"), "landing");

    expect(screen.queryByText("Welcome Email")).not.toBeInTheDocument();
    expect(screen.getByText("Landing Hero")).toBeInTheDocument();
  });

  it("opens preview dialog and renders iframe preview", async () => {
    const user = userEvent.setup();
    render(<HtmlTemplates />);

    await screen.findByText("Welcome Email");

    const previewButtons = screen.getAllByTestId("VisibilityIcon");
    await user.click(previewButtons[0].closest("button") as HTMLButtonElement);

    expect(await screen.findByText("Welcome Email — Preview")).toBeInTheDocument();
    expect(screen.getByTitle("Template Preview")).toBeInTheDocument();
    expect(mockGetPreviewBaseHref).toHaveBeenCalled();
    expect(mockBuildPreviewSrcDoc).toHaveBeenCalledWith(
      { html_content: "<p>{{user_name}}</p>" },
      { baseHref: "http://localhost/" }
    );
  });

  it("creates a template with extracted variables and refetches", async () => {
    const user = userEvent.setup();
    render(<HtmlTemplates />);

    await screen.findByText("Welcome Email");

    await user.click(screen.getByRole("button", { name: "New Template" }));
    expect(await screen.findByText("New Public Template")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Template Name *"), "Digest Template");
    fireEvent.change(screen.getByLabelText("Subject *"), {
      target: { value: "Summary {{user_name}}" },
    });
    fireEvent.change(screen.getByPlaceholderText("Enter HTML with variables like {{user_name}}, {{company_name}}…"), {
      target: { value: "<div>{{user_name}}</div><div>{{items_n}}</div><div>{{items_1_name}}</div>" },
    });

    await user.click(screen.getByRole("button", { name: "Create Template" }));

    await waitFor(() => expect(mockedAxios.post).toHaveBeenCalledTimes(1));
    expect(mockedAxios.post).toHaveBeenCalledWith(
      "/api/html-templates",
      expect.objectContaining({
        template_name: "Digest Template",
        subject: "Summary {{user_name}}",
        type: ["email"],
        isPublic: true,
        variables: expect.arrayContaining(["user_name"]),
        arrayVariables: expect.arrayContaining(["items_n"]),
      }),
      { headers: { Authorization: "Bearer mock-token" } }
    );
    expect(mockedAxios.get).toHaveBeenCalledTimes(2);
  });

  it("edits a template and sends template_id in payload", async () => {
    const user = userEvent.setup();
    render(<HtmlTemplates />);

    await screen.findByText("Welcome Email");

    const editButtons = screen.getAllByTestId("EditIcon");
    await user.click(editButtons[0].closest("button") as HTMLButtonElement);

    expect(await screen.findByText("Edit Public Template")).toBeInTheDocument();
    const nameInput = screen.getByLabelText("Template Name *");
    await user.clear(nameInput);
    await user.type(nameInput, "Welcome Email Updated");

    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(mockedAxios.post).toHaveBeenCalledTimes(1));
    expect(mockedAxios.post).toHaveBeenCalledWith(
      "/api/html-templates",
      expect.objectContaining({
        template_id: "tpl-a",
        template_name: "Welcome Email Updated",
        isPublic: true,
      }),
      { headers: { Authorization: "Bearer mock-token" } }
    );
  });

  it("deletes a template using public delete endpoint and refetches", async () => {
    const user = userEvent.setup();
    render(<HtmlTemplates />);

    await screen.findByText("Welcome Email");

    const row = screen.getByText("Welcome Email").closest("tr") as HTMLTableRowElement;
    const deleteIcon = within(row).getByTestId("DeleteIcon");
    await user.click(deleteIcon.closest("button") as HTMLButtonElement);

    expect(await screen.findByText("Delete Template")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Delete$/ }));

    await waitFor(() =>
      expect(mockedAxios.delete).toHaveBeenCalledWith(
        "/api/html-templates/tpl-a?isPublic=true",
        { headers: { Authorization: "Bearer mock-token" } }
      )
    );
    expect(mockedAxios.get).toHaveBeenCalledTimes(2);
  });
});
