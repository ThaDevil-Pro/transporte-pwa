-- =====================================================================
-- DOS CAMIONES
-- Cada salida, asiento, lista de abordaje, temporizador y corte
-- pertenece a un camión. El chofer elige qué camión maneja.
-- estado_viaje.id = número de camión.
-- =====================================================================

-- --- 1. COLUMNAS ---
alter table public.horarios_matriz add column if not exists camion smallint not null default 1 check (camion between 1 and 9);
alter table public.abordajes add column if not exists camion smallint not null default 1;
alter table public.historial_viajes add column if not exists camion smallint;
alter table public.reservas add column if not exists camion smallint not null default 1;

alter table public.reservas drop constraint if exists reservas_fecha_hora_asiento_key;
alter table public.reservas drop constraint if exists reservas_salida_asiento_key;
alter table public.reservas add constraint reservas_salida_asiento_key unique (fecha, hora, camion, asiento);

insert into public.estado_viaje (id, estado, temporizador_activo) values (2, 'ESPERANDO', false)
on conflict (id) do nothing;

-- Limpia un temporizador viejo que quedó activo
update public.estado_viaje set temporizador_activo = false, tiempo_salida = null
where temporizador_activo and (tiempo_salida is null or tiempo_salida < now());

-- --- 2. HORARIO (lunes a viernes) ---
-- Camión 1: 6:00 ida, 11:00 regreso, 15:00 regreso
-- Camión 2: 6:15 ida, 13:00 regreso
-- (El viaje vacío de A a B del camión 1 no lleva alumnos y no se programa.)
delete from public.horarios_matriz;
insert into public.horarios_matriz (lunes, martes, miercoles, jueves, viernes, camion, created_at)
select v.dato, v.dato, v.dato, v.dato, v.dato, v.camion, now() + make_interval(secs => v.orden)
from (values
  (1, 1, '{"hora": "06:00", "tipo": "IDA"}'::jsonb),
  (2, 1, '{"hora": "11:00", "tipo": "REGRESO"}'::jsonb),
  (3, 1, '{"hora": "15:00", "tipo": "REGRESO"}'::jsonb),
  (4, 2, '{"hora": "06:15", "tipo": "IDA"}'::jsonb),
  (5, 2, '{"hora": "13:00", "tipo": "REGRESO"}'::jsonb)
) as v(orden, camion, dato);

-- --- 3. AUXILIARES ---
create or replace function public._camion_valido(p_camion int)
returns void
language plpgsql
set search_path = public
as $$
begin
  if p_camion is null or p_camion not between 1 and 9 then
    raise exception 'Camión inválido';
  end if;
  insert into estado_viaje (id, estado, temporizador_activo) values (p_camion, 'ESPERANDO', false)
  on conflict (id) do nothing;
end;
$$;

drop function if exists public._salidas_programadas(date, int);
create function public._salidas_programadas(p_desde date, p_dias int)
returns table (fecha date, hora time, tipo text, camion smallint)
language sql
stable
set search_path = public
as $$
  select distinct on (d.fecha, (v.dato ->> 'hora')::time, h.camion)
         d.fecha, (v.dato ->> 'hora')::time, coalesce(nullif(v.dato ->> 'tipo', ''), 'IDA'), h.camion
  from (select (p_desde + g)::date as fecha from generate_series(0, p_dias - 1) g) d
  cross join horarios_matriz h
  cross join lateral (
    select case extract(isodow from d.fecha)::int
             when 1 then h.lunes when 2 then h.martes when 3 then h.miercoles
             when 4 then h.jueves when 5 then h.viernes
           end as dato
  ) v
  where coalesce(v.dato ->> 'hora', '') ~ '^\d{1,2}:\d{2}'
  order by d.fecha, (v.dato ->> 'hora')::time, h.camion, h.created_at
$$;

drop function if exists public._opciones_pareja(date, time, text[]);
create function public._opciones_pareja(p_fecha date, p_hora time, p_camion int, p_excluir text[])
returns table (bancas_libres int, medias_solos int)
language sql
stable
set search_path = public
as $$
  with ocup as (
    select asiento, _pareja_de(matricula) is null as solo
    from reservas
    where fecha = p_fecha and hora = p_hora and camion = p_camion and not (matricula = any (p_excluir))
  ), bancas as (
    select b,
           (select count(*) from ocup where asiento in (b, b + 1)) as n,
           (select bool_and(solo) from ocup where asiento in (b, b + 1)) as solos
    from generate_series(1, 39, 2) b
  )
  select (count(*) filter (where n = 0))::int,
         (count(*) filter (where n = 1 and solos))::int
  from bancas
$$;

-- La señal de tiempo real ahora incluye el camión
create or replace function public._marcar_actividad()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clave text := tg_table_name;
  v_fila reservas%rowtype;
begin
  if tg_table_name = 'reservas' then
    if tg_op = 'DELETE' then v_fila := old; else v_fila := new; end if;
    v_clave := 'salida:' || to_char(v_fila.fecha, 'YYYY-MM-DD') || 'T' || to_char(v_fila.hora, 'HH24:MI') || ':' || v_fila.camion;
  end if;
  insert into actividad (clave, actualizado) values (v_clave, now())
  on conflict (clave) do update set actualizado = excluded.actualizado;
  return null;
end;
$$;

-- --- 4. ALUMNO: SALIDAS, MAPA Y APARTADO ---
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
             (select r.asiento from reservas r where r.fecha = s.fecha and r.hora = s.hora and r.camion = s.camion and r.matricula = v_yo) as mi_asiento,
             (select r.asiento from reservas r where r.fecha = s.fecha and r.hora = s.hora and r.camion = s.camion and r.matricula = v_pareja) as asiento_pareja
      from _salidas_programadas(v_hoy, 8) s
      where _salida_ts(s.fecha, s.hora) > _ahora()
      order by _salida_ts(s.fecha, s.hora), s.camion
      limit 15
    ) x
  ), '[]'::json);
end;
$$;

drop function if exists public.alumno_mapa(uuid, date, time);
create function public.alumno_mapa(p_token uuid, p_fecha date, p_hora time, p_camion int)
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
begin
  select s.tipo into v_tipo from _salidas_programadas(p_fecha, 1) s where s.hora = p_hora and s.camion = p_camion;
  if v_tipo is null then
    raise exception 'Esa salida ya no está en el horario';
  end if;

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
    'pareja', case when v_pareja is null then null else json_build_object('nombre', _nombre_corto(v_pareja)) end,
    'asientos', (
      with ocup as (
        select asiento, matricula, _pareja_de(matricula) is null as solo
        from reservas where fecha = p_fecha and hora = p_hora and camion = p_camion
      ), s as (
        select g as n,
               case when o.matricula is null then 'libre'
                    when o.matricula = v_yo then 'mio'
                    when o.matricula = v_pareja then 'pareja'
                    else 'ocupado' end as estado,
               coalesce(o.solo, false) as solo
        from generate_series(1, 40) g
        left join ocup o on o.asiento = g
      ), m as (
        select a.n, a.estado, b.estado as vecino, b.solo as vecino_solo
        from s a
        join s b on b.n = case when a.n % 2 = 1 then a.n + 1 else a.n - 1 end
      )
      select json_agg(json_build_object(
        'n', n,
        'estado', estado,
        'sel', case v_modo
                 when 'solo' then estado = 'libre'
                 when 'pareja' then estado <> 'ocupado' and vecino <> 'ocupado'
                                    and not (estado in ('mio', 'pareja') and vecino in ('mio', 'pareja'))
                 when 'pareja_reacomodo' then estado <> 'ocupado' and vecino = 'ocupado' and vecino_solo
                 else estado = 'libre'
               end,
        'mover', v_modo = 'pareja_reacomodo' and estado <> 'ocupado' and vecino = 'ocupado' and vecino_solo
      ) order by n)
      from m
    )
  );
end;
$$;

drop function if exists public.alumno_apartar(uuid, date, time, int, boolean);
create function public.alumno_apartar(p_token uuid, p_fecha date, p_hora time, p_camion int, p_asiento int, p_solo boolean default false)
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
begin
  -- Un apartado a la vez por horario (un alumno solo puede ir en un camión a la vez)
  perform pg_advisory_xact_lock(hashtext('salida:' || p_fecha::text || 'T' || p_hora::text));

  select s.tipo into v_tipo from _salidas_programadas(p_fecha, 1) s where s.hora = p_hora and s.camion = p_camion;
  if v_tipo is null then
    raise exception 'Esa salida ya no está en el horario';
  end if;
  if _ahora() < v_salida - interval '12 hours' then
    raise exception 'El apartado abre 12 horas antes de la salida';
  end if;
  if _ahora() >= v_salida then
    raise exception 'Esta salida ya partió';
  end if;
  if p_asiento is null or p_asiento not between 1 and 40 then
    raise exception 'Asiento inválido';
  end if;

  v_pareja := _pareja_de(v_yo);
  select matricula into v_ocupa from reservas
  where fecha = p_fecha and hora = p_hora and camion = p_camion and asiento = p_asiento;

  -- Sin pareja (o pareja sin banca disponible): solo un asiento
  if v_pareja is null or p_solo then
    if v_pareja is not null then
      select o.bancas_libres, o.medias_solos into v_libres, v_medias
      from _opciones_pareja(p_fecha, p_hora, p_camion, array[v_yo, v_pareja]) o;
      if v_libres > 0 or v_medias >= 2 then
        raise exception 'Todavía pueden sentarse juntos: elige una banca para los dos';
      end if;
    end if;
    if v_ocupa is not null and v_ocupa <> v_yo then
      raise exception 'Ese asiento ya está ocupado';
    end if;
    delete from reservas where fecha = p_fecha and hora = p_hora and matricula = v_yo;
    insert into reservas (fecha, hora, tipo, camion, asiento, matricula) values (p_fecha, p_hora, v_tipo, p_camion, p_asiento, v_yo);
    return json_build_object('asiento', p_asiento);
  end if;

  -- Con pareja: se aparta la banca completa
  if v_ocupa is not null and v_ocupa not in (v_yo, v_pareja) then
    raise exception 'Ese asiento ya está ocupado';
  end if;
  v_vecino := case when p_asiento % 2 = 1 then p_asiento + 1 else p_asiento - 1 end;

  delete from reservas where fecha = p_fecha and hora = p_hora and matricula in (v_yo, v_pareja);
  select matricula into v_ocupa_vecino from reservas
  where fecha = p_fecha and hora = p_hora and camion = p_camion and asiento = v_vecino;

  if v_ocupa_vecino is not null then
    if _pareja_de(v_ocupa_vecino) is not null then
      raise exception 'Esa banca no está disponible para sentarse juntos';
    end if;
    select o.bancas_libres into v_libres from _opciones_pareja(p_fecha, p_hora, p_camion, array[v_yo, v_pareja]) o;
    if v_libres > 0 then
      raise exception 'Elige una banca libre para sentarse juntos';
    end if;

    -- Reacomodo: el compañero sin pareja pasa junto a otro alumno sin pareja
    select t.n into v_destino
    from generate_series(1, 40) t(n)
    where t.n not in (p_asiento, v_vecino)
      and not exists (select 1 from reservas r where r.fecha = p_fecha and r.hora = p_hora and r.camion = p_camion and r.asiento = t.n)
      and exists (
        select 1 from reservas r
        where r.fecha = p_fecha and r.hora = p_hora and r.camion = p_camion
          and r.asiento = case when t.n % 2 = 1 then t.n + 1 else t.n - 1 end
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
      format('Para la salida del %s (camión %s), tu asiento cambió del %s al %s, junto a otro compañero, para que una pareja pudiera sentarse junta.',
             _salida_texto(p_fecha, p_hora), p_camion, v_vecino, v_destino));
    v_movido := true;
  end if;

  insert into reservas (fecha, hora, tipo, camion, asiento, matricula) values
    (p_fecha, p_hora, v_tipo, p_camion, p_asiento, v_yo),
    (p_fecha, p_hora, v_tipo, p_camion, v_vecino, v_pareja);

  perform _avisar(v_pareja, 'asiento_pareja',
    format('Para la salida del %s (camión %s), %s apartó el asiento %s para ti, junto al suyo.',
           _salida_texto(p_fecha, p_hora), p_camion, _nombre_corto(v_yo), v_vecino));

  return json_build_object('asiento', p_asiento, 'asiento_pareja', v_vecino, 'movido', v_movido);
end;
$$;

-- --- 5. CHOFER: OPERACIÓN POR CAMIÓN ---
drop function if exists public.chofer_abordajes(uuid);
create function public.chofer_abordajes(p_token uuid, p_camion int)
returns setof public.abordajes
language plpgsql
security definer
set search_path = public
as $$
begin
  perform _validar_sesion(p_token, array['Chofer']);
  perform _camion_valido(p_camion);
  return query select * from abordajes where camion = p_camion order by created_at;
end;
$$;

-- Registra al alumno y devuelve su nombre y, si lo apartó, su asiento en la salida actual
drop function if exists public.chofer_registrar_abordaje(uuid, text);
create function public.chofer_registrar_abordaje(p_token uuid, p_camion int, p_matricula text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_matricula text := trim(p_matricula);
  v_nombre text;
  v_otro_camion int;
  v_fecha date;
  v_hora time;
  v_asiento int;
begin
  perform _validar_sesion(p_token, array['Chofer']);
  perform _camion_valido(p_camion);
  lock table abordajes in share row exclusive mode;

  if (select count(*) from abordajes where camion = p_camion) >= 40 then
    raise exception 'Límite alcanzado (Máximo 40 pasajeros)';
  end if;

  select nombre into v_nombre from alumnos where matricula = v_matricula;
  if v_nombre is null then
    raise exception 'Matrícula % inválida', v_matricula;
  end if;

  select camion into v_otro_camion from abordajes where matricula = v_matricula;
  if v_otro_camion = p_camion then
    raise exception 'El alumno (%) ya está a bordo', v_matricula;
  elsif v_otro_camion is not null then
    raise exception 'El alumno (%) ya está a bordo del camión %', v_matricula, v_otro_camion;
  end if;

  insert into abordajes (nombre, matricula, camion) values (v_nombre, v_matricula, p_camion);

  -- Salida en curso de este camión: la próxima (o la que salió hace menos de 30 min)
  select s.fecha, s.hora into v_fecha, v_hora
  from _salidas_programadas((_ahora() at time zone 'America/Mexico_City')::date - 1, 3) s
  where s.camion = p_camion and _salida_ts(s.fecha, s.hora) > _ahora() - interval '30 minutes'
  order by _salida_ts(s.fecha, s.hora)
  limit 1;

  select asiento into v_asiento from reservas
  where fecha = v_fecha and hora = v_hora and camion = p_camion and matricula = v_matricula;

  return json_build_object('nombre', v_nombre, 'asiento', v_asiento);
end;
$$;

drop function if exists public.chofer_vaciar_abordajes(uuid);
create function public.chofer_vaciar_abordajes(p_token uuid, p_camion int)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform _validar_sesion(p_token, array['Chofer']);
  perform _camion_valido(p_camion);
  delete from abordajes where camion = p_camion;
end;
$$;

-- Corte atómico del camión: suma $30, registra historial y pone el viaje EN_CAMINO
drop function if exists public.chofer_hacer_corte(uuid);
create function public.chofer_hacer_corte(p_token uuid, p_camion int)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total integer;
begin
  perform _validar_sesion(p_token, array['Chofer']);
  perform _camion_valido(p_camion);
  lock table abordajes in share row exclusive mode;

  select count(*) into v_total from abordajes where camion = p_camion;
  if v_total = 0 then
    raise exception 'No hay estudiantes en la lista de abordaje.';
  end if;

  update alumnos a
     set saldo = coalesce(a.saldo, 0) + 30
    from abordajes b
   where a.matricula = b.matricula and b.camion = p_camion;

  insert into historial_viajes (matricula, monto, fecha_hora, camion)
  select matricula, 30, now(), p_camion from abordajes where camion = p_camion;

  update estado_viaje set estado = 'EN_CAMINO', updated_at = now() where id = p_camion;
  return v_total;
end;
$$;

drop function if exists public.chofer_finalizar_viaje(uuid);
create function public.chofer_finalizar_viaje(p_token uuid, p_camion int)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform _validar_sesion(p_token, array['Chofer']);
  perform _camion_valido(p_camion);
  delete from abordajes where camion = p_camion;
  update estado_viaje set estado = 'ESPERANDO', updated_at = now() where id = p_camion;
end;
$$;

drop function if exists public.chofer_temporizador(uuid, text);
create function public.chofer_temporizador(p_token uuid, p_camion int, p_accion text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform _validar_sesion(p_token, array['Chofer']);
  perform _camion_valido(p_camion);

  if p_accion = 'iniciar' then
    update estado_viaje set tiempo_salida = now() + interval '5 minutes', temporizador_activo = true where id = p_camion;
  elsif p_accion = 'agregar' then
    update estado_viaje set tiempo_salida = tiempo_salida + interval '1 minute'
     where id = p_camion and temporizador_activo and tiempo_salida is not null;
  elsif p_accion = 'cancelar' then
    update estado_viaje set tiempo_salida = null, temporizador_activo = false where id = p_camion;
  else
    raise exception 'Acción de temporizador desconocida: %', p_accion;
  end if;
end;
$$;

drop function if exists public.chofer_horario_agregar(uuid);
create function public.chofer_horario_agregar(p_token uuid, p_camion int)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform _validar_sesion(p_token, array['Chofer']);
  perform _camion_valido(p_camion);
  insert into horarios_matriz (camion) values (p_camion);
end;
$$;

create or replace function public.chofer_horario_camion(p_token uuid, p_id bigint, p_camion int)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform _validar_sesion(p_token, array['Chofer']);
  perform _camion_valido(p_camion);
  update horarios_matriz set camion = p_camion where id = p_id;
end;
$$;

-- Salidas del camión para el mapa del chofer (incluye la que salió hace menos de 30 min)
create or replace function public.chofer_salidas(p_token uuid, p_camion int)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hoy date := (_ahora() at time zone 'America/Mexico_City')::date;
begin
  perform _validar_sesion(p_token, array['Chofer']);
  perform _camion_valido(p_camion);
  return coalesce((
    select json_agg(x order by x.salida_en)
    from (
      select s.fecha,
             to_char(s.hora, 'HH24:MI') as hora,
             s.tipo,
             s.camion,
             _salida_ts(s.fecha, s.hora) as salida_en,
             _salida_ts(s.fecha, s.hora) - interval '12 hours' as abre_en,
             _ahora() >= _salida_ts(s.fecha, s.hora) - interval '12 hours' as abierta,
             (select count(*) from reservas r where r.fecha = s.fecha and r.hora = s.hora and r.camion = s.camion)::int as ocupados
      from _salidas_programadas(v_hoy, 8) s
      where s.camion = p_camion and _salida_ts(s.fecha, s.hora) > _ahora() - interval '30 minutes'
      order by _salida_ts(s.fecha, s.hora)
      limit 10
    ) x
  ), '[]'::json);
end;
$$;

-- Mapa del chofer: quién va en cada asiento y si ya subió
create or replace function public.chofer_mapa(p_token uuid, p_fecha date, p_hora time, p_camion int)
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
    'asientos', (
      with ocup as (
        select r.asiento, r.matricula, a.nombre, _pareja_de(r.matricula) as pareja
        from reservas r join alumnos a on a.matricula = r.matricula
        where r.fecha = p_fecha and r.hora = p_hora and r.camion = p_camion
      )
      select json_agg(json_build_object(
        'n', g,
        'nombre', o.nombre,
        'matricula', o.matricula,
        'abordo', o.matricula is not null and exists (select 1 from abordajes b where b.camion = p_camion and b.matricula = o.matricula),
        'con_pareja', o.pareja is not null and exists (
          select 1 from ocup v where v.matricula = o.pareja
            and v.asiento = case when g % 2 = 1 then g + 1 else g - 1 end)
      ) order by g)
      from generate_series(1, 40) g
      left join ocup o on o.asiento = g
    )
  );
end;
$$;

-- --- 6. PERMISOS ---
revoke execute on function public._camion_valido(int) from public, anon, authenticated;
revoke execute on function public._salidas_programadas(date, int) from public, anon, authenticated;
revoke execute on function public._opciones_pareja(date, time, int, text[]) from public, anon, authenticated;
