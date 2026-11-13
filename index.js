/**
 * dsh-translate —— Host 半边。
 *
 * 职责：把本地 Ollama 的翻译小模型包装成一个**无状态**翻译内核，并用一条包私有
 * HTTP 路由（`POST /dsh-translate/api`）暴露给本包的浏览器半边。
 *
 * 设计约束（来自需求）：
 *   1. 翻译内核 = 本地 Ollama 模型（默认 Hunyuan-MT2 1.8B），不接入宿主 LLM 通道 ——
 *      后者会把请求写进会话、带 system prompt 与历史，违反「每次翻译不保留上下文」。
 *   2. 每次请求 = 一条 system + 一条 user message；不复用 /api/generate 的 `context`，
 *      不缓存译文，不跨请求保存任何对话状态。
 *   3. 清理三层：
 *      ① 请求级：AbortSignal 贯穿 client → route → Ollama；客户端断开即终止生成。
 *      ② 模型级：`keep_alive` 默认 "5m"，配合空闲卸载器（idleUnloadMs，默认 90s）
 *         把模型从显存/共享内存里卸掉。
 *      ③ 卸载兜底：插件卸载时 abort 在飞请求并 best-effort 卸载。
 *   4. 手动控制：`load` / `unload` 动作；手动加载会把模型「钉住」，空闲卸载器不碰它。
 *
 * 文件只在本机回环地址上被服务；路由额外做 Origin / Sec-Fetch-Site 校验。
 *
 * 纯函数（分段、prompt、后处理、zip/docx/xlsx/pptx 解析）通过 `__internal` 导出，
 * 供 tests/selftest.mjs 离线断言。
 */

import { inflateRawSync } from 'node:zlib'

export const ROUTE_PATH = '/dsh-translate/api'

/* ────────────────────────────── 语言 / 语气表 ────────────────────────────── */

/** 目标语言表：prompt 里的英文名 + 可选的字符提示（简体模型容易被「繁体」指令带偏）。 */
export const LANGS = {
  'zh-Hans': { label: '简体中文', prompt: 'Simplified Chinese', cjk: true },
  'zh-Hant': {
    label: '繁體中文',
    prompt: '繁體中文（台灣）',
    cjk: true,
    // 1.8B 模型对「Traditional Chinese」这种英文语言名会输出简体；用中文语言名 + 中文提示才稳定。
    hint: '使用繁體字（例如：這個、會、還、們），不得使用簡體字。',
  },
  en: { label: 'English', prompt: 'English' },
  ja: { label: '日本語', prompt: 'Japanese' },
  ko: { label: '한국어', prompt: 'Korean' },
  fr: { label: 'Français', prompt: 'French' },
  de: { label: 'Deutsch', prompt: 'German' },
  es: { label: 'Español', prompt: 'Spanish' },
  ru: { label: 'Русский', prompt: 'Russian' },
  pt: { label: 'Português', prompt: 'Portuguese' },
  it: { label: 'Italiano', prompt: 'Italian' },
  ar: { label: 'العربية', prompt: 'Arabic' },
  th: { label: 'ไทย', prompt: 'Thai' },
  vi: { label: 'Tiếng Việt', prompt: 'Vietnamese' },
}

/** 语气：只追加一句风格描述，保持「只输出译文」的主指令不变。 */
export const TONES = {
  natural: { label: '自然', clause: '' },
  literal: { label: '直译', clause: 'Translate as literally as possible while keeping the result grammatical.' },
  casual: { label: '口语', clause: 'Use a casual, conversational tone.' },
  formal: { label: '学术', clause: 'Use a formal, academic tone.' },
  business: { label: '商务', clause: 'Use a concise, professional business tone.' },
}

/* ───────────────────────────────── 错误 ───────────────────────────────── */

export class TranslateError extends Error {
  constructor(code, message, extra) {
    super(message)
    this.name = 'TranslateError'
    this.code = code
    if (extra !== undefined) this.extra = extra
  }
}

function isAbort(err) {
  return !!err && (err.name === 'AbortError' || err.code === 'ABORT_ERR' || err.name === 'TimeoutError')
}

function abortCode(err, timeoutMs) {
  if (err && err.name === 'TimeoutError') return new TranslateError('TIMEOUT', `翻译请求超时（${timeoutMs}ms）`)
  return new TranslateError('CANCELLED', '翻译请求已取消')
}

/* ──────────────────────────── 文本分段 / 组装 ──────────────────────────── */

/** 中日韩字符占比（用于「自动」目标语言方向与选区过滤）。 */
export function cjkRatio(text) {
  const s = String(text ?? '')
  if (!s) return 0
  let cjk = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0)
    if (
      (cp >= 0x3040 && cp <= 0x30ff) || // 假名
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0xf900 && cp <= 0xfaff)
    ) cjk += 1
  }
  return cjk / Math.max(1, [...s].length)
}

/** 把一段散文切成不超过 limit 的块：优先按空行，再按句末标点，最后硬切。 */
export function splitProse(text, limit) {
  const out = []
  const blocks = String(text).split(/(\n{2,})/)
  let buf = ''
  const flush = () => {
    if (buf) out.push(buf)
    buf = ''
  }
  for (const block of blocks) {
    if (!block) continue
    if (/^\n+$/.test(block)) {
      // 段落分隔符：贴到上一块末尾，组装时原样还原
      if (out.length > 0) out[out.length - 1] += block
      else buf += block
      continue
    }
    if (block.length <= limit) {
      if (buf.length + block.length > limit) flush()
      buf += block
      continue
    }
    flush()
    // 超长段落：按句末标点切
    const sentences = block.split(/(?<=[。！？!?；;：:…»」』”"]\s*)/u)
    let line = ''
    for (const sentence of sentences) {
      if (sentence.length > limit) {
        if (line) {
          out.push(line)
          line = ''
        }
        for (let at = 0; at < sentence.length; at += limit) out.push(sentence.slice(at, at + limit))
        continue
      }
      if (line.length + sentence.length > limit) {
        out.push(line)
        line = sentence
      } else {
        line += sentence
      }
    }
    if (line) out.push(line)
  }
  flush()
  return out.filter((chunk) => chunk.trim() !== '')
}

/**
 * 按「代码围栏 + 段落」切段。每段保留自己的首尾空白（lead/trail），
 * 翻译完成后能原样拼回，避免 Markdown 结构被模型重排。
 * @param input 原文
 * @param limit 单段字符上限
 * @param options.paragraphs 为 true 时按空行强制分条（文件翻译要按段显示进度）
 * @returns {{text:string, kind:'text'|'code', lead:string, trail:string}[]}
 */
export function splitSegments(input, limit, options = {}) {
  const source = String(input ?? '')
  const limitSafe = Math.max(120, Number(limit) || 1200)
  const parts = []
  const fence = /```[\s\S]*?```|~~~[\s\S]*?~~~/g
  let last = 0
  let m
  while ((m = fence.exec(source)) !== null) {
    if (m.index > last) parts.push({ text: source.slice(last, m.index), kind: 'text' })
    parts.push({ text: m[0], kind: 'code' })
    last = m.index + m[0].length
  }
  if (last < source.length) parts.push({ text: source.slice(last), kind: 'text' })
  if (parts.length === 0) parts.push({ text: source, kind: 'text' })

  const segments = []
  for (const part of parts) {
    if (part.kind === 'code') {
      if (part.text.trim()) segments.push({ text: part.text, kind: 'code', lead: '', trail: '' })
      continue
    }
    const { lead, core, trail } = trimEdges(part.text)
    if (!core) continue
    const blocks = options.paragraphs ? splitParagraphBlocks(core) : [core]
    blocks.forEach((block, blockIndex) => {
      const chunks = block.length <= limitSafe ? [block] : splitProse(block, limitSafe)
      chunks.forEach((chunk, index) => {
        segments.push({
          text: options.paragraphs ? chunk.trim() : chunk,
          kind: 'text',
          lead: blockIndex === 0 && index === 0 ? lead : '',
          trail: blockIndex === blocks.length - 1 && index === chunks.length - 1 ? trail : '',
        })
      })
    })
  }
  return segments
}

/** 按空行切成段落块（丢弃分隔用的空行，供文件翻译按段推进度）。 */
function splitParagraphBlocks(text) {
  const out = []
  let buffer = ''
  for (const part of String(text).split(/(\n{2,})/)) {
    if (!part) continue
    if (/^\n+$/.test(part)) {
      if (buffer) out.push(buffer)
      buffer = ''
      continue
    }
    buffer += part
  }
  if (buffer) out.push(buffer)
  return out.filter((block) => block.trim() !== '')
}

function trimEdges(text) {
  const lead = /^\s*/.exec(text)[0]
  const rest = text.slice(lead.length)
  const trail = /\s*$/.exec(rest)[0]
  return { lead, core: rest.slice(0, rest.length - trail.length), trail }
}

/** 把各段译文按 lead/trail 拼回全文；代码段原样输出。 */
export function assembleSegments(segments, outputs) {
  let out = ''
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]
    out += segment.lead || ''
    out += segment.kind === 'code' ? segment.text : outputs[i] ?? ''
    out += segment.trail || ''
  }
  return out
}

/* ──────────────────────────── prompt / 后处理 ──────────────────────────── */

/** 「自动」目标语言：中文输入的译文用英文，其他输入用简体中文。 */
export function resolveTarget(requested, text, fallback = 'zh-Hans') {
  const wanted = requested && requested !== 'auto' ? requested : null
  if (wanted) return wanted
  const ratio = cjkRatio(text)
  return ratio > 0.2 ? 'en' : fallback
}

export function buildSystemPrompt({ targetLanguage, tone, glossary }) {
  const lang = LANGS[targetLanguage] ?? LANGS['zh-Hans']
  const toneClause = (TONES[tone] ?? TONES.natural).clause
  let prompt = `You are a professional translator. Translate the user's text into ${lang.prompt}.`
  if (toneClause) prompt += ` ${toneClause}`
  if (glossary && String(glossary).trim()) {
    prompt += ` Follow this glossary strictly: ${String(glossary).trim().replace(/\n+/g, '; ')}.`
  }
  prompt += ' Output only the translation, with no explanations, no notes and no surrounding quotation marks.'
  prompt += ' Preserve the original formatting: line breaks, Markdown, code, numbers, URLs and proper nouns.'
  if (lang.hint) prompt += ` ${lang.hint}`
  return prompt
}

/** 去掉模型偶发的标签/包裹引号/整体代码围栏，折叠多余空行。 */
export function postProcess(raw, original = '') {
  let text = String(raw ?? '').trim()
  text = text.replace(/^(译文|翻译结果|翻译|Translation|Translated text)\s*[:：]\s*/i, '')
  const pairs = [
    ['"', '"'],
    ['“', '”'],
    ["'", "'"],
    ['「', '」'],
    ['『', '』'],
  ]
  for (const [open, close] of pairs) {
    if (text.length > 2 && text.startsWith(open) && text.endsWith(close)) {
      text = text.slice(open.length, text.length - close.length).trim()
      break
    }
  }
  if (!/```/.test(original) && text.startsWith('```')) {
    text = text
      .replace(/^```[^\n]*\n?/, '')
      .replace(/\n?```\s*$/, '')
      .trim()
  }
  return text.replace(/\n{3,}/g, '\n\n')
}

/* ─────────────────────────────── 文件解析 ─────────────────────────────── */

const TEXT_EXTENSIONS = new Set([
  'txt', 'text', 'log', 'md', 'markdown', 'mdx', 'rst', 'adoc', 'tex',
  'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'ini', 'toml', 'env',
  'html', 'htm', 'xhtml', 'xml',
])

/** 块状字幕：按「行」处理，序号/时间轴原样保留，只翻文本行。 */
const SUBTITLE_EXTENSIONS = new Set(['srt', 'vtt'])

const ZIP_EXTENSIONS = new Set(['docx', 'docm', 'xlsx', 'xlsm', 'pptx', 'pptm', 'epub'])

export function listFormats() {
  return {
    text: [...TEXT_EXTENSIONS].sort(),
    office: ['docx', 'xlsx', 'pptx', 'epub'],
    subtitles: [...SUBTITLE_EXTENSIONS],
    unsupported: ['pdf', 'doc', 'xls', 'ppt', 'ass', 'lrc'],
  }
}

/**
 * 字幕行分类：序号行 / 时间轴行 / 空行 / 结构标记 → 原样保留（code），其余为待译文本。
 */
function subtitleSegments(text) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim()
      const structural =
        trimmed === '' ||
        /^\d+$/.test(trimmed) ||
        trimmed.includes('-->') ||
        /^WEBVTT/i.test(trimmed) ||
        /^(NOTE|STYLE|REGION|kind:|language:)/i.test(trimmed)
      return { text: line, kind: structural ? 'code' : 'text' }
    })
}

export function decodeEntities(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
  return String(text)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => safeChar(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeChar(parseInt(dec, 10)))
    .replace(/&([a-zA-Z]+);/g, (whole, name) => named[name] ?? whole)
}

function safeChar(code) {
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

/** HTML/XML → 纯文本：块级标签转换行，其余标签剥掉。 */
export function htmlToText(html) {
  let text = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote|pre|table|ul|ol|dl|dt|dd)>/gi, '\n')
    .replace(/<\/(td|th)>/gi, '\t')
    .replace(/<[^>]+>/g, '')
  text = decodeEntities(text)
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 极简 ZIP 中央目录读取器（只支持 stored / deflate，Office 与 EPUB 够用）。 */
export function readZip(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  const EOCD = 0x06054b50
  let eocd = -1
  const floor = Math.max(0, buf.length - 66000)
  for (let at = buf.length - 22; at >= floor; at -= 1) {
    if (buf.readUInt32LE(at) === EOCD) {
      eocd = at
      break
    }
  }
  if (eocd < 0) throw new TranslateError('EXTRACT_FAILED', '不是有效的 zip 容器')
  const count = buf.readUInt16LE(eocd + 10)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (cdOffset === 0xffffffff) throw new TranslateError('EXTRACT_FAILED', '不支持 ZIP64 容器')
  const entries = new Map()
  let at = cdOffset
  for (let index = 0; index < count; index += 1) {
    if (buf.readUInt32LE(at) !== 0x02014b50) break
    const method = buf.readUInt16LE(at + 10)
    const compSize = buf.readUInt32LE(at + 20)
    const nameLen = buf.readUInt16LE(at + 28)
    const extraLen = buf.readUInt16LE(at + 30)
    const commentLen = buf.readUInt16LE(at + 32)
    const localOffset = buf.readUInt32LE(at + 42)
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen)
    entries.set(name, { method, compSize, localOffset })
    at += 46 + nameLen + extraLen + commentLen
  }
  return {
    names: () => [...entries.keys()],
    has: (name) => entries.has(name),
    read(name) {
      const entry = entries.get(name)
      if (!entry) return null
      const head = entry.localOffset
      if (buf.readUInt32LE(head) !== 0x04034b50) throw new TranslateError('EXTRACT_FAILED', `zip 头损坏：${name}`)
      const nameLen = buf.readUInt16LE(head + 26)
      const extraLen = buf.readUInt16LE(head + 28)
      const start = head + 30 + nameLen + extraLen
      const raw = buf.subarray(start, start + entry.compSize)
      if (entry.method === 0) return Buffer.from(raw)
      if (entry.method === 8) return inflateRawSync(raw)
      throw new TranslateError('EXTRACT_FAILED', `不支持的 zip 压缩方式 ${entry.method}`)
    },
  }
}

function docxText(zip) {
  const parts = []
  const order = [
    'word/document.xml',
    'word/header1.xml', 'word/header2.xml', 'word/header3.xml',
    'word/footer1.xml', 'word/footer2.xml', 'word/footer3.xml',
    'word/footnotes.xml', 'word/endnotes.xml', 'word/comments.xml',
  ]
  for (const name of order) {
    const data = zip.read(name)
    if (!data) continue
    const xml = data.toString('utf8')
      .replace(/<w:tab[^>]*\/>/g, '\t')
      .replace(/<w:br[^>]*\/>/g, '\n')
      .replace(/<w:delText[\s\S]*?<\/w:delText>/g, '')
      .replace(/<\/w:p>\s*<\/w:tc>/g, '\t')
      .replace(/<\/w:tc>/g, '\t')
      .replace(/<\/w:tr>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
    parts.push(
      decodeEntities(xml.replace(/<[^>]+>/g, ''))
        .replace(/[ \t]+$/gm, '')
        .replace(/\t\n/g, '\n'),
    )
  }
  return parts.join('\n')
}

function pptxText(zip) {
  const slides = zip
    .names()
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1]))
  const parts = []
  for (const name of slides) {
    const data = zip.read(name)
    if (!data) continue
    const xml = data.toString('utf8')
      .replace(/<a:br[^>]*\/>/g, '\n')
      .replace(/<\/a:p>/g, '\n')
    parts.push(decodeEntities(xml.replace(/<[^>]+>/g, '')))
  }
  return parts.join('\n\n')
}

function xlsxText(zip) {
  const shared = []
  const sharedData = zip.read('xl/sharedStrings.xml')
  if (sharedData) {
    const xml = sharedData.toString('utf8')
    for (const si of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      const runs = [...si[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1])
      shared.push(decodeEntities(runs.join('')))
    }
  }
  const sheets = zip
    .names()
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1]))
  const parts = []
  for (const name of sheets) {
    const data = zip.read(name)
    if (!data) continue
    const xml = data.toString('utf8')
    const rows = []
    for (const row of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = []
      for (const cell of row[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attrs = cell[1]
        const body = cell[2]
        const type = /\bt="([^"]+)"/.exec(attrs)?.[1]
        if (type === 's') {
          const index = Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '-1')
          cells.push(shared[index] ?? '')
        } else if (type === 'inlineStr') {
          cells.push(decodeEntities([...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join('')))
        } else {
          cells.push(decodeEntities(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? ''))
        }
      }
      if (cells.some((cell) => cell !== '')) rows.push(cells.join('\t'))
    }
    if (rows.length) parts.push(rows.join('\n'))
  }
  return parts.join('\n\n')
}

function epubText(zip) {
  const docs = zip
    .names()
    .filter((name) => /\.(x?html|htm)$/i.test(name) && !/META-INF/i.test(name))
    .sort()
  const parts = []
  for (const name of docs) {
    const data = zip.read(name)
    if (!data) continue
    const text = htmlToText(data.toString('utf8'))
    if (text) parts.push(text)
  }
  return parts.join('\n\n')
}

/**
 * 从文件名 + 字节里抽出纯文本。
 * @returns {{format:string, text:string, warnings:string[]}}
 */
export function extractText({ name, bytes }) {
  const filename = String(name || 'untitled')
  const dot = filename.lastIndexOf('.')
  const extension = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : ''
  const warnings = []
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)

  if (extension === 'pdf') {
    throw new TranslateError('EXTRACT_UNSUPPORTED', '暂不支持 PDF：请另存为 .docx / .txt 后再翻译')
  }
  if (extension === 'doc' || extension === 'xls' || extension === 'ppt') {
    throw new TranslateError('EXTRACT_UNSUPPORTED', `暂不支持旧版 Office 二进制格式（.${extension}）：请另存为 .docx / .xlsx / .pptx`)
  }
  if (TEXT_EXTENSIONS.has(extension) || extension === '') {
    const raw = buf.toString('utf8').replace(/^\uFEFF/, '')
    const isHtml = extension === 'html' || extension === 'htm' || extension === 'xhtml'
    const text = isHtml ? htmlToText(raw) : raw
    return { format: isHtml ? `html` : extension || 'txt', text, warnings }
  }
  if (SUBTITLE_EXTENSIONS.has(extension)) {
    const raw = buf.toString('utf8').replace(/^\uFEFF/, '')
    warnings.push('字幕按行处理：序号与时间轴原样保留，只翻译文本行')
    return { format: extension, text: raw, warnings }
  }
  if (extension === 'ass' || extension === 'lrc') {
    throw new TranslateError('EXTRACT_UNSUPPORTED', `暂不支持 .${extension}：时间轴与文本在同一行，逐行翻译会破坏时间戳`)
  }
  if (ZIP_EXTENSIONS.has(extension)) {
    const zip = readZip(buf)
    const text =
      extension === 'docx' || extension === 'docm'
        ? docxText(zip)
        : extension === 'pptx' || extension === 'pptm'
          ? pptxText(zip)
          : extension === 'epub'
            ? epubText(zip)
            : xlsxText(zip)
    if (extension === 'xlsx' || extension === 'xlsm') warnings.push('表格按行抽取：每个单元格以制表符分隔')
    return { format: extension, text, warnings }
  }
  throw new TranslateError('EXTRACT_UNSUPPORTED', `不支持的文件类型：.${extension || '?'}`)
}

/* ─────────────────────────────── 配置归一 ─────────────────────────────── */

export const DEFAULTS = Object.freeze({
  baseURL: 'http://127.0.0.1:11434',
  model: 'kaelri/hy-mt2:1.8b',
  keepAlive: '5m',
  idleUnloadMs: 90000,
  timeoutMs: 120000,
  maxTextChars: 20000,
  chunkChars: 1200,
  maxUploadBytes: 12 * 1024 * 1024,
  defaultTarget: 'auto',
  tone: 'natural',
})

function numberOr(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

export function normalizeConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const baseURL = String(input.baseURL || DEFAULTS.baseURL).trim().replace(/\/+$/, '')
  const model = String(input.model || DEFAULTS.model).trim()
  const keepAlive = input.keepAlive === 0 ? '0' : String(input.keepAlive ?? DEFAULTS.keepAlive).trim() || DEFAULTS.keepAlive
  const target = String(input.defaultTarget || DEFAULTS.defaultTarget)
  return {
    baseURL,
    model,
    keepAlive,
    idleUnloadMs: numberOr(input.idleUnloadMs, DEFAULTS.idleUnloadMs, 0, 24 * 3600 * 1000),
    timeoutMs: numberOr(input.timeoutMs, DEFAULTS.timeoutMs, 2000, 15 * 60 * 1000),
    maxTextChars: numberOr(input.maxTextChars, DEFAULTS.maxTextChars, 500, 500000),
    chunkChars: numberOr(input.chunkChars, DEFAULTS.chunkChars, 120, 8000),
    maxUploadBytes: numberOr(input.maxUploadBytes, DEFAULTS.maxUploadBytes, 1024, 64 * 1024 * 1024),
    defaultTarget: LANGS[target] || target === 'auto' ? target : DEFAULTS.defaultTarget,
    tone: TONES[String(input.tone || '')] ? String(input.tone) : DEFAULTS.tone,
    temperature: numberOr(input.temperature, 0.2, 0, 1.5),
  }
}

/* ───────────────────────────── Ollama HTTP 层 ───────────────────────────── */

function combineSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(Math.max(1000, timeoutMs))
  if (!signal) return timeout
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout])
  return signal
}

async function requestJson(url, { method = 'GET', body, signal, timeoutMs = 30000 } = {}) {
  const init = { method, signal: combineSignal(signal, timeoutMs), headers: {} }
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json'
    init.body = typeof body === 'string' ? body : JSON.stringify(body)
  }
  let response
  try {
    response = await fetch(url, init)
  } catch (error) {
    if (isAbort(error)) throw abortCode(error, timeoutMs)
    throw new TranslateError('OLLAMA_UNREACHABLE', `连不上本地 Ollama（${url}）：${error?.message || error}`)
  }
  const text = await response.text().catch(() => '')
  let data = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = null
    }
  }
  if (!response.ok) {
    const detail = (data && (data.error || data.message)) || text.slice(0, 240)
    throw new TranslateError('OLLAMA_HTTP', `Ollama 返回 ${response.status}：${detail}`)
  }
  if (data === null) throw new TranslateError('OLLAMA_HTTP', 'Ollama 返回了无法解析的响应')
  return data
}

async function listTags(cfg, signal) {
  const data = await requestJson(`${cfg.baseURL}/api/tags`, { signal, timeoutMs: 5000 })
  return Array.isArray(data.models) ? data.models : []
}

async function listRunning(cfg, signal) {
  const data = await requestJson(`${cfg.baseURL}/api/ps`, { signal, timeoutMs: 5000 })
  return Array.isArray(data.models) ? data.models : []
}

async function chatOnce({ cfg, messages, signal, numPredict }) {
  const data = await requestJson(`${cfg.baseURL}/api/chat`, {
    method: 'POST',
    timeoutMs: cfg.timeoutMs,
    signal,
    body: {
      model: cfg.model,
      messages,
      stream: false,
      keep_alive: cfg.keepAlive,
      options: {
        temperature: cfg.temperature,
        top_p: 0.9,
        num_predict: Math.min(4096, Math.max(256, Math.ceil(numPredict))),
      },
    },
  })
  const content = data?.message?.content
  if (typeof content !== 'string') throw new TranslateError('OLLAMA_HTTP', 'Ollama 没有返回 message.content')
  return content
}

async function unloadModel(cfg, signal) {
  await requestJson(`${cfg.baseURL}/api/generate`, {
    method: 'POST',
    timeoutMs: 15000,
    signal,
    body: { model: cfg.model, keep_alive: 0, prompt: '', stream: false },
  })
}

/* ─────────────────────────────── 服务状态 ─────────────────────────────── */

function createState(cfg, ctx) {
  return {
    cfg,
    ctx,
    lastActivity: 0,
    /** 本插件触发过加载的模型名；卸载以它为准，避免用户换模型后卸错对象。 */
    touchedModels: new Set(),
    pinned: false,
    inflight: new Set(),
    lastError: null,
    disposed: false,
    log(level, message) {
      try {
        const logger = ctx?.logger
        const write = logger && (logger[level] || logger.warn)
        if (typeof write === 'function') write.call(logger, `[dsh-translate] ${message}`)
      } catch {
        /* 日志失败不影响翻译 */
      }
    },
  }
}

async function statusOf(state, signal, cfg = state.cfg) {
  const result = {
    reachable: true,
    error: null,
    baseURL: cfg.baseURL,
    model: cfg.model,
    installed: false,
    loaded: false,
    pinned: state.pinned,
    keepAlive: cfg.keepAlive,
    idleUnloadMs: cfg.idleUnloadMs,
    models: [],
    loadedModels: [],
    languages: Object.entries(LANGS).map(([id, meta]) => ({ id, label: meta.label })),
    tones: Object.entries(TONES).map(([id, meta]) => ({ id, label: meta.label })),
    formats: listFormats(),
  }
  try {
    const tags = await listTags(cfg, signal)
    result.models = tags.map((entry) => ({
      name: entry.name,
      size: entry.size ?? null,
      params: entry.details?.parameter_size ?? null,
      quant: entry.details?.quantization_level ?? null,
    }))
    result.installed = tags.some((entry) => entry.name === cfg.model)
  } catch (error) {
    result.reachable = false
    result.error = error?.message || String(error)
    return result
  }
  try {
    const running = await listRunning(cfg, signal)
    result.loadedModels = running.map((entry) => entry.name)
    result.loaded = running.some((entry) => entry.name === cfg.model)
  } catch {
    /* /api/ps 失败不影响结论：当作未加载 */
  }
  return result
}

async function warmup(state, cfg, signal) {
  const tags = await listTags(cfg, signal)
  if (!tags.some((entry) => entry.name === cfg.model)) {
    throw new TranslateError('MODEL_MISSING', `本地没有模型 ${cfg.model}，可用模型：${tags.map((t) => t.name).join(', ') || '（无）'}`)
  }
  await requestJson(`${cfg.baseURL}/api/generate`, {
    method: 'POST',
    timeoutMs: cfg.timeoutMs,
    signal,
    body: { model: cfg.model, keep_alive: cfg.keepAlive, prompt: '', stream: false },
  })
  state.touchedModels.add(cfg.model)
  state.pinned = true
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    const running = await listRunning(cfg, signal).catch(() => [])
    if (running.some((entry) => entry.name === cfg.model)) return statusOf(state, signal, cfg)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return statusOf(state, signal, cfg)
}

async function sweepIdle(state) {
  const cfg = state.cfg
  if (cfg.idleUnloadMs <= 0 || state.disposed || state.pinned) return
  if (state.touchedModels.size === 0) return
  if (Date.now() - state.lastActivity < cfg.idleUnloadMs) return
  const running = await listRunning(cfg, undefined).catch(() => null)
  if (!running) return
  const idle = running.filter((entry) => state.touchedModels.has(entry.name))
  if (idle.length === 0) return
  state.log('info', '空闲卸载：把模型从显存/共享内存里释放')
  for (const entry of idle) {
    await unloadModel({ ...cfg, model: entry.name }, undefined).catch((error) =>
      state.log('warn', `空闲卸载 ${entry.name} 失败：${error?.message || error}`),
    )
    state.touchedModels.delete(entry.name)
  }
}

/* ─────────────────────────────── 翻译主流程 ─────────────────────────────── */

async function translateSegments({ state, cfg, segments, spec, signal }) {
  const target = resolveTarget(spec.targetLanguage, spec.text, cfg.defaultTarget === 'auto' ? 'zh-Hans' : cfg.defaultTarget)
  const system = buildSystemPrompt({ targetLanguage: target, tone: spec.tone || cfg.tone, glossary: spec.glossary })
  const outputs = []
  let translated = 0
  for (const segment of segments) {
    if (segment.kind === 'code') {
      outputs.push(segment.text)
      continue
    }
    let attempt = 0
    let lastError = null
    while (attempt < 2) {
      try {
        const raw = await chatOnce({
          cfg,
          signal,
          numPredict: Math.ceil(segment.text.length * 1.8),
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: segment.text },
          ],
        })
        outputs.push(postProcess(raw, segment.text))
        lastError = null
        break
      } catch (error) {
        lastError = error
        if (error?.code === 'CANCELLED' || error?.code === 'TIMEOUT') throw error
        attempt += 1
        if (attempt >= 2) throw error
        await new Promise((resolve) => setTimeout(resolve, 400))
      }
    }
    if (lastError) throw lastError
    translated += 1
    state.touchedModels.add(cfg.model)
    state.lastActivity = Date.now()
  }
  return { text: assembleSegments(segments, outputs), translated, targetLanguage: target }
}

/* ─────────────────────────────── HTTP 路由 ─────────────────────────────── */

function sendJson(res, status, payload) {
  if (res.writableEnded) return
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function fail(res, error) {
  const code = error instanceof TranslateError ? error.code : 'INTERNAL'
  const message = error?.message || String(error)
  const status = code === 'BAD_REQUEST' || code === 'BODY_TOO_LARGE' ? 400 : code === 'EXTRACT_UNSUPPORTED' ? 415 : code === 'TEXT_TOO_LONG' ? 413 : 502
  sendJson(res, status, { ok: false, error: { code, message } })
}

/** 只接受同源请求：跨站 fetch 与伪造 Origin 一律拒绝（回环地址之外的请求不该存在）。 */
function foreignReason(req) {
  const site = String(req.headers['sec-fetch-site'] || '')
  if (site === 'cross-site') return 'cross-site'
  const origin = req.headers.origin
  if (!origin) return null
  try {
    const parsed = new URL(origin)
    const host = String(req.headers.host || '')
    if (parsed.host !== host) return 'origin-mismatch'
    return null
  } catch {
    return 'bad-origin'
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0
    let done = false
    const chunks = []
    req.on('data', (chunk) => {
      if (done) return
      size += chunk.length
      if (size > limit) {
        done = true
        reject(new TranslateError('BODY_TOO_LARGE', `请求体超过上限 ${limit} 字节`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (done) return
      done = true
      resolve(Buffer.concat(chunks))
    })
    req.on('error', (error) => {
      if (done) return
      done = true
      reject(error)
    })
  })
}

function jsonBody(buffer) {
  if (!buffer || buffer.length === 0) return {}
  let parsed
  try {
    parsed = JSON.parse(buffer.toString('utf8'))
  } catch {
    throw new TranslateError('BAD_REQUEST', '请求体不是合法 JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TranslateError('BAD_REQUEST', '请求体必须是对象')
  }
  return parsed
}

function applyOverrides(state, body) {
  const cfg = state.cfg
  const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : cfg.model
  const keepAlive = body.keepAlive === 0 ? '0' : typeof body.keepAlive === 'string' && body.keepAlive.trim() ? body.keepAlive.trim() : cfg.keepAlive
  return { ...cfg, model, keepAlive }
}

async function handleAction(state, body, signal) {
  const action = String(body.action || '')

  if (action === 'status') {
    return { ok: true, status: await statusOf(state, signal, applyOverrides(state, body)) }
  }

  if (action === 'load') {
    const status = await warmup(state, applyOverrides(state, body), signal)
    state.lastActivity = Date.now()
    return { ok: true, status }
  }

  if (action === 'unload') {
    const cfg = applyOverrides(state, body)
    state.pinned = false
    await unloadModel(cfg, signal)
    state.touchedModels.delete(cfg.model)
    return { ok: true, status: await statusOf(state, signal, cfg) }
  }

  if (action === 'extract') {
    const name = String(body.name || '')
    const base64 = String(body.dataBase64 || '')
    if (!base64) throw new TranslateError('BAD_REQUEST', '缺少 dataBase64')
    const bytes = Buffer.from(base64, 'base64')
    if (bytes.length > state.cfg.maxUploadBytes) {
      throw new TranslateError('EXTRACT_FAILED', `文件超过上限 ${Math.round(state.cfg.maxUploadBytes / 1024 / 1024)} MB`)
    }
    const extracted = extractText({ name, bytes })
    if (SUBTITLE_EXTENSIONS.has(extracted.format)) {
      const segments = subtitleSegments(extracted.text)
      return {
        ok: true,
        format: extracted.format,
        warnings: extracted.warnings,
        chars: extracted.text.length,
        layout: 'lines',
        segments,
      }
    }
    // Office/EPUB 里单个换行就是段落边界；Markdown/纯文本里它只是软换行，不能拆。
    const segmented =
      ['docx', 'docm', 'pptx', 'pptm', 'xlsx', 'xlsm', 'epub'].includes(extracted.format)
        ? extracted.text.replace(/\n(?!\n)/g, '\n\n')
        : extracted.text
    const segments = splitSegments(segmented, state.cfg.chunkChars, { paragraphs: true }).filter(
      (segment) => segment.kind === 'code' || segment.text.trim() !== '',
    )
    return {
      ok: true,
      format: extracted.format,
      warnings: extracted.warnings,
      chars: extracted.text.length,
      layout: 'paragraphs',
      segments: segments.map((segment) => ({ text: segment.text, kind: segment.kind })),
    }
  }

  if (action === 'translate') {
    const cfg = applyOverrides(state, body)
    const text = String(body.text ?? '')
    if (!text.trim()) throw new TranslateError('BAD_REQUEST', '没有可翻译的文本')
    if (text.length > cfg.maxTextChars) {
      throw new TranslateError('TEXT_TOO_LONG', `文本过长（${text.length} 字符，上限 ${cfg.maxTextChars}）`)
    }
    const segments = splitSegments(text, cfg.chunkChars)
    const started = Date.now()
    const result = await translateSegments({
      state,
      cfg,
      segments,
      spec: {
        text,
        targetLanguage: body.targetLanguage,
        tone: body.tone,
        glossary: body.glossary,
      },
      signal,
    })
    state.lastActivity = Date.now()
    return { ok: true, text: result.text, targetLanguage: result.targetLanguage, chunks: segments.length, ms: Date.now() - started }
  }

  throw new TranslateError('BAD_REQUEST', `未知动作：${action || '(空)'}`)
}

async function handleRequest(state, req, res) {
  const reject = foreignReason(req)
  if (reject) {
    sendJson(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: `拒绝非本页请求（${reject}）` } })
    return
  }

  if (req.method === 'GET') {
    const status = await statusOf(state, undefined)
    sendJson(res, 200, { ok: true, status })
    return
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: '只支持 GET / POST' } })
    return
  }

  const controller = new AbortController()
  state.inflight.add(controller)
  const onClose = () => {
    if (!res.writableEnded) controller.abort()
  }
  res.on('close', onClose)

  try {
    const body = jsonBody(await readBody(req, state.cfg.maxUploadBytes * 2 + 1024 * 1024))
    const payload = await handleAction(state, body, controller.signal)
    sendJson(res, 200, payload)
  } catch (error) {
    if (isAbort(error)) {
      // 客户端已离开：没有可写的响应体，直接丢弃。
      if (!res.writableEnded) res.end()
      return
    }
    if (error?.code === 'CANCELLED' || error?.code === 'TIMEOUT') {
      fail(res, error)
      return
    }
    if (!(error instanceof TranslateError)) state.log('warn', `翻译失败：${error?.stack || error}`)
    state.lastError = error?.message || String(error)
    fail(res, error)
  } finally {
    state.inflight.delete(controller)
    res.off('close', onClose)
  }
}

/* ─────────────────────────────── 插件入口 ─────────────────────────────── */

export function apply(ctx, rawConfig) {
  const state = createState(normalizeConfig(rawConfig), ctx)

  // 路由只在 Web 载体存在时注册；非 Web 宿主里 Client 半边本来也不会加载。
  ctx.inject(['webServer'], (scope) => {
    const webServer = typeof scope.get === 'function' ? scope.get('webServer') : scope.webServer
    if (!webServer || typeof webServer.register !== 'function') {
      state.log('warn', '没有 webServer 服务，翻译路由未注册')
      return
    }
    scope.effect(
      () =>
        webServer.register({
          kind: 'exact',
          path: ROUTE_PATH,
          handler: (req, res) => {
            handleRequest(state, req, res).catch((error) => {
              state.log('warn', `路由异常：${error?.message || error}`)
              if (!res.writableEnded) sendJson(res, 500, { ok: false, error: { code: 'INTERNAL', message: '内部错误' } })
            })
          },
        }),
      'dsh-translate: POST /dsh-translate/api',
    )
  })

  // 空闲卸载器：模型不驻留过久（本机是核显共享内存，驻留代价高）。
  ctx.effect(() => {
    const timer = setInterval(() => {
      void sweepIdle(state).catch(() => {})
    }, 15000)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  }, 'dsh-translate: idle unloader')

  // 卸载：中止在飞请求，并 best-effort 释放模型。
  ctx.effect(
    () => () => {
      state.disposed = true
      for (const controller of state.inflight) controller.abort()
      state.inflight.clear()
      if (state.touchedModels.size > 0) {
        for (const model of state.touchedModels) {
          void unloadModel({ ...state.cfg, model }, undefined).catch((error) => {
            state.log('warn', `卸载模型 ${model} 失败（忽略）：${error?.message || error}`)
          })
        }
        state.touchedModels.clear()
      }
    },
    'dsh-translate: dispose cleanup',
  )
}

/** 离线自检用：纯函数与协议常量。 */
export const __internal = {
  DEFAULTS,
  LANGS,
  TONES,
  splitSegments,
  splitProse,
  assembleSegments,
  buildSystemPrompt,
  postProcess,
  resolveTarget,
  cjkRatio,
  extractText,
  readZip,
  htmlToText,
  decodeEntities,
  normalizeConfig,
  handleRequest,
  statusOf,
  createState,
}
