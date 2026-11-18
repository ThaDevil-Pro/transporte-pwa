-- CAMIFY · Notificaciones push también para choferes y administración
--  - Choferes y admins pueden activar notificaciones igual que los alumnos.
--  - Administración: emergencias, fallas, quejas, cargas de diesel por revisar, cortes y accesos bloqueados.
--  - Choferes: emergencias de otros camiones, respuesta a sus fallas y a sus cargas de diesel, quejas de su camión.
--  - Alumnos (además de lo que ya tenían): pagos, ajustes de saldo y cobro de cada viaje.
-- Los avisos salen de triggers: ninguna función existente cambia. Si un aviso falla, la acción que lo provocó sigue.

-- ---------------------------------------------------------------------
-- Suscribir: cualquier rol con notificaciones (el teléfono queda ligado al rol y usuario de la sesión)
-- ---------------------------------------------------------------------
create or replace function public.push_suscribir(p_token uuid, p_endpoint text, p_p256dh text, p_auth text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ref text := _validar_sesion(p_token, array['Estudiante', 'Chofer', 'Admin']);
  v_rol text := current_setting('camify.rol');
begin
  if not privado.push_endpoint_valido(p_endpoint) then
    raise exception 'Este navegador no admite notificaciones';
  end if;
  if coalesce(p_p256dh, '') !~ '^[A-Za-z0-9_-]{80,100}$' or coalesce(p_auth, '') !~ '^[A-Za-z0-9_-]{16,30}$' then
    raise exception 'La suscripción no es válida';
  end if;

  -- Un teléfono es de quien entró por última vez en él
  insert into privado.push_suscripciones (endpoint, rol, usuario_ref, p256dh, auth)
  values (p_endpoint, v_rol, v_ref, p_p256dh, p_auth)
  on conflict (endpoint) do update
    set rol = excluded.rol, usuario_ref = excluded.usuario_ref, p256dh = excluded.p256dh,
        auth = excluded.auth, actualizado_en = now();

  -- Máximo 5 dispositivos por usuario: se quitan los más viejos
  delete from privado.push_suscripciones
  where endpoint in (
    select endpoint from privado.push_suscripciones
    where rol = v_rol and usuario_ref = v_ref
    order by actualizado_en desc
    offset 5
  );
end;
$$;

-- ---------------------------------------------------------------------
-- Envío: p_items = [{titulo, cuerpo, etiqueta, rol?, ref? | matricula? | todos?, excepto?}]
--   rol por defecto 'Estudiante'; matricula es lo mismo que ref (compatibilidad);
--   todos = true manda a todos los de ese rol (menos "excepto").
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
      join privado.push_suscripciones s
        on s.rol = coalesce(i->>'rol', 'Estudiante')
       and (case when coalesce((i->>'todos')::boolean, false) then true
                 else s.usuario_ref = coalesce(i->>'ref', i->>'matricula') end)
       and s.usuario_ref is distinct from i->>'excepto'
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

-- Atajo: un aviso para una persona o para todo un rol (nunca "todos los alumnos" por una referencia vacía)
create or replace function privado.push_a(p_rol text, p_ref text, p_titulo text, p_cuerpo text, p_etiqueta text, p_excepto text default null)
returns void
language sql
security definer
set search_path = ''
as $$
  select privado.push_enviar(jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
    'rol', p_rol, 'ref', p_ref, 'todos', p_ref is null and p_rol in ('Admin', 'Chofer'), 'excepto', p_excepto,
    'titulo', p_titulo, 'cuerpo', left(p_cuerpo, 300), 'etiqueta', p_etiqueta))))
$$;

create or replace function privado.push_dinero(p numeric)
returns text
language sql
immutable
set search_path = ''
as $$
  select '$' || case when abs(p) = trunc(abs(p)) then to_char(abs(p), 'FM999,990') else to_char(abs(p), 'FM999,990.00') end
$$;

-- Saldo positivo = adeudo; negativo = a favor
create or replace function privado.push_saldo(p numeric)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when coalesce(p, 0) > 0 then 'Debes ' || privado.push_dinero(p)
              when p < 0 then 'Tienes ' || privado.push_dinero(p) || ' a favor'
              else 'Estás al corriente' end
$$;

-- ---------------------------------------------------------------------
-- Fallas: nueva (o emergencia) → administración; cambio de estado → el chofer que la reportó
-- ---------------------------------------------------------------------
create or replace function privado.push_fallas_tg()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_camion text := public._camion_nombre(new.camion);
  v_quien text := coalesce(initcap(lower(new.chofer_nombre)), 'Un chofer');
begin
  if tg_op = 'INSERT' then
    if new.descripcion like 'EMERGENCIA:%' then
      perform privado.push_a('Admin', null, '🚨 Emergencia: camión ' || v_camion,
        v_quien || ' avisó: ' || substr(new.descripcion, 13), 'emergencia-' || new.id);
      perform privado.push_a('Chofer', null, '🚨 Emergencia en el camión ' || v_camion,
        v_quien || ' avisó: ' || substr(new.descripcion, 13), 'emergencia-' || new.id, new.chofer);
    else
      perform privado.push_a('Admin', null,
        'Falla reportada: camión ' || v_camion || case new.gravedad when 'alta' then ' ⚠️' else '' end,
        format('%s · %s · gravedad %s: %s', v_quien, case new.tipo when 'electrico' then 'eléctrico' else new.tipo end,
               new.gravedad, new.descripcion), 'falla-' || new.id);
    end if;
  elsif new.chofer is not null then
    perform privado.push_a('Chofer', new.chofer,
      case new.estado when 'reparacion' then 'Tu reporte de falla está en reparación'
                      when 'resuelta' then 'Tu reporte de falla quedó resuelto'
                      else 'Tu reporte de falla sigue abierto' end,
      format('Camión %s · %s', v_camion, coalesce('Nota: ' || new.nota, new.descripcion)), 'falla-' || new.id);
  end if;
  return null;
exception when others then
  raise warning 'push_fallas_tg: %', sqlerrm;
  return null;
end;
$$;

drop trigger if exists fallas_push on public.fallas;
create trigger fallas_push after insert on public.fallas
  for each row execute function privado.push_fallas_tg();
drop trigger if exists fallas_push_estado on public.fallas;
create trigger fallas_push_estado after update of estado, nota on public.fallas
  for each row when ((old.estado, old.nota) is distinct from (new.estado, new.nota))
  execute function privado.push_fallas_tg();

-- ---------------------------------------------------------------------
-- Quejas nuevas → administración y el chofer que trae ese camión hoy
-- ---------------------------------------------------------------------
create or replace function privado.push_quejas_tg()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_texto text := format('%s%s: %s',
                         case new.categoria when 'camion' then 'Camión' when 'otro' then 'Otro tema' else initcap(new.categoria) end,
                         coalesce(' · camión ' || public._camion_nombre(new.camion), ''), new.mensaje);
  v_chofer text;
begin
  perform privado.push_a('Admin', null, 'Queja nueva en el buzón', v_texto, 'queja-' || new.id);
  if new.camion is not null then
    select chofer into v_chofer from privado.jornadas where fecha = privado.hoy() and camion = new.camion;
    if v_chofer is not null then
      perform privado.push_a('Chofer', v_chofer, 'Queja nueva sobre tu camión', v_texto, 'queja-' || new.id);
    end if;
  end if;
  return null;
exception when others then
  raise warning 'push_quejas_tg: %', sqlerrm;
  return null;
end;
$$;

drop trigger if exists quejas_push on public.quejas;
create trigger quejas_push after insert on public.quejas
  for each row execute function privado.push_quejas_tg();

-- ---------------------------------------------------------------------
-- Diesel: carga de un chofer → administración; revisión → el chofer
-- ---------------------------------------------------------------------
create or replace function privado.push_diesel_tg()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_camion text := public._camion_nombre(new.camion);
begin
  if tg_op = 'INSERT' then
    if new.registrado_rol = 'Chofer' then
      perform privado.push_a('Admin', null, 'Carga de diesel por revisar',
        format('%s · camión %s · %s L · %s', coalesce(initcap(lower(new.chofer_nombre)), 'Chofer'), v_camion,
               rtrim(rtrim(to_char(new.litros, 'FM99,990.00'), '0'), '.'), privado.push_dinero(new.importe)), 'diesel-' || new.id);
    end if;
  elsif new.chofer is not null and new.estado <> 'pendiente' then
    perform privado.push_a('Chofer', new.chofer,
      case new.estado when 'verificada' then 'Tu carga de diesel fue verificada'
                      when 'observada' then 'Tu carga de diesel tiene una observación'
                      else 'Tu carga de diesel fue anulada' end,
      format('Camión %s · %s L · %s', v_camion, rtrim(rtrim(to_char(new.litros, 'FM99,990.00'), '0'), '.'), privado.push_dinero(new.importe))
        || coalesce('. Nota: ' || new.nota, ''), 'diesel-' || new.id);
  end if;
  return null;
exception when others then
  raise warning 'push_diesel_tg: %', sqlerrm;
  return null;
end;
$$;

drop trigger if exists diesel_push on privado.diesel_cargas;
create trigger diesel_push after insert on privado.diesel_cargas
  for each row execute function privado.push_diesel_tg();
drop trigger if exists diesel_push_estado on privado.diesel_cargas;
create trigger diesel_push_estado after update of estado on privado.diesel_cargas
  for each row when (old.estado is distinct from new.estado)
  execute function privado.push_diesel_tg();

-- ---------------------------------------------------------------------
-- Pagos → el alumno
-- ---------------------------------------------------------------------
create or replace function privado.push_pagos_tg()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform privado.push_a('Estudiante', new.matricula, 'Recibimos tu pago de ' || privado.push_dinero(new.monto),
    privado.push_saldo((select saldo from public.alumnos where matricula = new.matricula)) || '. ¡Gracias!',
    'saldo');
  return null;
exception when others then
  raise warning 'push_pagos_tg: %', sqlerrm;
  return null;
end;
$$;

drop trigger if exists pagos_push on privado.pagos;
create trigger pagos_push after insert on privado.pagos
  for each row execute function privado.push_pagos_tg();

-- ---------------------------------------------------------------------
-- Cobro de cada viaje (al hacer el corte) → cada alumno que subió. El apartado perdido ya avisa aparte.
-- ---------------------------------------------------------------------
create or replace function privado.push_viajes_tg()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform privado.push_enviar((
    select jsonb_agg(jsonb_build_object(
      'matricula', n.matricula,
      'titulo', 'Viaje cobrado: ' || privado.push_dinero(n.monto),
      'cuerpo', format('Subiste al camión %s. El cobro ya está en tu saldo.', public._camion_nombre(n.camion)),
      'etiqueta', 'viaje-' || n.id))
    from nuevos n
    where not coalesce(n.perdido, false) and n.monto > 0 and n.matricula is not null
      and exists (select 1 from privado.push_suscripciones s where s.rol = 'Estudiante' and s.usuario_ref = n.matricula)
  ));
  return null;
exception when others then
  raise warning 'push_viajes_tg: %', sqlerrm;
  return null;
end;
$$;

drop trigger if exists historial_push on public.historial_viajes;
create trigger historial_push after insert on public.historial_viajes
  referencing new table as nuevos
  for each statement execute function privado.push_viajes_tg();

-- ---------------------------------------------------------------------
-- Bitácora: cortes y accesos bloqueados → administración; ajuste de saldo → el alumno
-- ---------------------------------------------------------------------
create or replace function privado.push_bitacora_tg()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  d jsonb := new.detalle;
begin
  if new.accion = 'corte' then
    perform privado.push_a('Admin', null, 'Corte del camión ' || public._camion_nombre((d->>'camion')::int),
      format('%s · %s alumnos · %s%s',
             coalesce((select initcap(lower(nombre)) from public.choferes where licencia = new.actor), 'Chofer'),
             coalesce(d->>'alumnos', '0'), privado.push_dinero(coalesce((d->>'total')::numeric, 0)),
             case when coalesce((d->>'perdidos')::int, 0) > 0 then format(' · %s no subieron', d->>'perdidos') else '' end),
      'corte-' || new.id);
  elsif new.accion = 'login_bloqueado' then
    perform privado.push_a('Admin', null, 'Acceso bloqueado por intentos fallidos',
      format('Alguien intentó entrar varias veces con «%s». Se bloqueó por un rato.', left(coalesce(d->>'clave', '?'), 40)),
      'bloqueo-' || left(coalesce(d->>'clave', ''), 40));
  elsif new.accion = 'saldo_ajustado' then
    perform privado.push_a('Estudiante', d->>'matricula', 'La administración ajustó tu saldo',
      privado.push_saldo((d->>'despues')::numeric) || '.', 'saldo');
  end if;
  return null;
exception when others then
  raise warning 'push_bitacora_tg: %', sqlerrm;
  return null;
end;
$$;

drop trigger if exists bitacora_push on privado.bitacora;
create trigger bitacora_push after insert on privado.bitacora
  for each row when (new.accion in ('corte', 'login_bloqueado', 'saldo_ajustado'))
  execute function privado.push_bitacora_tg();

-- ---------------------------------------------------------------------
-- Permisos
-- ---------------------------------------------------------------------
revoke all on function privado.push_enviar(jsonb) from public, anon, authenticated;
revoke all on function privado.push_a(text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function privado.push_dinero(numeric) from public, anon, authenticated;
revoke all on function privado.push_saldo(numeric) from public, anon, authenticated;
revoke all on function privado.push_fallas_tg() from public, anon, authenticated;
revoke all on function privado.push_quejas_tg() from public, anon, authenticated;
revoke all on function privado.push_diesel_tg() from public, anon, authenticated;
revoke all on function privado.push_pagos_tg() from public, anon, authenticated;
revoke all on function privado.push_viajes_tg() from public, anon, authenticated;
revoke all on function privado.push_bitacora_tg() from public, anon, authenticated;
revoke all on function public.push_suscribir(uuid, text, text, text) from public, authenticated;
grant execute on function public.push_suscribir(uuid, text, text, text) to anon;
