-- =====================================================================
-- CAMIFY · Endurecimiento antes del lanzamiento
--  1. QR dinámico firmado (no se puede falsificar con la matrícula)
--  2. Bloqueo por intentos fallidos de inicio de sesión
--  3. Política de contraseñas, cambio obligatorio y cierre de sesiones
--  4. Bitácora de acciones y registro de pagos
--  5. Validaciones del lado del servidor
--  6. Limpieza de tablas heredadas, índices y permisos
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. Esquema privado: no se expone por la API (solo lo usan las funciones)
-- ---------------------------------------------------------------------
create schema if not exists privado;
revoke all on schema privado from public, anon, authenticated;

create table if not exists privado.secretos (
  nombre text primary key,
  valor bytea not null
);
insert into privado.secretos (nombre, valor)
values ('qr', extensions.gen_random_bytes(32))
on conflict (nombre) do nothing;

create table if not exists privado.login_intentos (
  clave text primary key,
  fallos int not null default 0,
  primer_fallo timestamptz not null default now(),
  bloqueado_hasta timestamptz
);

create table if not exists privado.bitacora (
  id bigint generated always as identity primary key,
  creado_en timestamptz not null default now(),
  actor_rol text,
  actor text,
  accion text not null,
  detalle jsonb not null default '{}'::jsonb
);
create index if not exists bitacora_creado_idx on privado.bitacora (creado_en desc);

create table if not exists privado.pagos (
  id bigint generated always as identity primary key,
  matricula text not null references public.alumnos (matricula) on update cascade on delete cascade,
  monto numeric(10, 2) not null check (monto > 0),
  nota text,
  registrado_por text not null,
  creado_en timestamptz not null default now()
);
create index if not exists pagos_matricula_idx on privado.pagos (matricula, creado_en desc);

revoke all on all tables in schema privado from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 1. Auxiliares privadas
-- ---------------------------------------------------------------------
create or replace function privado.log(p_rol text, p_actor text, p_accion text, p_detalle jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into privado.bitacora (actor_rol, actor, accion, detalle)
  values (p_rol, p_actor, p_accion, coalesce(p_detalle, '{}'::jsonb));
$$;

create or replace function privado.ip_cliente()
returns text language plpgsql stable set search_path = '' as $$
declare
  h json;
begin
  begin
    h := nullif(current_setting('request.headers', true), '')::json;
  exception when others then
    h := null;
  end;
  return nullif(trim(coalesce(h ->> 'cf-connecting-ip', split_part(h ->> 'x-forwarded-for', ',', 1), h ->> 'x-real-ip', '')), '');
end;
$$;

create or replace function privado.hash(p_password text)
returns text language sql volatile set search_path = '' as $$
  select extensions.crypt(p_password, extensions.gen_salt('bf', 10));
$$;

-- Reglas de contraseña: 8 a 72 bytes, letras y números, que no contenga el usuario y que no sea común
create or replace function privado.validar_password(p_password text, p_identificador text)
returns void language plpgsql immutable set search_path = '' as $$
begin
  if p_password is null or char_length(p_password) < 8 then
    raise exception 'La contraseña debe tener al menos 8 caracteres';
  end if;
  if octet_length(p_password) > 72 then
    raise exception 'La contraseña es demasiado larga (máximo 72 caracteres)';
  end if;
  if p_password !~ '[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]' or p_password !~ '[0-9]' then
    raise exception 'La contraseña debe combinar letras y números';
  end if;
  if coalesce(trim(p_identificador), '') <> '' and position(lower(trim(p_identificador)) in lower(p_password)) > 0 then
    raise exception 'La contraseña no puede contener tu usuario o matrícula';
  end if;
  if lower(p_password) in ('12345678', '123456789', '1234567890', 'password1', 'password123', 'contraseña1',
                           'contrasena1', 'qwerty123', 'abc12345', 'camify123', 'camify2026', 'escuela123',
                           'camion123', 'a1234567', 'abcd1234', '11111111a', 'admin123', 'chofer123') then
    raise exception 'Esa contraseña es muy común, elige otra';
  end if;
end;
$$;

create or replace function privado.validar_identificador(p_valor text)
returns text language plpgsql immutable set search_path = '' as $$
declare
  v text := trim(coalesce(p_valor, ''));
begin
  if v !~ '^[A-Za-z0-9_-]{3,30}$' then
    raise exception 'El usuario, matrícula o licencia debe tener de 3 a 30 caracteres: letras, números, guion o guion bajo';
  end if;
  return v;
end;
$$;

create or replace function privado.validar_nombre(p_valor text)
returns text language plpgsql immutable set search_path = '' as $$
declare
  v text := regexp_replace(trim(coalesce(p_valor, '')), '\s+', ' ', 'g');
begin
  if char_length(v) < 2 or char_length(v) > 80 then
    raise exception 'El nombre debe tener entre 2 y 80 caracteres';
  end if;
  if v ~ '[<>{}\x00-\x1F]' then
    raise exception 'El nombre contiene caracteres no permitidos';
  end if;
  return v;
end;
$$;

-- Suma un intento fallido; al llegar al límite bloquea 15 minutos
create or replace function privado.registrar_fallo(p_clave text, p_limite int)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_fallos int;
begin
  insert into privado.login_intentos as li (clave, fallos, primer_fallo)
  values (p_clave, 1, now())
  on conflict (clave) do update set
    fallos = case when li.primer_fallo < now() - interval '15 minutes' then 1 else li.fallos + 1 end,
    primer_fallo = case when li.primer_fallo < now() - interval '15 minutes' then now() else li.primer_fallo end
  returning fallos into v_fallos;

  if v_fallos >= p_limite then
    update privado.login_intentos
       set bloqueado_hasta = now() + interval '15 minutes', fallos = 0, primer_fallo = now()
     where clave = p_clave;
    perform privado.log(null, null, 'login_bloqueado', jsonb_build_object('clave', p_clave, 'ip', privado.ip_cliente()));
  end if;
end;
$$;

-- Firma del QR: HMAC-SHA256(matrícula.ventana) con un secreto que nunca sale de la base de datos
create or replace function privado.qr_firma(p_matricula text, p_ventana bigint)
returns text language sql stable security definer set search_path = '' as $$
  select substr(encode(extensions.hmac(
    convert_to(p_matricula || '.' || p_ventana::text, 'UTF8'),
    (select valor from privado.secretos where nombre = 'qr'),
    'sha256'), 'hex'), 1, 20);
$$;

create or replace function privado.qr_ventana()
returns bigint language sql stable set search_path = '' as $$
  select floor(extract(epoch from now()) / 30)::bigint;
$$;

revoke all on all functions in schema privado from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. Contraseñas: bcrypt más fuerte y cambio obligatorio
-- ---------------------------------------------------------------------
create or replace function public._hash_password()
returns trigger language plpgsql set search_path = 'public', 'extensions' as $$
begin
  if new.password is not null and new.password !~ '^\$2[abxy]\$' then
    new.password := extensions.crypt(new.password, extensions.gen_salt('bf', 10));
  end if;
  return new;
end;
$$;

alter table public.alumnos  add column if not exists debe_cambiar_password boolean not null default true;
alter table public.choferes add column if not exists debe_cambiar_password boolean not null default true;
alter table public.admins   add column if not exists debe_cambiar_password boolean not null default true;
alter table public.sesiones add column if not exists debe_cambiar boolean not null default false;

create or replace function public._validar_sesion(p_token uuid, p_roles text[])
returns text language plpgsql security definer set search_path = 'public' as $$
declare
  v_ref text;
  v_cambiar boolean;
begin
  select usuario_ref, debe_cambiar into v_ref, v_cambiar
  from sesiones
  where token = p_token and rol = any (p_roles) and expira_en > now();

  if v_ref is null then
    raise exception 'Sesión inválida o expirada' using errcode = '28000';
  end if;
  if v_cambiar then
    raise exception 'Debes cambiar tu contraseña para continuar' using errcode = 'CMF01';
  end if;
  return v_ref;
end;
$$;

-- ---------------------------------------------------------------------
-- 3. Inicio de sesión con bloqueo por intentos
--    5 fallos por cuenta o 100 por red en 15 min → 15 min de bloqueo.
--    No usa excepciones para que el conteo de fallos sí se guarde.
-- ---------------------------------------------------------------------
create or replace function public.login(p_rol text, p_identificador text, p_password text)
returns json language plpgsql security definer set search_path = 'public', 'extensions' as $$
declare
  v_ident text := trim(coalesce(p_identificador, ''));
  v_clave text := 'u:' || coalesce(p_rol, '') || ':' || lower(v_ident);
  v_clave_ip text := 'ip:' || coalesce(privado.ip_cliente(), 'desconocida');
  v_bloqueo timestamptz;
  v_perfil json;
  v_ref text;
  v_cambiar boolean;
  v_token uuid;
begin
  delete from sesiones where expira_en < now();
  delete from privado.login_intentos
   where coalesce(bloqueado_hasta, primer_fallo) < now() - interval '1 day';

  select max(bloqueado_hasta) into v_bloqueo
  from privado.login_intentos
  where clave in (v_clave, v_clave_ip) and bloqueado_hasta > now();

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
    perform privado.registrar_fallo(v_clave, 5);
    perform privado.registrar_fallo(v_clave_ip, 100);
    return null;
  end if;

  delete from privado.login_intentos where clave = v_clave;
  insert into sesiones (rol, usuario_ref, debe_cambiar)
  values (p_rol, v_ref, coalesce(v_cambiar, false))
  returning token into v_token;

  return json_build_object('token', v_token, 'perfil', v_perfil, 'debe_cambiar', coalesce(v_cambiar, false));
end;
$$;

-- Cambio de contraseña del propio usuario (cualquier rol)
create or replace function public.cambiar_password(p_token uuid, p_actual text, p_nueva text)
returns void language plpgsql security definer set search_path = 'public', 'extensions' as $$
declare
  v_rol text;
  v_ref text;
  v_hash text;
begin
  select rol, usuario_ref into v_rol, v_ref
  from sesiones where token = p_token and expira_en > now();
  if v_ref is null then
    raise exception 'Sesión inválida o expirada' using errcode = '28000';
  end if;

  if v_rol = 'Estudiante' then select password into v_hash from alumnos where matricula = v_ref;
  elsif v_rol = 'Chofer' then select password into v_hash from choferes where licencia = v_ref;
  else select password into v_hash from admins where usuario = v_ref;
  end if;

  if v_hash is null or v_hash <> crypt(coalesce(p_actual, ''), v_hash) then
    raise exception 'La contraseña actual no es correcta';
  end if;
  if p_nueva = p_actual then
    raise exception 'La nueva contraseña debe ser diferente a la actual';
  end if;
  perform privado.validar_password(p_nueva, v_ref);

  if v_rol = 'Estudiante' then
    update alumnos set password = privado.hash(p_nueva), debe_cambiar_password = false where matricula = v_ref;
  elsif v_rol = 'Chofer' then
    update choferes set password = privado.hash(p_nueva), debe_cambiar_password = false where licencia = v_ref;
  else
    update admins set password = privado.hash(p_nueva), debe_cambiar_password = false where usuario = v_ref;
  end if;

  -- Cierra las demás sesiones abiertas y libera esta
  delete from sesiones where rol = v_rol and usuario_ref = v_ref and token <> p_token;
  update sesiones set debe_cambiar = false where token = p_token;
  perform privado.log(v_rol, v_ref, 'cambio_password', '{}'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------
-- 4. QR dinámico
-- ---------------------------------------------------------------------
-- Devuelve los códigos de la ventana actual y las siguientes (5 min),
-- para que una caída breve de señal no impida subir al camión.
create or replace function public.alumno_qr(p_token uuid)
returns json language plpgsql security definer set search_path = 'public' as $$
declare
  v_yo text := _validar_sesion(p_token, array['Estudiante']);
  v_ventana bigint := privado.qr_ventana();
begin
  return json_build_object(
    'ahora', floor(extract(epoch from now()) * 1000)::bigint,
    'periodo', 30,
    'codigos', (
      select json_agg(json_build_object('v', w, 'codigo', 'CMF1.' || v_yo || '.' || w || '.' || privado.qr_firma(v_yo, w)) order by w)
      from generate_series(v_ventana, v_ventana + 9) w
    )
  );
end;
$$;

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
-- 5. Chofer: bitácora en acciones que mueven dinero o la lista
-- ---------------------------------------------------------------------
create or replace function public.chofer_hacer_corte(p_token uuid, p_camion integer)
returns integer language plpgsql security definer set search_path = 'public' as $$
declare
  v_chofer text := _validar_sesion(p_token, array['Chofer']);
  v_total integer;
begin
  perform _camion_valido(p_camion);
  lock table abordajes in share row exclusive mode;

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

create or replace function public.chofer_finalizar_viaje(p_token uuid, p_camion integer)
returns void language plpgsql security definer set search_path = 'public' as $$
declare
  v_chofer text := _validar_sesion(p_token, array['Chofer']);
begin
  perform _camion_valido(p_camion);
  delete from abordajes where camion = p_camion;
  update estado_viaje set estado = 'ESPERANDO', updated_at = now() where id = p_camion;
  perform privado.log('Chofer', v_chofer, 'viaje_finalizado', jsonb_build_object('camion', p_camion));
end;
$$;

create or replace function public.chofer_vaciar_abordajes(p_token uuid, p_camion integer)
returns void language plpgsql security definer set search_path = 'public' as $$
declare
  v_chofer text := _validar_sesion(p_token, array['Chofer']);
  v_n int;
begin
  perform _camion_valido(p_camion);
  delete from abordajes where camion = p_camion;
  get diagnostics v_n = row_count;
  perform privado.log('Chofer', v_chofer, 'lista_vaciada', jsonb_build_object('camion', p_camion, 'alumnos', v_n));
end;
$$;

create or replace function public.chofer_quitar_abordaje(p_token uuid, p_id bigint)
returns void language plpgsql security definer set search_path = 'public' as $$
declare
  v_chofer text := _validar_sesion(p_token, array['Chofer']);
  v_fila abordajes%rowtype;
begin
  delete from abordajes where id = p_id returning * into v_fila;
  if v_fila.id is not null then
    perform privado.log('Chofer', v_chofer, 'alumno_quitado', jsonb_build_object('camion', v_fila.camion, 'matricula', v_fila.matricula));
  end if;
end;
$$;

create or replace function public.chofer_horario_actualizar(p_token uuid, p_id bigint, p_dia text, p_valor jsonb)
returns void language plpgsql security definer set search_path = 'public' as $$
declare
  v_hora text := coalesce(p_valor ->> 'hora', '');
  v_tipo text := coalesce(nullif(p_valor ->> 'tipo', ''), 'IDA');
begin
  perform _validar_sesion(p_token, array['Chofer']);

  if p_dia not in ('lunes', 'martes', 'miercoles', 'jueves', 'viernes') then
    raise exception 'Día inválido';
  end if;
  if v_hora <> '' and v_hora !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
    raise exception 'Hora inválida';
  end if;
  if v_tipo not in ('IDA', 'REGRESO') then
    raise exception 'Tipo de salida inválido';
  end if;

  execute format('update horarios_matriz set %I = $1 where id = $2', p_dia)
  using jsonb_build_object('hora', v_hora, 'tipo', v_tipo), p_id;
end;
$$;

-- ---------------------------------------------------------------------
-- 6. Administración: validaciones, sesiones y bitácora
-- ---------------------------------------------------------------------
create or replace function public.admin_crear_usuario(p_token uuid, p_rol text, p_nombre text, p_identificador text, p_password text, p_saldo numeric default 0)
returns void language plpgsql security definer set search_path = 'public' as $$
declare
  v_admin text := _validar_sesion(p_token, array['Admin']);
  v_ident text := privado.validar_identificador(p_identificador);
  v_nombre text;
  v_saldo numeric := round(coalesce(p_saldo, 0), 2);
begin
  if p_rol not in ('Estudiante', 'Chofer', 'Admin') then
    raise exception 'Rol inválido';
  end if;
  if p_rol <> 'Admin' then
    v_nombre := privado.validar_nombre(p_nombre);
  end if;
  perform privado.validar_password(p_password, v_ident);
  if v_saldo < 0 or v_saldo > 100000 then
    raise exception 'El saldo inicial debe estar entre $0 y $100,000';
  end if;

  if p_rol = 'Estudiante' then
    insert into alumnos (nombre, matricula, password, saldo, debe_cambiar_password)
    values (v_nombre, v_ident, privado.hash(p_password), v_saldo, true);
  elsif p_rol = 'Chofer' then
    insert into choferes (nombre, licencia, password, debe_cambiar_password)
    values (v_nombre, v_ident, privado.hash(p_password), true);
  else
    insert into admins (usuario, password, debe_cambiar_password)
    values (v_ident, privado.hash(p_password), true);
  end if;

  perform privado.log('Admin', v_admin, 'usuario_creado',
    jsonb_build_object('rol', p_rol, 'identificador', v_ident, 'nombre', v_nombre, 'saldo_inicial', v_saldo));
end;
$$;

create or replace function public.admin_editar_usuario(p_token uuid, p_rol text, p_id text, p_nombre text, p_password text default null)
returns void language plpgsql security definer set search_path = 'public' as $$
declare
  v_admin text := _validar_sesion(p_token, array['Admin']);
  v_ref text;
  v_nuevo text;
  v_cambia_pw boolean := coalesce(p_password, '') <> '';
begin
  if p_rol = 'Estudiante' then
    select matricula into v_ref from alumnos where id = p_id::uuid;
    if v_ref is null then raise exception 'Usuario no encontrado'; end if;
    v_nuevo := privado.validar_nombre(p_nombre);
    update alumnos set nombre = v_nuevo where id = p_id::uuid;
    if v_cambia_pw then
      perform privado.validar_password(p_password, v_ref);
      update alumnos set password = privado.hash(p_password), debe_cambiar_password = true where id = p_id::uuid;
    end if;
  elsif p_rol = 'Chofer' then
    select licencia into v_ref from choferes where id = p_id::bigint;
    if v_ref is null then raise exception 'Usuario no encontrado'; end if;
    v_nuevo := privado.validar_nombre(p_nombre);
    update choferes set nombre = v_nuevo where id = p_id::bigint;
    if v_cambia_pw then
      perform privado.validar_password(p_password, v_ref);
      update choferes set password = privado.hash(p_password), debe_cambiar_password = true where id = p_id::bigint;
    end if;
  elsif p_rol = 'Admin' then
    select usuario into v_ref from admins where id = p_id::bigint;
    if v_ref is null then raise exception 'Usuario no encontrado'; end if;
    -- Los usuarios ya existentes conservan su nombre aunque no siga la regla nueva
    v_nuevo := case when trim(coalesce(p_nombre, '')) = v_ref then v_ref else privado.validar_identificador(p_nombre) end;
    if v_nuevo <> v_ref then
      update admins set usuario = v_nuevo where id = p_id::bigint;
      update sesiones set usuario_ref = v_nuevo where rol = 'Admin' and usuario_ref = v_ref;
    end if;
    if v_cambia_pw then
      perform privado.validar_password(p_password, v_nuevo);
      update admins set password = privado.hash(p_password), debe_cambiar_password = true where id = p_id::bigint;
    end if;
    v_ref := v_nuevo;
  else
    raise exception 'Rol inválido';
  end if;

  -- Una contraseña restablecida cierra las sesiones abiertas de esa persona
  if v_cambia_pw then
    delete from sesiones where rol = p_rol and usuario_ref = v_ref and token <> p_token;
    update sesiones set debe_cambiar = true where rol = p_rol and usuario_ref = v_ref;
  end if;

  perform privado.log('Admin', v_admin, 'usuario_editado',
    jsonb_build_object('rol', p_rol, 'identificador', v_ref, 'nombre', v_nuevo, 'password_restablecida', v_cambia_pw));
end;
$$;

create or replace function public.admin_eliminar_usuario(p_token uuid, p_rol text, p_id text)
returns void language plpgsql security definer set search_path = 'public' as $$
declare
  v_admin text := _validar_sesion(p_token, array['Admin']);
  v_ref text;
  v_nombre text;
begin
  if p_rol = 'Estudiante' then
    delete from alumnos where id = p_id::uuid returning matricula, nombre into v_ref, v_nombre;
  elsif p_rol = 'Chofer' then
    delete from choferes where id = p_id::bigint returning licencia, nombre into v_ref, v_nombre;
  elsif p_rol = 'Admin' then
    select usuario into v_ref from admins where id = p_id::bigint;
    if v_ref = v_admin then
      raise exception 'No puedes eliminar tu propia cuenta de administrador';
    end if;
    if (select count(*) from admins) <= 1 then
      raise exception 'Debe quedar al menos un administrador';
    end if;
    delete from admins where id = p_id::bigint;
  else
    raise exception 'Rol inválido';
  end if;

  if v_ref is null then
    raise exception 'Usuario no encontrado';
  end if;
  delete from sesiones where rol = p_rol and usuario_ref = v_ref;
  perform privado.log('Admin', v_admin, 'usuario_eliminado',
    jsonb_build_object('rol', p_rol, 'identificador', v_ref, 'nombre', v_nombre));
end;
$$;

-- Ajuste manual del saldo (correcciones), siempre con motivo en la bitácora
drop function if exists public.admin_actualizar_saldo(uuid, uuid, numeric);
create or replace function public.admin_actualizar_saldo(p_token uuid, p_id uuid, p_saldo numeric, p_motivo text default null)
returns void language plpgsql security definer set search_path = 'public' as $$
declare
  v_admin text := _validar_sesion(p_token, array['Admin']);
  v_saldo numeric := round(p_saldo, 2);
  v_antes numeric;
  v_matricula text;
begin
  if v_saldo is null or v_saldo < 0 or v_saldo > 100000 then
    raise exception 'El saldo debe estar entre $0 y $100,000';
  end if;
  select saldo, matricula into v_antes, v_matricula from alumnos where id = p_id for update;
  if v_matricula is null then
    raise exception 'Alumno no encontrado';
  end if;
  update alumnos set saldo = v_saldo where id = p_id;
  perform privado.log('Admin', v_admin, 'saldo_ajustado', jsonb_build_object(
    'matricula', v_matricula, 'antes', v_antes, 'despues', v_saldo,
    'motivo', nullif(left(trim(coalesce(p_motivo, '')), 200), '')));
end;
$$;

-- Pagos: bajan el saldo y quedan en el historial del alumno
create or replace function public.admin_registrar_pago(p_token uuid, p_id uuid, p_monto numeric, p_nota text default null)
returns json language plpgsql security definer set search_path = 'public' as $$
declare
  v_admin text := _validar_sesion(p_token, array['Admin']);
  v_monto numeric := round(p_monto, 2);
  v_saldo numeric;
  v_matricula text;
  v_nota text := nullif(left(trim(coalesce(p_nota, '')), 200), '');
begin
  select saldo, matricula into v_saldo, v_matricula from alumnos where id = p_id for update;
  if v_matricula is null then
    raise exception 'Alumno no encontrado';
  end if;
  if v_monto is null or v_monto <= 0 then
    raise exception 'El pago debe ser mayor a $0';
  end if;
  if v_monto > coalesce(v_saldo, 0) then
    raise exception 'El pago no puede ser mayor al saldo pendiente ($%)', to_char(coalesce(v_saldo, 0), 'FM999,990.00');
  end if;

  update alumnos set saldo = saldo - v_monto where id = p_id returning saldo into v_saldo;
  insert into privado.pagos (matricula, monto, nota, registrado_por) values (v_matricula, v_monto, v_nota, v_admin);
  perform privado.log('Admin', v_admin, 'pago_registrado',
    jsonb_build_object('matricula', v_matricula, 'monto', v_monto, 'saldo_restante', v_saldo, 'nota', v_nota));
  return json_build_object('saldo', v_saldo);
end;
$$;

create or replace function public.admin_bitacora(p_token uuid, p_limite int default 100)
returns json language plpgsql security definer set search_path = 'public' as $$
begin
  perform _validar_sesion(p_token, array['Admin']);
  return coalesce((
    select json_agg(json_build_object('id', id, 'creado_en', creado_en, 'actor_rol', actor_rol, 'actor', actor,
                                      'accion', accion, 'detalle', detalle) order by id desc)
    from (select * from privado.bitacora order by id desc limit least(greatest(coalesce(p_limite, 100), 1), 300)) b
  ), '[]'::json);
end;
$$;

-- Historial del alumno: viajes cobrados y pagos registrados
drop function if exists public.alumno_historial(uuid);
create or replace function public.alumno_historial(p_token uuid)
returns json language plpgsql security definer set search_path = 'public' as $$
declare
  v_matricula text := _validar_sesion(p_token, array['Estudiante']);
begin
  return coalesce((
    select json_agg(x order by x.fecha_hora desc)
    from (
      select * from (
        select 'v' || id as id, 'viaje' as tipo, monto, fecha_hora, camion, null::text as nota
        from historial_viajes where matricula = v_matricula
        union all
        select 'p' || id, 'pago', monto, creado_en, null, nota
        from privado.pagos where matricula = v_matricula
      ) u
      order by fecha_hora desc
      limit 100
    ) x
  ), '[]'::json);
end;
$$;

-- ---------------------------------------------------------------------
-- 7. Limpieza, índices y permisos
-- ---------------------------------------------------------------------
drop table if exists public.parejas_temp;
drop table if exists public.viajes;
drop table if exists public.usuarios;

create index if not exists reservas_matricula_idx on public.reservas (matricula);

-- Las auxiliares internas (_*) no deben poder llamarse desde la API
do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as firma
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname like '\_%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.firma);
  end loop;
end;
$$;
