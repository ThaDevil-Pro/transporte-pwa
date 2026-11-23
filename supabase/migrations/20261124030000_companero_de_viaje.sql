-- «Pareja de viaje» ahora se llama «Compañero de viaje» (2026-11-23)
-- Solo cambian los textos que ve el usuario (avisos, errores, títulos de notificación). Los nombres
-- internos (tabla parejas, _pareja_de, modo 'pareja', tipos de aviso) se quedan igual.
-- Se reescriben las funciones vigentes cambiando únicamente esas frases.
do $$
declare
  v_f record;
  v_def text;
  v_nuevo text;
  v_frases text[][] := array[
    ['Pareja de viaje terminada', 'Compañero de viaje terminado'],
    ['%s terminó la pareja de viaje.', '%s dejó de ser tu compañero de viaje.'],
    ['%s no aceptó tu invitación de pareja.', '%s no aceptó ser tu compañero de viaje.'],
    ['opciones para parejas', 'opciones para compañeros de viaje'],
    ['una pareja activa', 'un compañero de viaje activo'],
    ['una pareja de viaje', 'un compañero de viaje'],
    ['pareja de viaje activa', 'compañero de viaje activo'],
    ['pareja de viaje', 'compañero de viaje'],
    ['Tu pareja', 'Tu compañero de viaje'],
    ['tu pareja', 'tu compañero de viaje'],
    ['su pareja', 'su compañero de viaje'],
    ['ya tiene pareja', 'ya tiene compañero de viaje']
  ];
  i int;
begin
  for v_f in
    select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'privado') and p.prokind = 'f'
  loop
    v_def := pg_get_functiondef(v_f.oid);
    v_nuevo := v_def;
    for i in 1 .. array_length(v_frases, 1) loop
      v_nuevo := replace(v_nuevo, v_frases[i][1], v_frases[i][2]);
    end loop;
    if v_nuevo <> v_def then
      execute v_nuevo;
    end if;
  end loop;
end $$;
