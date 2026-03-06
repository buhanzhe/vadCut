/**
 * 生成符合 electron-builder 要求的 ICO 图标（包含 16/32/48/256 四种尺寸）
 */
const fs = require('fs');
const path = require('path');

const BUILD_DIR = path.join(__dirname, '..', 'build');
if (!fs.existsSync(BUILD_DIR)) fs.mkdirSync(BUILD_DIR, { recursive: true });

function sign(p1x, p1y, p2x, p2y, p3x, p3y) {
  return (p1x - p3x) * (p2y - p3y) - (p2x - p3x) * (p1y - p3y);
}
function isInTriangle(px, py, ax, ay, bx, by, cx2, cy2) {
  const d1 = sign(px, py, ax, ay, bx, by);
  const d2 = sign(px, py, bx, by, cx2, cy2);
  const d3 = sign(px, py, cx2, cy2, ax, ay);
  const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
  const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);
  return !(hasNeg && hasPos);
}

function makeBmpData(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const cx = size / 2, cy = size / 2, r = size / 2 - 1;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const off = (y * size + x) * 4;
      const dx = x - cx, dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist > r) {
        pixels[off] = 0; pixels[off+1] = 0; pixels[off+2] = 0; pixels[off+3] = 0;
      } else {
        // 深蓝背景 #1a1a2e -> BGRA: 2e 1a 1a ff
        pixels[off] = 0x2e; pixels[off+1] = 0x1a; pixels[off+2] = 0x1a; pixels[off+3] = 0xff;

        // 播放三角形（白色）
        const pr = r * 0.55;
        const inTri = isInTriangle(x, y,
          cx - pr * 0.3, cy - pr * 0.6,
          cx - pr * 0.3, cy + pr * 0.6,
          cx + pr * 0.6, cy);
        if (inTri) {
          pixels[off] = 0xff; pixels[off+1] = 0xff; pixels[off+2] = 0xff; pixels[off+3] = 0xff;
        }
      }
    }
  }

  const maskSize = Math.ceil(size * size / 8);
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(size * size * 4, 20);

  // Flip rows (BMP is bottom-up)
  const flipped = Buffer.alloc(size * size * 4);
  for (let row = 0; row < size; row++) {
    pixels.copy(flipped, row * size * 4, (size - 1 - row) * size * 4, (size - row) * size * 4);
  }

  return Buffer.concat([header, flipped, Buffer.alloc(maskSize, 0)]);
}

function makeIco(sizes) {
  const bmps = sizes.map(s => makeBmpData(s));
  const headerSize = 6 + sizes.length * 16;
  let offset = headerSize;
  const offsets = bmps.map(b => { const o = offset; offset += b.length; return o; });

  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);

  for (let i = 0; i < sizes.length; i++) {
    const base = 6 + i * 16;
    const size = sizes[i];
    header.writeUInt8(size >= 256 ? 0 : size, base);
    header.writeUInt8(size >= 256 ? 0 : size, base + 1);
    header.writeUInt8(0, base + 2);
    header.writeUInt8(0, base + 3);
    header.writeUInt16LE(1, base + 4);
    header.writeUInt16LE(32, base + 6);
    header.writeUInt32LE(bmps[i].length, base + 8);
    header.writeUInt32LE(offsets[i], base + 12);
  }

  return Buffer.concat([header, ...bmps]);
}

const icoPath = path.join(BUILD_DIR, 'icon.ico');
fs.writeFileSync(icoPath, makeIco([16, 32, 48, 256]));
console.log(`✓ 图标已生成: ${icoPath} (${fs.statSync(icoPath).size} bytes, 含 16/32/48/256px)`);
