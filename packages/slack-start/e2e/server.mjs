// Static server for e2e fixtures + the built bundle. No API: tests mock it with page.route.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] ?? 4319);
const types = { '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript' };

createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  if (path === '/health') return res.end('ok');
  const rel = path.startsWith('/dist/') ? path : join('/e2e/fixtures', path);
  const file = normalize(join(root, rel));
  if (!file.startsWith(root)) return res.writeHead(403).end();
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, '127.0.0.1');
