/**
 * ENG-1322 — the tool SCHEMA is what Emma can actually pass.
 *
 * Greptile caught this and it was a showstopper: CONVERSION_ACTION was added to the
 * entity enum and documented in the ACTION MATRIX, but the argument properties were
 * never added to `inputSchema.properties`. The handler read `args.counting_type`,
 * which a schema-driven caller could never supply, so every CREATE would have been
 * refused for a missing counting_type that the model had no way to send.
 *
 * Service-level tests could not catch it — they call the service directly and never
 * go through the schema. These do.
 */
import '../emma/tools';
import { emmaToolRegistry } from '../emma/registry';

// tools.ts registers into the shared registry as a side effect; importing it for
// that effect is how the real runtime gets these definitions too.
const tool: any = emmaToolRegistry.getTool('call_google_ads_api');
const props = () => tool.definition.inputSchema.properties;

describe('call_google_ads_api exposes CONVERSION_ACTION', () => {
  it('is registered at all', () => {
    expect(tool).toBeTruthy();
  });

  it('offers CONVERSION_ACTION as an entity type', () => {
    expect(props().entity_type.enum).toContain('CONVERSION_ACTION');
  });

  it.each([
    'category',
    'counting_type',
    'primary_for_goal',
    'click_through_lookback_window_days',
    'conversion_action_resource_name',
  ])('accepts %s, which the handler reads', (field) => {
    expect(props()[field]).toBeDefined();
  });

  it('constrains counting_type to the two values Google accepts', () => {
    expect(props().counting_type.enum.sort()).toEqual(['MANY_PER_CLICK', 'ONE_PER_CLICK']);
  });

  it('tells the model to ask rather than guess the counting type', () => {
    // The whole safety argument rests on the model not defaulting this. If the
    // description stops saying so, the guard is one confident guess from useless.
    const description = props().counting_type.description as string;
    expect(description).toMatch(/never guess|ask the user/i);
  });

  it('already had a status property for the PAUSED path', () => {
    // UPDATE status=PAUSED is the supported alternative to REMOVE, so this has to
    // be reachable from the schema too.
    expect(props().status.enum).toEqual(expect.arrayContaining(['ENABLED', 'PAUSED']));
  });
});

describe('the action matrix documents the entity for the model', () => {
  const matrix = () => tool.definition.description as string;

  it('lists CONVERSION_ACTION with its supported actions', () => {
    expect(matrix()).toMatch(/CONVERSION_ACTION\s*→\s*LIST, CREATE/);
  });

  it('states that REMOVE is unsupported and names the alternative', () => {
    expect(matrix()).toMatch(/NO REMOVE/);
    expect(matrix()).toMatch(/status=PAUSED/);
  });

  it('warns that counting_type is never inferred', () => {
    expect(matrix()).toMatch(/counting_type is REQUIRED and never inferred/);
  });
});

describe('the tool matrix warns off PAUSED (ENG-1329 e2e)', () => {
  // The model will reach for PAUSED — every other Google Ads entity uses it. The schema
  // cannot enumerate `status` (it is shared across entities, and campaigns really do
  // pause), so the matrix text is the only place this can be said.
  const tool: any = emmaToolRegistry.getTool('call_google_ads_api');
  const text = `${tool.definition?.description ?? ''}`;

  it('states that a conversion action has no PAUSED', () => {
    expect(text).toMatch(/NO PAUSED|no PAUSED/);
  });

  it('names the three real values', () => {
    expect(text).toContain('ENABLED, REMOVED or HIDDEN');
  });

  it('points at HIDDEN as the alternative, and warns REMOVED is permanent', () => {
    expect(text).toMatch(/use HIDDEN/i);
    expect(text).toMatch(/REMOVED is permanent/i);
  });

  it('no longer tells the caller to stop an action with status=PAUSED', () => {
    // The REMOVE-refusal advice said exactly that. It would have walked every agent
    // straight into the 400 this ticket exists to prevent.
    // Checks what is RECOMMENDED, not every mention — the text now names PAUSED in order
    // to warn against it, which is the point.
    expect(text).not.toMatch(/UPDATE it with status=PAUSED/);
    expect(text).toMatch(/UPDATE it with status=HIDDEN/);
  });
});
