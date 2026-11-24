-- Detector de congelamientos (2026-11-23)
-- La app anota cuándo se traba en el celular (pausa del hilo principal, pantalla que no se
-- redibuja o toque en una pestaña que no cambia) y lo manda aquí. Sin datos personales: solo
-- rol, pantalla, qué se estaba cargando y el navegador. Se consulta con SQL desde el panel.
create table if not exists privado.diagnosticos (
  id bigint generated always as identity primary key,
  creado_en timestamptz not null default now(),
  rol text,
  sesion text,          -- huella de la sesión (no el token) para limitar cuántos manda cada teléfono
  datos jsonb not null
);
create index if not exists diagnosticos_creado_idx on privado.diagnosticos (creado_en);
create index if not exists diagnosticos_sesion_idx on privado.diagnosticos (sesion, creado_en);
revoke all on privado.diagnosticos from anon, authenticated;

create or replace function public.app_diagnostico(p_token uuid, p_datos jsonb)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_ref text := _validar_sesion(p_token, array['Estudiante', 'Chofer', 'Admin', 'Financiero']);
  v_rol text := current_setting('camify.rol', true);
  v_huella text := left(md5(p_token::text), 16);
begin
  if p_datos is null or jsonb_typeof(p_datos) <> 'array' or octet_length(p_datos::text) > 20000 then
    return false;
  end if;
  -- Máximo 200 registros por sesión al día
  if (select count(*) from privado.diagnosticos where sesion = v_huella and creado_en > now() - interval '1 day') >= 200 then
    return false;
  end if;
  insert into privado.diagnosticos (rol, sesion, datos)
  select v_rol, v_huella, e from jsonb_array_elements(p_datos) e
  where jsonb_typeof(e) = 'object'
  limit 20;
  return true;
end;
$function$;
revoke all on function public.app_diagnostico(uuid, jsonb) from public;
grant execute on function public.app_diagnostico(uuid, jsonb) to anon, authenticated;
