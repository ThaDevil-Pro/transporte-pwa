// CAMIFY · Entrega de notificaciones push
// La base (pg_net) manda un lote de mensajes ya armados; aquí solo se cifran y se entregan.
// Solo firma con la llave pública de CAMIFY: sin la privada correcta, los servicios de push
// rechazan el envío, así que esta función no sirve para mandar push de nadie más.
import webpush from 'npm:web-push@3.6.7'

const PUBLICA = 'BJMOG3H9_KW__Bc_LPjvPMX87PCqdwwFBjnI0Lv0doys23jdXjlsUco4U3BBg1llcyEaBFmJl1XBTDCnpH3P--A'
const SERVICIOS = /^https:\/\/([a-z0-9-]+\.)*(fcm\.googleapis\.com|android\.googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)\//

type Mensaje = { endpoint: string; p256dh: string; auth: string; datos: Record<string, string> }

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Método no permitido', { status: 405 })

  let cuerpo: { vapid?: { publica?: string; privada?: string }; mensajes?: Mensaje[]; limpieza?: string }
  try { cuerpo = await req.json() } catch { return new Response('JSON inválido', { status: 400 }) }

  const { vapid, mensajes, limpieza } = cuerpo
  if (vapid?.publica !== PUBLICA || !vapid.privada || !Array.isArray(mensajes) || mensajes.length > 500) {
    return new Response('Solicitud inválida', { status: 400 })
  }
  webpush.setVapidDetails('https://camify.lat', PUBLICA, vapid.privada)

  const vencidas: string[] = []
  let enviadas = 0
  await Promise.all(mensajes.map(async (m) => {
    if (typeof m?.endpoint !== 'string' || !SERVICIOS.test(m.endpoint)) return
    try {
      await webpush.sendNotification(
        { endpoint: m.endpoint, keys: { p256dh: m.p256dh, auth: m.auth } },
        JSON.stringify(m.datos ?? {}),
        { TTL: 6 * 3600, urgency: 'high' }
      )
      enviadas++
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode
      if (status === 404 || status === 410) vencidas.push(m.endpoint)
      else console.error('push', status, (e as Error).message)
    }
  }))

  // Suscripciones que el teléfono ya quitó: se borran para no volver a intentarlas
  if (vencidas.length && limpieza) {
    const url = Deno.env.get('SUPABASE_URL')
    const anon = Deno.env.get('SUPABASE_ANON_KEY')
    if (url && anon) {
      await fetch(`${url}/rest/v1/rpc/push_limpiar`, {
        method: 'POST',
        headers: { apikey: anon, Authorization: `Bearer ${anon}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_clave: limpieza, p_endpoints: vencidas })
      }).catch((e) => console.error('limpieza', e.message))
    }
  }

  return Response.json({ enviadas, vencidas: vencidas.length })
})
