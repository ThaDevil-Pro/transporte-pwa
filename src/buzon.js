// =====================================================================
// Buzón de quejas y reportes de fallas del camión.
// · Alumno: envía quejas o sugerencias y ve su estado y la respuesta.
// · Chofer: lee las quejas sin autor y reporta fallas del camión.
// · Administración: ve quién escribió cada queja, la atiende y responde,
//   y da seguimiento a las fallas.
// La censura de groserías y los límites viven en Supabase.
// =====================================================================
import {
  $, $$, esc, icon, avatar, haptic, toast, openSheet, closeSheet, setLoading, shake, patchList,
  emptyState, skeletonRows, initSegmented
} from './ui.js'

const TZ = 'America/Mexico_City'

const CATEGORIAS = {
  servicio: { label: 'Servicio', icon: 'i-message' },
  chofer: { label: 'Chofer', icon: 'i-wheel' },
  camion: { label: 'Camión', icon: 'i-bus' },
  horario: { label: 'Horario', icon: 'i-calendar' },
  otro: { label: 'Otro', icon: 'i-info' }
}

const ESTADO_QUEJA = {
  nueva: { label: 'Recibida', admin: 'Nueva', tono: 'blue' },
  revision: { label: 'En revisión', admin: 'En revisión', tono: 'orange' },
  atendida: { label: 'Atendida', admin: 'Atendida', tono: 'green' }
}

const TIPOS_FALLA = {
  motor: 'Motor', frenos: 'Frenos', llantas: 'Llantas', luces: 'Luces',
  puertas: 'Puertas', clima: 'Clima', electrico: 'Eléctrico', otro: 'Otro'
}

const GRAVEDAD = {
  baja: { label: 'Puede seguir', sub: 'No es urgente', tono: 'green' },
  media: { label: 'Revisar pronto', sub: 'Antes de varios viajes', tono: 'orange' },
  alta: { label: 'No puede circular', sub: 'Es peligroso', tono: 'red' }
}

const ESTADO_FALLA = {
  abierta: { label: 'Abierta', tono: 'red' },
  reparacion: { label: 'En reparación', tono: 'orange' },
  resuelta: { label: 'Resuelta', tono: 'green' }
}

const relativo = new Intl.RelativeTimeFormat('es', { numeric: 'auto' })

function cuando(iso) {
  const d = new Date(iso)
  const seg = Math.round((d - Date.now()) / 1000)
  const abs = Math.abs(seg)
  if (abs < 60) return 'Hace un momento'
  if (abs < 3600) return relativo.format(Math.round(seg / 60), 'minute')
  if (abs < 86400) return relativo.format(Math.round(seg / 3600), 'hour')
  if (abs < 7 * 86400) return relativo.format(Math.round(seg / 86400), 'day')
  return d.toLocaleDateString('es-MX', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' })
}

const fechaCompleta = iso => {
  const d = new Date(iso)
  return `${d.toLocaleDateString('es-MX', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' })}, ${d.toLocaleTimeString('es-MX', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true })}`
}

const chip = (texto, tono) => `<span class="state-chip tono-${tono}">${esc(texto)}</span>`
const mayus = s => s.charAt(0).toUpperCase() + s.slice(1)

// Botones de opción única (rol radio) dentro de un contenedor
function opciones(contenedor, items, alElegir) {
  contenedor.innerHTML = items.map(it => `<button type="button" class="choice${it.tono ? ` tono-${it.tono}` : ''}" role="radio" aria-checked="false" data-value="${esc(it.value)}">
      ${it.icon ? icon(it.icon) : ''}<span class="choice-text"><span class="choice-label">${esc(it.label)}</span>${it.sub ? `<span class="choice-sub">${esc(it.sub)}</span>` : ''}</span>
    </button>`).join('')
  let valor = null
  const marcar = v => {
    valor = v
    $$('.choice', contenedor).forEach(b => b.setAttribute('aria-checked', String(b.dataset.value === v)))
    contenedor.classList.remove('is-invalid')
  }
  contenedor.addEventListener('click', e => {
    const b = e.target.closest('.choice')
    if (!b) return
    haptic(5)
    marcar(b.dataset.value)
    alElegir?.(b.dataset.value)
  })
  return { get value() { return valor }, set: marcar, reset: () => marcar(null) }
}

// Contador de caracteres de un textarea
function contador(textarea, etiqueta, max) {
  const pintar = () => {
    const n = textarea.value.length
    etiqueta.textContent = `${n}/${max}`
    etiqueta.classList.toggle('is-near', n > max * 0.9)
  }
  textarea.addEventListener('input', () => {
    pintar()
    textarea.closest('.field')?.classList.remove('is-invalid')
  })
  return pintar
}

export function initBuzon({ rpc, supabase, camion }) {
  let rol = null
  let misQuejas = []
  let quejas = []
  let fallas = []
  let refresco = null

  // ===================================================================
  // ALUMNO
  // ===================================================================
  const inboxBody = $('#student-inbox-body')
  const formQueja = $('#form-queja')
  const mensajeQueja = $('#queja-mensaje')
  const categoria = opciones($('#queja-categorias'), Object.entries(CATEGORIAS).map(([value, c]) => ({ value, label: c.label, icon: c.icon })))
  const camionQueja = initSegmented($('#queja-camion'))
  const pintarContadorQueja = contador(mensajeQueja, $('#queja-contador'), 600)

  async function cargarAlumno() {
    const { data, error } = await rpc('alumno_quejas')
    if (error || rol !== 'Estudiante') return
    misQuejas = data
    renderAlumno()
  }

  function renderAlumno() {
    const lista = misQuejas.slice(0, 5)
    inboxBody.innerHTML = `
      <p class="inbox-intro">¿Algo que mejorar? Tu opinión llega a la administración.</p>
      <button class="btn btn-tinted btn-block" data-queja-nueva>${icon('i-message')}Escribir una queja o sugerencia</button>
      ${lista.length ? `<div class="inbox-mine">${lista.map(q => {
        const est = ESTADO_QUEJA[q.estado] || ESTADO_QUEJA.nueva
        const cat = CATEGORIAS[q.categoria] || CATEGORIAS.otro
        return `<div class="inbox-mine-item">
          <div class="inbox-mine-top">
            <span class="inbox-mine-cat">${icon(cat.icon)}${esc(cat.label)}${q.camion ? ` · Camión ${q.camion}` : ''}</span>
            ${chip(est.label, est.tono)}
          </div>
          <p class="inbox-mine-text">${esc(q.mensaje)}</p>
          ${q.respuesta ? `<p class="inbox-reply">${icon('i-reply')}<span><b>Respuesta:</b> ${esc(q.respuesta)}</span></p>` : ''}
          <p class="inbox-time">${esc(cuando(q.creado_en))}</p>
        </div>`
      }).join('')}</div>` : ''}`
  }

  inboxBody.addEventListener('click', e => {
    if (!e.target.closest('[data-queja-nueva]')) return
    haptic(6)
    formQueja.reset()
    categoria.reset()
    camionQueja.select('0', false)
    pintarContadorQueja()
    $$('.is-invalid', formQueja).forEach(el => el.classList.remove('is-invalid'))
    openSheet('sheet-queja')
  })

  formQueja.addEventListener('submit', async e => {
    e.preventDefault()
    const texto = mensajeQueja.value.trim()
    if (!categoria.value) {
      const grupo = $('#queja-categorias')
      grupo.classList.add('is-invalid')
      shake(grupo)
      toast('Elige de qué trata tu queja', { type: 'warning' })
      return
    }
    if (texto.length < 10) {
      const campo = mensajeQueja.closest('.field')
      campo.classList.add('is-invalid')
      shake(campo)
      toast('Cuéntanos un poco más (mínimo 10 caracteres)', { type: 'warning' })
      return
    }
    const btn = $('#btn-queja-send')
    setLoading(btn, true)
    const { data, error } = await rpc('alumno_queja_enviar', {
      p_categoria: categoria.value,
      p_camion: Number(camionQueja.value) || null,
      p_mensaje: texto
    })
    setLoading(btn, false)
    if (error) {
      toast(error.message || 'No se pudo enviar', { type: 'error', duration: 4000 })
      return
    }
    mensajeQueja.blur()
    await closeSheet('sheet-queja')
    haptic([10, 40, 14])
    toast(data?.censurada ? 'Enviada. Ocultamos algunas palabras.' : 'Queja enviada. ¡Gracias!', { type: 'success' })
    cargarAlumno()
  })

  // ===================================================================
  // CHOFER
  // ===================================================================
  const formFalla = $('#form-falla')
  const descFalla = $('#falla-descripcion')
  const panelFallas = $('#driver-inbox-fallas')
  const panelQuejas = $('#driver-inbox-quejas')
  const tipoFalla = opciones($('#falla-tipos'), Object.entries(TIPOS_FALLA).map(([value, label]) => ({ value, label })))
  const gravedad = opciones($('#falla-gravedad'), Object.entries(GRAVEDAD).map(([value, g]) => ({ value, label: g.label, sub: g.sub, tono: g.tono })))
  const camionFalla = initSegmented($('#falla-camion'))
  const pintarContadorFalla = contador(descFalla, $('#falla-contador'), 600)
  const vistaChofer = initSegmented($('#driver-inbox-seg'), v => {
    panelFallas.hidden = v !== 'fallas'
    panelQuejas.hidden = v !== 'quejas'
  })

  function filaQueja(q, { conAutor = false } = {}) {
    const cat = CATEGORIAS[q.categoria] || CATEGORIAS.otro
    const est = ESTADO_QUEJA[q.estado] || ESTADO_QUEJA.nueva
    const autor = conAutor
      ? `${esc(q.nombre || 'Alumno dado de baja')}${q.matricula ? ` · ${esc(q.matricula)}` : ''}`
      : 'Anónimo'
    return `<${conAutor ? 'button type="button"' : 'div'} class="row inbox-row${q.estado === 'nueva' && conAutor ? ' is-new' : ''}" data-queja="${esc(q.id)}">
      <span class="row-icon">${icon(cat.icon)}</span>
      <span class="row-text">
        <span class="inbox-row-top"><span class="row-title">${esc(cat.label)}${q.camion ? ` · Camión ${q.camion}` : ''}</span>${chip(conAutor ? est.admin : est.label, est.tono)}</span>
        <span class="inbox-row-msg">${esc(q.mensaje)}</span>
        <span class="row-sub">${autor} · ${esc(cuando(q.creado_en))}</span>
      </span>
    </${conAutor ? 'button' : 'div'}>`
  }

  function filaFalla(f, { admin = false } = {}) {
    const g = GRAVEDAD[f.gravedad] || GRAVEDAD.media
    const est = ESTADO_FALLA[f.estado] || ESTADO_FALLA.abierta
    const quien = admin ? f.chofer_nombre : f.mia ? 'Tú' : f.chofer_nombre || 'Otro chofer'
    return `<${admin ? 'button type="button"' : 'div'} class="row inbox-row${f.estado === 'abierta' && admin ? ' is-new' : ''}" data-falla="${esc(f.id)}">
      <span class="row-icon tono-${g.tono}">${icon('i-wrench')}</span>
      <span class="row-text">
        <span class="inbox-row-top"><span class="row-title">${esc(TIPOS_FALLA[f.tipo] || 'Falla')} · Camión ${f.camion}</span>${chip(est.label, est.tono)}</span>
        <span class="inbox-row-msg">${esc(f.descripcion)}</span>
        ${f.nota ? `<span class="inbox-reply">${icon('i-reply')}<span>${esc(f.nota)}</span></span>` : ''}
        <span class="row-sub"><span class="severity-dot tono-${g.tono}"></span>${esc(g.label)} · ${esc(quien || '')} · ${esc(cuando(f.creado_en))}</span>
      </span>
    </${admin ? 'button' : 'div'}>`
  }

  async function cargarChofer() {
    if (!$('#driver-fallas-list').children.length) $('#driver-fallas-list').innerHTML = skeletonRows(2)
    if (!$('#driver-quejas-list').children.length) $('#driver-quejas-list').innerHTML = skeletonRows(2)
    const [rq, rf] = await Promise.all([rpc('chofer_quejas'), rpc('chofer_fallas')])
    if (rol !== 'Chofer') return
    if (!rq.error) {
      quejas = rq.data
      patchList($('#driver-quejas-list'), quejas, {
        key: q => q.id,
        render: q => filaQueja(q),
        empty: emptyState('i-inbox', 'Sin quejas', 'Cuando los alumnos escriban, aparecerán aquí sin su nombre.')
      })
    }
    if (!rf.error) {
      fallas = rf.data
      patchList($('#driver-fallas-list'), fallas, {
        key: f => f.id,
        render: f => filaFalla(f),
        empty: emptyState('i-wrench', 'Sin reportes', 'Si el camión presenta una falla, repórtala aquí y la administración le dará seguimiento.')
      })
    }
  }

  $('#btn-report-falla').addEventListener('click', () => {
    haptic(6)
    formFalla.reset()
    tipoFalla.reset()
    gravedad.reset()
    camionFalla.select(String(camion()), false)
    pintarContadorFalla()
    $$('.is-invalid', formFalla).forEach(el => el.classList.remove('is-invalid'))
    openSheet('sheet-falla')
  })

  formFalla.addEventListener('submit', async e => {
    e.preventDefault()
    const texto = descFalla.value.trim()
    const faltan = [
      !tipoFalla.value && $('#falla-tipos'),
      !gravedad.value && $('#falla-gravedad'),
      texto.length < 5 && descFalla.closest('.field')
    ].filter(Boolean)
    if (faltan.length) {
      faltan.forEach(el => el.classList.add('is-invalid'))
      shake(faltan[0])
      toast(!tipoFalla.value ? 'Elige qué tipo de falla es' : !gravedad.value ? 'Indica qué tan grave es' : 'Describe la falla', { type: 'warning' })
      return
    }
    const btn = $('#btn-falla-send')
    setLoading(btn, true)
    const { error } = await rpc('chofer_falla_reportar', {
      p_camion: Number(camionFalla.value),
      p_tipo: tipoFalla.value,
      p_gravedad: gravedad.value,
      p_descripcion: texto
    })
    setLoading(btn, false)
    if (error) {
      toast(error.message || 'No se pudo enviar el reporte', { type: 'error', duration: 4000 })
      return
    }
    descFalla.blur()
    await closeSheet('sheet-falla')
    haptic([10, 40, 14])
    toast('Reporte enviado a la administración', { type: 'success' })
    vistaChofer.select('fallas')
    cargarChofer()
  })

  // ===================================================================
  // ADMINISTRACIÓN
  // ===================================================================
  const listaAdmin = $('#admin-inbox-list')
  const badge = $('#admin-inbox-badge')
  const formAtender = $('#form-atender')
  const textoAtender = $('#atender-texto')
  const pintarContadorAtender = contador(textoAtender, $('#atender-contador'), 500)
  const estadoAtender = opciones($('#atender-estado'), [])
  let atendiendo = null // { tipo: 'queja' | 'falla', item }

  const vistaAdmin = initSegmented($('#admin-inbox-seg'), () => renderAdmin())
  const filtroAdmin = initSegmented($('#admin-inbox-filter'), () => renderAdmin())

  async function cargarPendientes() {
    const { data, error } = await rpc('admin_buzon_pendientes')
    if (error || rol !== 'Admin') return
    pintarBadge(data.quejas + data.fallas)
    const seg = $('#admin-inbox-seg')
    $('button[data-value="quejas"]', seg).textContent = data.quejas ? `Quejas (${data.quejas})` : 'Quejas'
    $('button[data-value="fallas"]', seg).textContent = data.fallas ? `Fallas (${data.fallas})` : 'Fallas del camión'
  }

  function pintarBadge(n) {
    badge.hidden = !n
    badge.textContent = n > 99 ? '99+' : String(n)
  }

  async function cargarAdmin() {
    if (!listaAdmin.children.length) listaAdmin.innerHTML = skeletonRows(3)
    const [rq, rf] = await Promise.all([rpc('admin_quejas'), rpc('admin_fallas'), cargarPendientes()])
    if (rol !== 'Admin') return
    if (!rq.error) quejas = rq.data
    if (!rf.error) fallas = rf.data
    renderAdmin()
  }

  function renderAdmin() {
    if (rol !== 'Admin') return
    const tipo = vistaAdmin.value
    const soloPendientes = filtroAdmin.value === 'pendientes'
    if (tipo === 'quejas') {
      const items = soloPendientes ? quejas.filter(q => q.estado !== 'atendida') : quejas
      patchList(listaAdmin, items, {
        key: q => `q${q.id}`,
        render: q => filaQueja(q, { conAutor: true }),
        empty: emptyState('i-inbox', soloPendientes ? 'Todo al día' : 'Sin quejas', soloPendientes ? 'No hay quejas pendientes de atender.' : 'Las quejas de los alumnos aparecerán aquí.')
      })
    } else {
      const items = soloPendientes ? fallas.filter(f => f.estado !== 'resuelta') : fallas
      patchList(listaAdmin, items, {
        key: f => `f${f.id}`,
        render: f => filaFalla(f, { admin: true }),
        empty: emptyState('i-wrench', soloPendientes ? 'Todo al día' : 'Sin reportes', soloPendientes ? 'No hay fallas pendientes.' : 'Los reportes de los choferes aparecerán aquí.')
      })
    }
  }

  function pintarOpcionesEstado(mapa) {
    // Los botones cambian según el tipo; "opciones" maneja el clic sobre el contenedor
    $('#atender-estado').innerHTML = Object.entries(mapa).map(([value, e]) => `<button type="button" class="choice tono-${e.tono}" role="radio" aria-checked="false" data-value="${esc(value)}"><span class="choice-text"><span class="choice-label">${esc(e.admin || e.label)}</span></span></button>`).join('')
  }

  listaAdmin.addEventListener('click', e => {
    const fila = e.target.closest('[data-queja], [data-falla]')
    if (!fila) return
    haptic(6)
    if (fila.dataset.queja) {
      const q = quejas.find(x => String(x.id) === fila.dataset.queja)
      if (q) abrirAtender('queja', q)
    } else {
      const f = fallas.find(x => String(x.id) === fila.dataset.falla)
      if (f) abrirAtender('falla', f)
    }
  })

  function abrirAtender(tipo, item) {
    atendiendo = { tipo, item }
    const esQueja = tipo === 'queja'
    $('#sheet-atender-title').textContent = esQueja ? 'Queja' : 'Falla del camión'
    if (esQueja) {
      const cat = CATEGORIAS[item.categoria] || CATEGORIAS.otro
      $('#atender-detalle').innerHTML = `
        <div class="inbox-author">${avatar(item.nombre || '?')}<span class="row-text"><span class="row-title">${esc(item.nombre || 'Alumno dado de baja')}</span><span class="row-sub">${item.matricula ? `Matrícula ${esc(item.matricula)}` : 'Ya no está registrado'}</span></span></div>
        <p class="inbox-detail-meta">${icon(cat.icon)}${esc(cat.label)}${item.camion ? ` · Camión ${item.camion}` : ''} · ${esc(mayus(fechaCompleta(item.creado_en)))}</p>
        <p class="inbox-detail-text">${esc(item.mensaje)}</p>
        ${item.censurada ? `<p class="field-hint">Se ocultaron groserías del mensaje original.</p>` : ''}`
      pintarOpcionesEstado(ESTADO_QUEJA)
      $('#atender-texto-label').textContent = 'Respuesta para el alumno (opcional)'
      $('#atender-hint').textContent = 'Si escribes una respuesta, el alumno la verá en su panel. El chofer nunca ve quién la escribió.'
      textoAtender.value = item.respuesta || ''
    } else {
      const g = GRAVEDAD[item.gravedad] || GRAVEDAD.media
      $('#atender-detalle').innerHTML = `
        <div class="inbox-author">${avatar(item.chofer_nombre || '?')}<span class="row-text"><span class="row-title">${esc(item.chofer_nombre || 'Chofer')}</span><span class="row-sub">Licencia ${esc(item.chofer)}</span></span></div>
        <p class="inbox-detail-meta">${icon('i-wrench')}${esc(TIPOS_FALLA[item.tipo] || 'Falla')} · Camión ${item.camion} · ${esc(mayus(fechaCompleta(item.creado_en)))}</p>
        <p class="inbox-detail-severity tono-${g.tono}"><span class="severity-dot tono-${g.tono}"></span>${esc(g.label)} · ${esc(g.sub)}</p>
        <p class="inbox-detail-text">${esc(item.descripcion)}</p>`
      pintarOpcionesEstado(ESTADO_FALLA)
      $('#atender-texto-label').textContent = 'Nota para los choferes (opcional)'
      $('#atender-hint').textContent = 'Por ejemplo: "Llevado al taller, usar el camión 2 mientras tanto". Los choferes la verán en su buzón.'
      textoAtender.value = item.nota || ''
    }
    estadoAtender.set(item.estado)
    pintarContadorAtender()
    openSheet('sheet-atender', { onClose: () => { atendiendo = null } })
  }

  formAtender.addEventListener('submit', async e => {
    e.preventDefault()
    if (!atendiendo) return
    const { tipo, item } = atendiendo
    const btn = $('#btn-atender-save')
    setLoading(btn, true)
    const { error } = tipo === 'queja'
      ? await rpc('admin_queja_actualizar', { p_id: item.id, p_estado: estadoAtender.value, p_respuesta: textoAtender.value })
      : await rpc('admin_falla_actualizar', { p_id: item.id, p_estado: estadoAtender.value, p_nota: textoAtender.value })
    setLoading(btn, false)
    if (error) {
      toast(error.message || 'No se pudo guardar', { type: 'error' })
      return
    }
    textoAtender.blur()
    await closeSheet('sheet-atender')
    haptic([10, 40, 14])
    toast('Guardado', { type: 'success' })
    cargarAdmin()
  })

  // ===================================================================
  // TIEMPO REAL: la tabla "actividad" avisa cuando cambian quejas o fallas
  // ===================================================================
  supabase
    .channel('actividad_buzon_channel')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'actividad' }, ({ new: fila }) => {
      if (!rol || !['quejas', 'fallas'].includes(fila?.clave)) return
      clearTimeout(refresco)
      refresco = setTimeout(refrescar, 500)
    })
    .subscribe()

  function refrescar() {
    if (rol === 'Estudiante') cargarAlumno()
    else if (rol === 'Chofer' && $('#driver-tab-inbox').classList.contains('is-active')) cargarChofer()
    else if (rol === 'Admin') {
      if ($('#admin-tab-inbox').classList.contains('is-active')) cargarAdmin()
      else cargarPendientes()
    }
  }

  return {
    alumno() {
      rol = 'Estudiante'
      cargarAlumno()
    },
    chofer() {
      rol = 'Chofer'
    },
    choferAbrir() {
      rol = 'Chofer'
      cargarChofer()
    },
    admin() {
      rol = 'Admin'
      cargarPendientes()
    },
    adminAbrir() {
      rol = 'Admin'
      cargarAdmin()
    },
    refrescar,
    limpiar() {
      rol = null
      misQuejas = []
      quejas = []
      fallas = []
      atendiendo = null
      inboxBody.innerHTML = '<div class="skeleton" style="height:60px;margin-top:14px;border-radius:16px"></div>'
      $('#driver-quejas-list').replaceChildren()
      $('#driver-fallas-list').replaceChildren()
      listaAdmin.replaceChildren()
      pintarBadge(0)
    }
  }
}
