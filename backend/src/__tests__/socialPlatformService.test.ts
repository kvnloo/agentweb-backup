import { socialPlatformService } from '../services/socialPlatformService';
import { InstagramAdapter } from '../services/adapters/instagramAdapter';
import { LinkedInAdapter } from '../services/adapters/linkedInAdapter';
import { ConnectedAccount } from '../services/connectedAccountsDb';

describe('socialPlatformService', () => {
    describe('getAdapter', () => {
        it('should resolve to LinkedInAdapter for generic linkedin platform Request', () => {
            const adapter = socialPlatformService.getAdapter('linkedin');
            expect(adapter).toBeInstanceOf(LinkedInAdapter);
        });

        it('should resolve to InstagramAdapter for instagram platform Request', () => {
            const adapter = socialPlatformService.getAdapter('instagram');
            expect(adapter).toBeInstanceOf(InstagramAdapter);
        });

        it('should throw an error for unsupported platform adapters', () => {
            expect(() => socialPlatformService.getAdapter('myspace')).toThrow(
                "Platform myspace is not supported"
            );
        });
    });
});
