/**
 * ENG-2187 (CodeRabbit #3137, thread 4129947899): pure placement-field helper for
 * `AgentModeService.generateImage`, extracted out of the agentModeService.ts monolith.
 */
import { declaredPlacementField } from '../services/agentMode/generateImagePlacement';

describe('declaredPlacementField', () => {
  it('includes a recognized placement', () => {
    expect(declaredPlacementField('meta_feed_square')).toEqual({ placement: 'meta_feed_square' });
    expect(declaredPlacementField('meta_story_reel')).toEqual({ placement: 'meta_story_reel' });
  });

  it('drops an unrecognized value instead of passing it on ungated', () => {
    expect(declaredPlacementField('tiktok_feed')).toEqual({});
    expect(declaredPlacementField('')).toEqual({});
  });

  it('is empty when nothing was declared', () => {
    expect(declaredPlacementField(undefined)).toEqual({});
  });
});
