-- =====================================================================
-- CAMIFY · Bloqueo de inicio de sesión sin daños colaterales y corte único
--  1. Los fallos se cuentan por cuenta + red, no solo por cuenta o por red,
--     para que nadie pueda dejar fuera a otra persona (ni a toda la escuela,
--     que comparte IP en el wifi) con contraseñas equivocadas a propósito.
--     Un dispositivo que ya entró a una cuenta queda como "conocido" y solo
--     lo frenan sus propios fallos (técnica de cookie de dispositivo de OWASP).
--  2. El corte de un viaje solo se cobra una vez; tras el corte no se sube a
--     más alumnos hasta finalizar el viaje.
--  3. Se eliminan funciones de prueba que quedaron en la base.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Inicio de sesión
--    Claves en privado.login_intentos (cuenta = rol:identificador):
--      ok:<cuenta>:<disp>   dispositivo que ya entró (60 días)
--      dv:<cuenta>:<disp>   fallos desde ese dispositivo   → 10 en 15 min
--      ua:<cuenta>@<ip>     fallos de la cuenta en esa red → 5 en 15 min
--      u:<cuenta>           fallos de la cuenta en total   → 30 en 15 min
--      ip:<ip>              fallos sobre cuentas reales    → 300 en 15 min
--    Un dispositivo conocido solo revisa su clave dv:, así que los bloqueos
--    provocados por otra persona no lo afectan.
-- ---------------------------------------------------------------------
drop function if exists public.login(text, text, text);
create or replace function public.login(p_rol text, p_identificador text, p_password text, p_dispositivo text default null)
returns json language plpgsql security definer set search_path = 'public', 'extensions' as $$
declare
  v_ident text := trim(coalesce(p_identificador, ''));
  v_ip text := coalesce(privado.ip_cliente(), 'desconocida');
  v_cuenta text := coalesce(p_rol, '') || ':' || left(lower(v_ident), 40);
  v_disp text := case
    when p_dispositivo ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then left(encode(extensions.digest(p_dispositivo, 'sha256'), 'hex'), 32)
  end;
  v_clave_dv text := 'dv:' || v_cuenta || ':' || coalesce(v_disp, '');
  v_clave_ua text := 'ua:' || v_cuenta || '@' || v_ip;
  v_clave_u text := 'u:' || v_cuenta;
  v_clave_ip text := 'ip:' || v_ip;
  v_conocido boolean := false;
  v_existe boolean;
  v_bloqueo timestamptz;
  v_perfil json;
  v_ref text;
  v_cambiar boolean;
  v_token uuid;
begin
  delete from sesiones where expira_en < now();
  delete from privado.login_intentos
   where (clave not like 'ok:%' and coalesce(bloqueado_hasta, primer_fallo) < now() - interval '1 day')
      or (clave like 'ok:%' and primer_fallo < now() - interval '60 days');

  if v_disp is not null then
    v_conocido := exists (select 1 from privado.login_intentos where clave = 'ok:' || v_cuenta || ':' || v_disp);
  end if;

  select max(bloqueado_hasta) into v_bloqueo
  from privado.login_intentos
  where bloqueado_hasta > now()
    and clave = any (case when v_conocido then array[v_clave_dv]
                          else array[v_clave_ua, v_clave_u, v_clave_ip] end);

  if v_bloqueo is not null then
    return json_build_object('bloqueado', true,
      'minutos', greatest(1, ceil(extract(epoch from v_bloqueo - now()) / 60))::int);
  end if;

  if octet_length(coalesce(p_password, '')) between 1 and 200 then
    if p_rol = 'Estudiante' then
      select matricula, json_build_object('nombre', nombre, 'matricula', matricula, 'saldo', saldo), debe_cambiar_password
        into v_ref, v_perfil, v_cambiar
      from alumnos where matricula = v_ident and password = crypt(p_password, password);
    elsif p_rol = 'Chofer' then
      select licencia, json_build_object('nombre', nombre, 'licencia', licencia), debe_cambiar_password
        into v_ref, v_perfil, v_cambiar
      from choferes where licencia = v_ident and password = crypt(p_password, password);
    elsif p_rol = 'Admin' then
      select usuario, json_build_object('usuario', usuario), debe_cambiar_password
        into v_ref, v_perfil, v_cambiar
      from admins where usuario = v_ident and password = crypt(p_password, password);
    end if;
  end if;

  if v_ref is null then
    if v_conocido then
      perform privado.registrar_fallo(v_clave_dv, 10);
    else
      perform privado.registrar_fallo(v_clave_ua, 5);
      perform privado.registrar_fallo(v_clave_u, 30);
      -- Solo los fallos sobre cuentas reales cuentan para la red, para que
      -- inventar usuarios no sirva para bloquear a toda una escuela
      v_existe := case p_rol
        when 'Estudiante' then exists (select 1 from alumnos where matricula = v_ident)
        when 'Chofer' then exists (select 1 from choferes where licencia = v_ident)
        when 'Admin' then exists (select 1 from admins where usuario = v_ident)
        else false
      end;
      if v_existe then
        perform privado.registrar_fallo(v_clave_ip, 300);
      end if;
    end if;
    return null;
  end if;

  delete from privado.login_intentos where clave in (v_clave_ua, v_clave_dv);
  if v_disp is not null then
    insert into privado.login_intentos (clave, fallos, primer_fallo)
    values ('ok:' || v_cuenta || ':' || v_disp, 0, now())
    on conflict (clave) do update set fallos = 0, primer_fallo = now(), bloqueado_hasta = null;
  end if;

  insert into sesiones (rol, usuario_ref, debe_cambiar)
  values (p_rol, v_ref, coalesce(v_cambiar, false))
  returning token into v_token;

  return json_build_object('token', v_token, 'perfil', v_perfil, 'debe_cambiar', coalesce(v_cambiar, false));
end;
$$;

-- ---------------------------------------------------------------------
-- 2. Corte único por viaje
-- ---------------------------------------------------------------------
create or replace function public.chofer_hacer_corte(p_token uuid, p_camion integer)
returns integer language plpgsql security definer set search_path = 'public' as $$
declare
  v_chofer text := _validar_sesion(p_token, array['Chofer']);
  v_total integer;
begin
  perform _camion_valido(p_camion);
  lock table abordajes in share row exclusive mode;

  if (select estado from estado_viaje where id = p_camion for update) = 'EN_CAMINO' then
    raise exception 'Ya se hizo el corte de este viaje. Finalízalo antes de cobrar otro.';
  end if;

  select count(*) into v_total from abordajes where camion = p_camion;
  if v_total = 0 then
    raise exception 'No hay estudiantes en la lista de abordaje.';
  end if;

  update alumnos a
     set saldo = coalesce(a.saldo, 0) + 30
    from abordajes b
   where a.matricula = b.matricula and b.camion = p_camion;

  insert into historial_viajes (matricula, monto, fecha_hora, camion)
  select matricula, 30, now(), p_camion from abordajes where camion = p_camion;

  update estado_viaje set estado = 'EN_CAMINO', updated_at = now() where id = p_camion;
  perform privado.log('Chofer', v_chofer, 'corte', jsonb_build_object('camion', p_camion, 'alumnos', v_total, 'total', v_total * 30));
  return v_total;
end;
$$;

-- Tras el corte nadie más sube a la lista: no se le cobraría
create or replace function public.chofer_registrar_abordaje(p_token uuid, p_camion integer, p_matricula text)
returns json language plpgsql security definer set search_path = 'public' as $$
declare
  v_chofer text := _validar_sesion(p_token, array['Chofer']);
  v_codigo text := trim(coalesce(p_matricula, ''));
  v_partes text[];
  v_matricula text;
  v_ventana bigint;
  v_actual bigint := privado.qr_ventana();
  v_nombre text;
  v_otro_camion int;
  v_fecha date;
  v_hora time;
  v_asiento int;
begin
  perform _camion_valido(p_camion);

  v_partes := regexp_match(v_codigo, '^CMF1\.([A-Za-z0-9_-]{1,30})\.([0-9]{1,12})\.([0-9a-f]{20})$');
  if v_partes is null then
    perform privado.log('Chofer', v_chofer, 'qr_rechazado', jsonb_build_object('motivo', 'formato', 'camion', p_camion, 'texto', left(v_codigo, 60)));
    return json_build_object('error', 'Este código no es de CAMIFY. Pide al alumno que abra su código en la app.');
  end if;

  v_matricula := v_partes[1];
  v_ventana := v_partes[2]::bigint;

  if v_partes[3] <> privado.qr_firma(v_matricula, v_ventana) then
    perform privado.log('Chofer', v_chofer, 'qr_rechazado', jsonb_build_object('motivo', 'firma', 'camion', p_camion, 'matricula', v_matricula));
    return json_build_object('error', 'Código falsificado o alterado. No se registró.');
  end if;

  if v_ventana < v_actual - 2 or v_ventana > v_actual + 1 then
    perform privado.log('Chofer', v_chofer, 'qr_rechazado', jsonb_build_object('motivo', 'vencido', 'camion', p_camion, 'matricula', v_matricula));
    return json_build_object('error', 'Código vencido. Pide al alumno que lo vuelva a abrir.');
  end if;

  lock table abordajes in share row exclusive mode;

  if (select estado from estado_viaje where id = p_camion) = 'EN_CAMINO' then
    raise exception 'El corte de este viaje ya se hizo. Finaliza el viaje antes de subir a más alumnos.';
  end if;

  if (select count(*) from abordajes where camion = p_camion) >= 40 then
    raise exception 'Límite alcanzado (Máximo 40 pasajeros)';
  end if;

  select nombre into v_nombre from alumnos where matricula = v_matricula;
  if v_nombre is null then
    raise exception 'Este alumno ya no está registrado';
  end if;

  select camion into v_otro_camion from abordajes where matricula = v_matricula;
  if v_otro_camion = p_camion then
    raise exception 'El alumno (%) ya está a bordo', v_matricula;
  elsif v_otro_camion is not null then
    raise exception 'El alumno (%) ya está a bordo del camión %', v_matricula, v_otro_camion;
  end if;

  insert into abordajes (nombre, matricula, camion) values (v_nombre, v_matricula, p_camion);

  select s.fecha, s.hora into v_fecha, v_hora
  from _salidas_programadas((_ahora() at time zone 'America/Mexico_City')::date - 1, 3) s
  where s.camion = p_camion and _salida_ts(s.fecha, s.hora) > _ahora() - interval '30 minutes'
  order by _salida_ts(s.fecha, s.hora)
  limit 1;

  select asiento into v_asiento from reservas
  where fecha = v_fecha and hora = v_hora and camion = p_camion and matricula = v_matricula;

  return json_build_object('nombre', v_nombre, 'asiento', v_asiento);
end;
$$;

-- ---------------------------------------------------------------------
-- 3. Limpieza
-- ---------------------------------------------------------------------
drop function if exists public.zz_a(text);
drop function if exists public.zz_b(text);
