// =====================================================================
// Registro manual del chofer: busca a un alumno por nombre o número de
// control y lo sube a la lista sin QR (para quien no trae su código).
// El servidor marca el abordaje como manual y lo anota en la bitácora.
// =====================================================================
import { camionCorto, htmlRotos, plantillaColumnas, posicion, asiento as asientoDe, vecino, vehiculo, UBICACIONES } from './camiones.js'
import { $, $$, esc, icon, avatar, initials, haptic, toast, confirm, openSheet, closeSheet } from './ui.js'

const MINIMO = 2
const ESPERA_MS = 220
const AYUDA = 'Escribe al menos 2 letras o números.'

const primerNombre = nombre => String(nombre ?? '').trim().split(/\s+/)[0] || ''

export function initChoferManual({ rpc, camion, alRegistrar }) {
  const input = $('#manual-search')
  const lista = $('#manual-results')
  const estado = $('#manual-status')
  let resultados = []
  let activo = -1
  let peticion = 0
  let espera = null
  let registrando = false

  // bloqueado: su adeudo pasa de $600 (el servidor tampoco lo dejaría subir)
  const disponible = a => a.camion == null && !a.bloqueado

  function abrir() {
    limpiar()
    openSheet('sheet-manual', {
      onClose: () => {
        clearTimeout(espera)
        peticion++
      }
    })
    // Después de la animación de entrada (la hoja enfoca su panel al abrir)
    setTimeout(() => input.focus({ preventScroll: true }), 380)
  }

  function limpiar() {
    clearTimeout(espera)
    peticion++
    input.value = ''
    resultados = []
    activo = -1
    pintar()
    estado.textContent = AYUDA
  }

  input.addEventListener('input', () => {
    clearTimeout(espera)
    const texto = input.value.trim()
    if (texto.length < MINIMO) {
      peticion++
      resultados = []
      activo = -1
      pintar()
      estado.textContent = AYUDA
      return
    }
    estado.textContent = 'Buscando…'
    espera = setTimeout(() => buscar(texto), ESPERA_MS)
  })

  async function buscar(texto) {
    const id = ++peticion
    const { data, error } = await rpc('chofer_buscar_alumnos', { p_texto: texto })
    // Llegó tarde: ya se escribió otra cosa
    if (id !== peticion) return
    if (error) {
      estado.textContent = 'No se pudo buscar. Revisa tu conexión.'
      return
    }
    resultados = Array.isArray(data) ? data : []
    activo = resultados.findIndex(disponible)
    pintar()
    if (!resultados.length) estado.textContent = `Nadie coincide con “${texto}”.`
    else if (resultados.length === 8) estado.textContent = 'Estos son los primeros 8. Escribe más para afinar.'
    else estado.textContent = resultados.length === 1 ? '1 alumno encontrado.' : `${resultados.length} alumnos encontrados.`
  }

  function pintar() {
    lista.hidden = !resultados.length
    input.setAttribute('aria-expanded', String(resultados.length > 0))
    if (activo >= 0) input.setAttribute('aria-activedescendant', `manual-opt-${activo}`)
    else input.removeAttribute('aria-activedescendant')

    lista.innerHTML = resultados.map((a, i) => {
      const abordo = !disponible(a)
      const mat = `${esc(a.matricula)}${UBICACIONES[a.ubicacion] ? ` · ${UBICACIONES[a.ubicacion].nombre}` : ''}`
      const sub = a.camion != null
        ? `${mat} · Ya va en el camión ${esc(camionCorto(a.camion))}`
        : a.bloqueado ? `${mat} · No puede subir: debe más de $600`
          : mat
      return `<button type="button" class="row" role="option" id="manual-opt-${i}" data-i="${i}" aria-selected="${i === activo}"${abordo ? ' aria-disabled="true"' : ''} tabindex="-1">
        ${avatar(a.nombre)}
        <span class="row-text"><span class="row-title">${esc(a.nombre)}</span><span class="row-sub">${sub}</span></span>
        <span class="row-trailing">${icon(a.camion != null ? 'i-check' : a.bloqueado ? 'i-lock' : 'i-plus')}</span>
      </button>`
    }).join('')
  }

  // Flechas: recorre solo a quienes todavía pueden subir
  function mover(paso) {
    if (!resultados.some(disponible)) return
    let i = activo
    do {
      i = (i + paso + resultados.length) % resultados.length
    } while (!disponible(resultados[i]))
    activo = i
    pintar()
    $(`#manual-opt-${activo}`)?.scrollIntoView({ block: 'nearest' })
  }

  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); mover(1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); mover(-1) }
    else if (e.key === 'Enter') {
      e.preventDefault()
      if (activo >= 0) elegir(activo)
    }
  })

  lista.addEventListener('click', e => {
    const fila = e.target.closest('.row')
    if (fila) elegir(Number(fila.dataset.i))
  })

  async function elegir(i) {
    const a = resultados[i]
    if (!a || registrando) return
    if (!disponible(a)) {
      toast(a.camion != null
        ? `${primerNombre(a.nombre)} ya va en ${camionCorto(a.camion)}`
        : `${primerNombre(a.nombre)} debe más de $600: tiene que pagar en la administración`, { type: 'warning' })
      return
    }
    const bus = camion()
    registrando = true
    const { data: mapa, error: errorMapa } = await rpc('chofer_mapa_actual', { p_camion: bus })
    registrando = false
    if (errorMapa) {
      toast('No se pudo cargar el mapa de asientos. Revisa tu conexión.', { type: 'error' })
      return
    }
    let asiento = null
    if (mapa) {
      // undefined = cerró la hoja sin elegir
      asiento = await elegirAsiento(a, bus, mapa)
      if (asiento === undefined) {
        input.focus({ preventScroll: true })
        return
      }
    } else {
      // Sin salida programada no hay mapa de asientos: sube sin asiento
      const ok = await confirm({
        title: `¿Subir a ${a.nombre}?`,
        message: `${a.matricula} · ${camionCorto(bus)}. No hay una salida programada, así que sube sin asiento. Se le cobrará en el corte.`,
        confirmLabel: 'Subir'
      })
      if (!ok) {
        input.focus({ preventScroll: true })
        return
      }
    }

    registrando = true
    const { data, error } = await rpc('chofer_abordar_manual', { p_camion: bus, p_matricula: a.matricula, p_asiento: asiento })
    registrando = false
    if (error) {
      haptic([30, 50, 30])
      toast(error.message || 'No se pudo registrar', { type: 'error' })
      input.focus({ preventScroll: true })
      return
    }

    haptic(30)
    toast(data.de_pie
      ? `Vehículo lleno: ${primerNombre(data.nombre)} irá de pie`
      : `${primerNombre(data.nombre)} está a bordo${data.asiento ? ` · Asiento ${data.asiento}` : ''}`, { type: data.de_pie ? 'warning' : 'success' })
    // Lista lista para el siguiente alumno sin código
    limpiar()
    input.focus({ preventScroll: true })
    alRegistrar()
  }

  // Mapa de la salida en curso para elegir asiento. Resuelve con el número,
  // null si va de pie (no queda ninguno libre) o undefined si se cancela.
  const grid = $('#manual-seat-grid')
  const btnOk = $('#btn-manual-seat-ok')

  function elegirAsiento(a, bus, mapa) {
    return new Promise(resolve => {
      let elegido = mapa.asientos.find(x => x.matricula === a.matricula)?.n ?? null
      // Si ya apartó (sola o con su compañero de viaje), se le marca dónde va y de qué lado
      const apartado = elegido
      const parN = apartado != null && mapa.asientos.find(x => x.n === apartado)?.con_pareja ? vecino(bus, apartado) : null
      const libres = mapa.asientos.filter(x => !x.nombre).length
      const dePie = !libres && elegido == null
      const seat = x => {
        const mio = x.matricula === a.matricula
        const estado = mio ? 'mio' : x.n === parN ? 'pareja' : x.nombre ? 'ocupado' : 'libre'
        const bloqueado = estado === 'ocupado' || estado === 'pareja'
        return `<button type="button" class="seat${mio ? ' is-selected' : ''}" style="${posicion(bus, x.n)}" data-n="${x.n}" data-estado="${estado}"${bloqueado ? ' disabled' : ''} aria-label="Asiento ${x.n}${estado === 'pareja' ? `, de su compañero de viaje ${esc(x.nombre)}` : estado === 'ocupado' ? `, ocupado por ${esc(x.nombre)}` : ''}">${estado === 'ocupado' ? esc(initials(x.nombre)) : x.n}</button>`
      }
      grid.style.gridTemplateColumns = plantillaColumnas(bus)
      grid.innerHTML = mapa.asientos.map(seat).join('') + htmlRotos(bus)
      $('#manual-seat-bus-name').textContent = `${camionCorto(bus)}`
      const leyenda = $('#manual-seat-apartado')
      leyenda.hidden = apartado == null
      $('#sheet-manual-seat-title').textContent = apartado != null ? 'Su asiento apartado' : 'Elige su asiento'
      if (apartado != null) {
        // El volante está a la izquierda y la puerta a la derecha (como en el dibujo del mapa)
        const lado = asientoDe(bus, apartado)?.c < (vehiculo(bus)?.cols || 5) / 2 ? 'lado del chofer' : 'lado de la puerta'
        leyenda.innerHTML = parN
          ? `<b>Asientos ${Math.min(apartado, parN)}-${Math.max(apartado, parN)}</b><span>con su compañero de viaje · ${lado}</span>`
          : `<b>Asiento ${apartado}</b><span>${lado}</span>`
      }
      $('#manual-seat-lead').textContent = apartado != null
        ? `${a.nombre} ya apartó para la salida de las ${mapa.hora} (${mapa.tipo === 'REGRESO' ? 'regreso' : 'ida'}).`
        : dePie
          ? `${a.nombre} · El vehículo va lleno: no queda ningún asiento libre, irá de pie.`
          : `${a.nombre} · Salida de las ${mapa.hora} (${mapa.tipo === 'REGRESO' ? 'regreso' : 'ida'}). Toca un asiento libre.`
      btnOk.textContent = dePie ? 'Subir de pie' : elegido ? `Subir · Asiento ${elegido}` : 'Subir'
      btnOk.disabled = !dePie && elegido == null

      let listo = false
      const terminar = v => {
        if (listo) return
        listo = true
        grid.onclick = null
        btnOk.onclick = null
        resolve(v)
      }
      grid.onclick = e => {
        const b = e.target.closest('.seat:not(:disabled)')
        if (!b) return
        haptic(6)
        elegido = Number(b.dataset.n)
        $$('.seat', grid).forEach(x => x.classList.toggle('is-selected', x === b))
        btnOk.textContent = `Subir · Asiento ${elegido}`
        btnOk.disabled = false
      }
      btnOk.onclick = () => {
        terminar(dePie ? null : elegido)
        closeSheet('sheet-manual-seat')
      }
      openSheet('sheet-manual-seat', { onClose: () => terminar(undefined) })
    })
  }

  return { abrir }
}
