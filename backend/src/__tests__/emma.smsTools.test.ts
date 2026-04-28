/**
 * Tests for SMS Emma tools (send_sms, get_sms_history) registered on the emmaToolRegistry.
 */

jest.mock('../services/smsService', () => ({
  smsService: {
    sendSMS: jest.fn(),
    getSMSHistory: jest.fn(),
    isConfigured: jest.fn().mockReturnValue(true),
  },
}));

import { emmaToolRegistry } from '../emma/registry';
import '../emma/smsTools';
import { smsService } from '../services/smsService';

const mockedSendSMS = smsService.sendSMS as jest.MockedFunction<typeof smsService.sendSMS>;
const mockedGetHistory = smsService.getSMSHistory as jest.MockedFunction<typeof smsService.getSMSHistory>;

const executeTool = async (name: string, args: any, context: any = {}) => {
  const tool = emmaToolRegistry.getTool(name);
  if (!tool) throw new Error(`Tool "${name}" not found in registry`);
  return tool.execute(args, context);
};

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── Registration ────────────────────────────────────────────────────────────

describe('tool registration', () => {
  it('registers send_sms', () => {
    expect(emmaToolRegistry.getTool('send_sms')).toBeDefined();
  });

  it('registers get_sms_history', () => {
    expect(emmaToolRegistry.getTool('get_sms_history')).toBeDefined();
  });
});

// ─── send_sms ────────────────────────────────────────────────────────────────

describe('send_sms', () => {
  const validArgs = {
    from_phone: '+12065550001',
    to_phone: '+12065550002',
    message: 'Hello from Emma!',
  };

  it('sends SMS successfully', async () => {
    mockedSendSMS.mockResolvedValue({ messageSid: 'SM123', status: 'queued' });
    const result = await executeTool('send_sms', validArgs);
    expect(result.success).toBe(true);
    expect(result.message_sid).toBe('SM123');
    expect(result.status).toBe('queued');
    expect(result.message).toContain('+12065550002');
    expect(mockedSendSMS).toHaveBeenCalledWith('+12065550001', '+12065550002', 'Hello from Emma!');
  });

  it('includes contact_name in success message', async () => {
    mockedSendSMS.mockResolvedValue({ messageSid: 'SM456', status: 'queued' });
    const result = await executeTool('send_sms', { ...validArgs, contact_name: 'John Doe' });
    expect(result.success).toBe(true);
    expect(result.message).toContain('John Doe');
  });

  it('returns error for missing from_phone', async () => {
    const result = await executeTool('send_sms', { ...validArgs, from_phone: '' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/from_phone/);
  });

  it('returns error for invalid from_phone format', async () => {
    const result = await executeTool('send_sms', { ...validArgs, from_phone: '2065550001' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/E\.164/);
  });

  it('returns error for invalid to_phone format', async () => {
    const result = await executeTool('send_sms', { ...validArgs, to_phone: '5550002' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/E\.164/);
  });

  it('returns error for empty message', async () => {
    const result = await executeTool('send_sms', { ...validArgs, message: '' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/empty/);
  });

  it('returns error when message exceeds 1600 characters', async () => {
    const result = await executeTool('send_sms', { ...validArgs, message: 'a'.repeat(1601) });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/1600/);
  });

  it('handles Twilio API errors gracefully', async () => {
    mockedSendSMS.mockRejectedValue(new Error('Twilio: invalid phone number'));
    const result = await executeTool('send_sms', validArgs);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Twilio: invalid phone number');
  });
});

// ─── get_sms_history ─────────────────────────────────────────────────────────

describe('get_sms_history', () => {
  const validArgs = {
    from_phone: '+12065550001',
    to_phone: '+12065550002',
  };

  const sampleMessages = [
    { messageSid: 'SM001', direction: 'outbound' as const, body: 'Hey!', status: 'delivered', createdAt: '2026-04-25T10:00:00.000Z', from: '+12065550001', to: '+12065550002' },
    { messageSid: 'SM002', direction: 'inbound' as const, body: 'Hi back!', status: 'received', createdAt: '2026-04-25T10:01:00.000Z', from: '+12065550002', to: '+12065550001' },
  ];

  it('returns SMS history successfully', async () => {
    mockedGetHistory.mockResolvedValue(sampleMessages);
    const result = await executeTool('get_sms_history', validArgs);
    expect(result.success).toBe(true);
    expect(result.count).toBe(2);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].direction).toBe('outbound');
    expect(result.messages[1].direction).toBe('inbound');
    expect(mockedGetHistory).toHaveBeenCalledWith('+12065550001', '+12065550002', 20);
  });

  it('returns empty history when no messages', async () => {
    mockedGetHistory.mockResolvedValue([]);
    const result = await executeTool('get_sms_history', validArgs);
    expect(result.success).toBe(true);
    expect(result.count).toBe(0);
    expect(result.messages).toHaveLength(0);
  });

  it('caps limit at 50', async () => {
    mockedGetHistory.mockResolvedValue([]);
    await executeTool('get_sms_history', { ...validArgs, limit: 100 });
    expect(mockedGetHistory).toHaveBeenCalledWith('+12065550001', '+12065550002', 50);
  });

  it('uses default limit of 20 when not specified', async () => {
    mockedGetHistory.mockResolvedValue([]);
    await executeTool('get_sms_history', validArgs);
    expect(mockedGetHistory).toHaveBeenCalledWith('+12065550001', '+12065550002', 20);
  });

  it('returns error for invalid from_phone', async () => {
    const result = await executeTool('get_sms_history', { ...validArgs, from_phone: 'not-a-number' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/E\.164/);
  });

  it('returns error for invalid to_phone', async () => {
    const result = await executeTool('get_sms_history', { ...validArgs, to_phone: '' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/to_phone/);
  });

  it('handles service errors gracefully', async () => {
    mockedGetHistory.mockRejectedValue(new Error('Twilio auth failed'));
    const result = await executeTool('get_sms_history', validArgs);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Twilio auth failed');
  });
});
