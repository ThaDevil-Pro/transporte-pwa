---
tags: [camify, indice]
actualizado: 2026-11-19
---

# CAMIFY · Inicio

App de transporte escolar del **TecNM Campus Santiago Papasquiaro**: los alumnos apartan asiento, suben con código QR, se les cobra por día y reciben avisos. Dominio: **camify.lat**.

> Regla de oro para quien trabaje aquí (persona o IA): **antes de afirmar qué hace la app, léelo en la base de producción o en el código**, no en una sola función ni de memoria. Las funciones se redefinieron muchas veces en las migraciones; la versión que vale es la de producción.

## Mapa

**Cómo funciona el negocio**
- [Cobros y adeudos](negocio/Cobros%20y%20adeudos.md): boleto diario, límites de $60 y $600, pagos.
- [Apartados y asientos](negocio/Apartados%20y%20asientos.md): ventana de 12 h, un viaje a la vez, parejas, liberar.
- [Viaje del chofer](negocio/Viaje%20del%20chofer.md): jornada, conteo, abordaje, corte y finalizar.
- [Roles y cuentas](negocio/Roles%20y%20cuentas.md): Estudiante, Chofer, Admin, Financiero; sesiones y bloqueos.
- [Buzón y fallas](negocio/Buzón%20y%20fallas.md): quejas, filtro de groserías, fallas y emergencias.
- [Notificaciones](negocio/Notificaciones.md): qué avisa a quién.

**Cómo está hecho**
- [Arquitectura](tecnico/Arquitectura.md): Vite PWA, Supabase, Cloudflare Pages, despliegue.
- [Base de datos](tecnico/Base%20de%20datos.md): patrón de funciones, esquema privado, tablas.
- [Tiempo real y carga](tecnico/Tiempo%20real%20y%20carga.md): por qué el mapa consulta cada 3 s.
- [Pruebas locales](tecnico/Pruebas%20locales.md): simulador PGlite y Postgres real.

**Seguimiento**
- [Decisiones](Decisiones.md): qué se decidió y por qué, con fecha.
- [Pendientes](Pendientes.md)
- [Comunicación con alumnos](Comunicación%20con%20alumnos.md): quejas recibidas y comunicados.
