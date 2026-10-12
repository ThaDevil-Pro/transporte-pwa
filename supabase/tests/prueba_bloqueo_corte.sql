-- Prueba de la migración bloqueo_y_corte. Corre dentro de una transacción
-- que siempre se revierte (lanza una excepción con el resumen al final).
-- Cada línea dice OK o FALLA.
do $$
declare
  r text := '';
  j json;
  t_al uuid; t_ch uuid;
  v_codigo text;
  i int;
  ip int;
  disp_victima constant text := '11111111-2222-4333-8444-555555555555';
  disp_otro constant text := '99999999-8888-4777-8666-555555555555';
  t_tarde uuid;
begin
  -- request.headers simula la red de cada petición, como llega por Supabase
  insert into alumnos (nombre, matricula, password, saldo, debe_cambiar_password) values
    ('Prueba Uno', 'ZZTEST01', 'Inicial123', 0, false),
    ('Prueba Dos', 'ZZTEST02', 'Inicial123', 0, false),
    ('Prueba Tres', 'ZZTEST03', 'Inicial123', 0, false);
  insert into choferes (nombre, licencia, password, debe_cambiar_password) values ('Chofer Prueba', 'ZZCHOF01', 'Inicial123', false);

  -- La víctima entra una vez desde su teléfono en la red de la escuela: su dispositivo queda conocido
  perform set_config('request.headers', '{"cf-connecting-ip": "10.0.0.1"}', true);
  j := login('Estudiante', 'ZZTEST01', 'Inicial123', disp_victima);
  r := r || E'\n' || case when j ->> 'token' is not null then 'OK ' else 'FALLA ' end || '1 víctima entra y registra su dispositivo';

  -- 2. Un compañero en el mismo wifi falla 5 veces con la cuenta de la víctima
  for i in 1..5 loop
    j := login('Estudiante', 'ZZTEST01', 'mala' || i, disp_otro);
  end loop;
  j := login('Estudiante', 'ZZTEST01', 'Inicial123', disp_otro);
  r := r || E'\n' || case when (j ->> 'bloqueado')::boolean then 'OK ' else 'FALLA ' end || '2a el atacante queda bloqueado: ' || coalesce(j::text, 'null');
  j := login('Estudiante', 'ZZTEST01', 'Inicial123', disp_victima);
  r := r || E'\n' || case when j ->> 'token' is not null then 'OK ' else 'FALLA ' end || '2b la víctima sigue entrando desde su teléfono, misma red';

  -- 3. Otra red sin dispositivo conocido no hereda el bloqueo de la red del atacante
  perform set_config('request.headers', '{"cf-connecting-ip": "10.0.0.2"}', true);
  j := login('Estudiante', 'ZZTEST01', 'Inicial123', null);
  r := r || E'\n' || case when j ->> 'token' is not null then 'OK ' else 'FALLA ' end || '3 entra desde otra red y dispositivo nuevo';

  -- 4. Ataque repartido en 6 redes contra ZZTEST02 (30 fallos) → bloqueo global de la cuenta
  for ip in 1..6 loop
    perform set_config('request.headers', json_build_object('cf-connecting-ip', '172.16.0.' || ip)::text, true);
    for i in 1..5 loop
      j := login('Estudiante', 'ZZTEST02', 'mala' || i, null);
    end loop;
  end loop;
  perform set_config('request.headers', '{"cf-connecting-ip": "10.0.0.3"}', true);
  j := login('Estudiante', 'ZZTEST02', 'Inicial123', null);
  r := r || E'\n' || case when (j ->> 'bloqueado')::boolean then 'OK ' else 'FALLA ' end || '4 30 fallos en 6 redes bloquean la cuenta para dispositivos nuevos';

  -- 5. Red bloqueada (300 fallos sobre cuentas reales): los dispositivos conocidos siguen entrando
  perform set_config('request.headers', '{"cf-connecting-ip": "10.0.0.9"}', true);
  insert into privado.login_intentos (clave, fallos, primer_fallo) values ('ip:10.0.0.9', 299, now());
  j := login('Estudiante', 'ZZTEST03', 'mala', null);
  j := login('Estudiante', 'ZZTEST03', 'Inicial123', null);
  r := r || E'\n' || case when (j ->> 'bloqueado')::boolean then 'OK ' else 'FALLA ' end || '5a el fallo 300 bloquea la red para dispositivos nuevos';
  j := login('Estudiante', 'ZZTEST01', 'Inicial123', disp_victima);
  r := r || E'\n' || case when j ->> 'token' is not null then 'OK ' else 'FALLA ' end || '5b dispositivo conocido entra aunque la red esté bloqueada';

  -- 6. Usuarios inventados no cuentan para la red
  perform set_config('request.headers', '{"cf-connecting-ip": "10.0.0.10"}', true);
  for i in 1..3 loop
    j := login('Estudiante', 'NOEXISTE' || i, 'mala', null);
  end loop;
  r := r || E'\n' || case when not exists (select 1 from privado.login_intentos where clave = 'ip:10.0.0.10') then 'OK ' else 'FALLA ' end || '6 usuarios inventados no suman a la red';

  -- 7. El dispositivo conocido tiene su propio límite (10 fallos)
  perform set_config('request.headers', '{"cf-connecting-ip": "10.0.0.1"}', true);
  for i in 1..10 loop
    j := login('Estudiante', 'ZZTEST01', 'mala' || i, disp_victima);
  end loop;
  j := login('Estudiante', 'ZZTEST01', 'Inicial123', disp_victima);
  r := r || E'\n' || case when (j ->> 'bloqueado')::boolean then 'OK ' else 'FALLA ' end || '7 10 fallos desde el dispositivo conocido lo bloquean';

  -- 8. Compatibilidad: la app anterior llama sin p_dispositivo
  perform set_config('request.headers', '{"cf-connecting-ip": "10.0.0.20"}', true);
  j := login('Chofer', 'ZZCHOF01', 'Inicial123');
  t_ch := (j ->> 'token')::uuid;
  r := r || E'\n' || case when t_ch is not null then 'OK ' else 'FALLA ' end || '8 login sin dispositivo (versión anterior de la app)';

  -- 9. Corte único (camión 9, que no se usa)
  perform set_config('request.headers', '{"cf-connecting-ip": "10.0.0.21"}', true);
  t_al := (login('Estudiante', 'ZZTEST03', 'Inicial123', null) ->> 'token')::uuid;
  t_tarde := (login('Estudiante', 'ZZTEST01', 'Inicial123', null) ->> 'token')::uuid;
  v_codigo := alumno_qr(t_al) -> 'codigos' -> 0 ->> 'codigo';
  j := chofer_registrar_abordaje(t_ch, 9, v_codigo);
  r := r || E'\n' || case when j ->> 'nombre' is not null then 'OK ' else 'FALLA ' end || '9a abordaje antes del corte: ' || j::text;
  i := chofer_hacer_corte(t_ch, 9);
  r := r || E'\n' || case when i = 1 and (select saldo from alumnos where matricula = 'ZZTEST03') = 30 then 'OK ' else 'FALLA ' end || '9b primer corte cobra $30';
  begin
    perform chofer_hacer_corte(t_ch, 9);
    r := r || E'\n' || 'FALLA 9c se permitió un segundo corte';
  exception when others then
    r := r || E'\n' || case when sqlerrm like '%corte%' then 'OK ' else 'FALLA ' end || '9c segundo corte rechazado: ' || sqlerrm;
  end;
  r := r || E'\n' || case when (select saldo from alumnos where matricula = 'ZZTEST03') = 30 then 'OK ' else 'FALLA ' end || '9d el saldo sigue en $30';
  v_codigo := alumno_qr(t_tarde) -> 'codigos' -> 0 ->> 'codigo';
  begin
    perform chofer_registrar_abordaje(t_ch, 9, v_codigo);
    r := r || E'\n' || 'FALLA 9e subió alguien después del corte';
  exception when others then
    r := r || E'\n' || case when sqlerrm like '%corte%' then 'OK ' else 'FALLA ' end || '9e abordaje tras el corte rechazado: ' || sqlerrm;
  end;
  v_codigo := alumno_qr(t_al) -> 'codigos' -> 0 ->> 'codigo';
  perform chofer_finalizar_viaje(t_ch, 9);
  j := chofer_registrar_abordaje(t_ch, 9, v_codigo);
  i := chofer_hacer_corte(t_ch, 9);
  r := r || E'\n' || case when (select saldo from alumnos where matricula = 'ZZTEST03') = 60 then 'OK ' else 'FALLA ' end || '9f tras finalizar, el siguiente viaje se cobra normal';

  -- 10. Limpieza y permisos
  r := r || E'\n' || case when not exists (select 1 from pg_proc where proname in ('zz_a', 'zz_b') and pronamespace = 'public'::regnamespace) then 'OK ' else 'FALLA ' end || '10a funciones zz_a/zz_b eliminadas';
  r := r || E'\n' || case when has_function_privilege('anon', 'public.login(text,text,text,text)', 'execute')
                           and not exists (select 1 from pg_proc where proname = 'login' and pronamespace = 'public'::regnamespace and pronargs = 3)
                      then 'OK ' else 'FALLA ' end || '10b login nuevo expuesto y el viejo eliminado';

  raise exception E'RESULTADOS%', r;
end;
$$;
