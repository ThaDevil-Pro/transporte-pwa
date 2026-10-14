// =====================================================================
// Camiones con nombre y color (Rojo, Blanco, Amarillo, Gris).
// La lista vive en estado_viaje; aquí hay una copia para pintar las
// pantallas al instante y se actualiza cuando llega la de Supabase.
// =====================================================================
import { esc, opciones } from './ui.js'

let lista = [
  { id: 1, nombre: 'Rojo', color: '#ff3b30' },
  { id: 2, nombre: 'Blanco', color: '#f2f2f7' },
  { id: 3, nombre: 'Amarillo', color: '#ffcc00' },
  { id: 4, nombre: 'Gris', color: '#8e8e93' }
]

export const listaCamiones = () => lista
export const idsCamiones = () => lista.map(c => c.id)
export const existeCamion = id => lista.some(c => c.id === Number(id))

// "Rojo" (o el número si no se conoce)
export function camionCorto(id) {
  const c = lista.find(x => x.id === Number(id))
  return c ? c.nombre : String(id ?? '')
}

// "Camión Rojo"
export const nombreCamion = id => `Camión ${camionCorto(id)}`

export function colorCamion(id) {
  return lista.find(x => x.id === Number(id))?.color || '#8e8e93'
}

// Punto de color para usar dentro de un texto
export const puntoCamion = id => `<span class="bus-dot" style="--bus:${esc(colorCamion(id))}" aria-hidden="true"></span>`

// Filas de estado_viaje con nombre y color
export function actualizarCamiones(filas) {
  const nuevos = (filas || [])
    .filter(f => f?.id != null && f.nombre)
    .map(f => ({ id: Number(f.id), nombre: f.nombre, color: f.color || '#8e8e93' }))
    .sort((a, b) => a.id - b.id)
  if (nuevos.length) lista = nuevos
}

// Selector de camión con botones de color. Devuelve { value, set, reset }.
// noSe: agrega la opción "No sé" (valor '0').
export function selectorCamion(contenedor, { noSe = false, alElegir } = {}) {
  const items = () => [
    ...lista.map(c => ({ value: String(c.id), label: c.nombre })),
    ...(noSe ? [{ value: '0', label: 'No sé' }] : [])
  ]
  contenedor.classList.add('choices-bus')
  const control = opciones(contenedor, items(), alElegir)
  const pintarColores = () => {
    contenedor.querySelectorAll('.choice').forEach(b => {
      if (b.dataset.value === '0') return
      b.style.setProperty('--bus', colorCamion(b.dataset.value))
      if (!b.querySelector('.bus-dot')) b.insertAdjacentHTML('afterbegin', '<span class="bus-dot" aria-hidden="true"></span>')
    })
  }
  pintarColores()
  return {
    get value() { return control.value },
    set(v) { control.set(v == null ? null : String(v)) },
    reset: () => control.reset()
  }
}
