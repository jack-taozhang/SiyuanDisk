/**
 * GitHub 凭据读取（供 tools/gh-*.mjs 共用）。
 *
 * ★ 为什么不能只用 `git credential fill` ★
 *   实测它**不稳定**：连续三次里会有一次**超时**（凭据助手 GCM 在非桌面 shell
 *   偶发卡住 —— 和 `git push` 挂死同一个根因）。发版工具不能有这种抖动。
 *
 * 读取顺序（前者优先）：
 *   1. `GITHUB_TOKEN` / `GH_TOKEN` 环境变量
 *   2. 仓库根的 `.gh-token` 文件（**已 gitignore**，一行纯 token）
 *      —— 本仓库已按此约定放好，发版走这条稳定路径
 *   3. `git credential fill`（遵从用户配置的 helper，带重试）—— 仅兜底
 *
 * ★ 用 `git credential fill` 而不是直接调某个 helper 可执行文件 ★
 *   前者遵从**用户自己配置的** credential.helper（GCM / store / 其它），
 *   脚本因此不绑定任何本机绝对路径。
 *
 * ★ 第 3 档用 spawnSync 是**不得已**（readGithubToken 必须同步返回）★
 *   本机沙箱下同步族子进程会 EBUSY（见 tools/pack.js 的同类修复），
 *   所以这里用 try/catch 包住：抛不出来就当"没拿到"，继续走失败分支，
 *   绝不让一次环境故障炸掉整个发布流程。
 */
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

const TOKEN_FILE = ".gh-token"

function fromEnv() {
  const v = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  return v && v.trim() ? v.trim() : null
}

function fromFile() {
  // 从仓库根跑（npm run）时 cwd 就是根；也兼容从 tools/ 里直接跑
  for (const p of [resolve(process.cwd(), TOKEN_FILE), resolve(process.cwd(), "..", TOKEN_FILE)]) {
    if (existsSync(p)) {
      const v = readFileSync(p, "utf8").trim()
      if (v) {
        return v
      }
    }
  }
  return null
}

function fromCredentialFill(attempts = 4) {
  for (let i = 1; i <= attempts; i++) {
    let res
    try {
      res = spawnSync("git", ["credential", "fill"], {
        input: "protocol=https\nhost=github.com\n\n",
        encoding: "utf8",
        timeout: 20000,
      })
    } catch {
      return null // 本机沙箱同步族子进程被拦（EBUSY / EPERM）⇒ 当作拿不到
    }
    const line = (res?.stdout || "").split("\n").find((l) => l.startsWith("password="))
    if (line) {
      return line.slice("password=".length).trim()
    }
    if (i < attempts) {
      console.log(`  …凭据助手第 ${i} 次未返回，重试`)
    }
  }
  return null
}

export function readGithubToken() {
  const env = fromEnv()
  if (env) {
    return env
  }
  const file = fromFile()
  if (file) {
    return file
  }
  const filled = fromCredentialFill()
  if (filled) {
    console.log(
      `  ⓘ 凭据来自 git credential fill（不稳定）。建议把它存到 ${TOKEN_FILE}（已 gitignore）以走稳定路径。`,
    )
    return filled
  }
  throw new Error(
    `取不到 GitHub 凭据。请任选其一：\n` +
      `  · 设环境变量 GITHUB_TOKEN\n` +
      `  · 在仓库根建 ${TOKEN_FILE}（一行纯 token；已 gitignore）\n` +
      `  · 确认 github.com 已登录过一次（凭据助手可用）`,
  )
}
