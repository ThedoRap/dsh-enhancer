# dsh-enhancer — DSH 增强插件

让 DSH 里的每一个模型都真正可用，并修复若干体验问题。适用于 DSH Web/CLI + `llm-deepseek` 中转场景。

## 功能（解决了什么 / 原因）

| 模块 | 解决什么 | 原因 |
| --- | --- | --- |
| 模型适配 | 每个模型都真正可用：自动探测并修正参数不兼容的模型、不可用自动降级、任何模型都能看图（可指定 `visionModel`）、kimi 系模型能正常用工具 | 中转模型（如 MiniMax-M3）不接受 DSH 默认 thinking 参数会 400；DSH 内置适配器 text-only 拒图；Moonshot 只接受 `#/$defs/` 引用、DSH 发 draft-07 schema 会被拒 |
| 附件支持 | 图片支持 9 种格式（PNG/JPEG/WebP/GIF/AVIF/TIFF/SVG/HEIC/HEIF，发送前统一转 PNG）；可直接上传 .txt/.py/.php/.h/.js/.md/.json/.csv 等文本/代码文件（读内容作为文本发给模型，超 512KB 截断）；单图上限 5MB → 100MB | 原附件系统只收 4 种图片格式、文本文件直接报 "unsupported image media type"、单图默认 5MB 太小 |
| 体验修复 | 缓存命中率显示精确到两位小数；添加工作区时中文路径不再被截断 | Math.round 取整导致 95.6% 显示成 96%；Windows 原生目录选择器把「销」这类字符（低字节为 0）误判为字符串结尾，「核销」变「核」 |

## 安装

```powershell
cd <dsh-enhancer 目录>
npm install
# 把 "dsh-enhancer"（link 依赖）加入 <DSH_HOME>\profiles\web\package.json 的
# dependencies 和 dsh.profile.bundles，然后在该目录执行 pnpm install
# 重启 dsh 生效；浏览器侧补丁需硬刷新页面（Ctrl+F5）
```

## 配置（cordis.patch.yml 或 设置 → 插件配置）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `provider` | `deepseek-official` | 适配的 provider 路由 |
| `visionModel` | `''` | 图片识别固定模型；空 = 跟随当前模型 |
| `fallbacks` | `{}` | 不可用模型的降级目标，如 `{ "MiniMax-M3": "MiniMax-M2.7" }` |
| `moonshotModels` | `[]` | 强制 Moonshot 兼容 schema 的模型 id/前缀，如 `["kimi-k3"]` |
| `requestTimeoutMs` | `600000` | 适配请求超时（毫秒），默认 10 分钟 |
| `autoProbeOnStart` | `true` | 启动时自动探测模型 |
| `applyClientPatch` | `true` | 自动应用补丁（缓存精度/图片准入/路径截断/格式扩展/大小限制/文本文件） |

## 补丁 CLI

```powershell
node scripts\patch-client.mjs           # 应用全部补丁（幂等，自动备份 *.dsh-enhancer.bak）
node scripts\patch-client.mjs --revert  # 从备份还原全部补丁
```

## 已知限制

- 补丁修改 dsh 安装目录下的 bundle 文件，DSH 升级后会自动重打；若匹配失败日志会提示，可手动运行补丁 CLI。
- Office 文档（docx/xlsx/pdf 等）暂不支持，后续版本考虑。
- 具体模型 API 对 AVIF/TIFF/SVG/HEIC 的接受度不一，插件已统一转 PNG 发送；浏览器预览同样受浏览器支持度影响。
- 非文本、非图片文件（压缩包、二进制等）仍不作为附件接受。

## License

MIT
