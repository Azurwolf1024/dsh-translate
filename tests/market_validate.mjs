/**
 * 校验 market/index.json（DSH 插件市场索引格式 1）。
 * 需要 devDependency：@deepseek-ai/dsh-plugin-market-index（官方校验器）。
 * 用法：pnpm run test:market
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const indexPath = join(here, '..', 'market', 'index.json')
const indexUrl = 'https://raw.githubusercontent.com/Azurwolf1024/dsh-translate/main/market/index.json'

const { parseMarketIndex, marketInstallTarget } = await import('@deepseek-ai/dsh-plugin-market-index')

let failed = 0
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failed += 1
}

const raw = readFileSync(indexPath, 'utf8')
let parsed
try {
  parsed = parseMarketIndex(JSON.parse(raw), indexUrl)
  check('索引符合格式 1', true)
} catch (error) {
  check('索引符合格式 1', false, `${error?.message || error} (path: ${error?.path || '?'})`)
  process.exit(1)
}

check('至少收录一个插件', parsed.plugins.length > 0, `${parsed.plugins.length} 个`)
for (const plugin of parsed.plugins) {
  check(`插件 ${plugin.name} 有版本`, plugin.versions.length > 0, plugin.versions.map((v) => v.version).join(','))
  for (const version of plugin.versions) {
    const target = marketInstallTarget(plugin.name, version)
    const okSpec = version.source.type === 'git' ? /^git\+https:\/\/.+#[0-9a-f]{40}/.test(target.spec) : target.spec.includes('@')
    check(`  ${plugin.name}@${version.version} 安装 spec 合法`, okSpec, target.spec)
  }
}

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`)
process.exit(failed === 0 ? 0 : 1)
