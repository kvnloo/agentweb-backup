/**
 * Service Registry
 * 
 * Central registry for all tool service providers.
 * Allows handlers to access dedicated services instead of the monolithic agentModeService.
 * 
 * Usage:
 * 1. Register services during initialization
 * 2. Handlers reference services by name in their configs
 * 3. HandlerFactory resolves the service and calls the method
 */

/**
 * Base interface for all tool services
 */
export interface ToolService {
  /** Service name for identification */
  readonly serviceName: string;
}

/**
 * Service registry for managing tool service providers
 */
export class ServiceRegistry {
  private services = new Map<string, ToolService>();
  private legacyService: any = null;

  /**
   * Register a service
   */
  register<T extends ToolService>(name: string, service: T): void {
    if (this.services.has(name)) {
      console.warn(`ServiceRegistry: Service '${name}' already registered, overwriting.`);
    }
    this.services.set(name, service);
  }

  /**
   * Register the legacy agentModeService for backward compatibility
   */
  registerLegacy(service: any): void {
    this.legacyService = service;
    this.services.set('legacy', service);
  }

  /**
   * Get a service by name
   */
  get<T extends ToolService>(name: string): T | undefined {
    return this.services.get(name) as T | undefined;
  }

  /**
   * Get the legacy agentModeService (for non-migrated tools)
   */
  getLegacy(): any {
    return this.legacyService;
  }

  /**
   * Check if a service is registered
   */
  has(name: string): boolean {
    return this.services.has(name);
  }

  /**
   * Get all registered service names
   */
  getRegisteredServices(): string[] {
    return Array.from(this.services.keys());
  }

  /**
   * Clear all services (useful for testing)
   */
  clear(): void {
    this.services.clear();
    this.legacyService = null;
  }
}

/**
 * Singleton instance
 */
export const serviceRegistry = new ServiceRegistry();

/**
 * Service provider interface for handler configs
 * Maps service name to the actual service instance
 */
export interface ServiceProvider {
  getService(serviceName: string): any;
  getLegacyService(): any;
}

/**
 * Create a ServiceProvider from a ServiceRegistry
 */
export function createServiceProvider(registry: ServiceRegistry): ServiceProvider {
  return {
    getService(serviceName: string): any {
      const service = registry.get(serviceName);
      if (!service) {
        // Fallback to legacy service
        return registry.getLegacy();
      }
      return service;
    },
    getLegacyService(): any {
      return registry.getLegacy();
    }
  };
}
