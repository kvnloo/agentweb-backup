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
    // Future adapters:
    // twitter: new TwitterAdapter(),
  } as Record<string, SocialPlatformAdapter>,

  getAdapter(platform: string): SocialPlatformAdapter {
    const adapterName = platform.toLowerCase();

    const adapter = this.adapters[adapterName];
    if (!adapter) {
      throw new Error(`Platform ${adapterName} is not supported`);
    }
    return adapter;
  }
};
