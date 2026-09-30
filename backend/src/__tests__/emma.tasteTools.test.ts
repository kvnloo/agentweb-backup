jest.mock('../services/tasteProfileService', () => {
  const actual = jest.requireActual('../services/tasteProfileService');
  return {
    ...actual,
    tasteProfileService: {
      getProfile: jest.fn(),
      getApplication: jest.fn(),
      getSettings: jest.fn(),
      updateSettings: jest.fn(),
      importXBookmarks: jest.fn(),
    },
  };
});

import { emmaToolRegistry } from '../emma/registry';
import { tasteProfileService } from '../services/tasteProfileService';
import '../emma/tasteTools';

describe('Emma Taste tools', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('registers read, preview, and explicit refresh tools with the right capability flags', () => {
    const profile = emmaToolRegistry.getTool('get_taste_profile');
    const preview = emmaToolRegistry.getTool('preview_taste_application');
    const settings = emmaToolRegistry.getTool('get_taste_settings');
    const updateSettings = emmaToolRegistry.getTool('update_taste_settings');
    const refresh = emmaToolRegistry.getTool('refresh_taste_from_x');

    expect(profile).toBeDefined();
    expect(profile?.readOnly).toBe(true);
    expect(profile?.requiresUserAccount).toBe(true);

    expect(preview).toBeDefined();
    expect(preview?.readOnly).toBe(true);
    expect(preview?.requiresUserAccount).toBe(true);

    expect(settings?.readOnly).toBe(true);
    expect(settings?.requiresUserAccount).toBe(true);
    expect(updateSettings?.readOnly).not.toBe(true);
    expect(updateSettings?.requiresUserAccount).toBe(true);

    expect(refresh).toBeDefined();
    expect(refresh?.readOnly).not.toBe(true);
    expect(refresh?.requiresUserAccount).toBe(true);
  });

  it('reads only the authenticated user profile', async () => {
    (tasteProfileService.getProfile as jest.Mock).mockResolvedValue({
      schema: 'taste.profile.v1',
      sourceCount: 1,
    });
    const tool = emmaToolRegistry.getTool('get_taste_profile');
    if (!tool) throw new Error('get_taste_profile not registered');

    await tool.execute({}, { userId: 'user-123' });

    expect(tasteProfileService.getProfile).toHaveBeenCalledWith('user-123');
  });

  it('previews a task-local surface and intensity without mutating Taste', async () => {
    (tasteProfileService.getApplication as jest.Mock).mockResolvedValue({
      schema: 'taste.application.v1',
      surface: 'landing_page',
      intensity: 'strong',
      active: true,
    });
    const tool = emmaToolRegistry.getTool('preview_taste_application');
    if (!tool) throw new Error('preview_taste_application not registered');

    await tool.execute(
      { surface: 'landing_page', intensity: 'strong' },
      { userId: 'user-123' }
    );

    expect(tasteProfileService.getApplication)
      .toHaveBeenCalledWith('user-123', 'landing_page', 'strong');
  });


  it('separates durable defaults from task-local preview overrides', async () => {
    (tasteProfileService.getSettings as jest.Mock).mockResolvedValue({
      schema: 'taste.settings.v1',
      surfaces: { social: 'subtle' },
    });
    (tasteProfileService.updateSettings as jest.Mock).mockResolvedValue({
      schema: 'taste.settings.v1',
      surfaces: { social: 'strong' },
    });

    const readTool = emmaToolRegistry.getTool('get_taste_settings');
    const updateTool = emmaToolRegistry.getTool('update_taste_settings');
    if (!readTool || !updateTool) throw new Error('Taste settings tools not registered');

    await readTool.execute({}, { userId: 'user-123' });
    await updateTool.execute({ surfaces: { social: 'strong' } }, { userId: 'user-123' });

    expect(tasteProfileService.getSettings).toHaveBeenCalledWith('user-123');
    expect(tasteProfileService.updateSettings)
      .toHaveBeenCalledWith('user-123', { social: 'strong' });
  });

  it('refreshes X Taste only through an existing connected-account id', async () => {
    (tasteProfileService.importXBookmarks as jest.Mock).mockResolvedValue({
      schema: 'taste.profile.v1',
      sourceCount: 1,
    });
    const tool = emmaToolRegistry.getTool('refresh_taste_from_x');
    if (!tool) throw new Error('refresh_taste_from_x not registered');

    await tool.execute({ account_id: 'x-account-1' }, { userId: 'user-123' });

    expect(tasteProfileService.importXBookmarks)
      .toHaveBeenCalledWith('user-123', 'x-account-1');
  });

  it('never asks for or exposes credential fields in the X refresh schema', () => {
    const tool = emmaToolRegistry.getTool('refresh_taste_from_x');
    const props = tool?.definition?.inputSchema?.properties || {};

    expect(Object.keys(props)).toEqual(['account_id']);
    expect(props.access_token).toBeUndefined();
    expect(props.refresh_token).toBeUndefined();
    expect(props.password).toBeUndefined();
  });
});
