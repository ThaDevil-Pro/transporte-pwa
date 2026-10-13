-- =====================================================================
-- CAMIFY · Reportes en PDF
--  1. Cada corte queda registrado con el chofer que lo hizo, y cada viaje
--     cobrado apunta a su corte (antes solo quedaba en la bitácora).
--  2. Reporte del alumno: sus viajes y pagos en un periodo.
--  3. Reporte del chofer: sus cortes (día, semana o mes) con pasajeros.
--  4. Informe de gastos de la administración y reporte de cualquier chofer.
--  El PDF se arma en el teléfono; aquí solo se entregan los datos.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Cortes
-- ---------------------------------------------------------------------
create table if not exists privado.cortes (
  id bigint generated always as identity primary key,
  creado_en timestamptz not null default now(),
  chofer text not null,          -- licencia
  chofer_nombre text,            -- nombre al momento del corte
  camion smallint not null,
  alumnos int not null,
  manuales int not null default 0,
  total numeric(10, 2) not null
);
create index if not exists cortes_chofer_idx on privado.cortes (chofer, creado_en desc);
create index if not exists cortes_creado_idx on privado.cortes (creado_en desc);
revoke all on privado.cortes from public, anon, authenticated;

alter table public.historial_viajes add column if not exists corte_id bigint references privado.cortes (id) on delete set null;
create index if not exists historial_corte_idx on public.historial_viajes (corte_id);
create index if not exists historial_fecha_idx on public.historial_viajes (fecha_hora desc);

-- Cortes anteriores: se recuperan de la bitácora. El corte y su registro
-- comparten la misma hora exacta (misma transacción).
do $$
declare
  b record;
  v_id bigint;
begin
  for b in
    select bi.* from privado.bitacora bi
    where bi.accion = 'corte' and bi.actor_rol = 'Chofer'
      and not exists (select 1 from privado.cortes c where c.creado_en = bi.creado_en and c.chofer = bi.actor)
    order by bi.id
  loop
    insert into privado.cortes (creado_en, chofer, chofer_nombre, camion, alumnos, manuales, total)
    values (b.creado_en, b.actor, (select nombre from public.choferes where licencia = b.actor),
            coalesce((b.detalle ->> 'camion')::smallint, 1), coalesce((b.detalle ->> 'alumnos')::int, 0),
            coalesce((b.detalle ->> 'manuales')::int, 0), coalesce((b.detalle ->> 'total')::numeric, 0))
    returning id into v_id;

    update public.historial_viajes
       set corte_id = v_id
     where corte_id is null and fecha_hora = b.creado_en and coalesce(camion, 1) = coalesce((b.detalle ->> 'camion')::smallint, 1);
  end loop;
end;
$$;

-- El corte ahora también guarda quién lo hizo
create or replace function public.chofer_hacer_corte(p_token uuid, p_camion integer)
returns integer language plpgsql security definer set search_path = 'public' as $$
declare
  v_chofer text := _validar_sesion(p_token, array['Chofer']);
  v_total integer;
  v_manuales integer;
  v_corte bigint;
begin
  perform _camion_valido(p_camion);
  lock table abordajes in share row exclusive mode;

  if (select estado from estado_viaje where id = p_camion for update) = 'EN_CAMINO' then
    raise exception 'Ya se hizo el corte de este viaje. Finalízalo antes de cobrar otro.';
  end if;

  select count(*), count(*) filter (where manual) into v_total, v_manuales from abordajes where camion = p_camion;
  if v_total = 0 then
    raise exception 'No hay estudiantes en la lista de abordaje.';
  end if;

  update alumnos a
     set saldo = coalesce(a.saldo, 0) + 30
    from abordajes b
   where a.matricula = b.matricula and b.camion = p_camion;

  insert into privado.cortes (chofer, chofer_nombre, camion, alumnos, manuales, total)
  values (v_chofer, (select nombre from choferes where licencia = v_chofer), p_camion, v_total, v_manuales, v_total * 30)
  returning id into v_corte;

  insert into historial_viajes (matricula, monto, fecha_hora, camion, manual, corte_id)
  select matricula, 30, now(), p_camion, manual, v_corte from abordajes where camion = p_camion;

  update estado_viaje set estado = 'EN_CAMINO', updated_at = now() where id = p_camion;
  perform privado.log('Chofer', v_chofer, 'corte', jsonb_build_object('camion', p_camion, 'alumnos', v_total, 'total', v_total * 30,
    'manuales', v_manuales));
  return v_total;
end;
$$;

-- ---------------------------------------------------------------------
-- 2. Auxiliares
-- ---------------------------------------------------------------------
-- Periodo en hora de México: [desde 00:00, hasta+1 00:00). Máximo ~13 meses.
create or replace function public._rango(p_desde date, p_hasta date, out ini timestamptz, out fin timestamptz)
language plpgsql stable set search_path = '' as $$
begin
  if p_desde is null or p_hasta is null or p_hasta < p_desde then
    raise exception 'Periodo inválido';
  end if;
  if p_hasta - p_desde > 400 then
    raise exception 'El periodo no puede pasar de un año';
  end if;
  ini := p_desde::timestamp at time zone 'America/Mexico_City';
  fin := (p_hasta + 1)::timestamp at time zone 'America/Mexico_City';
end;
$$;

create or replace function public._reporte_chofer(p_licencia text, p_desde date, p_hasta date)
returns json language plpgsql stable set search_path = 'public' as $$
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
        'manuales', c.manuales, 'total', c.total,
        'pasajeros', coalesce((
          select json_agg(json_build_object('nombre', coalesce(a.nombre, h.matricula), 'matricula', h.matricula, 'manual', h.manual)
                          order by coalesce(a.nombre, h.matricula))
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

revoke all on function public._rango(date, date) from public, anon, authenticated;
revoke all on function public._reporte_chofer(text, date, date) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. Alumno
-- ---------------------------------------------------------------------
create or replace function public.alumno_reporte(p_token uuid, p_desde date, p_hasta date)
returns json language plpgsql security definer set search_path = 'public' as $$
declare
  v_matricula text := _validar_sesion(p_token, array['Estudiante']);
  r record;
begin
  select * into r from _rango(p_desde, p_hasta);
  return (
    select json_build_object(
      'alumno', json_build_object('nombre', a.nombre, 'matricula', a.matricula, 'saldo', coalesce(a.saldo, 0)),
      'desde', p_desde,
      'hasta', p_hasta,
      'viajes', coalesce((
        select json_agg(json_build_object('fecha_hora', h.fecha_hora, 'camion', h.camion, 'monto', h.monto, 'manual', h.manual)
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

-- ---------------------------------------------------------------------
-- 4. Chofer
-- ---------------------------------------------------------------------
create or replace function public.chofer_reporte(p_token uuid, p_desde date, p_hasta date)
returns json language plpgsql security definer set search_path = 'public' as $$
declare
  v_chofer text := _validar_sesion(p_token, array['Chofer']);
begin
  return _reporte_chofer(v_chofer, p_desde, p_hasta);
end;
$$;

-- ---------------------------------------------------------------------
-- 5. Administración
-- ---------------------------------------------------------------------
-- Choferes con cortes, aunque ya no estén registrados
create or replace function public.admin_reporte_choferes(p_token uuid)
returns json language plpgsql security definer set search_path = 'public' as $$
begin
  perform _validar_sesion(p_token, array['Admin']);
  return coalesce((
    select json_agg(json_build_object('licencia', x.licencia, 'nombre', x.nombre, 'activo', x.activo) order by x.nombre)
    from (
      select licencia, nombre, true as activo from choferes
      union all
      (select distinct on (c.chofer) c.chofer, coalesce(c.chofer_nombre, c.chofer), false
       from privado.cortes c
       where not exists (select 1 from choferes ch where ch.licencia = c.chofer)
       order by c.chofer, c.id desc)
    ) x
  ), '[]'::json);
end;
$$;

create or replace function public.admin_reporte_chofer(p_token uuid, p_licencia text, p_desde date, p_hasta date)
returns json language plpgsql security definer set search_path = 'public' as $$
begin
  perform _validar_sesion(p_token, array['Admin']);
  return _reporte_chofer(trim(coalesce(p_licencia, '')), p_desde, p_hasta);
end;
$$;

-- Informe de gastos: lo que se cobró en viajes, lo que se pagó y lo que se debe
create or replace function public.admin_reporte_gastos(p_token uuid, p_desde date, p_hasta date)
returns json language plpgsql security definer set search_path = 'public' as $$
declare
  r record;
begin
  perform _validar_sesion(p_token, array['Admin']);
  select * into r from _rango(p_desde, p_hasta);
  return json_build_object(
    'desde', p_desde,
    'hasta', p_hasta,
    'adeudo_total', (select coalesce(sum(saldo), 0) from alumnos),
    'alumnos_con_adeudo', (select count(*) from alumnos where saldo > 0),
    'alumnos', coalesce((
      select json_agg(x order by x.cargado desc, x.nombre)
      from (
        select a.nombre, a.matricula, coalesce(a.saldo, 0) as saldo,
               coalesce(v.viajes, 0) as viajes, coalesce(v.cargado, 0) as cargado, coalesce(p.pagado, 0) as pagado
        from alumnos a
        left join (
          select matricula, count(*) as viajes, sum(monto) as cargado
          from historial_viajes where fecha_hora >= r.ini and fecha_hora < r.fin group by matricula
        ) v on v.matricula = a.matricula
        left join (
          select matricula, sum(monto) as pagado
          from privado.pagos where creado_en >= r.ini and creado_en < r.fin group by matricula
        ) p on p.matricula = a.matricula
        where v.viajes is not null or p.pagado is not null or a.saldo > 0
      ) x
    ), '[]'::json),
    'pagos', coalesce((
      select json_agg(json_build_object('creado_en', p.creado_en, 'nombre', coalesce(a.nombre, p.matricula), 'matricula', p.matricula,
                                        'monto', p.monto, 'nota', p.nota, 'registrado_por', p.registrado_por) order by p.creado_en)
      from privado.pagos p left join alumnos a on a.matricula = p.matricula
      where p.creado_en >= r.ini and p.creado_en < r.fin
    ), '[]'::json),
    'choferes', coalesce((
      select json_agg(x order by x.total desc)
      from (
        select chofer as licencia, max(coalesce(ch.nombre, c.chofer_nombre, c.chofer)) as nombre,
               count(*) as cortes, sum(c.alumnos) as alumnos, sum(c.total) as total
        from privado.cortes c left join choferes ch on ch.licencia = c.chofer
        where c.creado_en >= r.ini and c.creado_en < r.fin
        group by c.chofer
      ) x
    ), '[]'::json),
    'camiones', coalesce((
      select json_agg(json_build_object('camion', camion, 'viajes', viajes, 'cargado', cargado) order by camion)
      from (
        select coalesce(camion, 1) as camion, count(*) as viajes, sum(monto) as cargado
        from historial_viajes where fecha_hora >= r.ini and fecha_hora < r.fin group by 1
      ) x
    ), '[]'::json),
    'dias', coalesce((
      select json_agg(json_build_object('fecha', d.fecha, 'cargado', d.cargado, 'pagado', d.pagado) order by d.fecha)
      from (
        select fecha, sum(cargado) as cargado, sum(pagado) as pagado
        from (
          select (fecha_hora at time zone 'America/Mexico_City')::date as fecha, monto as cargado, 0 as pagado
          from historial_viajes where fecha_hora >= r.ini and fecha_hora < r.fin
          union all
          select (creado_en at time zone 'America/Mexico_City')::date, 0, monto
          from privado.pagos where creado_en >= r.ini and creado_en < r.fin
        ) u
        group by fecha
      ) d
    ), '[]'::json)
  );
end;
$$;

revoke all on function public.alumno_reporte(uuid, date, date) from public;
revoke all on function public.chofer_reporte(uuid, date, date) from public;
revoke all on function public.admin_reporte_choferes(uuid) from public;
revoke all on function public.admin_reporte_chofer(uuid, text, date, date) from public;
revoke all on function public.admin_reporte_gastos(uuid, date, date) from public;
grant execute on function public.alumno_reporte(uuid, date, date) to anon, authenticated;
grant execute on function public.chofer_reporte(uuid, date, date) to anon, authenticated;
grant execute on function public.admin_reporte_choferes(uuid) to anon, authenticated;
grant execute on function public.admin_reporte_chofer(uuid, text, date, date) to anon, authenticated;
grant execute on function public.admin_reporte_gastos(uuid, date, date) to anon, authenticated;
