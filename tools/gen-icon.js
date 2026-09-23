/* 生成插件图标 icon.png (160x160)
 * 纯 node 手写 PNG 编码，不引第三方依赖。
 * 图形：圆角方形底 + 白色云 + 向下箭头（与插件的 svg symbol 呼应）
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const S = 160;

/* ---------- 画布 ---------- */
const px = new Uint8Array(S * S * 4); // RGBA

function set(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  // 简单的 source-over 混合
  const sa = a / 255;
  px[i]     = Math.round(px[i]     * (1 - sa) + r * sa);
  px[i + 1] = Math.round(px[i + 1] * (1 - sa) + g * sa);
  px[i + 2] = Math.round(px[i + 2] * (1 - sa) + b * sa);
  px[i + 3] = Math.max(px[i + 3], a);
}

/** 带抗锯齿的填充：给定「点是否在形状内」的判定函数 */
function fill(inside, r, g, b, a = 255) {
  const SS = 3; // 每像素 3x3 超采样
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let hit = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = x + (sx + 0.5) / SS;
          const fy = y + (sy + 0.5) / SS;
          if (inside(fx, fy)) hit++;
        }
      }
      if (hit) set(x, y, r, g, b, Math.round(a * hit / (SS * SS)));
    }
  }
}

/* ---------- 形状定义 ---------- */
// 圆角方形（macOS/思源风格：半径约 22%）
function roundRect(x0, y0, x1, y1, rad) {
  return (x, y) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const cx = Math.min(Math.max(x, x0 + rad), x1 - rad);
    const cy = Math.min(Math.max(y, y0 + rad), y1 - rad);
    return (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad;
  };
}

// 云：几个圆的并集 + 底部矩形
function cloud(x, y) {
  const parts = [
    [58, 96, 26],   // 左
    [88, 78, 32],   // 中上
    [118, 94, 24],  // 右
  ];
  for (const [cx, cy, r] of parts) {
    if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) return true;
  }
  // 底部把三个圆连起来
  return x >= 46 && x <= 132 && y >= 96 && y <= 118 &&
         (x - 58) ** 2 + (y - 96) ** 2 <= 26 * 26 ||
         x >= 46 && x <= 132 && y >= 96 && y <= 118;
}

// 向下箭头（用在云下方）
function arrowDown(x, y) {
  // 箭杆
  if (x >= 74 && x <= 86 && y >= 70 && y <= 104) return true;
  // 箭头三角
  if (y >= 100 && y <= 130) {
    const halfW = (130 - y) * 0.95;
    if (Math.abs(x - 80) <= halfW) return true;
  }
  return false;
}

/* ---------- 绘制 ---------- */
// ① 底：渐变蓝的圆角方形
const bg = roundRect(6, 6, S - 6, S - 6, 34);
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    if (!bg(x + 0.5, y + 0.5)) continue;
    const t = (x + y) / (2 * S);          // 左上 → 右下
    const r = Math.round(0x2b + (0x1a - 0x2b) * t);
    const g = Math.round(0x6c + (0x9d - 0x6c) * t);
    const b = Math.round(0xd6 + (0xf0 - 0xd6) * t);
    set(x, y, r, g, b, 255);
  }
}

// ② 云（白色，半透明）
fill(cloud, 255, 255, 255, 235);

// ③ 箭头（深蓝，压在云上）
fill(arrowDown, 0x1a, 0x4d, 0xa8, 255);

/* ---------- PNG 编码 ---------- */
function crc32(buf) {
  let c, table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const body = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

// IHDR
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8;    // bit depth
ihdr[9] = 6;    // color type RGBA
ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

// 扫描线（每行前置一个 filter byte = 0）
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  Buffer.from(px.buffer, y * S * 4, S * 4).copy(raw, y * (S * 4 + 1) + 1);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = path.resolve(__dirname, "../icon.png");
fs.writeFileSync(out, png);
console.log(`已生成 ${out}  (${S}x${S}, ${png.length} 字节)`);
