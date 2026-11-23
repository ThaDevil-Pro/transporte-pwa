-- Parejas sin reacomodo automático (2026-11-23)
-- Antes, si no quedaban filas dobles libres, el sistema movía a un alumno que iba solo para
-- juntar a la pareja, sin preguntarle. Ya no. Cuando no hay filas dobles libres, la pareja elige:
--   1. Separarse: quien aparta elige su asiento y a su pareja se le da el libre más cercano.
--   2. Otro vehículo: alumno_salidas dice cuántas filas dobles libres tiene cada salida.
--   3. Pedir un cambio: quien aparta toma el asiento libre junto a alguien que va solo y a esa
--      persona le llega una solicitud amable; si acepta, se cambia a otro asiento libre y la
--      pareja ocupa su lugar. Si no, nadie se mueve.

create table if not exists privado.cambios_asiento (
  id bigint generated always as identity primary key,
  creado_en timestamptz not null default now(),
  fecha date not null,
  hora time not null,
  camion integer not null,
  pide text not null references public.alumnos (matricula) on update cascade on delete cascade,
  pareja text not null references public.alumnos (matricula) on update cascade on delete cascade,
  a text not null references public.alumnos (matricula) on update cascade on delete cascade,
  asiento_pide integer not null,     -- el que apartó quien pide (junto al de la otra persona)
  asiento_actual integer not null,   -- el de la otra persona: lo ocuparía la pareja
  asiento_nuevo integer not null,    -- el que se le ofrece a la otra persona
  estado text not null default 'pendiente' check (estado in ('pendiente', 'aceptada', 'rechazada', 'cancelada', 'vencida')),
  respondida_en timestamptz
);
create index if not exists cambios_asiento_a_idx on privado.cambios_asiento (a) where estado = 'pendiente';
create index if not exists cambios_asiento_pide_idx on privado.cambios_asiento (pide) where estado = 'pendiente';
revoke all on privado.cambios_asiento from anon, authenticated;

-- Asiento libre más cercano a otro (misma fila primero), para separar a una pareja
create or replace function privado.asiento_cercano(p_camion integer, p_fecha date, p_hora time, p_asiento integer, p_excluir integer[])
returns integer
language sql
stable
set search_path = ''
as $$
  with g as (
    select (a ->> 'n')::int n, (a ->> 'r')::int r, (a ->> 'c')::int c
    from public.estado_viaje e cross join lateral jsonb_array_elements(e.asientos) a
    where e.id = p_camion
  ), base as (select r, c from g where n = p_asiento)
  select g.n from g, base
  where g.n <> all (p_excluir)
    and not exists (select 1 from public.reservas x where x.fecha = p_fecha and x.hora = p_hora and x.camion = p_camion and x.asiento = g.n)
  order by abs(g.r - base.r) * 2 + abs(g.c - base.c), g.n
  limit 1
$$;

-- "ventana" o "pasillo" para los mensajes
create or replace function privado.lugar_asiento(p_camion integer, p_asiento integer)
returns text
language sql
stable
set search_path = ''
as $$
  select case when (a ->> 'c')::int in (0, e.cols - 1) then 'ventana' else 'pasillo' end
  from public.estado_viaje e cross join lateral jsonb_array_elements(e.asientos) a
  where e.id = p_camion and (a ->> 'n')::int = p_asiento
$$;

revoke all on function privado.asiento_cercano(integer, date, time, integer, integer[]) from public, anon, authenticated;
revoke all on function privado.lugar_asiento(integer, integer) from public, anon, authenticated;

-- Mapa del alumno: sin modo de reacomodo. Con la pareja y sin filas dobles libres: 'pareja_llena'.
create or replace function public.alumno_mapa(p_token uuid, p_fecha date, p_hora time without time zone, p_camion integer)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_yo text := _validar_sesion(p_token, array['Estudiante']);
  v_pareja text := _pareja_de(v_yo);
  v_salida timestamptz := _salida_ts(p_fecha, p_hora);
  v_tipo text;
  v_libres int;
  v_libres_total int;
  v_modo text := 'solo';
  v_restriccion text;
  v_sol record;
begin
  select s.tipo into v_tipo from _salidas_programadas(p_fecha, 1) s where s.hora = p_hora and s.camion = p_camion;
  if v_tipo is null then
    raise exception 'Esa salida ya no está en el horario';
  end if;
  v_restriccion := coalesce(privado.motivo_no_aparta(v_yo, p_fecha, v_tipo, p_camion),
                            privado.motivo_viaje_pendiente(v_yo, p_fecha, p_hora));

  select count(*) into v_libres_total from privado.asientos_de(p_camion) g
  where not exists (select 1 from reservas r where r.fecha = p_fecha and r.hora = p_hora and r.camion = p_camion and r.asiento = g.n);

  if v_pareja is not null then
    select o.bancas_libres into v_libres from _opciones_pareja(p_fecha, p_hora, p_camion, array[v_yo, v_pareja]) o;
    v_modo := case when v_libres > 0 then 'pareja' else 'pareja_llena' end;
  end if;

  select c.id, c.asiento_pide, _nombre_corto(c.a) as nombre into v_sol
  from privado.cambios_asiento c
  where c.pide = v_yo and c.estado = 'pendiente' and c.fecha = p_fecha and c.hora = p_hora and c.camion = p_camion
  order by c.id desc limit 1;

  return json_build_object(
    'fecha', p_fecha,
    'hora', to_char(p_hora, 'HH24:MI'),
    'tipo', v_tipo,
    'camion', p_camion,
    'salida_en', v_salida,
    'abre_en', v_salida - interval '12 hours',
    'abierta', _ahora() >= v_salida - interval '12 hours' and _ahora() < v_salida and not privado.salida_cerrada(p_fecha, p_hora, p_camion),
    'modo', v_modo,
    'restriccion', v_restriccion,
    'pareja', case when v_pareja is null then null else json_build_object('nombre', _nombre_corto(v_pareja)) end,
    'solicitud', case when v_sol.id is null then null else json_build_object('id', v_sol.id, 'asiento', v_sol.asiento_pide, 'nombre', v_sol.nombre) end,
    'asientos', coalesce((
      with ocup as (
        select asiento, matricula, _pareja_de(matricula) is null as solo
        from reservas where fecha = p_fecha and hora = p_hora and camion = p_camion
      ), s as (
        select g.n, g.par,
               case when o.matricula is null then 'libre'
                    when o.matricula = v_yo then 'mio'
                    when o.matricula = v_pareja then 'pareja'
                    else 'ocupado' end as estado,
               coalesce(o.solo, false) as solo
        from privado.asientos_de(p_camion) g
        left join ocup o on o.asiento = g.n
      ), m as (
        select a.n, a.estado, b.estado as vecino, coalesce(b.solo, false) as vecino_solo
        from s a
        left join s b on b.n = a.par
      )
      select json_agg(json_build_object(
        'n', n,
        'estado', estado,
        'sel', v_restriccion is null and case v_modo
                 when 'solo' then estado = 'libre'
                 when 'pareja' then vecino is not null and estado <> 'ocupado' and vecino <> 'ocupado'
                                    and not (estado in ('mio', 'pareja') and vecino in ('mio', 'pareja'))
                 else estado = 'libre'
               end,
        -- Junto a alguien que va solo: se le puede pedir que se cambie (si queda otro libre para él)
        'pedible', v_modo = 'pareja_llena' and v_restriccion is null and estado = 'libre'
                   and vecino = 'ocupado' and vecino_solo and v_libres_total >= 2
      ) order by n)
      from m
    ), '[]'::json)
  );
end;
$$;

-- Apartar: sin reacomodo. p_solo con pareja = apartar separados (ella en el libre más cercano).
create or replace function public.alumno_apartar(p_token uuid, p_fecha date, p_hora time without time zone, p_camion integer, p_asiento integer, p_solo boolean default false)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_yo text := _validar_sesion(p_token, array['Estudiante']);
  v_pareja text;
  v_salida timestamptz := _salida_ts(p_fecha, p_hora);
  v_tipo text;
  v_ocupa text;
  v_vecino int;
  v_ocupa_vecino text;
  v_libres int;
  v_pareja_debe boolean := false;
  v_pareja_fuera boolean := false;
  v_pareja_con_viaje boolean := false;
  v_motivo text;
  v_devuelto numeric;
  v_k text;
  v_lugar_pareja int;
begin
  if (select ubicacion from alumnos where matricula = v_yo) is null then
    raise exception 'Primero elige dónde tomas el camión' using errcode = 'CMF05';
  end if;
  if not coalesce(privado.puede_apartar(v_yo, p_fecha), false) then
    raise exception 'Para apartar asiento tu adeudo debe ser de $60 o menos: debes $%. Paga en la administración.',
      to_char((select saldo from alumnos where matricula = v_yo), 'FM999,990.00');
  end if;
  perform pg_advisory_xact_lock(hashtext('salida:' || p_fecha::text || 'T' || p_hora::text));
  for v_k in select unnest(array_remove(array[v_yo, _pareja_de(v_yo)], null)) order by 1 loop
    perform pg_advisory_xact_lock(hashtext('alumno:' || v_k));
  end loop;

  select s.tipo into v_tipo from _salidas_programadas(p_fecha, 1) s where s.hora = p_hora and s.camion = p_camion;
  if v_tipo is null then
    raise exception 'Esa salida ya no está en el horario';
  end if;
  v_motivo := coalesce(privado.motivo_no_aparta(v_yo, p_fecha, v_tipo, p_camion),
                       privado.motivo_viaje_pendiente(v_yo, p_fecha, p_hora));
  if v_motivo is not null then
    raise exception '%', v_motivo;
  end if;
  if _ahora() < v_salida - interval '12 hours' then
    raise exception 'El apartado abre 12 horas antes de la salida';
  end if;
  if _ahora() >= v_salida or privado.salida_cerrada(p_fecha, p_hora, p_camion) then
    raise exception 'Esta salida ya partió';
  end if;
  if p_asiento is null or not exists (select 1 from privado.asientos_de(p_camion) a where a.n = p_asiento) then
    raise exception 'Asiento inválido';
  end if;
  with d as (
    delete from historial_viajes
    where matricula = v_yo and perdido and corte_id is null and salida_fecha = p_fecha and salida_hora = p_hora
    returning monto
  )
  select sum(monto) into v_devuelto from d;
  if v_devuelto is not null then
    update alumnos set saldo = saldo - v_devuelto where matricula = v_yo;
    perform privado.log('Estudiante', v_yo, 'apartado_recuperado', jsonb_build_object(
      'fecha', p_fecha, 'hora', to_char(p_hora, 'HH24:MI'), 'monto', v_devuelto));
  end if;

  v_pareja := _pareja_de(v_yo);
  if v_pareja is not null and not coalesce(privado.puede_apartar(v_pareja, p_fecha), false) then
    v_pareja := null;
    v_pareja_debe := true;
  elsif v_pareja is not null and privado.motivo_no_aparta(v_pareja, p_fecha, v_tipo, p_camion) is not null then
    v_pareja := null;
    v_pareja_fuera := true;
  elsif v_pareja is not null and exists (select 1 from privado.viaje_pendiente(v_pareja, p_fecha, p_hora)) then
    v_pareja := null;
    v_pareja_con_viaje := true;
  end if;
  select matricula into v_ocupa from reservas
  where fecha = p_fecha and hora = p_hora and camion = p_camion and asiento = p_asiento;

  -- Cualquier solicitud de cambio que tenga pendiente en esta salida deja de valer
  update privado.cambios_asiento set estado = 'cancelada', respondida_en = now()
  where pide = v_yo and estado = 'pendiente' and fecha = p_fecha and hora = p_hora;

  if v_pareja is null or p_solo then
    if v_ocupa is not null and v_ocupa <> v_yo then
      raise exception 'Ese asiento ya está ocupado';
    end if;
    if v_pareja is not null then
      select o.bancas_libres into v_libres
      from _opciones_pareja(p_fecha, p_hora, p_camion, array[v_yo, v_pareja]) o;
      if v_libres > 0 then
        raise exception 'Todavía pueden sentarse juntos: elige una fila de dos para los dos';
      end if;
    end if;
    delete from reservas where fecha = p_fecha and hora = p_hora and matricula = v_yo;
    insert into reservas (fecha, hora, tipo, camion, asiento, matricula) values (p_fecha, p_hora, v_tipo, p_camion, p_asiento, v_yo);

    -- Separados: si la pareja todavía no tiene lugar en esta salida, el libre más cercano
    if v_pareja is not null
       and not exists (select 1 from reservas where fecha = p_fecha and hora = p_hora and matricula = v_pareja) then
      v_lugar_pareja := privado.asiento_cercano(p_camion, p_fecha, p_hora, p_asiento, array[p_asiento]);
      if v_lugar_pareja is not null then
        insert into reservas (fecha, hora, tipo, camion, asiento, matricula) values (p_fecha, p_hora, v_tipo, p_camion, v_lugar_pareja, v_pareja);
        perform _avisar(v_pareja, 'asiento_pareja',
          format('Para la salida del %s (%s), %s apartó el asiento %s para ti. Ya no quedaban lugares juntos, así que van separados (el suyo es el %s).',
                 _salida_texto(p_fecha, p_hora), _camion_nombre(p_camion), _nombre_corto(v_yo), v_lugar_pareja, p_asiento));
      end if;
    end if;
    return json_build_object('asiento', p_asiento, 'asiento_pareja', v_lugar_pareja, 'separados', v_lugar_pareja is not null,
                             'pareja_debe', v_pareja_debe, 'pareja_fuera', v_pareja_fuera, 'pareja_con_viaje', v_pareja_con_viaje);
  end if;

  if v_ocupa is not null and v_ocupa not in (v_yo, v_pareja) then
    raise exception 'Ese asiento ya está ocupado';
  end if;
  select a.par into v_vecino from privado.asientos_de(p_camion) a where a.n = p_asiento;
  if v_vecino is null then
    raise exception 'Ese asiento va solo: elige una fila de dos para sentarse juntos';
  end if;

  delete from reservas where fecha = p_fecha and hora = p_hora and matricula in (v_yo, v_pareja);
  select matricula into v_ocupa_vecino from reservas
  where fecha = p_fecha and hora = p_hora and camion = p_camion and asiento = v_vecino;
  -- Ya no se mueve a nadie sin preguntarle: si el de al lado está ocupado, esa fila no sirve
  if v_ocupa_vecino is not null then
    raise exception 'Esa fila ya no está libre para los dos. Elige otra o usa una de las opciones para parejas.';
  end if;

  insert into reservas (fecha, hora, tipo, camion, asiento, matricula) values
    (p_fecha, p_hora, v_tipo, p_camion, p_asiento, v_yo),
    (p_fecha, p_hora, v_tipo, p_camion, v_vecino, v_pareja);

  perform _avisar(v_pareja, 'asiento_pareja',
    format('Para la salida del %s (%s), %s apartó el asiento %s para ti, junto al suyo.',
           _salida_texto(p_fecha, p_hora), _camion_nombre(p_camion), _nombre_corto(v_yo), v_vecino));

  return json_build_object('asiento', p_asiento, 'asiento_pareja', v_vecino, 'movido', false);
end;
$$;

-- Pedir a alguien que va solo que se cambie para que la pareja se siente junta
create or replace function public.alumno_pedir_cambio(p_token uuid, p_fecha date, p_hora time without time zone, p_camion integer, p_asiento integer)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_yo text := _validar_sesion(p_token, array['Estudiante']);
  v_pareja text := _pareja_de(v_yo);
  v_salida timestamptz := _salida_ts(p_fecha, p_hora);
  v_tipo text;
  v_motivo text;
  v_vecino int;
  v_otro text;
  v_nuevo int;
  v_libres int;
  v_id bigint;
  v_k text;
begin
  if v_pareja is null then
    raise exception 'Necesitas una pareja de viaje para pedir un cambio';
  end if;
  if not coalesce(privado.puede_apartar(v_yo, p_fecha), false) then
    raise exception 'Para apartar asiento tu adeudo debe ser de $60 o menos. Paga en la administración.';
  end if;
  perform pg_advisory_xact_lock(hashtext('salida:' || p_fecha::text || 'T' || p_hora::text));
  for v_k in select unnest(array[v_yo, v_pareja]) order by 1 loop
    perform pg_advisory_xact_lock(hashtext('alumno:' || v_k));
  end loop;

  select s.tipo into v_tipo from _salidas_programadas(p_fecha, 1) s where s.hora = p_hora and s.camion = p_camion;
  if v_tipo is null then
    raise exception 'Esa salida ya no está en el horario';
  end if;
  v_motivo := coalesce(privado.motivo_no_aparta(v_yo, p_fecha, v_tipo, p_camion),
                       privado.motivo_viaje_pendiente(v_yo, p_fecha, p_hora));
  if v_motivo is not null then
    raise exception '%', v_motivo;
  end if;
  if _ahora() < v_salida - interval '12 hours' or _ahora() >= v_salida or privado.salida_cerrada(p_fecha, p_hora, p_camion) then
    raise exception 'Esta salida no está abierta para apartar';
  end if;
  -- La pareja también tiene que poder viajar en esta salida
  if not coalesce(privado.puede_apartar(v_pareja, p_fecha), false)
     or privado.motivo_no_aparta(v_pareja, p_fecha, v_tipo, p_camion) is not null
     or exists (select 1 from privado.viaje_pendiente(v_pareja, p_fecha, p_hora)) then
    raise exception 'Tu pareja no puede apartar en esta salida (adeudo, ubicación u otro viaje): aparta solo tu asiento';
  end if;
  select o.bancas_libres into v_libres from _opciones_pareja(p_fecha, p_hora, p_camion, array[v_yo, v_pareja]) o;
  if v_libres > 0 then
    raise exception 'Todavía hay filas libres para los dos: elige una de esas';
  end if;

  if exists (select 1 from reservas where fecha = p_fecha and hora = p_hora and camion = p_camion and asiento = p_asiento and matricula <> v_yo) then
    raise exception 'Ese asiento ya está ocupado';
  end if;
  select a.par into v_vecino from privado.asientos_de(p_camion) a where a.n = p_asiento;
  select matricula into v_otro from reservas where fecha = p_fecha and hora = p_hora and camion = p_camion and asiento = v_vecino;
  if v_vecino is null or v_otro is null or v_otro in (v_yo, v_pareja) or _pareja_de(v_otro) is not null then
    raise exception 'Elige un asiento libre que esté junto a alguien que va solo';
  end if;
  if exists (select 1 from privado.cambios_asiento where a = v_otro and estado = 'pendiente' and fecha = p_fecha and hora = p_hora) then
    raise exception '% ya tiene otra solicitud pendiente. Elige otra fila.', _nombre_corto(v_otro);
  end if;
  if (select count(*) from privado.cambios_asiento where pide = v_yo and fecha = p_fecha and hora = p_hora) >= 5 then
    raise exception 'Ya enviaste 5 solicitudes para esta salida. Elige separarse u otro vehículo.';
  end if;
  v_nuevo := privado.asiento_cercano(p_camion, p_fecha, p_hora, v_vecino, array[p_asiento, v_vecino]);
  if v_nuevo is null then
    raise exception 'No queda otro asiento libre que ofrecerle. Elige separarse u otro vehículo.';
  end if;

  -- Quien pide se queda con el asiento libre de esa fila mientras tanto
  update privado.cambios_asiento set estado = 'cancelada', respondida_en = now()
  where pide = v_yo and estado = 'pendiente' and fecha = p_fecha and hora = p_hora;
  delete from reservas where fecha = p_fecha and hora = p_hora and matricula = v_yo;
  insert into reservas (fecha, hora, tipo, camion, asiento, matricula) values (p_fecha, p_hora, v_tipo, p_camion, p_asiento, v_yo);

  insert into privado.cambios_asiento (fecha, hora, camion, pide, pareja, a, asiento_pide, asiento_actual, asiento_nuevo)
  values (p_fecha, p_hora, p_camion, v_yo, v_pareja, v_otro, p_asiento, v_vecino, v_nuevo)
  returning id into v_id;

  perform privado.push_a('Estudiante', v_otro, format('%s te pide un favor', _nombre_corto(v_yo)),
    format('¿Te cambiarías al asiento %s para que viaje junto a su pareja? Abre CAMIFY para responder.', v_nuevo),
    'cambio-' || v_id);
  perform privado.log('Estudiante', v_yo, 'cambio_pedido', jsonb_build_object(
    'a', v_otro, 'camion', p_camion, 'fecha', p_fecha, 'hora', to_char(p_hora, 'HH24:MI'), 'asiento', v_vecino, 'nuevo', v_nuevo));
  return json_build_object('id', v_id, 'asiento', p_asiento, 'nombre', _nombre_corto(v_otro));
end;
$$;

create or replace function public.alumno_responder_cambio(p_token uuid, p_id bigint, p_aceptar boolean)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_yo text := _validar_sesion(p_token, array['Estudiante']);
  v_c privado.cambios_asiento%rowtype;
  v_nuevo int;
  v_tipo text;
  v_k text;
  v_salida text;
begin
  select * into v_c from privado.cambios_asiento where id = p_id and a = v_yo;
  if v_c.id is null or v_c.estado <> 'pendiente' then
    raise exception 'Esta solicitud ya no está disponible';
  end if;
  perform pg_advisory_xact_lock(hashtext('salida:' || v_c.fecha::text || 'T' || v_c.hora::text));
  for v_k in select unnest(array[v_c.pide, v_c.pareja, v_c.a]) order by 1 loop
    perform pg_advisory_xact_lock(hashtext('alumno:' || v_k));
  end loop;
  v_salida := format('%s (%s)', _salida_texto(v_c.fecha, v_c.hora), _camion_nombre(v_c.camion));

  if not p_aceptar then
    update privado.cambios_asiento set estado = 'rechazada', respondida_en = now() where id = p_id;
    perform _avisar(v_c.pide, 'cambio_rechazado', format(
      '%s prefirió conservar su asiento en la salida del %s. Tu lugar sigue apartado; puedes apartar a tu pareja en otro asiento o buscar otro vehículo.',
      _nombre_corto(v_yo), v_salida));
    return json_build_object('estado', 'rechazada');
  end if;

  -- Todo tiene que seguir igual que cuando se pidió
  if _salida_ts(v_c.fecha, v_c.hora) <= _ahora() or privado.salida_cerrada(v_c.fecha, v_c.hora, v_c.camion)
     or not exists (select 1 from reservas where fecha = v_c.fecha and hora = v_c.hora and camion = v_c.camion and asiento = v_c.asiento_actual and matricula = v_yo)
     or not exists (select 1 from reservas where fecha = v_c.fecha and hora = v_c.hora and camion = v_c.camion and asiento = v_c.asiento_pide and matricula = v_c.pide)
     or _pareja_de(v_c.pide) is distinct from v_c.pareja then
    update privado.cambios_asiento set estado = 'vencida', respondida_en = now() where id = p_id;
    raise exception 'Gracias, pero esta solicitud ya no aplica: algo cambió en la salida. Tu asiento se queda igual.';
  end if;

  v_nuevo := case when not exists (select 1 from reservas where fecha = v_c.fecha and hora = v_c.hora and camion = v_c.camion and asiento = v_c.asiento_nuevo)
                  then v_c.asiento_nuevo
                  else privado.asiento_cercano(v_c.camion, v_c.fecha, v_c.hora, v_c.asiento_actual, array[v_c.asiento_pide, v_c.asiento_actual]) end;
  if v_nuevo is null then
    update privado.cambios_asiento set estado = 'vencida', respondida_en = now() where id = p_id;
    raise exception 'Gracias, pero ya no queda otro asiento libre para cambiarte. Tu asiento se queda igual.';
  end if;

  select tipo into v_tipo from reservas where fecha = v_c.fecha and hora = v_c.hora and camion = v_c.camion and matricula = v_yo;
  update reservas set asiento = v_nuevo where fecha = v_c.fecha and hora = v_c.hora and camion = v_c.camion and matricula = v_yo;
  delete from reservas where fecha = v_c.fecha and hora = v_c.hora and matricula = v_c.pareja;
  insert into reservas (fecha, hora, tipo, camion, asiento, matricula)
  values (v_c.fecha, v_c.hora, v_tipo, v_c.camion, v_c.asiento_actual, v_c.pareja);
  update privado.cambios_asiento set estado = 'aceptada', respondida_en = now(), asiento_nuevo = v_nuevo where id = p_id;

  perform _avisar(v_c.pide, 'cambio_aceptado', format(
    '¡%s aceptó cambiarse! En la salida del %s viajan juntos: tú en el %s y tu pareja en el %s.',
    _nombre_corto(v_yo), v_salida, v_c.asiento_pide, v_c.asiento_actual));
  perform _avisar(v_c.pareja, 'asiento_pareja', format(
    'Para la salida del %s, %s apartó el asiento %s para ti, junto al suyo.',
    v_salida, _nombre_corto(v_c.pide), v_c.asiento_actual));
  perform privado.log('Estudiante', v_yo, 'cambio_aceptado', jsonb_build_object(
    'pide', v_c.pide, 'camion', v_c.camion, 'de', v_c.asiento_actual, 'a', v_nuevo));
  return json_build_object('estado', 'aceptada', 'asiento', v_nuevo);
end;
$$;

-- Estado de pareja: también trae las solicitudes de cambio (recibida y enviada) vigentes
create or replace function public.pareja_estado(p_token uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_yo text := _validar_sesion(p_token, array['Estudiante']);
  v_activa parejas%rowtype;
begin
  select * into v_activa from parejas
  where estado = 'activa' and expira_en > now() and v_yo in (invita, invitado)
  order by aceptada_en desc limit 1;

  return json_build_object(
    'activa', case when v_activa.id is null then null else json_build_object(
      'id', v_activa.id,
      'nombre', _nombre_corto(case when v_activa.invita = v_yo then v_activa.invitado else v_activa.invita end),
      'desde', v_activa.aceptada_en,
      'expira_en', v_activa.expira_en
    ) end,
    'enviada', (
      select json_build_object('id', id, 'nombre', _nombre_corto(invitado), 'creado_en', creado_en)
      from parejas where invita = v_yo and estado = 'pendiente'
      order by creado_en desc limit 1
    ),
    'recibidas', coalesce((
      select json_agg(json_build_object('id', id, 'nombre', _nombre_corto(invita), 'creado_en', creado_en) order by creado_en)
      from parejas where invitado = v_yo and estado = 'pendiente'
    ), '[]'::json),
    'cambio_recibido', (
      select json_build_object('id', c.id, 'nombre', _nombre_corto(c.pide), 'salida', _salida_texto(c.fecha, c.hora),
                               'camion', _camion_nombre(c.camion), 'actual', c.asiento_actual, 'nuevo', c.asiento_nuevo,
                               'lugar', privado.lugar_asiento(c.camion, c.asiento_nuevo))
      from privado.cambios_asiento c
      where c.a = v_yo and c.estado = 'pendiente' and _salida_ts(c.fecha, c.hora) > _ahora()
      order by c.id desc limit 1
    ),
    'cambio_enviado', (
      select json_build_object('id', c.id, 'nombre', _nombre_corto(c.a), 'salida', _salida_texto(c.fecha, c.hora))
      from privado.cambios_asiento c
      where c.pide = v_yo and c.estado = 'pendiente' and _salida_ts(c.fecha, c.hora) > _ahora()
      order by c.id desc limit 1
    )
  );
end;
$$;

-- Liberar: también cancela las solicitudes de cambio de esa salida
create or replace function public.alumno_liberar_asiento(p_token uuid, p_fecha date, p_hora time without time zone)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_yo text := _validar_sesion(p_token, array['Estudiante']);
  v_salida timestamptz := _salida_ts(p_fecha, p_hora);
  v_camion integer;
  v_cobro numeric := 0;
begin
  select camion into v_camion from reservas where fecha = p_fecha and hora = p_hora and matricula = v_yo;
  if _ahora() >= v_salida or privado.salida_cerrada(p_fecha, p_hora, v_camion) then
    raise exception 'Esta salida ya partió';
  end if;
  delete from reservas where fecha = p_fecha and hora = p_hora and matricula = v_yo;
  update privado.cambios_asiento set estado = 'cancelada', respondida_en = now()
  where estado = 'pendiente' and fecha = p_fecha and hora = p_hora and v_yo in (pide, a);
  if v_camion is not null and _ahora() >= v_salida - interval '1 hour' then
    v_cobro := privado.cobrar_perdido(v_yo, v_camion, null, p_fecha, p_hora);
    perform privado.log('Estudiante', v_yo, 'apartado_cancelado_tarde', jsonb_build_object(
      'camion', v_camion, 'fecha', p_fecha, 'hora', to_char(p_hora, 'HH24:MI'), 'monto', v_cobro));
  end if;
  return json_build_object('cobro', v_cobro);
end;
$$;

-- Salidas del alumno: cuántas filas dobles libres tiene cada una (para "otro vehículo")
create or replace function public.alumno_salidas(p_token uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_yo text := _validar_sesion(p_token, array['Estudiante']);
  v_pareja text := _pareja_de(v_yo);
  v_hoy date := (_ahora() at time zone 'America/Mexico_City')::date;
  v_ubic text := (select ubicacion from alumnos where matricula = v_yo);
begin
  return coalesce((
    select json_agg(x order by x.salida_en, x.camion)
    from (
      select s.fecha,
             to_char(s.hora, 'HH24:MI') as hora,
             s.tipo,
             s.camion,
             _salida_ts(s.fecha, s.hora) as salida_en,
             _salida_ts(s.fecha, s.hora) - interval '12 hours' as abre_en,
             _ahora() >= _salida_ts(s.fecha, s.hora) - interval '12 hours' as abierta,
             (select count(*) from reservas r where r.fecha = s.fecha and r.hora = s.hora and r.camion = s.camion)::int as ocupados,
             m.asiento as mi_asiento,
             (select r.asiento from reservas r where r.fecha = s.fecha and r.hora = s.hora and r.camion = s.camion and r.matricula = v_pareja) as asiento_pareja,
             e.exclusivo_chinacates as exclusivo,
             case when v_pareja is not null then
               (select o.bancas_libres from _opciones_pareja(s.fecha, s.hora, s.camion, array[v_yo, v_pareja]) o) end as dobles
      from _salidas_programadas(v_hoy, 8) s
      join estado_viaje e on e.id = s.camion
      left join reservas m on m.fecha = s.fecha and m.hora = s.hora and m.camion = s.camion and m.matricula = v_yo
      where _salida_ts(s.fecha, s.hora) > _ahora()
        and not privado.salida_cerrada(s.fecha, s.hora, s.camion)
        and (m.asiento is not null or (case
              when e.exclusivo_chinacates then v_ubic = 'chinacates'
              when v_ubic = 'chinacates' then privado.exclusiva_con_lugar(s.fecha, s.tipo) is null
              else true end))
      order by _salida_ts(s.fecha, s.hora), s.camion
      limit 15
    ) x
  ), '[]'::json);
end;
$$;

revoke all on function public.alumno_pedir_cambio(uuid, date, time, integer, integer) from public;
grant execute on function public.alumno_pedir_cambio(uuid, date, time, integer, integer) to anon;
revoke all on function public.alumno_responder_cambio(uuid, bigint, boolean) from public;
grant execute on function public.alumno_responder_cambio(uuid, bigint, boolean) to anon;

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
    when 'cambio_aceptado' then '¡Ya van juntos!'
    when 'cambio_rechazado' then 'Respuesta a tu solicitud'
    else 'CAMIFY'
  end
$$;
