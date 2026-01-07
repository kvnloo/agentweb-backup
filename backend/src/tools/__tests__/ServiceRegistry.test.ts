
import { ServiceRegistry, createServiceProvider, ToolService } from '../ServiceRegistry';

// Mock service
class MockService implements ToolService {
  serviceName = 'mock';
  async testMethod(arg: string) {
    return `Processed: ${arg}`;
  }
}

describe('ServiceRegistry', () => {
  let registry: ServiceRegistry;

  beforeEach(() => {
    registry = new ServiceRegistry();
  });

  it('should register and retrieve a service', () => {
    const service = new MockService();
    registry.register('mock', service);
    
    expect(registry.get('mock')).toBe(service);
    expect(registry.has('mock')).toBe(true);
  });

  it('should return undefined for unknown service', () => {
    expect(registry.get('unknown')).toBeUndefined();
    expect(registry.has('unknown')).toBe(false);
  });

  it('should register and retrieve legacy service', () => {
    const legacy = { legacyMethod: () => {} };
    registry.registerLegacy(legacy);
    
    expect(registry.getLegacy()).toBe(legacy);
    expect(registry.get('legacy')).toBe(legacy);
  });

  it('should overwrite existing service registration with warning', () => {
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const service1 = new MockService();
    const service2 = new MockService();
    
    registry.register('mock', service1);
    registry.register('mock', service2);
    
    expect(registry.get('mock')).toBe(service2);
    expect(consoleSpy).toHaveBeenCalled();
  });

  it('should clear all services', () => {
    registry.register('mock', new MockService());
    registry.registerLegacy({});
    
    registry.clear();
    
    expect(registry.get('mock')).toBeUndefined();
    expect(registry.getLegacy()).toBeNull();
  });
});

describe('ServiceProvider', () => {
  let registry: ServiceRegistry;
  
  beforeEach(() => {
    registry = new ServiceRegistry();
  });

  it('should return service from registry', () => {
    const service = new MockService();
    registry.register('mock', service);
    
    const provider = createServiceProvider(registry);
    expect(provider.getService('mock')).toBe(service);
  });

  it('should fallback to legacy service if service not found', () => {
    const legacy = { legacyMethod: () => {} };
    registry.registerLegacy(legacy);
    
    const provider = createServiceProvider(registry);
    expect(provider.getService('unknown')).toBe(legacy);
  });

  it('should return legacy service explicitly', () => {
    const legacy = { legacyMethod: () => {} };
    registry.registerLegacy(legacy);
    
    const provider = createServiceProvider(registry);
    expect(provider.getLegacyService()).toBe(legacy);
  });
});
