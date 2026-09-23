/**
 * 部署口令的统一入口 —— **仓库里不保存任何明文口令**。
 *
 * 解析顺序（先到先用）：
 *   1. 环境变量 NB_PASS
 *   2. tools/.nb-local.json   —— 格式 {"pass":"…"}，已被 .gitignore 排除
 *
 * 都没有则**立刻抛错**（fail fast），并说清怎么配，避免误以为"脚本坏了"。
 *
 * 为什么连单引号都要转义：
 *   这些口令会被拼进 `echo '…' | sudo -S` 之类的**远端命令字符串**里。
 *   若口令自身含单引号，不转义就会把 shell 的引号闭合、命令被截断 ——
 *   症状是"本地好好的、远端行为诡异"。所以统一走 shellSingleQuote()。
 *
 * 用法：
 *   const { PASS, PASS_SQ, SUDO, USER } = require("./_secrets.cjs");
 *   // 直接当密码用        → PASS
 *   // 拼进单引号上下文    → PASS_SQ （已含首尾单引号）
 *   // 远端 sudo 前缀      → SUDO    （末尾带空格，直接接命令）
 */
"use strict";

const fs = require("fs");
const path = require("path");

const LOCAL_FILE = path.join(__dirname, ".nb-local.json");

function loadLocal() {
  try {
    return JSON.parse(fs.readFileSync(LOCAL_FILE, "utf8"));
  } catch (e) {
    return {};
  }
}

const local = loadLocal();
const PASS = process.env.NB_PASS || local.pass || "";
const USER = process.env.NB_USER || local.user || "tao_zhang";
const HOST = process.env.NB_HOST || local.host || "172.16.30.128";

if (!PASS) {
  throw new Error(
    [
      "缺少部署口令。请任选一种方式提供（不要写进代码）：",
      "",
      "  1) 环境变量：",
      "       Bash      : export NB_PASS='你的口令'",
      "       PowerShell: $env:NB_PASS='你的口令'",
      "",
      "  2) 本地文件：",
      "       " + LOCAL_FILE,
      '       内容：{"pass":"你的口令"}',
      "",
      "  tools/.nb-local.json 与 .env 一样已被 .gitignore 排除，不会进仓库。",
      "  可参考 tools/.nb-local.json.example 复制一份。",
    ].join("\n")
  );
}

/** 单引号安全包裹：' → '\'' */
function shellSingleQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

const PASS_SQ = shellSingleQuote(PASS);

/** 拼好的远端 sudo 前缀（末尾带空格，可直接接命令） */
const SUDO = `echo ${PASS_SQ} | sudo -S -p '' `;

module.exports = { PASS, PASS_SQ, SUDO, USER, HOST, LOCAL_FILE };
