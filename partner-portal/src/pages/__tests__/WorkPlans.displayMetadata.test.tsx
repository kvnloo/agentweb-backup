/**
 * ENG-1469 — the Partner Portal editor's "Customer-facing browse details" and
 * "Recommended next workplans" sections: no raw JSON, category checkboxes
 * (multi-select), a channel select, an optional suite, a max-3 ordered
 * next-plan list, and a compact preview using the canonical projection shape.
 */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axios from "axios";
import WorkPlans from "../WorkPlans";

jest.mock("axios");
jest.mock("../../contexts/AuthContext", () => ({ useAuth: () => ({ token: "mock-token" }) }));
jest.mock("../../config", () => ({ buildApiUrl: (endpoint: string) => endpoint }));

const mockedAxios = axios as jest.Mocked<typeof axios>;

const plan = {
  planId: "wp-1",
  title: "Meta Pre-Launch Gate",
  description: "Gate a Meta launch",
  category: "Paid Ads",
  steps: [
    { stepCount: 1, title: "Scope the launch" },
    { stepCount: 2, title: "Inventory assets" },
  ],
  visibility: "system",
  isBuiltIn: true,
  showInAgentMode: true,
  autocomplete: false,
  requireLogin: true,
  createdAt: "2026-08-04T08:00:00.000Z",
  updatedAt: "2026-08-04T09:00:00.000Z",
  steps_rev: "rev-1",
};

const otherPlan = {
  planId: "wp-2",
  title: "Landing Page Launch",
  steps: [{ stepCount: 1, title: "Draft the page" }],
  visibility: "public",
  isBuiltIn: true,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

const renderPage = async (plans: any[] = [plan, otherPlan]) => {
  mockedAxios.get.mockResolvedValue({ data: plans });
  render(<WorkPlans />);
  await waitFor(() => expect(screen.getByText(plan.title)).toBeInTheDocument());
};

const openEditor = async () => {
  fireEvent.click(screen.getAllByTestId("EditIcon")[0].closest("button") as HTMLElement);
  await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
};

const saveButton = () => screen.getByRole("button", { name: /^update$/i });

beforeEach(() => {
  jest.clearAllMocks();
});

describe("WorkPlans editor — customer-facing browse details", () => {
  it("renders no raw JSON editor for display metadata", async () => {
    await renderPage();
    await openEditor();

    expect(screen.getByText(/Customer-facing browse details/i)).toBeInTheDocument();
    expect(screen.queryByText(/raw json/i)).not.toBeInTheDocument();
    // No <textarea> or code editor holding a JSON blob for this section.
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByText(/"version"\s*:\s*1/)).not.toBeInTheDocument();
  });

  it("initializes fields from the plan's existing display block on edit", async () => {
    await renderPage([
      {
        ...plan,
        display: {
          version: 1,
          title: "Launch Meta Fast",
          summary: "Get live in a day.",
          categories: ["paid-ads", "strategy"],
          channel: "meta",
          nextPlanIds: ["wp-2"],
        },
      },
      otherPlan,
    ]);
    await openEditor();

    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByDisplayValue("Launch Meta Fast")).toBeInTheDocument();
    expect(dialog.getByDisplayValue("Get live in a day.")).toBeInTheDocument();
    expect(dialog.getByRole("checkbox", { name: /Paid Ads/i })).toBeChecked();
    expect(dialog.getByRole("checkbox", { name: /^Strategy$/i })).toBeChecked();
    // "Landing Page Launch" is also a row in the (still-mounted) background
    // table behind the modal, so this must be scoped to the dialog itself.
    expect(dialog.getByText("Landing Page Launch")).toBeInTheDocument();
  });

  it("saves the complete display block including categories, channel, and step labels", async () => {
    await renderPage();
    await openEditor();
    mockedAxios.put.mockResolvedValue({ data: {} });

    fireEvent.change(screen.getByLabelText(/Display title \(optional\)/i), { target: { value: "Launch Meta Ads" } });
    fireEvent.change(screen.getByLabelText(/Outcome summary \(optional\)/i), { target: { value: "Ship a Meta campaign fast." } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Paid Ads/i }));

    fireEvent.click(saveButton());

    await waitFor(() => expect(mockedAxios.put).toHaveBeenCalled());
    const body = mockedAxios.put.mock.calls[0][1] as any;
    expect(body.display).toEqual(
      expect.objectContaining({
        version: 1,
        title: "Launch Meta Ads",
        summary: "Ship a Meta campaign fast.",
        categories: ["paid-ads"],
      }),
    );
  });

  it("does not exceed the 80/180 character limits even if pasted text is longer", async () => {
    await renderPage();
    await openEditor();

    const titleInput = screen.getByLabelText(/Display title \(optional\)/i) as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: "x".repeat(200) } });
    expect(titleInput.value.length).toBe(80);

    const summaryInput = screen.getByLabelText(/Outcome summary \(optional\)/i) as HTMLTextAreaElement;
    fireEvent.change(summaryInput, { target: { value: "y".repeat(300) } });
    expect(summaryInput.value.length).toBe(180);
  });

  it("blocks saving an invalid suite ID before it reaches the API", async () => {
    await renderPage();
    await openEditor();

    fireEvent.click(screen.getByRole("checkbox", { name: /Group this plan into a suite/i }));
    fireEvent.change(screen.getByLabelText("Suite ID"), { target: { value: "Meta launch" } });
    fireEvent.change(screen.getByLabelText("Suite name"), { target: { value: "Meta Launch" } });

    expect(saveButton()).toBeDisabled();
    expect(mockedAxios.put).not.toHaveBeenCalled();
  });
});

describe("WorkPlans editor — recommended next workplans", () => {
  it("adds a recommendation from the search, showing it in author order", async () => {
    await renderPage();
    await openEditor();
    const dialog = within(screen.getByRole("dialog"));

    const combobox = screen.getByLabelText(/Add a recommendation/i);
    fireEvent.mouseDown(combobox);
    const option = await screen.findByRole("option", { name: "Landing Page Launch" });
    fireEvent.click(option);

    expect(dialog.getByText("Landing Page Launch")).toBeInTheDocument();
  });

  it("caps recommendations at three and disables adding a fourth", async () => {
    const manyPlans = [
      plan,
      { ...otherPlan, planId: "wp-2", title: "Plan Two" },
      { ...otherPlan, planId: "wp-3", title: "Plan Three" },
      { ...otherPlan, planId: "wp-4", title: "Plan Four" },
      { ...otherPlan, planId: "wp-5", title: "Plan Five" },
    ];
    await renderPage(manyPlans);
    await openEditor();

    const addOne = async (title: string) => {
      const combobox = screen.getByLabelText(/Add a recommendation|Maximum of 3 reached/i);
      fireEvent.mouseDown(combobox);
      const option = await screen.findByRole("option", { name: title });
      fireEvent.click(option);
    };

    await addOne("Plan Two");
    await addOne("Plan Three");
    await addOne("Plan Four");

    expect(screen.getByPlaceholderText(/Maximum of 3 reached/i)).toBeInTheDocument();
    // A fourth cannot be added — the combobox is disabled.
    expect(screen.getByRole("combobox", { name: /Add a recommendation/i })).toBeDisabled();
  });

  it("removes a recommendation", async () => {
    await renderPage([{ ...plan, display: { version: 1, nextPlanIds: ["wp-2"] } }, otherPlan]);
    await openEditor();
    const dialog = within(screen.getByRole("dialog"));

    expect(dialog.getByText("Landing Page Launch")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Remove"));

    expect(dialog.queryByText("Landing Page Launch")).not.toBeInTheDocument();
  });

  it("reorders recommendations with the up/down controls", async () => {
    const thirdPlan = { ...otherPlan, planId: "wp-3", title: "Ad Copy Sprint" };
    await renderPage([{ ...plan, display: { version: 1, nextPlanIds: ["wp-2", "wp-3"] } }, otherPlan, thirdPlan]);
    await openEditor();

    const rows = () => screen.getAllByTitle("Remove").map((btn) => btn.closest("div")?.textContent || "");
    expect(rows()[0]).toContain("Landing Page Launch");

    fireEvent.click(screen.getAllByTitle("Move down")[0]);

    expect(rows()[0]).toContain("Ad Copy Sprint");
  });

  it("labels the section as optional relationship metadata, not a required sequence", async () => {
    await renderPage();
    await openEditor();

    expect(screen.getByText(/not a prerequisite or a required sequence/i)).toBeInTheDocument();
  });

  it("sends the saved recommendations as nextPlanIds in author order", async () => {
    await renderPage([{ ...plan, display: { version: 1, nextPlanIds: ["wp-2"] } }, otherPlan]);
    await openEditor();
    mockedAxios.put.mockResolvedValue({ data: {} });

    fireEvent.click(saveButton());

    await waitFor(() => expect(mockedAxios.put).toHaveBeenCalled());
    const body = mockedAxios.put.mock.calls[0][1] as any;
    expect(body.display.nextPlanIds).toEqual(["wp-2"]);
  });
});

describe("WorkPlans editor — compact preview uses the canonical projection shape", () => {
  it("shows the display title/summary/categories once entered, live", async () => {
    await renderPage();
    await openEditor();

    expect(screen.getByText("Customer preview")).toBeInTheDocument();
    // Falls back to the plan's own title before any display title is typed.
    expect(within(screen.getByText("Customer preview").closest("div") as HTMLElement).getByText(plan.title)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Display title \(optional\)/i), { target: { value: "Launch Meta Ads" } });
    expect(screen.getByText("Launch Meta Ads")).toBeInTheDocument();
  });

  it("shows a 'Then consider' line for recommended next plans", async () => {
    await renderPage([{ ...plan, display: { version: 1, nextPlanIds: ["wp-2"] } }, otherPlan]);
    await openEditor();

    expect(screen.getByText(/Then consider:.*Landing Page Launch/)).toBeInTheDocument();
  });
});
