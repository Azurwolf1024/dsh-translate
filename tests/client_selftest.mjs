/**
 * dsh-translate Client 半边离线自检。
 *
 * 不启动浏览器：造一个最小的 window / document / React 替身，按真实加载器的约定
 * 执行 `window.__ModuleLoader__.load` 登记的 factory，然后
 *   ① 断言 apply() 往四个槽位各注册一次；
 *   ② 逐个调用组件函数走一遍渲染路径（能抓出 createElement 里未定义变量这类错误）；
 *   ③ 校验 apiUrl / base64 等前端工具函数。
 *
 * 用法：node tests/client_selftest.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const bundle = readFileSync(join(here, '..', 'client.js'), 'utf8')

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/* ───────────────────────── 浏览器替身 ───────────────────────── */

const tree = []
function element(type, props, children) {
  return { type, props: props || {}, children }
}

const React = {
  createElement(type, props) {
    const children = []
    for (let index = 2; index < arguments.length; index += 1) children.push(arguments[index])
    const node = element(type, props, children.flat(Infinity))
    tree.push(node)
    return node
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, function () {}]
  },
  useRef(initial) {
    return { current: initial }
  },
  useEffect() {}
}

const localStorageData = new Map()
const windowStub = {
  __ModuleLoader__: { load(definition) { windowStub.__definition = definition } },
  localStorage: {
    getItem(key) { return localStorageData.has(key) ? localStorageData.get(key) : null },
    setItem(key, value) { localStorageData.set(key, String(value)) },
    removeItem(key) { localStorageData.delete(key) }
  },
  location: { origin: 'http://127.0.0.1:61213', href: 'http://127.0.0.1:61213/' },
  innerWidth: 1440,
  innerHeight: 900,
  setTimeout,
  clearTimeout,
  btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
  URL: URL,
  Blob: class Blob {},
  fetch: () => {
    throw new Error('渲染阶段不应发起 fetch')
  }
}

const documentStub = {
  baseURI: 'http://127.0.0.1:61213/',
  createElement() {
    return { style: {}, setAttribute() {}, select() {}, remove() {}, appendChild() {} }
  },
  execCommand() { return true },
  body: { appendChild() {} },
  addEventListener() {},
  removeEventListener() {}
}

const context = {
  window: windowStub,
  document: documentStub,
  navigator: { clipboard: { writeText: async () => {} } },
  location: windowStub.location,
  console,
  setTimeout,
  clearTimeout,
  URL,
  Blob: windowStub.Blob,
  btoa: windowStub.btoa,
  Set,
  Map,
  Object,
  Array,
  JSON,
  Math,
  Number,
  String,
  Error,
  Promise,
  Uint8Array,
  AbortController: globalThis.AbortController,
  fetch: windowStub.fetch
}
context.globalThis = context
vm.createContext(context)
vm.runInContext(bundle, context, { filename: 'client.js' })

console.log('\n1. 加载器契约')
check('bundle 登记了一个 factory', !!windowStub.__definition && typeof windowStub.__definition.factory === 'function')
check('id 与包名一致', windowStub.__definition?.id === 'dsh-translate', String(windowStub.__definition?.id))

const exportsObject = windowStub.__definition.factory((name) => {
  if (name === 'react') return React
  throw new Error(`未知模块 ${name}`)
})
check('声明 inject: slots', Array.isArray(exportsObject.inject) && exportsObject.inject.includes('slots'))
check('导出 apply', typeof exportsObject.apply === 'function')

console.log('\n2. 槽位注册')
const registrations = []
const ctx = {
  slots: {
    inject(owner, callback) {
      registrations.push({ owner, dispose: callback() })
    },
    register(options, component) {
      registrations.push({ kind: 'register', options, component })
      return () => {}
    }
  },
  get(name) {
    if (name === 'layout') return { selectPanel(panel) { registrations.push({ kind: 'selectPanel', panel }) } }
    return undefined
  }
}
exportsObject.apply(ctx)

const slotNames = registrations.filter((r) => r.kind === 'register').map((r) => r.options.name)
check('注册 sidebar.panellist', slotNames.includes('sidebar.panellist'))
check('注册 main（key=translate）', registrations.some((r) => r.kind === 'register' && r.options.name === 'main' && r.options.key === 'translate'))
check('注册两个 shell.overlay 条目', slotNames.filter((name) => name === 'shell.overlay').length === 2)
check(
  '侧栏图标 id 与主面板 key 同名',
  registrations.some((r) => r.kind === 'register' && r.options.id === 'translate') &&
    registrations.some((r) => r.kind === 'register' && r.options.key === 'translate')
)

console.log('\n3. 组件渲染冒烟')
const self = exportsObject.__selftest
const components = self.components
self.store.status = {
  baseURL: 'http://127.0.0.1:11434',
  model: 'kaelri/hy-mt2:1.8b',
  installed: true,
  loaded: false,
  pinned: false,
  models: [{ name: 'kaelri/hy-mt2:1.8b' }],
  formats: { office: ['docx'], text: ['txt'] }
}

function render(name, call) {
  try {
    const node = call()
    check(`渲染 ${name}`, node !== undefined)
    return node
  } catch (error) {
    check(`渲染 ${name}`, false, error?.stack?.split('\n').slice(0, 3).join(' | '))
    return null
  }
}

const dock = render('Dock', () => components.Dock())
check('Dock 里有一个带右键菜单的按钮', !!findNode(dock, (node) => node.type === 'button' && typeof node.props.onContextMenu === 'function'))
check('Dock 渲染了状态圆点', !!findNode(dock, (node) => typeof node.props.className === 'string' && node.props.className.indexOf('dstr-dot') >= 0))
render('ContextMenu', () => components.ContextMenu({ menu: { x: 1200, y: 800 }, onClose() {} }))
render('Workbench', () => components.Workbench())
render('TextTab', () => components.TextTab())
render('FileTab', () => components.FileTab())
render('SettingsTab', () => components.SettingsTab())
check('无选区时浮层不渲染', components.SelectionPopover() === null)

self.store.selection = {
  text: 'Hello world',
  rect: { left: 100, top: 100, right: 300, bottom: 120 },
  loading: false,
  result: '你好，世界',
  error: null,
  target: 'zh-Hans',
  ms: 800
}
const popover = render('SelectionPopover', () => components.SelectionPopover())
check('浮层显示译文', !!findNode(popover, (node) => node.children.indexOf('你好，世界') >= 0))
check('浮层带「重译」「复制」按钮', !!findNode(popover, (node) => node.type === 'button' && node.children.indexOf('重译') >= 0))

self.store.selection = null
self.store.overlayOpen = true
render('OverlayWorkbench', () => components.OverlayWorkbench())

// 首次使用提示：连不上 Ollama / 缺模型 都要能渲染出来
self.store.status = { ...self.store.status, reachable: false, baseURL: 'http://127.0.0.1:11434' }
const offlineNotice = render('SetupNotice（Ollama 未启动）', () => components.SetupNotice())
check('未启动 Ollama 时给出提示', !!findNode(offlineNotice, (node) => node.children.indexOf('重新检测') >= 0))
self.store.status = { ...self.store.status, reachable: true, installed: false, model: 'kaelri/hy-mt2:1.8b' }
const modelNotice = render('SetupNotice（缺模型）', () => components.SetupNotice())
check(
  '缺模型时给出 pull 命令',
  !!findNode(modelNotice, (node) => node.type === 'code' && String(node.children[0] || '').includes('ollama pull'))
)
self.store.status = { ...self.store.status, installed: true }
check('一切就绪时不渲染提示', components.SetupNotice() === null)

function findNode(root, predicate) {
  if (!root || typeof root !== 'object') return null
  if (predicate(root)) return root
  const children = Array.isArray(root.children) ? root.children : []
  for (const child of children) {
    const found = findNode(child, predicate)
    if (found) return found
  }
  return null
}

console.log('\n4. 前端工具')
check('apiUrl 指向宿主路由', self.apiUrl() === 'http://127.0.0.1:61213/dsh-translate/api', self.apiUrl())
check('base64 编码正确', self.toBase64(new Uint8Array([104, 105]).buffer) === 'aGk=', self.toBase64(new Uint8Array([104, 105]).buffer))
check('默认设置包含划译开关', self.readSettings().selectionEnabled === true)
check('CSS 使用主题 token', self.CSS.includes('--dsw-alias-brand-primary') && !/#[0-9a-fA-F]{6}/.test(self.CSS.replace(/#fff\b/g, '')))
check('CSS 覆盖整页/浮层/菜单', ['dstr-page', 'dstr-pop', 'dstr-menu', 'dstr-fab'].every((name) => self.CSS.includes(name)))
check('渲染过程没有发起 fetch', tree.length > 0)

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
