---
tags: [camify, negocio, push]
actualizado: 2026-11-19
---

# Notificaciones push

Volver a [Inicio](../Inicio.md) · Técnico: [Arquitectura](../tecnico/Arquitectura.md)

Cada usuario activa con la tarjeta **Activar** al entrar. En iPhone solo funcionan con la app **instalada** (iOS 16.4+). Probado en iPhone y Android reales el 2026-11-18.

| Para | Cuándo |
|---|---|
| Alumno | Su camión empieza a abordar; cambio de asiento; pareja (invitación, aceptada, apartó por ti); emergencia; respuesta a su queja; apartado perdido; cambio de ubicación; **pago recibido**; **ajuste de saldo**; **viaje cobrado** |
| Chofer | Emergencia de otro camión; queja sobre su camión (si lo tiene en su jornada de hoy); su falla cambió de estado; su carga de diesel fue revisada |
| Admin | Emergencia; falla reportada; queja nueva; carga de diesel por revisar; corte de cada camión; acceso bloqueado por intentos |
| Financiero | Nada (no se pidió) |

## Cómo funciona
- Suscripciones en `privado.push_suscripciones` (un teléfono = la última cuenta que entró; máx. 5 por usuario). Al cerrar sesión se quita.
- Triggers en `avisos`, `parejas`, `estado_viaje`, `fallas`, `quejas`, `privado.diesel_cargas`, `privado.pagos`, `historial_viajes`, `privado.bitacora` → `privado.push_enviar` / `privado.push_a`.
- `pg_net` manda un POST después del commit a la función `enviar-push`, que cifra con VAPID y entrega. Si falla un aviso, la acción que lo provocó **no** se deshace.
- Llaves VAPID y dirección de la función en `privado.secretos`. **Nunca borrar esa tabla.**
- Para mandar una prueba a una sola persona: `select privado.push_enviar('[{"matricula":"…","titulo":"…","cuerpo":"…"}]')`. No usar para mensajes personales.
