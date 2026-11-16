-- CAMIFY · Segunda ronda de endurecimiento (revisión de seguridad del 16 nov 2026)
--  1. Un chofer solo puede bajar de la lista a alumnos de su propio vehículo de hoy.
--  2. Se eliminan las versiones viejas de las funciones de horarios que seguían
--     expuestas (solo lanzaban error, pero eran superficie de ataque innecesaria).
--  3. Las funciones del esquema privado dejan de ser ejecutables por los roles de
--     la API, hoy y para las que se creen después (defensa en profundidad: el
--     esquema ya no es accesible desde la API, pero así no depende de eso).

-- 1. chofer_quitar_abordaje: exige que el abordaje sea de su vehículo
do $$
declare
  v text := replace(pg_get_functiondef('public.chofer_quitar_abordaje(uuid, bigint)'::regprocedure), E'\r\n', E'\n');
  a text := E'  if v_fila.id is null then\n    return;\n  end if;\n';
  b text := E'  if v_fila.id is null then\n    return;\n  end if;\n  perform _camion_valido(v_fila.camion);\n';
begin
  if position('perform _camion_valido(v_fila.camion)' in v) > 0 then
    return;
  elsif position(a in v) = 0 then
    raise exception 'No se encontró el punto a modificar en chofer_quitar_abordaje';
  end if;
  execute replace(v, a, b);
end $$;

-- 2. Versiones viejas que ya no usa la app
drop function if exists public.chofer_horario_actualizar(uuid, bigint, text, jsonb);
drop function if exists public.chofer_horario_eliminar(uuid, bigint);
drop function if exists public.chofer_horario_camion(uuid, bigint, integer);

-- 3. Nada del esquema privado se puede ejecutar desde la API
revoke all on all functions in schema privado from public, anon, authenticated;
alter default privileges in schema privado revoke execute on functions from public;
alter default privileges for role postgres in schema privado revoke execute on functions from public, anon, authenticated;
