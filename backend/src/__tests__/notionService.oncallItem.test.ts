// createOncallItem was removed in ENG-6 (the Notion oncall fallback was deleted — intake now
// routes unconditionally to Linear/Featurebase). Only getSprintTasksDatabaseId remains here.

// Mock secretsManager (getSprintTasksDatabaseId reads Notion credentials)
jest.mock('../utils/secretsManager', () => ({
  getSecret: jest.fn().mockResolvedValue(JSON.stringify({
    apiToken: 'test-notion-token',
    userGuidePageId: 'test-page-id',
  })),
}));

import { getSprintTasksDatabaseId } from '../services/notionService';

describe('notionService - getSprintTasksDatabaseId', () => {
  it('should return default database ID when not in credentials', async () => {
    const dbId = await getSprintTasksDatabaseId();
    expect(dbId).toBe('2bf09247-c951-812a-bd0a-000bd4c05bbf');
  });
});
