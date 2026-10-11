-- =====================================================================
-- SEGURIDAD: contraseñas con hash, sesiones con token, RLS y RPCs
-- El cliente (anon key) ya no toca las tablas directamente: todo pasa
-- por funciones SECURITY DEFINER que validan el token y el rol.
-- =====================================================================

-- --- 1. HASH DE CONTRASEÑAS (bcrypt vía pgcrypto) ---
create or replace function public._hash_password()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if new.password is not null and new.password !~ '^\$2[abxy]\$' then
    new.password := extensions.crypt(new.password, extensions.gen_salt('bf'));
  end if;
  return new;
end;
$$;

alter table public.alumnos alter column password drop default;

drop trigger if exists trg_hash_password on public.alumnos;
drop trigger if exists trg_hash_password on public.choferes;
drop trigger if exists trg_hash_password on public.admins;

create trigger trg_hash_password before insert or update of password on public.alumnos
  for each row execute function public._hash_password();
create trigger trg_hash_password before insert or update of password on public.choferes
  for each row execute function public._hash_password();
create trigger trg_hash_password before insert or update of password on public.admins
  for each row execute function public._hash_password();

-- Convertir las contraseñas existentes (el trigger las hashea)
update public.alumnos  set password = password where password is not null and password !~ '^\$2[abxy]\$';
update public.choferes set password = password where password is not null and password !~ '^\$2[abxy]\$';
update public.admins   set password = password where password is not null and password !~ '^\$2[abxy]\$';

-- --- 2. SESIONES ---
create table if not exists public.sesiones (
  token uuid primary key default gen_random_uuid(),
  rol text not null check (rol in ('Estudiante', 'Chofer', 'Admin')),
  usuario_ref text not null,
  creado_en timestamptz not null default now(),
  expira_en timestamptz not null default now() + interval '12 hours'
);

-- Valida el token y devuelve el identificador del usuario (matrícula / licencia / usuario)
create or replace function public._validar_sesion(p_token uuid, p_roles text[])
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ref text;
begin
  select usuario_ref into v_ref
  from sesiones
  where token = p_token and rol = any(p_roles) and expira_en > now();

  if v_ref is null then
    raise exception 'Sesión inválida o expirada' using errcode = '28000';
  end if;
  return v_ref;
end;
$$;

-- --- 3. RLS: bloquear acceso directo a todas las tablas ---
alter table public.alumnos          enable row level security;
alter table public.choferes         enable row level security;
alter table public.admins           enable row level security;
alter table public.abordajes        enable row level security;
alter table public.historial_viajes enable row level security;
alter table public.horarios_matriz  enable row level security;
alter table public.estado_viaje     enable row level security;
alter table public.sesiones         enable row level security;

-- Eliminar políticas antiguas que dejaban todo abierto
drop policy if exists "Permitir actualizacion publica" on public.alumnos;
drop policy if exists "Permitir eliminacion publica" on public.alumnos;
drop policy if exists "Permitir insercion publica" on public.alumnos;
drop policy if exists "Permitir lectura publica" on public.alumnos;
drop policy if exists "Permitir lectura publica de choferes" on public.choferes;

-- Defensa extra: sin privilegios directos sobre tablas sensibles
revoke all on public.alumnos, public.choferes, public.admins, public.abordajes,
              public.historial_viajes, public.sesiones from anon, authenticated;
revoke insert, update, delete, truncate on public.estado_viaje, public.horarios_matriz from anon, authenticated;

-- Lectura pública solo de datos no sensibles (necesaria para Realtime)
drop policy if exists "lectura publica estado" on public.estado_viaje;
create policy "lectura publica estado" on public.estado_viaje
  for select to anon, authenticated using (true);

drop policy if exists "lectura publica horarios" on public.horarios_matriz;
create policy "lectura publica horarios" on public.horarios_matriz
  for select to anon, authenticated using (true);

-- --- 4. LOGIN / LOGOUT ---
create or replace function public.login(p_rol text, p_identificador text, p_password text)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_perfil json;
  v_ref text;
  v_token uuid;
begin
  -- Limpieza de sesiones vencidas
  delete from sesiones where expira_en < now();

  if p_rol = 'Estudiante' then
    select matricula, json_build_object('nombre', nombre, 'matricula', matricula, 'saldo', saldo)
      into v_ref, v_perfil
    from alumnos where matricula = p_identificador and password = crypt(p_password, password);
  elsif p_rol = 'Chofer' then
    select licencia, json_build_object('nombre', nombre, 'licencia', licencia)
      into v_ref, v_perfil
    from choferes where licencia = p_identificador and password = crypt(p_password, password);
  elsif p_rol = 'Admin' then
    select usuario, json_build_object('usuario', usuario)
      into v_ref, v_perfil
    from admins where usuario = p_identificador and password = crypt(p_password, password);
  end if;

  if v_ref is null then
    return null;
  end if;

  insert into sesiones (rol, usuario_ref) values (p_rol, v_ref) returning token into v_token;
  return json_build_object('token', v_token, 'perfil', v_perfil);
end;
$$;

create or replace function public.logout(p_token uuid)
returns void
language sql
security definer
set search_path = public
as $$
  delete from sesiones where token = p_token;
$$;

-- --- 5. ALUMNO ---
create or replace function public.alumno_perfil(p_token uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_matricula text := _validar_sesion(p_token, array['Estudiante']);
begin
  return (
    select json_build_object('nombre', nombre, 'matricula', matricula, 'saldo', saldo)
    from alumnos where matricula = v_matricula
  );
end;
$$;

create or replace function public.alumno_historial(p_token uuid)
returns setof public.historial_viajes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_matricula text := _validar_sesion(p_token, array['Estudiante']);
begin
  return query
    select * from historial_viajes where matricula = v_matricula order by fecha_hora desc;
end;
$$;

-- --- 6. CHOFER ---
create or replace function public.chofer_abordajes(p_token uuid)
returns setof public.abordajes
language plpgsql
security definer
set search_path = public
as $$
begin
  perform _validar_sesion(p_token, array['Chofer']);
  return query select * from abordajes order by created_at;
end;
$$;

-- Valida el QR y registra al alumno. Devuelve el nombre del alumno.
create or replace function public.chofer_registrar_abordaje(p_token uuid, p_matricula text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_nombre text;
begin
  perform _validar_sesion(p_token, array['Chofer']);
  -- Serializa escaneos simultáneos para respetar el límite de 40
  lock table abordajes in share row exclusive mode;

  if (select count(*) from abordajes) >= 40 then
    raise exception 'Límite alcanzado (Máximo 40 pasajeros)';
  end if;

  select nombre into v_nombre from alumnos where matricula = trim(p_matricula);
  if v_nombre is null then
    raise exception 'Matrícula % inválida', trim(p_matricula);
  end if;

  if exists (select 1 from abordajes where matricula = trim(p_matricula)) then
    raise exception 'El alumno (%) ya está a bordo', trim(p_matricula);
  end if;

  insert into abordajes (nombre, matricula) values (v_nombre, trim(p_matricula));
  return v_nombre;
end;
$$;

create or replace function public.chofer_quitar_abordaje(p_token uuid, p_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform _validar_sesion(p_token, array['Chofer']);
  delete from abordajes where id = p_id;
end;
$$;

create or replace function public.chofer_vaciar_abordajes(p_token uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform _validar_sesion(p_token, array['Chofer']);
  delete from abordajes where true;
end;
$$;

-- Corte atómico: suma $30 a cada pasajero, registra historial y pone el viaje EN_CAMINO.
-- Todo ocurre en una sola transacción, así que dos cortes simultáneos no pierden cobros.
create or replace function public.chofer_hacer_corte(p_token uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total integer;
begin
  perform _validar_sesion(p_token, array['Chofer']);
  lock table abordajes in share row exclusive mode;

  select count(*) into v_total from abordajes;
  if v_total = 0 then
    raise exception 'No hay estudiantes en la lista de abordaje.';
  end if;

  update alumnos a
     set saldo = coalesce(a.saldo, 0) + 30
    from abordajes b
   where a.matricula = b.matricula;

  insert into historial_viajes (matricula, monto, fecha_hora)
  select matricula, 30, now() from abordajes;

  update estado_viaje set estado = 'EN_CAMINO', updated_at = now() where id = 1;
  return v_total;
end;
$$;

create or replace function public.chofer_finalizar_viaje(p_token uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform _validar_sesion(p_token, array['Chofer']);
  delete from abordajes where true;
  update estado_viaje set estado = 'ESPERANDO', updated_at = now() where id = 1;
end;
$$;

-- p_accion: 'iniciar' (5 min), 'agregar' (+1 min) o 'cancelar'
create or replace function public.chofer_temporizador(p_token uuid, p_accion text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform _validar_sesion(p_token, array['Chofer']);

  if p_accion = 'iniciar' then
    update estado_viaje set tiempo_salida = now() + interval '5 minutes', temporizador_activo = true where id = 1;
  elsif p_accion = 'agregar' then
    update estado_viaje set tiempo_salida = tiempo_salida + interval '1 minute'
     where id = 1 and temporizador_activo and tiempo_salida is not null;
  elsif p_accion = 'cancelar' then
    update estado_viaje set tiempo_salida = null, temporizador_activo = false where id = 1;
  else
    raise exception 'Acción de temporizador desconocida: %', p_accion;
  end if;
end;
$$;

create or replace function public.chofer_horario_agregar(p_token uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform _validar_sesion(p_token, array['Chofer']);
  insert into horarios_matriz default values;
end;
$$;

create or replace function public.chofer_horario_actualizar(p_token uuid, p_id bigint, p_dia text, p_valor jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform _validar_sesion(p_token, array['Chofer']);

  if p_dia not in ('lunes', 'martes', 'miercoles', 'jueves', 'viernes') then
    raise exception 'Día inválido: %', p_dia;
  end if;

  execute format('update horarios_matriz set %I = $1 where id = $2', p_dia) using p_valor, p_id;
end;
$$;

create or replace function public.chofer_horario_eliminar(p_token uuid, p_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform _validar_sesion(p_token, array['Chofer']);
  delete from horarios_matriz where id = p_id;
end;
$$;

-- --- 7. ADMIN ---
create or replace function public.admin_usuarios(p_token uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  perform _validar_sesion(p_token, array['Admin']);
  return json_build_object(
    'alumnos',  coalesce((select json_agg(json_build_object('id', id, 'nombre', nombre, 'matricula', matricula, 'saldo', saldo) order by nombre) from alumnos), '[]'::json),
    'choferes', coalesce((select json_agg(json_build_object('id', id, 'nombre', nombre, 'licencia', licencia) order by nombre) from choferes), '[]'::json),
    'admins',   coalesce((select json_agg(json_build_object('id', id, 'usuario', usuario) order by usuario) from admins), '[]'::json)
  );
end;
$$;

create or replace function public.admin_crear_usuario(
  p_token uuid, p_rol text, p_nombre text, p_identificador text, p_password text, p_saldo numeric default 0
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform _validar_sesion(p_token, array['Admin']);

  if coalesce(trim(p_password), '') = '' then
    raise exception 'La contraseña es obligatoria';
  end if;

  if p_rol = 'Estudiante' then
    insert into alumnos (nombre, matricula, password, saldo) values (p_nombre, p_identificador, p_password, coalesce(p_saldo, 0));
  elsif p_rol = 'Chofer' then
    insert into choferes (nombre, licencia, password) values (p_nombre, p_identificador, p_password);
  elsif p_rol = 'Admin' then
    insert into admins (usuario, password) values (p_identificador, p_password);
  else
    raise exception 'Rol inválido: %', p_rol;
  end if;
end;
$$;

-- p_id es texto porque alumnos usa uuid y choferes/admins usan bigint
create or replace function public.admin_editar_usuario(p_token uuid, p_rol text, p_id text, p_nombre text, p_password text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform _validar_sesion(p_token, array['Admin']);

  if p_rol = 'Estudiante' then
    update alumnos set nombre = p_nombre where id = p_id::uuid;
    if coalesce(p_password, '') <> '' then update alumnos set password = p_password where id = p_id::uuid; end if;
  elsif p_rol = 'Chofer' then
    update choferes set nombre = p_nombre where id = p_id::bigint;
    if coalesce(p_password, '') <> '' then update choferes set password = p_password where id = p_id::bigint; end if;
  elsif p_rol = 'Admin' then
    update admins set usuario = p_nombre where id = p_id::bigint;
    if coalesce(p_password, '') <> '' then update admins set password = p_password where id = p_id::bigint; end if;
  else
    raise exception 'Rol inválido: %', p_rol;
  end if;
end;
$$;

create or replace function public.admin_eliminar_usuario(p_token uuid, p_rol text, p_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform _validar_sesion(p_token, array['Admin']);

  if p_rol = 'Estudiante' then
    delete from alumnos where id = p_id::uuid;
  elsif p_rol = 'Chofer' then
    delete from choferes where id = p_id::bigint;
  elsif p_rol = 'Admin' then
    delete from admins where id = p_id::bigint;
  else
    raise exception 'Rol inválido: %', p_rol;
  end if;
end;
$$;

create or replace function public.admin_actualizar_saldo(p_token uuid, p_id uuid, p_saldo numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform _validar_sesion(p_token, array['Admin']);
  update alumnos set saldo = p_saldo where id = p_id;
end;
$$;

-- --- 8. PERMISOS: las funciones internas no se exponen por la API ---
revoke execute on function public._validar_sesion(uuid, text[]) from public, anon, authenticated;
revoke execute on function public._hash_password() from public, anon, authenticated;
