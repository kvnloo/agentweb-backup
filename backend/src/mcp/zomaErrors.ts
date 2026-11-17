/** Zoma "a step is missing" refusal; the toolkits turn it into a readable MetaToolkitRefusal. */
export class ZomaNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZomaNotReadyError';
  }
}
