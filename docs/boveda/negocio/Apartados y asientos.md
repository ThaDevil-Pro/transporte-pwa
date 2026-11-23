---
tags: [camify, negocio, asientos]
actualizado: 2026-11-23
---

# Apartados y asientos

Volver a [Inicio](../Inicio.md) · Relacionado: [Cobros y adeudos](Cobros%20y%20adeudos.md), [Tiempo real y carga](../tecnico/Tiempo%20real%20y%20carga.md)

Función principal: `public.alumno_apartar`. Mapa: `public.alumno_mapa`. Tabla: `reservas (fecha, hora, camion, asiento, matricula, tipo)`.

## Cuándo se puede apartar
- Abre **12 horas antes** de la salida y cierra a la hora de salida o cuando el chofer hace el corte (`privado.salida_cerrada`).
- Hay que haber elegido ubicación (Nuevo Ideal / Chinacates) y deber **≤ $60**.
- **Vehículos exclusivos de Chinacates** (`estado_viaje.exclusivo_chinacates`): solo alumnos de Chinacates; y si hay exclusiva con lugar ese día, los de Chinacates deben apartar ahí primero (`privado.motivo_no_aparta`).

## Un viaje a la vez (desde 2026-11-19)
- Con un viaje pendiente **no se puede apartar otra salida** (`privado.viaje_pendiente`). El mapa muestra el aviso y bloquea los asientos.
- En la **misma salida** sí puede cambiar de asiento o de vehículo.
- Si **libera** su asiento, puede apartar otro.
- El viaje termina cuando el chofer **finaliza** tras el corte. Mientras está *En camino*, sigue bloqueado.
- Respaldo: si nunca se finaliza, deja de bloquear **3 horas después** de la hora de salida.
- Candados: por salida y por alumno (y su pareja), para que dos teléfonos no cuelen dos viajes.
- Consecuencia: quien aparta la ida no puede apartar el regreso hasta llegar.

## Compañeros de viaje (antes «parejas»)
- Desde 2026-11-23 la función se llama **Compañero de viaje** en todos los textos que ve el usuario. En el código y la base de datos sigue llamándose `pareja` (tabla `parejas`, `_pareja_de`, modo `'pareja'`, tipos de aviso).
- Tablas/funciones: `parejas`, `pareja_invitar`, `pareja_responder`, `pareja_terminar`.
- Al apartar con pareja se reservan **dos asientos de la misma fila**.
- **Solo o con la pareja** (desde 2026-11-23): al abrir el mapa sin asiento, se pregunta «¿Apartarás solo o con tu pareja?». Con «Solo yo» se aparta únicamente su asiento y el de la pareja no cambia (`alumno_apartar` con `p_sin_pareja`). Se puede cambiar con el botón bajo la pista del mapa.
- **Liberar**: cualquiera de la pareja puede liberar su asiento, el del otro o los dos (`alumno_liberar_asiento` con `p_quien` = `yo` / `pareja` / `ambos`). Al otro le llega el aviso `pareja_libero`. Con **menos de una hora** para la salida también se puede, pero **a cada quien se le cobra su propio boleto** como apartado perdido (se le devuelve si vuelve a apartar esa salida).
- Si la pareja **debe más de $60**, **no puede viajar en ese vehículo** o **ya tiene otro viaje**, se aparta solo para quien lo pidió (`pareja_debe`, `pareja_fuera`, `pareja_con_viaje`).
- **Sin reacomodo** (desde 2026-11-22): el sistema **nunca mueve a nadie sin preguntar**. Si no queda ninguna fila libre para los dos (`alumno_mapa` modo `pareja_llena`), la pareja elige:
  1. **Separarnos**: quien aparta elige su asiento y a la pareja se le aparta el libre más cercano (`alumno_apartar` con `p_solo`; `privado.asiento_cercano`). Se le avisa a la pareja.
  2. **Otro vehículo**: se listan las salidas abiertas que todavía tienen filas libres para los dos (`alumno_salidas.dobles`).
  3. **Pedir un cambio**: elige un asiento libre junto a alguien que va solo (`pedible`). Se le aparta a quien pide y al alumno solo le llega una notificación y una ventana: «¿Te cambiarías del asiento X al Y? Tu lugar sigue apartado; si prefieres quedarte, no pasa nada.» Si acepta, se mueve y la pareja queda junta; si no, nadie se mueve (`alumno_pedir_cambio`, `alumno_responder_cambio`, tabla `privado.cambios_asiento`). Máximo 5 solicitudes por salida y una pendiente por alumno; se cancelan si alguno libera o aparta en otro lado.

## Al salir (corte)
- Quien apartó y **no subió** pierde el apartado y se le cobra el boleto (si el corte es ≥ 20 min antes o después de la salida).
- De pie solo cuentan los que pasan la capacidad del vehículo.
