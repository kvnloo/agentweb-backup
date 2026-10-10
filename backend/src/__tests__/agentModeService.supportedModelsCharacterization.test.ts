import * as fs from 'fs';
import * as path from 'path';
import { AgentModeService } from '../services/agentModeService';

// ENG-1778 AC1/AC3: characterization of getSupportedModelsWithMetadata() BEFORE
// the llmModels literal is migrated to AW-ModelRegistry. The fixture pins the
// full current output (every field, every model, admin and non-admin) so the
// registry read path must reproduce it byte-for-byte for every pre-migration id.
//
// Only regenerate deliberately, when the roster itself is meant to change:
//   UPDATE_MODEL_CHARACTERIZATION=1 npx jest agentModeService.supportedModelsCharacterization
// A diff in this fixture during the registry migration is a regression, not a
// fixture to refresh.

jest.mock('../services/db', () => ({
  getSession: jest.fn(),
  saveMessage: jest.fn(),
  updateSession: jest.fn(),
  getTask: jest.fn(),
  getTaskExecution: jest.fn(),
  getUserById: jest.fn(),
}));
jest.mock('../services/chatbotService');
jest.mock('../services/settingsService');
jest.mock('../utils/secretsManager');

const FIXTURE_PATH = path.join(__dirname, '__fixtures__', 'supportedModelsWithMetadata.eng-1778.json');

function serialize(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

describe('getSupportedModelsWithMetadata characterization (ENG-1778)', () => {
  let actual: { admin: unknown; nonAdmin: unknown };

  beforeAll(async () => {
    const service = new AgentModeService();
    actual = {
      admin: await service.getSupportedModelsWithMetadata(true),
      nonAdmin: await service.getSupportedModelsWithMetadata(false),
    };
    if (process.env.UPDATE_MODEL_CHARACTERIZATION === '1') {
      fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
      fs.writeFileSync(FIXTURE_PATH, serialize(actual));
    }
  });

  it('matches the committed fixture byte-for-byte (admin and non-admin)', () => {
    const expected = fs.readFileSync(FIXTURE_PATH, 'utf8');
    expect(serialize(actual)).toBe(expected);
  });

  it('fixture is a non-empty roster for both audiences', () => {
    const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
    expect(Array.isArray(fixture.admin)).toBe(true);
    expect(Array.isArray(fixture.nonAdmin)).toBe(true);
    expect(fixture.nonAdmin.length).toBeGreaterThan(0);
    expect(fixture.admin.length).toBeGreaterThanOrEqual(fixture.nonAdmin.length);
  });
});
