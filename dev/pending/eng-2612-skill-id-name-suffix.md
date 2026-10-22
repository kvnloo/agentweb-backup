## ENG-2612: install_skills recovers UUID from "<uuid>- Skill Name" ids (2026-10-22)

Models copied the catalog display line as the skill id (10+ prod invalid_args rows since 2026-09-22). `normalizeSkillIdArg` strips the name suffix only after a full UUID; entitlement lookup is unchanged.
