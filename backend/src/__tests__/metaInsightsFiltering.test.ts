/**
 * ENG-630 — Meta Insights request normalization + error preservation.
 *
 * Pure unit tests. No network, no clock, no AWS. Every assertion here is about
 * the SHAPE we hand to Meta and the DETAIL we hand back to the caller.
 */
import {
  normalizeMetaInsightsFiltering,
  describeMetaGraphApiError,
  MetaInsightsFilteringError,
} from '../utils/metaInsightsFiltering';

describe('normalizeMetaInsightsFiltering', () => {
  describe('AC1 — a single campaign filter becomes the array shape Meta expects', () => {
    it('wraps a bare filter object in an array', () => {
      // The model routinely emits the object itself rather than a one-element
      // list. Before the fix `filtering?.length` was undefined, so the filter
      // was DROPPED and Meta returned whole-account numbers that read to the
      // model as campaign-scoped.
      const result = normalizeMetaInsightsFiltering({
        field: 'campaign.id',
        operator: 'IN',
        value: ['120210000000000001'],
      });

      expect(Array.isArray(result)).toBe(true);
      expect(result).toEqual([
        { field: 'campaign.id', operator: 'IN', value: ['120210000000000001'] },
      ]);
    });

    it('parses a JSON-string array — the literal "filtering must be an array" repro', () => {
      // This is the reported production failure (ENG-621 -> ENG-630): the model
      // pre-serializes `filtering` to JSON text. A string has a truthy `.length`,
      // so the old guard passed it straight through and Meta rejected the call
      // with `(#100) param filtering must be an array`.
      const raw = '[{"field":"campaign.id","operator":"IN","value":["120210000000000001"]}]';

      const result = normalizeMetaInsightsFiltering(raw);

      expect(Array.isArray(result)).toBe(true);
      expect(result).toEqual([
        { field: 'campaign.id', operator: 'IN', value: ['120210000000000001'] },
      ]);
    });

    it('parses a JSON-string single object and wraps it', () => {
      const raw = '{"field":"campaign.id","operator":"EQUAL","value":"120210000000000001"}';

      expect(normalizeMetaInsightsFiltering(raw)).toEqual([
        { field: 'campaign.id', operator: 'EQUAL', value: '120210000000000001' },
      ]);
    });

    it('lifts a scalar IN value into an array', () => {
      // `IN` with a bare string is the other half of the same shape defect —
      // Meta requires a list for IN/NOT_IN.
      expect(
        normalizeMetaInsightsFiltering({
          field: 'campaign.id',
          operator: 'IN',
          value: '120210000000000001',
        })
      ).toEqual([
        { field: 'campaign.id', operator: 'IN', value: ['120210000000000001'] },
      ]);
    });

    it('lifts a scalar NOT_IN value into an array', () => {
      expect(
        normalizeMetaInsightsFiltering({
          field: 'campaign.id',
          operator: 'NOT_IN',
          value: '120210000000000002',
        })
      ).toEqual([
        { field: 'campaign.id', operator: 'NOT_IN', value: ['120210000000000002'] },
      ]);
    });

    it('normalizes a lowercase operator to the uppercase Meta enum', () => {
      expect(
        normalizeMetaInsightsFiltering({ field: 'campaign.id', operator: 'in', value: 'abc' })
      ).toEqual([{ field: 'campaign.id', operator: 'IN', value: ['abc'] }]);
    });

    it('leaves a non-list operator value scalar', () => {
      expect(
        normalizeMetaInsightsFiltering({
          field: 'campaign.name',
          operator: 'CONTAIN',
          value: 'Summer',
        })
      ).toEqual([{ field: 'campaign.name', operator: 'CONTAIN', value: 'Summer' }]);
    });

    it('accepts an already-correct array unchanged', () => {
      const input = [
        { field: 'campaign.id', operator: 'IN', value: ['1', '2'] },
      ];

      expect(normalizeMetaInsightsFiltering(input)).toEqual(input);
    });

    it('does not mutate the caller-supplied array or its entries', () => {
      const entry = { field: 'campaign.id', operator: 'in', value: '1' };
      const input = [entry];

      normalizeMetaInsightsFiltering(input);

      expect(entry).toEqual({ field: 'campaign.id', operator: 'in', value: '1' });
      expect(input).toHaveLength(1);
    });
  });

  describe('AC2 — empty and multi-filter cases stay valid and deterministic', () => {
    it('returns undefined for undefined', () => {
      expect(normalizeMetaInsightsFiltering(undefined)).toBeUndefined();
    });

    it('returns undefined for null', () => {
      expect(normalizeMetaInsightsFiltering(null)).toBeUndefined();
    });

    it('returns undefined for an empty array', () => {
      expect(normalizeMetaInsightsFiltering([])).toBeUndefined();
    });

    it('returns undefined for an empty / whitespace string', () => {
      expect(normalizeMetaInsightsFiltering('')).toBeUndefined();
      expect(normalizeMetaInsightsFiltering('   ')).toBeUndefined();
    });

    it('returns undefined for a JSON-string empty array', () => {
      expect(normalizeMetaInsightsFiltering('[]')).toBeUndefined();
    });

    it('preserves multiple filters in input order', () => {
      const result = normalizeMetaInsightsFiltering([
        { field: 'campaign.id', operator: 'IN', value: ['1'] },
        { field: 'spend', operator: 'GREATER_THAN', value: 100 },
        { field: 'campaign.name', operator: 'CONTAIN', value: 'Q3' },
      ]);

      expect(result).toHaveLength(3);
      expect(result!.map((f) => f.field)).toEqual([
        'campaign.id',
        'spend',
        'campaign.name',
      ]);
    });

    it('is deterministic — the same input yields a deeply equal result every time', () => {
      const input = '[{"field":"campaign.id","operator":"in","value":"1"}]';

      expect(normalizeMetaInsightsFiltering(input)).toEqual(
        normalizeMetaInsightsFiltering(input)
      );
    });

    it('drops null/undefined holes rather than forwarding them to Meta', () => {
      const result = normalizeMetaInsightsFiltering([
        null,
        { field: 'campaign.id', operator: 'IN', value: ['1'] },
        undefined,
      ] as any);

      expect(result).toEqual([
        { field: 'campaign.id', operator: 'IN', value: ['1'] },
      ]);
    });

    it('returns undefined when every entry was a hole', () => {
      expect(normalizeMetaInsightsFiltering([null, undefined] as any)).toBeUndefined();
    });

    it('preserves a numeric zero value rather than treating it as absent', () => {
      expect(
        normalizeMetaInsightsFiltering({ field: 'spend', operator: 'GREATER_THAN', value: 0 })
      ).toEqual([{ field: 'spend', operator: 'GREATER_THAN', value: 0 }]);
    });
  });

  describe('fails loud — a filter we cannot honour is never silently dropped', () => {
    it('throws on a malformed JSON string', () => {
      expect(() => normalizeMetaInsightsFiltering('[{field: campaign.id}')).toThrow(
        MetaInsightsFilteringError
      );
      expect(() => normalizeMetaInsightsFiltering('[{field: campaign.id}')).toThrow(
        /could not be parsed as JSON/i
      );
    });

    it('throws on a JSON string that decodes to a scalar', () => {
      expect(() => normalizeMetaInsightsFiltering('"campaign.id"')).toThrow(
        MetaInsightsFilteringError
      );
    });

    it('throws on a primitive', () => {
      expect(() => normalizeMetaInsightsFiltering(42 as any)).toThrow(
        MetaInsightsFilteringError
      );
      expect(() => normalizeMetaInsightsFiltering(true as any)).toThrow(
        MetaInsightsFilteringError
      );
    });

    it('throws when an entry is missing `field`', () => {
      expect(() =>
        normalizeMetaInsightsFiltering([{ operator: 'IN', value: ['1'] }] as any)
      ).toThrow(/field/);
    });

    it('throws when an entry is missing `operator`', () => {
      expect(() =>
        normalizeMetaInsightsFiltering([{ field: 'campaign.id', value: ['1'] }] as any)
      ).toThrow(/operator/);
    });

    it('throws when an entry is missing `value`', () => {
      expect(() =>
        normalizeMetaInsightsFiltering([{ field: 'campaign.id', operator: 'IN' }] as any)
      ).toThrow(/value/);
    });

    it('throws on an unsupported operator rather than letting Meta 400 on it', () => {
      expect(() =>
        normalizeMetaInsightsFiltering({
          field: 'campaign.id',
          operator: 'REGEX_MATCH',
          value: 'x',
        })
      ).toThrow(/REGEX_MATCH/);
    });

    it('names the offending index so the model can correct itself', () => {
      expect(() =>
        normalizeMetaInsightsFiltering([
          { field: 'campaign.id', operator: 'IN', value: ['1'] },
          { field: 'spend' },
        ] as any)
      ).toThrow(/index 1/);
    });

    it('throws on an entry that is a primitive rather than an object', () => {
      expect(() => normalizeMetaInsightsFiltering(['campaign.id'] as any)).toThrow(
        MetaInsightsFilteringError
      );
    });

    it('throws on an IN filter whose value is an empty array', () => {
      // An empty IN list matches nothing; forwarding it would produce a clean
      // "no data" report for a question the user did ask.
      expect(() =>
        normalizeMetaInsightsFiltering({ field: 'campaign.id', operator: 'IN', value: [] })
      ).toThrow(/empty/i);
    });
  });

  describe('a malformed filter VALUE is rejected here, not forwarded to Meta', () => {
    // The value is the last place a bad shape could still reach the wire: field
    // and operator are validated above, but `value` was previously passed through
    // untouched. An object or nested array there either serializes to something
    // the caller never asked for or fails the async report job minutes later with
    // an opaque upstream parameter error.
    it('throws when a scalar operator is given an object', () => {
      expect(() =>
        normalizeMetaInsightsFiltering({
          field: 'campaign.id',
          operator: 'EQUAL',
          value: { id: '123' },
        })
      ).toThrow(MetaInsightsFilteringError);
    });

    it('names the offending shape and operator so the model can correct itself', () => {
      expect(() =>
        normalizeMetaInsightsFiltering({
          field: 'campaign.id',
          operator: 'EQUAL',
          value: { id: '123' },
        })
      ).toThrow(/an object.*for operator EQUAL/i);
    });

    it('throws when a scalar operator is given an array', () => {
      // EQUAL with a list is a caller reaching for IN; Meta rejects it upstream.
      expect(() =>
        normalizeMetaInsightsFiltering({
          field: 'campaign.id',
          operator: 'EQUAL',
          value: ['123', '456'],
        })
      ).toThrow(/an array/i);
    });

    it('throws when a scalar operator is given a function', () => {
      expect(() =>
        normalizeMetaInsightsFiltering({
          field: 'campaign.id',
          operator: 'CONTAIN',
          value: (() => 'x') as any,
        })
      ).toThrow(/a function/i);
    });

    it('throws on a nested array inside a list operator', () => {
      expect(() =>
        normalizeMetaInsightsFiltering({
          field: 'campaign.id',
          operator: 'IN',
          value: [['123']],
        })
      ).toThrow(/an array.*value\[0\]/i);
    });

    it('throws on an object element inside a list operator', () => {
      expect(() =>
        normalizeMetaInsightsFiltering({
          field: 'campaign.id',
          operator: 'IN',
          value: ['123', { id: '456' }],
        })
      ).toThrow(/an object.*value\[1\]/i);
    });

    it('throws on a null element inside a list operator', () => {
      // A null hole in a list is not the same as an absent filter — dropping it
      // would silently widen the query, which is the defect this module exists for.
      expect(() =>
        normalizeMetaInsightsFiltering({
          field: 'campaign.id',
          operator: 'IN',
          value: ['123', null],
        })
      ).toThrow(/null.*value\[1\]/i);
    });

    it('throws on NaN, which serializes to null and filters on the wrong value', () => {
      expect(() =>
        normalizeMetaInsightsFiltering({
          field: 'spend',
          operator: 'GREATER_THAN',
          value: Number.NaN,
        })
      ).toThrow(/non-finite/i);
    });

    it('throws on Infinity inside a list operator', () => {
      expect(() =>
        normalizeMetaInsightsFiltering({
          field: 'spend',
          operator: 'ANY',
          value: [Number.POSITIVE_INFINITY],
        })
      ).toThrow(/non-finite/i);
    });

    it('still accepts the scalar shapes Meta actually supports', () => {
      // The guard must not narrow a working call: string, number, and boolean
      // values all survive, under both scalar and list operators.
      expect(
        normalizeMetaInsightsFiltering([
          { field: 'campaign.id', operator: 'EQUAL', value: '123' },
          { field: 'spend', operator: 'GREATER_THAN', value: 10.5 },
          { field: 'is_active', operator: 'EQUAL', value: true },
          { field: 'adset.id', operator: 'IN', value: ['a', 2, false] },
        ])
      ).toEqual([
        { field: 'campaign.id', operator: 'EQUAL', value: '123' },
        { field: 'spend', operator: 'GREATER_THAN', value: 10.5 },
        { field: 'is_active', operator: 'EQUAL', value: true },
        { field: 'adset.id', operator: 'IN', value: ['a', 2, false] },
      ]);
    });
  });
});

describe('describeMetaGraphApiError — AC3', () => {
  const graphError = (error: Record<string, any>, status = 400) =>
    ({
      message: `Request failed with status code ${status}`,
      response: { status, data: { error } },
    }) as any;

  it('surfaces the actual Meta message instead of the opaque axios status line', () => {
    const detail = describeMetaGraphApiError(
      graphError({
        message: '(#100) param filtering must be an array',
        type: 'OAuthException',
        code: 100,
      })
    );

    expect(detail).toContain('param filtering must be an array');
    expect(detail).not.toBe('Request failed with status code 400');
  });

  it('includes the Meta error code so the failure is classifiable', () => {
    const detail = describeMetaGraphApiError(
      graphError({ message: 'Invalid parameter', code: 100, error_subcode: 33 })
    );

    expect(detail).toContain('100');
    expect(detail).toContain('33');
  });

  it('prefers the user-facing message when Meta supplies one', () => {
    const detail = describeMetaGraphApiError(
      graphError({
        message: 'Invalid parameter',
        code: 100,
        error_user_title: 'Unsupported filter',
        error_user_msg: 'The campaign you selected is no longer available.',
      })
    );

    expect(detail).toContain('Unsupported filter');
    expect(detail).toContain('The campaign you selected is no longer available.');
  });

  it('never leaks fbtrace_id', () => {
    const detail = describeMetaGraphApiError(
      graphError({
        message: 'Invalid parameter',
        code: 100,
        fbtrace_id: 'A1bCdEfGhIjKlMnOp',
      })
    );

    expect(detail).not.toContain('A1bCdEfGhIjKlMnOp');
    expect(detail).not.toContain('fbtrace_id');
  });

  it('redacts an access token echoed back inside the message', () => {
    const detail = describeMetaGraphApiError(
      graphError({
        message:
          'Invalid OAuth access token EAAGm0PX4ZCpsBAxxxxxxxxSECRETxxxxxxxx - cannot parse',
        code: 190,
      })
    );

    expect(detail).not.toContain('EAAGm0PX4ZCpsBAxxxxxxxxSECRETxxxxxxxx');
    expect(detail).toContain('[redacted]');
  });

  it('redacts an access_token=... query fragment echoed back', () => {
    const detail = describeMetaGraphApiError(
      graphError({
        message: 'Unsupported request: /insights?access_token=abc123def456ghi789',
        code: 100,
      })
    );

    expect(detail).not.toContain('abc123def456ghi789');
    expect(detail).toContain('[redacted]');
  });

  it('returns undefined for a non-Graph error so the caller keeps its own message', () => {
    expect(describeMetaGraphApiError(new Error('socket hang up'))).toBeUndefined();
  });

  it('returns undefined when the response body has no Meta error envelope', () => {
    expect(
      describeMetaGraphApiError({
        message: 'Request failed with status code 500',
        response: { status: 500, data: { something: 'else' } },
      } as any)
    ).toBeUndefined();
  });

  it('returns undefined for null/undefined input', () => {
    expect(describeMetaGraphApiError(undefined)).toBeUndefined();
    expect(describeMetaGraphApiError(null)).toBeUndefined();
  });

  it('handles a Meta error envelope that carries only a message', () => {
    const detail = describeMetaGraphApiError(graphError({ message: 'Something broke' }));

    expect(detail).toContain('Something broke');
  });

  it('returns undefined when the Meta envelope carries no usable text', () => {
    expect(describeMetaGraphApiError(graphError({ code: 100 }))).toBeUndefined();
  });

  it('reads a Graph error nested under data.error even on a 500', () => {
    const detail = describeMetaGraphApiError(
      graphError({ message: 'Internal Meta failure', code: 2 }, 500)
    );

    expect(detail).toContain('Internal Meta failure');
  });

  it('tolerates a string response body', () => {
    expect(
      describeMetaGraphApiError({
        message: 'Request failed with status code 400',
        response: { status: 400, data: 'Bad Request' },
      } as any)
    ).toBeUndefined();
  });

  it('produces a single-line message safe for a tool response', () => {
    const detail = describeMetaGraphApiError(
      graphError({ message: 'line one\nline two', code: 100 })
    );

    expect(detail).not.toContain('\n');
  });
});
