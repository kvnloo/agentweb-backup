import express from 'express';
import request from 'supertest';

const mockDeleteObject = jest.fn(() => ({ promise: () => Promise.resolve({}) }));
jest.mock('aws-sdk', () => ({ __esModule: true, default: { S3: jest.fn(() => ({ deleteObject: mockDeleteObject })) } }));
jest.mock('../../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => { req.user = { userId: 'u1' }; next(); },
}));
const mockDb = { createCharacter: jest.fn(), getCharacterById: jest.fn(), deleteCharacter: jest.fn(), listCharacters: jest.fn() };
jest.mock('../../services/characterDb', () => ({ characterDb: mockDb }));
jest.mock('../../utils/s3Utils', () => ({ uploadFileToS3: jest.fn() }));

import router, { isOwnUploadKey } from '../characters';

const app = express();
app.use(express.json());
app.use('/api/characters', router);

const OWN = 'users/u1/files/1/tok/a.png';
const FOREIGN = 'users/u2/files/1/tok/secret.png';
const body = (key: string) => ({ name: 'n', description: 'd', referenceImageUrl: 'https://x/a.png', referenceImageKey: key });

beforeEach(() => jest.clearAllMocks());

describe('ENG-2408 character reference image key scoping', () => {
  it('accepts an own-prefix key on create', async () => {
    mockDb.createCharacter.mockResolvedValue({ characterId: 'c1' });
    const r = await request(app).post('/api/characters').send(body(OWN));
    expect(r.status).toBe(201);
    expect(mockDb.createCharacter).toHaveBeenCalledWith('u1', expect.objectContaining({ referenceImageKey: OWN }));
  });

  it('accepts own keys whose filename contains two dots (Opslane P2)', () => {
    expect(isOwnUploadKey('users/u1/files/photo..final.png', 'u1')).toBe(true);
    expect(isOwnUploadKey('users/u1/files/./x', 'u1')).toBe(false);
  });

  it.each([FOREIGN, 'users/u1/files/../../u2/files/x', 'users/u10/files/x', 'other/key'])('rejects foreign key %s on create', async (key) => {
    const r = await request(app).post('/api/characters').send(body(key));
    expect(r.status).toBe(400);
    expect(mockDb.createCharacter).not.toHaveBeenCalled();
  });

  it('deletes the S3 object for an own-prefix key', async () => {
    mockDb.getCharacterById.mockResolvedValue({ userId: 'u1', referenceImageKey: OWN });
    const r = await request(app).delete('/api/characters/c1');
    expect(r.status).toBe(200);
    expect(mockDeleteObject).toHaveBeenCalledWith(expect.objectContaining({ Key: OWN }));
    expect(mockDb.deleteCharacter).toHaveBeenCalledWith('u1', 'c1');
  });

  it('does not delete a legacy foreign key but still removes the row', async () => {
    mockDb.getCharacterById.mockResolvedValue({ userId: 'u1', referenceImageKey: FOREIGN });
    const r = await request(app).delete('/api/characters/c1');
    expect(r.status).toBe(200);
    expect(mockDeleteObject).not.toHaveBeenCalled();
    expect(mockDb.deleteCharacter).toHaveBeenCalledWith('u1', 'c1');
  });
});
