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

  it('states that REMOVE is supported behind a confirmation', () => {
    // Was "NO REMOVE … use status=PAUSED". Both halves are now known wrong: REMOVE is the
    // only working retire path, and PAUSED is not a conversion-action status at all.
    expect(matrix()).toMatch(/REMOVE \(conversion_action_resource_name, confirm_conversion_action_removal\)/);
    expect(matrix()).toMatch(/Ask the user before setting the flag/);
  });

  it('warns that counting_type is never inferred', () => {
    expect(matrix()).toMatch(/counting_type is REQUIRED and never inferred/);
  });
});

describe('the tool stops recommending an impossible action (ENG-1329 e2e)', () => {
  const tool: any = emmaToolRegistry.getTool('call_google_ads_api');
  const text = `${tool.definition?.description ?? ''}`;
  const props = () => tool.definition.inputSchema.properties;

  it('no longer offers HIDDEN in the status enum', () => {
    // Rejected by Google on BOTH create and update — offering it invites a guaranteed error.
    expect(props().status.enum).not.toContain('HIDDEN');
  });

  it('exposes the removal confirmation flag', () => {
    expect(props().confirm_conversion_action_removal).toBeDefined();
    expect(props().confirm_conversion_action_removal.type).toBe('boolean');
  });

  it('lists REMOVE as a supported CONVERSION_ACTION operation', () => {
    expect(text).toMatch(/REMOVE \(conversion_action_resource_name, confirm_conversion_action_removal\)/);
  });

  it('tells the model not to suggest HIDDEN', () => {
    expect(text).toMatch(/HIDDEN cannot be set through the API at all/);
    expect(text).toMatch(/Do not suggest it/);
  });

  it('describes removal accurately rather than as data loss', () => {
    expect(text).toMatch(/conversions already recorded stay in reporting/i);
    expect(text).not.toMatch(/severs historical attribution/);
  });
});

describe('the matrix describes the corrected status model (ENG-1329 e2e)', () => {
  // Replaces three earlier blocks that asserted HIDDEN was the retire path. The real
  // account rejected HIDDEN on create AND update, so those tests were pinning a belief,
  // not a behaviour — and they passed the whole time because mocks agree with you.
  const tool: any = emmaToolRegistry.getTool('call_google_ads_api');
  const text = `${tool.definition?.description ?? ''}`;

  it('says a conversion action has no PAUSED status', () => {
    expect(text).toMatch(/NO PAUSED status/);
  });

  it('says it is always created ENABLED', () => {
    expect(text).toMatch(/always created ENABLED/);
  });

  it('no longer offers PAUSED or HIDDEN as the way to stop an action', () => {
    expect(text).not.toMatch(/UPDATE it with status=PAUSED/);
    expect(text).not.toMatch(/UPDATE it to HIDDEN/);
  });

  it('names REMOVE plus its confirmation flag as the retire path', () => {
    expect(text).toMatch(/CONVERSION_ACTION REMOVE with confirm_conversion_action_removal=true/);
  });
});
