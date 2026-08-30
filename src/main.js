import QRCode from 'qrcode'
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

let currentRole = ''

// --- 1. SELECCIÓN DE ROL ---
document.querySelectorAll('.btn[data-role]').forEach(btn => {
  btn.addEventListener('click', (e) => {
    currentRole = e.target.dataset.role
    loginTitle.textContent = `LOGIN ${currentRole.toUpperCase()}`
    errorMessage.classList.add('hidden')
    loginForm.reset()

    if (currentRole === 'Admin') {
      // Admin: Solo pide contraseña (esconde campo de número de control)
      groupControl.classList.add('hidden')
      inputControl.removeAttribute('required')
    } else {
      // Estudiante o Chofer: Piden ambos campos
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

    // Mostrar Panel Estudiante
    viewLogin.classList.add('hidden')
    viewStudent.classList.remove('hidden')
    
    // Cargar Datos del Alumno en el Dashboard
    document.getElementById('student-name').textContent = alumno.nombre
    document.getElementById('student-control').textContent = alumno.matricula
    
    const saldo = alumno.saldo !== undefined && alumno.saldo !== null ? Number(alumno.saldo).toFixed(2) : '0.00'
    document.getElementById('student-balance').textContent = saldo
    document.getElementById('modal-student-id').textContent = `ID: ${alumno.matricula}`
  }

  // CASO B: CHOFER
  else if (currentRole === 'Chofer') {
    if (password === '123456' && control !== '') {
      viewLogin.classList.add('hidden')
      viewDashOther.classList.remove('hidden')
      document.getElementById('dash-title').textContent = 'PANEL CHOFER'
      document.getElementById('dash-desc').textContent = `Chofer ID: ${control}`
    } else {
      showError('Datos de Chofer incorrectos (Prueba clave: 123456)')
    }
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

// --- 3. LOGICA DEL MODAL Y DIBUJO DEL QR ---
const qrModal = document.getElementById('qr-modal')
const btnShowQr = document.getElementById('btn-show-qr')
const btnCloseQr = document.getElementById('btn-close-qr')

if (btnShowQr) {
  btnShowQr.addEventListener('click', () => {
    // 1. Mostrar el modal primero para dar dimensiones al canvas
    qrModal.classList.remove('hidden')

    // 2. Obtener matrícula del dashboard
    const matricula = document.getElementById('student-control').textContent

    // 3. Dibujar QR
    const canvas = document.getElementById('qr-canvas')
    QRCode.toCanvas(canvas, matricula, { 
      width: 200, 
      margin: 2,
      color: {
        dark: '#000000',
        light: '#ffffff'
      }
    }, (err) => {
      if (err) console.error('Error generando QR:', err)
    })
  })
}

if (btnCloseQr) {
  btnCloseQr.addEventListener('click', () => {
    qrModal.classList.add('hidden')
  })
}

if (qrModal) {
  qrModal.addEventListener('click', (e) => {
    if (e.target === qrModal) {
      qrModal.classList.add('hidden')
    }
  })
}

// Botones Cerrar Sesión
document.getElementById('btn-logout-student').addEventListener('click', resetApp)
document.getElementById('btn-logout-other').addEventListener('click', resetApp)

function resetApp() {
  if (qrModal) qrModal.classList.add('hidden')
  viewStudent.classList.add('hidden')
  viewDashOther.classList.add('hidden')
  viewLogin.classList.add('hidden')
  viewRoles.classList.remove('hidden')
  loginForm.reset()
}

// --- 4. VIDEO INTRO ---
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