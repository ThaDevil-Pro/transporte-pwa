---
tags: [camify, tecnico, rendimiento]
actualizado: 2026-11-22
---

# Tiempo real y carga

Volver a [Inicio](../Inicio.md) · Decisión del 2026-11-19 en [Decisiones](../Decisiones.md)

## Problema encontrado
Prueba con 150 alumnos apartando a la vez (Postgres real, ver [Pruebas locales](Pruebas%20locales.md)). Antes, cada apartado avisaba en vivo a **todos** los teléfonos y cada uno recargaba su mapa al instante:

| | Antes | Después |
|---|---|---|
| Apartar (mediana) | 2.1 s | 0.017 s |
| Peticiones | 518/s | 95/s |
| Mensajes en vivo | ~2,600/s (límite 100/s) | 0 |
| Asientos duplicados | 0 | 0 |

## Cómo quedó
- **Mapa abierto**: se consulta cada 2.5–3.5 s (al azar), solo con la app en pantalla.
- **Salidas, pareja y avisos del alumno**: cada 25–35 s y al volver a la app. Lo urgente llega por push.
- **Desde 2026-11-22 solo el personal (choferes, admins, finanzas) abre conexión en vivo**: `estado_viaje`, `horarios_matriz`, buzón (`clave=in.(quejas,fallas)`) y diesel (`clave=eq.diesel`). Ni el alumno ni la pantalla de entrada se conectan.
- **Alumno**: estado de los camiones cada 15–25 s (tarjeta del viaje) y horarios cada ~2 min, solo con la app a la vista.
- **Mapa del chofer**: se consulta cada 10 s (antes escuchaba en vivo *todos* los apartados de *todas* las unidades: en la hora pico, cada apartado se multiplicaba por cada chofer).
- Los avisos masivos (emergencia: uno por alumno) marcan `actividad` **una vez por operación**, no por alumno.

Por qué: el plan gratis permite **100 mensajes en vivo por segundo y 200 conexiones**. Cada cambio se manda a cada teléfono conectado: con 150 alumnos, iniciar un conteo eran 150 mensajes de golpe y Supabase desconecta a todos al pasarse.

**No volver** a conectar en vivo a los alumnos.
