// =====================================================================
// Control de diésel.
// · Chofer: registra cada carga en la gasolinera con la foto del ticket,
//   los litros, el total y el kilometraje, y ve si ya se verificó.
// · Administración: revisa cada carga junto a su ticket, la verifica, la
//   observa, la corrige o la anula, registra tickets que falten y define
//   la capacidad del tanque de cada camión.
// El rendimiento (km/L) y las alertas se calculan en Supabase.
// =====================================================================
import {
  $, $$, esc, icon, avatar, haptic, toast, openSheet, closeSheet, setLoading, shake, patchList,
  emptyState, skeletonRows, initSegmented, collapse, confirm, animateNumber, opciones, contador
} from './ui.js'
import { camionCorto, listaCamiones, selectorCamion } from './camiones.js'

const TZ = 'America/Mexico_City'
const PRECIO_MIN = 12
const PRECIO_MAX = 60
const DIA = 86400000

export const ESTADO_CARGA = {
  pendiente: { label: 'Por verificar', tono: 'blue' },
  verificada: { label: 'Verificada', tono: 'green' },
  observada: { label: 'Con observación', corto: 'Observada', tono: 'orange' },
  anulada: { label: 'Anulada', tono: 'gray' }
}

// Por qué una carga se ve rara (las calcula la vista privado.diesel_calculo)
export const ALERTAS = {
  sin_ticket: { texto: 'Sin foto del ticket', detalle: 'Se registró sin comprobante.' },
  sobre_tanque: { texto: 'Más litros de los que caben', detalle: 'Cargó más que la capacidad del tanque del camión.' },
  odometro: { texto: 'Kilometraje menor al anterior', detalle: 'El tablero marca menos que en la carga anterior: puede ser un error al escribirlo.' },
  carga_faltante: { texto: 'Puede faltar una carga', detalle: 'Desde la carga anterior recorrió más de lo que alcanza un tanque.' },
  rendimiento_bajo: { texto: 'Rindió mucho menos de lo normal', detalle: 'Puede ser un ticket inflado, una fuga o diésel que no llegó al camión.' },
  rendimiento_alto: { texto: 'Rindió mucho más de lo normal', detalle: 'Puede faltar registrar una carga anterior.' },
  precio: { texto: 'Precio por litro fuera de lo normal', detalle: 'Es más de 8 % distinto al de las otras cargas de esas semanas.' },
  seguidas: { texto: 'Dos cargas muy seguidas', detalle: 'Hubo otra carga menos de 12 horas antes, casi sin recorrer kilómetros.' }
}

// --- Formatos ---
const nf = (min, max) => new Intl.NumberFormat('es-MX', { minimumFractionDigits: min, maximumFractionDigits: max })
const fLitros = nf(0, 2)
const fKm = nf(0, 0)
const fDos = nf(2, 2)
export const fmtLitros = n => `${fLitros.format(Number(n) || 0)} L`
export const fmtKm = n => `${fKm.format(Number(n) || 0)} km`
export const fmtPesos = n => `$${fDos.format(Number(n) || 0)}`
export const fmtRend = n => (n == null || !Number.isFinite(Number(n)) ? '—' : `${fDos.format(Number(n))} km/L`)
// Rendimiento de un periodo: km entre llenados completos / litros de esos tramos
export const rendimiento = (km, litros) => (Number(litros) > 0 && Number(km) > 0 ? Number(km) / Number(litros) : null)

const mayus = s => s.charAt(0).toUpperCase() + s.slice(1)
const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`
const chip = (texto, tono) => `<span class="state-chip tono-${tono}">${esc(texto)}</span>`

export const fmtCuando = iso => {
  const d = new Date(iso)
  return `${mayus(d.toLocaleDateString('es-MX', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' }))}, ${d.toLocaleTimeString('es-MX', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true })}`
}

const relativo = new Intl.RelativeTimeFormat('es', { numeric: 'auto' })
function hace(iso) {
  const seg = Math.round((new Date(iso) - Date.now()) / 1000)
  const abs = Math.abs(seg)
  if (abs < 3600) return 'hace un momento'
  if (abs < DIA / 1000) return relativo.format(Math.round(seg / 3600), 'hour')
  return relativo.format(Math.round(seg / (DIA / 1000)), 'day')
}

// Fecha para <input type="datetime-local"> en la hora del teléfono
function aLocal(d) {
  const x = new Date(d)
  x.setMinutes(x.getMinutes() - x.getTimezoneOffset())
  return x.toISOString().slice(0, 16)
}

// --- Fotos ---
// Se reducen en el teléfono: un ticket queda en 100-400 KB y se sigue leyendo
function reducir(img, { lado, calidad, maxBytes }) {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  let escala = Math.min(1, lado / Math.max(img.naturalWidth, img.naturalHeight))
  let q = calidad
  for (let intento = 0; ; intento++) {
    canvas.width = Math.max(1, Math.round(img.naturalWidth * escala))
    canvas.height = Math.max(1, Math.round(img.naturalHeight * escala))
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    const data = canvas.toDataURL('image/jpeg', q)
    const bytes = Math.round(((data.length - data.indexOf(',') - 1) * 3) / 4)
    if (bytes <= maxBytes || intento >= 4) return { data, ancho: canvas.width, alto: canvas.height, bytes }
    escala *= 0.82
    q = Math.max(0.5, q - 0.06)
  }
}

export async function comprimirFoto(archivo) {
  const url = URL.createObjectURL(archivo)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    return reducir(img, { lado: 1600, calidad: 0.72, maxBytes: 420 * 1024 })
  } finally {
    URL.revokeObjectURL(url)
  }
}

// Versión ligera para el anexo del PDF
export async function miniatura(base64) {
  const img = new Image()
  img.src = `data:image/jpeg;base64,${base64}`
  await img.decode()
  return reducir(img, { lado: 1000, calidad: 0.66, maxBytes: 150 * 1024 })
}

export function initDiesel({ rpc, supabase, camion, alCambiar }) {
  let rol = null
  let contexto = [] // última carga de cada camión: { camion, odometro, fecha, tanque }
  let cargas = []
  let tanques = []
  let foto = null
  let modo = 'chofer'
  let revisando = null
  let refresco = null
  const tickets = new Map() // id → data URL de los tickets ya vistos

  // ===================================================================
  // FORMULARIO DE CARGA (chofer y administración)
  // ===================================================================
  const form = $('#form-diesel')
  const inputFoto = $('#diesel-foto')
  const fotoBox = $('#diesel-foto-box')
  const litros = $('#diesel-litros')
  const importe = $('#diesel-importe')
  const odometro = $('#diesel-odometro')
  const lleno = $('#diesel-lleno')
  const fecha = $('#diesel-fecha')
  const gasolinera = $('#diesel-gasolinera')
  const folio = $('#diesel-folio')
  const pistaPrecio = $('#diesel-precio')
  const pistaOdo = $('#diesel-odo-hint')
  const choferSelect = $('#diesel-chofer')
  const camionSeg = selectorCamion($('#diesel-camion'), { alElegir: () => pintarPistas() })

  const ultimaDe = bus => contexto.find(c => c.camion === bus)

  $('#btn-diesel-foto').addEventListener('click', () => inputFoto.click())
  $('#btn-diesel-foto-cambiar').addEventListener('click', () => inputFoto.click())
  inputFoto.addEventListener('change', async () => {
    const archivo = inputFoto.files?.[0]
    inputFoto.value = ''
    if (!archivo) return
    if (archivo.type && !archivo.type.startsWith('image/')) {
      toast('Elige una foto del ticket', { type: 'warning' })
      return
    }
    fotoBox.classList.add('is-loading')
    try {
      foto = await comprimirFoto(archivo)
      haptic(8)
    } catch (err) {
      console.error('No se pudo leer la foto:', err)
      toast('No se pudo leer la foto. Intenta tomarla de nuevo.', { type: 'error' })
    } finally {
      fotoBox.classList.remove('is-loading')
      pintarFoto()
    }
  })

  function pintarFoto() {
    fotoBox.classList.toggle('has-foto', !!foto)
    fotoBox.classList.remove('is-invalid')
    const img = $('img', fotoBox)
    if (foto) img.src = foto.data
    else img.removeAttribute('src')
  }

  function pintarPistas() {
    const bus = Number(camionSeg.value)
    const u = ultimaDe(bus)
    const l = litros.valueAsNumber
    const i = importe.valueAsNumber
    const o = odometro.valueAsNumber

    // Precio por litro y capacidad del tanque
    const lineas = []
    if (l > 0 && i > 0) {
      const p = i / l
      lineas.push(p < PRECIO_MIN || p > PRECIO_MAX
        ? `<span class="is-warning">${icon('i-alert')}Revisa: saldría a <b>${fmtPesos(p)}</b> por litro</span>`
        : `<span>${icon('i-fuel')}<b>${fmtPesos(p)}</b> por litro</span>`)
    }
    if (l > 0 && u?.tanque && l > u.tanque * 1.03) {
      lineas.push(`<span class="is-warning">${icon('i-alert')}El tanque del camión ${camionCorto(bus)} es de ${fmtLitros(u.tanque)}</span>`)
    }
    pistaPrecio.innerHTML = lineas.join('')
    pistaPrecio.hidden = !lineas.length

    // Kilometraje contra la última carga del camión
    let html
    let aviso = false
    if (u?.odometro == null) html = `Es la primera carga registrada del camión ${camionCorto(bus)}.`
    else if (!(o >= 0)) html = `Última carga del camión ${camionCorto(bus)}: <b>${fmtKm(u.odometro)}</b>, ${hace(u.fecha)}.`
    else if (o < u.odometro) {
      aviso = true
      html = `Es menos que la última carga (${fmtKm(u.odometro)}). Revisa el tablero.`
    } else if (o - u.odometro > 3000) {
      aviso = true
      html = `Son ${fmtKm(o - u.odometro)} desde la última carga. ¿Es correcto?`
    } else html = `Recorrió <b>${fmtKm(o - u.odometro)}</b> desde la última carga.`
    pistaOdo.innerHTML = html
    pistaOdo.classList.toggle('is-warning', aviso)
  }

  ;[litros, importe, odometro].forEach(el => el.addEventListener('input', () => {
    el.closest('.field')?.classList.remove('is-invalid')
    pintarPistas()
  }))
  fecha.addEventListener('input', () => fecha.closest('.field')?.classList.remove('is-invalid'))

  async function cargarChoferes() {
    const { data, error } = await rpc('admin_reporte_choferes')
    if (error) return
    const actual = choferSelect.value
    choferSelect.innerHTML = '<option value="">Sin chofer (lo registra la administración)</option>' +
      data.filter(c => c.activo).map(c => `<option value="${esc(c.licencia)}">${esc(c.nombre)} · ${esc(c.licencia)}</option>`).join('')
    choferSelect.value = actual
  }

  function abrirFormulario(nuevoModo) {
    modo = nuevoModo
    form.reset()
    foto = null
    pintarFoto()
    $$('.is-invalid', form).forEach(el => el.classList.remove('is-invalid'))
    lleno.checked = true
    const ahora = aLocal(Date.now())
    fecha.value = ahora
    fecha.dataset.inicial = ahora
    fecha.max = ahora
    fecha.min = aLocal(Date.now() - (modo === 'chofer' ? 7 : 400) * DIA)
    if (modo === 'chofer' || !camionSeg.value) camionSeg.set(modo === 'chofer' ? camion() : listaCamiones()[0]?.id)
    $('#diesel-chofer-field').hidden = modo !== 'admin'
    $('#diesel-foto-sub').textContent = modo === 'admin'
      ? 'Opcional si el ticket se perdió, pero quedará marcada'
      : 'Que se lean los litros, el total y la fecha'
    $('#sheet-diesel-title').textContent = modo === 'admin' ? 'Registrar un ticket' : 'Registrar carga'
    pintarPistas()
    openSheet('sheet-diesel')
    if (modo === 'admin') cargarChoferes()
    else cargarChofer()
  }

  form.addEventListener('submit', async e => {
    e.preventDefault()
    const bus = Number(camionSeg.value)
    const l = litros.valueAsNumber
    const i = importe.valueAsNumber
    const o = odometro.valueAsNumber
    const cuandoFue = fecha.value ? new Date(fecha.value) : new Date()

    const faltan = [
      !bus && $('#diesel-camion'),
      modo === 'chofer' && !foto && fotoBox,
      !(l > 0) && litros.closest('.field'),
      !(i > 0) && importe.closest('.field'),
      !(Number.isInteger(o) && o >= 0) && odometro.closest('.field')
    ].filter(Boolean)
    if (faltan.length) {
      faltan.forEach(el => el.classList.add('is-invalid'))
      shake(faltan[0])
      toast(!bus ? 'Elige el camión' : faltan[0] === fotoBox ? 'Toma la foto del ticket' : !(l > 0) ? 'Escribe los litros' : !(i > 0) ? 'Escribe el total del ticket' : 'Escribe el kilometraje del tablero (sin decimales)', { type: 'warning' })
      return
    }
    const p = i / l
    if (p < PRECIO_MIN || p > PRECIO_MAX) {
      litros.closest('.field').classList.add('is-invalid')
      importe.closest('.field').classList.add('is-invalid')
      shake(litros.closest('.field-row'))
      toast(`Revisa los litros y el total: saldría a ${fmtPesos(p)} por litro`, { type: 'warning', duration: 4000 })
      return
    }
    const limite = Date.now() - (modo === 'chofer' ? 7 : 400) * DIA
    if (Number.isNaN(cuandoFue.getTime()) || cuandoFue.getTime() > Date.now() + 10 * 60000 || cuandoFue.getTime() < limite) {
      fecha.closest('.field').classList.add('is-invalid')
      shake(fecha.closest('.field'))
      toast(cuandoFue.getTime() < limite && modo === 'chofer'
        ? 'Solo puedes registrar cargas de los últimos 7 días'
        : 'Revisa la fecha de la carga', { type: 'warning' })
      return
    }
    const u = ultimaDe(bus)
    if (u?.odometro != null && o < u.odometro) {
      const seguir = await confirm({
        title: 'Kilometraje menor',
        message: `La última carga del camión ${camionCorto(bus)} marcaba ${fmtKm(u.odometro)}. ¿Guardar ${fmtKm(o)} de todos modos?`,
        confirmLabel: 'Guardar'
      })
      if (!seguir) return
    }
    if (modo === 'admin' && !foto) {
      const seguir = await confirm({
        title: 'Sin foto del ticket',
        message: 'La carga quedará marcada con la alerta "Sin foto del ticket".',
        confirmLabel: 'Guardar sin foto'
      })
      if (!seguir) return
    }

    const btn = $('#btn-diesel-send')
    setLoading(btn, true)
    const params = {
      p_camion: bus,
      // Si no cambió la fecha, el servidor usa la hora exacta de ahora
      p_fecha: fecha.value && fecha.value !== fecha.dataset.inicial ? cuandoFue.toISOString() : null,
      p_litros: l,
      p_importe: i,
      p_odometro: o,
      p_lleno: lleno.checked,
      p_gasolinera: gasolinera.value,
      p_folio: folio.value,
      p_foto: foto?.data || null
    }
    const { data, error } = modo === 'chofer'
      ? await rpc('chofer_diesel_registrar', params)
      : await rpc('admin_diesel_registrar', { p_chofer: choferSelect.value || null, ...params })
    setLoading(btn, false)
    if (error) {
      toast(error.message || 'No se pudo guardar la carga', { type: 'error', duration: 4500 })
      return
    }
    document.activeElement?.blur?.()
    await closeSheet('sheet-diesel')
    haptic([10, 40, 14])
    const n = data?.alertas?.length || 0
    toast(modo === 'admin' && n
      ? `Guardada con ${plural(n, 'alerta', 'alertas')}`
      : data?.km ? `Carga guardada · ${fmtKm(data.km)} desde la anterior` : 'Carga guardada', { type: modo === 'admin' && n ? 'warning' : 'success' })
    foto = null
    if (modo === 'chofer') cargarChofer()
    else refrescarAdmin()
    alCambiar?.()
  })

  // ===================================================================
  // CHOFER
  // ===================================================================
  let mias = []
  let choferListo = false

  async function cargarChofer() {
    const { data, error } = await rpc('chofer_diesel')
    if (error || rol !== 'Chofer') return
    contexto = data.camiones
    mias = data.mias
    choferListo = true
    pintarChofer()
    if ($('#sheet-diesel').classList.contains('is-open')) pintarPistas()
  }

  function pintarChofer() {
    const bus = camion()
    const u = ultimaDe(bus)
    $('#driver-diesel-sub').textContent = !choferListo
      ? 'Registra cada carga con la foto del ticket'
      : u?.fecha
      ? `Última carga del camión ${camionCorto(bus)}: ${hace(u.fecha)} · ${fmtKm(u.odometro)}`
      : `Aún no hay cargas registradas del camión ${camionCorto(bus)}`
    const lista = $('#driver-diesel-list')
    lista.hidden = !mias.length
    lista.innerHTML = mias.slice(0, 3).map(c => {
      const est = ESTADO_CARGA[c.estado] || ESTADO_CARGA.pendiente
      return `<div class="inbox-mine-item">
        <div class="inbox-mine-top">
          <span class="inbox-mine-cat">${icon('i-fuel')}Camión ${camionCorto(c.camion)} · ${esc(fmtLitros(c.litros))} · ${esc(fmtPesos(c.importe))}</span>
          ${chip(est.corto || est.label, est.tono)}
        </div>
        ${c.nota ? `<p class="inbox-reply">${icon('i-reply')}<span>${esc(c.nota)}</span></p>` : ''}
        <p class="inbox-time">${esc(fmtCuando(c.fecha))} · ${esc(fmtKm(c.odometro))}</p>
      </div>`
    }).join('')
  }

  $('#btn-diesel-registrar').addEventListener('click', () => {
    haptic(6)
    abrirFormulario('chofer')
  })

  // ===================================================================
  // ADMINISTRACIÓN
  // ===================================================================
  const listaCargas = $('#diesel-cargas-list')
  const filtroSeg = $('#diesel-cargas-filtro')
  const filtro = initSegmented(filtroSeg, () => pintarCargas())

  async function cargarResumen() {
    const { data, error } = await rpc('admin_diesel_resumen')
    if (error || rol !== 'Admin') return
    animateNumber($('#admin-diesel-total'), Number(data.importe), { decimals: 2 })
    const rend = rendimiento(data.km_lleno, data.litros_lleno)
    $('#admin-diesel-meta').textContent = data.cargas
      ? [plural(data.cargas, 'carga', 'cargas'), fmtLitros(data.litros), rend && fmtRend(rend)].filter(Boolean).join(' · ')
      : 'Sin cargas este mes'
    const aviso = $('#admin-diesel-pending')
    aviso.hidden = !data.pendientes
    aviso.classList.toggle('is-warning', !!data.alertas)
    aviso.innerHTML = data.pendientes
      ? `${icon(data.alertas ? 'i-alert' : 'i-info')}<span>${plural(data.pendientes, 'carga por verificar', 'cargas por verificar')}${data.alertas ? ` · ${plural(data.alertas, 'con alerta', 'con alertas')}` : ''}</span>`
      : ''
  }

  async function cargarAdmin() {
    const { data, error } = await rpc('admin_diesel_cargas')
    if (rol !== 'Admin') return
    if (error) {
      if (!cargas.length) listaCargas.innerHTML = emptyState('i-alert', 'No se pudo cargar', error.message || 'Revisa tu conexión e intenta de nuevo.')
      return
    }
    cargas = data.cargas
    tanques = data.tanques
    // Última carga válida de cada camión, para las pistas del formulario
    contexto = tanques.map(t => {
      const u = cargas.find(c => c.camion === t.camion && c.estado !== 'anulada')
      return { camion: t.camion, tanque: t.litros, odometro: u?.odometro ?? null, fecha: u?.fecha ?? null }
    })
    pintarCargas()
  }

  function filaCarga(c) {
    const est = ESTADO_CARGA[c.estado] || ESTADO_CARGA.pendiente
    const alertas = c.estado === 'anulada' ? [] : c.alertas || []
    const tono = c.estado === 'anulada' ? 'gray' : alertas.length ? 'orange' : c.estado === 'verificada' ? 'green' : 'blue'
    const quien = c.chofer_nombre || (c.registrado_rol === 'Admin' ? 'Administración' : c.chofer || '')
    const datos = [fmtPesos(c.importe), `${fmtPesos(c.precio_litro)}/L`, c.rendimiento != null && fmtRend(c.rendimiento)].filter(Boolean).join(' · ')
    return `<button type="button" class="row inbox-row diesel-row${c.estado === 'anulada' ? ' is-void' : ''}" data-carga="${c.id}">
      <span class="row-icon tono-${tono}">${icon('i-fuel')}</span>
      <span class="row-text">
        <span class="inbox-row-top"><span class="row-title">Camión ${camionCorto(c.camion)} · ${esc(fmtLitros(c.litros))}</span>${chip(est.corto || est.label, est.tono)}</span>
        <span class="row-sub">${esc(fmtCuando(c.fecha))}${quien ? ` · ${esc(quien)}` : ''}</span>
        <span class="row-sub">${esc(datos)}</span>
        ${alertas.length ? `<span class="diesel-alert-line">${icon('i-alert')}${esc(ALERTAS[alertas[0]]?.texto || alertas[0])}${alertas.length > 1 ? ` y ${alertas.length - 1} más` : ''}</span>` : ''}
      </span>
    </button>`
  }

  function pintarCargas() {
    const f = filtro.value
    const conAlertas = cargas.filter(c => c.estado !== 'anulada' && c.alertas?.length)
    const pendientes = cargas.filter(c => c.estado === 'pendiente')
    $('button[data-value="pendientes"]', filtroSeg).textContent = pendientes.length ? `Por verificar (${pendientes.length})` : 'Por verificar'
    $('button[data-value="alertas"]', filtroSeg).textContent = conAlertas.length ? `Alertas (${conAlertas.length})` : 'Alertas'
    const items = f === 'pendientes' ? pendientes : f === 'alertas' ? conAlertas : cargas
    patchList(listaCargas, items, {
      key: c => c.id,
      render: filaCarga,
      empty: f === 'pendientes'
        ? emptyState('i-check-circle', 'Todo verificado', 'No hay cargas pendientes de revisar.')
        : f === 'alertas'
          ? emptyState('i-check-circle', 'Sin alertas', 'Ninguna carga reciente tiene algo raro.')
          : emptyState('i-fuel', 'Sin cargas', 'Cuando los choferes registren cargas de diésel aparecerán aquí.')
    })
  }

  $('#btn-admin-diesel-cargas').addEventListener('click', () => {
    haptic(6)
    if (!cargas.length) listaCargas.innerHTML = skeletonRows(4)
    openSheet('sheet-diesel-cargas')
    cargarAdmin()
  })

  $('#btn-diesel-nueva').addEventListener('click', () => {
    haptic(6)
    abrirFormulario('admin')
  })

  listaCargas.addEventListener('click', e => {
    const fila = e.target.closest('[data-carga]')
    if (!fila) return
    const c = cargas.find(x => String(x.id) === fila.dataset.carga)
    if (c) {
      haptic(6)
      abrirCarga(c)
    }
  })

  // --- Revisar una carga ---
  const formRevisar = $('#form-diesel-revisar')
  const notaRevisar = $('#diesel-revisar-nota')
  const pintarContadorNota = contador(notaRevisar, $('#diesel-revisar-contador'), 300)
  const estadoRevisar = opciones($('#diesel-revisar-estado'),
    Object.entries(ESTADO_CARGA).map(([value, e]) => ({ value, label: e.label, tono: e.tono })),
    v => pintarNotaRequerida(v))
  const corregirBox = $('#diesel-corregir')
  const btnCorregir = $('#btn-diesel-corregir')
  const corr = {
    litros: $('#diesel-corr-litros'),
    importe: $('#diesel-corr-importe'),
    odometro: $('#diesel-corr-odometro'),
    fecha: $('#diesel-corr-fecha'),
    lleno: $('#diesel-corr-lleno')
  }
  const corrCamion = selectorCamion($('#diesel-corr-camion'))

  function pintarNotaRequerida(estado) {
    const requerida = estado === 'observada' || estado === 'anulada'
    $('#diesel-revisar-nota-label').textContent = requerida
      ? (estado === 'anulada' ? 'Motivo para anularla' : 'Qué se observó')
      : 'Nota (opcional)'
    if (!requerida) notaRevisar.closest('.field').classList.remove('is-invalid')
  }

  btnCorregir.addEventListener('click', () => {
    const abrir = corregirBox.classList.contains('is-collapsed')
    haptic(5)
    collapse(corregirBox, !abrir)
    btnCorregir.setAttribute('aria-expanded', String(abrir))
    $('span', btnCorregir).textContent = abrir ? 'Cancelar corrección' : 'Corregir datos'
  })

  function datoCelda(etiqueta, valor, nota = '', tono = '') {
    return `<div class="diesel-dato${tono ? ` tono-${tono}` : ''}"><span>${esc(etiqueta)}</span><b>${esc(valor)}</b>${nota ? `<small>${esc(nota)}</small>` : ''}</div>`
  }

  function pintarDetalle(c) {
    const quien = c.chofer_nombre || (c.chofer ? `Licencia ${c.chofer}` : 'Sin chofer')
    const sub = c.registrado_rol === 'Admin'
      ? `Registrada por la administración${c.registrado_por ? ` (${c.registrado_por})` : ''}`
      : c.chofer ? `Licencia ${c.chofer}` : 'Chofer'
    const alertas = c.estado === 'anulada' ? [] : c.alertas || []
    const rendBajo = alertas.includes('rendimiento_bajo') || alertas.includes('rendimiento_alto')
    const extra = [c.lleno ? 'Tanque lleno' : 'Carga parcial', c.gasolinera, c.folio && `Folio ${c.folio}`].filter(Boolean).join(' · ')
    $('#diesel-revisar-detalle').innerHTML = `
      <div class="inbox-author">${avatar(c.chofer_nombre || 'Administración')}<span class="row-text"><span class="row-title">${esc(quien)}</span><span class="row-sub">${esc(sub)}</span></span></div>
      <p class="inbox-detail-meta">${icon('i-bus')}Camión ${camionCorto(c.camion)} · ${esc(fmtCuando(c.fecha))}</p>
      <div class="diesel-datos">
        ${datoCelda('Litros', fmtLitros(c.litros), c.tanque ? `Tanque de ${fmtLitros(c.tanque)}` : '', alertas.includes('sobre_tanque') ? 'orange' : '')}
        ${datoCelda('Total', fmtPesos(c.importe))}
        ${datoCelda('Precio por litro', fmtPesos(c.precio_litro), '', alertas.includes('precio') ? 'orange' : '')}
        ${datoCelda('Tablero', fmtKm(c.odometro), c.odo_prev != null ? `Antes: ${fmtKm(c.odo_prev)}` : 'Primera carga', alertas.includes('odometro') ? 'orange' : '')}
        ${datoCelda('Recorrido', c.km != null ? fmtKm(c.km) : '—', 'Desde la anterior', alertas.includes('carga_faltante') ? 'orange' : '')}
        ${datoCelda('Rendimiento', fmtRend(c.rendimiento), c.rendimiento_normal ? `Normal: ${fmtRend(c.rendimiento_normal)}` : c.rendimiento != null ? 'Aún sin promedio' : c.lleno ? 'Falta otro llenado' : 'Se calcula al llenar', rendBajo ? 'orange' : '')}
      </div>
      <p class="inbox-detail-meta">${icon('i-info')}${esc(extra)}</p>
      ${alertas.length ? `<ul class="diesel-alertas">${alertas.map(a => `<li>${icon('i-alert')}<span><b>${esc(ALERTAS[a]?.texto || a)}</b>${esc(ALERTAS[a]?.detalle || '')}</span></li>`).join('')}</ul>` : ''}
      ${c.revisada_por ? `<p class="field-hint">Revisada por ${esc(c.revisada_por)}${c.revisada_en ? ` · ${esc(fmtCuando(c.revisada_en))}` : ''}</p>` : ''}`
  }

  async function pintarTicket(c) {
    const box = $('#diesel-revisar-ticket')
    if (!c.tiene_foto) {
      box.className = 'diesel-ticket is-empty'
      box.innerHTML = `${icon('i-image')}<span>Sin foto del ticket</span>`
      return
    }
    const guardada = tickets.get(c.id)
    if (guardada) {
      box.className = 'diesel-ticket'
      box.innerHTML = `<button type="button" class="diesel-ticket-btn" aria-label="Ver el ticket completo"><img src="${guardada}" alt="Ticket de la carga"></button>`
      return
    }
    box.className = 'diesel-ticket is-loading skeleton'
    box.innerHTML = ''
    const { data, error } = await rpc('admin_diesel_tickets', { p_ids: [c.id] })
    if (revisando?.id !== c.id) return
    const b64 = !error && data?.[0]?.foto
    if (!b64) {
      box.className = 'diesel-ticket is-empty'
      box.innerHTML = `${icon('i-alert')}<span>No se pudo cargar la foto</span>`
      return
    }
    const url = `data:image/jpeg;base64,${b64}`
    if (tickets.size > 40) tickets.delete(tickets.keys().next().value)
    tickets.set(c.id, url)
    pintarTicket(c)
  }

  $('#diesel-revisar-ticket').addEventListener('click', e => {
    const img = e.target.closest('.diesel-ticket-btn')?.querySelector('img')
    if (img) abrirVisor(img.src)
  })

  function abrirCarga(c) {
    revisando = c
    pintarDetalle(c)
    pintarTicket(c)
    estadoRevisar.set(c.estado)
    pintarNotaRequerida(c.estado)
    notaRevisar.value = c.nota || ''
    pintarContadorNota()
    $$('.is-invalid', formRevisar).forEach(el => el.classList.remove('is-invalid'))
    // Datos para corregir
    corrCamion.set(c.camion)
    corr.litros.value = c.litros
    corr.importe.value = c.importe
    corr.odometro.value = c.odometro
    corr.fecha.value = aLocal(c.fecha)
    corr.fecha.dataset.inicial = corr.fecha.value
    corr.fecha.max = aLocal(Date.now())
    corr.lleno.checked = !!c.lleno
    collapse(corregirBox, true)
    btnCorregir.setAttribute('aria-expanded', 'false')
    $('span', btnCorregir).textContent = 'Corregir datos'
    openSheet('sheet-diesel-carga', { onClose: () => { revisando = null } })
  }

  formRevisar.addEventListener('submit', async e => {
    e.preventDefault()
    if (!revisando) return
    const c = revisando
    const estado = estadoRevisar.value
    const nota = notaRevisar.value.trim()
    if ((estado === 'observada' || estado === 'anulada') && !nota) {
      const campo = notaRevisar.closest('.field')
      campo.classList.add('is-invalid')
      shake(campo)
      toast(estado === 'anulada' ? 'Escribe por qué se anula' : 'Escribe qué se observó', { type: 'warning' })
      return
    }
    const params = { p_id: c.id, p_estado: estado, p_nota: nota }
    if (!corregirBox.classList.contains('is-collapsed')) {
      const l = corr.litros.valueAsNumber
      const i = corr.importe.valueAsNumber
      const o = corr.odometro.valueAsNumber
      const malos = [
        !(l > 0) && corr.litros, !(i > 0) && corr.importe, !(Number.isInteger(o) && o >= 0) && corr.odometro
      ].filter(Boolean).map(el => el.closest('.field'))
      if (malos.length) {
        malos.forEach(el => el.classList.add('is-invalid'))
        shake(malos[0])
        toast('Revisa los datos corregidos', { type: 'warning' })
        return
      }
      Object.assign(params, {
        p_camion: Number(corrCamion.value),
        p_litros: l,
        p_importe: i,
        p_odometro: o,
        p_lleno: corr.lleno.checked,
        p_fecha: corr.fecha.value && corr.fecha.value !== corr.fecha.dataset.inicial ? new Date(corr.fecha.value).toISOString() : null
      })
    }
    if (estado === 'anulada' && c.estado !== 'anulada') {
      const seguir = await confirm({
        title: 'Anular carga',
        message: 'Dejará de contar en los totales y en los informes. Seguirá visible en la lista como anulada.',
        confirmLabel: 'Anular',
        destructive: true
      })
      if (!seguir) return
    }
    const btn = $('#btn-diesel-revisar-save')
    setLoading(btn, true)
    const { error } = await rpc('admin_diesel_actualizar', params)
    setLoading(btn, false)
    if (error) {
      toast(error.message || 'No se pudo guardar', { type: 'error', duration: 4500 })
      return
    }
    document.activeElement?.blur?.()
    await closeSheet('sheet-diesel-carga')
    haptic([10, 40, 14])
    toast(estado === 'verificada' ? 'Carga verificada' : estado === 'anulada' ? 'Carga anulada' : 'Guardado', { type: 'success' })
    refrescarAdmin()
    alCambiar?.()
  })

  formRevisar.addEventListener('input', e => e.target.closest('.field')?.classList.remove('is-invalid'))

  // --- Capacidad de los tanques ---
  const formTanques = $('#form-diesel-tanques')

  $('#btn-diesel-tanques').addEventListener('click', () => {
    haptic(6)
    $('#diesel-tanques-campos').innerHTML = (tanques.length ? tanques : listaCamiones().map(c => ({ camion: c.id }))).map(t => `
      <div class="field">
        <input id="diesel-tanque-${t.camion}" data-camion="${t.camion}" data-inicial="${t.litros ?? ''}" type="number" inputmode="decimal" step="1" min="20" max="1500" placeholder=" " value="${t.litros ?? ''}">
        <label for="diesel-tanque-${t.camion}">Camión ${camionCorto(t.camion)} · litros</label>
      </div>`).join('')
    openSheet('sheet-diesel-tanques')
  })

  formTanques.addEventListener('submit', async e => {
    e.preventDefault()
    const campos = $$('input[data-camion]', formTanques)
    const cambios = campos.filter(el => el.value !== el.dataset.inicial)
    const malo = cambios.find(el => el.value !== '' && !(el.valueAsNumber >= 20 && el.valueAsNumber <= 1500))
    if (malo) {
      malo.closest('.field').classList.add('is-invalid')
      shake(malo.closest('.field'))
      toast('La capacidad debe estar entre 20 y 1,500 litros', { type: 'warning' })
      return
    }
    const btn = $('#btn-diesel-tanques-save')
    setLoading(btn, true)
    for (const el of cambios) {
      const { error } = await rpc('admin_diesel_tanque', { p_camion: Number(el.dataset.camion), p_litros: el.value === '' ? null : el.valueAsNumber })
      if (error) {
        setLoading(btn, false)
        toast(error.message || 'No se pudo guardar', { type: 'error' })
        return
      }
    }
    setLoading(btn, false)
    document.activeElement?.blur?.()
    await closeSheet('sheet-diesel-tanques')
    if (cambios.length) {
      haptic([10, 40, 14])
      toast('Capacidad guardada', { type: 'success' })
      refrescarAdmin()
      alCambiar?.()
    }
  })

  formTanques.addEventListener('input', e => e.target.closest('.field')?.classList.remove('is-invalid'))

  function refrescarAdmin() {
    cargarResumen()
    if ($('#sheet-diesel-cargas').classList.contains('is-open')) cargarAdmin()
  }

  // ===================================================================
  // VISOR DEL TICKET (pantalla completa, toca para acercar)
  // ===================================================================
  const visor = $('#ticket-viewer')
  const visorImg = $('img', visor)

  function abrirVisor(src) {
    visorImg.src = src
    visor.classList.remove('is-zoom')
    visor.hidden = false
    visor.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: 'ease-out' })
    $('.ticket-viewer-close', visor).focus({ preventScroll: true })
  }

  async function cerrarVisor() {
    if (visor.hidden) return
    await visor.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: 'ease-in' }).finished.catch(() => {})
    visor.hidden = true
    visorImg.removeAttribute('src')
  }

  $('.ticket-viewer-close', visor).addEventListener('click', cerrarVisor)
  visorImg.addEventListener('click', () => {
    haptic(5)
    visor.classList.toggle('is-zoom')
  })
  // Escape cierra primero el visor y no la hoja de abajo
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !visor.hidden) {
      e.stopImmediatePropagation()
      cerrarVisor()
    }
  }, true)

  // ===================================================================
  // TIEMPO REAL: la tabla "actividad" avisa cuando cambian las cargas
  // ===================================================================
  supabase
    .channel('actividad_diesel_channel')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'actividad' }, ({ new: fila }) => {
      if (!rol || fila?.clave !== 'diesel') return
      clearTimeout(refresco)
      refresco = setTimeout(refrescar, 600)
    })
    .subscribe()

  function refrescar() {
    if (rol === 'Chofer') cargarChofer()
    else if (rol === 'Admin') {
      refrescarAdmin()
      alCambiar?.()
    }
  }

  return {
    chofer() {
      rol = 'Chofer'
      pintarChofer()
      cargarChofer()
    },
    admin() {
      rol = 'Admin'
      cargarResumen()
    },
    abrirCarga(c) {
      if (rol === 'Admin') abrirCarga(c)
    },
    refrescar() {
      if (rol) refrescar()
    },
    limpiar() {
      rol = null
      contexto = []
      cargas = []
      tanques = []
      mias = []
      choferListo = false
      foto = null
      revisando = null
      tickets.clear()
      listaCargas.replaceChildren()
      $('#driver-diesel-list').replaceChildren()
      $('#admin-diesel-total').dataset.value = '0'
      $('#admin-diesel-total').textContent = '0.00'
      $('#admin-diesel-pending').hidden = true
      if (!visor.hidden) {
        visor.hidden = true
        visorImg.removeAttribute('src')
      }
    }
  }
}
