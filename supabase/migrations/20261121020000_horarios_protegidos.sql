-- Horarios sin dejar alumnos colgados:
-- 1. Cambiar la hora o borrar una salida con asientos apartados pide confirmación
--    (error CMF07); al confirmar, esos asientos se liberan sin cobro y se avisa a cada alumno.
-- 2. La administración puede pasar una salida a otra unidad; los alumnos se van con ella
--    si su mismo asiento está libre allá (y la unidad no es exclusiva de otra ubicación).
-- 3. Cada cambio queda en la bitácora con quién lo hizo.

-- Apartados futuros que dependen de la salida p_id en ese día y hora. Si otra fila de la
-- misma unidad tiene esa misma hora ese día, la salida sigue existiendo y no se toca nada.
create or replace function privado.horario_apartados(p_camion integer, p_dia text, p_hora text, p_id bigint)
returns setof public.reservas
language sql
stable
set search_path = ''
as $$
  select r.*
  from public.reservas r
  where coalesce(p_hora, '') <> ''
    and r.camion = p_camion
    and r.hora = p_hora::time
    and extract(isodow from r.fecha) = array_position(array['lunes', 'martes', 'miercoles', 'jueves', 'viernes'], p_dia)
    and (r.fecha + r.hora) > (public._ahora() at time zone 'America/Mexico_City')
    and not exists (
      select 1 from public.horarios_matriz h
      where h.id <> p_id and coalesce(h.camion, 1) = p_camion
        and (to_jsonb(h) -> p_dia ->> 'hora') = p_hora
    )
$$;

-- Libera esos apartados (sin cobro) y avisa a cada alumno
create or replace function privado.horario_liberar(p_ids bigint[], p_razon text)
returns integer
language plpgsql
set search_path = public
as $$
declare
  v record;
  n integer := 0;
begin
  for v in delete from reservas where id = any(p_ids) returning matricula, fecha, hora loop
    perform _avisar(v.matricula, 'salida_cambiada', format(
      'La salida del %s %s; tu asiento quedó libre, no se te cobró nada y ya puedes apartar otro viaje.',
      _salida_texto(v.fecha, v.hora), p_razon));
    n := n + 1;
  end loop;
  return n;
end;
$$;

create or replace function privado.horario_confirmar(p_n integer, p_que text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% %. %', p_n,
    case when p_n = 1 then 'alumno tiene asiento apartado en esa salida' else 'alumnos tienen asiento apartado en esa salida' end, p_que
    using errcode = 'CMF07';
end;
$$;

revoke all on function privado.horario_apartados(integer, text, text, bigint) from public, anon, authenticated;
revoke all on function privado.horario_liberar(bigint[], text) from public, anon, authenticated;
revoke all on function privado.horario_confirmar(integer, text) from public, anon, authenticated;

-- Cambian de firma (p_confirmar): se quitan las anteriores para no dejar dos versiones
drop function if exists public.chofer_horario_actualizar(uuid, bigint, text, jsonb, integer);
drop function if exists public.chofer_horario_eliminar(uuid, bigint, integer);

create or replace function public.chofer_horario_actualizar(p_token uuid, p_id bigint, p_dia text, p_valor jsonb, p_camion integer, p_confirmar boolean default false)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_yo text := _validar_sesion(p_token, array['Chofer', 'Admin']);
  v_hora text := coalesce(p_valor ->> 'hora', '');
  v_tipo text := coalesce(nullif(p_valor ->> 'tipo', ''), 'IDA');
  v_antes jsonb;
  v_ids bigint[];
  v_liberados integer := 0;
begin
  perform _camion_valido(p_camion);

  if p_dia not in ('lunes', 'martes', 'miercoles', 'jueves', 'viernes') then
    raise exception 'Día inválido';
  end if;
  if v_hora <> '' and v_hora !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
    raise exception 'Hora inválida';
  end if;
  if v_tipo not in ('IDA', 'REGRESO') then
    raise exception 'Tipo de salida inválido';
  end if;

  select to_jsonb(h) -> p_dia into v_antes
  from horarios_matriz h where h.id = p_id and coalesce(h.camion, 1) = p_camion for update;
  if not found then
    raise exception 'Esa salida no es de tu camión';
  end if;

  select array_agg(id) into v_ids from privado.horario_apartados(p_camion, p_dia, v_antes ->> 'hora', p_id);
  if coalesce(v_antes ->> 'hora', '') <> v_hora then
    -- Cambió la hora (o se quitó): los apartados de la hora anterior ya no tienen salida
    if v_ids is not null and not p_confirmar then
      perform privado.horario_confirmar(cardinality(v_ids), 'Si la cambias, sus asientos se liberan sin cobro y se les avisa.');
    end if;
    if v_ids is not null then
      v_liberados := privado.horario_liberar(v_ids, case when v_hora = '' then 'se canceló'
        else format('cambió a las %s', ((split_part(v_hora, ':', 1)::int + 11) % 12 + 1) || ':' || split_part(v_hora, ':', 2)
          || case when split_part(v_hora, ':', 1)::int < 12 then ' a. m.' else ' p. m.' end) end);
    end if;
  elsif v_ids is not null then
    -- Misma hora, solo cambió Ida/Regreso: el asiento sigue valiendo
    update reservas set tipo = v_tipo where id = any(v_ids);
  end if;

  execute format('update horarios_matriz set %I = $1 where id = $2', p_dia)
  using jsonb_build_object('hora', v_hora, 'tipo', v_tipo), p_id;

  if coalesce(v_antes ->> 'hora', '') <> v_hora or coalesce(v_antes ->> 'tipo', 'IDA') <> v_tipo then
    perform privado.log(current_setting('camify.rol', true), v_yo, 'horario_cambiado', jsonb_build_object(
      'camion', p_camion, 'dia', p_dia,
      'antes', coalesce(v_antes, '{}'::jsonb), 'despues', jsonb_build_object('hora', v_hora, 'tipo', v_tipo),
      'liberados', v_liberados));
  end if;
  return json_build_object('liberados', v_liberados);
end;
$$;

create or replace function public.chofer_horario_eliminar(p_token uuid, p_id bigint, p_camion integer, p_confirmar boolean default false)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_yo text := _validar_sesion(p_token, array['Chofer', 'Admin']);
  v_fila jsonb;
  v_ids bigint[];
  v_liberados integer := 0;
begin
  perform _camion_valido(p_camion);
  select to_jsonb(h) into v_fila from horarios_matriz h where h.id = p_id and coalesce(h.camion, 1) = p_camion for update;
  if not found then
    raise exception 'Esa salida no es de tu camión';
  end if;

  select array_agg(a.id) into v_ids
  from unnest(array['lunes', 'martes', 'miercoles', 'jueves', 'viernes']) d,
       lateral privado.horario_apartados(p_camion, d, v_fila -> d ->> 'hora', p_id) a;
  if v_ids is not null and not p_confirmar then
    perform privado.horario_confirmar(cardinality(v_ids), 'Si la eliminas, sus asientos se liberan sin cobro y se les avisa.');
  end if;
  if v_ids is not null then
    v_liberados := privado.horario_liberar(v_ids, 'se canceló');
  end if;

  delete from horarios_matriz where id = p_id;
  perform privado.log(current_setting('camify.rol', true), v_yo, 'horario_eliminado', jsonb_build_object(
    'camion', p_camion, 'salida', v_fila - 'id' - 'camion' - 'created_at', 'liberados', v_liberados));
  return json_build_object('liberados', v_liberados);
end;
$$;

-- Pasa una salida (todas sus horas de la semana) a otra unidad
create or replace function public.admin_horario_mover(p_token uuid, p_id bigint, p_destino integer, p_confirmar boolean default false)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_yo text := _validar_sesion(p_token, array['Admin']);
  v_fila jsonb;
  v_origen integer;
  v_dest record;
  v_r record;
  v_mover bigint[] := '{}';
  v_soltar bigint[] := '{}';
  v_liberados integer := 0;
begin
  perform _camion_valido(p_destino);
  select to_jsonb(h), coalesce(h.camion, 1) into v_fila, v_origen from horarios_matriz h where h.id = p_id for update;
  if not found then
    raise exception 'Esa salida ya no existe';
  end if;
  if v_origen = p_destino then
    raise exception 'La salida ya es de esa unidad';
  end if;
  select nombre, asientos, exclusivo_chinacates into v_dest from estado_viaje where id = p_destino;

  for v_r in
    select a.*
    from unnest(array['lunes', 'martes', 'miercoles', 'jueves', 'viernes']) d,
         lateral privado.horario_apartados(v_origen, d, v_fila -> d ->> 'hora', p_id) a
    order by a.creado_en, a.id
  loop
    -- Se va con la salida si su mismo asiento existe y está libre en la otra unidad
    if exists (select 1 from jsonb_array_elements(v_dest.asientos) s where (s ->> 'n')::int = v_r.asiento)
       and not exists (select 1 from reservas o where o.fecha = v_r.fecha and o.hora = v_r.hora and o.camion = p_destino and o.asiento = v_r.asiento)
       and (not v_dest.exclusivo_chinacates or (select ubicacion from alumnos where matricula = v_r.matricula) = 'chinacates') then
      v_mover := v_mover || v_r.id;
    else
      v_soltar := v_soltar || v_r.id;
    end if;
  end loop;

  if cardinality(v_mover) + cardinality(v_soltar) > 0 and not p_confirmar then
    perform privado.horario_confirmar(cardinality(v_mover) + cardinality(v_soltar), format(
      'Se pasarán a %s con su mismo asiento; si ese asiento no existe o está ocupado allá, se libera sin cobro. A todos se les avisa.', v_dest.nombre));
  end if;

  update horarios_matriz set camion = p_destino where id = p_id;
  for v_r in update reservas set camion = p_destino where id = any(v_mover) returning matricula, fecha, hora, asiento loop
    perform _avisar(v_r.matricula, 'salida_cambiada', format(
      'Tu salida del %s ahora sale en %s. Conservas tu asiento %s.', _salida_texto(v_r.fecha, v_r.hora), v_dest.nombre, v_r.asiento));
  end loop;
  if cardinality(v_soltar) > 0 then
    v_liberados := privado.horario_liberar(v_soltar, format('ahora sale en %s y tu asiento no está disponible allá', v_dest.nombre));
  end if;

  perform privado.log('Admin', v_yo, 'horario_movido', jsonb_build_object(
    'de', v_origen, 'a', p_destino, 'salida', v_fila - 'id' - 'camion' - 'created_at',
    'movidos', cardinality(v_mover), 'liberados', v_liberados));
  return json_build_object('movidos', cardinality(v_mover), 'liberados', v_liberados);
end;
$$;

revoke all on function public.chofer_horario_actualizar(uuid, bigint, text, jsonb, integer, boolean) from public;
grant execute on function public.chofer_horario_actualizar(uuid, bigint, text, jsonb, integer, boolean) to anon;
revoke all on function public.chofer_horario_eliminar(uuid, bigint, integer, boolean) from public;
grant execute on function public.chofer_horario_eliminar(uuid, bigint, integer, boolean) to anon;
revoke all on function public.admin_horario_mover(uuid, bigint, integer, boolean) from public;
grant execute on function public.admin_horario_mover(uuid, bigint, integer, boolean) to anon;

create or replace function privado.push_titulo_aviso(p_tipo text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_tipo
    when 'asiento_movido' then 'Cambiamos tu asiento'
    when 'asiento_pareja' then 'Tu pareja apartó tu lugar'
    when 'pareja_aceptada' then '¡Ya tienes pareja de viaje!'
    when 'pareja_rechazada' then 'Invitación no aceptada'
    when 'pareja_terminada' then 'Pareja de viaje terminada'
    when 'queja_respondida' then 'Respondieron tu queja'
    when 'queja_atendida' then 'Tu queja fue atendida'
    when 'emergencia' then 'Aviso de emergencia del camión'
    when 'apartado_perdido' then 'Perdiste tu apartado'
    when 'ubicacion_cambiada' then 'Cambiaron tu ubicación'
    when 'beca_cambiada' then 'Beca de transporte'
    when 'salida_cambiada' then 'Cambió tu salida'
    else 'CAMIFY'
  end
$$;
