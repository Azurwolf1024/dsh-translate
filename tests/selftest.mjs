/**
 * dsh-translate 离线 + 真机自检。
 *
 * 用法（在插件目录里）：
 *   node tests/selftest.mjs           # 纯函数 + 路由（status/extract/卸载）
 *   node tests/selftest.mjs --live    # 额外跑真实 Ollama 翻译（会加载模型，随后卸载）
 *
 * 不依赖 DSH 运行时：用一个最小 fake ctx 提供 webServer / effect / inject，
 * 再把真实的 HTTP handler 当普通函数驱动。
 */
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { apply, __internal, ROUTE_PATH } from '../index.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, 'fixtures')
const live = process.argv.includes('--live')

let failures = 0
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
function section(title) {
  console.log(`\n${title}`)
}

/* ───────────────────────────── 1. 纯函数 ───────────────────────────── */

section('1. 纯函数')

const { splitSegments, assembleSegments, buildSystemPrompt, postProcess, cjkRatio, resolveTarget, splitProse } = __internal

const mixed = '# 标题\n\n第一段文字。\n\n```bash\nnpm install\n```\n\n- 列表项一\n- 列表项二\n'
const segments = splitSegments(mixed, 1200)
check('代码块被识别为 code 段', segments.some((s) => s.kind === 'code' && s.text.includes('npm install')))
check('散文段不含代码', segments.filter((s) => s.kind === 'text').every((s) => !s.text.includes('npm install')))
check(
  'lead/trail 拼回原文',
  assembleSegments(segments, segments.map((s) => (s.kind === 'code' ? s.text : s.text))) === mixed,
  JSON.stringify(assembleSegments(segments, segments.map((s) => s.text))),
)
check('空输入不产生空段', splitSegments('   \n\n  ', 500).length === 0)

const long = 'Sentence one. '.repeat(120)
const chunks = splitProse(long, 200)
check('超长文本按句切分', chunks.length > 1 && chunks.every((c) => c.length <= 260), `${chunks.length} chunks`)
check('切分不丢字符', chunks.join('').replace(/\s+/g, ' ').trim() === long.replace(/\s+/g, ' ').trim())

const prompt = buildSystemPrompt({ targetLanguage: 'zh-Hant', tone: 'formal', glossary: 'token=令符' })
check('prompt 含目标语言（中文语言名）', prompt.includes('繁體中文（台灣）'), prompt)
check('prompt 含繁体字符提示', prompt.includes('使用繁體字'))
check('prompt 含术语表', prompt.includes('token=令符'))
check('prompt 要求只输出译文', prompt.includes('Output only the translation'))

check('去掉译文前缀', postProcess('译文：你好', 'Hello') === '你好')
check('去掉包裹引号', postProcess('“你好”', 'Hello') === '你好')
check('去掉整体代码围栏', postProcess('```\n你好\n```', 'Hello') === '你好')
check('保留原文里的代码围栏', postProcess('```js\n你好\n```', '```js\nHello\n```').includes('```'))

check('中文占比判定', cjkRatio('这是中文') > 0.9 && cjkRatio('plain english') === 0)
check('自动方向：中文→英文', resolveTarget('auto', '这是中文') === 'en')
check('自动方向：英文→中文', resolveTarget('auto', 'this is english') === 'zh-Hans')
check('显式方向优先', resolveTarget('ja', '这是中文') === 'ja')

/* ───────────────────────────── 2. 文件解析 ───────────────────────────── */

section('2. 文件解析')

const { extractText } = __internal
const docx = extractText({ name: 'sample.docx', bytes: readFileSync(join(fixtures, 'sample.docx')) })
check('docx 抽取正文', docx.text.includes('Installation') && docx.text.includes('five minutes'), JSON.stringify(docx.text.slice(0, 120)))
check('docx 表格单元格', /Name\tValue/.test(docx.text), JSON.stringify(docx.text.slice(-80)))

const xlsx = extractText({ name: 'sample.xlsx', bytes: readFileSync(join(fixtures, 'sample.xlsx')) })
check('xlsx 抽取单元格', xlsx.text.includes('selection translate\tenabled'), JSON.stringify(xlsx.text.slice(0, 120)))

const pptx = extractText({ name: 'sample.pptx', bytes: readFileSync(join(fixtures, 'sample.pptx')) })
check('pptx 抽取幻灯片', pptx.text.includes('Plugin Overview') && pptx.text.includes('Unload the model when idle'))

const epub = extractText({ name: 'sample.epub', bytes: readFileSync(join(fixtures, 'sample.epub')) })
check('epub 抽取章节', epub.text.includes('Hello world') && epub.text.includes('Another chapter'), JSON.stringify(epub.text))

const html = extractText({ name: 'a.html', bytes: Buffer.from('<h1>标题</h1><p>第一段</p><script>bad()</script>') })
check('html 剥标签去脚本', html.text.includes('标题') && html.text.includes('第一段') && !html.text.includes('bad()'))

let pdfError = null
try {
  extractText({ name: 'a.pdf', bytes: Buffer.from('%PDF-1.4') })
} catch (error) {
  pdfError = error
}
check('pdf 明确报不支持', pdfError?.code === 'EXTRACT_UNSUPPORTED', String(pdfError))

/* ───────────────────────────── 3. 路由（真机） ───────────────────────────── */

section('3. 路由（真机 Ollama）')

function makeFakeCtx() {
  const routes = []
  const effects = []
  const webServer = {
    register(route) {
      routes.push(route)
      return () => {
        const at = routes.indexOf(route)
        if (at >= 0) routes.splice(at, 1)
      }
    },
  }
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    webServer,
    get(name) {
      return name === 'webServer' ? webServer : undefined
    },
    inject(names, callback) {
      if (names.includes('webServer')) callback(ctx)
    },
    effect(callback) {
      const disposer = typeof callback === 'function' ? callback() : undefined
      effects.push(disposer)
      return disposer
    },
  }
  return { ctx, routes, effects }
}

function makeRequest({ method = 'POST', body = '', headers = {} } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.headers = { host: '127.0.0.1:61213', ...headers }
  req.destroy = () => {}
  const res = new EventEmitter()
  res.parts = []
  res.writableEnded = false
  res.writeHead = (code, extra) => {
    res.statusCode = code
    res.headers = extra
  }
  res.end = (chunk) => {
    if (chunk) res.parts.push(Buffer.from(chunk))
    res.writableEnded = true
    setImmediate(() => res.emit('close'))
  }
  return { req, res }
}

async function callRoute(route, options = {}) {
  const { req, res } = makeRequest(options)
  const finished = new Promise((resolve) => res.once('close', resolve))
  await route.handler(req, res)
  setImmediate(() => {
    const body = options.body
    if (body) req.emit('data', Buffer.isBuffer(body) ? body : Buffer.from(body))
    req.emit('end')
  })
  await finished
  const text = Buffer.concat(res.parts).toString('utf8')
  return { status: res.statusCode, json: text ? JSON.parse(text) : null }
}

const { ctx, routes, effects } = makeFakeCtx()
apply(ctx, { model: 'kaelri/hy-mt2:1.8b', keepAlive: '5m', idleUnloadMs: 60000 })

check('注册了唯一路由', routes.length === 1 && routes[0].path === ROUTE_PATH && routes[0].kind === 'exact')
const route = routes[0]

const foreign = await callRoute(route, { headers: { origin: 'http://evil.example', host: '127.0.0.1:61213' } })
check('拒绝跨源请求', foreign.status === 403, JSON.stringify(foreign.json))

const status = await callRoute(route, { method: 'GET' })
check('GET 返回状态', status.json?.ok === true && status.json.status.model === 'kaelri/hy-mt2:1.8b')
check('Ollama 可达', status.json?.status?.reachable === true, JSON.stringify(status.json?.status?.error))
check('模型已安装', status.json?.status?.installed === true, JSON.stringify(status.json?.status?.models?.map((m) => m.name)))

const extract = await callRoute(route, {
  body: JSON.stringify({ action: 'extract', name: 'sample.docx', dataBase64: readFileSync(join(fixtures, 'sample.docx')).toString('base64') }),
})
check('路由 extract 返回分段', extract.json?.ok === true && extract.json.segments.length >= 2, JSON.stringify(extract.json?.segments?.length))

const srtText = '1\n00:00:01,000 --> 00:00:04,000\nHello there.\n\n2\n00:00:05,000 --> 00:00:08,000\nSecond line.\n'
const srt = await callRoute(route, {
  body: JSON.stringify({ action: 'extract', name: 'demo.srt', dataBase64: Buffer.from(srtText).toString('base64') }),
})
check('字幕走按行布局', srt.json?.layout === 'lines', JSON.stringify(srt.json?.layout))
check('字幕时间轴保留为 code', srt.json?.segments?.some((segment) => segment.kind === 'code' && segment.text.includes('-->')))
check(
  '字幕只把文本行交给模型',
  srt.json?.segments
    ?.filter((segment) => segment.kind === 'text')
    .map((segment) => segment.text)
    .join('|') === 'Hello there.|Second line.',
)

const external = await callRoute(route, { body: JSON.stringify({ action: 'externalStatus' }) })
check(
  'externalStatus 报告伴生进程状态',
  external.json?.ok === true && external.json.external.helperExists === true && external.json.external.supported === true,
  JSON.stringify(external.json?.external),
)

const badPort = await callRoute(route, { body: JSON.stringify({ action: 'externalStart', port: 999999 }) })
check('非法端口被拒绝', badPort.json?.ok === false && badPort.json.error.code === 'BAD_REQUEST')

const empty = await callRoute(route, { body: JSON.stringify({ action: 'translate', text: '   ' }) })
check('空文本被拒绝', empty.status === 400 && empty.json.error.code === 'BAD_REQUEST')

const unknown = await callRoute(route, { body: JSON.stringify({ action: 'nope' }) })
check('未知动作被拒绝', unknown.json?.ok === false && unknown.json.error.code === 'BAD_REQUEST')

if (live) {
  const t0 = Date.now()
  const translated = await callRoute(route, {
    body: JSON.stringify({ action: 'translate', text: 'The model is unloaded when it is idle.', targetLanguage: 'zh-Hans' }),
  })
  check('真机翻译返回中文', translated.json?.ok === true && /[\u4e00-\u9fff]/.test(translated.json.text), JSON.stringify(translated.json))
  console.log(`       → ${translated.json?.text} (${Date.now() - t0} ms, ${translated.json?.chunks} 段)`)

  const unloaded = await callRoute(route, { body: JSON.stringify({ action: 'unload' }) })
  check('卸载后 loaded=false', unloaded.json?.ok === true && unloaded.json.status.loaded === false, JSON.stringify(unloaded.json?.status))
}

check('effect 清理函数已登记', effects.length >= 2)
for (const disposer of effects) if (typeof disposer === 'function') disposer()

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
