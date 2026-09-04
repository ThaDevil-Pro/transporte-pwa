import QRCode from 'qrcode'
import { Html5Qrcode } from 'html5-qrcode'
import { supabase } from './supabase.js'

// Hacer disponible supabase globalmente para depuración y consola
window.supabase = supabase

// Referencias Vistas DOM
const viewRoles = document.getElementById('view-roles')
const viewLogin = document.getElementById('view-login')
const viewStudent = document.getElementById('view-student')
const viewDashDriver = document.getElementById('view-dash-driver')
const viewDashAdmin = document.getElementById('view-dash-admin')

// Formulario Login
const loginTitle = document.getElementById('login-title')
const loginForm = document.getElementById('login-form')
const groupControl = document.getElementById('group-control')
const labelControl = document.getElementById('label-control')
const inputControl = document.getElementById('input-control')
const inputPassword = document.getElementById('input-password')
const errorMessage = document.getElementById('error-message')

// Referencias Chofer
const driverName = document.getElementById('driver-name')
const driverLicense = document.getElementById('driver-license')
const passengersCount = document.getElementById('passengers-count')
const studentsUl = document.getElementById('students-ul')
const btnIniciarViaje = document.getElementById('btn-iniciar-viaje')

// Referencias Módulo Horarios (Matriz Semanal)
const tbodyAlumnos = document.getElementById('tbody-horarios-alumnos')
const tbodyChofer = document.getElementById('tbody-horarios-chofer')
const btnAddScheduleRow = document.getElementById('btn-add-schedule-row')

// Variables Globales
let currentRole = ''
let passengers = []
let copyPassengers = [] // Copia temporal para el comprobante (Paso 5)
let html5QrcodeScanner = null
let allUsersCache = []
let currentFilter = 'Todos'
let currentStudentMatricula = null

// --- FUNCIÓN DEL EFECTO DECODIFICADOR (OPTIMIZADA CON ANIMATION FRAME) ---
function triggerDecodeEffect(elementId) {
  const element = document.getElementById(elementId)
  if (!element) return

  if (element.dataset.animationFrame) {
    cancelAnimationFrame(Number(element.dataset.animationFrame))
  }

  const originalText = 'SELECCIONA TU ROL'
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+'
  let iteration = 0
  let lastTime = 0
  const speedMs = 25

  function animate(currentTime) {
    if (!lastTime) lastTime = currentTime
    const delta = currentTime - lastTime

    if (delta > speedMs) {
      element.innerText = originalText
        .split('')
        .map((letter, index) => {
          if (letter === ' ') return ' '
          if (index < iteration) return originalText[index]
          return chars[Math.floor(Math.random() * chars.length)]
        })
        .join('')

      iteration += 1 / 3
      lastTime = currentTime
    }

    if (iteration < originalText.length) {
      const frameId = requestAnimationFrame(animate)
      element.dataset.animationFrame = frameId.toString()
    } else {
      element.innerText = originalText
      delete element.dataset.animationFrame
    }
  }

  const initialFrame = requestAnimationFrame(animate)
  element.dataset.animationFrame = initialFrame.toString()
}

// ==========================================
// ⏱️ GESTIÓN DEL TEMPORIZADOR Y ESTADO (B&N)
// ==========================================

let localTimerInterval = null

async function consultarEstadoViaje() {
  const { data, error } = await supabase
    .from('estado_viaje')
    .select('*')
    .eq('id', 1)
    .maybeSingle()

  if (data) {
    actualizarVistaReloj(data)
    actualizarUIIndicador(data.estado || 'ESPERANDO')
  }

  // Suscripción Realtime robusta para el alumno
  supabase.removeChannel(supabase.channel('student-estado-viaje'))
  supabase
    .channel('student-estado-viaje')
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'estado_viaje',
        filter: 'id=eq.1'
      },
      (payload) => {
        console.log('Cambio en tiempo real recibido por el alumno:', payload.new)
        actualizarVistaReloj(payload.new)
        if (payload.new.estado) {
          actualizarUIIndicador(payload.new.estado)
        }
      }
    )
    .subscribe()
}

function actualizarVistaReloj(estado) {
  const timerBox = document.getElementById('timer-student-box')
  const timerDisplay = document.getElementById('timer-student-display')
  const indicadorStatus = document.getElementById('indicador-status')
  const driverTimerDisplay = document.getElementById('driver-timer-display')

  if (!timerBox || !timerDisplay || !indicadorStatus) return

  if (estado.temporizador_activo && estado.tiempo_salida) {
    // Oculta el texto de "Esperando..." y muestra el temporizador embebido en su lugar
    indicadorStatus.classList.add('hidden')
    timerBox.classList.remove('hidden')
    
    if (localTimerInterval) clearInterval(localTimerInterval)
    const targetTime = new Date(estado.tiempo_salida).getTime()
    
    localTimerInterval = setInterval(() => {
      const now = new Date().getTime()
      const distance = targetTime - now

      if (distance <= 0) {
        clearInterval(localTimerInterval)
        localTimerInterval = null
        timerDisplay.textContent = "00:00"
        if (driverTimerDisplay) driverTimerDisplay.textContent = "00:00 - ¡TIEMPO AGOTADO!"
      } else {
        const minutes = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60))
        const seconds = Math.floor((distance % (1000 * 60)) / 1000)
        const formatted = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
        timerDisplay.textContent = formatted
        if (driverTimerDisplay) driverTimerDisplay.textContent = formatted
      }
    }, 1000)
  } else {
    // Si no está activo, regresa el texto de "Esperando..." y oculta el reloj
    if (localTimerInterval) clearInterval(localTimerInterval)
    localTimerInterval = null
    indicadorStatus.classList.remove('hidden')
    indicadorStatus.textContent = "Esperando..."
    timerBox.classList.add('hidden')
    if (driverTimerDisplay) driverTimerDisplay.textContent = '05:00'
  }
}

function actualizarUIIndicador(estado) {
  const statusElem = document.getElementById('indicador-status')
  const boxElem = document.getElementById('indicador-viaje-box')

  if (!statusElem || !boxElem) return

  if (estado === 'EN_CAMINO') {
    statusElem.textContent = 'En camino...'
    boxElem.classList.add('en-camino')
  } else {
    statusElem.textContent = 'Esperando...'
    boxElem.classList.remove('en-camino')
  }
}

// Controles del Chofer para el Temporizador
const btnTimerStart = document.getElementById('btn-timer-start')
const btnTimerAdd = document.getElementById('btn-timer-add')
const btnTimerStop = document.getElementById('btn-timer-stop')

if (btnTimerStart) {
  btnTimerStart.addEventListener('click', async () => {
    const endTime = new Date(Date.now() + 5 * 60 * 1000).toISOString()

    const { error } = await supabase
      .from('estado_viaje')
      .update({
        tiempo_salida: endTime,
        temporizador_activo: true,
        estado: 'EN_CAMINO'
      })
      .eq('id', 1)

    if (error) alert('Error al iniciar temporizador: ' + error.message)
  })
}

if (btnTimerAdd) {
  btnTimerAdd.addEventListener('click', async () => {
    const { data } = await supabase.from('estado_viaje').select('tiempo_salida').eq('id', 1).maybeSingle()
    if (!data || !data.tiempo_salida) return

    const currentTarget = new Date(data.tiempo_salida).getTime()
    const newEndTime = new Date(currentTarget + 1 * 60 * 1000).toISOString()

    const { error } = await supabase
      .from('estado_viaje')
      .update({ tiempo_salida: newEndTime })
      .eq('id', 1)

    if (error) alert('Error al agregar tiempo: ' + error.message)
  })
}

if (btnTimerStop) {
  btnTimerStop.addEventListener('click', async () => {
    const { error } = await supabase
      .from('estado_viaje')
      .update({
        tiempo_salida: null,
        temporizador_activo: false,
        estado: 'ESPERANDO'
      })
      .eq('id', 1)

    if (error) alert('Error al detener temporizador: ' + error.message)
  })
}

// --- 1. SELECCIÓN DE ROL ---
document.querySelectorAll('.btn[data-role]').forEach(btn => {
  btn.addEventListener('click', (e) => {
    currentRole = e.target.dataset.role
    loginTitle.textContent = `LOGIN ${currentRole.toUpperCase()}`
    errorMessage.classList.add('hidden')
    loginForm.reset()

    if (currentRole === 'Admin') {
      labelControl.textContent = 'Usuario Administrador'
      inputControl.setAttribute('placeholder', 'Ej. Harold Nevarez')
    } else if (currentRole === 'Chofer') {
      labelControl.textContent = 'Número de Licencia'
      inputControl.setAttribute('placeholder', 'Ej. LIC-12345')
    } else {
      labelControl.textContent = 'Número de Control / Matrícula'
      inputControl.setAttribute('placeholder', 'Ej. 23010099')
    }

    groupControl.classList.remove('hidden')
    inputControl.setAttribute('required', 'true')
    viewRoles.classList.add('hidden')
    viewLogin.classList.remove('hidden')
  })
})

const btnBack = document.getElementById('btn-back')
if (btnBack) {
  btnBack.addEventListener('click', () => {
    viewLogin.classList.add('hidden')
    viewRoles.classList.remove('hidden')
    triggerDecodeEffect('text-decode')
  })
}

// --- 2. LÓGICA DE LOGIN ---
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  errorMessage.classList.add('hidden')

  const control = inputControl.value.trim()
  const password = inputPassword.value.trim()

  if (currentRole === 'Estudiante') {
    const { data: alumno, error } = await supabase
      .from('alumnos')
      .select('*')
      .eq('matricula', control)
      .eq('password', password)
      .maybeSingle()

    if (error || !alumno) {
      showError('Número de control o contraseña incorrectos')
      return
    }

    currentStudentMatricula = alumno.matricula
    viewLogin.classList.add('hidden')
    viewStudent.classList.remove('hidden')
    document.getElementById('student-name').textContent = alumno.nombre
    document.getElementById('student-control').textContent = alumno.matricula
    const saldo = alumno.saldo !== undefined && alumno.saldo !== null ? Number(alumno.saldo).toFixed(2) : '0.00'
    document.getElementById('student-balance').textContent = saldo
    document.getElementById('modal-student-id').textContent = `ID: ${alumno.matricula}`

    // Cargar Indicador de Viaje y Historial
    consultarEstadoViaje()
    cargarHistorialAlumno(alumno.matricula)
  }
  else if (currentRole === 'Chofer') {
    const { data: chofer, error } = await supabase
      .from('choferes')
      .select('*')
      .eq('licencia', control)
      .eq('password', password)
      .maybeSingle()

    if (error || !chofer) {
      showError('Número de licencia o contraseña incorrectos')
      return
    }

    viewLogin.classList.add('hidden')
    viewDashDriver.classList.remove('hidden')
    driverName.textContent = `¡Hola, ${chofer.nombre}!`
    driverLicense.textContent = `Licencia: ${chofer.licencia}`
    fetchPassengers()
  }
  else if (currentRole === 'Admin') {
    const { data: admin, error } = await supabase
      .from('admins')
      .select('*')
      .eq('usuario', control)
      .eq('password', password)
      .maybeSingle()

    if (error || !admin) {
      showError('Usuario o contraseña de Admin incorrectos')
      return
    }

    viewLogin.classList.add('hidden')
    viewDashAdmin.classList.remove('hidden')
    loadAdminData()
  }
})

function showError(msg) {
  errorMessage.textContent = msg
  errorMessage.classList.remove('hidden')
}

// --- 3. MODAL QR ESTUDIANTE Y FUNCIONES ALUMNO ---
const qrModal = document.getElementById('qr-modal')
const btnShowQr = document.getElementById('btn-show-qr')
const btnCloseQr = document.getElementById('btn-close-qr')

if (btnShowQr) {
  btnShowQr.addEventListener('click', () => {
    qrModal.classList.remove('hidden')
    const matricula = document.getElementById('student-control').textContent
    const canvas = document.getElementById('qr-canvas')
    QRCode.toCanvas(canvas, matricula, { width: 200, margin: 2, color: { dark: '#000000', light: '#ffffff' } })
  })
}
if (btnCloseQr) btnCloseQr.addEventListener('click', () => qrModal.classList.add('hidden'))
if (qrModal) qrModal.addEventListener('click', (e) => { if (e.target === qrModal) qrModal.classList.add('hidden') })

// Cargar historial de viajes del alumno
async function cargarHistorialAlumno(matricula) {
  const tbody = document.getElementById('tbody-historial-alumno')
  if (!tbody) return

  const { data: viajes, error } = await supabase
    .from('historial_viajes')
    .select('*')
    .eq('matricula', matricula)
    .order('fecha_hora', { ascending: false })

  if (error || !viajes || viajes.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" style="text-align: center; color: #888;">No hay viajes registrados.</td></tr>'
    return
  }

  tbody.innerHTML = viajes.map(viaje => {
    const f = new Date(viaje.fecha_hora)
    const fecha = f.toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit', year: 'numeric' })
    const hora = f.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: true })

    return `
      <tr>
        <td>${fecha}</td>
        <td>${hora}</td>
        <td>$${viaje.monto}.00</td>
      </tr>
    `
  }).join('')
}

// --- 4. CHOFER & ESCÁNER QR ---
const scannerModal = document.getElementById('scanner-modal')
const btnOpenScanner = document.getElementById('btn-open-scanner')
const btnCloseScanner = document.getElementById('btn-close-scanner')
const btnClearList = document.getElementById('btn-clear-list')
const scanFeedback = document.getElementById('scan-feedback')

let isProcessingScan = false

// Cargar pasajeros desde Supabase
async function fetchPassengers() {
  const { data, error } = await supabase
    .from('abordajes')
    .select('*')

  if (error) {
    console.error('Error al cargar pasajeros:', error)
  } else if (data) {
    passengers = data
    renderPassengersUI()
  }
}

// Renderizar lista de pasajeros
function renderPassengersUI() {
  if (!passengersCount || !studentsUl) return

  passengersCount.textContent = `${passengers.length} / 40`
  studentsUl.innerHTML = ''

  if (passengers.length === 0) {
    studentsUl.innerHTML = '<li style="color:#444; font-size:0.8rem; text-align:center; padding:12px 0;">No hay alumnos a bordo</li>'
    return
  }

  passengers.forEach((p) => {
    const li = document.createElement('li')
    li.className = 'student-item'
    li.innerHTML = `
      <div class="student-info">
        <span class="student-item-name">${p.nombre}</span>
        <span class="student-item-id">Matrícula: ${p.matricula}</span>
      </div>
      <button class="btn-remove-student" data-id="${p.id}">✕</button>
    `
    studentsUl.appendChild(li)
  })
}

// Eliminar un alumno individual de abordajes
if (studentsUl) {
  studentsUl.addEventListener('click', async (e) => {
    if (e.target.classList.contains('btn-remove-student')) {
      const id = e.target.dataset.id
      const { error } = await supabase.from('abordajes').delete().eq('id', id)
      if (!error) await fetchPassengers()
    }
  })
}

// Vaciar la lista sin cobro
if (btnClearList) {
  btnClearList.addEventListener('click', async () => {
    if (passengers.length === 0) return

    if (confirm('¿Deseas vaciar la lista de abordaje sin realizar cobros?')) {
      const { error } = await supabase
        .from('abordajes')
        .delete()
        .gt('id', -1)

      if (error) {
        console.error('Error al vaciar en Supabase:', error)
        alert(`Error al vaciar: ${error.message}`)
      } else {
        passengers = []
        renderPassengersUI()
      }
    }
  })
}

// --- LÓGICA DE CORTE, CORRIDA Y COMPROBANTE ---
let isTripActive = false

if (btnIniciarViaje) {
  btnIniciarViaje.addEventListener('click', async () => {
    if (passengers.length === 0) {
      alert('No hay estudiantes en la lista de abordaje.')
      return
    }

    if (!isTripActive) {
      const confirmacion = confirm(`¿Deseas realizar el corte y cobrar $30 a los ${passengers.length} estudiantes registrados?`)
      if (!confirmacion) return

      btnIniciarViaje.disabled = true
      btnIniciarViaje.textContent = 'Procesando cobros...'

      try {
        const fechaHoraActual = new Date().toISOString()

        for (const student of passengers) {
          const { data: alumnoData } = await supabase
            .from('alumnos')
            .select('saldo')
            .eq('matricula', student.matricula)
            .maybeSingle()

          const saldoActual = alumnoData?.saldo || 0
          const nuevoSaldo = Number(saldoActual) + 30

          await supabase
            .from('alumnos')
            .update({ saldo: nuevoSaldo })
            .eq('matricula', student.matricula)

          await supabase
            .from('historial_viajes')
            .insert([
              {
                matricula: student.matricula,
                monto: 30,
                fecha_hora: fechaHoraActual
              }
            ])
        }

        await supabase
          .from('estado_viaje')
          .update({ estado: 'EN_CAMINO' })
          .eq('id', 1)

        alert(`Cobro realizado exitosamente a los ${passengers.length} alumnos.`)

        isTripActive = true
        btnIniciarViaje.textContent = 'FINALIZAR VIAJE'

      } catch (err) {
        console.error('Error al procesar el viaje:', err)
        alert('Ocurrió un error al procesar el cobro de los alumnos.')
      } finally {
        btnIniciarViaje.disabled = false
      }
    } 
    else {
      const confirmacion = confirm('¿Deseas finalizar el viaje y generar el comprobante?')
      if (!confirmacion) return

      copyPassengers = [...passengers]

      const ahora = new Date()
      const fechaHoraTexto = ahora.toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ' ' + ahora.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: true })
      
      const compFechaElem = document.getElementById('comprobante-fecha-hora')
      const compTotalElem = document.getElementById('comprobante-total')
      
      if (compFechaElem) compFechaElem.textContent = `FECHA Y HORA: ${fechaHoraTexto}`
      if (compTotalElem) compTotalElem.textContent = `TOTAL ALUMNOS: ${copyPassengers.length} | TOTAL COBRADO: $${copyPassengers.length * 30}.00`

      const tbodyComp = document.getElementById('tbody-comprobante')
      if (tbodyComp) {
        tbodyComp.innerHTML = copyPassengers.map((student, index) => `
          <tr>
            <td>${index + 1}</td>
            <td>${student.matricula}</td>
            <td>${student.nombre || student.nombre_completo || 'ALUMNO'}</td>
            <td>$30.00</td>
          </tr>
        `).join('')
      }

      const modalComp = document.getElementById('modal-comprobante')
      if (modalComp) modalComp.classList.remove('hidden')
    }
  })
}

const btnCerrarComprobante = document.getElementById('btn-cerrar-comprobante')
if (btnCerrarComprobante) {
  btnCerrarComprobante.addEventListener('click', async () => {
    try {
      await supabase.from('abordajes').delete().gt('id', -1)
      passengers = []
      renderPassengersUI()

      await supabase
        .from('estado_viaje')
        .update({ estado: 'ESPERANDO' })
        .eq('id', 1)

      isTripActive = false
      btnIniciarViaje.textContent = 'HACER CORTE ($30 C/U)'

      const modalComp = document.getElementById('modal-comprobante')
      if (modalComp) modalComp.classList.add('hidden')
      alert('Viaje finalizado y lista vaciada correctamente.')

    } catch (err) {
      console.error('Error al limpiar lista:', err)
      alert('Error al vaciar la lista de abordaje.')
    }
  })
}

// Control del Escáner QR
if (btnOpenScanner) {
  btnOpenScanner.addEventListener('click', async () => {
    isProcessingScan = false
    scannerModal.classList.remove('hidden')
    scanFeedback.textContent = 'Iniciando cámara...'
    if (!html5QrcodeScanner) html5QrcodeScanner = new Html5Qrcode("reader")
    try {
      await html5QrcodeScanner.start({ facingMode: "environment" }, { fps: 10, qrbox: 200 }, onScanSuccess, null)
      scanFeedback.textContent = 'Apunta al código QR'
    } catch (err) { scanFeedback.textContent = 'Error al acceder a la cámara' }
  })
}

async function stopScanner() {
  isProcessingScan = false
  if (html5QrcodeScanner && html5QrcodeScanner.isScanning) await html5QrcodeScanner.stop()
  if (scannerModal) scannerModal.classList.add('hidden')
}
if (btnCloseScanner) btnCloseScanner.addEventListener('click', stopScanner)

async function onScanSuccess(decodedText) {
  if (isProcessingScan) return
  isProcessingScan = true

  const scannedId = String(decodedText).trim()

  if (passengers.length >= 40) {
    scanFeedback.textContent = '❌ Límite alcanzado (Máximo 40 pasajeros)'
    setTimeout(() => { isProcessingScan = false }, 2000)
    return
  }

  const alreadyExists = passengers.some(p => String(p.matricula).trim() === scannedId)
  if (alreadyExists) {
    scanFeedback.textContent = `⚠️ El alumno (${scannedId}) ya está a bordo`
    setTimeout(() => { isProcessingScan = false }, 2000)
    return
  }

  scanFeedback.textContent = 'Validando...'

  const { data: alumno, error: fetchError } = await supabase
    .from('alumnos')
    .select('nombre, matricula')
    .eq('matricula', scannedId)
    .maybeSingle()

  if (fetchError || !alumno) {
    scanFeedback.textContent = `❌ Matrícula ${scannedId} inválida`
    setTimeout(() => { isProcessingScan = false }, 2000)
    return
  }

  const matriculaVal = String(alumno.matricula).trim()
  const nombreVal = String(alumno.nombre).trim()

  const { error } = await supabase
    .from('abordajes')
    .insert([{ nombre: nombreVal, matricula: matriculaVal }])

  if (error) {
    console.error('Error al insertar:', error)
    scanFeedback.textContent = `❌ Error: ${error.message}`
    setTimeout(() => { isProcessingScan = false }, 3000)
    return
  }

  await fetchPassengers()
  scanFeedback.textContent = `✅ ¡${nombreVal} listo!`
  setTimeout(stopScanner, 800)
}

fetchPassengers()

// --- 5. LÓGICA DASHBOARD ADMINISTRADOR ---
const adminTabs = document.querySelectorAll('.admin-tab')
const tabContents = document.querySelectorAll('.tab-content')
const adminNewRole = document.getElementById('admin-new-role')
const labelAdminIdentifier = document.getElementById('label-admin-identifier')
const groupAdminBalance = document.getElementById('group-admin-initial-balance')
const formCreateUser = document.getElementById('form-create-user')
const searchUserInput = document.getElementById('search-user-input')
const filterChips = document.querySelectorAll('.chip')

adminTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    adminTabs.forEach(t => t.classList.remove('active'))
    tabContents.forEach(c => c.classList.add('hidden'))
    tab.classList.add('active')
    const targetContent = document.getElementById(tab.dataset.tab)
    if (targetContent) targetContent.classList.remove('hidden')
  })
})

if (adminNewRole) {
  adminNewRole.addEventListener('change', (e) => {
    const role = e.target.value
    if (role === 'Estudiante') {
      labelAdminIdentifier.textContent = 'MATRÍCULA / NÚM. CONTROL'
      groupAdminBalance.classList.remove('hidden')
    } else if (role === 'Chofer') {
      labelAdminIdentifier.textContent = 'NÚMERO DE LICENCIA'
      groupAdminBalance.classList.add('hidden')
    } else {
      labelAdminIdentifier.textContent = 'NOMBRE DE USUARIO'
      groupAdminBalance.classList.add('hidden')
    }
  })
}

const dropdown = document.getElementById('roleDropdown')
const selectedRole = document.getElementById('selectedRole')
const optionsList = document.getElementById('optionsList')
const roleInput = document.getElementById('admin-new-role')

if (dropdown && selectedRole && optionsList) {
  const options = optionsList.querySelectorAll('.option')

  selectedRole.addEventListener('click', (e) => {
    e.stopPropagation()
    dropdown.classList.toggle('open')
    optionsList.classList.toggle('hidden')
  })

  options.forEach(option => {
    option.addEventListener('click', () => {
      selectedRole.querySelector('span').textContent = option.textContent
      roleInput.value = option.dataset.value
      
      options.forEach(opt => opt.classList.remove('active'))
      option.classList.add('active')

      optionsList.classList.add('hidden')
      dropdown.classList.remove('open')

      roleInput.dispatchEvent(new Event('change'))
    })
  })

  document.addEventListener('click', () => {
    optionsList.classList.add('hidden')
    dropdown.classList.remove('open')
  })
}

if (formCreateUser) {
  formCreateUser.addEventListener('submit', async (e) => {
    e.preventDefault()
    const role = adminNewRole.value
    const name = document.getElementById('admin-new-name').value.trim()
    const identifier = document.getElementById('admin-new-identifier').value.trim()
    const password = document.getElementById('admin-new-password').value.trim()
    const balance = parseFloat(document.getElementById('admin-new-balance').value) || 0
    const msg = document.getElementById('admin-register-msg')

    let error = null
    if (role === 'Estudiante') {
      const res = await supabase.from('alumnos').insert([{ nombre: name, matricula: identifier, password, saldo: balance }])
      error = res.error
    } else if (role === 'Chofer') {
      const res = await supabase.from('choferes').insert([{ nombre: name, licencia: identifier, password }])
      error = res.error
    } else {
      const res = await supabase.from('admins').insert([{ usuario: identifier, password }])
      error = res.error
    }

    if (error) {
      msg.style.color = '#ff4444'
      msg.textContent = `Error: ${error.message}`
    } else {
      msg.style.color = '#00ff66'
      msg.textContent = '✅ Usuario creado exitosamente'
      formCreateUser.reset()
      loadAdminData()
    }
  })
}

async function loadAdminData() {
  const [{ data: alumnos }, { data: choferes }, { data: admins }] = await Promise.all([
    supabase.from('alumnos').select('*'),
    supabase.from('choferes').select('*'),
    supabase.from('admins').select('*')
  ])

  allUsersCache = [
    ...(alumnos || []).map(u => ({ ...u, rol: 'Estudiante', idStr: u.matricula })),
    ...(choferes || []).map(u => ({ ...u, rol: 'Chofer', idStr: u.licencia })),
    ...(admins || []).map(u => ({ ...u, nombre: u.usuario, rol: 'Admin', idStr: u.usuario }))
  ]

  updateAutocompleteList()
  renderUsersList()
  renderBalancesList(alumnos || [])
}

function updateAutocompleteList() {
  const datalist = document.getElementById('users-autocomplete-list')
  if (!datalist) return
  datalist.innerHTML = ''
  allUsersCache.forEach(u => {
    const opt = document.createElement('option')
    opt.value = u.idStr
    opt.label = u.nombre
    datalist.appendChild(opt)
  })
}

function renderUsersList() {
  const ul = document.getElementById('admin-users-ul')
  if (!ul) return
  const query = searchUserInput ? searchUserInput.value.toLowerCase().trim() : ''
  ul.innerHTML = ''

  const filtered = allUsersCache.filter(u => {
    const matchesFilter = currentFilter === 'Todos' || u.rol === currentFilter
    const matchesSearch = (u.nombre && u.nombre.toLowerCase().includes(query)) || (u.idStr && u.idStr.toLowerCase().includes(query))
    return matchesFilter && matchesSearch
  })

  if (filtered.length === 0) {
    ul.innerHTML = '<li style="color:#444; font-size:0.8rem; text-align:center; padding:12px 0;">Sin resultados</li>'
    return
  }

  filtered.forEach(u => {
    const li = document.createElement('li')
    li.className = 'student-item'
    li.innerHTML = `
      <div class="student-info">
        <span class="student-item-name">${u.nombre} <small style="color:#666">(${u.rol})</small></span>
        <span class="student-item-id">ID: ${u.idStr}</span>
      </div>
      <div class="user-actions">
        <button class="btn-action edit" data-role="${u.rol}" data-id="${u.id}">✏️</button>
        <button class="btn-action delete" data-role="${u.rol}" data-id="${u.id}">🗑️</button>
      </div>
    `
    ul.appendChild(li)
  })

  document.querySelectorAll('.btn-action.delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      if (!confirm('¿Deseas eliminar este usuario?')) return
      const role = e.target.dataset.role
      const id = e.target.dataset.id
      const table = role === 'Estudiante' ? 'alumnos' : role === 'Chofer' ? 'choferes' : 'admins'
      await supabase.from(table).delete().eq('id', id)
      loadAdminData()
    })
  })

  document.querySelectorAll('.btn-action.edit').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const role = e.target.dataset.role
      const id = e.target.dataset.id
      const user = allUsersCache.find(u => u.rol === role && u.id == id)
      
      const newName = prompt('Nuevo Nombre/Usuario:', user.nombre)
      const newPass = prompt('Nueva Contraseña (vacío para conservar):')
      
      if (newName) {
        const table = role === 'Estudiante' ? 'alumnos' : role === 'Chofer' ? 'choferes' : 'admins'
        const updates = role === 'Admin' ? { usuario: newName } : { nombre: newName }
        if (newPass) updates.password = newPass
        await supabase.from(table).update(updates).eq('id', id)
        loadAdminData()
      }
    })
  })
}

function renderBalancesList(alumnos) {
  const ul = document.getElementById('admin-balances-ul')
  if (!ul) return
  ul.innerHTML = ''

  if (alumnos.length === 0) {
    ul.innerHTML = '<li style="color:#444; font-size:0.8rem; text-align:center; padding:12px 0;">No hay alumnos registrados</li>'
    return
  }

  alumnos.forEach(a => {
    const li = document.createElement('li')
    li.className = 'student-item'
    const saldo = a.saldo !== undefined && a.saldo !== null ? Number(a.saldo).toFixed(2) : '0.00'
    li.innerHTML = `
      <div class="student-info">
        <span class="student-item-name">${a.nombre}</span>
        <span class="student-item-id">Matrícula: ${a.matricula}</span>
      </div>
      <div style="display:flex; align-items:center; gap:10px;">
        <span class="balance-tag">$${saldo}</span>
        <button class="btn-action edit-balance" data-id="${a.id}" data-saldo="${saldo}">✏️</button>
      </div>
    `
    ul.appendChild(li)
  })

  document.querySelectorAll('.edit-balance').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = e.target.dataset.id
      const currentSaldo = e.target.dataset.saldo
      const newSaldo = prompt('Ingresa el nuevo saldo ($):', currentSaldo)
      if (newSaldo !== null && !isNaN(newSaldo)) {
        await supabase.from('alumnos').update({ saldo: parseFloat(newSaldo) }).eq('id', id)
        loadAdminData()
      }
    })
  })
}

if (searchUserInput) searchUserInput.addEventListener('input', renderUsersList)

filterChips.forEach(chip => {
  chip.addEventListener('click', () => {
    filterChips.forEach(c => c.classList.remove('active'))
    chip.classList.add('active')
    currentFilter = chip.dataset.filter
    renderUsersList()
  })
})

// Cierre de sesión seguro
const btnLogoutStudent = document.getElementById('btn-logout-student')
const btnLogoutDriver = document.getElementById('btn-logout-driver') || document.getElementById('btn-logout-other')
const btnLogoutAdmin = document.getElementById('btn-logout-admin')

if (btnLogoutStudent) btnLogoutStudent.addEventListener('click', resetApp)
if (btnLogoutDriver) btnLogoutDriver.addEventListener('click', resetApp)
if (btnLogoutAdmin) btnLogoutAdmin.addEventListener('click', resetApp)

function resetApp() {
  stopScanner()
  if (qrModal) qrModal.classList.add('hidden')
  if (viewStudent) viewStudent.classList.add('hidden')
  if (viewDashDriver) viewDashDriver.classList.add('hidden')
  if (viewDashAdmin) viewDashAdmin.classList.add('hidden')
  if (viewLogin) viewLogin.classList.add('hidden')
  if (viewRoles) viewRoles.classList.remove('hidden')
  passengers = []
  currentStudentMatricula = null
  loginForm.reset()
  
  triggerDecodeEffect('text-decode')
}

// --- 6. VIDEO INTRO Y ANIMACIÓN AUTOMÁTICA ---
const splash = document.getElementById('splash-screen')
const video = document.getElementById('splash-video')

const DURACION_VIDEO_MS = 2500 

if (splash) {
  if (video) {
    video.play().catch(() => {
      const forcePlay = () => {
        video.play()
        window.removeEventListener('touchstart', forcePlay)
        window.removeEventListener('click', forcePlay)
      }
      window.addEventListener('touchstart', forcePlay, { passive: true })
      window.addEventListener('click', forcePlay, { passive: true })
    })
  }

  setTimeout(() => {
    splash.style.pointerEvents = 'none'
    splash.style.opacity = '0'
    
    setTimeout(() => {
      splash.style.display = 'none'
      if (video) video.pause()
      
      requestAnimationFrame(() => {
        triggerDecodeEffect('text-decode')
      })

    }, 500)
  }, DURACION_VIDEO_MS)

} else {
  document.addEventListener('DOMContentLoaded', () => {
    requestAnimationFrame(() => {
      triggerDecodeEffect('text-decode')
    })
  })
}

// --- 7. MÓDULO MATRIZ DE HORARIOS SEMANALES ---

let isEditingSchedule = false

async function fetchScheduleMatrix() {
  const { data, error } = await supabase
    .from('horarios_matriz')
    .select('*')
    .order('created_at', { ascending: true })

  if (!error && data) {
    renderScheduleUI(data)
  }
}

function renderScheduleUI(rows) {
  if (isEditingSchedule) return

  if (tbodyAlumnos) tbodyAlumnos.innerHTML = ''
  if (tbodyChofer) tbodyChofer.innerHTML = ''

  const dias = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes']

  rows.forEach((row) => {
    if (tbodyAlumnos) {
      const trAlumno = document.createElement('tr')
      dias.forEach(dia => {
        const cellData = row[dia] || { hora: '', tipo: 'IDA' }
        const td = document.createElement('td')
        if (cellData.hora) {
          td.innerHTML = `
            <div class="badge-schedule ${cellData.tipo ? cellData.tipo.toLowerCase() : 'ida'}">
              ${cellData.hora} <br> <small>${cellData.tipo || 'IDA'}</small>
            </div>
          `
        } else {
          td.innerHTML = '<span style="color:#444;">-</span>'
        }
        trAlumno.appendChild(td)
      })
      tbodyAlumnos.appendChild(trAlumno)
    }

    if (tbodyChofer) {
      const trChofer = document.createElement('tr')
      trChofer.dataset.id = row.id

      dias.forEach(dia => {
        const cellData = row[dia] || { hora: '', tipo: 'IDA' }
        const td = document.createElement('td')
        td.innerHTML = `
          <div class="schedule-cell">
            <input type="time" class="schedule-time-input" data-dia="${dia}" value="${cellData.hora || ''}">
            <button class="btn-type-toggle ${cellData.tipo ? cellData.tipo.toLowerCase() : 'ida'}" data-dia="${dia}" data-tipo="${cellData.tipo || 'IDA'}">
              ${cellData.tipo || 'IDA'}
            </button>
          </div>
        `
        trChofer.appendChild(td)
      })

      const tdAction = document.createElement('td')
      tdAction.innerHTML = `<button class="btn-remove-student btn-delete-row" data-id="${row.id}">✕</button>`
      trChofer.appendChild(tdAction)

      tbodyChofer.appendChild(trChofer)
    }
  })
}

if (btnAddScheduleRow) {
  btnAddScheduleRow.addEventListener('click', async () => {
    const emptyDay = { hora: '', tipo: 'IDA' }
    const newRow = {
      lunes: emptyDay,
      martes: emptyDay,
      miercoles: emptyDay,
      jueves: emptyDay,
      viernes: emptyDay
    }

    await supabase.from('horarios_matriz').insert([newRow])
    fetchScheduleMatrix()
  })
}

if (tbodyChofer) {
  tbodyChofer.addEventListener('focusin', (e) => {
    if (e.target.classList.contains('schedule-time-input')) {
      isEditingSchedule = true

      if (!e.target.value) {
        const tr = e.target.closest('tr')
        const allInputs = Array.from(tr.querySelectorAll('.schedule-time-input'))
        const currentIndex = allInputs.indexOf(e.target)

        let neighbourTime = ''

        for (let i = currentIndex - 1; i >= 0; i--) {
          if (allInputs[i].value) {
            neighbourTime = allInputs[i].value
            break
          }
        }

        if (!neighbourTime) {
          for (let i = currentIndex + 1; i < allInputs.length; i++) {
            if (allInputs[i].value) {
              neighbourTime = allInputs[i].value
              break
            }
          }
        }

        if (neighbourTime) {
          e.target.value = neighbourTime
        }
      }
    }
  })

  tbodyChofer.addEventListener('focusout', async (e) => {
    if (e.target.classList.contains('schedule-time-input')) {
      const tr = e.target.closest('tr')
      const rowId = tr.dataset.id
      const dia = e.target.dataset.dia
      const nuevaHora = e.target.value

      const btnTipo = tr.querySelector(`button[data-dia="${dia}"]`)
      const tipoActual = btnTipo ? btnTipo.dataset.tipo : 'IDA'

      const updatedDayData = { hora: nuevaHora, tipo: tipoActual }

      await supabase
        .from('horarios_matriz')
        .update({ [dia]: updatedDayData })
        .eq('id', rowId)

      isEditingSchedule = false
    }
  })

  tbodyChofer.addEventListener('click', async (e) => {
    if (e.target.classList.contains('btn-type-toggle')) {
      const tr = e.target.closest('tr')
      const rowId = tr.dataset.id
      const dia = e.target.dataset.dia
      const tipoActual = e.target.dataset.tipo
      const nuevoTipo = tipoActual === 'IDA' ? 'REGRESO' : 'IDA'

      const inputHora = tr.querySelector(`input[data-dia="${dia}"]`)
      const horaActual = inputHora ? inputHora.value : ''

      const updatedDayData = { hora: horaActual, tipo: nuevoTipo }

      e.target.dataset.tipo = nuevoTipo
      e.target.textContent = nuevoTipo
      e.target.className = `btn-type-toggle ${nuevoTipo.toLowerCase()}`

      await supabase
        .from('horarios_matriz')
        .update({ [dia]: updatedDayData })
        .eq('id', rowId)
    }

    if (e.target.classList.contains('btn-delete-row')) {
      const rowId = e.target.dataset.id
      await supabase.from('horarios_matriz').delete().eq('id', rowId)
      fetchScheduleMatrix()
    }
  })
}

// Suscripciones en tiempo real
supabase
  .channel('estado_viaje_channel')
  .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'estado_viaje' }, (payload) => {
    if (payload.new && payload.new.estado) {
      actualizarUIIndicador(payload.new.estado)
    }
  })
  .subscribe()

supabase
  .channel('historial_viajes_channel')
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'historial_viajes' }, (payload) => {
    if (currentStudentMatricula && payload.new && payload.new.matricula === currentStudentMatricula) {
      cargarHistorialAlumno(currentStudentMatricula)
    }
  })
  .subscribe()

fetchScheduleMatrix()