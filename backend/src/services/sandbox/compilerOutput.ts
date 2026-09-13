import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { parse, resolve, sep } from 'path';

/** Pin each directory with O_NOFOLLOW. Node has no openat binding; Linux procfs
 * provides descriptor-relative paths. Fail closed on hosts without that facility.
 * Rename replaces a raced leaf symlink instead of following it; existing hard
 * links are replaced too, so frozen packet bytes can never be overwritten. */
export function withCompilerOutput(output: string, packet: string, write: (put: (name: string, bytes: string | Buffer) => void) => void): void {
  const destination = resolve(output), packetRoot = realpathSync(packet);
  const outside = (directory: string) => {
    if (directory === packetRoot || directory.startsWith(packetRoot + sep)) throw new Error('Output must be outside the frozen packet');
  };
  outside(destination);
  if (process.platform !== 'linux') throw new Error('Safe compiler file output requires Linux /proc/self/fd; use stdout on other hosts');
  const descriptors: number[] = [];
  const pin = (directory: string) => {
    const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    descriptors.push(fd);
    if (!fstatSync(fd).isDirectory()) throw new Error('Unsafe output directory');
    return fd;
  };
  const at = (fd: number, name = '') => `/proc/self/fd/${fd}${name ? '/' + name : ''}`;
  const child = (fd: number, name: string) => {
    try { mkdirSync(at(fd, name), { mode: 0o700 }); } catch (error: any) { if (error.code !== 'EEXIST') throw error; }
    return pin(at(fd, name));
  };
  try {
    let directory = pin(parse(destination).root);
    for (const component of destination.slice(parse(destination).root.length).split(sep).filter(Boolean)) directory = child(directory, component);
    outside(realpathSync(at(directory)));
    const put = (name: string, bytes: string | Buffer) => {
      if (!/^(dataset\.json|reconciliation\.json|assets\/[a-f0-9]{64}\.png)$/.test(name)) throw new Error('Unsafe compiled output path');
      const parts = name.split('/'), leaf = parts.pop()!;
      let parent = directory;
      for (const component of parts) parent = child(parent, component);
      outside(realpathSync(at(parent)));
      const target = at(parent, leaf);
      try {
        if (!lstatSync(target).isFile()) throw new Error('Unsafe compiled output target');
      } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
      const temporary = at(parent, `.compile-${randomUUID()}`);
      const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        try { writeFileSync(fd, bytes); } finally { closeSync(fd); }
        renameSync(temporary, target);
      } finally {
        try { unlinkSync(temporary); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
      }
    };
    write(put);
  } finally { for (const fd of descriptors.reverse()) closeSync(fd); }
}
