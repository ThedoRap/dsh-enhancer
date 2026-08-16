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
 * 4. **附件图片格式扩展** — 取消 PNG/JPG/WebP/GIF 四格式限制，扩展为
 *    AVIF/TIFF/SVG/HEIC/HEIF/JXL/BMP/ICO 等 sharp 可解码格式，覆盖 6 个
 *    bundle 的 14 处白名单（见下文 MEDIA_TYPE_PATCH_SETS 注释）。
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

/** Locate the attachment-local store bundle. */
export function locateAttachmentLocalBundle() {
  return locatePackageFile(['dsh-attachment-local', 'lib', 'index.js'])
}

/** Locate the client-connection wire bundle (browser-side schemas + projections). */
export function locateClientConnectionBundle() {
  return locatePackageFile(['dsh-client-connection', 'lib', 'client.js'])
}

/** Locate the host-apiproxy type-layer session-export bundle. */
export function locateSessionExportBundle() {
  return locatePackageFile(['dsh-host-apiproxy', 'lib', 'types', 'session-export.js'])
}

/** Locate the host-apiproxy type-layer sessions schema bundle. */
export function locateSessionsSchemaBundle() {
  return locatePackageFile(['dsh-host-apiproxy', 'lib', 'types', 'api', 'sessions.schema.js'])
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

// ---------------------------------------------------------------------------
// 附件图片格式扩展：取消「仅支持 PNG/JPG/WebP/GIF」限制
// ---------------------------------------------------------------------------
//
// DSH 的附件系统把图片格式白名单硬编码在 6 个 bundle 的 14 处：
//   1. dsh-attachment-local —— 上传准入（sharp 格式→MIME 映射 + 能力声明列表），
//      未知格式直接 INVALID_IMAGE；
//   2. dsh-host-apiproxy —— 浏览器 wire 的 mediaType zod 校验 + 会话导出 zip
//      扩展名映射（主 bundle 与 type 层各一份）；
//   3. dsh-client-connection —— 浏览器侧同一份 zod 校验 + 会话投影的
//      imageLimits.mediaTypes 硬编码回退；
//   4. dsh-client-ui-conversation —— 浏览器侧 imageMediaType() 开关，不在
//      白名单内的 File.type 直接抛 UnsupportedImageMediaTypeError（真正的
//      硬闸门）；
//   5. dsh-tool-fs —— read_image 工具的扩展名映射、描述、输出 schema 枚举
//      与两处报错文案。
// 本补丁把白名单扩展为
// PNG/JPEG/WebP/GIF/AVIF/TIFF/SVG/HEIC/HEIF/JXL/BMP/ICO（与 sharp 可解码
// 的光栅格式对齐）；HEIC 在客户端规范化为 image/heif（sharp 统一报告
// heif 格式，避免 IMAGE_TYPE_MISMATCH）。每个文件只嵌一个 marker，
// 一次性原子替换全部点位，幂等。

/** Marker embedded in media-type-widening replacements so "already patched" is unambiguous. */
export const MEDIA_MARKER = '/*dsh-enhancer:media-types*/'

/** 1. attachment-local: sharp 格式名 → MIME。 */
const ATTACH_MEDIA_TYPES_OLD = `const MEDIA_TYPES = {
\tpng: "image/png",
\tjpeg: "image/jpeg",
\twebp: "image/webp",
\tgif: "image/gif"
};`
const ATTACH_MEDIA_TYPES_NEW = `${MEDIA_MARKER}
const MEDIA_TYPES = {
\tpng: "image/png",
\tjpeg: "image/jpeg",
\twebp: "image/webp",
\tgif: "image/gif",
\tavif: "image/avif",
\ttiff: "image/tiff",
\tsvg: "image/svg+xml",
\theif: "image/heif",
\tjxl: "image/jxl",
\tbmp: "image/bmp",
\tico: "image/x-icon"
};`
/** 2. attachment-local: 能力声明列表（含 heic 别名，浏览器 File.type 可能是 image/heic）。 */
const ATTACH_LIMITS_OLD = `\t\t\tmediaTypes: Object.freeze([
\t\t\t\t"image/png",
\t\t\t\t"image/jpeg",
\t\t\t\t"image/webp",
\t\t\t\t"image/gif"
\t\t\t])`
const ATTACH_LIMITS_NEW = `\t\t\tmediaTypes: Object.freeze([
\t\t\t\t"image/png",
\t\t\t\t"image/jpeg",
\t\t\t\t"image/webp",
\t\t\t\t"image/gif",
\t\t\t\t"image/avif",
\t\t\t\t"image/tiff",
\t\t\t\t"image/svg+xml",
\t\t\t\t"image/heic",
\t\t\t\t"image/heif",
\t\t\t\t"image/jxl",
\t\t\t\t"image/bmp",
\t\t\t\t"image/x-icon"
\t\t\t])`
/** 3. host-apiproxy 主 bundle: 会话导出 zip 扩展名映射。 */
const HOST_EXT_OLD = `const MEDIA_TYPE_EXTENSIONS = {
\t"image/png": "png",
\t"image/jpeg": "jpg",
\t"image/webp": "webp",
\t"image/gif": "gif"
};`
const HOST_EXT_NEW = `${MEDIA_MARKER}
const MEDIA_TYPE_EXTENSIONS = {
\t"image/png": "png",
\t"image/jpeg": "jpg",
\t"image/webp": "webp",
\t"image/gif": "gif",
\t"image/avif": "avif",
\t"image/tiff": "tif",
\t"image/svg+xml": "svg",
\t"image/heic": "heic",
\t"image/heif": "heif",
\t"image/jxl": "jxl",
\t"image/bmp": "bmp",
\t"image/x-icon": "ico"
};`
/** 4. host-apiproxy 主 bundle: 浏览器 wire 的 mediaType zod 校验。 */
const HOST_SCHEMA_OLD = `const imageMediaTypeSchema = z$1.union([
\tz$1.literal("image/png"),
\tz$1.literal("image/jpeg"),
\tz$1.literal("image/webp"),
\tz$1.literal("image/gif")
]);`
const HOST_SCHEMA_NEW = `${MEDIA_MARKER}
const imageMediaTypeSchema = z$1.union([
\tz$1.literal("image/png"),
\tz$1.literal("image/jpeg"),
\tz$1.literal("image/webp"),
\tz$1.literal("image/gif"),
\tz$1.literal("image/avif"),
\tz$1.literal("image/tiff"),
\tz$1.literal("image/svg+xml"),
\tz$1.literal("image/heic"),
\tz$1.literal("image/heif"),
\tz$1.literal("image/jxl"),
\tz$1.literal("image/bmp"),
\tz$1.literal("image/x-icon")
]);`
/** 5. host-apiproxy type 层: 会话导出 zip 扩展名映射（单引号/4 空格风格）。 */
const HOST_EXT_TYPES_OLD = `const MEDIA_TYPE_EXTENSIONS = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
};`
const HOST_EXT_TYPES_NEW = `${MEDIA_MARKER}
const MEDIA_TYPE_EXTENSIONS = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/avif': 'avif',
    'image/tiff': 'tif',
    'image/svg+xml': 'svg',
    'image/heic': 'heic',
    'image/heif': 'heif',
    'image/jxl': 'jxl',
    'image/bmp': 'bmp',
    'image/x-icon': 'ico',
};`
/** 6. host-apiproxy type 层: mediaType zod 校验（单引号/4 空格风格）。 */
const HOST_SCHEMA_TYPES_OLD = `export const imageMediaTypeSchema = z.union([
    z.literal('image/png'),
    z.literal('image/jpeg'),
    z.literal('image/webp'),
    z.literal('image/gif'),
]);`
const HOST_SCHEMA_TYPES_NEW = `${MEDIA_MARKER}
export const imageMediaTypeSchema = z.union([
    z.literal('image/png'),
    z.literal('image/jpeg'),
    z.literal('image/webp'),
    z.literal('image/gif'),
    z.literal('image/avif'),
    z.literal('image/tiff'),
    z.literal('image/svg+xml'),
    z.literal('image/heic'),
    z.literal('image/heif'),
    z.literal('image/jxl'),
    z.literal('image/bmp'),
    z.literal('image/x-icon'),
]);`
/** 7. client-connection: 浏览器侧 mediaType zod 校验。 */
const CLIENT_SCHEMA_OLD = `\t\tconst imageMediaTypeSchema = union([
\t\t\tliteral("image/png"),
\t\t\tliteral("image/jpeg"),
\t\t\tliteral("image/webp"),
\t\t\tliteral("image/gif")
\t\t]);`
const CLIENT_SCHEMA_NEW = `\t\t${MEDIA_MARKER} const imageMediaTypeSchema = union([
\t\t\tliteral("image/png"),
\t\t\tliteral("image/jpeg"),
\t\t\tliteral("image/webp"),
\t\t\tliteral("image/gif"),
\t\t\tliteral("image/avif"),
\t\t\tliteral("image/tiff"),
\t\t\tliteral("image/svg+xml"),
\t\t\tliteral("image/heic"),
\t\t\tliteral("image/heif"),
\t\t\tliteral("image/jxl"),
\t\t\tliteral("image/bmp"),
\t\t\tliteral("image/x-icon")
\t\t]);`
/** 8. client-connection: 会话投影的 imageLimits.mediaTypes 硬编码回退。 */
const CLIENT_LIMITS_OLD = `\t\t\t\tmediaTypes: [
\t\t\t\t\t"image/png",
\t\t\t\t\t"image/jpeg",
\t\t\t\t\t"image/webp",
\t\t\t\t\t"image/gif"
\t\t\t\t]`
const CLIENT_LIMITS_NEW = `\t\t\t\tmediaTypes: [
\t\t\t\t\t"image/png",
\t\t\t\t\t"image/jpeg",
\t\t\t\t\t"image/webp",
\t\t\t\t\t"image/gif",
\t\t\t\t\t"image/avif",
\t\t\t\t\t"image/tiff",
\t\t\t\t\t"image/svg+xml",
\t\t\t\t\t"image/heic",
\t\t\t\t\t"image/heif",
\t\t\t\t\t"image/jxl",
\t\t\t\t\t"image/bmp",
\t\t\t\t\t"image/x-icon"
\t\t\t\t]`
/** 9. client-ui-conversation: imageMediaType() 硬闸门（HEIC 规范化为 image/heif）。 */
const CONVERSATION_SWITCH_OLD = `\t\t\t\tcase "image/png":
\t\t\t\tcase "image/jpeg":
\t\t\t\tcase "image/webp":
\t\t\t\tcase "image/gif": return value;`
const CONVERSATION_SWITCH_NEW = `\t\t\t\t${MEDIA_MARKER}
\t\t\t\tcase "image/png":
\t\t\t\tcase "image/jpeg":
\t\t\t\tcase "image/webp":
\t\t\t\tcase "image/gif":
\t\t\t\tcase "image/avif":
\t\t\t\tcase "image/tiff":
\t\t\t\tcase "image/svg+xml":
\t\t\t\tcase "image/heic":
\t\t\t\tcase "image/heif":
\t\t\t\tcase "image/jxl":
\t\t\t\tcase "image/bmp":
\t\t\t\tcase "image/x-icon": return value === "image/heic" ? "image/heif" : value;`
/** 10. tool-fs: read_image 扩展名映射。 */
const TOOL_EXT_OLD = `const IMAGE_EXTENSIONS = {
\t".png": "image/png",
\t".jpg": "image/jpeg",
\t".jpeg": "image/jpeg",
\t".webp": "image/webp",
\t".gif": "image/gif"
};`
const TOOL_EXT_NEW = `${MEDIA_MARKER}
const IMAGE_EXTENSIONS = {
\t".png": "image/png",
\t".jpg": "image/jpeg",
\t".jpeg": "image/jpeg",
\t".webp": "image/webp",
\t".gif": "image/gif",
\t".avif": "image/avif",
\t".tif": "image/tiff",
\t".tiff": "image/tiff",
\t".svg": "image/svg+xml",
\t".heic": "image/heif",
\t".heif": "image/heif",
\t".jxl": "image/jxl",
\t".bmp": "image/bmp",
\t".ico": "image/x-icon"
};`
/** 11. tool-fs: read_image 工具描述（模型可见）。 */
const TOOL_DESC_OLD = 'description: "Read a PNG/JPEG/WebP/GIF file and return the image itself. Requires the current model to accept image input.",'
const TOOL_DESC_NEW = 'description: "Read an image file (PNG/JPEG/WebP/GIF/AVIF/TIFF/SVG/HEIC/HEIF/JXL/BMP/ICO) and return the image itself. Requires the current model to accept image input.",'
/** 12. tool-fs: 输出 schema 的 mediaType 枚举。 */
const TOOL_ENUM_OLD = `\t\t\t\t\t\t\t\tenum: [
\t\t\t\t\t\t\t\t\t"image/png",
\t\t\t\t\t\t\t\t\t"image/jpeg",
\t\t\t\t\t\t\t\t\t"image/webp",
\t\t\t\t\t\t\t\t\t"image/gif"
\t\t\t\t\t\t\t\t],`
const TOOL_ENUM_NEW = `\t\t\t\t\t\t\t\tenum: [
\t\t\t\t\t\t\t\t\t"image/png",
\t\t\t\t\t\t\t\t\t"image/jpeg",
\t\t\t\t\t\t\t\t\t"image/webp",
\t\t\t\t\t\t\t\t\t"image/gif",
\t\t\t\t\t\t\t\t\t"image/avif",
\t\t\t\t\t\t\t\t\t"image/tiff",
\t\t\t\t\t\t\t\t\t"image/svg+xml",
\t\t\t\t\t\t\t\t\t"image/heic",
\t\t\t\t\t\t\t\t\t"image/heif",
\t\t\t\t\t\t\t\t\t"image/jxl",
\t\t\t\t\t\t\t\t\t"image/bmp",
\t\t\t\t\t\t\t\t\t"image/x-icon"
\t\t\t\t\t\t\t\t],`
/** 13. tool-fs: 未知扩展名报错文案。 */
const TOOL_PATH_ERR_OLD = 'throw new Error(`cannot read "${args.file_path}": read_image only accepts PNG/JPEG/WebP/GIF paths`);'
const TOOL_PATH_ERR_NEW = 'throw new Error(`cannot read "${args.file_path}": read_image only accepts image paths (PNG/JPEG/WebP/GIF/AVIF/TIFF/SVG/HEIC/HEIF/JXL/BMP/ICO)`);'
/** 14. tool-fs: 扩展名与字节不符的报错文案。 */
const TOOL_MISMATCH_ERR_OLD = 'throw new Error(`cannot read "${target.displayPath}": the ${extension} extension declares ${mediaType}, but the bytes use a different image format; rename the file to match its actual format if it is PNG/JPEG/WebP/GIF, or convert it to one of those formats`, { cause: error });'
const TOOL_MISMATCH_ERR_NEW = 'throw new Error(`cannot read "${target.displayPath}": the ${extension} extension declares ${mediaType}, but the bytes use a different image format; rename the file to match its actual format, or convert it to a supported image format`, { cause: error });'

/** Per-file media-type patch sets: id → { file locator, patch list }. */
export const MEDIA_TYPE_PATCH_SETS = [
  {
    id: 'attachment-local',
    file: locateAttachmentLocalBundle,
    patches: [
      { old: ATTACH_MEDIA_TYPES_OLD, new: ATTACH_MEDIA_TYPES_NEW },
      { old: ATTACH_LIMITS_OLD, new: ATTACH_LIMITS_NEW },
    ],
  },
  {
    id: 'host-apiproxy',
    file: locateHostApiproxyBundle,
    patches: [
      { old: HOST_EXT_OLD, new: HOST_EXT_NEW },
      { old: HOST_SCHEMA_OLD, new: HOST_SCHEMA_NEW },
    ],
  },
  {
    id: 'host-apiproxy-session-export',
    file: locateSessionExportBundle,
    patches: [{ old: HOST_EXT_TYPES_OLD, new: HOST_EXT_TYPES_NEW }],
  },
  {
    id: 'host-apiproxy-sessions-schema',
    file: locateSessionsSchemaBundle,
    patches: [{ old: HOST_SCHEMA_TYPES_OLD, new: HOST_SCHEMA_TYPES_NEW }],
  },
  {
    id: 'client-connection',
    file: locateClientConnectionBundle,
    patches: [
      { old: CLIENT_SCHEMA_OLD, new: CLIENT_SCHEMA_NEW },
      { old: CLIENT_LIMITS_OLD, new: CLIENT_LIMITS_NEW },
    ],
  },
  {
    id: 'client-ui-conversation',
    file: locateClientBundleViaRequire,
    patches: [{ old: CONVERSATION_SWITCH_OLD, new: CONVERSATION_SWITCH_NEW }],
  },
  {
    id: 'tool-fs',
    file: locateToolFsBundle,
    patches: [
      { old: TOOL_EXT_OLD, new: TOOL_EXT_NEW },
      { old: TOOL_DESC_OLD, new: TOOL_DESC_NEW },
      { old: TOOL_ENUM_OLD, new: TOOL_ENUM_NEW },
      { old: TOOL_PATH_ERR_OLD, new: TOOL_PATH_ERR_NEW },
      { old: TOOL_MISMATCH_ERR_OLD, new: TOOL_MISMATCH_ERR_NEW },
    ],
  },
]

/**
 * Apply one multi-expression patch set to a file atomically.
 * @param file - absolute path of the target bundle.
 * @param marker - marker embedded by the first replacement; presence means "already patched".
 * @param patches - exact old/new expression pairs, all replaced in one pass before writing.
 * @returns 'patched' | 'already'
 * @throws when the file is missing or any expected expression cannot be found
 *   (nothing is written in that case).
 */
export function applyExpressionSet(file, marker, patches) {
  const source = readFileSync(file, 'utf8')
  if (marker !== undefined && source.includes(marker)) return 'already'
  let next = source
  for (const patch of patches) {
    if (next.includes(patch.new)) continue
    if (!next.includes(patch.old)) {
      const preview = patch.old.replace(/\s+/g, ' ').slice(0, 80)
      throw new Error(`expected expression not found in ${file}: ${preview}`)
    }
    next = next.split(patch.old).join(patch.new)
  }
  const backup = `${file}${BACKUP_SUFFIX}`
  if (!existsSync(backup)) copyFileSync(file, backup)
  writeFileSync(file, next, 'utf8')
  return 'patched'
}

/**
 * Apply every media-type widening patch across all located bundles.
 * @returns per-id outcomes; throws on the first set whose file cannot be
 *   located or whose expression does not match.
 */
export function applyMediaTypePatches() {
  const outcomes = {}
  for (const set of MEDIA_TYPE_PATCH_SETS) {
    const file = set.file()
    if (file === undefined) throw new Error(`cannot locate bundle for patch "${set.id}"`)
    outcomes[set.id] = applyExpressionSet(file, MEDIA_MARKER, set.patches)
  }
  return outcomes
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
  try {
    const media = applyMediaTypePatches()
    for (const [id, outcome] of Object.entries(media)) lines.push(`media-types(${id}): ${outcome}`)
  } catch (error) {
    lines.push(`media-types: ${error.message}`)
  }
  return lines.join('\n')
}

/** CLI entry: `node scripts/patch-client.mjs [--all] [--revert] [--file <path>]`. */
export async function runCli(argv) {
  const args = [...argv]
  if (args.includes('--revert')) {
    for (const file of [locateClientBundleViaRequire(), locateHostApiproxyBundle(), locateHostApiproxyTypesBundle(), locateToolFsBundle(), locateNativePickerWorker(), locateAttachmentLocalBundle(), locateClientConnectionBundle(), locateSessionExportBundle(), locateSessionsSchemaBundle()]) {
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
