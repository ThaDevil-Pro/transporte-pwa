---
tags: [camify, negocio, chofer]
actualizado: 2026-11-23
---

# Viaje del chofer

Volver a [Inicio](../Inicio.md)

Estado de cada vehículo en `estado_viaje` (`estado`: ESPERANDO / EN_CAMINO, `temporizador_activo`, `tiempo_salida`).

1. **Jornada**: el chofer elige su vehículo del día (`chofer_elegir_vehiculo` → `privado.jornadas`). Un vehículo, un chofer por día.
2. **Conteo**: inicia el temporizador de salida (`chofer_temporizador`). Al iniciarlo, se manda push "Tu camión ya está abordando" a quien apartó esa salida.
3. **Abordaje**: escanea el QR del alumno (`chofer_registrar_abordaje`; cada código cambia cada 30 s pero se acepta **hasta 1 hora**, así sirve una captura de pantalla) o lo registra a mano (`chofer_abordar_manual`). Lista en `abordajes`.
4. **Corte** (`chofer_hacer_corte`): cobra a todos los de la lista ([Cobros y adeudos](Cobros%20y%20adeudos.md)), marca perdidos y pasa a **EN_CAMINO**. Queda en `privado.cortes`.
5. **Finalizar** (`chofer_finalizar_viaje`): vacía la lista y vuelve a ESPERANDO. **Importante**: libera a los alumnos para apartar su siguiente viaje ([Apartados y asientos](Apartados%20y%20asientos.md)).

Otras acciones del chofer: reportar falla, botón de emergencia ([Buzón y fallas](Buzón%20y%20fallas.md)), registrar diesel, editar horarios de su vehículo (`chofer_horario_agregar/actualizar/eliminar`).

**Horarios desde la administración** (2026-11-21): el Admin tiene la pestaña **Horarios**, elige la unidad y edita sus salidas con el mismo editor del chofer (mismas funciones, ahora aceptan el rol Admin). El chofer solo puede editar si ya eligió vehículo del día.
- **Salidas con asientos apartados**: cambiar la hora o borrar una salida pide confirmar (error `CMF07`); al confirmar, esos asientos se **liberan sin cobro** y se avisa a cada alumno (`salida_cambiada`). Cambiar solo Ida/Regreso conserva el asiento. Si otra fila de la misma unidad tiene esa hora ese día, no se toca nada.
- **Pasar a otra unidad** (solo Admin, `admin_horario_mover`): la salida se va con todas sus horas; cada alumno se va con su **mismo asiento** si existe y está libre allá (y la unidad no es exclusiva de Chinacates para alguien de otra ubicación); si no, se libera sin cobro. A todos se les avisa.
- Cada cambio queda en bitácora: `horario_cambiado`, `horario_eliminado`, `horario_movido` (con quién lo hizo).

**Registro manual** (alumno sin QR): el chofer busca por nombre o número de control. Si ya apartó, el mapa marca su asiento (y el de su pareja en morado) y arriba sale una leyenda grande: «Asiento 24 · lado del chofer» o «Asientos 24-25 · con su pareja · lado de la puerta» (el volante va a la izquierda y la puerta a la derecha, como en el dibujo).

**De pie**: quien no apartó y llega con el camión lleno sube de pie (sin límite). Al escanear, los apartados cuentan como ocupados aunque no hayan llegado; en el corte se recalcula con quienes subieron.

**Viajes olvidados** (desde 2026-11-22, `privado.limpiar_viajes_viejos`, corre al escanear, hacer corte, abrir la lista o la jornada):
- Alumnos escaneados hace **más de 4 h en un viaje sin corte** se quitan de la lista **sin cobro** y quedan en la bitácora (`abordajes_descartados`) con nombre y matrícula, por si la administración quiere cobrarlos a mano. Antes se quedaban "a bordo" para siempre: no podían subir a otra unidad y se les cobraba en el siguiente corte de ese camión (pasó en producción: uno del 4 de noviembre).
- Corte hecho y nadie tocó **Finalizar**: se finaliza solo **6 h después del corte** (`viaje_finalizado_auto`).
- Conteo de salida encendido hace más de 2 h: se apaga.

**Salida actual** (`_salida_actual`): la salida programada del vehículo más cercana a la hora actual (de 3 h antes a 1 h después) sin corte.
