// Rebrands the Node single executable in place: draws the Optionwise icon into node.exe's existing icon slots
// and replaces its version block (the name Explorer and Task Manager show). No npm packages: a small PE resource
// walker, a rasterizer for the icon and a PNG encoder on top of zlib.
import zlib from 'node:zlib';

// ---- Icon artwork: a near-black tile with a teal glow and a payoff line (flat, then rising) ----
// Coordinates are in a 0..1 square. Matches public/icons (see the web-asset-generator source).
const TILE = [15, 15, 15], EDGE = [52, 52, 52], WHITE = [237, 237, 237], TEAL = [14, 196, 160];
const FLAT = [[0.19, 0.68], [0.46, 0.68]], RISE = [[0.46, 0.68], [0.8, 0.29]];

function segDist(px, py, [[ax, ay], [bx, by]]) {
  const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
function roundRectDist(px, py, r) { // signed distance to a rounded square inset slightly from the edges
  const inset = 0.03, h = 0.5 - inset, qx = Math.abs(px - 0.5) - h + r, qy = Math.abs(py - 0.5) - h + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

// Tile fill: dark vertical gradient with a soft teal glow towards the top right.
function tileColor(u, v) {
  const base = 26 - 12 * v, glow = Math.max(0, 1 - Math.hypot(u - 0.8, v - 0.3) / 0.6) * 0.28;
  return [base + (TEAL[0] - base) * glow, base + (TEAL[1] - base) * glow, base + 1 + (TEAL[2] - base) * glow];
}

// RGBA pixels, top row first. 4x4 supersampling for smooth edges.
export function drawIcon(size) {
  const px = Buffer.alloc(size * size * 4), n = 4;
  const stroke = size <= 24 ? 0.13 : 0.095, edge = Math.max(1 / size, 0.012);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < n; sy++) for (let sx = 0; sx < n; sx++) {
      const u = (x + (sx + 0.5) / n) / size, v = (y + (sy + 0.5) / n) / size;
      const d = roundRectDist(u, v, 0.22);
      if (d > 0) continue;
      let c = d > -edge ? EDGE : tileColor(u, v);
      if (segDist(u, v, RISE) < stroke / 2) c = TEAL;
      else if (segDist(u, v, FLAT) < stroke / 2) c = WHITE;
      r += c[0]; g += c[1]; b += c[2]; a++;
    }
    const i = (y * size + x) * 4;
    if (a) { px[i] = r / a; px[i + 1] = g / a; px[i + 2] = b / a; px[i + 3] = (255 * a) / (n * n); }
  }
  return px;
}

// ---- Encoders ----
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (buf) => { let c = -1; for (const x of buf) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); out.write(type, 4, 'latin1'); data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length); return out;
}
export function png(size, rgba) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
// Classic icon image: BITMAPINFOHEADER, bottom-up BGRA rows, then an all-zero AND mask (alpha does the work).
function dib(size, rgba) {
  const maskRow = Math.ceil(size / 32) * 4, out = Buffer.alloc(40 + size * size * 4 + maskRow * size);
  out.writeUInt32LE(40, 0); out.writeInt32LE(size, 4); out.writeInt32LE(size * 2, 8); out.writeUInt16LE(1, 12); out.writeUInt16LE(32, 14);
  out.writeUInt32LE(size * size * 4 + maskRow * size, 20);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const s = (y * size + x) * 4, d = 40 + ((size - 1 - y) * size + x) * 4;
    out[d] = rgba[s + 2]; out[d + 1] = rgba[s + 1]; out[d + 2] = rgba[s]; out[d + 3] = rgba[s + 3];
  }
  return out;
}

// VS_VERSIONINFO with one English/Unicode string table.
function versionInfo({ version, name, file, description, copyright }) {
  const [a = 0, b = 0, c = 0] = version.split('.').map(Number);
  const align = (buf) => Buffer.concat([buf, Buffer.alloc((4 - (buf.length % 4)) % 4)]);
  const wstr = (s) => Buffer.from(s + '\0', 'utf16le');
  const node = (key, value, children = [], type = 1) => {
    const head = Buffer.alloc(6), k = align(Buffer.concat([head, wstr(key)]));
    const val = value ? align(value) : Buffer.alloc(0);
    const body = Buffer.concat([k, val, ...children.map(align)]);
    body.writeUInt16LE(body.length, 0); body.writeUInt16LE(value ? (type === 1 ? value.length / 2 : value.length) : 0, 2); body.writeUInt16LE(type, 4);
    return body;
  };
  const fixed = Buffer.alloc(52);
  [0xfeef04bd, 0x10000, (a << 16) | b, c << 16, (a << 16) | b, c << 16, 0x3f, 0, 0x4, 0x1, 0, 0, 0].forEach((v, i) => fixed.writeUInt32LE(v >>> 0, i * 4));
  // No InternalName (optional, and Explorer does not show it): node.exe's slot is only 744 bytes, and without it a
  // two-digit version part (0.10.0) still fits with room to spare.
  const strings = { CompanyName: name, FileDescription: description, FileVersion: version, LegalCopyright: copyright, OriginalFilename: file, ProductName: name, ProductVersion: version };
  const table = node('040904B0', null, Object.entries(strings).map(([k, v]) => node(k, wstr(v))));
  const sfi = node('StringFileInfo', null, [table]);
  const vfi = node('VarFileInfo', null, [node('Translation', Buffer.from([0x09, 0x04, 0xb0, 0x04]), [], 0)]);
  return node('VS_VERSION_INFO', fixed, [sfi, vfi], 0);
}

// ---- PE resource walker ----
function resources(exe) {
  const pe = exe.readUInt32LE(0x3c), nsec = exe.readUInt16LE(pe + 6), optSize = exe.readUInt16LE(pe + 20), opt = pe + 24;
  const rsrcRva = exe.readUInt32LE(opt + (exe.readUInt16LE(opt) === 0x20b ? 112 : 96) + 2 * 8);
  const secs = Array.from({ length: nsec }, (_, i) => { const s = opt + optSize + i * 40; return { va: exe.readUInt32LE(s + 12), size: Math.max(exe.readUInt32LE(s + 8), exe.readUInt32LE(s + 16)), raw: exe.readUInt32LE(s + 20) }; });
  const off = (rva) => { const s = secs.find((s) => rva >= s.va && rva < s.va + s.size); return rva - s.va + s.raw; };
  const base = off(rsrcRva), found = [];
  const walk = (o, path) => {
    const n = exe.readUInt16LE(o + 12) + exe.readUInt16LE(o + 14);
    for (let i = 0; i < n; i++) {
      const e = o + 16 + i * 8, id = exe.readUInt32LE(e), to = exe.readUInt32LE(e + 4), key = id & 0x80000000 ? -1 : id;
      if (to & 0x80000000) walk(base + (to & 0x7fffffff), [...path, key]);
      else { const entry = base + to; found.push({ type: path[0], id: path[1], entry, data: off(exe.readUInt32LE(entry)), size: exe.readUInt32LE(entry + 4) }); }
    }
  };
  walk(base, []);
  return found;
}
function put(exe, res, data, what) {
  if (data.length > res.size) throw new Error(`${what} is ${data.length} bytes, the slot holds ${res.size}`);
  exe.fill(0, res.data, res.data + res.size); data.copy(exe, res.data); exe.writeUInt32LE(data.length, res.entry + 4);
}

export function rebrand(exe, meta) {
  const all = resources(exe);
  const group = all.find((r) => r.type === 14);
  const icons = new Map(all.filter((r) => r.type === 3).map((r) => [r.id, r]));
  const count = exe.readUInt16LE(group.data + 4);
  for (let i = 0; i < count; i++) {
    const e = group.data + 6 + i * 14, size = exe[e] || 256, id = exe.readUInt16LE(e + 12), res = icons.get(id);
    const rgba = drawIcon(size), img = size >= 256 ? png(size, rgba) : dib(size, rgba);
    put(exe, res, img, `${size}px icon`);
    exe.writeUInt16LE(1, e + 4); exe.writeUInt16LE(32, e + 6); exe.writeUInt32LE(img.length, e + 8);
  }
  put(exe, all.find((r) => r.type === 16), versionInfo(meta), 'Version info');
}
