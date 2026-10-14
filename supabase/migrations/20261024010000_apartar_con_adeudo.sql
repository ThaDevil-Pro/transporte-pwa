-- =====================================================================
-- CAMIFY · Con más de $600 de adeudo tampoco se aparta asiento
-- (el lugar quedaría ocupado por alguien que no puede subir y haría que
-- otros fueran de pie)
-- =====================================================================
do $$
declare
  f text := 'public.alumno_apartar(uuid,date,time without time zone,integer,integer,boolean)';
  v text := pg_get_functiondef(f::regprocedure);
  a text := 'begin
  perform pg_advisory_xact_lock(';
  b text := 'begin
  if (select saldo from alumnos where matricula = v_yo) > 600 then
    raise exception ''Debes más de $600. Paga en la administración para poder apartar asiento.'';
  end if;
  perform pg_advisory_xact_lock(';
begin
  if position('Paga en la administración para poder apartar' in v) > 0 then
    return;
  end if;
  if position(a in v) = 0 then
    raise exception 'alumno_apartar cambió';
  end if;
  execute replace(v, a, b);
end;
$$;
