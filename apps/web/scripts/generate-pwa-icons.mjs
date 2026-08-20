/**
 * Writes the three manifest icons as PNGs.
 *
 * Checked in as a script rather than as opaque binaries so the mark can be regenerated and
 * reviewed as code. No image dependency: PNG is a handful of chunks over a zlib stream.
 *
 *   node scripts/generate-pwa-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

const PAPER = [0xf3, 0xec, 0xdf];
const INK = [0x14, 0x18, 0x1d];

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixel) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  let offset = 0;
  for (let y = 0; y < size; y += 1) {
    raw[offset] = 0; // filter: none
    offset += 1;
    for (let x = 0; x < size; x += 1) {
      const [r, g, b] = pixel(x, y);
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      offset += 3;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * The mark: an envelope drawn as a rectangle and its fold. `inset` is the share of the canvas left
 * empty around it — a maskable icon has to survive a circular crop, so its art sits inside the
 * safe zone rather than filling the tile.
 */
function envelope(size, inset) {
  const left = Math.round(size * inset);
  const right = size - left;
  const height = Math.round((right - left) * 0.68);
  const top = Math.round((size - height) / 2);
  const bottom = top + height;
  const stroke = Math.max(2, Math.round(size * 0.035));

  return (x, y) => {
    const onVertical = (x >= left && x < left + stroke) || (x > right - stroke && x <= right);
    const onHorizontal = (y >= top && y < top + stroke) || (y > bottom - stroke && y <= bottom);
    const insideBox = x >= left && x <= right && y >= top && y <= bottom;
    if (insideBox && (onVertical || onHorizontal)) return INK;

    // The fold: two diagonals from the top corners meeting at the centre.
    if (insideBox) {
      const halfway = (right - left) / 2;
      const slope = height / 2 / halfway;
      const fromLeft = top + (x - left) * slope;
      const fromRight = top + (right - x) * slope;
      if (Math.abs(y - fromLeft) < stroke / 1.4 && x <= left + halfway) return INK;
      if (Math.abs(y - fromRight) < stroke / 1.4 && x > left + halfway) return INK;
    }
    return PAPER;
  };
}

mkdirSync(OUT_DIR, { recursive: true });

const icons = [
  { file: 'icon-192.png', size: 192, inset: 0.16 },
  { file: 'icon-512.png', size: 512, inset: 0.16 },
  // Maskable art keeps clear of the crop: 20% padding on every side.
  { file: 'icon-512-maskable.png', size: 512, inset: 0.26 },
];

for (const { file, size, inset } of icons) {
  writeFileSync(join(OUT_DIR, file), encodePng(size, envelope(size, inset)));
  process.stdout.write(`wrote ${file} (${size}x${size})\n`);
}
