---
tags: [camify, tecnico]
actualizado: 2026-11-19
---

# Arquitectura

Volver a [Inicio](../Inicio.md)

- **Frontend**: PWA con Vite, JavaScript sin framework (`src/*.js`, `index.html`, `public/sw.js`). Service worker con caché `camify-vN` (navegación primero a la red).
- **Backend**: Supabase, proyecto `askluzbhppbfmjfecmtn`, **plan gratis**. Todo pasa por funciones RPC con rol `anon` + token de sesión propio (no se usa Supabase Auth). Ver [Base de datos](Base%20de%20datos.md).
- **Hosting**: Cloudflare Pages. **Cada push a `main` se publica solo** en camify.lat (~1 min). Cloudflare oculta los correos de las páginas (se ven bien en el navegador).
- **Push**: función de Supabase `enviar-push` (web-push, sin JWT).
- **Repositorio**: commits sin línea de coautoría de Claude.

## Migraciones
- Carpeta `supabase/migrations/`, nombre `AAAAMMDDhhmmss_descripcion.sql`.
- Muchas migraciones viejas redefinen funciones con `replace()` sobre el texto de la versión anterior. **La versión vigente es la de producción** (`pg_get_functiondef`), no la del primer archivo que aparece.
- Cambios a producción: solo con visto bueno explícito del responsable.

## Límites del plan gratis que importan
- `anon` tiene `statement_timeout = 3s`: una operación que tarde más se cancela.
- Tiempo real: **100 mensajes/s** y 200 conexiones; si se pasa, Supabase desconecta a todos. 2 millones de mensajes al mes.
- Ver [Tiempo real y carga](Tiempo%20real%20y%20carga.md).
