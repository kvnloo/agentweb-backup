import axios from 'axios';
import { createTaskInList, mapCustomFieldValues, ClickUpTaskError } from '../services/clickupService';

jest.mock('axios');
jest.mock('../services/db', () => ({ userDb: {}, orgDb: {} }));
jest.mock('../utils/crypto', () => ({ decryptPassword: jest.fn() }));
const mockGet = axios.get as jest.Mock;
const mockPost = axios.post as jest.Mock;

const schema = {
  fields: [
    { id: 'f-type', name: 'Type', type: 'drop_down', type_config: { options: [{ id: 'o-conf', name: 'Conference' }, { id: 'o-web', name: 'Webinar' }] } },
    { id: 'f-loc', name: 'Location', type: 'short_text' },
    { id: 'f-cost', name: 'Cost', type: 'currency' },
    { id: 'f-dates', name: 'Dates', type: 'date' },
  ],
};

describe('ENG-755 createTaskInList', () => {
  beforeEach(() => jest.clearAllMocks());

  it('creates a task in the list with status, standard fields and schema-mapped custom fields', async () => {
    mockGet.mockResolvedValue({ data: schema });
    mockPost.mockResolvedValue({ data: { id: 't1', name: 'ASCO', url: 'https://app.clickup.com/t/t1' } });

    const res = await createTaskInList('tok', '901413827994', {
      name: 'ASCO', description: 'Big one', status: 'Possibles', priority: 2, assignees: [7], dueDate: 1000,
      customFields: { type: 'conference', Location: 'Chicago', Cost: '$1,200', Dates: '2027-05-29' },
    });

    expect(res).toEqual({ id: 't1', name: 'ASCO', url: 'https://app.clickup.com/t/t1' });
    expect(mockGet.mock.calls[0][0]).toBe('https://api.clickup.com/api/v2/list/901413827994/field');
    const [url, body] = mockPost.mock.calls[0];
    expect(url).toBe('https://api.clickup.com/api/v2/list/901413827994/task');
    expect(body).toEqual({
      name: 'ASCO', markdown_description: 'Big one', status: 'Possibles', priority: 2, assignees: [7], due_date: 1000,
      custom_fields: [
        { id: 'f-type', value: 'o-conf' },
        { id: 'f-loc', value: 'Chicago' },
        { id: 'f-cost', value: 1200 },
        { id: 'f-dates', value: Date.parse('2027-05-29') },
      ],
    });
  });

  it('rejects an unknown custom field with a typed error and creates nothing', async () => {
    mockGet.mockResolvedValue({ data: schema });
    await expect(createTaskInList('tok', 'L', { name: 'x', customFields: { Vibes: 'good' } }))
      .rejects.toMatchObject({ code: 'UNKNOWN_FIELD' });
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('rejects an invalid dropdown value with INVALID_VALUE', () => {
    const fields = schema.fields.map(f => ({ id: f.id, name: f.name, type: f.type, options: (f as any).type_config?.options }));
    expect(() => mapCustomFieldValues(fields, { Type: 'Party' })).toThrow(ClickUpTaskError);
    try { mapCustomFieldValues(fields, { Cost: 'free' }); } catch (e: any) { expect(e.code).toBe('INVALID_VALUE'); }
  });

  it('maps ClickUp 401 to AUTH_FAILED', async () => {
    mockPost.mockRejectedValue({ response: { status: 401, data: { err: 'Token invalid', ECODE: 'OAUTH_025' } } });
    await expect(createTaskInList('bad', 'L', { name: 'x' })).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    expect(mockGet).not.toHaveBeenCalled();
  });
});
