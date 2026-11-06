/**
 * In-memory SlackStartStore for route tests. It mirrors the DynamoDB
 * conditions pinned in slackStartStore.test.ts (transactional intake + domain
 * lock, exactly-once stamps, lease claims, bounded counters) and yields to the
 * event loop on every call so concurrent requests genuinely interleave.
 */
import type { DomainLock, IntakeRecord, SlackStartStore } from '../../services/slackStart/slackStartStore';

const tick = () => new Promise((r) => setImmediate(r));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

export interface FakeSlackStartStore extends SlackStartStore {
  intakes: Map<string, IntakeRecord>;
  locks: Map<string, DomainLock>;
  counters: Map<string, number>;
}

export function createFakeSlackStartStore(): FakeSlackStartStore {
  const intakes = new Map<string, IntakeRecord>();
  const locks = new Map<string, DomainLock>();
  const counters = new Map<string, number>();
  return {
    intakes,
    locks,
    counters,
    async createIntake(intake, lock) {
      await tick();
      if (intakes.has(intake.intakeId) || locks.has(lock.domain)) {
        return { created: false, lock: locks.has(lock.domain) ? clone(locks.get(lock.domain)!) : null };
      }
      intakes.set(intake.intakeId, clone(intake));
      locks.set(lock.domain, clone(lock));
      return { created: true };
    },
    async getDomainLock(domain) {
      await tick();
      return locks.has(domain) ? clone(locks.get(domain)!) : null;
    },
    async getIntake(id) {
      await tick();
      return intakes.has(id) ? clone(intakes.get(id)!) : null;
    },
    async updateIntake(id, set, condition) {
      await tick();
      const item = intakes.get(id) as any;
      if (!item) return false;
      if (condition?.ifNotExists && item[condition.ifNotExists] !== undefined) return false;
      if (condition?.ifLeaseFree) {
        const cur = item[condition.ifLeaseFree.attr];
        if (cur !== undefined && !(cur < condition.ifLeaseFree.now)) return false;
      }
      for (const [path, value] of Object.entries(set)) {
        const parts = path.split('.');
        let target = item;
        for (const p of parts.slice(0, -1)) target = target[p];
        target[parts[parts.length - 1]] = clone(value);
      }
      return true;
    },
    async consumeRate(scope, keyHash, max, windowMs, now) {
      await tick();
      const key = `${scope}#${keyHash}#${Math.floor(now.getTime() / windowMs)}`;
      const count = counters.get(key) ?? 0;
      if (count >= max) return false;
      counters.set(key, count + 1);
      return true;
    },
  };
}
