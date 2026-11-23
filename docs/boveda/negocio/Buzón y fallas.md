---
tags: [camify, negocio, buzon]
actualizado: 2026-11-23
---

# Buzón y fallas

Volver a [Inicio](../Inicio.md)

## Quejas de alumnos
- `alumno_queja_enviar`: categoría (servicio, chofer, camión, horario, otro), vehículo opcional, mensaje.
- **Filtro de groserías** (desde 2026-11-18, migración `buzon_sin_groserias`): si el mensaje tiene una grosería o insulto **no se envía** (error `CMF06`). Normaliza letras cambiadas por números, acentos, letras repetidas y formas fonéticas; detecta español e inglés y abreviaturas. Funciones `privado.ofensa*`.
- La administración responde o marca atendida (`admin_queja_actualizar`) → el alumno recibe aviso.
- Los choferes ven las quejas sin el nombre del alumno.

## Fallas y emergencias del chofer
- `chofer_falla_reportar`: tipo, gravedad, descripción (máx. 15 al día).
- `chofer_emergencia` (descompuesto / no disponible, máx. 3 por hora): crea una falla grave con texto "EMERGENCIA: …" y notifica a admins y otros choferes. Desde 2026-11-23:
  - La unidad queda **fuera de servicio el resto del día** (`estado_viaje.fuera_hasta`): no aparece para apartar y no se puede apartar en ella (`privado.motivo_no_aparta`).
  - Sus apartados de hoy se liberan sin cobro.
  - El aviso llega **solo** a quien tenía apartado en ella y a quien viajó en ella en los últimos 14 días (las unidades no tienen ubicación fija).
  - El chofer («Ya está reparado» en su panel) o un admin (Vehículos → «Marcar como reparado») la regresan antes con `vehiculo_reparado`.
- Desde 2026-11-22 además **libera sin cobro los apartados de esa unidad** que no han salido y a esos alumnos su aviso les dice qué salida se liberó. Antes quedaban bloqueados por "un viaje a la vez". La unidad sigue apareciendo para apartar: si va a estar fuera varios días, pasar sus salidas a otra unidad en **Horarios**.
- El admin cambia el estado (abierta / en reparación / resuelta) → push al chofer.
