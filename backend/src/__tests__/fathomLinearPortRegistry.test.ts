/**
 * Tests for the LinearPort registry seam (ENG-259).
 *
 * The cloud webhook resolves its `LinearPort` through this registry so the production
 * adapter (ENG-536) can plug in at composition time without the webhook knowing about
 * credentials or GraphQL. Until an adapter is registered, `getFathomLinearPort()` is
 * null and the webhook reports the router as inactive rather than half-running.
 */

import {
  getFathomLinearPort,
  registerFathomLinearPort,
  _resetFathomLinearPort,
} from '../services/fathomLinearPortRegistry';
import type { LinearPort } from '../services/fathomLinearRouter';

const stubPort: LinearPort = {
  findByFathomKey: jest.fn().mockResolvedValue(null),
  searchIssues: jest.fn().mockResolvedValue([]),
  createIssue: jest.fn(),
  addComment: jest.fn(),
  relateIssues: jest.fn(),
};

describe('fathomLinearPortRegistry', () => {
  afterEach(() => _resetFathomLinearPort());

  it('returns null before any port is registered', () => {
    expect(getFathomLinearPort()).toBeNull();
  });

  it('returns the registered port', () => {
    registerFathomLinearPort(stubPort);
    expect(getFathomLinearPort()).toBe(stubPort);
  });

  it('rejects registering a second port without an explicit reset (fail loud, no silent swap)', () => {
    registerFathomLinearPort(stubPort);
    expect(() => registerFathomLinearPort({ ...stubPort })).toThrow(/already registered/i);
  });

  it('allows re-registration after a reset', () => {
    registerFathomLinearPort(stubPort);
    _resetFathomLinearPort();
    const other = { ...stubPort };
    registerFathomLinearPort(other);
    expect(getFathomLinearPort()).toBe(other);
  });
});
