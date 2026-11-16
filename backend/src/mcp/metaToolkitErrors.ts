/** A Meta Toolkit call outside the external surface or refused by a guard (tool-level error). */
export class MetaToolkitRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetaToolkitRefusal';
  }
}

/** A refusal because the caller named an object outside the selected ad account (HTTP 403, not 400). */
export class MetaToolkitForbidden extends MetaToolkitRefusal {
  readonly forbidden = true;
  constructor(message: string) {
    super(message);
    this.name = 'MetaToolkitForbidden';
  }
}
