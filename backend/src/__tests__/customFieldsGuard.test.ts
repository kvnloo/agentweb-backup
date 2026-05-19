import {
  isPlainCustomFieldsObject,
  sanitizeCustomFields,
  mergeCustomFields,
} from '../utils/customFieldsGuard';

describe('customFieldsGuard', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  describe('isPlainCustomFieldsObject', () => {
    it('returns true for plain objects', () => {
      expect(isPlainCustomFieldsObject({})).toBe(true);
      expect(isPlainCustomFieldsObject({ a: 1, b: 'x' })).toBe(true);
    });

    it('returns true for objects with numeric-string keys (no false positive)', () => {
      expect(isPlainCustomFieldsObject({ '1': 'Yes', '2': 'No' })).toBe(true);
    });

    it('returns false for strings', () => {
      expect(isPlainCustomFieldsObject('{"a":1}')).toBe(false);
      expect(isPlainCustomFieldsObject('')).toBe(false);
    });

    it('returns false for arrays', () => {
      expect(isPlainCustomFieldsObject(['a', 'b'])).toBe(false);
      expect(isPlainCustomFieldsObject([])).toBe(false);
    });

    it('returns false for null and undefined', () => {
      expect(isPlainCustomFieldsObject(null)).toBe(false);
      expect(isPlainCustomFieldsObject(undefined)).toBe(false);
    });

    it('returns false for numbers and booleans', () => {
      expect(isPlainCustomFieldsObject(42)).toBe(false);
      expect(isPlainCustomFieldsObject(true)).toBe(false);
    });

    it('returns false for class instances (non-plain objects)', () => {
      class Foo { x = 1; }
      expect(isPlainCustomFieldsObject(new Foo())).toBe(false);
    });

    it('returns false for Map and Set', () => {
      expect(isPlainCustomFieldsObject(new Map())).toBe(false);
      expect(isPlainCustomFieldsObject(new Set())).toBe(false);
    });
  });

  describe('sanitizeCustomFields', () => {
    it('returns input unchanged when it is a plain object', () => {
      const input = { a: 1 };
      const result = sanitizeCustomFields(input, { source: 'test' });
      expect(result).toBe(input);
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('coerces a string to {} and logs an error', () => {
      const result = sanitizeCustomFields('{"a":1}', { source: 'test', listId: 'L1', leadId: 'X1' });
      expect(result).toEqual({});
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const [msg, ctx] = errorSpy.mock.calls[0];
      expect(msg).toContain('[customFieldsGuard]');
      expect(ctx).toMatchObject({ source: 'test', listId: 'L1', leadId: 'X1', type: 'string' });
      expect(typeof ctx.stack).toBe('string');
    });

    it('coerces an array to {} and logs an error', () => {
      const result = sanitizeCustomFields(['a', 'b'], { source: 'test' });
      expect(result).toEqual({});
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0][1]).toMatchObject({ isArray: true });
    });

    it('coerces null to {}', () => {
      expect(sanitizeCustomFields(null, { source: 'test' })).toEqual({});
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    it('coerces undefined to {}', () => {
      expect(sanitizeCustomFields(undefined, { source: 'test' })).toEqual({});
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    it('coerces a number to {}', () => {
      expect(sanitizeCustomFields(42, { source: 'test' })).toEqual({});
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('mergeCustomFields', () => {
    it('merges two plain objects with patch winning on collision', () => {
      const result = mergeCustomFields({ a: 1, b: 2 }, { b: 3, c: 4 }, { source: 'test' });
      expect(result).toEqual({ a: 1, b: 3, c: 4 });
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('drops a corrupted (string) existing side and keeps only the patch', () => {
      const result = mergeCustomFields('{"firstName":"David"}', { newKey: 'newVal' }, {
        source: 'test', listId: 'L1', leadId: 'X1',
      });
      expect(result).toEqual({ newKey: 'newVal' });
      // No numeric-string keys from the corrupted string
      expect(Object.keys(result).some((k) => /^\d+$/.test(k))).toBe(false);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    it('drops a corrupted (string) patch side and keeps only existing', () => {
      const result = mergeCustomFields({ a: 1 }, 'corrupt', { source: 'test' });
      expect(result).toEqual({ a: 1 });
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    it('returns {} when both sides are corrupted', () => {
      const result = mergeCustomFields('a', 'b', { source: 'test' });
      expect(result).toEqual({});
      expect(errorSpy).toHaveBeenCalledTimes(2);
    });

    it('does NOT auto-heal an already-corrupted char-indexed object (documents non-goal)', () => {
      const corruptObj = { '0': '{', '1': '"', '2': 'a' };
      const result = mergeCustomFields(corruptObj, { newKey: 'v' }, { source: 'test' });
      expect(result).toEqual({ '0': '{', '1': '"', '2': 'a', newKey: 'v' });
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });
});
