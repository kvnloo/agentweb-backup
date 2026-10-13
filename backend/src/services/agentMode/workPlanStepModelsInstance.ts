/** Process-wide ENG-2378 switch reader (one cache, one answer for write routes, launches, the engine and GET /model-options). */
import { settingsService } from '../settingsService';
import { createWorkPlanStepModelsSwitch } from './workPlanStepModels';

export const workPlanStepModels = createWorkPlanStepModelsSwitch({
  getSetting: (name) => settingsService.getSetting(name),
  now: () => Date.now(),
  log: (message, fields) => console.error(message, fields),
});
