#!/usr/bin/env node
/**
 * dsh-enhancer 客户端补丁 CLI
 *
 * 用法：
 *   node scripts/patch-client.mjs                  # 自动定位并应用补丁（幂等）
 *   node scripts/patch-client.mjs --file <path>    # 指定 conversation client.js
 *   node scripts/patch-client.mjs --revert         # 从备份还原（需要 --file 或自动定位）
 */
import { runCli } from '../lib/patch-client.js'

await runCli(process.argv.slice(2))
