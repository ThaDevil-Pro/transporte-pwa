-- =====================================================================
-- CAMIFY · Las sesiones duran una semana (antes 12 horas)
-- Alumnos, choferes y administración ya no tienen que entrar cada día.
-- Las sesiones abiertas se extienden a 7 días desde que se iniciaron.
-- Cerrar sesión o cambiar la contraseña sigue terminándolas al instante.
-- =====================================================================

alter table public.sesiones alter column expira_en set default now() + interval '7 days';

update public.sesiones
   set expira_en = creado_en + interval '7 days'
 where expira_en > now()
   and creado_en + interval '7 days' > expira_en;
