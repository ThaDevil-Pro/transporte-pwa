// Instalar la app y notificaciones push
// - Android / Chrome: el navegador ofrece instalar (beforeinstallprompt) y se abre su ventana.
// - iPhone: Apple no deja instalar desde una página; se muestran los pasos (Compartir → Agregar a inicio).
//   En iPhone las notificaciones solo funcionan con la app instalada (iOS 16.4 o más nuevo).
import { $, esc, icon, toast, setLoading, openSheet, haptic } from './ui.js'
import { supabase } from './supabase.js'

const PUBLICA = 'BJMOG3H9_KW__Bc_LPjvPMX87PCqdwwFBjnI0Lv0doys23jdXjlsUco4U3BBg1llcyEaBFmJl1XBTDCnpH3P--A'
const POSPUESTO_KEY = 'camify.push.pospuesto'
const UNA_SEMANA = 7 * 24 * 3600 * 1000

const ua = navigator.userAgent
export const esIOS = () => /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
export const instalada = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true
// Navegadores dentro de otras apps (Instagram, Facebook, TikTok...): ahí no se puede instalar
const enOtraApp = () => /Instagram|FBAN|FBAV|FB_IAB|Line\/|Snapchat|TikTok|musical_ly|; wv\)/i.test(ua)
const pushSoportado = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

let pedidoInstalar = null // evento beforeinstallprompt guardado

// ---------- INSTALAR ----------
export function initInstalar({ boton }) {
  // Siempre visible mientras la app no esté instalada
  const pintar = () => { boton.hidden = instalada() }

  addEventListener('beforeinstallprompt', e => {
    e.preventDefault()
    pedidoInstalar = e
    pintar()
  })
  addEventListener('appinstalled', () => {
    pedidoInstalar = null
    pintar()
    toast('Listo: CAMIFY ya está en tu pantalla de inicio', { type: 'success', duration: 4000 })
  })

  boton.addEventListener('click', instalar)
  pintar()
}

export async function instalar() {
  haptic()
  if (pedidoInstalar) {
    const e = pedidoInstalar
    pedidoInstalar = null
    // La ventana de instalar de Android/Chrome solo se puede abrir una vez por aviso del navegador
    e.prompt()
    await e.userChoice.catch(() => null)
    return
  }
  // iPhone, otra app o un navegador que no ofrece instalar solo: pasos a mano
  const otraApp = enOtraApp()
  $('#instalar-otra-app').hidden = !otraApp
  $('#instalar-ios').hidden = otraApp || !esIOS()
  $('#instalar-android').hidden = otraApp || esIOS()
  openSheet('sheet-instalar')
}

// ---------- NOTIFICACIONES ----------
function llaveBytes(base64) {
  const relleno = '='.repeat((4 - base64.length % 4) % 4)
  const bin = atob((base64 + relleno).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(bin, c => c.charCodeAt(0))
}

async function registro() {
  if (!('serviceWorker' in navigator)) return null
  return navigator.serviceWorker.getRegistration()
}

// La primera vez que se abre la app el service worker se registra al terminar de cargar: se espera
async function registroListo() {
  const reg = await registro()
  if (reg?.active) return reg
  if (!('serviceWorker' in navigator)) return null
  return Promise.race([navigator.serviceWorker.ready, new Promise(r => setTimeout(() => r(null), 15000))])
}

async function suscribir(rpc) {
  const reg = await registroListo()
  if (!reg) throw new Error('La app todavía se está preparando. Intenta en un momento.')
  let sub = await reg.pushManager.getSubscription()
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: llaveBytes(PUBLICA) })
  const { endpoint, keys } = sub.toJSON()
  const { error } = await rpc('push_suscribir', { p_endpoint: endpoint, p_p256dh: keys.p256dh, p_auth: keys.auth })
  if (error) throw new Error(error.message)
}

export function initPush({ rpc, contenedor }) {
  const leer = () => { try { return Number(localStorage.getItem(POSPUESTO_KEY)) || 0 } catch { return 0 } }
  const pospuesto = () => Date.now() - leer() < UNA_SEMANA
  const ocultar = () => { contenedor.innerHTML = '' }

  function tarjeta({ titulo, texto, boton, accion }) {
    contenedor.innerHTML = `<article class="alert-card push-card">
      <span class="row-icon tint-blue">${icon('i-bell')}</span>
      <div class="alert-text">
        <p class="alert-title">${esc(titulo)}</p>
        <p class="alert-msg">${esc(texto)}</p>
        <div class="button-row">
          <button class="btn btn-secondary" data-push="despues">Ahora no</button>
          <button class="btn btn-primary" data-push="${accion}">${esc(boton)}</button>
        </div>
      </div>
    </article>`
  }

  contenedor.addEventListener('click', async e => {
    const btn = e.target.closest('[data-push]')
    if (!btn) return
    if (btn.dataset.push === 'despues') {
      try { localStorage.setItem(POSPUESTO_KEY, String(Date.now())) } catch { /* modo privado */ }
      ocultar()
      return
    }
    if (btn.dataset.push === 'instalar') { instalar(); return }
    // Activar: el permiso se pide dentro del toque (iPhone lo exige)
    setLoading(btn, true)
    try {
      const permiso = await Notification.requestPermission()
      if (permiso !== 'granted') {
        ocultar()
        toast(permiso === 'denied'
          ? 'Bloqueaste las notificaciones. Puedes activarlas en los ajustes de tu teléfono.'
          : 'No se activaron las notificaciones', { type: 'warning', duration: 4500 })
        return
      }
      await suscribir(rpc)
      ocultar()
      haptic([10, 40, 14])
      toast('Notificaciones activadas', { type: 'success' })
    } catch (err) {
      setLoading(btn, false)
      toast(err.message || 'No se pudieron activar las notificaciones', { type: 'error', duration: 4500 })
    }
  })

  return {
    // Al entrar el alumno: si ya dio permiso, se vuelve a ligar el teléfono a su cuenta en silencio
    async alEntrar() {
      ocultar()
      if (!pushSoportado()) {
        if (esIOS() && !instalada() && !pospuesto()) {
          tarjeta({ titulo: 'Recibe avisos en tu iPhone', texto: 'Instala CAMIFY en tu pantalla de inicio para que te avise cuando tu camión esté abordando.', boton: 'Cómo instalar', accion: 'instalar' })
        }
        return
      }
      if (Notification.permission === 'granted') {
        suscribir(rpc).catch(err => console.warn('push:', err.message))
        return
      }
      if (Notification.permission === 'default' && !pospuesto()) {
        tarjeta({ titulo: 'Activa las notificaciones', texto: 'Te avisamos cuando tu camión esté abordando, si cambia tu asiento o si hay una emergencia.', boton: 'Activar', accion: 'activar' })
      }
    },
    // Antes de cerrar sesión: este teléfono deja de recibir los avisos de esta cuenta
    async alSalir(token) {
      ocultar()
      try {
        const sub = await (await registro())?.pushManager.getSubscription()
        // Directo (sin el rpc de la app) para no volver a disparar el cierre de sesión si falla
        if (sub && token) await supabase.rpc('push_desuscribir', { p_token: token, p_endpoint: sub.endpoint })
      } catch { /* sin conexión: la suscripción se reemplaza cuando entre otra cuenta */ }
    }
  }
}
