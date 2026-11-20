---
tags: [camify, negocio, asientos]
actualizado: 2026-11-19
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

## Parejas de viaje
- Tablas/funciones: `parejas`, `pareja_invitar`, `pareja_responder`, `pareja_terminar`.
- Al apartar con pareja se reservan **dos asientos de la misma fila**.
- Si la pareja **debe más de $60**, **no puede viajar en ese vehículo** o **ya tiene otro viaje**, se aparta solo para quien lo pidió (`pareja_debe`, `pareja_fuera`, `pareja_con_viaje`).
- **Reacomodo**: si no hay fila libre, el sistema puede **mover a un alumno que iba solo** a otro asiento libre (junto a otro solo) para juntar a la pareja. Se le avisa (`asiento_movido`). Es el punto más criticado por los alumnos → ver [Pendientes](../Pendientes.md).

## Al salir (corte)
- Quien apartó y **no subió** pierde el apartado y se le cobra el boleto (si el corte es ≥ 20 min antes o después de la salida).
- De pie solo cuentan los que pasan la capacidad del vehículo.
