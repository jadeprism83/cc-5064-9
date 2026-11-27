// Dumps RGBA Uint8Clamped frames as binary PPM (P6) for offline inspection.
// PPM keeps the toolchain dependency-free; open with any image viewer or
// convert with ImageMagick (`convert a.ppm a.png`).
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { WIDTH, HEIGHT } from '../src/scene.js';

export function writePPM(path, display, w = WIDTH, h = HEIGHT) {
  mkdirSync(dirname(path), { recursive: true });
  const header = Buffer.from(`P6\n${w} ${h}\n255\n`, 'ascii');
  const body = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    body[i * 3] = display[i * 4];
    body[i * 3 + 1] = display[i * 4 + 1];
    body[i * 3 + 2] = display[i * 4 + 2];
  }
  writeFileSync(path, Buffer.concat([header, body]));
}
