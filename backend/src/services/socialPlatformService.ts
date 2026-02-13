import { SocialPlatformAdapter } from './adapters/socialPlatformTypes';
import { LinkedInAdapter } from './adapters/linkedInAdapter';
import { InstagramAdapter } from './adapters/instagramAdapter';

// Re-export types for consumers
export * from './adapters/socialPlatformTypes';

/**
 * Registry of platform adapters
 */
export const socialPlatformService = {
  adapters: {
    linkedin: new LinkedInAdapter(),
    instagram: new InstagramAdapter(),
  } as Record<string, SocialPlatformAdapter>,

  getAdapter(platform: string): SocialPlatformAdapter {
    const adapter = this.adapters[platform];
    if (!adapter) {
      throw new Error(`Platform ${platform} is not supported`);
    }
    return adapter;
  }
};
