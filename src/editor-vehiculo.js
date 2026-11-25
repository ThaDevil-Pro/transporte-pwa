// =====================================================================
// Editor visual de vehículos (administración).
// 1. Tipo: minivan o camión.  2. Preajuste (acomodo estándar) o personalizado
// (dibujo vacío).  3. Dibujo: bloques de un asiento o filas de dos que se
// arrastran desde la paleta (o se tocan y luego se toca el lugar), se mueven
// arrastrándolos y se quitan tocándolos («Quitar») o soltándolos en el bote.
// Los asientos se numeran solos, de adelante hacia atrás y de izquierda a
// derecha; el servidor vuelve a validar y numerar al guardar.
// =====================================================================
import { $, $$, haptic, toast, confirm, openSheet, closeSheet, setLoading, shake } from './ui.js'
import { TIPOS, listaCamiones, vehiculo } from './camiones.js'

const COLS = { minivan: 4, camion: 5 }
const FILAS_MIN = 6
const FILAS_MAX = 20
// Minivan: 4 filas de 2 + pasillo + 1 = 12 asientos. Camión: 10 filas de 2 + pasillo + 2 = 40.
const PREAJUSTES = {
  minivan: () => Array.from({ length: 4 }, (_, r) => [{ r, c: 0, w: 2 }, { r, c: 3, w: 1 }]).flat(),
  camion: () => Array.from({ length: 10 }, (_, r) => [{ r, c: 0, w: 2 }, { r, c: 3, w: 2 }]).flat()
}
const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`

export function initEditorVehiculo({ rpc, alGuardar }) {
  const sheet = $('#sheet-vehiculo')
  const pasos = { tipo: $('#veh-paso-tipo'), inicio: $('#veh-paso-inicio'), dibujo: $('#veh-paso-dibujo') }
  const lienzo = $('#veh-lienzo')
  const paleta = $('#veh-paleta')
  const footer = $('#veh-footer')
  const basura = $('#veh-basura')
  const nombre = $('#veh-nombre')
  const exclusivo = $('#veh-exclusivo')
  const btnGuardar = $('#btn-veh-guardar')

  let id = null
  let tipo = null
  let bloques = [] // { id, r, c, w }
  let sel = null // bloque seleccionado (para quitarlo)
  let herramienta = null // 1 o 2: tocar un lugar coloca ese bloque
  let siguiente = 1
  let arrastre = null

  const cols = () => COLS[tipo] || 5
  const conId = lista => lista.map(b => ({ id: siguiente++, r: b.r, c: b.c, w: b.w, roto: b.roto === true, extra: b.extra === true, sn: b.sn === true }))
  let numeracionVeh = 'chofer' // 'puerta': cada fila empieza por el lado de la puerta

  // --- PASOS ---
  function mostrar(paso) {
    Object.entries(pasos).forEach(([k, el]) => { el.hidden = k !== paso })
    footer.hidden = paso !== 'dibujo'
    $('#veh-body').scrollTop = 0
    if (paso === 'dibujo') pintar()
  }

  function nuevo() {
    id = null
    tipo = null
    numeracionVeh = 'chofer'
    bloques = []
    sel = null
    herramienta = null
    nombre.value = `Vehículo ${listaCamiones().length + 1}`
    exclusivo.checked = false
    $('#sheet-vehiculo-title').textContent = 'Nuevo vehículo'
    $('#veh-editar-aviso').hidden = true
    mostrar('tipo')
    openSheet(sheet, { onClose: cancelarArrastre })
  }

  function editar(v) {
    id = v.id
    tipo = v.tipo
    numeracionVeh = v.numeracion || 'chofer'
    bloques = conId(v.bloques)
    sel = null
    herramienta = null
    nombre.value = v.nombre
    exclusivo.checked = !!v.exclusivo
    $('#sheet-vehiculo-title').textContent = 'Editar vehículo'
    $('#veh-editar-aviso').hidden = false
    mostrar('dibujo')
    openSheet(sheet, { onClose: cancelarArrastre })
  }

  pasos.tipo.addEventListener('click', async e => {
    const b = e.target.closest('[data-tipo]')
    if (!b) return
    haptic(6)
    const nuevoTipo = b.dataset.tipo
    if (id != null && nuevoTipo !== tipo && bloques.length) {
      // Editando: cambiar de tipo cambia el ancho; lo que no quepa se quita
      const fuera = bloques.filter(x => x.c + x.w > COLS[nuevoTipo])
      if (fuera.length) {
        const ok = await confirm({
          title: `¿Cambiar a ${TIPOS[nuevoTipo].toLowerCase()}?`,
          message: `${plural(fuera.reduce((s, x) => s + x.w, 0), 'asiento no cabe', 'asientos no caben')} en el nuevo ancho y se quitarán.`,
          confirmLabel: 'Cambiar'
        })
        if (!ok) return
        bloques = bloques.filter(x => x.c + x.w <= COLS[nuevoTipo])
      }
      tipo = nuevoTipo
      mostrar('dibujo')
      return
    }
    tipo = nuevoTipo
    const n = PREAJUSTES[tipo]().reduce((s, x) => s + x.w, 0)
    $('#veh-inicio-lead').textContent = `${TIPOS[tipo]}: ¿cómo quieres empezar?`
    $('#veh-preajuste-sub').textContent = `${n} asientos ya acomodados. Puedes moverlos, quitarlos o agregar más.`
    mostrar('inicio')
  })

  pasos.inicio.addEventListener('click', e => {
    const b = e.target.closest('[data-inicio]')
    if (!b) return
    haptic(6)
    bloques = b.dataset.inicio === 'preajuste' ? conId(PREAJUSTES[tipo]()) : []
    sel = null
    herramienta = b.dataset.inicio === 'vacio' ? 2 : null
    mostrar('dibujo')
    if (!bloques.length) toast('Toca un lugar del dibujo para poner una fila de dos', { type: 'info', duration: 3200 })
  })

  $('#btn-veh-atras').addEventListener('click', () => mostrar('tipo'))
  $('#btn-veh-tipo').addEventListener('click', () => mostrar('tipo'))

  // --- DIBUJO ---
  const filas = () => Math.min(FILAS_MAX, Math.max(FILAS_MIN, bloques.reduce((m, b) => Math.max(m, b.r), -1) + 2))

  // Número de cada asiento: de adelante hacia atrás y de izquierda a derecha
  function numeracion() {
    // Igual que privado.armar_asientos: sin número y extras al final y, con «puerta», el lado de la puerta primero
    const lado = c => (numeracionVeh === 'puerta' && c * 2 >= cols() ? 0 : 1)
    const asientos = bloques.filter(b => !b.roto).flatMap(b => Array.from({ length: b.w }, (_, k) => ({ r: b.r, c: b.c + k, id: b.id, extra: b.extra ? 1 : 0, sn: b.sn ? 1 : 0 })))
      .sort((a, b) => a.sn - b.sn || a.extra - b.extra || a.r - b.r || lado(a.c) - lado(b.c) || a.c - b.c)
    const mapa = new Map()
    asientos.forEach((a, i) => mapa.set(`${a.r},${a.c}`, a.sn ? 'S/N' : i + 1))
    return { total: asientos.length, de: (r, c) => mapa.get(`${r},${c}`) }
  }

  function libre(r, c, w, ignorar = null) {
    if (r < 0 || r >= FILAS_MAX || c < 0 || c + w > cols()) return false
    return !bloques.some(b => b.id !== ignorar && b.r === r && c < b.c + b.w && b.c < c + w)
  }

  function pintar() {
    const nf = filas()
    const { total, de } = numeracion()
    $('#veh-tipo-texto').textContent = `${TIPOS[tipo]} · ${cols()} columnas`
    lienzo.style.gridTemplateColumns = `repeat(${cols()}, minmax(0, 1fr))`
    lienzo.style.gridTemplateRows = `repeat(${nf}, var(--veh-celda))`
    let html = ''
    for (let r = 0; r < nf; r++) {
      for (let c = 0; c < cols(); c++) html += `<div class="veh-celda" data-r="${r}" data-c="${c}" style="grid-row:${r + 1};grid-column:${c + 1}"></div>`
    }
    html += bloques.map(b => {
      const nums = Array.from({ length: b.w }, (_, k) => de(b.r, b.c + k))
      return `<button type="button" class="veh-bloque${b.id === sel ? ' is-selected' : ''}${b.roto ? ' is-roto' : ''}" data-id="${b.id}" style="grid-row:${b.r + 1};grid-column:${b.c + 1} / span ${b.w}"
        aria-label="${b.roto ? (b.w === 2 ? 'Fila de dos rota' : 'Asiento roto') : b.w === 2 ? `Fila de dos, asientos ${nums.join(' y ')}` : `Asiento ${nums[0]}`}${b.id === sel ? ', seleccionado' : ''}">
        ${nums.map(n => `<span class="veh-asiento">${n ?? '✕'}</span>`).join('')}
      </button>`
    }).join('')
    lienzo.innerHTML = html
    lienzo.classList.toggle('is-placing', !!herramienta)
    $$('.veh-pieza', paleta).forEach(p => p.setAttribute('aria-pressed', String(Number(p.dataset.w) === herramienta)))
    $('#veh-contador').textContent = plural(total, 'asiento', 'asientos')
    btnGuardar.disabled = total === 0
    const elegido = bloques.find(b => b.id === sel)
    $('#veh-barra-sel').hidden = !elegido
    if (elegido) {
      const nums = Array.from({ length: elegido.w }, (_, k) => de(elegido.r, elegido.c + k))
      $('#veh-sel-texto').textContent = elegido.roto
        ? (elegido.w === 2 ? 'Fila de dos rota' : 'Asiento roto')
        : elegido.w === 2 ? `Fila de dos · asientos ${nums.join(' y ')}` : `Asiento ${nums[0]}`
      $('#btn-veh-roto').textContent = elegido.roto ? 'Ya funciona' : 'Roto'
    }
    $('#veh-ayuda').textContent = herramienta
      ? `Toca un lugar vacío del dibujo para poner ${herramienta === 2 ? 'una fila de dos' : 'un asiento'}. Toca otra vez el bloque de arriba para terminar.`
      : 'Arrastra un bloque al dibujo, o tócalo y luego toca un lugar. Toca un asiento para quitarlo o arrástralo para moverlo.'
  }

  function colocar(r, c, w, mover = null) {
    // Una fila de dos tocada en la última columna se acomoda una a la izquierda
    if (c + w > cols()) c = cols() - w
    if (!libre(r, c, w, mover)) return false
    if (mover != null) {
      const b = bloques.find(x => x.id === mover)
      b.r = r
      b.c = c
    } else {
      bloques.push({ id: siguiente++, r, c, w })
    }
    return true
  }

  // Asiento roto: sigue en el dibujo (en gris) pero no se numera ni se puede apartar
  $('#btn-veh-roto').addEventListener('click', () => {
    const b = bloques.find(x => x.id === sel)
    if (!b) return
    b.roto = !b.roto
    haptic(8)
    pintar()
  })

  function quitar(idBloque) {
    bloques = bloques.filter(b => b.id !== idBloque)
    if (sel === idBloque) sel = null
    haptic([10, 30, 10])
    pintar()
  }

  // Tocar un lugar con una pieza elegida, o tocar un bloque para seleccionarlo
  lienzo.addEventListener('click', e => {
    if (arrastre?.movio) return
    const bloque = e.target.closest('.veh-bloque')
    if (bloque) {
      const idB = Number(bloque.dataset.id)
      sel = sel === idB ? null : idB
      herramienta = null
      haptic(5)
      pintar()
      return
    }
    const celda = e.target.closest('.veh-celda')
    if (!celda) return
    if (!herramienta) {
      if (sel != null) { sel = null; pintar() }
      return
    }
    if (colocar(Number(celda.dataset.r), Number(celda.dataset.c), herramienta)) {
      haptic(8)
      pintar()
    } else {
      haptic([20, 40, 20])
      shake(celda)
    }
  })

  $('#btn-veh-quitar').addEventListener('click', () => { if (sel != null) quitar(sel) })

  $('#btn-veh-vaciar').addEventListener('click', async () => {
    if (!bloques.length) return
    const ok = await confirm({ title: '¿Vaciar el dibujo?', message: 'Se quitan todos los asientos para empezar de cero.', confirmLabel: 'Vaciar', destructive: true })
    if (!ok) return
    bloques = []
    sel = null
    pintar()
  })

  $('#btn-veh-preajuste').addEventListener('click', async () => {
    if (bloques.length) {
      const ok = await confirm({ title: 'Usar el preajuste', message: `El dibujo se reemplaza por el acomodo estándar de ${TIPOS[tipo].toLowerCase()}.`, confirmLabel: 'Reemplazar' })
      if (!ok) return
    }
    bloques = conId(PREAJUSTES[tipo]())
    sel = null
    herramienta = null
    pintar()
  })

  document.addEventListener('keydown', e => {
    if (!sheet.classList.contains('is-open') || pasos.dibujo.hidden || sel == null) return
    if ((e.key === 'Delete' || e.key === 'Backspace') && !e.target.closest('input')) {
      e.preventDefault()
      quitar(sel)
    }
  })

  // --- ARRASTRAR (mouse y dedo) ---
  paleta.addEventListener('pointerdown', e => {
    const pieza = e.target.closest('.veh-pieza')
    if (pieza) iniciar(e, { w: Number(pieza.dataset.w), id: null, origen: pieza })
  })
  lienzo.addEventListener('pointerdown', e => {
    const el = e.target.closest('.veh-bloque')
    if (!el) return
    const b = bloques.find(x => x.id === Number(el.dataset.id))
    if (b) iniciar(e, { w: b.w, id: b.id, origen: el })
  })
  // Tocar una pieza sin arrastrarla la deja lista para colocar con toques
  paleta.addEventListener('click', e => {
    const pieza = e.target.closest('.veh-pieza')
    if (!pieza || arrastre?.movio) return
    const w = Number(pieza.dataset.w)
    herramienta = herramienta === w ? null : w
    sel = null
    haptic(6)
    pintar()
  })

  function iniciar(e, datos) {
    if (e.button > 0) return
    arrastre = { ...datos, x0: e.clientX, y0: e.clientY, movio: false, pid: e.pointerId, destino: null, enBasura: false }
    window.addEventListener('pointermove', mover)
    window.addEventListener('pointerup', soltar)
    window.addEventListener('pointercancel', cancelarArrastre)
  }

  function medidaCelda() {
    const c = lienzo.querySelector('.veh-celda')
    return c ? c.getBoundingClientRect() : { width: 44, height: 44 }
  }

  function mover(e) {
    if (!arrastre || e.pointerId !== arrastre.pid) return
    if (!arrastre.movio) {
      if (Math.hypot(e.clientX - arrastre.x0, e.clientY - arrastre.y0) < 6) return
      arrastre.movio = true
      const m = medidaCelda()
      const fantasma = document.createElement('div')
      fantasma.className = 'veh-fantasma'
      fantasma.style.width = `${m.width * arrastre.w}px`
      fantasma.style.height = `${m.height}px`
      fantasma.innerHTML = '<span class="veh-asiento"></span>'.repeat(arrastre.w)
      document.body.appendChild(fantasma)
      arrastre.fantasma = fantasma
      arrastre.m = m
      lienzo.classList.add('is-dragging')
      arrastre.origen.classList.add('is-origin')
      basura.hidden = arrastre.id == null
      haptic(8)
    }
    e.preventDefault()
    const { m, w } = arrastre
    arrastre.fantasma.style.transform = `translate(${e.clientX - (m.width * w) / 2}px, ${e.clientY - m.height / 2}px)`

    // Celda bajo el dedo: en una fila de dos, el dedo queda entre sus dos asientos
    const x = e.clientX - (w === 2 ? m.width / 2 : 0)
    const celda = document.elementFromPoint(x, e.clientY)?.closest('.veh-celda')
    $$('.veh-celda.is-ok, .veh-celda.is-bad', lienzo).forEach(c => c.classList.remove('is-ok', 'is-bad'))
    arrastre.destino = null
    if (celda) {
      const r = Number(celda.dataset.r)
      const c = Math.min(Number(celda.dataset.c), cols() - w)
      const ok = libre(r, c, w, arrastre.id)
      arrastre.destino = ok ? { r, c } : null
      for (let k = 0; k < w; k++) lienzo.querySelector(`.veh-celda[data-r="${r}"][data-c="${c + k}"]`)?.classList.add(ok ? 'is-ok' : 'is-bad')
    }
    const rb = basura.getBoundingClientRect()
    arrastre.enBasura = !basura.hidden && e.clientX >= rb.left && e.clientX <= rb.right && e.clientY >= rb.top && e.clientY <= rb.bottom
    basura.classList.toggle('is-over', arrastre.enBasura)

    // Cerca de los bordes de la hoja, el dibujo se desplaza solo (una vez que el
    // dedo ya entró al dibujo: al salir de la paleta, que está arriba, no se mueve)
    if (celda) arrastre.entro = true
    if (arrastre.entro) {
      const cuerpo = $('#veh-body')
      const rc = cuerpo.getBoundingClientRect()
      const techo = Math.max(rc.top, paleta.getBoundingClientRect().bottom)
      if (e.clientY > rc.bottom - 56) cuerpo.scrollTop += 14
      else if (e.clientY < techo + 40) cuerpo.scrollTop -= 14
    }
  }

  function soltar(e) {
    if (!arrastre || e.pointerId !== arrastre.pid) return
    const a = arrastre
    if (a.movio) {
      if (a.enBasura && a.id != null) {
        quitar(a.id)
      } else if (a.destino && colocar(a.destino.r, a.destino.c, a.w, a.id)) {
        if (a.id == null) sel = null
        haptic(10)
      } else {
        haptic([20, 40, 20])
      }
    }
    limpiarArrastre()
    if (a.movio) {
      pintar()
      // El clic que llega después de soltar no debe contar como toque
      setTimeout(() => { if (arrastre === a) arrastre = null }, 0)
      arrastre = a
    }
  }

  function limpiarArrastre() {
    window.removeEventListener('pointermove', mover)
    window.removeEventListener('pointerup', soltar)
    window.removeEventListener('pointercancel', cancelarArrastre)
    if (arrastre?.fantasma) arrastre.fantasma.remove()
    arrastre?.origen?.classList.remove('is-origin')
    lienzo.classList.remove('is-dragging')
    $$('.veh-celda.is-ok, .veh-celda.is-bad', lienzo).forEach(c => c.classList.remove('is-ok', 'is-bad'))
    basura.hidden = true
    basura.classList.remove('is-over')
    arrastre = null
  }

  function cancelarArrastre() {
    if (arrastre) limpiarArrastre()
  }

  // --- GUARDAR ---
  btnGuardar.addEventListener('click', async () => {
    const texto = nombre.value.trim()
    if (!texto) {
      nombre.closest('.field').classList.add('is-invalid')
      shake(nombre.closest('.field'))
      nombre.focus()
      return
    }
    if (/[<>&"'`\\]/.test(texto)) {
      toast('El nombre no puede llevar los signos < > & " \' ` \\', { type: 'warning', duration: 3600 })
      shake(nombre.closest('.field'))
      return
    }
    const { total } = numeracion()
    if (!total) {
      toast('Agrega al menos un asiento', { type: 'warning' })
      return
    }
    if (id != null && exclusivo.checked && !vehiculo(id)?.exclusivo) {
      const ok = await confirm({
        title: 'Hacerlo exclusivo de Chinacates',
        message: 'Los alumnos que no son de Chinacates y ya apartaron en este vehículo perderán su lugar (sin cobro) y les llegará un aviso para apartar en otro.',
        confirmLabel: 'Hacerlo exclusivo'
      })
      if (!ok) return
    }
    setLoading(btnGuardar, true)
    const { error } = await rpc('admin_vehiculo_guardar', {
      p_id: id,
      p_nombre: texto,
      p_tipo: tipo,
      p_cols: cols(),
      p_bloques: bloques.map(({ r, c, w, roto, extra, sn }) => ({ r, c, w, ...(roto ? { roto: true } : {}), ...(extra ? { extra: true } : {}), ...(sn ? { sn: true } : {}) })),
      p_exclusivo: exclusivo.checked
    })
    setLoading(btnGuardar, false)
    if (error) {
      toast(error.message || 'No se pudo guardar el vehículo', { type: 'error', duration: 4500 })
      return
    }
    haptic([10, 40, 14])
    await closeSheet(sheet)
    toast(id == null ? `${texto} listo · ${plural(total, 'asiento', 'asientos')}` : 'Vehículo actualizado', { type: 'success' })
    alGuardar?.()
  })

  nombre.addEventListener('input', () => nombre.closest('.field').classList.remove('is-invalid'))

  return { nuevo, editar }
}
