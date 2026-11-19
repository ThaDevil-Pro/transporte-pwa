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
import { actualizarCamiones, actualizarCamion, camionCorto, nombreCamion, puntoCamion, capacidad, etiquetaVehiculo, listaCamiones, vehiculo, TIPOS, UBICACIONES, ubicacionNombre, siFaltaVehiculo, alCambiarVehiculos } from './camiones.js'
import { initEditorVehiculo } from './editor-vehiculo.js'
import { initFotos, selectorFoto, urlFoto } from './fotos.js'
import { initInstalar, initPush } from './push.js'
import {
  $, $$, esc, icon, avatar, emptyState, skeletonRows, haptic,
  initScreens, showScreen, initTabs, selectTab, initSegmented,
  initSheets, openSheet, closeSheet, closeAllSheets,
  confirm, actionSheet, toast, setLoading, shake, collapse, opciones,
  animateNumber, setDigits, revealWords, patchList, initPasswordToggles, ocultarPasswords
} from './ui.js'

// --- 0. CONFIGURACIÓN Y ESTADO GLOBAL ---
// $60 por viaje redondo: el regreso del mismo día va incluido (lo calcula el servidor)
const PRECIO_VIAJE = 60
// Desde Chinacates el boleto cuesta $40 (el servidor lo manda en el perfil)
const precioAlumno = () => Number(perfilActual.precio) || PRECIO_VIAJE
const OPCIONES_UBICACION = Object.entries(UBICACIONES).map(([value, u]) => ({ value, label: u.nombre, sub: `Boleto $${u.precio}` }))
const ADEUDO_MAXIMO = 600
const GAUGE_C = 339.292 // circunferencia del anillo (r = 54)
const SESSION_KEY = 'camify.sesion'
const DISPOSITIVO_KEY = 'camify.dispositivo'
const DIAS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes']
const DIAS_NOMBRE = { lunes: 'Lunes', martes: 'Martes', miercoles: 'Miércoles', jueves: 'Jueves', viernes: 'Viernes' }
const DIAS_CORTO = { lunes: 'Lun', martes: 'Mar', miercoles: 'Mié', jueves: 'Jue', viernes: 'Vie' }

const ROLES = {
  Estudiante: { icon: 'i-student', tint: 'blue', title: 'Estudiante', subtitle: 'Entra con tu matrícula y contraseña.', idLabel: 'Matrícula', screen: 'view-student', error: 'Número de control o contraseña incorrectos.' },
  Chofer: { icon: 'i-wheel', tint: 'orange', title: 'Chofer', subtitle: 'Entra con tu número de licencia.', idLabel: 'Número de licencia', screen: 'view-driver', error: 'Número de licencia o contraseña incorrectos.' },
  Admin: { icon: 'i-shield', tint: 'indigo', title: 'Administración', subtitle: 'Acceso para gestionar usuarios y saldos.', idLabel: 'Usuario', screen: 'view-admin', error: 'Usuario o contraseña incorrectos.' },
  Financiero: { icon: 'i-wallet', tint: 'green', title: 'Financiero', subtitle: 'Cobros, pagos y saldos de los alumnos.', idLabel: 'Usuario', screen: 'view-finanzas', error: 'Usuario o contraseña incorrectos.' }
}
const ROL_ETIQUETA = { Estudiante: 'Alumno', Chofer: 'Chofer', Admin: 'Admin', Financiero: 'Financiero' }

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

// Vehículos: cada uno tiene su estado de viaje (estado_viaje.id = vehículo)
// y su nombre, color y acomodo de asientos en camiones.js
let estados = {}
let camionActual = null // el de la jornada de hoy del chofer
let camionAlumno = null // el del próximo asiento apartado del alumno
// Cupo del vehículo del chofer (nunca 0, para no dividir entre cero)
const cupo = () => capacidad(camionActual) || 1

// --- 1. FORMATO ---
const money = new Intl.NumberFormat('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtMoney = n => `$${money.format(Number(n) || 0)}`
// Saldo negativo = dinero a favor del alumno
const fmtSaldo = n => (Number(n) < 0 ? `${fmtMoney(-n)} a favor` : fmtMoney(n))
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
initTabs($('#view-finanzas'))

// Instalar la app (bienvenida) y notificaciones push del alumno
initInstalar({ boton: $('#btn-instalar') })
const push = initPush({ rpc })

// Asientos y parejas del alumno (rpc es una declaración de función, ya disponible)
const asientos = initAsientos({
  rpc,
  precio: () => precioAlumno(),
  alCobrar: () => refrescarAlumno(),
  // La tarjeta de viaje del alumno sigue al camión de su próximo asiento apartado
  alCambiarSalidas: salidas => {
    const s = salidas.find(x => x.mi_asiento) || salidas[0]
    const nuevo = perfilActual.abordo ?? s?.camion ?? null
    $('#trip-bus-label').textContent = nuevo ? nombreCamion(nuevo) : 'Sin salidas'
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
$('#btn-fin-report-gastos').addEventListener('click', () => reportes.abrir({ rol: 'Financiero', perfil: perfilActual }))

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
  // El chofer todavía no elige el vehículo de su jornada (o cambió el día)
  if (res.error?.code === 'CMF04' && currentRole === 'Chofer') verificarJornada()
  // El alumno todavía no dice dónde toma el camión
  if (res.error?.code === 'CMF05' && currentRole === 'Estudiante') pedirUbicacion()
  return res
}

function entrar(rol, perfil, transition = 'fade') {
  currentRole = rol
  perfilActual = perfil || {}
  sesionExpirada = false
  pintarCuentaLateral(rol, perfil)
  if (rol === 'Estudiante') iniciarAlumno(perfil)
  else if (rol === 'Chofer') iniciarChofer(perfil)
  else if (rol === 'Financiero') iniciarFinanzas()
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
  // supabase-js solo envía la petición al consumir la promesa.
  // Primero se desliga este teléfono de las notificaciones (necesita la sesión viva) y luego se cierra.
  const token = sessionToken
  if (token) push.alSalir(token).finally(() => supabase.rpc('logout', { p_token: token }).then(() => {}, () => {}))
  borrarSesion()
  stopScanner()
  closeAllSheets({ force: true })
  asientos.limpiar()
  asientosChofer.limpiar()
  buzon.limpiar()
  diesel.limpiar()
  passengers = []
  copyPassengers = []
  camionActual = null
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
  push.alEntrar('Estudiante')
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
  const ubic = UBICACIONES[perfil.ubicacion]
  const chipUbic = $('#student-ubicacion')
  chipUbic.hidden = !ubic
  if (ubic) {
    chipUbic.className = `chip-id chip-ubic ubic-${perfil.ubicacion}`
    chipUbic.textContent = `${ubic.nombre} · boleto $${Number(perfil.precio) || ubic.precio}`
  }

  const saldo = Number(perfil.saldo) || 0
  animateNumber($('#student-balance'), Math.abs(saldo), { decimals: 2 })
  $('#student-balance-card').dataset.state = saldo > 0 ? 'due' : 'clear'
  $('#student-balance-label').textContent = saldo < 0 ? 'Saldo a favor' : 'Saldo pendiente'
  const viajes = saldo / (Number(perfil.precio) || PRECIO_VIAJE)
  $('#student-balance-status').textContent = saldo < 0
    ? 'Se descuenta de tus próximos viajes'
    : saldo === 0
      ? 'Estás al corriente'
      : saldo > ADEUDO_MAXIMO
        ? `Pasaste el máximo de ${fmtMoney(ADEUDO_MAXIMO)}: paga para poder subir`
        : Number.isInteger(viajes) ? `${plural(viajes, 'viaje redondo', 'viajes redondos')} por pagar` : 'Pendiente de pago'
}

// Refresca saldo e historial del alumno (por ejemplo, después de un corte)
async function refrescarAlumno() {
  const { data: perfil } = await rpc('alumno_perfil')
  if (perfil && currentRole === 'Estudiante') {
    perfilActual = { ...perfilActual, ...perfil }
    renderPerfilAlumno(perfil)
    if (perfil.abordo && perfil.abordo !== camionAlumno) {
      camionAlumno = perfil.abordo
      $('#trip-bus-label').textContent = nombreCamion(camionAlumno)
    }
    sincronizarViaje()
    if (!perfil.ubicacion) pedirUbicacion()
  }
  cargarHistorialAlumno()
}

// --- UBICACIÓN: el alumno elige una sola vez dónde toma el camión ---
const sheetUbicacion = $('#sheet-ubicacion')

function pedirUbicacion() {
  if (currentRole !== 'Estudiante' || sheetUbicacion.classList.contains('is-open')) return
  sheetUbicacion.dataset.locked = '1'
  openSheet(sheetUbicacion)
}

$('#ubicacion-opciones').addEventListener('click', async e => {
  const b = e.target.closest('[data-ubicacion]')
  if (!b) return
  const u = UBICACIONES[b.dataset.ubicacion]
  const ok = await confirm({
    title: `¿Tomas el camión en ${u.nombre}?`,
    message: `Tu boleto costará ${fmtMoney(u.precio)}. No podrás cambiarla después: solo la administración puede hacerlo en las oficinas.`,
    confirmLabel: `Sí, ${u.nombre}`
  })
  if (!ok) return
  setLoading(b, true)
  const { error } = await rpc('alumno_elegir_ubicacion', { p_ubicacion: b.dataset.ubicacion })
  setLoading(b, false)
  delete sheetUbicacion.dataset.locked
  await closeSheet(sheetUbicacion, { force: true })
  if (error) toast(error.message, { type: 'error', duration: 4000 })
  else {
    haptic([10, 40, 14])
    toast(`Listo: subes en ${u.nombre}`, { type: 'success' })
  }
  // Si ya tenía una (otra pestaña), el perfil la trae; si no, se vuelve a pedir
  refrescarAlumno()
  asientos.cargar()
})

$('#btn-ubicacion-logout').addEventListener('click', async () => {
  delete sheetUbicacion.dataset.locked
  await closeSheet(sheetUbicacion, { force: true })
  cerrarSesion()
})

async function cargarHistorialAlumno() {
  const { data: movimientos, error } = await rpc('alumno_historial')
  if (error || !Array.isArray(movimientos)) return

  const viajes = movimientos.filter(m => m.tipo !== 'pago' && !m.perdido).length
  $('#student-history-meta').textContent = viajes ? plural(viajes, 'viaje', 'viajes') : ''
  patchList($('#student-history-list'), movimientos, {
    key: m => m.id,
    render: m => {
      const f = new Date(m.fecha_hora)
      const pago = m.tipo === 'pago'
      const perdido = !pago && m.perdido
      return `<div class="row">
        <span class="row-icon${pago ? ' is-money' : perdido ? ' is-alert' : ''}">${icon(pago ? 'i-wallet' : perdido ? 'i-alert' : 'i-bus')}</span>
        <span class="row-text"><span class="row-title">${pago ? 'Pago registrado' : perdido ? 'Apartado perdido' : Number(m.monto) ? 'Viaje cobrado' : 'Regreso incluido'}</span><span class="row-sub">${esc(fmtFecha(f))} · ${esc(fmtHora(f))}${perdido ? ' · Apartaste y no subiste' : ''}${pago && m.nota ? ` · ${esc(m.nota)}` : ''}${m.manual ? ' · Registrado a mano por el chofer' : ''}</span></span>
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
let qrBloqueo = null // mensaje del servidor cuando el adeudo pasa del máximo

async function cargarCodigosQR() {
  qrCargando = true
  const { data, error } = await rpc('alumno_qr')
  qrCargando = false
  qrBloqueo = error?.code === 'CMF02' ? error.message : null
  if (qrBloqueo) {
    // Los códigos guardados tampoco sirven: el chofer no lo dejaría subir
    qrDatos = null
    try { localStorage.removeItem(QR_KEY) } catch { /* modo privado */ }
  }
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
  card.classList.toggle('is-blocked', !c && !!qrBloqueo)
  if (!c) {
    $('#qr-countdown').textContent = qrBloqueo || (cargando ? 'Preparando tu código…' : 'Sin conexión: conéctate para generar tu código')
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
  enroute: { label: 'En camino', headline: 'Viaje en curso', sub: 'Buen viaje. Tu saldo ya incluye este recorrido.' },
  gone: { label: 'Ya salió', headline: 'Este viaje ya salió', sub: 'No vas a bordo. Revisa tu próxima salida en «Tu asiento».' }
}

function estadoTarjeta() {
  const ahora = Date.now()
  if (estadoViaje === 'EN_CAMINO') return currentRole === 'Estudiante' && perfilActual.abordo !== camionAlumno ? 'gone' : 'enroute'
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
    .order('id', { ascending: true })

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
        ${esProxima ? '<span class="next-tag is-live"><span class="status-dot"></span>Próxima</span>' : `<span class="badge badge-bus">${icon('i-bus')}${camionCorto(s.camion)}</span>`}
      </div>`
    },
    empty: emptyState('i-calendar', 'Sin salidas', `No hay salidas programadas el ${DIAS_NOMBRE[dia].toLowerCase()}.`)
  })
}

function renderDriverSchedule() {
  // Solo las salidas del camión que maneja el chofer, en el orden en que se crearon
  const filas = scheduleRows
    .filter(r => (r.camion || 1) === camionActual)
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id)
  $('#driver-schedule-eyebrow').textContent = `${camionCorto(camionActual)} · Semana`
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
    empty: emptyState('i-calendar', 'Sin horarios', `Agrega la primera salida de ${camionCorto(camionActual)}.`)
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

// Sin horas sugeridas: una hora sugerida que no se cambiaba se borraba al pasar al siguiente día
driverScheduleList.addEventListener('focusin', e => {
  if (e.target.classList.contains('schedule-time-input')) isEditingSchedule = true
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
  camionActual = null
  aplicarCamion()
  verificarJornada()
  push.alEntrar('Chofer')
}

// Carga todo lo del vehículo de la jornada del chofer
// Nombre del vehículo: de la lista o, si todavía no llega, de la jornada del chofer
const nombreDeJornada = id => vehiculo(id)?.nombre || jornada?.vehiculos?.find(v => v.id === id)?.nombre || camionCorto(id)
const pintarNombreCamion = () => {
  $('#camion-label').innerHTML = camionActual ? `${puntoCamion(camionActual)}${esc(nombreDeJornada(camionActual))}` : 'Elige vehículo'
}

function aplicarCamion() {
  pintarNombreCamion()
  $('#passengers-count').dataset.value = '0'
  passengers = []
  sincronizarViaje()
  renderDriverSchedule()
  if (!camionActual) {
    $('#students-ul').replaceChildren()
    renderPassengersUI()
    asientosChofer.limpiar()
    return
  }
  $('#students-ul').innerHTML = skeletonRows(3)
  fetchPassengers()
  asientosChofer.cargar()
  diesel.chofer()
}

// --- JORNADA: cada día, antes de trabajar, el chofer elige su vehículo ---
const sheetJornada = $('#sheet-jornada')
let jornada = null

async function verificarJornada({ cambiar = false } = {}) {
  if (currentRole !== 'Chofer') return
  const { data, error } = await rpc('chofer_jornada')
  if (error || !data || currentRole !== 'Chofer') return
  jornada = data
  if (data.camion && !cambiar) {
    if (data.camion !== camionActual) {
      camionActual = data.camion
      aplicarCamion()
    }
    return
  }
  if (!data.camion && camionActual) {
    // Empezó otro día: se vuelve a preguntar
    camionActual = null
    aplicarCamion()
  }
  pedirVehiculo({ obligatorio: !data.camion })
}

function pedirVehiculo({ obligatorio }) {
  const lista = $('#jornada-list')
  const vehiculos = jornada?.vehiculos || []
  if (obligatorio) sheetJornada.dataset.locked = '1'
  else delete sheetJornada.dataset.locked
  $('#sheet-jornada-title').textContent = obligatorio ? '¿En qué vehículo vas a trabajar hoy?' : 'Cambiar de vehículo'
  $('#jornada-lead').textContent = obligatorio
    ? 'Elige el vehículo de tu jornada para empezar. Mañana te lo volveremos a preguntar.'
    : 'Solo puedes cambiar si no llevas pasajeros a bordo.'
  $('#btn-jornada-logout').hidden = !obligatorio
  lista.innerHTML = vehiculos.length
    ? vehiculos.map(v => {
        const ocupado = !!v.ocupado_por
        const mio = v.id === camionActual
        return `<button type="button" class="row jornada-row" data-vehiculo="${esc(v.id)}"${ocupado ? ' aria-disabled="true"' : ''}>
          <span class="row-icon jornada-icon" style="--bus:${esc(v.color)}">${icon('i-bus')}</span>
          <span class="row-text"><span class="row-title">${esc(v.nombre)} – ${esc(TIPOS[v.tipo] || 'Vehículo')}</span>
            <span class="row-sub">${ocupado ? `Lo tiene ${esc(v.ocupado_por)} hoy` : `${plural(v.capacidad, 'asiento', 'asientos')}${v.exclusivo ? ' · Exclusivo Chinacates' : ''}`}</span></span>
          <span class="row-trailing">${icon(mio ? 'i-check' : ocupado ? 'i-lock' : 'i-chevron-right')}</span>
        </button>`
      }).join('')
    : emptyState('i-bus', 'Aún no hay vehículos', 'Pide a la administración que dé de alta los vehículos en la app.')
  if (!sheetJornada.classList.contains('is-open')) openSheet(sheetJornada)
}

$('#jornada-list').addEventListener('click', async e => {
  const fila = e.target.closest('[data-vehiculo]')
  if (!fila) return
  const id = Number(fila.dataset.vehiculo)
  const v = jornada?.vehiculos?.find(x => x.id === id)
  if (v?.ocupado_por) {
    toast(`${v.nombre} ya lo tiene ${v.ocupado_por} hoy`, { type: 'warning' })
    return
  }
  setLoading(fila, true)
  const { error } = await rpc('chofer_elegir_vehiculo', { p_camion: id })
  setLoading(fila, false)
  if (error) {
    toast(error.message || 'No se pudo elegir el vehículo', { type: 'error', duration: 4000 })
    verificarJornada({ cambiar: !!camionActual })
    return
  }
  haptic([10, 40, 14])
  await closeSheet(sheetJornada, { force: true })
  delete sheetJornada.dataset.locked
  const cambio = id !== camionActual
  camionActual = id
  if (cambio) aplicarCamion()
  toast(`Hoy trabajas en ${v ? `${v.nombre} – ${TIPOS[v.tipo] || 'Vehículo'}` : etiquetaVehiculo(id)}`, { type: 'success' })
})

$('#btn-jornada-logout').addEventListener('click', async () => {
  await closeSheet(sheetJornada, { force: true })
  delete sheetJornada.dataset.locked
  cerrarSesion()
})

$('#btn-camion').addEventListener('click', () => verificarJornada({ cambiar: true }))

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
  $('#gauge-fill').style.strokeDashoffset = String(GAUGE_C * (1 - Math.min(n, cupo()) / cupo()))
  $('#gauge-max').textContent = camionActual ? `de ${cupo()}` : 'sin vehículo'
  $('#driver-hero').dataset.level = n >= cupo() ? 'full' : n >= cupo() - 5 ? 'high' : 'normal'
  const dePie = passengers.filter(p => p.de_pie).length
  $('#scanner-count').textContent = dePie ? `${n} a bordo · ${dePie} de pie` : `${n} de ${cupo()} a bordo`
  $('#btn-clear-list').hidden = n === 0 || isTripActive

  patchList($('#students-ul'), passengers, {
    key: p => p.id,
    render: p => `<div class="row">
      ${avatar(p.nombre)}
      <span class="row-text"><span class="row-title">${esc(p.nombre)}</span><span class="row-sub">${esc(p.matricula)}</span></span>
      ${UBICACIONES[p.ubicacion] ? `<span class="badge badge-ubic ubic-${p.ubicacion}" title="${ubicacionNombre(p.ubicacion)}">${UBICACIONES[p.ubicacion].corto}</span>` : ''}
      ${p.de_pie ? '<span class="badge badge-standing">De pie</span>' : ''}
      ${p.manual ? '<span class="badge badge-manual" title="Registrado a mano, sin código QR">A mano</span>' : ''}
      <button class="icon-btn icon-btn-sm icon-btn-danger btn-remove-student" data-id="${esc(p.id)}" aria-label="Quitar a ${esc(p.nombre)}">${icon('i-minus')}</button>
    </div>`,
    empty: emptyState('i-users', 'Nadie a bordo', 'Toca Escanear para registrar a cada alumno al subir, o Buscar alumno si no trae su código.')
  })

  renderDriverTrip()
}

// Cobro de cada pasajero en el corte: su boleto ($60, o $40 desde Chinacates) o $0 si es su regreso del día
const totalCorte = lista => lista.reduce((s, p) => s + (Number(p.cobro) || 0), 0)
// "3 × $60 · 2 × $40 · 1 de regreso"
function detalleCobro(lista) {
  const porMonto = new Map()
  lista.forEach(p => porMonto.set(Number(p.cobro) || 0, (porMonto.get(Number(p.cobro) || 0) || 0) + 1))
  return [...porMonto].sort((a, b) => b[0] - a[0]).map(([m, n]) => (m ? `${n} × ${fmtMoney(m)}` : `${n} de regreso`)).join(' · ')
}

function renderDriverTrip() {
  const n = passengers.length
  const dePie = passengers.filter(p => p.de_pie).length
  const hero = $('#driver-hero')
  hero.dataset.state = isTripActive ? 'enroute' : 'boarding'
  hero.classList.toggle('is-live', isTripActive)
  $('#driver-trip-status').textContent = isTripActive ? 'En camino' : 'Abordando'
  $('#driver-trip-headline').textContent = isTripActive ? 'Viaje en curso' : n >= cupo() ? 'Unidad llena' : 'Lista abierta'
  $('#driver-trip-sub').textContent = isTripActive
    ? 'Corte realizado. Finaliza el viaje al llegar.'
    : dePie ? `${plural(dePie, 'alumno va', 'alumnos van')} de pie.`
      : n ? `Quedan ${Math.max(0, cupo() - n)} lugares disponibles.` : 'Escanea el código de cada alumno al subir.'

  const corte = $('#corte-card')
  corte.dataset.state = isTripActive ? 'active' : 'idle'
  // Después del corte ya se cobró: no se puede quitar ni vaciar (el servidor también lo impide)
  $('#students-ul').classList.toggle('is-locked', isTripActive)
  $('#btn-clear-list').hidden = !passengers.length || isTripActive
  $('#corte-label').textContent = isTripActive ? 'Cobrado en este viaje' : 'Total del corte'
  $('#corte-total').textContent = fmtMoney(totalCorte(passengers))
  $('#corte-detail').textContent = n ? detalleCobro(passengers) : `0 × ${fmtMoney(PRECIO_VIAJE)}`
  if (!btnIniciarViaje.classList.contains('is-loading')) {
    btnIniciarViaje.textContent = isTripActive ? 'Finalizar viaje' : 'Hacer corte'
    btnIniciarViaje.disabled = !isTripActive && n === 0 && !camionActual
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
  const ok = await confirm({
    title: 'Hacer corte',
    message: n
      ? `A bordo: ${plural(n, 'alumno', 'alumnos')} (${detalleCobro(passengers)}). Quien apartó en esta salida y no subió pagará su boleto completo.`
      : 'Nadie subió. Solo se cobrará el boleto a quien apartó en esta salida y no llegó.',
    confirmLabel: `Cobrar ${fmtMoney(totalCorte(passengers))}`
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
  $('#comprobante-fecha-hora').textContent = `${camionCorto(camionActual)} · ${fmtFechaLarga(ahora)} · ${fmtHora(ahora)}`
  $('#comprobante-total').textContent = fmtMoney(totalCorte(copyPassengers))
  $('#comprobante-detalle').textContent = plural(n, 'alumno', 'alumnos')
  $('#tbody-comprobante').innerHTML = n
    ? copyPassengers.map((p, i) => `<div class="row receipt-row">
        <span class="receipt-index">${i + 1}</span>
        <span class="row-text"><span class="row-title">${esc(p.nombre || 'Alumno')}</span><span class="row-sub">${esc(p.matricula)}</span></span>
        <span class="row-trailing${Number(p.cobro) ? '' : ' is-muted'}">${Number(p.cobro) ? fmtMoney(p.cobro) : 'Regreso'}</span>
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

  const matriculaQR = /^CMF1\.([^.]+)\./.exec(scannedId)?.[1]
  const yaArriba = matriculaQR && passengers.find(p => String(p.matricula).trim() === matriculaQR)
  if (yaArriba) {
    haptic([20, 40, 20])
    setScanFeedback(`${primerNombre(yaArriba.nombre)} ya está a bordo`, 'warning', { volver: 2000 })
    return liberarEscaner(1200)
  }

  setScanFeedback('Validando…')

  // Supabase valida la matrícula, el adeudo, los duplicados y si ya no hay asientos (va de pie)
  const { data, error } = await rpc('chofer_registrar_abordaje', { p_camion: camionActual, p_matricula: scannedId })

  if (error || data?.error) {
    if (error) console.error('Error al registrar abordaje:', error)
    flash('error')
    haptic([30, 50, 30])
    setScanFeedback(data?.error || error.message, 'error', { volver: 2600 })
    return liberarEscaner(1500)
  }

  if (data.de_pie) {
    flash('success')
    haptic([20, 60, 20, 60, 20])
    setScanFeedback(`Vehículo lleno: ${primerNombre(data.nombre)} irá de pie`, 'warning', { volver: 3200 })
  } else if (data.asignado) {
    // Debe más de $60 y no pudo apartar: el sistema le dio el primer asiento libre sin apartar
    flash('success')
    haptic([20, 60, 20])
    setScanFeedback(`${primerNombre(data.nombre)} debe más de $60: dale el asiento ${data.asiento}`, 'warning', { volver: 3800 })
  } else {
    flash('success')
    haptic(30)
    // Si apartó lugar para esta salida, el chofer ve a qué asiento va
    const asiento = data.asiento ? ` · Asiento ${data.asiento}` : ''
    setScanFeedback(`${primerNombre(data.nombre)} está a bordo${asiento}`, 'success', { volver: 2200 })
  }
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
    .select('id, estado, tiempo_salida, temporizador_activo, nombre, color, tipo, cols, bloques, asientos, activo, exclusivo_chinacates')
  if (!data) return
  actualizarCamiones(data)
  pintarVehiculos()
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
const ubicNueva = opciones($('#admin-new-ubicacion'), OPCIONES_UBICACION)
const fotoNueva = selectorFoto({ boton: $('#btn-admin-new-foto'), input: $('#admin-new-foto'), vista: $('#admin-new-foto-vista'), nombre: () => $('#admin-new-name').value })
fotoNueva.reset()
// Fotos en lote: el nombre de cada archivo (número de control) dice de quién es
initFotos({ rpc, alumnos: () => alumnosCache, alTerminar: () => loadAdminData() })

function aplicarRolRegistro(rol) {
  $('#label-admin-identifier').textContent = ROLES[rol].idLabel
  collapse($('#group-admin-name'), rol === 'Admin')
  collapse($('#group-admin-initial-balance'), rol !== 'Estudiante')
}

// Vehículos (pestaña Registrar): lista, alta con el editor visual, edición y baja
const editorVehiculo = initEditorVehiculo({ rpc, alGuardar: () => cargarEstadoViaje() })
$('#btn-vehiculo-nuevo').addEventListener('click', () => editorVehiculo.nuevo())

function pintarVehiculos() {
  const lista = $('#admin-vehiculos-ul')
  if (!lista) return
  const vehiculos = listaCamiones()
  $('#admin-vehiculos-meta').textContent = vehiculos.length
    ? `${plural(vehiculos.length, 'vehículo', 'vehículos')} · ${plural(vehiculos.reduce((s, v) => s + v.asientos.length, 0), 'asiento', 'asientos')} en total`
    : 'Aún no hay vehículos'
  patchList(lista, vehiculos, {
    key: v => `${v.id}-${v.nombre}-${v.asientos.length}-${v.tipo}-${v.exclusivo}`,
    render: v => `<button class="row" data-vehiculo="${esc(v.id)}">
      <span class="row-icon jornada-icon" style="--bus:${esc(v.color)}">${icon('i-bus')}</span>
      <span class="row-text"><span class="row-title">${esc(v.nombre)}</span><span class="row-sub">${esc(TIPOS[v.tipo])} · ${plural(v.asientos.length, 'asiento', 'asientos')}${v.exclusivo ? ' · Exclusivo Chinacates' : ''}</span></span>
      ${icon('i-chevron-right', 'chevron')}
    </button>`,
    empty: emptyState('i-bus', 'Sin vehículos', 'Toca «Agregar vehículo» para dibujar el primero.')
  })
}

$('#admin-vehiculos-ul').addEventListener('click', async e => {
  const fila = e.target.closest('[data-vehiculo]')
  if (!fila) return
  const v = vehiculo(fila.dataset.vehiculo)
  if (!v) return
  const accion = await actionSheet({
    title: v.nombre,
    message: `${TIPOS[v.tipo]} · ${plural(v.asientos.length, 'asiento', 'asientos')}${v.exclusivo ? ' · Exclusivo para Chinacates' : ''}`,
    actions: [
      { label: 'Editar acomodo y nombre', value: 'editar' },
      { label: 'Dar de baja', value: 'baja', style: 'destructive' }
    ]
  })
  if (accion === 'editar') editorVehiculo.editar(v)
  if (accion === 'baja') {
    const ok = await confirm({
      title: `¿Dar de baja ${v.nombre}?`,
      message: 'Se borran sus horarios y los apartados de sus próximas salidas (se avisa a los alumnos). Su historial de viajes se conserva.',
      confirmLabel: 'Dar de baja',
      destructive: true
    })
    if (!ok) return
    const { error } = await rpc('admin_vehiculo_eliminar', { p_id: v.id })
    if (error) toast(error.message || 'No se pudo dar de baja', { type: 'error', duration: 4000 })
    else toast(`${v.nombre} dado de baja`, { type: 'success' })
    cargarEstadoViaje()
  }
})

function iniciarAdmin() {
  selectTab($('#view-admin'), 'admin-tab-register', { animate: false })
  pintarVehiculos()
  cargarEstadoViaje()
  aplicarRolRegistro(adminRole.value)
  $('#admin-users-ul').innerHTML = skeletonRows(4)
  $('#admin-balances-ul').innerHTML = skeletonRows(4)
  $('#admin-total-balance').dataset.value = '0'
  loadAdminData()
  buzon.admin()
  diesel.admin()
  push.alEntrar('Admin')
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
  // Ubicación y foto del alumno, si se eligieron
  const extras = role !== 'Estudiante' ? [] : [
    ubicNueva.value && rpc('admin_alumno_ubicacion', { p_matricula: identifier, p_ubicacion: ubicNueva.value }),
    fotoNueva.valor && rpc('admin_foto_guardar', { p_matricula: identifier, p_foto: fotoNueva.valor })
  ].filter(Boolean)
  const fallo = (await Promise.all(extras)).find(r => r.error)
  haptic([10, 40, 14])
  if (fallo) toast(`${ROL_ETIQUETA[role]} creado, pero: ${fallo.error.message}`, { type: 'warning', duration: 4500 })
  else toast(`${ROL_ETIQUETA[role]} creado`, { type: 'success' })
  formCreateUser.reset()
  ocultarPasswords(formCreateUser)
  $('#admin-new-balance').value = '0'
  ubicNueva.reset()
  fotoNueva.reset()
  loadAdminData()
})

formCreateUser.addEventListener('input', e => e.target.closest('.field')?.classList.remove('is-invalid'))

async function loadAdminData() {
  const { data, error } = await rpc('admin_usuarios')
  if (error) {
    console.error('Error al cargar usuarios:', error)
    return
  }
  const { alumnos, choferes, financieros = [], admins } = data
  alumnosCache = alumnos
  $('#fotos-meta').textContent = alumnos.length ? `${alumnos.filter(a => a.foto).length} de ${plural(alumnos.length, 'alumno tiene', 'alumnos tienen')} foto.` : ''
  allUsersCache = [
    ...alumnos.map(u => ({ ...u, rol: 'Estudiante', idStr: u.matricula })),
    ...choferes.map(u => ({ ...u, rol: 'Chofer', idStr: u.licencia })),
    ...financieros.map(u => ({ ...u, rol: 'Financiero', idStr: u.usuario })),
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
      <span class="row-text"><span class="row-title">${esc(u.nombre)}</span><span class="row-sub">${ROL_ETIQUETA[u.rol]} · ${esc(u.idStr)}${u.rol === 'Estudiante' ? ` · ${ubicacionNombre(u.ubicacion)}${u.foto ? '' : ' · sin foto'}` : ''}</span></span>
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

const ubicEdit = opciones($('#edit-user-ubicacion'), OPCIONES_UBICACION)
const fotoEdit = selectorFoto({
  boton: $('#btn-edit-user-foto'), input: $('#edit-user-foto'), vista: $('#edit-user-foto-vista'),
  quitar: $('#btn-edit-user-foto-quitar'), nombre: () => editingUser?.nombre
})

function abrirEditarUsuario(user) {
  editingUser = user
  const alumno = user.rol === 'Estudiante'
  $('#edit-user-alumno').hidden = !alumno
  if (alumno) {
    ubicEdit.set(user.ubicacion || null)
    fotoEdit.cargar(null)
    $('#edit-user-foto-nota').textContent = user.foto ? 'Cargando la foto…' : 'Sin foto: elige una o cárgalas en lote'
    if (user.foto) {
      rpc('admin_foto', { p_matricula: user.matricula }).then(({ data, error }) => {
        if (editingUser !== user) return
        if (!error && data) fotoEdit.cargar(urlFoto(data))
        $('#edit-user-foto-nota').textContent = error ? 'No se pudo cargar la foto' : 'La ve el chofer al tocar su asiento'
      })
    }
  }
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
  if (error) {
    setLoading(btn, false)
    toast(`Error al editar: ${error.message}`, { type: 'error' })
    return
  }
  // Ubicación y foto del alumno
  const u = editingUser
  const extras = u.rol !== 'Estudiante' ? [] : [
    ubicEdit.value && ubicEdit.value !== u.ubicacion && rpc('admin_alumno_ubicacion', { p_matricula: u.matricula, p_ubicacion: ubicEdit.value }),
    fotoEdit.valor === null && rpc('admin_foto_borrar', { p_matricula: u.matricula }),
    fotoEdit.valor && rpc('admin_foto_guardar', { p_matricula: u.matricula, p_foto: fotoEdit.valor })
  ].filter(Boolean)
  const fallo = (await Promise.all(extras)).find(r => r.error)
  setLoading(btn, false)
  await closeSheet('sheet-edit-user')
  if (fallo) toast(`Se guardó lo demás, pero: ${fallo.error.message}`, { type: 'warning', duration: 4500 })
  else toast(passwordNueva ? 'Contraseña restablecida: se le pedirá cambiarla al entrar' : 'Cambios guardados', { type: 'success' })
  loadAdminData()
})

$('#form-edit-user').addEventListener('input', e => e.target.closest('.field')?.classList.remove('is-invalid'))

// Saldos: la misma lista en administración y en finanzas (finanzas además busca y filtra)
const finFiltro = initSegmented($('#fin-filter-seg'), () => renderBalancesList())
$('#fin-search').addEventListener('input', () => renderBalancesList())
const sinAcentos = s => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()

function renderBalancesList() {
  const fin = currentRole === 'Financiero'
  const ui = fin
    ? { total: $('#fin-total-balance'), meta: $('#fin-balance-meta'), lista: $('#fin-balances-ul') }
    : { total: $('#admin-total-balance'), meta: $('#admin-balance-meta'), lista: $('#admin-balances-ul') }
  const ordenados = [...alumnosCache].sort((a, b) => (Number(b.saldo) || 0) - (Number(a.saldo) || 0) || a.nombre.localeCompare(b.nombre))
  const total = ordenados.reduce((s, a) => s + Math.max(0, Number(a.saldo) || 0), 0)
  const conAdeudo = ordenados.filter(a => Number(a.saldo) > 0).length
  const aFavor = ordenados.filter(a => Number(a.saldo) < 0).length

  animateNumber(ui.total, total, { decimals: 2 })
  ui.meta.textContent = conAdeudo
    ? `${plural(conAdeudo, 'alumno', 'alumnos')} con saldo pendiente`
    : 'Todos los alumnos están al corriente'
  if (aFavor) ui.meta.textContent += ` · ${plural(aFavor, 'con saldo', 'con saldo')} a favor`

  let visibles = ordenados
  const q = fin ? sinAcentos($('#fin-search').value.trim()) : ''
  if (fin) {
    const f = finFiltro.value
    visibles = ordenados.filter(a =>
      (f === 'adeudo' ? Number(a.saldo) > 0 : f === 'favor' ? Number(a.saldo) < 0 : true) &&
      (!q || sinAcentos(a.nombre).includes(q) || sinAcentos(a.matricula).includes(q)))
  }

  patchList(ui.lista, visibles, {
    key: a => a.id,
    render: a => {
      const saldo = Number(a.saldo) || 0
      return `<button class="row" data-id="${esc(a.id)}">
        ${avatar(a.nombre)}
        <span class="row-text"><span class="row-title">${esc(a.nombre)}</span><span class="row-sub">${esc(a.matricula)}${UBICACIONES[a.ubicacion] ? ` · ${ubicacionNombre(a.ubicacion)}` : ''}</span></span>
        <span class="row-trailing${saldo > ADEUDO_MAXIMO ? ' is-warning' : saldo < 0 ? ' is-positive' : saldo > 0 ? '' : ' is-muted'}">${fmtSaldo(saldo)}</span>
        ${icon('i-chevron-right', 'chevron')}
      </button>`
    },
    empty: alumnosCache.length
      ? emptyState('i-search', 'Sin resultados', q ? 'Prueba con otro nombre o matrícula.' : 'Ningún alumno en este filtro.')
      : emptyState('i-users', 'Sin alumnos', 'Registra alumnos para ver sus saldos.')
  })
}

async function cargarSaldosFinanzas() {
  const { data, error } = await rpc('finanzas_alumnos')
  if (error || !Array.isArray(data)) return
  alumnosCache = data
  renderBalancesList()
}

const recargarSaldos = () => (currentRole === 'Financiero' ? cargarSaldosFinanzas() : loadAdminData())

function iniciarFinanzas() {
  selectTab($('#view-finanzas'), 'fin-tab-balance', { animate: false })
  $('#fin-search').value = ''
  finFiltro.select('todos', false)
  $('#fin-balances-ul').innerHTML = skeletonRows(4)
  $('#fin-total-balance').dataset.value = '0'
  cargarSaldosFinanzas()
}

$('#view-finanzas').addEventListener('tabchange', e => {
  if (e.detail === 'fin-tab-balance') cargarSaldosFinanzas()
  if (e.detail === 'fin-tab-log') cargarBitacora({
    lista: $('#fin-log-ul'),
    nombre: 'finanzas_movimientos',
    vacio: emptyState('i-receipt', 'Sin movimientos todavía', 'Aquí verás cada pago y corrección de saldo.')
  })
})

// Saldos: registrar un pago (baja el saldo y queda en el historial) o corregirlo con motivo
const balanceMode = initSegmented($('#balance-mode-seg'), aplicarModoSaldo)

function aplicarModoSaldo(modo) {
  const saldo = Number(editingAlumno?.saldo) || 0
  const pago = modo === 'pago'
  const input = $('#edit-balance-amount')
  $('#edit-balance-label').textContent = pago ? 'Monto del pago ($)' : 'Saldo correcto ($, negativo si es a favor)'
  // El teclado decimal del iPhone no tiene signo menos
  input.inputMode = pago ? 'decimal' : 'text'
  $('#edit-balance-note-label').textContent = pago ? 'Nota (opcional): efectivo, transferencia…' : 'Motivo de la corrección (obligatorio)'
  $('#btn-save-balance').textContent = pago ? 'Registrar pago' : 'Guardar corrección'
  input.value = pago ? '' : saldo.toFixed(2)
  $('#edit-balance-note').value = ''
  const rapidos = pago
    ? [[60, '$60'], [300, '$300'], ...(saldo > 0 ? [['todo', `Todo (${fmtMoney(saldo)})`]] : [])]
    : [[-60, '−$60'], [60, '+$60'], [0, 'En cero']]
  $('#balance-quick').innerHTML = rapidos.map(([v, t]) => `<button type="button" class="btn ${v === 'todo' ? 'btn-tinted-green' : 'btn-secondary'}" data-quick="${v}">${esc(t)}</button>`).join('')
  $$('.field', $('#form-edit-balance')).forEach(f => f.classList.remove('is-invalid'))
}

function abrirSaldo(e) {
  const row = e.target.closest('.row[data-id]')
  if (!row) return
  editingAlumno = alumnosCache.find(a => String(a.id) === row.dataset.id)
  if (!editingAlumno) return
  $('#sheet-edit-balance-title').textContent = 'Saldo'
  $('#edit-balance-person').innerHTML = personaHTML(editingAlumno.nombre, editingAlumno.matricula)
  $('#edit-balance-current').textContent = fmtSaldo(editingAlumno.saldo)
  const saldo = Number(editingAlumno.saldo) || 0
  balanceMode.select(saldo > 0 ? 'pago' : 'ajuste', false)
  aplicarModoSaldo(balanceMode.value)
  openSheet('sheet-edit-balance')
}
$('#admin-balances-ul').addEventListener('click', abrirSaldo)
$('#fin-balances-ul').addEventListener('click', abrirSaldo)

$('#form-edit-balance').addEventListener('click', e => {
  const btn = e.target.closest('[data-quick]')
  if (!btn) return
  const input = $('#edit-balance-amount')
  const saldo = Number(editingAlumno?.saldo) || 0
  const v = btn.dataset.quick
  if (balanceMode.value === 'pago') {
    input.value = (v === 'todo' ? saldo : Number(v)).toFixed(2)
  } else {
    const actual = parseFloat(input.value) || 0
    input.value = (Number(v) === 0 ? 0 : actual + Number(v)).toFixed(2)
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
  const invalido = (campo, msg) => {
    campo.closest('.field').classList.add('is-invalid')
    shake(campo.closest('.field'))
    if (msg) toast(msg, { type: 'warning' })
  }
  if (input.value.trim() === '' || !Number.isFinite(valor)) return invalido(input)
  if (pago && valor <= 0) return invalido(input, 'El pago debe ser mayor a $0')
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
  recargarSaldos()
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
  pago_registrado: ['Pago registrado', 'i-wallet', 'is-money', d => `${d.nombre ? `${d.nombre} · ` : ''}${d.matricula} · ${fmtMoney(d.monto)}${d.nota ? ` · ${d.nota}` : ''}`],
  saldo_ajustado: ['Saldo corregido', 'i-receipt', '', d => `${d.nombre ? `${d.nombre} · ` : ''}${d.matricula} · ${fmtSaldo(d.antes)} → ${fmtSaldo(d.despues)}${d.motivo ? ` · ${d.motivo}` : ''}`],
  corte: ['Corte de viaje', 'i-bus', 'is-money', d => `${camionCorto(d.camion)}${d.salida ? ` ${d.salida}` : ''} · ${plural(d.alumnos, 'alumno', 'alumnos')} · ${d.monto_perdidos ? `${fmtMoney(d.total - d.monto_perdidos)} + ${fmtMoney(d.monto_perdidos)} de perdidos` : fmtMoney(d.total)}${d.manuales ? ` · ${d.manuales} a mano` : ''}${d.de_pie ? ` · ${d.de_pie} de pie` : ''}${d.perdidos ? ` · ${plural(d.perdidos, 'apartado perdido', 'apartados perdidos')}` : ''}`],
  apartado_recuperado: ['Apartado recuperado tras cancelar', 'i-receipt', 'is-money', d => `salida de las ${d.hora} · se devolvieron ${fmtMoney(d.monto)}`],
  apartado_cancelado_tarde: ['Apartado cancelado en la última hora', 'i-alert', 'is-money', d => `${camionCorto(d.camion)} · salida de las ${d.hora} · se cobró ${fmtMoney(d.monto)}`],
  ubicacion_elegida: ['Ubicación elegida por el alumno', 'i-pin', '', d => ubicacionNombre(d.ubicacion)],
  ubicacion_cambiada: ['Ubicación del alumno cambiada', 'i-pin', 'is-alert', d => `${d.nombre ? `${d.nombre} · ` : ''}${d.matricula} · ${d.antes ? ubicacionNombre(d.antes) : 'Sin ubicación'} → ${ubicacionNombre(d.despues)}`],
  fotos_cargadas: ['Fotos de alumnos cargadas', 'i-camera', '', d => plural(d.fotos || 0, 'foto', 'fotos')],
  foto_borrada: ['Foto de alumno quitada', 'i-camera', '', d => d.matricula || ''],
  emergencia: ['Emergencia del camión', 'i-alert', 'is-alert', d => `${camionCorto(d.camion)} · ${d.motivo === 'descompuesto' ? 'Se descompuso' : 'No estará disponible'} · avisó a ${plural(d.avisados || 0, 'alumno', 'alumnos')}`],
  abordaje_manual: ['Abordaje registrado a mano', 'i-hand', 'is-alert', d => `${camionCorto(d.camion)} · ${d.nombre ? `${d.nombre} · ` : ''}${d.matricula}${d.asiento ? ` · Asiento ${d.asiento}` : ''}${d.de_pie ? ' · De pie' : ''}`],
  usuarios_importados: ['Usuarios importados', 'i-sheet', '', d => [
    d.alumnos && plural(d.alumnos, 'alumno', 'alumnos'),
    d.choferes && plural(d.choferes, 'chofer', 'choferes'),
    d.fallidos && `${d.fallidos} con error`
  ].filter(Boolean).join(' · ') || 'Ningún usuario creado'],
  viaje_finalizado: ['Viaje finalizado', 'i-flag', '', d => `${camionCorto(d.camion)}`],
  lista_vaciada: ['Lista vaciada sin cobrar', 'i-trash', 'is-alert', d => `${camionCorto(d.camion)} · ${plural(d.alumnos || 0, 'alumno', 'alumnos')}`],
  alumno_quitado: ['Alumno quitado de la lista', 'i-minus', '', d => `${camionCorto(d.camion)} · ${d.matricula}`],
  qr_rechazado: ['Código QR rechazado', 'i-alert', 'is-alert', d => `${{ formato: 'No es de CAMIFY', firma: 'Falsificado', vencido: 'Vencido' }[d.motivo] || d.motivo}${d.matricula ? ` · ${d.matricula}` : ''} · ${camionCorto(d.camion)}`],
  login_bloqueado: ['Bloqueo por intentos fallidos', 'i-lock', 'is-alert', d => detalleBloqueo(String(d.clave || ''))],
  usuario_creado: ['Usuario creado', 'i-user-plus', '', d => `${ROL_ETIQUETA[d.rol] || d.rol} · ${d.nombre ? `${d.nombre} · ` : ''}${d.identificador}`],
  usuario_editado: ['Usuario editado', 'i-users', '', d => `${ROL_ETIQUETA[d.rol] || d.rol} · ${d.identificador}${d.password_restablecida ? ' · contraseña restablecida' : ''}`],
  usuario_eliminado: ['Usuario eliminado', 'i-trash', 'is-alert', d => `${ROL_ETIQUETA[d.rol] || d.rol} · ${d.nombre ? `${d.nombre} · ` : ''}${d.identificador}`],
  cambio_password: ['Cambio de contraseña', 'i-lock', '', () => ''],
  falla_reportada: ['Falla del camión reportada', 'i-wrench', 'is-alert', d => `${camionCorto(d.camion)} · ${FALLA_TIPO[d.tipo] || d.tipo} · ${FALLA_GRAVEDAD[d.gravedad] || d.gravedad}`],
  falla_actualizada: ['Falla del camión actualizada', 'i-wrench', '', d => `Reporte #${d.id} · ${{ abierta: 'Abierta', reparacion: 'En reparación', resuelta: 'Resuelta' }[d.estado] || d.estado}`],
  queja_actualizada: ['Queja atendida', 'i-inbox', '', d => `Queja #${d.id} · ${{ nueva: 'Nueva', revision: 'En revisión', atendida: 'Atendida' }[d.estado] || d.estado}${d.respondida ? ' · con respuesta' : ''}`],
  diesel_registrado: ['Carga de diésel registrada', 'i-fuel', 'is-money', d => `${camionCorto(d.camion)} · ${fmtLitros(d.litros)} · ${fmtMoney(d.importe)}`],
  diesel_actualizado: ['Carga de diésel revisada', 'i-fuel', '', d => `Carga #${d.id} · ${camionCorto(d.camion)} · ${ESTADO_CARGA[d.estado]?.label || d.estado}${d.corregida ? ' · datos corregidos' : ''}`],
  diesel_tanque: ['Capacidad del tanque', 'i-gauge', '', d => `${camionCorto(d.camion)} · ${d.litros ? fmtLitros(d.litros) : 'sin dato'}`],
  vehiculo_guardado: ['Vehículo guardado', 'i-bus', '', d => `${d.nombre} · ${TIPOS[d.tipo] || ''} · ${plural(d.asientos || 0, 'asiento', 'asientos')}${d.exclusivo ? ' · exclusivo Chinacates' : ''}${d.nuevo ? ' · nuevo' : ''}${d.avisados ? ` · ${plural(d.avisados, 'apartado liberado', 'apartados liberados')}` : ''}`],
  vehiculo_eliminado: ['Vehículo dado de baja', 'i-trash', 'is-alert', d => d.nombre || camionCorto(d.camion)],
  vehiculo_elegido: ['Vehículo de la jornada', 'i-wheel', '', d => camionCorto(d.camion)]
}
const FALLA_TIPO = { motor: 'Motor', frenos: 'Frenos', llantas: 'Llantas', luces: 'Luces', puertas: 'Puertas', clima: 'Clima', electrico: 'Eléctrico', otro: 'Otro' }
const FALLA_GRAVEDAD = { baja: 'Puede seguir', media: 'Revisar pronto', alta: 'No puede circular' }

async function cargarBitacora({ lista = $('#admin-log-ul'), nombre = 'admin_bitacora', vacio = emptyState('i-shield', 'Sin actividad todavía', 'Aquí verás pagos, cortes, cambios y alertas.') } = {}) {
  if (!lista.children.length) lista.innerHTML = skeletonRows(5)
  const { data, error } = await rpc(nombre, { p_limite: 150 })
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
    empty: vacio
  })
}

$('#view-admin').addEventListener('tabchange', e => {
  if (e.detail === 'admin-tab-log') cargarBitacora()
  if (e.detail === 'admin-tab-inbox') buzon.adminAbrir()
  if (e.detail === 'admin-tab-balance') diesel.refrescar()
})

// Si una pantalla pide un vehículo que la app todavía no conoce, se recarga la lista
siFaltaVehiculo(() => cargarEstadoViaje())
// Solo se repinta si cambió el vehículo que se ve (el temporizador también actualiza la fila)
let firmaVisible = ''
alCambiarVehiculos(() => {
  const id = currentRole === 'Chofer' ? camionActual : currentRole === 'Estudiante' ? camionAlumno : null
  const v = id ? vehiculo(id) : null
  const firma = v ? `${id}|${v.nombre}|${v.color}|${v.cols}|${v.asientos.length}|${v.exclusivo}` : ''
  if (firma === firmaVisible) return
  firmaVisible = firma
  if (currentRole === 'Chofer' && camionActual) {
    pintarNombreCamion()
    renderDriverSchedule()
    renderPassengersUI()
    asientosChofer.repintar()
  }
  if (currentRole === 'Estudiante') {
    $('#trip-bus-label').textContent = camionAlumno ? nombreCamion(camionAlumno) : 'Sin salidas'
    asientos.repintar()
  }
})

// --- 12. TIEMPO REAL ---
supabase
  .channel('estado_viaje_channel')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'estado_viaje' }, ({ new: row }) => {
    if (!row?.id) return
    actualizarCamion(row)
    pintarVehiculos()
    // Dieron de baja el vehículo del chofer: que elija otro
    if (currentRole === 'Chofer' && row.id === camionActual && row.activo === false) verificarJornada()
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
    // Si cambió el día, verificarJornada vuelve a preguntar el vehículo
    verificarJornada()
    if (camionActual) {
      fetchPassengers()
      asientosChofer.cargar()
    }
  }
  if (currentRole === 'Financiero') cargarSaldosFinanzas()
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
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(err => console.error('Error al registrar el service worker:', err))
  })
}
