-- =====================================================================
-- ASIENTOS Y PAREJAS
-- · Apartado de asientos por salida: abre 12 h antes y cierra al partir.
-- · Parejas de viaje (1 mes): al apartar uno, se aparta la banca completa.
-- · Si ya no hay bancas libres, los alumnos sin pareja se reacomodan
--   junto a otros sin pareja y reciben un aviso.
-- Camión: 10 filas × (A B | pasillo | C D) = 40 asientos.
-- Bancas: 1-2, 3-4, …, 39-40 (impar con el siguiente par).
-- =====================================================================

-- --- 1. TABLAS ---
create table if not exists public.reservas (
  id bigint generated always as identity primary key,
  fecha date not null,
  hora time not null,
  tipo text not null default 'IDA',
  asiento smallint not null check (asiento between 1 and 40),
  matricula text not null references public.alumnos (matricula) on update cascade on delete cascade,
  creado_en timestamptz not null default now(),
  unique (fecha, hora, asiento),
  unique (fecha, hora, matricula)
);

create table if not exists public.parejas (
  id bigint generated always as identity primary key,
  invita text not null references public.alumnos (matricula) on update cascade on delete cascade,
  invitado text not null references public.alumnos (matricula) on update cascade on delete cascade,
  estado text not null default 'pendiente'
    check (estado in ('pendiente', 'activa', 'rechazada', 'cancelada', 'terminada')),
  creado_en timestamptz not null default now(),
  aceptada_en timestamptz,
  expira_en timestamptz,
  check (invita <> invitado)
);
create index if not exists parejas_invita_idx on public.parejas (invita);
create index if not exists parejas_invitado_idx on public.parejas (invitado);

create table if not exists public.avisos (
  id bigint generated always as identity primary key,
  matricula text not null references public.alumnos (matricula) on update cascade on delete cascade,
  tipo text not null,
  mensaje text not null,
  creado_en timestamptz not null default now(),
  leido boolean not null default false
);
create index if not exists avisos_pendientes_idx on public.avisos (matricula) where not leido;

-- Señal pública SIN datos personales: solo avisa que algo cambió para refrescar en vivo
create table if not exists public.actividad (
  clave text primary key,
  actualizado timestamptz not null default now()
);

alter table public.reservas  enable row level security;
alter table public.parejas   enable row level security;
alter table public.avisos    enable row level security;
alter table public.actividad enable row level security;

revoke all on public.reservas, public.parejas, public.avisos from anon, authenticated;
revoke insert, update, delete, truncate on public.actividad from anon, authenticated;

drop policy if exists "lectura publica actividad" on public.actividad;
create policy "lectura publica actividad" on public.actividad
  for select to anon, authenticated using (true);

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'actividad') then
    alter publication supabase_realtime add table public.actividad;
  end if;
end $$;

-- --- 2. AUXILIARES ---
-- Reloj único (permite simular la hora en pruebas)
create or replace function public._ahora()
returns timestamptz
language sql
stable
as $$ select now() $$;

-- Momento exacto de una salida en hora del centro de México
create or replace function public._salida_ts(p_fecha date, p_hora time)
returns timestamptz
language sql
stable
as $$ select (p_fecha + p_hora) at time zone 'America/Mexico_City' $$;

-- Salidas del horario semanal para un rango de días
create or replace function public._salidas_programadas(p_desde date, p_dias int)
returns table (fecha date, hora time, tipo text)
language sql
stable
set search_path = public
as $$
  select distinct on (d.fecha, (v.dato ->> 'hora')::time)
         d.fecha, (v.dato ->> 'hora')::time, coalesce(nullif(v.dato ->> 'tipo', ''), 'IDA')
  from (select (p_desde + g)::date as fecha from generate_series(0, p_dias - 1) g) d
  cross join horarios_matriz h
  cross join lateral (
    select case extract(isodow from d.fecha)::int
             when 1 then h.lunes when 2 then h.martes when 3 then h.miercoles
             when 4 then h.jueves when 5 then h.viernes
           end as dato
  ) v
  where coalesce(v.dato ->> 'hora', '') ~ '^\d{1,2}:\d{2}'
  order by d.fecha, (v.dato ->> 'hora')::time, h.created_at
$$;

-- "Luis Fernando Ortega" → "Luis F."
create or replace function public._nombre_corto(p_matricula text)
returns text
language sql
stable
set search_path = public
as $$
  select p[1] || coalesce(' ' || nullif(left(p[2], 1), '') || '.', '')
  from (select regexp_split_to_array(trim(nombre), '\s+') as p from alumnos where matricula = p_matricula) x
$$;

-- Pareja activa de un alumno (o null)
create or replace function public._pareja_de(p_matricula text)
returns text
language sql
stable
set search_path = public
as $$
  select case when invita = p_matricula then invitado else invita end
  from parejas
  where estado = 'activa' and expira_en > now() and p_matricula in (invita, invitado)
  order by aceptada_en desc
  limit 1
$$;

-- "lunes 12 de octubre a las 6:00 a. m."
create or replace function public._salida_texto(p_fecha date, p_hora time)
returns text
language sql
immutable
as $$
  select (array['lunes','martes','miércoles','jueves','viernes','sábado','domingo'])[extract(isodow from p_fecha)::int]
    || ' ' || extract(day from p_fecha)::int || ' de '
    || (array['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'])[extract(month from p_fecha)::int]
    || ' a las ' || ((extract(hour from p_hora)::int + 11) % 12 + 1) || ':' || to_char(p_hora, 'MI')
    || case when extract(hour from p_hora) < 12 then ' a. m.' else ' p. m.' end
$$;

create or replace function public._avisar(p_matricula text, p_tipo text, p_mensaje text)
returns void
language sql
set search_path = public
as $$
  insert into avisos (matricula, tipo, mensaje) values (p_matricula, p_tipo, p_mensaje)
$$;

-- Opciones para que una pareja se siente junta (ignorando sus propios asientos):
-- bancas totalmente libres y bancas con un solo alumno sin pareja
create or replace function public._opciones_pareja(p_fecha date, p_hora time, p_excluir text[])
returns table (bancas_libres int, medias_solos int)
language sql
stable
set search_path = public
as $$
  with ocup as (
    select asiento, _pareja_de(matricula) is null as solo
    from reservas
    where fecha = p_fecha and hora = p_hora and not (matricula = any (p_excluir))
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

-- Señal de tiempo real
create or replace function public._marcar_actividad()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clave text := tg_table_name;
  v_fecha date;
  v_hora time;
begin
  if tg_table_name = 'reservas' then
    if tg_op = 'DELETE' then
      v_fecha := old.fecha; v_hora := old.hora;
    else
      v_fecha := new.fecha; v_hora := new.hora;
    end if;
    v_clave := 'salida:' || to_char(v_fecha, 'YYYY-MM-DD') || 'T' || to_char(v_hora, 'HH24:MI');
  end if;
  insert into actividad (clave, actualizado) values (v_clave, now())
  on conflict (clave) do update set actualizado = excluded.actualizado;
  return null;
end;
$$;

drop trigger if exists trg_actividad on public.reservas;
drop trigger if exists trg_actividad on public.parejas;
drop trigger if exists trg_actividad on public.avisos;
create trigger trg_actividad after insert or update or delete on public.reservas for each row execute function public._marcar_actividad();
create trigger trg_actividad after insert or update or delete on public.parejas for each row execute function public._marcar_actividad();
create trigger trg_actividad after insert or update or delete on public.avisos for each row execute function public._marcar_actividad();

-- --- 3. SALIDAS Y MAPA ---
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
    select json_agg(x order by x.salida_en)
    from (
      select s.fecha,
             to_char(s.hora, 'HH24:MI') as hora,
             s.tipo,
             _salida_ts(s.fecha, s.hora) as salida_en,
             _salida_ts(s.fecha, s.hora) - interval '12 hours' as abre_en,
             _ahora() >= _salida_ts(s.fecha, s.hora) - interval '12 hours' as abierta,
             (select count(*) from reservas r where r.fecha = s.fecha and r.hora = s.hora)::int as ocupados,
             (select r.asiento from reservas r where r.fecha = s.fecha and r.hora = s.hora and r.matricula = v_yo) as mi_asiento,
             (select r.asiento from reservas r where r.fecha = s.fecha and r.hora = s.hora and r.matricula = v_pareja) as asiento_pareja
      from _salidas_programadas(v_hoy, 8) s
      where _salida_ts(s.fecha, s.hora) > _ahora()
      order by _salida_ts(s.fecha, s.hora)
      limit 12
    ) x
  ), '[]'::json);
end;
$$;

create or replace function public.alumno_mapa(p_token uuid, p_fecha date, p_hora time)
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
  select s.tipo into v_tipo from _salidas_programadas(p_fecha, 1) s where s.hora = p_hora;
  if v_tipo is null then
    raise exception 'Esa salida ya no está en el horario';
  end if;

  if v_pareja is not null then
    select o.bancas_libres, o.medias_solos into v_libres, v_medias
    from _opciones_pareja(p_fecha, p_hora, array[v_yo, v_pareja]) o;
    v_modo := case when v_libres > 0 then 'pareja'
                   when v_medias >= 2 then 'pareja_reacomodo'
                   else 'pareja_sin_banca' end;
  end if;

  return json_build_object(
    'fecha', p_fecha,
    'hora', to_char(p_hora, 'HH24:MI'),
    'tipo', v_tipo,
    'salida_en', v_salida,
    'abre_en', v_salida - interval '12 hours',
    'abierta', _ahora() >= v_salida - interval '12 hours' and _ahora() < v_salida,
    'modo', v_modo,
    'pareja', case when v_pareja is null then null else json_build_object('nombre', _nombre_corto(v_pareja)) end,
    'asientos', (
      with ocup as (
        select asiento, matricula, _pareja_de(matricula) is null as solo
        from reservas where fecha = p_fecha and hora = p_hora
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

-- --- 4. APARTAR Y LIBERAR ---
-- p_solo: solo para alumnos con pareja cuando ya no hay forma de sentarse juntos
create or replace function public.alumno_apartar(p_token uuid, p_fecha date, p_hora time, p_asiento int, p_solo boolean default false)
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
  -- Un apartado a la vez por salida
  perform pg_advisory_xact_lock(hashtext('salida:' || p_fecha::text || 'T' || p_hora::text));

  select s.tipo into v_tipo from _salidas_programadas(p_fecha, 1) s where s.hora = p_hora;
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
  select matricula into v_ocupa from reservas where fecha = p_fecha and hora = p_hora and asiento = p_asiento;

  -- Sin pareja (o pareja sin banca disponible): solo un asiento
  if v_pareja is null or p_solo then
    if v_pareja is not null then
      select o.bancas_libres, o.medias_solos into v_libres, v_medias
      from _opciones_pareja(p_fecha, p_hora, array[v_yo, v_pareja]) o;
      if v_libres > 0 or v_medias >= 2 then
        raise exception 'Todavía pueden sentarse juntos: elige una banca para los dos';
      end if;
    end if;
    if v_ocupa is not null and v_ocupa <> v_yo then
      raise exception 'Ese asiento ya está ocupado';
    end if;
    delete from reservas where fecha = p_fecha and hora = p_hora and matricula = v_yo;
    insert into reservas (fecha, hora, tipo, asiento, matricula) values (p_fecha, p_hora, v_tipo, p_asiento, v_yo);
    return json_build_object('asiento', p_asiento);
  end if;

  -- Con pareja: se aparta la banca completa
  if v_ocupa is not null and v_ocupa not in (v_yo, v_pareja) then
    raise exception 'Ese asiento ya está ocupado';
  end if;
  v_vecino := case when p_asiento % 2 = 1 then p_asiento + 1 else p_asiento - 1 end;

  delete from reservas where fecha = p_fecha and hora = p_hora and matricula in (v_yo, v_pareja);
  select matricula into v_ocupa_vecino from reservas where fecha = p_fecha and hora = p_hora and asiento = v_vecino;

  if v_ocupa_vecino is not null then
    if _pareja_de(v_ocupa_vecino) is not null then
      raise exception 'Esa banca no está disponible para sentarse juntos';
    end if;
    select o.bancas_libres into v_libres from _opciones_pareja(p_fecha, p_hora, array[v_yo, v_pareja]) o;
    if v_libres > 0 then
      raise exception 'Elige una banca libre para sentarse juntos';
    end if;

    -- Reacomodo: el compañero sin pareja pasa junto a otro alumno sin pareja
    select t.n into v_destino
    from generate_series(1, 40) t(n)
    where t.n not in (p_asiento, v_vecino)
      and not exists (select 1 from reservas r where r.fecha = p_fecha and r.hora = p_hora and r.asiento = t.n)
      and exists (
        select 1 from reservas r
        where r.fecha = p_fecha and r.hora = p_hora
          and r.asiento = case when t.n % 2 = 1 then t.n + 1 else t.n - 1 end
          and _pareja_de(r.matricula) is null
      )
    order by t.n
    limit 1;

    if v_destino is null then
      raise exception 'Ya no hay forma de sentarse juntos en esta salida';
    end if;

    update reservas set asiento = v_destino
    where fecha = p_fecha and hora = p_hora and matricula = v_ocupa_vecino;
    perform _avisar(v_ocupa_vecino, 'asiento_movido',
      format('Para la salida del %s, tu asiento cambió del %s al %s, junto a otro compañero, para que una pareja pudiera sentarse junta.',
             _salida_texto(p_fecha, p_hora), v_vecino, v_destino));
    v_movido := true;
  end if;

  insert into reservas (fecha, hora, tipo, asiento, matricula) values
    (p_fecha, p_hora, v_tipo, p_asiento, v_yo),
    (p_fecha, p_hora, v_tipo, v_vecino, v_pareja);

  perform _avisar(v_pareja, 'asiento_pareja',
    format('Para la salida del %s, %s apartó el asiento %s para ti, junto al suyo.',
           _salida_texto(p_fecha, p_hora), _nombre_corto(v_yo), v_vecino));

  return json_build_object('asiento', p_asiento, 'asiento_pareja', v_vecino, 'movido', v_movido);
end;
$$;

create or replace function public.alumno_liberar_asiento(p_token uuid, p_fecha date, p_hora time)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_yo text := _validar_sesion(p_token, array['Estudiante']);
begin
  if _ahora() >= _salida_ts(p_fecha, p_hora) then
    raise exception 'Esta salida ya partió';
  end if;
  delete from reservas where fecha = p_fecha and hora = p_hora and matricula = v_yo;
end;
$$;

-- --- 5. AVISOS ---
create or replace function public.alumno_avisos(p_token uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_yo text := _validar_sesion(p_token, array['Estudiante']);
begin
  return coalesce((
    select json_agg(json_build_object('id', id, 'tipo', tipo, 'mensaje', mensaje, 'creado_en', creado_en) order by creado_en desc)
    from (select * from avisos where matricula = v_yo and not leido order by creado_en desc limit 10) a
  ), '[]'::json);
end;
$$;

create or replace function public.alumno_aviso_leido(p_token uuid, p_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_yo text := _validar_sesion(p_token, array['Estudiante']);
begin
  update avisos set leido = true where id = p_id and matricula = v_yo;
end;
$$;

-- --- 6. PAREJAS ---
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
    ), '[]'::json)
  );
end;
$$;

create or replace function public.pareja_invitar(p_token uuid, p_matricula text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_yo text := _validar_sesion(p_token, array['Estudiante']);
  v_otro text := trim(p_matricula);
begin
  perform pg_advisory_xact_lock(hashtext('parejas'));
  if v_otro = v_yo then
    raise exception 'No puedes invitarte a ti mismo';
  end if;
  if not exists (select 1 from alumnos where matricula = v_otro) then
    raise exception 'No encontramos esa matrícula';
  end if;
  if _pareja_de(v_yo) is not null then
    raise exception 'Ya tienes una pareja activa';
  end if;
  if _pareja_de(v_otro) is not null then
    raise exception 'Ese alumno ya tiene pareja';
  end if;
  if exists (select 1 from parejas where estado = 'pendiente'
             and ((invita = v_yo and invitado = v_otro) or (invita = v_otro and invitado = v_yo))) then
    raise exception 'Ya hay una invitación pendiente entre ustedes';
  end if;

  -- Solo una invitación enviada a la vez
  update parejas set estado = 'cancelada' where invita = v_yo and estado = 'pendiente';
  insert into parejas (invita, invitado) values (v_yo, v_otro);
  return json_build_object('nombre', _nombre_corto(v_otro));
end;
$$;

create or replace function public.pareja_responder(p_token uuid, p_id bigint, p_aceptar boolean)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_yo text := _validar_sesion(p_token, array['Estudiante']);
  v_inv parejas%rowtype;
begin
  perform pg_advisory_xact_lock(hashtext('parejas'));
  select * into v_inv from parejas where id = p_id and invitado = v_yo and estado = 'pendiente';
  if v_inv.id is null then
    raise exception 'Esta invitación ya no está disponible';
  end if;

  if not p_aceptar then
    update parejas set estado = 'rechazada' where id = p_id;
    perform _avisar(v_inv.invita, 'pareja_rechazada', format('%s no aceptó tu invitación de pareja.', _nombre_corto(v_yo)));
    return json_build_object('estado', 'rechazada');
  end if;

  if _pareja_de(v_yo) is not null or _pareja_de(v_inv.invita) is not null then
    raise exception 'Alguno de los dos ya tiene pareja';
  end if;

  update parejas set estado = 'activa', aceptada_en = now(), expira_en = now() + interval '1 month' where id = p_id;
  -- Cualquier otra invitación pendiente de los dos queda cancelada
  update parejas set estado = 'cancelada'
  where estado = 'pendiente' and id <> p_id
    and (invita in (v_yo, v_inv.invita) or invitado in (v_yo, v_inv.invita));

  perform _avisar(v_inv.invita, 'pareja_aceptada',
    format('%s aceptó ser tu pareja de viaje. Durante un mes, sus asientos se apartarán juntos.', _nombre_corto(v_yo)));
  return json_build_object('estado', 'activa', 'expira_en', now() + interval '1 month');
end;
$$;

create or replace function public.pareja_cancelar_invitacion(p_token uuid, p_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_yo text := _validar_sesion(p_token, array['Estudiante']);
begin
  update parejas set estado = 'cancelada' where id = p_id and invita = v_yo and estado = 'pendiente';
end;
$$;

create or replace function public.pareja_terminar(p_token uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_yo text := _validar_sesion(p_token, array['Estudiante']);
  v_otro text := _pareja_de(v_yo);
begin
  if v_otro is null then
    raise exception 'No tienes una pareja activa';
  end if;
  update parejas set estado = 'terminada', expira_en = now()
  where estado = 'activa' and expira_en > now() and v_yo in (invita, invitado);
  perform _avisar(v_otro, 'pareja_terminada', format('%s terminó la pareja de viaje.', _nombre_corto(v_yo)));
end;
$$;

-- --- 7. PERMISOS: las auxiliares no se exponen por la API ---
revoke execute on function public._ahora() from public, anon, authenticated;
revoke execute on function public._salida_ts(date, time) from public, anon, authenticated;
revoke execute on function public._salidas_programadas(date, int) from public, anon, authenticated;
revoke execute on function public._nombre_corto(text) from public, anon, authenticated;
revoke execute on function public._pareja_de(text) from public, anon, authenticated;
revoke execute on function public._salida_texto(date, time) from public, anon, authenticated;
revoke execute on function public._avisar(text, text, text) from public, anon, authenticated;
revoke execute on function public._opciones_pareja(date, time, text[]) from public, anon, authenticated;
revoke execute on function public._marcar_actividad() from public, anon, authenticated;
