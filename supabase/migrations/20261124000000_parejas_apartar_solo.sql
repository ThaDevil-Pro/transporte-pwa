-- Parejas: cada quien puede apartar solo (2026-11-23)
-- · alumno_apartar(p_sin_pareja): aparta solo mi asiento aunque tenga pareja; el de la pareja no cambia.
-- · alumno_liberar_asiento(p_quien): 'yo', 'pareja' o 'ambos'. Cualquiera de la pareja puede liberar
--   el asiento del otro (se le avisa). Con menos de una hora para la salida solo el dueño puede
--   liberar el suyo, porque ahí se cobra el apartado perdido.

drop function if exists public.alumno_apartar(uuid, date, time without time zone, integer, integer, boolean);

create or replace function public.alumno_apartar(p_token uuid, p_fecha date, p_hora time without time zone, p_camion integer, p_asiento integer, p_solo boolean default false, p_sin_pareja boolean default false)
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

  -- Solo yo: aparto mi asiento sin tocar el de mi pareja
  v_pareja := case when p_sin_pareja then null else _pareja_de(v_yo) end;
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

drop function if exists public.alumno_liberar_asiento(uuid, date, time without time zone);
create or replace function public.alumno_liberar_asiento(p_token uuid, p_fecha date, p_hora time without time zone, p_quien text default 'yo')
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_yo text := _validar_sesion(p_token, array['Estudiante']);
  v_pareja text := _pareja_de(v_yo);
  v_salida timestamptz := _salida_ts(p_fecha, p_hora);
  v_quien text := coalesce(p_quien, 'yo');
  v_m text;
  v_camion integer;
  v_asiento integer;
  v_cobro numeric := 0;
  v_liberados int := 0;
begin
  if v_quien not in ('yo', 'pareja', 'ambos') then
    raise exception 'Opción inválida';
  end if;
  if v_quien <> 'yo' and v_pareja is null then
    raise exception 'Ya no tienes pareja de viaje activa';
  end if;
  if _ahora() >= v_salida then
    raise exception 'Esta salida ya partió';
  end if;

  for v_m in select unnest(case v_quien when 'yo' then array[v_yo] when 'pareja' then array[v_pareja] else array[v_yo, v_pareja] end) loop
    v_camion := null;
    select camion, asiento into v_camion, v_asiento from reservas where fecha = p_fecha and hora = p_hora and matricula = v_m;
    if privado.salida_cerrada(p_fecha, p_hora, v_camion) then
      raise exception 'Esta salida ya partió';
    end if;
    if v_camion is null then
      continue;
    end if;
    -- Con menos de una hora se cobra el apartado perdido: eso solo lo decide el dueño del asiento
    if v_m <> v_yo and _ahora() >= v_salida - interval '1 hour' then
      raise exception 'Falta menos de una hora para la salida: solo % puede liberar su asiento.', _nombre_corto(v_m);
    end if;
    delete from reservas where fecha = p_fecha and hora = p_hora and matricula = v_m;
    update privado.cambios_asiento set estado = 'cancelada', respondida_en = now()
    where estado = 'pendiente' and fecha = p_fecha and hora = p_hora and v_m in (pide, a);
    v_liberados := v_liberados + 1;
    if v_m = v_yo then
      if _ahora() >= v_salida - interval '1 hour' then
        v_cobro := privado.cobrar_perdido(v_yo, v_camion, null, p_fecha, p_hora);
        perform privado.log('Estudiante', v_yo, 'apartado_cancelado_tarde', jsonb_build_object(
          'camion', v_camion, 'fecha', p_fecha, 'hora', to_char(p_hora, 'HH24:MI'), 'monto', v_cobro));
      end if;
    else
      perform _avisar(v_m, 'pareja_libero', format('%s liberó tu asiento %s de la salida del %s (%s). Puedes volver a apartar si todavía quieres ir.',
        _nombre_corto(v_yo), v_asiento, _salida_texto(p_fecha, p_hora), _camion_nombre(v_camion)));
      perform privado.log('Estudiante', v_yo, 'asiento_pareja_liberado', jsonb_build_object(
        'pareja', v_m, 'camion', v_camion, 'fecha', p_fecha, 'hora', to_char(p_hora, 'HH24:MI'), 'asiento', v_asiento));
    end if;
  end loop;
  return json_build_object('cobro', v_cobro, 'liberados', v_liberados);
end;
$$;

revoke all on function public.alumno_apartar(uuid, date, time without time zone, integer, integer, boolean, boolean) from public;
grant execute on function public.alumno_apartar(uuid, date, time without time zone, integer, integer, boolean, boolean) to anon, authenticated;
revoke all on function public.alumno_liberar_asiento(uuid, date, time without time zone, text) from public;
grant execute on function public.alumno_liberar_asiento(uuid, date, time without time zone, text) to anon, authenticated;

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
    when 'pareja_libero' then 'Tu pareja liberó tu asiento'
    else 'CAMIFY'
  end
$$;
