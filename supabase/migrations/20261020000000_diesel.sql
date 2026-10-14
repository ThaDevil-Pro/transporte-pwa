-- =====================================================================
-- CAMIFY · Control de diésel
--  1. El chofer registra cada carga en la gasolinera: foto del ticket,
--     litros, importe y kilometraje del odómetro.
--  2. La administración la verifica (o la marca con observación o la
--     anula) y puede registrar tickets que falten.
--  3. Con el kilometraje se calcula el rendimiento (km/L por el método
--     de tanque lleno) y se marcan las cargas sospechosas.
--  4. Informe por semana, mes, semestre o año para los directivos.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Tablas (esquema privado: solo se llega a ellas por las funciones)
-- ---------------------------------------------------------------------
create table if not exists privado.diesel_tanques (
  camion integer primary key references public.estado_viaje (id) on delete cascade,
  litros numeric(6,1) not null check (litros between 20 and 1500),
  actualizado_en timestamptz not null default now(),
  actualizado_por text
);

create table if not exists privado.diesel_cargas (
  id bigint generated always as identity primary key,
  creado_en timestamptz not null default now(),
  fecha timestamptz not null,           -- cuándo se cargó (puede registrarse después)
  camion smallint not null,
  chofer text,                          -- licencia; vacío si la administración no indicó chofer
  chofer_nombre text,
  registrado_rol text not null check (registrado_rol in ('Chofer', 'Admin')),
  registrado_por text not null,
  litros numeric(7,2) not null check (litros > 0),
  importe numeric(10,2) not null check (importe > 0),
  precio_litro numeric(8,3) generated always as (round(importe / litros, 3)) stored,
  odometro integer not null check (odometro >= 0),
  lleno boolean not null default true,  -- tanque lleno: permite calcular el rendimiento exacto
  gasolinera text,
  folio text,
  estado text not null default 'pendiente' check (estado in ('pendiente', 'verificada', 'observada', 'anulada')),
  nota text,
  revisada_por text,
  revisada_en timestamptz
);
create index if not exists diesel_cargas_camion_idx on privado.diesel_cargas (camion, fecha, id);
create index if not exists diesel_cargas_fecha_idx on privado.diesel_cargas (fecha);
create index if not exists diesel_cargas_chofer_idx on privado.diesel_cargas (chofer, creado_en desc);

-- La foto va aparte para que las listas no la carguen
create table if not exists privado.diesel_tickets (
  carga_id bigint primary key references privado.diesel_cargas (id) on delete cascade,
  foto bytea not null
);

revoke all on privado.diesel_tanques, privado.diesel_cargas, privado.diesel_tickets from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. Cálculos: kilómetros, rendimiento y alertas de cada carga
-- ---------------------------------------------------------------------
-- Rendimiento por tanque lleno: los km entre dos llenados completos entre
-- los litros cargados desde el anterior (incluidas cargas parciales).
create or replace view privado.diesel_calculo with (security_invoker = true) as
with base as (
  select c.*, t.litros as tanque,
         exists (select 1 from privado.diesel_tickets k where k.carga_id = c.id) as tiene_foto
  from privado.diesel_cargas c
  left join privado.diesel_tanques t on t.camion = c.camion
  where c.estado <> 'anulada'
),
seq as (
  select b.*,
    lag(b.odometro) over w as odo_prev,
    lag(b.fecha) over w as fecha_prev,
    count(*) filter (where b.lleno) over (partition by b.camion order by b.fecha, b.id
                                          rows between unbounded preceding and 1 preceding) as grupo
  from base b
  window w as (partition by b.camion order by b.fecha, b.id)
),
llenos as (
  select s.id, lag(s.odometro) over (partition by s.camion order by s.fecha, s.id) as odo_lleno_prev
  from seq s where s.lleno
),
grupos as (
  select camion, grupo, sum(litros) as litros_grupo from seq group by camion, grupo
),
calc as (
  select s.*,
    case when s.odo_prev is not null and s.odometro >= s.odo_prev then s.odometro - s.odo_prev end as km,
    case when s.grupo > 0 and l.odo_lleno_prev is not null and s.odometro > l.odo_lleno_prev
         then s.odometro - l.odo_lleno_prev end as km_lleno,
    case when s.grupo > 0 and l.odo_lleno_prev is not null and s.odometro > l.odo_lleno_prev
         then g.litros_grupo end as litros_lleno
  from seq s
  left join llenos l on l.id = s.id
  left join grupos g on g.camion = s.camion and g.grupo = s.grupo
),
ref as (
  select camion, count(*) as n,
         percentile_cont(0.5) within group (order by km_lleno::numeric / litros_lleno) as rend_mediana
  from calc where km_lleno is not null group by camion
)
select c.id, c.creado_en, c.fecha, c.camion, c.chofer, c.chofer_nombre, c.registrado_rol, c.registrado_por,
  c.litros, c.importe, c.precio_litro, c.odometro, c.lleno, c.gasolinera, c.folio, c.estado, c.nota,
  c.revisada_por, c.revisada_en, c.tiene_foto, c.tanque, c.odo_prev, c.km, c.km_lleno, c.litros_lleno,
  round(c.km_lleno::numeric / c.litros_lleno, 2) as rendimiento,
  round(r.rend_mediana::numeric, 2) as rendimiento_normal,
  array_remove(array[
    case when not c.tiene_foto then 'sin_ticket' end,
    case when c.tanque is not null and c.litros > c.tanque * 1.03 then 'sobre_tanque' end,
    case when c.odo_prev is not null and c.odometro < c.odo_prev then 'odometro' end,
    case when c.km is not null and c.km > coalesce(case when r.n >= 3 then c.tanque * r.rend_mediana * 1.15 end, 2500)
         then 'carga_faltante' end,
    case when c.km_lleno is not null and r.n >= 3 and c.km_lleno::numeric / c.litros_lleno < r.rend_mediana * 0.75
         then 'rendimiento_bajo' end,
    case when c.km_lleno is not null and r.n >= 3 and c.km_lleno::numeric / c.litros_lleno > r.rend_mediana * 1.33
         then 'rendimiento_alto' end,
    case when p.mediana is not null and abs(c.precio_litro - p.mediana) > p.mediana * 0.08 then 'precio' end,
    case when c.fecha_prev is not null and c.fecha - c.fecha_prev < interval '12 hours' and coalesce(c.km, 0) < 80
         then 'seguidas' end
  ], null) as alertas
from calc c
left join ref r on r.camion = c.camion
left join lateral (
  -- Precio normal: la mediana de las demás cargas de mes y medio alrededor
  select percentile_cont(0.5) within group (order by o.precio_litro) as mediana
  from privado.diesel_cargas o
  where o.estado <> 'anulada' and o.id <> c.id
    and o.fecha between c.fecha - interval '45 days' and c.fecha + interval '45 days'
  having count(*) >= 3
) p on true;

revoke all on privado.diesel_calculo from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. Validación y alta (compartidas por chofer y administración)
-- ---------------------------------------------------------------------
create or replace function privado.diesel_validar(p_camion integer, p_fecha timestamptz, p_litros numeric,
                                                  p_importe numeric, p_odometro integer, p_dias integer)
returns void language plpgsql stable set search_path = '' as $$
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
  if p_odometro is null or p_odometro < 0 or p_odometro > 5000000 then
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

create or replace function privado.diesel_guardar(
  p_rol text, p_actor text, p_chofer text, p_camion integer, p_fecha timestamptz, p_litros numeric,
  p_importe numeric, p_odometro integer, p_lleno boolean, p_gasolinera text, p_folio text, p_foto text)
returns json language plpgsql security definer set search_path = '' as $$
declare
  v_fecha timestamptz := coalesce(p_fecha, now());
  v_litros numeric := round(p_litros, 2);
  v_importe numeric := round(p_importe, 2);
  v_gasolinera text := nullif(privado.limpiar_texto(p_gasolinera), '');
  v_folio text := nullif(upper(regexp_replace(coalesce(p_folio, ''), '\s+', '', 'g')), '');
  v_foto bytea;
  v_id bigint;
  v_r json;
begin
  perform privado.diesel_validar(p_camion, v_fecha, v_litros, v_importe, p_odometro, case when p_rol = 'Chofer' then 7 else 400 end);
  if char_length(coalesce(v_gasolinera, '')) > 80 then
    raise exception 'El nombre de la gasolinera es muy largo (máximo 80 caracteres)';
  end if;
  if char_length(coalesce(v_folio, '')) > 40 then
    raise exception 'El folio es muy largo (máximo 40 caracteres)';
  end if;
  -- El mismo ticket dos veces
  if exists (
    select 1 from privado.diesel_cargas
    where estado <> 'anulada'
      and ((v_folio is not null and folio = v_folio and importe = v_importe)
        or (camion = p_camion and litros = v_litros and importe = v_importe
            and abs(extract(epoch from fecha - v_fecha)) < 6 * 3600))
  ) then
    raise exception 'Esta carga ya estaba registrada';
  end if;

  -- Foto del ticket: JPEG comprimido en el teléfono, en base64
  if nullif(p_foto, '') is not null then
    begin
      v_foto := decode(regexp_replace(p_foto, '^data:image/[a-z]+;base64,', ''), 'base64');
    exception when others then
      raise exception 'La foto del ticket no es válida';
    end;
    if octet_length(v_foto) > 900 * 1024 then
      raise exception 'La foto del ticket es muy pesada';
    end if;
    if octet_length(v_foto) < 2000 or substring(v_foto from 1 for 3) <> '\xffd8ff'::bytea then
      raise exception 'La foto del ticket no es válida';
    end if;
  elsif p_rol = 'Chofer' then
    raise exception 'Toma la foto del ticket';
  end if;

  insert into privado.diesel_cargas (fecha, camion, chofer, chofer_nombre, registrado_rol, registrado_por,
                                     litros, importe, odometro, lleno, gasolinera, folio)
  values (v_fecha, p_camion, p_chofer, (select nombre from public.choferes where licencia = p_chofer), p_rol, p_actor,
          v_litros, v_importe, p_odometro, coalesce(p_lleno, true), v_gasolinera, v_folio)
  returning id into v_id;
  if v_foto is not null then
    insert into privado.diesel_tickets (carga_id, foto) values (v_id, v_foto);
  end if;

  perform privado.log(p_rol, p_actor, 'diesel_registrado',
    jsonb_build_object('id', v_id, 'camion', p_camion, 'litros', v_litros, 'importe', v_importe));
  perform public._senal('diesel');

  select json_build_object('id', id, 'km', km, 'rendimiento', rendimiento, 'alertas', alertas)
    into v_r from privado.diesel_calculo where id = v_id;
  return v_r;
end;
$$;

revoke all on function privado.diesel_validar(integer, timestamptz, numeric, numeric, integer, integer) from public, anon, authenticated;
revoke all on function privado.diesel_guardar(text, text, text, integer, timestamptz, numeric, numeric, integer, boolean, text, text, text) from public, anon, authenticated;

-- Fila de carga para las listas (con lo calculado si no está anulada)
create or replace function privado.diesel_json(c privado.diesel_cargas, v privado.diesel_calculo)
returns json language sql stable set search_path = '' as $$
  select json_build_object(
    'id', c.id, 'creado_en', c.creado_en, 'fecha', c.fecha, 'camion', c.camion,
    'chofer', c.chofer, 'chofer_nombre', c.chofer_nombre, 'registrado_rol', c.registrado_rol, 'registrado_por', c.registrado_por,
    'litros', c.litros, 'importe', c.importe, 'precio_litro', c.precio_litro, 'odometro', c.odometro, 'lleno', c.lleno,
    'gasolinera', c.gasolinera, 'folio', c.folio, 'estado', c.estado, 'nota', c.nota,
    'revisada_por', c.revisada_por, 'revisada_en', c.revisada_en,
    'tiene_foto', exists (select 1 from privado.diesel_tickets k where k.carga_id = c.id),
    'km', v.km, 'rendimiento', v.rendimiento, 'rendimiento_normal', v.rendimiento_normal,
    'odo_prev', v.odo_prev, 'tanque', v.tanque, 'alertas', coalesce(to_json(v.alertas), '[]'::json));
$$;
revoke all on function privado.diesel_json(privado.diesel_cargas, privado.diesel_calculo) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. Chofer
-- ---------------------------------------------------------------------
create or replace function public.chofer_diesel_registrar(
  p_token uuid, p_camion integer, p_fecha timestamptz, p_litros numeric, p_importe numeric,
  p_odometro integer, p_lleno boolean, p_gasolinera text, p_folio text, p_foto text)
returns json language plpgsql security definer set search_path = 'public' as $$
declare
  v_chofer text := _validar_sesion(p_token, array['Chofer']);
begin
  if (select count(*) from privado.diesel_cargas where registrado_por = v_chofer and registrado_rol = 'Chofer'
        and creado_en > now() - interval '24 hours') >= 10 then
    raise exception 'Ya registraste 10 cargas en las últimas 24 horas. Avisa a la administración.';
  end if;
  return privado.diesel_guardar('Chofer', v_chofer, v_chofer, p_camion, p_fecha, p_litros, p_importe,
                                p_odometro, p_lleno, p_gasolinera, p_folio, p_foto);
end;
$$;

-- Sus últimas cargas y la última de cada camión (para comparar el kilometraje)
create or replace function public.chofer_diesel(p_token uuid)
returns json language plpgsql security definer set search_path = 'public' as $$
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
      select json_agg(json_build_object('camion', e.id, 'odometro', u.odometro, 'fecha', u.fecha, 'tanque', t.litros) order by e.id)
      from estado_viaje e
      left join lateral (
        select odometro, fecha from privado.diesel_cargas
        where camion = e.id and estado <> 'anulada' order by fecha desc, id desc limit 1
      ) u on true
      left join privado.diesel_tanques t on t.camion = e.id
    ), '[]'::json)
  );
end;
$$;

-- Foto del ticket de una carga propia
create or replace function public.chofer_diesel_ticket(p_token uuid, p_id bigint)
returns text language plpgsql security definer set search_path = 'public' as $$
declare
  v_chofer text := _validar_sesion(p_token, array['Chofer']);
  v_foto bytea;
begin
  select k.foto into v_foto
  from privado.diesel_tickets k join privado.diesel_cargas c on c.id = k.carga_id
  where k.carga_id = p_id and c.chofer = v_chofer;
  if v_foto is null then
    raise exception 'No se encontró la foto del ticket';
  end if;
  return translate(encode(v_foto, 'base64'), E'\n', '');
end;
$$;

-- ---------------------------------------------------------------------
-- 5. Administración
-- ---------------------------------------------------------------------
-- Tarjeta de la pestaña Saldos: el mes en curso y lo pendiente de revisar
create or replace function public.admin_diesel_resumen(p_token uuid)
returns json language plpgsql security definer set search_path = 'public' as $$
declare
  v_ini timestamptz := date_trunc('month', now() at time zone 'America/Mexico_City') at time zone 'America/Mexico_City';
begin
  perform _validar_sesion(p_token, array['Admin']);
  return (
    select json_build_object(
      'cargas', count(*) filter (where fecha >= v_ini),
      'litros', coalesce(sum(litros) filter (where fecha >= v_ini), 0),
      'importe', coalesce(sum(importe) filter (where fecha >= v_ini), 0),
      'km_lleno', coalesce(sum(km_lleno) filter (where fecha >= v_ini), 0),
      'litros_lleno', coalesce(sum(litros_lleno) filter (where fecha >= v_ini), 0),
      'pendientes', count(*) filter (where estado = 'pendiente'),
      'alertas', count(*) filter (where estado = 'pendiente' and cardinality(alertas) > 0)
    )
    from privado.diesel_calculo
  );
end;
$$;

create or replace function public.admin_diesel_cargas(p_token uuid)
returns json language plpgsql security definer set search_path = 'public' as $$
begin
  perform _validar_sesion(p_token, array['Admin']);
  return json_build_object(
    'cargas', coalesce((
      select json_agg(privado.diesel_json(c, v) order by c.fecha desc, c.id desc)
      from privado.diesel_cargas c
      left join privado.diesel_calculo v on v.id = c.id
      where c.id in (select id from privado.diesel_cargas order by fecha desc, id desc limit 300)
    ), '[]'::json),
    'tanques', coalesce((
      select json_agg(json_build_object('camion', e.id, 'litros', t.litros) order by e.id)
      from estado_viaje e left join privado.diesel_tanques t on t.camion = e.id
    ), '[]'::json)
  );
end;
$$;

create or replace function public.admin_diesel_registrar(
  p_token uuid, p_chofer text, p_camion integer, p_fecha timestamptz, p_litros numeric, p_importe numeric,
  p_odometro integer, p_lleno boolean, p_gasolinera text, p_folio text, p_foto text)
returns json language plpgsql security definer set search_path = 'public' as $$
declare
  v_admin text := _validar_sesion(p_token, array['Admin']);
begin
  if nullif(p_chofer, '') is not null and not exists (select 1 from choferes where licencia = p_chofer) then
    raise exception 'Ese chofer no existe';
  end if;
  return privado.diesel_guardar('Admin', v_admin, nullif(p_chofer, ''), p_camion, p_fecha, p_litros, p_importe,
                                p_odometro, p_lleno, p_gasolinera, p_folio, p_foto);
end;
$$;

-- Verificar, observar, anular o corregir una carga. Los datos que llegan
-- vacíos no cambian.
create or replace function public.admin_diesel_actualizar(
  p_token uuid, p_id bigint, p_estado text, p_nota text,
  p_camion integer default null, p_fecha timestamptz default null, p_litros numeric default null,
  p_importe numeric default null, p_odometro integer default null, p_lleno boolean default null)
returns json language plpgsql security definer set search_path = 'public' as $$
declare
  v_admin text := _validar_sesion(p_token, array['Admin']);
  v_nota text := nullif(privado.limpiar_texto(p_nota), '');
  a privado.diesel_cargas%rowtype;
  n privado.diesel_cargas%rowtype;
  v_corregida boolean;
  v_r json;
begin
  if p_estado is null or p_estado not in ('pendiente', 'verificada', 'observada', 'anulada') then
    raise exception 'Estado inválido';
  end if;
  if char_length(coalesce(v_nota, '')) > 300 then
    raise exception 'La nota es muy larga (máximo 300 caracteres)';
  end if;
  if p_estado in ('observada', 'anulada') and v_nota is null then
    raise exception '%', case when p_estado = 'anulada' then 'Escribe por qué se anula' else 'Escribe qué se observó' end;
  end if;
  select * into a from privado.diesel_cargas where id = p_id for update;
  if a.id is null then
    raise exception 'La carga ya no existe';
  end if;

  n := a;
  n.camion := coalesce(p_camion, a.camion);
  n.fecha := coalesce(p_fecha, a.fecha);
  n.litros := round(coalesce(p_litros, a.litros), 2);
  n.importe := round(coalesce(p_importe, a.importe), 2);
  n.odometro := coalesce(p_odometro, a.odometro);
  n.lleno := coalesce(p_lleno, a.lleno);
  v_corregida := (n.camion, n.fecha, n.litros, n.importe, n.odometro, n.lleno)
                 is distinct from (a.camion, a.fecha, a.litros, a.importe, a.odometro, a.lleno);
  if v_corregida then
    perform privado.diesel_validar(n.camion, n.fecha, n.litros, n.importe, n.odometro, 400);
  end if;

  update privado.diesel_cargas
     set estado = p_estado, nota = v_nota, camion = n.camion, fecha = n.fecha, litros = n.litros,
         importe = n.importe, odometro = n.odometro, lleno = n.lleno,
         revisada_por = v_admin, revisada_en = now()
   where id = p_id;

  perform privado.log('Admin', v_admin, 'diesel_actualizado', jsonb_build_object('id', p_id, 'estado', p_estado,
    'camion', n.camion, 'corregida', v_corregida) ||
    case when v_corregida then jsonb_build_object('antes', jsonb_build_object('camion', a.camion, 'litros', a.litros,
      'importe', a.importe, 'odometro', a.odometro, 'lleno', a.lleno, 'fecha', a.fecha)) else '{}'::jsonb end);
  perform _senal('diesel');

  select privado.diesel_json(c, v) into v_r
  from privado.diesel_cargas c left join privado.diesel_calculo v on v.id = c.id
  where c.id = p_id;
  return v_r;
end;
$$;

-- Capacidad del tanque de cada camión (vacío = sin dato)
create or replace function public.admin_diesel_tanque(p_token uuid, p_camion integer, p_litros numeric)
returns void language plpgsql security definer set search_path = 'public' as $$
declare
  v_admin text := _validar_sesion(p_token, array['Admin']);
begin
  if p_camion is null or not exists (select 1 from estado_viaje where id = p_camion) then
    raise exception 'Ese camión no existe';
  end if;
  if p_litros is null then
    delete from privado.diesel_tanques where camion = p_camion;
  else
    if p_litros < 20 or p_litros > 1500 then
      raise exception 'La capacidad del tanque debe estar entre 20 y 1,500 litros';
    end if;
    insert into privado.diesel_tanques (camion, litros, actualizado_por) values (p_camion, round(p_litros, 1), v_admin)
    on conflict (camion) do update set litros = excluded.litros, actualizado_en = now(), actualizado_por = excluded.actualizado_por;
  end if;
  perform privado.log('Admin', v_admin, 'diesel_tanque', jsonb_build_object('camion', p_camion, 'litros', p_litros));
  perform _senal('diesel');
end;
$$;

-- Fotos de tickets (hasta 30 por llamada, para el anexo del PDF)
create or replace function public.admin_diesel_tickets(p_token uuid, p_ids bigint[])
returns json language plpgsql security definer set search_path = 'public' as $$
begin
  perform _validar_sesion(p_token, array['Admin']);
  if cardinality(p_ids) > 30 then
    raise exception 'Pide máximo 30 fotos a la vez';
  end if;
  return coalesce((
    select json_agg(json_build_object('id', carga_id, 'foto', translate(encode(foto, 'base64'), E'\n', '')))
    from privado.diesel_tickets where carga_id = any(p_ids)
  ), '[]'::json);
end;
$$;

-- Informe para directivos. El periodo anterior (opcional) sirve para comparar.
create or replace function public.admin_reporte_diesel(p_token uuid, p_desde date, p_hasta date,
                                                       p_ant_desde date default null, p_ant_hasta date default null)
returns json language plpgsql security definer set search_path = 'public' as $$
declare
  r record;
  v_ant_ini timestamptz;
  v_ant_fin timestamptz;
begin
  perform _validar_sesion(p_token, array['Admin']);
  select * into r from _rango(p_desde, p_hasta);
  if p_ant_desde is not null and p_ant_hasta is not null then
    select ini, fin into v_ant_ini, v_ant_fin from _rango(p_ant_desde, p_ant_hasta);
  end if;

  return (
    with v as (
      select * from privado.diesel_calculo where fecha >= r.ini and fecha < r.fin
    ),
    sal as (
      select camion, count(*) as salidas, coalesce(sum(alumnos), 0) as pasajeros
      from privado.cortes where creado_en >= r.ini and creado_en < r.fin group by camion
    )
    select json_build_object(
      'desde', p_desde,
      'hasta', p_hasta,
      'totales', (
        select json_build_object('cargas', count(*), 'litros', coalesce(sum(litros), 0), 'importe', coalesce(sum(importe), 0),
          'km', coalesce(sum(km), 0), 'km_lleno', coalesce(sum(km_lleno), 0), 'litros_lleno', coalesce(sum(litros_lleno), 0),
          'pendientes', count(*) filter (where estado = 'pendiente'),
          'observadas', count(*) filter (where estado = 'observada'),
          'con_alertas', count(*) filter (where cardinality(alertas) > 0),
          'salidas', (select coalesce(sum(salidas), 0) from sal),
          'pasajeros', (select coalesce(sum(pasajeros), 0) from sal))
        from v
      ),
      'anuladas', (select count(*) from privado.diesel_cargas where estado = 'anulada' and fecha >= r.ini and fecha < r.fin),
      'anterior', case when v_ant_ini is not null then (
        select json_build_object('cargas', count(*), 'litros', coalesce(sum(litros), 0), 'importe', coalesce(sum(importe), 0))
        from privado.diesel_calculo where fecha >= v_ant_ini and fecha < v_ant_fin
      ) end,
      'camiones', coalesce((
        select json_agg(json_build_object('camion', e.id, 'tanque', t.litros,
          'cargas', coalesce(x.cargas, 0), 'litros', coalesce(x.litros, 0), 'importe', coalesce(x.importe, 0),
          'km', coalesce(x.km, 0), 'km_lleno', coalesce(x.km_lleno, 0), 'litros_lleno', coalesce(x.litros_lleno, 0),
          'salidas', coalesce(s.salidas, 0), 'pasajeros', coalesce(s.pasajeros, 0)) order by e.id)
        from estado_viaje e
        left join privado.diesel_tanques t on t.camion = e.id
        left join (
          select camion, count(*) as cargas, sum(litros) as litros, sum(importe) as importe, sum(km) as km,
                 sum(km_lleno) as km_lleno, sum(litros_lleno) as litros_lleno
          from v group by camion
        ) x on x.camion = e.id
        left join sal s on s.camion = e.id
      ), '[]'::json),
      'choferes', coalesce((
        select json_agg(json_build_object('licencia', y.chofer, 'nombre', y.nombre, 'cargas', y.cargas,
          'litros', y.litros, 'importe', y.importe) order by y.importe desc)
        from (
          select v.chofer, max(coalesce(ch.nombre, v.chofer_nombre, v.chofer)) as nombre, count(*) as cargas,
                 sum(v.litros) as litros, sum(v.importe) as importe
          from v left join choferes ch on ch.licencia = v.chofer
          group by v.chofer
        ) y
      ), '[]'::json),
      -- Mismo formato que la lista de la administración (se abren en la misma hoja)
      'cargas', coalesce((
        select json_agg(privado.diesel_json(c, d) order by d.fecha, d.id)
        from privado.diesel_calculo d join privado.diesel_cargas c on c.id = d.id
        where d.fecha >= r.ini and d.fecha < r.fin
      ), '[]'::json),
      'dias', coalesce((
        select json_agg(json_build_object('fecha', d.fecha, 'litros', d.litros, 'importe', d.importe) order by d.fecha)
        from (
          select (fecha at time zone 'America/Mexico_City')::date as fecha, sum(litros) as litros, sum(importe) as importe
          from v group by 1
        ) d
      ), '[]'::json)
    )
  );
end;
$$;

-- ---------------------------------------------------------------------
-- 6. Permisos: las funciones públicas validan el token de sesión
-- ---------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'chofer_diesel_registrar(uuid, integer, timestamptz, numeric, numeric, integer, boolean, text, text, text)',
    'chofer_diesel(uuid)', 'chofer_diesel_ticket(uuid, bigint)',
    'admin_diesel_resumen(uuid)', 'admin_diesel_cargas(uuid)',
    'admin_diesel_registrar(uuid, text, integer, timestamptz, numeric, numeric, integer, boolean, text, text, text)',
    'admin_diesel_actualizar(uuid, bigint, text, text, integer, timestamptz, numeric, numeric, integer, boolean)',
    'admin_diesel_tanque(uuid, integer, numeric)', 'admin_diesel_tickets(uuid, bigint[])',
    'admin_reporte_diesel(uuid, date, date, date, date)'
  ] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
end;
$$;
