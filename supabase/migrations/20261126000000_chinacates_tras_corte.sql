-- Chinacates sube con el corte ya hecho y Finalizar hasta 40 min después del corte (2026-11-26)
-- · El camión hace el corte al salir y después pasa por Chinacates: esos alumnos pueden subir (QR o a mano)
--   con el viaje EN_CAMINO. Se les cobra al momento dentro del mismo corte (historial con su corte_id y
--   el corte suma alumno y monto).
-- · El corte ya no cobra como «apartado perdido» a los de Chinacates que todavía no suben: eso se cobra
--   al finalizar el viaje (a mano o el automático de 6 h), con la misma regla de los 20 minutos.
-- · chofer_finalizar_viaje se rechaza antes de 40 minutos desde el corte.

-- Cobra como perdidos a los de Chinacates que apartaron la salida del último corte y no subieron
create or replace function privado.cobrar_perdidos_chinacates(p_camion integer)
returns void
language plpgsql
set search_path to ''
as $function$
declare
  v_c record;
  v_q record;
  v_cobro numeric;
  v_n int := 0;
begin
  select id, salida_fecha, salida_hora, creado_en into v_c
  from privado.cortes where camion = p_camion order by creado_en desc, id desc limit 1;
  if v_c.salida_fecha is null or v_c.creado_en < public._salida_ts(v_c.salida_fecha, v_c.salida_hora) - interval '20 minutes' then
    return;
  end if;
  for v_q in
    delete from public.reservas r
    where r.fecha = v_c.salida_fecha and r.hora = v_c.salida_hora and r.camion = p_camion
      and not privado.es_prueba(r.matricula)
      and exists (select 1 from public.alumnos a where a.matricula = r.matricula and a.ubicacion = 'chinacates')
      and not exists (select 1 from public.abordajes b where b.matricula = r.matricula)
      and not exists (select 1 from public.historial_viajes h where h.matricula = r.matricula and not h.perdido
                        and h.salida_fecha = v_c.salida_fecha and h.salida_hora = v_c.salida_hora)
    returning r.matricula
  loop
    v_cobro := privado.cobrar_perdido(v_q.matricula, p_camion, v_c.id, v_c.salida_fecha, v_c.salida_hora);
    perform public._avisar(v_q.matricula, 'apartado_perdido', format(
      'Apartaste asiento en la salida del %s (%s) y no subiste. Se te cobró el boleto completo: $%s. Tu siguiente viaje se cobra como nuevo.',
      public._salida_texto(v_c.salida_fecha, v_c.salida_hora), public._camion_nombre(p_camion), to_char(v_cobro, 'FM999,990')));
    v_n := v_n + 1;
  end loop;
  if v_n > 0 then
    update privado.cortes
       set perdidos = coalesce(perdidos, 0) + v_n,
           total = (select coalesce(sum(monto), 0) from public.historial_viajes where corte_id = v_c.id)
     where id = v_c.id;
  end if;
end;
$function$;
revoke all on function privado.cobrar_perdidos_chinacates(integer) from public, anon, authenticated;

create or replace function public._abordar(p_camion integer, p_matricula text, p_manual boolean, p_asiento integer default null::integer)
returns json
language plpgsql
set search_path to 'public'
as $function$
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
  v_cap int := privado.capacidad(p_camion);
  v_corte_id bigint;
  v_corte_fecha date;
  v_corte_hora time;
  v_id bigint;
  v_monto numeric := 0;
begin
  lock table abordajes in share row exclusive mode;
  perform privado.limpiar_viajes_viejos();

  select nombre, saldo, ubicacion into v_nombre, v_saldo, v_ubic from alumnos where matricula = p_matricula;

  if (select estado from estado_viaje where id = p_camion) = 'EN_CAMINO' then
    -- Los de Chinacates suben en el camino, con el corte ya hecho
    if v_nombre is null or v_ubic is distinct from 'chinacates' then
      raise exception 'El corte de este viaje ya se hizo. Finaliza el viaje antes de subir a más alumnos (después del corte solo suben los de Chinacates).';
    end if;
    select id, salida_fecha, salida_hora into v_corte_id, v_corte_fecha, v_corte_hora
    from privado.cortes where camion = p_camion order by creado_en desc, id desc limit 1;
  end if;

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

  if v_corte_id is not null then
    -- Después del corte la salida es la del corte (ya «cerrada» para _salida_actual)
    select s.fecha, s.hora, s.tipo into v_s
    from _salidas_programadas(v_corte_fecha, 1) s
    where s.camion = p_camion and s.hora = v_corte_hora
    limit 1;
  else
    select * into v_s from _salida_actual(p_camion);
  end if;

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
    end if;
    select asiento into v_asiento from reservas
    where fecha = v_s.fecha and hora = v_s.hora and camion = p_camion and matricula = p_matricula;
  end if;

  if v_asiento is null then
    v_de_pie := v_ocupados >= v_cap;
    -- En una van no se puede viajar de pie
    if v_de_pie and privado.es_van(p_camion) then
      raise exception 'La van va llena: no queda ningún asiento libre y en % no se puede ir de pie.', _camion_nombre(p_camion);
    end if;
  else
    v_de_pie := false;
  end if;

  insert into abordajes (nombre, matricula, camion, manual, de_pie, asiento_asignado)
  values (v_nombre, p_matricula, p_camion, p_manual, v_de_pie, v_asignado)
  returning id into v_id;

  -- Subió con el corte hecho: se cobra ya, dentro del mismo corte
  if v_corte_id is not null then
    if not privado.es_prueba(p_matricula) then
      v_monto := privado.cobro_viaje(p_matricula);
      insert into historial_viajes (matricula, monto, fecha_hora, camion, manual, corte_id, de_pie, salida_fecha, salida_hora)
      values (p_matricula, v_monto, now(), p_camion, p_manual, v_corte_id, v_de_pie, v_corte_fecha, v_corte_hora);
      update alumnos set saldo = coalesce(saldo, 0) + v_monto where matricula = p_matricula;
      update privado.cortes
         set alumnos = alumnos + 1, manuales = manuales + p_manual::int, de_pie = coalesce(de_pie, 0) + v_de_pie::int,
             total = total + v_monto
       where id = v_corte_id;
    end if;
    update abordajes set cobrado = v_monto where id = v_id;
  end if;

  return json_build_object('nombre', v_nombre, 'asiento', v_asiento, 'de_pie', v_de_pie, 'asignado', false, 'ubicacion', v_ubic);
end;
$function$;

create or replace function public.chofer_finalizar_viaje(p_token uuid, p_camion integer)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_chofer text := _validar_sesion(p_token, array['Chofer']);
  v_corte timestamptz;
begin
  perform _camion_valido(p_camion);
  lock table abordajes in share row exclusive mode;

  -- Otro teléfono ya lo finalizó: la lista actual es del siguiente viaje
  if coalesce((select estado from estado_viaje where id = p_camion for update), '') <> 'EN_CAMINO' then
    return;
  end if;

  -- Mínimo 40 minutos después del corte (los de Chinacates suben en el camino)
  select max(creado_en) into v_corte from privado.cortes where camion = p_camion;
  if v_corte is not null and now() < v_corte + interval '40 minutes' then
    raise exception 'Podrás finalizar el viaje a partir de las % (40 minutos después del corte).',
      to_char((v_corte + interval '40 minutes') at time zone 'America/Mexico_City', 'FMHH12:MI a.m.');
  end if;

  perform privado.cobrar_perdidos_chinacates(p_camion);
  delete from abordajes where camion = p_camion;
  update estado_viaje
     set estado = 'ESPERANDO', tiempo_salida = null, temporizador_activo = false, updated_at = now()
   where id = p_camion;
  perform privado.log('Chofer', v_chofer, 'viaje_finalizado', jsonb_build_object('camion', p_camion));
end;
$function$;

-- El corte deja pendientes a los de Chinacates; el finalizado automático también los cobra
do $$
declare
  r record;
  v_def text;
begin
  for r in select * from (values
    ('public', 'chofer_hacer_corte',
     'and not exists (select 1 from abordajes b where b.matricula = r.matricula)',
     'and not exists (select 1 from abordajes b where b.matricula = r.matricula)
        and not exists (select 1 from alumnos a where a.matricula = r.matricula and a.ubicacion = ''chinacates'')'),
    ('privado', 'limpiar_viajes_viejos',
     'loop
    delete from public.abordajes where camion = v.id;',
     'loop
    perform privado.cobrar_perdidos_chinacates(v.id);
    delete from public.abordajes where camion = v.id;')
  ) t(esq, fn, de, a) loop
    select pg_get_functiondef(p.oid) into v_def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = r.esq and p.proname = r.fn;
    if position(r.de in v_def) = 0 then
      raise exception 'No encontré el texto a cambiar en %', r.fn;
    end if;
    execute replace(v_def, r.de, r.a);
  end loop;
end $$;
