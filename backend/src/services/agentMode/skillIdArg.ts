const SKILL_ID_WITH_NAME_SUFFIX = /^\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*-\s+\S.*$/is;

/**
 * ENG-2612: strip a trailing "- <Skill Name>" the model copied from the catalog listing.
 * Only a full UUID followed by "- <text>" is rewritten, so the result is exactly the id the
 * model meant; entitlement is still decided by the normal lookup on that bare UUID.
 */
export function normalizeSkillIdArg(id: string): string {
  const m = SKILL_ID_WITH_NAME_SUFFIX.exec(id);
  return m ? m[1] : id;
}
