/**
 * ENG-1525 — re-applying a Google Ads tag must not delete the label that makes it work.
 *
 * `POST /generated/:id/google-ads` with an id and no label is explicitly permitted (the
 * route downgrades it to a warning, because the base tag CAN be installed before the
 * conversion action exists). That request used to take the falsy branch here and REMOVE
 * `googleAdsConversionLabel` and `googleAdsCustomerId` — from this record and, via the
 * route's sibling loop, every page on the site.
 *
 * The base tag survives that, so RULE 7.5 keeps passing and the page still looks
 * configured, while `buildTrackingHelper` — which fires only when id AND label are both
 * present — goes silent. A conversion pair destroyed behind an HTTP 200.
 *
 * The distinction these tests pin: `undefined` means "the caller did not mention this
 * field", `""` means "the caller asked to clear it". They are different requests.
 */

const mockDynamoInstance = {
  put: jest.fn().mockReturnValue({ promise: () => Promise.resolve() }),
  get: jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) }),
  update: jest.fn().mockReturnValue({ promise: () => Promise.resolve() }),
  delete: jest.fn().mockReturnValue({ promise: () => Promise.resolve() }),
  query: jest.fn().mockReturnValue({ promise: () => Promise.resolve({ Items: [] }) }),
  scan: jest.fn().mockReturnValue({ promise: () => Promise.resolve({ Items: [] }) }),
};

jest.mock("aws-sdk", () => ({
  __esModule: true,
  default: {
    DynamoDB: { DocumentClient: jest.fn().mockImplementation(() => mockDynamoInstance) },
    S3: jest.fn().mockImplementation(() => ({})),
    SecretsManager: jest.fn().mockImplementation(() => ({
      getSecretValue: jest.fn().mockReturnValue({
        promise: () => Promise.resolve({ SecretString: '{"token":"gh-token","org":"AgentWebPro"}' }),
      }),
    })),
    config: { update: jest.fn() },
  },
  S3: jest.fn().mockImplementation(() => ({})),
}));

jest.mock("../utils/secretsManager", () => ({
  getVercelToken: jest.fn().mockResolvedValue("t"),
  getGitHubOrgToken: jest.fn().mockResolvedValue({ token: "gh", org: "AgentWebPro" }),
}));

import { updateLandingPageGoogleAds } from "../services/v0Service";

const AW = "AW-18192751758";
const LABEL = "qAnwCOLmx-McEI65_eJD";
const PAGE = { id: "page-1", userId: "user-1", googleAdsConversionId: AW, googleAdsConversionLabel: LABEL };

/** The function reads the record back first; give it one. */
function seedRecord() {
  mockDynamoInstance.get.mockReturnValue({ promise: () => Promise.resolve({ Item: PAGE }) });
  mockDynamoInstance.query.mockReturnValue({ promise: () => Promise.resolve({ Items: [PAGE] }) });
}

function lastUpdate() {
  const calls = mockDynamoInstance.update.mock.calls;
  return calls[calls.length - 1][0] as { UpdateExpression: string };
}

beforeEach(() => {
  jest.clearAllMocks();
  seedRecord();
});

describe("ENG-1525 — an omitted field is not a request to delete it", () => {
  // The exact call the ticket is about.
  it("does NOT remove the label when re-applying the id alone", async () => {
    await updateLandingPageGoogleAds("page-1", "user-1", AW);
    const expr = lastUpdate().UpdateExpression;
    expect(expr).not.toMatch(/REMOVE[\s\S]*googleAdsConversionLabel/);
    expect(expr).not.toMatch(/REMOVE[\s\S]*googleAdsCustomerId/);
    expect(expr).toMatch(/SET[\s\S]*googleAdsConversionId/);
  });

  it("still writes a label that WAS supplied", async () => {
    await updateLandingPageGoogleAds("page-1", "user-1", AW, LABEL, "2883029950");
    const expr = lastUpdate().UpdateExpression;
    expect(expr).toMatch(/googleAdsConversionLabel = :lbl/);
    expect(expr).toMatch(/googleAdsCustomerId = :cust/);
    expect(expr).not.toMatch(/REMOVE/);
  });

  // Clearing must remain possible — the fix must not make the field write-once.
  it("removes the label when it is explicitly cleared with an empty string", async () => {
    await updateLandingPageGoogleAds("page-1", "user-1", AW, "", "");
    const expr = lastUpdate().UpdateExpression;
    expect(expr).toMatch(/REMOVE[\s\S]*googleAdsConversionLabel/);
    expect(expr).toMatch(/REMOVE[\s\S]*googleAdsCustomerId/);
  });

  it("treats the two fields independently", async () => {
    await updateLandingPageGoogleAds("page-1", "user-1", AW, LABEL);
    const expr = lastUpdate().UpdateExpression;
    expect(expr).toMatch(/googleAdsConversionLabel = :lbl/);
    expect(expr).not.toMatch(/REMOVE/);
  });

  // Clearing the id is a different operation and keeps its all-three semantics: an id-less
  // record has nothing for a label or customer id to belong to.
  it("still clears all three when the conversion id itself is removed", async () => {
    await updateLandingPageGoogleAds("page-1", "user-1", "");
    const expr = lastUpdate().UpdateExpression;
    expect(expr).toMatch(/REMOVE googleAdsConversionId, googleAdsConversionLabel, googleAdsCustomerId/);
  });
});
