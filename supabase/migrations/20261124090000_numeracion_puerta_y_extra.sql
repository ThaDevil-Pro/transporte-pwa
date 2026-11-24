-- Numeración por vehículo y asiento extra (2026-11-24)
-- · estado_viaje.numeracion: 'chofer' (como siempre: cada fila de izquierda a derecha) o 'puerta'
--   (cada fila empieza por el lado de la puerta). El Camión Gris va puerta primero: fila 1 = 1-2 puerta, 3-4 chofer.
-- · Un bloque con "extra": true (p. ej. el asiento plegable de la escalera) se numera al final,
--   aunque esté adelante en el dibujo. Se puede apartar como cualquier otro.
alter table public.estado_viaje add column if not exists numeracion text not null default 'chofer';
do $$ begin
  alter table public.estado_viaje add constraint estado_viaje_numeracion_chk check (numeracion in ('chofer', 'puerta'));
exception when duplicate_object then null; end $$;

drop function if exists privado.armar_asientos(integer, jsonb);
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
    select (x ->> 'r')::int r, (x ->> 'c')::int c, (x ->> 'w')::int w, coalesce((x ->> 'extra')::boolean, false) extra, o
    from jsonb_array_elements(p_bloques) with ordinality t(x, o)
    where not coalesce((x ->> 'roto')::boolean, false)
  ), celdas as (
    select b.r, b.c + k as c, b.o, b.extra from b, generate_series(0, b.w - 1) k
  ), num as (
    -- Extras al final; con numeración «puerta», en cada fila primero las columnas del lado de la puerta
    select r, c, o, (row_number() over (order by extra, r,
             case when p_numeracion = 'puerta' and c * 2 >= p_cols then 0 else 1 end, c))::int as n
    from celdas
  )
  select jsonb_agg(jsonb_build_object(
           'n', a.n, 'r', a.r, 'c', a.c,
           'par', (select p.n from num p where p.o = a.o and p.n <> a.n)) order by a.n)
    into v_res
  from num a;
  return v_res;
end;
$function$;
revoke all on function privado.armar_asientos(integer, jsonb, text) from public, anon, authenticated;

-- Al guardar desde el editor se respeta la numeración del vehículo
do $$
declare
  v_def text := pg_get_functiondef('public.admin_vehiculo_guardar(uuid,integer,text,text,integer,jsonb,boolean)'::regprocedure);
  v_nuevo text;
begin
  if position('numeracion from estado_viaje' in v_def) > 0 then
    return;
  end if;
  v_nuevo := replace(v_def, 'privado.armar_asientos(p_cols, p_bloques)',
    'privado.armar_asientos(p_cols, p_bloques, coalesce((select numeracion from estado_viaje where id = p_id), ''chofer''))');
  if v_nuevo = v_def then
    raise exception 'No se encontró armar_asientos en admin_vehiculo_guardar';
  end if;
  execute v_nuevo;
end $$;
