/**
 * PDF 双语排版（Host 半边）。
 *
 * 思路与成熟实现一致：
 *   pdf.js 取「文本片段 + 坐标」→ 聚成行/段（轻量 IR）→ 逐块翻译
 *   → pdf-lib 把译文写回原坐标（覆盖模式）/ 生成对照页（对照模式）。
 *
 * 设计约束：
 *   · 不重新发明排版引擎：只做「同位置替换 + 收缩字号适配」，公式/代码默认不译、原样保留。
 *   · 字体必须嵌入（CJK）：优先系统单文件 TTF（Windows 等线/黑体），可用配置覆盖；
 *     TTC 集合 pdf-lib 不支持（实测 createSubset is not a function）。
 *   · OCR 页（扫描件）由调用方提供带坐标的行，这里只负责排版。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import { PDFDocument, rgb } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'

const PDFJS_ROOT = join(process.cwd(), 'node_modules', 'pdfjs-dist')

/** 行高/字号推断的通用比例。 */
const LINE_HEIGHT_RATIO = 1.22
const PARA_GAP_RATIO = 1.65
const MAX_BLOCK_CHARS = 560
const MAX_BLOCK_HEIGHT_RATIO = 0.32

/* ─────────────────────────── 文本 → 行 / 段 ─────────────────────────── */

function normalizeText(value) {
  let text = String(value || '')
    .replace(/­/g, '')
    .replace(/[​-‏]/g, '')
    .trim()
  // 很多封面/标题用字距拉开的写法（"S I X T H  E D I T I O N"）：收拢成正常单词
  const tokens = text.split(/\s+/).filter(Boolean)
  if (tokens.length >= 4) {
    const single = tokens.filter((token) => Array.from(token).length === 1).length
    if (single / tokens.length > 0.8) text = tokens.join('')
  }
  return text
}

function isTranslatable(text) {
  const value = normalizeText(text)
  if (value.length < 2) return false
  const letters = (value.match(/[\p{L}]/gu) || []).length
  if (letters === 0) return false
  // 字母占比过低（数字/符号为主）
  if (letters / value.length < 0.32) return false
  // 数学符号密集：公式、矩阵片段（保留原文，避免模型把公式翻烂）
  const mathChars = (value.match(/[=+\-×÷±∑∏∫√≈≤≥≠∈∀∃∂∇∞→←↔^_{}\[\]()<>|\/]/g) || []).length
  if (mathChars / value.length > 0.12) return false
  // 大量 1~2 字符的碎片（"u1 v1 …"、"6u7 6v2 7"）：几乎都是矩阵/公式
  const tokens = value.split(/\s+/).filter(Boolean)
  if (tokens.length >= 4) {
    const tiny = tokens.filter((token) => Array.from(token).length <= 2).length
    if (tiny / tokens.length > 0.55) return false
  }
  return true
}

/** 把 pdf.js 的 textContent items 聚成「行」。 */
export function buildLines(items) {
  const usable = []
  for (const item of items) {
    if (!item || typeof item.str !== 'string') continue
    const text = item.str
    if (!text) continue
    // 旋转文字（页边 arXiv 水印之类）：跳过，否则会被当成正文块翻译/覆盖
    if (item.transform && (Math.abs(item.transform[1]) > 0.01 || Math.abs(item.transform[2]) > 0.01)) continue
    const x = item.transform[4]
    const y = item.transform[5]
    const width = item.width || 0
    const height = item.height || Math.abs(item.transform[3] || 0) || 0
    if (width <= 0 && height <= 0 && !text.trim()) continue
    usable.push({ text, x, y, width, height })
  }
  usable.sort((a, b) => (Math.abs(b.y - a.y) > 2 ? b.y - a.y : a.x - b.x))

  const lines = []
  for (const item of usable) {
    const tolerance = Math.max(2, (item.height || 8) * 0.45)
    const line = lines.find((candidate) => Math.abs(candidate.baseline - item.y) <= tolerance)
    if (line) {
      line.items.push(item)
      line.baseline = (line.baseline * (line.items.length - 1) + item.y) / line.items.length
    } else {
      lines.push({ baseline: item.y, items: [item] })
    }
  }

  const result = []
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x)
    let text = ''
    let previous = null
    for (const item of line.items) {
      if (previous) {
        const gap = item.x - (previous.x + previous.width)
        // 片段之间没有空格但视觉上有间距 → 补一个空格（PDF 文本层常把空格吞掉）
        if (gap > Math.max(1.2, (item.height || 8) * 0.16) && !/\s$/.test(text) && !/^\s/.test(item.text)) {
          text += ' '
        }
      }
      text += item.text
      previous = item
    }
    const left = Math.min(...line.items.map((item) => item.x))
    const right = Math.max(...line.items.map((item) => item.x + (item.width || 0)))
    const heights = line.items.map((item) => item.height || 0).filter((h) => h > 0)
    const lineHeight = heights.length ? Math.max(...heights) : 9
    result.push({
      text: normalizeText(text),
      x: left,
      y: line.baseline,
      width: Math.max(1, right - left),
      height: lineHeight,
    })
  }
  return result.filter((line) => line.text)
}

/** 双栏页的分栏位置：用文本片段（不是行）找竖向空白沟——行在双栏页会把左右两栏并成一行。 */
export function detectColumnGutter(rows, pageWidth) {
  if (rows.length < 8 || pageWidth < 240) return null
  let best = null
  for (let x = pageWidth * 0.28; x <= pageWidth * 0.72; x += 4) {
    let left = 0
    let right = 0
    let crossing = 0
    for (const line of rows) {
      if (line.x + line.width <= x) left += 1
      else if (line.x >= x) right += 1
      else crossing += 1
    }
    const score = Math.min(left, right)
    if (score >= Math.max(4, rows.length * 0.18) && crossing <= rows.length * 0.12) {
      if (!best || score > best.score) best = { x, score }
    }
  }
  if (!best) return null
  const lw = median(rows.filter((line) => line.x + line.width <= best.x).map((line) => line.width))
  const rw = median(rows.filter((line) => line.x >= best.x).map((line) => line.width))
  if (!(lw > 0 && rw > 0 && lw < pageWidth * 0.64 && rw < pageWidth * 0.64)) return null
  return best
}

function columnOf(line, gutter) {
  if (!gutter) return 'full'
  if (line.x + line.width <= gutter.x) return 'left'
  if (line.x >= gutter.x) return 'right'
  return 'full'
}

function canExtend(block, line, maxHeight) {
  const gap = block.y - (line.y + line.height)
  const similarSize = Math.abs(line.height - block.height) <= Math.max(2, block.height * 0.35)
  const aligned = Math.abs(line.x - block.x) <= Math.max(18, block.height * 2.2)
  const continuous = gap >= -2 && gap <= Math.max(block.height * PARA_GAP_RATIO, block.height + 6)
  const lastLine = block.lines[block.lines.length - 1]
  const endsSentence = /[.。!?;：:]["'”’)\]]?\s*$/.test(lastLine ? lastLine.text : '')
  const limit = endsSentence ? Math.round(MAX_BLOCK_CHARS * 1.6) : MAX_BLOCK_CHARS
  const charsOk = block.textLen + line.text.length <= limit
  const heightOk = block.top - line.y <= maxHeight
  return similarSize && continuous && (aligned || gap < -2) && charsOk && heightOk
}

function makeBlock(line, column) {
  return {
    column,
    x: line.x,
    y: line.y,
    right: line.x + line.width,
    top: line.y + line.height,
    height: line.height,
    textLen: line.text.length,
    lines: [line],
  }
}

function extendBlock(block, line) {
  block.lines.push(line)
  block.x = Math.min(block.x, line.x)
  block.right = Math.max(block.right, line.x + line.width)
  block.y = Math.min(block.y, line.y)
  block.top = Math.max(block.top, line.y + line.height)
  block.height = Math.max(block.height, line.height)
  block.textLen += line.text.length
}

/** 按分栏空白沟把文本片段分成左右两栏 + 跨栏片段。 */
export function partitionByColumn(items, pageWidth) {
  const usable = (items || []).filter(
    (item) =>
      item &&
      typeof item.str === 'string' &&
      item.str &&
      item.transform &&
      Math.abs(item.transform[1]) <= 0.01 &&
      Math.abs(item.transform[2]) <= 0.01,
  )
  const boxes = usable.map((item) => ({
    item,
    x: item.transform[4],
    width: Math.max(0, item.width || 0),
  }))
  const gutter = detectColumnGutter(boxes, pageWidth)
  if (!gutter) return { full: usable, left: [], right: [] }
  const left = []
  const right = []
  const full = []
  for (const box of boxes) {
    if (box.x + box.width <= gutter.x) left.push(box.item)
    else if (box.x >= gutter.x) right.push(box.item)
    else full.push(box.item)
  }
  return { left, right, full }
}

/**
 * 行 → 段。
 *  · 先找竖向空白沟分出左右栏（XY-cut 的简化版），块不跨栏；全宽行（标题/跨栏公式）单独成块并打断两栏；
 *  · 块有大小上限（600 字符 / 页高 32%），避免整页正文被并成一块（大输入会让模型截断、丢失内容）。
 */
export function groupParagraphs(lines, pageWidth, pageHeight = 0) {
  const rows = lines.filter((line) => line.text && line.width > 0)
  const hasColumns = rows.some((line) => line.column)
  const gutter = hasColumns ? null : detectColumnGutter(rows, pageWidth)
  const maxHeight = Math.max(120, (pageHeight || 792) * MAX_BLOCK_HEIGHT_RATIO)
  const sorted = [...rows].sort((a, b) => (Math.abs(b.y - a.y) > 3 ? b.y - a.y : a.x - b.x))
  const blocks = []
  const current = { left: null, right: null, full: null }
  const flush = (key) => {
    if (current[key]) {
      blocks.push(current[key])
      current[key] = null
    }
  }
  for (const line of sorted) {
    const column = line.column || columnOf(line, gutter)
    if (column === 'full') {
      // 全宽行（标题/跨栏公式/图注）打断左右栏
      flush('left')
      flush('right')
      if (current.full && canExtend(current.full, line, maxHeight)) extendBlock(current.full, line)
      else {
        flush('full')
        current.full = makeBlock(line, 'full')
      }
      continue
    }
    flush('full')
    if (current[column] && canExtend(current[column], line, maxHeight)) extendBlock(current[column], line)
    else {
      flush(column)
      current[column] = makeBlock(line, column)
    }
  }
  flush('left')
  flush('right')
  flush('full')

  // 阅读顺序：自上而下；同一高度左栏先于右栏，全宽块居中处理
  const order = { left: 0, full: 1, right: 2 }
  blocks.sort((a, b) => (Math.abs(a.y - b.y) > 6 ? b.y - a.y : order[a.column] - order[b.column]))

  return blocks.map((block, index) => {
    const joined = block.lines.map((line) => line.text).join(' ')
    const text = joined
      .replace(/([a-z])-\s+([a-z])/g, '$1$2')
      .replace(/\s+/g, ' ')
      .trim()
    return {
      id: `b${index}`,
      text,
      column: block.column,
      x: round2(block.x),
      y: round2(block.y),
      width: round2(block.right - block.x),
      height: round2(block.top - block.y),
      fontSize: round2(block.height),
      lines: block.lines.length,
      translatable: isTranslatable(text),
    }
  })
}

function round2(value) {
  return Math.round(value * 100) / 100
}

function median(values) {
  const list = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (!list.length) return 0
  return list[Math.floor(list.length / 2)]
}

/* ─────────────────────────── PDF 读取 ─────────────────────────── */

/** 读 PDF：返回每页尺寸与段落块（y 轴为 PDF 原生：原点左下）。 */
export async function readPdfBlocks(bytes, options = {}) {
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: false,
    isEvalSupported: false,
    standardFontDataUrl: join(PDFJS_ROOT, 'standard_fonts') + '/',
  }).promise

  const pages = []
  const from = Math.max(1, Number(options.from) || 1)
  const to = options.to ? Math.min(Number(options.to), doc.numPages) : doc.numPages
  const limit = Math.min(to, options.maxPages ? from + options.maxPages - 1 : to)
  for (let index = from; index <= limit; index += 1) {
    const page = await doc.getPage(index)
    const viewport = page.getViewport({ scale: 1 })
    const content = await page.getTextContent()
    // 先按栏切片段，再各自聚行：同一基线的左右两栏不能进同一行
    const parts = partitionByColumn(content.items, viewport.width)
    const lines = []
    for (const column of ['left', 'right', 'full']) {
      if (!parts[column] || parts[column].length === 0) continue
      for (const line of buildLines(parts[column])) lines.push({ ...line, column })
    }
    const blocks = groupParagraphs(lines, viewport.width, viewport.height)
    pages.push({
      index: index - 1,
      width: round2(viewport.width),
      height: round2(viewport.height),
      textChars: blocks.reduce((sum, block) => sum + block.text.length, 0),
      blocks,
    })
    page.cleanup()
  }
  const totalPages = doc.numPages
  await doc.destroy()
  return { pageCount: totalPages, pages }
}

/* ─────────────────────────── 字体 ─────────────────────────── */

const FONT_CANDIDATES = {
  win32: [
    'C:/Windows/Fonts/Deng.ttf', // 等线：单文件 TTF，pdf-lib 可直接子集化
    'C:/Windows/Fonts/simhei.ttf',
    'C:/Windows/Fonts/msyh.ttf',
  ],
  darwin: ['/System/Library/Fonts/Supplemental/Songti.ttc', '/Library/Fonts/Arial Unicode.ttf'],
  linux: [
    '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
  ],
}

let cachedFont = null

/** 找一个能被 pdf-lib 嵌入的中文字体（TTC 集合不支持，跳过）。 */
export function resolvePdfFont(configuredPath) {
  if (cachedFont) return cachedFont
  const candidates = []
  if (configuredPath) candidates.push(configuredPath)
  const list = FONT_CANDIDATES[process.platform] || FONT_CANDIDATES.linux
  candidates.push(...list)
  for (const path of candidates) {
    if (!path) continue
    if (!existsSync(path)) continue
    if (/\.ttc$/i.test(path)) continue // pdf-lib + fontkit 不支持集合
    try {
      cachedFont = { path, bytes: readFileSync(path) }
      return cachedFont
    } catch {
      /* 换下一个 */
    }
  }
  return null
}

/* ─────────────────────────── 排版写回 ─────────────────────────── */

function wrapText(text, font, size, maxWidth) {
  const lines = []
  let current = ''
  const widthOf = (value) => (value ? font.widthOfTextAtSize(value, size) : 0)
  for (const char of Array.from(text)) {
    if (char === '\n') {
      lines.push(current)
      current = ''
      continue
    }
    const next = current + char
    if (widthOf(next) <= maxWidth || current === '') {
      current = next
      continue
    }
    // 拉丁词不拆：回退到最后一个空格
    const space = current.lastIndexOf(' ')
    if (space > 0 && /[A-Za-z]/.test(char)) {
      lines.push(current.slice(0, space))
      current = current.slice(space + 1) + char
    } else {
      lines.push(current)
      current = char
    }
  }
  if (current) lines.push(current)
  return lines
}

const MIN_FONT_SIZE = 6

/** 在给定矩形内放下译文：从原字号开始逐级缩小；实在放不下就截断到可用高度并标 overflow。 */
function layoutFit(text, font, boxWidth, boxHeight, startSize) {
  const floor = Math.max(MIN_FONT_SIZE, startSize * 0.55)
  let size = Math.max(floor, Math.min(startSize, Math.max(boxHeight, startSize)))
  for (; size >= floor; size -= 0.5) {
    const lineHeight = size * LINE_HEIGHT_RATIO
    const lines = wrapText(text, font, size, Math.max(8, boxWidth))
    if (lines.length * lineHeight <= boxHeight + 0.5) {
      return { lines, size, lineHeight, overflow: false }
    }
  }
  const lineHeight = floor * LINE_HEIGHT_RATIO
  const all = wrapText(text, font, floor, Math.max(8, boxWidth))
  const keep = Math.max(1, Math.floor(boxHeight / lineHeight))
  const lines = all.slice(0, keep)
  if (all.length > keep && lines.length) {
    lines[lines.length - 1] = lines[lines.length - 1].replace(/\s+$/, '') + '…'
  }
  return { lines, size: floor, lineHeight, overflow: all.length > keep }
}

/** 每块下方可用高度：到「同栏下一块顶部」的距离（没有下一块就用页底留白）。 */
function computeAvailabilities(page) {
  const blocks = page.blocks || []
  const map = new Map()
  for (const block of blocks) {
    const top = block.y + block.height
    let nearestTop = null
    for (const other of blocks) {
      if (other === block) continue
      const otherTop = other.y + other.height
      if (otherTop >= top - 1) continue
      const overlap = Math.min(block.x + block.width, other.x + other.width) - Math.max(block.x, other.x)
      if (overlap < Math.min(block.width, other.width) * 0.3) continue
      if (nearestTop === null || otherTop > nearestTop) nearestTop = otherTop
    }
    map.set(block.id, top - (nearestTop === null ? 12 : nearestTop))
  }
  return map
}

/**
 * 生成输出 PDF，并返回排版统计（供 QC / UI 提示）。
 * @returns {Promise<{bytes: Uint8Array, stats: object}>}
 */
export async function buildBilingualPdf(input) {
  const { bytes, pages, mode = 'overlay', font, options = {} } = input
  const getTranslation = (pageIndex, block) => {
    const translations = input.translations
    const key = `${pageIndex}:${block.id}`
    if (translations instanceof Map) return translations.get(key) || ''
    return (translations && translations[key]) || ''
  }
  const pageMap = new Map((pages || []).map((page) => [page.index, page]))
  const background = rgb(...(options.background || [1, 1, 1]))
  const textColor = rgb(...(options.textColor || [0, 0, 0]))
  const shouldTranslate = (block) => block.translatable !== false
  const stats = { blocks: 0, translated: 0, skipped: 0, empty: 0, overflow: [], overlaps: [] }

  const drawPage = ({ page, info, font: cjk, background: fillDefault, allowCover }) => {
    const availabilities = computeAvailabilities(info)
    const rects = []
    for (const block of info.blocks || []) {
      const text = getTranslation(info.index, block)
      const translatable = shouldTranslate(block)
      stats.blocks += 1
      if (!translatable) {
        stats.skipped += 1
        continue
      }
      if (!text) {
        stats.empty += 1
        continue
      }
      let fill = fillDefault
      if (allowCover && fill && options.sampleBackground && options.pageSamples && options.pageSamples[info.index]) {
        const sampled = sampleBackgroundColor(options.pageSamples[info.index], block, info)
        if (sampled) fill = sampled
      }
      const drawn = drawBlock({
        page,
        block,
        text,
        font: cjk,
        color: textColor,
        background: allowCover ? fill : null,
        maxHeight: availabilities.get(block.id),
      })
      stats.translated += 1
      if (drawn.overflow) stats.overflow.push({ page: info.index, id: block.id })
      rects.push(drawn)
    }
    // 重叠检测（只在同一页内、面积足够大的相交才算）
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        const a = rects[i]
        const b = rects[j]
        const ox = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
        const oy = Math.min(a.top, b.top) - Math.max(a.bottom, b.bottom)
        if (ox > 6 && oy > 6) stats.overlaps.push({ page: info.index, a: i, b: j })
      }
    }
  }

  if (mode === 'dual') {
    const source = await PDFDocument.load(bytes, { ignoreEncryption: true })
    const out = await PDFDocument.create()
    out.registerFontkit(fontkit)
    const cjk = await out.embedFont(font.bytes, { subset: true })
    const sourcePages = source.getPages()
    for (let index = 0; index < sourcePages.length; index += 1) {
      const copied = await out.copyPages(source, [index])
      out.addPage(copied[0])
      const original = sourcePages[index]
      const { width, height } = original.getSize()
      const page = pageMap.get(index)
      if (!page || !page.blocks || page.blocks.length === 0) continue
      const translated = out.addPage([width, height])
      translated.drawRectangle({ x: 0, y: 0, width, height, color: background })
      drawPage({ page: translated, info: page, font: cjk, background: null, allowCover: false })
    }
    return { bytes: await out.save(), stats }
  }

  // 覆盖模式：直接在原页上盖底色 + 写译文
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true })
  doc.registerFontkit(fontkit)
  const cjk = await doc.embedFont(font.bytes, { subset: true })
  const docPages = doc.getPages()
  for (let index = 0; index < docPages.length; index += 1) {
    const info = pageMap.get(index)
    if (!info || !info.blocks || info.blocks.length === 0) continue
    drawPage({ page: docPages[index], info, font: cjk, background, allowCover: true })
  }
  return { bytes: await doc.save(), stats }
}

/** 从页面位图（RGBA）采样块周围的底色，取众数；失败返回 null。 */
export function sampleBackgroundColor(sample, block, pageInfo) {
  try {
    const { data, width, height, scale } = sample
    const left = Math.max(0, Math.round((block.x - 4) * scale))
    const right = Math.min(width - 1, Math.round((block.x + block.width + 4) * scale))
    const top = Math.max(0, Math.round((pageInfo.height - block.y - block.height - 6) * scale))
    const bottom = Math.min(height - 1, Math.round((pageInfo.height - block.y + 6) * scale))
    const counts = new Map()
    for (let y = top; y <= bottom; y += 3) {
      for (let x = left; x <= right; x += 3) {
        const offset = (y * width + x) * 4
        const key = `${data[offset]},${data[offset + 1]},${data[offset + 2]}`
        counts.set(key, (counts.get(key) || 0) + 1)
      }
    }
    if (!counts.size) return null
    let best = null
    let bestCount = 0
    for (const [key, count] of counts) {
      if (count > bestCount) { best = key; bestCount = count }
    }
    const [r, g, b] = best.split(',').map((value) => Number(value) / 255)
    return rgb(r, g, b)
  } catch {
    return null
  }
}

/** 把 OCR 结果的行（含像素坐标）换算成 PDF 坐标的「段落块」（相邻行先合并）。 */
export function blocksFromOcrLines(lines, pageWidth, pageHeight, scale = 2) {
  const rows = []
  for (const line of lines || []) {
    const text = normalizeText(line.text)
    if (!text) continue
    const height = Math.max(6, line.h / scale)
    const top = pageHeight - line.y / scale
    rows.push({
      text,
      x: line.x / scale,
      y: top - height,
      width: Math.max(height, line.w / scale),
      height,
    })
  }
  rows.sort((a, b) => (Math.abs(b.y - a.y) > 2 ? b.y - a.y : a.x - b.x))

  const merged = []
  for (const row of rows) {
    const last = merged[merged.length - 1]
    if (last) {
      const gap = last.y - (row.y + row.height)
      const overlap = Math.min(last.x + last.width, row.x + row.width) - Math.max(last.x, row.x)
      const similar = Math.abs(row.height - last.height) <= Math.max(2, last.height * 0.45)
      const continuous = gap >= -2 && gap <= Math.max(2, row.height * 1.15)
      // 同一行被 OCR 拆成两段（纵向重叠大、水平挨得近）也要合并，否则两段译文会叠在一行上
      const sameLine = Math.abs(row.y - last.y) <= Math.max(2, row.height * 0.45) &&
        (row.x - (last.x + last.width) <= Math.max(8, row.height * 1.2)) &&
        (last.x - (row.x + row.width) <= Math.max(8, row.height * 1.2))
      if (sameLine || (similar && continuous && overlap > Math.min(last.width, row.width) * 0.28)) {
        const joiner = /[一-鿿]$/.test(last.text) && /^[一-鿿]/.test(row.text) ? '' : ' '
        last.text = (last.text + joiner + row.text).replace(/\s+/g, ' ').trim()
        last.x = Math.min(last.x, row.x)
        last.width = Math.max(last.x + last.width, row.x + row.width) - last.x
        last.y = Math.min(last.y, row.y)
        last.height = Math.max(last.height, row.y + row.height - last.y)
        continue
      }
    }
    merged.push({ ...row })
  }

  return merged.map((block, index) => ({
    id: `o${index}`,
    text: block.text,
    x: round2(block.x),
    y: round2(block.y),
    width: round2(block.width),
    height: round2(block.height),
    fontSize: round2(block.height),
    lines: 1,
    translatable: isTranslatable(block.text),
    fromOcr: true,
  }))
}

function drawBlock({ page, block, text, font, color, background, maxHeight }) {
  const padX = Math.max(0.6, block.fontSize * 0.12)
  const boxX = block.x - padX
  const boxWidth = block.width + padX * 2
  const top = block.y + block.height + 1
  const space = Math.max(block.height + 2, maxHeight || block.height + 8)
  const layout = layoutFit(text, font, boxWidth, space, block.fontSize)
  let cursor = top - layout.size
  if (background) {
    // 盖住「原文块 + 实际译文占用的高度」——只按原文块大小盖，会露出溢出的原文，形成叠字
    const bottom = cursor - (layout.lines.length - 1) * layout.lineHeight + layout.size * 0.25
    const rectTop = top + block.fontSize * 0.35
    const rectBottom = Math.min(block.y - block.fontSize * 0.42, bottom - 1.2)
    page.drawRectangle({
      x: boxX - 0.8,
      y: rectBottom,
      width: boxWidth + 1.6,
      height: Math.max(2, rectTop - rectBottom),
      color: background,
    })
  }
  for (const line of layout.lines) {
    page.drawText(line, { x: boxX, y: cursor, size: layout.size, font, color })
    cursor -= layout.lineHeight
  }
  const bottom = cursor + layout.lineHeight
  return {
    x: boxX,
    width: boxWidth,
    top,
    bottom: Math.min(bottom, block.y),
    overflow: layout.overflow,
  }
}

/* ─────────────────────────── 渲染（校验/预览用） ─────────────────────────── */

/** 把 PDF 某页渲染成 PNG（Node 侧，需要 @napi-rs/canvas；仅用于校验/预览）。 */
export async function renderPdfPage(bytes, pageIndex, scale = 2) {
  const { createCanvas } = await import('@napi-rs/canvas')
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: false,
    isEvalSupported: false,
    standardFontDataUrl: join(PDFJS_ROOT, 'standard_fonts') + '/',
  }).promise
  const page = await doc.getPage(pageIndex + 1)
  const viewport = page.getViewport({ scale })
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
  const context = canvas.getContext('2d')
  await page.render({ canvasContext: context, viewport, canvas }).promise
  const png = canvas.toBuffer('image/png')
  await doc.destroy()
  return png
}
