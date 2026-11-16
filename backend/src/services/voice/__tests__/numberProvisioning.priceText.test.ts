jest.mock('../../db', () => ({ orgDb: { getOrgById: jest.fn(), updateOrg: jest.fn() } }));
jest.mock('../../../utils/vendorRateCard', () => ({ getAllocatedRate: jest.fn() }));
import { getAllocatedRate } from '../../../utils/vendorRateCard';
import { callRateText, monthlyRentText } from '../numberProvisioning';

const rate = getAllocatedRate as jest.Mock;

describe('price texts for the approval cards', () => {
  it('reads the live rent and call rate from the rate card', () => {
    rate.mockImplementation((_provider: string, key: string) => (key === 'number_monthly_rent' ? 1.15 : 0.014));
    expect(monthlyRentText()).toBe('$1.15 per month');
    expect(callRateText()).toBe('$0.014 per minute');
    expect(rate).toHaveBeenCalledWith('twilio', 'voice_minute_outbound');
  });
  it('rounds the rent to cents and the call rate to four decimals without trailing zeros', () => {
    rate.mockReturnValue(1.005);
    expect(monthlyRentText()).toBe('$1.00 per month');
    rate.mockReturnValue(0.01249999);
    expect(callRateText()).toBe('$0.0125 per minute');
    rate.mockReturnValue(0.02);
    expect(callRateText()).toBe('$0.02 per minute');
  });
  it('falls back to words when the rate card has no rate', () => {
    rate.mockReturnValue(null);
    expect(monthlyRentText()).toBe('a monthly fee');
    expect(callRateText()).toBe('the per-minute rate of your phone provider');
  });
});
