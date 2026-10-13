// =====================================================================
// Intro del logotipo.
//
// Escena principal (WebGL): en la oscuridad respira una chispa de luz,
// estalla hacia la cámara en miles de trazos de color con perspectiva
// (algunos pasan de largo, como un salto al hiperespacio), los trazos
// giran en espiral y aterrizan sobre la forma exacta del logotipo, que
// se solidifica con un pulso, una onda expansiva y retroiluminación.
// Al final el logotipo vuela a su lugar en la pantalla de bienvenida.
//
// Todo el movimiento se calcula en la GPU (el procesador solo envía el
// tiempo en cada cuadro). Sin WebGL se usa la versión retroiluminada.
// La primera vez del día va completa; las siguientes, más rápida.
// =====================================================================
import { $, $$ } from './ui.js'

const LOGO_URL = '/brand/camify-wordmark.png'
const VISTA_KEY = 'camify.intro'
const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)'
const EASE_MOVE = 'cubic-bezier(0.32, 0.72, 0, 1)'
const EASE_IN_OUT = 'cubic-bezier(0.65, 0, 0.35, 1)'

// Escena de partículas (ms)
const PARTICULAS = {
  halo: 1900,
  solido: 2200,
  onda: 2250,
  desvanecer: 2300,
  frase: 2450,
  salida: 3400
}

// Versión retroiluminada, sin WebGL (ms)
const RETRO = {
  linea: 120,
  halo: 520,
  encendido: 1300,
  frase: 1750,
  salida: 3000
}

// Colores de la marca a lo largo del logotipo (azul → violeta → rosa → naranja)
const PALETA = [
  [0.16, 0.59, 1.0],
  [0.37, 0.36, 0.9],
  [0.75, 0.35, 0.95],
  [1.0, 0.22, 0.37],
  [1.0, 0.62, 0.04]
]

function colorEn(u) {
  const x = Math.min(0.9999, Math.max(0, u)) * (PALETA.length - 1)
  const i = Math.floor(x)
  const f = x - i
  return PALETA[i].map((c, k) => c + (PALETA[i + 1][k] - c) * f)
}

function cargarLogo() {
  const img = new Image()
  img.src = LOGO_URL
  const decodificado = (img.decode ? img.decode() : new Promise((r, e) => { img.onload = r; img.onerror = e }))
    .then(() => img, () => null)
  // Si la imagen tarda, la intro arranca de todos modos (sin partículas)
  return Promise.race([decodificado, new Promise(r => setTimeout(() => r(null), 900))])
}

// Primera vez del día: intro completa. Después, más rápida.
function velocidadIntro() {
  const hoy = new Date().toDateString()
  try {
    const vista = localStorage.getItem(VISTA_KEY) === hoy
    localStorage.setItem(VISTA_KEY, hoy)
    return vista ? 1.55 : 1
  } catch {
    return 1
  }
}

// =====================================================================
// Escena WebGL
// =====================================================================
const VERTEX = `
attribute vec2 a_target;
attribute vec3 a_start;
attribute vec3 a_time;   // retraso, duración, giro
attribute vec3 a_info;   // grosor, tipo (0 logotipo, 1 polvo), estela
attribute vec3 a_color;
attribute vec2 a_corner; // (0 cola · 1 cabeza, lado -1 · 1)

uniform float u_t;
uniform vec2 u_res;
uniform vec2 u_center;
uniform float u_persp;
uniform float u_fade;

varying vec2 v_local;
varying float v_len;
varying float v_w;
varying vec3 v_color;
varying float v_alpha;
varying float v_cola;

vec2 rot(vec2 p, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
}

float quintica(float k) {
  return k * k * k * (k * (k * 6.0 - 15.0) + 10.0);
}

// xy: posición en pantalla respecto al centro del logotipo · z: escala · w: avance
vec4 estado(float t) {
  vec2 s = rot(a_start.xy, 0.55 * t);
  float k = clamp((t - a_time.x) / a_time.y, 0.0, 1.0);
  if (a_info.y < 0.5) {
    float e = quintica(k);
    float kz = clamp(k / 0.55, 0.0, 1.0);
    float ez = 1.0 - pow(1.0 - kz, 3.0);
    vec2 xy = a_target + rot(s - a_target, a_time.z * (1.0 - e)) * (1.0 - e);
    float z = a_start.z * (1.0 - ez) * (1.0 - ez);
    float sc = u_persp / (u_persp + z);
    return vec4(xy * sc, sc, k);
  }
  float e = k * k;
  float z = mix(a_start.z, -0.86 * u_persp, e);
  float sc = u_persp / (u_persp + z);
  return vec4(s * sc, sc, k);
}

void main() {
  vec2 cola;
  vec2 cabeza;
  float w;
  float alpha;
  vec3 color = a_color;

  if (a_info.y > 1.5) {
    // Chispa: núcleo que respira y destello horizontal de lente; estallan y se apagan
    float t = u_t;
    // (pow con base negativa no está definido: en iPhone da NaN)
    float q = (t - 0.5) / 0.09;
    float destello = exp(-q * q);
    alpha = smoothstep(0.0, 0.35, t) * (1.0 - smoothstep(0.58, 0.95, t)) * a_time.z * u_fade;
    if (a_info.y < 2.5) {
      w = a_info.x * (0.55 + 0.45 * smoothstep(0.0, 0.42, t)) * (1.0 + 0.07 * sin(t * 12.0)) * (1.0 + 1.3 * destello);
      cola = vec2(0.0);
      cabeza = vec2(0.0);
    } else {
      float largo = a_info.x * smoothstep(0.08, 0.42, t) * (0.3 + 2.6 * destello);
      w = 1.1 + 1.6 * destello;
      cola = vec2(-largo, 0.0);
      cabeza = vec2(largo, 0.0);
    }
  } else {
    vec4 h = estado(u_t);
    vec4 c = estado(u_t - a_info.z);
    cabeza = h.xy;
    cola = c.xy;
    w = a_info.x * clamp(h.z, 0.3, 7.0);
    float k = h.w;
    float asentado = a_info.y < 0.5 ? smoothstep(0.8, 1.0, k) : 0.0;
    color = mix(a_color, vec3(1.0), asentado * 0.7);
    alpha = smoothstep(0.0, 0.5, u_t) * u_fade;
    // La nube de la chispa (todas juntas) es más suave para no quemarse en blanco
    alpha *= mix(0.22, 1.0, smoothstep(0.0, 0.12, k));
    if (a_info.y > 0.5) alpha *= 1.0 - smoothstep(0.6, 1.0, k);
  }

  vec2 d = cabeza - cola;
  float len = length(d);
  vec2 dir = len > 0.001 ? d / len : vec2(1.0, 0.0);
  vec2 nor = vec2(-dir.y, dir.x);
  vec2 p = mix(cola, cabeza, a_corner.x) + dir * (a_corner.x * 2.0 - 1.0) * w + nor * a_corner.y * w;
  v_local = vec2(mix(-w, len + w, a_corner.x), a_corner.y * w);
  v_len = len;
  v_w = w;
  v_color = color;
  v_alpha = alpha;
  v_cola = a_info.y > 1.5 ? 1.0 : 0.2;

  vec2 pos = (u_center + p) / u_res * 2.0 - 1.0;
  gl_Position = vec4(pos.x, -pos.y, 0.0, 1.0);
}
`

const FRAGMENT = `
precision mediump float;
varying vec2 v_local;
varying float v_len;
varying float v_w;
varying vec3 v_color;
varying float v_alpha;
varying float v_cola;

void main() {
  float x = clamp(v_local.x, 0.0, v_len);
  float d = length(vec2(v_local.x - x, v_local.y)) / v_w;
  float halo = exp(-d * d * 3.5);
  float nucleo = exp(-d * d * 14.0);
  float largo = v_len > 0.0001 ? mix(v_cola, 1.0, x / v_len) : 1.0;
  float a = (halo * 0.5 + nucleo * 0.85) * largo * v_alpha;
  gl_FragColor = vec4(v_color * a, a);
}
`

const POR_VERTICE = 16
const ESQUINAS = [[0, -1], [1, -1], [1, 1], [0, -1], [1, 1], [0, 1]]

function puntosDelLogo(img, ancho, alto, cantidad) {
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(ancho))
  c.height = Math.max(1, Math.round(alto))
  const ctx = c.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(img, 0, 0, c.width, c.height)
  const { data } = ctx.getImageData(0, 0, c.width, c.height)
  const llenos = []
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      if (data[(y * c.width + x) * 4 + 3] > 140) llenos.push(x, y)
    }
  }
  const total = llenos.length / 2
  if (!total) return []
  const n = Math.min(cantidad, total)
  const puntos = []
  for (let i = 0; i < n; i++) {
    const j = (Math.random() * total) | 0
    puntos.push(llenos[j * 2] + Math.random() - c.width / 2, llenos[j * 2 + 1] + Math.random() - c.height / 2)
  }
  return puntos
}

function compilar(gl, tipo, fuente) {
  const s = gl.createShader(tipo)
  gl.shaderSource(s, fuente)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.warn('Intro: shader', gl.getShaderInfoLog(s))
    return null
  }
  return s
}

// Mide el lienzo tal como se ve y el logotipo respecto a él. No se usa
// window.innerHeight: en iPhone llega mal al abrir la app y aplastaba la escena.
function medir(canvas, logo) {
  const c = canvas.getBoundingClientRect()
  const l = logo.getBoundingClientRect()
  return {
    W: c.width || window.innerWidth,
    H: c.height || window.innerHeight,
    cx: l.left - c.left + l.width / 2,
    cy: l.top - c.top + l.height / 2,
    lw: l.width,
    lh: l.height
  }
}

function crearEscena({ canvas, img, logo, velocidad }) {
  let gl
  try {
    gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' })
  } catch {
    gl = null
  }
  if (!gl) return null

  const vs = compilar(gl, gl.VERTEX_SHADER, VERTEX)
  const fs = compilar(gl, gl.FRAGMENT_SHADER, FRAGMENT)
  if (!vs || !fs) return null
  const prog = gl.createProgram()
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.warn('Intro: programa', gl.getProgramInfoLog(prog))
    return null
  }

  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  let m = medir(canvas, logo)
  const rect = { width: m.lw, height: m.lh }

  // Menos partículas en equipos modestos
  const modesto = (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 3
  const objetivos = puntosDelLogo(img, rect.width, rect.height, modesto ? 800 : 1500)
  if (!objetivos.length) {
    console.warn('Intro: el logotipo no tiene puntos')
    return null
  }
  const nLogo = objetivos.length / 2
  const nPolvo = modesto ? 450 : 1000
  const total = nLogo + nPolvo + 3

  const persp = 600
  const radio = 0.55 * Math.hypot(m.W, m.H)
  const datos = new Float32Array(total * 6 * POR_VERTICE)
  let o = 0
  const escribir = (target, start, tiempo, info, color) => {
    for (const [a, l] of ESQUINAS) {
      datos.set(target, o)
      datos.set(start, o + 2)
      datos.set(tiempo, o + 5)
      datos.set(info, o + 8)
      datos.set(color, o + 11)
      datos[o + 14] = a
      datos[o + 15] = l
      o += POR_VERTICE
    }
  }

  for (let i = 0; i < nLogo; i++) {
    const tx = objetivos[i * 2]
    const ty = objetivos[i * 2 + 1]
    const u = tx / rect.width + 0.5
    const ang = Math.random() * Math.PI * 2
    const r = radio * (0.35 + 0.65 * Math.sqrt(Math.random()))
    escribir(
      [tx, ty],
      [Math.cos(ang) * r, Math.sin(ang) * r, persp * (18 + Math.random() * 16)],
      [0.42 + Math.random() * 0.25 + u * 0.12, 1.3 + Math.random() * 0.25, 2.2 + Math.random() * 1.6],
      [0.7 + Math.random() * 0.7, 0, 0.05],
      colorEn(u + (Math.random() - 0.5) * 0.12)
    )
  }

  for (let i = 0; i < nPolvo; i++) {
    const ang = Math.random() * Math.PI * 2
    const r = radio * (0.08 + 0.92 * Math.random())
    const blanco = Math.random() < 0.25
    escribir(
      [0, 0],
      [Math.cos(ang) * r, Math.sin(ang) * r, persp * (10 + Math.random() * 25)],
      [0.38 + Math.random() * 0.5, 0.9 + Math.random() * 0.6, 0],
      [0.55 + Math.random() * 0.75, 1, 0.08],
      blanco ? [1, 1, 1] : colorEn(Math.random())
    )
  }

  // Chispa inicial: halo suave, núcleo blanco y destello horizontal de lente
  escribir([0, 0], [0, 0, 0], [0, 1, 0.55], [46, 2, 0], [0.42, 0.45, 1.0])
  escribir([0, 0], [0, 0, 0], [0, 1, 1.0], [7, 2, 0], [1, 1, 1])
  escribir([0, 0], [0, 0, 0], [0, 1, 0.9], [120, 3, 0], [0.6, 0.7, 1.0])

  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, datos, gl.STATIC_DRAW)
  gl.useProgram(prog)
  const atributo = (nombre, tam, desfase) => {
    const loc = gl.getAttribLocation(prog, nombre)
    if (loc < 0) return
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, tam, gl.FLOAT, false, POR_VERTICE * 4, desfase * 4)
  }
  atributo('a_target', 2, 0)
  atributo('a_start', 3, 2)
  atributo('a_time', 3, 5)
  atributo('a_info', 3, 8)
  atributo('a_color', 3, 11)
  atributo('a_corner', 2, 14)

  const u = nombre => gl.getUniformLocation(prog, nombre)
  const uT = u('u_t')
  const uFade = u('u_fade')
  const uRes = u('u_res')
  const uCenter = u('u_center')
  gl.uniform1f(u('u_persp'), persp)

  // Tamaño del lienzo y centro del logotipo; se recalcula si la pantalla cambia
  const ajustar = () => {
    canvas.width = Math.max(1, Math.round(m.W * dpr))
    canvas.height = Math.max(1, Math.round(m.H * dpr))
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.uniform2f(uRes, m.W, m.H)
    gl.uniform2f(uCenter, m.cx, m.cy)
  }
  ajustar()
  const observador = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => { m = medir(canvas, logo); ajustar() })
    : null
  observador?.observe(canvas)
  gl.disable(gl.DEPTH_TEST)
  gl.enable(gl.BLEND)
  gl.blendFunc(gl.ONE, gl.ONE) // luz aditiva
  gl.clearColor(0, 0, 0, 0)

  const vertices = total * 6
  let raf = 0
  let inicio = 0
  let corte = null // { en, dur }: desvanecido rápido al saltar la intro
  const desvanecerEn = PARTICULAS.desvanecer / 1000
  const desvanecerDur = 0.6

  function cuadro(ahora) {
    const t = ((ahora - inicio) / 1000) * velocidad
    let fade = 1 - Math.min(1, Math.max(0, (t - desvanecerEn) / desvanecerDur))
    if (corte) fade *= 1 - Math.min(1, (ahora - corte.en) / corte.dur)
    gl.clear(gl.COLOR_BUFFER_BIT)
    if (fade > 0.001) {
      gl.uniform1f(uT, t)
      gl.uniform1f(uFade, fade * fade * (3 - 2 * fade))
      gl.drawArrays(gl.TRIANGLES, 0, vertices)
      raf = requestAnimationFrame(cuadro)
    }
  }

  return {
    iniciar() {
      inicio = performance.now()
      raf = requestAnimationFrame(cuadro)
    },
    // Al tocar para saltar: las partículas se apagan rápido
    apagar(ms = 200) {
      corte = { en: performance.now(), dur: ms }
      // Por si el navegador deja de pedir cuadros: se borra al terminar
      setTimeout(() => {
        cancelAnimationFrame(raf)
        gl.clear(gl.COLOR_BUFFER_BIT)
      }, ms + 40)
    },
    destruir() {
      cancelAnimationFrame(raf)
      observador?.disconnect()
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
  }
}

// =====================================================================
// Intro
// =====================================================================

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
  const linea = $('.splash-line', splash)
  const anillo = $('.splash-ring', splash)
  const canvas = $('.splash-canvas', splash)
  const halos = $$('.splash-halo', splash)
  const colores = $$('.splash-halo-color', splash)
  const glow = $('.splash-glow', splash)
  const frase = $('.splash-tagline', splash)
  const fondo = $('.splash-bg', splash)
  const reducido = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const velocidad = reducido ? 1 : velocidadIntro()
  const ms = x => x / velocidad

  // Animaciones con final (se completan al instante si se toca la pantalla)
  const anims = []
  const play = (el, frames, opts) => {
    const a = el.animate(frames, { fill: 'both', ...opts })
    anims.push(a)
    return a
  }

  let saliendo = false
  let timer = null
  let escena = null

  // El color del halo gira sin parar (fuera de "anims": no tiene final)
  const giros = colores.map((el, i) => el.animate(
    [{ transform: 'translate(-50%, -50%) rotate(0turn)' }, { transform: 'translate(-50%, -50%) rotate(1turn)' }],
    { duration: 7000, iterations: Infinity, delay: i * -900 }
  ))

  const logoEncendido = () => {
    full.getAnimations().forEach(a => a.cancel())
    full.style.background = '#fff'
    full.style.opacity = '1'
  }

  async function salir() {
    if (saliendo) return
    saliendo = true
    clearTimeout(timer)
    splash.style.pointerEvents = 'none'

    // Si se saltó la intro, todo llega a su estado final al instante
    anims.forEach(a => { if (a.playState !== 'finished') a.finish() })
    logoEncendido()
    escena?.apagar()

    const destino = alSalir()
    const dur = reducido ? 260 : 900

    fondo.animate([{ opacity: 1 }, { opacity: 0 }], { duration: dur * 0.85, easing: EASE_OUT, fill: 'forwards' })
    canvas.animate([{ opacity: getComputedStyle(canvas).opacity }, { opacity: 0 }], { duration: 220, easing: EASE_OUT, fill: 'forwards' })
    glow.animate([{ opacity: getComputedStyle(glow).opacity }, { opacity: 0 }], { duration: dur * 0.6, fill: 'forwards' })
    halos.forEach(h => h.animate([{ opacity: getComputedStyle(h).opacity }, { opacity: 0 }], { duration: dur * 0.55, easing: EASE_OUT, fill: 'forwards' }))
    linea.style.visibility = 'hidden'
    anillo.style.visibility = 'hidden'
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

    giros.forEach(a => a.cancel())
    escena?.destruir()
    splash.remove()
    alTerminar?.()
  }

  splash.addEventListener('pointerdown', salir)

  const img = await cargarLogo()
  if (saliendo) return

  if (reducido) {
    logoEncendido()
    giros.forEach(a => a.pause())
    halos.forEach(h => { h.style.opacity = '0.6' })
    frase.style.opacity = '1'
    timer = setTimeout(salir, 900)
    return
  }

  if (img) {
    try {
      escena = crearEscena({ canvas, img, logo, velocidad })
    } catch (err) {
      console.warn('Intro: sin WebGL', err)
      escena = null
    }
  }

  if (escena) secuenciaParticulas()
  else secuenciaRetroiluminada()

  // --- Escena de partículas: la luz se vuelve logotipo ---
  function secuenciaParticulas() {
    linea.hidden = true
    full.style.background = '#fff'
    escena.iniciar()

    // Luz ambiental que crece con la explosión
    play(glow, [
      { opacity: 0, transform: 'scale(0.3)' },
      { opacity: 0.85, transform: 'scale(1)', offset: 0.5 },
      { opacity: 1, transform: 'scale(1.05)' }
    ], { duration: ms(2400), delay: ms(350), easing: EASE_OUT })

    // Retroiluminación detrás del logotipo mientras aterrizan los trazos
    halos.forEach((h, i) => {
      play(h, [
        { opacity: 0, transform: 'scale(0.92)' },
        { opacity: 1, transform: 'scale(1)', offset: 0.55 },
        { opacity: i === 0 ? 0.75 : 0.9, transform: 'scale(1)' }
      ], { duration: ms(1300), delay: ms(PARTICULAS.halo + i * 120), easing: EASE_OUT })
    })

    // La luz se solidifica: aparece el logotipo
    play(full, [
      { opacity: 0, transform: 'scale(1.025)' },
      { opacity: 1, transform: 'scale(1)' }
    ], { duration: ms(520), delay: ms(PARTICULAS.solido), easing: EASE_OUT })

    // Pulso del logotipo y onda expansiva al anclarse
    play(logo, [
      { transform: 'scale(1)' },
      { transform: 'scale(1.045)', offset: 0.28 },
      { transform: 'scale(1)' }
    ], { duration: ms(700), delay: ms(PARTICULAS.onda - 40), easing: EASE_OUT })
    play(anillo, [
      { opacity: 0, transform: 'translate(-50%, -50%) scale(0.25)' },
      { opacity: 0.95, transform: 'translate(-50%, -50%) scale(0.6)', offset: 0.08 },
      { opacity: 0, transform: 'translate(-50%, -50%) scale(5.5)' }
    ], { duration: ms(1150), delay: ms(PARTICULAS.onda), easing: 'cubic-bezier(0.16, 1, 0.3, 1)' })
    play(glow, [
      { filter: 'brightness(1) saturate(1)' },
      { filter: 'brightness(1.7) saturate(1.35)', offset: 0.25 },
      { filter: 'brightness(1) saturate(1)' }
    ], { duration: ms(1200), delay: ms(PARTICULAS.onda), easing: 'ease-out', fill: 'none' })

    play(frase, [
      { opacity: 0, letterSpacing: '0.42em', filter: 'blur(4px)' },
      { opacity: 1, letterSpacing: '0.06em', filter: 'blur(0)' }
    ], { duration: ms(1000), delay: ms(PARTICULAS.frase), easing: EASE_OUT })

    timer = setTimeout(salir, ms(PARTICULAS.salida))
  }

  // --- Sin WebGL: línea de luz, silueta retroiluminada y encendido ---
  function secuenciaRetroiluminada() {
    canvas.hidden = true
    full.style.opacity = '1'

    play(linea, [
      { opacity: 0, transform: 'translate(-50%, -50%) scaleX(0) scaleY(1)' },
      { opacity: 1, transform: 'translate(-50%, -50%) scaleX(1) scaleY(1)', offset: 0.45 },
      { opacity: 1, transform: 'translate(-50%, -50%) scaleX(1.05) scaleY(1.6)', offset: 0.62 },
      { opacity: 0, transform: 'translate(-50%, -50%) scaleX(1.25) scaleY(28)' }
    ], { duration: ms(1250), delay: ms(RETRO.linea), easing: EASE_IN_OUT })

    play(glow, [
      { opacity: 0, transform: 'scale(0.4)' },
      { opacity: 1, transform: 'scale(1)' }
    ], { duration: ms(1800), delay: ms(RETRO.halo), easing: EASE_OUT })

    halos.forEach((h, i) => {
      play(h, [
        { opacity: 0, transform: 'scale(0.9)' },
        { opacity: 1, transform: 'scale(1)', offset: 0.6 },
        { opacity: i === 0 ? 0.75 : 0.9, transform: 'scale(1)' }
      ], { duration: ms(1700), delay: ms(RETRO.halo + i * 140), easing: EASE_OUT })
    })

    // La silueta aparece apenas, recortada contra el halo
    play(full, [
      { opacity: 0, transform: 'scale(0.97)' },
      { opacity: 1, transform: 'scale(1)' }
    ], { duration: ms(1400), delay: ms(RETRO.halo), easing: EASE_OUT })

    // Las letras se encienden de izquierda a derecha
    play(full, [
      { backgroundPosition: '100% 0' },
      { backgroundPosition: '0% 0' }
    ], { duration: ms(1100), delay: ms(RETRO.encendido), easing: EASE_IN_OUT })

    play(glow, [
      { filter: 'brightness(1) saturate(1)' },
      { filter: 'brightness(1.5) saturate(1.3)', offset: 0.4 },
      { filter: 'brightness(1) saturate(1)' }
    ], { duration: ms(1300), delay: ms(RETRO.encendido + 500), easing: 'ease-in-out', fill: 'none' })

    play(frase, [
      { opacity: 0, letterSpacing: '0.42em', filter: 'blur(4px)' },
      { opacity: 1, letterSpacing: '0.06em', filter: 'blur(0)' }
    ], { duration: ms(1100), delay: ms(RETRO.frase), easing: EASE_OUT })

    timer = setTimeout(salir, ms(RETRO.salida))
  }
}
