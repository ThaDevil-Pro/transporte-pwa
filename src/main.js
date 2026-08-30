import QRCode from 'qrcode'
import { supabase } from './supabase.js'

// Variables de interfaz
let selectedRole = ''
const roleSelector = document.getElementById('role-selector')
const loginFormBox = document.getElementById('login-form-box')
const loginTitle = document.getElementById('login-title')
const formLogin = document.getElementById('form-login')
const studentDashboard = document.getElementById('student-dashboard')
const loginError = document.getElementById('login-error')

// Botones de Rol
document.querySelectorAll('.btn-role').forEach(button => {
  button.addEventListener('click', (e) => {
    selectedRole = e.target.dataset.role
    loginTitle.textContent = `LOGIN - ${selectedRole.toUpperCase()}`
    roleSelector.classList.add('hidden')
    loginFormBox.classList.remove('hidden')
  })
})

// Botón Volver
document.getElementById('btn-back').addEventListener('click', () => {
  loginFormBox.classList.add('hidden')
  roleSelector.classList.remove('hidden')
  loginError.classList.add('hidden')
})

// Procesar Formulario de Login
formLogin.addEventListener('submit', async (e) => {
  e.preventDefault()
  loginError.classList.add('hidden')
  
  const matricula = document.getElementById('control-number').value.trim()
  const password = document.getElementById('password').value.trim()

  if (selectedRole === 'Estudiante') {
    // Validar alumno en Supabase
    const { data: alumno, error } = await supabase
      .from('alumnos')
      .select('*')
      .eq('matricula', matricula)
      .eq('password', password)
      .single()

    if (error || !alumno) {
      loginError.textContent = 'Número de control o contraseña incorrectos'
      loginError.classList.remove('hidden')
      return
    }

    // Login Exitoso para Estudiante
    loginFormBox.classList.add('hidden')
    studentDashboard.classList.remove('hidden')
    mostrarAlumno(alumno)

  } else {
    // Para Chofer y Admin (Simulación básica por ahora)
    alert(`Bienvenido ${selectedRole}: ${matricula}`)
  }
})

// Mostrar nombre y generar QR del estudiante
function mostrarAlumno(alumno) {
  document.getElementById('alumno-nombre').textContent = alumno.nombre
  const canvas = document.getElementById('qr-canvas')

  QRCode.toCanvas(canvas, alumno.matricula, { width: 200, margin: 1 }, (err) => {
    if (err) console.error(err)
  })
}

// Cerrar sesión
document.getElementById('btn-logout').addEventListener('click', () => {
  studentDashboard.classList.add('hidden')
  roleSelector.classList.remove('hidden')
  formLogin.reset()
})

// --- LÓGICA DEL VIDEO INTRO ---
const splash = document.getElementById('splash-screen')
const video = document.getElementById('splash-video')

if (video && splash) {
  let cerrado = false

  video.muted = true
  video.setAttribute('playsinline', '')
  video.setAttribute('webkit-playsinline', '')

  function cerrarSplash() {
    if (cerrado) return
    cerrado = true
    splash.style.opacity = '0'
    setTimeout(() => {
      splash.style.display = 'none'
      video.pause()
    }, 500)
  }

  video.addEventListener('timeupdate', () => {
    if (video.currentTime >= 2.0) { 
      cerrarSplash()
    }
  })

  video.addEventListener('ended', cerrarSplash)

  const reproducirVideo = () => {
    const playPromise = video.play()
    if (playPromise !== undefined) {
      playPromise.catch(() => {
        const forcePlay = () => {
          video.play()
          window.removeEventListener('touchstart', forcePlay)
          window.removeEventListener('click', forcePlay)
          window.removeEventListener('scroll', forcePlay)
        }
        window.addEventListener('touchstart', forcePlay, { passive: true })
        window.addEventListener('click', forcePlay, { passive: true })
        window.addEventListener('scroll', forcePlay, { passive: true })
      })
    }
  }

  reproducirVideo()
}