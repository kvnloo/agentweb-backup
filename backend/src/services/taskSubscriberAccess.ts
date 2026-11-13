/**
 * ENG-2989: who may add or remove a task's email subscribers: the task's owner or an admin (the rule `POST /api/tasks/:taskId/subscribers`
 * always had). The delete route on the tasks router, and the add and delete routes on the auth router, only required a login, so any
 * signed-in user could add an address to (so AgentWeb would email it) or remove one from someone else's task.
 */
import { taskDb, userDb } from './db';

export type TaskSubscriberAccess = { ok: true } | { ok: false; status: 401 | 403 | 404; message: string };

export async function checkTaskSubscriberAccess(userId: string | undefined, taskId: string): Promise<TaskSubscriberAccess> {
  if (!userId) return { ok: false, status: 401, message: 'Unauthorized' };
  const task = await taskDb.getTaskById(taskId);
  if (!task) return { ok: false, status: 404, message: 'Task not found' };
  const user = await userDb.getUserById(userId);
  if (!user) return { ok: false, status: 401, message: 'User not found' };
  if (!user.isAdmin && task.userId !== userId) return { ok: false, status: 403, message: 'Access denied' };
  return { ok: true };
}
