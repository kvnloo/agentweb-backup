/**
 * ENG-2315: GET /sdk/v1/aw.js — the tracker SDK, public and cacheable.
 *
 * The body is a string constant (src/sdk/awSdkSource.ts), not a file: `tsc` emits only what it
 * compiles and the deploy bundle ships `dist`, so this is in the artifact by construction.
 */
import express, { Request, Response } from 'express';
import * as crypto from 'crypto';
import { AW_SDK_SOURCE } from '../sdk/awSdkSource';
import { setCors } from './trackIngest';

const SDK_ETAG = `"${crypto.createHash('sha1').update(AW_SDK_SOURCE).digest('base64url')}"`;

export const sdkRouter = express.Router();
sdkRouter.get('/aw.js', (req: Request, res: Response) => {
  setCors(res);
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  // 5 minutes: a pasted <script> tag is on customers' pages we cannot edit, so a fix must reach
  // them quickly, but the file is requested on every page view and must not hit the origin each time.
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.setHeader('ETag', SDK_ETAG);
  if (req.headers['if-none-match'] === SDK_ETAG) {
    res.status(304).end();
    return;
  }
  res.status(200).send(AW_SDK_SOURCE);
});

export default sdkRouter;
