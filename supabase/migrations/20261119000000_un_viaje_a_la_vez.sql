-- CAMIFY · Un viaje apartado a la vez
-- Un alumno con asiento apartado no puede apartar en otra salida hasta que ese viaje termine.
-- Cambiar de asiento (o de vehículo) en la misma salida sí se permite, y si libera su asiento puede apartar otro.
-- Un viaje termina cuando el chofer lo finaliza después del corte. Si nunca se finaliza (se olvidó, se canceló),
-- se da por terminado 3 horas después de la hora de salida, para que nadie quede bloqueado.

-- Otro viaje del alumno que todavía no termina (distinto a la salida p_fecha/p_hora)
create or replace function privado.viaje_pendiente(p_matricula text, p_fecha date, p_hora time)
returns table (fecha date, hora time, camion smallint)
language sql
stable
security definer
set search_path = ''
as $$
  select r.fecha, r.hora, r.camion
  from public.reservas r
  where r.matricula = p_matricula
    and (r.fecha, r.hora) <> (p_fecha, p_hora)
    and public._salida_ts(r.fecha, r.hora) > public._ahora() - interval '3 hours'
    and not (
      -- Corte hecho y el chofer ya finalizó ese viaje
      privado.salida_cerrada(r.fecha, r.hora, r.camion)
      and not exists (
        select 1 from public.estado_viaje e
        where e.id = r.camion and e.estado = 'EN_CAMINO'
          and (select (c.salida_fecha, c.salida_hora) from privado.cortes c
               where c.camion = r.camion order by c.id desc limit 1) = (r.fecha, r.hora)
      )
    )
  order by r.fecha, r.hora
  limit 1
$$;

create or replace function privado.motivo_viaje_pendiente(p_matricula text, p_fecha date, p_hora time)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select format('Ya tienes apartado el viaje del %s (%s). Podrás apartar otro cuando termine ese viaje.',
                public._salida_texto(v.fecha, v.hora), public._camion_nombre(v.camion))
  from privado.viaje_pendiente(p_matricula, p_fecha, p_hora) v
$$;

revoke all on function privado.viaje_pendiente(text, date, time) from public, anon, authenticated;
revoke all on function privado.motivo_viaje_pendiente(text, date, time) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Mapa: con otro viaje pendiente se ve el aviso y los asientos no se pueden elegir
-- ---------------------------------------------------------------------
create or replace function public.alumno_mapa(p_token uuid, p_fecha date, p_hora time without time zone, p_camion integer)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_yo text := _validar_sesion(p_token, array['Estudiante']);
  v_pareja text := _pareja_de(v_yo);
  v_salida timestamptz := _salida_ts(p_fecha, p_hora);
  v_tipo text;
  v_libres int;
  v_medias int;
  v_modo text := 'solo';
  v_restriccion text;
begin
  select s.tipo into v_tipo from _salidas_programadas(p_fecha, 1) s where s.hora = p_hora and s.camion = p_camion;
  if v_tipo is null then
    raise exception 'Esa salida ya no está en el horario';
  end if;
  v_restriccion := coalesce(privado.motivo_no_aparta(v_yo, p_fecha, v_tipo, p_camion),
                            privado.motivo_viaje_pendiente(v_yo, p_fecha, p_hora));

  if v_pareja is not null then
    select o.bancas_libres, o.medias_solos into v_libres, v_medias
    from _opciones_pareja(p_fecha, p_hora, p_camion, array[v_yo, v_pareja]) o;
    v_modo := case when v_libres > 0 then 'pareja'
                   when v_medias >= 2 then 'pareja_reacomodo'
                   else 'pareja_sin_banca' end;
  end if;

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
                 when 'pareja_reacomodo' then vecino is not null and estado <> 'ocupado' and vecino = 'ocupado' and vecino_solo
                 else estado = 'libre'
               end,
        'mover', v_modo = 'pareja_reacomodo' and vecino is not null and estado <> 'ocupado' and vecino = 'ocupado' and vecino_solo
      ) order by n)
      from m
    ), '[]'::json)
  );
end;
$function$;

-- ---------------------------------------------------------------------
-- Apartar: se rechaza si el alumno tiene otro viaje pendiente; si es la pareja, se aparta solo para él
-- ---------------------------------------------------------------------
create or replace function public.alumno_apartar(p_token uuid, p_fecha date, p_hora time without time zone, p_camion integer, p_asiento integer, p_solo boolean default false)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_yo text := _validar_sesion(p_token, array['Estudiante']);
  v_pareja text;
  v_salida timestamptz := _salida_ts(p_fecha, p_hora);
  v_tipo text;
  v_ocupa text;
  v_vecino int;
  v_ocupa_vecino text;
  v_destino int;
  v_libres int;
  v_medias int;
  v_movido boolean := false;
  v_pareja_debe boolean := false;
  v_pareja_fuera boolean := false;
  v_pareja_con_viaje boolean := false;
  v_motivo text;
  v_devuelto numeric;
  v_k text;
begin
  if (select ubicacion from alumnos where matricula = v_yo) is null then
    raise exception 'Primero elige dónde tomas el camión' using errcode = 'CMF05';
  end if;
  if not coalesce(privado.puede_apartar(v_yo, p_fecha), false) then
    raise exception 'Para apartar asiento tu adeudo debe ser de $60 o menos: debes $%. Paga en la administración.',
      to_char((select saldo from alumnos where matricula = v_yo), 'FM999,990.00');
  end if;
  perform pg_advisory_xact_lock(hashtext('salida:' || p_fecha::text || 'T' || p_hora::text));
  -- Un alumno (y su pareja) a la vez, aunque aparte desde dos teléfonos en salidas distintas; siempre en el mismo orden
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

  if v_pareja is null or p_solo then
    if v_pareja is not null then
      select o.bancas_libres, o.medias_solos into v_libres, v_medias
      from _opciones_pareja(p_fecha, p_hora, p_camion, array[v_yo, v_pareja]) o;
      if v_libres > 0 or v_medias >= 2 then
        raise exception 'Todavía pueden sentarse juntos: elige una fila de dos para los dos';
      end if;
    end if;
    if v_ocupa is not null and v_ocupa <> v_yo then
      raise exception 'Ese asiento ya está ocupado';
    end if;
    delete from reservas where fecha = p_fecha and hora = p_hora and matricula = v_yo;
    insert into reservas (fecha, hora, tipo, camion, asiento, matricula) values (p_fecha, p_hora, v_tipo, p_camion, p_asiento, v_yo);
    return json_build_object('asiento', p_asiento, 'pareja_debe', v_pareja_debe, 'pareja_fuera', v_pareja_fuera,
                             'pareja_con_viaje', v_pareja_con_viaje);
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

  if v_ocupa_vecino is not null then
    if _pareja_de(v_ocupa_vecino) is not null then
      raise exception 'Esa fila no está disponible para sentarse juntos';
    end if;
    select o.bancas_libres into v_libres from _opciones_pareja(p_fecha, p_hora, p_camion, array[v_yo, v_pareja]) o;
    if v_libres > 0 then
      raise exception 'Elige una fila de dos libre para sentarse juntos';
    end if;

    select t.n into v_destino
    from privado.asientos_de(p_camion) t
    where t.n not in (p_asiento, v_vecino)
      and t.par is not null
      and not exists (select 1 from reservas r where r.fecha = p_fecha and r.hora = p_hora and r.camion = p_camion and r.asiento = t.n)
      and exists (
        select 1 from reservas r
        where r.fecha = p_fecha and r.hora = p_hora and r.camion = p_camion
          and r.asiento = t.par
          and _pareja_de(r.matricula) is null
      )
    order by t.n
    limit 1;

    if v_destino is null then
      raise exception 'Ya no hay forma de sentarse juntos en esta salida';
    end if;

    update reservas set asiento = v_destino
    where fecha = p_fecha and hora = p_hora and camion = p_camion and matricula = v_ocupa_vecino;
    perform _avisar(v_ocupa_vecino, 'asiento_movido',
      format('Para la salida del %s (%s), tu asiento cambió del %s al %s, junto a otro compañero, para que una pareja pudiera sentarse junta.',
             _salida_texto(p_fecha, p_hora), _camion_nombre(p_camion), v_vecino, v_destino));
    v_movido := true;
  end if;

  insert into reservas (fecha, hora, tipo, camion, asiento, matricula) values
    (p_fecha, p_hora, v_tipo, p_camion, p_asiento, v_yo),
    (p_fecha, p_hora, v_tipo, p_camion, v_vecino, v_pareja);

  perform _avisar(v_pareja, 'asiento_pareja',
    format('Para la salida del %s (%s), %s apartó el asiento %s para ti, junto al suyo.',
           _salida_texto(p_fecha, p_hora), _camion_nombre(p_camion), _nombre_corto(v_yo), v_vecino));

  return json_build_object('asiento', p_asiento, 'asiento_pareja', v_vecino, 'movido', v_movido);
end;
$function$;
