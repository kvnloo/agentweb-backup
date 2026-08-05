/**
 * ENG-890: the Work Plans editor saves by replacing the whole steps array with
 * whatever the dialog loaded. Emma edits these same plans through
 * manage_predefined_work_plan, so a save built from a row this page loaded
 * minutes ago could silently put the old steps back.
 *
 * The backend refuses a write whose staked steps_rev no longer matches. These
 * tests pin the two halves the portal owns: it has to send the revision it
 * loaded, and it has to handle the refusal without throwing the admin's edits
 * away.
 */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import axios from "axios";
import WorkPlans from "../WorkPlans";

jest.mock("axios");

jest.mock("../../contexts/AuthContext", () => ({
  useAuth: () => ({ token: "mock-token" }),
}));

jest.mock("../../config", () => ({
  buildApiUrl: (endpoint: string) => endpoint,
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;

const plan = {
  planId: "wp-1",
  title: "Meta Pre-Launch Gate",
  description: "Gate a Meta launch",
  welcomeMessage: "Hi",
  steps: [
    { stepCount: 1, title: "Scope the launch", description: "scope" },
    { stepCount: 2, title: "Inventory assets", description: "inventory" },
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

const conflict = Object.assign(new Error("Request failed with status code 409"), {
  response: { status: 409, data: { message: "Work plan changed since it was read — re-read it and retry" } },
});

const renderPage = async (plans: any[] = [plan]) => {
  mockedAxios.get.mockResolvedValue({ data: plans });
  render(<WorkPlans />);
  await waitFor(() => expect(screen.getByText(plan.title)).toBeInTheDocument());
};

/** The row actions are icon-only buttons, so reach them via the MUI icon.
 *  fireEvent rather than userEvent deliberately: these are plain clicks, and
 *  userEvent's pointer simulation made this suite slow enough to push other
 *  suites past their timeouts in a parallel run. */
const openEditor = async () => {
  fireEvent.click(screen.getAllByTestId("EditIcon")[0].closest("button") as HTMLElement);
  await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
};

/** The dialog's confirm button reads "Update" when editing an existing plan. */
const saveButton = () => screen.getByRole("button", { name: /^update$/i });

beforeEach(() => {
  jest.clearAllMocks();
});

describe("WorkPlans editor stakes the plan it loaded", () => {
  it("sends the loaded steps_rev with the save", async () => {
    await renderPage();
    await openEditor();
    mockedAxios.put.mockResolvedValue({ data: {} });

    fireEvent.click(saveButton());

    await waitFor(() => expect(mockedAxios.put).toHaveBeenCalled());
    expect(mockedAxios.put.mock.calls[0][1]).toEqual(
      expect.objectContaining({ expectedStepsRev: "rev-1" }),
    );
  });

  it("stakes null for a plan that predates the revision field", async () => {
    const { steps_rev, ...legacy } = plan;
    await renderPage([legacy]);
    await openEditor();
    mockedAxios.put.mockResolvedValue({ data: {} });

    fireEvent.click(saveButton());

    // Not omitted: absent would mean "do not check", which is exactly the
    // unguarded overwrite this is meant to stop.
    await waitFor(() => expect(mockedAxios.put).toHaveBeenCalled());
    expect(mockedAxios.put.mock.calls[0][1]).toHaveProperty("expectedStepsRev", null);
  });

  it("keeps the dialog open on a conflict so the admin's edits survive", async () => {
    await renderPage();
    await openEditor();
    mockedAxios.put.mockRejectedValue(conflict);

    fireEvent.click(saveButton());

    await waitFor(() => expect(screen.getByText(/changed while you were editing/i)).toBeInTheDocument());
    // Closing here would discard the work while leaving the outdated plan on
    // screen — the admin would have nothing to copy their changes from.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("does not report a conflicted save as saved", async () => {
    await renderPage();
    await openEditor();
    mockedAxios.put.mockRejectedValue(conflict);

    fireEvent.click(saveButton());

    await waitFor(() => expect(mockedAxios.put).toHaveBeenCalled());
    expect(screen.queryByText(/work plan updated/i)).not.toBeInTheDocument();
  });
});
