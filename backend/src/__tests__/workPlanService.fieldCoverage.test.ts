/**
 * Guard: every WorkPlan field must be accounted for by updateWorkPlan.
 *
 * updateWorkPlan used to be a whole-item put, so it persisted whatever was on
 * the object and adding a field to the interface was enough. It is now
 * attribute-scoped (so it cannot clobber the thumbnail — ENG-889), which means
 * a field added to WorkPlan but not to one of the lists below would simply stop
 * being saved: a silent drop, the exact defect class this issue is about.
 *
 * This reads the source rather than exercising behaviour on purpose — the whole
 * point is to fail when someone adds a field and forgets, which no behavioural
 * test can catch for a field that does not exist yet. Same approach as
 * sdkConstructionGuard.test.ts.
 */
import fs from 'fs';
import path from 'path';

const SOURCE = fs.readFileSync(
  path.join(__dirname, '../services/workPlanService.ts'),
  'utf8',
);

const listNamed = (name: string): string[] => {
  const start = SOURCE.indexOf(`const ${name}`);
  expect(start).toBeGreaterThan(-1);
  const block = SOURCE.slice(start, SOURCE.indexOf(']', start));
  return Array.from(block.matchAll(/'(\w+)'/g)).map((m) => m[1]);
};

describe('updateWorkPlan field coverage', () => {
  it('accounts for every field on the WorkPlan interface', () => {
    const iface = SOURCE.slice(
      SOURCE.indexOf('export interface WorkPlan {'),
      SOURCE.indexOf('/** Owned exclusively by updateThumbnail'),
    );
    const fields = Array.from(iface.matchAll(/^ {2}(\w+)\??:/gm)).map((m) => m[1]);

    // planId is the key; updatedAt is always stamped by the writer.
    const accounted = new Set([
      ...listNamed('REQUIRED_PLAN_FIELDS'),
      ...listNamed('OPTIONAL_PLAN_FIELDS'),
      ...listNamed('THUMBNAIL_FIELDS'),
      'planId',
      'updatedAt',
    ]);

    const unaccounted = fields.filter((f) => !accounted.has(f));
    expect(unaccounted).toEqual([]);
    // Sanity: the scrape found a realistic number of fields, so a refactor that
    // breaks the regex fails loudly instead of vacuously passing.
    expect(fields.length).toBeGreaterThan(15);
  });

  it('keeps every thumbnail attribute out of the plan-field lists', () => {
    const thumbnail = listNamed('THUMBNAIL_FIELDS');
    const planFields = [...listNamed('REQUIRED_PLAN_FIELDS'), ...listNamed('OPTIONAL_PLAN_FIELDS')];

    for (const field of thumbnail) {
      expect(planFields).not.toContain(field);
    }
    expect(thumbnail).toContain('thumbnail_rev');
  });
});
