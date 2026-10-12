-- Prueba de la migración abordaje_manual_e_importacion. Corre dentro de una
-- transacción que siempre se revierte (lanza una excepción con el resumen).
-- Cada línea dice OK o FALLA.
do $$
declare
  r text := '';
  j json;
  t_al uuid; t_ch uuid; t_ad uuid;
  v_codigo text;
  v_lote jsonb := '[]'::jsonb;
  v_t0 timestamptz;
  v_ms int;
  v_pw text;
  i int;
begin
  insert into alumnos (nombre, matricula, password, saldo, debe_cambiar_password) values
    ('José Pérez Núñez', 'ZZTEST01', 'Inicial123', 0, false),
    ('Ana Joselyn Ruiz', 'ZZTEST02', 'Inicial123', 0, false),
    ('Mario 100% Real', 'ZZ_TEST3', 'Inicial123', 0, false);
  insert into choferes (nombre, licencia, password, debe_cambiar_password) values ('Chofer Prueba', 'ZZCHOF01', 'Inicial123', false);
  insert into admins (usuario, password, debe_cambiar_password) values ('zzadmin', 'Inicial123', false);

  perform set_config('request.headers', '{"cf-connecting-ip": "10.9.9.9"}', true);
  t_ch := (login('Chofer', 'ZZCHOF01', 'Inicial123') ->> 'token')::uuid;
  t_al := (login('Estudiante', 'ZZTEST02', 'Inicial123') ->> 'token')::uuid;
  t_ad := (login('Admin', 'zzadmin', 'Inicial123') ->> 'token')::uuid;

  -- 1. Búsqueda (solo se cuentan los alumnos de prueba ZZ…, por si hay reales con el mismo nombre)
  j := chofer_buscar_alumnos(t_ch, 'jose perez');
  r := r || E'\n' || case when (select array_agg(x ->> 'matricula') from json_array_elements(j) x where x ->> 'matricula' like 'ZZ%') = array['ZZTEST01'] then 'OK ' else 'FALLA ' end || '1a nombre sin acentos: ' || j::text;
  j := chofer_buscar_alumnos(t_ch, 'perez jo');
  r := r || E'\n' || case when (select count(*) from json_array_elements(j) x where x ->> 'matricula' like 'ZZ%') = 1 then 'OK ' else 'FALLA ' end || '1b palabras en otro orden';
  j := chofer_buscar_alumnos(t_ch, 'jose');
  r := r || E'\n' || case when (select count(*) from json_array_elements(j) x where x ->> 'matricula' like 'ZZ%') = 2 then 'OK ' else 'FALLA ' end || '1c "jose" encuentra José y Joselyn';
  j := chofer_buscar_alumnos(t_ch, 'zztest0');
  r := r || E'\n' || case when json_array_length(j) = 2 then 'OK ' else 'FALLA ' end || '1d matrícula por inicio';
  j := chofer_buscar_alumnos(t_ch, 'zztest02');
  r := r || E'\n' || case when j -> 0 ->> 'matricula' = 'ZZTEST02' then 'OK ' else 'FALLA ' end || '1e matrícula exacta primero';
  j := chofer_buscar_alumnos(t_ch, 'zz_');
  r := r || E'\n' || case when json_array_length(j) = 1 and j -> 0 ->> 'matricula' = 'ZZ_TEST3' then 'OK ' else 'FALLA ' end || '1f "_" no funciona como comodín';
  j := chofer_buscar_alumnos(t_ch, '%%');
  r := r || E'\n' || case when not exists (select 1 from json_array_elements(j) x where x ->> 'matricula' <> 'ZZ_TEST3') then 'OK ' else 'FALLA ' end || '1g "%" no devuelve a todos';
  j := chofer_buscar_alumnos(t_ch, 'j');
  r := r || E'\n' || case when json_array_length(j) = 0 then 'OK ' else 'FALLA ' end || '1h menos de 2 letras no busca';
  begin
    perform chofer_buscar_alumnos(t_al, 'jose');
    r := r || E'\n' || 'FALLA 1i un alumno pudo buscar';
  exception when others then
    r := r || E'\n' || 'OK 1i un alumno no puede buscar: ' || sqlerrm;
  end;

  -- 2. Abordaje manual (camión 9, que no se usa)
  j := chofer_abordar_manual(t_ch, 9, 'ZZTEST01');
  r := r || E'\n' || case when j ->> 'nombre' = 'José Pérez Núñez' and (select manual from abordajes where matricula = 'ZZTEST01') then 'OK ' else 'FALLA ' end || '2a sube a mano y queda marcado: ' || j::text;
  r := r || E'\n' || case when exists (select 1 from privado.bitacora where accion = 'abordaje_manual' and detalle ->> 'matricula' = 'ZZTEST01') then 'OK ' else 'FALLA ' end || '2b queda en la bitácora';
  j := chofer_buscar_alumnos(t_ch, 'jose perez');
  r := r || E'\n' || case when (select (x ->> 'camion')::int from json_array_elements(j) x where x ->> 'matricula' = 'ZZTEST01') = 9 then 'OK ' else 'FALLA ' end || '2c la búsqueda indica que ya va a bordo';
  begin
    perform chofer_abordar_manual(t_ch, 9, 'ZZTEST01');
    r := r || E'\n' || 'FALLA 2d subió dos veces';
  exception when others then
    r := r || E'\n' || 'OK 2d repetido: ' || sqlerrm;
  end;
  begin
    perform chofer_abordar_manual(t_ch, 9, 'NOEXISTE');
    r := r || E'\n' || 'FALLA 2e subió una matrícula inexistente';
  exception when others then
    r := r || E'\n' || 'OK 2e inexistente: ' || sqlerrm;
  end;

  -- 3. QR sigue funcionando y no queda como manual
  v_codigo := alumno_qr(t_al) -> 'codigos' -> 0 ->> 'codigo';
  j := chofer_registrar_abordaje(t_ch, 9, v_codigo);
  r := r || E'\n' || case when j ->> 'nombre' is not null and not (select manual from abordajes where matricula = 'ZZTEST02') then 'OK ' else 'FALLA ' end || '3 QR registra sin marca manual';

  -- 4. Corte: el historial conserva la marca
  i := chofer_hacer_corte(t_ch, 9);
  r := r || E'\n' || case when i = 2
        and (select manual from historial_viajes where matricula = 'ZZTEST01' order by id desc limit 1)
        and not (select manual from historial_viajes where matricula = 'ZZTEST02' order by id desc limit 1)
      then 'OK ' else 'FALLA ' end || '4a corte cobra a los 2 y copia la marca';
  r := r || E'\n' || case when (alumno_historial(t_al) -> 0 ->> 'manual')::boolean = false then 'OK ' else 'FALLA ' end || '4b historial del alumno trae el campo manual';
  begin
    perform chofer_abordar_manual(t_ch, 9, 'ZZ_TEST3');
    r := r || E'\n' || 'FALLA 4c subió a mano después del corte';
  exception when others then
    r := r || E'\n' || case when sqlerrm like '%corte%' then 'OK ' else 'FALLA ' end || '4c tras el corte: ' || sqlerrm;
  end;

  -- 5. Importación: mezcla de filas buenas y malas
  j := admin_importar_usuarios(t_ad, jsonb_build_array(
    jsonb_build_object('fila', 2, 'nombre', 'Laura Gómez', 'identificador', 'ZZIMP01', 'password', 'Camino2026'),
    jsonb_build_object('fila', 3, 'nombre', 'Pedro Sánchez', 'identificador', 'ZZIMP02', 'saldo', '$1,250.50'),
    jsonb_build_object('fila', 4, 'rol', 'Chofer', 'nombre', 'Chofer Nuevo', 'identificador', 'ZZCHOF02'),
    jsonb_build_object('fila', 5, 'nombre', 'Duplicado', 'identificador', 'ZZTEST01'),
    jsonb_build_object('fila', 6, 'nombre', 'Mal ID', 'identificador', 'a b'),
    jsonb_build_object('fila', 7, 'nombre', 'Débil', 'identificador', 'ZZIMP03', 'password', '123'),
    jsonb_build_object('fila', 8, 'rol', 'Admin', 'nombre', 'Intruso', 'identificador', 'ZZADM2'),
    jsonb_build_object('fila', 9, 'rol', 'Chofer', 'nombre', 'Con saldo', 'identificador', 'ZZCHOF03', 'saldo', '50'),
    jsonb_build_object('fila', 10, 'nombre', '<b>x</b>', 'identificador', 'ZZIMP04'),
    jsonb_build_object('fila', 11, 'nombre', 'Saldo raro', 'identificador', 'ZZIMP05', 'saldo', 'mucho')
  ));
  r := r || E'\n' || case when (select count(*) from json_array_elements(j) x where (x ->> 'ok')::boolean) = 3 then 'OK ' else 'FALLA ' end || '5a crea 3 de 10 filas';
  r := r || E'\n' || case when j -> 0 ->> 'password' is null and j -> 1 ->> 'password' ~ '^[A-Z][a-z]{3}-[0-9]{4}$' then 'OK ' else 'FALLA ' end || '5b genera contraseña solo si falta: ' || coalesce(j -> 1 ->> 'password', 'null');
  r := r || E'\n' || case when (select saldo from alumnos where matricula = 'ZZIMP02') = 1250.50 then 'OK ' else 'FALLA ' end || '5c saldo con $ y comas';
  r := r || E'\n' || case when (select bool_and(debe_cambiar_password) from alumnos where matricula in ('ZZIMP01', 'ZZIMP02')) then 'OK ' else 'FALLA ' end || '5d deberán cambiar contraseña';
  r := r || E'\n' || case when not exists (select 1 from admins where usuario = 'ZZADM2') then 'OK ' else 'FALLA ' end || '5e no se pueden importar admins';
  r := r || E'\n' || '   errores: ' || (select string_agg((x ->> 'fila') || ' ' || (x ->> 'error'), ' | ') from json_array_elements(j) x where not (x ->> 'ok')::boolean);
  v_pw := j -> 1 ->> 'password';
  r := r || E'\n' || case when (login('Estudiante', 'ZZIMP02', v_pw) ->> 'debe_cambiar')::boolean then 'OK ' else 'FALLA ' end || '5f la contraseña generada sirve para entrar';

  -- 6. Lote completo de 15 dentro del límite de tiempo de la API (3 s)
  for i in 1..15 loop
    v_lote := v_lote || jsonb_build_object('fila', i, 'nombre', 'Alumno Lote ' || i, 'identificador', 'ZZLOTE' || i);
  end loop;
  v_t0 := clock_timestamp();
  j := admin_importar_usuarios(t_ad, v_lote);
  v_ms := extract(epoch from clock_timestamp() - v_t0) * 1000;
  r := r || E'\n' || case when (select count(*) from json_array_elements(j) x where (x ->> 'ok')::boolean) = 15 and v_ms < 2500 then 'OK ' else 'FALLA ' end || '6a 15 filas en ' || v_ms || ' ms';
  begin
    perform admin_importar_usuarios(t_ad, v_lote || '[{"nombre": "x", "identificador": "ZZLOTE99"}]'::jsonb);
    r := r || E'\n' || 'FALLA 6b aceptó 16 filas';
  exception when others then
    r := r || E'\n' || 'OK 6b más de 15 filas: ' || sqlerrm;
  end;
  begin
    perform admin_importar_usuarios(t_ch, v_lote);
    r := r || E'\n' || 'FALLA 6c un chofer pudo importar';
  exception when others then
    r := r || E'\n' || 'OK 6c un chofer no puede importar: ' || sqlerrm;
  end;

  -- 7. Permisos de la API
  r := r || E'\n' || case when not has_function_privilege('anon', 'public._abordar(int,text,boolean)', 'execute')
                           and has_function_privilege('anon', 'public.chofer_abordar_manual(uuid,int,text)', 'execute')
                           and has_function_privilege('anon', 'public.chofer_buscar_alumnos(uuid,text)', 'execute')
                           and has_function_privilege('anon', 'public.admin_importar_usuarios(uuid,jsonb)', 'execute')
                      then 'OK ' else 'FALLA ' end || '7 auxiliar oculta y funciones nuevas expuestas';

  raise exception E'RESULTADOS%', r;
end;
$$;
