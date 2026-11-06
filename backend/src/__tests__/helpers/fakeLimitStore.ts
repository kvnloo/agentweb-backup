import type { LimitStore } from '../../services/voice/limitStore';

/**
 * In-memory LimitStore with the same semantics as the DynamoDB one. Each method is synchronous inside
 * its body, so concurrent callers interleave only at the awaits, like single conditional writes would.
 */
export class FakeLimitStore implements LimitStore {
  readonly counters = new Map<string, number>();
  readonly counterExpiresAtS = new Map<string, number>();
  readonly claims = new Map<string, { token: string; expiresAtS: number }>();
  readonly keysTouched: string[] = [];
  failNext: Error | null = null;
  /** When set, every operation on a key starting with this prefix throws it (the other keys work), e.g. `hlc#phone#` to fail only the reservation. */
  failKeyPrefix: { prefix: string; error: Error } | null = null;

  private touch(key: string): void {
    this.keysTouched.push(key);
    if (this.failKeyPrefix && key.startsWith(this.failKeyPrefix.prefix)) throw this.failKeyPrefix.error;
    if (this.failNext) { const err = this.failNext; this.failNext = null; throw err; }
  }

  async incrementBelow(key: string, cap: number, expiresAtS: number): Promise<boolean> {
    if (!(cap >= 1)) return false; // like the real store: nothing admitted, no write
    this.touch(key);
    const n = this.counters.get(key) ?? 0;
    if (n >= cap) return false;
    this.counters.set(key, n + 1);
    this.counterExpiresAtS.set(key, expiresAtS);
    return true;
  }

  async read(key: string): Promise<number> {
    this.touch(key);
    return this.counters.get(key) ?? 0;
  }

  async decrement(key: string): Promise<void> {
    this.touch(key);
    const n = this.counters.get(key) ?? 0;
    if (n > 0) this.counters.set(key, n - 1);
  }

  async claim(key: string, token: string, expiresAtS: number, nowS: number): Promise<boolean> {
    this.touch(key);
    const held = this.claims.get(key);
    if (held && held.expiresAtS > nowS) return false;
    this.claims.set(key, { token, expiresAtS });
    return true;
  }

  async holder(key: string, nowS: number): Promise<string | null> {
    this.touch(key);
    const held = this.claims.get(key);
    return held && held.expiresAtS > nowS ? held.token : null;
  }

  async release(key: string, token: string): Promise<void> {
    this.touch(key);
    if (this.claims.get(key)?.token === token) this.claims.delete(key);
  }
}
