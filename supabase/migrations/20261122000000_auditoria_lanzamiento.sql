-- Auditoría antes del lanzamiento (2026-11-22)
-- 1. Viajes colgados: abordajes sin corte de hace más de 4 h se descartan (con registro en la
--    bitácora) y un viaje con corte que nadie finalizó se finaliza solo 6 h después del corte.
--    Antes, un alumno escaneado y sin corte se quedaba "a bordo" para siempre: no podía subir a
--    otra unidad y se le cobraba en el siguiente corte de ese camión.
-- 2. Emergencia: los apartados de la unidad que falló se liberan sin cobro y se avisa a cada uno;
--    antes quedaban bloqueados por "un viaje a la vez" justo cuando tenían que buscar otra unidad.
-- 3. Código QR: 2 horas de códigos guardados en el teléfono (antes 5 minutos), para la parada sin señal.
-- 4. Baja o cambio de un vehículo: solo se avisa por salidas que todavía no pasan.
-- 5. Índice del historial por alumno.
-- 6. Los avisos masivos marcan actividad una sola vez (menos mensajes en vivo).

create or replace function privado.limpiar_viajes_viejos()
returns void
language plpgsql
set search_path = ''
as $$
declare
  v record;
begin
  -- Corte hecho y nadie tocó "Finalizar": se finaliza solo 6 h después del corte
  for v in
    select e.id from public.estado_viaje e
    where e.estado = 'EN_CAMINO'
      and coalesce((select max(c.creado_en) from privado.cortes c where c.camion = e.id), e.updated_at) < now() - interval '6 hours'
  loop
    delete from public.abordajes where camion = v.id;
    update public.estado_viaje
       set estado = 'ESPERANDO', tiempo_salida = null, temporizador_activo = false, updated_at = now()
     where id = v.id;
    perform privado.log(null, null, 'viaje_finalizado_auto', jsonb_build_object('camion', v.id));
  end loop;

  -- Alumnos escaneados hace más de 4 h en un viaje sin corte: el chofer no lo cerró y nadie les cobró.
  -- Se quitan de la lista (para que no se les cobre en otro viaje) y quedan en la bitácora.
  for v in
    select b.camion, array_agg(b.id) ids,
           jsonb_agg(jsonb_build_object('matricula', b.matricula, 'nombre', b.nombre, 'subio', b.created_at) order by b.created_at) alumnos
    from public.abordajes b
    join public.estado_viaje e on e.id = b.camion
    where e.estado <> 'EN_CAMINO' and b.created_at < now() - interval '4 hours'
    group by b.camion
  loop
    delete from public.abordajes where id = any (v.ids);
    perform privado.log(null, null, 'abordajes_descartados', jsonb_build_object('camion', v.camion, 'alumnos', v.alumnos));
  end loop;

  -- Conteos de salida que se quedaron encendidos
  update public.estado_viaje
     set temporizador_activo = false, tiempo_salida = null, updated_at = now()
   where temporizador_activo and tiempo_salida < now() - interval '2 hours' and estado <> 'EN_CAMINO';
end;
$$;
revoke all on function privado.limpiar_viajes_viejos() from public, anon, authenticated;

CREATE OR REPLACE FUNCTION public._abordar(p_camion integer, p_matricula text, p_manual boolean, p_asiento integer DEFAULT NULL::integer)
 RETURNS json
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_nombre text;
  v_saldo numeric;
  v_ubic text;
  v_otro_camion int;
  v_s record;
  v_ocupa text;
  v_asiento int;
  v_ocupados int;
  v_de_pie boolean;
  v_asignado boolean := false;
  v_auto boolean := false;
  v_cap int := privado.capacidad(p_camion);
  v_libre int;
begin
  lock table abordajes in share row exclusive mode;
  perform privado.limpiar_viajes_viejos();

  if (select estado from estado_viaje where id = p_camion) = 'EN_CAMINO' then
    raise exception 'El corte de este viaje ya se hizo. Finaliza el viaje antes de subir a más alumnos.';
  end if;

  select nombre, saldo, ubicacion into v_nombre, v_saldo, v_ubic from alumnos where matricula = p_matricula;
  if v_nombre is null then
    raise exception 'Este alumno ya no está registrado';
  end if;

  if (select exclusivo_chinacates from estado_viaje where id = p_camion) and v_ubic is distinct from 'chinacates' then
    raise exception '% no es de Chinacates: este vehículo es exclusivo para alumnos de Chinacates.', split_part(v_nombre, ' ', 1);
  end if;

  select camion into v_otro_camion from abordajes where matricula = p_matricula;
  if v_otro_camion = p_camion then
    raise exception 'El alumno (%) ya está a bordo', p_matricula;
  elsif v_otro_camion is not null then
    raise exception 'El alumno (%) ya está a bordo de %', p_matricula, _camion_nombre(v_otro_camion);
  end if;

  if v_saldo > 600 then
    raise exception '% debe $% (el máximo es $600). Tiene que pagar en la administración antes de subir.',
      split_part(v_nombre, ' ', 1), to_char(v_saldo, 'FM999,990.00');
  end if;

  select * into v_s from _salida_actual(p_camion);

  -- Lugares ocupados: apartados de esta salida + sentados sin apartar
  if v_s.fecha is not null then
    select (select count(*) from reservas r
             where r.fecha = v_s.fecha and r.hora = v_s.hora and r.camion = p_camion)
         + (select count(*) from abordajes b
             where b.camion = p_camion and not b.de_pie
               and not exists (select 1 from reservas r where r.fecha = v_s.fecha and r.hora = v_s.hora
                                 and r.camion = p_camion and r.matricula = b.matricula))
      into v_ocupados;
  else
    select count(*) into v_ocupados from abordajes b where b.camion = p_camion and not b.de_pie;
  end if;

  if v_s.fecha is not null then
    if p_asiento is not null then
      if not exists (select 1 from privado.asientos_de(p_camion) a where a.n = p_asiento) then
        raise exception 'Asiento inválido';
      end if;
      select matricula into v_ocupa from reservas
      where fecha = v_s.fecha and hora = v_s.hora and camion = p_camion and asiento = p_asiento;
      if v_ocupa is not null and v_ocupa <> p_matricula then
        raise exception 'El asiento % ya está ocupado', p_asiento;
      end if;
      v_asignado := not exists (select 1 from reservas where fecha = v_s.fecha and hora = v_s.hora
                                  and camion = p_camion and matricula = p_matricula);
      delete from reservas where fecha = v_s.fecha and hora = v_s.hora and matricula = p_matricula;
      begin
        insert into reservas (fecha, hora, tipo, camion, asiento, matricula)
        values (v_s.fecha, v_s.hora, v_s.tipo, p_camion, p_asiento, p_matricula);
      exception when unique_violation then
        raise exception 'El asiento % se acaba de ocupar. Elige otro.', p_asiento;
      end;
    elsif coalesce(v_saldo, 0) > 60
          and not exists (select 1 from reservas where fecha = v_s.fecha and hora = v_s.hora
                            and camion = p_camion and matricula = p_matricula) then
      -- Debe más de $60 (no pudo apartar): se le da el primer asiento libre que nadie apartó
      if v_ocupados < v_cap then
        select a.n into v_libre
        from privado.asientos_de(p_camion) a
        where not exists (select 1 from reservas r where r.fecha = v_s.fecha and r.hora = v_s.hora
                            and r.camion = p_camion and r.asiento = a.n)
        order by a.n
        limit 1;
      end if;
      if v_libre is null then
        raise exception '% debe $% y ya no hay asientos libres sin apartar: no puede subir.',
          split_part(v_nombre, ' ', 1), to_char(v_saldo, 'FM999,990.00');
      end if;
      delete from reservas where fecha = v_s.fecha and hora = v_s.hora and matricula = p_matricula;
      insert into reservas (fecha, hora, tipo, camion, asiento, matricula)
      values (v_s.fecha, v_s.hora, v_s.tipo, p_camion, v_libre, p_matricula);
      v_asignado := true;
      v_auto := true;
    end if;
    select asiento into v_asiento from reservas
    where fecha = v_s.fecha and hora = v_s.hora and camion = p_camion and matricula = p_matricula;
  end if;

  -- Sin asiento propio y con todos los lugares ocupados: va de pie (no si debe más de $60)
  if v_asiento is null then
    v_de_pie := v_ocupados >= v_cap;
    if v_de_pie and coalesce(v_saldo, 0) > 60 then
      raise exception '% debe $% y ya no hay asientos libres: no puede subir de pie.',
        split_part(v_nombre, ' ', 1), to_char(v_saldo, 'FM999,990.00');
    end if;
  else
    v_de_pie := false;
  end if;

  insert into abordajes (nombre, matricula, camion, manual, de_pie, asiento_asignado)
  values (v_nombre, p_matricula, p_camion, p_manual, v_de_pie, v_asignado);

  return json_build_object('nombre', v_nombre, 'asiento', v_asiento, 'de_pie', v_de_pie, 'asignado', v_auto, 'ubicacion', v_ubic);
end;
$function$;

CREATE OR REPLACE FUNCTION public.chofer_hacer_corte(p_token uuid, p_camion integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_chofer text := _validar_sesion(p_token, array['Chofer']);
  v_total integer;
  v_manuales integer;
  v_de_pie integer;
  v_monto numeric;
  v_corte bigint;
  v_sal record;
  v_q record;
  v_cobro numeric;
  v_perdidos integer := 0;
begin
  perform _camion_valido(p_camion);
  lock table abordajes in share row exclusive mode;
  perform privado.limpiar_viajes_viejos();

  if (select estado from estado_viaje where id = p_camion for update) = 'EN_CAMINO' then
    raise exception 'Ya se hizo el corte de este viaje. Finalízalo antes de cobrar otro.';
  end if;
  select * into v_sal from _salida_actual(p_camion);

  with orden as (
    select b.id, row_number() over (order by (r.matricula is not null), b.created_at desc, b.id desc) as n
    from abordajes b
    left join reservas r on r.fecha = v_sal.fecha and r.hora = v_sal.hora and r.camion = p_camion and r.matricula = b.matricula
    where b.camion = p_camion
  )
  update abordajes a
     set de_pie = o.n <= greatest(0, (select count(*) from abordajes where camion = p_camion) - privado.capacidad(p_camion))
    from orden o where a.id = o.id;

  if not exists (select 1 from abordajes where camion = p_camion)
     and not exists (select 1 from reservas where fecha = v_sal.fecha and hora = v_sal.hora and camion = p_camion) then
    raise exception 'No hay estudiantes en la lista de abordaje.';
  end if;
  -- El alumno de prueba no cuenta en el corte
  select count(*), count(*) filter (where manual), count(*) filter (where de_pie)
    into v_total, v_manuales, v_de_pie
  from abordajes where camion = p_camion and not privado.es_prueba(matricula);

  insert into privado.cortes (chofer, chofer_nombre, camion, alumnos, manuales, de_pie, total, salida_fecha, salida_hora)
  values (v_chofer, (select nombre from choferes where licencia = v_chofer), p_camion, v_total, v_manuales, v_de_pie, 0, v_sal.fecha, v_sal.hora)
  returning id into v_corte;

  with nuevos as (
    insert into historial_viajes (matricula, monto, fecha_hora, camion, manual, corte_id, de_pie, salida_fecha, salida_hora)
    select matricula, privado.cobro_viaje(matricula), now(), p_camion, manual, v_corte, de_pie, v_sal.fecha, v_sal.hora
    from abordajes where camion = p_camion and not privado.es_prueba(matricula)
    returning matricula, monto
  )
  update alumnos a set saldo = coalesce(a.saldo, 0) + n.monto
  from nuevos n where a.matricula = n.matricula;

  update abordajes b set cobrado = h.monto
    from historial_viajes h where h.corte_id = v_corte and h.matricula = b.matricula and b.camion = p_camion;
  update abordajes set cobrado = 0 where camion = p_camion and privado.es_prueba(matricula);

  if v_sal.fecha is not null and _ahora() >= _salida_ts(v_sal.fecha, v_sal.hora) - interval '20 minutes' then
    -- El apartado del alumno de prueba se quita sin cobro ni aviso
    delete from reservas r
    where r.fecha = v_sal.fecha and r.hora = v_sal.hora and r.camion = p_camion and privado.es_prueba(r.matricula);
    for v_q in
      delete from reservas r
      where r.fecha = v_sal.fecha and r.hora = v_sal.hora and r.camion = p_camion
        and not exists (select 1 from abordajes b where b.matricula = r.matricula)
        and not exists (select 1 from historial_viajes h where h.matricula = r.matricula and not h.perdido
                          and h.salida_fecha = v_sal.fecha and h.salida_hora = v_sal.hora)
      returning r.matricula
    loop
      v_cobro := privado.cobrar_perdido(v_q.matricula, p_camion, v_corte, v_sal.fecha, v_sal.hora);
      perform _avisar(v_q.matricula, 'apartado_perdido', format(
        'Apartaste asiento en la salida del %s (%s) y no subiste. Se te cobró el boleto completo: $%s. Tu siguiente viaje se cobra como nuevo.',
        _salida_texto(v_sal.fecha, v_sal.hora), _camion_nombre(p_camion), to_char(v_cobro, 'FM999,990')));
      v_perdidos := v_perdidos + 1;
    end loop;
  end if;

  select coalesce(sum(monto), 0) into v_monto from historial_viajes where corte_id = v_corte;
  update privado.cortes set total = v_monto, perdidos = v_perdidos where id = v_corte;

  update estado_viaje set estado = 'EN_CAMINO', updated_at = now() where id = p_camion;
  perform privado.log('Chofer', v_chofer, 'corte', jsonb_build_object('camion', p_camion, 'alumnos', v_total,
    'total', v_monto, 'manuales', v_manuales, 'de_pie', v_de_pie, 'perdidos', v_perdidos,
    'monto_perdidos', (select coalesce(sum(monto), 0) from historial_viajes where corte_id = v_corte and perdido),
    'salida', case when v_sal.fecha is null then null else to_char(v_sal.hora, 'HH24:MI') end));
  return v_total;
end;
$function$;

CREATE OR REPLACE FUNCTION public.chofer_abordajes(p_token uuid, p_camion integer)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform _validar_sesion(p_token, array['Chofer']);
  perform _camion_valido(p_camion);
  perform privado.limpiar_viajes_viejos();
  return coalesce((
    select json_agg(to_jsonb(b) || jsonb_build_object(
                      'cobro', coalesce(b.cobrado, privado.cobro_viaje(b.matricula)),
                      'ubicacion', (select a.ubicacion from alumnos a where a.matricula = b.matricula))
                    order by b.created_at)
    from abordajes b where b.camion = p_camion
  ), '[]'::json);
end;
$function$;

CREATE OR REPLACE FUNCTION public.chofer_jornada(p_token uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_yo text := _validar_sesion(p_token, array['Chofer']);
  v_hoy date := privado.hoy();
begin
  perform privado.limpiar_viajes_viejos();
  return json_build_object(
    'fecha', v_hoy,
    'camion', (select j.camion from privado.jornadas j
               join estado_viaje e on e.id = j.camion and e.activo
               where j.fecha = v_hoy and j.chofer = v_yo),
    'vehiculos', coalesce((
      select json_agg(json_build_object(
        'id', e.id, 'nombre', e.nombre, 'tipo', e.tipo, 'color', e.color,
        'capacidad', jsonb_array_length(e.asientos), 'exclusivo', e.exclusivo_chinacates,
        'ocupado_por', (select c.nombre from privado.jornadas j join choferes c on c.licencia = j.chofer
                        where j.fecha = v_hoy and j.camion = e.id and j.chofer <> v_yo)
      ) order by e.id)
      from estado_viaje e where e.activo
    ), '[]'::json)
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.alumno_qr(p_token uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_yo text := _validar_sesion(p_token, array['Estudiante']);
  v_ventana bigint := privado.qr_ventana();
  v_saldo numeric := (select saldo from alumnos where matricula = v_yo);
begin
  if v_saldo > 600 then
    raise exception 'Debes $% y el máximo es $600. Paga en la administración para volver a generar tu código.',
      to_char(v_saldo, 'FM999,990.00') using errcode = 'CMF02';
  end if;
  return json_build_object(
    'ahora', floor(extract(epoch from now()) * 1000)::bigint,
    'periodo', 30,
    'codigos', (
      select json_agg(json_build_object('v', w, 'codigo', 'CMF1.' || v_yo || '.' || w || '.' || privado.qr_firma(v_yo, w)) order by w)
      from generate_series(v_ventana, v_ventana + 239) w
    )
  );
end;
$function$;

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
  v_texto := format('El camión %s %s. Si apartaste asiento en él, ese lugar no estará disponible.', _camion_nombre(p_camion), v_que)
             || coalesce(' Mensaje del chofer: ' || v_extra, '');

  -- Los apartados de esta unidad que no han salido se liberan sin cobro: si no, el alumno
  -- quedaría bloqueado por "un viaje a la vez" justo cuando tiene que buscar otra unidad
  with lib as (
    delete from reservas r
    where r.camion = p_camion
      and _salida_ts(r.fecha, r.hora) > _ahora() - interval '3 hours'
      and not privado.salida_cerrada(r.fecha, r.hora, p_camion)
    returning r.matricula, r.fecha, r.hora
  )
  select coalesce(jsonb_object_agg(x.matricula, _salida_texto(x.fecha, x.hora)), '{}'::jsonb) into v_lib
  from (select distinct on (matricula) matricula, fecha, hora from lib order by matricula, fecha, hora) x;

  insert into avisos (matricula, tipo, mensaje)
  select a.matricula, 'emergencia', v_texto || case when v_lib ? a.matricula
           then case when v_texto ~ '[.!?]$' then '' else '.' end
                || format(' Tu asiento de la salida del %s se liberó sin cobro: ya puedes apartar en otra unidad.', v_lib ->> a.matricula)
           else '' end
  from alumnos a;
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

CREATE OR REPLACE FUNCTION public.admin_vehiculo_eliminar(p_token uuid, p_id integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_admin text := _validar_sesion(p_token, array['Admin']);
  v_nombre text;
  v_q record;
begin
  select nombre into v_nombre from estado_viaje where id = p_id and activo;
  if v_nombre is null then
    raise exception 'Ese vehículo ya no existe';
  end if;
  if exists (select 1 from abordajes where camion = p_id) or (select estado from estado_viaje where id = p_id) = 'EN_CAMINO' then
    raise exception 'El vehículo tiene un viaje en curso. Espera a que el chofer lo finalice.';
  end if;

  delete from horarios_matriz where camion = p_id;
  for v_q in
    delete from reservas where camion = p_id and fecha >= privado.hoy() returning matricula, fecha, hora
  loop
    -- Solo se avisa por salidas que todavía no pasan
    if _salida_ts(v_q.fecha, v_q.hora) > _ahora() then
      perform _avisar(v_q.matricula, 'asiento_movido',
        format('El vehículo %s se dio de baja: tu asiento de la salida del %s se liberó.', v_nombre, _salida_texto(v_q.fecha, v_q.hora)));
    end if;
  end loop;
  delete from privado.jornadas where camion = p_id and fecha >= privado.hoy();
  update estado_viaje
     set activo = false, estado = 'ESPERANDO', temporizador_activo = false, tiempo_salida = null, updated_at = now()
   where id = p_id;
  perform privado.log('Admin', v_admin, 'vehiculo_eliminado', jsonb_build_object('camion', p_id, 'nombre', v_nombre));
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_vehiculo_guardar(p_token uuid, p_id integer, p_nombre text, p_tipo text, p_cols integer, p_bloques jsonb, p_exclusivo boolean DEFAULT false)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_admin text := _validar_sesion(p_token, array['Admin']);
  v_nombre text := regexp_replace(trim(coalesce(p_nombre, '')), '\s+', ' ', 'g');
  v_excl boolean := coalesce(p_exclusivo, false);
  v_asientos jsonb;
  v_id int := p_id;
  v_q record;
  v_avisados int := 0;
  v_paleta text[] := array['#ff3b30', '#0a84ff', '#ffcc00', '#34c759', '#af52de', '#ff9500', '#5ac8fa', '#8e8e93'];
begin
  if char_length(v_nombre) not between 1 and 40 then
    raise exception 'Escribe un nombre de hasta 40 caracteres';
  end if;
  -- El nombre se muestra en muchas pantallas: sin signos que puedan armar HTML
  if v_nombre ~ '[<>&"''`\\]' then
    raise exception 'El nombre no puede llevar los signos < > & " '' ` \';
  end if;
  if p_tipo is null or p_tipo not in ('minivan', 'camion') then
    raise exception 'Elige si es minivan o camión';
  end if;
  v_asientos := privado.armar_asientos(p_cols, p_bloques);
  if exists (select 1 from estado_viaje where activo and lower(nombre) = lower(v_nombre) and id is distinct from v_id) then
    raise exception 'Ya hay un vehículo con ese nombre';
  end if;

  if v_id is null then
    insert into estado_viaje (nombre, color, tipo, cols, bloques, asientos, estado, temporizador_activo, exclusivo_chinacates)
    values (v_nombre, v_paleta[1 + ((select count(*) from estado_viaje)::int % 8)], p_tipo, p_cols, p_bloques, v_asientos,
            'ESPERANDO', false, v_excl)
    returning id into v_id;
  else
    if not exists (select 1 from estado_viaje where id = v_id and activo) then
      raise exception 'Ese vehículo ya no existe';
    end if;
    update estado_viaje
       set nombre = v_nombre, tipo = p_tipo, cols = p_cols, bloques = p_bloques, asientos = v_asientos,
           exclusivo_chinacates = v_excl, updated_at = now()
     where id = v_id;
    -- Apartados que ya no caben: asientos que desaparecen o alumnos que no son de Chinacates
    -- en un vehículo que ahora es exclusivo. Se liberan y se avisa.
    for v_q in
      delete from reservas r
      where r.camion = v_id and r.fecha >= privado.hoy() and _salida_ts(r.fecha, r.hora) > _ahora()
        and (not exists (select 1 from privado.asientos_de(v_id) a where a.n = r.asiento)
             or (v_excl and (select a.ubicacion from alumnos a where a.matricula = r.matricula) is distinct from 'chinacates'))
      returning r.matricula, r.fecha, r.hora
    loop
      perform _avisar(v_q.matricula, 'asiento_movido',
        format('El vehículo %s cambió y tu asiento de la salida del %s ya no está disponible. Vuelve a apartar tu lugar.',
               v_nombre, _salida_texto(v_q.fecha, v_q.hora)));
      v_avisados := v_avisados + 1;
    end loop;
  end if;

  perform privado.log('Admin', v_admin, 'vehiculo_guardado', jsonb_build_object(
    'camion', v_id, 'nombre', v_nombre, 'tipo', p_tipo, 'asientos', jsonb_array_length(v_asientos),
    'exclusivo', v_excl, 'nuevo', p_id is null, 'avisados', v_avisados));
  return v_id;
end;
$function$;

-- 5. El historial se consulta por alumno en cada corte y al abrir la app: crece cientos de filas por día
create index if not exists historial_matricula_idx on public.historial_viajes (matricula, fecha_hora desc);

-- 6. Un aviso masivo (la emergencia manda uno por alumno) marcaba "actividad" una vez por cada
--    alumno: 200 cambios en vivo de golpe. Basta una vez por operación.
drop trigger if exists trg_actividad on public.avisos;
create trigger trg_actividad after insert or delete or update on public.avisos
  for each statement execute function _marcar_actividad();
