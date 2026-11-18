-- CAMIFY · Notificaciones push para alumnos
--  1. Cada teléfono con la app instalada guarda su suscripción (una por dispositivo).
--  2. Se avisa por push lo mismo que ya aparece en "Avisos" (cambio de asiento, apartado
--     perdido, emergencia, quejas...), las invitaciones de pareja y el inicio del abordaje
--     para quien apartó asiento en esa salida.
--  3. La base no firma nada: arma los mensajes y los manda en un solo POST (pg_net, después
--     del commit) a la función "enviar-push", que los cifra y entrega. Las llaves VAPID y la
--     dirección de la función viven en privado.secretos; sin ellas no se envía nada.

create extension if not exists pg_net with schema extensions;

create table if not exists privado.push_suscripciones (
  endpoint text primary key,
  rol text not null,
  usuario_ref text not null,
  p256dh text not null,
  auth text not null,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);
create index if not exists push_suscripciones_usuario_idx on privado.push_suscripciones (rol, usuario_ref);

-- Clave con la que la función de envío borra suscripciones vencidas
insert into privado.secretos (nombre, valor)
values ('push_limpieza', extensions.gen_random_bytes(32))
on conflict (nombre) do nothing;

create or replace function privado.secreto_texto(p_nombre text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select convert_from(valor, 'UTF8') from privado.secretos where nombre = p_nombre
$$;

-- Solo servicios de push reales (FCM, Apple, Mozilla, Windows)
create or replace function privado.push_endpoint_valido(p text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p is not null and length(p) <= 1000
     and p ~ '^https://([a-z0-9-]+\.)*(fcm\.googleapis\.com|android\.googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)/'
$$;

-- ---------------------------------------------------------------------
-- Suscribir y quitar (desde la app, con la sesión del alumno)
-- ---------------------------------------------------------------------
create or replace function public.push_suscribir(p_token uuid, p_endpoint text, p_p256dh text, p_auth text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ref text := _validar_sesion(p_token, array['Estudiante']);
begin
  if not privado.push_endpoint_valido(p_endpoint) then
    raise exception 'Este navegador no admite notificaciones';
  end if;
  if coalesce(p_p256dh, '') !~ '^[A-Za-z0-9_-]{80,100}$' or coalesce(p_auth, '') !~ '^[A-Za-z0-9_-]{16,30}$' then
    raise exception 'La suscripción no es válida';
  end if;

  -- Un teléfono es de quien entró por última vez en él
  insert into privado.push_suscripciones (endpoint, rol, usuario_ref, p256dh, auth)
  values (p_endpoint, 'Estudiante', v_ref, p_p256dh, p_auth)
  on conflict (endpoint) do update
    set rol = excluded.rol, usuario_ref = excluded.usuario_ref, p256dh = excluded.p256dh,
        auth = excluded.auth, actualizado_en = now();

  -- Máximo 5 dispositivos por alumno: se quitan los más viejos
  delete from privado.push_suscripciones
  where endpoint in (
    select endpoint from privado.push_suscripciones
    where rol = 'Estudiante' and usuario_ref = v_ref
    order by actualizado_en desc
    offset 5
  );
end;
$$;

create or replace function public.push_desuscribir(p_token uuid, p_endpoint text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ref text;
begin
  select usuario_ref into v_ref from sesiones where token = p_token and expira_en > now();
  if v_ref is null then
    raise exception 'Sesión inválida o expirada' using errcode = '28000';
  end if;
  delete from privado.push_suscripciones where endpoint = p_endpoint and usuario_ref = v_ref;
end;
$$;

-- La función de envío avisa qué suscripciones ya no existen (el teléfono las quitó)
create or replace function public.push_limpiar(p_clave text, p_endpoints text[])
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_clave is null or p_clave is distinct from encode((select valor from privado.secretos where nombre = 'push_limpieza'), 'hex') then
    raise exception 'No autorizado' using errcode = '28000';
  end if;
  delete from privado.push_suscripciones where endpoint = any (p_endpoints[1:500]);
end;
$$;

-- ---------------------------------------------------------------------
-- Envío: p_items = [{matricula, titulo, cuerpo, etiqueta}]
-- ---------------------------------------------------------------------
create or replace function privado.push_enviar(p_items jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text := privado.secreto_texto('push_funcion');
  v_publica text := privado.secreto_texto('vapid_publica');
  v_privada text := privado.secreto_texto('vapid_privada');
  v_lote jsonb;
begin
  if v_url is null or v_publica is null or v_privada is null or p_items is null then
    return;
  end if;

  for v_lote in
    select jsonb_agg(m)
    from (
      select jsonb_build_object(
               'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth,
               'datos', jsonb_build_object('titulo', i->>'titulo', 'cuerpo', i->>'cuerpo',
                                           'etiqueta', coalesce(i->>'etiqueta', 'camify'), 'url', '/')) as m,
             (row_number() over ()) / 200 as grupo
      from jsonb_array_elements(p_items) i
      join privado.push_suscripciones s on s.rol = 'Estudiante' and s.usuario_ref = i->>'matricula'
    ) x
    group by grupo
  loop
    perform net.http_post(
      url := v_url,
      body := jsonb_build_object(
        'vapid', jsonb_build_object('publica', v_publica, 'privada', v_privada),
        'limpieza', encode((select valor from privado.secretos where nombre = 'push_limpieza'), 'hex'),
        'mensajes', v_lote),
      headers := '{"Content-Type": "application/json"}'::jsonb,
      timeout_milliseconds := 15000
    );
  end loop;
exception when others then
  -- Una notificación que no sale nunca debe deshacer lo que la provocó
  raise warning 'push_enviar: %', sqlerrm;
end;
$$;

-- Títulos iguales a los de la tarjeta de avisos de la app
create or replace function privado.push_titulo_aviso(p_tipo text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_tipo
    when 'asiento_movido' then 'Cambiamos tu asiento'
    when 'asiento_pareja' then 'Tu pareja apartó tu lugar'
    when 'pareja_aceptada' then '¡Ya tienes pareja de viaje!'
    when 'pareja_rechazada' then 'Invitación no aceptada'
    when 'pareja_terminada' then 'Pareja de viaje terminada'
    when 'queja_respondida' then 'Respondieron tu queja'
    when 'queja_atendida' then 'Tu queja fue atendida'
    when 'emergencia' then 'Aviso de emergencia del camión'
    when 'apartado_perdido' then 'Perdiste tu apartado'
    when 'ubicacion_cambiada' then 'Cambiaron tu ubicación'
    else 'CAMIFY'
  end
$$;

-- Cada aviso nuevo (una emergencia inserta cientos de una vez: un solo envío)
create or replace function privado.push_avisos_tg()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform privado.push_enviar((
    select jsonb_agg(jsonb_build_object(
      'matricula', n.matricula,
      'titulo', privado.push_titulo_aviso(n.tipo),
      'cuerpo', left(n.mensaje, 300),
      'etiqueta', case when n.tipo = 'emergencia' then 'emergencia' else 'aviso-' || n.id end))
    from nuevos n
    where exists (select 1 from privado.push_suscripciones s where s.rol = 'Estudiante' and s.usuario_ref = n.matricula)
  ));
  return null;
end;
$$;

drop trigger if exists avisos_push on public.avisos;
create trigger avisos_push after insert on public.avisos
  referencing new table as nuevos
  for each statement execute function privado.push_avisos_tg();

-- Invitación de pareja
create or replace function privado.push_pareja_tg()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_nombre text;
begin
  if new.estado <> 'pendiente' then return null; end if;
  select initcap(lower(split_part(nombre, ' ', 1))) into v_nombre from public.alumnos where matricula = new.invita;
  perform privado.push_enviar(jsonb_build_array(jsonb_build_object(
    'matricula', new.invitado,
    'titulo', coalesce(v_nombre, 'Un compañero') || ' quiere ser tu pareja de viaje',
    'cuerpo', 'Abre CAMIFY para aceptar o rechazar la invitación.',
    'etiqueta', 'pareja-' || new.id)));
  return null;
end;
$$;

drop trigger if exists parejas_push on public.parejas;
create trigger parejas_push after insert on public.parejas
  for each row execute function privado.push_pareja_tg();

-- El chofer inicia el conteo: avisa a quien apartó asiento en esa salida
create or replace function privado.push_abordaje_tg()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sal record;
  v_min int := greatest(1, round(extract(epoch from (new.tiempo_salida - now())) / 60)::int);
begin
  select * into v_sal from public._salida_actual(new.id);
  if v_sal.fecha is null then return null; end if;
  perform privado.push_enviar((
    select jsonb_agg(jsonb_build_object(
      'matricula', r.matricula,
      'titulo', 'Tu camión ya está abordando',
      'cuerpo', format('%s sale en %s min. Tu asiento es el %s: ten listo tu código.',
                       public._camion_nombre(new.id), v_min, r.asiento),
      'etiqueta', 'abordaje-' || new.id))
    from public.reservas r
    where r.fecha = v_sal.fecha and r.hora = v_sal.hora and r.camion = new.id
  ));
  return null;
end;
$$;

drop trigger if exists estado_viaje_push on public.estado_viaje;
create trigger estado_viaje_push after update of temporizador_activo on public.estado_viaje
  for each row
  when (new.temporizador_activo and not coalesce(old.temporizador_activo, false) and new.tiempo_salida is not null)
  execute function privado.push_abordaje_tg();

-- ---------------------------------------------------------------------
-- Permisos: la app solo llama a suscribir/quitar; la limpieza la llama la función de envío
-- ---------------------------------------------------------------------
revoke all on function privado.secreto_texto(text) from public, anon, authenticated;
revoke all on function privado.push_endpoint_valido(text) from public, anon, authenticated;
revoke all on function privado.push_enviar(jsonb) from public, anon, authenticated;
revoke all on function privado.push_titulo_aviso(text) from public, anon, authenticated;
revoke all on function privado.push_avisos_tg() from public, anon, authenticated;
revoke all on function privado.push_pareja_tg() from public, anon, authenticated;
revoke all on function privado.push_abordaje_tg() from public, anon, authenticated;
revoke all on function public.push_suscribir(uuid, text, text, text) from public, authenticated;
revoke all on function public.push_desuscribir(uuid, text) from public, authenticated;
revoke all on function public.push_limpiar(text, text[]) from public, authenticated;
grant execute on function public.push_suscribir(uuid, text, text, text) to anon;
grant execute on function public.push_desuscribir(uuid, text) to anon;
grant execute on function public.push_limpiar(text, text[]) to anon;
