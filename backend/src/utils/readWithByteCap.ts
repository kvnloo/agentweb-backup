/**
 * ENG-2840: read a download's body up to `maxBytes`, without ever holding more than that in memory.
 *
 * Used for Google Drive downloads (knowledge-base file reads and asset materialization), whose reported size can be missing or 0 (for
 * example during a virus scan), so the size cannot be trusted before the download. The body is requested as a stream and read here:
 *  - more than `maxBytes` arrive: the stream is destroyed (the download stops) and the answer is null;
 *  - the stream ends: the bytes read;
 *  - the stream errors, or closes without ending: an error (a short download must not pass as a complete file).
 * A body that is already bytes (some transports, and tests) is measured as is. Anything else is an error.
 */
export async function readWithByteCap(body: unknown, maxBytes: number): Promise<Buffer | null> {
  if (Buffer.isBuffer(body)) return body.length > maxBytes ? null : body;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    const buffer = Buffer.from(body as any);
    return buffer.length > maxBytes ? null : buffer;
  }
  if (typeof body === 'string') {
    const buffer = Buffer.from(body);
    return buffer.length > maxBytes ? null : buffer;
  }
  const stream = body as NodeJS.ReadableStream & { destroy?: (error?: Error) => void };
  if (!stream || typeof (stream as any).on !== 'function') {
    throw new Error('The download returned no readable body');
  }
  return new Promise<Buffer | null>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    stream.on('data', (chunk: Buffer | string) => {
      if (done) return;
      const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += piece.length;
      if (total > maxBytes) {
        done = true;
        chunks.length = 0;
        stream.destroy?.();
        resolve(null);
        return;
      }
      chunks.push(piece);
    });
    stream.on('end', () => {
      if (!done) { done = true; resolve(Buffer.concat(chunks)); }
    });
    stream.on('error', (error: Error) => {
      if (!done) { done = true; reject(error); }
    });
    stream.on('close', () => {
      if (!done) { done = true; reject(new Error('The download ended before it was complete')); }
    });
  });
}
