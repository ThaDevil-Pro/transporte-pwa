// =====================================================================
// Importación de alumnos y choferes desde Excel (.xlsx) o CSV.
// El archivo se lee en el navegador; al servidor solo llegan las filas,
// en lotes de 15 (cifrar cada contraseña tarda ~85 ms y la API corta a 3 s).
// El servidor vuelve a validar todo: lo de aquí es para avisar antes.
// =====================================================================
import { $, esc, icon, avatar, haptic, toast, confirm, openSheet, closeSheet, setLoading } from './ui.js'
import { ROL_ETIQUETA, plural, leerArchivo, csv, descargar } from './hojas.js'

const LOTE = 15
const MUESTRA = 5
const MAX_ERRORES_VISIBLES = 50

export function initImportar({ rpc, usuariosExistentes, alTerminar }) {
  const inputArchivo = $('#import-file')
  const sheet = $('#sheet-import')
  const cuerpo = $('#import-body')
  const boton = $('#btn-import-run')
  let estado = null // { archivo, listas, errores, columnas, resultados, credenciales, descargado }

  $('#btn-import-pick').addEventListener('click', () => {
    inputArchivo.value = ''
    inputArchivo.click()
  })

  $('#btn-import-template').addEventListener('click', () => {
    descargar('plantilla-camify.csv', csv([
      ['Nombre', 'Matrícula', 'Contraseña', 'Saldo', 'Rol'],
      ['Ana López Ruiz', 'A2026001', '', '0', 'Alumno'],
      ['Luis Ortega Díaz', 'A2026002', '', '', 'Alumno'],
      ['Juan Pérez Mora', 'LIC12345', '', '', 'Chofer']
    ]))
  })

  inputArchivo.addEventListener('change', async () => {
    const archivo = inputArchivo.files?.[0]
    if (!archivo) return
    try {
      estado = { archivo: archivo.name, ...await leerArchivo(archivo, usuariosExistentes()) }
    } catch (err) {
      haptic([30, 50, 30])
      toast(err.message || 'No se pudo leer el archivo', { type: 'error', duration: 4500 })
      return
    }
    pintarVistaPrevia()
    // Al cerrar, las contraseñas no se quedan en memoria
    openSheet(sheet, { onClose: () => { estado = null } })
  })

  function filaError(f) {
    return `<div class="row">
      <span class="import-row-num">Fila ${f.fila}</span>
      <span class="row-text"><span class="row-title">${esc(f.nombre || f.identificador || 'Sin nombre')}</span><span class="row-sub">${esc(f.error)}</span></span>
    </div>`
  }

  function listaErrores(errores, titulo) {
    if (!errores.length) return ''
    const visibles = errores.slice(0, MAX_ERRORES_VISIBLES)
    const resto = errores.length - visibles.length
    return `<p class="import-subtitle">${esc(titulo)}</p>
      <div class="list">${visibles.map(filaError).join('')}</div>
      ${resto ? `<p class="field-hint">Y ${plural(resto, 'fila más', 'filas más')}.</p>` : ''}`
  }

  function pintarVistaPrevia() {
    const { archivo, listas, errores, columnas } = estado
    const sinPassword = listas.filter(f => !f.password).length
    delete sheet.dataset.locked

    cuerpo.innerHTML = `
      <div class="import-file">
        <span class="row-icon tint-green">${icon('i-sheet')}</span>
        <span class="row-text"><span class="row-title">${esc(archivo)}</span><span class="row-sub">Columnas: ${esc(columnas.join(', '))}</span></span>
      </div>
      <div class="import-stats">
        <div class="import-stat is-ok"><b>${listas.length}</b><span>listas para importar</span></div>
        <div class="import-stat${errores.length ? ' is-bad' : ''}"><b>${errores.length}</b><span>con problemas</span></div>
      </div>
      ${sinPassword ? `<p class="import-note is-info">${plural(sinPassword, 'fila no trae', 'filas no traen')} contraseña: se generará una temporal. Al terminar podrás descargarlas en un archivo para entregarlas.</p>` : ''}
      ${listaErrores(errores, 'No se importarán')}
      ${listas.length ? `<p class="import-subtitle">Vista previa</p>
        <div class="list">${listas.slice(0, MUESTRA).map(f => `<div class="row">
          ${avatar(f.nombre)}
          <span class="row-text"><span class="row-title">${esc(f.nombre)}</span><span class="row-sub">${ROL_ETIQUETA[f.rol]} · ${esc(f.identificador)}${f.saldo && Number(f.saldo) ? ` · Saldo $${esc(f.saldo)}` : ''}</span></span>
        </div>`).join('')}</div>
        ${listas.length > MUESTRA ? `<p class="field-hint">Y ${plural(listas.length - MUESTRA, 'más', 'más')}.</p>` : ''}` : ''}`

    boton.hidden = false
    boton.disabled = !listas.length
    boton.textContent = listas.length ? `Importar ${plural(listas.length, 'usuario', 'usuarios')}` : 'Nada que importar'
    boton.onclick = importar
  }

  function pintarProgreso(hechos, total) {
    cuerpo.innerHTML = `
      <p class="sheet-lead">No cierres la app hasta que termine.</p>
      <div class="progress" style="--p:${total ? hechos / total : 0}"><span></span></div>
      <p class="import-progress-label">Importando ${hechos} de ${total}…</p>`
  }

  async function importar() {
    const { listas } = estado
    sheet.dataset.locked = '1'
    setLoading(boton, true)
    pintarProgreso(0, listas.length)

    const resultados = []
    let interrumpido = null
    for (let i = 0; i < listas.length; i += LOTE) {
      const lote = listas.slice(i, i + LOTE)
      const { data, error } = await rpc('admin_importar_usuarios', {
        p_filas: lote.map(({ fila, rol, nombre, identificador, password, saldo }) => ({ fila, rol, nombre, identificador, password, saldo }))
      })
      if (error) {
        interrumpido = error.message || 'Se perdió la conexión'
        break
      }
      resultados.push(...data)
      pintarProgreso(Math.min(i + LOTE, listas.length), listas.length)
    }

    setLoading(boton, false)
    const porFila = new Map(listas.map(f => [f.fila, f]))
    estado.resultados = resultados
    estado.pendientes = listas.length - resultados.length
    estado.interrumpido = interrumpido
    estado.credenciales = resultados
      .filter(r => r.ok && r.password)
      .map(r => ({ ...porFila.get(r.fila), password: r.password }))
    estado.descargado = !estado.credenciales.length
    haptic([10, 40, 14])
    pintarResultado()
    alTerminar()
  }

  function pintarResultado() {
    const { resultados, credenciales, pendientes, interrumpido } = estado
    const porFila = new Map(estado.listas.map(f => [f.fila, f]))
    const creados = resultados.filter(r => r.ok).length
    const fallidos = resultados.filter(r => !r.ok).map(r => ({ ...porFila.get(r.fila), error: r.error }))
    // Mientras haya contraseñas sin descargar, la hoja no se cierra por accidente
    if (estado.descargado) delete sheet.dataset.locked
    else sheet.dataset.locked = '1'

    cuerpo.innerHTML = `
      <div class="import-stats">
        <div class="import-stat is-ok"><b>${creados}</b><span>${creados === 1 ? 'usuario creado' : 'usuarios creados'}</span></div>
        <div class="import-stat${fallidos.length + estado.errores.length ? ' is-bad' : ''}"><b>${fallidos.length + estado.errores.length}</b><span>no se crearon</span></div>
      </div>
      ${interrumpido ? `<p class="import-note">La importación se detuvo: ${esc(interrumpido)}. Faltaron ${plural(pendientes, 'fila', 'filas')}. Vuelve a importar el mismo archivo: los que ya se crearon aparecerán como “Ya existe”.</p>` : ''}
      ${credenciales.length ? `<p class="import-note"><b>Descarga las contraseñas temporales ahora.</b> Es la única vez que se muestran. Guárdalas en un lugar seguro y entrégalas en persona: al entrar, cada quien deberá cambiar la suya.</p>
        <button type="button" class="btn btn-tinted btn-lg btn-block" id="btn-import-download">${icon('i-download')}Descargar ${plural(credenciales.length, 'contraseña', 'contraseñas')}</button>` : ''}
      ${listaErrores(fallidos, 'Rechazadas por el servidor')}
      ${listaErrores(estado.errores, 'No se enviaron')}`

    $('#btn-import-download')?.addEventListener('click', () => {
      descargar(`contrasenas-camify-${new Date().toISOString().slice(0, 10)}.csv`, csv([
        ['Rol', 'Nombre', 'Matrícula o licencia', 'Contraseña temporal'],
        ...credenciales.map(c => [ROL_ETIQUETA[c.rol], c.nombre, c.identificador, c.password])
      ]))
      estado.descargado = true
      delete sheet.dataset.locked
      toast('Archivo descargado', { type: 'success' })
    })

    boton.textContent = 'Listo'
    boton.disabled = false
    boton.onclick = cerrar
  }

  async function cerrar() {
    if (!estado.descargado) {
      const ok = await confirm({
        title: '¿Cerrar sin descargar?',
        message: 'Las contraseñas temporales no se pueden volver a ver. Tendrías que restablecerlas una por una.',
        confirmLabel: 'Cerrar sin descargar',
        destructive: true
      })
      if (!ok) return
    }
    delete sheet.dataset.locked
    await closeSheet(sheet)
  }
}
