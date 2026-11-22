---
tags: [camify, negocio, seguridad]
actualizado: 2026-11-22
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
- Al crear un usuario o poner una contraseña temporal, el panel ofrece **descargar un comprobante en PDF** (`pdfEntregaPassword` en `src/pdf.js`): arriba la hoja para el usuario con la contraseña; abajo un acuse para recortar y firmar, **sin la contraseña**. Se genera en el teléfono; la contraseña no se guarda en ningún lado.
- **Bloqueo por intentos** (`privado.login_intentos`): por cuenta+IP, por cuenta y por IP; un dispositivo ya conocido tiene su propio contador. Avisa a los admins por push (`login_bloqueado`).
- Mismo tiempo de respuesta exista o no la cuenta (no revela matrículas).
- **Cuentas de prueba** (`privado.es_prueba`: usuario `developer` en cualquier rol): el alumno de prueba paga $0 y no cuenta en cortes ni historial; el chofer de prueba no sale en reportes y sus cortes y cargas de diésel no suman. Sus pagos tampoco salen en Gastos. Las crea el dueño desde Registrar (contraseña temporal y luego la definitiva). Riesgo: si la de Admin/Financiero es fácil, cambiarla o borrarla al terminar de probar.
- Admin y Financiero pueden registrar pagos y ajustar saldos; el resto de administración es solo Admin.
