// Zero-dependency static server for the VRS graphical entry point.
// The raster debug window (index.html) is the primary VRS interface; the CLI
// tools only assist it. Run: npm run serve  (or: node tools/serve.mjs)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const PORT = Number(process.env.PORT) || 8080;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.css': 'text/css',
  '.ppm': 'image/x-portable-pixmap',
};

const server = createServer(async (req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const safe = normalize(urlPath === '/' ? '/index.html' : urlPath).replace(/^(\.\.[/\\])+/, '');
  try {
    const data = await readFile(join(ROOT, safe));
    res.writeHead(200, { 'Content-Type': MIME[extname(safe)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
});

server.listen(PORT, () => {
  console.log(`VRS raster debug window: http://127.0.0.1:${PORT}/`);
});
