/**
 * readUserForOwnership: read the base table (not the lagging UserIdIndex) for
 * decisions that depend on a write this process just made.
 */

const getUserById = jest.fn();
const getUserByIdConsistent = jest.fn();
jest.mock("../services/db", () => ({
  userDb: {
    getUserById: (...a: unknown[]) => getUserById(...a),
    getUserByIdConsistent: (...a: unknown[]) => getUserByIdConsistent(...a),
  },
}));

import { readUserForOwnership } from "../utils/readUserForOwnership";

beforeEach(() => {
  getUserById.mockReset();
  getUserByIdConsistent.mockReset();
});

describe("readUserForOwnership", () => {
  it("returns the consistent row and never the stale index row", async () => {
    getUserById.mockResolvedValue({ userId: "u1", adImageRunId: "previous" });
    getUserByIdConsistent.mockResolvedValue({ userId: "u1", adImageRunId: "current" });
    await expect(readUserForOwnership("u1")).resolves.toEqual({ userId: "u1", adImageRunId: "current" });
    expect(getUserById).not.toHaveBeenCalled();
  });

  it("falls back to the index read, and says so, when the consistent read throws", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    getUserByIdConsistent.mockRejectedValue(new Error("throttled"));
    getUserById.mockResolvedValue({ userId: "u1" });
    await expect(readUserForOwnership("u1")).resolves.toEqual({ userId: "u1" });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("consistent read failed"),
      expect.objectContaining({ userId: "u1", err: "throttled" }),
    );
    warn.mockRestore();
  });

  it("falls back to the index read when the consistent read finds nothing", async () => {
    getUserByIdConsistent.mockResolvedValue(undefined);
    getUserById.mockResolvedValue(undefined);
    await expect(readUserForOwnership("gone")).resolves.toBeUndefined();
    expect(getUserById).toHaveBeenCalledWith("gone");
  });
});
