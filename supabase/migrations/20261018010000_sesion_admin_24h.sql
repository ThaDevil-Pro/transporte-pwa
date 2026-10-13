-- =====================================================================
-- CAMIFY · Duración de la sesión según el perfil
--  · Alumnos y choferes: 7 días.
--  · Administración: 24 horas (puede cambiar saldos y usuarios).
-- La duración se fija al crear la sesión, sin importar quién la inserte.
-- =====================================================================

create or replace function privado.duracion_sesion()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.expira_en := now() + case when new.rol = 'Admin' then interval '24 hours' else interval '7 days' end;
  return new;
end;
$$;

revoke all on function privado.duracion_sesion() from public, anon, authenticated;

drop trigger if exists sesiones_duracion on public.sesiones;
create trigger sesiones_duracion
before insert on public.sesiones
for each row execute function privado.duracion_sesion();

-- Las sesiones de administración abiertas no pasan de 24 horas
update public.sesiones
   set expira_en = creado_en + interval '24 hours'
 where rol = 'Admin'
   and expira_en > creado_en + interval '24 hours';
