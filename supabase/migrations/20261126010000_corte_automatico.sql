-- Corte automático cuando el conteo de salida llega a 0 (2026-11-26)
-- · privado.hacer_corte(camion, chofer, auto) tiene el cuerpo de chofer_hacer_corte (que queda como envoltura).
-- · privado.cortes_vencidos() hace el corte de cada vehículo con el conteo encendido y vencido, a nombre del
--   chofer de la jornada. Si no se puede (nadie subió ni apartó) apaga el conteo y lo deja en bitácora.
-- · pg_cron la corre cada 10 segundos: no depende de que el teléfono del chofer esté abierto.

do $$
declare
  v_def text;
  v_de text := E'CREATE OR REPLACE FUNCTION public.chofer_hacer_corte(p_token uuid, p_camion integer)\n RETURNS integer\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO ''public''\nAS $function$\ndeclare\n  v_chofer text := _validar_sesion(p_token, array[''Chofer'']);';
  v_a text := E'CREATE OR REPLACE FUNCTION privado.hacer_corte(p_camion integer, p_chofer text, p_auto boolean DEFAULT false)\n RETURNS integer\n LANGUAGE plpgsql\n SET search_path TO ''public''\nAS $function$\ndeclare\n  v_chofer text := p_chofer;';
begin
  select pg_get_functiondef('public.chofer_hacer_corte(uuid, integer)'::regprocedure) into v_def;
  if position(v_de in v_def) <> 1 or position('''salida'', case' in v_def) = 0 then
    raise exception 'chofer_hacer_corte no tiene la forma esperada';
  end if;
  v_def := replace(v_def, v_de, v_a);
  v_def := replace(v_def, '''salida'', case', '''automatico'', p_auto, ''salida'', case');
  execute v_def;
end $$;
revoke all on function privado.hacer_corte(integer, text, boolean) from public, anon, authenticated;

create or replace function public.chofer_hacer_corte(p_token uuid, p_camion integer)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_chofer text := _validar_sesion(p_token, array['Chofer']);
begin
  return privado.hacer_corte(p_camion, v_chofer);
end;
$function$;

create or replace function privado.cortes_vencidos()
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v record;
begin
  for v in
    select e.id,
           (select j.chofer from privado.jornadas j
             where j.camion = e.id and j.fecha = (now() at time zone 'America/Mexico_City')::date
             order by j.creada_en desc limit 1) as chofer
    from public.estado_viaje e
    where e.temporizador_activo and e.tiempo_salida <= now() and e.estado <> 'EN_CAMINO'
  loop
    begin
      perform privado.hacer_corte(v.id, coalesce(v.chofer, 'automatico'), true);
    exception when others then
      -- Por ejemplo, nadie subió ni apartó: se apaga el conteo para no reintentar.
      -- Si el chofer hizo el corte a mano en ese instante, no hay nada que apagar ni avisar.
      if (select estado from public.estado_viaje where id = v.id) <> 'EN_CAMINO' then
        update public.estado_viaje set temporizador_activo = false, tiempo_salida = null, updated_at = now() where id = v.id;
        perform privado.log(null, null, 'corte_auto_fallido', jsonb_build_object('camion', v.id, 'motivo', sqlerrm));
      end if;
    end;
  end loop;
end;
$function$;
revoke all on function privado.cortes_vencidos() from public, anon, authenticated;

-- Corrección a 20261126000000_chinacates_tras_corte:
-- · Viaje EN_CAMINO sin registro de corte: no se sube a nadie (no habría a qué corte cobrarle)
do $$
declare
  v_def text := pg_get_functiondef('public._abordar(integer, text, boolean, integer)'::regprocedure);
  v_de text := E'    from privado.cortes where camion = p_camion order by creado_en desc, id desc limit 1;\n  end if;';
begin
  if position(v_de in v_def) = 0 then
    raise exception '_abordar no tiene la forma esperada';
  end if;
  execute replace(v_def, v_de, E'    from privado.cortes where camion = p_camion order by creado_en desc, id desc limit 1;\n    if v_corte_id is null then\n      raise exception ''El corte de este viaje ya se hizo. Finaliza el viaje antes de subir a más alumnos.'';\n    end if;\n  end if;');
end $$;

-- Cada 10 s (en el simulador local no hay pg_cron: ahí se llama a mano).
-- pg_cron guarda cada corrida en cron.job_run_details: se borra lo de más de un día para no llenar la base.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('corte-automatico', '10 seconds', 'select privado.cortes_vencidos()');
    perform cron.schedule('limpiar-cron', '17 4 * * *', $q$delete from cron.job_run_details where end_time < now() - interval '1 day'$q$);
  end if;
end $$;
