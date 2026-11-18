-- CAMIFY · Ubicaciones, apartados perdidos, fotos, vehículos exclusivos y kilometraje opcional
--  1. Cada alumno tiene una ubicación de origen: Nuevo Ideal o Chinacates. La elige él una
--     sola vez; después solo la cambia la administración. Desde Chinacates el boleto cuesta
--     $40 (desde Nuevo Ideal, $60). El tope de $60 para apartar es igual para todos.
--  2. Apartado perdido: quien aparta y no sube (lo detecta el corte) o cancela en la última
--     hora antes de salir paga el boleto completo. Ese cobro no cuenta como viaje: el
--     siguiente viaje del día se cobra como nuevo y su regreso va incluido.
--  3. El chofer ve la ubicación de cada asiento y, al tocarlo, la ficha del alumno con foto.
--  4. Fotos de los alumnos: una por una o en lote (el nombre del archivo es la matrícula).
--  5. Vehículos exclusivos de Chinacates: solo esos alumnos apartan o suben ahí, y si ese día
--     hay una salida exclusiva del mismo sentido con lugar, deben apartar en ella primero.
--  6. El kilometraje de las cargas de diésel es opcional.

-- =====================================================================
-- 1. Ubicación y precio del boleto
-- =====================================================================
alter table public.alumnos add column if not exists ubicacion text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'alumnos_ubicacion_check') then
    alter table public.alumnos add constraint alumnos_ubicacion_check check (ubicacion in ('nuevo_ideal', 'chinacates'));
  end if;
end $$;

-- Sin ubicación todavía se cobra como Nuevo Ideal
create or replace function privado.precio_boleto(p_matricula text)
returns numeric
language sql
stable
set search_path = ''
as $$
  select (case (select ubicacion from public.alumnos where matricula = p_matricula) when 'chinacates' then 40 else 60 end)::numeric
$$;

create or replace function privado.ubicacion_nombre(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p when 'chinacates' then 'Chinacates' when 'nuevo_ideal' then 'Nuevo Ideal' end
$$;

create or replace function public.alumno_elegir_ubicacion(p_token uuid, p_ubicacion text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_yo text := _validar_sesion(p_token, array['Estudiante']);
begin
  if p_ubicacion is null or p_ubicacion not in ('nuevo_ideal', 'chinacates') then
    raise exception 'Elige Nuevo Ideal o Chinacates';
  end if;
  update alumnos set ubicacion = p_ubicacion where matricula = v_yo and ubicacion is null;
  if not found then
    raise exception 'Ya elegiste tu ubicación. Para cambiarla acude a la administración.';
  end if;
  perform privado.log('Estudiante', v_yo, 'ubicacion_elegida', jsonb_build_object('ubicacion', p_ubicacion));
  return json_build_object('ubicacion', p_ubicacion, 'precio', privado.precio_boleto(v_yo));
end;
$$;

-- =====================================================================
-- 2. Apartados perdidos
-- =====================================================================
alter table public.historial_viajes add column if not exists perdido boolean not null default false;
alter table privado.cortes add column if not exists perdidos integer not null default 0;

-- El 1er viaje del día se cobra y el 2º (el regreso) va incluido, y así sucesivamente.
-- Un apartado perdido no cuenta como viaje y reinicia la cuenta: el siguiente se cobra como nuevo.
create or replace function privado.cobro_viaje(p_matricula text)
returns numeric
language sql
stable
set search_path = ''
as $$
  with hoy as (
    select h.fecha_hora, h.perdido
    from public.historial_viajes h
    where h.matricula = p_matricula
      and (h.fecha_hora at time zone 'America/Mexico_City')::date = (now() at time zone 'America/Mexico_City')::date
  )
  select (case when count(*) % 2 = 0 then privado.precio_boleto(p_matricula) else 0 end)::numeric
  from hoy
  where not hoy.perdido
    and hoy.fecha_hora > coalesce((select max(fecha_hora) from hoy where perdido), '-infinity'::timestamptz)
$$;

-- Cobra el boleto completo de un apartado perdido y lo deja en su historial
create or replace function privado.cobrar_perdido(p_matricula text, p_camion integer, p_corte bigint)
returns numeric
language plpgsql
set search_path = ''
as $$
declare
  v_monto numeric := privado.precio_boleto(p_matricula);
begin
  insert into public.historial_viajes (matricula, monto, fecha_hora, camion, manual, corte_id, de_pie, perdido)
  values (p_matricula, v_monto, now(), p_camion, false, p_corte, false, true);
  update public.alumnos set saldo = coalesce(saldo, 0) + v_monto where matricula = p_matricula;
  return v_monto;
end;
$$;

-- Corte: además de cobrar a los que subieron, cobra el apartado a quien apartó en la salida
-- que está saliendo y no subió (ni va en otro vehículo)
create or replace function public.chofer_hacer_corte(p_token uuid, p_camion integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
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

  if (select estado from estado_viaje where id = p_camion for update) = 'EN_CAMINO' then
    raise exception 'Ya se hizo el corte de este viaje. Finalízalo antes de cobrar otro.';
  end if;

  -- De pie solo quedan los que pasan del cupo del vehículo (los últimos en subir)
  with orden as (
    select b.id, row_number() over (order by (r.matricula is not null), b.created_at desc, b.id desc) as n
    from abordajes b
    cross join _salida_actual(p_camion) s
    left join reservas r on r.fecha = s.fecha and r.hora = s.hora and r.camion = p_camion and r.matricula = b.matricula
    where b.camion = p_camion
  )
  update abordajes a
     set de_pie = o.n <= greatest(0, (select count(*) from abordajes where camion = p_camion) - privado.capacidad(p_camion))
    from orden o where a.id = o.id;

  select count(*), count(*) filter (where manual), count(*) filter (where de_pie)
    into v_total, v_manuales, v_de_pie
  from abordajes where camion = p_camion;
  if v_total = 0 then
    raise exception 'No hay estudiantes en la lista de abordaje.';
  end if;

  insert into privado.cortes (chofer, chofer_nombre, camion, alumnos, manuales, de_pie, total)
  values (v_chofer, (select nombre from choferes where licencia = v_chofer), p_camion, v_total, v_manuales, v_de_pie, 0)
  returning id into v_corte;

  -- cobro_viaje ve el historial de antes de este corte (misma instrucción)
  with nuevos as (
    insert into historial_viajes (matricula, monto, fecha_hora, camion, manual, corte_id, de_pie)
    select matricula, privado.cobro_viaje(matricula), now(), p_camion, manual, v_corte, de_pie
    from abordajes where camion = p_camion
    returning matricula, monto
  )
  update alumnos a set saldo = coalesce(a.saldo, 0) + n.monto
  from nuevos n where a.matricula = n.matricula;

  update abordajes b set cobrado = h.monto
    from historial_viajes h where h.corte_id = v_corte and h.matricula = b.matricula and b.camion = p_camion;

  -- Apartados perdidos: la salida de este vehículo más cercana a ahora (de hace 90 min a dentro de 20)
  select s.fecha, s.hora into v_sal
  from _salidas_programadas(privado.hoy() - 1, 2) s
  where s.camion = p_camion
    and _salida_ts(s.fecha, s.hora) between _ahora() - interval '90 minutes' and _ahora() + interval '20 minutes'
  order by abs(extract(epoch from _salida_ts(s.fecha, s.hora) - _ahora()))
  limit 1;
  if v_sal.fecha is not null then
    for v_q in
      delete from reservas r
      where r.fecha = v_sal.fecha and r.hora = v_sal.hora and r.camion = p_camion
        and not exists (select 1 from abordajes b where b.matricula = r.matricula)
        and not exists (select 1 from historial_viajes h where h.matricula = r.matricula and not h.perdido
                          and h.fecha_hora > _salida_ts(v_sal.fecha, v_sal.hora) - interval '2 hours')
      returning r.matricula
    loop
      v_cobro := privado.cobrar_perdido(v_q.matricula, p_camion, v_corte);
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
    'total', v_monto, 'manuales', v_manuales, 'de_pie', v_de_pie, 'perdidos', v_perdidos));
  return v_total;
end;
$$;

-- Cancelar: gratis hasta 1 hora antes de la salida; en la última hora cuenta como apartado perdido
drop function if exists public.alumno_liberar_asiento(uuid, date, time);
create function public.alumno_liberar_asiento(p_token uuid, p_fecha date, p_hora time)
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
  if _ahora() >= v_salida then
    raise exception 'Esta salida ya partió';
  end if;
  delete from reservas where fecha = p_fecha and hora = p_hora and matricula = v_yo
  returning camion into v_camion;
  if v_camion is not null and _ahora() >= v_salida - interval '1 hour' then
    v_cobro := privado.cobrar_perdido(v_yo, v_camion, null);
    perform privado.log('Estudiante', v_yo, 'apartado_cancelado_tarde', jsonb_build_object(
      'camion', v_camion, 'fecha', p_fecha, 'hora', to_char(p_hora, 'HH24:MI'), 'monto', v_cobro));
  end if;
  return json_build_object('cobro', v_cobro);
end;
$$;

-- =====================================================================
-- 5. Vehículos exclusivos de Chinacates (antes de las funciones que los consultan)
-- =====================================================================
alter table public.estado_viaje add column if not exists exclusivo_chinacates boolean not null default false;

-- Primera salida exclusiva de Chinacates ese día y en ese sentido, todavía por salir y con lugar
create or replace function privado.exclusiva_con_lugar(p_fecha date, p_tipo text)
returns integer
language sql
stable
set search_path = ''
as $$
  select s.camion
  from public._salidas_programadas(p_fecha, 1) s
  join public.estado_viaje e on e.id = s.camion and e.activo and e.exclusivo_chinacates
  where s.tipo = p_tipo
    and public._salida_ts(s.fecha, s.hora) > public._ahora()
    and (select count(*) from public.reservas r where r.fecha = s.fecha and r.hora = s.hora and r.camion = s.camion)
        < privado.capacidad(s.camion)
  order by s.hora
  limit 1
$$;

-- Por qué un alumno no puede apartar en una salida (null si sí puede)
create or replace function privado.motivo_no_aparta(p_matricula text, p_fecha date, p_tipo text, p_camion integer)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_ubic text := (select ubicacion from public.alumnos where matricula = p_matricula);
  v_excl boolean := coalesce((select exclusivo_chinacates from public.estado_viaje where id = p_camion), false);
  v_otra integer;
begin
  if v_ubic is null then
    return 'Primero elige dónde tomas el camión';
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
$$;

-- =====================================================================
-- Funciones del alumno con ubicación, precio y exclusivos
-- =====================================================================
create or replace function public.alumno_perfil(p_token uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_matricula text := _validar_sesion(p_token, array['Estudiante']);
begin
  return (
    select json_build_object('nombre', nombre, 'matricula', matricula, 'saldo', saldo,
                             'ubicacion', ubicacion, 'precio', privado.precio_boleto(matricula))
    from alumnos where matricula = v_matricula
  );
end;
$$;

-- Salidas próximas: los exclusivos solo los ve Chinacates, y Chinacates no ve las salidas
-- normales del día y sentido en que todavía hay una exclusiva con lugar (salvo donde ya apartó)
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
             e.exclusivo_chinacates as exclusivo
      from _salidas_programadas(v_hoy, 8) s
      join estado_viaje e on e.id = s.camion
      left join reservas m on m.fecha = s.fecha and m.hora = s.hora and m.camion = s.camion and m.matricula = v_yo
      where _salida_ts(s.fecha, s.hora) > _ahora()
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

create or replace function public.alumno_mapa(p_token uuid, p_fecha date, p_hora time, p_camion integer)
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
  v_medias int;
  v_modo text := 'solo';
  v_restriccion text;
begin
  select s.tipo into v_tipo from _salidas_programadas(p_fecha, 1) s where s.hora = p_hora and s.camion = p_camion;
  if v_tipo is null then
    raise exception 'Esa salida ya no está en el horario';
  end if;
  v_restriccion := privado.motivo_no_aparta(v_yo, p_fecha, v_tipo, p_camion);

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
    'abierta', _ahora() >= v_salida - interval '12 hours' and _ahora() < v_salida,
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
$$;

create or replace function public.alumno_apartar(p_token uuid, p_fecha date, p_hora time, p_camion integer, p_asiento integer, p_solo boolean default false)
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
  v_destino int;
  v_libres int;
  v_medias int;
  v_movido boolean := false;
  v_pareja_debe boolean := false;
  v_pareja_fuera boolean := false;
  v_motivo text;
begin
  if (select ubicacion from alumnos where matricula = v_yo) is null then
    raise exception 'Primero elige dónde tomas el camión' using errcode = 'CMF05';
  end if;
  if not coalesce(privado.puede_apartar(v_yo, p_fecha), false) then
    raise exception 'Para apartar asiento tu adeudo debe ser de $60 o menos: debes $%. Paga en la administración.',
      to_char((select saldo from alumnos where matricula = v_yo), 'FM999,990.00');
  end if;
  perform pg_advisory_xact_lock(hashtext('salida:' || p_fecha::text || 'T' || p_hora::text));

  select s.tipo into v_tipo from _salidas_programadas(p_fecha, 1) s where s.hora = p_hora and s.camion = p_camion;
  if v_tipo is null then
    raise exception 'Esa salida ya no está en el horario';
  end if;
  v_motivo := privado.motivo_no_aparta(v_yo, p_fecha, v_tipo, p_camion);
  if v_motivo is not null then
    raise exception '%', v_motivo;
  end if;
  if _ahora() < v_salida - interval '12 hours' then
    raise exception 'El apartado abre 12 horas antes de la salida';
  end if;
  if _ahora() >= v_salida then
    raise exception 'Esta salida ya partió';
  end if;
  if p_asiento is null or not exists (select 1 from privado.asientos_de(p_camion) a where a.n = p_asiento) then
    raise exception 'Asiento inválido';
  end if;

  v_pareja := _pareja_de(v_yo);
  -- Una pareja que debe más de $60, o que no puede viajar en este vehículo, no recibe asiento:
  -- se aparta solo para quien lo pidió
  if v_pareja is not null and not coalesce(privado.puede_apartar(v_pareja, p_fecha), false) then
    v_pareja := null;
    v_pareja_debe := true;
  elsif v_pareja is not null and privado.motivo_no_aparta(v_pareja, p_fecha, v_tipo, p_camion) is not null then
    v_pareja := null;
    v_pareja_fuera := true;
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
    return json_build_object('asiento', p_asiento, 'pareja_debe', v_pareja_debe, 'pareja_fuera', v_pareja_fuera);
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

    -- El compañero sin pareja pasa a un asiento libre junto a otro compañero sin pareja
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
$$;

-- Historial y reportes: el apartado perdido aparece como tal y no cuenta como viaje
create or replace function public.alumno_historial(p_token uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_matricula text := _validar_sesion(p_token, array['Estudiante']);
begin
  return coalesce((
    select json_agg(x order by x.fecha_hora desc)
    from (
      select * from (
        select 'v' || id as id, 'viaje' as tipo, monto, fecha_hora, camion, null::text as nota, manual, perdido
        from historial_viajes where matricula = v_matricula
        union all
        select 'p' || id, 'pago', monto, creado_en, null, nota, false, false
        from privado.pagos where matricula = v_matricula
      ) u
      order by fecha_hora desc
      limit 100
    ) x
  ), '[]'::json);
end;
$$;

create or replace function public.alumno_reporte(p_token uuid, p_desde date, p_hasta date)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_matricula text := _validar_sesion(p_token, array['Estudiante']);
  r record;
begin
  select * into r from _rango(p_desde, p_hasta);
  return (
    select json_build_object(
      'alumno', json_build_object('nombre', a.nombre, 'matricula', a.matricula, 'saldo', coalesce(a.saldo, 0),
                                  'ubicacion', a.ubicacion),
      'desde', p_desde,
      'hasta', p_hasta,
      'viajes', coalesce((
        select json_agg(json_build_object('fecha_hora', h.fecha_hora, 'camion', h.camion, 'monto', h.monto, 'manual', h.manual,
                                          'perdido', h.perdido)
                        order by h.fecha_hora)
        from historial_viajes h
        where h.matricula = v_matricula and h.fecha_hora >= r.ini and h.fecha_hora < r.fin
      ), '[]'::json),
      'pagos', coalesce((
        select json_agg(json_build_object('creado_en', p.creado_en, 'monto', p.monto, 'nota', p.nota) order by p.creado_en)
        from privado.pagos p
        where p.matricula = v_matricula and p.creado_en >= r.ini and p.creado_en < r.fin
      ), '[]'::json)
    )
    from alumnos a where a.matricula = v_matricula
  );
end;
$$;

create or replace function public._reporte_chofer(p_licencia text, p_desde date, p_hasta date)
returns json
language plpgsql
set search_path = public
as $$
declare
  r record;
begin
  select * into r from _rango(p_desde, p_hasta);
  return json_build_object(
    'chofer', json_build_object(
      'licencia', p_licencia,
      'nombre', coalesce((select nombre from choferes where licencia = p_licencia),
                         (select chofer_nombre from privado.cortes where chofer = p_licencia order by id desc limit 1))),
    'desde', p_desde,
    'hasta', p_hasta,
    'cortes', coalesce((
      select json_agg(json_build_object(
        'id', c.id, 'creado_en', c.creado_en, 'camion', c.camion, 'alumnos', c.alumnos,
        'manuales', c.manuales, 'de_pie', c.de_pie, 'total', c.total, 'perdidos', c.perdidos,
        'pasajeros', coalesce((
          select json_agg(json_build_object('nombre', coalesce(a.nombre, h.matricula), 'matricula', h.matricula, 'manual', h.manual,
                                            'de_pie', h.de_pie, 'monto', h.monto, 'perdido', h.perdido)
                          order by h.perdido, coalesce(a.nombre, h.matricula))
          from historial_viajes h left join alumnos a on a.matricula = h.matricula
          where h.corte_id = c.id
        ), '[]'::json)
      ) order by c.creado_en)
      from privado.cortes c
      where c.chofer = p_licencia and c.creado_en >= r.ini and c.creado_en < r.fin
    ), '[]'::json)
  );
end;
$$;

-- El informe de gastos cuenta como viajes solo los que se hicieron; el apartado perdido sí suma al cobro
do $$
declare
  cambios text[][] := array[
    array['select matricula, count(*) as viajes, sum(monto) as cargado',
          'select matricula, count(*) filter (where not perdido) as viajes, sum(monto) as cargado'],
    array['select coalesce(camion, 1) as camion, count(*) as viajes, sum(monto) as cargado',
          'select coalesce(camion, 1) as camion, count(*) filter (where not perdido) as viajes, sum(monto) as cargado']
  ];
  v text := replace(pg_get_functiondef('public.admin_reporte_gastos(uuid, date, date)'::regprocedure), E'\r\n', E'\n');
begin
  for i in 1 .. array_length(cambios, 1) loop
    continue when position(cambios[i][2] in v) > 0;
    if position(cambios[i][1] in v) = 0 then
      raise exception 'No se encontró el texto a cambiar en admin_reporte_gastos (cambio %)', i;
    end if;
    v := replace(v, cambios[i][1], cambios[i][2]);
  end loop;
  execute v;
end $$;

-- =====================================================================
-- 3. Chofer: ubicación en el mapa, ficha del alumno y exclusivos al subir
-- =====================================================================
create or replace function public.chofer_mapa(p_token uuid, p_fecha date, p_hora time, p_camion integer)
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  perform _validar_sesion(p_token, array['Chofer']);
  perform _camion_valido(p_camion);
  return json_build_object(
    'fecha', p_fecha,
    'hora', to_char(p_hora, 'HH24:MI'),
    'camion', p_camion,
    'asientos', coalesce((
      with ocup as (
        select r.asiento, r.matricula, a.nombre, a.ubicacion, _pareja_de(r.matricula) as pareja
        from reservas r join alumnos a on a.matricula = r.matricula
        where r.fecha = p_fecha and r.hora = p_hora and r.camion = p_camion
      )
      select json_agg(json_build_object(
        'n', g.n,
        'nombre', o.nombre,
        'matricula', o.matricula,
        'ubicacion', o.ubicacion,
        'abordo', o.matricula is not null and exists (select 1 from abordajes b where b.camion = p_camion and b.matricula = o.matricula),
        'con_pareja', o.pareja is not null and g.par is not null
                      and exists (select 1 from ocup v where v.matricula = o.pareja and v.asiento = g.par)
      ) order by g.n)
      from privado.asientos_de(p_camion) g
      left join ocup o on o.asiento = g.n
    ), '[]'::json)
  );
end;
$$;

-- Ficha de un alumno para el chofer: solo de quien aparta en esa salida o va a bordo de su vehículo
create or replace function public.chofer_alumno(p_token uuid, p_camion integer, p_fecha date, p_hora time, p_matricula text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_asiento integer;
  v_abordo boolean;
  v_pareja text;
begin
  perform _validar_sesion(p_token, array['Chofer']);
  perform _camion_valido(p_camion);
  select asiento into v_asiento from reservas
  where fecha = p_fecha and hora = p_hora and camion = p_camion and matricula = p_matricula;
  v_abordo := exists (select 1 from abordajes where camion = p_camion and matricula = p_matricula);
  if v_asiento is null and not v_abordo then
    raise exception 'Ese alumno no va en tu vehículo';
  end if;
  v_pareja := _pareja_de(p_matricula);
  return (
    select json_build_object(
      'nombre', a.nombre,
      'matricula', a.matricula,
      'ubicacion', a.ubicacion,
      'asiento', v_asiento,
      'abordo', v_abordo,
      'pareja', case when v_pareja is null then null else _nombre_corto(v_pareja) end,
      'foto', (select translate(encode(f.foto, 'base64'), E'\n', '') from privado.fotos f where f.matricula = a.matricula))
    from alumnos a where a.matricula = p_matricula
  );
end;
$$;

create or replace function public.chofer_abordajes(p_token uuid, p_camion integer)
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  perform _validar_sesion(p_token, array['Chofer']);
  perform _camion_valido(p_camion);
  return coalesce((
    select json_agg(to_jsonb(b) || jsonb_build_object(
                      'cobro', coalesce(b.cobrado, privado.cobro_viaje(b.matricula)),
                      'ubicacion', (select a.ubicacion from alumnos a where a.matricula = b.matricula))
                    order by b.created_at)
    from abordajes b where b.camion = p_camion
  ), '[]'::json);
end;
$$;

create or replace function public.chofer_buscar_alumnos(p_token uuid, p_texto text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_q text := privado.normalizar(regexp_replace(trim(left(coalesce(p_texto, ''), 60)), '\s+', ' ', 'g'));
  v_like text;
  v_palabras text[];
begin
  perform _validar_sesion(p_token, array['Chofer']);
  if char_length(v_q) < 2 then
    return '[]'::json;
  end if;

  v_like := replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_');
  v_palabras := string_to_array(v_like, ' ');

  return coalesce((
    select json_agg(json_build_object('nombre', x.nombre, 'matricula', x.matricula, 'camion', x.camion, 'ubicacion', x.ubicacion,
                                      'bloqueado', x.bloqueado, 'sin_apartar', x.sin_apartar) order by x.orden, x.nombre)
    from (
      select a.nombre, a.matricula, a.ubicacion, b.camion, coalesce(a.saldo, 0) > 600 as bloqueado, coalesce(a.saldo, 0) > 60 as sin_apartar,
             case when lower(a.matricula) = v_q then 0
                  when lower(a.matricula) like v_like || '%' then 1
                  else 2 end as orden
      from alumnos a
      left join abordajes b on b.matricula = a.matricula
      where lower(a.matricula) like v_like || '%'
         or (select bool_and(privado.normalizar(a.nombre) like '%' || w || '%') from unnest(v_palabras) w)
      order by orden, a.nombre
      limit 8
    ) x
  ), '[]'::json);
end;
$$;

create or replace function public.chofer_jornada(p_token uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_yo text := _validar_sesion(p_token, array['Chofer']);
  v_hoy date := privado.hoy();
begin
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
$$;

-- Subir: los exclusivos solo aceptan alumnos de Chinacates
create or replace function public._abordar(p_camion integer, p_matricula text, p_manual boolean, p_asiento integer default null)
returns json
language plpgsql
set search_path = public
as $$
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
$$;

-- =====================================================================
-- 5b. Alta y edición de vehículos con la marca de exclusivo
-- =====================================================================
drop function if exists public.admin_vehiculo_guardar(uuid, integer, text, text, integer, jsonb);
create function public.admin_vehiculo_guardar(p_token uuid, p_id integer, p_nombre text, p_tipo text, p_cols integer, p_bloques jsonb,
                                              p_exclusivo boolean default false)
returns integer
language plpgsql
security definer
set search_path = public
as $$
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
      where r.camion = v_id and r.fecha >= privado.hoy()
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
$$;

-- =====================================================================
-- 1b. Administración: ubicación del alumno
-- =====================================================================
create or replace function public.admin_alumno_ubicacion(p_token uuid, p_matricula text, p_ubicacion text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin text := _validar_sesion(p_token, array['Admin']);
  v_antes text;
  v_existe boolean;
  v_q record;
begin
  if p_ubicacion is null or p_ubicacion not in ('nuevo_ideal', 'chinacates') then
    raise exception 'Elige Nuevo Ideal o Chinacates';
  end if;
  select true, ubicacion into v_existe, v_antes from alumnos where matricula = p_matricula for update;
  if v_existe is null then
    raise exception 'Alumno no encontrado';
  end if;
  if v_antes is not distinct from p_ubicacion then
    return;
  end if;
  update alumnos set ubicacion = p_ubicacion where matricula = p_matricula;

  -- Si deja de ser de Chinacates, sus apartados en vehículos exclusivos se liberan
  if p_ubicacion <> 'chinacates' then
    for v_q in
      delete from reservas r using estado_viaje e
      where r.matricula = p_matricula and r.fecha >= privado.hoy() and e.id = r.camion and e.exclusivo_chinacates
      returning r.fecha, r.hora
    loop
      perform _avisar(p_matricula, 'asiento_movido',
        format('Tu asiento de la salida del %s se liberó: ese vehículo es exclusivo de Chinacates.', _salida_texto(v_q.fecha, v_q.hora)));
    end loop;
  end if;
  if v_antes is not null then
    perform _avisar(p_matricula, 'ubicacion_cambiada', format('La administración cambió tu ubicación a %s. Tu boleto cuesta $%s.',
      privado.ubicacion_nombre(p_ubicacion), to_char(privado.precio_boleto(p_matricula), 'FM999,990')));
  end if;
  perform privado.log('Admin', v_admin, 'ubicacion_cambiada', jsonb_build_object(
    'matricula', p_matricula, 'nombre', (select nombre from alumnos where matricula = p_matricula),
    'antes', v_antes, 'despues', p_ubicacion));
end;
$$;

create or replace function public.admin_usuarios(p_token uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  perform _validar_sesion(p_token, array['Admin']);
  return json_build_object(
    'alumnos', coalesce((select json_agg(json_build_object('id', a.id, 'nombre', a.nombre, 'matricula', a.matricula, 'saldo', a.saldo,
                                                           'ubicacion', a.ubicacion,
                                                           'foto', exists (select 1 from privado.fotos f where f.matricula = a.matricula))
                                         order by a.nombre) from alumnos a), '[]'::json),
    'choferes', coalesce((select json_agg(json_build_object('id', id, 'nombre', nombre, 'licencia', licencia) order by nombre) from choferes), '[]'::json),
    'financieros', coalesce((select json_agg(json_build_object('id', id, 'nombre', nombre, 'usuario', usuario) order by nombre) from financieros), '[]'::json),
    'admins', coalesce((select json_agg(json_build_object('id', id, 'usuario', usuario) order by usuario) from admins), '[]'::json)
  );
end;
$$;

create or replace function public.finanzas_alumnos(p_token uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  perform _validar_sesion(p_token, array['Admin', 'Financiero']);
  return coalesce((select json_agg(json_build_object('id', id, 'nombre', nombre, 'matricula', matricula, 'saldo', saldo,
                                                     'ubicacion', ubicacion) order by nombre)
                   from alumnos), '[]'::json);
end;
$$;

-- =====================================================================
-- 4. Fotos de los alumnos (JPEG chico que prepara la app; se guardan fuera de la API)
-- =====================================================================
create table if not exists privado.fotos (
  matricula text primary key references public.alumnos (matricula) on update cascade on delete cascade,
  foto bytea not null,
  actualizada_en timestamptz not null default now()
);
alter table privado.fotos enable row level security;

create or replace function privado.foto_decodificar(p_foto text)
returns bytea
language plpgsql
immutable
set search_path = ''
as $$
declare
  v bytea;
begin
  begin
    v := decode(regexp_replace(coalesce(p_foto, ''), '^data:image/[a-z]+;base64,', ''), 'base64');
  exception when others then
    raise exception 'La foto no es válida';
  end;
  if octet_length(v) > 250 * 1024 then
    raise exception 'La foto es muy pesada';
  end if;
  if octet_length(v) < 1000 or substring(v from 1 for 3) <> '\xffd8ff'::bytea then
    raise exception 'La foto no es válida: debe ser JPEG';
  end if;
  return v;
end;
$$;

-- Matrícula tal como está registrada (el nombre del archivo puede venir en otras mayúsculas)
create or replace function privado.matricula_de(p text)
returns text
language sql
stable
set search_path = ''
as $$
  select a.matricula from public.alumnos a
  where lower(a.matricula) = lower(trim(coalesce(p, '')))
  order by (a.matricula = trim(p)) desc
  limit 1
$$;

-- Bitácora: las fotos cargadas en un mismo rato se suman en un solo registro
create or replace function privado.log_fotos(p_admin text, p_cargadas integer)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_id bigint;
begin
  if p_cargadas <= 0 then
    return;
  end if;
  select id into v_id from privado.bitacora
  where accion = 'fotos_cargadas' and actor = p_admin and creado_en > now() - interval '10 minutes'
  order by id desc limit 1;
  if v_id is null then
    perform privado.log('Admin', p_admin, 'fotos_cargadas', jsonb_build_object('fotos', p_cargadas));
  else
    update privado.bitacora
       set detalle = jsonb_set(detalle, '{fotos}', to_jsonb(coalesce((detalle ->> 'fotos')::int, 0) + p_cargadas))
     where id = v_id;
  end if;
end;
$$;

create or replace function public.admin_foto_guardar(p_token uuid, p_matricula text, p_foto text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin text := _validar_sesion(p_token, array['Admin']);
  v_mat text := privado.matricula_de(p_matricula);
begin
  if v_mat is null then
    raise exception 'No hay alumno con esa matrícula';
  end if;
  insert into privado.fotos (matricula, foto) values (v_mat, privado.foto_decodificar(p_foto))
  on conflict (matricula) do update set foto = excluded.foto, actualizada_en = now();
  perform privado.log_fotos(v_admin, 1);
end;
$$;

create or replace function public.admin_fotos_lote(p_token uuid, p_fotos jsonb)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin text := _validar_sesion(p_token, array['Admin']);
  v_item jsonb;
  v_mat text;
  v_ok integer := 0;
  v_res jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p_fotos) is distinct from 'array' or jsonb_array_length(p_fotos) not between 1 and 12 then
    raise exception 'Envía de 1 a 12 fotos por lote';
  end if;
  for v_item in select value from jsonb_array_elements(p_fotos) loop
    begin
      v_mat := privado.matricula_de(v_item ->> 'matricula');
      if v_mat is null then
        raise exception 'No hay alumno con esa matrícula';
      end if;
      insert into privado.fotos (matricula, foto) values (v_mat, privado.foto_decodificar(v_item ->> 'foto'))
      on conflict (matricula) do update set foto = excluded.foto, actualizada_en = now();
      v_ok := v_ok + 1;
      v_res := v_res || jsonb_build_object('matricula', v_item ->> 'matricula', 'ok', true);
    exception when others then
      v_res := v_res || jsonb_build_object('matricula', v_item ->> 'matricula', 'ok', false, 'error', sqlerrm);
    end;
  end loop;
  perform privado.log_fotos(v_admin, v_ok);
  return v_res::json;
end;
$$;

create or replace function public.admin_foto(p_token uuid, p_matricula text)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  perform _validar_sesion(p_token, array['Admin']);
  return (select translate(encode(foto, 'base64'), E'\n', '') from privado.fotos where matricula = p_matricula);
end;
$$;

create or replace function public.admin_foto_borrar(p_token uuid, p_matricula text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin text := _validar_sesion(p_token, array['Admin']);
begin
  delete from privado.fotos where matricula = p_matricula;
  if found then
    perform privado.log('Admin', v_admin, 'foto_borrada', jsonb_build_object('matricula', p_matricula));
  end if;
end;
$$;

-- =====================================================================
-- 6. Kilometraje opcional en las cargas de diésel
-- =====================================================================
alter table privado.diesel_cargas alter column odometro drop not null;

create or replace function privado.diesel_validar(p_camion integer, p_fecha timestamptz, p_litros numeric, p_importe numeric, p_odometro integer, p_dias integer)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_precio numeric;
begin
  if p_camion is null or not exists (select 1 from public.estado_viaje where id = p_camion) then
    raise exception 'Ese camión no existe';
  end if;
  if p_litros is null or p_litros < 1 or p_litros > 1500 then
    raise exception 'Revisa los litros';
  end if;
  if p_importe is null or p_importe < 1 or p_importe > 50000 then
    raise exception 'Revisa el importe';
  end if;
  v_precio := p_importe / p_litros;
  if v_precio < 12 or v_precio > 60 then
    raise exception 'Revisa los litros y el importe: el precio por litro sería de $%', to_char(v_precio, 'FM999990.00');
  end if;
  if p_odometro is not null and (p_odometro < 0 or p_odometro > 5000000) then
    raise exception 'Revisa el kilometraje';
  end if;
  if p_fecha is null or p_fecha > now() + interval '10 minutes' then
    raise exception 'La fecha de la carga no puede ser futura';
  end if;
  if p_fecha < now() - make_interval(days => p_dias) then
    raise exception '%', case when p_dias <= 7
      then 'Solo puedes registrar cargas de los últimos 7 días. Para una más antigua, avisa a la administración.'
      else 'La fecha de la carga es demasiado antigua' end;
  end if;
end;
$$;

-- Rendimiento: los kilómetros se miden contra la carga anterior que sí tiene kilometraje,
-- y solo los llenos con kilometraje sirven de referencia
create or replace view privado.diesel_calculo as
 WITH base AS (
         SELECT c_1.id, c_1.creado_en, c_1.fecha, c_1.camion, c_1.chofer, c_1.chofer_nombre, c_1.registrado_rol,
            c_1.registrado_por, c_1.litros, c_1.importe, c_1.precio_litro, c_1.odometro, c_1.lleno, c_1.gasolinera,
            c_1.folio, c_1.estado, c_1.nota, c_1.revisada_por, c_1.revisada_en,
            t.litros AS tanque,
            (EXISTS ( SELECT 1 FROM privado.diesel_tickets k WHERE (k.carga_id = c_1.id))) AS tiene_foto
           FROM (privado.diesel_cargas c_1
             LEFT JOIN privado.diesel_tanques t ON ((t.camion = c_1.camion)))
          WHERE (c_1.estado <> 'anulada'::text)
        ), seq AS (
         SELECT b.id, b.creado_en, b.fecha, b.camion, b.chofer, b.chofer_nombre, b.registrado_rol, b.registrado_por,
            b.litros, b.importe, b.precio_litro, b.odometro, b.lleno, b.gasolinera, b.folio, b.estado, b.nota,
            b.revisada_por, b.revisada_en, b.tanque, b.tiene_foto,
            ( SELECT b2.odometro FROM base b2
               WHERE b2.camion = b.camion AND b2.odometro IS NOT NULL AND (b2.fecha, b2.id) < (b.fecha, b.id)
               ORDER BY b2.fecha DESC, b2.id DESC LIMIT 1) AS odo_prev,
            lag(b.fecha) OVER w AS fecha_prev,
            count(*) FILTER (WHERE (b.lleno AND b.odometro IS NOT NULL)) OVER (PARTITION BY b.camion ORDER BY b.fecha, b.id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS grupo
           FROM base b
          WINDOW w AS (PARTITION BY b.camion ORDER BY b.fecha, b.id)
        ), llenos AS (
         SELECT s.id,
            lag(s.odometro) OVER (PARTITION BY s.camion ORDER BY s.fecha, s.id) AS odo_lleno_prev
           FROM seq s
          WHERE (s.lleno AND s.odometro IS NOT NULL)
        ), grupos AS (
         SELECT seq.camion, seq.grupo, sum(seq.litros) AS litros_grupo
           FROM seq
          GROUP BY seq.camion, seq.grupo
        ), calc AS (
         SELECT s.id, s.creado_en, s.fecha, s.camion, s.chofer, s.chofer_nombre, s.registrado_rol, s.registrado_por,
            s.litros, s.importe, s.precio_litro, s.odometro, s.lleno, s.gasolinera, s.folio, s.estado, s.nota,
            s.revisada_por, s.revisada_en, s.tanque, s.tiene_foto, s.odo_prev, s.fecha_prev, s.grupo,
                CASE
                    WHEN ((s.odo_prev IS NOT NULL) AND (s.odometro IS NOT NULL) AND (s.odometro >= s.odo_prev)) THEN (s.odometro - s.odo_prev)
                    ELSE NULL::integer
                END AS km,
                CASE
                    WHEN ((s.grupo > 0) AND (l.odo_lleno_prev IS NOT NULL) AND (s.odometro > l.odo_lleno_prev)) THEN (s.odometro - l.odo_lleno_prev)
                    ELSE NULL::integer
                END AS km_lleno,
                CASE
                    WHEN ((s.grupo > 0) AND (l.odo_lleno_prev IS NOT NULL) AND (s.odometro > l.odo_lleno_prev)) THEN g.litros_grupo
                    ELSE NULL::numeric
                END AS litros_lleno
           FROM ((seq s
             LEFT JOIN llenos l ON ((l.id = s.id)))
             LEFT JOIN grupos g ON (((g.camion = s.camion) AND (g.grupo = s.grupo))))
        ), ref AS (
         SELECT calc.camion,
            count(*) AS n,
            percentile_cont((0.5)::double precision) WITHIN GROUP (ORDER BY ((((calc.km_lleno)::numeric / calc.litros_lleno))::double precision)) AS rend_mediana
           FROM calc
          WHERE (calc.km_lleno IS NOT NULL)
          GROUP BY calc.camion
        )
 SELECT c.id, c.creado_en, c.fecha, c.camion, c.chofer, c.chofer_nombre, c.registrado_rol, c.registrado_por,
    c.litros, c.importe, c.precio_litro, c.odometro, c.lleno, c.gasolinera, c.folio, c.estado, c.nota,
    c.revisada_por, c.revisada_en, c.tiene_foto, c.tanque, c.odo_prev, c.km, c.km_lleno, c.litros_lleno,
    round(((c.km_lleno)::numeric / c.litros_lleno), 2) AS rendimiento,
    round((r.rend_mediana)::numeric, 2) AS rendimiento_normal,
    array_remove(ARRAY[
        CASE WHEN (NOT c.tiene_foto) THEN 'sin_ticket'::text ELSE NULL::text END,
        CASE WHEN ((c.tanque IS NOT NULL) AND (c.litros > (c.tanque * 1.03))) THEN 'sobre_tanque'::text ELSE NULL::text END,
        CASE WHEN ((c.odo_prev IS NOT NULL) AND (c.odometro < c.odo_prev)) THEN 'odometro'::text ELSE NULL::text END,
        CASE
            WHEN ((c.km IS NOT NULL) AND ((c.km)::double precision > COALESCE(
            CASE
                WHEN (r.n >= 3) THEN (((c.tanque)::double precision * r.rend_mediana) * (1.15)::double precision)
                ELSE NULL::double precision
            END, (2500)::double precision))) THEN 'carga_faltante'::text
            ELSE NULL::text
        END,
        CASE
            WHEN ((c.km_lleno IS NOT NULL) AND (r.n >= 3) AND ((((c.km_lleno)::numeric / c.litros_lleno))::double precision < (r.rend_mediana * (0.75)::double precision))) THEN 'rendimiento_bajo'::text
            ELSE NULL::text
        END,
        CASE
            WHEN ((c.km_lleno IS NOT NULL) AND (r.n >= 3) AND ((((c.km_lleno)::numeric / c.litros_lleno))::double precision > (r.rend_mediana * (1.33)::double precision))) THEN 'rendimiento_alto'::text
            ELSE NULL::text
        END,
        CASE
            WHEN ((p.mediana IS NOT NULL) AND (abs(((c.precio_litro)::double precision - p.mediana)) > (p.mediana * (0.08)::double precision))) THEN 'precio'::text
            ELSE NULL::text
        END,
        CASE
            WHEN ((c.fecha_prev IS NOT NULL) AND ((c.fecha - c.fecha_prev) < '12:00:00'::interval) AND (COALESCE(c.km, 0) < 80)) THEN 'seguidas'::text
            ELSE NULL::text
        END], NULL::text) AS alertas
   FROM ((calc c
     LEFT JOIN ref r ON ((r.camion = c.camion)))
     LEFT JOIN LATERAL ( SELECT percentile_cont((0.5)::double precision) WITHIN GROUP (ORDER BY ((o.precio_litro)::double precision)) AS mediana
           FROM privado.diesel_cargas o
          WHERE ((o.estado <> 'anulada'::text) AND (o.id <> c.id) AND ((o.fecha >= (c.fecha - '45 days'::interval)) AND (o.fecha <= (c.fecha + '45 days'::interval))))
         HAVING (count(*) >= 3)) p ON (true));

-- Pistas del formulario del chofer: el kilometraje de referencia es el de la última carga que lo tiene
create or replace function public.chofer_diesel(p_token uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_chofer text := _validar_sesion(p_token, array['Chofer']);
begin
  return json_build_object(
    'mias', coalesce((
      select json_agg(json_build_object('id', c.id, 'fecha', c.fecha, 'camion', c.camion, 'litros', c.litros,
        'importe', c.importe, 'odometro', c.odometro, 'estado', c.estado, 'nota', c.nota, 'km', v.km)
        order by c.fecha desc, c.id desc)
      from (select * from privado.diesel_cargas where chofer = v_chofer order by fecha desc, id desc limit 8) c
      left join privado.diesel_calculo v on v.id = c.id
    ), '[]'::json),
    'camiones', coalesce((
      select json_agg(json_build_object('camion', e.id, 'odometro', k.odometro, 'fecha', u.fecha, 'tanque', t.litros) order by e.id)
      from estado_viaje e
      left join lateral (
        select fecha from privado.diesel_cargas
        where camion = e.id and estado <> 'anulada' order by fecha desc, id desc limit 1
      ) u on true
      left join lateral (
        select odometro from privado.diesel_cargas
        where camion = e.id and estado <> 'anulada' and odometro is not null order by fecha desc, id desc limit 1
      ) k on true
      left join privado.diesel_tanques t on t.camion = e.id
    ), '[]'::json)
  );
end;
$$;

-- =====================================================================
-- Permisos
-- =====================================================================
revoke all on all functions in schema privado from public, anon, authenticated;

revoke all on function public.alumno_elegir_ubicacion(uuid, text) from public;
revoke all on function public.alumno_liberar_asiento(uuid, date, time) from public;
revoke all on function public.chofer_alumno(uuid, integer, date, time, text) from public;
revoke all on function public.admin_vehiculo_guardar(uuid, integer, text, text, integer, jsonb, boolean) from public;
revoke all on function public.admin_alumno_ubicacion(uuid, text, text) from public;
revoke all on function public.admin_foto_guardar(uuid, text, text) from public;
revoke all on function public.admin_fotos_lote(uuid, jsonb) from public;
revoke all on function public.admin_foto(uuid, text) from public;
revoke all on function public.admin_foto_borrar(uuid, text) from public;
grant execute on function public.alumno_elegir_ubicacion(uuid, text) to anon, authenticated;
grant execute on function public.alumno_liberar_asiento(uuid, date, time) to anon, authenticated;
grant execute on function public.chofer_alumno(uuid, integer, date, time, text) to anon, authenticated;
grant execute on function public.admin_vehiculo_guardar(uuid, integer, text, text, integer, jsonb, boolean) to anon, authenticated;
grant execute on function public.admin_alumno_ubicacion(uuid, text, text) to anon, authenticated;
grant execute on function public.admin_foto_guardar(uuid, text, text) to anon, authenticated;
grant execute on function public.admin_fotos_lote(uuid, jsonb) to anon, authenticated;
grant execute on function public.admin_foto(uuid, text) to anon, authenticated;
grant execute on function public.admin_foto_borrar(uuid, text) to anon, authenticated;
