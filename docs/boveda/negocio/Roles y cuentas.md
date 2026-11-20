---
tags: [camify, negocio, seguridad]
actualizado: 2026-11-19
---

# Roles y cuentas

Volver a [Inicio](../Inicio.md)

| Rol | Tabla | Identificador (`usuario_ref`) | Sesión dura |
|---|---|---|---|
| Estudiante | `alumnos` | matrícula | 7 días |
| Chofer | `choferes` | licencia | 7 días |
| Admin | `admins` | usuario | 24 h |
| Financiero | `financieros` | usuario | 24 h |

- `login(p_rol, p_identificador, p_password, p_dispositivo)` crea una fila en `sesiones` y devuelve un **token**. Todas las funciones reciben ese token.
- Contraseñas con bcrypt (`crypt`): **no se pueden recuperar**, solo restablecer. Contraseña temporal → `debe_cambiar_password`.
- **Bloqueo por intentos** (`privado.login_intentos`): por cuenta+IP, por cuenta y por IP; un dispositivo ya conocido tiene su propio contador. Avisa a los admins por push (`login_bloqueado`).
- Mismo tiempo de respuesta exista o no la cuenta (no revela matrículas).
- Admin y Financiero pueden registrar pagos y ajustar saldos; el resto de administración es solo Admin.
