---
tags: [camify, negocio, dinero]
actualizado: 2026-11-23
---

# Cobros y adeudos

Volver a [Inicio](../Inicio.md)

## Saldo
- `alumnos.saldo`: **positivo = debe**, **negativo = a favor**, 0 = al corriente.
- **En pantalla se muestra al revés** (desde 2026-11-23): lo que debe en negativo (−$120) y lo que tiene a favor en positivo ($50); en el historial los viajes van con «−» y los pagos con «+». Solo cambia la vista (`fmtSaldo` y reportes); la base y las reglas siguen igual. La corrección de saldo del admin se escribe como en pantalla y se invierte al guardar. La hoja de importación pide el **Adeudo** (número positivo).
- Al 2026-11-19 los 205 alumnos están en $0 (semana de prueba: las deudas previas quedaron en segundo plano).

## Boleto diario (`privado.precio_boleto`, `privado.cobro_viaje`)
- **Nuevo Ideal: $60**, **Chinacates: $40** (según `alumnos.ubicacion`).
- Se cobra **el primer viaje del día**; el regreso del mismo día es **gratis** (cuenta los viajes del día en `historial_viajes`: par → cobra, impar → $0).
- El cobro se hace **en el corte** del chofer, no al apartar ni al escanear. Ver [Viaje del chofer](Viaje%20del%20chofer.md).

## Becas de transporte (desde 2026-11-21)
- El admin marca la beca en **Editar alumno**: sin beca, **50%** o **100%** (`privado.becas`, `admin_alumno_beca`).
- **Requiere el oficio firmado por el director** (foto o PDF, máx. 3 MB). Admin y Financiero lo pueden ver (`admin_beca_oficio`) para auditoría.
- El descuento se aplica en `privado.precio_boleto`: cada cobro (boleto, apartado perdido, cancelar tarde) se registra con el **monto real ya descontado**. **No se ponen saldos inventados**: lo pidió Finanzas para que los reportes cuadren en auditoría.
- Beca 100% → el viaje queda en el historial con $0. Quitar la beca conserva el oficio.
- Cada cambio queda en bitácora (`beca_cambiada`) y avisa al alumno.

## Límites
| Para… | Límite | Dónde |
|---|---|---|
| Subir al camión (QR o registro manual) | adeudo **≤ $600** | `alumno_qr`, `_abordar` |
| Apartar asiento | adeudo **≤ $60** (un día) | `privado.puede_apartar` |

- $600 = 10 días a $60 ≈ **2 semanas de clases** (Chinacates: 15 días). Esto es lo que respalda el "hasta 2 semanas para pagar" del comunicado.
- Si debe más de $60 puede seguir subiendo, pero sin asiento apartado: **como cualquier alumno sin apartado**, sentado si hay lugar y **de pie si va lleno** (desde 2026-11-22; antes se le asignaba a fuerza un asiento sin apartar y, si no quedaba, no podía subir).
- La deuda **solo** cuenta en estas dos reglas. El que va de pie paga el boleto normal.

## Cobros extra
- **Apartado perdido**: apartó y no subió → en el corte se le cobra el boleto completo (`privado.cobrar_perdido`, `historial_viajes.perdido = true`) y se le avisa. Ver [Apartados y asientos](Apartados%20y%20asientos.md).
- **Cancelar tarde**: liberar el asiento a menos de **1 hora** de la salida cobra el boleto (`alumno_liberar_asiento`).
- Si vuelve a apartar la misma salida después de un cobro de perdido sin corte, se le devuelve (`apartado_recuperado`).

## Pagos
- `admin_registrar_pago` (Admin o Financiero): resta del saldo y guarda en `privado.pagos`. Notifica al alumno.
- `admin_actualizar_saldo`: fija el saldo a mano con motivo; queda en bitácora (`saldo_ajustado`) y notifica.
