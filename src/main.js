import QRCode from 'qrcode'
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode'
import { supabase } from './supabase.js'
import {
  $, $$, esc, icon, avatar, emptyState, skeletonRows, haptic,
  initScreens, showScreen, initTabs, selectTab, initSegmented,
  initSheets, openSheet, closeSheet, closeAllSheets,
  confirm, actionSheet, toast, setLoading, shake, collapse,
  animateNumber, setDigits, revealWords, patchList, initPasswordToggles
} from './ui.js'

// --- 0. CONFIGURACIÓN Y ESTADO GLOBAL ---
const PRECIO_VIAJE = 30
const CAPACIDAD = 40
const GAUGE_C = 339.292 // circunferencia del anillo (r = 54)
const SESSION_KEY = 'camify.sesion'
const DIAS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes']
const DIAS_NOMBRE = { lunes: 'Lunes', martes: 'Martes', miercoles: 'Miércoles', jueves: 'Jueves', viernes: 'Viernes' }
const DIAS_CORTO = { lunes: 'Lun', martes: 'Mar', miercoles: 'Mié', jueves: 'Jue', viernes: 'Vie' }

const ROLES = {
  Estudiante: { icon: 'i-student', tint: 'blue', title: 'Estudiante', subtitle: 'Entra con tu matrícula y contraseña.', idLabel: 'Matrícula', screen: 'view-student', error: 'Número de control o contraseña incorrectos.' },
  Chofer: { icon: 'i-wheel', tint: 'orange', title: 'Chofer', subtitle: 'Entra con tu número de licencia.', idLabel: 'Número de licencia', screen: 'view-driver', error: 'Número de licencia o contraseña incorrectos.' },
  Admin: { icon: 'i-shield', tint: 'indigo', title: 'Administración', subtitle: 'Acceso para gestionar usuarios y saldos.', idLabel: 'Usuario', screen: 'view-admin', error: 'Usuario o contraseña incorrectos.' }
}
const ROL_ETIQUETA = { Estudiante: 'Alumno', Chofer: 'Chofer', Admin: 'Admin' }

let currentRole = ''
let sessionToken = null
let sesionExpirada = false
let passengers = []
let copyPassengers = [] // Copia para el comprobante
let html5QrcodeScanner = null
let allUsersCache = []
let alumnosCache = []
let currentFilter = 'Todos'
let currentStudentMatricula = null
let estadoViaje = 'ESPERANDO'
let isTripActive = false
let scheduleRows = []
let isEditingSchedule = false
let editingUser = null
let editingAlumno = null
let timerInterval = null
let targetEndTime = null
let timerTotalMs = 5 * 60 * 1000

// --- 1. FORMATO ---
const money = new Intl.NumberFormat('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtMoney = n => `$${money.format(Number(n) || 0)}`
const fmtFecha = d => d.toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' })
const fmtFechaLarga = d => d.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' })
const fmtHora = d => d.toLocaleTimeString('es-MX', { hour: 'numeric', minute: '2-digit', hour12: true })
const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`
const primerNombre = nombre => String(nombre ?? '').trim().split(/\s+/)[0] || ''

function formatMMSS(ms) {
  const total = Math.ceil(ms / 1000)
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

// '14:30' → { t: '2:30', p: 'p. m.' }
function splitHora(hhmm) {
  const [h, m] = hhmm.split(':').map(Number)
  return { t: `${h % 12 || 12}:${String(m).padStart(2, '0')}`, p: h < 12 ? 'a. m.' : 'p. m.' }
}

function saludo() {
  const h = new Date().getHours()
  return h < 12 ? 'Buenos días' : h < 19 ? 'Buenas tardes' : 'Buenas noches'
}

function diaHoy() {
  const d = new Date().getDay()
  return d >= 1 && d <= 5 ? DIAS[d - 1] : null
}

// --- 2. INICIALIZACIÓN DE LA INTERFAZ ---
initScreens()
initSheets()
initPasswordToggles()
initTabs($('#view-driver'))
initTabs($('#view-admin'))

const rolesTitle = $('#roles-title')
const loginForm = $('#login-form')
const inputControl = $('#input-control')
const inputPassword = $('#input-password')
const errorMessage = $('#error-message')
const btnLogin = $('#btn-login')
const btnIniciarViaje = $('#btn-iniciar-viaje')

// --- 3. SESIÓN ---
function guardarSesion(sesion) {
  sessionToken = sesion.token
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(sesion)) } catch { /* modo privado */ }
}

function leerSesion() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)) } catch { return null }
}

function borrarSesion() {
  sessionToken = null
  try { localStorage.removeItem(SESSION_KEY) } catch { /* modo privado */ }
}

// Llama una función RPC con el token de la sesión activa
async function rpc(nombre, params = {}) {
  const res = await supabase.rpc(nombre, { p_token: sessionToken, ...params })
  if (res.error?.code === '28000' && !sesionExpirada) {
    sesionExpirada = true
    toast('Tu sesión expiró. Vuelve a entrar.', { type: 'warning' })
    cerrarSesion()
  }
  return res
}

function entrar(rol, perfil, transition = 'fade') {
  currentRole = rol
  sesionExpirada = false
  if (rol === 'Estudiante') iniciarAlumno(perfil)
  else if (rol === 'Chofer') iniciarChofer(perfil)
  else iniciarAdmin()
  return showScreen(ROLES[rol].screen, transition)
}

function cerrarSesion() {
  // supabase-js solo envía la petición al consumir la promesa
  if (sessionToken) supabase.rpc('logout', { p_token: sessionToken }).then(() => {}, () => {})
  borrarSesion()
  stopScanner()
  closeAllSheets()
  passengers = []
  currentStudentMatricula = null
  allUsersCache = []
  loginForm.reset()
  showScreen('view-roles', 'fade')
  revealWords(rolesTitle)
}

$$('[data-logout]').forEach(btn => btn.addEventListener('click', async () => {
  const ok = await confirm({ title: '¿Cerrar sesión?', message: 'Tendrás que volver a ingresar tus datos.', confirmLabel: 'Cerrar sesión', destructive: true })
  if (ok) cerrarSesion()
}))

// --- 4. SELECCIÓN DE ROL Y LOGIN ---
$$('.role-card').forEach(card => card.addEventListener('click', () => {
  haptic(8)
  abrirLogin(card.dataset.role)
}))

function abrirLogin(rol) {
  currentRole = rol
  const cfg = ROLES[rol]
  $('#login-title').textContent = cfg.title
  $('#login-subtitle').textContent = cfg.subtitle
  $('#label-control').textContent = cfg.idLabel
  $('#login-icon').className = `app-icon app-icon-xl tint-${cfg.tint}`
  $('#login-icon use').setAttribute('href', `#${cfg.icon}`)
  $('#view-login').dataset.tint = cfg.tint
  loginForm.reset()
  ocultarError()
  showScreen('view-login', 'push')
}

$('#btn-back').addEventListener('click', () => {
  inputControl.blur()
  inputPassword.blur()
  showScreen('view-roles', 'pop')
})

function mostrarError(msg) {
  errorMessage.innerHTML = `${icon('i-alert')}<span>${esc(msg)}</span>`
  errorMessage.hidden = false
  errorMessage.animate([{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], { duration: 300 })
}

function ocultarError() {
  errorMessage.hidden = true
  $$('.field', loginForm).forEach(f => f.classList.remove('is-invalid'))
}

$$('input', loginForm).forEach(input => input.addEventListener('input', ocultarError))

inputControl.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault()
    inputPassword.focus()
  }
})

loginForm.addEventListener('submit', async e => {
  e.preventDefault()
  ocultarError()

  const control = inputControl.value.trim()
  const password = inputPassword.value.trim()

  if (!control || !password) {
    const vacio = !control ? inputControl : inputPassword
    vacio.closest('.field').classList.add('is-invalid')
    mostrarError('Completa ambos campos para continuar.')
    shake($('#login-fields'))
    vacio.focus()
    return
  }

  // La contraseña se valida en Supabase (hash bcrypt); el cliente solo recibe un token de sesión
  setLoading(btnLogin, true)
  const { data: sesion, error } = await supabase.rpc('login', {
    p_rol: currentRole,
    p_identificador: control,
    p_password: password
  })
  setLoading(btnLogin, false)

  if (error || !sesion) {
    mostrarError(error ? 'No pudimos conectar. Intenta de nuevo.' : ROLES[currentRole].error)
    $$('.field', loginForm).forEach(f => f.classList.add('is-invalid'))
    shake($('#login-fields'))
    return
  }

  haptic([10, 40, 14])
  inputControl.blur()
  inputPassword.blur()
  guardarSesion({ token: sesion.token, rol: currentRole, perfil: sesion.perfil })
  entrar(currentRole, sesion.perfil)
})

// --- 5. ALUMNO ---
const studentDays = initSegmented($('#student-days'), () => {
  $('#student-schedule-list').replaceChildren()
  renderStudentSchedule()
})

function iniciarAlumno(perfil) {
  currentStudentMatricula = perfil.matricula
  $('#student-greeting').textContent = saludo()
  $('#student-balance').dataset.value = '0'
  renderPerfilAlumno(perfil)

  const hoy = diaHoy()
  $$('#student-days button').forEach(b => b.classList.toggle('is-today', b.dataset.value === hoy))
  studentDays.select(hoy || 'lunes', false)

  $('#student-history-list').innerHTML = skeletonRows(3)
  $('#student-schedule-list').replaceChildren()
  renderStudentSchedule()
  renderTripCard()
  refrescarAlumno()
}

function renderPerfilAlumno(perfil) {
  $('#student-name').textContent = perfil.nombre
  $('#student-nav-title').textContent = primerNombre(perfil.nombre)
  $('#student-control').textContent = perfil.matricula
  $('#qr-name').textContent = perfil.nombre
  $('#modal-student-id').textContent = perfil.matricula

  const saldo = Number(perfil.saldo) || 0
  animateNumber($('#student-balance'), saldo, { decimals: 2 })
  $('#student-balance-card').dataset.state = saldo > 0 ? 'due' : 'clear'
  const viajes = saldo / PRECIO_VIAJE
  $('#student-balance-status').textContent = saldo <= 0
    ? 'Estás al corriente'
    : Number.isInteger(viajes) ? `${plural(viajes, 'viaje', 'viajes')} por pagar` : 'Pendiente de pago'
}

// Refresca saldo e historial del alumno (por ejemplo, después de un corte)
async function refrescarAlumno() {
  const { data: perfil } = await rpc('alumno_perfil')
  if (perfil) renderPerfilAlumno(perfil)
  cargarHistorialAlumno()
}

async function cargarHistorialAlumno() {
  const { data: viajes, error } = await rpc('alumno_historial')
  if (error) return

  $('#student-history-meta').textContent = viajes.length ? plural(viajes.length, 'viaje', 'viajes') : ''
  patchList($('#student-history-list'), viajes, {
    key: v => v.id,
    render: v => {
      const f = new Date(v.fecha_hora)
      return `<div class="row">
        <span class="row-icon">${icon('i-bus')}</span>
        <span class="row-text"><span class="row-title">Viaje cobrado</span><span class="row-sub">${esc(fmtFecha(f))} · ${esc(fmtHora(f))}</span></span>
        <span class="row-trailing">${fmtMoney(v.monto)}</span>
      </div>`
    },
    empty: emptyState('i-receipt', 'Sin viajes todavía', 'Tus viajes cobrados aparecerán aquí.')
  })
}

$('#btn-show-qr').addEventListener('click', () => {
  haptic(8)
  QRCode.toCanvas($('#qr-canvas'), currentStudentMatricula, {
    width: 640,
    margin: 1,
    errorCorrectionLevel: 'M',
    color: { dark: '#000000', light: '#ffffff' }
  })
  openSheet('sheet-qr')
})

// Tarjeta de estado del viaje del alumno
const TRIP_COPY = {
  waiting: { label: 'Esperando', headline: 'Sin salida programada', sub: 'Cuando el chofer inicie el conteo lo verás aquí en tiempo real.' },
  countdown: { label: 'Abordando', headline: '', sub: 'Muestra tu código al chofer antes de que termine el tiempo.' },
  departing: { label: 'Saliendo', headline: '¡Es hora de salir!', sub: 'El camión está por partir.' },
  enroute: { label: 'En camino', headline: 'Viaje en curso', sub: 'Buen viaje. Tu saldo ya incluye este recorrido.' }
}

function estadoTarjeta() {
  const ahora = Date.now()
  if (estadoViaje === 'EN_CAMINO') return 'enroute'
  if (targetEndTime && targetEndTime > ahora) return 'countdown'
  if (targetEndTime && ahora - targetEndTime < 10 * 60 * 1000) return 'departing'
  return 'waiting'
}

function renderTripCard() {
  const card = $('#trip-card')
  const state = estadoTarjeta()
  if (card.dataset.state === state && card.dataset.ready) return
  card.dataset.ready = '1'
  const anterior = card.dataset.state
  card.dataset.state = state
  card.classList.toggle('is-live', state !== 'waiting')

  const copy = TRIP_COPY[state]
  $('#trip-status-label').textContent = copy.label
  $('#trip-headline').textContent = copy.headline
  $('#trip-headline').hidden = !copy.headline
  $('#trip-sub').textContent = copy.sub
  $('#trip-kicker').hidden = state !== 'countdown'
  $('#timer-student-display').hidden = state !== 'countdown'
  $('#timer-student-progress').hidden = state !== 'countdown'

  if (anterior && anterior !== state) {
    $('#trip-main').animate([{ opacity: 0, transform: 'translateY(8px)', filter: 'blur(6px)' }, { opacity: 1, transform: 'none', filter: 'blur(0)' }], { duration: 520, easing: 'cubic-bezier(0.25, 1, 0.5, 1)' })
    if (currentRole === 'Estudiante' && (state === 'countdown' || state === 'enroute')) haptic([12, 50, 12])
  }
}

// --- 6. HORARIOS ---
async function fetchScheduleMatrix() {
  const { data, error } = await supabase
    .from('horarios_matriz')
    .select('*')
    .order('created_at', { ascending: true })

  if (error || !data) return
  scheduleRows = data
  renderStudentSchedule()
  if (!isEditingSchedule) renderDriverSchedule()
}

function renderStudentSchedule() {
  const list = $('#student-schedule-list')
  const dia = studentDays.value
  const salidas = scheduleRows
    .map(r => ({ id: r.id, ...(r[dia] || {}) }))
    .filter(s => s.hora)
    .sort((a, b) => a.hora.localeCompare(b.hora))

  const ahora = new Date()
  const hhmm = `${String(ahora.getHours()).padStart(2, '0')}:${String(ahora.getMinutes()).padStart(2, '0')}`
  const proxima = dia === diaHoy() ? salidas.find(s => s.hora > hhmm) : null

  $('#student-schedule-meta').textContent = salidas.length ? plural(salidas.length, 'salida', 'salidas') : ''
  patchList(list, salidas, {
    key: s => s.id,
    render: s => {
      const { t, p } = splitHora(s.hora)
      const ida = (s.tipo || 'IDA') === 'IDA'
      const esProxima = s === proxima
      return `<div class="row schedule-row${esProxima ? ' is-next' : ''}">
        <span class="schedule-time">${t}<small>${p}</small></span>
        <span class="badge ${ida ? 'badge-ida' : 'badge-regreso'}">${icon(ida ? 'i-arrow-right' : 'i-arrow-left')}${ida ? 'Ida' : 'Regreso'}</span>
        ${esProxima ? '<span class="next-tag is-live"><span class="status-dot"></span>Próxima</span>' : ''}
      </div>`
    },
    empty: emptyState('i-calendar', 'Sin salidas', `No hay salidas programadas el ${DIAS_NOMBRE[dia].toLowerCase()}.`)
  })
}

function renderDriverSchedule() {
  patchList($('#driver-schedule-list'), scheduleRows, {
    key: r => r.id,
    render: (r, i) => `<article class="card schedule-card" data-id="${esc(r.id)}">
      <header class="schedule-card-header">
        <h3>Salida ${i + 1}</h3>
        <span class="saved-tag">${icon('i-check')}Guardado</span>
        <button type="button" class="icon-btn icon-btn-sm icon-btn-danger btn-delete-row" data-id="${esc(r.id)}" aria-label="Eliminar salida ${i + 1}">${icon('i-trash')}</button>
      </header>
      ${DIAS.map(dia => {
        const c = r[dia] || {}
        const tipo = c.tipo === 'REGRESO' ? 'REGRESO' : 'IDA'
        return `<div class="schedule-day">
          <span class="schedule-day-name"><span class="long">${DIAS_NOMBRE[dia]}</span><span class="short">${DIAS_CORTO[dia]}</span></span>
          <input type="time" class="time-input schedule-time-input" data-dia="${dia}" value="${esc(c.hora || '')}" data-saved="${esc(c.hora || '')}" aria-label="Hora del ${DIAS_NOMBRE[dia]}">
          <button type="button" class="type-toggle ${tipo === 'IDA' ? 'is-ida' : 'is-regreso'}" data-dia="${dia}" data-tipo="${tipo}">${tipo === 'IDA' ? 'Ida' : 'Regreso'}</button>
        </div>`
      }).join('')}
    </article>`,
    empty: emptyState('i-calendar', 'Sin horarios', 'Agrega la primera salida de la semana.')
  })
}

async function guardarDia(card, dia) {
  const input = card.querySelector(`input[data-dia="${dia}"]`)
  const btn = card.querySelector(`.type-toggle[data-dia="${dia}"]`)
  const valor = { hora: input.value, tipo: btn.dataset.tipo }
  const id = Number(card.dataset.id)

  const { error } = await rpc('chofer_horario_actualizar', { p_id: id, p_dia: dia, p_valor: valor })
  if (error) {
    toast('No se guardó el cambio', { type: 'error' })
    return
  }
  input.dataset.saved = input.value
  const fila = scheduleRows.find(r => r.id === id)
  if (fila) fila[dia] = valor
  renderStudentSchedule()

  card.classList.add('is-saved')
  clearTimeout(card._savedTimer)
  card._savedTimer = setTimeout(() => card.classList.remove('is-saved'), 1600)
}

const driverScheduleList = $('#driver-schedule-list')

// Al enfocar una hora vacía se propone la de un día vecino
driverScheduleList.addEventListener('focusin', e => {
  if (!e.target.classList.contains('schedule-time-input')) return
  isEditingSchedule = true
  if (e.target.value) return

  const inputs = $$('.schedule-time-input', e.target.closest('.schedule-card'))
  const idx = inputs.indexOf(e.target)
  const vecino = [...inputs.slice(0, idx).reverse(), ...inputs.slice(idx + 1)].find(i => i.value)
  if (vecino) e.target.value = vecino.value
})

driverScheduleList.addEventListener('focusout', e => {
  if (!e.target.classList.contains('schedule-time-input')) return
  isEditingSchedule = false
  if (e.target.value !== e.target.dataset.saved) guardarDia(e.target.closest('.schedule-card'), e.target.dataset.dia)
})

driverScheduleList.addEventListener('click', async e => {
  const toggle = e.target.closest('.type-toggle')
  if (toggle) {
    const nuevo = toggle.dataset.tipo === 'IDA' ? 'REGRESO' : 'IDA'
    toggle.dataset.tipo = nuevo
    toggle.textContent = nuevo === 'IDA' ? 'Ida' : 'Regreso'
    toggle.className = `type-toggle ${nuevo === 'IDA' ? 'is-ida' : 'is-regreso'}`
    toggle.animate([{ transform: 'scale(0.9)' }, { transform: 'scale(1)' }], { duration: 380, easing: 'cubic-bezier(0.34, 1.4, 0.64, 1)' })
    haptic(6)
    guardarDia(toggle.closest('.schedule-card'), toggle.dataset.dia)
    return
  }

  const borrar = e.target.closest('.btn-delete-row')
  if (borrar) {
    const ok = await confirm({ title: 'Eliminar salida', message: 'Se quitará esta salida de todos los días.', confirmLabel: 'Eliminar', destructive: true })
    if (!ok) return
    const { error } = await rpc('chofer_horario_eliminar', { p_id: Number(borrar.dataset.id) })
    if (error) toast('No se pudo eliminar', { type: 'error' })
    else fetchScheduleMatrix()
  }
})

$('#btn-add-schedule-row').addEventListener('click', async e => {
  const btn = e.currentTarget
  setLoading(btn, true)
  const { error } = await rpc('chofer_horario_agregar')
  setLoading(btn, false)
  if (error) {
    toast('No se pudo agregar la salida', { type: 'error' })
    return
  }
  await fetchScheduleMatrix()
  const panel = $('#driver-tab-schedule')
  panel.scrollTo({ top: panel.scrollHeight, behavior: 'smooth' })
})

// --- 7. CHOFER: ABORDAJE ---
function iniciarChofer(perfil) {
  $('#driver-name').textContent = `Hola, ${primerNombre(perfil.nombre)}`
  $('#driver-license').textContent = `Licencia ${perfil.licencia}`
  $('#passengers-count').dataset.value = '0'
  selectTab($('#view-driver'), 'driver-tab-trip', { animate: false })
  $('#students-ul').innerHTML = skeletonRows(3)
  isTripActive = estadoViaje === 'EN_CAMINO'
  renderDriverTrip()
  fetchPassengers()
  renderDriverSchedule()
}

async function fetchPassengers() {
  const { data, error } = await rpc('chofer_abordajes')
  if (error) {
    console.error('Error al cargar pasajeros:', error)
    return
  }
  passengers = data
  renderPassengersUI()
}

function renderPassengersUI() {
  const n = passengers.length
  animateNumber($('#passengers-count'), n, { duration: 700 })
  $('#gauge-fill').style.strokeDashoffset = String(GAUGE_C * (1 - Math.min(n, CAPACIDAD) / CAPACIDAD))
  $('#driver-hero').dataset.level = n >= CAPACIDAD ? 'full' : n >= CAPACIDAD - 5 ? 'high' : 'normal'
  $('#scanner-count').textContent = `${n} de ${CAPACIDAD} a bordo`
  $('#btn-clear-list').hidden = n === 0

  patchList($('#students-ul'), passengers, {
    key: p => p.id,
    render: p => `<div class="row">
      ${avatar(p.nombre)}
      <span class="row-text"><span class="row-title">${esc(p.nombre)}</span><span class="row-sub">${esc(p.matricula)}</span></span>
      <button class="icon-btn icon-btn-sm icon-btn-danger btn-remove-student" data-id="${esc(p.id)}" aria-label="Quitar a ${esc(p.nombre)}">${icon('i-minus')}</button>
    </div>`,
    empty: emptyState('i-users', 'Nadie a bordo', 'Toca Escanear para registrar a cada alumno al subir.')
  })

  renderDriverTrip()
}

function renderDriverTrip() {
  const n = passengers.length
  const hero = $('#driver-hero')
  hero.dataset.state = isTripActive ? 'enroute' : 'boarding'
  hero.classList.toggle('is-live', isTripActive)
  $('#driver-trip-status').textContent = isTripActive ? 'En camino' : 'Abordando'
  $('#driver-trip-headline').textContent = isTripActive ? 'Viaje en curso' : n >= CAPACIDAD ? 'Unidad llena' : 'Lista abierta'
  $('#driver-trip-sub').textContent = isTripActive
    ? 'Corte realizado. Finaliza el viaje al llegar.'
    : n ? `Quedan ${CAPACIDAD - n} lugares disponibles.` : 'Escanea el código de cada alumno al subir.'

  const corte = $('#corte-card')
  corte.dataset.state = isTripActive ? 'active' : 'idle'
  $('#corte-label').textContent = isTripActive ? 'Cobrado en este viaje' : 'Total del corte'
  $('#corte-total').textContent = fmtMoney(n * PRECIO_VIAJE)
  $('#corte-detail').textContent = `${n} × ${fmtMoney(PRECIO_VIAJE)}`
  if (!btnIniciarViaje.classList.contains('is-loading')) {
    btnIniciarViaje.textContent = isTripActive ? 'Finalizar viaje' : 'Hacer corte'
    btnIniciarViaje.disabled = !isTripActive && n === 0
  }
}

// Quitar un alumno (optimista: desaparece al instante)
$('#students-ul').addEventListener('click', async e => {
  const btn = e.target.closest('.btn-remove-student')
  if (!btn) return
  const id = Number(btn.dataset.id)
  haptic(8)
  passengers = passengers.filter(p => p.id !== id)
  renderPassengersUI()
  const { error } = await rpc('chofer_quitar_abordaje', { p_id: id })
  if (error) {
    toast('No se pudo quitar al alumno', { type: 'error' })
    fetchPassengers()
  }
})

$('#btn-clear-list').addEventListener('click', async () => {
  if (!passengers.length) return
  const ok = await confirm({
    title: 'Vaciar lista',
    message: `Se quitarán ${plural(passengers.length, 'alumno', 'alumnos')} sin cobrarles.`,
    confirmLabel: 'Vaciar',
    destructive: true
  })
  if (!ok) return

  const { error } = await rpc('chofer_vaciar_abordajes')
  if (error) {
    toast(`Error al vaciar: ${error.message}`, { type: 'error' })
    return
  }
  passengers = []
  renderPassengersUI()
  toast('Lista vaciada', { type: 'success' })
})

// --- 8. CORTE Y COMPROBANTE ---
btnIniciarViaje.addEventListener('click', async () => {
  if (isTripActive) {
    copyPassengers = [...passengers]
    renderComprobante()
    openSheet('sheet-receipt')
    return
  }

  const n = passengers.length
  if (!n) return
  const ok = await confirm({
    title: 'Hacer corte',
    message: `Se cobrarán ${fmtMoney(PRECIO_VIAJE)} a cada uno de los ${plural(n, 'alumno', 'alumnos')} a bordo.`,
    confirmLabel: `Cobrar ${fmtMoney(n * PRECIO_VIAJE)}`
  })
  if (!ok) return

  // Cobro, historial y estado EN_CAMINO en una sola transacción en Supabase
  setLoading(btnIniciarViaje, true)
  const { data: totalCobrados, error } = await rpc('chofer_hacer_corte')
  setLoading(btnIniciarViaje, false)

  if (error) {
    toast(error.message || 'No se pudo hacer el corte', { type: 'error' })
    renderDriverTrip()
    return
  }

  estadoViaje = 'EN_CAMINO'
  isTripActive = true
  haptic([15, 60, 15])
  toast(`Corte listo: ${plural(totalCobrados, 'alumno cobrado', 'alumnos cobrados')}`, { type: 'success' })
  await fetchPassengers()
  renderDriverTrip()
})

function renderComprobante() {
  const ahora = new Date()
  const n = copyPassengers.length
  $('#comprobante-fecha-hora').textContent = `${fmtFechaLarga(ahora)} · ${fmtHora(ahora)}`
  $('#comprobante-total').textContent = fmtMoney(n * PRECIO_VIAJE)
  $('#comprobante-detalle').textContent = `${plural(n, 'alumno', 'alumnos')} × ${fmtMoney(PRECIO_VIAJE)}`
  $('#tbody-comprobante').innerHTML = n
    ? copyPassengers.map((p, i) => `<div class="row receipt-row">
        <span class="receipt-index">${i + 1}</span>
        <span class="row-text"><span class="row-title">${esc(p.nombre || 'Alumno')}</span><span class="row-sub">${esc(p.matricula)}</span></span>
        <span class="row-trailing">${fmtMoney(PRECIO_VIAJE)}</span>
      </div>`).join('')
    : emptyState('i-users', 'Sin pasajeros', 'La lista se vació antes de finalizar.')
}

$('#btn-cerrar-comprobante').addEventListener('click', async e => {
  const btn = e.currentTarget
  setLoading(btn, true)
  const { error } = await rpc('chofer_finalizar_viaje')
  setLoading(btn, false)
  if (error) {
    toast('No se pudo finalizar el viaje', { type: 'error' })
    return
  }
  passengers = []
  estadoViaje = 'ESPERANDO'
  isTripActive = false
  renderPassengersUI()
  await closeSheet('sheet-receipt')
  haptic([10, 40, 10])
  toast('Viaje finalizado', { type: 'success' })
})

// --- 9. ESCÁNER QR (continuo: registra varios alumnos sin cerrar) ---
const scanner = $('#scanner')
const scanFeedback = $('#scan-feedback')
let isProcessingScan = false
let ultimoEscaneo = { texto: '', en: 0 }
let feedbackTimer = null

function setScanFeedback(texto, tipo = 'info', { volver = 0 } = {}) {
  scanFeedback.textContent = texto
  scanFeedback.dataset.type = tipo
  clearTimeout(feedbackTimer)
  if (volver) feedbackTimer = setTimeout(() => setScanFeedback('Apunta al código del siguiente alumno'), volver)
}

function flash(tipo) {
  delete scanner.dataset.flash
  void scanner.offsetWidth
  scanner.dataset.flash = tipo
}

$('#btn-open-scanner').addEventListener('click', async () => {
  haptic(8)
  isProcessingScan = false
  ultimoEscaneo = { texto: '', en: 0 }
  setScanFeedback('Iniciando cámara…')
  await openSheet('sheet-scanner', { onClose: stopScanner })

  if (!html5QrcodeScanner) {
    html5QrcodeScanner = new Html5Qrcode('reader', { verbose: false, formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE] })
  }
  try {
    await html5QrcodeScanner.start({ facingMode: 'environment' }, { fps: 12, aspectRatio: 1, disableFlip: true }, onScanSuccess, () => {})
    scanner.classList.add('is-live')
    setScanFeedback('Apunta al código QR del alumno')
  } catch {
    setScanFeedback('No pudimos abrir la cámara. Revisa los permisos.', 'error')
  }
})

async function stopScanner() {
  scanner.classList.remove('is-live')
  clearTimeout(feedbackTimer)
  try {
    if (html5QrcodeScanner?.isScanning) await html5QrcodeScanner.stop()
  } catch { /* la cámara ya estaba detenida */ }
}

function liberarEscaner(ms) {
  setTimeout(() => { isProcessingScan = false }, ms)
}

async function onScanSuccess(decodedText) {
  const scannedId = String(decodedText).trim()
  const ahora = Date.now()
  if (isProcessingScan) return
  // Ignora el mismo código mientras sigue frente a la cámara
  if (scannedId === ultimoEscaneo.texto && ahora - ultimoEscaneo.en < 4000) return
  isProcessingScan = true
  ultimoEscaneo = { texto: scannedId, en: ahora }

  if (passengers.length >= CAPACIDAD) {
    flash('error')
    haptic([30, 50, 30])
    setScanFeedback(`Unidad llena (máximo ${CAPACIDAD} pasajeros)`, 'error', { volver: 2200 })
    return liberarEscaner(1500)
  }

  if (passengers.some(p => String(p.matricula).trim() === scannedId)) {
    haptic([20, 40, 20])
    setScanFeedback(`${scannedId} ya está a bordo`, 'warning', { volver: 2000 })
    return liberarEscaner(1200)
  }

  setScanFeedback('Validando…')

  // Supabase valida la matrícula, el límite de 40 y los duplicados
  const { data: nombre, error } = await rpc('chofer_registrar_abordaje', { p_matricula: scannedId })

  if (error) {
    console.error('Error al registrar abordaje:', error)
    flash('error')
    haptic([30, 50, 30])
    setScanFeedback(error.message, 'error', { volver: 2400 })
    return liberarEscaner(1500)
  }

  flash('success')
  haptic(30)
  setScanFeedback(`${primerNombre(nombre)} está a bordo`, 'success', { volver: 1800 })
  await fetchPassengers()
  liberarEscaner(1100)
}

// --- 10. TEMPORIZADOR EN TIEMPO REAL ---
const btnTimerStart = $('#btn-timer-start')
const btnTimerAdd = $('#btn-timer-add')
const btnTimerStop = $('#btn-timer-stop')

function startLocalTimer(isoEndTime) {
  const nuevo = isoEndTime ? new Date(isoEndTime).getTime() : null
  const ahora = Date.now()
  if (nuevo && nuevo > ahora) {
    const restante = nuevo - ahora
    // Conteo nuevo: la barra parte llena; con +1 min crece la duración total
    if (!targetEndTime || targetEndTime <= ahora) timerTotalMs = Math.max(5 * 60 * 1000, restante)
    else if (restante > timerTotalMs) timerTotalMs = restante
  }
  targetEndTime = nuevo

  clearInterval(timerInterval)
  timerInterval = null
  if (targetEndTime && targetEndTime > ahora) timerInterval = setInterval(tickTimer, 250)
  tickTimer()
}

function tickTimer() {
  const ahora = Date.now()
  const restante = targetEndTime ? Math.max(0, targetEndTime - ahora) : 0
  const contando = restante > 0
  const terminado = !!targetEndTime && !contando && ahora - targetEndTime < 10 * 60 * 1000

  if (!contando && timerInterval) {
    clearInterval(timerInterval)
    timerInterval = null
    haptic([40, 60, 40])
  }

  const texto = contando ? formatMMSS(restante) : terminado ? '00:00' : '05:00'
  const progreso = contando ? restante / timerTotalMs : 0

  // Chofer
  const card = $('#driver-timer-card')
  card.dataset.state = contando ? 'counting' : terminado ? 'done' : 'idle'
  setDigits($('#driver-timer-display'), texto)
  $('#driver-timer-progress').style.setProperty('--p', progreso)
  $('#driver-timer-caption').textContent = contando ? 'Restante para la salida' : terminado ? '¡Hora de salir!' : 'Listo para iniciar el conteo'
  btnTimerStart.hidden = contando
  btnTimerStart.textContent = terminado ? 'Reiniciar 5 min' : 'Iniciar 5 min'
  btnTimerAdd.hidden = !contando
  btnTimerStop.hidden = !contando && !terminado
  btnTimerStop.textContent = contando ? 'Cancelar' : 'Restablecer'

  // Alumno
  setDigits($('#timer-student-display'), texto)
  $('#timer-student-progress').style.setProperty('--p', progreso)
  renderTripCard()
}

async function accionTemporizador(accion, btn) {
  haptic(8)
  setLoading(btn, true)
  const { error } = await rpc('chofer_temporizador', { p_accion: accion })
  setLoading(btn, false)
  if (error) toast('No se pudo actualizar el temporizador', { type: 'error' })
  else cargarEstadoViaje()
}

btnTimerStart.addEventListener('click', () => accionTemporizador('iniciar', btnTimerStart))
btnTimerAdd.addEventListener('click', () => accionTemporizador('agregar', btnTimerAdd))
btnTimerStop.addEventListener('click', () => accionTemporizador('cancelar', btnTimerStop))

// Estado del viaje y temporizador (lectura pública)
async function cargarEstadoViaje() {
  const { data } = await supabase
    .from('estado_viaje')
    .select('estado, tiempo_salida, temporizador_activo')
    .eq('id', 1)
    .maybeSingle()
  return aplicarEstadoViaje(data)
}

function aplicarEstadoViaje(row) {
  if (!row) return false
  const cambio = row.estado !== estadoViaje
  estadoViaje = row.estado
  isTripActive = estadoViaje === 'EN_CAMINO'
  startLocalTimer(row.temporizador_activo ? row.tiempo_salida : null)
  renderTripCard()
  renderDriverTrip()
  return cambio
}

// --- 11. ADMINISTRACIÓN ---
const adminRole = initSegmented($('#admin-role-seg'), aplicarRolRegistro)
const formCreateUser = $('#form-create-user')

function aplicarRolRegistro(rol) {
  $('#label-admin-identifier').textContent = ROLES[rol].idLabel
  collapse($('#group-admin-name'), rol === 'Admin')
  collapse($('#group-admin-initial-balance'), rol !== 'Estudiante')
}

function iniciarAdmin() {
  selectTab($('#view-admin'), 'admin-tab-register', { animate: false })
  aplicarRolRegistro(adminRole.value)
  $('#admin-users-ul').innerHTML = skeletonRows(4)
  $('#admin-balances-ul').innerHTML = skeletonRows(4)
  $('#admin-total-balance').dataset.value = '0'
  loadAdminData()
}

formCreateUser.addEventListener('submit', async e => {
  e.preventDefault()
  const role = adminRole.value
  const nameInput = $('#admin-new-name')
  const idInput = $('#admin-new-identifier')
  const passInput = $('#admin-new-password')
  const identifier = idInput.value.trim()
  const name = role === 'Admin' ? identifier : nameInput.value.trim()
  const password = passInput.value.trim()
  const balance = parseFloat($('#admin-new-balance').value) || 0

  const faltantes = [
    role !== 'Admin' && !name && nameInput,
    !identifier && idInput,
    !password && passInput
  ].filter(Boolean)
  $$('.field', formCreateUser).forEach(f => f.classList.remove('is-invalid'))
  if (faltantes.length) {
    faltantes.forEach(i => i.closest('.field').classList.add('is-invalid'))
    shake(formCreateUser)
    faltantes[0].focus()
    return
  }

  const btn = $('#btn-create-user')
  setLoading(btn, true)
  const { error } = await rpc('admin_crear_usuario', {
    p_rol: role,
    p_nombre: name,
    p_identificador: identifier,
    p_password: password,
    p_saldo: balance
  })
  setLoading(btn, false)

  if (error) {
    const duplicado = error.code === '23505'
    toast(duplicado ? `Ya existe un usuario con ese ${ROLES[role].idLabel.toLowerCase()}` : `Error: ${error.message}`, { type: 'error' })
    return
  }
  haptic([10, 40, 14])
  toast(`${ROL_ETIQUETA[role]} creado`, { type: 'success' })
  formCreateUser.reset()
  $('#admin-new-balance').value = '0'
  loadAdminData()
})

formCreateUser.addEventListener('input', e => e.target.closest('.field')?.classList.remove('is-invalid'))

async function loadAdminData() {
  const { data, error } = await rpc('admin_usuarios')
  if (error) {
    console.error('Error al cargar usuarios:', error)
    return
  }
  const { alumnos, choferes, admins } = data
  alumnosCache = alumnos
  allUsersCache = [
    ...alumnos.map(u => ({ ...u, rol: 'Estudiante', idStr: u.matricula })),
    ...choferes.map(u => ({ ...u, rol: 'Chofer', idStr: u.licencia })),
    ...admins.map(u => ({ ...u, nombre: u.usuario, rol: 'Admin', idStr: u.usuario }))
  ]
  $('#admin-users-meta').textContent = plural(allUsersCache.length, 'usuario registrado', 'usuarios registrados')
  renderUsersList()
  renderBalancesList()
}

const adminFilter = initSegmented($('#admin-filter-seg'), valor => {
  currentFilter = valor
  renderUsersList()
})
const searchUserInput = $('#search-user-input')
searchUserInput.addEventListener('input', renderUsersList)

function renderUsersList() {
  const query = searchUserInput.value.toLowerCase().trim()
  const filtrados = allUsersCache.filter(u => {
    const coincideFiltro = currentFilter === 'Todos' || u.rol === currentFilter
    const coincideBusqueda = !query || u.nombre?.toLowerCase().includes(query) || u.idStr?.toLowerCase().includes(query)
    return coincideFiltro && coincideBusqueda
  })

  patchList($('#admin-users-ul'), filtrados, {
    key: u => `${u.rol}-${u.id}`,
    render: u => `<button class="row" data-role="${esc(u.rol)}" data-id="${esc(u.id)}">
      ${avatar(u.nombre)}
      <span class="row-text"><span class="row-title">${esc(u.nombre)}</span><span class="row-sub">${ROL_ETIQUETA[u.rol]} · ${esc(u.idStr)}</span></span>
      ${icon('i-chevron-right', 'chevron')}
    </button>`,
    empty: emptyState('i-search', 'Sin resultados', query ? 'Prueba con otro nombre o ID.' : 'Aún no hay usuarios en esta categoría.')
  })
}

$('#admin-users-ul').addEventListener('click', async e => {
  const row = e.target.closest('.row[data-id]')
  if (!row) return
  const user = allUsersCache.find(u => u.rol === row.dataset.role && String(u.id) === row.dataset.id)
  if (!user) return

  const accion = await actionSheet({
    title: user.nombre,
    message: `${ROL_ETIQUETA[user.rol]} · ${user.idStr}`,
    actions: [
      { label: 'Editar', value: 'edit' },
      { label: 'Eliminar', value: 'delete', style: 'destructive' }
    ]
  })

  if (accion === 'edit') abrirEditarUsuario(user)
  if (accion === 'delete') {
    const ok = await confirm({ title: `¿Eliminar a ${user.nombre}?`, message: 'Esta acción no se puede deshacer.', confirmLabel: 'Eliminar', destructive: true })
    if (!ok) return
    const { error } = await rpc('admin_eliminar_usuario', { p_rol: user.rol, p_id: String(user.id) })
    if (error) toast(`Error al eliminar: ${error.message}`, { type: 'error' })
    else toast('Usuario eliminado', { type: 'success' })
    loadAdminData()
  }
})

function personaHTML(nombre, detalle) {
  return `${avatar(nombre)}<span class="row-text"><span class="row-title">${esc(nombre)}</span><span class="row-sub">${esc(detalle)}</span></span>`
}

function abrirEditarUsuario(user) {
  editingUser = user
  $('#sheet-edit-user-title').textContent = `Editar ${ROL_ETIQUETA[user.rol].toLowerCase()}`
  $('#edit-user-person').innerHTML = personaHTML(user.nombre, `${ROL_ETIQUETA[user.rol]} · ${user.idStr}`)
  $('#edit-user-name-label').textContent = user.rol === 'Admin' ? 'Usuario' : 'Nombre completo'
  $('#edit-user-name').value = user.nombre
  $('#edit-user-password').value = ''
  openSheet('sheet-edit-user')
}

$('#form-edit-user').addEventListener('submit', async e => {
  e.preventDefault()
  const nombre = $('#edit-user-name').value.trim()
  if (!nombre) {
    $('#edit-user-name').closest('.field').classList.add('is-invalid')
    shake($('#edit-user-name').closest('.field'))
    return
  }
  const btn = $('#btn-save-user')
  setLoading(btn, true)
  const { error } = await rpc('admin_editar_usuario', {
    p_rol: editingUser.rol,
    p_id: String(editingUser.id),
    p_nombre: nombre,
    p_password: $('#edit-user-password').value.trim() || null
  })
  setLoading(btn, false)
  if (error) {
    toast(`Error al editar: ${error.message}`, { type: 'error' })
    return
  }
  await closeSheet('sheet-edit-user')
  toast('Cambios guardados', { type: 'success' })
  loadAdminData()
})

$('#form-edit-user').addEventListener('input', e => e.target.closest('.field')?.classList.remove('is-invalid'))

function renderBalancesList() {
  const ordenados = [...alumnosCache].sort((a, b) => (Number(b.saldo) || 0) - (Number(a.saldo) || 0) || a.nombre.localeCompare(b.nombre))
  const total = ordenados.reduce((s, a) => s + (Number(a.saldo) || 0), 0)
  const conAdeudo = ordenados.filter(a => Number(a.saldo) > 0).length

  animateNumber($('#admin-total-balance'), total, { decimals: 2 })
  $('#admin-balance-meta').textContent = conAdeudo
    ? `${plural(conAdeudo, 'alumno', 'alumnos')} con saldo pendiente`
    : 'Todos los alumnos están al corriente'

  patchList($('#admin-balances-ul'), ordenados, {
    key: a => a.id,
    render: a => {
      const saldo = Number(a.saldo) || 0
      return `<button class="row" data-id="${esc(a.id)}">
        ${avatar(a.nombre)}
        <span class="row-text"><span class="row-title">${esc(a.nombre)}</span><span class="row-sub">${esc(a.matricula)}</span></span>
        <span class="row-trailing${saldo > 0 ? '' : ' is-muted'}">${fmtMoney(saldo)}</span>
        ${icon('i-chevron-right', 'chevron')}
      </button>`
    },
    empty: emptyState('i-users', 'Sin alumnos', 'Registra alumnos para ver sus saldos.')
  })
}

$('#admin-balances-ul').addEventListener('click', e => {
  const row = e.target.closest('.row[data-id]')
  if (!row) return
  editingAlumno = alumnosCache.find(a => String(a.id) === row.dataset.id)
  if (!editingAlumno) return
  $('#sheet-edit-balance-title').textContent = 'Saldo'
  $('#edit-balance-person').innerHTML = personaHTML(editingAlumno.nombre, editingAlumno.matricula)
  $('#edit-balance-amount').value = (Number(editingAlumno.saldo) || 0).toFixed(2)
  openSheet('sheet-edit-balance')
})

$('#form-edit-balance').addEventListener('click', e => {
  const btn = e.target.closest('[data-adjust]')
  if (!btn) return
  const input = $('#edit-balance-amount')
  const actual = parseFloat(input.value) || 0
  const nuevo = btn.dataset.adjust === 'paid' ? 0 : Math.max(0, actual + Number(btn.dataset.adjust))
  input.value = nuevo.toFixed(2)
  haptic(6)
  input.animate([{ transform: 'scale(1.03)' }, { transform: 'scale(1)' }], { duration: 300, easing: 'cubic-bezier(0.34, 1.4, 0.64, 1)' })
})

$('#form-edit-balance').addEventListener('submit', async e => {
  e.preventDefault()
  const input = $('#edit-balance-amount')
  const valor = input.value.trim()
  if (valor === '' || isNaN(valor) || Number(valor) < 0) {
    input.closest('.field').classList.add('is-invalid')
    shake(input.closest('.field'))
    return
  }
  const btn = $('#btn-save-balance')
  setLoading(btn, true)
  const { error } = await rpc('admin_actualizar_saldo', { p_id: editingAlumno.id, p_saldo: parseFloat(valor) })
  setLoading(btn, false)
  if (error) {
    toast(`Error al actualizar saldo: ${error.message}`, { type: 'error' })
    return
  }
  await closeSheet('sheet-edit-balance')
  toast('Saldo actualizado', { type: 'success' })
  loadAdminData()
})

$('#form-edit-balance').addEventListener('input', e => e.target.closest('.field')?.classList.remove('is-invalid'))

// --- 12. TIEMPO REAL ---
supabase
  .channel('estado_viaje_channel')
  .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'estado_viaje' }, ({ new: row }) => {
    const cambio = aplicarEstadoViaje(row)
    // El corte cambia el estado a EN_CAMINO: refrescar saldo e historial del alumno
    if (cambio && currentStudentMatricula && sessionToken) refrescarAlumno()
  })
  .subscribe()

supabase
  .channel('horarios_channel')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'horarios_matriz' }, () => fetchScheduleMatrix())
  .subscribe()

// Al volver a la app (el celular suspende la conexión en segundo plano)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !sessionToken) return
  cargarEstadoViaje()
  fetchScheduleMatrix()
  if (currentRole === 'Estudiante') refrescarAlumno()
  if (currentRole === 'Chofer') fetchPassengers()
})

// --- 13. INTRO Y ARRANQUE ---
const splash = $('#splash')
const video = $('#splash-video')
const DURACION_VIDEO_MS = 2500
let arrancado = false

function actualizarThemeColor() {
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
  $('meta[name="theme-color"]').setAttribute('content', bg || '#000000')
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', actualizarThemeColor)

function arrancar() {
  if (arrancado) return
  arrancado = true

  const sesion = leerSesion()
  if (sesion?.token && ROLES[sesion.rol]) {
    sessionToken = sesion.token
    entrar(sesion.rol, sesion.perfil || {})
  } else {
    showScreen('view-roles')
    revealWords(rolesTitle)
  }

  if (splash) {
    splash.style.pointerEvents = 'none'
    splash.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(1.06)' }], { duration: 700, easing: 'cubic-bezier(0.25, 1, 0.5, 1)', fill: 'forwards' })
      .finished.then(() => {
        splash.remove()
        actualizarThemeColor()
      })
  } else {
    actualizarThemeColor()
  }
}

if (splash) {
  video?.play().catch(() => {})
  setTimeout(arrancar, DURACION_VIDEO_MS)
  // Tocar la intro la salta
  splash.addEventListener('pointerdown', arrancar)
} else {
  arrancar()
}

cargarEstadoViaje()
fetchScheduleMatrix()

// --- 14. PWA: SERVICE WORKER (solo en producción para no cachear en desarrollo) ---
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(err => console.error('Error al registrar el service worker:', err))
  })
}
