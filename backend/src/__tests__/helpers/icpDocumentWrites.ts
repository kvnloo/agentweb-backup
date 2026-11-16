/**
 * Test double for `userDb.updateUser(userId, {}, { pathSets, pathRemoves, condition })` as the persona routes call it
 * (`writeIcpCard`, ENG-2551 follow-ups): applies the document-path writes to a copy of the stored user and returns the
 * updated user, the way DynamoDB's `ReturnValues: ALL_NEW` does. The condition is NOT evaluated here; tests read it from
 * the call to assert which card the write was pinned to.
 */
export interface DocumentWriteOptions {
  pathSets?: Array<{ path: Array<string | number>; value: unknown }>;
  pathRemoves?: Array<{ path: Array<string | number> }>;
  condition?: { expression: string; names?: Record<string, string>; values?: Record<string, unknown> };
}

export function applyDocumentWrites(user: Record<string, any>, options: DocumentWriteOptions | undefined): Record<string, any> {
  const next = JSON.parse(JSON.stringify(user));
  for (const { path, value } of options?.pathSets ?? []) {
    let node = next;
    path.slice(0, -1).forEach((key, i) => {
      if (node[key] === undefined) node[key] = typeof path[i + 1] === 'number' ? [] : {};
      node = node[key];
    });
    node[path[path.length - 1]] = value;
  }
  for (const { path } of options?.pathRemoves ?? []) {
    let node = next;
    for (const key of path.slice(0, -1)) node = node?.[key];
    const last = path[path.length - 1];
    if (Array.isArray(node) && typeof last === 'number') node.splice(last, 1);
    else if (node) delete node[last];
  }
  return next;
}

/** `userDb.updateUser` fake over one stored user: each write is applied to what the previous write left. */
export function documentWriteFake(initial: Record<string, any>): { updateUser: jest.Mock; current: () => Record<string, any> } {
  let stored = initial;
  const updateUser = jest.fn(async (_userId: string, _patch: unknown, options?: DocumentWriteOptions) => {
    stored = applyDocumentWrites(stored, options);
    return stored;
  });
  return { updateUser, current: () => stored };
}
