---
tags: [camify, tecnico, bd]
actualizado: 2026-11-21
---

# Base de datos

Volver a [Inicio](../Inicio.md)

## Patrón de funciones
```sql
create or replace function public.algo(p_token uuid, ...)
returns json language plpgsql security definer set search_path = public as $$
declare v_yo text := _validar_sesion(p_token, array['Estudiante']);  -- valida rol y sesión
begin ... end $$;
```
- `_validar_sesion` devuelve el `usuario_ref` y deja `camify.rol` / `camify.usuario` en la transacción.
- Lo interno vive en el esquema **`privado`** y se revoca a `anon`.
- Bitácora: `privado.log(rol, actor, accion, detalle)` → `privado.bitacora`.
- `actividad (clave, actualizado)`: "señal" de que algo cambió (`salida:fecha T hora:camion`, `quejas`, `fallas`, `diesel`, `avisos`, `parejas`).
- Reloj único: `_ahora()` (para poder simular la hora en pruebas).

## Tablas principales
`alumnos`, `choferes`, `admins`, `financieros`, `sesiones`, `estado_viaje` (vehículos), `horarios_matriz`, `reservas`, `abordajes`, `historial_viajes`, `avisos`, `parejas`, `quejas`, `fallas`, `actividad`.
Privado: `secretos`, `bitacora`, `cortes`, `pagos`, `jornadas`, `diesel_cargas`, `push_suscripciones`, `login_intentos`, `fotos`, `becas` (porcentaje + oficio).

## Errores con código propio
- `CMF01` debe cambiar contraseña · `CMF05` falta ubicación · `CMF06` mensaje con groserías.
