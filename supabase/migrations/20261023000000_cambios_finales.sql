-- =====================================================================
-- CAMIFY · Cambios finales
--  1. $60 por viaje redondo: se cobra el 1.º, 3.º… viaje del día y el
--     siguiente (el regreso) va incluido. Solo ida o solo regreso: $60.
--  2. Saldo a favor: un saldo negativo es dinero a favor del alumno.
--  3. Adeudo máximo de $600: pasado eso no hay código QR ni abordaje.
--  4. Camión lleno: el alumno sube de pie y queda contado en el corte.
--  5. Al subir a alguien a mano, el chofer le elige el asiento.
--  6. Botón de emergencia del chofer: avisa a todos los alumnos.
-- =====================================================================

alter table public.abordajes add column if not exists de_pie boolean not null default false;
alter table public.historial_viajes add column if not exists de_pie boolean not null default false;
alter table privado.cortes add column if not exists de_pie integer not null default 0;

-- ---------------------------------------------------------------------
-- 1. Tarifa
-- ---------------------------------------------------------------------
create or replace function privado.cobro_viaje(p_matricula text)
returns numeric language sql stable set search_path = '' as $$
  select (case when count(*) % 2 = 0 then 60 else 0 end)::numeric
  from public.historial_viajes
  where matricula = p_matricula
    and (fecha_hora at time zone 'America/Mexico_City')::date = (now() at time zone 'America/Mexico_City')::date;
$$;
revoke all on function privado.cobro_viaje(text) from public, anon, authenticated;

-- Salida en curso del camión (la próxima, o la que salió hace menos de 30 min)
create or replace function public._salida_actual(p_camion integer, out fecha date, out hora time, out tipo text)
language sql stable set search_path = 'public' as $$
  select s.fecha, s.hora, s.tipo
  from _salidas_programadas((_ahora() at time zone 'America/Mexico_City')::date - 1, 3) s
  where s.camion = p_camion and _salida_ts(s.fecha, s.hora) > _ahora() - interval '30 minutes'
  order by _salida_ts(s.fecha, s.hora)
  limit 1
$$;
revoke all on function public._salida_actual(integer) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 3, 4 y 5. Abordaje: adeudo máximo, asiento elegido y pasajeros de pie
-- ---------------------------------------------------------------------
drop function if exists public._abordar(integer, text, boolean);
create function public._abordar(p_camion integer, p_matricula text, p_manual boolean, p_asiento integer default null)
returns json language plpgsql set search_path = 'public' as $$
declare
  v_nombre text;
  v_saldo numeric;
  v_otro_camion int;
  v_s record;
  v_ocupa text;
  v_asiento int;
  v_ocupados int;
  v_de_pie boolean;
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
    raise exception 'El alumno (%) ya está a bordo del camión %', p_matricula, _camion_nombre(v_otro_camion);
  end if;

  if v_saldo > 600 then
    raise exception '% debe $% (el máximo es $600). Tiene que pagar en la administración antes de subir.',
      split_part(v_nombre, ' ', 1), to_char(v_saldo, 'FM999,990.00');
  end if;

  select * into v_s from _salida_actual(p_camion);
  if v_s.fecha is not null then
    if p_asiento is not null then
      if p_asiento not between 1 and 40 then
        raise exception 'Asiento inválido';
      end if;
      select matricula into v_ocupa from reservas
      where fecha = v_s.fecha and hora = v_s.hora and camion = p_camion and asiento = p_asiento;
      if v_ocupa is not null and v_ocupa <> p_matricula then
        raise exception 'El asiento % ya está ocupado', p_asiento;
      end if;
      delete from reservas where fecha = v_s.fecha and hora = v_s.hora and matricula = p_matricula;
      insert into reservas (fecha, hora, tipo, camion, asiento, matricula)
      values (v_s.fecha, v_s.hora, v_s.tipo, p_camion, p_asiento, p_matricula);
    end if;
    select asiento into v_asiento from reservas
    where fecha = v_s.fecha and hora = v_s.hora and camion = p_camion and matricula = p_matricula;
  end if;

  -- Sin asiento propio y con los 40 lugares ocupados (apartados + sentados sin apartar): va de pie
  if v_asiento is null then
    select (select count(*) from reservas r
             where r.fecha = v_s.fecha and r.hora = v_s.hora and r.camion = p_camion)
         + (select count(*) from abordajes b
             where b.camion = p_camion and not b.de_pie
               and not exists (select 1 from reservas r where r.fecha = v_s.fecha and r.hora = v_s.hora
                                 and r.camion = p_camion and r.matricula = b.matricula))
      into v_ocupados;
    v_de_pie := v_ocupados >= 40;
  else
    v_de_pie := false;
  end if;

  insert into abordajes (nombre, matricula, camion, manual, de_pie)
  values (v_nombre, p_matricula, p_camion, p_manual, v_de_pie);

  return json_build_object('nombre', v_nombre, 'asiento', v_asiento, 'de_pie', v_de_pie);
end;
$$;
revoke all on function public._abordar(integer, text, boolean, integer) from public, anon, authenticated;

drop function if exists public.chofer_abordar_manual(uuid, integer, text);
create function public.chofer_abordar_manual(p_token uuid, p_camion integer, p_matricula text, p_asiento integer default null)
returns json language plpgsql security definer set search_path = 'public' as $$
declare
  v_chofer text := _validar_sesion(p_token, array['Chofer']);
  v_res json;
begin
  perform _camion_valido(p_camion);
  v_res := _abordar(p_camion, trim(coalesce(p_matricula, '')), true, p_asiento);
  perform privado.log('Chofer', v_chofer, 'abordaje_manual', jsonb_build_object(
    'camion', p_camion, 'matricula', trim(p_matricula), 'nombre', v_res ->> 'nombre',
    'asiento', v_res -> 'asiento', 'de_pie', v_res -> 'de_pie'));
  return v_res;
end;
$$;

-- Asientos de la salida en curso, para elegir uno al subir a alguien a mano
create or replace function public.chofer_mapa_actual(p_token uuid, p_camion integer)
returns json language plpgsql security definer set search_path = 'public' as $$
declare
  v_s record;
begin
  perform _validar_sesion(p_token, array['Chofer']);
  perform _camion_valido(p_camion);
  select * into v_s from _salida_actual(p_camion);
  if v_s.fecha is null then
    return null;
  end if;
  return chofer_mapa(p_token, v_s.fecha, v_s.hora, p_camion)::jsonb || jsonb_build_object('tipo', v_s.tipo);
end;
$$;

-- La lista a bordo dice cuánto se le cobrará a cada uno en el corte
drop function if exists public.chofer_abordajes(uuid, integer);
create function public.chofer_abordajes(p_token uuid, p_camion integer)
returns json language plpgsql security definer set search_path = 'public' as $$
begin
  perform _validar_sesion(p_token, array['Chofer']);
  perform _camion_valido(p_camion);
  return coalesce((
    select json_agg(to_jsonb(b) || jsonb_build_object('cobro', privado.cobro_viaje(b.matricula)) order by b.created_at)
    from abordajes b where b.camion = p_camion
  ), '[]'::json);
end;
$$;

-- ---------------------------------------------------------------------
-- 1 y 4. Corte: cobra $60 o $0 a cada uno y cuenta a los que van de pie
-- ---------------------------------------------------------------------
create or replace function public.chofer_hacer_corte(p_token uuid, p_camion integer)
returns integer language plpgsql security definer set search_path = 'public' as $$
declare
  v_chofer text := _validar_sesion(p_token, array['Chofer']);
  v_total integer;
  v_manuales integer;
  v_de_pie integer;
  v_monto numeric;
  v_corte bigint;
begin
  perform _camion_valido(p_camion);
  lock table abordajes in share row exclusive mode;

  if (select estado from estado_viaje where id = p_camion for update) = 'EN_CAMINO' then
    raise exception 'Ya se hizo el corte de este viaje. Finalízalo antes de cobrar otro.';
  end if;

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

  select coalesce(sum(monto), 0) into v_monto from historial_viajes where corte_id = v_corte;
  update privado.cortes set total = v_monto where id = v_corte;

  update estado_viaje set estado = 'EN_CAMINO', updated_at = now() where id = p_camion;
  perform privado.log('Chofer', v_chofer, 'corte', jsonb_build_object('camion', p_camion, 'alumnos', v_total,
    'total', v_monto, 'manuales', v_manuales, 'de_pie', v_de_pie));
  return v_total;
end;
$$;

-- ---------------------------------------------------------------------
-- 3. Sin código QR con más de $600 de adeudo
-- ---------------------------------------------------------------------
create or replace function public.alumno_qr(p_token uuid)
returns json language plpgsql security definer set search_path = 'public' as $$
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
      from generate_series(v_ventana, v_ventana + 9) w
    )
  );
end;
$$;

-- ---------------------------------------------------------------------
-- 2. Saldo a favor
-- ---------------------------------------------------------------------
create or replace function public.admin_registrar_pago(p_token uuid, p_id uuid, p_monto numeric, p_nota text default null)
returns json language plpgsql security definer set search_path = 'public' as $$
declare
  v_admin text := _validar_sesion(p_token, array['Admin']);
  v_monto numeric := round(p_monto, 2);
  v_saldo numeric;
  v_matricula text;
  v_nota text := nullif(left(trim(coalesce(p_nota, '')), 200), '');
begin
  select saldo, matricula into v_saldo, v_matricula from alumnos where id = p_id for update;
  if v_matricula is null then
    raise exception 'Alumno no encontrado';
  end if;
  if v_monto is null or v_monto <= 0 or v_monto > 100000 then
    raise exception 'El pago debe estar entre $0.01 y $100,000';
  end if;

  -- Si paga de más, la diferencia queda como saldo a favor (saldo negativo)
  update alumnos set saldo = coalesce(saldo, 0) - v_monto where id = p_id returning saldo into v_saldo;
  insert into privado.pagos (matricula, monto, nota, registrado_por) values (v_matricula, v_monto, v_nota, v_admin);
  perform privado.log('Admin', v_admin, 'pago_registrado',
    jsonb_build_object('matricula', v_matricula, 'monto', v_monto, 'saldo_restante', v_saldo, 'nota', v_nota));
  return json_build_object('saldo', v_saldo);
end;
$$;

create or replace function public.admin_actualizar_saldo(p_token uuid, p_id uuid, p_saldo numeric, p_motivo text default null)
returns void language plpgsql security definer set search_path = 'public' as $$
declare
  v_admin text := _validar_sesion(p_token, array['Admin']);
  v_saldo numeric := round(p_saldo, 2);
  v_antes numeric;
  v_matricula text;
begin
  if v_saldo is null or v_saldo < -100000 or v_saldo > 100000 then
    raise exception 'El saldo debe estar entre -$100,000 (a favor) y $100,000';
  end if;
  select saldo, matricula into v_antes, v_matricula from alumnos where id = p_id for update;
  if v_matricula is null then
    raise exception 'Alumno no encontrado';
  end if;
  update alumnos set saldo = v_saldo where id = p_id;
  perform privado.log('Admin', v_admin, 'saldo_ajustado', jsonb_build_object(
    'matricula', v_matricula, 'antes', v_antes, 'despues', v_saldo,
    'motivo', nullif(left(trim(coalesce(p_motivo, '')), 200), '')));
end;
$$;

-- ---------------------------------------------------------------------
-- 6. Emergencia: el camión se descompuso o no estará disponible
-- ---------------------------------------------------------------------
create or replace function public.chofer_emergencia(p_token uuid, p_camion integer, p_motivo text, p_mensaje text)
returns json language plpgsql security definer set search_path = 'public' as $$
declare
  v_chofer text := _validar_sesion(p_token, array['Chofer']);
  v_extra text := nullif(privado.limpiar_texto(p_mensaje), '');
  v_que text;
  v_texto text;
  v_n int;
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

  insert into avisos (matricula, tipo, mensaje) select matricula, 'emergencia', v_texto from alumnos;
  get diagnostics v_n = row_count;

  -- La administración lo ve en su buzón como falla urgente
  insert into fallas (chofer, chofer_nombre, camion, tipo, gravedad, descripcion)
  values (v_chofer, (select nombre from choferes where licencia = v_chofer), p_camion, 'otro', 'alta',
          format('EMERGENCIA: el camión %s. %s', v_que, coalesce(v_extra, 'Se avisó a todos los alumnos.')));

  perform privado.log('Chofer', v_chofer, 'emergencia', jsonb_build_object('camion', p_camion, 'motivo', p_motivo, 'avisados', v_n));
  perform _senal('fallas');
  return json_build_object('avisados', v_n);
end;
$$;

-- ---------------------------------------------------------------------
-- Informes: adeudo solo de saldos positivos y alumnos de pie por corte
-- ---------------------------------------------------------------------
do $$
declare
  v text;
  f text;
  cambios text[][] := array[
    array['public.admin_reporte_gastos(uuid,date,date)',
          '''adeudo_total'', (select coalesce(sum(saldo), 0) from alumnos)',
          '''adeudo_total'', (select coalesce(sum(saldo), 0) from alumnos where saldo > 0)'],
    array['public.admin_reporte_gastos(uuid,date,date)',
          'count(*) as cortes, sum(c.alumnos) as alumnos, sum(c.total) as total',
          'count(*) as cortes, sum(c.alumnos) as alumnos, sum(c.de_pie) as de_pie, sum(c.total) as total'],
    array['public._reporte_chofer(text,date,date)',
          '''manuales'', c.manuales, ''total'', c.total,',
          '''manuales'', c.manuales, ''de_pie'', c.de_pie, ''total'', c.total,'],
    array['public._reporte_chofer(text,date,date)',
          '''manual'', h.manual)',
          '''manual'', h.manual, ''de_pie'', h.de_pie, ''monto'', h.monto)']
  ];
  i int;
begin
  for i in 1 .. array_length(cambios, 1) loop
    f := cambios[i][1];
    v := pg_get_functiondef(f::regprocedure);
    if position(cambios[i][2] in v) > 0 then
      execute replace(v, cambios[i][2], cambios[i][3]);
    elsif position(cambios[i][3] in v) = 0 then
      raise exception 'La función % cambió; revisa el reemplazo %', f, i;
    end if;
  end loop;
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'chofer_abordar_manual(uuid, integer, text, integer)', 'chofer_mapa_actual(uuid, integer)',
    'chofer_abordajes(uuid, integer)', 'chofer_emergencia(uuid, integer, text, text)'
  ] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
end;
$$;
