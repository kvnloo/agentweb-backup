import express from 'express';
import { settingsService } from '../services/settingsService';
import { authenticateToken, requireAdmin } from '../middleware/auth';

const router = express.Router();

// Get image model configuration (default model and supported models)
router.get('/', authenticateToken, requireAdmin, async (req, res) => {
  try {
    // Get default image model
    const defaultModelSetting = await settingsService.getSetting('default_image_model');
    const defaultImageModel = defaultModelSetting?.settingValue || 'openai-image-1';

    // Get supported image models
    const supportedModelsSetting = await settingsService.getSetting('supported_image_models');
    let supportedImageModels = [];
    
    if (supportedModelsSetting?.settingValue) {
      try {
        supportedImageModels = JSON.parse(supportedModelsSetting.settingValue);
      } catch (parseError) {
        console.error('Error parsing supported image models:', parseError);
        // Return empty array if parsing fails - should be initialized in database
        supportedImageModels = [];
      }
    } else {
      // Return empty array if no setting exists - should be initialized in database
      supportedImageModels = [];
    }

    res.json({
      defaultImageModel,
      supportedImageModels
    });
  } catch (error) {
    console.error('Error getting image model configuration:', error);
    res.status(500).json({ error: 'Failed to get image model configuration' });
  }
});

export default router;
