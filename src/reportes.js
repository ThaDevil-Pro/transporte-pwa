// =====================================================================
// Hoja de reportes: el alumno ve sus viajes, el chofer sus cortes del día,
// la semana o el mes, y la administración el informe de gastos o el
// reporte de cualquier chofer. Vista previa en la hoja y PDF descargable.
// =====================================================================
import { $, esc, icon, haptic, toast, openSheet, initSegmented, setLoading, skeletonRows, emptyState, animateNumber } from './ui.js'

const TZ = 'America/Mexico_City'
const MAX_FILAS = 40

const PERIODOS = {
  dia: { etiqueta: 'Día', adjetivo: 'diario' },
  semana: { etiqueta: 'Semana', adjetivo: 'semanal' },
  mes: { etiqueta: 'Mes', adjetivo: 'mensual' },
  anio: { etiqueta: 'Año', adjetivo: 'anual' }
}

const CONFIG = {
  Estudiante: { titulo: 'Reporte de viajes', periodos: ['semana', 'mes', 'anio'], inicial: 'mes' },
  Chofer: { titulo: 'Mis reportes', periodos: ['dia', 'semana', 'mes'], inicial: 'dia' },
  Admin: { titulo: 'Reportes', periodos: ['dia', 'semana', 'mes', 'anio'], inicial: 'mes' }
}

const dinero = new Intl.NumberFormat('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtDinero = n => `$${dinero.format(Number(n) || 0)}`
const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`
const mayus = s => s.charAt(0).toUpperCase() + s.slice(1)

// --- Fechas puras (YYYY-MM-DD), siempre en hora de México ---
const hoy = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ })
const aFecha = ymd => new Date(`${ymd}T12:00:00Z`)
const aYMD = d => d.toISOString().slice(0, 10)
const sumarDias = (ymd, n) => { const d = aFecha(ymd); d.setUTCDate(d.getUTCDate() + n); return aYMD(d) }
const fmtDia = (ymd, opts) => aFecha(ymd).toLocaleDateString('es-MX', { timeZone: 'UTC', ...opts })
const fmtHora = iso => new Date(iso).toLocaleTimeString('es-MX', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true })
const fmtFechaHora = iso => {
  const d = new Date(iso)
  return `${mayus(d.toLocaleDateString('es-MX', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' }))} · ${fmtHora(iso)}`
}

function rango(tipo, ref) {
  const d = aFecha(ref)
  if (tipo === 'dia') return { desde: ref, hasta: ref }
  if (tipo === 'semana') {
    const desde = sumarDias(ref, -((d.getUTCDay() + 6) % 7))
    return { desde, hasta: sumarDias(desde, 6) }
  }
  if (tipo === 'mes') {
    const desde = `${ref.slice(0, 7)}-01`
    const fin = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 12))
    return { desde, hasta: aYMD(fin) }
  }
  return { desde: `${ref.slice(0, 4)}-01-01`, hasta: `${ref.slice(0, 4)}-12-31` }
}

function mover(tipo, ref, dir) {
  if (tipo === 'dia') return sumarDias(ref, dir)
  if (tipo === 'semana') return sumarDias(ref, dir * 7)
  const d = aFecha(ref)
  if (tipo === 'mes') return aYMD(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + dir, 1, 12)))
  return `${d.getUTCFullYear() + dir}-01-01`
}

// Textos del periodo para la hoja y el PDF
function describir(tipo, ref) {
  const { desde, hasta } = rango(tipo, ref)
  const actual = rango(tipo, hoy()).desde === desde
  const anio = desde.slice(0, 4)
  let titulo, texto, relativo
  if (tipo === 'dia') {
    titulo = fmtDia(desde, { day: 'numeric', month: 'long' })
    texto = mayus(fmtDia(desde, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }))
    const semana = fmtDia(desde, { weekday: 'long' })
    relativo = actual ? `Hoy · ${semana}` : desde === sumarDias(hoy(), -1) ? `Ayer · ${semana}` : `${mayus(semana)} · ${anio}`
  } else if (tipo === 'semana') {
    const mismoMes = desde.slice(0, 7) === hasta.slice(0, 7)
    titulo = `${fmtDia(desde, mismoMes ? { day: 'numeric' } : { day: 'numeric', month: 'short' })} – ${fmtDia(hasta, { day: 'numeric', month: 'short' })}`
    texto = `Semana del ${fmtDia(desde, { day: 'numeric', month: 'long' })} al ${fmtDia(hasta, { day: 'numeric', month: 'long', year: 'numeric' })}`
    relativo = actual ? 'Esta semana' : anio
  } else if (tipo === 'mes') {
    titulo = mayus(fmtDia(desde, { month: 'long' }))
    texto = mayus(fmtDia(desde, { month: 'long', year: 'numeric' }))
    relativo = actual ? 'Este mes' : anio
  } else {
    titulo = anio
    texto = `Año ${anio}`
    relativo = actual ? 'Este año' : 'Año completo'
  }
  return {
    tipo, desde, hasta, titulo, texto, relativo,
    adjetivo: PERIODOS[tipo].adjetivo,
    archivo: tipo === 'dia' ? desde : tipo === 'semana' ? `semana-${desde}` : tipo === 'mes' ? desde.slice(0, 7) : anio
  }
}

export function initReportes({ rpc }) {
  const sheet = $('#sheet-report')
  const kindSeg = $('#report-kind')
  const choferField = $('#report-chofer-field')
  const choferSelect = $('#report-chofer')
  const periodSeg = $('#report-period')
  const preview = $('#report-preview')
  const btnPdf = $('#btn-report-pdf')
  const btnPrev = $('#report-prev')
  const btnNext = $('#report-next')

  let estado = null // { rol, perfil, tipo: 'propio'|'gastos'|'chofer', periodo, ref, licencia, datos }
  let peticion = 0
  let periodos = null
  let choferes = []

  const kind = initSegmented(kindSeg, valor => {
    estado.tipo = valor
    pintarControles()
    cargar()
  })

  choferSelect.addEventListener('change', () => {
    estado.licencia = choferSelect.value
    cargar()
  })

  btnPrev.addEventListener('click', () => navegar(-1))
  btnNext.addEventListener('click', () => navegar(1))

  function navegar(dir) {
    const ref = mover(estado.periodo, estado.ref, dir)
    if (dir > 0 && rango(estado.periodo, ref).desde > hoy()) return
    haptic(5)
    estado.ref = ref
    pintarRango()
    cargar()
  }

  // rol: 'Estudiante' | 'Chofer' | 'Admin'; tipo (admin): 'gastos' | 'chofer'
  async function abrir({ rol, perfil = {}, tipo = 'gastos', licencia = null }) {
    const cfg = CONFIG[rol]
    estado = {
      rol, perfil,
      tipo: rol === 'Admin' ? tipo : 'propio',
      periodo: cfg.inicial,
      ref: hoy(),
      licencia,
      datos: null
    }
    $('#sheet-report-title').textContent = cfg.titulo

    // Periodos según el rol (los botones se rehacen; el segmentado es nuevo)
    periodSeg.style.setProperty('--n', cfg.periodos.length)
    periodSeg.innerHTML = '<span class="segmented-thumb"></span>' +
      cfg.periodos.map(p => `<button type="button" data-value="${p}">${PERIODOS[p].etiqueta}</button>`).join('')
    periodSeg.dataset.value = cfg.inicial
    periodos = initSegmented(periodSeg, valor => {
      estado.periodo = valor
      estado.ref = ajustarRef(valor, estado.ref)
      pintarRango()
      cargar()
    })

    kindSeg.hidden = rol !== 'Admin'
    if (rol === 'Admin') kind.select(estado.tipo, false)
    choferField.hidden = true
    pintarRango()
    preview.innerHTML = ''
    btnPdf.disabled = true
    const actual = estado
    openSheet(sheet, { onClose: () => { peticion++; estado = null } })
    // La lista de choferes se pide cada vez: pudieron agregarse nuevos
    if (rol === 'Admin') await cargarChoferes()
    if (estado !== actual) return
    pintarControles()
    cargar()
  }

  // Al cambiar de periodo se queda en el más reciente que no pase de hoy
  function ajustarRef(tipo, ref) {
    return rango(tipo, ref).desde > hoy() ? hoy() : ref
  }

  async function cargarChoferes() {
    const { data, error } = await rpc('admin_reporte_choferes')
    if (error) return
    choferes = data
    choferSelect.innerHTML = choferes.length
      ? choferes.map(c => `<option value="${esc(c.licencia)}">${esc(c.nombre)}${c.activo ? '' : ' (dado de baja)'} · ${esc(c.licencia)}</option>`).join('')
      : '<option value="">Sin choferes registrados</option>'
  }

  function pintarControles() {
    const verChofer = estado.rol === 'Admin' && estado.tipo === 'chofer'
    choferField.hidden = !verChofer
    if (verChofer) {
      if (!choferes.some(c => c.licencia === estado.licencia)) estado.licencia = choferes[0]?.licencia || null
      choferSelect.value = estado.licencia || ''
    }
  }

  function pintarRango() {
    const p = describir(estado.periodo, estado.ref)
    $('#report-range-title').textContent = p.titulo
    $('#report-range-sub').textContent = p.relativo
    btnNext.disabled = rango(estado.periodo, mover(estado.periodo, estado.ref, 1)).desde > hoy()
  }

  async function cargar() {
    if (!estado) return
    const turno = ++peticion
    const p = describir(estado.periodo, estado.ref)
    const params = { p_desde: p.desde, p_hasta: p.hasta }
    let nombre
    if (estado.rol === 'Estudiante') nombre = 'alumno_reporte'
    else if (estado.rol === 'Chofer') nombre = 'chofer_reporte'
    else if (estado.tipo === 'gastos') nombre = 'admin_reporte_gastos'
    else {
      nombre = 'admin_reporte_chofer'
      params.p_licencia = estado.licencia
      if (!estado.licencia) {
        estado.datos = null
        preview.innerHTML = emptyState('i-users', 'Sin choferes', 'Registra un chofer para ver sus reportes.')
        btnPdf.disabled = true
        return
      }
    }

    estado.datos = null
    btnPdf.disabled = true
    preview.innerHTML = `<div class="report-stats is-loading">${'<div class="report-stat skeleton"></div>'.repeat(4)}</div>${skeletonRows(3)}`
    const { data, error } = await rpc(nombre, params)
    if (turno !== peticion || !estado) return
    if (error) {
      preview.innerHTML = emptyState('i-alert', 'No se pudo cargar', error.message || 'Revisa tu conexión e intenta de nuevo.')
      return
    }
    estado.datos = data
    btnPdf.disabled = false
    pintarVista(p)
  }

  // --- Vista previa en la hoja ---
  function stats(items) {
    return `<div class="report-stats">${items.map(it => `
      <div class="report-stat${it.tono ? ` is-${it.tono}` : ''}">
        <span class="report-stat-label">${esc(it.etiqueta)}</span>
        <span class="report-stat-value${it.valor.length > 8 ? ' is-long' : ''}" data-valor="${it.numero ?? ''}" data-decimales="${it.dinero ? 2 : 0}">${esc(it.valor)}</span>
        ${it.nota ? `<span class="report-stat-note">${esc(it.nota)}</span>` : ''}
      </div>`).join('')}</div>`
  }

  const encabezado = (titulo, meta = '') =>
    `<div class="section-header report-section"><h3>${esc(titulo)}</h3>${meta ? `<span class="section-meta">${esc(meta)}</span>` : ''}</div>`

  const fila = ({ iconId, tono = '', titulo, sub, monto, montoTono = '', data = '' }) => `
    <div class="row"${data}>
      <span class="row-icon${tono ? ` ${tono}` : ''}">${icon(iconId)}</span>
      <span class="row-text"><span class="row-title">${esc(titulo)}</span><span class="row-sub">${esc(sub)}</span></span>
      <span class="row-trailing${montoTono ? ` ${montoTono}` : ''}">${esc(monto)}</span>
    </div>`

  const resto = n => (n > 0 ? `<p class="report-more">y ${plural(n, 'registro más', 'registros más')} en el PDF</p>` : '')

  function pintarVista(p) {
    const d = estado.datos
    let html = ''

    if (estado.rol === 'Estudiante') {
      const cobrado = d.viajes.reduce((s, v) => s + Number(v.monto), 0)
      const pagado = d.pagos.reduce((s, x) => s + Number(x.monto), 0)
      html += stats([
        { etiqueta: 'Viajes', valor: String(d.viajes.length), numero: d.viajes.length },
        { etiqueta: 'Cobrado', valor: fmtDinero(cobrado), numero: cobrado, dinero: true },
        { etiqueta: 'Pagado', valor: fmtDinero(pagado), numero: pagado, dinero: true, tono: pagado ? 'green' : '' },
        { etiqueta: 'Saldo hoy', valor: fmtDinero(d.alumno.saldo), numero: Number(d.alumno.saldo), dinero: true, tono: Number(d.alumno.saldo) > 0 ? 'orange' : '' }
      ])
      const movs = [
        ...d.viajes.map(v => ({ f: v.fecha_hora, pago: false, ...v })),
        ...d.pagos.map(x => ({ f: x.creado_en, pago: true, ...x }))
      ].sort((a, b) => new Date(b.f) - new Date(a.f))
      html += encabezado('Movimientos', movs.length ? plural(movs.length, 'registro', 'registros') : '')
      html += movs.length
        ? `<div class="list">${movs.slice(0, MAX_FILAS).map(m => fila({
            iconId: m.pago ? 'i-wallet' : 'i-bus',
            tono: m.pago ? 'is-money' : '',
            titulo: m.pago ? 'Pago registrado' : `Viaje · Camión ${m.camion ?? 1}`,
            sub: `${fmtFechaHora(m.f)}${m.pago && m.nota ? ` · ${m.nota}` : ''}${m.manual ? ' · A mano' : ''}`,
            monto: `${m.pago ? '−' : ''}${fmtDinero(m.monto)}`,
            montoTono: m.pago ? 'is-positive' : ''
          })).join('')}</div>${resto(movs.length - MAX_FILAS)}`
        : emptyState('i-receipt', 'Sin viajes', `No tuviste viajes ni pagos en ${p.texto.toLowerCase().startsWith('semana') ? 'esta semana' : 'este periodo'}.`)
    } else if (estado.tipo === 'gastos') {
      const cobrado = d.alumnos.reduce((s, a) => s + Number(a.cargado), 0)
      const viajes = d.alumnos.reduce((s, a) => s + Number(a.viajes), 0)
      const pagado = d.pagos.reduce((s, x) => s + Number(x.monto), 0)
      html += stats([
        { etiqueta: 'Cobrado', valor: fmtDinero(cobrado), numero: cobrado, dinero: true, nota: plural(viajes, 'viaje', 'viajes') },
        { etiqueta: 'Pagos', valor: fmtDinero(pagado), numero: pagado, dinero: true, tono: pagado ? 'green' : '', nota: plural(d.pagos.length, 'pago', 'pagos') },
        { etiqueta: 'Adeudo hoy', valor: fmtDinero(d.adeudo_total), numero: Number(d.adeudo_total), dinero: true, tono: Number(d.adeudo_total) > 0 ? 'orange' : '' },
        { etiqueta: 'Con adeudo', valor: String(d.alumnos_con_adeudo), numero: d.alumnos_con_adeudo, nota: 'alumnos' }
      ])
      html += encabezado('Por chofer', d.choferes.length ? 'Toca para ver su reporte' : '')
      html += d.choferes.length
        ? `<div class="list">${d.choferes.map(c => fila({
            iconId: 'i-wheel',
            titulo: c.nombre,
            sub: `${plural(c.cortes, 'corte', 'cortes')} · ${plural(c.alumnos, 'pasajero', 'pasajeros')}`,
            monto: fmtDinero(c.total),
            data: ` data-licencia="${esc(c.licencia)}" role="button" tabindex="0"`
          })).join('')}</div>`
        : `<p class="report-empty">Ningún chofer hizo cortes en este periodo.</p>`
      if (d.camiones.length) {
        html += encabezado('Por camión')
        html += `<div class="list">${d.camiones.map(c => fila({ iconId: 'i-bus', titulo: `Camión ${c.camion}`, sub: plural(c.viajes, 'viaje', 'viajes'), monto: fmtDinero(c.cargado) })).join('')}</div>`
      }
      html += encabezado('Por alumno', d.alumnos.length ? plural(d.alumnos.length, 'alumno', 'alumnos') : '')
      html += d.alumnos.length
        ? `<div class="list">${d.alumnos.slice(0, MAX_FILAS).map(a => fila({
            iconId: 'i-student',
            titulo: a.nombre,
            sub: `${a.matricula} · ${plural(a.viajes, 'viaje', 'viajes')} · pagó ${fmtDinero(a.pagado)}`,
            monto: fmtDinero(a.saldo),
            montoTono: Number(a.saldo) > 0 ? 'is-warning' : 'is-muted'
          })).join('')}</div>${resto(d.alumnos.length - MAX_FILAS)}<p class="report-more">La cantidad a la derecha es el saldo pendiente de hoy.</p>`
        : `<p class="report-empty">Sin movimientos en este periodo.</p>`
    } else {
      const cortes = d.cortes
      const pasajeros = cortes.reduce((s, c) => s + c.alumnos, 0)
      const manuales = cortes.reduce((s, c) => s + c.manuales, 0)
      const total = cortes.reduce((s, c) => s + Number(c.total), 0)
      html += stats([
        { etiqueta: 'Cortes', valor: String(cortes.length), numero: cortes.length },
        { etiqueta: 'Pasajeros', valor: String(pasajeros), numero: pasajeros },
        { etiqueta: 'Total cobrado', valor: fmtDinero(total), numero: total, dinero: true },
        { etiqueta: 'A mano', valor: String(manuales), numero: manuales, nota: pasajeros ? `${Math.round((manuales / pasajeros) * 100)}% del total` : '' }
      ])
      html += encabezado('Cortes', cortes.length ? 'Toca uno para ver quién subió' : '')
      html += cortes.length
        ? `<div class="list">${[...cortes].reverse().slice(0, MAX_FILAS).map(c => fila({
            iconId: 'i-receipt',
            titulo: `Corte · Camión ${c.camion}`,
            sub: `${estado.periodo === 'dia' ? fmtHora(c.creado_en) : fmtFechaHora(c.creado_en)} · ${plural(c.alumnos, 'pasajero', 'pasajeros')}${c.manuales ? ` (${c.manuales} a mano)` : ''}`,
            monto: fmtDinero(c.total),
            data: ` data-corte="${c.id}" role="button" tabindex="0" aria-expanded="false"`
          }) + `<ol class="report-detail" data-detalle="${c.id}" hidden>${c.pasajeros.length
            ? c.pasajeros.map(x => `<li><span>${esc(x.nombre)}</span><span class="report-detail-meta">${esc(x.matricula)}${x.manual ? ' · A mano' : ''}</span></li>`).join('')
            : '<li><span>Sin detalle de pasajeros</span></li>'}</ol>`).join('')}</div>${resto(cortes.length - MAX_FILAS)}`
        : emptyState('i-receipt', 'Sin cortes', estado.periodo === 'dia' ? 'No hay cortes este día.' : 'No hay cortes en este periodo.')
    }

    preview.innerHTML = html
    preview.querySelectorAll('.report-stat-value[data-valor]').forEach(el => {
      const n = Number(el.dataset.valor)
      if (!el.dataset.valor || !Number.isFinite(n) || n === 0) return
      const dec = Number(el.dataset.decimales)
      if (dec) {
        // animateNumber pinta solo el número; se conserva el signo de pesos
        el.innerHTML = `$<span></span>`
        animateNumber(el.firstElementChild, n, { decimals: 2, duration: 900 })
      } else {
        el.textContent = '0'
        animateNumber(el, n, { duration: 700 })
      }
    })
  }

  // Detalle de un corte o ir al reporte de un chofer desde el informe de gastos
  function activarFila(el) {
    if (!estado?.datos) return
    if (el.dataset.corte) {
      const detalle = preview.querySelector(`[data-detalle="${el.dataset.corte}"]`)
      if (!detalle) return
      haptic(6)
      const abrir = detalle.hidden
      detalle.hidden = !abrir
      el.setAttribute('aria-expanded', String(abrir))
      if (abrir) {
        detalle.animate([{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }],
          { duration: 320, easing: 'cubic-bezier(0.25, 1, 0.5, 1)' })
      }
    } else if (el.dataset.licencia) {
      haptic(6)
      estado.tipo = 'chofer'
      estado.licencia = el.dataset.licencia
      kind.select('chofer', false)
      pintarControles()
      cargar()
    }
  }

  preview.addEventListener('click', e => {
    const el = e.target.closest('[data-corte], [data-licencia]')
    if (el) activarFila(el)
  })
  preview.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    const el = e.target.closest('[data-corte], [data-licencia]')
    if (!el) return
    e.preventDefault()
    activarFila(el)
  })

  btnPdf.addEventListener('click', async () => {
    if (!estado?.datos) return
    const p = describir(estado.periodo, estado.ref)
    const datos = estado.datos
    setLoading(btnPdf, true)
    try {
      const pdf = await import('./pdf.js')
      if (estado.rol === 'Estudiante') await pdf.pdfAlumno(datos, p)
      else if (estado.tipo === 'gastos') await pdf.pdfGastos(datos, p, { admin: estado.perfil?.usuario })
      else await pdf.pdfChofer(datos, p)
      haptic([10, 40, 14])
      toast('Reporte descargado', { type: 'success' })
    } catch (err) {
      console.error('Error al generar el PDF:', err)
      toast('No se pudo generar el PDF. Revisa tu conexión e intenta de nuevo.', { type: 'error', duration: 4000 })
    } finally {
      setLoading(btnPdf, false)
    }
  })

  return { abrir }
}
