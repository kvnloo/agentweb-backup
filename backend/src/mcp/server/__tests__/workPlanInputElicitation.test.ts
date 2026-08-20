import { buildWorkPlanInputRequest } from '../../../services/agentMode/core/workPlanInputRequest';
import { toMcpElicitation } from '../workPlanInputElicitation';

describe('toMcpElicitation', () => {
  it('maps the shared request to MCP’s flat, typed form schema', () => {
    const request = buildWorkPlanInputRequest({
      requestId: 'request-1',
      stepCount: 1,
      title: 'Event details',
      prompt: 'Enter event details.',
      fields: [
        { id: 'url', label: 'Guest list URL', type: 'url', required: true },
        { id: 'days', label: 'Lookback days', type: 'number', defaultValue: 14, minimum: 1, maximum: 90 },
        { id: 'audience', label: 'Audience', type: 'select', required: true, options: [{ value: 'founders', label: 'Founders' }, { value: 'investors', label: 'Investors' }] },
      ],
    });

    expect(toMcpElicitation(request)).toEqual({
      mode: 'form',
      message: 'Enter event details.',
      requestedSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', format: 'uri', title: 'Guest list URL' },
          days: { type: 'number', title: 'Lookback days', default: 14, minimum: 1, maximum: 90 },
          audience: { type: 'string', title: 'Audience', oneOf: [{ const: 'founders', title: 'Founders' }, { const: 'investors', title: 'Investors' }] },
        },
        required: ['url', 'audience'],
      },
    });
  });
});
