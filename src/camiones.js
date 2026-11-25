// =====================================================================
// Vehículos (minivan o camión) con nombre, color y acomodo de asientos.
// La lista vive en estado_viaje y la da de alta la administración. Aquí
// hay una copia para pintar las pantallas; los dados de baja se conservan
// solo para mostrar su nombre en el historial.
// Asiento: { n, r, c, par } — fila r y columna c del dibujo; par es el
// asiento de al lado en su fila de dos (null si va suelto).
// =====================================================================
import { esc, opciones } from './ui.js'

let todos = []
const selectores = new Set()

// Un vehículo que no está en la copia (se dio de alta con la app abierta) pide recargar la lista
let alFaltar = null
const pedidos = new Set()
export const siFaltaVehiculo = fn => { alFaltar = fn }
// Las pantallas que muestran nombres o acomodos se vuelven a pintar cuando la lista cambia
export const alCambiarVehiculos = fn => selectores.add(fn)

const activos = () => todos.filter(v => v.activo)
function buscar(id) {
  const v = todos.find(x => x.id === Number(id))
  if (!v && Number(id) > 0 && !pedidos.has(Number(id))) {
    pedidos.add(Number(id))
    queueMicrotask(() => alFaltar?.())
  }
  return v
}

export const listaCamiones = activos
export const idsCamiones = () => activos().map(c => c.id)
export const existeCamion = id => activos().some(c => c.id === Number(id))
export const vehiculo = buscar

export const TIPOS = { minivan: 'Minivan', camion: 'Camión' }

// "Vehículo 1" (o el número si no se conoce)
export function camionCorto(id) {
  return buscar(id)?.nombre ?? String(id ?? '')
}

export const nombreCamion = camionCorto

// "Vehículo 1 – Minivan"
export function etiquetaVehiculo(id) {
  const v = buscar(id)
  return v ? `${v.nombre} – ${TIPOS[v.tipo] || 'Vehículo'}` : String(id ?? '')
}

export function colorCamion(id) {
  return buscar(id)?.color || '#8e8e93'
}

// Punto de color para usar dentro de un texto
export const puntoCamion = id => `<span class="bus-dot" style="--bus:${esc(colorCamion(id))}" aria-hidden="true"></span>`

// --- Acomodo de asientos ---
export const asientosDe = id => buscar(id)?.asientos || []
export const capacidad = id => asientosDe(id).length
export const asiento = (id, n) => asientosDe(id).find(a => a.n === Number(n))
export const vecino = (id, n) => asiento(id, n)?.par ?? null
export function esVentana(id, n) {
  const a = asiento(id, n)
  const cols = buscar(id)?.cols || 5
  return !!a && (a.c === 0 || a.c === cols - 1)
}
export const filaDe = (id, n) => (asiento(id, n)?.r ?? 0) + 1
// Texto del asiento: su número, o «S/N» si en el camión no tiene número (se aparta igual)
export const rotulo = (id, n) => (n == null ? n : asiento(id, n)?.sn ? 'S/N' : n)

// Lugares con el asiento roto: se dibujan en gris, sin número, y no se pueden elegir
export const rotosDe = id => (buscar(id)?.bloques || [])
  .filter(b => b.roto)
  .flatMap(b => Array.from({ length: b.w }, (_, k) => ({ r: b.r, c: b.c + k })))
export const htmlRotos = id => rotosDe(id)
  .map(x => `<span class="seat-roto" style="grid-row:${x.r + 1};grid-column:${x.c + 1}" role="img" aria-label="Asiento roto, fuera de servicio" title="Asiento roto"></span>`)
  .join('')

// Columnas de la cuadrícula: las que nunca tienen asiento (pasillo) van angostas
export function plantillaColumnas(id) {
  const v = buscar(id)
  if (!v) return ''
  const rotos = rotosDe(id)
  return Array.from({ length: v.cols }, (_, c) => (v.asientos.some(a => a.c === c) || rotos.some(a => a.c === c) ? 'minmax(0, 1fr)' : '18px')).join(' ')
}

// Ubicación de un asiento dentro de la cuadrícula del mapa
export function posicion(id, n) {
  const a = asiento(id, n)
  return a ? `grid-row:${a.r + 1};grid-column:${a.c + 1}` : ''
}

// Retraso de la ola de entrada, de adelante hacia atrás
export function retrasoOla(id, n) {
  const a = asiento(id, n)
  return a ? a.r * 35 + a.c * 12 : 0
}

// Filas de estado_viaje (lectura pública)
function normalizar(f) {
  return {
    id: Number(f.id),
    nombre: f.nombre || `Vehículo ${f.id}`,
    color: f.color || '#8e8e93',
    tipo: f.tipo === 'minivan' ? 'minivan' : 'camion',
    cols: Number(f.cols) || 5,
    bloques: Array.isArray(f.bloques) ? f.bloques : [],
    asientos: Array.isArray(f.asientos) ? f.asientos : [],
    activo: f.activo !== false,
    exclusivo: f.exclusivo_chinacates === true,
    numeracion: f.numeracion === 'puerta' ? 'puerta' : 'chofer'
  }
}

// --- Ubicación de origen de los alumnos ---
export const UBICACIONES = {
  nuevo_ideal: { nombre: 'Nuevo Ideal', corto: 'NI', precio: 60 },
  chinacates: { nombre: 'Chinacates', corto: 'CH', precio: 40 }
}
export const ubicacionNombre = u => UBICACIONES[u]?.nombre || 'Sin ubicación'

export function actualizarCamiones(filas) {
  todos = (filas || []).filter(f => f?.id != null).map(normalizar).sort((a, b) => a.id - b.id)
  selectores.forEach(rehacer => rehacer())
}

// Un cambio en vivo de una fila (tiempo real). Si el aviso no trae el acomodo
// (columnas grandes que no cambiaron), se conserva el que ya se tenía.
export function actualizarCamion(fila) {
  if (fila?.id == null || fila.nombre === undefined) return
  const i = todos.findIndex(x => x.id === Number(fila.id))
  const previo = i >= 0 ? todos[i] : null
  const v = normalizar({
    ...fila,
    bloques: Array.isArray(fila.bloques) ? fila.bloques : previo?.bloques,
    asientos: Array.isArray(fila.asientos) ? fila.asientos : previo?.asientos
  })
  if (i >= 0) todos[i] = v
  else todos.push(v)
  todos.sort((a, b) => a.id - b.id)
  selectores.forEach(rehacer => rehacer())
}

// Selector de vehículo con botones de color. Devuelve { value, set, reset }.
// noSe: agrega la opción "No sé" (valor '0'). Se rehace solo cuando cambia la lista.
export function selectorCamion(contenedor, { noSe = false, alElegir } = {}) {
  const items = () => [
    ...activos().map(c => ({ value: String(c.id), label: c.nombre })),
    ...(noSe ? [{ value: '0', label: 'No sé' }] : [])
  ]
  contenedor.classList.add('choices-bus')
  const control = opciones(contenedor, items(), alElegir)
  const pintar = () => {
    contenedor.querySelectorAll('.choice').forEach(b => {
      if (b.dataset.value === '0') return
      b.style.setProperty('--bus', colorCamion(b.dataset.value))
      if (!b.querySelector('.bus-dot')) b.insertAdjacentHTML('afterbegin', '<span class="bus-dot" aria-hidden="true"></span>')
    })
  }
  pintar()
  // Mismo marcado que opciones(); el clic ya lo escucha el contenedor
  selectores.add(() => {
    const actual = control.value
    contenedor.innerHTML = items().map(it => `<button type="button" class="choice" role="radio" aria-checked="false" data-value="${esc(it.value)}"><span class="choice-text"><span class="choice-label">${esc(it.label)}</span></span></button>`).join('')
    pintar()
    control.set(actual && items().some(it => it.value === actual) ? actual : null)
  })
  return {
    get value() { return control.value },
    set(v) { control.set(v == null ? null : String(v)) },
    reset: () => control.reset()
  }
}
