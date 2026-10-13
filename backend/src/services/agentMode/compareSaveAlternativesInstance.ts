/** Process-wide ENG-113 switch reader used by /compare/select and GET /model-options (one cache, one answer). */
import { settingsService } from '../settingsService';
import { createCompareSaveAlternatives } from './compareSaveAlternatives';

export const compareSaveAlternatives = createCompareSaveAlternatives({
  getSetting: (name) => settingsService.getSetting(name),
  now: () => Date.now(),
  log: (message, fields) => console.error(message, fields),
});
