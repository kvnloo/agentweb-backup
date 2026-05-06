import express from 'express';
import multer from 'multer';
import { authenticateToken } from '../middleware/auth';
import { characterDb } from '../services/characterDb';
import { uploadFileToS3 } from '../utils/s3Utils';
import AWS from 'aws-sdk';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB

const s3 = new AWS.S3({ region: process.env.AWS_REGION || 'us-west-2' });
const S3_BUCKET = process.env.AWS_S3_BUCKET || 'agentweb-user-files';

router.use(authenticateToken);

// GET /api/characters — list all characters for the authenticated user
router.get('/', async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    const characters = await characterDb.listCharacters(userId);
    res.json(characters);
  } catch (error) {
    console.error('Error listing characters:', error);
    res.status(500).json({ message: 'Failed to list characters' });
  }
});

// GET /api/characters/:characterId — get a single character
router.get('/:characterId', async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    const { characterId } = req.params;
    const character = await characterDb.getCharacterById(characterId);
    if (!character) return res.status(404).json({ message: 'Character not found' });
    if (character.userId !== userId) return res.status(403).json({ message: 'Not authorized' });
    res.json(character);
  } catch (error) {
    console.error('Error getting character:', error);
    res.status(500).json({ message: 'Failed to get character' });
  }
});

// POST /api/characters/upload-image — upload a reference image, returns URL + key
// Must be registered before /:characterId to avoid route conflict
router.post('/upload-image', upload.single('file'), async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

    const { buffer, originalname, mimetype } = req.file;
    const result = await uploadFileToS3(buffer, originalname, userId, mimetype);
    if (!result.success || !result.url || !result.key) {
      return res.status(500).json({ message: result.error || 'Upload failed' });
    }
    res.json({ url: result.url, key: result.key });
  } catch (error) {
    console.error('Error uploading character image:', error);
    res.status(500).json({ message: 'Failed to upload image' });
  }
});

// POST /api/characters — create a character (referenceImageUrl already uploaded)
router.post('/', async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    const { name, description, referenceImageUrl, referenceImageKey, prompt } = req.body;
    if (!name || !description || !referenceImageUrl) {
      return res.status(400).json({ message: 'name, description, and referenceImageUrl are required' });
    }
    const character = await characterDb.createCharacter(userId, {
      name,
      description,
      referenceImageUrl,
      referenceImageKey: referenceImageKey || '',
      prompt: prompt || description,
    });
    res.status(201).json(character);
  } catch (error) {
    console.error('Error creating character:', error);
    res.status(500).json({ message: 'Failed to create character' });
  }
});

// DELETE /api/characters/:characterId — delete character and its S3 image
router.delete('/:characterId', async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    const { characterId } = req.params;
    const character = await characterDb.getCharacterById(characterId);
    if (!character) return res.status(404).json({ message: 'Character not found' });
    if (character.userId !== userId) return res.status(403).json({ message: 'Not authorized' });

    if (character.referenceImageKey) {
      try {
        await s3.deleteObject({ Bucket: S3_BUCKET, Key: character.referenceImageKey }).promise();
      } catch (s3Error) {
        console.warn('Failed to delete character image from S3:', s3Error);
      }
    }

    await characterDb.deleteCharacter(userId, characterId);
    res.json({ message: 'Character deleted' });
  } catch (error) {
    console.error('Error deleting character:', error);
    res.status(500).json({ message: 'Failed to delete character' });
  }
});

export default router;
