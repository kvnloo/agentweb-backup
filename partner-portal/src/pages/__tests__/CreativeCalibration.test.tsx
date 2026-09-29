import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import axios from "axios";
import CreativeCalibration from "../CreativeCalibration";
import { newerOnRight } from "../../utils/calibrationSides";
import type { GoldenCaseView } from "../EvalLabelling";

jest.mock("axios", () => {
  const actual = jest.requireActual("axios");
  return { __esModule: true, default: { get: jest.fn(), put: jest.fn(), isAxiosError: actual.isAxiosError } };
});

const mockAuth = { token: "test-token", user: { isAdmin: true } };
jest.mock("../../contexts/AuthContext", () => ({
  useAuth: () => mockAuth,
}));

jest.mock("../../config", () => ({
  buildApiUrl: (path: string) => `https://api.test${path}`,
}));

const mockedAxios = jest.mocked(axios);
const AUTH = { headers: { Authorization: "Bearer test-token" } };

function pairCase(n: number, batch = "2026-W39", label?: "A" | "B" | "tie"): GoldenCaseView {
  return {
    caseId: `creative#candidatePair#new-${n}#old-${n}`,
    surface: "creative",
    taskType: "creative_pairwise",
    sourceRef: { kind: "candidateId", id: `new-${n}` },
    criteria: ["pairwise_preference"],
    labels: label ? { pairwise_preference: label } : {},
    split: "test",
    version: label ? 1 : 0,
    pair: { candidateIdB: `old-${n}`, batch, position: n, batchSize: 3, category: "ad", placement: "meta_feed_portrait", signal: "unscored" },
  } as GoldenCaseView;
}

const SINGLE: GoldenCaseView = {
  caseId: "creative#candidateId#single",
  surface: "creative",
  taskType: "creative_image",
  sourceRef: { kind: "candidateId", id: "single" },
  criteria: ["hook"],
  labels: {},
  split: "test",
  version: 0,
};

function routeGets(cases: GoldenCaseView[], provisioned = true) {
  mockedAxios.get.mockImplementation(async (url: string) => {
    if (url.endsWith("/api/admin/eval/golden-cases/status")) return { data: { provisioned } };
    if (url.endsWith("/api/admin/eval/golden-cases?surface=creative")) return { data: { cases } };
    const m = /\/api\/human-eval\/candidates\/(.+)$/.exec(url);
    if (m) return { data: { candidate: { reviewType: "creative_image", artifactUrl: `https://img.test/${m[1]}.png`, originalRequest: `request for ${m[1]}`, createdAt: "2026-09-15T10:00:00Z", feedback: [{ text: "Matt said no" }], creativeRubric: { status: "ok", passedCount: 6 } } } };
    throw new Error(`unexpected GET ${url}`);
  });
}

function renderPage(path = "/eval-labelling/calibration") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <CreativeCalibration />
    </MemoryRouter>,
  );
}

/** The A/B value the left button stands for on this pair. */
const leftIs = (c: GoldenCaseView) => (newerOnRight(c.caseId) ? "B" : "A");

describe("CreativeCalibration (ENG-2142)", () => {
  beforeEach(() => {
    mockedAxios.get.mockReset();
    mockedAxios.put.mockReset();
    mockAuth.user = { isAdmin: true };
  });

  it("renders nothing but an access message for a non-admin and makes no requests", () => {
    mockAuth.user = { isAdmin: false };
    renderPage();
    expect(screen.getByText("Admin access required")).toBeInTheDocument();
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it("says the store is not provisioned and loads no cases until OPS-2", async () => {
    routeGets([], false);
    renderPage();
    expect(await screen.findByText(/not provisioned yet \(OPS-2, ENG-2147\)/)).toBeInTheDocument();
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });

  it("opens the first unlabelled pair of the latest batch and loads both creatives with the useAuth token", async () => {
    routeGets([pairCase(0, "2026-W39", "A"), pairCase(1), pairCase(2), pairCase(0, "2026-W38"), SINGLE]);
    renderPage();
    expect(await screen.findByText("Pair 2")).toBeInTheDocument();
    expect(screen.getByText("1 / 3 pairs labelled")).toBeInTheDocument();
    await waitFor(() => expect(mockedAxios.get).toHaveBeenCalledWith("https://api.test/api/human-eval/candidates/new-1", AUTH));
    expect(mockedAxios.get).toHaveBeenCalledWith("https://api.test/api/human-eval/candidates/old-1", AUTH);
    expect(await screen.findAllByRole("img")).toHaveLength(2);
    expect(screen.getByText("request for new-1")).toBeInTheDocument();
    // No reviewer feedback, judge result or date that would say which creative is newer.
    expect(screen.queryByText(/Matt said no|passedCount|2026-09-15/)).not.toBeInTheDocument();
  });

  it("shows a landing-page pair as links to the live pages, not as images (ENG-2192)", async () => {
    mockedAxios.get.mockImplementation(async (url: string) => {
      if (url.endsWith("/api/admin/eval/golden-cases/status")) return { data: { provisioned: true } };
      if (url.endsWith("/api/admin/eval/golden-cases?surface=creative")) return { data: { cases: [pairCase(1)] } };
      const m = /\/api\/human-eval\/candidates\/(.+)$/.exec(url);
      if (m) return { data: { candidate: { reviewType: "landing_page", artifactUrl: `https://lp.test/${m[1]}`, originalRequest: `page ${m[1]}` } } };
      throw new Error(`unexpected GET ${url}`);
    });
    renderPage();

    const links = await screen.findAllByRole("link", { name: "Open landing page" });
    expect(links.map((l) => l.getAttribute("href")).sort()).toEqual(["https://lp.test/new-1", "https://lp.test/old-1"]);
    expect(links.every((l) => l.getAttribute("target") === "_blank" && l.getAttribute("rel") === "noopener noreferrer")).toBe(true);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("saves with one click as A / B through the golden-case label route and auto-advances to the next pair", async () => {
    const cases = [pairCase(0), pairCase(1), pairCase(2)];
    routeGets(cases);
    mockedAxios.put.mockImplementation(async (_url: string, body: unknown) => ({
      data: { case: { ...cases[0], labels: (body as { labels: GoldenCaseView["labels"] }).labels, version: 1 } },
    }));
    renderPage();
    expect(await screen.findByText("Pair 1")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Note (optional)"), { target: { value: "stronger hook" } });
    fireEvent.click(screen.getByRole("button", { name: "Left is better" }));

    await waitFor(() => {
      expect(mockedAxios.put).toHaveBeenCalledWith(
        `https://api.test/api/admin/eval/golden-cases/${encodeURIComponent(cases[0].caseId)}/labels`,
        { labels: { pairwise_preference: leftIs(cases[0]) }, notes: "stronger hook", expectedVersion: 0 },
        AUTH,
      );
    });
    expect(await screen.findByText("Pair 2")).toBeInTheDocument();
    expect(screen.getByText("Saved pair 1: left is better.")).toBeInTheDocument();
    expect(screen.getByText("2026-W39 · 1 / 3 pairs labelled")).toBeInTheDocument();
    expect(screen.getByLabelText("Note (optional)")).toHaveValue("");
  });

  it("records a tie and says so", async () => {
    const cases = [pairCase(0), pairCase(1)];
    routeGets(cases);
    mockedAxios.put.mockResolvedValue({ data: { case: { ...cases[0], labels: { pairwise_preference: "tie" }, version: 1 } } });
    renderPage();
    await screen.findByText("Pair 1");
    fireEvent.click(screen.getByRole("button", { name: "Tie" }));
    expect(await screen.findByText("Saved pair 1: a tie.")).toBeInTheDocument();
    expect(mockedAxios.put).toHaveBeenCalledWith(expect.any(String), { labels: { pairwise_preference: "tie" }, notes: "", expectedVersion: 0 }, AUTH);
  });

  it("locks the choices and the note while a save is in flight, so a double click saves once", async () => {
    const cases = [pairCase(0), pairCase(1)];
    routeGets(cases);
    let resolvePut: (value: unknown) => void = () => undefined;
    mockedAxios.put.mockReturnValue(new Promise((resolve) => { resolvePut = resolve; }));
    renderPage();
    await screen.findByText("Pair 1");
    fireEvent.click(screen.getByRole("button", { name: "Right is better" }));
    fireEvent.click(screen.getByRole("button", { name: "Right is better" }));

    for (const name of ["Left is better", "Tie", "Right is better"]) expect(screen.getByRole("button", { name })).toBeDisabled();
    expect(screen.getByLabelText("Note (optional)")).toBeDisabled();
    expect(mockedAxios.put).toHaveBeenCalledTimes(1);

    resolvePut({ data: { case: { ...cases[0], labels: { pairwise_preference: "B" }, version: 1 } } });
    expect(await screen.findByText("Pair 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tie" })).not.toBeDisabled();
  });

  it("drops the saved confirmation as soon as the note is edited (#3079 review)", async () => {
    const cases = [pairCase(0), pairCase(1)];
    routeGets(cases);
    mockedAxios.put.mockResolvedValue({ data: { case: { ...cases[0], labels: { pairwise_preference: "A" }, version: 1 } } });
    renderPage();
    await screen.findByText("Pair 1");
    fireEvent.click(screen.getByRole("button", { name: "Tie" }));
    expect(await screen.findByText(/Saved pair 1/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Note (optional)"), { target: { value: "hmm" } });
    expect(screen.queryByText(/Saved pair 1/)).not.toBeInTheDocument();
  });

  it("shows a saved choice when a labelled pair is reopened and saves a change against its new version", async () => {
    const cases = [pairCase(0), pairCase(1, "2026-W39", "A")];
    routeGets(cases);
    mockedAxios.put.mockResolvedValue({ data: { case: { ...cases[1], labels: { pairwise_preference: "tie" }, version: 2 } } });
    renderPage();
    await screen.findByText("Pair 1");
    fireEvent.click(screen.getByRole("button", { name: "Pair 2 (labelled)" }));
    expect(await screen.findByText("Pair 2")).toBeInTheDocument();
    const pressed = leftIs(cases[1]) === "A" ? "Left is better" : "Right is better";
    expect(screen.getByRole("button", { name: pressed })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Tie" }));
    await waitFor(() => expect(mockedAxios.put).toHaveBeenCalledWith(expect.stringContaining(encodeURIComponent(cases[1].caseId)), { labels: { pairwise_preference: "tie" }, notes: "", expectedVersion: 1 }, AUTH));
    // Pair 1 is still unlabelled, so it opens next.
    expect(await screen.findByText("Pair 1")).toBeInTheDocument();
  });

  it("stays on the last pair and says the batch is done once every pair is labelled", async () => {
    const cases = [pairCase(0, "2026-W39", "B"), pairCase(1)];
    routeGets(cases);
    mockedAxios.put.mockResolvedValue({ data: { case: { ...cases[1], labels: { pairwise_preference: "A" }, version: 1 } } });
    renderPage();
    await screen.findByText("Pair 2");
    fireEvent.click(screen.getByRole("button", { name: "Tie" }));
    expect(await screen.findByText(/All 2 pairs in 2026-W39 are labelled/)).toBeInTheDocument();
    expect(screen.getByText("Pair 2")).toBeInTheDocument();
  });

  it("explains a version conflict instead of overwriting another reviewer, and does not advance", async () => {
    routeGets([pairCase(0), pairCase(1)]);
    mockedAxios.put.mockRejectedValue(Object.assign(new Error("conflict"), { isAxiosError: true, response: { status: 409, data: { error: "version_conflict" } } }));
    renderPage();
    await screen.findByText("Pair 1");
    fireEvent.click(screen.getByRole("button", { name: "Tie" }));
    expect(await screen.findByText(/Someone saved this pair after you opened it/)).toBeInTheDocument();
    expect(screen.getByText("Pair 1")).toBeInTheDocument();
  });

  it("opens the batch named in the Slack link", async () => {
    routeGets([pairCase(0, "2026-W39"), pairCase(0, "2026-W38"), pairCase(1, "2026-W38")]);
    renderPage("/eval-labelling/calibration?batch=2026-W38");
    expect(await screen.findByText("0 / 2 pairs labelled")).toBeInTheDocument();
  });
});
