#!/usr/bin/env node
/* 打包 siyuan-nebuladisk 为思源可导入的 zip。
 *
 * 用法:
 *   node tools/pack.js              # 输出到 ../_dist-packages/
 *   node tools/pack.js <输出目录>    # 指定输出目录
 *
 * ★ 关键约定（思源插件包规范）★
 *   zip 内**顶层必须是一个目录**，目录名 == plugin.json 的 name，
 *   即 zip 里第一条路径是 `siyuan-nebuladisk/`。
 *   直接压平（顶层就是 plugin.json）思源认不出。
 *
 * ★ 只收运行必需的文件 ★
 *   不收：src/ test/ tools/ node_modules/ *.bak
 *   收：index.js(产物) index.css(产物) plugin.json icon.png i18n/ README*.md DEVELOPMENT.md
 *
 * ★★★ 最容易踩的坑：index.js 必须取【构建产物】★★★
 *   插件工程根目录的 index.js 是**分模块源码入口**（约 83KB，含 `import "./src/x.js"`）。
 *   思源加载的是**单文件打包产物**（约 487KB，代码里无相对 require）。
 *   取错对象 → 交付一个思源根本加载不起来的包，而且错误**只出现在浏览器 console**，
 *   siyuan.log 里什么都看不到。
 *   所以这里从 dist/（或本机思源环）取，并对此做**强断言**（见自检 3）。
 *
 * ★ 自检里判「有没有相对 require」必须先剥注释 ★
 *   产物里有 3 处 `require("./` 全在**注释**里，是在解释「为什么不能写相对 require」。
 *   不剥注释会把文档文字当代码，误判成"不是打包产物"。
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.resolve(__dirname, "..");
const NAME = JSON.parse(fs.readFileSync(path.join(ROOT, "plugin.json"), "utf8")).name;
const OUT_DIR = process.argv[2] || path.resolve(ROOT, "..", "_dist-packages");

// 产物来源候选（顺序即优先级）：仓库 dist/ → 本机思源安装位
const BUILT_CANDIDATES = [
  path.join(ROOT, "dist"),
  "D:/Software/SiYuan/data/plugins/siyuan-nebuladisk",
];

function pickBuiltDir() {
  for (const d of BUILT_CANDIDATES) {
    const js = path.join(d, "index.js");
    if (fs.existsSync(js) && fs.statSync(js).size > 200_000) return d;
  }
  return null;
}

const BUILT = pickBuiltDir();
if (!BUILT) {
  console.error("✗ 找不到有效的构建产物（index.js 应 >200KB）。请先运行：");
  console.error("    node tools/build.js --repo && node tools/build.js");
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "plugin.json"), "utf8"));
const VER = manifest.version;
const ZIP = path.join(OUT_DIR, `${NAME}-${VER}.zip`);

// （磁盘路径, zip 内相对名）
const ITEMS = [
  [path.join(BUILT, "index.js"), "index.js"], // ★ 产物
  [path.join(BUILT, "index.css"), "index.css"], // ★ 产物
  [path.join(ROOT, "plugin.json"), "plugin.json"],
  [path.join(ROOT, "icon.png"), "icon.png"],
  [path.join(ROOT, "README.md"), "README.md"],
  [path.join(ROOT, "README.zh_CN.md"), "README.zh_CN.md"],
  [path.join(ROOT, "DEVELOPMENT.md"), "DEVELOPMENT.md"],
  [path.join(ROOT, "REPORT-t67.md"), "REPORT-t67.md"],
  [path.join(ROOT, "i18n", "zh_CN.json"), "i18n/zh_CN.json"],
];

/* ---------------- 极简 ZIP 写入（store/deflate，无外部依赖） ---------------- */
function crc32(buf) {
  let c,
    crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const raw = e.data;
    const comp = zlib.deflateRawSync(raw, { level: 9 });
    const useDeflate = comp.length < raw.length;
    const data = useDeflate ? comp : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 flag
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuf, data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4); // version made by
    cen.writeUInt16LE(20, 6); // version needed
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0x21, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, eocd]);
}

/* ---------------- 组装 ---------------- */
const entries = [];
const missing = [];
for (const [src, rel] of ITEMS) {
  if (!fs.existsSync(src)) {
    missing.push(rel);
    continue;
  }
  entries.push({ name: `${NAME}/${rel}`, data: fs.readFileSync(src), src, rel });
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(ZIP, buildZip(entries));

console.log(`产物目录: ${BUILT}`);
const builtJs = fs.statSync(path.join(BUILT, "index.js")).size;
console.log(`   index.js  ${builtJs} 字节`);
console.log(`\n输出: ${ZIP}`);
console.log(`大小: ${fs.statSync(ZIP).size} 字节`);
for (const e of entries) {
  console.log(`   ${String(e.data.length).padStart(8)}  ${e.name}`);
}
if (missing.length) console.log("\n⚠️ 缺失（跳过）:", missing.join(", "));

/* ---------------- 自检 ---------------- */
let failed = 0;
function check(title, fn) {
  console.log(`\n=== ${title} ===`);
  try {
    fn();
  } catch (e) {
    console.log("   ❌ " + e.message);
    failed++;
  }
}

// 读回 zip 需要解析；这里用最小的读法：直接扫 local header 收集文件名与数据
function readZip(buf) {
  const out = new Map();
  let i = 0;
  while (i + 30 <= buf.length && buf.readUInt32LE(i) === 0x04034b50) {
    const method = buf.readUInt16LE(i + 8);
    const compSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.slice(i + 30, i + 30 + nameLen).toString("utf8");
    const dataStart = i + 30 + nameLen + extraLen;
    const data = buf.slice(dataStart, dataStart + compSize);
    out.set(name, method === 8 ? zlib.inflateRawSync(data) : data);
    i = dataStart + compSize;
  }
  return out;
}

const zipBuf = fs.readFileSync(ZIP);
const zf = readZip(zipBuf);

check("自检 1：顶层目录必须恰好是 plugin.json 的 name", () => {
  const tops = new Set([...zf.keys()].map((n) => n.split("/")[0]));
  if (tops.size !== 1 || !tops.has(NAME)) {
    throw new Error(`顶层集合应为 {${NAME}}，实际 {${[...tops].join(",")}}`);
  }
  console.log(`   ✅ 顶层唯一且等于 name = ${NAME}`);
});

check("自检 2：zip 内 plugin.json 与源逐字节一致", () => {
  const inzip = zf.get(`${NAME}/plugin.json`);
  const src = fs.readFileSync(path.join(ROOT, "plugin.json"));
  if (!inzip || !inzip.equals(src)) throw new Error("不一致");
  console.log(`   ✅ 一致（${src.length} 字节），version=${VER}`);
});

check("自检 3：index.js 必须是单文件产物（不是源码入口）", () => {
  const zjs = zf.get(`${NAME}/index.js`);
  if (!zjs) throw new Error("zip 内没有 index.js");
  console.log(`   zip 内 index.js = ${zjs.length} 字节`);
  if (zjs.length < 200_000) {
    throw new Error("太小！源码入口约 83KB，产物约 487KB —— 取错对象了");
  }
  // ★ 必须剥注释再判（产物注释里有 3 处 require("./ 是说明文字）
  const txt = zjs.toString("utf8");
  const stripped = txt.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const codeReq = (stripped.match(/require\(\s*["']\.\//g) || []).length;
  const codeFrom = (stripped.match(/\bfrom\s+["']\.\//g) || []).length;
  if (codeReq || codeFrom) {
    throw new Error(`代码里仍有相对模块引用 require=${codeReq} from=${codeFrom}`);
  }
  if (!stripped.includes("module.exports")) {
    throw new Error("没有 module.exports，思源加载不了");
  }
  const srcJs = fs.readFileSync(path.join(BUILT, "index.js"));
  if (!zjs.equals(srcJs)) throw new Error("与产物目录的 index.js 逐字节不一致");
  console.log(
    "   ✅ 单文件产物（>200KB、代码无相对 require、有 module.exports、与产物逐字节一致）",
  );
});

check("自检 4：必需文件齐备", () => {
  const need = [
    "index.js",
    "index.css",
    "plugin.json",
    "icon.png",
    "i18n/zh_CN.json",
    "README.md",
    "README.zh_CN.md",
    "DEVELOPMENT.md",
  ];
  const got = [...zf.keys()].map((n) => n.replace(`${NAME}/`, ""));
  const lack = need.filter((n) => !got.includes(n));
  if (lack.length) throw new Error("缺 " + lack.join(", "));
  console.log(`   ✅ 齐备：${need.join(", ")}`);
});

if (failed) {
  console.log(`\n❌ 自检失败 ${failed} 项`);
  process.exit(1);
}
console.log("\n全部自检通过 ✅");
