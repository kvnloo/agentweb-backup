/**
 * `updateUser` skips fields set to `undefined` and REMOVEs fields set to
 * `null`, so a start patch's `<axis>Error: undefined` never cleared the
 * previous failure's message: a later successful run kept showing the old
 * error text beside `ready`. Claims write the REMOVE form of the clear.
 */
export function withClearedError<T extends object>(patch: T, errorKey: string): T {
  return { ...patch, [errorKey]: null } as T;
}
