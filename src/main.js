import QRCode from 'qrcode'
import { supabase } from './supabase.js'

async function cargarDatosAlumno() {
  // Buscar el alumno en la base de datos de Supabase
  const { data: alumnos, error } = await supabase
    .from('alumnos')
    .select('*')
    .limit(1)

  if (error) {
    console.error('Error cargando alumno:', error)
    document.getElementById('alumno-nombre').textContent = 'Error al cargar datos'
    return
  }

  if (alumnos && alumnos.length > 0) {
    const alumno = alumnos[0]

    // Poner el nombre real de Supabase
    document.getElementById('alumno-nombre').textContent = alumno.nombre

    // Generar el QR codificando la MATRÍCULA real guardada en la BD
    const canvas = document.getElementById('qr-canvas')
    QRCode.toCanvas(canvas, alumno.matricula, { width: 220, margin: 2 }, (err) => {
      if (err) console.error(err)
      else console.log('QR generado con la matrícula real:', alumno.matricula)
    })
  } else {
    document.getElementById('alumno-nombre').textContent = 'No hay alumnos registrados'
  }
}

cargarDatosAlumno()

// Manejo del Splash Screen y forzado de autoplay en Modo Ahorro
const splash = document.getElementById('splash-screen')
const video = document.getElementById('splash-video')

if (video && splash) {
  let cerrado = false

  // Atributos obligatorios para iOS
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

  // Monitorear el tiempo del video mientras se reproduce
  video.addEventListener('timeupdate', () => {
    if (video.currentTime >= 2.0) { 
      cerrado = true
      splash.style.opacity = '0'
      setTimeout(() => {
        splash.style.display = 'none'
        video.pause()
      }, 500)
    }
  })

  // Por si el video finaliza antes de tiempo
  video.addEventListener('ended', cerrarSplash)

  // Intentar reproduccion automatica y forzar al toque si hay Ahorro de Batería
  const reproducirVideo = () => {
    const playPromise = video.play()

    if (playPromise !== undefined) {
      playPromise.catch(() => {
        // Si el ahorro de energía lo frena, arranca al primer toque/scroll en el iPhone
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