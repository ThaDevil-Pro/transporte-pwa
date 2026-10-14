-- =====================================================================
-- CAMIFY · Apartar al corriente y asientos libres al salir
--  1. Para apartar asiento hay que estar al corriente (saldo de $0 o a
--     favor). Subir sin apartar sigue permitido hasta $600 de adeudo.
--  2. Al hacer el corte (el camión sale), los asientos apartados de quien
--     no llegó quedan libres: los que iban de pie se sientan y solo
--     cuentan de pie los que de verdad no caben (más de 40).
-- =====================================================================
do $$
declare
  f text := 'public.alumno_apartar(uuid,date,time without time zone,integer,integer,boolean)';
  v text := pg_get_functiondef(f::regprocedure);
  a text := '  if (select saldo from alumnos where matricula = v_yo) > 600 then
    raise exception ''Debes más de $600. Paga en la administración para poder apartar asiento.'';
  end if;';
  b text := '  if coalesce((select saldo from alumnos where matricula = v_yo), 0) > 0 then
    raise exception ''Para apartar asiento debes estar al corriente: debes $%. Paga en la administración.'',
      to_char((select saldo from alumnos where matricula = v_yo), ''FM999,990.00'');
  end if;';
begin
  if position(a in v) > 0 then
    execute replace(v, a, b);
  elsif position('debes estar al corriente' in v) = 0 then
    raise exception 'alumno_apartar cambió';
  end if;
end;
$$;

do $$
declare
  f text := 'public.chofer_hacer_corte(uuid,integer)';
  v text := pg_get_functiondef(f::regprocedure);
  a text := '  select count(*), count(*) filter (where manual), count(*) filter (where de_pie)';
  b text := '  -- Al salir, los asientos apartados de quien no llegó quedan libres: de pie solo quedan
  -- los que pasan de 40 (los últimos en subir)
  update abordajes set de_pie = false
  where camion = p_camion and de_pie
    and id not in (
      select id from abordajes where camion = p_camion and de_pie
      order by created_at desc, id desc
      limit greatest(0, (select count(*) from abordajes where camion = p_camion) - 40)
    );

  select count(*), count(*) filter (where manual), count(*) filter (where de_pie)';
begin
  if position('los asientos apartados de quien no llegó' in v) > 0 then
    return;
  end if;
  if position(a in v) = 0 then
    raise exception 'chofer_hacer_corte cambió';
  end if;
  execute replace(v, a, b);
end;
$$;
