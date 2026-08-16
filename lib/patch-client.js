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
 *    本补丁放行这些检查（图片请求由插件在 llm/stream 瀑布处直接请求中转）。
 * 3. **原生目录选择器 UTF-16 路径截断** — Windows 原生文件夹选择器
 *    （dsh-host-directory-picker-native 的 IFileOpenDialog worker）读取选中
 *    路径时，NUL 扫描只看每个 UTF-16 码元的第 1 个字节：低字节为 0x00 的
 *    字符（码位为 256 整数倍，如「销」U+9500）被误判为字符串结尾，路径
 *    被截断（"H:\...\核销" → "H:\...\核"），添加工作区报
 *    workspace-invalid-path / realpath ENOENT。补丁改为仅当完整 0x0000
 *    码元出现时才结束扫描。
 * 4. **附件图片格式扩展** — 取消 PNG/JPG/WebP/GIF 四格式限制，扩展为
 *    AVIF/TIFF/SVG/HEIC/HEIF（实测本机 sharp 0.35 可解码的全部格式；
 *    JXL/BMP/ICO/PDF 该构建解不了，不加白名单）。另修复 AVIF 识别：
 *    sharp 把 AVIF 报成 format="heif"，需按 compression="av1" 区分，否则
 *    "声明 image/avif vs 检测 image/heif" 类型比对失败、上传被拒。
 *    覆盖 6 个 bundle 的 15 处白名单/映射（见下文 MEDIA_TYPE_PATCH_SETS）。
 * 5. **上传大小限制** — 单图默认上限 5MB（attachment-local 的
 *    DEFAULT_MAX_IMAGE_BYTES 与 client-connection 投影回退各一处硬编码），
 *    提升到 100MB（仍可在配置中覆盖）。
 * 6. **文本/代码文件支持** — 原来只能传图片；现在浏览器侧把 .txt/.py/.php/
 *    .h/.js/.md/.json/.csv 等文本类文件读成内容、作为文本块发给模型
 *    （512KB 截断），不再报 "unsupported image media type"。
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
// DSH 的附件系统把图片格式白名单硬编码在 6 个 bundle 的 15 处：
//   1. dsh-attachment-local —— 上传准入（sharp 格式→MIME 映射 + AVIF 识别 +
//      能力声明列表），未知格式直接 INVALID_IMAGE；
//   2. dsh-host-apiproxy —— 浏览器 wire 的 mediaType zod 校验 + 会话导出 zip
//      扩展名映射（主 bundle 与 type 层各一份）；
//   3. dsh-client-connection —— 浏览器侧同一份 zod 校验 + 会话投影的
//      imageLimits.mediaTypes 硬编码回退；
//   4. dsh-client-ui-conversation —— 浏览器侧 imageMediaType() 开关（真正的
//      硬闸门），并顺带实现文本/代码文件支持（见文件末尾 TEXT 补丁）；
//   5. dsh-tool-fs —— read_image 工具的扩展名映射、描述、输出 schema 枚举
//      与两处报错文案。
// 有效白名单 = 本机 sharp 0.35 实测可解码的格式：
// PNG/JPEG/WebP/GIF/AVIF/TIFF/SVG/HEIC/HEIF（JXL/BMP/ICO/PDF 该构建解不了，
// 加入只会让上传在存储层被拒，故不加）。AVIF 特判：sharp 统一报
// format="heif"，用 compression="av1" 区分出 image/avif，避免类型比对失败。
// HEIC 在客户端规范化为 image/heif。每个文件只嵌一个 marker，一次性原子
// 替换全部点位，幂等。

/** Marker embedded in media-type-widening replacements so "already patched" is unambiguous. */
export const MEDIA_MARKER = '/*dsh-enhancer:media-types*/'

/** 1a. attachment-local: sharp 格式名 → MIME。 */
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
\theif: "image/heif"
};`
/** 1b. attachment-local: AVIF 识别（sharp 把 AVIF 报成 heif，按 compression 区分）。 */
const ATTACH_AVIF_OLD = '\tconst mediaType = MEDIA_TYPES[metadata.format];'
const ATTACH_AVIF_NEW = '\tconst mediaType = metadata.format === "heif" && metadata.compression === "av1" ? "image/avif" : MEDIA_TYPES[metadata.format];'
/** 1c. attachment-local: 能力声明列表（含 heic 别名，浏览器 File.type 可能是 image/heic）。 */
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
\t\t\t\t"image/heif"
\t\t\t])`
/** 2a. host-apiproxy 主 bundle: 会话导出 zip 扩展名映射。 */
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
\t"image/heif": "heif"
};`
/** 2b. host-apiproxy 主 bundle: 浏览器 wire 的 mediaType zod 校验。 */
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
\tz$1.literal("image/heif")
]);`
/** 3a. host-apiproxy type 层: 会话导出 zip 扩展名映射（单引号/4 空格风格）。 */
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
};`
/** 3b. host-apiproxy type 层: mediaType zod 校验（单引号/4 空格风格）。 */
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
]);`
/** 4a. client-connection: 浏览器侧 mediaType zod 校验。 */
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
\t\t\tliteral("image/heif")
\t\t]);`
/** 4b. client-connection: 会话投影的 imageLimits.mediaTypes 硬编码回退。 */
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
\t\t\t\t\t"image/heif"
\t\t\t\t]`
/** 5. client-ui-conversation: imageMediaType() 硬闸门 + 文本/代码文件支持。 */
const CONVERSATION_FN_OLD = `\t\tfunction imageMediaType(value) {
\t\t\tswitch (value) {
\t\t\t\tcase "image/png":
\t\t\t\tcase "image/jpeg":
\t\t\t\tcase "image/webp":
\t\t\t\tcase "image/gif": return value;
\t\t\t\tdefault: throw new UnsupportedImageMediaTypeError(value);
\t\t\t}
\t\t}`
const CONVERSATION_FN_NEW = `\t\t${MEDIA_MARKER}
\t\tfunction imageMediaType(value) {
\t\t\tswitch (value) {
\t\t\t\tcase "image/png":
\t\t\t\tcase "image/jpeg":
\t\t\t\tcase "image/webp":
\t\t\t\tcase "image/gif":
\t\t\t\tcase "image/avif":
\t\t\t\tcase "image/tiff":
\t\t\t\tcase "image/svg+xml":
\t\t\t\tcase "image/heic":
\t\t\t\tcase "image/heif": return value === "image/heic" ? "image/heif" : value;
\t\t\t\tdefault: throw new UnsupportedImageMediaTypeError(value);
\t\t\t}
\t\t}
\t\tfunction fileIsTextFile(file) {
\t\t\tconst type = (file.type || "").toLowerCase();
\t\t\tif (type.startsWith("text/") || type === "application/json" || type === "application/xml" || type === "application/javascript" || type === "application/x-yaml" || type === "application/x-sh" || type === "application/x-httpd-php" || type === "application/sql") return true;
\t\t\tconst ext = (file.name.split(".").pop() || "").toLowerCase();
\t\t\treturn ["txt", "md", "markdown", "json", "csv", "tsv", "yml", "yaml", "xml", "html", "htm", "css", "js", "mjs", "cjs", "ts", "jsx", "tsx", "py", "php", "h", "hpp", "c", "cpp", "cc", "java", "go", "rs", "rb", "sh", "bash", "bat", "cmd", "ps1", "sql", "ini", "cfg", "conf", "toml", "log", "env", "gitignore", "vue", "svelte"].includes(ext) || file.name.toLowerCase().endsWith("dockerfile") || file.name.toLowerCase() === "makefile";
\t\t}
\t\tconst TEXT_FILE_ICON = "data:image/svg+xml;charset=utf-8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="8" fill="#e3e6ea"/><path d="M22 14h14l8 8v28H22z" fill="#8ab4f8"/><rect x="26" y="34" width="12" height="2" fill="#fff"/><rect x="26" y="39" width="12" height="2" fill="#fff"/><rect x="26" y="44" width="8" height="2" fill="#fff"/></svg>');
\t\tconst TEXT_FILE_CAP = 524288;`
/** 6. client-ui-conversation: 草稿缩略图（文本文件用文件图标，避免 <img> 裂图）。 */
const CONVERSATION_DRAFT_OLD = `\t\tfunction browserDraftAttachment(file) {
\t\t\treturn {
\t\t\t\tkind: "image",
\t\t\t\tid: crypto.randomUUID(),
\t\t\t\tpreviewUrl: URL.createObjectURL(file),
\t\t\t\tfile
\t\t\t};
\t\t}`
const CONVERSATION_DRAFT_NEW = `\t\tfunction browserDraftAttachment(file) {
\t\t\treturn {
\t\t\t\tkind: "image",
\t\t\t\tid: crypto.randomUUID(),
\t\t\t\tpreviewUrl: fileIsTextFile(file) ? TEXT_FILE_ICON : URL.createObjectURL(file),
\t\t\t\tfile
\t\t\t};
\t\t}`
/** 7. client-ui-conversation: 序列化——文本类文件读内容发文本块，其余走图片。 */
const CONVERSATION_SERIALIZE_OLD = `\t\t\tserializeImages(images) {
\t\t\t\treturn Promise.all(images.map(async (file) => ({
\t\t\t\t\ttype: "image",
\t\t\t\t\tmediaType: imageMediaType(file.type),
\t\t\t\t\tdata: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
\t\t\t\t\t...file.name === "" ? {} : { name: file.name }
\t\t\t\t})));
\t\t\t}`
const CONVERSATION_SERIALIZE_NEW = `\t\t\tserializeImages(images) {
\t\t\t\treturn Promise.all(images.map(async (file) => {
\t\t\t\t\tif (fileIsTextFile(file)) {
\t\t\t\t\t\tconst blob = file.size > TEXT_FILE_CAP ? file.slice(0, TEXT_FILE_CAP) : file;
\t\t\t\t\t\tconst text = await blob.text();
\t\t\t\t\t\tconst note = file.size > TEXT_FILE_CAP ? "\\n…（附件过大，仅截取前 " + TEXT_FILE_CAP + " 字节）" : "";
\t\t\t\t\t\treturn { type: "text", text: "[附件：" + file.name + "]\\n" + text + note };
\t\t\t\t\t}
\t\t\t\t\treturn {
\t\t\t\t\t\ttype: "image",
\t\t\t\t\t\tmediaType: imageMediaType(file.type),
\t\t\t\t\t\tdata: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
\t\t\t\t\t\t...file.name === "" ? {} : { name: file.name }
\t\t\t\t\t};
\t\t\t\t}));
\t\t\t}`
/** 8. tool-fs: read_image 扩展名映射。 */
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
\t".heif": "image/heif"
};`
/** 8. client-ui-conversation: 不支持的图片类型提示文案（zh/en，原文案只列 4 种格式）。 */
const CONVERSATION_LOCALE_ZH_OLD = '"image.unsupportedType": "仅支持 PNG、JPG、WebP、GIF 格式的图片",'
const CONVERSATION_LOCALE_ZH_NEW = '"image.unsupportedType": "仅支持 PNG、JPG、WebP、GIF、AVIF、TIFF、SVG、HEIC、HEIF 格式的图片，以及 txt/py/php 等文本/代码文件",'
const CONVERSATION_LOCALE_EN_OLD = '"image.unsupportedType": "Only PNG, JPG, WebP, and GIF images are supported",'
const CONVERSATION_LOCALE_EN_NEW = '"image.unsupportedType": "Only PNG, JPG, WebP, GIF, AVIF, TIFF, SVG, HEIC, HEIF images and text/code files are supported",'

/** 9. tool-fs: read_image 工具描述（模型可见）。 */
const TOOL_DESC_OLD = 'description: "Read a PNG/JPEG/WebP/GIF file and return the image itself. Requires the current model to accept image input.",'
const TOOL_DESC_NEW = 'description: "Read an image file (PNG/JPEG/WebP/GIF/AVIF/TIFF/SVG/HEIC/HEIF) and return the image itself. Requires the current model to accept image input.",'
/** 10. tool-fs: 输出 schema 的 mediaType 枚举。 */
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
\t\t\t\t\t\t\t\t\t"image/heif"
\t\t\t\t\t\t\t\t],`
/** 11. tool-fs: 未知扩展名报错文案。 */
const TOOL_PATH_ERR_OLD = 'throw new Error(`cannot read "${args.file_path}": read_image only accepts PNG/JPEG/WebP/GIF paths`);'
const TOOL_PATH_ERR_NEW = 'throw new Error(`cannot read "${args.file_path}": read_image only accepts image paths (PNG/JPEG/WebP/GIF/AVIF/TIFF/SVG/HEIC/HEIF)`);'
/** 12. tool-fs: 扩展名与字节不符的报错文案。 */
const TOOL_MISMATCH_ERR_OLD = 'throw new Error(`cannot read "${target.displayPath}": the ${extension} extension declares ${mediaType}, but the bytes use a different image format; rename the file to match its actual format if it is PNG/JPEG/WebP/GIF, or convert it to one of those formats`, { cause: error });'
const TOOL_MISMATCH_ERR_NEW = 'throw new Error(`cannot read "${target.displayPath}": the ${extension} extension declares ${mediaType}, but the bytes use a different image format; rename the file to match its actual format, or convert it to a supported image format`, { cause: error });'

/** Per-file media-type patch sets: id → { file locator, patch list }. */
export const MEDIA_TYPE_PATCH_SETS = [
  {
    id: 'attachment-local',
    marker: MEDIA_MARKER,
    file: locateAttachmentLocalBundle,
    patches: [
      { old: ATTACH_MEDIA_TYPES_OLD, new: ATTACH_MEDIA_TYPES_NEW },
      { old: ATTACH_AVIF_OLD, new: ATTACH_AVIF_NEW },
      { old: ATTACH_LIMITS_OLD, new: ATTACH_LIMITS_NEW },
    ],
  },
  {
    id: 'host-apiproxy',
    marker: MEDIA_MARKER,
    file: locateHostApiproxyBundle,
    patches: [
      { old: HOST_EXT_OLD, new: HOST_EXT_NEW },
      { old: HOST_SCHEMA_OLD, new: HOST_SCHEMA_NEW },
    ],
  },
  {
    id: 'host-apiproxy-session-export',
    marker: MEDIA_MARKER,
    file: locateSessionExportBundle,
    patches: [{ old: HOST_EXT_TYPES_OLD, new: HOST_EXT_TYPES_NEW }],
  },
  {
    id: 'host-apiproxy-sessions-schema',
    marker: MEDIA_MARKER,
    file: locateSessionsSchemaBundle,
    patches: [{ old: HOST_SCHEMA_TYPES_OLD, new: HOST_SCHEMA_TYPES_NEW }],
  },
  {
    id: 'client-connection',
    marker: MEDIA_MARKER,
    file: locateClientConnectionBundle,
    patches: [
      { old: CLIENT_SCHEMA_OLD, new: CLIENT_SCHEMA_NEW },
      { old: CLIENT_LIMITS_OLD, new: CLIENT_LIMITS_NEW },
    ],
  },
  {
    id: 'client-ui-conversation',
    marker: MEDIA_MARKER,
    file: locateClientBundleViaRequire,
    patches: [
      { old: CONVERSATION_FN_OLD, new: CONVERSATION_FN_NEW },
      { old: CONVERSATION_DRAFT_OLD, new: CONVERSATION_DRAFT_NEW },
      { old: CONVERSATION_SERIALIZE_OLD, new: CONVERSATION_SERIALIZE_NEW },
      { old: CONVERSATION_LOCALE_ZH_OLD, new: CONVERSATION_LOCALE_ZH_NEW },
      { old: CONVERSATION_LOCALE_EN_OLD, new: CONVERSATION_LOCALE_EN_NEW },
    ],
  },
  {
    id: 'tool-fs',
    marker: MEDIA_MARKER,
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

// ---------------------------------------------------------------------------
// 上传大小限制：单图默认 5MB → 100MB
// ---------------------------------------------------------------------------
//
// attachment-local 的 DEFAULT_MAX_IMAGE_BYTES（同时被 Config 默认引用）与
// client-connection 会话投影回退各有一处 5MB 硬编码；浏览器提示
// "image.fileTooLarge" 的数值来自宿主推送的 imageLimits，改默认即生效。
// 实际限制仍可在 profile 配置中覆盖（maxImageBytes）。

/** Marker embedded in upload-limit replacements so "already patched" is unambiguous. */
export const LIMITS_MARKER = '/*dsh-enhancer:upload-limits*/'

const LIMITS_ATTACH_DEFAULT_OLD = 'const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;'
const LIMITS_ATTACH_DEFAULT_NEW = `${LIMITS_MARKER}\nconst DEFAULT_MAX_IMAGE_BYTES = 100 * 1024 * 1024;`
const LIMITS_ATTACH_CTOR_OLD = 'config.maxImageBytes ?? 5242880'
const LIMITS_ATTACH_CTOR_NEW = 'config.maxImageBytes ?? 104857600'
const LIMITS_CLIENT_OLD = 'maxImageBytes: 5 * 1024 * 1024,'
const LIMITS_CLIENT_NEW = `maxImageBytes: ${LIMITS_MARKER} 100 * 1024 * 1024,`

/** Per-file upload-limit patch sets. */
export const LIMITS_PATCH_SETS = [
  {
    id: 'attachment-local-limits',
    marker: LIMITS_MARKER,
    file: locateAttachmentLocalBundle,
    patches: [
      { old: LIMITS_ATTACH_DEFAULT_OLD, new: LIMITS_ATTACH_DEFAULT_NEW },
      { old: LIMITS_ATTACH_CTOR_OLD, new: LIMITS_ATTACH_CTOR_NEW },
    ],
  },
  {
    id: 'client-connection-limits',
    marker: LIMITS_MARKER,
    file: locateClientConnectionBundle,
    patches: [{ old: LIMITS_CLIENT_OLD, new: LIMITS_CLIENT_NEW }],
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
    outcomes[set.id] = applyExpressionSet(file, set.marker, set.patches)
  }
  return outcomes
}

/**
 * Apply every upload-limit patch across all located bundles.
 * @returns per-id outcomes; throws on the first set whose file cannot be
 *   located or whose expression does not match.
 */
export function applyLimitPatches() {
  const outcomes = {}
  for (const set of LIMITS_PATCH_SETS) {
    const file = set.file()
    if (file === undefined) throw new Error(`cannot locate bundle for patch "${set.id}"`)
    outcomes[set.id] = applyExpressionSet(file, set.marker, set.patches)
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
  try {
    const limits = applyLimitPatches()
    for (const [id, outcome] of Object.entries(limits)) lines.push(`upload-limits(${id}): ${outcome}`)
  } catch (error) {
    lines.push(`upload-limits: ${error.message}`)
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
