---
tags: [camify, pendientes]
actualizado: 2026-11-22
---

# Pendientes

Volver a [Inicio](Inicio.md)

## Antes del lanzamiento (auditoría del 2026-11-22)
- [ ] **Publicar**: migración `20261122000000_auditoria_lanzamiento.sql` y los commits del comprobante de contraseña, la auditoría, la consulta ligera del alumno y «Sin cobro». Orden: primero la migración, luego el código.
- [ ] **133 de 206 alumnos nunca han entrado**: confirmar que la administración tiene el archivo de contraseñas temporales que dio la importación. Si se perdió, hay que restablecerlas una por una (Usuarios → Editar, con comprobante en PDF).
- [ ] **135 alumnos sin ubicación**: la app se las pide al entrar; solo la administración puede corregirla después.
- [ ] Emergencia: la unidad descompuesta **sigue apareciendo para apartar**. Si estará fuera varios días, pasar sus salidas a otra unidad en **Horarios**.
- [ ] Al publicar, el abordaje colgado del 4 de noviembre (Camión Amarillo) se quitará solo y quedará en Actividad como «Alumnos quitados de un viaje sin corte».
- [ ] El 22 de noviembre a las 10:37 a. m. alguien escaneó la API desde muchas IPs buscando funciones de saldo, pagos y becas. Todo fue rechazado; solo leyó lo que ya es público (horarios y unidades). Sin acción, pero estar atentos.

## Del negocio
- [ ] **Reacomodo de asientos**: el comunicado prometió revisarlo. Opciones: pedir permiso antes de mover, o dejar de mover y que la pareja se siente donde haya. Ver [Apartados y asientos](negocio/Apartados%20y%20asientos.md).
- [ ] **Comunicado**: precisar que para apartar se puede deber hasta un día ($60), no "estar al corriente". PDF en `Claude outputs/Comunicado-CAMIFY.pdf`.
- [ ] Revisar con frecuencia **camifyapptransporte@gmail.com**: solicitudes de datos personales (plazo legal de 20 días hábiles) y reportes de seguridad.
- [ ] ¿Notificaciones para Financiero (pagos)? No se pidió todavía.
- [ ] Que los choferes toquen **Finalizar** al llegar. Si se les olvida, el viaje se finaliza solo 6 h después del corte, pero mientras tanto no pueden subir a nadie a esa unidad.

## Vigilar en producción
- [ ] Uso mensual de tráfico (cupo gratis: 5 GB) y mensajes en vivo, ahora que los alumnos consultan en lugar de escuchar.
- [ ] La CPU y los tiempos la primera vez que muchos aparten a la vez.
