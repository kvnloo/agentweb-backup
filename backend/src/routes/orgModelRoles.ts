import express from 'express';
import { orgDb, userDb } from '../services/db';
import { can } from '../services/orgAuthz';
import { MODEL_ROLES, ModelRole, ModelRoles, getRoleDefault, getRoleModelOptions, sanitizeModelRoles, invalidateModelRoles } from '../services/modelRoles';

const router = express.Router();
router.use(async (req, res, next) => {
  try {
    const userId = (req as any).user?.userId;
    if (!userId) return res.sendStatus(401);
    const user = await userDb.getUserById(userId);
    if (!user?.orgId) return res.sendStatus(404);
    const org = await orgDb.getOrgById(user.orgId);
    if (!org) return res.sendStatus(404);
    if (!can({ userId, orgId: user.orgId, orgRole: user.orgRole }, org, 'org:configure')) return res.sendStatus(403);
    res.locals.org = org;
    next();
  } catch { res.sendStatus(500); }
});

router.get('/', async (_req, res) => {
  try {
    const org = res.locals.org;
    const overrides = sanitizeModelRoles(org.modelRoles);
    const roles = await Promise.all(MODEL_ROLES.map(async role => {
      const allowedModels = getRoleModelOptions(role);
      const defaultModel = await getRoleDefault(role);
      const override = overrides[role];
      return { role, defaultModel, allowedModels, effectiveModel: override && allowedModels.includes(override) ? override : defaultModel };
    }));
    res.json({ modelRoles: overrides, revision: org.updatedAt ?? null, roles });
  } catch { res.sendStatus(500); }
});

// PUT replaces the map; omit a role (or send {}) to reset to the default.
router.put('/', async (req, res) => {
  const body = req.body;
  const map = body?.modelRoles;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return res.sendStatus(400);
  if (!Object.prototype.hasOwnProperty.call(body, 'revision')) return res.sendStatus(428);
  if (body.revision !== null && (typeof body.revision !== 'string' || !body.revision)) return res.sendStatus(400);
  for (const [role, model] of Object.entries(map)) {
    if (!MODEL_ROLES.includes(role as ModelRole) || typeof model !== 'string' || !getRoleModelOptions(role as ModelRole).includes(model)) return res.sendStatus(400);
  }
  try {
    const orgId = res.locals.org.orgId;
    const revision = await orgDb.updateModelRoles(orgId, map as ModelRoles, body.revision ?? undefined);
    invalidateModelRoles(orgId);
    return res.json({ modelRoles: map, revision });
  } catch (error: any) {
    return res.sendStatus(error?.code === 'ConditionalCheckFailedException' ? 409 : 500);
  }
});
export default router;
