import { closeSync, constants, fstatSync, openSync, readSync } from 'fs';

export const MAX_DATASET_FILE_BYTES = 16 * 1024 * 1024;
/** Bound allocation and reject special files before reading; never trust a manifest's size. */
export function readDatasetFile(file: string, limit = MAX_DATASET_FILE_BYTES): Buffer {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error('Dataset file exceeds size limit or is not a regular file');
    const bytes = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
    let length = 0, count: number;
    while (length < bytes.length && (count = readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += count;
    if (length > stat.size || length > limit) throw new Error('Dataset file changed or exceeds size limit');
    return bytes.subarray(0, length);
  } finally { closeSync(fd); }
}
