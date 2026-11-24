-- Versión 1.1 (2026-11-23)
-- 1. El código QR se acepta hasta 12 horas después de generado (antes 1 hora).
-- 2. Las sesiones de choferes y administradores no vencen (antes 7 días y 24 horas).
-- 3. Vans (vehículos tipo minivan): nadie viaja de pie, y cada salida solo se puede apartar
--    cuando el chofer la activa («Activar viaje»), porque no siempre salen.

-- 1. QR: 1,440 ventanas de 30 s = 12 horas
create or replace function public.chofer_registrar_abordaje(p_token uuid, p_camion integer, p_matricula text)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_chofer text := _validar_sesion(p_token, array['Chofer']);
  v_codigo text := trim(coalesce(p_matricula, ''));
  v_partes text[];
  v_matricula text;
  v_ventana bigint;
  v_actual bigint := privado.qr_ventana();
begin
  perform _camion_valido(p_camion);

  v_partes := regexp_match(v_codigo, '^CMF1\.([A-Za-z0-9_-]{1,30})\.([0-9]{1,12})\.([0-9a-f]{20})$');
  if v_partes is null then
    perform privado.log('Chofer', v_chofer, 'qr_rechazado', jsonb_build_object('motivo', 'formato', 'camion', p_camion, 'texto', left(v_codigo, 60)));
    return json_build_object('error', 'Este código no es de CAMIFY. Pide al alumno que abra su código en la app.');
  end if;

  v_matricula := v_partes[1];
  v_ventana := v_partes[2]::bigint;

  if v_partes[3] <> privado.qr_firma(v_matricula, v_ventana) then
    perform privado.log('Chofer', v_chofer, 'qr_rechazado', jsonb_build_object('motivo', 'firma', 'camion', p_camion, 'matricula', v_matricula));
    return json_build_object('error', 'Código falsificado o alterado. No se registró.');
  end if;

  -- 1,440 ventanas de 30 s = 12 horas
  if v_ventana < v_actual - 1440 or v_ventana > v_actual + 1 then
    perform privado.log('Chofer', v_chofer, 'qr_rechazado', jsonb_build_object('motivo', 'vencido', 'camion', p_camion, 'matricula', v_matricula));
    return json_build_object('error', 'Código vencido (dura 12 horas). Pide al alumno que lo vuelva a abrir.');
  end if;

  return _abordar(p_camion, v_matricula, false);
end;
$function$;

-- 2. Sesiones: choferes y administradores se quedan dentro hasta que salgan o se les cambie la contraseña
create or replace function privado.duracion_sesion()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
  new.expira_en := case
    when new.rol in ('Chofer', 'Admin') then 'infinity'::timestamptz
    when new.rol = 'Financiero' then now() + interval '24 hours'
    else now() + interval '7 days'
  end;
  return new;
end;
$function$;

update public.sesiones set expira_en = 'infinity' where rol in ('Chofer', 'Admin') and expira_en > now();

-- 3. Vans: salidas que el chofer activa
create table if not exists privado.viajes_activados (
  fecha date not null,
  hora time not null,
  camion integer not null,
  activado_por text,
  activado_en timestamptz not null default now(),
  primary key (fecha, hora, camion)
);
revoke all on privado.viajes_activados from anon, authenticated;

-- Viajes de van que ya tienen apartados al publicar este cambio: se quedan activos
insert into privado.viajes_activados (fecha, hora, camion, activado_por)
select distinct r.fecha, r.hora, r.camion, 'automático (ya tenía apartados)'
from public.reservas r join public.estado_viaje e on e.id = r.camion and e.tipo = 'minivan'
where r.fecha >= (now() at time zone 'America/Mexico_City')::date
on conflict do nothing;

create or replace function privado.es_van(p_camion integer)
returns boolean
language sql
stable
set search_path to ''
as $$
  select coalesce((select tipo = 'minivan' from public.estado_viaje where id = p_camion), false)
$$;

-- ¿Se puede apartar en esta salida? Los camiones siempre; las vans solo si el chofer activó el viaje
create or replace function privado.salida_activa(p_fecha date, p_hora time, p_camion integer)
returns boolean
language sql
stable
set search_path to ''
as $$
  select not privado.es_van(p_camion)
      or exists (select 1 from privado.viajes_activados v where v.fecha = p_fecha and v.hora = p_hora and v.camion = p_camion)
$$;

create or replace function privado.motivo_salida(p_fecha date, p_hora time, p_camion integer)
returns text
language sql
stable
set search_path to ''
as $$
  select case when not privado.salida_activa(p_fecha, p_hora, p_camion)
    then format('%s todavía no confirma este viaje. Aparecerá para apartar cuando el chofer lo active.', public._camion_nombre(p_camion))
  end
$$;

revoke all on function privado.es_van(integer) from public, anon, authenticated;
revoke all on function privado.salida_activa(date, time, integer) from public, anon, authenticated;
revoke all on function privado.motivo_salida(date, time, integer) from public, anon, authenticated;

-- Apartar, mapa y pedir cambio revisan también que la salida esté activa
do $$
declare
  v_nombre text;
  v_def text;
  v_nuevo text;
begin
  foreach v_nombre in array array['public.alumno_apartar(uuid,date,time without time zone,integer,integer,boolean,boolean)',
                                  'public.alumno_mapa(uuid,date,time without time zone,integer)',
                                  'public.alumno_pedir_cambio(uuid,date,time without time zone,integer,integer)'] loop
    v_def := pg_get_functiondef(v_nombre::regprocedure);
    if position('privado.motivo_salida(' in v_def) > 0 then
      continue;
    end if;
    v_nuevo := replace(v_def, 'privado.motivo_viaje_pendiente(v_yo, p_fecha, p_hora))',
                              'privado.motivo_viaje_pendiente(v_yo, p_fecha, p_hora), privado.motivo_salida(p_fecha, p_hora, p_camion))');
    if v_nuevo = v_def then
      raise exception 'No se encontró dónde agregar la revisión de salida activa en %', v_nombre;
    end if;
    execute v_nuevo;
  end loop;

  -- Lista de salidas del alumno: las vans sin activar no aparecen (salvo que ya tenga asiento ahí)
  v_def := pg_get_functiondef('public.alumno_salidas(uuid)'::regprocedure);
  if position('privado.salida_activa(' in v_def) = 0 then
    v_nuevo := replace(v_def, 'and not coalesce(e.fuera_hasta > _salida_ts(s.fecha, s.hora), false)',
                              'and not coalesce(e.fuera_hasta > _salida_ts(s.fecha, s.hora), false)
        and (m.asiento is not null or privado.salida_activa(s.fecha, s.hora, s.camion))');
    if v_nuevo = v_def then
      raise exception 'No se encontró dónde filtrar las vans sin activar en alumno_salidas';
    end if;
    execute v_nuevo;
  end if;
end $$;

-- La van exclusiva de Chinacates solo obliga a apartar ahí si su viaje está activado
create or replace function privado.exclusiva_con_lugar(p_fecha date, p_tipo text)
returns integer
language sql
stable
set search_path to ''
as $function$
  select s.camion
  from public._salidas_programadas(p_fecha, 1) s
  join public.estado_viaje e on e.id = s.camion and e.activo and e.exclusivo_chinacates
  where s.tipo = p_tipo
    and public._salida_ts(s.fecha, s.hora) > public._ahora()
    and not privado.salida_cerrada(s.fecha, s.hora, s.camion)
    and privado.salida_activa(s.fecha, s.hora, s.camion)
    and (select count(*) from public.reservas r where r.fecha = s.fecha and r.hora = s.hora and r.camion = s.camion)
        < privado.capacidad(s.camion)
  order by s.hora
  limit 1
$function$;

-- Salidas del chofer: dicen si es van y si el viaje está activado
create or replace function public.chofer_salidas(p_token uuid, p_camion integer)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
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
             (select count(*) from reservas r where r.fecha = s.fecha and r.hora = s.hora and r.camion = s.camion)::int as ocupados,
             privado.es_van(s.camion) as van,
             privado.salida_activa(s.fecha, s.hora, s.camion) as activa
      from _salidas_programadas(v_hoy, 8) s
      where s.camion = p_camion and _salida_ts(s.fecha, s.hora) > _ahora() - interval '30 minutes'
      order by _salida_ts(s.fecha, s.hora)
      limit 10
    ) x
  ), '[]'::json);
end;
$function$;

-- Activar o desactivar el viaje de una van
create or replace function public.chofer_activar_viaje(p_token uuid, p_camion integer, p_fecha date, p_hora time without time zone, p_activar boolean)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_chofer text := _validar_sesion(p_token, array['Chofer', 'Admin']);
  v_rol text := (select rol from sesiones where token = p_token);
  v_apartados int;
begin
  perform _camion_valido(p_camion);
  if not privado.es_van(p_camion) then
    raise exception 'Solo las vans se activan por viaje: los camiones siempre aparecen para apartar';
  end if;
  if not exists (select 1 from _salidas_programadas(p_fecha, 1) s where s.camion = p_camion and s.hora = p_hora) then
    raise exception 'Esa salida ya no está en el horario';
  end if;
  if _salida_ts(p_fecha, p_hora) <= _ahora() - interval '3 hours' or privado.salida_cerrada(p_fecha, p_hora, p_camion) then
    raise exception 'Esa salida ya pasó';
  end if;

  if coalesce(p_activar, true) then
    insert into privado.viajes_activados (fecha, hora, camion, activado_por)
    values (p_fecha, p_hora, p_camion, v_chofer)
    on conflict (fecha, hora, camion) do nothing;
  else
    select count(*) into v_apartados from reservas where fecha = p_fecha and hora = p_hora and camion = p_camion;
    if v_apartados > 0 then
      raise exception 'Ya hay % apartado(s) en este viaje. Si la van no va a salir, usa «Emergencia del camión» para avisarles y liberar sus lugares.', v_apartados;
    end if;
    delete from privado.viajes_activados where fecha = p_fecha and hora = p_hora and camion = p_camion;
  end if;

  perform privado.log(v_rol, v_chofer, case when coalesce(p_activar, true) then 'viaje_activado' else 'viaje_desactivado' end,
    jsonb_build_object('camion', p_camion, 'fecha', p_fecha, 'hora', to_char(p_hora, 'HH24:MI')));
  perform _senal('salida:' || p_fecha::text || 'T' || p_hora::text || ':' || p_camion);
  return json_build_object('activa', coalesce(p_activar, true));
end;
$function$;
revoke all on function public.chofer_activar_viaje(uuid, integer, date, time without time zone, boolean) from public;
grant execute on function public.chofer_activar_viaje(uuid, integer, date, time without time zone, boolean) to anon, authenticated;

-- Vans: nadie sube de pie (no caben)
do $$
declare
  v_def text := pg_get_functiondef('public._abordar(integer,text,boolean,integer)'::regprocedure);
  v_nuevo text;
begin
  if position('privado.es_van(p_camion)' in v_def) > 0 then
    return;
  end if;
  v_nuevo := replace(v_def, '    v_de_pie := v_ocupados >= v_cap;',
    '    v_de_pie := v_ocupados >= v_cap;
    -- En una van no se puede viajar de pie
    if v_de_pie and privado.es_van(p_camion) then
      raise exception ''La van va llena: no queda ningún asiento libre y en % no se puede ir de pie.'', _camion_nombre(p_camion);
    end if;');
  if v_nuevo = v_def then
    raise exception 'No se encontró dónde bloquear ir de pie en _abordar';
  end if;
  execute v_nuevo;
end $$;
