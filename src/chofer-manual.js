// =====================================================================
// Registro manual del chofer: busca a un alumno por nombre o número de
// control y lo sube a la lista sin QR (para quien no trae su código).
// El servidor marca el abordaje como manual y lo anota en la bitácora.
// =====================================================================
import { $, esc, icon, avatar, haptic, toast, confirm, openSheet } from './ui.js'

const MINIMO = 2
const ESPERA_MS = 220
const AYUDA = 'Escribe al menos 2 letras o números.'

const primerNombre = nombre => String(nombre ?? '').trim().split(/\s+/)[0] || ''

export function initChoferManual({ rpc, camion, alRegistrar }) {
  const input = $('#manual-search')
  const lista = $('#manual-results')
  const estado = $('#manual-status')
  let resultados = []
  let activo = -1
  let peticion = 0
  let espera = null
  let registrando = false

  const disponible = a => a.camion == null

  function abrir() {
    limpiar()
    openSheet('sheet-manual', {
      onClose: () => {
        clearTimeout(espera)
        peticion++
      }
    })
    // Después de la animación de entrada (la hoja enfoca su panel al abrir)
    setTimeout(() => input.focus({ preventScroll: true }), 380)
  }

  function limpiar() {
    clearTimeout(espera)
    peticion++
    input.value = ''
    resultados = []
    activo = -1
    pintar()
    estado.textContent = AYUDA
  }

  input.addEventListener('input', () => {
    clearTimeout(espera)
    const texto = input.value.trim()
    if (texto.length < MINIMO) {
      peticion++
      resultados = []
      activo = -1
      pintar()
      estado.textContent = AYUDA
      return
    }
    estado.textContent = 'Buscando…'
    espera = setTimeout(() => buscar(texto), ESPERA_MS)
  })

  async function buscar(texto) {
    const id = ++peticion
    const { data, error } = await rpc('chofer_buscar_alumnos', { p_texto: texto })
    // Llegó tarde: ya se escribió otra cosa
    if (id !== peticion) return
    if (error) {
      estado.textContent = 'No se pudo buscar. Revisa tu conexión.'
      return
    }
    resultados = Array.isArray(data) ? data : []
    activo = resultados.findIndex(disponible)
    pintar()
    if (!resultados.length) estado.textContent = `Nadie coincide con “${texto}”.`
    else if (resultados.length === 8) estado.textContent = 'Estos son los primeros 8. Escribe más para afinar.'
    else estado.textContent = resultados.length === 1 ? '1 alumno encontrado.' : `${resultados.length} alumnos encontrados.`
  }

  function pintar() {
    lista.hidden = !resultados.length
    input.setAttribute('aria-expanded', String(resultados.length > 0))
    if (activo >= 0) input.setAttribute('aria-activedescendant', `manual-opt-${activo}`)
    else input.removeAttribute('aria-activedescendant')

    lista.innerHTML = resultados.map((a, i) => {
      const abordo = !disponible(a)
      const sub = abordo ? `${esc(a.matricula)} · Ya va en el camión ${esc(a.camion)}` : esc(a.matricula)
      return `<button type="button" class="row" role="option" id="manual-opt-${i}" data-i="${i}" aria-selected="${i === activo}"${abordo ? ' aria-disabled="true"' : ''} tabindex="-1">
        ${avatar(a.nombre)}
        <span class="row-text"><span class="row-title">${esc(a.nombre)}</span><span class="row-sub">${sub}</span></span>
        <span class="row-trailing">${icon(abordo ? 'i-check' : 'i-plus')}</span>
      </button>`
    }).join('')
  }

  // Flechas: recorre solo a quienes todavía pueden subir
  function mover(paso) {
    if (!resultados.some(disponible)) return
    let i = activo
    do {
      i = (i + paso + resultados.length) % resultados.length
    } while (!disponible(resultados[i]))
    activo = i
    pintar()
    $(`#manual-opt-${activo}`)?.scrollIntoView({ block: 'nearest' })
  }

  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); mover(1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); mover(-1) }
    else if (e.key === 'Enter') {
      e.preventDefault()
      if (activo >= 0) elegir(activo)
    }
  })

  lista.addEventListener('click', e => {
    const fila = e.target.closest('.row')
    if (fila) elegir(Number(fila.dataset.i))
  })

  async function elegir(i) {
    const a = resultados[i]
    if (!a || registrando) return
    if (!disponible(a)) {
      toast(`${primerNombre(a.nombre)} ya va en el camión ${a.camion}`, { type: 'warning' })
      return
    }
    const bus = camion()
    const ok = await confirm({
      title: `¿Subir a ${a.nombre}?`,
      message: `${a.matricula} · Camión ${bus}. Quedará registrado a mano y se le cobrará en el corte.`,
      confirmLabel: 'Subir'
    })
    if (!ok) {
      input.focus({ preventScroll: true })
      return
    }

    registrando = true
    const { data, error } = await rpc('chofer_abordar_manual', { p_camion: bus, p_matricula: a.matricula })
    registrando = false
    if (error) {
      haptic([30, 50, 30])
      toast(error.message || 'No se pudo registrar', { type: 'error' })
      input.focus({ preventScroll: true })
      return
    }

    haptic(30)
    toast(`${primerNombre(data.nombre)} está a bordo${data.asiento ? ` · Asiento ${data.asiento}` : ''}`, { type: 'success' })
    // Lista lista para el siguiente alumno sin código
    limpiar()
    input.focus({ preventScroll: true })
    alRegistrar()
  }

  return { abrir }
}
