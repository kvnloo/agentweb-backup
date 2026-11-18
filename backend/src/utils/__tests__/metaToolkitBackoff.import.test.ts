/**
 * ENG-3018: metaToolkitBackoff installs its interceptors on the default axios
 * client at module load. Twenty suites mock axios with a factory that has no
 * `interceptors`, and every one of them failed to load because that install
 * threw. Importing the module must never throw; a real client must still get
 * the interceptors.
 */
const load = () => {
  let mod: typeof import('../metaToolkitBackoff') | undefined;
  jest.isolateModules(() => { mod = require('../metaToolkitBackoff'); });
  return mod!;
};

describe('metaToolkitBackoff module load (ENG-3018)', () => {
  afterEach(() => { jest.dontMock('axios'); jest.resetModules(); });

  it('loads when axios is mocked with a factory that has no interceptors', () => {
    jest.doMock('axios', () => ({ get: jest.fn(), post: jest.fn() }));
    expect(load).not.toThrow();
  });

  it('loads when the mocked default export has no interceptors', () => {
    jest.doMock('axios', () => ({ __esModule: true, default: { get: jest.fn() } }));
    expect(load).not.toThrow();
  });

  it('loads when the mocked default export is a bare jest.fn', () => {
    jest.doMock('axios', () => ({ __esModule: true, default: jest.fn() }));
    expect(load).not.toThrow();
  });

  it('still exports a usable toolkit context under a mocked axios', async () => {
    jest.doMock('axios', () => ({ get: jest.fn() }));
    const mod = load();
    expect(await mod.withMetaToolkitBackoff(false, undefined, async () => 'ok')).toBe('ok');
  });

  it('installs request and response interceptors on the real default client', () => {
    const count = (manager: any) => manager.handlers.filter(Boolean).length;
    let before = { request: 0, response: 0 };
    let after = { request: 0, response: 0 };
    jest.isolateModules(() => {
      const axios = require('axios').default;
      before = { request: count(axios.interceptors.request), response: count(axios.interceptors.response) };
      require('../metaToolkitBackoff');
      after = { request: count(axios.interceptors.request), response: count(axios.interceptors.response) };
    });
    expect(after).toEqual({ request: before.request + 1, response: before.response + 1 });
  });

  it('attachMetaToolkitBackoff still throws on a client without interceptors, so a broken explicit client is not silent', () => {
    const { attachMetaToolkitBackoff } = load();
    expect(() => attachMetaToolkitBackoff({} as any)).toThrow();
  });
});
