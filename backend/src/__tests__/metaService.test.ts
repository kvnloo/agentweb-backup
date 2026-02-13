import { MetaService } from '../services/metaService';
import { FacebookAdsApi, User } from 'facebook-nodejs-business-sdk';

// Mock the facebook-nodejs-business-sdk
jest.mock('facebook-nodejs-business-sdk', () => {
    return {
        FacebookAdsApi: {
            init: jest.fn()
        },
        User: jest.fn().mockImplementation(() => ({
            getAdAccounts: jest.fn(),
            getAccounts: jest.fn(),
            get: jest.fn()
        }))
    };
});

describe('MetaService', () => {
    let metaService: MetaService;
    const mockAccessToken = 'mock_access_token';

    beforeEach(() => {
        metaService = new MetaService();
        jest.clearAllMocks();
    });

    describe('getUserProfile', () => {
        it('should fetch user profile with picture', async () => {
            const mockUserResponse = {
                id: '123',
                name: 'Test User',
                email: 'test@example.com',
                picture: {
                    data: {
                        url: 'https://example.com/pic.jpg'
                    }
                }
            };

            const mockGet = jest.fn().mockResolvedValue(mockUserResponse);
            (User as any).mockImplementation(() => ({
                get: mockGet
            }));

            const result = await metaService.getUserProfile(mockAccessToken);

            expect(FacebookAdsApi.init).toHaveBeenCalledWith(mockAccessToken);
            expect(mockGet).toHaveBeenCalledWith(['id', 'name', 'email']);
            expect(result).toEqual({
                id: '123',
                name: 'Test User',
                email: 'test@example.com'
            });
        });

        it('should handle missing picture data', async () => {
            const mockUserResponse = {
                id: '123',
                name: 'Test User',
                email: 'test@example.com'
            };

            const mockGet = jest.fn().mockResolvedValue(mockUserResponse);
            (User as any).mockImplementation(() => ({
                get: mockGet
            }));

            const result = await metaService.getUserProfile(mockAccessToken);

            expect(result).toEqual({
                id: '123',
                name: 'Test User',
                email: 'test@example.com',
                profile_picture_url: undefined
            });
        });

        it('should handle API errors', async () => {
            const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => { });
            const mockError = new Error('API Error');
            const mockGet = jest.fn().mockRejectedValue(mockError);
            (User as unknown as jest.Mock).mockImplementation(() => ({
                get: mockGet
            }));

            await expect(metaService.getUserProfile(mockAccessToken)).rejects.toThrow('API Error');
            expect(consoleSpy).toHaveBeenCalled();
            consoleSpy.mockRestore();
        });
    });

    describe('getAdAccounts', () => {
        it('should fetch and filter business ad accounts', async () => {
            const mockAdAccounts = [
                {
                    id: 'act_123',
                    name: 'Business Ad Account',
                    account_id: '123',
                    currency: 'USD',
                    account_status: 1,
                    owner: 'owner_id',
                    business: { id: 'biz_123', name: 'Test Business' }
                },
                {
                    id: 'act_456',
                    name: 'Personal Ad Account',
                    account_id: '456',
                    currency: 'USD',
                    account_status: 1,
                    owner: 'owner_id'
                    // No business field
                }
            ];

            const mockGetAdAccounts = jest.fn().mockResolvedValue(mockAdAccounts);
            (User as unknown as jest.Mock).mockImplementation(() => ({
                getAdAccounts: mockGetAdAccounts
            }));

            const result = await metaService.getAdAccounts(mockAccessToken);

            expect(mockGetAdAccounts).toHaveBeenCalledWith(['id', 'name', 'account_id', 'currency', 'account_status', 'owner', 'business']);
            expect(result).toHaveLength(1);
            expect(result[0].id).toBe('act_123');
            expect(result[0].business).toBeDefined();
        });
    });

    describe('getPages', () => {
        it('should fetch pages', async () => {
            const mockPages = [
                {
                    id: 'page_123',
                    name: 'Test Page',
                    access_token: 'page_token',
                    category: 'Business',
                    tasks: ['ADVERTISE']
                }
            ];

            const mockGetAccounts = jest.fn().mockResolvedValue(mockPages);
            (User as unknown as jest.Mock).mockImplementation(() => ({
                getAccounts: mockGetAccounts
            }));

            const result = await metaService.getPages(mockAccessToken);

            expect(mockGetAccounts).toHaveBeenCalledWith(['id', 'name', 'access_token', 'category', 'tasks']);
            expect(result).toHaveLength(1);
            expect(result[0].id).toBe('page_123');
        });
    });

    describe('verifyToken', () => {
        it('should return valid true when API call succeeds', async () => {
            const mockGet = jest.fn().mockResolvedValue({ id: '123' });
            (User as unknown as jest.Mock).mockImplementation(() => ({
                get: mockGet
            }));

            const result = await metaService.verifyToken(mockAccessToken);

            expect(result.valid).toBe(true);
        });

        it('should return valid false on 401 error', async () => {
            const mockError: any = new Error('Auth Error');
            mockError.response = { status: 401 };

            const mockGet = jest.fn().mockRejectedValue(mockError);
            (User as unknown as jest.Mock).mockImplementation(() => ({
                get: mockGet
            }));

            const result = await metaService.verifyToken(mockAccessToken);

            expect(result.valid).toBe(false);
            expect(result.error).toBe('Token expired or revoked');
        });
    });
});
