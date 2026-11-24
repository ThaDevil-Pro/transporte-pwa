// =====================================================================
// Detector de congelamientos: anota cuándo la app se traba en el celular
// (hilo principal ocupado, pantalla que no se redibuja o toque en una
// pestaña que no cambia) y lo manda al servidor sin datos personales:
// solo rol, pantalla, qué se estaba cargando y el tipo de teléfono.
// =====================================================================
const MAX_LOTE = 20

export function initDetector({ enviar, contexto }) {
  const pendientes = []
  let visibleDesde = Date.now()
  let ultimo = performance.now()

  // Al volver de otra app los relojes se atrasan solos: eso no cuenta
  const estable = () => document.visibilityState === 'visible' && Date.now() - visibleDesde > 3000
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      visibleDesde = Date.now()
      ultimo = performance.now()
    } else {
      vaciar()
    }
  })

  function anotar(tipo, ms, extra = {}) {
    if (pendientes.length >= MAX_LOTE) return
    let ctx = {}
    try { ctx = contexto() } catch { /* el contexto nunca debe romper la app */ }
    pendientes.push({ tipo, ms: Math.round(ms), en: new Date().toISOString(), abierta_s: Math.round(performance.now() / 1000), ...ctx, ...extra })
  }

  // 1. Hilo principal trabado: este reloj de 250 ms llega muy tarde
  setInterval(() => {
    const ahora = performance.now()
    const atraso = ahora - ultimo - 250
    ultimo = ahora
    if (atraso > 1500 && estable()) anotar('pausa', atraso)
  }, 250)

  // 2. Pantalla trabada: pedir dos cuadros y ver cuánto tardan en dibujarse
  setInterval(() => {
    if (!estable()) return
    const t = performance.now()
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const ms = performance.now() - t
      if (ms > 1000 && estable()) anotar('dibujo', ms)
    }))
  }, 2000)

  // 3. Toque en una pestaña que no cambia de panel
  document.addEventListener('click', e => {
    const tab = e.target.closest?.('.tabbar .tab')
    if (!tab?.dataset.tab) return
    const id = tab.dataset.tab
    setTimeout(() => {
      if (!document.getElementById(id)?.classList.contains('is-active')) anotar('toque', 600, { pestana_tocada: id })
    }, 600)
  }, true)

  async function vaciar() {
    if (!pendientes.length) return
    const lote = pendientes.splice(0, MAX_LOTE)
    let ok = false
    try { ok = await enviar(lote) } catch { ok = false }
    // Sin señal: se reintenta en la siguiente vuelta
    if (!ok && pendientes.length + lote.length <= MAX_LOTE) pendientes.unshift(...lote)
  }
  setInterval(() => { if (estable()) vaciar() }, 30000)
}
