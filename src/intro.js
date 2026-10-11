// =====================================================================
// Intro animada del logotipo (reemplaza al video).
// Las letras se materializan una por una, un barrido de luz recorre el
// logotipo y al final vuela a su lugar en la pantalla de bienvenida.
// =====================================================================
import { $, $$ } from './ui.js'

const LOGO_URL = '/brand/camify-wordmark.png'
const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)'
const EASE_MOVE = 'cubic-bezier(0.32, 0.72, 0, 1)'
const EASE_POP = 'cubic-bezier(0.34, 1.56, 0.64, 1)'

// Piezas del logotipo medidas sobre el PNG (1200 × 233 px).
// La "IF" va junta para que el autobús nunca se parta.
const PIEZAS = [
  { clip: 'inset(0 84.17% 0 0)', origen: '7.9% 50%' }, // C
  { clip: 'inset(0 63.58% 0 15.83%)', origen: '26.1% 50%' }, // A
  { clip: 'inset(0 45.83% 0 36.42%)', origen: '45.3% 50%' }, // M
  { clip: 'inset(0 20.42% 0 54.17%)', origen: '66.9% 50%' }, // IF + autobús
  { clip: 'polygon(79.58% 0, 100% 0, 100% 64.38%, 94.17% 64.38%, 94.17% 100%, 79.58% 100%)', origen: '89.8% 50%' }, // Y
  { clip: 'inset(64.38% 0 0 94.17%)', origen: '97.4% 84.5%', punto: true } // .
]

const TIEMPOS = {
  inicioLetras: 150,
  pasoLetra: 80,
  duracionLetra: 950,
  inicioPunto: 800,
  barrido: 1250,
  frase: 1350,
  salida: 2350
}

function cargarLogo() {
  const img = new Image()
  img.src = LOGO_URL
  const decodificado = img.decode ? img.decode() : new Promise(r => { img.onload = r })
  // Si la imagen tarda, la intro arranca de todos modos
  return Promise.race([decodificado.catch(() => {}), new Promise(r => setTimeout(r, 900))])
}

// alSalir() muestra la pantalla de destino y regresa el elemento donde debe
// aterrizar el logotipo (o null para desvanecerlo en su lugar).
export async function runIntro({ alSalir, alTerminar }) {
  const splash = $('#splash')
  if (!splash) {
    alSalir()
    alTerminar?.()
    return
  }

  const logo = $('.splash-logo', splash)
  const full = $('.splash-full', splash)
  const sheen = $('.splash-sheen', splash)
  const glow = $('.splash-glow', splash)
  const frase = $('.splash-tagline', splash)
  const fondo = $('.splash-bg', splash)
  const reducido = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  // Construye las piezas del logotipo. El recorte y la máscara van en el
  // elemento interior para que el desenfoque del exterior afecte a la letra.
  const piezas = PIEZAS.map(p => {
    const el = document.createElement('span')
    el.className = 'splash-piece'
    el.style.transformOrigin = p.origen
    const glifo = document.createElement('span')
    glifo.className = 'splash-glyph'
    glifo.style.clipPath = p.clip
    glifo.style.webkitClipPath = p.clip
    el.appendChild(glifo)
    logo.insertBefore(el, full)
    return el
  })

  const anims = []
  const play = (el, frames, opts) => {
    const a = el.animate(frames, { fill: 'both', ...opts })
    anims.push(a)
    return a
  }

  let saliendo = false
  let timer = null

  const mostrarCompleto = () => {
    full.style.opacity = '1'
    piezas.forEach(p => { p.style.visibility = 'hidden' })
  }

  async function salir() {
    if (saliendo) return
    saliendo = true
    clearTimeout(timer)
    splash.style.pointerEvents = 'none'

    // Si se saltó la intro, completa el logotipo al instante
    anims.forEach(a => { if (a.playState !== 'finished') a.finish() })
    mostrarCompleto()
    sheen.style.visibility = 'hidden'

    const destino = alSalir()
    const dur = reducido ? 260 : 900

    fondo.animate([{ opacity: 1 }, { opacity: 0 }], { duration: dur * 0.85, easing: EASE_OUT, fill: 'forwards' })
    glow.animate([{ opacity: getComputedStyle(glow).opacity }, { opacity: 0 }], { duration: dur * 0.6, fill: 'forwards' })
    frase.animate([{ opacity: getComputedStyle(frase).opacity, transform: 'none' }, { opacity: 0, transform: 'translateY(8px)' }], { duration: dur * 0.4, easing: EASE_OUT, fill: 'forwards' })

    let vuelo
    if (destino && !reducido) {
      // Aterriza exactamente sobre el logotipo de la bienvenida
      destino.style.visibility = 'hidden'
      destino.getAnimations().filter(a => a.animationName === 'reveal').forEach(a => a.finish())
      const t = destino.getBoundingClientRect()
      const s = logo.getBoundingClientRect()
      const escala = t.width / s.width
      const dx = t.left + t.width / 2 - (s.left + s.width / 2)
      const dy = t.top + t.height / 2 - (s.top + s.height / 2)
      const colorFinal = getComputedStyle(destino).backgroundColor

      full.animate([{ backgroundColor: '#ffffff' }, { backgroundColor: colorFinal }], { duration: dur, easing: EASE_MOVE, fill: 'forwards' })
      vuelo = logo.animate(
        [{ transform: 'translate(0, 0) scale(1)' }, { transform: `translate(${dx}px, ${dy}px) scale(${escala})` }],
        { duration: dur, easing: EASE_MOVE, fill: 'forwards' }
      )
      await vuelo.finished.catch(() => {})
      destino.style.visibility = ''
    } else {
      // Sin destino (sesión guardada): el logotipo se acerca y se disuelve
      vuelo = logo.animate(
        [{ transform: 'scale(1)', opacity: 1, filter: 'blur(0)' }, { transform: 'scale(1.4)', opacity: 0, filter: 'blur(14px)' }],
        { duration: reducido ? 260 : 700, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards' }
      )
      await vuelo.finished.catch(() => {})
    }

    splash.remove()
    alTerminar?.()
  }

  splash.addEventListener('pointerdown', salir)

  await cargarLogo()
  if (saliendo) return

  if (reducido) {
    mostrarCompleto()
    frase.style.opacity = '1'
    timer = setTimeout(salir, 900)
    return
  }

  // 1. Resplandor de fondo
  play(glow, [{ opacity: 0, transform: 'scale(0.6)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 1600, delay: 100, easing: EASE_OUT })

  // 2. Letras que se materializan una por una
  piezas.forEach((el, i) => {
    if (PIEZAS[i].punto) {
      play(el, [
        { opacity: 0, transform: 'translateY(-60%) scale(0.4)', filter: 'blur(6px)' },
        { opacity: 1, transform: 'translateY(0) scale(1.18)', filter: 'blur(0)', offset: 0.55 },
        { opacity: 1, transform: 'translateY(0) scale(1)', filter: 'blur(0)' }
      ], { duration: 720, delay: TIEMPOS.inicioPunto, easing: EASE_POP })
      return
    }
    play(el, [
      { opacity: 0, transform: 'translateY(26%) scale(1.06)', filter: 'blur(16px)' },
      { opacity: 1, transform: 'translateY(0) scale(1)', filter: 'blur(0)' }
    ], { duration: TIEMPOS.duracionLetra, delay: TIEMPOS.inicioLetras + i * TIEMPOS.pasoLetra, easing: EASE_OUT })
  })

  // 3. Barrido de luz de color a través del logotipo
  play($('span', sheen), [{ transform: 'translateX(-110%)' }, { transform: 'translateX(110%)' }], { duration: 1050, delay: TIEMPOS.barrido, easing: 'cubic-bezier(0.45, 0, 0.25, 1)' })
  play(glow, [{ filter: 'saturate(1) brightness(1)' }, { filter: 'saturate(1.4) brightness(1.35)' }, { filter: 'saturate(1) brightness(1)' }], { duration: 1100, delay: TIEMPOS.barrido, easing: 'ease-in-out', fill: 'none' })

  // 4. Frase
  play(frase, [{ opacity: 0, letterSpacing: '0.4em', filter: 'blur(4px)' }, { opacity: 1, letterSpacing: '0.04em', filter: 'blur(0)' }], { duration: 1000, delay: TIEMPOS.frase, easing: EASE_OUT })

  // Cuando todas las piezas llegaron, se usa el logotipo completo (sin uniones visibles)
  Promise.all(anims.slice(1, 1 + piezas.length).map(a => a.finished)).then(() => {
    if (!saliendo) mostrarCompleto()
  }, () => {})

  timer = setTimeout(salir, TIEMPOS.salida)
}
