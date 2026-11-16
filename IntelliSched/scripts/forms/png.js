// A small PNG reader for the forms' measurements (Phase 8 Part 9): zlib from Node, the five PNG row
// filters, any 8-bit colour type turned into one grey byte per pixel. No new package.
const fs = require('fs');
const zlib = require('zlib');

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const readPng = (file) => {
  const buf = fs.readFileSync(file);
  let pos = 8;
  let width = 0; let height = 0; let depth = 8; let colorType = 6; let palette = null;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; colorType = data[9];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (depth !== 8) throw new Error(`${file}: only 8-bit PNGs are read (depth ${depth})`);
  const ch = CHANNELS[colorType];
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * ch;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? out[dst + x - ch] : 0;
      const b = y > 0 ? out[dst - stride + x] : 0;
      const c = x >= ch && y > 0 ? out[dst - stride + x - ch] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[dst + x] = v & 255;
    }
  }
  const grey = Buffer.alloc(width * height);
  for (let i = 0; i < width * height; i++) {
    const o = i * ch;
    let r; let g; let bl; let alpha = 255;
    if (colorType === 3) { const p = out[o] * 3; r = palette[p]; g = palette[p + 1]; bl = palette[p + 2]; }
    else if (ch <= 2) { r = g = bl = out[o]; if (ch === 2) alpha = out[o + 1]; }
    else { r = out[o]; g = out[o + 1]; bl = out[o + 2]; if (ch === 4) alpha = out[o + 3]; }
    const v = (r * 299 + g * 587 + bl * 114) / 1000;
    grey[i] = Math.round(255 - (alpha / 255) * (255 - v));
  }
  return { width, height, grey };
};

module.exports = { readPng };
