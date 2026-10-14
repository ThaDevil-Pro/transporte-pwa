import QRCode from 'qrcode'
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode'
import { supabase } from './supabase.js'
import { runIntro } from './intro.js'
import { initAsientos } from './asientos.js'
import { initChoferAsientos } from './chofer-asientos.js'
import { initChoferManual } from './chofer-manual.js'
import { initImportar } from './importar.js'
import { initReportes } from './reportes.js'
import { initAmbiente } from './ambiente.js'
import { initBuzon } from './buzon.js'
import { initDiesel, fmtLitros, ESTADO_CARGA } from './diesel.js'
import { actualizarCamiones, camionCorto, existeCamion, idsCamiones, nombreCamion, puntoCamion } from './camiones.js'
import {
  $, $$, esc, icon, avatar, emptyState, skeletonRows, haptic,
  initScreens, showScreen, initTabs, selectTab, initSegmented,
  initSheets, openSheet, closeSheet, closeAllSheets,
  confirm, actionSheet, toast, setLoading, shake, collapse,
  animateNumber, setDigits, revealWords, patchList, initPasswordToggles, ocultarPasswords
} from './ui.js'

// --- 0. CONFIGURACIÓN Y ESTADO GLOBAL ---
const PRECIO_VIAJE = 30
const CAPACIDAD = 40
const GAUGE_C = 339.292 // circunferencia del anillo (r = 54)
const SESSION_KEY = 'camify.sesion'
const DISPOSITIVO_KEY = 'camify.dispositivo'
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
let perfilActual = {}
let sessionToken = null
let sesionExpirada = false
let passengers = []
let copyPassengers = [] // Copia para el comprobante
let html5QrcodeScanner = null
let allUsersCache = []
let alumnosCache = []
let currentFilter = 'Todos'
let estadoViaje = 'ESPERANDO'
let isTripActive = false
let scheduleRows = []
let isEditingSchedule = false
let editingUser = null
let editingAlumno = null
let timerInterval = null
let targetEndTime = null
let timerTotalMs = 5 * 60 * 1000

// Camiones: cada uno tiene su estado de viaje (estado_viaje.id = camión)
// y un nombre y color (Rojo, Blanco, Amarillo, Gris) en camiones.js
const CAMION_KEY = 'camify.camion'
let estados = {}
let camionActual = leerCamion() // el que maneja el chofer
let camionAlumno = 1 // el del próximo asiento apartado del alumno

function leerCamion() {
  try {
    const n = Number(localStorage.getItem(CAMION_KEY))
    return existeCamion(n) ? n : idsCamiones()[0]
  } catch { return idsCamiones()[0] }
}

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

// Asientos y parejas del alumno (rpc es una declaración de función, ya disponible)
const asientos = initAsientos({
  rpc,
  supabase,
  // La tarjeta de viaje del alumno sigue al camión de su próximo asiento apartado
  alCambiarSalidas: salidas => {
    const s = salidas.find(x => x.mi_asiento) || salidas[0]
    const nuevo = s?.camion || 1
    $('#trip-bus-label').textContent = nombreCamion(nuevo)
    if (nuevo === camionAlumno) return
    camionAlumno = nuevo
    if (currentRole === 'Estudiante') sincronizarViaje()
  }
})
const asientosChofer = initChoferAsientos({ rpc, supabase, camion: () => camionActual })

// Registro manual (alumno sin código) e importación de usuarios (admin)
const manualChofer = initChoferManual({ rpc, camion: () => camionActual, alRegistrar: () => fetchPassengers() })
initImportar({
  rpc,
  usuariosExistentes: () => new Set(allUsersCache.filter(u => u.rol !== 'Admin').map(u => `${u.rol}:${u.idStr}`)),
  alTerminar: () => loadAdminData()
})

// Buzón de quejas y fallas del camión
const buzon = initBuzon({ rpc, supabase, camion: () => camionActual })

// Control de diésel: cargas con ticket, revisión e informe
const diesel = initDiesel({ rpc, supabase, camion: () => camionActual, alCambiar: () => reportes.refrescarDiesel() })

// Reportes en PDF: el alumno, el chofer y la administración
const reportes = initReportes({ rpc, abrirCarga: c => diesel.abrirCarga(c) })
$('#btn-student-report').addEventListener('click', () => reportes.abrir({ rol: 'Estudiante', perfil: perfilActual }))
$('#btn-driver-report').addEventListener('click', () => reportes.abrir({ rol: 'Chofer', perfil: perfilActual }))
$('#btn-admin-report-gastos').addEventListener('click', () => reportes.abrir({ rol: 'Admin', perfil: perfilActual, tipo: 'gastos' }))
$('#btn-admin-report-chofer').addEventListener('click', () => reportes.abrir({ rol: 'Admin', perfil: perfilActual, tipo: 'chofer' }))
$('#btn-admin-report-diesel').addEventListener('click', () => reportes.abrir({ rol: 'Admin', perfil: perfilActual, tipo: 'diesel' }))

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

// ID aleatorio de este navegador: si ya inició sesión aquí, los bloqueos por
// intentos fallidos que provoque otra persona no le impiden entrar
function idDispositivo() {
  try {
    let id = localStorage.getItem(DISPOSITIVO_KEY)
    if (!id) {
      id = crypto.randomUUID()
      localStorage.setItem(DISPOSITIVO_KEY, id)
    }
    return id
  } catch { return null }
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
  // El servidor exige cambiar la contraseña antes de seguir
  if (res.error?.code === 'CMF01') pedirCambioPassword({ obligatorio: true })
  return res
}

function entrar(rol, perfil, transition = 'fade') {
  currentRole = rol
  perfilActual = perfil || {}
  sesionExpirada = false
  pintarCuentaLateral(rol, perfil)
  if (rol === 'Estudiante') iniciarAlumno(perfil)
  else if (rol === 'Chofer') iniciarChofer(perfil)
  else iniciarAdmin()
  return showScreen(ROLES[rol].screen, transition)
}

// Cuenta en la barra lateral (vista de computadora)
function pintarCuentaLateral(rol, perfil = {}) {
  const screen = document.getElementById(ROLES[rol].screen)
  const nombre = perfil.nombre || perfil.usuario || ROLES[rol].title
  const sub = rol === 'Estudiante' ? perfil.matricula : rol === 'Chofer' && perfil.licencia ? `Licencia ${perfil.licencia}` : ROLES[rol].title
  $('[data-side-name]', screen).textContent = nombre
  $('[data-side-sub]', screen).textContent = sub || ROLES[rol].title
  $('[data-side-avatar]', screen).innerHTML = avatar(nombre)
}

function cerrarSesion() {
  qrDatos = null
  clearInterval(qrTimer)
  try { localStorage.removeItem(QR_KEY) } catch { /* modo privado */ }
  // supabase-js solo envía la petición al consumir la promesa
  if (sessionToken) supabase.rpc('logout', { p_token: sessionToken }).then(() => {}, () => {})
  borrarSesion()
  stopScanner()
  closeAllSheets({ force: true })
  asientos.limpiar()
  asientosChofer.limpiar()
  buzon.limpiar()
  diesel.limpiar()
  passengers = []
  copyPassengers = []
  currentRole = ''
  perfilActual = {}
  camionAlumno = 1
  allUsersCache = []
  alumnosCache = []
  editingUser = null
  editingAlumno = null
  loginForm.reset()
  ocultarPasswords()
  showScreen('view-roles', 'fade')
  revealWords(rolesTitle)
}

$$('[data-logout]').forEach(btn => btn.addEventListener('click', async () => {
  const accion = await actionSheet({
    title: 'Tu cuenta',
    actions: [
      { label: 'Cambiar contraseña', value: 'password' },
      { label: 'Cerrar sesión', value: 'salir', style: 'destructive' }
    ]
  })
  if (accion === 'password') pedirCambioPassword()
  if (accion === 'salir') cerrarSesion()
}))

// --- CAMBIO DE CONTRASEÑA (obligatorio la primera vez) ---
const formPassword = $('#form-password')
let alTerminarPassword = null

function reglasPassword() {
  const nueva = $('#pw-nueva').value
  const ok = {
    len: [...nueva].length >= 8,
    mix: /[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/.test(nueva) && /\d/.test(nueva),
    match: nueva.length > 0 && nueva === $('#pw-confirmar').value
  }
  $$('#pw-rules li').forEach(li => li.classList.toggle('is-ok', ok[li.dataset.rule]))
  return ok.len && ok.mix && ok.match
}

function pedirCambioPassword({ obligatorio = false, alTerminar = null } = {}) {
  const sheet = $('#sheet-password')
  if (alTerminar) alTerminarPassword = alTerminar
  if (obligatorio) sheet.dataset.locked = '1'
  if (sheet.classList.contains('is-open')) return
  if (!obligatorio) delete sheet.dataset.locked
  $('#sheet-password-title').textContent = obligatorio ? 'Crea tu contraseña' : 'Cambiar contraseña'
  $('#password-lead').textContent = obligatorio
    ? 'Por tu seguridad, cambia la contraseña temporal que te dio la administración. Solo tú la vas a conocer.'
    : 'Elige una contraseña que solo tú conozcas. Se cerrará tu sesión en otros dispositivos.'
  $('#btn-password-logout').hidden = !obligatorio
  formPassword.reset()
  ocultarPasswords(formPassword)
  $('#password-error').hidden = true
  reglasPassword()
  openSheet(sheet)
}

formPassword.addEventListener('input', () => {
  reglasPassword()
  $('#password-error').hidden = true
  $$('.field', formPassword).forEach(f => f.classList.remove('is-invalid'))
})

formPassword.addEventListener('submit', async e => {
  e.preventDefault()
  const error = $('#password-error')
  const mostrar = msg => {
    error.innerHTML = `${icon('i-alert')}<span>${esc(msg)}</span>`
    error.hidden = false
    shake(formPassword)
  }
  if (!$('#pw-actual').value) return mostrar('Escribe tu contraseña actual.')
  if (!reglasPassword()) return mostrar('Revisa que la nueva contraseña cumpla los tres puntos.')

  const btn = $('#btn-password-save')
  setLoading(btn, true)
  const { error: err } = await supabase.rpc('cambiar_password', {
    p_token: sessionToken,
    p_actual: $('#pw-actual').value,
    p_nueva: $('#pw-nueva').value
  })
  setLoading(btn, false)
  if (err) {
    if (err.code === '28000') { await closeSheet('sheet-password', { force: true }); cerrarSesion(); return }
    return mostrar(err.message || 'No se pudo cambiar la contraseña.')
  }

  const sesion = leerSesion()
  if (sesion) guardarSesion({ ...sesion, debe_cambiar: false })
  const sheet = $('#sheet-password')
  const eraObligatorio = !!sheet.dataset.locked
  const siguiente = alTerminarPassword
  alTerminarPassword = null
  await closeSheet(sheet, { force: true })
  delete sheet.dataset.locked
  haptic([10, 40, 14])
  toast('Contraseña actualizada', { type: 'success' })
  if (siguiente) siguiente()
  else if (eraObligatorio && sesion) entrar(sesion.rol, sesion.perfil || {})
})

$('#btn-password-logout').addEventListener('click', async () => {
  await closeSheet('sheet-password', { force: true })
  delete $('#sheet-password').dataset.locked
  alTerminarPassword = null
  cerrarSesion()
})

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
  ocultarPasswords(loginForm)
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
  const password = inputPassword.value

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
    p_password: password,
    p_dispositivo: idDispositivo()
  })
  setLoading(btnLogin, false)

  if (sesion?.bloqueado) {
    mostrarError(`Demasiados intentos fallidos. Espera ${sesion.minutos} min e inténtalo de nuevo.`)
    shake($('#login-fields'))
    return
  }

  if (error || !sesion) {
    mostrarError(error ? 'No pudimos conectar. Intenta de nuevo.' : ROLES[currentRole].error)
    $$('.field', loginForm).forEach(f => f.classList.add('is-invalid'))
    shake($('#login-fields'))
    return
  }

  haptic([10, 40, 14])
  inputControl.blur()
  inputPassword.blur()
  const rol = currentRole
  guardarSesion({ token: sesion.token, rol, perfil: sesion.perfil, debe_cambiar: !!sesion.debe_cambiar })
  if (sesion.debe_cambiar) {
    pedirCambioPassword({ obligatorio: true, alTerminar: () => entrar(rol, sesion.perfil) })
    return
  }
  entrar(rol, sesion.perfil)
})

// --- 5. ALUMNO ---
const studentDays = initSegmented($('#student-days'), () => {
  $('#student-schedule-list').replaceChildren()
  renderStudentSchedule()
})

function iniciarAlumno(perfil) {
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
  asientos.cargar(perfil.nombre)
  buzon.alumno()
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
  const { data: movimientos, error } = await rpc('alumno_historial')
  if (error || !Array.isArray(movimientos)) return

  const viajes = movimientos.filter(m => m.tipo !== 'pago').length
  $('#student-history-meta').textContent = viajes ? plural(viajes, 'viaje', 'viajes') : ''
  patchList($('#student-history-list'), movimientos, {
    key: m => m.id,
    render: m => {
      const f = new Date(m.fecha_hora)
      const pago = m.tipo === 'pago'
      return `<div class="row">
        <span class="row-icon${pago ? ' is-money' : ''}">${icon(pago ? 'i-wallet' : 'i-bus')}</span>
        <span class="row-text"><span class="row-title">${pago ? 'Pago registrado' : 'Viaje cobrado'}</span><span class="row-sub">${esc(fmtFecha(f))} · ${esc(fmtHora(f))}${pago && m.nota ? ` · ${esc(m.nota)}` : ''}${m.manual ? ' · Registrado a mano por el chofer' : ''}</span></span>
        <span class="row-trailing${pago ? ' is-positive' : ''}">${pago ? '−' : ''}${fmtMoney(m.monto)}</span>
      </div>`
    },
    empty: emptyState('i-receipt', 'Sin movimientos todavía', 'Tus viajes cobrados y tus pagos aparecerán aquí.')
  })
}

// QR dinámico: el servidor firma un código nuevo cada 30 s y entrega los
// de los próximos 5 minutos, para aguantar una caída breve de señal.
const QR_KEY = 'camify.qr'
let qrDatos = null
let qrTimer = null
let qrMostrado = null
let qrCargando = false

async function cargarCodigosQR() {
  qrCargando = true
  const { data, error } = await rpc('alumno_qr')
  qrCargando = false
  if (error || !data?.codigos) return false
  qrDatos = { offset: data.ahora - Date.now(), periodo: data.periodo * 1000, codigos: data.codigos, token: sessionToken }
  try { localStorage.setItem(QR_KEY, JSON.stringify(qrDatos)) } catch { /* modo privado */ }
  return true
}

function qrGuardado() {
  try {
    const d = JSON.parse(localStorage.getItem(QR_KEY))
    return d?.token === sessionToken ? d : null
  } catch { return null }
}

function codigoActual() {
  if (!qrDatos) return null
  const ahora = Date.now() + qrDatos.offset
  const v = Math.floor(ahora / qrDatos.periodo)
  const c = qrDatos.codigos.find(x => Number(x.v) === v)
  if (!c) return null
  return { codigo: c.codigo, restante: (v + 1) * qrDatos.periodo - ahora, quedan: qrDatos.codigos.filter(x => Number(x.v) > v).length }
}

function pintarQR({ cargando = false } = {}) {
  const c = codigoActual()
  const card = $('.qr-card')
  card.classList.toggle('is-offline', !c)
  if (!c) {
    $('#qr-countdown').textContent = cargando ? 'Preparando tu código…' : 'Sin conexión: conéctate para generar tu código'
    $('#qr-progress').style.setProperty('--p', 0)
    return
  }
  if (qrMostrado !== c.codigo) {
    const canvas = $('#qr-canvas')
    const primero = qrMostrado === null
    qrMostrado = c.codigo
    QRCode.toCanvas(canvas, c.codigo, { width: 640, margin: 1, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } })
    if (!primero) {
      canvas.classList.remove('is-refresh')
      void canvas.offsetWidth
      canvas.classList.add('is-refresh')
      haptic(6)
    }
  }
  $('#qr-countdown').textContent = `Se renueva en ${Math.max(1, Math.ceil(c.restante / 1000))} s`
  $('#qr-progress').style.setProperty('--p', (c.restante / qrDatos.periodo).toFixed(3))
  if (c.quedan < 4 && !qrCargando) cargarCodigosQR()
}

$('#btn-show-qr').addEventListener('click', async () => {
  haptic(8)
  qrMostrado = null
  if (!qrDatos || qrDatos.token !== sessionToken) qrDatos = qrGuardado()
  openSheet('sheet-qr', { onClose: () => { clearInterval(qrTimer); qrTimer = null } })
  pintarQR({ cargando: true })
  clearInterval(qrTimer)
  qrTimer = setInterval(pintarQR, 500)
  await cargarCodigosQR()
  pintarQR()
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
    .map(r => ({ id: r.id, camion: r.camion || 1, ...(r[dia] || {}) }))
    .filter(s => s.hora)
    .sort((a, b) => a.hora.localeCompare(b.hora) || a.camion - b.camion)

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
        ${esProxima ? '<span class="next-tag is-live"><span class="status-dot"></span>Próxima</span>' : `<span class="badge badge-bus">${icon('i-bus')}Camión ${camionCorto(s.camion)}</span>`}
      </div>`
    },
    empty: emptyState('i-calendar', 'Sin salidas', `No hay salidas programadas el ${DIAS_NOMBRE[dia].toLowerCase()}.`)
  })
}

function renderDriverSchedule() {
  // Solo las salidas del camión que maneja el chofer, en el orden en que se crearon
  const filas = scheduleRows
    .filter(r => (r.camion || 1) === camionActual)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
  $('#driver-schedule-eyebrow').textContent = `Camión ${camionCorto(camionActual)} · Semana`
  patchList($('#driver-schedule-list'), filas, {
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
    empty: emptyState('i-calendar', 'Sin horarios', `Agrega la primera salida del camión ${camionCorto(camionActual)}.`)
  })
}

async function guardarDia(card, dia) {
  const input = card.querySelector(`input[data-dia="${dia}"]`)
  const btn = card.querySelector(`.type-toggle[data-dia="${dia}"]`)
  const valor = { hora: input.value, tipo: btn.dataset.tipo }
  const id = Number(card.dataset.id)

  const { error } = await rpc('chofer_horario_actualizar', { p_id: id, p_dia: dia, p_valor: valor, p_camion: camionActual })
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
  delete e.target.dataset.propuesta
  delete e.target.dataset.tocada
  if (e.target.value) return

  const inputs = $$('.schedule-time-input', e.target.closest('.schedule-card'))
  const idx = inputs.indexOf(e.target)
  const vecino = [...inputs.slice(0, idx).reverse(), ...inputs.slice(idx + 1)].find(i => i.value)
  if (vecino) {
    e.target.value = vecino.value
    e.target.dataset.propuesta = vecino.value
  }
})

// Solo cuenta como cambio si el chofer eligió o escribió una hora
driverScheduleList.addEventListener('input', e => {
  if (e.target.classList.contains('schedule-time-input')) e.target.dataset.tocada = '1'
})
driverScheduleList.addEventListener('change', e => {
  if (e.target.classList.contains('schedule-time-input')) e.target.dataset.tocada = '1'
})

driverScheduleList.addEventListener('focusout', e => {
  if (!e.target.classList.contains('schedule-time-input')) return
  isEditingSchedule = false
  // Tocar un día vacío y salir sin elegir no crea una salida
  if (e.target.dataset.propuesta && !e.target.dataset.tocada) {
    e.target.value = e.target.dataset.saved
    delete e.target.dataset.propuesta
    return
  }
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
    const { error } = await rpc('chofer_horario_eliminar', { p_id: Number(borrar.dataset.id), p_camion: camionActual })
    if (error) toast('No se pudo eliminar', { type: 'error' })
    else fetchScheduleMatrix()
  }
})

$('#btn-add-schedule-row').addEventListener('click', async e => {
  const btn = e.currentTarget
  setLoading(btn, true)
  const { error } = await rpc('chofer_horario_agregar', { p_camion: camionActual })
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
  selectTab($('#view-driver'), 'driver-tab-trip', { animate: false })
  buzon.chofer()
  aplicarCamion()
  renderDriverSchedule()

  // Primera vez en este teléfono: que elija su camión
  let elegido = null
  try { elegido = localStorage.getItem(CAMION_KEY) } catch { /* modo privado */ }
  if (!elegido) setTimeout(() => elegirCamion({ primeraVez: true }), 900)
}

// Carga todo lo del camión que maneja el chofer
function aplicarCamion() {
  $('#camion-label').innerHTML = `${puntoCamion(camionActual)}${camionCorto(camionActual)}`
  $('#passengers-count').dataset.value = '0'
  $('#students-ul').innerHTML = skeletonRows(3)
  passengers = []
  sincronizarViaje()
  fetchPassengers()
  asientosChofer.cargar()
  renderDriverSchedule()
  diesel.chofer()
}

async function elegirCamion({ primeraVez = false } = {}) {
  const elegido = await actionSheet({
    title: primeraVez ? '¿Qué camión manejas hoy?' : 'Cambiar de camión',
    message: 'La lista de abordaje, el temporizador y el corte son de cada camión.',
    actions: idsCamiones().map(n => ({ label: `${nombreCamion(n)}${n === camionActual ? ' ✓' : ''}`, value: n }))
  })
  if (!elegido) return
  try { localStorage.setItem(CAMION_KEY, String(elegido)) } catch { /* modo privado */ }
  if (elegido === camionActual) return
  camionActual = elegido
  haptic([10, 40, 14])
  aplicarCamion()
  toast(`Ahora manejas el camión ${camionCorto(elegido)}`, { type: 'success' })
}

$('#btn-camion').addEventListener('click', () => elegirCamion())

// El mapa del chofer se actualiza cada vez que abre la pestaña
$('#view-driver').addEventListener('tabchange', e => {
  if (e.detail === 'driver-tab-seats') asientosChofer.cargar()
  if (e.detail === 'driver-tab-inbox') buzon.choferAbrir()
})

async function fetchPassengers() {
  const bus = camionActual
  const { data, error } = await rpc('chofer_abordajes', { p_camion: bus })
  if (error) {
    console.error('Error al cargar pasajeros:', error)
    return
  }
  // Si el chofer cambió de camión mientras tanto, se ignora la respuesta
  if (bus !== camionActual) return
  passengers = data
  renderPassengersUI()
  asientosChofer.refrescar()
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
      ${p.manual ? '<span class="badge badge-manual" title="Registrado a mano, sin código QR">A mano</span>' : ''}
      <button class="icon-btn icon-btn-sm icon-btn-danger btn-remove-student" data-id="${esc(p.id)}" aria-label="Quitar a ${esc(p.nombre)}">${icon('i-minus')}</button>
    </div>`,
    empty: emptyState('i-users', 'Nadie a bordo', 'Toca Escanear para registrar a cada alumno al subir, o Buscar alumno si no trae su código.')
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
    return
  }
  asientosChofer.refrescar()
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

  const { error } = await rpc('chofer_vaciar_abordajes', { p_camion: camionActual })
  if (error) {
    toast(`Error al vaciar: ${error.message}`, { type: 'error' })
    return
  }
  passengers = []
  renderPassengersUI()
  asientosChofer.refrescar()
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
  const { data: totalCobrados, error } = await rpc('chofer_hacer_corte', { p_camion: camionActual })
  setLoading(btnIniciarViaje, false)

  if (error) {
    toast(error.message || 'No se pudo hacer el corte', { type: 'error' })
    renderDriverTrip()
    return
  }

  estados[camionActual] = { ...estados[camionActual], estado: 'EN_CAMINO' }
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
  $('#comprobante-fecha-hora').textContent = `Camión ${camionCorto(camionActual)} · ${fmtFechaLarga(ahora)} · ${fmtHora(ahora)}`
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
  const { error } = await rpc('chofer_finalizar_viaje', { p_camion: camionActual })
  setLoading(btn, false)
  if (error) {
    toast('No se pudo finalizar el viaje', { type: 'error' })
    return
  }
  passengers = []
  estados[camionActual] = { ...estados[camionActual], estado: 'ESPERANDO' }
  estadoViaje = 'ESPERANDO'
  isTripActive = false
  renderPassengersUI()
  asientosChofer.refrescar()
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

// Registro manual: desde la lista o desde el escáner (cierra la cámara primero)
$('#btn-open-manual').addEventListener('click', () => {
  haptic(8)
  manualChofer.abrir()
})

$('#btn-scanner-manual').addEventListener('click', async () => {
  haptic(8)
  await closeSheet('sheet-scanner')
  manualChofer.abrir()
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

  const matriculaQR = /^CMF1\.([^.]+)\./.exec(scannedId)?.[1]
  const yaArriba = matriculaQR && passengers.find(p => String(p.matricula).trim() === matriculaQR)
  if (yaArriba) {
    haptic([20, 40, 20])
    setScanFeedback(`${primerNombre(yaArriba.nombre)} ya está a bordo`, 'warning', { volver: 2000 })
    return liberarEscaner(1200)
  }

  setScanFeedback('Validando…')

  // Supabase valida la matrícula, el límite de 40 y los duplicados (también en el otro camión)
  const { data, error } = await rpc('chofer_registrar_abordaje', { p_camion: camionActual, p_matricula: scannedId })

  if (error || data?.error) {
    if (error) console.error('Error al registrar abordaje:', error)
    flash('error')
    haptic([30, 50, 30])
    setScanFeedback(data?.error || error.message, 'error', { volver: 2600 })
    return liberarEscaner(1500)
  }

  flash('success')
  haptic(30)
  // Si apartó lugar para esta salida, el chofer ve a qué asiento va
  const asiento = data.asiento ? ` · Asiento ${data.asiento}` : ''
  setScanFeedback(`${primerNombre(data.nombre)} está a bordo${asiento}`, 'success', { volver: 2200 })
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
  const { error } = await rpc('chofer_temporizador', { p_camion: camionActual, p_accion: accion })
  setLoading(btn, false)
  if (error) toast('No se pudo actualizar el temporizador', { type: 'error' })
  else cargarEstadoViaje()
}

btnTimerStart.addEventListener('click', () => accionTemporizador('iniciar', btnTimerStart))
btnTimerAdd.addEventListener('click', () => accionTemporizador('agregar', btnTimerAdd))
btnTimerStop.addEventListener('click', () => accionTemporizador('cancelar', btnTimerStop))

// Estado del viaje y temporizador de cada camión (lectura pública)
async function cargarEstadoViaje() {
  const { data } = await supabase
    .from('estado_viaje')
    .select('id, estado, tiempo_salida, temporizador_activo, nombre, color')
  if (!data) return
  actualizarCamiones(data)
  data.forEach(row => { estados[row.id] = row })
  sincronizarViaje()
}

// Camión que se muestra: el que maneja el chofer o el del asiento del alumno
const camionVisible = () => (currentRole === 'Chofer' ? camionActual : camionAlumno)

function sincronizarViaje() {
  const row = estados[camionVisible()] || { estado: 'ESPERANDO', temporizador_activo: false }
  estadoViaje = row.estado
  isTripActive = estadoViaje === 'EN_CAMINO'
  startLocalTimer(row.temporizador_activo ? row.tiempo_salida : null)
  renderTripCard()
  renderDriverTrip()
}

// Devuelve true si cambió el estado (ESPERANDO ↔ EN_CAMINO) de ese camión
function aplicarEstadoViaje(row) {
  if (!row) return false
  const previo = estados[row.id]?.estado
  estados[row.id] = row
  if (row.id === camionVisible()) sincronizarViaje()
  return previo !== undefined && previo !== row.estado
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
  buzon.admin()
  diesel.admin()
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
  ocultarPasswords(formCreateUser)
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

initSegmented($('#admin-filter-seg'), valor => {
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
  ocultarPasswords($('#form-edit-user'))
  $$('.field', $('#form-edit-user')).forEach(f => f.classList.remove('is-invalid'))
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
  const passwordNueva = $('#edit-user-password').value.trim()
  const btn = $('#btn-save-user')
  setLoading(btn, true)
  const { error } = await rpc('admin_editar_usuario', {
    p_rol: editingUser.rol,
    p_id: String(editingUser.id),
    p_nombre: nombre,
    p_password: passwordNueva || null
  })
  setLoading(btn, false)
  if (error) {
    toast(`Error al editar: ${error.message}`, { type: 'error' })
    return
  }
  await closeSheet('sheet-edit-user')
  toast(passwordNueva ? 'Contraseña restablecida: se le pedirá cambiarla al entrar' : 'Cambios guardados', { type: 'success' })
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

// Saldos: registrar un pago (baja el saldo y queda en el historial) o corregirlo con motivo
const balanceMode = initSegmented($('#balance-mode-seg'), aplicarModoSaldo)

function aplicarModoSaldo(modo) {
  const saldo = Number(editingAlumno?.saldo) || 0
  const pago = modo === 'pago'
  const input = $('#edit-balance-amount')
  $('#edit-balance-label').textContent = pago ? 'Monto del pago ($)' : 'Saldo pendiente correcto ($)'
  $('#edit-balance-note-label').textContent = pago ? 'Nota (opcional): efectivo, transferencia…' : 'Motivo de la corrección (obligatorio)'
  $('#btn-save-balance').textContent = pago ? 'Registrar pago' : 'Guardar corrección'
  input.value = pago ? '' : saldo.toFixed(2)
  $('#edit-balance-note').value = ''
  const rapidos = pago
    ? [[30, '$30'], [60, '$60'], ['todo', `Todo (${fmtMoney(saldo)})`]]
    : [[-30, '−$30'], [30, '+$30'], [0, 'En cero']]
  $('#balance-quick').innerHTML = rapidos.map(([v, t]) => `<button type="button" class="btn ${v === 'todo' ? 'btn-tinted-green' : 'btn-secondary'}" data-quick="${v}">${esc(t)}</button>`).join('')
  $$('.field', $('#form-edit-balance')).forEach(f => f.classList.remove('is-invalid'))
}

$('#admin-balances-ul').addEventListener('click', e => {
  const row = e.target.closest('.row[data-id]')
  if (!row) return
  editingAlumno = alumnosCache.find(a => String(a.id) === row.dataset.id)
  if (!editingAlumno) return
  $('#sheet-edit-balance-title').textContent = 'Saldo'
  $('#edit-balance-person').innerHTML = personaHTML(editingAlumno.nombre, editingAlumno.matricula)
  $('#edit-balance-current').textContent = fmtMoney(editingAlumno.saldo)
  const saldo = Number(editingAlumno.saldo) || 0
  balanceMode.select(saldo > 0 ? 'pago' : 'ajuste', false)
  aplicarModoSaldo(balanceMode.value)
  openSheet('sheet-edit-balance')
})

$('#form-edit-balance').addEventListener('click', e => {
  const btn = e.target.closest('[data-quick]')
  if (!btn) return
  const input = $('#edit-balance-amount')
  const saldo = Number(editingAlumno?.saldo) || 0
  const v = btn.dataset.quick
  if (balanceMode.value === 'pago') {
    input.value = (v === 'todo' ? saldo : Math.min(saldo, Number(v))).toFixed(2)
  } else {
    const actual = parseFloat(input.value) || 0
    input.value = (Number(v) === 0 ? 0 : Math.max(0, actual + Number(v))).toFixed(2)
  }
  haptic(6)
  input.animate([{ transform: 'scale(1.03)' }, { transform: 'scale(1)' }], { duration: 300, easing: 'cubic-bezier(0.34, 1.4, 0.64, 1)' })
})

$('#form-edit-balance').addEventListener('submit', async e => {
  e.preventDefault()
  const input = $('#edit-balance-amount')
  const nota = $('#edit-balance-note')
  const valor = Number(input.value)
  const pago = balanceMode.value === 'pago'
  const saldo = Number(editingAlumno.saldo) || 0
  const invalido = (campo, msg) => {
    campo.closest('.field').classList.add('is-invalid')
    shake(campo.closest('.field'))
    if (msg) toast(msg, { type: 'warning' })
  }
  if (input.value.trim() === '' || !Number.isFinite(valor) || valor < 0) return invalido(input)
  if (pago && (valor <= 0 || valor > saldo)) return invalido(input, `El pago debe ser mayor a $0 y no pasar de ${fmtMoney(saldo)}`)
  if (!pago && !nota.value.trim()) return invalido(nota, 'Escribe el motivo de la corrección')

  const btn = $('#btn-save-balance')
  setLoading(btn, true)
  const { error } = pago
    ? await rpc('admin_registrar_pago', { p_id: editingAlumno.id, p_monto: valor, p_nota: nota.value.trim() || null })
    : await rpc('admin_actualizar_saldo', { p_id: editingAlumno.id, p_saldo: valor, p_motivo: nota.value.trim() })
  setLoading(btn, false)
  if (error) {
    toast(error.message || 'No se pudo guardar', { type: 'error' })
    return
  }
  await closeSheet('sheet-edit-balance')
  haptic([10, 40, 14])
  toast(pago ? `Pago de ${fmtMoney(valor)} registrado` : 'Saldo corregido', { type: 'success' })
  loadAdminData()
})

$('#form-edit-balance').addEventListener('input', e => e.target.closest('.field')?.classList.remove('is-invalid'))

// Bitácora (pestaña Actividad)
// Claves de bloqueo: ip:<red>, u:<rol>:<usuario>, ua:<rol>:<usuario>@<red>, dv:<rol>:<usuario>:<dispositivo>
function detalleBloqueo(clave) {
  const [, tipo, resto = ''] = /^(\w+):(.*)$/.exec(clave) || []
  if (tipo === 'ip') return `Red ${resto} · todas las cuentas`
  const [, rol = '', usuario = resto] = /^([^:]*):(.*)$/.exec(resto) || []
  const quien = `${ROL_ETIQUETA[rol] || rol} · `
  if (tipo === 'ua') {
    const arroba = usuario.lastIndexOf('@')
    return `${quien}${usuario.slice(0, arroba)} · solo desde la red ${usuario.slice(arroba + 1)}`
  }
  if (tipo === 'dv') return `${quien}${usuario.replace(/:[0-9a-f]+$/, '')} · su dispositivo`
  if (tipo === 'u') return `${quien}${usuario} · desde cualquier red nueva`
  return clave
}

const fmtDetalle = {
  pago_registrado: ['Pago registrado', 'i-wallet', 'is-money', d => `${d.matricula} · ${fmtMoney(d.monto)}${d.nota ? ` · ${d.nota}` : ''}`],
  saldo_ajustado: ['Saldo corregido', 'i-receipt', '', d => `${d.matricula} · ${fmtMoney(d.antes)} → ${fmtMoney(d.despues)}${d.motivo ? ` · ${d.motivo}` : ''}`],
  corte: ['Corte de viaje', 'i-bus', 'is-money', d => `Camión ${camionCorto(d.camion)} · ${plural(d.alumnos, 'alumno', 'alumnos')} · ${fmtMoney(d.total)}${d.manuales ? ` · ${d.manuales} a mano` : ''}`],
  abordaje_manual: ['Abordaje registrado a mano', 'i-hand', 'is-alert', d => `Camión ${camionCorto(d.camion)} · ${d.nombre ? `${d.nombre} · ` : ''}${d.matricula}`],
  usuarios_importados: ['Usuarios importados', 'i-sheet', '', d => [
    d.alumnos && plural(d.alumnos, 'alumno', 'alumnos'),
    d.choferes && plural(d.choferes, 'chofer', 'choferes'),
    d.fallidos && `${d.fallidos} con error`
  ].filter(Boolean).join(' · ') || 'Ningún usuario creado'],
  viaje_finalizado: ['Viaje finalizado', 'i-flag', '', d => `Camión ${camionCorto(d.camion)}`],
  lista_vaciada: ['Lista vaciada sin cobrar', 'i-trash', 'is-alert', d => `Camión ${camionCorto(d.camion)} · ${plural(d.alumnos || 0, 'alumno', 'alumnos')}`],
  alumno_quitado: ['Alumno quitado de la lista', 'i-minus', '', d => `Camión ${camionCorto(d.camion)} · ${d.matricula}`],
  qr_rechazado: ['Código QR rechazado', 'i-alert', 'is-alert', d => `${{ formato: 'No es de CAMIFY', firma: 'Falsificado', vencido: 'Vencido' }[d.motivo] || d.motivo}${d.matricula ? ` · ${d.matricula}` : ''} · Camión ${camionCorto(d.camion)}`],
  login_bloqueado: ['Bloqueo por intentos fallidos', 'i-lock', 'is-alert', d => detalleBloqueo(String(d.clave || ''))],
  usuario_creado: ['Usuario creado', 'i-user-plus', '', d => `${ROL_ETIQUETA[d.rol] || d.rol} · ${d.nombre ? `${d.nombre} · ` : ''}${d.identificador}`],
  usuario_editado: ['Usuario editado', 'i-users', '', d => `${ROL_ETIQUETA[d.rol] || d.rol} · ${d.identificador}${d.password_restablecida ? ' · contraseña restablecida' : ''}`],
  usuario_eliminado: ['Usuario eliminado', 'i-trash', 'is-alert', d => `${ROL_ETIQUETA[d.rol] || d.rol} · ${d.nombre ? `${d.nombre} · ` : ''}${d.identificador}`],
  cambio_password: ['Cambio de contraseña', 'i-lock', '', () => ''],
  falla_reportada: ['Falla del camión reportada', 'i-wrench', 'is-alert', d => `Camión ${camionCorto(d.camion)} · ${FALLA_TIPO[d.tipo] || d.tipo} · ${FALLA_GRAVEDAD[d.gravedad] || d.gravedad}`],
  falla_actualizada: ['Falla del camión actualizada', 'i-wrench', '', d => `Reporte #${d.id} · ${{ abierta: 'Abierta', reparacion: 'En reparación', resuelta: 'Resuelta' }[d.estado] || d.estado}`],
  queja_actualizada: ['Queja atendida', 'i-inbox', '', d => `Queja #${d.id} · ${{ nueva: 'Nueva', revision: 'En revisión', atendida: 'Atendida' }[d.estado] || d.estado}${d.respondida ? ' · con respuesta' : ''}`],
  diesel_registrado: ['Carga de diésel registrada', 'i-fuel', 'is-money', d => `Camión ${camionCorto(d.camion)} · ${fmtLitros(d.litros)} · ${fmtMoney(d.importe)}`],
  diesel_actualizado: ['Carga de diésel revisada', 'i-fuel', '', d => `Carga #${d.id} · Camión ${camionCorto(d.camion)} · ${ESTADO_CARGA[d.estado]?.label || d.estado}${d.corregida ? ' · datos corregidos' : ''}`],
  diesel_tanque: ['Capacidad del tanque', 'i-gauge', '', d => `Camión ${camionCorto(d.camion)} · ${d.litros ? fmtLitros(d.litros) : 'sin dato'}`]
}
const FALLA_TIPO = { motor: 'Motor', frenos: 'Frenos', llantas: 'Llantas', luces: 'Luces', puertas: 'Puertas', clima: 'Clima', electrico: 'Eléctrico', otro: 'Otro' }
const FALLA_GRAVEDAD = { baja: 'Puede seguir', media: 'Revisar pronto', alta: 'No puede circular' }

async function cargarBitacora() {
  const lista = $('#admin-log-ul')
  if (!lista.children.length) lista.innerHTML = skeletonRows(5)
  const { data, error } = await rpc('admin_bitacora', { p_limite: 150 })
  if (error || !Array.isArray(data)) return
  patchList(lista, data, {
    key: r => r.id,
    render: r => {
      const [titulo, ico, cls, det] = fmtDetalle[r.accion] || [r.accion, 'i-info', '', () => '']
      const f = new Date(r.creado_en)
      const quien = r.actor ? `${ROL_ETIQUETA[r.actor_rol] || r.actor_rol || ''} ${r.actor}`.trim() : 'Sistema'
      const detalle = det(r.detalle || {})
      return `<div class="row log-row">
        <span class="row-icon ${cls}">${icon(ico)}</span>
        <span class="row-text"><span class="row-title">${esc(titulo)}</span><span class="row-sub">${detalle ? `${esc(detalle)}<br>` : ''}${esc(quien)} · ${esc(fmtFecha(f))} · ${esc(fmtHora(f))}</span></span>
      </div>`
    },
    empty: emptyState('i-shield', 'Sin actividad todavía', 'Aquí verás pagos, cortes, cambios y alertas.')
  })
}

$('#view-admin').addEventListener('tabchange', e => {
  if (e.detail === 'admin-tab-log') cargarBitacora()
  if (e.detail === 'admin-tab-inbox') buzon.adminAbrir()
  if (e.detail === 'admin-tab-balance') diesel.refrescar()
})

// --- 12. TIEMPO REAL ---
supabase
  .channel('estado_viaje_channel')
  .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'estado_viaje' }, ({ new: row }) => {
    const cambio = aplicarEstadoViaje(row)
    if (!cambio || !sessionToken) return
    // El corte cambia el estado a EN_CAMINO: refrescar saldo e historial del alumno
    if (currentRole === 'Estudiante') refrescarAlumno()
    // Otro teléfono hizo el corte o finalizó este camión: la lista cambió
    if (currentRole === 'Chofer' && row.id === camionActual) fetchPassengers()
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
  if (currentRole === 'Estudiante') {
    refrescarAlumno()
    asientos.cargar()
  }
  if (currentRole === 'Chofer') {
    fetchPassengers()
    asientosChofer.cargar()
  }
  buzon.refrescar()
  diesel.refrescar()
})

// --- 13. INTRO Y ARRANQUE ---
// El color de la barra del sistema sigue a la pantalla visible
// (la bienvenida y el inicio de sesión son siempre oscuros)
let pantallaVisible = null
function actualizarThemeColor() {
  const bg = getComputedStyle(pantallaVisible || document.documentElement).getPropertyValue('--bg').trim()
  $('meta[name="theme-color"]').setAttribute('content', bg || '#000000')
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', actualizarThemeColor)
document.addEventListener('screenchange', e => {
  pantallaVisible = document.getElementById(e.detail.id)
  // Durante la intro la barra se queda negra; al terminar se actualiza
  if (!document.getElementById('splash')) actualizarThemeColor()
})

// Fondo vivo de la bienvenida y del inicio de sesión
initAmbiente(document.getElementById('view-roles'))
initAmbiente(document.getElementById('view-login'))

// Al terminar la intro se abre la sesión guardada o la bienvenida.
// Regresa dónde debe aterrizar el logotipo (solo en la bienvenida).
function arrancar() {
  const sesion = leerSesion()
  if (sesion?.token && ROLES[sesion.rol]) {
    sessionToken = sesion.token
    if (sesion.debe_cambiar) {
      currentRole = sesion.rol
      showScreen('view-roles')
      revealWords(rolesTitle)
      setTimeout(() => pedirCambioPassword({ obligatorio: true, alTerminar: () => entrar(sesion.rol, sesion.perfil || {}) }), 500)
      return $('#view-roles .wordmark')
    }
    entrar(sesion.rol, sesion.perfil || {})
    return null
  }
  showScreen('view-roles')
  revealWords(rolesTitle)
  return $('#view-roles .wordmark')
}

runIntro({ alSalir: arrancar, alTerminar: actualizarThemeColor })

cargarEstadoViaje()
fetchScheduleMatrix()

// --- 14. PWA: SERVICE WORKER (solo en producción para no cachear en desarrollo) ---
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(err => console.error('Error al registrar el service worker:', err))
  })
}
