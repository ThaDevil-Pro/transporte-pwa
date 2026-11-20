---
tags: [camify, tecnico, pruebas]
actualizado: 2026-11-19
---

# Pruebas locales

Volver a [Inicio](../Inicio.md)

Nada de esto toca producción. Los scripts viven en una carpeta temporal de sesión (no en el repo); si se pierden, se rehacen con esta descripción.

- **Simulador** (`servidor.mjs` en el puerto 54321): imita la API de Supabase (RPC con rol `anon`) y el tiempo real, sobre:
  - **PGlite** (Postgres en WASM, una conexión): rápido para probar lógica.
  - **Postgres 18 real** (`PG=postgres://…`, pool de 15 conexiones, `statement_timeout` de 3 s): para pruebas de carga. Se usa un clúster propio en el puerto 55432, no el servicio instalado.
- Aplica todas las migraciones del repo; `pg_net` se simula con una tabla `net.cola`.
- `sembrar.mjs` crea admin, choferes, vehículos, horarios y alumnos con sesiones.
- App compilada contra el simulador: `VITE_SUPABASE_URL=http://localhost:54321 vite build` y `vite preview` en el puerto 5181; Puppeteer para revisar pantallas.
