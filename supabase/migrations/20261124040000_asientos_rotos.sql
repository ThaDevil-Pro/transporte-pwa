-- Asientos rotos (2026-11-23)
-- Un bloque del acomodo puede llevar "roto": true. Se dibuja en gris en todos los mapas, pero no
-- tiene número ni cuenta como asiento: nadie lo puede apartar ni se asigna al subir, y no suma a la
-- capacidad. Así no se recorre la numeración de los demás asientos.
create or replace function privado.armar_asientos(p_cols integer, p_bloques jsonb)
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
  ) then
    raise exception 'Hay asientos fuera del vehículo: acomódalos dentro del dibujo';
  end if;

  -- Los rotos también ocupan su lugar en el dibujo: no se puede encimar nada sobre ellos
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
    select (x ->> 'r')::int r, (x ->> 'c')::int c, (x ->> 'w')::int w, o
    from jsonb_array_elements(p_bloques) with ordinality t(x, o)
    where not coalesce((x ->> 'roto')::boolean, false)
  ), celdas as (
    select b.r, b.c + k as c, b.o from b, generate_series(0, b.w - 1) k
  ), num as (
    select r, c, o, (row_number() over (order by r, c))::int as n from celdas
  )
  select jsonb_agg(jsonb_build_object(
           'n', a.n, 'r', a.r, 'c', a.c,
           'par', (select p.n from num p where p.o = a.o and p.n <> a.n)) order by a.n)
    into v_res
  from num a;
  return v_res;
end;
$function$;
