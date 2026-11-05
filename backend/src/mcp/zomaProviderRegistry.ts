/**
 * ENG-2828 — registry of Zoma providers. Meta is the only registered provider; a second
 * platform registers here and its tools join tools/list after Meta's.
 */
import { metaZomaProvider } from './metaZomaProvider';
import type { ZomaProvider, ZomaProviderSetupStatus, ZomaToolDefinition } from './zomaProvider';

export class ZomaProviderRegistry {
  private readonly providers = new Map<string, ZomaProvider>();

  constructor(providers: ZomaProvider[] = []) {
    for (const p of providers) this.register(p);
  }

  register(provider: ZomaProvider): void {
    if (this.providers.has(provider.platform)) {
      throw new Error(`Zoma provider ${provider.platform} is already registered`);
    }
    this.providers.set(provider.platform, provider);
  }

  get(platform: string): ZomaProvider | undefined {
    return this.providers.get(platform);
  }

  list(): ZomaProvider[] {
    return [...this.providers.values()];
  }

  /**
   * Combined tools/list in registration order. Shared toolkit tools (zoma_status, …) that
   * more than one provider advertises appear once, at their first position.
   */
  listTools(): ZomaToolDefinition[] {
    const seen = new Set<string>();
    const tools: ZomaToolDefinition[] = [];
    for (const provider of this.providers.values()) {
      for (const tool of provider.listTools()) {
        if (seen.has(tool.name)) continue;
        seen.add(tool.name);
        tools.push(tool);
      }
    }
    return tools;
  }

  /** The provider that owns a curated platform tool, if any. */
  providerForTool(toolName: string): ZomaProvider | undefined {
    return this.list().find((p) => p.toolNames.includes(toolName));
  }

  /** Setup status per registered platform. */
  async getSetupStatus(userId: string): Promise<ZomaProviderSetupStatus[]> {
    return Promise.all(this.list().map((p) => p.getSetupStatus(userId)));
  }
}

export const zomaProviderRegistry = new ZomaProviderRegistry([metaZomaProvider]);
