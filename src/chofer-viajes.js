// =====================================================================
// Vans: no siempre salen, así que cada salida aparece para apartar solo
// cuando el chofer activa el viaje. Los camiones siempre aparecen.
// =====================================================================
import { $, esc, haptic, toast, confirm, setLoading } from './ui.js'
import { claveSalida, horaTexto, etiquetaDia } from './asientos.js'

export function initChoferViajes({ rpc, camion }) {
  const card = $('#driver-viajes')
  const lista = $('#driver-viajes-list')
  let salidas = []
  let peticion = 0

  async function cargar() {
    const bus = camion()
    if (!bus) return limpiar()
    const id = ++peticion
    const { data, error } = await rpc('chofer_salidas', { p_camion: bus })
    // Llegó tarde: el chofer ya cambió de vehículo
    if (id !== peticion || bus !== camion() || error) return
    salidas = (data || []).filter(s => s.van && new Date(s.salida_en) > Date.now())
    pintar()
  }

  function limpiar() {
    peticion++
    salidas = []
    card.hidden = true
  }

  function pintar() {
    card.hidden = !salidas.length
    lista.innerHTML = salidas.slice(0, 4).map(s => {
      const estado = s.activa
        ? s.ocupados ? `Activado · ${s.ocupados} ${s.ocupados === 1 ? 'apartado' : 'apartados'}` : 'Activado · los alumnos ya pueden apartar'
        : 'Sin activar · los alumnos no lo ven'
      // Con apartados ya no se desactiva: si no sale, se usa Emergencia (avisa y libera)
      const boton = !s.activa
        ? `<button type="button" class="btn btn-sm btn-primary" data-activar="1" data-k="${esc(claveSalida(s))}">Activar viaje</button>`
        : !s.ocupados
          ? `<button type="button" class="btn btn-sm btn-secondary" data-activar="0" data-k="${esc(claveSalida(s))}">Desactivar</button>`
          : ''
      return `<div class="row viaje-row${s.activa ? ' is-activo' : ''}">
        <span class="row-text"><span class="row-title">${esc(etiquetaDia(s.fecha))} · ${esc(horaTexto(s.hora))} · ${s.tipo === 'REGRESO' ? 'Regreso' : 'Ida'}</span>
        <span class="row-sub">${estado}</span></span>
        ${boton}
      </div>`
    }).join('')
  }

  lista.addEventListener('click', async e => {
    const btn = e.target.closest('[data-activar]')
    if (!btn) return
    const s = salidas.find(x => claveSalida(x) === btn.dataset.k)
    if (!s) return
    const activar = btn.dataset.activar === '1'
    if (!activar) {
      const ok = await confirm({
        title: '¿Desactivar este viaje?',
        message: `La salida de las ${horaTexto(s.hora)} dejará de aparecer para que los alumnos aparten.`,
        confirmLabel: 'Desactivar',
        destructive: true
      })
      if (!ok) return
    }
    haptic(8)
    setLoading(btn, true)
    const { error } = await rpc('chofer_activar_viaje', { p_camion: s.camion, p_fecha: s.fecha, p_hora: s.hora, p_activar: activar })
    setLoading(btn, false)
    if (error) {
      toast(error.message || 'No se pudo cambiar el viaje', { type: 'error', duration: 5000 })
      return
    }
    toast(activar ? `Viaje de las ${horaTexto(s.hora)} activado: ya aparece para apartar` : 'Viaje desactivado', { type: 'success' })
    cargar()
  })

  return { cargar, limpiar }
}
