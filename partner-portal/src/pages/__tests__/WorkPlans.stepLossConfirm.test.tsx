/**
 * ENG-1221 follow-up: the destructive-step guard now runs at
 * `PUT /api/admin/work-plans/:planId`, the endpoint this editor calls.
 *
 * The editor always sends the WHOLE steps array, so two ordinary admin actions
 * land on the guard's refusal: renaming a step while editing its content, and
 * removing a step. Both returned 400 and dead-ended, because the server's
 * message closes by telling the caller to retry with `confirm_step_removal` —
 * a flag this page had no way to send.
 *
 * These pin the fix: a refusal becomes a decision the admin can make, and an
 * ordinary save never confirms anything on their behalf.
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
  title: "Google Pre-Launch Gate",
  description: "Gate a Google launch",
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

/** A step renamed while its content was edited — reported as `unpaired`. */
const unpairedRefusal = Object.assign(new Error("Request failed with status code 400"), {
  response: {
    status: 400,
    data: {
      message: "Refusing to update: 1 step(s) are not recognisable in what you sent.",
      stepsWouldBeRemoved: 0,
      stepContentLoss: [
        { stepCount: 2, title: "Inventory assets", fields: [], kind: "unpaired" },
      ],
    },
  },
});

/** A removed step — the shrink arm of the same guard. */
const removalRefusal = Object.assign(new Error("Request failed with status code 400"), {
  response: {
    status: 400,
    data: {
      message: "Refusing to update: this payload would take the plan from 2 steps to 1, removing 1.",
      stepsWouldBeRemoved: 1,
      removedStepTitles: ["Inventory assets"],
    },
  },
});

/** A 400 that is NOT about step loss — must stay an ordinary error. */
const plainBadRequest = Object.assign(new Error("Request failed with status code 400"), {
  response: { status: 400, data: { message: "Unrecognised steps_mode \"sideways\"." } },
});

const renderPage = async (plans: any[] = [plan]) => {
  mockedAxios.get.mockResolvedValue({ data: plans });
  render(<WorkPlans />);
  await waitFor(() => expect(screen.getByText(plan.title)).toBeInTheDocument());
};

const openEditor = async () => {
  fireEvent.click(screen.getAllByTestId("EditIcon")[0].closest("button") as HTMLElement);
  await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
};

const saveButton = () => screen.getByRole("button", { name: /^update$/i });
const saveAnyway = () => screen.getByRole("button", { name: /save anyway/i });

/** The confirmation is a second dialog over the still-open editor, and the step
 *  titles it names also appear in the editor behind it — so every assertion
 *  about its contents has to be scoped to it, not to the whole screen. */
const confirmDialog = () =>
  screen.getByText(/would lose step content/i).closest('[role="dialog"]') as HTMLElement;

beforeEach(() => {
  jest.clearAllMocks();
});

describe("WorkPlans turns a step-loss refusal into a decision (ENG-1221)", () => {
  it("offers a confirmation instead of a dead-end error", async () => {
    await renderPage();
    await openEditor();
    mockedAxios.put.mockRejectedValue(unpairedRefusal);

    fireEvent.click(saveButton());

    await waitFor(() => expect(screen.getByText(/would lose step content/i)).toBeInTheDocument());
    expect(saveAnyway()).toBeInTheDocument();
  });

  it("names the step and explains an unpaired loss in the admin's terms", async () => {
    await renderPage();
    await openEditor();
    mockedAxios.put.mockRejectedValue(unpairedRefusal);

    fireEvent.click(saveButton());

    await waitFor(() => expect(screen.getByText(/would lose step content/i)).toBeInTheDocument());
    expect(within(confirmDialog()).getByText(/Inventory assets/)).toBeInTheDocument();
    // "unpaired" is the wire word; the admin needs the reason, not the token.
    expect(within(confirmDialog()).getByText(/not recognisable in what you are saving/i)).toBeInTheDocument();
  });

  it("lists the steps a removal would drop", async () => {
    await renderPage();
    await openEditor();
    mockedAxios.put.mockRejectedValue(removalRefusal);

    fireEvent.click(saveButton());

    await waitFor(() => expect(screen.getByText(/would be removed/i)).toBeInTheDocument());
    expect(within(confirmDialog()).getByText("Inventory assets")).toBeInTheDocument();
  });

  it("retries with confirm_step_removal once the admin says save anyway", async () => {
    await renderPage();
    await openEditor();
    mockedAxios.put.mockRejectedValueOnce(removalRefusal).mockResolvedValueOnce({ data: {} });

    fireEvent.click(saveButton());
    await waitFor(() => expect(saveAnyway()).toBeInTheDocument());
    fireEvent.click(saveAnyway());

    await waitFor(() => expect(mockedAxios.put).toHaveBeenCalledTimes(2));
    expect(mockedAxios.put.mock.calls[1][1]).toEqual(
      expect.objectContaining({ confirm_step_removal: true, expectedStepsRev: "rev-1" }),
    );
  });

  it("never confirms on an ordinary save", async () => {
    // The Save button used to read `onClick={handleSave}`, which hands React's
    // MouseEvent to the first parameter. A truthy event would have confirmed
    // every destructive save silently — the opposite of the guard's purpose.
    await renderPage();
    await openEditor();
    mockedAxios.put.mockResolvedValue({ data: {} });

    fireEvent.click(saveButton());

    await waitFor(() => expect(mockedAxios.put).toHaveBeenCalled());
    expect(mockedAxios.put.mock.calls[0][1]).not.toHaveProperty("confirm_step_removal");
  });

  it("leaves a 400 that is not about step loss as a plain error", async () => {
    await renderPage();
    await openEditor();
    mockedAxios.put.mockRejectedValue(plainBadRequest);

    fireEvent.click(saveButton());

    await waitFor(() => expect(screen.getByText(/Unrecognised steps_mode/)).toBeInTheDocument());
    expect(screen.queryByText(/save anyway/i)).not.toBeInTheDocument();
  });

  it("does not report a refused save as saved", async () => {
    await renderPage();
    await openEditor();
    mockedAxios.put.mockRejectedValue(unpairedRefusal);

    fireEvent.click(saveButton());

    await waitFor(() => expect(mockedAxios.put).toHaveBeenCalled());
    expect(screen.queryByText(/work plan updated/i)).not.toBeInTheDocument();
  });
});
