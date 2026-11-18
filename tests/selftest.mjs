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
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { apply, __internal, findOllamaApp, findOllamaExe, looksUntranslated, normalizeConfig, ROUTE_PATH } from '../index.js'

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

check(
  '注册了 API 精确路由 + 资源前缀路由',
  routes.length === 2 &&
    routes.some((item) => item.kind === 'exact' && item.path === ROUTE_PATH) &&
    routes.some((item) => item.kind === 'prefix' && item.path === '/dsh-translate/assets'),
  JSON.stringify(routes.map((item) => item.kind + ' ' + item.path))
)
const route = routes.find((item) => item.path === ROUTE_PATH)

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

section('4. PDF 排版（pdf.js + pdf-lib）')

const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib')
const pdfModule = await import('../pdf.js')

async function makeFixturePdf() {
  const doc = await PDFDocument.create()
  const page = doc.addPage([595, 842])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  page.drawText('The inner product of two vectors is a single real number.', { x: 72, y: 760, size: 12, font, color: rgb(0, 0, 0) })
  page.drawText('It is also called the dot product.', { x: 72, y: 740, size: 12, font, color: rgb(0, 0, 0) })
  page.drawText('u = [ 1  2 ]  v = [ 3  4 ]', { x: 72, y: 700, size: 12, font, color: rgb(0, 0, 0) })
  return new Uint8Array(await doc.save())
}

const fixturePdf = await makeFixturePdf()
const parsed = await pdfModule.readPdfBlocks(fixturePdf)
check('pdf 解析出页与段落', parsed.pageCount === 1 && parsed.pages[0].blocks.length >= 2, JSON.stringify(parsed.pages?.map((page) => page.blocks.length)))
check(
  'pdf 段落文本正确',
  parsed.pages[0].blocks.some((block) => block.text.includes('inner product')),
  parsed.pages[0].blocks.map((block) => block.text.slice(0, 40)).join(' | ')
)
check('公式行被标记为不翻译', parsed.pages[0].blocks.some((block) => !block.translatable))

const fontInfo = pdfModule.resolvePdfFont()
check('找到可嵌入的中文字体', fontInfo && !/\.ttc$/i.test(fontInfo.path), fontInfo && fontInfo.path)
if (fontInfo) {
  const translations = {}
  for (const block of parsed.pages[0].blocks) {
    if (block.translatable) translations[`0:${block.id}`] = '内积是两个向量的一个实数。'
  }
  const overlayPdf = await pdfModule.buildBilingualPdf({
    bytes: fixturePdf,
    pages: parsed.pages,
    translations,
    mode: 'overlay',
    font: fontInfo,
    options: {},
  })
  check('覆盖模式生成了 PDF', overlayPdf.bytes.length > fixturePdf.length, `${overlayPdf.bytes.length} bytes`)
  const checkDoc = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const checkLoaded = await checkDoc.getDocument({ data: new Uint8Array(overlayPdf.bytes), standardFontDataUrl: '' }).promise
  const outPage = await checkLoaded.getPage(1)
  const outContent = await outPage.getTextContent()
  const outText = outContent.items.map((item) => item.str).join('')
  await checkLoaded.destroy()
  check('覆盖模式里写入了译文', outText.includes('内积'), outText.slice(0, 80))

  const dualPdf = await pdfModule.buildBilingualPdf({
    bytes: fixturePdf,
    pages: parsed.pages,
    translations,
    mode: 'dual',
    font: fontInfo,
    options: {},
  })
  const dualDoc = await checkDoc.getDocument({ data: new Uint8Array(dualPdf.bytes), standardFontDataUrl: '' }).promise
  check('对照模式是原文页 + 译文页', dualDoc.numPages === 2, String(dualDoc.numPages))
  check('排版统计：翻译块数 > 0 且无重叠', dualPdf.stats.translated > 0 && dualPdf.stats.overlaps.length === 0, JSON.stringify(dualPdf.stats))
  await dualDoc.destroy()
}

// 分块：块大小上限（整页正文不能被并成一块）
const syntheticLines = []
for (let i = 0; i < 60; i += 1) {
  syntheticLines.push({
    text: `line ${i} of a long single column paragraph with several words to exceed the cap`,
    x: 50,
    y: 700 - i * 12,
    width: 400,
    height: 9,
  })
}
const cappedBlocks = pdfModule.groupParagraphs(syntheticLines, 612, 792)
check(
  '单栏长正文按上限切块（<=900 字符，句子边界可放宽）',
  cappedBlocks.length > 1 && cappedBlocks.every((block) => block.text.length <= 900),
  `blocks=${cappedBlocks.length} max=${Math.max(...cappedBlocks.map((block) => block.text.length))}`
)

// 分栏：左右两栏的片段要分开（否则两栏文本会被并成一行、顺序错乱）
const twoColumnItems = []
for (let i = 0; i < 12; i += 1) {
  const y = 700 - i * 14
  twoColumnItems.push({ str: `Left column line ${i}`, width: 200, transform: [1, 0, 0, 1, 46, y] })
  twoColumnItems.push({ str: `Right column line ${i}`, width: 200, transform: [1, 0, 0, 1, 310, y] })
}
const parts = pdfModule.partitionByColumn(twoColumnItems, 612)
check(
  '双栏片段按空白沟分开',
  parts.left.length >= 10 && parts.right.length >= 10 && parts.full.length === 0,
  `left=${parts.left.length} right=${parts.right.length} full=${parts.full.length}`
)

// 译文校验：英文原样返回要被判失败，中文译文要放行
check(
  '译文校验：英文原样返回判为未翻译',
  looksUntranslated('For robots to be useful, they must possess skills.', 'zh-Hans', 'For robots to be useful, they must possess skills.') === true
)
check(
  '译文校验：中文译文放行',
  looksUntranslated('为了使机器人有用，它们必须具备技能。', 'zh-Hans', 'For robots to be useful, they must possess skills.') === false
)
check(
  '译文校验：原文已是中文时不判失败',
  looksUntranslated('已经是中文', 'zh-Hans', '已经是中文') === false
)
check(
  '译文校验：非中文目标不启用',
  looksUntranslated('For robots to be useful.', 'en', '这是一段中文原文') === false
)

const routePdf = await callRoute(route, {
  body: JSON.stringify({ action: 'pdfExtract', name: 'fixture.pdf', dataBase64: Buffer.from(fixturePdf).toString('base64') }),
})
check('路由 pdfExtract 返回页面与段落', routePdf.json?.ok === true && routePdf.json.pages.length === 1, JSON.stringify(routePdf.json?.error))

const routeBuild = await callRoute(route, {
  body: JSON.stringify({
    action: 'pdfBuild',
    dataBase64: Buffer.from(fixturePdf).toString('base64'),
    pages: routePdf.json?.pages || [],
    translations: { '0:b0': '内积测试' },
    mode: 'overlay',
  }),
})
check('路由 pdfBuild 返回 PDF base64', routeBuild.json?.ok === true && String(routeBuild.json.dataBase64 || '').length > 100, JSON.stringify(routeBuild.json?.error))

const ollamaExe = findOllamaExe()
check(
  '能找到 ollama.exe（找不到也算合法，返回 null）',
  ollamaExe === null || (typeof ollamaExe === 'string' && existsSync(ollamaExe)),
  String(ollamaExe)
)
const ollamaApp = findOllamaApp()
check(
  '能找到 ollama 托盘应用（找不到也算合法，返回 null）',
  ollamaApp === null || (typeof ollamaApp === 'string' && existsSync(ollamaApp)),
  String(ollamaApp)
)
check('ollamaLaunch 默认 auto', normalizeConfig({}).ollamaLaunch === 'auto')
check('ollamaLaunch 非法值回退 auto', normalizeConfig({ ollamaLaunch: 'nope' }).ollamaLaunch === 'auto')
check('配置默认自动启动 Ollama', normalizeConfig({}).autoStartOllama === true)
check('autoStartOllama 可关闭', normalizeConfig({ autoStartOllama: false }).autoStartOllama === false)
check('ollamaExe 配置可透传', normalizeConfig({ ollamaExe: 'D:/x/ollama.exe' }).ollamaExe === 'D:/x/ollama.exe')

check('effect 清理函数已登记', effects.length >= 2)
for (const disposer of effects) if (typeof disposer === 'function') disposer()

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
