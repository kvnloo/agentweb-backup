/** A copy of `obj` without the named keys. */
export function omit<T extends object, K extends keyof T & string>(obj: T, keys: readonly K[]): Omit<T, K> {
  const out: Partial<T> = { ...obj };
  for (const key of keys) delete out[key];
  return out as Omit<T, K>;
}
