---
tags: [camify, negocio, chofer]
actualizado: 2026-11-21
---

# Viaje del chofer

Volver a [Inicio](../Inicio.md)

Estado de cada vehículo en `estado_viaje` (`estado`: ESPERANDO / EN_CAMINO, `temporizador_activo`, `tiempo_salida`).

1. **Jornada**: el chofer elige su vehículo del día (`chofer_elegir_vehiculo` → `privado.jornadas`). Un vehículo, un chofer por día.
2. **Conteo**: inicia el temporizador de salida (`chofer_temporizador`). Al iniciarlo, se manda push "Tu camión ya está abordando" a quien apartó esa salida.
3. **Abordaje**: escanea el QR del alumno (`chofer_registrar_abordaje`) o lo registra a mano (`chofer_abordar_manual`). Lista en `abordajes`.
4. **Corte** (`chofer_hacer_corte`): cobra a todos los de la lista ([Cobros y adeudos](Cobros%20y%20adeudos.md)), marca perdidos y pasa a **EN_CAMINO**. Queda en `privado.cortes`.
5. **Finalizar** (`chofer_finalizar_viaje`): vacía la lista y vuelve a ESPERANDO. **Importante**: libera a los alumnos para apartar su siguiente viaje ([Apartados y asientos](Apartados%20y%20asientos.md)).

Otras acciones del chofer: reportar falla, botón de emergencia ([Buzón y fallas](Buzón%20y%20fallas.md)), registrar diesel, editar horarios de su vehículo (`chofer_horario_agregar/actualizar/eliminar`).

**Horarios desde la administración** (2026-11-21): el Admin tiene la pestaña **Horarios**, elige la unidad y edita sus salidas con el mismo editor del chofer (mismas funciones, ahora aceptan el rol Admin). El chofer solo puede editar si ya eligió vehículo del día.
- **Salidas con asientos apartados**: cambiar la hora o borrar una salida pide confirmar (error `CMF07`); al confirmar, esos asientos se **liberan sin cobro** y se avisa a cada alumno (`salida_cambiada`). Cambiar solo Ida/Regreso conserva el asiento. Si otra fila de la misma unidad tiene esa hora ese día, no se toca nada.
- **Pasar a otra unidad** (solo Admin, `admin_horario_mover`): la salida se va con todas sus horas; cada alumno se va con su **mismo asiento** si existe y está libre allá (y la unidad no es exclusiva de Chinacates para alguien de otra ubicación); si no, se libera sin cobro. A todos se les avisa.
- Cada cambio queda en bitácora: `horario_cambiado`, `horario_eliminado`, `horario_movido` (con quién lo hizo).

**Salida actual** (`_salida_actual`): la salida programada del vehículo más cercana a la hora actual (de 3 h antes a 1 h después) sin corte.
