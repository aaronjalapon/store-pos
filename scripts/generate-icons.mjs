import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const appIconSizes = [192, 512];
for (const size of appIconSizes) {
  writeFileSync(resolve(`apps/web/public/icon-${size}.png`), encodePng(size, size, createIconPixels(size)));
}

const faviconPngs = [16, 32, 48].map((size) => encodePng(size, size, createIconPixels(size)));
writeFileSync(resolve('apps/web/public/favicon.ico'), encodeIco(faviconPngs));

function createIconPixels(size) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = (y * size + x) * 4;
      const radius = size * 0.19;
      const outsideCorner = (x < radius && y < radius && Math.hypot(x - radius, y - radius) > radius)
        || (x > size - radius && y < radius && Math.hypot(x - (size - radius), y - radius) > radius)
        || (x < radius && y > size - radius && Math.hypot(x - radius, y - (size - radius)) > radius)
        || (x > size - radius && y > size - radius && Math.hypot(x - (size - radius), y - (size - radius)) > radius);
      const color = outsideCorner ? [247, 245, 239, 255] : [17, 97, 73, 255];
      pixels.set(color, index);
    }
  }
  const cream = [247, 245, 239, 255];
  const stroke = Math.round(size * 0.075);
  const cx = size / 2;
  const cy = size / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const distance = Math.hypot(x - cx, y - cy);
      const ring = distance > size * 0.22 && distance < size * 0.34;
      const rightOpening = x > cx + size * 0.05 && Math.abs(y - cy) < size * 0.11;
      const crossbar = x > cx && x < cx + size * 0.29 && Math.abs(y - cy) < stroke / 2;
      const innerStem = x > cx + size * 0.19 && x < cx + size * 0.29 && y > cy && y < cy + size * 0.22;
      if ((ring && !rightOpening) || crossbar || innerStem) pixels.set(cream, (y * size + x) * 4);
    }
  }
  return pixels;
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function encodeIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);

  const entries = [];
  let offset = header.length + pngs.length * 16;
  for (const png of pngs) {
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    const entry = Buffer.alloc(16);
    entry.writeUInt8(width >= 256 ? 0 : width, 0);
    entry.writeUInt8(height >= 256 ? 0 : height, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += png.length;
  }

  return Buffer.concat([header, ...entries, ...pngs]);
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length, 0); name.copy(output, 4); data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8);
  return output;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
