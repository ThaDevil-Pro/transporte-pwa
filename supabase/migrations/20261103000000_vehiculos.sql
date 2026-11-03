-- CAMIFY · Vehículos con acomodo propio y jornada del chofer
--  1. Cada vehículo (estado_viaje) tiene tipo (minivan o camión), su acomodo
--     de asientos dibujado por la administración y baja lógica (activo).
--     bloques = lo que dibujó la administración: [{r, c, w}] (w = 1 asiento
--     suelto, 2 = fila de dos). asientos = numeración calculada aquí:
--     [{n, r, c, par}] (par = el asiento de al lado en su fila de dos).
--  2. Se dan de baja los 4 camiones de prueba (Rojo, Blanco, Amarillo, Gris),
--     con sus horarios y apartados; su historial se conserva.
--  3. Todo lo que suponía 40 asientos en bancas de dos usa ahora el acomodo
--     de cada vehículo: mapas, apartado, parejas, pasajeros de pie y corte.
--  4. Apartar: solo quien debe $60 o menos. Quien debe más sube con el primer
--     asiento libre que nadie apartó; si no queda ninguno, no sube (ni de pie).
--  5. Jornada: cada día el chofer elige su vehículo antes de trabajar; un
--     vehículo no puede tenerlo otro chofer el mismo día.

-- ---------------------------------------------------------------------
-- 1. Vehículos
-- ---------------------------------------------------------------------
alter table public.estado_viaje
  add column if not exists tipo text not null default 'camion',
  add column if not exists cols smallint not null default 5,
  add column if not exists bloques jsonb not null default '[]'::jsonb,
  add column if not exists asientos jsonb not null default '[]'::jsonb,
  add column if not exists activo boolean not null default true;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'estado_viaje_tipo_check') then
    alter table public.estado_viaje add constraint estado_viaje_tipo_check check (tipo in ('minivan', 'camion'));
  end if;
end $$;

-- Los vehículos nuevos toman números que nunca se han usado (el historial conserva los viejos)
create sequence if not exists public.vehiculos_id_seq;
select setval('public.vehiculos_id_seq', greatest((select coalesce(max(id), 0) from public.estado_viaje), 4));
alter table public.estado_viaje alter column id set default nextval('public.vehiculos_id_seq');
alter table public.estado_viaje alter column estado set default 'ESPERANDO';

-- Ya no hay un tope fijo de camiones ni de 40 asientos
alter table public.horarios_matriz drop constraint if exists horarios_matriz_camion_check;
alter table public.reservas drop constraint if exists reservas_asiento_check;
alter table public.reservas add constraint reservas_asiento_check check (asiento between 1 and 80);

-- Valida el dibujo y numera los asientos: de adelante hacia atrás y de izquierda a derecha
create or replace function privado.armar_asientos(p_cols integer, p_bloques jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_celdas int;
  v_distintas int;
  v_res jsonb;
begin
  if p_cols is null or p_cols not between 3 and 6 then
    raise exception 'El ancho del vehículo no es válido';
  end if;
  if p_bloques is null or jsonb_typeof(p_bloques) <> 'array' then
    raise exception 'El acomodo de asientos no es válido';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_bloques) x
    where jsonb_typeof(x) <> 'object'
       or coalesce(x ->> 'w', '') not in ('1', '2')
       or coalesce(x ->> 'r', '') !~ '^[0-9]{1,2}$'
       or coalesce(x ->> 'c', '') !~ '^[0-9]$'
       or (x ->> 'r')::int > 29
       or (x ->> 'c')::int + (x ->> 'w')::int > p_cols
  ) then
    raise exception 'Hay asientos fuera del vehículo: acomódalos dentro del dibujo';
  end if;

  with b as (
    select (x ->> 'r')::int r, (x ->> 'c')::int c, (x ->> 'w')::int w from jsonb_array_elements(p_bloques) x
  ), celdas as (
    select b.r, b.c + k as c from b, generate_series(0, b.w - 1) k
  )
  select count(*), count(distinct (r, c)) into v_celdas, v_distintas from celdas;

  if v_celdas = 0 then
    raise exception 'Agrega al menos un asiento';
  end if;
  if v_celdas > 80 then
    raise exception 'Un vehículo puede tener hasta 80 asientos';
  end if;
  if v_celdas <> v_distintas then
    raise exception 'Hay asientos encimados: acomódalos en lugares distintos';
  end if;

  with b as (
    select (x ->> 'r')::int r, (x ->> 'c')::int c, (x ->> 'w')::int w, o
    from jsonb_array_elements(p_bloques) with ordinality t(x, o)
  ), celdas as (
    select b.r, b.c + k as c, b.o from b, generate_series(0, b.w - 1) k
  ), num as (
    select r, c, o, (row_number() over (order by r, c))::int as n from celdas
  )
  select jsonb_agg(jsonb_build_object(
           'n', a.n, 'r', a.r, 'c', a.c,
           'par', (select p.n from num p where p.o = a.o and p.n <> a.n)) order by a.n)
    into v_res
  from num a;
  return v_res;
end;
$$;

-- Asientos de un vehículo: número y el de al lado en su fila de dos (null si va suelto)
create or replace function privado.asientos_de(p_camion integer)
returns table(n integer, par integer)
language sql
stable
set search_path = ''
as $$
  select (a ->> 'n')::int, (a ->> 'par')::int
  from public.estado_viaje e
  cross join lateral jsonb_array_elements(e.asientos) a
  where e.id = p_camion
$$;

create or replace function privado.capacidad(p_camion integer)
returns integer
language sql
stable
set search_path = ''
as $$
  select coalesce((select jsonb_array_length(asientos) from public.estado_viaje where id = p_camion), 0)
$$;

create or replace function privado.hoy()
returns date
language sql
stable
set search_path = ''
as $$
  select (public._ahora() at time zone 'America/Mexico_City')::date
$$;

-- Los camiones que ya existían quedan con el acomodo de siempre: 10 filas de 2 + pasillo + 2
update public.estado_viaje
   set tipo = 'camion', cols = 5,
       bloques = (select jsonb_agg(jsonb_build_object('r', r, 'c', c, 'w', 2) order by r, c)
                  from generate_series(0, 9) r, unnest(array[0, 3]) c)
 where jsonb_array_length(bloques) = 0;
update public.estado_viaje
   set asientos = privado.armar_asientos(cols, bloques)
 where jsonb_array_length(asientos) = 0;

-- ---------------------------------------------------------------------
-- 2. Baja de los 4 camiones de prueba
-- ---------------------------------------------------------------------
do $$
declare
  v int[];
begin
  select array_agg(id) into v from public.estado_viaje
  where id between 1 and 4 and nombre in ('Rojo', 'Blanco', 'Amarillo', 'Gris') and activo;
  if v is null then
    return;
  end if;
  delete from public.horarios_matriz where camion = any (v);
  delete from public.reservas where camion = any (v);
  delete from public.abordajes where camion = any (v);
  update public.estado_viaje
     set activo = false, estado = 'ESPERANDO', temporizador_activo = false, tiempo_salida = null, updated_at = now()
   where id = any (v);
end $$;

-- ---------------------------------------------------------------------
-- 5. Jornada del chofer (antes que las funciones que la consultan)
-- ---------------------------------------------------------------------
create table if not exists privado.jornadas (
  fecha date not null,
  chofer text not null references public.choferes (licencia) on update cascade on delete cascade,
  camion integer not null,
  creada_en timestamptz not null default now(),
  primary key (fecha, chofer),
  unique (fecha, camion)
);
alter table privado.jornadas enable row level security;

-- La sesión deja dicho quién llama, para las reglas que dependen de eso
create or replace function public._validar_sesion(p_token uuid, p_roles text[])
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ref text;
  v_cambiar boolean;
  v_rol text;
begin
  select usuario_ref, debe_cambiar, rol into v_ref, v_cambiar, v_rol
  from sesiones
  where token = p_token and rol = any (p_roles) and expira_en > now();

  if v_ref is null then
    raise exception 'Sesión inválida o expirada' using errcode = '28000';
  end if;
  if v_cambiar then
    raise exception 'Debes cambiar tu contraseña para continuar' using errcode = 'CMF01';
  end if;
  perform set_config('camify.rol', v_rol, true);
  perform set_config('camify.usuario', v_ref, true);
  return v_ref;
end;
$$;

-- Vehículo activo y, si llama un chofer, el de su jornada de hoy
create or replace function public._camion_valido(p_camion integer)
returns void
language plpgsql
set search_path = public
as $$
begin
  if p_camion is null or not exists (select 1 from estado_viaje where id = p_camion and activo) then
    raise exception 'Ese vehículo no existe o ya no está activo';
  end if;
  if current_setting('camify.rol', true) = 'Chofer' and not exists (
    select 1 from privado.jornadas
    where fecha = privado.hoy() and chofer = current_setting('camify.usuario', true) and camion = p_camion
  ) then
    raise exception 'Primero elige en qué vehículo vas a trabajar hoy' using errcode = 'CMF04';
  end if;
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
        'capacidad', jsonb_array_length(e.asientos),
        'ocupado_por', (select c.nombre from privado.jornadas j join choferes c on c.licencia = j.chofer
                        where j.fecha = v_hoy and j.camion = e.id and j.chofer <> v_yo)
      ) order by e.id)
      from estado_viaje e where e.activo
    ), '[]'::json)
  );
end;
$$;

create or replace function public.chofer_elegir_vehiculo(p_token uuid, p_camion integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_yo text := _validar_sesion(p_token, array['Chofer']);
  v_hoy date := privado.hoy();
  v_actual int;
begin
  perform pg_advisory_xact_lock(hashtext('jornada:' || v_hoy::text));
  if p_camion is null or not exists (select 1 from estado_viaje where id = p_camion and activo) then
    raise exception 'Ese vehículo no existe o ya no está activo';
  end if;
  if exists (select 1 from privado.jornadas where fecha = v_hoy and camion = p_camion and chofer <> v_yo) then
    raise exception 'Ese vehículo ya lo eligió otro chofer hoy';
  end if;

  select camion into v_actual from privado.jornadas where fecha = v_hoy and chofer = v_yo;
  if v_actual is not null and v_actual <> p_camion
     and (exists (select 1 from abordajes where camion = v_actual)
          or (select estado from estado_viaje where id = v_actual) = 'EN_CAMINO') then
    raise exception 'Termina el viaje de tu vehículo actual antes de cambiar de vehículo';
  end if;

  insert into privado.jornadas (fecha, chofer, camion) values (v_hoy, v_yo, p_camion)
  on conflict (fecha, chofer) do update set camion = excluded.camion, creada_en = now();
  if v_actual is distinct from p_camion then
    perform privado.log('Chofer', v_yo, 'vehiculo_elegido', jsonb_build_object('camion', p_camion));
  end if;
  return p_camion;
end;
$$;

-- ---------------------------------------------------------------------
-- 1b. Alta, edición y baja de vehículos (administración)
-- ---------------------------------------------------------------------
create or replace function public.admin_vehiculo_guardar(p_token uuid, p_id integer, p_nombre text, p_tipo text, p_cols integer, p_bloques jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin text := _validar_sesion(p_token, array['Admin']);
  v_nombre text := regexp_replace(trim(coalesce(p_nombre, '')), '\s+', ' ', 'g');
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
    insert into estado_viaje (nombre, color, tipo, cols, bloques, asientos, estado, temporizador_activo)
    values (v_nombre, v_paleta[1 + ((select count(*) from estado_viaje)::int % 8)], p_tipo, p_cols, p_bloques, v_asientos, 'ESPERANDO', false)
    returning id into v_id;
  else
    if not exists (select 1 from estado_viaje where id = v_id and activo) then
      raise exception 'Ese vehículo ya no existe';
    end if;
    update estado_viaje
       set nombre = v_nombre, tipo = p_tipo, cols = p_cols, bloques = p_bloques, asientos = v_asientos, updated_at = now()
     where id = v_id;
    -- Apartados de asientos que ya no existen en el acomodo nuevo: se liberan y se avisa
    for v_q in
      delete from reservas r
      where r.camion = v_id and r.fecha >= privado.hoy()
        and not exists (select 1 from privado.asientos_de(v_id) a where a.n = r.asiento)
      returning r.matricula, r.fecha, r.hora
    loop
      perform _avisar(v_q.matricula, 'asiento_movido',
        format('El acomodo del vehículo %s cambió y tu asiento de la salida del %s ya no existe. Vuelve a apartar tu lugar.',
               v_nombre, _salida_texto(v_q.fecha, v_q.hora)));
      v_avisados := v_avisados + 1;
    end loop;
  end if;

  perform privado.log('Admin', v_admin, 'vehiculo_guardado', jsonb_build_object(
    'camion', v_id, 'nombre', v_nombre, 'tipo', p_tipo, 'asientos', jsonb_array_length(v_asientos),
    'nuevo', p_id is null, 'avisados', v_avisados));
  return v_id;
end;
$$;

create or replace function public.admin_vehiculo_eliminar(p_token uuid, p_id integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
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
    perform _avisar(v_q.matricula, 'asiento_movido',
      format('El vehículo %s se dio de baja: tu asiento de la salida del %s se liberó.', v_nombre, _salida_texto(v_q.fecha, v_q.hora)));
  end loop;
  delete from privado.jornadas where camion = p_id and fecha >= privado.hoy();
  update estado_viaje
     set activo = false, estado = 'ESPERANDO', temporizador_activo = false, tiempo_salida = null, updated_at = now()
   where id = p_id;
  perform privado.log('Admin', v_admin, 'vehiculo_eliminado', jsonb_build_object('camion', p_id, 'nombre', v_nombre));
end;
$$;

-- ---------------------------------------------------------------------
-- 4. Apartar: adeudo de $60 o menos
-- ---------------------------------------------------------------------
create or replace function privado.puede_apartar(p_matricula text, p_fecha date)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(a.saldo, 0) <= 60 from public.alumnos a where a.matricula = p_matricula;
$$;

-- ---------------------------------------------------------------------
-- 3. Mapas, apartado, parejas, abordaje y corte con el acomodo de cada vehículo
-- ---------------------------------------------------------------------
-- Filas de dos libres y filas de dos con un compañero sin pareja
create or replace function public._opciones_pareja(p_fecha date, p_hora time, p_camion integer, p_excluir text[])
returns table(bancas_libres integer, medias_solos integer)
language sql
stable
set search_path = public
as $$
  with ocup as (
    select asiento, _pareja_de(matricula) is null as solo
    from reservas
    where fecha = p_fecha and hora = p_hora and camion = p_camion and not (matricula = any (p_excluir))
  ), bancas as (
    select (select count(*) from ocup where asiento in (a.n, a.par)) as n_ocup,
           (select bool_and(solo) from ocup where asiento in (a.n, a.par)) as solos
    from privado.asientos_de(p_camion) a
    where a.par > a.n
  )
  select (count(*) filter (where n_ocup = 0))::int,
         (count(*) filter (where n_ocup = 1 and solos))::int
  from bancas
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
        'sel', case v_modo
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
begin
  if not coalesce(privado.puede_apartar(v_yo, p_fecha), false) then
    raise exception 'Para apartar asiento tu adeudo debe ser de $60 o menos: debes $%. Paga en la administración.',
      to_char((select saldo from alumnos where matricula = v_yo), 'FM999,990.00');
  end if;
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
  if p_asiento is null or not exists (select 1 from privado.asientos_de(p_camion) a where a.n = p_asiento) then
    raise exception 'Asiento inválido';
  end if;

  v_pareja := _pareja_de(v_yo);
  -- Una pareja que debe más de $60 no recibe asiento: se aparta solo para quien lo pidió
  if v_pareja is not null and not coalesce(privado.puede_apartar(v_pareja, p_fecha), false) then
    v_pareja := null;
    v_pareja_debe := true;
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
    return json_build_object('asiento', p_asiento, 'pareja_debe', v_pareja_debe);
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
        select r.asiento, r.matricula, a.nombre, _pareja_de(r.matricula) as pareja
        from reservas r join alumnos a on a.matricula = r.matricula
        where r.fecha = p_fecha and r.hora = p_hora and r.camion = p_camion
      )
      select json_agg(json_build_object(
        'n', g.n,
        'nombre', o.nombre,
        'matricula', o.matricula,
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

create or replace function public._abordar(p_camion integer, p_matricula text, p_manual boolean, p_asiento integer default null)
returns json
language plpgsql
set search_path = public
as $$
declare
  v_nombre text;
  v_saldo numeric;
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

  select nombre, saldo into v_nombre, v_saldo from alumnos where matricula = p_matricula;
  if v_nombre is null then
    raise exception 'Este alumno ya no está registrado';
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

  return json_build_object('nombre', v_nombre, 'asiento', v_asiento, 'de_pie', v_de_pie, 'asignado', v_auto);
end;
$$;

-- Corte: de pie solo quedan los que pasan del cupo del vehículo; búsqueda manual: quién no puede apartar
do $$
declare
  cambios text[][] := array[
    array['public.chofer_hacer_corte(uuid, integer)',
      $a$(select count(*) from abordajes where camion = p_camion) - 40)$a$,
      $a$(select count(*) from abordajes where camion = p_camion) - privado.capacidad(p_camion))$a$],
    array['public.chofer_buscar_alumnos(uuid, text)',
      $a$'bloqueado', x.bloqueado)$a$,
      $a$'bloqueado', x.bloqueado, 'sin_apartar', x.sin_apartar)$a$],
    array['public.chofer_buscar_alumnos(uuid, text)',
      $a$coalesce(a.saldo, 0) > 600 as bloqueado,$a$,
      $a$coalesce(a.saldo, 0) > 600 as bloqueado, coalesce(a.saldo, 0) > 60 as sin_apartar,$a$]
  ];
  v text;
begin
  for i in 1 .. array_length(cambios, 1) loop
    v := replace(pg_get_functiondef(cambios[i][1]::regprocedure), E'\r\n', E'\n');
    continue when position(cambios[i][3] in v) > 0;
    if position(cambios[i][2] in v) = 0 then
      raise exception 'No se encontró el texto a cambiar en % (cambio %)', cambios[i][1], i;
    end if;
    execute replace(v, cambios[i][2], cambios[i][3]);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Permisos de las funciones nuevas
-- ---------------------------------------------------------------------
revoke all on function public.chofer_jornada(uuid) from public;
revoke all on function public.chofer_elegir_vehiculo(uuid, integer) from public;
revoke all on function public.admin_vehiculo_guardar(uuid, integer, text, text, integer, jsonb) from public;
revoke all on function public.admin_vehiculo_eliminar(uuid, integer) from public;
grant execute on function public.chofer_jornada(uuid) to anon, authenticated;
grant execute on function public.chofer_elegir_vehiculo(uuid, integer) to anon, authenticated;
grant execute on function public.admin_vehiculo_guardar(uuid, integer, text, text, integer, jsonb) to anon, authenticated;
grant execute on function public.admin_vehiculo_eliminar(uuid, integer) to anon, authenticated;
