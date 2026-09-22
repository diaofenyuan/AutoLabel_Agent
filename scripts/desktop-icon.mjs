import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const size = 256;
const rows = Buffer.alloc((size * 4 + 1) * size);
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
  const i = y * (size * 4 + 1) + 1 + x * 4;
  const dx = Math.max(0, 44 - x, x - 211), dy = Math.max(0, 44 - y, y - 211);
  const inside = dx * dx + dy * dy <= 44 * 44;
  const white = (x >= 63 && x <= 76 && ((y >= 65 && y <= 111) || (y >= 145 && y <= 190)))
    || (x >= 179 && x <= 192 && ((y >= 65 && y <= 111) || (y >= 145 && y <= 190)))
    || (y >= 65 && y <= 78 && ((x >= 63 && x <= 109) || (x >= 146 && x <= 192)))
    || (y >= 177 && y <= 190 && ((x >= 63 && x <= 109) || (x >= 146 && x <= 192)))
    || ((x - 128) ** 2 + (y - 128) ** 2 < 19 ** 2);
  rows[i] = white ? 255 : 38; rows[i + 1] = white ? 255 : 86; rows[i + 2] = white ? 255 : 228; rows[i + 3] = inside ? 255 : 0;
}
const crc = data => { let c = -1; for (const value of data) { c ^= value; for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (c ^ -1) >>> 0; };
const chunk = (kind, data) => { const name = Buffer.from(kind); const out = Buffer.alloc(data.length + 12); out.writeUInt32BE(data.length); name.copy(out, 4); data.copy(out, 8); out.writeUInt32BE(crc(Buffer.concat([name, data])), data.length + 8); return out; };
const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
const ico = Buffer.alloc(22); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4); ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12); ico.writeUInt32LE(png.length, 14); ico.writeUInt32LE(22, 18);
const output = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../packaging');
await mkdir(output, { recursive: true });
await writeFile(path.join(output, 'icon.png'), png); await writeFile(path.join(output, 'icon.ico'), Buffer.concat([ico, png]));
