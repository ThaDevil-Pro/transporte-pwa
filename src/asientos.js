// =====================================================================
// Asientos y parejas (vista del alumno)
// · Tarjetas "Tu asiento" y "Pareja de viaje" y mensajes del panel.
// · Mapa interactivo del camión: 10 filas × (A B | pasillo | C D).
// Toda la lógica de reglas vive en Supabase; aquí solo se presenta.
// =====================================================================
import { camionCorto } from './camiones.js'
import {
  $, $$, esc, icon, avatar, haptic, openSheet, closeSheet, confirm, toast, setLoading, shake, patchList
} from './ui.js'

export const TZ = 'America/Mexico_City'
const FILAS = 10
const EASE = 'cubic-bezier(0.25, 1, 0.5, 1)'
const ESQUELETO = '<div class="skeleton" style="height:72px;margin-top:14px;border-radius:16px"></div>'

const AVISO_UI = {
  asiento_movido: { titulo: 'Cambiamos tu asiento', icono: 'i-swap', tint: 'orange' },
  asiento_pareja: { titulo: 'Tu pareja apartó tu lugar', icono: 'i-seat', tint: 'indigo' },
  pareja_aceptada: { titulo: '¡Ya tienes pareja de viaje!', icono: 'i-link', tint: 'green' },
  pareja_rechazada: { titulo: 'Invitación no aceptada', icono: 'i-link', tint: 'gray' },
  pareja_terminada: { titulo: 'Pareja de viaje terminada', icono: 'i-link', tint: 'gray' },
  queja_respondida: { titulo: 'Respondieron tu queja', icono: 'i-inbox', tint: 'blue' },
  queja_atendida: { titulo: 'Tu queja fue atendida', icono: 'i-inbox', tint: 'green' },
  emergencia: { titulo: 'Aviso de emergencia del camión', icono: 'i-alert', tint: 'red' }
}

// --- FORMATO ---
export const vecino = n => (n % 2 === 1 ? n + 1 : n - 1)
const esVentana = n => n % 4 === 1 || n % 4 === 0
// Igual que la clave de la tabla "actividad": salida:<fecha>T<hora>:<camión>
export const claveSalida = s => `${s.fecha}T${s.hora}:${s.camion}`
const fechaISO = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
const hoyLocal = (dias = 0) => fechaISO.format(new Date(Date.now() + dias * 864e5))
const relativo = new Intl.RelativeTimeFormat('es', { numeric: 'auto' })

export function splitHora(hhmm) {
  const [h, m] = hhmm.split(':').map(Number)
  return { t: `${h % 12 || 12}:${String(m).padStart(2, '0')}`, p: h < 12 ? 'a. m.' : 'p. m.' }
}

export const horaTexto = hhmm => {
  const { t, p } = splitHora(hhmm)
  return `${t} ${p}`
}

export function etiquetaDia(fecha) {
  if (fecha === hoyLocal()) return 'Hoy'
  if (fecha === hoyLocal(1)) return 'Mañana'
  const txt = new Date(`${fecha}T12:00:00`).toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric' }).replace('.', '')
  return txt.charAt(0).toUpperCase() + txt.slice(1)
}

// Momento absoluto → "hoy a las 6:00 p. m."
function momentoTexto(iso) {
  const d = new Date(iso)
  const fecha = fechaISO.format(d)
  const hora = d.toLocaleTimeString('es-MX', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true })
  const dia = fecha === hoyLocal() ? 'hoy' : fecha === hoyLocal(1) ? 'mañana' : `el ${d.toLocaleDateString('es-MX', { timeZone: TZ, weekday: 'long' })}`
  return `${dia} a las ${hora}`
}

function formatCuenta(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000))
  const d = Math.floor(s / 86400)
  if (d > 0) return `${d} d ${Math.floor((s % 86400) / 3600)} h`
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map(v => String(v).padStart(2, '0')).join(':')
}

function tiempoAtras(iso) {
  const seg = Math.round((new Date(iso) - Date.now()) / 1000)
  const abs = Math.abs(seg)
  if (abs < 60) return 'Hace un momento'
  if (abs < 3600) return relativo.format(Math.round(seg / 60), 'minute')
  if (abs < 86400) return relativo.format(Math.round(seg / 3600), 'hour')
  return relativo.format(Math.round(seg / 86400), 'day')
}

export function initAsientos({ rpc, supabase, alCambiarSalidas }) {
  let activo = false
  let miNombre = ''
  let salidas = []
  let pareja = { activa: null, enviada: null, recibidas: [] }
  let avisos = []
  let salidaSel = null
  let mapa = null
  let seleccion = null
  let reloj = null
  let refrescoTimer = null
  let ultimaRecarga = 0
  let peticionMapa = 0

  const alerts = $('#student-alerts')
  const seatBody = $('#seat-card-body')
  const pairBody = $('#pair-card-body')
  const bus = $('#bus')
  const busSeats = $('#bus-seats')
  const btnConfirm = $('#btn-seat-confirm')
  const btnRelease = $('#btn-seat-release')
  const departures = $('#seat-departures')

  // --- CARGA ---
  async function cargar(nombre) {
    if (nombre) miNombre = nombre
    activo = true
    await Promise.all([cargarSalidas(), cargarPareja(), cargarAvisos()])
    clearInterval(reloj)
    reloj = setInterval(tic, 1000)
  }

  async function cargarSalidas() {
    const { data, error } = await rpc('alumno_salidas')
    if (error || !activo) return
    salidas = data
    renderSeatCard()
    if (salidaSel) renderDepartures()
    alCambiarSalidas?.(salidas)
  }

  async function cargarPareja() {
    const { data, error } = await rpc('pareja_estado')
    if (error || !activo) return
    pareja = data
    renderPairCard()
    renderAlerts()
  }

  async function cargarAvisos() {
    const { data, error } = await rpc('alumno_avisos')
    if (error || !activo) return
    avisos = data
    renderAlerts()
  }

  function limpiar() {
    activo = false
    clearInterval(reloj)
    salidas = []
    pareja = { activa: null, enviada: null, recibidas: [] }
    avisos = []
    salidaSel = null
    mapa = null
    seleccion = null
    alerts.replaceChildren()
    seatBody.innerHTML = ESQUELETO
    pairBody.innerHTML = ESQUELETO
  }

  // Cuentas regresivas y apertura automática de salidas
  function tic() {
    if (!activo) return
    const ahora = Date.now()
    $$('[data-cuenta]').forEach(el => { el.textContent = formatCuenta(new Date(el.dataset.cuenta) - ahora) })
    const cambio = salidas.some(s => (!s.abierta && new Date(s.abre_en) <= ahora) || new Date(s.salida_en) <= ahora)
    if (cambio && ahora - ultimaRecarga > 15000) {
      ultimaRecarga = ahora
      cargarSalidas().then(() => { if (mapa) cargarMapa({ silencioso: true }) })
    }
  }

  // --- MENSAJES DEL PANEL ---
  function htmlAviso(av) {
    const ui = AVISO_UI[av.tipo] || { titulo: 'Aviso', icono: 'i-info', tint: 'blue' }
    return `<article class="alert-card">
      <span class="row-icon tint-${ui.tint}">${icon(ui.icono)}</span>
      <div class="alert-text">
        <p class="alert-title">${esc(ui.titulo)}</p>
        <p class="alert-msg">${esc(av.mensaje)}</p>
        <p class="alert-time">${esc(tiempoAtras(av.creado_en))}</p>
      </div>
      <button class="icon-btn icon-btn-sm alert-close" data-aviso="${esc(av.id)}" aria-label="Descartar aviso">${icon('i-x')}</button>
    </article>`
  }

  function htmlInvitacion(inv) {
    return `<article class="alert-card">
      ${avatar(inv.nombre)}
      <div class="alert-text">
        <p class="alert-title">${esc(inv.nombre)} quiere ser tu pareja de viaje</p>
        <p class="alert-msg">Durante un mes se sentarán juntos cuando cualquiera de los dos aparte asiento.</p>
        <div class="button-row">
          <button class="btn btn-secondary" data-invitacion="${esc(inv.id)}" data-aceptar="0">Rechazar</button>
          <button class="btn btn-primary" data-invitacion="${esc(inv.id)}" data-aceptar="1">Aceptar</button>
        </div>
      </div>
    </article>`
  }

  function renderAlerts() {
    const items = [
      ...(pareja.recibidas || []).map(inv => ({ clave: `inv-${inv.id}`, inv })),
      ...avisos.map(av => ({ clave: `av-${av.id}`, av }))
    ]
    patchList(alerts, items, {
      key: i => i.clave,
      render: i => (i.inv ? htmlInvitacion(i.inv) : htmlAviso(i.av))
    })
  }

  alerts.addEventListener('click', async e => {
    const cerrar = e.target.closest('[data-aviso]')
    if (cerrar) {
      const id = Number(cerrar.dataset.aviso)
      haptic(5)
      avisos = avisos.filter(a => a.id !== id)
      renderAlerts()
      rpc('alumno_aviso_leido', { p_id: id })
      return
    }

    const resp = e.target.closest('[data-invitacion]')
    if (!resp) return
    const aceptar = resp.dataset.aceptar === '1'
    setLoading(resp, true)
    const { error } = await rpc('pareja_responder', { p_id: Number(resp.dataset.invitacion), p_aceptar: aceptar })
    setLoading(resp, false)
    if (error) {
      toast(error.message, { type: 'error' })
      cargarPareja()
      return
    }
    haptic(aceptar ? [12, 50, 18] : 8)
    toast(aceptar ? '¡Ahora viajan juntos!' : 'Invitación rechazada', { type: aceptar ? 'success' : 'info' })
    await cargarPareja()
    cargarSalidas()
  })

  // --- TARJETA "TU ASIENTO" ---
  function renderSeatCard() {
    const conAsiento = salidas.find(s => s.mi_asiento)
    const abierta = salidas.find(s => s.abierta)
    const proxima = salidas[0]

    if (conAsiento) {
      const s = conAsiento
      const junto = s.asiento_pareja && vecino(s.mi_asiento) === s.asiento_pareja
      seatBody.innerHTML = `<div class="seat-summary">
          <span class="seat-badge"><small>Asiento</small><strong>${s.mi_asiento}</strong></span>
          <div>
            <p class="seat-when">${esc(etiquetaDia(s.fecha))} · ${esc(horaTexto(s.hora))}</p>
            <p class="seat-sub">Camión ${camionCorto(s.camion)} · ${s.tipo === 'REGRESO' ? 'Regreso' : 'Ida'} · ${esVentana(s.mi_asiento) ? 'Ventana' : 'Pasillo'} · Fila ${Math.ceil(s.mi_asiento / 4)}</p>
            ${junto ? `<p class="seat-sub"><b>Junto a ${esc(pareja.activa?.nombre || 'tu pareja')}</b> · asiento ${s.asiento_pareja}</p>` : ''}
          </div>
        </div>
        <button class="btn btn-secondary btn-block" data-abrir-asientos="${esc(claveSalida(s))}">Ver o cambiar asiento</button>`
    } else if (abierta) {
      seatBody.innerHTML = `<p class="seat-cta-title">Ya puedes apartar tu lugar</p>
        <p class="seat-cta-sub">Camión ${camionCorto(abierta.camion)}, ${esc(etiquetaDia(abierta.fecha).toLowerCase())} a las ${esc(horaTexto(abierta.hora))} · ${40 - abierta.ocupados} asientos libres</p>
        <button class="btn btn-primary btn-block" data-abrir-asientos="${esc(claveSalida(abierta))}">${icon('i-seat')}Elegir asiento</button>`
    } else if (proxima) {
      seatBody.innerHTML = `<p class="seat-cta-title">El apartado abre en <span class="countdown-inline" data-cuenta="${esc(proxima.abre_en)}">${formatCuenta(new Date(proxima.abre_en) - Date.now())}</span></p>
        <p class="seat-cta-sub">Para el camión ${camionCorto(proxima.camion)}, ${esc(etiquetaDia(proxima.fecha).toLowerCase())} a las ${esc(horaTexto(proxima.hora))}. Se abre 12 horas antes.</p>
        <button class="btn btn-secondary btn-block" data-abrir-asientos="${esc(claveSalida(proxima))}">Ver el camión</button>`
    } else {
      seatBody.innerHTML = `<p class="seat-cta-title">Sin salidas próximas</p>
        <p class="seat-cta-sub" style="margin-bottom:0">Cuando haya salidas en el horario podrás apartar tu lugar aquí.</p>`
    }
  }

  seatBody.addEventListener('click', e => {
    const btn = e.target.closest('[data-abrir-asientos]')
    if (btn) abrirAsientos(btn.dataset.abrirAsientos)
  })

  // --- TARJETA "PAREJA DE VIAJE" ---
  function renderPairCard() {
    const { activa, enviada } = pareja
    if (activa) {
      const total = new Date(activa.expira_en) - new Date(activa.desde)
      const resta = new Date(activa.expira_en) - Date.now()
      const hasta = new Date(activa.expira_en).toLocaleDateString('es-MX', { timeZone: TZ, day: 'numeric', month: 'long' })
      pairBody.innerHTML = `<div class="pair-row">
          <span class="pair-avatars">${avatar(miNombre)}${avatar(activa.nombre)}<span class="pair-link">${icon('i-link')}</span></span>
          <div>
            <p class="pair-names">Tú y ${esc(activa.nombre)}</p>
            <p class="pair-sub">Juntos hasta el ${esc(hasta)}</p>
          </div>
        </div>
        <div class="progress pair-progress" style="--p:${Math.max(0, Math.min(1, resta / total)).toFixed(3)}"><span></span></div>
        <div class="pair-actions"><button class="btn btn-plain" data-pareja="terminar">Terminar pareja</button></div>`
    } else if (enviada) {
      pairBody.innerHTML = `<div class="pair-row">
          ${avatar(enviada.nombre)}
          <div>
            <p class="pair-names">Invitación enviada a ${esc(enviada.nombre)}</p>
            <p class="pair-sub">Esperando a que la acepte.</p>
          </div>
        </div>
        <button class="btn btn-secondary btn-block" data-pareja="cancelar" data-id="${esc(enviada.id)}">Cancelar invitación</button>`
    } else {
      pairBody.innerHTML = `<p class="pair-empty-title">Viaja junto a alguien</p>
        <p class="pair-empty-text">Invita a un compañero: durante un mes, cuando uno de los dos aparte asiento, el de al lado se apartará para el otro.</p>
        <button class="btn btn-tinted btn-block" data-pareja="invitar">${icon('i-send')}Invitar a un compañero</button>`
    }
  }

  pairBody.addEventListener('click', async e => {
    const btn = e.target.closest('[data-pareja]')
    if (!btn) return
    const accion = btn.dataset.pareja

    if (accion === 'invitar') {
      haptic(6)
      $('#invite-matricula').value = ''
      openSheet('sheet-invite')
      return
    }

    if (accion === 'cancelar') {
      setLoading(btn, true)
      const { error } = await rpc('pareja_cancelar_invitacion', { p_id: Number(btn.dataset.id) })
      if (error) toast(error.message, { type: 'error' })
      else toast('Invitación cancelada', { type: 'success' })
      cargarPareja()
      return
    }

    if (accion === 'terminar') {
      const ok = await confirm({
        title: '¿Terminar pareja?',
        message: `Ya no se apartarán asientos juntos con ${pareja.activa.nombre}. Los asientos que ya apartaron se conservan.`,
        confirmLabel: 'Terminar',
        destructive: true
      })
      if (!ok) return
      const { error } = await rpc('pareja_terminar')
      if (error) toast(error.message, { type: 'error' })
      else toast('Pareja terminada', { type: 'success' })
      cargarPareja()
      cargarSalidas()
    }
  })

  const formInvite = $('#form-invite')
  formInvite.addEventListener('submit', async e => {
    e.preventDefault()
    const input = $('#invite-matricula')
    const campo = input.closest('.field')
    const matricula = input.value.trim()
    if (!matricula) {
      campo.classList.add('is-invalid')
      shake(campo)
      input.focus()
      return
    }
    const btn = $('#btn-invite-send')
    setLoading(btn, true)
    const { data, error } = await rpc('pareja_invitar', { p_matricula: matricula })
    setLoading(btn, false)
    if (error) {
      toast(error.message, { type: 'error' })
      campo.classList.add('is-invalid')
      shake(campo)
      return
    }
    haptic([10, 40, 14])
    input.blur()
    await closeSheet('sheet-invite')
    toast(`Invitación enviada a ${data.nombre}`, { type: 'success' })
    cargarPareja()
  })
  formInvite.addEventListener('input', e => e.target.closest('.field')?.classList.remove('is-invalid'))

  // --- HOJA DEL MAPA ---
  async function abrirAsientos(clave) {
    if (!salidas.length) return
    const inicial = salidas.find(s => claveSalida(s) === clave) || salidas.find(s => s.mi_asiento) || salidas.find(s => s.abierta) || salidas[0]
    salidaSel = claveSalida(inicial)
    seleccion = null
    mapa = null
    busSeats.replaceChildren()
    $('#seat-hint').textContent = ''
    $('#bus-lock').hidden = true
    bus.classList.remove('is-locked')
    renderDepartures()
    renderFooter()
    haptic(8)
    openSheet('sheet-seats', { onClose: () => { salidaSel = null; mapa = null; seleccion = null } })
    departures.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'center' })
    await cargarMapa({ transicion: true })
  }

  function renderDepartures() {
    departures.innerHTML = salidas.map(s => {
      const k = claveSalida(s)
      const { t, p } = splitHora(s.hora)
      const estado = s.mi_asiento
        ? `${icon('i-check')}Asiento ${s.mi_asiento}`
        : s.abierta
          ? `${40 - s.ocupados} libres`
          : `${icon('i-lock')}${esc(new Date(s.abre_en).toLocaleTimeString('es-MX', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true }))}`
      return `<button class="departure${s.mi_asiento ? ' is-mine' : ''}" role="tab" aria-selected="${k === salidaSel}" data-salida="${esc(k)}" aria-label="Camión ${camionCorto(s.camion)}, ${esc(etiquetaDia(s.fecha))} ${esc(horaTexto(s.hora))}">
        <span class="departure-day">${esc(etiquetaDia(s.fecha))} · ${s.tipo === 'REGRESO' ? 'Regreso' : 'Ida'}</span>
        <span class="departure-time">${t}<small>${p}</small></span>
        <span class="departure-status"><span class="departure-bus">${icon('i-bus')}${s.camion}</span>${estado}</span>
      </button>`
    }).join('')
  }

  departures.addEventListener('click', e => {
    const btn = e.target.closest('[data-salida]')
    if (!btn || btn.dataset.salida === salidaSel) return
    haptic(5)
    salidaSel = btn.dataset.salida
    seleccion = null
    $$('.departure', departures).forEach(d => d.setAttribute('aria-selected', String(d === btn)))
    btn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
    cargarMapa({ transicion: true })
  })

  async function cargarMapa({ transicion = false, silencioso = false } = {}) {
    const s = salidas.find(x => claveSalida(x) === salidaSel)
    if (!s) return
    const turno = ++peticionMapa
    const { data, error } = await rpc('alumno_mapa', { p_fecha: s.fecha, p_hora: s.hora, p_camion: s.camion })
    // Ignora respuestas viejas si el alumno ya cambió de salida
    if (turno !== peticionMapa || claveSalida(s) !== salidaSel) return
    if (error) {
      if (!silencioso) toast(error.message, { type: 'error' })
      return
    }
    const anterior = mapa
    mapa = data
    if (seleccion && !mapa.asientos[seleccion - 1]?.sel) seleccion = null
    renderMapa(transicion || !anterior ? null : anterior)
  }

  function clasesAsiento(a) {
    const enPareja = mapa.modo === 'pareja' || mapa.modo === 'pareja_reacomodo'
    let cls = ''
    if (mapa.abierta && a.estado === 'libre' && !a.sel) cls += ' is-off'
    if (mapa.abierta && a.sel && a.mover) cls += ' is-move'
    if (seleccion === a.n) cls += ' is-selected'
    else if (enPareja && seleccion && a.n === vecino(seleccion)) cls += ' is-partner-pick'
    return cls
  }

  function etiquetaAsiento(a) {
    const estados = { libre: 'libre', ocupado: 'ocupado', mio: 'tu asiento', pareja: 'asiento de tu pareja' }
    return `Asiento ${a.n}, ${esVentana(a.n) ? 'ventana' : 'pasillo'}, ${estados[a.estado]}`
  }

  function htmlAsiento(a) {
    const bloqueado = !mapa.abierta || !a.sel
    return `<button type="button" class="seat${clasesAsiento(a)}" data-n="${a.n}" data-estado="${a.estado}" aria-label="${esc(etiquetaAsiento(a))}" aria-pressed="${seleccion === a.n}" aria-disabled="${bloqueado}">${a.n}</button>`
  }

  function construirAsientos() {
    const celdas = []
    for (let r = 0; r < FILAS; r++) {
      const fila = mapa.asientos.slice(r * 4, r * 4 + 4)
      celdas.push(htmlAsiento(fila[0]), htmlAsiento(fila[1]), `<span class="bus-row-label" aria-hidden="true">${r + 1}</span>`, htmlAsiento(fila[2]), htmlAsiento(fila[3]))
    }
    busSeats.innerHTML = celdas.join('')
    // Ola de entrada desde el frente del camión
    $$('.seat', busSeats).forEach(el => {
      const n = Number(el.dataset.n)
      el.animate(
        [{ opacity: 0, transform: 'translateY(10px) scale(0.85)' }, { opacity: 1, transform: 'none' }],
        { duration: 480, delay: (Math.ceil(n / 4) - 1) * 35 + ((n - 1) % 4) * 12, easing: EASE, fill: 'backwards' }
      )
    })
  }

  function actualizarAsientos(anterior) {
    $$('.seat', busSeats).forEach(el => {
      const n = Number(el.dataset.n)
      const a = mapa.asientos[n - 1]
      el.className = `seat${clasesAsiento(a)}`
      el.dataset.estado = a.estado
      el.setAttribute('aria-label', etiquetaAsiento(a))
      el.setAttribute('aria-pressed', String(seleccion === n))
      el.setAttribute('aria-disabled', String(!mapa.abierta || !a.sel))
      // Destello cuando un asiento cambia en vivo
      if (anterior && anterior.asientos[n - 1]?.estado !== a.estado) {
        el.classList.remove('is-pulse')
        void el.offsetWidth
        el.classList.add('is-pulse')
      }
    })
  }

  function renderMapa(anterior) {
    renderHint()
    $('#bus-name').textContent = `Camión ${camionCorto(mapa.camion)}`
    $('#legend-pair').hidden = !mapa.pareja
    bus.classList.toggle('is-locked', !mapa.abierta)
    $('#bus-lock').hidden = mapa.abierta
    if (!mapa.abierta) {
      const cuenta = $('#bus-lock-count')
      cuenta.dataset.cuenta = mapa.abre_en
      cuenta.textContent = formatCuenta(new Date(mapa.abre_en) - Date.now())
      $('#bus-lock-when').textContent = `Abre ${momentoTexto(mapa.abre_en)}`
    }
    if (!anterior || !busSeats.children.length) construirAsientos()
    else actualizarAsientos(anterior)
    renderFooter()
  }

  function renderHint() {
    const hint = $('#seat-hint')
    const nombre = esc(mapa.pareja?.nombre || '')
    if (!mapa.abierta) hint.innerHTML = 'Así se ve el camión. El apartado abre <b>12 horas antes</b> de la salida.'
    else if (mapa.modo === 'pareja') hint.innerHTML = `Viajas con <b>${nombre}</b>: elige una banca y se apartarán los dos asientos.`
    else if (mapa.modo === 'pareja_reacomodo') hint.innerHTML = 'Ya no quedan bancas libres. Elige una con un compañero sin pareja: <b>lo moveremos junto a otro compañero</b> y le avisaremos.'
    else if (mapa.modo === 'pareja_sin_banca') hint.innerHTML = 'Ya no hay forma de sentarse juntos en esta salida. <b>Puedes apartar solo tu asiento.</b>'
    else hint.textContent = 'Toca un asiento libre para apartarlo.'
  }

  function renderFooter() {
    const texto = $('#seat-selection')
    const mio = mapa?.asientos.find(a => a.estado === 'mio')
    const enPareja = mapa && (mapa.modo === 'pareja' || mapa.modo === 'pareja_reacomodo')
    btnRelease.hidden = !(mapa?.abierta && mio)
    btnConfirm.disabled = true

    if (!mapa) {
      texto.innerHTML = ''
      btnConfirm.textContent = 'Apartar asiento'
      return
    }
    if (!mapa.abierta) {
      texto.innerHTML = '<small>Podrás elegir tu lugar en cuanto abra el apartado</small>'
      btnConfirm.textContent = 'Apartar asiento'
      return
    }
    if (seleccion) {
      const a = mapa.asientos[seleccion - 1]
      if (enPareja) {
        const otro = vecino(seleccion)
        texto.innerHTML = `Asientos ${Math.min(seleccion, otro)} y ${Math.max(seleccion, otro)}
          <small>Tú en el ${seleccion} · ${esc(mapa.pareja.nombre)} en el ${otro}</small>
          ${a.mover ? '<small class="is-warning">Un compañero sin pareja cambiará de lugar</small>' : ''}`
        btnConfirm.textContent = mio ? 'Cambiar a esta banca' : 'Apartar para los dos'
      } else {
        texto.innerHTML = `Asiento ${seleccion}<small>${esVentana(seleccion) ? 'Ventana' : 'Pasillo'} · Fila ${Math.ceil(seleccion / 4)}</small>`
        btnConfirm.textContent = mio ? 'Cambiar a este asiento' : 'Apartar asiento'
      }
      btnConfirm.disabled = false
    } else if (mio) {
      texto.innerHTML = `Tu asiento: ${mio.n}<small>Toca otro asiento si quieres cambiarte</small>`
      btnConfirm.textContent = 'Apartar asiento'
    } else {
      texto.innerHTML = `<small>${enPareja ? 'Elige una banca para los dos' : 'Elige un asiento libre'}</small>`
      btnConfirm.textContent = enPareja ? 'Apartar para los dos' : 'Apartar asiento'
    }
  }

  busSeats.addEventListener('click', e => {
    const el = e.target.closest('.seat')
    if (!el || !mapa?.abierta) return
    const n = Number(el.dataset.n)
    const a = mapa.asientos[n - 1]
    if (!a.sel) {
      haptic(4)
      el.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-4px)' }, { transform: 'translateX(4px)' }, { transform: 'translateX(0)' }], { duration: 260 })
      return
    }
    seleccion = seleccion === n ? null : n
    haptic(6)
    actualizarAsientos(null)
    renderFooter()
  })

  btnConfirm.addEventListener('click', async () => {
    const s = salidas.find(x => claveSalida(x) === salidaSel)
    if (!seleccion || !mapa || !s) return
    const n = seleccion
    setLoading(btnConfirm, true)
    const { data, error } = await rpc('alumno_apartar', {
      p_fecha: s.fecha,
      p_hora: s.hora,
      p_camion: s.camion,
      p_asiento: n,
      p_solo: mapa.modo === 'pareja_sin_banca'
    })
    setLoading(btnConfirm, false)
    if (error) {
      toast(error.message, { type: 'error', duration: 4500 })
      seleccion = null
      cargarMapa()
      return
    }
    haptic([12, 50, 18])
    seleccion = null
    await Promise.all([cargarMapa(), cargarSalidas()])
    toast(data.asiento_pareja
      ? `Asientos ${Math.min(n, data.asiento_pareja)} y ${Math.max(n, data.asiento_pareja)} apartados`
      : data.pareja_debe
        ? `Asiento ${n} apartado solo para ti: tu pareja no está al corriente`
        : `Asiento ${n} apartado`, { type: data.pareja_debe ? 'warning' : 'success', duration: data.pareja_debe ? 4500 : 2800 })
    setTimeout(() => closeSheet('sheet-seats'), 1200)
  })

  btnRelease.addEventListener('click', async () => {
    const s = salidas.find(x => claveSalida(x) === salidaSel)
    if (!s) return
    const ok = await confirm({
      title: 'Liberar asiento',
      message: `Tu lugar quedará disponible para otros compañeros.${mapa?.pareja ? ' El asiento de tu pareja se conserva.' : ''}`,
      confirmLabel: 'Liberar',
      destructive: true
    })
    if (!ok) return
    setLoading(btnRelease, true)
    const { error } = await rpc('alumno_liberar_asiento', { p_fecha: s.fecha, p_hora: s.hora })
    setLoading(btnRelease, false)
    if (error) {
      toast(error.message, { type: 'error' })
      return
    }
    toast('Asiento liberado', { type: 'success' })
    seleccion = null
    await Promise.all([cargarMapa(), cargarSalidas()])
  })

  // --- TIEMPO REAL: la tabla "actividad" solo avisa que algo cambió ---
  supabase
    .channel('actividad_channel')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'actividad' }, ({ new: fila }) => {
      if (!activo) return
      if (salidaSel && fila?.clave === `salida:${salidaSel}`) cargarMapa({ silencioso: true })
      clearTimeout(refrescoTimer)
      refrescoTimer = setTimeout(() => {
        cargarSalidas()
        cargarPareja()
        cargarAvisos()
      }, 600)
    })
    .subscribe()

  return { cargar, limpiar }
}
