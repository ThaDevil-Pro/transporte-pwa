-- Asientos sin número «S/N» (2026-11-25)
-- · Un bloque con "sn": true es un asiento que en el camión no tiene número (p. ej. en el Camión Gris el plegable
--   de la escalera y los dos de la primera fila del lado de la puerta). Se puede apartar como cualquier otro;
--   por dentro se numera DESPUÉS de todos los demás (para que el fondo quede con los últimos números)
--   y en pantalla y en los avisos se muestra «S/N».
-- · privado.etiqueta_asiento(camion, n) da el texto a mostrar: el número o «S/N».

create or replace function privado.armar_asientos(p_cols integer, p_bloques jsonb, p_numeracion text default 'chofer')
returns jsonb
language plpgsql
immutable
set search_path to ''
as $function$
declare
  v_celdas int;
  v_distintas int;
  v_asientos int;
  v_res jsonb;
begin
  if p_cols is null or p_cols not between 3 and 6 then
    raise exception 'El ancho del vehículo no es válido';
  end if;
  if p_bloques is null or jsonb_typeof(p_bloques) <> 'array' then
    raise exception 'El acomodo de asientos no es válido';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_bloques) x
    where jsonb_typeof(x) <> 'object'
       or coalesce(x ->> 'w', '') not in ('1', '2')
       or coalesce(x ->> 'r', '') !~ '^[0-9]{1,2}$'
       or coalesce(x ->> 'c', '') !~ '^[0-9]$'
       or (x ->> 'r')::int > 29
       or (x ->> 'c')::int + (x ->> 'w')::int > p_cols
       or coalesce(jsonb_typeof(x -> 'roto'), 'boolean') <> 'boolean'
       or coalesce(jsonb_typeof(x -> 'extra'), 'boolean') <> 'boolean'
       or coalesce(jsonb_typeof(x -> 'sn'), 'boolean') <> 'boolean'
  ) then
    raise exception 'Hay asientos fuera del vehículo: acomódalos dentro del dibujo';
  end if;

  with b as (
    select (x ->> 'r')::int r, (x ->> 'c')::int c, (x ->> 'w')::int w, coalesce((x ->> 'roto')::boolean, false) roto
    from jsonb_array_elements(p_bloques) x
  ), celdas as (
    select b.r, b.c + k as c, b.roto from b, generate_series(0, b.w - 1) k
  )
  select count(*), count(distinct (r, c)), count(*) filter (where not roto) into v_celdas, v_distintas, v_asientos from celdas;

  if v_asientos = 0 then
    raise exception 'Agrega al menos un asiento';
  end if;
  if v_celdas > 80 then
    raise exception 'Un vehículo puede tener hasta 80 asientos';
  end if;
  if v_celdas <> v_distintas then
    raise exception 'Hay asientos encimados: acomódalos en lugares distintos';
  end if;

  with b as (
    select (x ->> 'r')::int r, (x ->> 'c')::int c, (x ->> 'w')::int w,
           coalesce((x ->> 'extra')::boolean, false) extra, coalesce((x ->> 'sn')::boolean, false) sn, o
    from jsonb_array_elements(p_bloques) with ordinality t(x, o)
    where not coalesce((x ->> 'roto')::boolean, false)
  ), celdas as (
    select b.r, b.c + k as c, b.o, b.extra, b.sn from b, generate_series(0, b.w - 1) k
  ), num as (
    -- Sin número al final, luego extras; con numeración «puerta», en cada fila primero el lado de la puerta
    select r, c, o, sn, (row_number() over (order by sn, extra, r,
             case when p_numeracion = 'puerta' and c * 2 >= p_cols then 0 else 1 end, c))::int as n
    from celdas
  )
  select jsonb_agg(jsonb_build_object(
           'n', a.n, 'r', a.r, 'c', a.c,
           'par', (select p.n from num p where p.o = a.o and p.n <> a.n))
           || case when a.sn then '{"sn": true}'::jsonb else '{}'::jsonb end order by a.n)
    into v_res
  from num a;
  return v_res;
end;
$function$;
revoke all on function privado.armar_asientos(integer, jsonb, text) from public, anon, authenticated;

-- Texto del asiento para mostrar: su número, o «S/N» si en el camión no tiene número
create or replace function privado.etiqueta_asiento(p_camion integer, p_n integer)
returns text
language sql
stable
set search_path to ''
as $function$
  select case
    when p_n is null then null
    when exists (select 1 from public.estado_viaje e, jsonb_array_elements(e.asientos) a
                 where e.id = p_camion and (a ->> 'n')::int = p_n and coalesce((a ->> 'sn')::boolean, false)) then 'S/N'
    else p_n::text
  end
$function$;
revoke all on function privado.etiqueta_asiento(integer, integer) from public, anon, authenticated;

-- Los avisos que mencionan un número de asiento usan la etiqueta
do $$
declare
  r record;
  v_oid oid;
  v_def text;
  v_nuevo text;
  v_hecho boolean;
begin
  for r in select * from (values
    ('admin_horario_mover', 'v_dest.nombre, v_r.asiento));', 'v_dest.nombre, privado.etiqueta_asiento(p_destino, v_r.asiento)));'),
    ('alumno_apartar', '_nombre_corto(v_yo), v_lugar_pareja, p_asiento));', '_nombre_corto(v_yo), privado.etiqueta_asiento(p_camion, v_lugar_pareja), privado.etiqueta_asiento(p_camion, p_asiento)));'),
    ('alumno_apartar', '_nombre_corto(v_yo), v_vecino));', '_nombre_corto(v_yo), privado.etiqueta_asiento(p_camion, v_vecino)));'),
    ('alumno_liberar_asiento', '_nombre_corto(v_yo), v_asiento, _salida_texto', '_nombre_corto(v_yo), privado.etiqueta_asiento(v_camion, v_asiento), _salida_texto'),
    ('alumno_pedir_cambio', 'Abre CAMIFY para responder.'', v_nuevo)', 'Abre CAMIFY para responder.'', privado.etiqueta_asiento(p_camion, v_nuevo))'),
    ('alumno_responder_cambio', '_nombre_corto(v_c.pide), v_c.asiento_actual));', '_nombre_corto(v_c.pide), privado.etiqueta_asiento(v_c.camion, v_c.asiento_actual)));'),
    ('alumno_responder_cambio', 'json_build_object(''estado'', ''aceptada'', ''asiento'', v_nuevo)', 'json_build_object(''estado'', ''aceptada'', ''asiento'', privado.etiqueta_asiento(v_c.camion, v_nuevo))'),
    ('push_abordaje_tg', 'v_min, r.asiento)', 'v_min, privado.etiqueta_asiento(new.id, r.asiento))'),
    ('pareja_estado', '''actual'', c.asiento_actual, ''nuevo'', c.asiento_nuevo', '''actual'', privado.etiqueta_asiento(c.camion, c.asiento_actual), ''nuevo'', privado.etiqueta_asiento(c.camion, c.asiento_nuevo)')
  ) t(fn, de, a) loop
    v_hecho := false;
    for v_oid in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname in ('public', 'privado') and p.proname = r.fn loop
      v_def := pg_get_functiondef(v_oid);
      if position(r.de in v_def) > 0 then
        v_nuevo := replace(v_def, r.de, r.a);
        execute v_nuevo;
        v_hecho := true;
      end if;
    end loop;
    if not v_hecho then
      raise exception 'No encontré el texto a cambiar en %: %', r.fn, r.de;
    end if;
  end loop;
end $$;
