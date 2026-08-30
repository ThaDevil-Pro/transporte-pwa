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
// Ocultar el Splash Screen cuando termine el video .mp4
const splash = document.getElementById('splash-screen')
const video = document.getElementById('splash-video')

if (video && splash) {
  let cerrado = false

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
    // Cambia 1.5 por los segundos exactos donde quieres cortar
    if (video.currentTime >= 2.0) { 
      cerrarSplash()
    }
  })

  // Por si el video finaliza antes de tiempo
  video.addEventListener('ended', cerrarSplash)

  // Respaldo por si el navegador bloquea el autoplay
  video.play().catch(() => {
    cerrarSplash()
  })
}