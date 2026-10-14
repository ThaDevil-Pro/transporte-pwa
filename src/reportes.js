// =====================================================================
// Hoja de reportes: el alumno ve sus viajes, el chofer sus cortes del día,
// la semana o el mes, y la administración el informe de gastos, el
// reporte de cualquier chofer o el informe de diésel (también por
// semestre). Vista previa en la hoja y PDF descargable.
// =====================================================================
import { camionCorto } from './camiones.js'
import { $, esc, icon, haptic, toast, openSheet, initSegmented, setLoading, skeletonRows, emptyState, animateNumber } from './ui.js'
import { ALERTAS, ESTADO_CARGA, fmtLitros, fmtKm, fmtRend, rendimiento, miniatura } from './diesel.js'

const TZ = 'America/Mexico_City'
const MAX_FILAS = 40

const PERIODOS = {
  dia: { etiqueta: 'Día', adjetivo: 'diario' },
  semana: { etiqueta: 'Semana', adjetivo: 'semanal' },
  mes: { etiqueta: 'Mes', adjetivo: 'mensual' },
  semestre: { etiqueta: 'Semestre', adjetivo: 'semestral' },
  anio: { etiqueta: 'Año', adjetivo: 'anual' }
}

const CONFIG = {
  Estudiante: { titulo: 'Reporte de viajes', periodos: ['semana', 'mes', 'anio'], inicial: 'mes' },
  Chofer: { titulo: 'Mis reportes', periodos: ['dia', 'semana', 'mes'], inicial: 'dia' },
  Admin: { titulo: 'Reportes', periodos: ['dia', 'semana', 'mes', 'anio'], inicial: 'mes' }
}
// El diésel se mide por semana, mes, semestre (enero–junio y julio–diciembre) y año
const PERIODOS_DIESEL = ['semana', 'mes', 'semestre', 'anio']

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
  if (tipo === 'semestre') {
    const anio = ref.slice(0, 4)
    return d.getUTCMonth() < 6
      ? { desde: `${anio}-01-01`, hasta: `${anio}-06-30` }
      : { desde: `${anio}-07-01`, hasta: `${anio}-12-31` }
  }
  return { desde: `${ref.slice(0, 4)}-01-01`, hasta: `${ref.slice(0, 4)}-12-31` }
}

function mover(tipo, ref, dir) {
  if (tipo === 'dia') return sumarDias(ref, dir)
  if (tipo === 'semana') return sumarDias(ref, dir * 7)
  const d = aFecha(ref)
  if (tipo === 'mes') return aYMD(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + dir, 1, 12)))
  if (tipo === 'semestre') return aYMD(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + dir * 6, 1, 12)))
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
  } else if (tipo === 'semestre') {
    const primero = desde.slice(5, 7) === '01'
    titulo = primero ? 'Enero – junio' : 'Julio – diciembre'
    texto = `Semestre ${primero ? 'enero–junio' : 'julio–diciembre'} ${anio}`
    relativo = actual ? `Este semestre · ${anio}` : anio
  } else {
    titulo = anio
    texto = `Año ${anio}`
    relativo = actual ? 'Este año' : 'Año completo'
  }
  return {
    tipo, desde, hasta, titulo, texto, relativo,
    adjetivo: PERIODOS[tipo].adjetivo,
    archivo: tipo === 'dia' ? desde : tipo === 'semana' ? `semana-${desde}` : tipo === 'mes' ? desde.slice(0, 7)
      : tipo === 'semestre' ? `${anio}-S${desde.slice(5, 7) === '01' ? 1 : 2}` : anio
  }
}

export function initReportes({ rpc, abrirCarga }) {
  const sheet = $('#sheet-report')
  const kindSeg = $('#report-kind')
  const choferField = $('#report-chofer-field')
  const choferSelect = $('#report-chofer')
  const periodSeg = $('#report-period')
  const preview = $('#report-preview')
  const btnPdf = $('#btn-report-pdf')
  const btnPrev = $('#report-prev')
  const btnNext = $('#report-next')
  const fotosOpcion = $('#report-fotos-opcion')
  const fotosCheck = $('#report-fotos')

  let estado = null // { rol, perfil, tipo: 'propio'|'gastos'|'chofer'|'diesel', periodo, ref, licencia, datos }
  let peticion = 0
  let choferes = []

  const kind = initSegmented(kindSeg, valor => {
    estado.tipo = valor
    pintarPeriodos()
    pintarControles()
    pintarRango()
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

  const periodosDe = e => (e.rol === 'Admin' && e.tipo === 'diesel' ? PERIODOS_DIESEL : CONFIG[e.rol].periodos)

  // Periodos según el rol y el tipo (los botones se rehacen; el segmentado es nuevo)
  function pintarPeriodos() {
    const lista = periodosDe(estado)
    if (periodSeg.dataset.lista === lista.join() && lista.includes(estado.periodo)) return
    if (!lista.includes(estado.periodo)) {
      estado.periodo = lista.includes('mes') ? 'mes' : lista[0]
      estado.ref = ajustarRef(estado.periodo, estado.ref)
    }
    periodSeg.dataset.lista = lista.join()
    periodSeg.style.setProperty('--n', lista.length)
    periodSeg.innerHTML = '<span class="segmented-thumb"></span>' +
      lista.map(p => `<button type="button" data-value="${p}">${PERIODOS[p].etiqueta}</button>`).join('')
    periodSeg.dataset.value = estado.periodo
    initSegmented(periodSeg, valor => {
      estado.periodo = valor
      estado.ref = ajustarRef(valor, estado.ref)
      pintarRango()
      cargar()
    })
  }

  // rol: 'Estudiante' | 'Chofer' | 'Admin'; tipo (admin): 'gastos' | 'chofer' | 'diesel'
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
    periodSeg.dataset.lista = ''
    pintarPeriodos()

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
    fotosOpcion.hidden = !(estado.rol === 'Admin' && estado.tipo === 'diesel')
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
    else if (estado.tipo === 'diesel') {
      // El periodo anterior del mismo tamaño, para comparar
      const ant = rango(estado.periodo, mover(estado.periodo, estado.ref, -1))
      nombre = 'admin_reporte_diesel'
      params.p_ant_desde = ant.desde
      params.p_ant_hasta = ant.hasta
    } else {
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
        <span class="report-stat-value${it.valor.length > 8 ? ' is-long' : ''}" data-valor="${it.numero ?? ''}" data-decimales="${it.dinero ? 2 : it.decimales || 0}" data-sufijo="${esc(it.sufijo || '')}">${esc(it.valor)}</span>
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
            titulo: m.pago ? 'Pago registrado' : `Viaje · Camión ${camionCorto(m.camion ?? 1)}`,
            sub: `${fmtFechaHora(m.f)}${m.pago && m.nota ? ` · ${m.nota}` : ''}${m.manual ? ' · A mano' : ''}`,
            monto: `${m.pago ? '−' : ''}${fmtDinero(m.monto)}`,
            montoTono: m.pago ? 'is-positive' : ''
          })).join('')}</div>${resto(movs.length - MAX_FILAS)}`
        : emptyState('i-receipt', 'Sin viajes', `No tuviste viajes ni pagos en ${p.texto.toLowerCase().startsWith('semana') ? 'esta semana' : 'este periodo'}.`)
    } else if (estado.tipo === 'diesel') {
      html += vistaDiesel(d, p)
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
        html += `<div class="list">${d.camiones.map(c => fila({ iconId: 'i-bus', titulo: `Camión ${camionCorto(c.camion)}`, sub: plural(c.viajes, 'viaje', 'viajes'), monto: fmtDinero(c.cargado) })).join('')}</div>`
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
            titulo: `Corte · Camión ${camionCorto(c.camion)}`,
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
      const sufijo = el.dataset.sufijo
      if (sufijo) {
        // Litros, km/L…: solo se anima el número
        el.innerHTML = `<span></span> ${esc(sufijo)}`
        animateNumber(el.firstElementChild, n, { decimals: dec, duration: 900 })
      } else if (dec) {
        // animateNumber pinta solo el número; se conserva el signo de pesos
        el.innerHTML = `$<span></span>`
        animateNumber(el.firstElementChild, n, { decimals: 2, duration: 900 })
      } else {
        el.textContent = '0'
        animateNumber(el, n, { duration: 700 })
      }
    })
  }

  function vistaDiesel(d, p) {
    const t = d.totales
    const importe = Number(t.importe)
    const litros = Number(t.litros)
    const rend = rendimiento(t.km_lleno, t.litros_lleno)
    const ant = d.anterior
    const cambio = ant && Number(ant.importe) > 0 ? ((importe - Number(ant.importe)) / Number(ant.importe)) * 100 : null
    let html = stats([
      {
        etiqueta: 'Gasto en diésel', valor: fmtDinero(importe), numero: importe, dinero: true,
        nota: cambio == null ? plural(t.cargas, 'carga', 'cargas') : `${cambio >= 0 ? '+' : '−'}${Math.abs(Math.round(cambio))} % vs. periodo anterior`,
        tono: cambio != null && cambio > 15 ? 'orange' : ''
      },
      { etiqueta: 'Litros', valor: fmtLitros(litros), numero: litros, sufijo: 'L', decimales: 0, nota: plural(t.cargas, 'carga', 'cargas') },
      { etiqueta: 'Rendimiento', valor: fmtRend(rend), numero: rend ?? '', sufijo: rend ? 'km/L' : '', decimales: 2, nota: t.km ? `${fmtKm(t.km)} recorridos` : 'Falta kilometraje' },
      { etiqueta: 'Precio promedio', valor: litros ? fmtDinero(importe / litros) : '—', numero: litros ? importe / litros : '', dinero: true, nota: 'por litro' },
      { etiqueta: 'Por salida', valor: t.salidas ? fmtDinero(importe / t.salidas) : '—', numero: t.salidas ? importe / t.salidas : '', dinero: true, nota: plural(t.salidas, 'salida', 'salidas') },
      { etiqueta: 'Por alumno', valor: t.pasajeros ? fmtDinero(importe / t.pasajeros) : '—', numero: t.pasajeros ? importe / t.pasajeros : '', dinero: true, nota: plural(t.pasajeros, 'viaje de alumno', 'viajes de alumnos') }
    ])

    const avisos = [
      t.con_alertas && plural(t.con_alertas, 'carga con alertas', 'cargas con alertas'),
      t.pendientes && plural(t.pendientes, 'por verificar', 'por verificar'),
      d.anuladas && plural(d.anuladas, 'anulada (no cuenta)', 'anuladas (no cuentan)')
    ].filter(Boolean)
    if (avisos.length) html += `<p class="report-callout${t.con_alertas ? ' is-warning' : ''}">${icon(t.con_alertas ? 'i-alert' : 'i-info')}<span>${esc(avisos.join(' · '))}</span></p>`

    const camiones = d.camiones.filter(c => c.cargas || c.salidas)
    if (camiones.length) {
      html += encabezado('Por camión')
      html += `<div class="list">${camiones.map(c => {
        const r = rendimiento(c.km_lleno, c.litros_lleno)
        return fila({
          iconId: 'i-bus',
          titulo: `Camión ${camionCorto(c.camion)}`,
          sub: [plural(c.cargas, 'carga', 'cargas'), fmtLitros(c.litros), r && fmtRend(r), r && Number(c.litros) > 0 && `${fmtDinero(Number(c.importe) / Number(c.litros) / r)}/km`].filter(Boolean).join(' · '),
          monto: fmtDinero(c.importe)
        })
      }).join('')}</div>`
    }

    if (d.choferes.length > 1 || (d.choferes.length === 1 && d.choferes[0].licencia)) {
      html += encabezado('Por chofer')
      html += `<div class="list">${d.choferes.map(c => fila({
        iconId: 'i-wheel',
        titulo: c.nombre || 'Sin chofer (administración)',
        sub: `${plural(c.cargas, 'carga', 'cargas')} · ${fmtLitros(c.litros)}`,
        monto: fmtDinero(c.importe)
      })).join('')}</div>`
    }

    const cargas = [...d.cargas].reverse()
    html += encabezado('Cargas', cargas.length ? 'Toca una para ver su ticket' : '')
    html += cargas.length
      ? `<div class="list">${cargas.slice(0, MAX_FILAS).map(c => {
          const est = ESTADO_CARGA[c.estado] || ESTADO_CARGA.pendiente
          const alertas = c.alertas || []
          return fila({
            iconId: 'i-fuel',
            tono: alertas.length ? 'tono-orange' : c.estado === 'verificada' ? 'tono-green' : '',
            titulo: `Camión ${camionCorto(c.camion)} · ${fmtLitros(c.litros)}`,
            sub: [fmtFechaHora(c.fecha), c.chofer_nombre, alertas.length ? `⚠ ${ALERTAS[alertas[0]]?.texto || alertas[0]}` : est.label].filter(Boolean).join(' · '),
            monto: fmtDinero(c.importe),
            data: ` data-carga="${c.id}" role="button" tabindex="0"`
          })
        }).join('')}</div>${resto(cargas.length - MAX_FILAS)}`
      : emptyState('i-fuel', 'Sin cargas', `No se registraron cargas de diésel en ${p.tipo === 'semana' ? 'esta semana' : 'este periodo'}.`)
    return html
  }

  // Detalle de un corte o ir al reporte de un chofer desde el informe de gastos
  function activarFila(el) {
    if (!estado?.datos) return
    if (el.dataset.carga) {
      const c = estado.datos.cargas?.find(x => String(x.id) === el.dataset.carga)
      if (c && abrirCarga) {
        haptic(6)
        abrirCarga(c)
      }
      return
    }
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
    const el = e.target.closest('[data-corte], [data-licencia], [data-carga]')
    if (el) activarFila(el)
  })
  preview.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    const el = e.target.closest('[data-corte], [data-licencia], [data-carga]')
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
      let resultado
      if (estado.rol === 'Estudiante') resultado = await pdf.pdfAlumno(datos, p)
      else if (estado.tipo === 'gastos') resultado = await pdf.pdfGastos(datos, p, { admin: estado.perfil?.usuario })
      else if (estado.tipo === 'diesel') {
        const fotos = fotosCheck.checked ? await cargarFotos(datos.cargas) : null
        if (!estado) return
        resultado = await pdf.pdfDiesel(datos, p, { admin: estado.perfil?.usuario, fotos })
      } else resultado = await pdf.pdfChofer(datos, p)
      if (resultado !== 'cancelado') {
        haptic([10, 40, 14])
        toast(resultado === 'compartido' ? 'Reporte listo' : 'Reporte descargado', { type: 'success' })
      }
    } catch (err) {
      console.error('Error al generar el PDF:', err)
      toast('No se pudo generar el PDF. Revisa tu conexión e intenta de nuevo.', { type: 'error', duration: 4000 })
    } finally {
      setLoading(btnPdf, false)
    }
  })

  // Tickets para el anexo del PDF: de 30 en 30 y reducidos
  async function cargarFotos(cargas) {
    const ids = cargas.filter(c => c.tiene_foto).map(c => c.id)
    const fotos = new Map()
    if (!ids.length) return fotos
    if (ids.length > 6) toast(`Preparando ${ids.length} tickets…`, { duration: 2400 })
    for (let i = 0; i < ids.length; i += 30) {
      const { data, error } = await rpc('admin_diesel_tickets', { p_ids: ids.slice(i, i + 30) })
      if (error) throw error
      for (const t of data) {
        try {
          fotos.set(t.id, await miniatura(t.foto))
        } catch (err) {
          console.warn('Ticket sin poder leer:', t.id, err)
        }
      }
    }
    return fotos
  }

  return {
    abrir,
    // Otro dispositivo cambió el diésel: si el informe está abierto, se recarga
    refrescarDiesel() {
      if (estado?.tipo === 'diesel' && !btnPdf.classList.contains('is-loading')) cargar()
    }
  }
}
