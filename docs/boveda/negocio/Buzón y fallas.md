---
tags: [camify, negocio, buzon]
actualizado: 2026-11-19
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
- `chofer_emergencia` (descompuesto / no disponible, máx. 3 por hora): avisa a **todos los alumnos**, crea una falla grave con texto "EMERGENCIA: …" y notifica a admins y otros choferes.
- El admin cambia el estado (abierta / en reparación / resuelta) → push al chofer.
