import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRuntimeStub } from './helpers/client-runtime.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

let JSDOM
let React
let createRoot
try {
  ({ JSDOM } = await import('jsdom'))
  React = await import('react')
  ;({ createRoot } = await import('react-dom/client'))
} catch (error) {
  console.log(`CLIENT DRAG SKIP: jsdom/react-dom are not installed in the plugin workspace (${error.code ?? error.message}). This does not validate real-DOM drag behavior.`)
  process.exit(0)
}

const globalNames = [
  'window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'PointerEvent',
  'MouseEvent', 'getComputedStyle', 'localStorage', 'IS_REACT_ACT_ENVIRONMENT',
]
const previousGlobals = Object.fromEntries(globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
const dom = new JSDOM('<!doctype html><html><head></head><body><div id="app"></div></body></html>', {
  url: 'http://127.0.0.1/',
})
const browserWindow = dom.window
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'PointerEvent', 'MouseEvent', 'getComputedStyle', 'localStorage']) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value: name === 'window' ? browserWindow : browserWindow[name],
  })
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true })
Object.defineProperty(browserWindow, 'innerWidth', { configurable: true, writable: true, value: 800 })
Object.defineProperty(browserWindow, 'innerHeight', { configurable: true, writable: true, value: 600 })

const windowListeners = new Map()
const nativeAddEventListener = browserWindow.addEventListener.bind(browserWindow)
const nativeRemoveEventListener = browserWindow.removeEventListener.bind(browserWindow)
browserWindow.addEventListener = (type, listener, options) => {
  const listeners = windowListeners.get(type) ?? new Set()
  listeners.add(listener)
  windowListeners.set(type, listeners)
  nativeAddEventListener(type, listener, options)
}
browserWindow.removeEventListener = (type, listener, options) => {
  windowListeners.get(type)?.delete(listener)
  nativeRemoveEventListener(type, listener, options)
}

const captures = new WeakMap()
browserWindow.HTMLElement.prototype.setPointerCapture = function setPointerCapture(pointerId) {
  const active = captures.get(this) ?? new Set()
  active.add(pointerId)
  captures.set(this, active)
}
browserWindow.HTMLElement.prototype.hasPointerCapture = function hasPointerCapture(pointerId) {
  return captures.get(this)?.has(pointerId) ?? false
}
browserWindow.HTMLElement.prototype.releasePointerCapture = function releasePointerCapture(pointerId) {
  captures.get(this)?.delete(pointerId)
}

// jsdom does not ship PointerEvent; the plugin only reads pointerId,
// pointerType, and MouseEvent geometry, so a MouseEvent subclass suffices.
if (typeof browserWindow.PointerEvent !== 'function') {
  browserWindow.PointerEvent = class PointerEvent extends browserWindow.MouseEvent {
    constructor(type, init = {}) {
      super(type, init)
      this.pointerId = init.pointerId ?? 1
      this.pointerType = init.pointerType ?? ''
    }
  }
}

// Import the real bundle in this context (like the browser page does) so the
// plugin components' free `window`/`document` references resolve to the JSDOM
// globals installed above; real react-dom then runs their effects for real.
let handoff = null
browserWindow.__ModuleLoader__ = { load(value) { handoff = value } }
await import(pathToFileURL(join(root, 'lib', 'client.js')).href + '?drag=' + Date.now())
assert.notEqual(handoff, null, 'client bundle registers with the real module loader handoff')
const plugin = handoff.factory((specifier) => {
  if (specifier === 'react') return React
  if (specifier === '@deepseek-ai/dsh-client-store') return createRuntimeStub()
  throw new Error(`unexpected client dependency: ${specifier}`)
})

function pointer(type, pointerId, pointerType, clientX, clientY, init = {}) {
  return new browserWindow.PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId,
    pointerType,
    clientX,
    clientY,
    button: type === 'pointerdown' ? 0 : -1,
    buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
    ...init,
  })
}

async function dispatch(target, event) {
  await React.act(async () => {
    target.dispatchEvent(event)
    await Promise.resolve()
  })
}

async function click(target) {
  await React.act(async () => {
    target.dispatchEvent(new browserWindow.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
    await Promise.resolve()
  })
}

// A DOM slot harness: same registration semantics as client-runtime.mjs, but
// hook channels become real useSyncExternalStore subscriptions and
// registrations return React elements for react-dom rendering. Slot
// injections route through the caller's effect context so disposal unmounts
// the registered contributions.
function createDomSlotHarness(currentContext) {
  const registrations = new Map()
  const hookSources = []
  const slots = {
    inject(name, provider) {
      return currentContext().effect(provider)
    },
    register(meta, component) {
      const instance = typeof meta.store === 'function' ? meta.store().create() : meta.store?.create()
      const injectedFace = typeof meta.inject === 'function'
        ? meta.inject(...(instance === undefined ? [] : [instance.actions]))
        : {}
      const injected = { ...injectedFace }
      for (const [name, source] of Object.entries(injectedFace.hooks ?? {})) {
        const hookName = `use${name[0].toUpperCase()}${name.slice(1)}`
        injected[hookName] = (selector) => React.useSyncExternalStore(
          (listener) => source.subscribe(listener),
          () => selector(source.getSnapshot()),
        )
        hookSources.push(source)
      }
      delete injected.hooks
      const props = {
        ...injected,
        ...(instance === undefined ? {} : {
          useStore: (selector) => selector(instance.getSnapshot()),
          actions: instance.actions,
        }),
      }
      const element = (owner = {}) => React.createElement(component, { ...owner, ...props })
      registrations.set(meta.name, element)
      return () => { registrations.delete(meta.name) }
    },
  }
  return { slots, registrations, hookSources }
}

function effectContext(base) {
  const disposers = []
  const ctx = {
    ...base,
    effect(execute) {
      const dispose = execute()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {
        const index = disposers.indexOf(dispose)
        if (index !== -1) disposers.splice(index, 1)
        if (typeof dispose === 'function') dispose()
      }
    },
    dispose() {
      for (const dispose of disposers.splice(0).reverse()) dispose()
    },
  }
  return ctx
}

const ctxHolder = { current: undefined }
const harness = createDomSlotHarness(() => ctxHolder.current)
const ComposerElement = () => harness.registrations.get('conversation.input.left')({})
const PanelElement = () => harness.registrations.get('shell.overlay')()

let reactRoot
let ctx
try {
  ctx = effectContext({
    slots: harness.slots,
    uiSession: { adapter: { current: { getSnapshot: () => ({ key: undefined }) } } },
    conversation: { input: { shell() { throw new Error('not used') } } },
  })
  ctxHolder.current = ctx
  plugin.apply(ctx)
  assert.equal(harness.registrations.size, 3, 'apply registers the three client slots')
  const container = browserWindow.document.getElementById('app')
  const App = () => React.createElement(React.Fragment, null,
    harness.registrations.has('conversation.input.left') ? ComposerElement() : null,
    harness.registrations.has('shell.overlay') ? PanelElement() : null,
  )
  reactRoot = createRoot(container)
  await React.act(async () => {
    reactRoot.render(React.createElement(App))
    await Promise.resolve()
  })

  const composer = () => browserWindow.document.querySelector('.dr-composer-btn')
  const panel = () => browserWindow.document.querySelector('.dr-panel')
  const header = () => browserWindow.document.querySelector('.dr-panel-head')
  const close = () => browserWindow.document.querySelector('.dr-close')
  await click(composer())
  assert.ok(panel(), 'real react-dom mounts the plugin panel into a real DOM')

  let panelWidth = 420
  const panelHeight = 500
  const headerHeight = 32
  const defaultRect = { left: 364, top: 56 }
  const attachRects = () => {
    panel().getBoundingClientRect = () => {
      const left = panel().style.left === '' ? defaultRect.left : Number.parseFloat(panel().style.left)
      const top = panel().style.top === '' ? defaultRect.top : Number.parseFloat(panel().style.top)
      return { left, top, width: panelWidth, height: panelHeight, right: left + panelWidth, bottom: top + panelHeight, x: left, y: top, toJSON() {} }
    }
    header().getBoundingClientRect = () => {
      const rect = panel().getBoundingClientRect()
      return { left: rect.left, top: rect.top, width: panelWidth, height: headerHeight, right: rect.left + panelWidth, bottom: rect.top + headerHeight, x: rect.left, y: rect.top, toJSON() {} }
    }
  }
  attachRects()

  await dispatch(header(), pointer('pointerdown', 7, 'mouse', 400, 70))
  assert.equal(header().hasPointerCapture(7), true, 'pointerdown captures the real DOM pointer target')
  await dispatch(header(), pointer('pointermove', 7, 'mouse', 600, 120))
  assert.equal(panel().style.left, '380px', 'mouse drag changes observable DOM left and clamps the right edge')
  assert.equal(panel().style.top, '106px', 'mouse drag changes observable DOM top')
  await dispatch(header(), pointer('pointerup', 7, 'mouse', 600, 120))
  assert.equal(header().hasPointerCapture(7), false, 'pointerup releases capture')

  await dispatch(header(), pointer('pointerdown', 15, 'mouse', 400, 120))
  await dispatch(browserWindow, pointer('pointermove', 15, 'mouse', 200, 220))
  assert.equal(panel().style.left, '180px', 'captured drag keeps moving when the pointer leaves the title element')
  assert.equal(panel().style.top, '206px', 'window-level Pointer Events preserve the drag delta')
  await dispatch(browserWindow, pointer('pointerup', 15, 'mouse', 200, 220))
  assert.equal(header().hasPointerCapture(15), false, 'window pointerup releases title capture')

  await dispatch(header(), pointer('pointerdown', 8, 'touch', 400, 120))
  await dispatch(header(), pointer('pointermove', 8, 'touch', -1000, -1000))
  assert.equal(panel().style.left, '0px', 'touch shares the Pointer Events path and clamps left')
  assert.equal(panel().style.top, '0px', 'touch shares the Pointer Events path and clamps top')
  await dispatch(header(), pointer('pointercancel', 8, 'touch', -1000, -1000))
  assert.equal(header().hasPointerCapture(8), false, 'pointercancel releases capture')
  await dispatch(header(), pointer('pointermove', 8, 'touch', 700, 500))
  assert.equal(panel().style.cssText, 'left: 0px; top: 0px; right: auto;', 'cancelled pointers cannot move the DOM again')

  await dispatch(header(), pointer('pointerdown', 9, 'pen', 10, 10))
  await dispatch(header(), pointer('pointermove', 9, 'pen', 1000, 1000))
  assert.equal(panel().style.left, '380px', 'pen shares the path and clamps right')
  assert.equal(panel().style.top, '568px', 'pen shares the path and keeps the complete title bar visible')
  header().releasePointerCapture(9)
  await dispatch(header(), pointer('lostpointercapture', 9, 'pen', 1000, 1000))
  await dispatch(header(), pointer('pointermove', 9, 'pen', 20, 20))
  assert.equal(panel().style.top, '568px', 'lost capture ends the drag')

  const positionBeforeClose = panel().style.cssText
  await dispatch(close(), pointer('pointerdown', 10, 'mouse', 760, 580))
  assert.equal(header().hasPointerCapture(10), false, 'interactive title descendants do not start drag')
  assert.equal(panel().style.cssText, positionBeforeClose, 'close pointerdown causes zero position change')
  assert.ok(panel().onpointerdown == null, 'content panel does not own a pointerdown handler')
  assert.ok(browserWindow.document.querySelector('.dr-input').onpointerdown == null, 'inputs do not own the title drag handler')

  assert.equal(windowListeners.get('resize')?.size, 1, 'one component resize listener is mounted')
  browserWindow.innerWidth = 300
  browserWindow.innerHeight = 200
  panelWidth = 268
  await React.act(async () => {
    browserWindow.dispatchEvent(new browserWindow.Event('resize'))
    await Promise.resolve()
  })
  assert.equal(panel().style.left, '32px', 'resize clamps the panel horizontally')
  assert.equal(panel().style.top, '168px', 'resize leaves the complete title bar visible')

  await dispatch(header(), pointer('pointerdown', 12, 'mouse', 50, 180))
  browserWindow.innerWidth = 800
  browserWindow.innerHeight = 600
  panelWidth = 420
  await React.act(async () => {
    browserWindow.dispatchEvent(new browserWindow.Event('resize'))
    await Promise.resolve()
  })
  await dispatch(header(), pointer('pointermove', 12, 'mouse', 2000, 180))
  assert.equal(panel().style.left, '380px', 'an active drag re-reads current geometry after resize')
  await dispatch(header(), pointer('pointerup', 12, 'mouse', 2000, 180))

  const retainedPosition = panel().style.cssText
  await click(close())
  assert.equal(panel(), null, 'close hides the panel')
  assert.equal(windowListeners.get('resize')?.size ?? 0, 0, 'close removes the resize listener')
  await click(composer())
  assert.equal(panel().style.cssText, retainedPosition, 'close/reopen retains position for this apply lifecycle')
  assert.equal(windowListeners.get('resize')?.size, 1, 'reopen installs one resize listener')

  attachRects()
  await dispatch(header(), pointer('pointerdown', 13, 'mouse', 400, 180))
  const externallyClosedHeader = header()
  assert.equal(externallyClosedHeader.hasPointerCapture(13), true, 'external-close coverage begins with active capture')
  await click(composer())
  assert.equal(panel(), null, 'composer can close the panel during drag')
  assert.equal(externallyClosedHeader.hasPointerCapture(13), false, 'close during drag releases capture')
  await click(composer())
  assert.equal(panel().style.cssText, retainedPosition, 'reopen after interrupted drag keeps apply-scope position')

  await React.act(async () => { reactRoot.unmount(); await Promise.resolve() })
  assert.equal(windowListeners.get('resize')?.size ?? 0, 0, 'DOM unmount removes the resize listener')
  reactRoot = createRoot(container)
  await React.act(async () => {
    reactRoot.render(React.createElement(App))
    await Promise.resolve()
  })
  assert.equal(panel().style.cssText, retainedPosition, 'same-apply DOM remount retains position')
  assert.equal(windowListeners.get('resize')?.size, 1, 'same-apply remount installs one resize listener')

  panel().getBoundingClientRect = () => ({ left: 380, top: 168, width: panelWidth, height: panelHeight, right: 800, bottom: 668, x: 380, y: 168, toJSON() {} })
  header().getBoundingClientRect = () => ({ left: 380, top: 168, width: panelWidth, height: headerHeight, right: 800, bottom: 200, x: 380, y: 168, toJSON() {} })
  await dispatch(header(), pointer('pointerdown', 14, 'mouse', 400, 180))
  assert.equal(header().hasPointerCapture(14), true, 'dispose coverage begins with active capture')
  const capturedHeader = header()
  await React.act(async () => {
    ctx.dispose()
    reactRoot.render(React.createElement(App))
    await Promise.resolve()
  })
  assert.equal(capturedHeader.hasPointerCapture(14), false, 'plugin disposal releases active capture')
  assert.equal(windowListeners.get('resize')?.size ?? 0, 0, 'plugin disposal removes the window listener')
  assert.equal(browserWindow.document.querySelectorAll('style[data-plugin="dsh-deepread"]').length, 0, 'plugin disposal removes styles')
  assert.equal(harness.registrations.size, 0, 'plugin disposal removes the slot contributions')
  assert.equal(browserWindow.localStorage.length, 0, 'drag position is never persisted')

  ctx = effectContext({
    slots: harness.slots,
    uiSession: { adapter: { current: { getSnapshot: () => ({ key: undefined }) } } },
    conversation: { input: { shell() { throw new Error('not used') } } },
  })
  ctxHolder.current = ctx
  plugin.apply(ctx)
  await React.act(async () => {
    reactRoot.render(React.createElement(App))
    await Promise.resolve()
  })
  await click(composer())
  assert.equal(panel().style.cssText, '', 'a fresh apply lifecycle starts at the CSS default position')

  const css = [...browserWindow.document.querySelectorAll('style[data-plugin="dsh-deepread"]')].map((node) => node.textContent).join('\n')
  assert.match(css, /touch-action:\s*none/, 'title handle disables touch panning only on itself')
  assert.match(css, /user-select:\s*none/, 'title handle suppresses selection only on itself')
  assert.match(css, /cursor:\s*grabbing/, 'dragging has immediate cursor feedback')
  assert.doesNotMatch(css, /\.dr-panel(?:-dragging)?[^}]*\b(?:animation|transition)\s*:/, 'drag feedback has no motion to gate for reduced motion')
} finally {
  if (ctx !== undefined) ctx.dispose()
  if (reactRoot !== undefined) await React.act(async () => { reactRoot.unmount() })
  dom.window.close()
  for (const [name, descriptor] of Object.entries(previousGlobals)) {
    if (descriptor === undefined) delete globalThis[name]
    else Object.defineProperty(globalThis, name, descriptor)
  }
}

console.log('CLIENT DRAG: real DOM PointerEvents pass through the plugin components with real react-dom')
