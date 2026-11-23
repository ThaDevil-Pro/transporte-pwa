-- Emergencia del chofer (2026-11-23)
-- · La unidad queda fuera de servicio el resto del día (estado_viaje.fuera_hasta): no aparece para
--   apartar ni se puede apartar en ella, hasta que el chofer o un admin la marquen como reparada.
-- · El aviso ya no llega a todos los alumnos: solo a quien tenía apartado en ella y a quien viajó
--   en ella en las últimas dos semanas.
-- · alumno_salidas: la salida donde apartó sigue en su lista aunque ya pasó la hora, hasta el corte
--   (antes desaparecía y la tarjeta decía «Ya puedes apartar tu lugar» aunque tenía asiento).
-- · alumno_perfil.apartado: el apartado vigente del alumno aunque ya pasó la hora programada
--   (el camión suele salir tarde); la tarjeta del viaje sigue a ese camión y no al de la siguiente salida.

alter table public.estado_viaje add column if not exists fuera_hasta timestamptz;

create or replace function privado.motivo_no_aparta(p_matricula text, p_fecha date, p_tipo text, p_camion integer)
returns text
language plpgsql
stable
set search_path to ''
as $function$
declare
  v_ubic text := (select ubicacion from public.alumnos where matricula = p_matricula);
  v_excl boolean := coalesce((select exclusivo_chinacates from public.estado_viaje where id = p_camion), false);
  v_otra integer;
begin
  if v_ubic is null then
    return 'Primero elige dónde tomas el camión';
  end if;
  if (select fuera_hasta from public.estado_viaje where id = p_camion) > (p_fecha::timestamp at time zone 'America/Mexico_City') then
    return format('%s está fuera de servicio hoy (el chofer avisó de una falla). Elige otra unidad.', public._camion_nombre(p_camion));
  end if;
  if v_excl and v_ubic <> 'chinacates' then
    return 'Este vehículo es exclusivo para alumnos de Chinacates';
  end if;
  if not v_excl and v_ubic = 'chinacates' then
    v_otra := privado.exclusiva_con_lugar(p_fecha, p_tipo);
    if v_otra is not null then
      return format('Ese día hay salida de %s, exclusiva para Chinacates, con lugares: aparta ahí primero', public._camion_nombre(v_otra));
    end if;
  end if;
  return null;
end;
$function$;

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
      -- Su propia salida sigue en la lista aunque ya pasó la hora (el camión suele salir tarde), hasta el corte
      where (_salida_ts(s.fecha, s.hora) > _ahora()
             or (m.asiento is not null and _salida_ts(s.fecha, s.hora) > _ahora() - interval '3 hours'))
        and not privado.salida_cerrada(s.fecha, s.hora, s.camion)
        -- Unidad fuera de servicio (emergencia del chofer): no se ofrece
        and not coalesce(e.fuera_hasta > _salida_ts(s.fecha, s.hora), false)
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

CREATE OR REPLACE FUNCTION public.chofer_emergencia(p_token uuid, p_camion integer, p_motivo text, p_mensaje text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_chofer text := _validar_sesion(p_token, array['Chofer']);
  v_extra text := nullif(privado.limpiar_texto(p_mensaje), '');
  v_que text;
  v_texto text;
  v_n int;
  v_lib jsonb;
  v_hasta timestamptz := (privado.hoy() + 1)::timestamp at time zone 'America/Mexico_City';
begin
  perform _camion_valido(p_camion);
  if p_motivo is null or p_motivo not in ('descompuesto', 'no_disponible') then
    raise exception 'Elige qué pasó';
  end if;
  if char_length(coalesce(v_extra, '')) > 300 then
    raise exception 'El mensaje es muy largo (máximo 300 caracteres)';
  end if;
  if (select count(*) from privado.bitacora where accion = 'emergencia' and actor = v_chofer
        and creado_en > now() - interval '1 hour') >= 3 then
    raise exception 'Ya enviaste 3 avisos de emergencia en la última hora. Llama a la administración.';
  end if;
  if v_extra is not null then
    v_extra := (privado.censurar(v_extra)).texto;
  end if;

  v_que := case p_motivo when 'descompuesto' then 'se descompuso' else 'no estará disponible' end;
  v_texto := format('El camión %s %s. Hoy no se podrá apartar en él.', _camion_nombre(p_camion), v_que)
             || coalesce(' Mensaje del chofer: ' || v_extra, '');

  -- Fuera de servicio el resto del día (o hasta que el chofer o un admin la marquen como reparada)
  update estado_viaje set fuera_hasta = v_hasta where id = p_camion;

  -- Los apartados de esta unidad que no han salido se liberan sin cobro: si no, el alumno
  -- quedaría bloqueado por "un viaje a la vez" justo cuando tiene que buscar otra unidad
  with lib as (
    delete from reservas r
    where r.camion = p_camion
      and _salida_ts(r.fecha, r.hora) > _ahora() - interval '3 hours'
      and _salida_ts(r.fecha, r.hora) < v_hasta
      and not privado.salida_cerrada(r.fecha, r.hora, p_camion)
    returning r.matricula, r.fecha, r.hora
  )
  select coalesce(jsonb_object_agg(x.matricula, _salida_texto(x.fecha, x.hora)), '{}'::jsonb) into v_lib
  from (select distinct on (matricula) matricula, fecha, hora from lib order by matricula, fecha, hora) x;

  -- Solo a quien le afecta: quien tenía apartado en esta unidad y quien viajó en ella en las
  -- últimas dos semanas (las unidades no tienen ubicación fija; eso dice quién suele usarla)
  insert into avisos (matricula, tipo, mensaje)
  select a.matricula, 'emergencia', v_texto || case when v_lib ? a.matricula
           then case when v_texto ~ '[.!?]$' then '' else '.' end
                || format(' Tu asiento de la salida del %s se liberó sin cobro: ya puedes apartar en otra unidad.', v_lib ->> a.matricula)
           else '' end
  from alumnos a
  where v_lib ? a.matricula
     or exists (select 1 from historial_viajes h where h.matricula = a.matricula and h.camion = p_camion
                  and not h.perdido and h.fecha_hora > now() - interval '14 days');
  get diagnostics v_n = row_count;

  -- La administración lo ve en su buzón como falla urgente
  insert into fallas (chofer, chofer_nombre, camion, tipo, gravedad, descripcion)
  values (v_chofer, (select nombre from choferes where licencia = v_chofer), p_camion, 'otro', 'alta',
          format('EMERGENCIA: el camión %s. %s', v_que, coalesce(v_extra, 'Se avisó a todos los alumnos.')));

  perform privado.log('Chofer', v_chofer, 'emergencia', jsonb_build_object('camion', p_camion, 'motivo', p_motivo, 'avisados', v_n, 'liberados', (select count(*) from jsonb_object_keys(v_lib))));
  perform _senal('fallas');
  return json_build_object('avisados', v_n, 'liberados', (select count(*) from jsonb_object_keys(v_lib)));
end;
$function$;

create or replace function public.vehiculo_reparado(p_token uuid, p_camion integer)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ref text := _validar_sesion(p_token, array['Chofer', 'Admin']);
  v_rol text := (select rol from sesiones where token = p_token);
begin
  perform _camion_valido(p_camion);
  update estado_viaje set fuera_hasta = null where id = p_camion and fuera_hasta is not null;
  if found then
    perform privado.log(v_rol, v_ref, 'vehiculo_reparado', jsonb_build_object('camion', p_camion));
  end if;
  return json_build_object('ok', true);
end;
$$;
revoke all on function public.vehiculo_reparado(uuid, integer) from public;
grant execute on function public.vehiculo_reparado(uuid, integer) to anon, authenticated;

create or replace function public.alumno_perfil(p_token uuid)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_matricula text := _validar_sesion(p_token, array['Estudiante']);
begin
  return (
    select json_build_object('nombre', nombre, 'matricula', matricula, 'saldo', saldo,
                             'ubicacion', ubicacion, 'precio', privado.precio_boleto(matricula),
                             'abordo', (select b.camion from abordajes b where b.matricula = alumnos.matricula limit 1),
                             -- Su apartado vigente, aunque ya pasó la hora programada y el camión no ha salido
                             'apartado', (select json_build_object('camion', r.camion, 'salida_en', _salida_ts(r.fecha, r.hora))
                                          from reservas r
                                          where r.matricula = alumnos.matricula
                                            and _salida_ts(r.fecha, r.hora) > _ahora() - interval '3 hours'
                                            and not privado.salida_cerrada(r.fecha, r.hora, r.camion)
                                          order by _salida_ts(r.fecha, r.hora) limit 1))
    from alumnos where matricula = v_matricula
  );
end;
$function$;
