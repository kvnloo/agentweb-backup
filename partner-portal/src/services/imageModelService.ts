import { buildApiUrl } from '../config';

export interface ImageModel {
  value: string;
  label: string;
  description: string;
  provider: string;
}

export interface ImageModelConfig {
  defaultImageModel: string;
  supportedImageModels: ImageModel[];
}

// Cache for image model configuration
let imageModelConfigCache: ImageModelConfig | null = null;
let cacheTimestamp: number = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// Fallback configuration in case API fails - minimal fallback
const fallbackConfig: ImageModelConfig = {
  defaultImageModel: 'openai-image-1',
  supportedImageModels: []
};

export const fetchImageModelConfig = async (): Promise<ImageModelConfig> => {
  // Check if we have valid cached data
  const now = Date.now();
  if (imageModelConfigCache && (now - cacheTimestamp) < CACHE_DURATION) {
    return imageModelConfigCache;
  }

  try {
    const response = await fetch(buildApiUrl('/api/image-models'));
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const config: ImageModelConfig = await response.json();
    
    // Validate the response structure
    if (!config.defaultImageModel || !Array.isArray(config.supportedImageModels)) {
      throw new Error('Invalid response structure');
    }
    
    // Cache the result
    imageModelConfigCache = config;
    cacheTimestamp = now;
    
    return config;
  } catch (error) {
    console.error('Error fetching image model configuration:', error);
    
    // Return minimal fallback configuration
    return fallbackConfig;
  }
};

export const getDefaultImageModel = async (): Promise<string> => {
  const config = await fetchImageModelConfig();
  return config.defaultImageModel;
};

export const getSupportedImageModels = async (): Promise<ImageModel[]> => {
  const config = await fetchImageModelConfig();
  return config.supportedImageModels;
};

// Clear cache (useful for testing or when settings are updated)
export const clearImageModelCache = (): void => {
  imageModelConfigCache = null;
  cacheTimestamp = 0;
};

// Get the effective image model for a task (user preference overrides default)
export const getEffectiveImageModel = (taskImageModel?: string, defaultModel?: string): string => {
  // User's task-specific preference takes precedence over default
  if (taskImageModel) {
    return taskImageModel;
  }
  // Fall back to default model if no user preference
  return defaultModel || 'openai-image-1';
};
