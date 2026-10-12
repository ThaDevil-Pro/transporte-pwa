-- Prueba de la migración de endurecimiento. Corre dentro de una transacción
-- que siempre se revierte (lanza una excepción con el resumen al final).
do $$
declare
  r text := '';
  j json;
  t_al uuid; t_ch uuid; t_ad uuid;
  v_codigo text;
  v_id uuid;
  ok boolean;
  i int;
  procedure_error text;
begin
  -- Usuarios de prueba (la contraseña se cifra con el trigger)
  insert into alumnos (nombre, matricula, password, saldo) values ('Prueba Uno', 'ZZTEST01', 'Inicial123', 90) returning id into v_id;
  insert into alumnos (nombre, matricula, password, saldo) values ('Prueba Dos', 'ZZTEST02', 'Inicial123', 0);
  insert into choferes (nombre, licencia, password) values ('Chofer Prueba', 'ZZCHOF01', 'Inicial123');
  insert into admins (usuario, password) values ('zzadmin', 'Inicial123');

  -- 1. Bloqueo tras 5 fallos
  for i in 1..5 loop
    j := login('Estudiante', 'ZZTEST02', 'mala' || i);
  end loop;
  j := login('Estudiante', 'ZZTEST02', 'Inicial123');
  r := r || E'\n' || ('1 bloqueo: ' || coalesce(j::text, 'null'));

  -- 2. Login correcto exige cambio de contraseña
  j := login('Estudiante', 'ZZTEST01', 'Inicial123');
  t_al := (j ->> 'token')::uuid;
  r := r || E'\n' || ('2 login debe_cambiar=' || (j ->> 'debe_cambiar'));
  begin
    perform alumno_perfil(t_al);
    r := r || E'\n' || '2b ERROR: perfil accesible sin cambiar';
  exception when sqlstate 'CMF01' then
    r := r || E'\n' || '2b perfil bloqueado hasta cambiar OK';
  end;
  begin
    perform cambiar_password(t_al, 'Inicial123', '12345678');
    r := r || E'\n' || '2c ERROR: aceptó contraseña débil';
  exception when others then
    r := r || E'\n' || ('2c débil rechazada: ' || sqlerrm);
  end;
  begin
    perform cambiar_password(t_al, 'Inicial123', 'zztest01abc9');
    r := r || E'\n' || '2d ERROR: aceptó contraseña con matrícula';
  exception when others then
    r := r || E'\n' || ('2d con matrícula rechazada: ' || sqlerrm);
  end;
  perform cambiar_password(t_al, 'Inicial123', 'Camionetas42');
  r := r || E'\n' || ('2e perfil tras cambio: ' || (alumno_perfil(t_al) ->> 'matricula'));
  j := login('Estudiante', 'ZZTEST01', 'Camionetas42');
  r := r || E'\n' || ('2f login nuevo debe_cambiar=' || (j ->> 'debe_cambiar'));

  -- 3. QR dinámico
  j := alumno_qr(t_al);
  v_codigo := j -> 'codigos' -> 0 ->> 'codigo';
  r := r || E'\n' || ('3 qr: ' || v_codigo || ' (' || json_array_length(j -> 'codigos') || ' códigos)');

  j := login('Chofer', 'ZZCHOF01', 'Inicial123');
  t_ch := (j ->> 'token')::uuid;
  perform cambiar_password(t_ch, 'Inicial123', 'Volante2026x');
  r := r || E'\n' || ('3b matrícula sola: ' || chofer_registrar_abordaje(t_ch, 1, 'ZZTEST01')::text);
  r := r || E'\n' || ('3c firma falsa: ' || chofer_registrar_abordaje(t_ch, 1, 'CMF1.ZZTEST02.' || privado.qr_ventana() || '.0123456789abcdef0123')::text);
  r := r || E'\n' || ('3d vencido: ' || chofer_registrar_abordaje(t_ch, 1,
              'CMF1.ZZTEST01.' || (privado.qr_ventana() - 5) || '.' || privado.qr_firma('ZZTEST01', privado.qr_ventana() - 5))::text);
  r := r || E'\n' || ('3e válido: ' || chofer_registrar_abordaje(t_ch, 1, v_codigo)::text);
  begin
    perform chofer_registrar_abordaje(t_ch, 1, v_codigo);
    r := r || E'\n' || '3f ERROR: doble abordaje';
  exception when others then
    r := r || E'\n' || ('3f repetido: ' || sqlerrm);
  end;
  -- Limpia la lista real del camión 1 solo dentro de esta prueba
  delete from abordajes where matricula like 'ZZTEST%';

  -- 4. Admin: validaciones, pagos y bitácora
  j := login('Admin', 'zzadmin', 'Inicial123');
  t_ad := (j ->> 'token')::uuid;
  perform cambiar_password(t_ad, 'Inicial123', 'Oficina2026z');
  begin
    perform admin_crear_usuario(t_ad, 'Estudiante', 'Nuevo', 'ZZTEST03', 'abc', 0);
    r := r || E'\n' || '4 ERROR: creó con contraseña débil';
  exception when others then r := r || E'\n' || ('4 crear débil: ' || sqlerrm); end;
  begin
    perform admin_crear_usuario(t_ad, 'Estudiante', '<script>x</script>', 'ZZTEST03', 'Buena12345', 0);
    r := r || E'\n' || '4b ERROR: nombre con etiquetas';
  exception when others then r := r || E'\n' || ('4b nombre: ' || sqlerrm); end;
  perform admin_crear_usuario(t_ad, 'Estudiante', 'Prueba  Tres', 'ZZTEST03', 'Buena12345', 30);
  r := r || E'\n' || ('4c creado: ' || (select nombre || ' / cambiar=' || debe_cambiar_password from alumnos where matricula = 'ZZTEST03'));
  begin
    perform admin_registrar_pago(t_ad, v_id, 1000, null);
    r := r || E'\n' || '4d ERROR: pago mayor al saldo';
  exception when others then r := r || E'\n' || ('4d pago excesivo: ' || sqlerrm); end;
  r := r || E'\n' || ('4e pago: ' || admin_registrar_pago(t_ad, v_id, 60, 'efectivo')::text);
  begin
    perform admin_actualizar_saldo(t_ad, v_id, -5, 'prueba');
    r := r || E'\n' || '4f ERROR: saldo negativo';
  exception when others then r := r || E'\n' || ('4f saldo negativo: ' || sqlerrm); end;
  perform admin_actualizar_saldo(t_ad, v_id, 45, 'corrección de prueba');
  r := r || E'\n' || ('4g historial: ' || (select count(*) from json_array_elements(alumno_historial(t_al)))::text || ' movimientos, tipos ' ||
             (select string_agg(distinct x ->> 'tipo', ',') from json_array_elements(alumno_historial(t_al)) x));
  r := r || E'\n' || ('4h bitácora: ' || (select string_agg(x ->> 'accion', ',') from json_array_elements(admin_bitacora(t_ad, 20)) x));
  -- Reset de contraseña por admin cierra sesión del alumno
  perform admin_editar_usuario(t_ad, 'Estudiante', v_id::text, 'Prueba Uno', 'Reinicio2026');
  begin
    perform alumno_perfil(t_al);
    r := r || E'\n' || '4i ERROR: sesión siguió activa tras reset';
  exception when others then r := r || E'\n' || ('4i tras reset: ' || sqlerrm || ' [' || sqlstate || ']'); end;
  begin
    perform admin_eliminar_usuario(t_ad, 'Admin', (select id::text from admins where usuario = 'zzadmin'));
    r := r || E'\n' || '4j ERROR: se borró a sí mismo';
  exception when others then r := r || E'\n' || ('4j autoborrado: ' || sqlerrm); end;

  -- 5. Permisos de la API
  r := r || E'\n' || ('5 anon _validar_sesion=' || has_function_privilege('anon', 'public._validar_sesion(uuid,text[])', 'execute')
             || ' anon login=' || has_function_privilege('anon', 'public.login(text,text,text)', 'execute')
             || ' anon schema privado=' || has_schema_privilege('anon', 'privado', 'usage')
             || ' anon qr_firma=' || has_function_privilege('anon', 'privado.qr_firma(text,bigint)', 'execute')
             || ' tablas viejas=' || (select count(*) from pg_class where relname in ('usuarios', 'viajes', 'parejas_temp') and relnamespace = 'public'::regnamespace));

  raise exception E'RESULTADOS\n%', r;
end;
$$;
