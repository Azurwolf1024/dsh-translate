/**
 * dsh-translate —— Client 半边（浏览器 bundle，手写、零打包器）。
 *
 * 加载器语义：执行本文件只 `登记` factory，副作用在 materialization 时才开始。
 * 格式与宿主一致：`window.__ModuleLoader__.load({ id, factory(require) })`。
 *
 * 三块界面：
 *   ① 整页工作台：`sidebar.panellist` 图标（id=translate，与 main 的 key 同名）
 *      → `main` keyed 槽的整页视图；文本 / 文件 / 设置 三个页签。
 *   ② 划译：`shell.overlay` 里的常驻浮层组件；**开关关闭时一个 document 监听都不挂**。
 *      选中后停顿 `selectionDelayMs` 自动翻译，Esc / 点外 / 滚动即关闭并 abort。
 *   ③ 小图标：同样是 `shell.overlay`，点击开工作台，右键菜单控制
 *      「加载/关闭模型」「加载/关闭划译」「刷新状态」。
 *
 * 纪律：
 *   - 不 import / 不 export，不碰宿主 DOM，样式全部走 `--dsw-alias-*` token；
 *   - 每个 effect 都返回清理：监听、定时器、AbortController 全部回收；
 *   - 宿主配置只读（模型/keepAlive 随请求下发，空闲卸载时长由 cordis.patch.yml 决定）。
 */
window.__ModuleLoader__.load({
	id: 'dsh-translate',
	factory: function (require) {
		var React = require('react');
		var h = React.createElement;
		var useEffect = React.useEffect;
		var useRef = React.useRef;
		var useState = React.useState;

		/* ═════════════════════════════ 常量 ═════════════════════════════ */

		var LS_KEY = 'dsh-translate:v1';
		var API_PATH = 'dsh-translate/api';

		var LANGS = [
			{ id: 'auto', label: '自动（中↔英）' },
			{ id: 'zh-Hans', label: '简体中文' },
			{ id: 'zh-Hant', label: '繁體中文' },
			{ id: 'en', label: 'English' },
			{ id: 'ja', label: '日本語' },
			{ id: 'ko', label: '한국어' },
			{ id: 'fr', label: 'Français' },
			{ id: 'de', label: 'Deutsch' },
			{ id: 'es', label: 'Español' },
			{ id: 'ru', label: 'Русский' },
			{ id: 'pt', label: 'Português' },
			{ id: 'it', label: 'Italiano' },
			{ id: 'ar', label: 'العربية' },
			{ id: 'th', label: 'ไทย' },
			{ id: 'vi', label: 'Tiếng Việt' }
		];

		var TONES = [
			{ id: 'natural', label: '自然' },
			{ id: 'literal', label: '直译' },
			{ id: 'casual', label: '口语' },
			{ id: 'formal', label: '学术' },
			{ id: 'business', label: '商务' }
		];

		var KEEP_ALIVE = [
			{ id: '0', label: '用完立即卸载（最省内存，每次多花加载时间）' },
			{ id: '5m', label: '保留 5 分钟' },
			{ id: '30m', label: '保留 30 分钟' },
			{ id: '1h', label: '保留 1 小时' }
		];

		var MAX_SELECTION_CHARS = 4000;
		var MAX_RENDERED_SEGMENTS = 400;

		var DEFAULT_SETTINGS = {
			targetLanguage: 'auto',
			sourceLanguage: 'auto',
			tone: 'natural',
			glossary: '',
			selectionEnabled: true,
			externalEnabled: true,
			pageOverlay: true,
			selectionDelayMs: 500,
			model: '',
			keepAlive: '5m',
			fileMode: 'bilingual'
		};

		/* ═════════════════════════════ 工具 ═════════════════════════════ */

		function safe(fn, fallback) {
			try {
				return fn();
			} catch (error) {
				return fallback;
			}
		}

		function readSettings() {
			var stored = safe(function () {
				var raw = window.localStorage.getItem(LS_KEY);
				return raw ? JSON.parse(raw) : null;
			}, null);
			var merged = Object.assign({}, DEFAULT_SETTINGS);
			if (stored && typeof stored === 'object') {
				Object.keys(DEFAULT_SETTINGS).forEach(function (key) {
					if (stored[key] !== undefined && stored[key] !== null) merged[key] = stored[key];
				});
			}
			return merged;
		}

		function persistSettings(settings) {
			safe(function () {
				window.localStorage.setItem(LS_KEY, JSON.stringify(settings));
			});
		}

		function apiUrl() {
			try {
				return new URL(API_PATH, document.baseURI).toString();
			} catch (error) {
				return window.location.origin + '/' + API_PATH;
			}
		}

		/** 永不抛的 JSON RPC：失败折叠成带 code 的 Error，由调用方展示。 */
		async function api(action, payload, signal) {
			var body = Object.assign({ action: action }, payload || {});
			var response;
			try {
				response = await window.fetch(apiUrl(), {
					method: 'POST',
					credentials: 'same-origin',
					headers: { 'content-type': 'application/json', 'x-dsh-translate': '1' },
					body: JSON.stringify(body),
					signal: signal
				});
			} catch (error) {
				if (error && error.name === 'AbortError') throw error;
				var offline = new Error('连不上翻译服务（宿主路由未响应）');
				offline.code = 'OFFLINE';
				throw offline;
			}
			var text = '';
			try {
				text = await response.text();
			} catch (error) {
				text = '';
			}
			var json = null;
			try {
				json = text ? JSON.parse(text) : null;
			} catch (error) {
				json = null;
			}
			if (!response.ok || !json || json.ok !== true) {
				var detail = (json && json.error) || {};
				var failure = new Error(detail.message || '翻译服务返回 ' + response.status);
				failure.code = detail.code || 'HTTP_' + response.status;
				throw failure;
			}
			return json;
		}

		async function copyText(text) {
			try {
				if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
					await navigator.clipboard.writeText(text);
					return true;
				}
			} catch (error) {
				/* 落到 execCommand 兜底 */
			}
			return safe(function () {
				var area = document.createElement('textarea');
				area.value = text;
				area.setAttribute('readonly', 'readonly');
				area.style.position = 'fixed';
				area.style.left = '-9999px';
				document.body.appendChild(area);
				area.select();
				var ok = document.execCommand('copy');
				area.remove();
				return !!ok;
			}, false);
		}

		function toBase64(buffer) {
			var bytes = new Uint8Array(buffer);
			var chunk = 0x8000;
			var binary = '';
			for (var at = 0; at < bytes.length; at += chunk) {
				binary += String.fromCharCode.apply(null, bytes.subarray(at, at + chunk));
			}
			return window.btoa(binary);
		}

		function byteLabel(size) {
			if (!size && size !== 0) return '';
			if (size < 1024) return size + ' B';
			if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB';
			return (size / 1024 / 1024).toFixed(1) + ' MB';
		}

		function langLabel(id) {
			var found = LANGS.filter(function (item) {
				return item.id === id;
			})[0];
			return found ? found.label : id;
		}

		function sleep(ms) {
			return new Promise(function (resolve) {
				window.setTimeout(resolve, ms);
			});
		}

		/* ═════════════════════════ 模块级状态 / 订阅 ═════════════════════════ */

		var settings = readSettings();

		var store = {
			settings: settings,
			status: null,
			statusError: null,
			statusBusy: false,
			activeTab: 'text',
			selection: null,
			external: null,
			menu: null,
			toast: null,
			overlayOpen: false
		};

		var subscribers = new Set();

		function emit() {
			subscribers.forEach(function (listener) {
				try {
					listener();
				} catch (error) {
					/* 单个订阅者失败不影响其它界面 */
				}
			});
		}

		function patch(next) {
			Object.assign(store, next);
			emit();
		}

		function setSettings(next) {
			store.settings = Object.assign({}, store.settings, next);
			settings = store.settings;
			persistSettings(store.settings);
			emit();
		}

		function useStore() {
			var pair = useState(0);
			var bump = pair[1];
			useEffect(function () {
				var listener = function () {
					bump(function (value) {
						return value + 1;
					});
				};
				subscribers.add(listener);
				return function () {
					subscribers.delete(listener);
				};
			}, []);
			return store;
		}

		var toastTimer = null;
		function toast(text) {
			patch({ toast: text });
			if (toastTimer) window.clearTimeout(toastTimer);
			toastTimer = window.setTimeout(function () {
				patch({ toast: null });
			}, 2600);
		}

		var services = { layout: null, ctx: null };

		function selectTranslatePanel() {
			var layout = services.layout;
			if (!layout && services.ctx) {
				layout = safe(function () {
					return typeof services.ctx.get === 'function' ? services.ctx.get('layout') : undefined;
				}, null);
				services.layout = layout;
			}
			if (layout && typeof layout.selectPanel === 'function') {
				try {
					layout.selectPanel('translate');
					return true;
				} catch (error) {
					return false;
				}
			}
			return false;
		}

		/* ── 状态查询 ── */

		var statusInFlight = null;
		function refreshStatus() {
			if (statusInFlight) return statusInFlight;
			store.statusBusy = true;
			emit();
			var payload = { model: store.settings.model || undefined };
			statusInFlight = api('status', payload)
				.then(function (data) {
					patch({ status: data.status, statusError: null, statusBusy: false });
					return data.status;
				})
				.catch(function (error) {
					patch({ statusError: error.message || String(error), statusBusy: false });
					return null;
				})
				.then(function (value) {
					statusInFlight = null;
					return value;
				});
			return statusInFlight;
		}

		async function loadModel() {
			toast('正在加载模型…');
			try {
				var data = await api('load', { model: store.settings.model || undefined, keepAlive: store.settings.keepAlive });
				patch({ status: data.status, statusError: null });
				toast('模型已加载（已钉住，空闲不会自动卸载）');
			} catch (error) {
				toast('加载失败：' + (error.message || error));
			}
		}

		async function unloadModel() {
			toast('正在卸载模型…');
			try {
				var data = await api('unload', { model: store.settings.model || undefined });
				patch({ status: data.status, statusError: null });
				toast('模型已卸载');
			} catch (error) {
				toast('卸载失败：' + (error.message || error));
			}
		}

		/* ═══════════════════════ 外部划译（系统级伴生进程） ═══════════════════════ */

		function apiPort() {
			try {
				var parsed = new window.URL(apiUrl());
				if (parsed.port) return Number(parsed.port);
				return parsed.protocol === 'https:' ? 443 : 80;
			} catch (error) {
				return 61213;
			}
		}

		/** 主题 token 可能挂在 html / body / #root / 主题容器上：挨个找，谁有就用谁。 */
		function themeRoots() {
			var roots = [];
			function add(node) {
				if (node && roots.indexOf(node) < 0) roots.push(node);
			}
			try {
				add(document.documentElement);
			} catch (error) { /* ignore */ }
			try {
				add(document.body);
			} catch (error) { /* ignore */ }
			try {
				add(document.getElementById('root'));
			} catch (error) { /* ignore */ }
			try {
				var nodes = document.querySelectorAll('[class*="theme"], [data-theme], [data-dsw-theme]');
				for (var index = 0; index < Math.min(nodes.length, 4); index += 1) add(nodes[index]);
			} catch (error) { /* ignore */ }
			return roots;
		}

		/** 从 CSS 字体栈里挑一个 Windows 上真有的字体（原生窗口只认字体族名）。 */
		function pickFontFamily(stack) {
			var preferred = ['Segoe UI', 'Microsoft YaHei UI', 'Microsoft YaHei', 'Segoe UI Variable', 'Arial'];
			var names = String(stack || '').split(',').map(function (name) {
				return name.trim().replace(/^["']|["']$/g, '');
			});
			for (var index = 0; index < preferred.length; index += 1) {
				if (names.indexOf(preferred[index]) >= 0) return preferred[index];
			}
			for (var other = 0; other < names.length; other += 1) {
				if (names[other] && names[other] !== 'system-ui' && names[other] !== 'sans-serif') return names[other];
			}
			return 'Microsoft YaHei UI';
		}

		/** 把 DSH 的主题 token 带上，原生浮窗才能跟页面同色同字体。 */
		function currentTheme() {
			try {
				var styles = themeRoots().map(function (node) {
					return window.getComputedStyle(node);
				});
				function token(name) {
					for (var index = 0; index < styles.length; index += 1) {
						var value = styles[index].getPropertyValue(name);
						if (value && value.trim()) return value.trim();
					}
					return '';
				}
				var theme = {
					bgBase: token('--dsw-alias-bg-base'),
					bgLayer1: token('--dsw-alias-bg-layer-1'),
					bgLayer2: token('--dsw-alias-bg-layer-2'),
					bgOverlay: token('--dsw-alias-bg-overlay'),
					borderL1: token('--dsw-alias-border-l1'),
					borderL2: token('--dsw-alias-border-l2'),
					labelPrimary: token('--dsw-alias-label-primary'),
					labelSecondary: token('--dsw-alias-label-secondary'),
					brandPrimary: token('--dsw-alias-brand-primary'),
					fontFamily: pickFontFamily(styles.length ? styles[styles.length - 1].fontFamily : '')
				};
				if (!theme.fontFamily) theme.fontFamily = 'Microsoft YaHei UI';
				return theme;
			} catch (error) {
				return null;
			}
		}

		var externalInFlight = null;

		async function refreshExternal() {
			try {
				var data = await api('externalStatus', {});
				patch({ external: data.external });
				return data.external;
			} catch (error) {
				patch({ external: { supported: true, running: false, error: error.message || String(error) } });
				return null;
			}
		}

		function startExternal() {
			if (externalInFlight) return externalInFlight;
			externalInFlight = api('externalStart', {
				port: apiPort(),
				targetLanguage: store.settings.targetLanguage,
				tone: store.settings.tone,
				theme: currentTheme()
			})
				.then(function (data) {
					patch({ external: data.external });
					return data.external;
				})
				.catch(function (error) {
					patch({
						external: {
							supported: true,
							running: false,
							error: error.message || String(error),
							logPath: '%TEMP%\dsh-translate-capture.log'
						}
					});
					throw error;
				})
				.then(function (value) {
					externalInFlight = null;
					return value;
				});
			return externalInFlight;
		}

		async function stopExternal() {
			try {
				var data = await api('externalStop', {});
				patch({ external: data.external });
			} catch (error) {
				/* 宿主已经不在：忽略 */
			}
		}

		async function toggleExternal(next) {
			setSettings({ externalEnabled: !!next });
			if (!next) {
				toast('外部划译已关闭');
				return;
			}
			toast('正在启动外部划译…');
			try {
				await startExternal();
				toast(store.settings.selectionEnabled ? '外部划译已启动（选中即译）' : '外部划译已启动；总开关还是关的');
			} catch (error) {
				toast('外部划译启动失败：' + (error.message || error));
			}
		}

		async function retryExternal() {
			toast('正在重启伴生进程…');
			await stopExternal();
			try {
				await startExternal();
				toast('伴生进程已重启');
			} catch (error) {
				toast('重启失败：' + (error.message || error));
			}
		}

		/** 系统级划译的开关/状态行（设置页复用）。 */
		function ExternalSettingsRows(s) {
			var ext = s.external || {};
			var statusText = ext.running
				? '运行中 · pid ' + ext.pid
				: ext.error
					? '未运行：' + ext.error
					: ext.supported === false
						? '仅支持 Windows'
						: '未运行（总开关或本开关关闭）';
			var statusClass = 'dstr-chip' + (ext.running ? ' ok' : ext.error ? ' err' : '');
			return [
				h(
					'div',
					{ className: 'dstr-switch', key: 'ext-switch' },
					h('span', { className: 'dstr-hint' }, '外部（任意应用，选中即译，无需热键）'),
					h(
						'button',
						{
							key: 'ext-btn',
							type: 'button',
							className: 'dstr-switch-btn',
							role: 'switch',
							'aria-checked': s.settings.externalEnabled ? 'true' : 'false',
							'aria-label': '外部划译开关',
							onClick: function () {
								toggleExternal(!s.settings.externalEnabled);
							}
						},
						h('i', null)
					)
				),
				h(
					'div',
					{ className: 'dstr-row', key: 'ext-status' },
					h('span', { className: statusClass }, statusText),
					h('button', { key: 'ext-retry', type: 'button', className: 'dstr-btn ghost', onClick: retryExternal }, '重启伴生进程')
				),
				h(
					'div',
					{ className: 'dstr-hint', key: 'ext-hint' },
					'UIA 优先（不碰剪贴板）；读不到才注入一次 Ctrl+C 并还原剪贴板；终端窗口跳过。日志：' +
						(ext.logPath || '%TEMP%\dsh-translate-capture.log')
				),
				h(
					'div',
					{ className: 'dstr-switch', key: 'page-switch' },
					h('span', { className: 'dstr-hint' }, 'DSH 页面内也显示浮层（两者同开会在页面里双弹窗）'),
					h(
						'button',
						{
							key: 'page-btn',
							type: 'button',
							className: 'dstr-switch-btn',
							role: 'switch',
							'aria-checked': s.settings.pageOverlay ? 'true' : 'false',
							'aria-label': '页面内浮层开关',
							onClick: function () {
								setSettings({ pageOverlay: !s.settings.pageOverlay });
							}
						},
						h('i', null)
					)
				)
			];
		}

		/** 总开关 + 外部开关都开时，起伴生进程；任一关闭就收掉它。 */
		function ExternalBridge() {
			var s = useStore();
			var want = !!(s.settings.selectionEnabled && s.settings.externalEnabled);
			useEffect(
				function () {
					var disposed = false;
					var poll = null;
					var retry = null;
					if (!want) {
						stopExternal();
						return;
					}
					function ensureStarted() {
						if (disposed) return;
						startExternal()
							.catch(function () {
								/* 错误已经写进 store.external */
							})
							.then(function () {
								if (disposed) return;
								window.setTimeout(function () {
									if (!disposed) refreshExternal();
								}, 1800);
							});
					}
					ensureStarted();
					// 宿主刚热更完时首次 start 可能落在路由注册之前：只要还没跑起来就隔一会儿再试一次。
					var kicks = 0;
					poll = window.setInterval(function () {
						if (disposed) return;
						refreshExternal().then(function (ext) {
							if (disposed || !ext) return;
							if (!ext.running && !ext.error && kicks < 6) {
								kicks += 1;
								startExternal().catch(function () {});
							}
						});
					}, 12000);
					// 亮/暗主题或字体变化：把 token 推过去，浮窗下次出现就是新配色
					var observer = null;
					var themeTimer = null;
					try {
						observer = new window.MutationObserver(function () {
							if (disposed) return;
							if (themeTimer) window.clearTimeout(themeTimer);
							themeTimer = window.setTimeout(function () {
								if (disposed) return;
								api('externalTheme', { theme: currentTheme() }).catch(function () {});
							}, 300);
						});
						observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
					} catch (error) {
						observer = null;
					}
					return function () {
						disposed = true;
						if (poll) window.clearInterval(poll);
						if (retry) window.clearTimeout(retry);
						if (observer) observer.disconnect();
						stopExternal();
					};
				},
				[want, store.settings.targetLanguage, store.settings.tone]
			);
			return null;
		}

		/* ═══════════════════════════ 划译（选区） ═══════════════════════════ */

		var selectionController = null;
		var selectionSeq = 0;

		function readSelection() {
			var selection = safe(function () {
				return window.getSelection();
			}, null);
			if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
			var text = String(selection.toString() || '').trim();
			if (text.length < 2 || text.length > MAX_SELECTION_CHARS) return null;
			var range = selection.getRangeAt(0);
			var rect = safe(function () {
				return range.getBoundingClientRect();
			}, null);
			if (!rect || (!rect.width && !rect.height)) return null;
			var node = selection.anchorNode;
			var element = node && node.nodeType === 3 ? node.parentElement : node;
			if (element && typeof element.closest === 'function') {
				if (element.closest('[data-dstr-ui]')) return null;
				if (element.closest('input, textarea, [contenteditable=""], [contenteditable="true"]')) return null;
			}
			return { text: text, rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } };
		}

		function closeSelection() {
			if (selectionController) {
				selectionController.abort();
				selectionController = null;
			}
			selectionSeq += 1;
			if (store.selection) patch({ selection: null });
		}

		async function translateSelection(picked) {
			if (selectionController) selectionController.abort();
			var controller = new AbortController();
			selectionController = controller;
			selectionSeq += 1;
			var seq = selectionSeq;
			patch({ selection: { text: picked.text, rect: picked.rect, loading: true, result: '', error: null, target: null } });
			try {
				var current = store.settings;
				var data = await api(
					'translate',
					{
						text: picked.text,
						targetLanguage: current.targetLanguage,
						tone: current.tone,
						glossary: current.glossary,
						model: current.model || undefined,
						keepAlive: current.keepAlive
					},
					controller.signal
				);
				if (seq !== selectionSeq) return;
				patch({
					selection: {
						text: picked.text,
						rect: picked.rect,
						loading: false,
						result: data.text,
						error: null,
						target: data.targetLanguage,
						ms: data.ms
					}
				});
				refreshStatus();
			} catch (error) {
				if (error && error.name === 'AbortError') return;
				if (seq !== selectionSeq) return;
				patch({
					selection: {
						text: picked.text,
						rect: picked.rect,
						loading: false,
						result: '',
						error: error.message || String(error),
						target: null
					}
				});
			} finally {
				if (selectionController === controller) selectionController = null;
			}
		}

		/* ═══════════════════════════ 样式 ═══════════════════════════ */

		var CSS = [
			'.dstr-root{all:initial;font:inherit;color:var(--dsw-alias-label-primary);}',
			'.dstr-root *{box-sizing:border-box;}',

			/* 小图标 */
			'.dstr-dock{position:fixed;right:18px;bottom:92px;z-index:60;display:flex;flex-direction:column;align-items:flex-end;gap:8px;pointer-events:none;}',
			'.dstr-dock>*{pointer-events:auto;}',
			'.dstr-fab{width:38px;height:38px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay);display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.16);padding:0;position:relative;transition:transform .12s ease,border-color .12s ease;}',
			'.dstr-fab:hover{transform:translateY(-1px);border-color:var(--dsw-alias-border-l2);}',
			'.dstr-fab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}',
			'.dstr-fab-mark{color:var(--dsw-alias-brand-primary);display:flex;}',
			'.dstr-dot{position:absolute;right:4px;bottom:4px;width:7px;height:7px;border-radius:50%;border:1px solid var(--dsw-alias-bg-overlay);background:var(--dsw-alias-state-idle-primary);}',
			'.dstr-dot.on{background:var(--dsw-alias-state-success-primary);}',
			'.dstr-dot.err{background:var(--dsw-alias-state-error-primary);}',

			/* 菜单 */
			'.dstr-menu{min-width:220px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay);box-shadow:0 10px 30px rgba(0,0,0,.22);padding:6px;display:flex;flex-direction:column;gap:2px;}',
			'.dstr-menu-item{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 10px;border-radius:8px;font-size:13px;cursor:pointer;background:transparent;border:0;color:var(--dsw-alias-label-primary);text-align:left;width:100%;font-family:inherit;}',
			'.dstr-menu-item:hover{background:var(--dsw-alias-bg-layer-2);}',
			'.dstr-menu-item[disabled]{opacity:.45;cursor:not-allowed;}',
			'.dstr-menu-item .dstr-hint{color:var(--dsw-alias-label-secondary);font-size:12px;}',
			'.dstr-menu-sep{height:1px;background:var(--dsw-alias-border-l1);margin:4px 2px;}',
			'.dstr-menu-head{padding:6px 10px 4px;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);}',

			/* 划译浮层 */
			'.dstr-pop{position:fixed;z-index:70;width:min(400px,calc(100vw - 24px));border-radius:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay);box-shadow:0 14px 40px rgba(0,0,0,.26);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55;overflow:hidden;}',
			'.dstr-pop-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px;color:var(--dsw-alias-label-secondary);}',
			'.dstr-pop-body{padding:10px 12px;max-height:min(46vh,340px);overflow:auto;white-space:pre-wrap;word-break:break-word;}',
			'.dstr-pop-src{padding:0 12px 8px;max-height:76px;overflow:hidden;color:var(--dsw-alias-label-secondary);font-size:12px;white-space:pre-wrap;word-break:break-word;border-bottom:1px dashed var(--dsw-alias-border-l1);margin-bottom:8px;}',
			'.dstr-pop-foot{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:8px 10px;border-top:1px solid var(--dsw-alias-border-l1);}',

			/* 通用控件 */
			'.dstr-btn{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap;}',
			'.dstr-btn:hover{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);}',
			'.dstr-btn[disabled]{opacity:.45;cursor:not-allowed;}',
			'.dstr-btn.primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff;}',
			'.dstr-btn.primary:hover{filter:brightness(1.05);}',
			'.dstr-btn.ghost{background:transparent;border-color:transparent;color:var(--dsw-alias-label-secondary);}',
			'.dstr-btn.ghost:hover{background:var(--dsw-alias-bg-layer-2);}',
			'.dstr-icon-btn{width:26px;height:26px;border-radius:7px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font-size:14px;line-height:1;font-family:inherit;}',
			'.dstr-icon-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}',
			'.dstr-field{display:flex;flex-direction:column;gap:5px;min-width:0;}',
			'.dstr-label{font-size:11px;color:var(--dsw-alias-label-secondary);letter-spacing:.02em;}',
			'.dstr-input,.dstr-select,.dstr-textarea{width:100%;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;font-size:12px;font-family:inherit;padding:6px 8px;outline:none;}',
			'.dstr-input:focus,.dstr-select:focus,.dstr-textarea:focus{border-color:var(--dsw-alias-brand-primary);}',
			'.dstr-textarea{resize:vertical;line-height:1.6;}',
			'.dstr-chip{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 9px;border-radius:999px;font-size:11px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);}',
			'.dstr-chip.ok{color:var(--dsw-alias-state-success-primary);border-color:currentColor;}',
			'.dstr-chip.warn{color:var(--dsw-alias-state-warn-primary);border-color:currentColor;}',
			'.dstr-chip.err{color:var(--dsw-alias-state-error-primary);border-color:currentColor;}',

			/* 整页工作台 */
			'.dstr-page{display:flex;flex-direction:column;height:100%;min-height:520px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;}',
			'.dstr-head{display:flex;align-items:center;gap:12px;padding:14px 18px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:0 0 auto;}',
			'.dstr-head-main{display:flex;align-items:center;gap:10px;min-width:0;}',
			'.dstr-head-mark{color:var(--dsw-alias-brand-primary);display:flex;}',
			'.dstr-head-title{font-size:15px;font-weight:600;}',
			'.dstr-head-sub{font-size:11px;color:var(--dsw-alias-label-secondary);}',
			'.dstr-head-actions{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
			'.dstr-tabs{display:flex;gap:4px;padding:8px 18px 0;flex:0 0 auto;}',
			'.dstr-tab{height:30px;padding:0 12px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer;border-bottom:2px solid transparent;font-family:inherit;}',
			'.dstr-tab.active{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary);}',
			'.dstr-tab:hover{color:var(--dsw-alias-label-primary);}',
			'.dstr-body{flex:1 1 auto;min-height:0;overflow:auto;padding:16px 18px 28px;}',

			/* 文本页 */
			'.dstr-text-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px;height:100%;min-height:420px;}',
			'@media (max-width:900px){.dstr-text-grid{grid-template-columns:minmax(0,1fr);height:auto;}}',
			'.dstr-pane{display:flex;flex-direction:column;gap:8px;min-height:0;}',
			'.dstr-pane-head{display:flex;align-items:center;justify-content:space-between;gap:8px;}',
			'.dstr-pane-title{font-size:12px;color:var(--dsw-alias-label-secondary);}',
			'.dstr-pane textarea{flex:1 1 auto;min-height:260px;}',
			'.dstr-out{flex:1 1 auto;min-height:260px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);padding:10px;overflow:auto;white-space:pre-wrap;word-break:break-word;line-height:1.65;}',
			'.dstr-out.empty{color:var(--dsw-alias-label-secondary);}',
			'.dstr-row{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap;}',
			'.dstr-row .dstr-field{flex:0 0 auto;min-width:132px;}',
			'.dstr-row .dstr-spacer{flex:1 1 auto;}',
			'.dstr-meta{font-size:11px;color:var(--dsw-alias-label-secondary);display:flex;gap:10px;flex-wrap:wrap;}',
			'.dstr-error{border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);background:transparent;border-radius:8px;padding:8px 10px;font-size:12px;line-height:1.5;}',

			/* 文件页 */
			'.dstr-drop{border:1.5px dashed var(--dsw-alias-border-l2);border-radius:12px;padding:26px 18px;text-align:center;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:border-color .12s ease,background .12s ease;}',
			'.dstr-drop:hover,.dstr-drop.over{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);}',
			'.dstr-drop-title{font-size:13px;color:var(--dsw-alias-label-primary);margin-bottom:4px;}',
			'.dstr-drop-hint{font-size:11px;line-height:1.6;}',
			'.dstr-file-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:14px;}',
			'.dstr-progress{flex:1 1 220px;height:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;min-width:140px;}',
			'.dstr-progress > i{display:block;height:100%;background:var(--dsw-alias-brand-primary);transition:width .18s ease;}',
			'.dstr-seg-list{display:flex;flex-direction:column;gap:8px;margin-top:14px;}',
			'.dstr-seg{display:grid;grid-template-columns:14px minmax(0,1fr) minmax(0,1fr);gap:10px;align-items:start;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:8px 10px;background:var(--dsw-alias-bg-layer-1);}',
			'@media (max-width:820px){.dstr-seg{grid-template-columns:14px minmax(0,1fr);}}',
			'.dstr-seg-state{width:8px;height:8px;border-radius:50%;margin-top:6px;background:var(--dsw-alias-state-idle-primary);}',
			'.dstr-seg-state.doing{background:var(--dsw-alias-state-warn-primary);animation:dstr-pulse 1.1s ease-in-out infinite;}',
			'.dstr-seg-state.done{background:var(--dsw-alias-state-success-primary);}',
			'.dstr-seg-state.error{background:var(--dsw-alias-state-error-primary);}',
			'@keyframes dstr-pulse{0%,100%{opacity:1}50%{opacity:.35}}',
			'.dstr-seg-text{white-space:pre-wrap;word-break:break-word;line-height:1.55;font-size:12px;max-height:150px;overflow:auto;}',
			'.dstr-seg-out{white-space:pre-wrap;word-break:break-word;line-height:1.55;font-size:12px;color:var(--dsw-alias-label-secondary);max-height:150px;overflow:auto;}',
			'.dstr-seg-out.done{color:var(--dsw-alias-label-primary);}',
			'.dstr-seg-out.error{color:var(--dsw-alias-state-error-primary);}',

			/* 设置页 */
			'.dstr-settings{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px;max-width:1000px;}',
			'.dstr-card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:10px;background:var(--dsw-alias-bg-layer-1);}',
			'.dstr-card-title{font-size:12px;font-weight:600;}',
			'.dstr-switch{display:flex;align-items:center;justify-content:space-between;gap:12px;}',
			'.dstr-switch-btn{width:38px;height:22px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);position:relative;cursor:pointer;padding:0;transition:background .14s ease;}',
			'.dstr-switch-btn > i{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-bg-base);transition:left .14s ease;}',
			'.dstr-switch-btn[aria-checked="true"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);}',
			'.dstr-switch-btn[aria-checked="true"] > i{left:18px;background:#fff;}',
			'.dstr-hint{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.6;}',
			'.dstr-kv{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 14px;font-size:12px;}',
			'.dstr-kv dt{color:var(--dsw-alias-label-secondary);}',
			'.dstr-kv dd{margin:0;word-break:break-all;}',

			/* 浮层兜底工作台 */
			'.dstr-veil{position:fixed;inset:0;z-index:80;background:rgba(0,0,0,.42);display:flex;align-items:center;justify-content:center;padding:24px;}',
			'.dstr-sheet{width:min(1100px,100%);height:min(760px,100%);border-radius:16px;overflow:hidden;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);box-shadow:0 24px 60px rgba(0,0,0,.35);display:flex;flex-direction:column;}',
			'.dstr-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:90;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:8px 14px;font-size:12px;color:var(--dsw-alias-label-primary);box-shadow:0 10px 30px rgba(0,0,0,.2);}'
		].join('\n');

		function Styles() {
			return h('style', null, CSS);
		}

		/* ═══════════════════════════ 图标 ═══════════════════════════ */

		function Mark(props) {
			var size = (props && props.size) || 18;
			return h(
				'svg',
				{ width: size, height: size, viewBox: '0 0 64 64', 'aria-hidden': 'true', focusable: 'false' },
				h('rect', { x: 1.5, y: 1.5, width: 61, height: 61, rx: 14, fill: 'none', stroke: 'currentColor', strokeWidth: 3 }),
				h('path', { d: 'M22 27h20M22 34h13', stroke: 'currentColor', strokeWidth: 3.4, strokeLinecap: 'round', fill: 'none' }),
				h('path', { d: 'M17 44h30', stroke: 'currentColor', strokeWidth: 3.4, strokeLinecap: 'round', fill: 'none', opacity: 0.45 })
			);
		}

		function Spinner() {
			return h('span', { className: 'dstr-hint' }, '翻译中…');
		}

		/* ══════════════════════════ 小图标 + 菜单 ══════════════════════════ */

		function Dock() {
			var s = useStore();
			var status = s.status;
			var loaded = !!(status && status.loaded);
			var dotClass = 'dstr-dot' + (s.statusError ? ' err' : loaded ? ' on' : '');

			function onMenu(event) {
				event.preventDefault();
				event.stopPropagation();
				patch({ menu: { x: event.clientX, y: event.clientY } });
				refreshStatus();
			}

			return h(
				'div',
				{ className: 'dstr-root dstr-dock', 'data-dstr-ui': '1' },
				h(Styles, null),
				s.menu ? h(ContextMenu, { menu: s.menu, onClose: function () { patch({ menu: null }); } }) : null,
				s.toast ? h('div', { className: 'dstr-toast' }, s.toast) : null,
				h(
					'button',
					{
						type: 'button',
						className: 'dstr-fab',
						title: '翻译（左键打开工作台，右键菜单）',
						'aria-label': '翻译',
						onClick: function (event) {
							event.preventDefault();
							if (!selectTranslatePanel()) {
								patch({ overlayOpen: true });
							}
						},
						onContextMenu: onMenu
					},
					h('span', { className: 'dstr-fab-mark' }, h(Mark, { size: 20 })),
					h('span', { className: dotClass })
				)
			);
		}

		function ContextMenu(props) {
			var s = useStore();
			var status = s.status;
			var loaded = !!(status && status.loaded);
			var enabled = s.settings.selectionEnabled;
			var externalOn = !!s.settings.externalEnabled;
			var rect = useRef(null);
			var op = useRef(null);
			var place = useRef(null);

			useEffect(function () {
				var node = op.current;
				if (!node) return;
				var width = node.offsetWidth || 230;
				var height = node.offsetHeight || 220;
				var left = Math.min(Math.max(8, props.menu.x - width + 12), window.innerWidth - width - 8);
				var top = props.menu.y - height - 10;
				if (top < 8) top = Math.min(props.menu.y + 14, window.innerHeight - height - 8);
				node.style.left = left + 'px';
				node.style.top = top + 'px';
				if (place.current) place.current.focus();
			}, [props.menu]);

			useEffect(function () {
				function onDown(event) {
					var node = op.current;
					if (node && node.contains(event.target)) return;
					props.onClose();
				}
				function onKey(event) {
					if (event.key === 'Escape') props.onClose();
				}
				window.addEventListener('mousedown', onDown, true);
				window.addEventListener('keydown', onKey, true);
				return function () {
					window.removeEventListener('mousedown', onDown, true);
					window.removeEventListener('keydown', onKey, true);
				};
			}, []);

			function item(label, hint, onClick, disabled) {
				return h(
					'button',
					{
						type: 'button',
						className: 'dstr-menu-item',
						disabled: !!disabled,
						onClick: function () {
							props.onClose();
							if (onClick) onClick();
						}
					},
					h('span', null, label),
					hint ? h('span', { className: 'dstr-hint' }, hint) : null
				);
			}

			return h(
				'div',
				{
					ref: op,
					className: 'dstr-root dstr-menu',
					style: { position: 'fixed', zIndex: 90, left: 8, top: 8 },
					role: 'menu',
					tabIndex: -1,
					onContextMenu: function (event) {
						event.preventDefault();
					}
				},
				h(Styles, null),
				h('div', { className: 'dstr-menu-head' }, loaded ? '模型已加载' : '模型未加载'),
				item('打开翻译工作台', '', function () {
					if (!selectTranslatePanel()) patch({ overlayOpen: true });
				}),
				h('div', { className: 'dstr-menu-sep' }),
				enabled
					? item('关闭划译', '当前：开', function () { setSettings({ selectionEnabled: false }); toast('划译已关闭'); })
					: item('开启划译', '当前：关', function () { setSettings({ selectionEnabled: true }); toast('划译已开启'); }),
				item(
					externalOn ? '关闭外部划译' : '开启外部划译',
					s.external && s.external.running ? '运行中（系统级）' : '系统级 / 未运行',
					function () {
						toggleExternal(!externalOn);
					}
				),
				loaded ? item('关闭模型', '释放内存', unloadModel) : item('加载模型', '预热到内存', loadModel),
				item('刷新状态', '', refreshStatus, s.statusBusy),
				h('div', { className: 'dstr-menu-sep' }),
				item('设置…', '', function () {
					patch({ activeTab: 'settings' });
					if (!selectTranslatePanel()) patch({ overlayOpen: true });
				})
			);
		}

		/* ═══════════════════════════ 划译浮层 ═══════════════════════════ */

		function SelectionPopover() {
			var s = useStore();
			var selection = s.selection;
			var box = useRef(null);
			var last = useRef('');
			var translated = useRef('');
			var seq = useRef(0);

			useEffect(function () {
				var node = box.current;
				if (!node || !selection) return;
				var rect = selection.rect;
				var width = node.offsetWidth || 380;
				var height = node.offsetHeight || 180;
				var left = Math.min(Math.max(10, rect.left), window.innerWidth - width - 10);
				var top = rect.bottom + 10;
				if (top + height > window.innerHeight - 10) {
					var above = rect.top - height - 10;
					top = above >= 10 ? above : Math.max(10, window.innerHeight - height - 10);
				}
				node.style.left = left + 'px';
				node.style.top = top + 'px';
			}, [selection]);

			useEffect(function () {
				if (!selection || selection.loading) return;
				if (selection.result && translated.current !== selection.result) {
					translated.current = selection.result;
					seq.current += 1;
				}
			}, [selection]);

			useEffect(function () {
				function onKey(event) {
					if (!selection) return;
					if (event.key === 'Escape') closeSelection();
				}
				function onScroll() {
					if (selection) closeSelection();
				}
				window.addEventListener('keydown', onKey, true);
				window.addEventListener('scroll', onScroll, true);
				return function () {
					window.removeEventListener('keydown', onKey, true);
					window.removeEventListener('scroll', onScroll, true);
				};
			}, [!!selection]);

			if (!selection) return null;
			last.current = selection.text;

			return h(
				'div',
				{
					ref: box,
					className: 'dstr-root dstr-pop',
					'data-dstr-ui': '1',
					style: { position: 'fixed', left: 10, top: 10 },
					onMouseDown: function (event) {
						event.stopPropagation();
					}
				},
				h(Styles, null),
				h(
					'div',
					{ className: 'dstr-pop-head' },
					h('span', null, '→ ' + (selection.target ? langLabel(selection.target) : langLabel(s.settings.targetLanguage))),
					h(
						'button',
						{
							type: 'button',
							className: 'dstr-icon-btn',
							title: '关闭（Esc）',
							onClick: closeSelection
						},
						'×'
					)
				),
				h('div', { className: 'dstr-pop-src' }, selection.text),
				h(
					'div',
					{ className: 'dstr-pop-body' },
					selection.loading ? h(Spinner, null) : selection.error ? h('span', { style: { color: 'var(--dsw-alias-state-error-primary)' } }, selection.error) : selection.result
				),
				h(
					'div',
					{ className: 'dstr-pop-foot' },
					selection.ms ? h('span', { className: 'dstr-hint', style: { marginRight: 'auto' } }, selection.ms + ' ms') : null,
					h(
						'button',
						{
							type: 'button',
							className: 'dstr-btn ghost',
							onClick: function () {
								translateSelection({ text: selection.text, rect: selection.rect });
							}
						},
						'重译'
					),
					h(
						'button',
						{
							type: 'button',
							className: 'dstr-btn',
							disabled: !selection.result,
							onClick: function () {
								copyText(selection.result).then(function (ok) {
									toast(ok ? '已复制译文' : '复制失败');
								});
							}
						},
						'复制'
					)
				)
			);
		}

		/* 划译监听器：开关关闭时不挂任何监听。 */
		function SelectionBridge() {
			var s = useStore();
			var externalRunning = !!(s.external && s.external.running);
			// 外部划译在跑时，页面内默认让位（避免双弹窗）；pageOverlay 可强行都开。
			var enabled = s.settings.selectionEnabled && (s.settings.pageOverlay || !externalRunning);
			var delay = s.settings.selectionDelayMs;
			var settingsRef = useRef(store.settings);
			settingsRef.current = store.settings;
			var lastText = useRef('');

			useEffect(
				function () {
					if (!enabled) return;
					var timer = null;
					var disposed = false;

					function schedule() {
						if (timer) window.clearTimeout(timer);
						timer = window.setTimeout(function () {
							timer = null;
							if (disposed) return;
							var picked = readSelection();
							if (!picked) return;
							// 同一个选区不重复翻译；浮层关掉后重新选中同一段仍可再翻。
							if (picked.text === lastText.current && store.selection) return;
							lastText.current = picked.text;
							translateSelection(picked);
						}, Math.max(120, delay));
					}

					function onSelectionChange() {
						schedule();
					}

					function onMouseDown(event) {
						var node = event.target;
						if (node && node.closest && node.closest('[data-dstr-ui]')) return;
						if (store.selection) closeSelection();
					}

					function onKeyDown(event) {
						if (event.key === 'Escape' && store.selection) closeSelection();
					}

					document.addEventListener('selectionchange', onSelectionChange);
					document.addEventListener('mousedown', onMouseDown, true);
					document.addEventListener('keydown', onKeyDown, true);

					return function () {
						disposed = true;
						if (timer) window.clearTimeout(timer);
						document.removeEventListener('selectionchange', onSelectionChange);
						document.removeEventListener('mousedown', onMouseDown, true);
						document.removeEventListener('keydown', onKeyDown, true);
						closeSelection();
						lastText.current = '';
					};
				},
				[enabled, delay]
			);

			return null;
		}

		/* ═════════════════════════════ 工作台 ═════════════════════════════ */

		function Workbench() {
			var s = useStore();
			var tab = s.activeTab || 'text';
			var status = s.status;
			var loaded = !!(status && status.loaded);
			var chipClass = 'dstr-chip' + (s.statusError ? ' err' : loaded ? ' ok' : '');
			var chipText = s.statusError ? '服务不可用' : status ? (loaded ? '模型已加载' : '模型未加载') : '状态未知';

			useEffect(function () {
				refreshStatus();
			}, []);

			function tabButton(id, label) {
				return h(
					'button',
					{
						type: 'button',
						className: 'dstr-tab' + (tab === id ? ' active' : ''),
						onClick: function () {
							patch({ activeTab: id });
						}
					},
					label
				);
			}

			return h(
				'div',
				{ className: 'dstr-root dstr-page', 'data-dstr-ui': '1' },
				h(Styles, null),
				h(
					'div',
					{ className: 'dstr-head' },
					h(
						'div',
						{ className: 'dstr-head-main' },
						h('span', { className: 'dstr-head-mark' }, h(Mark, { size: 22 })),
						h(
							'div',
							null,
							h('div', { className: 'dstr-head-title' }, '翻译'),
							h('div', { className: 'dstr-head-sub' }, '本地 Ollama · ' + (s.settings.model || (status && status.model) || '—'))
						)
					),
					h('span', { className: chipClass, title: s.statusError || '' }, chipText),
					h(
						'div',
						{ className: 'dstr-head-actions' },
						h(
							'button',
							{ type: 'button', className: 'dstr-btn ghost', onClick: refreshStatus, disabled: s.statusBusy },
							'刷新'
						),
						loaded
							? h('button', { type: 'button', className: 'dstr-btn', onClick: unloadModel }, '关闭模型')
							: h('button', { type: 'button', className: 'dstr-btn', onClick: loadModel }, '加载模型')
					)
				),
				h('div', { className: 'dstr-tabs' }, tabButton('text', '文本'), tabButton('file', '文件'), tabButton('settings', '设置')),
				h('div', { className: 'dstr-body' }, tab === 'text' ? h(TextTab, null) : tab === 'file' ? h(FileTab, null) : h(SettingsTab, null))
			);
		}

		/* ── 文本页 ── */

		function TextTab() {
			var s = useStore();
			var sourcePair = useState('');
			var source = sourcePair[0];
			var setSource = sourcePair[1];
			var resultPair = useState('');
			var result = resultPair[0];
			var setResult = resultPair[1];
			var errorPair = useState(null);
			var error = errorPair[0];
			var setError = errorPair[1];
			var metaPair = useState(null);
			var meta = metaPair[0];
			var setMeta = metaPair[1];
			var busyPair = useState(false);
			var busy = busyPair[0];
			var setBusy = busyPair[1];
			var targetPair = useState(null);
			var resolved = targetPair[0];
			var setResolved = targetPair[1];
			var controller = useRef(null);
			var input = useRef(null);

			useEffect(function () {
				return function () {
					if (controller.current) controller.current.abort();
				};
			}, []);

			async function run() {
				if (busy) return;
				var text = source.trim();
				if (!text) {
					setError('请输入要翻译的文本');
					return;
				}
				if (controller.current) controller.current.abort();
				var control = new AbortController();
				controller.current = control;
				setBusy(true);
				setError(null);
				var started = Date.now();
				try {
					var current = store.settings;
					var data = await api(
						'translate',
						{
							text: text,
							targetLanguage: current.targetLanguage,
							sourceLanguage: current.sourceLanguage,
							tone: current.tone,
							glossary: current.glossary,
							model: current.model || undefined,
							keepAlive: current.keepAlive
						},
						control.signal
					);
					setResult(data.text);
					setResolved(data.targetLanguage);
					setMeta({ ms: data.ms || Date.now() - started, chunks: data.chunks, chars: text.length });
					refreshStatus();
				} catch (failure) {
					if (failure && failure.name === 'AbortError') return;
					setError(failure.message || String(failure));
					setResult('');
				} finally {
					if (controller.current === control) controller.current = null;
					setBusy(false);
				}
			}

			function onKeyDown(event) {
				if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
					event.preventDefault();
					run();
				}
			}

			return h(
				'div',
				{ className: 'dstr-text-grid' },
				h(
					'div',
					{ className: 'dstr-pane' },
					h(
						'div',
						{ className: 'dstr-row' },
						h(
							'label',
							{ className: 'dstr-field' },
							h('span', { className: 'dstr-label' }, '目标语言'),
							h(
								'select',
								{
									className: 'dstr-select',
									value: store.settings.targetLanguage,
									onChange: function (event) {
										setSettings({ targetLanguage: event.target.value });
									}
								},
								LANGS.map(function (lang) {
									return h('option', { key: lang.id, value: lang.id }, lang.label);
								})
							)
						),
						h(
							'label',
							{ className: 'dstr-field' },
							h('span', { className: 'dstr-label' }, '语气'),
							h(
								'select',
								{
									className: 'dstr-select',
									value: store.settings.tone,
									onChange: function (event) {
										setSettings({ tone: event.target.value });
									}
								},
								TONES.map(function (tone) {
									return h('option', { key: tone.id, value: tone.id }, tone.label);
								})
							)
						),
						h('span', { className: 'dstr-spacer' }),
						h('span', { className: 'dstr-meta' }, source.length + ' 字符')
					),
					h(
						'div',
						{ className: 'dstr-pane-head' },
						h('span', { className: 'dstr-pane-title' }, '原文'),
						h(
							'button',
							{
								type: 'button',
								className: 'dstr-btn ghost',
								onClick: function () {
									setSource('');
									setResult('');
									setMeta(null);
									setError(null);
									if (input.current) input.current.focus();
								}
							},
							'清空'
						)
					),
					h('textarea', {
						ref: input,
						className: 'dstr-textarea',
						value: source,
						placeholder: '粘贴或输入要翻译的文本…（Ctrl+Enter 翻译）',
						spellCheck: false,
						onChange: function (event) {
							setSource(event.target.value);
						},
						onKeyDown: onKeyDown
					}),
					h(
						'div',
						{ className: 'dstr-row' },
						h(
							'button',
							{ type: 'button', className: 'dstr-btn primary', onClick: run, disabled: busy || !source.trim() },
							busy ? '翻译中…' : '翻译（Ctrl+Enter）'
						),
						busy
							? h(
									'button',
									{
										type: 'button',
										className: 'dstr-btn',
										onClick: function () {
											if (controller.current) controller.current.abort();
										}
									},
									'取消'
								)
							: null
					)
				),
				h(
					'div',
					{ className: 'dstr-pane' },
					h(
						'div',
						{ className: 'dstr-pane-head' },
						h('span', { className: 'dstr-pane-title' }, '译文' + (resolved ? ' · ' + langLabel(resolved) : '')),
						h(
							'button',
							{
								type: 'button',
								className: 'dstr-btn ghost',
								disabled: !result,
								onClick: function () {
									copyText(result).then(function (ok) {
										toast(ok ? '已复制译文' : '复制失败');
									});
								}
							},
							'复制'
						)
					),
					error ? h('div', { className: 'dstr-error' }, error) : null,
					h('div', { className: 'dstr-out' + (result ? '' : ' empty') }, result || (busy ? '翻译中…' : '译文会显示在这里')),
					meta
						? h(
								'div',
								{ className: 'dstr-meta' },
								[
									meta.chunks ? meta.chunks + ' 段' : '1 段',
									Math.round(meta.ms) + ' ms',
									meta.chars + ' 字符'
								].join(' · ')
							)
						: null
				)
			);
		}

		/* ── 文件页 ── */

		function FileTab() {
			var s = useStore();
			var infoPair = useState(null);
			var info = infoPair[0];
			var setInfo = infoPair[1];
			var segmentsPair = useState([]);
			var segments = segmentsPair[0];
			var setSegments = segmentsPair[1];
			var runningPair = useState(false);
			var running = runningPair[0];
			var setRunning = runningPair[1];
			var errorPair = useState(null);
			var error = errorPair[0];
			var setError = errorPair[1];
			var busyPair = useState(false);
			var busy = busyPair[0];
			var setBusy = busyPair[1];
			var overPair = useState(false);
			var over = overPair[0];
			var setOver = overPair[1];
			var controller = useRef(null);
			var segmentsRef = useRef([]);
			var downloadRef = useRef(null);
			var fileInput = useRef(null);

			segmentsRef.current = segments;

			useEffect(function () {
				return function () {
					if (controller.current) controller.current.abort();
				};
			}, []);

			async function accept(file) {
				if (!file) return;
				if (running) {
					setError('请先取消正在进行的翻译');
					return;
				}
				if (controller.current) controller.current.abort();
				setBusy(true);
				setError(null);
				setInfo(null);
				setSegments([]);
				try {
					var buffer = await file.arrayBuffer();
					var data = await api('extract', {
						name: file.name,
						dataBase64: toBase64(buffer)
					});
					setInfo({
						name: file.name,
						size: file.size,
						format: data.format,
						chars: data.chars,
						layout: data.layout || 'paragraphs',
						warnings: data.warnings || []
					});
					var rows = data.segments.map(function (segment) {
						return { text: segment.text, kind: segment.kind, state: 'pending', out: '', error: null };
					});
					setSegments(rows);
				} catch (failure) {
					setError(failure.message || String(failure));
				} finally {
					setBusy(false);
				}
			}

			function updateAt(index, next) {
				setSegments(function (previous) {
					var copy = previous.slice();
					if (copy[index]) copy[index] = Object.assign({}, copy[index], next);
					return copy;
				});
			}

			async function runAll() {
				if (running) return;
				var rows = segmentsRef.current.slice();
				var pending = rows.filter(function (row) {
					return row.state !== 'done';
				});
				if (pending.length === 0) return;
				var control = new AbortController();
				controller.current = control;
				setRunning(true);
				setError(null);
				var current = store.settings;
				for (var index = 0; index < rows.length; index += 1) {
					if (control.signal.aborted) break;
					var row = rows[index];
					if (row.state === 'done') continue;
					if (row.kind === 'code') {
						updateAt(index, { state: 'done', out: row.text });
						continue;
					}
					updateAt(index, { state: 'doing', error: null });
					var ok = false;
					for (var attempt = 0; attempt < 2 && !ok; attempt += 1) {
						try {
							var data = await api(
								'translate',
								{
									text: row.text,
									targetLanguage: current.targetLanguage,
									tone: current.tone,
									glossary: current.glossary,
									model: current.model || undefined,
									keepAlive: current.keepAlive
								},
								control.signal
							);
							ok = true;
							updateAt(index, { state: 'done', out: data.text, error: null });
						} catch (failure) {
							if (failure && failure.name === 'AbortError') break;
							if (attempt === 1) updateAt(index, { state: 'error', error: failure.message || String(failure) });
							else await sleep(400);
						}
					}
					if (!ok && control.signal.aborted) break;
				}
				setRunning(false);
				if (controller.current === control) controller.current = null;
				if (control.signal.aborted) toast('已取消文件翻译');
				else {
					refreshStatus();
					toast('文件翻译完成');
				}
			}

			function renderOutput() {
				var rows = segmentsRef.current;
				var layout = (info && info.layout) || 'paragraphs';
				var done = rows.filter(function (row) {
					return row.state === 'done' || row.state === 'error';
				});
				if (done.length === 0) return '';
				// 字幕（按行布局）：结构行原样保留，只替换文本行，逐行拼接 → 仍是合法 srt/vtt。
				if (layout === 'lines') {
					return rows
						.map(function (row) {
							if (row.kind === 'code') return row.text;
							if (row.state === 'done') return row.out;
							return row.text;
						})
						.join('\n');
				}
				var mode = store.settings.fileMode;
				var pieces = [];
				done.forEach(function (row) {
					var translated = row.state === 'done' ? row.out : '［翻译失败：' + (row.error || '未知错误') + '］';
					if (mode === 'bilingual' && row.kind !== 'code') pieces.push(row.text + '\n\n' + translated);
					else pieces.push(translated);
				});
				return pieces.join('\n\n');
			}

			function exportFile() {
				var text = renderOutput();
				if (!text) {
					toast('还没有可导出的译文');
					return;
				}
				var base = (info && info.name) || 'translation.txt';
				var dot = base.lastIndexOf('.');
				if (dot > 0) base = base.slice(0, dot);
				var name = base + '.译文.md';
				var anchor = downloadRef.current;
				if (!anchor) return;
				var url = window.URL.createObjectURL(new window.Blob([text], { type: 'text/markdown;charset=utf-8' }));
				anchor.href = url;
				anchor.download = name;
				anchor.click();
				window.setTimeout(function () {
					window.URL.revokeObjectURL(url);
				}, 2000);
				toast('已导出 ' + name);
			}

			var subtitle = !!(info && info.layout === 'lines');
			var counted = subtitle
				? segments.filter(function (row) {
						return row.kind === 'text';
					})
				: segments;
			var total = counted.length;
			var finished = counted.filter(function (row) {
				return row.state === 'done' || row.state === 'error';
			}).length;
			var percent = total ? Math.round((finished / total) * 100) : 0;
			var indexed = segments.map(function (row, index) {
				return { row: row, index: index };
			});
			if (subtitle) {
				indexed = indexed.filter(function (entry) {
					return entry.row.kind === 'text';
				});
			}
			var visible = indexed.length > MAX_RENDERED_SEGMENTS ? indexed.slice(0, MAX_RENDERED_SEGMENTS) : indexed;

			return h(
				'div',
				null,
				h('a', { ref: downloadRef, style: { display: 'none' }, 'aria-hidden': 'true' }, ''),
				h('input', {
					ref: fileInput,
					type: 'file',
					style: { display: 'none' },
					accept: '.txt,.text,.log,.md,.markdown,.mdx,.rst,.adoc,.tex,.csv,.tsv,.json,.jsonl,.yaml,.yml,.ini,.toml,.env,.srt,.vtt,.html,.htm,.xhtml,.xml,.docx,.docm,.xlsx,.xlsm,.pptx,.pptm,.epub',
					onChange: function (event) {
						var file = event.target.files && event.target.files[0];
						accept(file);
						event.target.value = '';
					}
				}),
				h(
					'div',
					{
						className: 'dstr-drop' + (over ? ' over' : ''),
						onClick: function () {
							if (!busy && fileInput.current) fileInput.current.click();
						},
						onDragOver: function (event) {
							event.preventDefault();
							setOver(true);
						},
						onDragLeave: function () {
							setOver(false);
						},
						onDrop: function (event) {
							event.preventDefault();
							setOver(false);
							var file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
							accept(file);
						}
					},
					h('div', { className: 'dstr-drop-title' }, busy ? '正在读取文件…' : '拖入文件，或点击选择'),
					h(
						'div',
						{ className: 'dstr-drop-hint' },
						'文档：.docx / .xlsx / .pptx / .epub · 文本：.txt / .md / .srt / .html / .json / .csv …',
						h('br', null),
						'单个文件上限 12 MB；PDF 与旧版 Office 二进制格式暂不支持'
					)
				),
				error ? h('div', { className: 'dstr-error', style: { marginTop: '12px' } }, error) : null,
				info
					? h(
							'div',
							{ className: 'dstr-file-bar' },
							h('span', { className: 'dstr-chip' }, info.format.toUpperCase()),
							h('span', null, info.name),
							h('span', { className: 'dstr-hint' }, byteLabel(info.size) + ' · ' + info.chars + ' 字符 · ' + total + ' 段')
						)
					: null,
				info && info.warnings && info.warnings.length
					? h('div', { className: 'dstr-hint', style: { marginTop: '6px' } }, info.warnings.join('；'))
					: null,
				info
					? h(
							'div',
							{ className: 'dstr-file-bar' },
							h(
								'button',
								{ type: 'button', className: 'dstr-btn primary', onClick: runAll, disabled: running || busy || total === 0 },
								running ? '翻译中…' : '开始翻译'
							),
							running
								? h(
										'button',
										{
											type: 'button',
											className: 'dstr-btn',
											onClick: function () {
												if (controller.current) controller.current.abort();
											}
										},
										'取消'
									)
								: null,
							h('div', { className: 'dstr-progress' }, h('i', { style: { width: percent + '%' } })),
							h('span', { className: 'dstr-hint' }, finished + ' / ' + total),
							subtitle
								? h('span', { className: 'dstr-hint' }, '字幕：仅导出译文，时间轴原样保留')
								: h(
										'select',
										{
											className: 'dstr-select',
											style: { width: 'auto' },
											value: store.settings.fileMode,
											onChange: function (event) {
												setSettings({ fileMode: event.target.value });
											}
										},
										h('option', { value: 'bilingual' }, '双语对照'),
										h('option', { value: 'target' }, '仅译文')
									),
							h('button', { type: 'button', className: 'dstr-btn', onClick: exportFile, disabled: finished === 0 }, '导出')
						)
					: null,
				total > 0
					? h(
							'div',
							{ className: 'dstr-seg-list' },
							visible.map(function (entry) {
								var row = entry.row;
								return h(
									'div',
									{ className: 'dstr-seg', key: entry.index },
									h('span', { className: 'dstr-seg-state ' + row.state, title: row.state }),
									h('div', { className: 'dstr-seg-text' }, row.text),
									h(
										'div',
										{ className: 'dstr-seg-out' + (row.state === 'done' ? ' done' : row.state === 'error' ? ' error' : '') },
										row.state === 'error'
											? '［失败］' + (row.error || '')
											: row.state === 'doing'
												? '翻译中…'
												: row.kind === 'code'
													? '（代码块，原样保留）'
													: row.out || '待翻译'
									)
								);
							}),
							segments.length > visible.length
								? h('div', { className: 'dstr-hint' }, '仅显示前 ' + visible.length + ' 段（导出仍包含全部 ' + segments.length + ' 段）')
								: null
						)
					: null
			);
		}

		/* ── 设置页 ── */

		function SettingsTab() {
			var s = useStore();
			var status = s.status;
			var models = (status && status.models) || [];
			var modelOptions = models.length
				? models.map(function (entry) {
						return entry.name;
					})
				: [];
			var modelValue = store.settings.model || (status && status.model) || '';
			if (modelValue && modelOptions.indexOf(modelValue) === -1) modelOptions = [modelValue].concat(modelOptions);

			function field(label, node, hint) {
				return h(
					'label',
					{ className: 'dstr-field' },
					h('span', { className: 'dstr-label' }, label),
					node,
					hint ? h('span', { className: 'dstr-hint' }, hint) : null
				);
			}

			return h(
				'div',
				{ className: 'dstr-settings' },
				h(
					'div',
					{ className: 'dstr-card' },
					h('div', { className: 'dstr-card-title' }, '划译'),
					h(
						'div',
						{ className: 'dstr-switch' },
						h('span', { className: 'dstr-hint' }, '选中文字后停顿自动翻译'),
						h(
							'button',
							{
								type: 'button',
								className: 'dstr-switch-btn',
								role: 'switch',
								'aria-checked': store.settings.selectionEnabled ? 'true' : 'false',
								'aria-label': '划译开关',
								onClick: function () {
									setSettings({ selectionEnabled: !store.settings.selectionEnabled });
								}
							},
							h('i', null)
						)
					),
					ExternalSettingsRows(store),
					field(
						'停顿（毫秒）',
						h('input', {
							className: 'dstr-input',
							type: 'number',
							min: 150,
							max: 3000,
							step: 50,
							value: store.settings.selectionDelayMs,
							onChange: function (event) {
								setSettings({ selectionDelayMs: Math.min(3000, Math.max(150, Number(event.target.value) || 500)) });
							}
						}),
						'选中后多久开始翻译；Esc / 点空白 / 滚动会取消'
					),
					h(
						'div',
						{ className: 'dstr-hint' },
						'总开关关闭：页内不注册任何选区监听，外部伴生进程也会退出。外部划译在跑时，页面内浮层默认让位。'
					)
				),
				h(
					'div',
					{ className: 'dstr-card' },
					h('div', { className: 'dstr-card-title' }, '翻译默认值'),
					field(
						'目标语言',
						h(
							'select',
							{
								className: 'dstr-select',
								value: store.settings.targetLanguage,
								onChange: function (event) {
									setSettings({ targetLanguage: event.target.value });
								}
							},
							LANGS.map(function (lang) {
								return h('option', { key: lang.id, value: lang.id }, lang.label);
							})
						),
						'「自动」= 中文输入译成英文，其他语言译成简体中文'
					),
					field(
						'语气',
						h(
							'select',
							{
								className: 'dstr-select',
								value: store.settings.tone,
								onChange: function (event) {
									setSettings({ tone: event.target.value });
								}
							},
							TONES.map(function (tone) {
								return h('option', { key: tone.id, value: tone.id }, tone.label);
							})
						)
					),
					field(
						'术语表（每行 原文=译文）',
						h('textarea', {
							className: 'dstr-textarea',
							rows: 3,
							value: store.settings.glossary,
							placeholder: 'token=令符\ncapsule=胶囊',
							onChange: function (event) {
								setSettings({ glossary: event.target.value });
							}
						}),
						'只随请求下发，不写入任何会话'
					)
				),
				h(
					'div',
					{ className: 'dstr-card' },
					h('div', { className: 'dstr-card-title' }, '模型'),
					field(
						'模型',
						h(
							'select',
							{
								className: 'dstr-select',
								value: modelValue,
								onChange: function (event) {
									setSettings({ model: event.target.value });
									refreshStatus();
								}
							},
							modelOptions.length === 0 ? h('option', { value: '' }, '（未发现模型）') : null,
							modelOptions.map(function (name) {
								return h('option', { key: name, value: name }, name);
							})
						)
					),
					field(
						'生成后驻留',
						h(
							'select',
							{
								className: 'dstr-select',
								value: store.settings.keepAlive,
								onChange: function (event) {
									setSettings({ keepAlive: event.target.value });
								}
							},
							KEEP_ALIVE.map(function (item) {
								return h('option', { key: item.id, value: item.id }, item.label);
							})
						),
						'空闲卸载时长由插件配置 idleUnloadMs 决定（默认 90 秒）'
					),
					h(
						'div',
						{ className: 'dstr-row' },
						status && status.loaded
							? h('button', { type: 'button', className: 'dstr-btn', onClick: unloadModel }, '立即卸载模型')
							: h('button', { type: 'button', className: 'dstr-btn', onClick: loadModel }, '加载并钉住模型')
					)
				),
				h(
					'div',
					{ className: 'dstr-card' },
					h('div', { className: 'dstr-card-title' }, '服务状态'),
					h(
						'dl',
						{ className: 'dstr-kv' },
						h('dt', null, '端点'),
						h('dd', null, (status && status.baseURL) || '—'),
						h('dt', null, '模型'),
						h('dd', null, (status && status.model) || '—'),
						h('dt', null, '已安装'),
						h('dd', null, status ? (status.installed ? '是' : '否') : '—'),
						h('dt', null, '已加载'),
						h('dd', null, status ? (status.loaded ? '是' : '否') : '—'),
						h('dt', null, '钉住'),
						h('dd', null, status ? (status.pinned ? '是（空闲不卸载）' : '否') : '—'),
						h('dt', null, '格式'),
						h(
							'dd',
							null,
							status && status.formats
								? status.formats.office.join(' / ') + ' / ' + status.formats.text.slice(0, 8).join(' / ') + ' …'
								: '—'
						)
					),
					s.statusError ? h('div', { className: 'dstr-error' }, s.statusError) : null,
					h(
						'div',
						{ className: 'dstr-hint' },
						'翻译请求只发往本机 Ollama；每次请求都是独立的 system+user 两条消息，不复用历史、不写会话。'
					)
				)
			);
		}

		/* ═══════════════════════════ 浮层兜底 ═══════════════════════════ */

		function OverlayWorkbench() {
			var s = useStore();
			if (!s.overlayOpen) return null;
			return h(
				'div',
				{
					className: 'dstr-root dstr-veil',
					'data-dstr-ui': '1',
					onMouseDown: function (event) {
						if (event.target === event.currentTarget) patch({ overlayOpen: false });
					}
				},
				h(
					'div',
					{ className: 'dstr-sheet' },
					h(
						'div',
						{ style: { display: 'flex', justifyContent: 'flex-end', padding: '6px 8px 0' } },
						h(
							'button',
							{
								type: 'button',
								className: 'dstr-icon-btn',
								title: '关闭',
								onClick: function () {
									patch({ overlayOpen: false });
								}
							},
							'×'
						)
					),
					h(Workbench, null)
				)
			);
		}

		/* ═══════════════════════════ 插件入口 ═══════════════════════════ */

		function apply(ctx) {
			services.ctx = ctx;
			services.layout = safe(function () {
				return typeof ctx.get === 'function' ? ctx.get('layout') : undefined;
			}, null);

			ctx.slots.inject('sidebar.panellist', function () {
				return ctx.slots.register(
					{
						name: 'sidebar.panellist',
						id: 'translate',
						order: 20,
						label: function () {
							return '翻译';
						}
					},
					function TranslateIcon(props) {
						var size = (props && props.size) || 20;
						var active = props && props.active;
						return h(
							'span',
							{
								style: {
									display: 'flex',
									color: active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)'
								}
							},
							h(Mark, { size: size })
						);
					}
				);
			});

			ctx.slots.inject('main', function () {
				return ctx.slots.register({ name: 'main', key: 'translate' }, Workbench);
			});

			ctx.slots.inject('shell.overlay', function () {
				return ctx.slots.register({ name: 'shell.overlay', id: 'translate-dock', order: 200 }, Dock);
			});

			ctx.slots.inject('shell.overlay', function () {
				return ctx.slots.register({ name: 'shell.overlay', id: 'translate-selection', order: 190 }, function SelectionLayer() {
					return h('div', { 'data-dstr-ui': '1' }, h(Styles, null), h(ExternalBridge, null), h(SelectionBridge, null), h(SelectionPopover, null), h(OverlayWorkbench, null));
				});
			});
		}

		var module = { exports: {} };
		module.exports.inject = ['slots'];
		module.exports.apply = apply;
		// 仅供离线自检（Loader 只读 apply/inject，未知导出无副作用）。
		module.exports.__selftest = {
			CSS: CSS,
			store: store,
			patch: patch,
			setSettings: setSettings,
			apiUrl: apiUrl,
			toBase64: toBase64,
			readSettings: readSettings,
			components: {
				Dock: Dock,
				ContextMenu: ContextMenu,
				Workbench: Workbench,
				TextTab: TextTab,
				FileTab: FileTab,
				SettingsTab: SettingsTab,
				SelectionPopover: SelectionPopover,
				SelectionBridge: SelectionBridge,
				OverlayWorkbench: OverlayWorkbench,
				Mark: Mark
			}
		};
		return module.exports;
	}
});
