-- =====================================================================
-- CAMIFY · El regreso incluido se puede apartar aunque deba esos $60
-- Si ese día ya hizo un viaje cobrado sin su regreso (número impar de
-- viajes) y solo debe hasta $60, puede apartar: el regreso no se cobra.
-- =====================================================================
do $$
declare
  f text := 'public.alumno_apartar(uuid,date,time without time zone,integer,integer,boolean)';
  v text := pg_get_functiondef(f::regprocedure);
  a text := '  if coalesce((select saldo from alumnos where matricula = v_yo), 0) > 0 then';
  b text := '  if coalesce((select saldo from alumnos where matricula = v_yo), 0) > 0
     and not (coalesce((select saldo from alumnos where matricula = v_yo), 0) <= 60
              and (select count(*) from historial_viajes where matricula = v_yo
                     and (fecha_hora at time zone ''America/Mexico_City'')::date = p_fecha) % 2 = 1) then';
begin
  if position('<= 60' in v) > 0 then
    return;
  end if;
  if position(a in v) = 0 then
    raise exception 'alumno_apartar cambió';
  end if;
  execute replace(v, a, b);
end;
$$;
