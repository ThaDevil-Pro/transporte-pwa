// =====================================================================
// Reportes en PDF, armados en el teléfono con jsPDF (se carga solo al
// descargar el primer reporte). Mismo lenguaje visual que la app:
// blanco, tipografía grande, tarjetas grises redondeadas y líneas finas.
// =====================================================================
const TZ = 'America/Mexico_City'

const C = {
  tinta: [29, 29, 31],
  gris: [110, 110, 115],
  gris2: [174, 174, 178],
  fondo: [245, 245, 247],
  linea: [229, 229, 234],
  azul: [0, 113, 227],
  verde: [36, 138, 61],
  naranja: [201, 52, 0]
}

const M = 48 // margen
const PIE = 54 // alto reservado para el pie de página

const dinero = new Intl.NumberFormat('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
export const fmtDinero = n => `$${dinero.format(Number(n) || 0)}`

// Helvetica de jsPDF solo trae Latin-1: espacios finos y signos raros se cambian
function limpio(texto) {
  return String(texto ?? '')
    .normalize('NFC')
    .replace(/[    ]/g, ' ')
    .replace(/[−–—]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    .replace(/[^\u0000-ÿ]/g, '?')
}

const fecha = (iso, opts) => new Date(iso).toLocaleDateString('es-MX', { timeZone: TZ, ...opts })
const hora = iso => new Date(iso).toLocaleTimeString('es-MX', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true })
// Fechas sin hora ("2026-10-13"): se leen al mediodía UTC para no cambiar de día
const dia = (ymd, opts) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString('es-MX', { timeZone: 'UTC', ...opts })
const diaLocal = iso => new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ })
const mayus = s => s.charAt(0).toUpperCase() + s.slice(1)

// --- Carga perezosa de jsPDF y del logotipo ---
let libs = null
let logo = null

async function cargarLibs() {
  if (!libs) {
    libs = Promise.all([import('jspdf'), import('jspdf-autotable')])
      .then(([pdf, tabla]) => ({ jsPDF: pdf.jsPDF, autoTable: tabla.autoTable || tabla.default }))
      .catch(err => { libs = null; throw err })
  }
  return libs
}

// El logotipo es blanco sobre transparente: se pinta en tinta oscura
async function cargarLogo() {
  if (logo !== null) return logo
  try {
    const img = new Image()
    img.src = '/brand/camify-wordmark.png'
    await img.decode()
    // A 600 px de ancho basta para imprimir nítido a 17 pt de alto
    const w = 600
    const h = Math.round((w * img.naturalHeight) / img.naturalWidth)
    const forma = document.createElement('canvas')
    forma.width = w
    forma.height = h
    const fctx = forma.getContext('2d')
    fctx.drawImage(img, 0, 0, w, h)
    fctx.globalCompositeOperation = 'source-in'
    fctx.fillStyle = 'rgb(29, 29, 31)'
    fctx.fillRect(0, 0, w, h)
    // Sobre blanco y en JPEG: pesa unos KB en lugar de un mega
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(forma, 0, 0)
    logo = { data: canvas.toDataURL('image/jpeg', 0.92), proporcion: w / h }
  } catch {
    logo = false
  }
  return logo
}

// --- Documento base ---
async function nuevoDocumento({ eyebrow, titulo, subtitulo }) {
  const [{ jsPDF, autoTable }, marca] = await Promise.all([cargarLibs(), cargarLogo()])
  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  const ancho = doc.internal.pageSize.getWidth()
  const alto = doc.internal.pageSize.getHeight()
  const ctx = { doc, autoTable, ancho, alto, util: ancho - M * 2, y: M }

  doc.setProperties({ title: limpio(`${eyebrow} · ${titulo}`), creator: 'CAMIFY', author: 'CAMIFY' })

  // Encabezado: logotipo y fecha de generación
  if (marca) {
    doc.addImage(marca.data, 'JPEG', M, M, 17 * marca.proporcion, 17)
  } else {
    texto(ctx, 'CAMIFY', M, M + 14, { size: 16, bold: true })
  }
  const generado = `Generado el ${fecha(new Date(), { day: 'numeric', month: 'short', year: 'numeric' })}, ${hora(new Date())}`
  texto(ctx, generado, ancho - M, M + 12, { size: 8.5, color: C.gris, align: 'right' })

  ctx.y = M + 62
  texto(ctx, eyebrow.toUpperCase(), M, ctx.y, { size: 9, bold: true, color: C.azul, spacing: 0.6 })
  ctx.y += 30
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(26)
  const lineas = doc.splitTextToSize(limpio(titulo), ctx.util)
  lineas.slice(0, 2).forEach((l, i) => texto(ctx, l, M, ctx.y + i * 30, { size: 26, bold: true }))
  ctx.y += (Math.min(lineas.length, 2) - 1) * 30 + 22
  texto(ctx, subtitulo, M, ctx.y, { size: 11, color: C.gris })
  ctx.y += 30
  return ctx
}

function texto(ctx, t, x, y, { size = 10, bold = false, color = C.tinta, align = 'left', spacing = 0 } = {}) {
  const { doc } = ctx
  doc.setFont('helvetica', bold ? 'bold' : 'normal')
  doc.setFontSize(size)
  doc.setTextColor(...color)
  doc.text(limpio(t), x, y, { align, charSpace: spacing })
}

function asegurar(ctx, alto) {
  if (ctx.y + alto > ctx.alto - PIE - 8) {
    ctx.doc.addPage()
    ctx.y = M
  }
}

// Tarjetas de resumen: [{ etiqueta, valor, nota?, color? }]
function tarjetas(ctx, items) {
  const { doc } = ctx
  const gap = 10
  const porFila = Math.min(items.length, 4)
  const w = (ctx.util - gap * (porFila - 1)) / porFila
  const h = 66
  for (let i = 0; i < items.length; i += porFila) {
    asegurar(ctx, h + gap)
    items.slice(i, i + porFila).forEach((it, j) => {
      const x = M + j * (w + gap)
      doc.setFillColor(...C.fondo)
      doc.roundedRect(x, ctx.y, w, h, 12, 12, 'F')
      texto(ctx, it.etiqueta, x + 14, ctx.y + 20, { size: 8.5, bold: true, color: C.gris })
      let size = 19
      doc.setFont('helvetica', 'bold')
      while (size > 11 && doc.setFontSize(size).getTextWidth(limpio(it.valor)) > w - 28) size -= 1
      texto(ctx, it.valor, x + 14, ctx.y + 43, { size, bold: true, color: it.color || C.tinta })
      if (it.nota) texto(ctx, it.nota, x + 14, ctx.y + 57, { size: 8, color: C.gris })
    })
    ctx.y += h + gap
  }
  ctx.y += 14
}

function seccion(ctx, titulo, nota) {
  asegurar(ctx, 70)
  texto(ctx, titulo, M, ctx.y + 4, { size: 14, bold: true })
  if (nota) texto(ctx, nota, ctx.ancho - M, ctx.y + 4, { size: 9, color: C.gris, align: 'right' })
  ctx.y += 14
}

function parrafo(ctx, t, { color = C.gris, size = 10 } = {}) {
  const { doc } = ctx
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(size)
  const lineas = doc.splitTextToSize(limpio(t), ctx.util)
  asegurar(ctx, lineas.length * (size + 4) + 10)
  lineas.forEach((l, i) => texto(ctx, l, M, ctx.y + 10 + i * (size + 4), { size, color }))
  ctx.y += lineas.length * (size + 4) + 18
}

// Tabla con líneas finas. columnas: [{ titulo, alinear?, ancho? }]
function tabla(ctx, columnas, filas, { pie = null } = {}) {
  const limpiar = fila => fila.map(c => limpio(c))
  const columnStyles = {}
  columnas.forEach((c, i) => {
    columnStyles[i] = { halign: c.alinear || 'left', ...(c.ancho ? { cellWidth: c.ancho } : {}) }
  })
  ctx.autoTable(ctx.doc, {
    startY: ctx.y,
    margin: { left: M, right: M, top: M, bottom: PIE + 8 },
    head: [columnas.map(c => limpio(c.titulo))],
    body: filas.map(limpiar),
    foot: pie ? [limpiar(pie)] : undefined,
    showFoot: 'lastPage',
    theme: 'plain',
    columnStyles,
    styles: {
      font: 'helvetica',
      fontSize: 9,
      textColor: C.tinta,
      cellPadding: { top: 6.5, bottom: 6.5, left: 5, right: 5 },
      lineColor: C.linea,
      lineWidth: { bottom: 0.5 },
      overflow: 'linebreak',
      valign: 'middle'
    },
    headStyles: { fontSize: 8, fontStyle: 'bold', textColor: C.gris, lineWidth: { bottom: 0.8 }, lineColor: C.gris2 },
    footStyles: { fontStyle: 'bold', fontSize: 9.5, textColor: C.tinta, lineWidth: 0 },
    didParseCell: d => {
      // Los títulos siguen la alineación de su columna
      if (d.section === 'head' || d.section === 'foot') d.cell.styles.halign = columnas[d.column.index]?.alinear || 'left'
    }
  })
  ctx.y = ctx.doc.lastAutoTable.finalY + 28
}

// Barras dobles (cobrado y pagado) por día o por mes
function grafica(ctx, puntos, { serieA, serieB }) {
  const { doc } = ctx
  const h = 130
  asegurar(ctx, h + 60)
  const x0 = M + 34
  const w = ctx.util - 34
  const y0 = ctx.y + 8
  const max = Math.max(1, ...puntos.flatMap(p => [p.a, p.b]))
  const tope = escalaBonita(max)

  // Líneas guía
  doc.setLineWidth(0.5)
  for (let i = 0; i <= 2; i++) {
    const y = y0 + h - (h * i) / 2
    doc.setDrawColor(...C.linea)
    doc.line(x0, y, x0 + w, y)
    texto(ctx, `$${dinero.format((tope * i) / 2).replace(/\.00$/, '')}`, x0 - 6, y + 3, { size: 7.5, color: C.gris, align: 'right' })
  }

  const paso = w / puntos.length
  const barra = Math.min(12, (paso * 0.7) / 2)
  const cadaCuanto = Math.ceil(puntos.length / 16)
  puntos.forEach((p, i) => {
    const cx = x0 + paso * i + paso / 2
    const ha = (p.a / tope) * h
    const hb = (p.b / tope) * h
    if (ha > 0) {
      doc.setFillColor(...C.tinta)
      doc.roundedRect(cx - barra - 1, y0 + h - ha, barra, ha, Math.min(2.5, barra / 2), Math.min(2.5, barra / 2), 'F')
    }
    if (hb > 0) {
      doc.setFillColor(...C.verde)
      doc.roundedRect(cx + 1, y0 + h - hb, barra, hb, Math.min(2.5, barra / 2), Math.min(2.5, barra / 2), 'F')
    }
    if (i % cadaCuanto === 0) texto(ctx, p.etiqueta, cx, y0 + h + 13, { size: 7.5, color: C.gris, align: 'center' })
  })

  // Leyenda
  const ly = y0 + h + 32
  doc.setFillColor(...C.tinta)
  doc.roundedRect(x0, ly - 7, 8, 8, 2, 2, 'F')
  texto(ctx, serieA, x0 + 13, ly, { size: 8.5, color: C.gris })
  doc.setFillColor(...C.verde)
  doc.roundedRect(x0 + 110, ly - 7, 8, 8, 2, 2, 'F')
  texto(ctx, serieB, x0 + 123, ly, { size: 8.5, color: C.gris })
  ctx.y = ly + 26
}

function escalaBonita(max) {
  const base = 10 ** Math.floor(Math.log10(max))
  for (const m of [1, 2, 2.5, 5, 10]) if (base * m >= max) return base * m
  return base * 10
}

// Pie en todas las páginas y descarga
function terminar(ctx, nombreArchivo) {
  const { doc } = ctx
  const total = doc.getNumberOfPages()
  for (let i = 1; i <= total; i++) {
    doc.setPage(i)
    const y = ctx.alto - PIE + 18
    doc.setDrawColor(...C.linea)
    doc.setLineWidth(0.5)
    doc.line(M, y - 12, ctx.ancho - M, y - 12)
    texto(ctx, 'CAMIFY · Transporte escolar', M, y, { size: 8, color: C.gris })
    texto(ctx, `Página ${i} de ${total}`, ctx.ancho - M, y, { size: 8, color: C.gris, align: 'right' })
  }
  doc.save(nombreArchivo)
}

const registro = manual => (manual ? 'A mano' : 'Código QR')

// =====================================================================
// Reporte del alumno
// =====================================================================
export async function pdfAlumno(datos, periodo) {
  const { alumno, viajes, pagos } = datos
  const cobrado = viajes.reduce((s, v) => s + Number(v.monto), 0)
  const pagado = pagos.reduce((s, p) => s + Number(p.monto), 0)

  const ctx = await nuevoDocumento({
    eyebrow: 'Reporte de viajes',
    titulo: alumno.nombre,
    subtitulo: `Matrícula ${alumno.matricula} · ${periodo.texto}`
  })

  tarjetas(ctx, [
    { etiqueta: 'Viajes', valor: String(viajes.length) },
    { etiqueta: 'Cobrado', valor: fmtDinero(cobrado) },
    { etiqueta: 'Pagado', valor: fmtDinero(pagado), color: pagado ? C.verde : C.tinta },
    { etiqueta: 'Saldo pendiente', valor: fmtDinero(alumno.saldo), nota: 'Al día de hoy', color: Number(alumno.saldo) > 0 ? C.naranja : C.tinta }
  ])

  seccion(ctx, 'Viajes', viajes.length ? `${viajes.length} en el periodo` : '')
  if (viajes.length) {
    tabla(ctx,
      [{ titulo: '#', ancho: 26 }, { titulo: 'Fecha' }, { titulo: 'Hora' }, { titulo: 'Camión', alinear: 'center' }, { titulo: 'Registro' }, { titulo: 'Monto', alinear: 'right' }],
      viajes.map((v, i) => [i + 1, mayus(fecha(v.fecha_hora, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })), hora(v.fecha_hora), v.camion ?? 1, registro(v.manual), fmtDinero(v.monto)]),
      { pie: ['', 'Total', '', '', '', fmtDinero(cobrado)] }
    )
  } else {
    parrafo(ctx, 'No tuviste viajes cobrados en este periodo.')
  }

  if (pagos.length) {
    seccion(ctx, 'Pagos', `${pagos.length} en el periodo`)
    tabla(ctx,
      [{ titulo: 'Fecha' }, { titulo: 'Hora' }, { titulo: 'Nota' }, { titulo: 'Monto', alinear: 'right' }],
      pagos.map(p => [mayus(fecha(p.creado_en, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })), hora(p.creado_en), p.nota || '-', fmtDinero(p.monto)]),
      { pie: ['Total', '', '', fmtDinero(pagado)] }
    )
  }

  parrafo(ctx, 'Cada viaje se cobra al hacer el corte de la salida. "A mano" significa que el chofer te registró sin tu código QR.', { size: 8.5 })
  terminar(ctx, `camify-viajes-${alumno.matricula}-${periodo.archivo}.pdf`)
}

// =====================================================================
// Reporte del chofer (diario, semanal o mensual)
// =====================================================================
export function resumenChofer(cortes) {
  return {
    cortes: cortes.length,
    pasajeros: cortes.reduce((s, c) => s + c.alumnos, 0),
    manuales: cortes.reduce((s, c) => s + c.manuales, 0),
    total: cortes.reduce((s, c) => s + Number(c.total), 0)
  }
}

export async function pdfChofer(datos, periodo) {
  const { chofer, cortes } = datos
  const r = resumenChofer(cortes)
  const ctx = await nuevoDocumento({
    eyebrow: `Reporte ${periodo.adjetivo} del chofer`,
    titulo: chofer.nombre || chofer.licencia,
    subtitulo: `Licencia ${chofer.licencia} · ${periodo.texto}`
  })

  tarjetas(ctx, [
    { etiqueta: 'Cortes', valor: String(r.cortes) },
    { etiqueta: 'Pasajeros', valor: String(r.pasajeros) },
    { etiqueta: 'Total cobrado', valor: fmtDinero(r.total) },
    { etiqueta: 'Registros a mano', valor: String(r.manuales), nota: r.pasajeros ? `${Math.round((r.manuales / r.pasajeros) * 100)}% del total` : '' }
  ])

  if (!cortes.length) {
    parrafo(ctx, 'No hay cortes en este periodo.')
    terminar(ctx, `camify-chofer-${chofer.licencia}-${periodo.archivo}.pdf`)
    return
  }

  // Por día (semana o mes)
  if (periodo.tipo !== 'dia') {
    const porDia = new Map()
    cortes.forEach(c => {
      const k = diaLocal(c.creado_en)
      const d = porDia.get(k) || { cortes: 0, pasajeros: 0, total: 0 }
      d.cortes++
      d.pasajeros += c.alumnos
      d.total += Number(c.total)
      porDia.set(k, d)
    })
    seccion(ctx, 'Por día')
    tabla(ctx,
      [{ titulo: 'Día' }, { titulo: 'Cortes', alinear: 'center' }, { titulo: 'Pasajeros', alinear: 'center' }, { titulo: 'Total', alinear: 'right' }],
      [...porDia].map(([k, d]) => [mayus(dia(k, { weekday: 'long', day: 'numeric', month: 'short' })), d.cortes, d.pasajeros, fmtDinero(d.total)]),
      { pie: ['Total', r.cortes, r.pasajeros, fmtDinero(r.total)] }
    )
  }

  seccion(ctx, 'Cortes', `${cortes.length} en el periodo`)
  tabla(ctx,
    [{ titulo: '#', ancho: 26 }, { titulo: 'Fecha' }, { titulo: 'Hora' }, { titulo: 'Camión', alinear: 'center' }, { titulo: 'Pasajeros', alinear: 'center' }, { titulo: 'A mano', alinear: 'center' }, { titulo: 'Total', alinear: 'right' }],
    cortes.map((c, i) => [i + 1, mayus(fecha(c.creado_en, { weekday: 'short', day: 'numeric', month: 'short' })), hora(c.creado_en), c.camion, c.alumnos, c.manuales, fmtDinero(c.total)]),
    { pie: ['', 'Total', '', '', r.pasajeros, r.manuales, fmtDinero(r.total)] }
  )

  // Lista de pasajeros de cada corte (día y semana; en el mes sería demasiado largo)
  if (periodo.tipo !== 'mes') {
    seccion(ctx, 'Pasajeros por corte')
    ctx.y += 6
    cortes.forEach((c, i) => {
      // Las listas cortas no se parten entre dos páginas
      asegurar(ctx, Math.min(64 + c.pasajeros.length * 25, 420))
      texto(ctx, `Corte ${i + 1} · Camión ${c.camion}`, M, ctx.y + 4, { size: 11, bold: true })
      texto(ctx, `${mayus(fecha(c.creado_en, { weekday: 'long', day: 'numeric', month: 'long' }))}, ${hora(c.creado_en)} · ${fmtDinero(c.total)}`,
        ctx.ancho - M, ctx.y + 4, { size: 9, color: C.gris, align: 'right' })
      ctx.y += 12
      if (c.pasajeros.length) {
        tabla(ctx,
          [{ titulo: '#', ancho: 26 }, { titulo: 'Nombre' }, { titulo: 'Matrícula' }, { titulo: 'Registro', alinear: 'right' }],
          c.pasajeros.map((p, j) => [j + 1, p.nombre, p.matricula, registro(p.manual)])
        )
      } else {
        parrafo(ctx, 'Sin detalle de pasajeros para este corte.')
      }
    })
  }

  terminar(ctx, `camify-chofer-${chofer.licencia}-${periodo.archivo}.pdf`)
}

// =====================================================================
// Informe de gastos (administración)
// =====================================================================
export function resumenGastos(datos) {
  const viajes = datos.alumnos.reduce((s, a) => s + Number(a.viajes), 0)
  const cobrado = datos.alumnos.reduce((s, a) => s + Number(a.cargado), 0)
  const pagado = datos.pagos.reduce((s, p) => s + Number(p.monto), 0)
  return { viajes, cobrado, pagado }
}

export async function pdfGastos(datos, periodo, { admin } = {}) {
  const r = resumenGastos(datos)
  const ctx = await nuevoDocumento({
    eyebrow: 'Informe de gastos',
    titulo: mayus(periodo.titulo),
    subtitulo: `${periodo.texto}${admin ? ` · Generado por ${admin}` : ''}`
  })

  tarjetas(ctx, [
    { etiqueta: 'Cobrado en viajes', valor: fmtDinero(r.cobrado), nota: `${r.viajes} ${r.viajes === 1 ? 'viaje' : 'viajes'}` },
    { etiqueta: 'Pagos recibidos', valor: fmtDinero(r.pagado), nota: `${datos.pagos.length} ${datos.pagos.length === 1 ? 'pago' : 'pagos'}`, color: r.pagado ? C.verde : C.tinta },
    { etiqueta: 'Adeudo total hoy', valor: fmtDinero(datos.adeudo_total), color: Number(datos.adeudo_total) > 0 ? C.naranja : C.tinta },
    { etiqueta: 'Alumnos con adeudo', valor: String(datos.alumnos_con_adeudo), nota: 'Al día de hoy' }
  ])

  // Gráfica: por día, o por mes si el periodo es largo
  if (periodo.tipo !== 'dia' && datos.dias.length) {
    const puntos = periodo.tipo === 'anio' ? porMes(datos.dias, periodo) : porDia(datos.dias, periodo)
    seccion(ctx, periodo.tipo === 'anio' ? 'Cobrado y pagado por mes' : 'Cobrado y pagado por día')
    grafica(ctx, puntos, { serieA: 'Cobrado en viajes', serieB: 'Pagos recibidos' })
  }

  if (datos.choferes.length) {
    seccion(ctx, 'Por chofer')
    const t = datos.choferes.reduce((s, c) => ({ cortes: s.cortes + c.cortes, alumnos: s.alumnos + c.alumnos, total: s.total + Number(c.total) }), { cortes: 0, alumnos: 0, total: 0 })
    tabla(ctx,
      [{ titulo: 'Chofer' }, { titulo: 'Licencia' }, { titulo: 'Cortes', alinear: 'center' }, { titulo: 'Pasajeros', alinear: 'center' }, { titulo: 'Total', alinear: 'right' }],
      datos.choferes.map(c => [c.nombre, c.licencia, c.cortes, c.alumnos, fmtDinero(c.total)]),
      { pie: ['Total', '', t.cortes, t.alumnos, fmtDinero(t.total)] }
    )
  }

  if (datos.camiones.length) {
    seccion(ctx, 'Por camión')
    tabla(ctx,
      [{ titulo: 'Camión' }, { titulo: 'Viajes', alinear: 'center' }, { titulo: 'Cobrado', alinear: 'right' }],
      datos.camiones.map(c => [`Camión ${c.camion}`, c.viajes, fmtDinero(c.cargado)]),
      { pie: ['Total', r.viajes, fmtDinero(r.cobrado)] }
    )
  }

  seccion(ctx, 'Por alumno', datos.alumnos.length ? `${datos.alumnos.length} con movimientos o adeudo` : '')
  if (datos.alumnos.length) {
    const saldoTotal = datos.alumnos.reduce((s, a) => s + Number(a.saldo), 0)
    tabla(ctx,
      [{ titulo: 'Nombre' }, { titulo: 'Matrícula' }, { titulo: 'Viajes', alinear: 'center' }, { titulo: 'Cobrado', alinear: 'right' }, { titulo: 'Pagado', alinear: 'right' }, { titulo: 'Saldo hoy', alinear: 'right' }],
      datos.alumnos.map(a => [a.nombre, a.matricula, a.viajes, fmtDinero(a.cargado), fmtDinero(a.pagado), fmtDinero(a.saldo)]),
      { pie: ['Total', '', r.viajes, fmtDinero(r.cobrado), fmtDinero(r.pagado), fmtDinero(saldoTotal)] }
    )
  } else {
    parrafo(ctx, 'Sin movimientos en este periodo.')
  }

  if (datos.pagos.length) {
    seccion(ctx, 'Pagos recibidos')
    tabla(ctx,
      [{ titulo: 'Fecha' }, { titulo: 'Alumno' }, { titulo: 'Nota' }, { titulo: 'Registró' }, { titulo: 'Monto', alinear: 'right' }],
      datos.pagos.map(p => [`${fecha(p.creado_en, { day: 'numeric', month: 'short' })}, ${hora(p.creado_en)}`, p.nombre, p.nota || '-', p.registrado_por, fmtDinero(p.monto)]),
      { pie: ['Total', '', '', '', fmtDinero(r.pagado)] }
    )
  }

  parrafo(ctx, 'Cobrado: viajes cargados al saldo de los alumnos en los cortes del periodo. Pagos: abonos registrados por la administración. El adeudo y el saldo son los de hoy, no los del cierre del periodo.', { size: 8.5 })
  terminar(ctx, `camify-gastos-${periodo.archivo}.pdf`)
}

function porDia(dias, periodo) {
  const mapa = new Map(dias.map(d => [d.fecha, d]))
  const puntos = []
  for (let d = new Date(`${periodo.desde}T12:00:00Z`); d.toISOString().slice(0, 10) <= periodo.hasta; d.setUTCDate(d.getUTCDate() + 1)) {
    const k = d.toISOString().slice(0, 10)
    const v = mapa.get(k)
    puntos.push({ etiqueta: periodo.tipo === 'semana' ? mayus(dia(k, { weekday: 'short' })) : String(d.getUTCDate()), a: Number(v?.cargado || 0), b: Number(v?.pagado || 0) })
  }
  return puntos
}

function porMes(dias, periodo) {
  const anio = periodo.desde.slice(0, 4)
  return Array.from({ length: 12 }, (_, m) => {
    const prefijo = `${anio}-${String(m + 1).padStart(2, '0')}`
    const del = dias.filter(d => d.fecha.startsWith(prefijo))
    return {
      etiqueta: mayus(dia(`${prefijo}-15`, { month: 'short' }).replace('.', '')),
      a: del.reduce((s, d) => s + Number(d.cargado), 0),
      b: del.reduce((s, d) => s + Number(d.pagado), 0)
    }
  })
}
