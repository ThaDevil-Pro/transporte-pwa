// =====================================================================
// Mapa de asientos del chofer: quién va en cada asiento, de dónde viene
// (Nuevo Ideal o Chinacates) y si ya subió. Al tocar un asiento se abre la
// ficha del alumno con su foto. Solo lectura; el apartado lo hacen los alumnos.
// =====================================================================
import { camionCorto, htmlRotos, capacidad, plantillaColumnas, posicion, retrasoOla, UBICACIONES, ubicacionNombre } from './camiones.js'
import { $, $$, esc, icon, initials, avatar, haptic, openSheet } from './ui.js'
import { TZ, claveSalida, splitHora, etiquetaDia } from './asientos.js'

const EASE = 'cubic-bezier(0.25, 1, 0.5, 1)'

export function initChoferAsientos({ rpc, camion }) {
  let activo = false
  let salidas = []
  let salidaSel = null
  let mapa = null
  let peticion = 0

  const chips = $('#driver-departures')
  const seats = $('#driver-bus-seats')

  async function cargar() {
    activo = true
    escuchar()
    const bus = camion()
    $('#driver-seats-eyebrow').textContent = `${camionCorto(bus)}`
    $('#driver-bus-name').textContent = `${camionCorto(bus)}`
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
    clearInterval(sondeo)
    sondeo = null
    salidas = []
    salidaSel = null
    mapa = null
    chips.replaceChildren()
    seats.replaceChildren()
    actualizarStats()
  }

  function renderChips() {
    if (!salidas.length) {
      chips.innerHTML = '<p class="seat-hint">No hay salidas próximas para este vehículo. Agrégalas en la pestaña Horarios.</p>'
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
    const ubic = UBICACIONES[a.ubicacion]
    const etiqueta = estado === 'libre'
      ? `Asiento ${a.n}, libre`
      : `Asiento ${a.n}, ${a.nombre}, de ${ubicacionNombre(a.ubicacion)}, ${estado === 'abordo' ? 'a bordo' : 'aún no sube'}`
    const contenido = estado === 'libre'
      ? a.n
      : `<span class="seat-ini">${esc(initials(a.nombre))}</span><span class="seat-ubic">${ubic ? ubic.corto : '?'}</span><span class="seat-num">${a.n}</span>${estado === 'abordo' ? `<span class="seat-check">${icon('i-check')}</span>` : ''}`
    return `<button type="button" class="seat${a.con_pareja ? ' is-paired' : ''}${ubic ? ` ubic-${a.ubicacion}` : ''}" style="${posicion(mapa.camion, a.n)}" data-n="${a.n}" data-estado="${estado}" aria-label="${esc(etiqueta)}">${contenido}</button>`
  }

  function render(anterior) {
    seats.style.gridTemplateColumns = plantillaColumnas(mapa.camion)
    seats.innerHTML = mapa.asientos.map(htmlAsiento).join('') + htmlRotos(mapa.camion)

    $$('.seat', seats).forEach(el => {
      const n = Number(el.dataset.n)
      if (!anterior) {
        // Ola de entrada desde el frente del vehículo
        el.animate(
          [{ opacity: 0, transform: 'translateY(10px) scale(0.85)' }, { opacity: 1, transform: 'none' }],
          { duration: 480, delay: retrasoOla(mapa.camion, n), easing: EASE, fill: 'backwards' }
        )
      } else if (estadoAsiento(anterior.asientos[n - 1] || {}) !== el.dataset.estado) {
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
    $('#stat-libres').textContent = Math.max(0, capacidad(mapa?.camion ?? camion()) - apartados)
  }

  // --- FICHA DEL ALUMNO (foto y datos) ---
  const ficha = $('#sheet-ficha')
  let fichaTurno = 0

  async function abrirFicha({ matricula, nombre, ubicacion, asiento, abordo, fecha = null, hora = null }) {
    const turno = ++fichaTurno
    const ubic = UBICACIONES[ubicacion]
    $('#ficha-foto').innerHTML = `<span class="ficha-foto-cargando">${avatar(nombre)}</span>`
    $('#ficha-nombre').textContent = nombre
    $('#ficha-mat').textContent = `Matrícula ${matricula}`
    pintarDatos({ ubicacion, asiento, abordo })
    $('#ficha-ubic').className = `ficha-ubic${ubic ? ` ubic-${ubicacion}` : ''}`
    $('#ficha-ubic').textContent = ubicacionNombre(ubicacion)
    openSheet(ficha)
    const { data, error } = await rpc('chofer_alumno', { p_camion: camion(), p_fecha: fecha, p_hora: hora, p_matricula: matricula })
    if (turno !== fichaTurno) return
    if (error || !data) {
      $('#ficha-foto').innerHTML = avatar(nombre)
      return
    }
    $('#ficha-foto').innerHTML = data.foto
      ? `<img src="data:image/jpeg;base64,${data.foto}" alt="Foto de ${esc(data.nombre)}">`
      : `${avatar(data.nombre)}<span class="ficha-sin-foto">Sin foto</span>`
    pintarDatos(data)
  }

  function pintarDatos({ ubicacion, asiento, abordo, pareja }) {
    $('#ficha-datos').innerHTML = [
      ['i-seat', 'Asiento', asiento ? String(asiento) : 'Sin asiento'],
      ['i-pin', 'Sube en', ubicacionNombre(ubicacion)],
      [abordo ? 'i-check-circle' : 'i-clock', 'Estado', abordo ? 'Ya está a bordo' : 'Aún no sube'],
      ...(pareja ? [['i-link', 'Viaja con', pareja]] : [])
    ].map(([ico, etiqueta, valor]) => `<div class="ficha-dato">${icon(ico)}<span class="ficha-dato-k">${esc(etiqueta)}</span><span class="ficha-dato-v">${esc(valor)}</span></div>`).join('')
  }

  seats.addEventListener('click', e => {
    const el = e.target.closest('.seat')
    if (!el || !mapa) return
    const a = mapa.asientos[Number(el.dataset.n) - 1]
    if (!a?.nombre) return
    haptic(6)
    abrirFicha({ matricula: a.matricula, nombre: a.nombre, ubicacion: a.ubicacion, asiento: a.n, abordo: a.abordo, fecha: mapa.fecha, hora: mapa.hora })
  })

  // Se consulta cada ~10 s mientras el chofer tiene la app a la vista. Antes escuchaba en vivo
  // todos los apartados de todas las unidades: en la hora pico eso rebasaba el límite de Supabase.
  let sondeo = null
  function escuchar() {
    clearInterval(sondeo)
    sondeo = setInterval(() => { if (activo && mapa && !document.hidden) cargarMapa() }, 10000)
  }

  // Después de escanear o quitar a alguien, para marcar quién ya subió
  const refrescar = () => { if (activo && mapa) cargarMapa() }

  // Si llega la lista de vehículos (o cambia), se vuelve a pintar con el acomodo correcto
  const repintar = () => {
    if (!activo) return
    $('#driver-seats-eyebrow').textContent = `${camionCorto(camion())}`
    $('#driver-bus-name').textContent = `${camionCorto(camion())}`
    if (mapa) render(null)
  }

  return { cargar, limpiar, refrescar, repintar, abrirFicha }
}
