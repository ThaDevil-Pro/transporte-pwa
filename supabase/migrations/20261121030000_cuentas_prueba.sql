-- Cuentas de prueba ("developer" en cualquier rol): no ensucian cortes ni reportes.
-- · Alumno de prueba: su boleto cuesta $0 por cualquier vía (viaje, perdido, cancelar tarde)
--   y en el corte no se cuenta ni se guarda en el historial.
-- · Chofer de prueba: no aparece en la lista de choferes de reportes, y sus cortes y cargas
--   de diésel no suman en los reportes de gastos ni de diésel.
-- shortcut: la prueba se reconoce por el nombre de usuario; si hay más cuentas de prueba, agregarlas aquí.

create or replace function privado.es_prueba(p_ref text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select lower(trim(coalesce(p_ref, ''))) in ('developer')
$$;
revoke all on function privado.es_prueba(text) from public, anon, authenticated;

create or replace function privado.precio_boleto(p_matricula text)
returns numeric
language sql
stable
set search_path = ''
as $$
  select case when privado.es_prueba(p_matricula) then 0::numeric else
    round((case (select ubicacion from public.alumnos where matricula = p_matricula) when 'chinacates' then 40 else 60 end)::numeric
          * (100 - coalesce((select porcentaje from privado.becas where matricula = p_matricula), 0)) / 100, 2)
  end
$$;

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
$$;

create or replace function public.admin_reporte_choferes(p_token uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  perform _validar_sesion(p_token, array['Admin']);
  return coalesce((
    select json_agg(json_build_object('licencia', x.licencia, 'nombre', x.nombre, 'activo', x.activo) order by x.nombre)
    from (
      select licencia, nombre, true as activo from choferes where not privado.es_prueba(licencia)
      union all
      (select distinct on (c.chofer) c.chofer, coalesce(c.chofer_nombre, c.chofer), false
       from privado.cortes c
       where not exists (select 1 from choferes ch where ch.licencia = c.chofer) and not privado.es_prueba(c.chofer)
       order by c.chofer, c.id desc)
    ) x
  ), '[]'::json);
end;
$$;

create or replace function public.admin_reporte_gastos(p_token uuid, p_desde date, p_hasta date)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  perform _validar_sesion(p_token, array['Admin', 'Financiero']);
  select * into r from _rango(p_desde, p_hasta);
  return json_build_object(
    'desde', p_desde,
    'hasta', p_hasta,
    'adeudo_total', (select coalesce(sum(saldo), 0) from alumnos where saldo > 0 and not privado.es_prueba(matricula)),
    'alumnos_con_adeudo', (select count(*) from alumnos where saldo > 0 and not privado.es_prueba(matricula)),
    'alumnos', coalesce((
      select json_agg(x order by x.cargado desc, x.nombre)
      from (
        select a.nombre, a.matricula, coalesce(a.saldo, 0) as saldo,
               coalesce(v.viajes, 0) as viajes, coalesce(v.cargado, 0) as cargado, coalesce(p.pagado, 0) as pagado
        from alumnos a
        left join (
          select matricula, count(*) filter (where not perdido) as viajes, sum(monto) as cargado
          from historial_viajes where fecha_hora >= r.ini and fecha_hora < r.fin group by matricula
        ) v on v.matricula = a.matricula
        left join (
          select matricula, sum(monto) as pagado
          from privado.pagos where creado_en >= r.ini and creado_en < r.fin group by matricula
        ) p on p.matricula = a.matricula
        where (v.viajes is not null or p.pagado is not null or a.saldo > 0) and not privado.es_prueba(a.matricula)
      ) x
    ), '[]'::json),
    'pagos', coalesce((
      select json_agg(json_build_object('creado_en', p.creado_en, 'nombre', coalesce(a.nombre, p.matricula), 'matricula', p.matricula,
                                        'monto', p.monto, 'nota', p.nota, 'registrado_por', p.registrado_por) order by p.creado_en)
      from privado.pagos p left join alumnos a on a.matricula = p.matricula
      where p.creado_en >= r.ini and p.creado_en < r.fin and not privado.es_prueba(p.matricula)
    ), '[]'::json),
    'choferes', coalesce((
      select json_agg(x order by x.total desc)
      from (
        select chofer as licencia, max(coalesce(ch.nombre, c.chofer_nombre, c.chofer)) as nombre,
               count(*) as cortes, sum(c.alumnos) as alumnos, sum(c.de_pie) as de_pie, sum(c.total) as total
        from privado.cortes c left join choferes ch on ch.licencia = c.chofer
        where c.creado_en >= r.ini and c.creado_en < r.fin and not privado.es_prueba(c.chofer)
        group by c.chofer
      ) x
    ), '[]'::json),
    'camiones', coalesce((
      select json_agg(json_build_object('camion', camion, 'viajes', viajes, 'cargado', cargado) order by camion)
      from (
        select coalesce(camion, 1) as camion, count(*) filter (where not perdido) as viajes, sum(monto) as cargado
        from historial_viajes where fecha_hora >= r.ini and fecha_hora < r.fin and not privado.es_prueba(matricula) group by 1
      ) x
    ), '[]'::json),
    'dias', coalesce((
      select json_agg(json_build_object('fecha', d.fecha, 'cargado', d.cargado, 'pagado', d.pagado) order by d.fecha)
      from (
        select fecha, sum(cargado) as cargado, sum(pagado) as pagado
        from (
          select (fecha_hora at time zone 'America/Mexico_City')::date as fecha, monto as cargado, 0 as pagado
          from historial_viajes where fecha_hora >= r.ini and fecha_hora < r.fin and not privado.es_prueba(matricula)
          union all
          select (creado_en at time zone 'America/Mexico_City')::date, 0, monto
          from privado.pagos where creado_en >= r.ini and creado_en < r.fin and not privado.es_prueba(matricula)
        ) u
        group by fecha
      ) d
    ), '[]'::json)
  );
end;
$$;

create or replace function public.admin_reporte_diesel(p_token uuid, p_desde date, p_hasta date, p_ant_desde date default null, p_ant_hasta date default null)
returns json
language plpgsql
security definer
set search_path = public
as $$
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
      select * from privado.diesel_calculo where fecha >= r.ini and fecha < r.fin and not privado.es_prueba(chofer)
    ),
    sal as (
      select camion, count(*) as salidas, coalesce(sum(alumnos), 0) as pasajeros
      from privado.cortes where creado_en >= r.ini and creado_en < r.fin and not privado.es_prueba(chofer) group by camion
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
      'anuladas', (select count(*) from privado.diesel_cargas where estado = 'anulada' and fecha >= r.ini and fecha < r.fin and not privado.es_prueba(chofer)),
      'anterior', case when v_ant_ini is not null then (
        select json_build_object('cargas', count(*), 'litros', coalesce(sum(litros), 0), 'importe', coalesce(sum(importe), 0))
        from privado.diesel_calculo where fecha >= v_ant_ini and fecha < v_ant_fin and not privado.es_prueba(chofer)
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
      'cargas', coalesce((
        select json_agg(privado.diesel_json(c, d) order by d.fecha, d.id)
        from privado.diesel_calculo d join privado.diesel_cargas c on c.id = d.id
        where d.fecha >= r.ini and d.fecha < r.fin and not privado.es_prueba(d.chofer)
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

create or replace function public.admin_diesel_resumen(p_token uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
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
    where not privado.es_prueba(chofer)
  );
end;
$$;
