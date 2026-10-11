// =====================================================================
// Mapa de asientos del chofer: quién va en cada asiento y si ya subió.
// Solo lectura; el apartado lo hacen los alumnos.
// =====================================================================
import { $, $$, esc, icon, initials, haptic, alert } from './ui.js'
import { TZ, claveSalida, splitHora, etiquetaDia } from './asientos.js'

const EASE = 'cubic-bezier(0.25, 1, 0.5, 1)'

export function initChoferAsientos({ rpc, supabase, camion }) {
  let activo = false
  let salidas = []
  let salidaSel = null
  let mapa = null
  let peticion = 0

  const chips = $('#driver-departures')
  const seats = $('#driver-bus-seats')

  async function cargar() {
    activo = true
    const bus = camion()
    $('#driver-seats-eyebrow').textContent = `Camión ${bus}`
    $('#driver-bus-name').textContent = `Camión ${bus}`
    const { data, error } = await rpc('chofer_salidas', { p_camion: bus })
    // Ignora la respuesta si el chofer cambió de camión mientras tanto
    if (error || !activo || bus !== camion()) return
    salidas = data
    if (!salidas.some(s => claveSalida(s) === salidaSel)) salidaSel = salidas[0] ? claveSalida(salidas[0]) : null
    renderChips()
    await cargarMapa({ reconstruir: true })
  }

  function limpiar() {
    activo = false
    salidas = []
    salidaSel = null
    mapa = null
    chips.replaceChildren()
    seats.replaceChildren()
    actualizarStats()
  }

  function renderChips() {
    if (!salidas.length) {
      chips.innerHTML = '<p class="seat-hint">No hay salidas próximas para este camión.</p>'
      return
    }
    chips.innerHTML = salidas.map(s => {
      const k = claveSalida(s)
      const { t, p } = splitHora(s.hora)
      const estado = new Date(s.salida_en) <= Date.now()
        ? 'Ya salió'
        : s.abierta
          ? `${s.ocupados} apartados`
          : `${icon('i-lock')}${esc(new Date(s.abre_en).toLocaleTimeString('es-MX', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true }))}`
      return `<button class="departure" role="tab" aria-selected="${k === salidaSel}" data-salida="${esc(k)}">
        <span class="departure-day">${esc(etiquetaDia(s.fecha))} · ${s.tipo === 'REGRESO' ? 'Regreso' : 'Ida'}</span>
        <span class="departure-time">${t}<small>${p}</small></span>
        <span class="departure-status">${estado}</span>
      </button>`
    }).join('')
  }

  chips.addEventListener('click', e => {
    const btn = e.target.closest('[data-salida]')
    if (!btn || btn.dataset.salida === salidaSel) return
    haptic(5)
    salidaSel = btn.dataset.salida
    $$('.departure', chips).forEach(d => d.setAttribute('aria-selected', String(d === btn)))
    btn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
    cargarMapa({ reconstruir: true })
  })

  async function cargarMapa({ reconstruir = false } = {}) {
    const s = salidas.find(x => claveSalida(x) === salidaSel)
    if (!s) {
      seats.replaceChildren()
      mapa = null
      actualizarStats()
      return
    }
    const turno = ++peticion
    const { data, error } = await rpc('chofer_mapa', { p_fecha: s.fecha, p_hora: s.hora, p_camion: s.camion })
    if (turno !== peticion || error || !activo) return
    const anterior = mapa
    mapa = data
    render(reconstruir || !anterior ? null : anterior)
  }

  const estadoAsiento = a => (!a.nombre ? 'libre' : a.abordo ? 'abordo' : 'apartado')

  function htmlAsiento(a) {
    const estado = estadoAsiento(a)
    const etiqueta = estado === 'libre'
      ? `Asiento ${a.n}, libre`
      : `Asiento ${a.n}, ${a.nombre}, ${estado === 'abordo' ? 'a bordo' : 'aún no sube'}`
    const contenido = estado === 'libre'
      ? a.n
      : `${esc(initials(a.nombre))}<span class="seat-num">${a.n}</span>${estado === 'abordo' ? `<span class="seat-check">${icon('i-check')}</span>` : ''}`
    return `<button type="button" class="seat${a.con_pareja ? ' is-paired' : ''}" data-n="${a.n}" data-estado="${estado}" aria-label="${esc(etiqueta)}">${contenido}</button>`
  }

  function render(anterior) {
    const celdas = []
    for (let r = 0; r < 10; r++) {
      const fila = mapa.asientos.slice(r * 4, r * 4 + 4)
      celdas.push(htmlAsiento(fila[0]), htmlAsiento(fila[1]), `<span class="bus-row-label" aria-hidden="true">${r + 1}</span>`, htmlAsiento(fila[2]), htmlAsiento(fila[3]))
    }
    seats.innerHTML = celdas.join('')

    $$('.seat', seats).forEach(el => {
      const n = Number(el.dataset.n)
      if (!anterior) {
        // Ola de entrada desde el frente del camión
        el.animate(
          [{ opacity: 0, transform: 'translateY(10px) scale(0.85)' }, { opacity: 1, transform: 'none' }],
          { duration: 480, delay: (Math.ceil(n / 4) - 1) * 35 + ((n - 1) % 4) * 12, easing: EASE, fill: 'backwards' }
        )
      } else if (estadoAsiento(anterior.asientos[n - 1]) !== el.dataset.estado) {
        el.classList.add('is-pulse')
      }
    })
    actualizarStats()
  }

  function actualizarStats() {
    const asientos = mapa?.asientos || []
    const apartados = asientos.filter(a => a.nombre).length
    $('#stat-apartados').textContent = apartados
    $('#stat-abordo').textContent = asientos.filter(a => a.abordo).length
    $('#stat-libres').textContent = 40 - apartados
  }

  seats.addEventListener('click', e => {
    const el = e.target.closest('.seat')
    if (!el || !mapa) return
    const a = mapa.asientos[Number(el.dataset.n) - 1]
    if (!a.nombre) return
    haptic(6)
    alert({
      title: a.nombre,
      message: `Asiento ${a.n} · ${a.matricula} · ${a.abordo ? 'Ya está a bordo' : 'Aún no sube'}${a.con_pareja ? ' · Viaja con su pareja' : ''}`
    })
  })

  // Tiempo real: cuando alguien aparta o libera un asiento de esta salida
  supabase
    .channel('actividad_chofer_channel')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'actividad' }, ({ new: fila }) => {
      if (activo && salidaSel && fila?.clave === `salida:${salidaSel}`) cargarMapa()
    })
    .subscribe()

  // Después de escanear o quitar a alguien, para marcar quién ya subió
  const refrescar = () => { if (activo && mapa) cargarMapa() }

  return { cargar, limpiar, refrescar }
}
