// =====================================================================
// Fotos de los alumnos (administración).
// · Una por una: al registrar o editar a un alumno.
// · En lote: una carpeta (o varias fotos) donde cada archivo se llama con el
//   número de control del alumno, p. ej. 26010024.jpg. Se reducen en el
//   navegador (unos 50 KB cada una) y se suben en lotes de 8; el servidor
//   vuelve a validar que sea JPEG y que el alumno exista.
// =====================================================================
import { $, esc, icon, avatar, haptic, toast, openSheet, closeSheet, setLoading } from './ui.js'

const LOTE = 8
const LADO = 480
const EXT = /\.(jpe?g|png|webp|heic|heif)$/i
const MAX_LISTA = 40
const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`

// Reduce una imagen a JPEG (lado mayor de 480 px). Devuelve la dirección para
// mostrarla y el base64 que se envía al servidor.
export async function comprimirFoto(archivo, { lado = LADO, calidad = 0.82 } = {}) {
  let bmp
  try {
    bmp = await createImageBitmap(archivo, { imageOrientation: 'from-image' })
  } catch {
    throw new Error('No se pudo abrir la imagen: usa JPG o PNG')
  }
  const k = Math.min(1, lado / Math.max(bmp.width, bmp.height))
  const w = Math.max(1, Math.round(bmp.width * k))
  const h = Math.max(1, Math.round(bmp.height * k))
  const lienzo = document.createElement('canvas')
  lienzo.width = w
  lienzo.height = h
  const ctx = lienzo.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(bmp, 0, 0, w, h)
  bmp.close?.()
  let url = lienzo.toDataURL('image/jpeg', calidad)
  // El servidor acepta hasta 250 KB: una foto muy detallada se comprime más
  if (url.length > 300000) url = lienzo.toDataURL('image/jpeg', 0.6)
  return { url, base64: url.slice(url.indexOf(',') + 1) }
}

export const urlFoto = base64 => (base64 ? `data:image/jpeg;base64,${base64}` : null)

// Botón para elegir una sola foto con su vista previa.
// valor: undefined = sin cambios, null = quitarla, texto = foto nueva (base64)
export function selectorFoto({ boton, input, vista, quitar = null, nombre = () => '' }) {
  let valor
  let tiene = false

  function pintar(url) {
    tiene = !!url
    vista.innerHTML = url ? `<img src="${url}" alt="Foto del alumno">` : avatar(nombre() || '?')
    vista.classList.toggle('has-foto', tiene)
    boton.textContent = tiene ? 'Cambiar' : 'Elegir'
    if (quitar) quitar.hidden = !tiene
  }

  boton.addEventListener('click', () => {
    input.value = ''
    input.click()
  })
  input.addEventListener('change', async () => {
    const archivo = input.files?.[0]
    if (!archivo) return
    setLoading(boton, true)
    try {
      const r = await comprimirFoto(archivo)
      valor = r.base64
      pintar(r.url)
      haptic(6)
    } catch (err) {
      toast(err.message, { type: 'error' })
    }
    setLoading(boton, false)
  })
  quitar?.addEventListener('click', () => {
    valor = null
    pintar(null)
  })

  return {
    get valor() { return valor },
    cargar(url) { valor = undefined; pintar(url) },
    reset() { valor = undefined; pintar(null) }
  }
}

// Archivos soltados en la tarjeta: también recorre carpetas y subcarpetas
async function archivosSoltados(dt) {
  const entradas = [...(dt.items || [])].map(i => i.webkitGetAsEntry?.()).filter(Boolean)
  if (!entradas.length) return [...(dt.files || [])]
  const salida = []
  const leer = async entrada => {
    if (entrada.isFile) {
      salida.push(await new Promise((ok, mal) => entrada.file(ok, mal)))
    } else if (entrada.isDirectory) {
      const lector = entrada.createReader()
      for (;;) {
        const lote = await new Promise((ok, mal) => lector.readEntries(ok, mal))
        if (!lote.length) break
        for (const e of lote) await leer(e)
      }
    }
  }
  for (const e of entradas) await leer(e)
  return salida
}

export function initFotos({ rpc, alumnos, alTerminar }) {
  const sheet = $('#sheet-fotos')
  const cuerpo = $('#fotos-body')
  const boton = $('#btn-fotos-run')
  const enCarpeta = $('#fotos-carpeta')
  const enArchivos = $('#fotos-archivos')
  const tarjeta = $('.fotos-card')
  let estado = null

  $('#btn-fotos-carpeta').addEventListener('click', () => {
    enCarpeta.value = ''
    enCarpeta.click()
  })
  $('#btn-fotos-archivos').addEventListener('click', () => {
    enArchivos.value = ''
    enArchivos.click()
  })
  enCarpeta.addEventListener('change', () => analizar([...enCarpeta.files]))
  enArchivos.addEventListener('change', () => analizar([...enArchivos.files]))

  // En computadora también se puede arrastrar la carpeta a la tarjeta
  tarjeta.addEventListener('dragover', e => {
    e.preventDefault()
    tarjeta.classList.add('is-drop')
  })
  tarjeta.addEventListener('dragleave', () => tarjeta.classList.remove('is-drop'))
  tarjeta.addEventListener('drop', async e => {
    e.preventDefault()
    tarjeta.classList.remove('is-drop')
    analizar(await archivosSoltados(e.dataTransfer))
  })

  function analizar(archivos) {
    const porMatricula = new Map(alumnos().map(a => [String(a.matricula).toLowerCase(), a]))
    const fotos = archivos.filter(f => EXT.test(f.name))
    if (!fotos.length) {
      toast(archivos.length ? 'No encontramos fotos (JPG o PNG) en lo que elegiste' : 'No elegiste ningún archivo', { type: 'warning' })
      return
    }
    const vistos = new Set()
    const listas = []
    const sinAlumno = []
    const repetidas = []
    for (const f of fotos) {
      const base = f.name.replace(/\.[^.]+$/, '').trim()
      const a = porMatricula.get(base.toLowerCase())
      if (!a) sinAlumno.push(f.name)
      else if (vistos.has(a.matricula)) repetidas.push(f.name)
      else {
        vistos.add(a.matricula)
        listas.push({ archivo: f, alumno: a })
      }
    }
    estado = { listas, sinAlumno, repetidas, ignorados: archivos.length - fotos.length }
    pintarVistaPrevia()
    openSheet(sheet, { onClose: () => { estado = null } })
  }

  function listaNombres(nombres, titulo) {
    if (!nombres.length) return ''
    const visibles = nombres.slice(0, MAX_LISTA)
    return `<p class="import-subtitle">${esc(titulo)}</p>
      <div class="list">${visibles.map(n => `<div class="row"><span class="row-icon">${icon('i-image')}</span><span class="row-text"><span class="row-title">${esc(n)}</span></span></div>`).join('')}</div>
      ${nombres.length > visibles.length ? `<p class="field-hint">Y ${plural(nombres.length - visibles.length, 'más', 'más')}.</p>` : ''}`
  }

  function pintarVistaPrevia() {
    const { listas, sinAlumno, repetidas, ignorados } = estado
    const reemplazos = listas.filter(x => x.alumno.foto).length
    delete sheet.dataset.locked
    cuerpo.innerHTML = `
      <div class="import-stats">
        <div class="import-stat is-ok"><b>${listas.length}</b><span>coinciden con un alumno</span></div>
        <div class="import-stat${sinAlumno.length ? ' is-bad' : ''}"><b>${sinAlumno.length}</b><span>sin alumno con esa matrícula</span></div>
      </div>
      ${reemplazos ? `<p class="import-note is-info">${plural(reemplazos, 'alumno ya tiene', 'alumnos ya tienen')} foto: se reemplazará por la nueva.</p>` : ''}
      ${ignorados ? `<p class="field-hint">${plural(ignorados, 'archivo no es foto y se ignora', 'archivos no son fotos y se ignoran')}.</p>` : ''}
      ${listas.length ? `<p class="import-subtitle">Vista previa</p>
        <div class="list">${listas.slice(0, 5).map(({ archivo, alumno }) => `<div class="row">
          ${avatar(alumno.nombre)}
          <span class="row-text"><span class="row-title">${esc(alumno.nombre)}</span><span class="row-sub">${esc(alumno.matricula)} · ${esc(archivo.name)}</span></span>
        </div>`).join('')}</div>
        ${listas.length > 5 ? `<p class="field-hint">Y ${plural(listas.length - 5, 'más', 'más')}.</p>` : ''}` : ''}
      ${listaNombres(sinAlumno, 'No se cargarán: el nombre del archivo no es una matrícula registrada')}
      ${listaNombres(repetidas, 'Repetidas (se usa la primera)')}`
    boton.disabled = !listas.length
    boton.textContent = listas.length ? `Cargar ${plural(listas.length, 'foto', 'fotos')}` : 'Nada que cargar'
    boton.onclick = cargar
  }

  function pintarProgreso(hechos, total) {
    cuerpo.innerHTML = `
      <p class="sheet-lead">No cierres la app hasta que termine.</p>
      <div class="progress" style="--p:${total ? hechos / total : 0}"><span></span></div>
      <p class="import-progress-label">Cargando ${hechos} de ${total}…</p>`
  }

  async function cargar() {
    const { listas } = estado
    sheet.dataset.locked = '1'
    setLoading(boton, true)
    pintarProgreso(0, listas.length)
    const errores = []
    let cargadas = 0
    let interrumpido = null

    for (let i = 0; i < listas.length; i += LOTE) {
      const lote = []
      for (const it of listas.slice(i, i + LOTE)) {
        try {
          lote.push({ it, foto: (await comprimirFoto(it.archivo)).base64 })
        } catch (err) {
          errores.push({ nombre: it.archivo.name, error: err.message })
        }
      }
      if (lote.length) {
        const { data, error } = await rpc('admin_fotos_lote', { p_fotos: lote.map(x => ({ matricula: x.it.alumno.matricula, foto: x.foto })) })
        if (error) {
          interrumpido = error.message || 'Se perdió la conexión'
          break
        }
        data.forEach((r, k) => (r.ok ? cargadas++ : errores.push({ nombre: lote[k].it.archivo.name, error: r.error })))
      }
      pintarProgreso(Math.min(i + LOTE, listas.length), listas.length)
    }

    setLoading(boton, false)
    delete sheet.dataset.locked
    haptic([10, 40, 14])
    cuerpo.innerHTML = `
      <div class="import-stats">
        <div class="import-stat is-ok"><b>${cargadas}</b><span>${cargadas === 1 ? 'foto asignada' : 'fotos asignadas'}</span></div>
        <div class="import-stat${errores.length ? ' is-bad' : ''}"><b>${errores.length}</b><span>con problemas</span></div>
      </div>
      ${interrumpido ? `<p class="import-note">La carga se detuvo: ${esc(interrumpido)}. Vuelve a elegir la carpeta: las fotos que ya se cargaron solo se reemplazan.</p>` : ''}
      ${errores.length ? `<p class="import-subtitle">No se cargaron</p>
        <div class="list">${errores.slice(0, MAX_LISTA).map(e => `<div class="row"><span class="row-icon">${icon('i-alert')}</span><span class="row-text"><span class="row-title">${esc(e.nombre)}</span><span class="row-sub">${esc(e.error)}</span></span></div>`).join('')}</div>` : ''}`
    boton.textContent = 'Listo'
    boton.disabled = false
    boton.onclick = () => closeSheet(sheet)
    alTerminar?.()
  }
}
