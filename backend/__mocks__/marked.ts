// Jest manual mock for 'marked' (ESM-only package, not compatible with Jest's CJS mode)
export const marked = (text: string): string => text;
