# dsh-enhancer — DSH 增强插件

让 DSH 里的每一个模型都真正可用，并修复若干体验问题。面向使用 DSH Web / CLI（`@deepseek-ai/dsh`，rc.6 系）并通过第三方中转接入 `llm-deepseek` 的用户。

## 功能特性

### 1. 模型可用性自动探测与适配
- 启动时自动用 **DSH 的真实请求格式**（`stream` + `thinking.enabled` + `reasoning_effort` + tools）探测 `llm-deepseek` 配置的每个模型，而不是只测 HTTP 200。
- 对**参数不兼容**的模型（实测：`MiniMax-M3` 不接受 `thinking.type: "enabled"`，只接受 `adaptive`/`disabled`，会导致 DSH 调用 400 失败）在 `llm/stream` 瀑布处**自动改写请求参数**，模型照常可用。
- 完全不可用的模型可配置 `fallbacks` 自动降级到替代模型。
- 随时用 `model_probe` 工具重测，输出 Markdown 报告。

### 2. 图片识别自动适配
- DSH 内置 DeepSeek 适配器是 text-only 的，**任何图片都会被它直接拒绝**（"does not support image content"），而且宿主层把所有模型声明为不支持图片（GUI 提示"当前模型不支持图片，请切换支持图片的模型"）。
- 本插件三管齐下：
  1. **图片准入放行**（自动补丁）：放行 host-apiproxy 的图片检查（不再报"当前模型不支持图片"）和 tool-fs 的读图检查；
  2. **瀑布适配**：含图片的请求被拦截，图片转为 base64 data URL（OpenAI 视觉格式）直接请求中转，**任何模型都能看图**（实测 14 个模型中 13 个支持图片，包括 deepseek-v4-flash）；图片从 durable 附件服务读取（`attachments`，与 DSH 内置适配器一致），工具结果内嵌套的图片（如 tool-fs 读图结果）也会被识别并以独立 user 消息补发；
  3. 可配置 `visionModel` 把图片识别固定路由到指定视觉模型（如 `claude-sonnet-4-6`），留空则跟随当前模型。

### 3. 缓存命中率显示精度
- 修复会话统计里缓存命中百分比被 `Math.round` 取整导致虚高的问题（95.6% 显示成 96%、99.5% 显示成 100%）。
- 自动给 `dsh-client-ui-conversation` 的 bundle 打补丁，改为**保留两位小数**（95.60%）。
- 补丁幂等，首次打补丁前自动备份为 `*.dsh-enhancer.bak`；可用 `node scripts/patch-client.mjs --revert` 还原全部补丁。

### 4. 请求/上传处理超时
- 适配请求（含图片上传请求）有明确的超时上限（`requestTimeoutMs`，默认 **10 分钟**）。
- 超时由插件侧主动中断并报 `REQUEST_TIMEOUT`，不再让请求被悬挂，也不会以模糊的 "context canceled" 收场；DSH 侧取消（停止/断开）仍即时生效。
- 若上游（中转 → 模型网关）处理含图请求需要更久，可调大该值；注意中转自身的渠道超时也需要同步调大。

### 5. Moonshot 工具 schema 兼容（kimi 系列）
- Moonshot 的 schema 校验器只接受 **`#/$defs/` 开头**的 `$ref`；而 DSH 的工具参数 schema（schemastery 生成）是 draft-07 风格（`#/properties/...`、`#/definitions/...`），导致 kimi-k3 等模型**一开工具调用就 400**：`tools.function.parameters is not a valid moonshot flavored json schema, details: <At path 'properties.triggers.items.$ref': references must start with #/$defs/>`。
- 本插件在请求构造时把这类 `$ref` 目标**提升到根级 `$defs` 并改写引用**（含嵌套/循环引用，输入 schema 不被修改），kimi 模型照常使用全部工具。
- **启动探测会实测每个模型**：用带 draft-07 引用的工具 schema 发探测请求，若中转返回 schema 校验错误、改写后通过，则自动给该模型打上改写标记（`model_probe` 报告新增 schema 列）；模型名含 `kimi` / `moonshot`（或配置 `moonshotModels`）作为探测完成前的即时兜底，`moonshotSchemaFix` 可整体关闭。

### 6. Windows 原生目录选择器中文路径截断修复
- DSH 的 Windows 原生文件夹选择器（`dsh-host-directory-picker-native` 的 IFileOpenDialog worker）读取选中路径时，NUL 扫描**只看每个 UTF-16 字符的第 1 个字节**：低字节为 `0x00` 的字符（码位为 256 整数倍，如「销」U+9500、「一」U+4E00）被误判为字符串结尾，路径被截断——文件夹名「核销」变成「核」，添加工作区报 `workspace-invalid-path` / realpath ENOENT。
- 本插件自动给 worker 打补丁，改为**仅当完整 `0x0000` 码元出现时才结束扫描**（ASCII 路径不受影响）。
- 补丁幂等，首次打补丁前自动备份为 `*.dsh-enhancer.bak`；`node scripts/patch-client.mjs --revert` 一并还原。

### 7. 附件图片格式扩展（取消四格式限制）
- DSH 附件系统**仅接受 PNG/JPG/WebP/GIF**（GUI 上传、read_image 工具、宿主/客户端 schema 校验、会话导出共 14 处硬编码白名单），其他格式的图片一律被拒（"unsupported image media type" / INVALID_IMAGE）。
- 本插件把白名单扩展为 **PNG/JPEG/WebP/GIF/AVIF/TIFF/SVG/HEIC/HEIF/JXL/BMP/ICO**（与 sharp 可解码的光栅格式对齐）：上传、粘贴、拖拽、`read_image` 工具均可使用这些格式；HEIC 在浏览器侧自动规范化为 `image/heif` 再校验，避免类型比对失败。
- 补丁覆盖 6 个 bundle（attachment-local / host-apiproxy 主 bundle 与 type 层 / client-connection / client-ui-conversation / tool-fs），幂等并自动备份；**浏览器侧补丁需要硬刷新页面（Ctrl+F5）后生效**。
- 注意：插件会把图片按原始格式直接转发给模型 API，**具体模型/中转对 AVIF/TIFF/SVG/HEIC 等格式的接受度不一**；若某模型拒绝，转成 PNG 再传即可。浏览器内预览同样受浏览器支持度影响（如 Chrome 不渲染 TIFF）。

## 工作原理

- **模型适配**：插件挂在 `llm/stream` 事件瀑布上，只拦截目标 provider 的请求；需要修正的模型走插件自带的中继实现（与内置 DeepSeek 适配器同协议：SSE 流、usage、tool-call、reasoning 均一致），其余请求原样放行。
- **自动补丁**：部分能力（图片准入、缓存精度、目录选择器修复、图片格式扩展）需要修改 DSH 安装目录下的 bundle 文件。所有补丁**幂等**：已打补丁的文件跳过；首次打补丁前自动备份为 `<file>.dsh-enhancer.bak`，替换内容内嵌 `/*dsh-enhancer:<name>*/` 标记。DSH 升级覆盖文件后，插件启动时会自动重打。

## 安装

> 环境要求：Node.js ≥ 18；已安装并运行 `@deepseek-ai/dsh`（Web profile）。

```powershell
# 1. 依赖安装（插件目录内）
cd <dsh-enhancer 目录>
npm install

# 2. 接入 profile：把下面的内容加入 <DSH_HOME>\profiles\web\package.json
#    （Windows 默认 DSH_HOME = %USERPROFILE%\.dsh）
#    dependencies 增加:
#      "dsh-enhancer": "link:<dsh-enhancer 绝对路径，正斜杠>"
#    dsh.profile.bundles 增加:
#      "dsh-enhancer"

# 3. 重装依赖
cd <DSH_HOME>\profiles\web
pnpm install

# 4. 重启 dsh（完全退出后重新打开 Web），插件自动生效：
#    - 启动 5 秒后自动探测全部模型并应用适配
#    - 自动补丁（缓存精度 / 图片准入 / 目录选择器修复）3 秒后应用
#    - 如补丁未自动应用，可手动执行：
node <dsh-enhancer 目录>\scripts\patch-client.mjs
```

## 配置（cordis.patch.yml 或 设置 → 插件配置）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `provider` | `deepseek-official` | 适配的 provider 路由 |
| `autoProbeOnStart` | `true` | 启动时自动探测 |
| `probeTimeoutMs` | `90000` | 单模型探测超时（毫秒） |
| `requestTimeoutMs` | `600000` | 适配请求（含图片上传）超时上限（毫秒），默认 10 分钟 |
| `visionModel` | `''` | 图片识别固定模型；空 = 跟随当前模型 |
| `thinkingFix` | `true` | 自动修正 thinking 参数不兼容的模型 |
| `fallbacks` | `{}` | 不可用模型的降级目标，如 `{ "MiniMax-M3": "MiniMax-M2.7" }` |
| `moonshotSchemaFix` | `true` | 把工具 schema 改写为 `#/$defs/` 引用（Moonshot 系模型必需） |
| `moonshotModels` | `[]` | 强制使用 Moonshot 兼容 schema 的模型 id/前缀，如 `["kimi-k3"]`（默认按名称自动识别 + 启动探测自动检测） |
| `applyClientPatch` | `true` | 自动应用宿主/客户端补丁（缓存精度、图片准入、目录选择器修复、图片格式扩展） |

`cordis.patch.yml` 内的注释给出了完整的配置示例。

## 补丁 CLI

```powershell
node scripts\patch-client.mjs                  # 自动定位并应用全部补丁（幂等）
node scripts\patch-client.mjs --revert         # 从 *.dsh-enhancer.bak 还原全部补丁
node scripts\patch-client.mjs --file <path>    # 指定 conversation client.js 应用缓存精度补丁
```

## 验证

- 启动后日志出现 `dsh-enhancer: patches — cache-hit: … | image-admission(…): … | utf16-terminator(worker): … | media-types(…): …` 表示补丁状态；
- 会话里调用 `model_probe` 工具可随时重测全部模型并输出 Markdown 报告；
- 修复验证：Windows 下添加工作区时选择以「销」「一」等字结尾的文件夹（如 `…\核销`），应能正常添加；
- 格式验证：硬刷新页面后上传/拖拽一张 **AVIF、BMP、TIFF 或 SVG** 图片，应能正常进入对话（不再报 "unsupported image media type"）。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 补丁未生效 / DSH 升级后被还原 | 重跑 `node scripts\patch-client.mjs`；若提示 expected expression not found，说明 DSH 版本已改变补丁目标代码，需更新插件 |
| 启动探测失败 | 日志有 `startup probe failed` 会 10 秒后自动重试一次；检查中转可达性与 API key |
| 图片上传后报错 | 确认 `applyClientPatch` 生效（图片准入补丁）；非图片文件仍受 DSH 附件系统类型限制 |
| 请求报 `REQUEST_TIMEOUT` | 调大 `requestTimeoutMs`，并同步调大中转渠道超时 |
| 添加工作区报 `workspace-invalid-path` | 目录选择器补丁未生效时会出现（路径被 UTF-16 截断）；重跑补丁 CLI |
| 上传其他格式图片仍被拒 | 浏览器侧补丁需要**硬刷新页面（Ctrl+F5）**；确认日志有 `media-types(…): patched`；若报错来自模型 API（如该模型不支持 AVIF/TIFF），转成 PNG 再传 |

## 开发

```
lib/index.js              插件主体：瀑布适配、探测、工具注册
lib/patch-client.js       补丁集：缓存精度 / 图片准入 / UTF-16 终止符 / 图片格式扩展
scripts/patch-client.mjs  补丁 CLI
test/                     回归测试（node:test 风格，离线可跑）
```

```powershell
node test\utf16-terminator.test.mjs
node test\image-serialize.test.mjs
node test\schema-sanitize.test.mjs
node test\request-timeout.test.mjs
node test\media-types.test.mjs
```

## 已知限制

- 补丁修改的是 dsh 安装目录下的 bundle 文件，升级 `@deepseek-ai/dsh` 后可能被还原，重新启动插件会自动重打（文件内容变化后若匹配失败，日志会提示，可手动运行 patch 脚本）。
- 图片附件支持格式已扩展为 PNG/JPEG/WebP/GIF/AVIF/TIFF/SVG/HEIC/HEIF/JXL/BMP/ICO；**非图片文件**（PDF/文档/压缩包等）仍不作为附件接受，且具体模型 API 对不同格式的接受度不一（见功能 7）。
- 插件面向 `llm-deepseek` 中转场景（OpenAI 兼容 `/chat/completions`）；其他 provider 路由需自行确认兼容性。

## License

MIT
