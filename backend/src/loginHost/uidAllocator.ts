/**
 * ENG-2110 PR 1a: numeric uid allocation from a reserved range (no /etc/passwd entries, outside
 * /etc/subuid). A uid is handed to an owner ("attempt:<ref>" or a connectionId) and returns to the
 * pool only through free(), which the manager calls after the process tree is dead, the home is
 * wiped and a residue scan finds nothing left in shared temp locations.
 */
import type { HostState } from "./stateStore";
import { HostError } from "./protocol";

export class UidAllocator {
  constructor(private readonly state: () => HostState, private readonly min: number, private readonly max: number) {
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1000 || max < min) throw new Error("uid range invalid (min >= 1000, max >= min)");
  }

  allocate(owner: string): number {
    const owners = this.state().uidOwners;
    for (let uid = this.min; uid <= this.max; uid++) {
      if (owners[String(uid)] === undefined) {
        owners[String(uid)] = owner;
        return uid;
      }
    }
    throw new HostError("EBUSY", "uid_range_exhausted");
  }

  ownerOf(uid: number): string | undefined {
    return this.state().uidOwners[String(uid)];
  }

  /** Move a uid from one owner to another (attempt -> connection at promote). */
  transfer(uid: number, from: string, to: string): void {
    const owners = this.state().uidOwners;
    if (owners[String(uid)] !== from) throw new HostError("EINTERNAL", "uid_owner_mismatch");
    owners[String(uid)] = to;
  }

  /** Frees `uid` only if `owner` still owns it: a late or repeated cleanup must never free a uid that was re-allocated. */
  free(uid: number, owner: string): boolean {
    const owners = this.state().uidOwners;
    if (owners[String(uid)] !== owner) return false;
    delete owners[String(uid)];
    return true;
  }

  inUseCount(): number {
    return Object.keys(this.state().uidOwners).length;
  }
}
