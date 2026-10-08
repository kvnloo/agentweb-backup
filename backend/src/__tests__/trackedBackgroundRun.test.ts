import { trackBackgroundRun } from "../utils/trackedBackgroundRun";
import { cronJobRegistry } from "../utils/cronJobRegistry";

describe("trackBackgroundRun", () => {
  it("registers the run so graceful shutdown waits for it", async () => {
    let resolve!: () => void;
    const run = new Promise<void>((r) => (resolve = r));
    trackBackgroundRun("test-run", run);
    expect(cronJobRegistry.size()).toBe(1);
    resolve();
    await run;
    await new Promise((r) => setImmediate(r));
    expect(cronJobRegistry.size()).toBe(0);
  });

  it("logs a crashed run instead of swallowing it, and does not throw", async () => {
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const boom = new Error("boom");
    trackBackgroundRun("test-crash", Promise.reject(boom));
    await new Promise((r) => setImmediate(r));
    expect(errSpy).toHaveBeenCalledWith("[test-crash] background run crashed", boom);
    errSpy.mockRestore();
  });

  it("tolerates a launcher that returned no promise instead of throwing into its caller", () => {
    expect(() => trackBackgroundRun("test-undefined", undefined as unknown as Promise<unknown>)).not.toThrow();
  });
});
