// =====================================================================
// Utilidades de interfaz: pantallas, pestañas, hojas, diálogos, avisos
// y animaciones. Sin dependencias externas.
// =====================================================================

export const $ = (sel, root = document) => root.querySelector(sel)
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]

const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
// En computadora las hojas se muestran como ventana centrada en lugar de subir desde abajo
const anchoQuery = window.matchMedia('(min-width: 1024px)')
export const esAncho = () => anchoQuery.matches
const reduced = () => motionQuery.matches
const dur = ms => (reduced() ? 1 : ms)

const EASE = 'cubic-bezier(0.25, 1, 0.5, 1)'
const EASE_SHEET = 'cubic-bezier(0.32, 0.72, 0, 1)'
const EASE_SPRING = 'cubic-bezier(0.34, 1.4, 0.64, 1)'

// --- TEXTO Y FORMATO ---
export function esc(valor) {
  return String(valor ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

export function icon(id, cls = '') {
  return `<svg class="icon ${cls}"><use href="#${id}"/></svg>`
}

export function initials(nombre) {
  const partes = String(nombre ?? '').trim().split(/\s+/).filter(Boolean)
  return ((partes[0]?.[0] ?? '') + (partes[1]?.[0] ?? '')).toUpperCase() || '?'
}

// Avatar con color estable a partir del nombre
export function avatar(nombre) {
  let h = 0
  for (const c of String(nombre ?? '')) h = (h * 31 + c.charCodeAt(0)) % 360
  return `<span class="avatar" style="--h:${h}" aria-hidden="true">${esc(initials(nombre))}</span>`
}

export function emptyState(iconId, titulo, texto) {
  return `<div class="empty"><span class="empty-icon">${icon(iconId)}</span><p class="empty-title">${esc(titulo)}</p><p class="empty-text">${esc(texto)}</p></div>`
}

export function skeletonRows(n = 3) {
  return Array.from({ length: n }, () =>
    `<div class="skeleton-row"><span class="skeleton" style="width:40px;height:40px;border-radius:50%"></span><span style="flex:1;display:grid;gap:8px"><span class="skeleton" style="height:14px;width:60%"></span><span class="skeleton" style="height:12px;width:35%"></span></span></div>`
  ).join('')
}

export function haptic(patron = 10) {
  // El navegador solo permite vibrar después de que el usuario tocó la página
  if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return
  try { navigator.vibrate?.(patron) } catch { /* sin vibración */ }
}

// --- PANTALLAS ---
let currentScreen = null
let transicionId = 0

export function initScreens() {
  $$('.screen').forEach(screen => {
    $$('.scroll', screen).forEach(sc => sc.addEventListener('scroll', () => syncNav(screen), { passive: true }))
  })
}

// Barra superior: vidrio al hacer scroll y título pequeño al pasar el título grande
function syncNav(screen) {
  const nav = $('.nav', screen)
  if (!nav) return
  const sc = $('.scroll.is-active', screen) || $('.scroll', screen)
  const y = sc ? sc.scrollTop : 0
  nav.classList.toggle('is-scrolled', y > 4)
  nav.classList.toggle('is-condensed', y > 56)
}

export function replayReveal(root) {
  $$('[data-reveal]', root).forEach(el => {
    el.classList.remove('revealed')
    void el.offsetWidth
    el.classList.add('revealed')
  })
}

// transition: 'push' (avanzar), 'pop' (regresar) o 'fade'
export function showScreen(id, transition = 'fade') {
  const next = document.getElementById(id)
  const prev = currentScreen
  if (!next || prev === next) return Promise.resolve()

  currentScreen = next
  // Cancela cualquier transición anterior. No se usa finish(): sobre una animación
  // ya cancelada la revive en su último cuadro y deja la pantalla desplazada.
  $$('.screen').forEach(s => s.getAnimations().forEach(an => an.cancel()))

  next.classList.add('is-active')
  document.dispatchEvent(new CustomEvent('screenchange', { detail: { id } }))
  $$('.scroll', next).forEach(sc => { sc.scrollTop = 0 })
  syncNav(next)
  if (transition !== 'pop') replayReveal(next)
  if (!prev) return Promise.resolve()

  const frames = {
    push: [
      [{ transform: 'translateX(100%)' }, { transform: 'translateX(0)' }],
      [{ transform: 'translateX(0)', opacity: 1 }, { transform: 'translateX(-30%)', opacity: 0.6 }]
    ],
    pop: [
      [{ transform: 'translateX(-30%)', opacity: 0.6 }, { transform: 'translateX(0)', opacity: 1 }],
      [{ transform: 'translateX(0)' }, { transform: 'translateX(100%)' }]
    ],
    fade: [
      [{ opacity: 0, transform: 'scale(0.97)' }, { opacity: 1, transform: 'scale(1)' }],
      [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(1.03)' }]
    ]
  }[transition]

  const turno = ++transicionId
  $$('.screen').forEach(s => { s.style.zIndex = '' })
  const encima = transition === 'pop' ? prev : next
  encima.style.zIndex = 2
  const opts = { duration: dur(transition === 'fade' ? 480 : 540), easing: transition === 'fade' ? EASE : EASE_SHEET }
  const a = next.animate(frames[0], opts)
  const b = prev.animate(frames[1], { ...opts, fill: 'forwards' })

  return Promise.all([a.finished, b.finished]).catch(() => {}).then(() => {
    b.cancel()
    if (prev !== currentScreen) prev.classList.remove('is-active')
    // Una transición más reciente ya acomodó las capas
    if (turno !== transicionId) return
    prev.style.zIndex = ''
    next.style.zIndex = ''
  })
}

// --- PESTAÑAS (tab bar flotante) ---
export function initTabs(screen) {
  $$('.tabbar .tab', screen).forEach(tab => tab.addEventListener('click', () => {
    haptic(6)
    selectTab(screen, tab.dataset.tab)
  }))
}

export function selectTab(screen, panelId, { animate = true } = {}) {
  const bar = $('.tabbar', screen)
  const tabs = $$('.tab', bar)
  const idx = tabs.findIndex(t => t.dataset.tab === panelId)
  const next = document.getElementById(panelId)
  const prev = $('.tab-panel.is-active', screen)
  if (!next || idx < 0) return

  bar.style.setProperty('--i', idx)
  tabs.forEach((t, i) => {
    t.classList.toggle('is-active', i === idx)
    t.setAttribute('aria-selected', String(i === idx))
  })

  // Tocar la pestaña activa regresa al inicio, como en iOS
  if (prev === next) {
    next.scrollTo({ top: 0, behavior: reduced() ? 'auto' : 'smooth' })
    return
  }

  prev?.classList.remove('is-active')
  next.classList.add('is-active')
  const title = $('.nav-title', screen)
  if (title) title.textContent = next.dataset.title || ''
  syncNav(screen)
  replayReveal(next)
  if (animate) next.animate([{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: dur(380), easing: EASE })
  screen.dispatchEvent(new CustomEvent('tabchange', { detail: panelId }))
}

// --- CONTROL SEGMENTADO ---
export function initSegmented(el, onChange) {
  const btns = $$('button', el)
  const select = (value, emit = true) => {
    const idx = Math.max(0, btns.findIndex(b => b.dataset.value === value))
    el.style.setProperty('--i', idx)
    el.dataset.value = btns[idx].dataset.value
    btns.forEach((b, i) => b.setAttribute('aria-selected', String(i === idx)))
    if (emit) onChange?.(el.dataset.value)
  }
  el.setAttribute('role', 'tablist')
  btns.forEach(b => {
    b.setAttribute('role', 'tab')
    b.addEventListener('click', () => {
      if (el.dataset.value === b.dataset.value) return
      haptic(5)
      select(b.dataset.value)
    })
  })
  select(el.dataset.value || btns[0].dataset.value, false)
  return { select, get value() { return el.dataset.value } }
}

// --- HOJAS (bottom sheets) con arrastre para cerrar ---
const openSheets = []

export function initSheets() {
  $$('.sheet').forEach(sheet => {
    $$('[data-close]', sheet).forEach(b => b.addEventListener('click', () => closeSheet(sheet)))
    enableDrag(sheet)
  })
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || document.querySelector('.dialog')) return
    const top = openSheets[openSheets.length - 1]
    if (top) closeSheet(top)
  })
}

export function openSheet(id, { onClose } = {}) {
  const sheet = typeof id === 'string' ? document.getElementById(id) : id
  if (!sheet || sheet.classList.contains('is-open')) return Promise.resolve()
  const panel = $('.sheet-panel', sheet)
  const backdrop = $('.sheet-backdrop', sheet)
  sheet._onClose = onClose
  sheet._returnFocus = document.activeElement
  sheet.classList.add('is-open')
  openSheets.push(sheet)

  backdrop.animate([{ opacity: 0 }, { opacity: 1 }], { duration: dur(320), easing: 'linear' })
  const anim = esAncho()
    ? panel.animate([{ opacity: 0, transform: 'translateY(18px) scale(0.97)' }, { opacity: 1, transform: 'none' }], { duration: dur(420), easing: EASE })
    : panel.animate([{ transform: 'translateY(110%)' }, { transform: 'translateY(0)' }], { duration: dur(560), easing: EASE_SHEET })
  setTimeout(() => panel.focus({ preventScroll: true }), 60)
  return anim.finished.catch(() => {})
}

export async function closeSheet(id, { force = false } = {}) {
  const sheet = typeof id === 'string' ? document.getElementById(id) : id
  if (!sheet?.classList.contains('is-open') || sheet._closing) return
  // Una hoja bloqueada (p. ej. cambio de contraseña obligatorio) solo se cierra por código
  if (sheet.dataset.locked && !force) return
  sheet._closing = true
  const panel = $('.sheet-panel', sheet)
  const backdrop = $('.sheet-backdrop', sheet)
  const desde = panel.style.transform || 'translateY(0)'
  const opBackdrop = backdrop.style.opacity || 1

  const a = backdrop.animate([{ opacity: opBackdrop }, { opacity: 0 }], { duration: dur(280), fill: 'forwards' })
  const b = esAncho()
    ? panel.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(10px) scale(0.98)' }], { duration: dur(240), easing: EASE, fill: 'forwards' })
    : panel.animate([{ transform: desde }, { transform: 'translateY(110%)' }], { duration: dur(400), easing: EASE_SHEET, fill: 'forwards' })
  await Promise.all([a.finished, b.finished]).catch(() => {})

  sheet.classList.remove('is-open')
  a.cancel()
  b.cancel()
  panel.style.transform = ''
  backdrop.style.opacity = ''
  sheet._closing = false
  openSheets.splice(openSheets.indexOf(sheet), 1)
  sheet._onClose?.()
  sheet._returnFocus?.focus?.({ preventScroll: true })
}

export function closeAllSheets() {
  return Promise.all([...openSheets].map(s => closeSheet(s)))
}

function enableDrag(sheet) {
  const handle = $('.sheet-drag', sheet)
  const panel = $('.sheet-panel', sheet)
  const backdrop = $('.sheet-backdrop', sheet)
  if (!handle) return
  let startY = 0
  let lastY = 0
  let lastT = 0
  let velocidad = 0
  let arrastrando = false

  handle.addEventListener('pointerdown', e => {
    if (e.target.closest('button, input, a') || sheet.dataset.locked || esAncho()) return
    arrastrando = true
    startY = lastY = e.clientY
    lastT = performance.now()
    velocidad = 0
    panel.getAnimations().forEach(a => a.finish())
    handle.setPointerCapture(e.pointerId)
  })

  handle.addEventListener('pointermove', e => {
    if (!arrastrando) return
    const dy = e.clientY - startY
    const ahora = performance.now()
    velocidad = (e.clientY - lastY) / Math.max(1, ahora - lastT)
    lastY = e.clientY
    lastT = ahora
    // Resistencia elástica al jalar hacia arriba
    const y = dy > 0 ? dy : -Math.sqrt(-dy) * 2
    panel.style.transform = `translateY(${y}px)`
    backdrop.style.opacity = String(Math.max(0.2, 1 - Math.max(0, dy) / panel.offsetHeight))
  })

  const soltar = e => {
    if (!arrastrando) return
    arrastrando = false
    const dy = e.clientY - startY
    if (dy > 110 || velocidad > 0.55) {
      closeSheet(sheet)
      return
    }
    const desde = panel.style.transform
    panel.style.transform = ''
    backdrop.style.opacity = ''
    if (desde) panel.animate([{ transform: desde }, { transform: 'translateY(0)' }], { duration: dur(450), easing: EASE_SPRING })
  }
  handle.addEventListener('pointerup', soltar)
  handle.addEventListener('pointercancel', soltar)
}

// --- DIÁLOGOS (alerta, confirmación y hoja de acciones) ---
function dialog({ title, message = '', actions, variant = 'alert', cancelValue = null }) {
  return new Promise(resolve => {
    const root = document.createElement('div')
    root.className = 'dialog'
    root.dataset.variant = variant
    const tituloId = `dlg-${Date.now()}`

    if (variant === 'sheet') {
      const principales = actions.filter(a => a.style !== 'cancel')
      const cancelar = actions.find(a => a.style === 'cancel')
      root.innerHTML = `
        <div class="dialog-backdrop"></div>
        <div class="dialog-panel" role="dialog" aria-modal="true" aria-labelledby="${tituloId}" tabindex="-1">
          <div class="action-group">
            ${title ? `<div class="action-head"><p class="dialog-title" id="${tituloId}">${esc(title)}</p>${message ? `<p class="dialog-message">${esc(message)}</p>` : ''}</div>` : ''}
            ${principales.map((a, i) => `<button class="action-item${a.style === 'destructive' ? ' is-destructive' : ''}" data-i="${actions.indexOf(a)}">${esc(a.label)}</button>`).join('')}
          </div>
          ${cancelar ? `<button class="action-group action-item action-cancel" data-i="${actions.indexOf(cancelar)}">${esc(cancelar.label)}</button>` : ''}
        </div>`
    } else {
      root.innerHTML = `
        <div class="dialog-backdrop"></div>
        <div class="dialog-panel" role="alertdialog" aria-modal="true" aria-labelledby="${tituloId}" tabindex="-1">
          <h2 class="dialog-title" id="${tituloId}">${esc(title)}</h2>
          ${message ? `<p class="dialog-message">${esc(message)}</p>` : ''}
          <div class="dialog-actions">
            ${actions.map((a, i) => {
              const cls = a.style === 'destructive' ? 'btn-danger' : a.style === 'cancel' ? 'btn-secondary' : 'btn-primary'
              return `<button class="btn ${cls}" data-i="${i}">${esc(a.label)}</button>`
            }).join('')}
          </div>
        </div>`
    }

    const regreso = document.activeElement
    document.body.appendChild(root)
    const panel = $('.dialog-panel', root)
    const backdrop = $('.dialog-backdrop', root)

    backdrop.animate([{ opacity: 0 }, { opacity: 1 }], { duration: dur(240) })
    if (variant === 'sheet' && !esAncho()) {
      panel.animate([{ transform: 'translateY(110%)' }, { transform: 'none' }], { duration: dur(520), easing: EASE_SHEET })
    } else {
      panel.animate([{ opacity: 0, transform: 'scale(1.14)' }, { opacity: 1, transform: 'scale(1)' }], { duration: dur(420), easing: EASE_SPRING })
    }

    const btnCancel = $$('button', root).find(b => actions[b.dataset.i]?.style === 'cancel')
    const btnFoco = btnCancel || $('button', root)
    setTimeout(() => btnFoco?.focus({ preventScroll: true }), 30)

    const cerrar = async valor => {
      document.removeEventListener('keydown', onKey)
      root.style.pointerEvents = 'none'
      const salida = variant === 'sheet' && !esAncho()
        ? panel.animate([{ transform: 'none' }, { transform: 'translateY(110%)' }], { duration: dur(320), easing: EASE_SHEET, fill: 'forwards' })
        : panel.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(0.94)' }], { duration: dur(200), easing: EASE, fill: 'forwards' })
      backdrop.animate([{ opacity: 1 }, { opacity: 0 }], { duration: dur(220), fill: 'forwards' })
      resolve(valor)
      await salida.finished.catch(() => {})
      root.remove()
      regreso?.focus?.({ preventScroll: true })
    }

    const onKey = e => { if (e.key === 'Escape') cerrar(cancelValue) }
    document.addEventListener('keydown', onKey)
    root.addEventListener('click', e => {
      const btn = e.target.closest('button[data-i]')
      if (btn) {
        haptic(6)
        cerrar(actions[btn.dataset.i].value)
      } else if (variant === 'sheet' && e.target === backdrop) {
        cerrar(cancelValue)
      }
    })
  })
}

export function confirm({ title, message, confirmLabel = 'Aceptar', cancelLabel = 'Cancelar', destructive = false }) {
  return dialog({
    title,
    message,
    cancelValue: false,
    actions: [
      { label: cancelLabel, value: false, style: 'cancel' },
      { label: confirmLabel, value: true, style: destructive ? 'destructive' : 'default' }
    ]
  })
}

export function alert({ title, message, label = 'Entendido' }) {
  return dialog({ title, message, cancelValue: true, actions: [{ label, value: true, style: 'default' }] })
}

export function actionSheet({ title, message, actions }) {
  return dialog({ title, message, variant: 'sheet', cancelValue: null, actions: [...actions, { label: 'Cancelar', value: null, style: 'cancel' }] })
}

// --- AVISO FLOTANTE (estilo Dynamic Island) ---
let islandTimer = null

export function toast(mensaje, { type = 'info', duration = 2800 } = {}) {
  const island = $('#island')
  if (!island) return
  const iconos = { success: 'i-check-circle', error: 'i-x-circle', warning: 'i-alert', info: 'i-info' }
  clearTimeout(islandTimer)
  island.dataset.type = type
  island.innerHTML = `${icon(iconos[type] || iconos.info)}<span>${esc(mensaje)}</span>`
  island.classList.remove('is-visible')
  void island.offsetWidth
  island.classList.add('is-visible')
  islandTimer = setTimeout(() => island.classList.remove('is-visible'), duration)
}

// --- MICROINTERACCIONES ---
export function setLoading(btn, cargando) {
  if (!btn) return
  btn.classList.toggle('is-loading', cargando)
  btn.disabled = cargando
  btn.setAttribute('aria-busy', String(cargando))
}

export function shake(el) {
  if (!el) return
  haptic([18, 40, 18])
  el.animate(
    [{ transform: 'translateX(0)' }, { transform: 'translateX(-10px)' }, { transform: 'translateX(9px)' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(4px)' }, { transform: 'translateX(0)' }],
    { duration: dur(460), easing: 'ease-out' }
  )
}

export function collapse(el, colapsado) {
  if (!el) return
  el.classList.toggle('is-collapsed', colapsado)
  el.inert = colapsado
}

const formatos = {}
function formato(decimales) {
  formatos[decimales] ??= new Intl.NumberFormat('es-MX', { minimumFractionDigits: decimales, maximumFractionDigits: decimales })
  return formatos[decimales]
}

// Cuenta animada desde el valor actual hasta el nuevo
export function animateNumber(el, hasta, { decimals = 0, duration = 1100 } = {}) {
  if (!el) return
  const desde = Number(el.dataset.value ?? 0)
  const fmt = formato(decimals)
  el.dataset.value = String(hasta)
  cancelAnimationFrame(el._raf)
  if (reduced() || desde === hasta) {
    el.textContent = fmt.format(hasta)
    return
  }
  const inicio = performance.now()
  const paso = ahora => {
    const t = Math.min(1, (ahora - inicio) / duration)
    const e = 1 - Math.pow(1 - t, 4)
    el.textContent = fmt.format(desde + (hasta - desde) * e)
    if (t < 1) el._raf = requestAnimationFrame(paso)
  }
  el._raf = requestAnimationFrame(paso)
}

// Dígitos que "caen" al cambiar (temporizadores)
export function setDigits(el, texto) {
  if (!el || el.dataset.text === texto) return
  const previo = el.dataset.text || ''
  el.dataset.text = texto
  el.setAttribute('aria-label', texto)
  if (previo.length !== texto.length) {
    el.innerHTML = [...texto].map(c => `<span class="digit" aria-hidden="true">${esc(c)}</span>`).join('')
    return
  }
  ;[...texto].forEach((c, i) => {
    if (previo[i] === c) return
    const span = el.children[i]
    span.textContent = c
    span.classList.remove('tick')
    void span.offsetWidth
    span.classList.add('tick')
  })
}

// Título que aparece palabra por palabra con desenfoque.
// data-accent="n" pinta la palabra n con el degradado de la marca.
export function revealWords(el) {
  if (!el) return
  const texto = el.dataset.text || el.textContent.trim()
  const acento = el.dataset.accent === undefined ? -1 : Number(el.dataset.accent)
  el.dataset.text = texto
  el.setAttribute('aria-label', texto)
  el.innerHTML = texto.split(' ').map((w, i) =>
    `<span class="word${i === acento ? ' word-accent' : ''}" aria-hidden="true" style="--w:${i}">${esc(w)}</span>`
  ).join(' ')
}

// --- LISTAS CON ENTRADA/SALIDA ANIMADA ---
// Conserva los elementos existentes por clave; anima solo los que entran o salen.
// Se crea en el documento principal: un <template> usa un documento inerte
// cuya línea de tiempo no avanza y dejaría congeladas las animaciones.
function toEl(html) {
  const caja = document.createElement('div')
  caja.innerHTML = html.trim()
  return caja.firstElementChild
}

function salir(el) {
  el.dataset.leaving = '1'
  const h = el.offsetHeight
  el.style.overflow = 'hidden'
  el.animate(
    [{ height: `${h}px`, opacity: 1 }, { height: '0px', opacity: 0, paddingTop: '0px', paddingBottom: '0px', marginTop: '0px', marginBottom: '0px' }],
    { duration: dur(340), easing: EASE }
  ).finished.then(() => el.remove(), () => el.remove())
}

export function patchList(container, items, { key, render, empty }) {
  if (!container) return
  $$(':scope > .skeleton-row', container).forEach(el => el.remove())
  const vivos = new Map()
  for (const el of container.children) {
    if (el.dataset.key && !el.dataset.leaving) vivos.set(el.dataset.key, el)
  }
  const deseados = new Set(items.map(it => String(key(it))))
  vivos.forEach((el, k) => { if (!deseados.has(k)) salir(el) })

  const vacio = $(':scope > .empty', container)
  if (!items.length) {
    if (!vacio && empty) {
      const el = toEl(empty)
      container.appendChild(el)
      el.animate([{ opacity: 0, transform: 'scale(0.96)' }, { opacity: 1, transform: 'none' }], { duration: dur(420), easing: EASE, delay: vivos.size ? 200 : 0, fill: 'backwards' })
    }
    return
  }
  vacio?.remove()

  let entrando = 0
  const ordenados = items.map((it, idx) => {
    const k = String(key(it))
    const html = render(it, idx).trim()
    let el = vivos.get(k)
    if (!el) {
      el = toEl(html)
      el.dataset.key = k
      el._html = html
      el.animate(
        [{ opacity: 0, transform: 'translateY(10px) scale(0.98)' }, { opacity: 1, transform: 'none' }],
        { duration: dur(480), easing: EASE, delay: dur(Math.min(entrando++, 8) * 45), fill: 'backwards' }
      )
    } else if (el._html !== html) {
      const fresco = toEl(html)
      fresco.dataset.key = k
      fresco._html = html
      el.replaceWith(fresco)
      el = fresco
    }
    return el
  })

  const siguienteVivo = nodo => {
    while (nodo && nodo.dataset?.leaving) nodo = nodo.nextElementSibling
    return nodo
  }
  let previo = null
  ordenados.forEach(el => {
    const destino = siguienteVivo(previo ? previo.nextElementSibling : container.firstElementChild)
    if (el !== destino) container.insertBefore(el, destino)
    previo = el
  })
}

// --- CAMPOS ---
export function initPasswordToggles(root = document) {
  $$('[data-toggle-password]', root).forEach(btn => btn.addEventListener('click', () => {
    const input = btn.parentElement.querySelector('input')
    const mostrar = input.type === 'password'
    input.type = mostrar ? 'text' : 'password'
    btn.setAttribute('aria-label', mostrar ? 'Ocultar contraseña' : 'Mostrar contraseña')
    btn.querySelector('use').setAttribute('href', mostrar ? '#i-eye-off' : '#i-eye')
  }))
}
