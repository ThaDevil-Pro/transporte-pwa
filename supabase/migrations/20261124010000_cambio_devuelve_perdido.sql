-- Al aceptar una solicitud de cambio, la pareja recupera lugar en esa salida:
-- si se le había cobrado como apartado perdido, se le devuelve (igual que al re-apartar).

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
  -- Si le habían cobrado esta salida como apartado perdido, al recuperar lugar se le devuelve
  perform privado.devolver_perdido(v_c.pareja, v_c.fecha, v_c.hora);
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
