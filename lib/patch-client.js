/**
 * dsh-enhancer 客户端/宿主补丁集
 *
 * 1. **缓存命中率显示精度** — dsh-client-ui-conversation 的 cacheHitPercent 用
 *    Math.round 取整到整数百分数，导致 95.6% 显示为 96%、99.5% 显示为 100%。
 *    改为保留两位小数（95.60%）。
 * 2. **图片准入放行** — DSH 内置 DeepSeek 适配器把所有模型声明为
 *    `inputModalities: ["text"]`，因此：
 *      - dsh-host-apiproxy 在提交含图 prompt 时拒绝（"does not support image
 *        input"，GUI 提示"当前模型不支持图片"）；
 *      - dsh-tool-fs 的读图工具同样拒绝。
 *    本补丁放行这些检查（图片请求由插件在 llm/stream 瀑布处直接请求中转，
 *    实测 14 个模型中 13 个支持图片）。
 * 3. **原生目录选择器 UTF-16 路径截断** — Windows 原生文件夹选择器
 *    （dsh-host-directory-picker-native 的 IFileOpenDialog worker）读取选中
 *    路径时，NUL 扫描只看每个 UTF-16 码元的第 1 个字节：低字节为 0x00 的
 *    字符（码位为 256 整数倍，如「销」U+9500）被误判为字符串结尾，路径
 *    被截断（"H:\...\核销" → "H:\...\核"），添加工作区报
 *    workspace-invalid-path / realpath ENOENT。补丁改为仅当完整 0x0000
 *    码元出现时才结束扫描。
 *
 * 所有补丁幂等：已打补丁的文件跳过；首次打补丁前自动备份为
 * <file>.dsh-enhancer.bak。补丁直接修改 host 侧 node_modules 中的 bundle 文件，
 * 重启 dsh（浏览器硬刷新）后生效。
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

/** Exact source expression produced by the conversation bundle. */
const CACHE_HIT_OLD = 'Math.round(usage.cacheReadTokens / denominator * 100)'
/** Two-decimal replacement. */
const CACHE_HIT_NEW = 'Math.round(usage.cacheReadTokens / denominator * 10000) / 100'
/** Marker embedded in image-admission replacements so "already patched" is unambiguous. */
const IMAGE_MARKER = '/*dsh-enhancer:image-admission*/'
/** Marker embedded in the UTF-16 terminator replacement so "already patched" is unambiguous. */
const UTF16_MARKER = '/*dsh-enhancer:utf16-terminator*/'
const BACKUP_SUFFIX = '.dsh-enhancer.bak'

/** Candidate roots (dsh main install + DSH_HOME) used to locate bundle files. */
function candidateRoots() {
  const roots = []
  const execDir = dirname(process.execPath)
  roots.push(
    join(execDir, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'),
    join(execDir, 'node_modules', '@deepseek-ai'),
  )
  const home = process.env.DSH_HOME ?? join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.dsh')
  roots.push(join(home, 'profiles', 'web', 'node_modules', '.pnpm', 'node_modules', '@deepseek-ai'))
  return roots
}

/** Locate one package-relative file across candidate roots. */
function locatePackageFile(relParts) {
  const rel = join(...relParts)
  for (const root of candidateRoots()) {
    try {
      const candidate = join(root, rel)
      if (existsSync(candidate)) return candidate
    } catch {
      /* keep probing */
    }
  }
  return undefined
}

/** Try to locate the conversation client bundle through module resolution. */
export function locateClientBundleViaRequire() {
  // module resolution from this plugin's position first
  try {
    const require = createRequire(import.meta.url)
    const pkgJson = require.resolve('@deepseek-ai/dsh-client-ui-conversation/package.json')
    const candidate = join(dirname(pkgJson), 'lib', 'client.js')
    if (existsSync(candidate)) return candidate
  } catch {
    /* not resolvable from this module */
  }
  return locatePackageFile(['dsh-client-ui-conversation', 'lib', 'client.js'])
}

/** Locate the host-apiproxy bundle (primary entry). */
export function locateHostApiproxyBundle() {
  return locatePackageFile(['dsh-host-apiproxy', 'lib', 'index.js'])
}

/** Locate the host-apiproxy type-layer copy (secondary entry). */
export function locateHostApiproxyTypesBundle() {
  return locatePackageFile(['dsh-host-apiproxy', 'lib', 'types', 'api-proxy.js'])
}

/** Locate the tool-fs bundle. */
export function locateToolFsBundle() {
  return locatePackageFile(['dsh-tool-fs', 'lib', 'index.js'])
}

/** Locate the native directory-picker worker bundle (Win32 folder dialog). */
export function locateNativePickerWorker() {
  return locatePackageFile(['dsh-host-directory-picker-native', 'lib', 'worker.cjs'])
}

/** Apply one expression-replacement patch with backup + idempotency. */
function applyExpressionPatch(file, oldExpr, newExpr, marker) {
  const source = readFileSync(file, 'utf8')
  if (marker !== undefined && source.includes(marker)) return 'already'
  if (!source.includes(oldExpr)) {
    if (source.includes(newExpr)) return 'already'
    throw new Error(`expected expression not found in ${file}`)
  }
  const backup = `${file}${BACKUP_SUFFIX}`
  if (!existsSync(backup)) copyFileSync(file, backup)
  writeFileSync(file, source.replace(oldExpr, newExpr), 'utf8')
  return 'patched'
}

/**
 * Apply the cache-hit precision patch to one conversation bundle file.
 * @param file - absolute path of dsh-client-ui-conversation/lib/client.js.
 * @returns 'patched' | 'already'
 * @throws when the file is missing or the expected expression cannot be found.
 */
export function applyClientPatch(file) {
  return applyExpressionPatch(file, CACHE_HIT_OLD, CACHE_HIT_NEW)
}

/** Image-admission patches: id → { file locator, old expression }. */
const IMAGE_PATCHES = [
  {
    id: 'host-apiproxy',
    file: locateHostApiproxyBundle,
    old: '!modelInfo.inputModalities.includes("image")',
  },
  {
    id: 'host-apiproxy-types',
    file: locateHostApiproxyTypesBundle,
    old: "!modelInfo.inputModalities.includes('image')",
  },
  {
    id: 'tool-fs',
    file: locateToolFsBundle,
    old: 'active.inputModalities === void 0 || !active.inputModalities.includes("image")',
  },
]

/**
 * Apply every image-admission patch (host-apiproxy ×2, tool-fs).
 * @returns per-id outcomes; throws on the first patch whose file cannot be
 *   located or whose expression does not match.
 */
export function applyImageAdmissionPatches() {
  const outcomes = {}
  for (const patch of IMAGE_PATCHES) {
    const file = patch.file()
    if (file === undefined) throw new Error(`cannot locate bundle for patch "${patch.id}"`)
    outcomes[patch.id] = applyExpressionPatch(file, patch.old, `false ${IMAGE_MARKER}`, IMAGE_MARKER)
  }
  return outcomes
}

/**
 * Exact source expression produced by the native picker worker's `readUtf16`
 * NUL scan: it checks only the FIRST byte of each UTF-16 code unit, so any
 * character whose low byte is 0x00 (code points ≡ 0 mod 256 — e.g. 销 U+9500,
 * 一 U+4E00) is mistaken for the string terminator and the path is truncated
 * ("H:\...\核销" → "H:\...\核", workspace add then fails with
 * workspace-invalid-path / realpath ENOENT).
 */
const UTF16_SCAN_OLD = '\twhile (end + 1 < bytes.length && bytes[end] !== 0) end += 2;'
/** Two-byte check: only a complete 0x0000 code unit ends the string. */
const UTF16_SCAN_NEW = `\t${UTF16_MARKER} while (end + 1 < bytes.length && !(bytes[end] === 0 && bytes[end + 1] === 0)) end += 2;`

/**
 * Apply the UTF-16 terminator patch to one native picker worker file.
 * @param file - absolute path of dsh-host-directory-picker-native/lib/worker.cjs.
 * @returns 'patched' | 'already'
 * @throws when the file is missing or the expected expression cannot be found.
 */
export function applyUtf16TerminatorPatch(file) {
  return applyExpressionPatch(file, UTF16_SCAN_OLD, UTF16_SCAN_NEW, UTF16_MARKER)
}

/**
 * Apply the UTF-16 terminator patch to every located native picker worker.
 * @returns per-file outcomes; throws when no worker file can be located.
 */
export function applyUtf16TerminatorPatches() {
  const file = locateNativePickerWorker()
  if (file === undefined) throw new Error('cannot locate dsh-host-directory-picker-native/lib/worker.cjs')
  return { worker: applyUtf16TerminatorPatch(file) }
}

/** Apply every patch this plugin owns; returns a summary string. */
export function applyAllPatches() {
  const lines = []
  const conversation = locateClientBundleViaRequire()
  if (conversation === undefined) {
    lines.push('cache-hit: bundle not located')
  } else {
    lines.push(`cache-hit: ${applyClientPatch(conversation)}`)
  }
  try {
    const image = applyImageAdmissionPatches()
    for (const [id, outcome] of Object.entries(image)) lines.push(`image-admission(${id}): ${outcome}`)
  } catch (error) {
    lines.push(`image-admission: ${error.message}`)
  }
  try {
    const utf16 = applyUtf16TerminatorPatches()
    for (const [id, outcome] of Object.entries(utf16)) lines.push(`utf16-terminator(${id}): ${outcome}`)
  } catch (error) {
    lines.push(`utf16-terminator: ${error.message}`)
  }
  return lines.join('\n')
}

/** CLI entry: `node scripts/patch-client.mjs [--all] [--revert] [--file <path>]`. */
export async function runCli(argv) {
  const args = [...argv]
  if (args.includes('--revert')) {
    for (const file of [locateClientBundleViaRequire(), locateHostApiproxyBundle(), locateHostApiproxyTypesBundle(), locateToolFsBundle(), locateNativePickerWorker()]) {
      if (file === undefined) continue
      const backup = `${file}${BACKUP_SUFFIX}`
      if (!existsSync(backup)) continue
      copyFileSync(backup, file)
      console.log(`patch-client: reverted ${file}`)
    }
    process.exit(0)
  }
  if (args.includes('--file')) {
    const fileFlag = args.indexOf('--file')
    const file = args[fileFlag + 1]
    if (file === undefined) {
      console.error('patch-client: --file requires a path')
      process.exit(1)
    }
    try {
      console.log(`patch-client: ${applyClientPatch(file)} — ${file}`)
    } catch (error) {
      console.error(`patch-client: ${error.message}`)
      process.exit(1)
    }
    process.exit(0)
  }
  console.log(applyAllPatches())
}
