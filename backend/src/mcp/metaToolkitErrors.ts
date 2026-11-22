/** A Meta Toolkit call outside the external surface or refused by a guard (tool-level error). */
export class MetaToolkitRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetaToolkitRefusal';
  }
}
