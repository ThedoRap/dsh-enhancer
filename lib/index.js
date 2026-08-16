/**
 * dsh-enhancer — DSH增强插件
 *
 * A host-plane plugin that makes every configured model genuinely usable in DSH:
 *
 * 1. **模型可用性自动适配** — 启动时用 DSH 的真实请求格式（stream +
 *    thinking.enabled + reasoning_effort + tools）探测 `llm-deepseek` 目录下的
 *    每个模型；对参数不兼容的模型（如 MiniMax-M3 只接受
 *    `thinking.type: adaptive|disabled`）在 `llm/stream` 瀑布处自动改写请求
 *    参数（保留原模型）；完全不可用的模型自动降级到配置的 fallback 模型。
 * 2. **图片识别自动路由** — DSH 内置 DeepSeek 适配器是 text-only 的，任何
 *    image block 都会被它拒绝（UNSUPPORTED_CONTENT）。本插件在瀑布处拦截
 *    含图片的请求，把图片转为 OpenAI 视觉格式（base64 data URL）直接请求
 *    中转，并可按配置把图片识别路由到指定视觉模型（visionModel），让
 *    "模型没有视觉能力"不再阻塞图片上传与使用。
 * 3. **缓存命中率显示精度** — 自动给 dsh-client-ui-conversation 打补丁，
 *    把缓存命中百分数从整数（Math.round，95.x% 显示成 100%）改为保留两位
 *    小数（95.60%）。
 * 4. **请求/上传处理超时** — 适配请求（含图片上传请求）默认 10 分钟超时
 *    （`requestTimeoutMs`），与 DSH 侧取消信号融合；到点主动中断并给出
 *    明确报错，避免请求被悬挂或在中转侧被模糊的 "context canceled" 掐断。
 * 5. **Moonshot 工具 schema 兼容** — Moonshot 系模型（kimi-k3 等）的 schema
 *    校验器只接受 `#/$defs/` 开头的 `$ref`，而 DSH 的工具参数 schema
 *    （schemastery 生成）是 draft-07 风格（`#/properties/...`、
 *    `#/definitions/...`），导致 kimi 模型一开工具就 400。插件在请求构造时
 *    把这类 `$ref` 目标提升到根级 `$defs` 并改写引用。**启动探测会用带
 *    draft-07 引用的工具 schema 实测每个模型**，命中校验拒绝即自动标记
 *    改写；模型名含 `kimi`/`moonshot` 或配置 `moonshotModels` 作为探测前的
 *    即时兜底。
 *
 * 附 `model_probe` 工具：随时手动重测所有模型并输出 Markdown 报告。
 *
 * @module dsh-enhancer
 */

import z from '@deepseek-ai/schemastery'
import { settingsNamespace, installSettingsSection } from '@deepseek-ai/dsh-settings'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  CallId,
  EMPTY_RESPONSE_CODE,
  LlmError,
  attributionHeaders,
} from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { Buffer } from 'node:buffer'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { applyClientPatch, applyImageAdmissionPatches, applyLimitPatches, applyMediaTypePatches, applyUtf16TerminatorPatches, locateClientBundleViaRequire } from './patch-client.js'

/** Stable plugin name (matches the cordis.patch.yml row id). */
export const name = 'dsh-enhancer'
// `attachments` is the durable image store (`AttachmentStore` registers as
// "attachments" — plural); it is provided by dsh-attachment-local via dsh-base.
export const inject = ['llm', 'tools', 'settings', 'credentials', 'timer', 'attachments']

/** Plugin configuration, also editable as the `dsh-enhancer` settings namespace. */
export const Config = z.object({
  /** Provider route this plugin adapts. */
  provider: z.string().default('deepseek-official'),
  /** Probe all models on plugin start. */
  autoProbeOnStart: z.boolean().default(true),
  /** Per-model probe timeout in milliseconds. */
  probeTimeoutMs: z.number().default(90000),
  /** Max duration for adapted relay requests (image uploads included), in ms. */
  requestTimeoutMs: z.number().default(600000),
  /** Force image requests to this model (empty = keep the request's model). */
  visionModel: z.string().default(''),
  /** Rewrite incompatible thinking parameters for failing models. */
  thinkingFix: z.boolean().default(true),
  /** Fallback model per failing model id, e.g. { 'MiniMax-M3': 'MiniMax-M2.7' }. */
  fallbacks: z.dict(z.string()).default({}),
  /** Rewrite tool schemas to `#/$defs/` refs for Moonshot-flavored models (kimi-k3 etc.). */
  moonshotSchemaFix: z.boolean().default(true),
  /** Model ids (or prefixes) that always use Moonshot-compatible tool schemas. */
  moonshotModels: z.array(z.string()).default([]),
  /** Apply the cache-hit display precision patch to the conversation bundle. */
  applyClientPatch: z.boolean().default(true),
})

/** The `llm-deepseek` settings namespace this plugin adapts (read-only). */
const LLM_NS = settingsNamespace('llm-deepseek')

/** Explicit defaults (schemastery schemas do not expose a `.defaults` surface). */
const DEFAULTS = {
  provider: 'deepseek-official',
  autoProbeOnStart: true,
  probeTimeoutMs: 90000,
  requestTimeoutMs: 600000,
  visionModel: '',
  thinkingFix: true,
  fallbacks: {},
  moonshotSchemaFix: true,
  moonshotModels: [],
  applyClientPatch: true,
}

// ---------------------------------------------------------------------------
// 消息序列化：与内置 DeepSeek 适配器一致，但支持 image block → OpenAI 视觉格式
// ---------------------------------------------------------------------------

function flattenText(blocks) {
  return blocks.filter((block) => block.type === 'text').map((block) => block.text).join('')
}

/** 直接透传给模型 API 的图片格式（其余格式发送前转 PNG）。 */
const RELAY_PASSTHROUGH_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/**
 * Locate the host's sharp module (same instance attachment-local uses), so
 * exotic raster formats can be normalized to PNG before hitting the model API.
 */
function locateSharp() {
  const execDir = dirname(process.execPath)
  const candidates = [
    join(execDir, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', 'sharp', 'package.json'),
    join(execDir, 'node_modules', 'sharp', 'package.json'),
  ]
  const home = process.env.DSH_HOME ?? join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.dsh')
  candidates.push(join(home, 'profiles', 'web', 'node_modules', 'sharp', 'package.json'))
  for (const pkg of candidates) {
    try {
      if (existsSync(pkg)) return createRequire(pkg)('sharp')
    } catch {
      /* keep probing */
    }
  }
  return undefined
}

function serializeAssistant(message) {
  const text = flattenText(message.content)
  const reasoning = message.content.filter((block) => block.type === 'reasoning').map((block) => block.text).join('')
  const toolCalls = message.content.filter((block) => block.type === 'tool-call').map((block) => ({
    id: block.id,
    type: 'function',
    function: { name: block.name, arguments: block.arguments },
  }))
  return {
    role: 'assistant',
    content: text,
    ...(toolCalls.length > 0 && reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  }
}

/** True when content contains an image block, walking nested tool-result content (mirrors `contentHasImage` in dsh-llm). */
function hasImageBlocks(content) {
  if (!Array.isArray(content)) return false
  return content.some(
    (block) => block.type === 'image' || (block.type === 'tool-result' && hasImageBlocks(block.content)),
  )
}

/**
 * Collect image blocks recursively (including images nested inside
 * tool-result content), deduplicated by attachment id. `seen` may be
 * pre-seeded to skip ids already emitted elsewhere (e.g. top-level images).
 */
function collectImageBlocks(blocks, out = [], seen = new Set()) {
  if (!Array.isArray(blocks)) return out
  for (const block of blocks) {
    if (block.type === 'image' && block.attachment !== undefined) {
      const id = block.attachment.attachmentId
      if (!seen.has(id)) {
        seen.add(id)
        out.push(block)
      }
    } else if (block.type === 'tool-result') {
      collectImageBlocks(block.content, out, seen)
    }
  }
  return out
}

/** Read one image attachment's bytes and encode as a base64 data URL. */
async function imageToDataUrl(ctx, block, signal) {
  const ref = block.attachment
  if (ref === undefined) {
    throw new LlmError('dsh-enhancer: image block has no attachment reference', 'UNSUPPORTED_CONTENT')
  }
  // The durable image store registers as `attachments` (plural) — see
  // @deepseek-ai/dsh-attachment (AttachmentStore). `readImage(ref, signal)`
  // returns `{ ref, data }` with the canonical verified ref.
  const store = ctx.get('attachments')
  if (store === undefined || typeof store.readImage !== 'function') {
    throw new LlmError(
      `dsh-enhancer: attachments service unavailable (cannot read image attachment ${ref.attachmentId ?? '?'})`,
      'UNSUPPORTED_CONTENT',
    )
  }
  let stored
  try {
    stored = await store.readImage(ref, signal)
  } catch (error) {
    const detail = error instanceof Error && error.message ? `: ${error.message}` : ''
    throw new LlmError(
      `dsh-enhancer: cannot read image attachment ${ref.attachmentId ?? '?'}${detail}`,
      'UNSUPPORTED_CONTENT',
      { cause: error },
    )
  }
  const mediaType = stored.ref?.mediaType ?? ref.mediaType
  // 非常规光栅格式（AVIF/TIFF/SVG/HEIC 等）很多模型 API 不认，统一转成 PNG
  // 再发（sharp 取自 DSH 安装树，与 attachment-local 同一实例）；找不到
  // sharp 或转换失败时退回原格式。
  if (!RELAY_PASSTHROUGH_TYPES.has(mediaType)) {
    const sharp = locateSharp()
    if (sharp !== undefined) {
      try {
        const png = await sharp(stored.data).png().toBuffer()
        return `data:image/png;base64,${Buffer.from(png).toString('base64')}`
      } catch (error) {
        ctx.logger?.warn?.(`dsh-enhancer: ${mediaType} → PNG 转换失败，按原格式发送: ${String(error)}`)
      }
    }
  }
  return `data:${mediaType};base64,${Buffer.from(stored.data).toString('base64')}`
}

/** Serialize harness messages to OpenAI-compatible wire messages (images allowed). */
async function serializeMessages(ctx, messages, signal) {
  const wire = []
  for (const message of messages) {
    if (message.role === 'system') {
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      wire.push(serializeAssistant(message))
      continue
    }
    const toolResults = message.content.filter((block) => block.type === 'tool-result')
    const text = flattenText(message.content)
    const topImages = message.content.filter((block) => block.type === 'image')
    // Images nested inside tool-result content (e.g. the tool-fs read_image
    // tool result) cannot be represented in an OpenAI `tool` message, so they
    // are emitted as a trailing user message after the tool results — this
    // keeps the assistant tool_calls → tool → user wire order valid while
    // still showing the model every image.
    const topIds = new Set(topImages.map((image) => image.attachment?.attachmentId).filter((id) => id !== undefined))
    const nestedImages = collectImageBlocks(toolResults, [], topIds)
    if (topImages.length > 0) {
      const parts = []
      if (text.length > 0) parts.push({ type: 'text', text })
      for (const image of topImages) {
        parts.push({ type: 'image_url', image_url: { url: await imageToDataUrl(ctx, image, signal) } })
      }
      wire.push({ role: 'user', content: parts })
    } else if (text.length > 0 || toolResults.length === 0) {
      wire.push({ role: 'user', content: text })
    }
    for (const result of toolResults) {
      wire.push({ role: 'tool', tool_call_id: result.toolCallId, content: flattenText(result.content) || '(no output)' })
    }
    if (nestedImages.length > 0) {
      const parts = []
      for (const image of nestedImages) {
        parts.push({ type: 'image_url', image_url: { url: await imageToDataUrl(ctx, image, signal) } })
      }
      wire.push({ role: 'user', content: parts })
    }
  }
  return wire
}

// ---------------------------------------------------------------------------
// SSE 翻译：中转流 → harness StreamChunk（与内置适配器协议一致）
// ---------------------------------------------------------------------------

function mapFinishReason(reason) {
  switch (reason) {
    case 'stop': return { kind: 'stop' }
    case 'tool_calls': return { kind: 'tool-calls' }
    case 'length': return { kind: 'max-tokens' }
    default: return { kind: 'error', failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() } }
  }
}

function mapUsage(usage) {
  if (usage === null || typeof usage !== 'object') return undefined
  const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
  return {
    inputTokens: usage.prompt_tokens - (cacheRead ?? 0),
    outputTokens: usage.completion_tokens,
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
  }
}

function closeBlock(block) {
  switch (block.kind) {
    case 'text': return { type: 'text', text: block.text }
    case 'reasoning': return { type: 'reasoning', text: block.text }
    case 'tool-call': return {
      type: 'tool-call',
      id: CallId(block.callId ?? ''),
      name: block.name ?? '',
      arguments: block.text,
    }
    default: throw new LlmError(`dsh-enhancer: unknown block kind ${block.kind}`, 'MALFORMED_RESPONSE')
  }
}

/** Consume a fetch Response body as SSE and yield StreamChunks. */
async function* translateSse(body, signal) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let nextIndex = 0
  let textBlock
  let reasoningBlock
  const toolBlocks = new Map()
  const order = []
  let pendingFinish
  let pendingUsage
  const open = (kind) => {
    const block = { index: nextIndex++, kind, text: '' }
    order.push(block)
    return block
  }
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '')
      buffer = buffer.slice(idx + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') {
        for (const block of order) yield { type: 'block-end', index: block.index, block: closeBlock(block) }
        if (pendingUsage !== undefined) yield { type: 'usage', usage: pendingUsage }
        const reason = pendingFinish ?? { kind: 'stop' }
        yield {
          type: 'finish',
          reason: reason.kind === 'stop' && order.length === 0
            ? { kind: 'error', failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE } }
            : reason,
        }
        return
      }
      let chunk
      try {
        chunk = JSON.parse(data)
      } catch {
        throw new LlmError(`dsh-enhancer: malformed SSE payload: ${data.slice(0, 120)}`, 'MALFORMED_RESPONSE')
      }
      for (const choice of chunk.choices ?? []) {
        const delta = choice.delta
        const reasoning = delta?.reasoning_content
        if (typeof reasoning === 'string' && reasoning.length > 0) {
          if (reasoningBlock === undefined) {
            reasoningBlock = open('reasoning')
            yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
          }
          reasoningBlock.text += reasoning
          yield { type: 'reasoning-delta', index: reasoningBlock.index, text: reasoning }
        }
        const content = delta?.content
        if (typeof content === 'string' && content.length > 0) {
          if (textBlock === undefined) {
            textBlock = open('text')
            yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
          }
          textBlock.text += content
          yield { type: 'text-delta', index: textBlock.index, text: content }
        }
        for (const call of delta?.tool_calls ?? []) {
          let block = toolBlocks.get(call.index)
          if (block === undefined) {
            block = open('tool-call')
            toolBlocks.set(call.index, block)
            yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
          }
          if (call.id !== undefined) block.callId = call.id
          if (call.function?.name !== undefined) block.name = call.function.name
          const fragment = call.function?.arguments ?? ''
          block.text += fragment
          yield {
            type: 'tool-call-delta',
            index: block.index,
            id: CallId(block.callId ?? ''),
            ...(block.name !== undefined ? { name: block.name } : {}),
            argumentsDelta: fragment,
          }
        }
        if (typeof choice.finish_reason === 'string') pendingFinish = mapFinishReason(choice.finish_reason)
      }
      if (chunk.usage !== undefined) pendingUsage = mapUsage(chunk.usage)
    }
  }
  throw new LlmError('dsh-enhancer: SSE stream ended without [DONE]', 'STREAM_CLOSED')
}

// ---------------------------------------------------------------------------
// 连接与凭据（与 llm-deepseek 相同的解析规则）
// ---------------------------------------------------------------------------

/** Read the live llm-deepseek connection facts from the settings document. */
function readConnection(ctx) {
  const settings = ctx.get('settings')
  const section = settings?.get(LLM_NS)
  const baseURL = (section?.baseURL ?? process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, '')
  const apiKeyEnv = section?.apiKeyEnv ?? 'DEEPSEEK_API_KEY'
  return {
    baseURL,
    apiKeyEnv,
    models: Array.isArray(section?.models) ? section.models : [],
    reasoningEffort: section?.reasoningEffort,
    thinking: section?.thinking,
  }
}

async function resolveApiKey(ctx, connection) {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    try {
      const hit = await credentials.resolve(credentialRef(connection.apiKeyEnv))
      if (hit !== undefined && hit.value !== undefined && hit.value.length > 0) return hit.value
    } catch {
      /* fall through to environment */
    }
  }
  const ambient = process.env[connection.apiKeyEnv]
  if (ambient !== undefined && ambient.length > 0) return ambient
  throw new LlmError(`dsh-enhancer: no API key for "${connection.apiKeyEnv}"`, 'MISSING_CREDENTIAL')
}

function httpErrorCode(status, providerError) {
  if (status === 401 || status === 403) return 'AUTH'
  const detail = [providerError?.code, providerError?.type, providerError?.message].filter(Boolean).join(' ')
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) return /context|window|token/i.test(detail) ? 'CONTEXT_WINDOW_EXCEEDED' : 'INVALID_REQUEST'
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

// ---------------------------------------------------------------------------
// Moonshot 兼容的工具 schema 改写（kimi 系列：`$ref` 必须以 `#/$defs/` 开头）
// ---------------------------------------------------------------------------

/** Decode one RFC 6901 JSON pointer segment (`~1` → `/`, `~0` → `~`). */
function decodePointerSegment(segment) {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~')
}

/**
 * Rewrite a JSON Schema so every internal `$ref` starts with `#/$defs/` — the
 * only reference form Moonshot's schema validator accepts (kimi-k3 etc.
 * reject draft-07 style pointers with "references must start with #/$defs/").
 *
 * DSH tool schemas (schemastery) use draft-07 style internal pointers
 * (`#/properties/...`, `#/definitions/...`). Their targets are hoisted into a
 * root `$defs` object and the refs rewritten in place; the input is never
 * mutated. Unresolvable internal refs degrade to `{}` (accept anything)
 * instead of failing validation; external (non-`#`) refs are left untouched.
 * Cycles are safe because only references are rewritten, never inlined.
 */
export function sanitizeSchemaForMoonshot(schema) {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return schema
  const root = structuredClone(schema)
  // draft-07 keyword `definitions` is not `$defs`; merge it under `$defs`
  if (root.definitions !== undefined && typeof root.definitions === 'object' && root.definitions !== null) {
    root.$defs = { ...(root.$defs ?? {}), ...root.definitions }
    delete root.definitions
  }
  // 1) collect every `$ref` owner object in document order
  const refs = []
  const walk = (node) => {
    if (typeof node !== 'object' || node === null) return
    if (typeof node.$ref === 'string') refs.push(node)
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref') continue
      if (Array.isArray(value)) {
        for (const item of value) walk(item)
      } else {
        walk(value)
      }
    }
  }
  walk(root)
  // 2) resolve one JSON pointer against the (mutating) root document
  const resolve = (pointer) => {
    if (typeof pointer !== 'string' || !pointer.startsWith('#')) return undefined
    const segments = pointer.slice(1).split('/').filter((segment) => segment.length > 0).map(decodePointerSegment)
    let node = root
    for (const segment of segments) {
      if (typeof node !== 'object' || node === null || !(segment in node)) return undefined
      node = node[segment]
    }
    return node
  }
  // 3) hoist draft-07 pointer targets into `$defs` and rewrite the refs
  const usedNames = new Set(Object.keys(root.$defs ?? {}))
  const nameByPointer = new Map()
  const nameByObject = new WeakMap()
  const nameFor = (pointer, target) => {
    const byObject = nameByObject.get(target)
    if (byObject !== undefined) return byObject
    const byPointer = nameByPointer.get(pointer)
    if (byPointer !== undefined) return byPointer
    let base = pointer.slice(1).split('/').filter(Boolean)
      .map(decodePointerSegment)
      .filter((segment) => segment !== 'properties' && segment !== 'items' && segment !== '$defs' && segment !== 'definitions')
      .join('_')
      .replace(/[^A-Za-z0-9_.-]/g, '_')
    if (base.length === 0) base = 'schema'
    let name = base
    let suffix = 1
    while (usedNames.has(name)) name = `${base}_${++suffix}`
    usedNames.add(name)
    root.$defs = { ...(root.$defs ?? {}), [name]: target }
    nameByPointer.set(pointer, name)
    nameByObject.set(target, name)
    return name
  }
  for (const owner of refs) {
    const ref = owner.$ref
    if (ref.startsWith('#/$defs/')) continue // already valid
    if (ref.startsWith('#/definitions/')) {
      // renamed during step 0; keep the ref valid only when the def exists
      const rest = ref.slice('#/definitions/'.length)
      if (root.$defs?.[rest] !== undefined) {
        owner.$ref = `#/$defs/${rest}`
      } else {
        delete owner.$ref
      }
      continue
    }
    if (!ref.startsWith('#')) continue // external ref: leave untouched
    const target = resolve(ref)
    if (target === undefined || target === root || typeof target !== 'object' || target === null) {
      // unresolvable (or degenerate self-root) pointer: degrade to permissive
      delete owner.$ref
      continue
    }
    owner.$ref = `#/$defs/${nameFor(ref, target)}`
  }
  return root
}

/**
 * True when a model id should receive Moonshot-compatible tool schemas:
 * explicitly listed in `moonshotModels` (exact id or prefix), or auto-detected
 * by name (`kimi` / `moonshot`) while `moonshotSchemaFix` is enabled.
 */
export function isMoonshotModel(model, config) {
  if (typeof model !== 'string' || model.length === 0) return false
  if (Array.isArray(config.moonshotModels)) {
    for (const id of config.moonshotModels) {
      if (typeof id === 'string' && id.length > 0 && (model === id || model.startsWith(id))) return true
    }
  }
  if (config.moonshotSchemaFix === false) return false
  const lower = model.toLowerCase()
  return lower.includes('kimi') || lower.includes('moonshot')
}

/**
 * Whether the wire model needs Moonshot-compatible tool schemas: the startup
 * probe detected it (the fixes entry carries `schema: 'moonshot'`), or the
 * name heuristic matches (covers the window before the probe finishes and any
 * model the probe could not test).
 */
function schemaFixNeeded(model, fixes, config) {
  if (config.moonshotSchemaFix === false) return false
  return fixes.get(model)?.schema === 'moonshot' || isMoonshotModel(model, config)
}

// ---------------------------------------------------------------------------
// 请求构造
// ---------------------------------------------------------------------------

/**
 * Build the wire request body. `fix` carries explicit wire overrides:
 *   { model?, wire: { thinking?, reasoning_effort? } }
 * When absent, the DSH-default effort rule applies (effort → thinking.enabled).
 * `signal` (default: `options.signal`) is used for attachment reads.
 */
async function buildBody(ctx, options, connection, fix, signal) {
  const messages = []
  if (options.system !== undefined) messages.push({ role: 'system', content: options.system })
  messages.push(...await serializeMessages(ctx, options.messages, signal ?? options.signal))
  const tools = options.tools?.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: fix.schema === 'moonshot' ? sanitizeSchemaForMoonshot(tool.parameters) : tool.parameters,
    },
  }))
  const body = {
    model: fix.model ?? options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
    ...(options.stop !== undefined ? { stop: options.stop } : {}),
  }
  if (fix.wire !== undefined) {
    if (fix.wire.thinking !== undefined) body.thinking = fix.wire.thinking
    if (fix.wire.reasoning_effort !== undefined) body.reasoning_effort = fix.wire.reasoning_effort
  } else if (options.reasoningEffort !== undefined && options.reasoningEffort !== 'off') {
    body.thinking = { type: 'enabled' }
    body.reasoning_effort = options.reasoningEffort
  }
  return body
}

/** One raw adapted stream: fetch the relay with corrected parameters, translate SSE. */
async function* rawStream(ctx, options, fix, timeoutMs) {
  const connection = readConnection(ctx)
  const apiKey = await resolveApiKey(ctx, connection)
  // 请求/上传处理超时：插件侧给适配请求（含图片上传请求）一个明确上限，
  // 与 DSH 侧的取消信号融合（谁先触发谁生效）。到点主动中断并给出明确
  // 报错，避免请求被悬挂或在中转侧被模糊的 "context canceled" 掐断。
  const deadline = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    deadline.abort()
  }, timeoutMs)
  const signal = options.signal !== undefined
    ? AbortSignal.any([options.signal, deadline.signal])
    : deadline.signal
  try {
    const body = await buildBody(ctx, options, connection, fix, signal)
    const headers = {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...attributionHeaders(),
      'x-deepseek-harness-user-id': String(getOrCreateAnonymousUserId()),
      ...(options.sessionId !== undefined ? { 'x-deepseek-harness-session-id': String(options.sessionId) } : {}),
      ...(options.purpose === 'compaction' ? { 'x-deepseek-harness-compact': '1' } : {}),
    }
    const response = await fetch(`${connection.baseURL}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    })
    if (!response.ok) {
      let message = `dsh-enhancer: relay error (HTTP ${response.status})`
      let providerError
      try {
        providerError = (await response.json()).error
        if (providerError?.message) message = `${providerError.message} (via dsh-enhancer for ${options.model})`
      } catch {
        /* non-JSON error body */
      }
      throw new LlmError(message, httpErrorCode(response.status, providerError), { status: response.status })
    }
    if (response.body === null) throw new LlmError('dsh-enhancer: relay returned no response body', 'EMPTY_RESPONSE')
    yield* translateSse(response.body, signal)
  } catch (error) {
    if (timedOut) {
      throw new LlmError(
        `dsh-enhancer: relay request timed out after ${timeoutMs}ms (model ${options.model})`,
        'REQUEST_TIMEOUT',
      )
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/** Wrap an adapted stream: never throw out of the waterfall; emit a terminal finish chunk. */
async function* guardedStream(ctx, options, fix, timeoutMs) {
  try {
    yield* rawStream(ctx, options, fix, timeoutMs)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger.warn(`dsh-enhancer: adapted request for ${options.model} failed: ${message}`)
    // 与内置适配器一致：DSH 侧取消（用户停止/断开）以 `aborted` 收尾，其余为错误。
    const aborted = options.signal?.aborted === true
    yield {
      type: 'finish',
      reason: {
        kind: aborted ? 'aborted' : 'error',
        failure: {
          message,
          code: error instanceof LlmError ? error.code : 'TRANSPORT',
        },
      },
    }
  }
}

// ---------------------------------------------------------------------------
// 探测
// ---------------------------------------------------------------------------

/**
 * Minimal tool schema for the schema-flavor probe. Its `$ref` deliberately
 * uses the draft-07 form (`#/properties/...`) that Moonshot's validator
 * rejects — exactly the shape DSH sends for real tools (schemastery).
 */
const SCHEMA_PROBE_TOOL = {
  type: 'function',
  function: {
    name: 'probe_schema',
    description: 'schema flavor probe',
    parameters: {
      type: 'object',
      properties: {
        triggers: {
          type: 'array',
          items: { $ref: '#/properties/func/properties/triggers/items' },
        },
        func: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            triggers: {
              type: 'array',
              items: {
                type: 'object',
                properties: { name: { type: 'string' }, config: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  },
}

/** True when a relay error is a tool-schema validation rejection (Moonshot style). */
function isSchemaValidationError(detail) {
  return /references must start with|json schema|schema[\s\S]{0,40}\$ref|\$ref[\s\S]{0,40}schema/i.test(detail)
}

/** One probe request against the relay; returns a compact result record. */
async function probeOnce(ctx, connection, apiKey, model, effort, wire, timeoutMs, signal, extra = {}) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  const started = Date.now()
  try {
    const body = {
      model,
      messages: [{ role: 'user', content: 'Reply with exactly: PROBE_OK' }],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 1024,
    }
    if (extra.tools !== undefined) body.tools = extra.tools
    if (wire !== undefined) {
      if (wire.thinking !== undefined) body.thinking = wire.thinking
      if (wire.reasoning_effort !== undefined) body.reasoning_effort = wire.reasoning_effort
    } else if (effort !== undefined && effort !== 'off') {
      body.thinking = { type: 'enabled' }
      body.reasoning_effort = effort
    }
    const response = await fetch(`${connection.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal: ac.signal,
    })
    if (!response.ok) {
      let detail = `HTTP ${response.status}`
      try {
        const j = await response.json()
        detail = j.error?.message || j.error?.code || detail
      } catch {
        /* keep status detail */
      }
      return { ok: false, status: response.status, ms: Date.now() - started, detail }
    }
    // drain the stream to verify real content
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let content = ''
    let sawDone = false
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') { sawDone = true; break }
        try {
          const j = JSON.parse(data)
          const delta = j.choices?.[0]?.delta
          if (delta?.content) content += delta.content
        } catch {
          /* ignore malformed probe chunk */
        }
      }
      if (sawDone) break
    }
    const usable = sawDone && content.trim().length > 0
    return { ok: usable, status: response.status, ms: Date.now() - started, detail: usable ? '' : 'stream ended without usable content' }
  } catch (error) {
    return { ok: false, status: 0, ms: Date.now() - started, detail: error?.name === 'AbortError' ? 'timeout' : String(error?.message ?? error) }
  } finally {
    clearTimeout(timer)
  }
}

/** Probe one model with the DSH request format, then corrective wire shapes. */
async function probeModel(ctx, state, connection, apiKey, model, signal) {
  const effort = connection.reasoningEffort ?? 'max'
  const attempts = []
  const base = await probeOnce(ctx, connection, apiKey, model, effort, undefined, state.probeTimeoutMs, signal)
  attempts.push({ shape: 'dsh', ...base })
  if (!base.ok) {
    const candidates = [
      { name: 'adaptive', wire: { thinking: { type: 'adaptive' }, reasoning_effort: effort } },
      { name: 'no-thinking', wire: {} },
      { name: 'disabled', wire: { thinking: { type: 'disabled' } } },
    ]
    for (const candidate of candidates) {
      const result = await probeOnce(ctx, connection, apiKey, model, effort, candidate.wire, state.probeTimeoutMs, signal)
      attempts.push({ shape: candidate.name, wire: candidate.wire, ...result })
      if (result.ok) break
    }
  }
  // "ok" means the DSH request shape itself works; a corrective shape that
  // works is recorded as a fix wire, not as plain availability.
  const ok = base.ok
  const winning = attempts.find((a) => a.ok)
  // Schema-flavor probe: DSH sends draft-07 `$ref` tool schemas, which some
  // providers (Moonshot/kimi) reject ("references must start with #/$defs/").
  // When the raw form fails with a schema-validation error and the rewritten
  // form works, mark the model so requests get sanitized tool schemas. Uses
  // the winning wire shape so thinking incompatibility is not misread as a
  // schema problem.
  let schemaFix
  if (winning !== undefined && state.config.moonshotSchemaFix !== false) {
    const wire = ok ? undefined : winning.wire
    const raw = await probeOnce(ctx, connection, apiKey, model, effort, wire, state.probeTimeoutMs, signal, {
      tools: [SCHEMA_PROBE_TOOL],
    })
    attempts.push({ shape: 'tools-raw', ...raw })
    if (!raw.ok && isSchemaValidationError(raw.detail)) {
      const fixed = await probeOnce(ctx, connection, apiKey, model, effort, wire, state.probeTimeoutMs, signal, {
        tools: [{ ...SCHEMA_PROBE_TOOL, function: { ...SCHEMA_PROBE_TOOL.function, parameters: sanitizeSchemaForMoonshot(SCHEMA_PROBE_TOOL.function.parameters) } }],
      })
      attempts.push({ shape: 'tools-fixed', ...fixed })
      if (fixed.ok) schemaFix = 'moonshot'
    }
  }
  return { model, ok, attempts, fixWire: ok ? undefined : winning?.wire, schemaFix }
}

/** Probe every configured model and refresh the adaptation table. */
async function runProbe(ctx, state, signal) {
  const connection = readConnection(ctx)
  const apiKey = await resolveApiKey(ctx, connection)
  const models = connection.models.length > 0
    ? connection.models
    : [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }]
  const results = []
  const fixes = new Map()
  for (const entry of models) {
    const model = typeof entry === 'string' ? entry : entry.id
    const result = await probeModel(ctx, state, connection, apiKey, model, signal)
    results.push(result)
    if (result.ok) {
      fixes.set(model, { ok: true, ...(result.schemaFix !== undefined ? { schema: result.schemaFix } : {}) })
    } else {
      const fallback = state.config.fallbacks[model]
      const fixed = result.fixWire !== undefined && state.config.thinkingFix
      const schema = result.schemaFix !== undefined ? { schema: result.schemaFix } : {}
      fixes.set(model, fixed
        ? { ok: false, wire: result.fixWire, ...schema }
        : fallback
          ? { ok: false, model: fallback, wire: result.fixWire, ...schema }
          : { ok: false, ...schema })
    }
  }
  state.fixes = fixes
  state.lastProbe = { at: new Date().toISOString(), results, connection }
  return { connection, results }
}

/** Render one probe run as a Markdown report. */
function renderReport(run) {
  const probe = run.lastProbe
  const lines = ['## 模型可用性探测报告', '', `- 中转地址：\`${probe.connection.baseURL}\``, `- 探测时间：${probe.at}`, '']
  lines.push('| 模型 | 状态 | 修正 | schema | 耗时 | 详情 |')
  lines.push('| --- | --- | --- | --- | --- | --- |')
  for (const r of probe.results) {
    const state = r.ok ? '✅ 可用' : '❌ 不可用'
    const winning = r.attempts.find((a) => a.ok)
    const shape = r.ok ? (winning?.shape === 'dsh' ? '原样' : `修正(${winning?.shape})`) : '无'
    const schema = r.schemaFix === 'moonshot' ? '改写' : (r.ok ? '原样' : '—')
    const fastest = r.attempts.filter((a) => a.ok).sort((a, b) => a.ms - b.ms)[0]
    const ms = fastest ? `${fastest.ms}ms` : r.attempts[0]?.ms ? `${r.attempts[0].ms}ms` : '—'
    const detail = r.ok ? '' : (r.attempts[0]?.detail ?? '')
    lines.push(`| ${r.model} | ${state} | ${shape} | ${schema} | ${ms} | ${detail} |`)
  }
  lines.push('')
  lines.push('运行时：参数不兼容的模型在 `llm/stream` 层自动改写请求后照常使用；完全不可用且配置了 `fallbacks` 的模型自动降级。Moonshot 系模型（kimi-k3 等）自动把工具 schema 改写为 `#/$defs/` 引用，否则其 API 会拒绝 draft-07 风格 `$ref`。')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

/** Internal exports for integration testing (not part of the public contract). */
export {
  probeModel,
  runProbe,
  readConnection,
  buildBody,
  serializeMessages,
  translateSse,
  rawStream,
}

export function apply(ctx, config = {}) {
  const state = {
    config: { ...DEFAULTS, ...config },
    fixes: new Map(),
    lastProbe: null,
    probeTimeoutMs: config.probeTimeoutMs ?? DEFAULTS.probeTimeoutMs,
    probing: null,
  }

  // ---- 客户端/宿主补丁（缓存命中精度 + 图片准入放行） ----
  if (state.config.applyClientPatch) {
    ctx.setTimeout(() => {
      try {
        // 优先通过 clientModules 服务拿到权威 bundle 路径（缓存命中补丁）
        const conversation = ctx.get('clientModules')?.clientPath('@deepseek-ai/dsh-client-ui-conversation')
          ?? locateClientBundleViaRequire()
        const outcomes = []
        if (conversation !== undefined) {
          outcomes.push(`cache-hit: ${applyClientPatch(conversation)}`)
        } else {
          outcomes.push('cache-hit: conversation bundle not located')
        }
        try {
          const image = applyImageAdmissionPatches()
          for (const [id, outcome] of Object.entries(image)) outcomes.push(`image-admission(${id}): ${outcome}`)
        } catch (error) {
          outcomes.push(`image-admission: ${error.message}`)
        }
        try {
          const utf16 = applyUtf16TerminatorPatches()
          for (const [id, outcome] of Object.entries(utf16)) outcomes.push(`utf16-terminator(${id}): ${outcome}`)
        } catch (error) {
          outcomes.push(`utf16-terminator: ${error.message}`)
        }
        try {
          const media = applyMediaTypePatches()
          for (const [id, outcome] of Object.entries(media)) outcomes.push(`media-types(${id}): ${outcome}`)
        } catch (error) {
          outcomes.push(`media-types: ${error.message}`)
        }
        try {
          const limits = applyLimitPatches()
          for (const [id, outcome] of Object.entries(limits)) outcomes.push(`upload-limits(${id}): ${outcome}`)
        } catch (error) {
          outcomes.push(`upload-limits: ${error.message}`)
        }
        ctx.logger.info(`dsh-enhancer: patches — ${outcomes.join(' | ')}`)
      } catch (error) {
        ctx.logger.warn(`dsh-enhancer: patch application failed: ${String(error)}`)
      }
    }, 3000)
  }

  // ---- 启动探测 ----
  const scheduleProbe = (attempt) => {
    if (!state.config.autoProbeOnStart) return
    if (state.probing !== null) return
    state.probing = runProbe(ctx, state).catch((error) => {
      ctx.logger.warn(`dsh-enhancer: startup probe failed (attempt ${attempt}): ${String(error)}`)
      if (attempt < 2) ctx.setTimeout(() => scheduleProbe(attempt + 1), 10000)
    }).finally(() => {
      state.probing = null
    })
  }
  ctx.setTimeout(() => scheduleProbe(0), 5000)

  // ---- llm/stream 瀑布适配 ----
  ctx.on('llm/stream', (options, next) => {
    if (options.provider !== state.config.provider) return next()
    const timeoutMs = state.config.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs
    const hasImage = options.messages.some((message) => hasImageBlocks(message.content))
    if (hasImage) {
      const fix = state.config.visionModel !== ''
        ? { model: state.config.visionModel }
        : {}
      // 图片被路由到的模型也可能是 Moonshot 系（kimi），工具 schema 同样要改写
      const wireModel = fix.model ?? options.model
      if (schemaFixNeeded(wireModel, state.fixes, state.config)) fix.schema = 'moonshot'
      return guardedStream(ctx, options, fix, timeoutMs)
    }
    const fix = state.fixes.get(options.model)
    // Moonshot 系模型（kimi-k3 等）拒绝 draft-07 风格的 `$ref` 工具 schema
    // （"references must start with #/$defs/"），内置适配器会 400 失败。
    // 无论探测结果如何都走插件中继路径，并把工具参数 schema 改写为
    // `#/$defs/` 引用；探测得到的 thinking 修正/降级同样生效。
    if (schemaFixNeeded(options.model, state.fixes, state.config)) {
      const adapted = fix !== undefined && !fix.ok
        ? { model: fix.model ?? options.model, wire: fix.wire }
        : {}
      return guardedStream(ctx, options, { ...adapted, schema: 'moonshot' }, timeoutMs)
    }
    if (fix === undefined || fix.ok) return next()
    return guardedStream(ctx, options, {
      model: fix.model ?? options.model,
      wire: fix.wire,
    }, timeoutMs)
  })

  // ---- model_probe 工具 ----
  try {
    ctx.tools.register(defineTool({
      name: 'model_probe',
      description: '探测 llm-deepseek 配置的所有模型在 DSH 请求格式下的可用性（含 thinking 参数兼容性、工具 schema 兼容性与自动修正方案），输出 Markdown 报告。发现新模型或中转变更后调用。',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render(_args, value) {
          return [{ type: 'text', text: value }]
        },
      },
      async execute() {
        const ac = new AbortController()
        const timer = setTimeout(() => ac.abort(), state.probeTimeoutMs * 6)
        try {
          await runProbe(ctx, state, ac.signal)
          return renderReport(state)
        } finally {
          clearTimeout(timer)
        }
      },
    }))
  } catch (error) {
    ctx.logger.warn(`dsh-enhancer: model_probe tool registration failed: ${String(error)}`)
  }

  // ---- settings namespace（运行时可改配置，热生效） ----
  try {
    installSettingsSection(ctx, settingsNamespace('dsh-enhancer'), Config, config, {
      setSource: (source) => {
        const next = source()
        state.config = { ...DEFAULTS, ...next }
        state.probeTimeoutMs = next.probeTimeoutMs ?? DEFAULTS.probeTimeoutMs
        // 配置变化后重新探测
        scheduleProbe(0)
      },
    })
  } catch (error) {
    ctx.logger.warn(`dsh-enhancer: settings registration failed: ${String(error)}`)
  }
}
