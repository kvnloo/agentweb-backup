/**
 * ENG-2193 (ENG-2128 B): `runContentChecksForCandidate` — the I/O wiring around
 * `creativeContentChecks.ts`. Every collaborator is mocked at the module boundary so this file
 * tests only the orchestration: the flag gate, the bounded downloads, and how their results feed
 * `runCreativeContentChecks` / `humanEvalService.appendCreativeGateChecks`.
 */
import axios from 'axios';
import { runContentChecksForCandidate } from '../services/creativeContentCheckRunner';
import { humanEvalService } from '../services/humanEvalService';
import { getPersistedBrandLogoUrl, resolveBrandGuidelinesForUser } from '../services/agentMode/brandLogo';
import { buildBrandProfile, runCreativeContentChecks } from '../services/creativeContentChecks';

jest.mock('../services/humanEvalService', () => ({
  humanEvalService: { appendCreativeGateChecks: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../services/agentMode/brandLogo', () => ({
  resolveBrandGuidelinesForUser: jest.fn(),
  getPersistedBrandLogoUrl: jest.fn(),
}));
jest.mock('../services/creativeContentChecks', () => ({
  buildBrandProfile: jest.fn().mockReturnValue({ colours: [], vocabulary: [] }),
  runCreativeContentChecks: jest.fn().mockResolvedValue([{ id: 'spelling', status: 'pass' }]),
}));

const mockedResolveBrand = resolveBrandGuidelinesForUser as jest.MockedFunction<typeof resolveBrandGuidelinesForUser>;
const mockedGetLogoUrl = getPersistedBrandLogoUrl as jest.MockedFunction<typeof getPersistedBrandLogoUrl>;
const mockedBuildBrandProfile = buildBrandProfile as jest.MockedFunction<typeof buildBrandProfile>;
const mockedRunChecks = runCreativeContentChecks as jest.MockedFunction<typeof runCreativeContentChecks>;
const mockedAppend = humanEvalService.appendCreativeGateChecks as jest.MockedFunction<
  typeof humanEvalService.appendCreativeGateChecks
>;

const ORIGINAL_ENV = process.env.CREATIVE_CONTENT_CHECKS_ENABLED;

function fakePng(): Buffer {
  // Content doesn't matter — sharp().metadata() is invoked on it, but this suite doesn't
  // assert on width/height, only on the wiring, so an undecodable buffer is fine (metadata()
  // rejects and the runner's own `.catch(() => undefined)` degrades width/height to undefined).
  return Buffer.from('fake-bytes');
}

describe('runContentChecksForCandidate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CREATIVE_CONTENT_CHECKS_ENABLED = 'true';
    mockedResolveBrand.mockResolvedValue(null);
    mockedGetLogoUrl.mockReturnValue(null);
  });

  afterAll(() => {
    process.env.CREATIVE_CONTENT_CHECKS_ENABLED = ORIGINAL_ENV;
  });

  it('is inert when the flag is not "true"', async () => {
    process.env.CREATIVE_CONTENT_CHECKS_ENABLED = 'false';
    jest.spyOn(axios, 'get');

    await runContentChecksForCandidate({ candidateId: 'cand-1', artifactUrl: 'https://cdn.example/x.png' });

    expect(axios.get).not.toHaveBeenCalled();
    expect(mockedAppend).not.toHaveBeenCalled();
  });

  it('is inert when the flag is unset', async () => {
    delete process.env.CREATIVE_CONTENT_CHECKS_ENABLED;
    await runContentChecksForCandidate({ candidateId: 'cand-1', artifactUrl: 'https://cdn.example/x.png' });
    expect(mockedAppend).not.toHaveBeenCalled();
  });

  it('no-ops when there is no artifact URL', async () => {
    await runContentChecksForCandidate({ candidateId: 'cand-1' });
    expect(mockedAppend).not.toHaveBeenCalled();
  });

  it('no-ops (never calls appendCreativeGateChecks) when the artifact download fails', async () => {
    jest.spyOn(axios, 'get').mockRejectedValue(new Error('ETIMEDOUT'));
    await runContentChecksForCandidate({ candidateId: 'cand-1', artifactUrl: 'https://cdn.example/x.png' });
    expect(mockedAppend).not.toHaveBeenCalled();
  });

  it('happy path: downloads the artifact and logo, runs the checks, and appends the result', async () => {
    jest
      .spyOn(axios, 'get')
      .mockResolvedValueOnce({ data: fakePng() }) // artifact
      .mockResolvedValueOnce({ data: fakePng() }); // logo
    mockedResolveBrand.mockResolvedValue({ brandData: { primaryColor: '#ff0000' } });
    mockedGetLogoUrl.mockReturnValue('https://cdn.example/logo.png');

    await runContentChecksForCandidate({
      candidateId: 'cand-1',
      artifactUrl: 'https://cdn.example/x.png',
      userId: 'user-1',
      adCopyText: 'Shop now',
    });

    expect(resolveBrandGuidelinesForUser).toHaveBeenCalledWith('user-1');
    expect(mockedBuildBrandProfile).toHaveBeenCalledWith({ primaryColor: '#ff0000' });
    expect(mockedRunChecks).toHaveBeenCalledWith(
      expect.objectContaining({
        adCopyText: 'Shop now',
        brand: { colours: [], vocabulary: [] },
        logoBuffer: expect.any(Buffer),
      }),
    );
    expect(mockedAppend).toHaveBeenCalledWith('cand-1', [{ id: 'spelling', status: 'pass' }]);
  });

  it('runs without a logo when the account has none on file (logoBuffer undefined)', async () => {
    jest.spyOn(axios, 'get').mockResolvedValueOnce({ data: fakePng() });
    mockedGetLogoUrl.mockReturnValue(null);

    await runContentChecksForCandidate({ candidateId: 'cand-1', artifactUrl: 'https://cdn.example/x.png' });

    expect(axios.get).toHaveBeenCalledTimes(1); // artifact only, no logo fetch
    expect(mockedRunChecks).toHaveBeenCalledWith(expect.objectContaining({ logoBuffer: undefined }));
    expect(mockedAppend).toHaveBeenCalled();
  });

  it('never throws — a failure inside runCreativeContentChecks is swallowed', async () => {
    jest.spyOn(axios, 'get').mockResolvedValueOnce({ data: fakePng() });
    mockedRunChecks.mockRejectedValueOnce(new Error('boom'));

    await expect(
      runContentChecksForCandidate({ candidateId: 'cand-1', artifactUrl: 'https://cdn.example/x.png' }),
    ).resolves.toBeUndefined();
    expect(mockedAppend).not.toHaveBeenCalled();
  });
});
