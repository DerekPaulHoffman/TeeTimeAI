import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';

if (!process.argv[2]) throw new Error('Pass the generated design-output directory.');
const root = resolve(process.argv[2]);
const port = Number(process.argv[3] || 4387);
const types = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.json': 'application/json' };
createServer(async (request, response) => {
  try {
    const path = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    const target = resolve(root, '.' + (path === '/' ? '/index.html' : path));
    if (!target.startsWith(root + sep) || !types[extname(target)]) {
      response.writeHead(404).end();
      return;
    }
    const body = await readFile(target);
    response.writeHead(200, { 'Content-Type': types[extname(target)], 'Cache-Control': 'no-store' });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
}).listen(port, '127.0.0.1', () => console.log(`Local email gallery: http://127.0.0.1:${port}`));
