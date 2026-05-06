/**
 * Tests for enrichmentLogger.ts — covers dev pretty-print, prod JSON,
 * level routing (debug/info/warn/error), and the `timed` helper for
 * both success and failure paths.
 */

describe('enrichmentLogger', () => {
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  const originalEnv = process.env.NODE_ENV;

  beforeEach(() => {
    jest.resetModules();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    process.env.NODE_ENV = originalEnv;
  });

  describe('dev mode (NODE_ENV !== production)', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'development';
    });

    it('debug routes to console.log with [crm-enrichment][event] tag and rest fields', () => {
      const { enrichLog } = require('../utils/enrichmentLogger');
      enrichLog.debug({ event: 'lead.start', leadId: 'l1' }, 'starting');
      expect(logSpy).toHaveBeenCalledWith(
        '[crm-enrichment][lead.start]',
        'starting',
        expect.objectContaining({ leadId: 'l1' })
      );
      // event should be stripped from the rest bag
      const restArg = logSpy.mock.calls[0][2];
      expect(restArg).not.toHaveProperty('event');
    });

    it('info routes to console.log even without a message', () => {
      const { enrichLog } = require('../utils/enrichmentLogger');
      enrichLog.info({ event: 'cache.hit' });
      expect(logSpy).toHaveBeenCalledWith(
        '[crm-enrichment][cache.hit]',
        '',
        expect.any(Object)
      );
    });

    it('warn routes to console.warn', () => {
      const { enrichLog } = require('../utils/enrichmentLogger');
      enrichLog.warn({ event: 'llm.retry' }, 'retrying');
      expect(warnSpy).toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();
    });

    it('error routes to console.error', () => {
      const { enrichLog } = require('../utils/enrichmentLogger');
      enrichLog.error({ event: 'lead.fail' }, 'boom');
      expect(errorSpy).toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();
    });
  });

  describe('prod mode (NODE_ENV = production)', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
    });

    it('emits single-line JSON with required fields', () => {
      const { enrichLog } = require('../utils/enrichmentLogger');
      enrichLog.info({ event: 'lead.complete', jobId: 'j1' }, 'done');
      expect(logSpy).toHaveBeenCalledTimes(1);
      const line = logSpy.mock.calls[0][0];
      const parsed = JSON.parse(line);
      expect(parsed).toMatchObject({
        level: 'info',
        component: 'crm-enrichment',
        event: 'lead.complete',
        jobId: 'j1',
        msg: 'done',
      });
      expect(typeof parsed.ts).toBe('string');
    });

    it('omits msg field when no message passed', () => {
      const { enrichLog } = require('../utils/enrichmentLogger');
      enrichLog.info({ event: 'cache.hit' });
      const parsed = JSON.parse(logSpy.mock.calls[0][0]);
      expect(parsed).not.toHaveProperty('msg');
    });

    it('warn routes to console.warn as JSON', () => {
      const { enrichLog } = require('../utils/enrichmentLogger');
      enrichLog.warn({ event: 'llm.retry' });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(() => JSON.parse(warnSpy.mock.calls[0][0])).not.toThrow();
    });

    it('error routes to console.error as JSON', () => {
      const { enrichLog } = require('../utils/enrichmentLogger');
      enrichLog.error({ event: 'lead.fail' }, 'boom');
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(errorSpy.mock.calls[0][0]);
      expect(parsed).toMatchObject({ level: 'error', event: 'lead.fail', msg: 'boom' });
    });

    it('debug routes to console.log as JSON', () => {
      const { enrichLog } = require('../utils/enrichmentLogger');
      enrichLog.debug({ event: 'trace' });
      const parsed = JSON.parse(logSpy.mock.calls[0][0]);
      expect(parsed.level).toBe('debug');
    });
  });

  describe('timed helper', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
    });

    it('returns the wrapped value and logs a success record with ms/ok=true', async () => {
      const { timed } = require('../utils/enrichmentLogger');
      const result = await timed({ event: 'span.work' }, async () => 'done');
      expect(result).toBe('done');
      const parsed = JSON.parse(logSpy.mock.calls[0][0]);
      expect(parsed).toMatchObject({ level: 'info', event: 'span.work', ok: true });
      expect(typeof parsed.ms).toBe('number');
      expect(parsed.ms).toBeGreaterThanOrEqual(0);
    });

    it('rethrows and logs an error record with ok=false and error message', async () => {
      const { timed } = require('../utils/enrichmentLogger');
      const err = new Error('boom');
      await expect(timed({ event: 'span.work' }, async () => { throw err; })).rejects.toThrow('boom');
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(errorSpy.mock.calls[0][0]);
      expect(parsed).toMatchObject({
        level: 'error',
        event: 'span.work',
        ok: false,
        error: 'boom',
        msg: 'span failed',
      });
    });

    it('handles thrown non-Error rejections (no .message)', async () => {
      const { timed } = require('../utils/enrichmentLogger');
      await expect(timed({ event: 'span.work' }, async () => { throw 'bare-string'; })).rejects.toBe('bare-string');
      const parsed = JSON.parse(errorSpy.mock.calls[0][0]);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toBeUndefined();
    });
  });
});
