/**
 * ENG-1217 AC9 — a confirmed model change must be auditable and undoable.
 *
 * Append-only, mirroring `llmChargeAuditDb` (ENG-1251), with one deliberate
 * difference: the sort key is `{changedAt}#{changeId}` rather than a bare id.
 * That table learned the hard way that a caller-controlled id does not sort by
 * time, so a date-range query silently missed events and it needed a GSI to
 * recover. Putting the timestamp first makes the base table range-queryable and
 * removes the index entirely.
 *
 * What is NOT stored matters as much: AC9 says "without recording prompts". The
 * record names the WORK and the MODELS, never the content.
 */

const mockPut = jest.fn();
const mockQuery = jest.fn();
const mockUpdate = jest.fn();

jest.mock("aws-sdk", () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      put: (...a: unknown[]) => ({ promise: () => mockPut(...a) }),
      query: (...a: unknown[]) => ({ promise: () => mockQuery(...a) }),
      update: (...a: unknown[]) => ({ promise: () => mockUpdate(...a) }),
    })),
  },
}));

import {
  recordModelChange,
  listModelChanges,
  markModelChangeUndone,
  MODEL_CHANGE_AUDIT_TABLE,
  type ModelChangeAuditRecord,
} from "../services/llmModelChangeAuditDb";

const record = (over: Partial<ModelChangeAuditRecord> = {}): ModelChangeAuditRecord => ({
  billingUserId: "billing-root",
  changeId: "chg-1",
  changedAt: "2026-08-15T10:00:00.000Z",
  scope: "schedule",
  scopeId: "sched-a",
  scopeLabel: "Lead list enrichment",
  modelBefore: "anthropic.claude-opus-5",
  modelAfter: "anthropic.claude-sonnet-5",
  estimatedDaysRecoveredAtDecision: 6,
  confidenceAtDecision: "high",
  confirmedByUserId: "member-a",
  undoneAt: null,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockPut.mockResolvedValue({});
  mockQuery.mockResolvedValue({ Items: [] });
  mockUpdate.mockResolvedValue({});
});

describe("recordModelChange", () => {
  it("writes a time-sortable sort key so the base table can be range-queried", () => {
    recordModelChange(record());
    const item = mockPut.mock.calls[0][0].Item;
    expect(item.sk).toBe("2026-08-15T10:00:00.000Z#chg-1");
  });

  it("stores the work and the models, and no prompt content (AC9)", async () => {
    await recordModelChange(record());
    const item = mockPut.mock.calls[0][0].Item;
    expect(item).toMatchObject({
      scope: "schedule",
      scopeId: "sched-a",
      modelBefore: "anthropic.claude-opus-5",
      modelAfter: "anthropic.claude-sonnet-5",
      estimatedDaysRecoveredAtDecision: 6,
      confirmedByUserId: "member-a",
    });
    // Nothing resembling message content may reach this table.
    expect(JSON.stringify(item)).not.toMatch(/prompt|message|content|startingMessage/i);
  });

  it("records who confirmed, not just who is billed", async () => {
    // An org member can confirm a change billed to the root. Storing only the
    // billing subject would make "who did this" unanswerable in the one table
    // that exists to answer it.
    await recordModelChange(record({ billingUserId: "billing-root", confirmedByUserId: "member-a" }));
    const item = mockPut.mock.calls[0][0].Item;
    expect(item.billingUserId).toBe("billing-root");
    expect(item.confirmedByUserId).toBe("member-a");
  });

  it("refuses to overwrite an existing change id", async () => {
    // Append-only: a retry must not silently rewrite history.
    await recordModelChange(record());
    expect(mockPut.mock.calls[0][0].ConditionExpression).toMatch(/attribute_not_exists/);
  });

  it("omits undoneAt entirely while the change stands", async () => {
    // DynamoDB counts an explicit null as a PRESENT attribute. Writing
    // `undoneAt: null` would make `attribute_not_exists(undoneAt)` false from
    // creation, so every undo would be rejected as "already undone" and the
    // feature would be silently dead. The absence is the state.
    await recordModelChange(record({ undoneAt: null }));
    expect(mockPut.mock.calls[0][0].Item).not.toHaveProperty("undoneAt");
  });

  it("keeps undoneAt when replaying an already-undone record", async () => {
    await recordModelChange(record({ undoneAt: "2026-08-16T09:00:00.000Z", undoneByUserId: "u" }));
    expect(mockPut.mock.calls[0][0].Item.undoneAt).toBe("2026-08-16T09:00:00.000Z");
  });

  it("expires the record rather than keeping it forever", async () => {
    await recordModelChange(record());
    expect(mockPut.mock.calls[0][0].Item.ttl).toBeGreaterThan(Date.now() / 1000);
  });
});

describe("listModelChanges", () => {
  it("queries the base table by time range, with no secondary index", async () => {
    await listModelChanges("billing-root", "2026-08-01", "2026-08-31");
    const params = mockQuery.mock.calls[0][0];
    expect(params.TableName).toBe(MODEL_CHANGE_AUDIT_TABLE);
    expect(params.IndexName).toBeUndefined();
    expect(params.KeyConditionExpression).toMatch(/billingUserId = :user AND sk BETWEEN/);
  });

  it("returns newest first, because undo is about what just happened", async () => {
    await listModelChanges("billing-root", "2026-08-01", "2026-08-31");
    expect(mockQuery.mock.calls[0][0].ScanIndexForward).toBe(false);
  });

  it("follows pagination rather than truncating history", async () => {
    mockQuery
      .mockResolvedValueOnce({ Items: [record()], LastEvaluatedKey: { k: 1 } })
      .mockResolvedValueOnce({ Items: [record({ changeId: "chg-2" })] });
    const out = await listModelChanges("billing-root", "2026-08-01", "2026-08-31");
    expect(out).toHaveLength(2);
  });
});

describe("markModelChangeUndone", () => {
  it("stamps the undo instead of deleting the record", async () => {
    // Append-only. Deleting would erase the fact that a change ever happened,
    // which is the opposite of an audit trail.
    await markModelChangeUndone("billing-root", "2026-08-15T10:00:00.000Z#chg-1", "member-a");
    const params = mockUpdate.mock.calls[0][0];
    expect(params.UpdateExpression).toMatch(/SET undoneAt/);
    expect(params.ExpressionAttributeValues[":by"]).toBe("member-a");
  });

  it("refuses to undo the same change twice", async () => {
    await markModelChangeUndone("billing-root", "2026-08-15T10:00:00.000Z#chg-1", "member-a");
    expect(mockUpdate.mock.calls[0][0].ConditionExpression).toMatch(/attribute_not_exists\(undoneAt\)|undoneAt = :null/);
  });
});
