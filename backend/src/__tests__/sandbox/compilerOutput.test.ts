import fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { withCompilerOutput } from '../../services/sandbox/compilerOutput';
import { MAX_DATASET_FILE_BYTES, readDatasetFile } from '../../services/sandbox/datasetFiles';

let root: string, packet: string, output: string;
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'sandbox-output-'));
  packet = join(root, 'packet'); output = join(root, 'output');
  fs.mkdirSync(packet); fs.mkdirSync(output);
  fs.writeFileSync(join(packet, 'frozen'), 'unchanged');
});
afterEach(() => { jest.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
it.each(['root', 'ancestor', 'assets', 'dataset.json', 'reconciliation.json'])('rejects a symlinked %s without touching the packet', target => {
  if (target === 'root') { fs.rmdirSync(output); fs.symlinkSync(packet, output); }
  else if (target === 'ancestor') { fs.rmdirSync(output); fs.symlinkSync(packet, output); output = join(output, 'child'); }
  else fs.symlinkSync(target === 'assets' ? packet : join(packet, 'frozen'), join(output, target));
  expect(() => withCompilerOutput(output, packet, put => {
    put(target === 'assets' ? `assets/${'a'.repeat(64)}.png` : target.endsWith('.json') ? target : 'dataset.json', 'changed');
  })).toThrow();
  expect(fs.readFileSync(join(packet, 'frozen'), 'utf8')).toBe('unchanged');
  expect(fs.readdirSync(packet)).toEqual(['frozen']);
});
it('pins parent directories across a symlink swap before writing', () => {
  const open = fs.openSync;
  let swapped = false;
  jest.spyOn(fs, 'openSync').mockImplementation(((file: any, flags: any, mode: any) => {
    if (!swapped && String(file).includes('/.compile-')) {
      swapped = true;
      fs.renameSync(output, `${output}-old`);
      fs.symlinkSync(packet, output);
    }
    return open(file, flags, mode);
  }) as any);
  withCompilerOutput(output, packet, put => put('dataset.json', 'compiled'));
  expect(swapped).toBe(true);
  expect(fs.readdirSync(packet)).toEqual(['frozen']);
  expect(fs.readFileSync(join(`${output}-old`, 'dataset.json'), 'utf8')).toBe('compiled');
});
it('replaces a raced leaf symlink and existing hard links without following them', () => {
  fs.linkSync(join(packet, 'frozen'), join(output, 'dataset.json'));
  withCompilerOutput(output, packet, put => put('dataset.json', 'compiled'));
  const rename = fs.renameSync;
  jest.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
    fs.unlinkSync(target); fs.symlinkSync(join(packet, 'frozen'), target);
    return rename(source, target);
  });
  withCompilerOutput(output, packet, put => put('dataset.json', 'new'));
  expect(fs.readFileSync(join(packet, 'frozen'), 'utf8')).toBe('unchanged');
  expect(fs.readFileSync(join(output, 'dataset.json'), 'utf8')).toBe('new');
});
it('rejects packet destinations and traversal keys', () => {
  expect(() => withCompilerOutput(packet, packet, () => {})).toThrow(/outside/);
  expect(() => withCompilerOutput(output, packet, put => put('../packet/frozen', 'changed'))).toThrow(/Unsafe/);
});
it('rejects oversized sparse files and nonregular files before allocating their contents', () => {
  const file = join(root, 'huge');
  fs.writeFileSync(file, ''); fs.truncateSync(file, MAX_DATASET_FILE_BYTES + 1);
  expect(() => readDatasetFile(file)).toThrow(/size limit/);
  expect(() => readDatasetFile(packet)).toThrow(/regular/);
});

it.each(['write', 'close', 'rename'])('preserves the first %s failure through file and directory cleanup failures', stage => {
  fs.writeFileSync(join(output, 'dataset.json'), 'previous');
  const primary = new Error(`${stage} failed`), cleanup = new Error('cleanup failed');
  const close = fs.closeSync;
  const openedDirectories = new Set<number>(), closedDirectories = new Set<number>();
  const open = fs.openSync;
  jest.spyOn(fs, 'openSync').mockImplementation(((file: any, flags: any, mode: any) => {
    const fd = open(file, flags, mode);
    if (fs.fstatSync(fd).isDirectory()) openedDirectories.add(fd);
    return fd;
  }) as any);
  if (stage === 'write') jest.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => { throw primary; });
  if (stage === 'rename') jest.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw primary; });
  jest.spyOn(fs, 'closeSync').mockImplementation(fd => {
    const directory = fs.fstatSync(fd).isDirectory();
    close(fd);
    if (directory) { closedDirectories.add(fd); throw cleanup; }
    if (stage !== 'rename') throw stage === 'close' ? primary : cleanup;
  });
  jest.spyOn(fs, 'unlinkSync').mockImplementationOnce(() => { throw cleanup; });
  expect(() => withCompilerOutput(output, packet, put => put('dataset.json', 'replacement'))).toThrow(primary);
  expect(closedDirectories).toEqual(openedDirectories);
  jest.restoreAllMocks();
  expect(fs.readFileSync(join(output, 'dataset.json'), 'utf8')).toBe('previous');
});

it.each([undefined, null, false, 0, ''])('preserves a falsy primary failure (%s) and never publishes the failed write', primary => {
  fs.writeFileSync(join(output, 'dataset.json'), 'previous');
  jest.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => { throw primary; });
  jest.spyOn(fs, 'unlinkSync').mockImplementationOnce(() => { throw new Error('cleanup failed'); });
  let caught = false;
  try { withCompilerOutput(output, packet, put => put('dataset.json', 'replacement')); }
  catch (error) { caught = true; expect(error).toBe(primary); }
  expect(caught).toBe(true);
  expect(fs.readFileSync(join(output, 'dataset.json'), 'utf8')).toBe('previous');
});

it.each(['unlink', 'directory close'])('surfaces %s cleanup failure when publication succeeded', stage => {
  const cleanup = new Error(`${stage} failed`);
  if (stage === 'unlink') jest.spyOn(fs, 'unlinkSync').mockImplementationOnce(() => { throw cleanup; });
  else {
    const close = fs.closeSync;
    jest.spyOn(fs, 'closeSync').mockImplementation(fd => {
      const directory = fs.fstatSync(fd).isDirectory();
      close(fd);
      if (directory) throw cleanup;
    });
  }
  expect(() => withCompilerOutput(output, packet, put => put('dataset.json', 'compiled'))).toThrow(cleanup);
  jest.restoreAllMocks();
  expect(fs.readFileSync(join(output, 'dataset.json'), 'utf8')).toBe('compiled');
});
