import QRCode from 'qrcode'
import { Html5Qrcode } from 'html5-qrcode'
import { supabase } from './supabase.js'

// Referencias del DOM
const viewRoles = document.getElementById('view-roles')
const viewLogin = document.getElementById('view-login')
const viewStudent = document.getElementById('view-student')
const viewDashOther = document.getElementById('view-dash-other')

const loginTitle = document.getElementById('login-title')
const loginForm = document.getElementById('login-form')
const groupControl = document.getElementById('group-control')
const labelControl = document.getElementById('label-control')
const inputControl = document.getElementById('input-control')
const inputPassword = document.getElementById('input-password')
const errorMessage = document.getElementById('error-message')

// Referencias DOM Chofer
const driverName = document.getElementById('driver-name')
const driverLicense = document.getElementById('driver-license')
const passengersCount = document.getElementById('passengers-count')
const studentsUl = document.getElementById('students-ul')

let currentRole = ''
let passengers = []
let html5QrcodeScanner = null

// --- 1. SELECCIÓN DE ROL ---
document.querySelectorAll('.btn[data-role]').forEach(btn => {
  btn.addEventListener('click', (e) => {
    currentRole = e.target.dataset.role
    loginTitle.textContent = `LOGIN ${currentRole.toUpperCase()}`
    errorMessage.classList.add('hidden')
    loginForm.reset()

    if (currentRole === 'Admin') {
      groupControl.classList.add('hidden')
      inputControl.removeAttribute('required')
    } else {
      groupControl.classList.remove('hidden')
      inputControl.setAttribute('required', 'true')
      labelControl.textContent = currentRole === 'Estudiante' ? 'Número de Control / Matrícula' : 'Número de Licencia / Control'
    }

    viewRoles.classList.add('hidden')
    viewLogin.classList.remove('hidden')
  })
})

// Botón Volver
document.getElementById('btn-back').addEventListener('click', () => {
  viewLogin.classList.add('hidden')
  viewRoles.classList.remove('hidden')
})

// --- 2. LOGICA DE LOGIN ---
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  errorMessage.classList.add('hidden')

  const control = inputControl.value.trim()
  const password = inputPassword.value.trim()

  // CASO A: ESTUDIANTE
  if (currentRole === 'Estudiante') {
    const { data: alumno, error } = await supabase
      .from('alumnos')
      .select('*')
      .eq('matricula', control)
      .eq('password', password)
      .single()

    if (error || !alumno) {
      showError('Número de control o contraseña incorrectos')
      return
    }

    viewLogin.classList.add('hidden')
    viewStudent.classList.remove('hidden')
    
    document.getElementById('student-name').textContent = alumno.nombre
    document.getElementById('student-control').textContent = alumno.matricula
    
    const saldo = alumno.saldo !== undefined && alumno.saldo !== null ? Number(alumno.saldo).toFixed(2) : '0.00'
    document.getElementById('student-balance').textContent = saldo
    document.getElementById('modal-student-id').textContent = `ID: ${alumno.matricula}`
  }

  // CASO B: CHOFER
  else if (currentRole === 'Chofer') {
    const { data: chofer, error } = await supabase
      .from('choferes')
      .select('*')
      .eq('licencia', control)
      .eq('password', password)
      .single()

    if (error || !chofer) {
      showError('Número de licencia o contraseña incorrectos')
      return
    }

    viewLogin.classList.add('hidden')
    viewDashOther.classList.remove('hidden')
    
    driverName.textContent = `¡Hola, ${chofer.nombre}!`
    driverLicense.textContent = `Licencia: ${chofer.licencia}`
    updatePassengersUI()
  }

  // CASO C: ADMIN
  else if (currentRole === 'Admin') {
    if (password === '2005') {
      viewLogin.classList.add('hidden')
      viewDashOther.classList.remove('hidden')
      document.getElementById('dash-title').textContent = 'PANEL ADMIN'
      document.getElementById('dash-desc').textContent = 'Acceso concedido como Administrador'
    } else {
      showError('Contraseña de Admin incorrecta')
    }
  }
})

function showError(msg) {
  errorMessage.textContent = msg
  errorMessage.classList.remove('hidden')
}

// --- 3. LOGICA DEL MODAL QR ESTUDIANTE ---
const qrModal = document.getElementById('qr-modal')
const btnShowQr = document.getElementById('btn-show-qr')
const btnCloseQr = document.getElementById('btn-close-qr')

if (btnShowQr) {
  btnShowQr.addEventListener('click', () => {
    qrModal.classList.remove('hidden')
    const matricula = document.getElementById('student-control').textContent
    const canvas = document.getElementById('qr-canvas')
    
    QRCode.toCanvas(canvas, matricula, { 
      width: 200, 
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' }
    }, (err) => {
      if (err) console.error('Error generando QR:', err)
    })
  })
}

if (btnCloseQr) {
  btnCloseQr.addEventListener('click', () => qrModal.classList.add('hidden'))
}

if (qrModal) {
  qrModal.addEventListener('click', (e) => {
    if (e.target === qrModal) qrModal.classList.add('hidden')
  })
}

// --- 4. GESTIÓN DE PASAJEROS Y ESCÁNER QR CHOFER ---
const scannerModal = document.getElementById('scanner-modal')
const btnOpenScanner = document.getElementById('btn-open-scanner')
const btnCloseScanner = document.getElementById('btn-close-scanner')
const btnClearList = document.getElementById('btn-clear-list')
const scanFeedback = document.getElementById('scan-feedback')

function updatePassengersUI() {
  passengersCount.textContent = passengers.length
  studentsUl.innerHTML = ''

  if (passengers.length === 0) {
    studentsUl.innerHTML = '<li style="color:#444; font-size:0.8rem; text-align:center; padding:12px 0;">No hay alumnos a bordo</li>'
    return
  }

  passengers.forEach((p, index) => {
    const li = document.createElement('li')
    li.className = 'student-item'
    li.innerHTML = `
      <div class="student-info">
        <span class="student-item-name">${p.nombre}</span>
        <span class="student-item-id">Matrícula: ${p.matricula}</span>
      </div>
      <button class="btn-remove-student" data-index="${index}">✕</button>
    `
    studentsUl.appendChild(li)
  })

  document.querySelectorAll('.btn-remove-student').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = e.target.dataset.index
      passengers.splice(idx, 1)
      updatePassengersUI()
    })
  })
}

if (btnClearList) {
  btnClearList.addEventListener('click', () => {
    if (passengers.length > 0 && confirm('¿Deseas vaciar la lista de pasajeros a bordo?')) {
      passengers = []
      updatePassengersUI()
    }
  })
}

if (btnOpenScanner) {
  btnOpenScanner.addEventListener('click', async () => {
    scannerModal.classList.remove('hidden')
    scanFeedback.textContent = 'Iniciando cámara...'
    
    if (!html5QrcodeScanner) {
      html5QrcodeScanner = new Html5Qrcode("reader")
    }

    try {
      await html5QrcodeScanner.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 200, height: 200 } },
        onScanSuccess,
        onScanFailure
      )
      scanFeedback.textContent = 'Apunta al código QR del alumno'
    } catch (err) {
      console.error("Error al abrir cámara:", err)
      scanFeedback.textContent = 'Error al acceder a la cámara'
    }
  })
}

async function stopScanner() {
  if (html5QrcodeScanner && html5QrcodeScanner.isScanning) {
    await html5QrcodeScanner.stop()
  }
  scannerModal.classList.add('hidden')
}

if (btnCloseScanner) {
  btnCloseScanner.addEventListener('click', stopScanner)
}

async function onScanSuccess(decodedText) {
  const yaRegistrado = passengers.some(p => p.matricula === decodedText)
  if (yaRegistrado) {
    scanFeedback.textContent = `⚠️ La matrícula ${decodedText} ya está abordada`
    return
  }

  scanFeedback.textContent = `Validando en base de datos...`

  const { data: alumno, error } = await supabase
    .from('alumnos')
    .select('nombre, matricula')
    .eq('matricula', decodedText)
    .single()

  if (error || !alumno) {
    scanFeedback.textContent = `❌ Matrícula ${decodedText} no encontrada`
    return
  }

  passengers.unshift({ nombre: alumno.nombre, matricula: alumno.matricula })
  updatePassengersUI()
  scanFeedback.textContent = `✅ ¡${alumno.nombre} registrado!`

  setTimeout(() => {
    stopScanner()
  }, 1000)
}

function onScanFailure(error) {
  // Búsqueda continua de frames
}

// Reset App (Cerrar Sesión)
document.getElementById('btn-logout-student').addEventListener('click', resetApp)
document.getElementById('btn-logout-other').addEventListener('click', resetApp)

function resetApp() {
  stopScanner()
  if (qrModal) qrModal.classList.add('hidden')
  viewStudent.classList.add('hidden')
  viewDashOther.classList.add('hidden')
  viewLogin.classList.add('hidden')
  viewRoles.classList.remove('hidden')
  passengers = []
  loginForm.reset()
}

// --- 5. VIDEO INTRO ---
const splash = document.getElementById('splash-screen')
const video = document.getElementById('splash-video')

if (video && splash) {
  let cerrado = false

  const cerrarSplash = () => {
    if (cerrado) return
    cerrado = true
    splash.style.opacity = '0'
    setTimeout(() => {
      splash.style.display = 'none'
      video.pause()
    }, 500)
  }

  video.addEventListener('timeupdate', () => {
    if (video.currentTime >= 2.0) cerrarSplash()
  })

  video.addEventListener('ended', cerrarSplash)

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