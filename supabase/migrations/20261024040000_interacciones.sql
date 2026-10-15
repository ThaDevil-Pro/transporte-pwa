-- =====================================================================
-- CAMIFY · Correcciones de interacción entre funciones
--  1. Quitar a un alumno subido a mano libera el asiento que el chofer
--     le apartó (si el alumno no lo tenía apartado antes).
--  2. Después del corte ya no se puede quitar ni vaciar la lista: ya se
--     cobró y el comprobante saldría incompleto.
--  3. Al salir, de pie quedan los que pasan de 40 aunque se hayan sentado
--     antes que los que tenían asiento apartado.
--  4. Apartar con pareja: si la pareja no está al corriente, solo se
--     aparta para quien lo pidió.
-- =====================================================================
alter table public.abordajes add column if not exists asiento_asignado boolean not null default false;

-- Regla para apartar: al corriente, o solo debe la ida de ese día y aparta su regreso incluido
create or replace function privado.puede_apartar(p_matricula text, p_fecha date)
returns boolean language sql stable set search_path = '' as $$
  select coalesce(a.saldo, 0) <= 0
      or (coalesce(a.saldo, 0) <= 60
          and (select count(*) from public.historial_viajes h
                where h.matricula = p_matricula
                  and (h.fecha_hora at time zone 'America/Mexico_City')::date = p_fecha) % 2 = 1)
  from public.alumnos a where a.matricula = p_matricula;
$$;
revoke all on function privado.puede_apartar(text, date) from public, anon, authenticated;

do $$
declare
  v text;
  f text;
  cambios text[][] := array[
    array['public.alumno_apartar(uuid,date,time without time zone,integer,integer,boolean)',
          '  v_movido boolean := false;',
          '  v_movido boolean := false;
  v_pareja_debe boolean := false;'],
    -- 4. alumno_apartar usa la regla y no aparta para una pareja que debe
    array['public.alumno_apartar(uuid,date,time without time zone,integer,integer,boolean)',
          '  if coalesce((select saldo from alumnos where matricula = v_yo), 0) > 0
     and not (coalesce((select saldo from alumnos where matricula = v_yo), 0) <= 60
              and (select count(*) from historial_viajes where matricula = v_yo
                     and (fecha_hora at time zone ''America/Mexico_City'')::date = p_fecha) % 2 = 1) then',
          '  if not coalesce(privado.puede_apartar(v_yo, p_fecha), false) then'],
    array['public.alumno_apartar(uuid,date,time without time zone,integer,integer,boolean)',
          '  v_pareja := _pareja_de(v_yo);',
          '  v_pareja := _pareja_de(v_yo);
  -- Una pareja que no está al corriente no recibe asiento: se aparta solo para quien lo pidió
  if v_pareja is not null and not coalesce(privado.puede_apartar(v_pareja, p_fecha), false) then
    v_pareja := null;
    v_pareja_debe := true;
  end if;'],
    array['public.alumno_apartar(uuid,date,time without time zone,integer,integer,boolean)',
          '    return json_build_object(''asiento'', p_asiento);',
          '    return json_build_object(''asiento'', p_asiento, ''pareja_debe'', v_pareja_debe);'],
    array['public._abordar(integer,text,boolean,integer)',
          '  v_de_pie boolean;',
          '  v_de_pie boolean;
  v_asignado boolean := false;'],
    -- 1. _abordar recuerda si el asiento lo apartó el chofer
    array['public._abordar(integer,text,boolean,integer)',
          '      delete from reservas where fecha = v_s.fecha and hora = v_s.hora and matricula = p_matricula;',
          '      v_asignado := not exists (select 1 from reservas where fecha = v_s.fecha and hora = v_s.hora
                                  and camion = p_camion and matricula = p_matricula);
      delete from reservas where fecha = v_s.fecha and hora = v_s.hora and matricula = p_matricula;'],
    array['public._abordar(integer,text,boolean,integer)',
          '  insert into abordajes (nombre, matricula, camion, manual, de_pie)
  values (v_nombre, p_matricula, p_camion, p_manual, v_de_pie);',
          '  insert into abordajes (nombre, matricula, camion, manual, de_pie, asiento_asignado)
  values (v_nombre, p_matricula, p_camion, p_manual, v_de_pie, v_asignado);'],
    -- 3. El corte cuenta de pie a los que pasan de 40, primero los que no apartaron
    array['public.chofer_hacer_corte(uuid,integer)',
          '  update abordajes set de_pie = false
  where camion = p_camion and de_pie
    and id not in (
      select id from abordajes where camion = p_camion and de_pie
      order by created_at desc, id desc
      limit greatest(0, (select count(*) from abordajes where camion = p_camion) - 40)
    );',
          '  with orden as (
    select b.id, row_number() over (order by (r.matricula is not null), b.created_at desc, b.id desc) as n
    from abordajes b
    cross join _salida_actual(p_camion) s
    left join reservas r on r.fecha = s.fecha and r.hora = s.hora and r.camion = p_camion and r.matricula = b.matricula
    where b.camion = p_camion
  )
  update abordajes a
     set de_pie = o.n <= greatest(0, (select count(*) from abordajes where camion = p_camion) - 40)
    from orden o where a.id = o.id;']
  ];
  i int;
begin
  for i in 1 .. array_length(cambios, 1) loop
    f := cambios[i][1];
    v := pg_get_functiondef(f::regprocedure);
    -- Primero "ya aplicado": en varios cambios el texto nuevo contiene al viejo
    if position(cambios[i][3] in v) > 0 then
      continue;
    elsif position(cambios[i][2] in v) > 0 then
      execute replace(v, cambios[i][2], cambios[i][3]);
    else
      raise exception 'La función % cambió; revisa el reemplazo %', f, i;
    end if;
  end loop;
end;
$$;

-- 1 y 2. Quitar a un alumno
create or replace function public.chofer_quitar_abordaje(p_token uuid, p_id bigint)
returns void language plpgsql security definer set search_path = 'public' as $$
declare
  v_chofer text := _validar_sesion(p_token, array['Chofer']);
  v_fila abordajes%rowtype;
  v_s record;
begin
  lock table abordajes in share row exclusive mode;
  select * into v_fila from abordajes where id = p_id;
  if v_fila.id is null then
    return;
  end if;
  if (select estado from estado_viaje where id = v_fila.camion) = 'EN_CAMINO' then
    raise exception 'El corte ya se hizo y se le cobró. Finaliza el viaje.';
  end if;
  delete from abordajes where id = p_id;
  -- El asiento que le apartó el chofer al subirlo a mano vuelve a quedar libre
  if v_fila.asiento_asignado then
    select * into v_s from _salida_actual(v_fila.camion);
    delete from reservas where fecha = v_s.fecha and hora = v_s.hora and camion = v_fila.camion and matricula = v_fila.matricula;
  end if;
  perform privado.log('Chofer', v_chofer, 'alumno_quitado', jsonb_build_object('camion', v_fila.camion, 'matricula', v_fila.matricula));
end;
$$;

-- 1 y 2. Vaciar la lista
create or replace function public.chofer_vaciar_abordajes(p_token uuid, p_camion integer)
returns void language plpgsql security definer set search_path = 'public' as $$
declare
  v_chofer text := _validar_sesion(p_token, array['Chofer']);
  v_s record;
  v_n int;
begin
  perform _camion_valido(p_camion);
  lock table abordajes in share row exclusive mode;
  if (select estado from estado_viaje where id = p_camion) = 'EN_CAMINO' then
    raise exception 'El corte ya se hizo y se les cobró. Finaliza el viaje.';
  end if;
  select * into v_s from _salida_actual(p_camion);
  delete from reservas r using abordajes b
   where b.camion = p_camion and b.asiento_asignado and r.matricula = b.matricula
     and r.fecha = v_s.fecha and r.hora = v_s.hora and r.camion = p_camion;
  delete from abordajes where camion = p_camion;
  get diagnostics v_n = row_count;
  perform privado.log('Chofer', v_chofer, 'lista_vaciada', jsonb_build_object('camion', p_camion, 'alumnos', v_n));
end;
$$;
