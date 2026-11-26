-- Finalizar viaje automático a los 60 minutos del corte (2026-11-26), por si el chofer lo olvida
-- · limpiar_viajes_viejos ya finalizaba solo a las 6 h del corte (con cobro de perdidos de Chinacates): baja a 60 min.
-- · cortes_vencidos (pg_cron cada 10 s) la corre primero, así no depende de que alguien use la app.
do $$
declare
  v_def text := pg_get_functiondef('privado.limpiar_viajes_viejos()'::regprocedure);
  v_de text := 'e.updated_at) < now() - interval ''6 hours''';
begin
  if position(v_de in v_def) = 0 then
    raise exception 'limpiar_viajes_viejos no tiene la forma esperada';
  end if;
  execute replace(v_def, v_de, 'e.updated_at) < now() - interval ''60 minutes''');

  v_def := pg_get_functiondef('privado.cortes_vencidos()'::regprocedure);
  v_de := E'begin\n  for v in';
  if position(v_de in v_def) = 0 then
    raise exception 'cortes_vencidos no tiene la forma esperada';
  end if;
  execute replace(v_def, v_de, E'begin\n  perform privado.limpiar_viajes_viejos();\n  for v in');
end $$;
