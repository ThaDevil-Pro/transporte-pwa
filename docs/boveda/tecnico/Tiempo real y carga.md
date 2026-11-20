---
tags: [camify, tecnico, rendimiento]
actualizado: 2026-11-19
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
- **Canales en vivo** con filtro: buzón `clave=in.(quejas,fallas)`, diesel `clave=eq.diesel`. El canal del mapa del chofer solo existe mientras tiene abierta esa pestaña.
- `estado_viaje` y `horarios_matriz` siguen en vivo para todos (cambian poco).

**No volver** a suscribir a todos los alumnos a cambios por cada apartado.
