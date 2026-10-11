// Service worker de CAMIFY
// - Páginas: red primero (siempre la versión más reciente), caché si no hay conexión
// - Archivos estáticos (JS/CSS/imágenes/video): caché primero
// - Supabase y otros orígenes: nunca se cachean (datos en vivo)

const CACHE = 'camify-v2'
const PRECACHE = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/favicon.svg']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(PRECACHE)))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)

  if (request.method !== 'GET' || url.origin !== self.location.origin) return

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(res => {
          const copia = res.clone()
          caches.open(CACHE).then(cache => cache.put('/', copia))
          return res
        })
        .catch(() => caches.match('/'))
    )
    return
  }

  // El video usa peticiones Range; se deja pasar directo a la red
  if (request.headers.has('range')) return

  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached
      return fetch(request).then(res => {
        if (res.ok && res.type === 'basic') {
          const copia = res.clone()
          caches.open(CACHE).then(cache => cache.put(request, copia))
        }
        return res
      })
    })
  )
})
