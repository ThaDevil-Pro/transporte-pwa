// =====================================================================
// Fondo vivo de la bienvenida (WebGL): motas de luz con los colores de
// la marca que flotan con profundidad, estrellas fugaces de vez en
// cuando y una onda que aparta la luz donde se toca la pantalla.
// Solo dibuja mientras la bienvenida está a la vista y la app abierta.
// =====================================================================

const PALETA = [
  [0.16, 0.59, 1.0],
  [0.37, 0.36, 0.9],
  [0.75, 0.35, 0.95],
  [1.0, 0.22, 0.37],
  [1.0, 0.62, 0.04],
  [1.0, 1.0, 1.0]
]

const VERTEX = `
attribute vec2 a_base;   // posición inicial (0–1) o semilla de la estrella
attribute vec2 a_vel;    // velocidad en px/s
attribute vec3 a_info;   // grosor, tipo (0 mota · 1 estrella fugaz), fase
attribute vec2 a_extra;  // parpadeo, profundidad (mota) · periodo (estrella)
attribute vec3 a_color;
attribute vec2 a_corner;

uniform float u_t;
uniform vec2 u_res;
uniform vec3 u_ptr;      // x, y, intensidad del toque
uniform float u_in;

varying vec2 v_local;
varying float v_len;
varying float v_w;
varying vec3 v_color;
varying float v_alpha;
varying float v_cola;

void main() {
  vec2 cabeza;
  vec2 cola;
  float w = a_info.x;
  float alpha;

  if (a_info.y < 0.5) {
    vec2 area = u_res * 1.2;
    vec2 p = mod(a_base * area + a_vel * u_t, area) - u_res * 0.1;
    vec2 d = p - u_ptr.xy;
    float d2 = dot(d, d);
    vec2 dir = d2 > 0.01 ? d / sqrt(d2) : vec2(0.0);
    float f = u_ptr.z * exp(-d2 / 16000.0);
    p += dir * f * 64.0;
    cabeza = p;
    cola = p - a_vel * 0.05 - dir * f * 18.0;
    float brillo = 0.55 + 0.45 * sin(u_t * a_extra.x + a_info.z);
    alpha = brillo * (0.22 + 0.5 * a_extra.y) * (1.0 + f * 1.8);
    v_cola = 0.5;
  } else {
    float periodo = a_extra.y;
    float ciclo = u_t + a_info.z;
    float n = floor(ciclo / periodo);
    float fase = ciclo - n * periodo;
    float dur = 1.15;
    float h1 = fract(sin(n * 12.9898 + a_info.z * 78.233) * 43758.5453);
    float h2 = fract(sin(n * 39.3468 + a_info.z * 11.135) * 24634.6345);
    vec2 inicio = vec2(u_res.x * (0.3 + 0.8 * h1), u_res.y * (-0.05 + 0.4 * h2));
    float rapidez = length(a_vel);
    vec2 dir = a_vel / rapidez;
    float s = min(fase, dur);
    cabeza = inicio + dir * rapidez * s;
    cola = cabeza - dir * min(rapidez * 0.18, rapidez * s);
    alpha = step(fase, dur) * sin(3.14159 * clamp(fase / dur, 0.0, 1.0)) * 0.95;
    v_cola = 0.0;
  }

  vec2 d = cabeza - cola;
  float len = length(d);
  vec2 dir = len > 0.001 ? d / len : vec2(1.0, 0.0);
  vec2 nor = vec2(-dir.y, dir.x);
  vec2 p = mix(cola, cabeza, a_corner.x) + dir * (a_corner.x * 2.0 - 1.0) * w + nor * a_corner.y * w;
  v_local = vec2(mix(-w, len + w, a_corner.x), a_corner.y * w);
  v_len = len;
  v_w = w;
  v_color = a_color;
  v_alpha = alpha * u_in;

  vec2 pos = p / u_res * 2.0 - 1.0;
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
  float halo = exp(-d * d * 3.0);
  float nucleo = exp(-d * d * 12.0);
  float largo = v_len > 0.0001 ? mix(v_cola, 1.0, x / v_len) : 1.0;
  float a = (halo * 0.55 + nucleo * 0.8) * largo * v_alpha;
  gl_FragColor = vec4(v_color * a, a);
}
`

const POR_VERTICE = 15
const ESQUINAS = [[0, -1], [1, -1], [1, 1], [0, -1], [1, 1], [0, 1]]

function compilar(gl, tipo, fuente) {
  const s = gl.createShader(tipo)
  gl.shaderSource(s, fuente)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.warn('Ambiente: shader', gl.getShaderInfoLog(s))
    return null
  }
  return s
}

export function initAmbiente(pantalla) {
  if (!pantalla || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

  const canvas = document.createElement('canvas')
  canvas.className = 'ambient-canvas'
  canvas.setAttribute('aria-hidden', 'true')
  pantalla.querySelector('.ambient')?.after(canvas)

  let gl = null
  try {
    gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false })
  } catch {
    gl = null
  }
  if (!gl) {
    canvas.remove()
    return
  }

  const vs = compilar(gl, gl.VERTEX_SHADER, VERTEX)
  const fs = compilar(gl, gl.FRAGMENT_SHADER, FRAGMENT)
  if (!vs || !fs) {
    canvas.remove()
    return
  }
  const prog = gl.createProgram()
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    canvas.remove()
    return
  }
  gl.useProgram(prog)

  // --- Partículas ---
  const modesto = (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 3
  const nMotas = modesto ? 70 : 130
  const estrellas = [
    { vel: [-620, 300], fase: 5.2, periodo: 9.5 },
    { vel: [-560, 330], fase: 1.3, periodo: 13.5 }
  ]
  const total = nMotas + estrellas.length
  const datos = new Float32Array(total * 6 * POR_VERTICE)
  let o = 0
  const escribir = (base, vel, info, extra, color) => {
    for (const [a, l] of ESQUINAS) {
      datos.set(base, o)
      datos.set(vel, o + 2)
      datos.set(info, o + 4)
      datos.set(extra, o + 7)
      datos.set(color, o + 9)
      datos[o + 12] = a
      datos[o + 13] = l
      datos[o + 14] = 0
      o += POR_VERTICE
    }
  }

  for (let i = 0; i < nMotas; i++) {
    // Las cercanas son más grandes, brillantes y rápidas (paralaje)
    const prof = Math.random() ** 1.6
    const ang = -Math.PI / 2 + (Math.random() - 0.5) * 1.6
    const rapidez = 4 + prof * 16
    escribir(
      [Math.random(), Math.random()],
      [Math.cos(ang) * rapidez, Math.sin(ang) * rapidez],
      [1.0 + prof * 2.6, 0, Math.random() * Math.PI * 2],
      [0.6 + Math.random() * 1.8, prof],
      PALETA[(Math.random() * PALETA.length) | 0]
    )
  }
  for (const e of estrellas) {
    escribir([0, 0], e.vel, [1.3, 1, e.fase], [0, e.periodo], [0.85, 0.88, 1.0])
  }

  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, datos, gl.STATIC_DRAW)
  const atributo = (nombre, tam, desfase) => {
    const loc = gl.getAttribLocation(prog, nombre)
    if (loc < 0) return
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, tam, gl.FLOAT, false, POR_VERTICE * 4, desfase * 4)
  }
  atributo('a_base', 2, 0)
  atributo('a_vel', 2, 2)
  atributo('a_info', 3, 4)
  atributo('a_extra', 2, 7)
  atributo('a_color', 3, 9)
  atributo('a_corner', 2, 12)

  const u = nombre => gl.getUniformLocation(prog, nombre)
  const uT = u('u_t')
  const uRes = u('u_res')
  const uPtr = u('u_ptr')
  const uIn = u('u_in')
  gl.enable(gl.BLEND)
  gl.blendFunc(gl.ONE, gl.ONE)
  gl.clearColor(0, 0, 0, 0)

  // --- Tamaño: el del lienzo tal como se ve ---
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  let W = 1
  let H = 1
  const ajustar = () => {
    const r = canvas.getBoundingClientRect()
    if (!r.width || !r.height) return
    W = r.width
    H = r.height
    canvas.width = Math.round(W * dpr)
    canvas.height = Math.round(H * dpr)
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.uniform2f(uRes, W, H)
  }
  if (typeof ResizeObserver === 'function') new ResizeObserver(ajustar).observe(canvas)

  // --- Toque: la luz se aparta del dedo y vuelve ---
  const toque = { x: -9999, y: -9999, k: 0, presionado: false }
  const mover = e => {
    const r = canvas.getBoundingClientRect()
    toque.x = e.clientX - r.left
    toque.y = e.clientY - r.top
  }
  pantalla.addEventListener('pointerdown', e => { mover(e); toque.presionado = true; toque.k = Math.max(toque.k, 0.6) })
  pantalla.addEventListener('pointermove', e => { if (toque.presionado) mover(e) })
  const soltar = () => { toque.presionado = false }
  pantalla.addEventListener('pointerup', soltar)
  pantalla.addEventListener('pointercancel', soltar)
  pantalla.addEventListener('pointerleave', soltar)

  // --- Bucle: solo con la bienvenida a la vista ---
  let raf = 0
  let activo = false
  let reloj = 0 // segundos acumulados de animación (no avanza en pausa)
  let previo = 0
  let encendido = 0

  function cuadro(ahora) {
    const dt = Math.min(0.05, (ahora - previo) / 1000)
    previo = ahora
    reloj += dt
    encendido = Math.min(1, encendido + dt / 1.6)
    toque.k = toque.presionado ? Math.min(1, toque.k + dt * 4) : toque.k * Math.exp(-dt * 2.4)

    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.uniform1f(uT, reloj)
    gl.uniform3f(uPtr, toque.x, toque.y, toque.k)
    gl.uniform1f(uIn, encendido * encendido * (3 - 2 * encendido))
    gl.drawArrays(gl.TRIANGLES, 0, total * 6)
    raf = requestAnimationFrame(cuadro)
  }

  function iniciar() {
    if (activo || document.hidden) return
    activo = true
    ajustar()
    previo = performance.now()
    raf = requestAnimationFrame(cuadro)
  }

  function detener() {
    activo = false
    cancelAnimationFrame(raf)
  }

  const visible = () => pantalla.classList.contains('is-active')
  document.addEventListener('screenchange', e => {
    if (e.detail?.id === pantalla.id) {
      encendido = 0
      iniciar()
    } else {
      // Se detiene cuando termina la transición de salida
      setTimeout(() => { if (!visible()) detener() }, 650)
    }
  })
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) detener()
    else if (visible()) iniciar()
  })
  canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); detener() })

  if (visible()) iniciar()
}
