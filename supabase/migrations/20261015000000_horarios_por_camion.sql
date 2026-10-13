-- =====================================================================
-- CAMIFY · Cada chofer solo edita los horarios de su camión
-- Las funciones nuevas reciben el camión y rechazan salidas de otro.
-- Mover una salida de camión queda solo para la administración.
-- =====================================================================

-- Editar la hora o el tipo de un día, solo si la salida es de ese camión
create or replace function public.chofer_horario_actualizar(p_token uuid, p_id bigint, p_dia text, p_valor jsonb, p_camion int)
returns void language plpgsql security definer set search_path = 'public' as $$
declare
  v_hora text := coalesce(p_valor ->> 'hora', '');
  v_tipo text := coalesce(nullif(p_valor ->> 'tipo', ''), 'IDA');
begin
  perform _validar_sesion(p_token, array['Chofer']);
  perform _camion_valido(p_camion);

  if p_dia not in ('lunes', 'martes', 'miercoles', 'jueves', 'viernes') then
    raise exception 'Día inválido';
  end if;
  if v_hora <> '' and v_hora !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
    raise exception 'Hora inválida';
  end if;
  if v_tipo not in ('IDA', 'REGRESO') then
    raise exception 'Tipo de salida inválido';
  end if;
  if not exists (select 1 from horarios_matriz where id = p_id and coalesce(camion, 1) = p_camion) then
    raise exception 'Esa salida no es de tu camión';
  end if;

  execute format('update horarios_matriz set %I = $1 where id = $2', p_dia)
  using jsonb_build_object('hora', v_hora, 'tipo', v_tipo), p_id;
end;
$$;

-- Eliminar una salida, solo si es de ese camión
create or replace function public.chofer_horario_eliminar(p_token uuid, p_id bigint, p_camion int)
returns void language plpgsql security definer set search_path = 'public' as $$
begin
  perform _validar_sesion(p_token, array['Chofer']);
  perform _camion_valido(p_camion);
  delete from horarios_matriz where id = p_id and coalesce(camion, 1) = p_camion;
  if not found then
    raise exception 'Esa salida no es de tu camión';
  end if;
end;
$$;

-- Las versiones anteriores (sin camión) dejan de aceptarse
create or replace function public.chofer_horario_actualizar(p_token uuid, p_id bigint, p_dia text, p_valor jsonb)
returns void language plpgsql security definer set search_path = 'public' as $$
begin
  perform _validar_sesion(p_token, array['Chofer']);
  raise exception 'Actualiza la app para editar horarios';
end;
$$;

create or replace function public.chofer_horario_eliminar(p_token uuid, p_id bigint)
returns void language plpgsql security definer set search_path = 'public' as $$
begin
  perform _validar_sesion(p_token, array['Chofer']);
  raise exception 'Actualiza la app para editar horarios';
end;
$$;

-- Un chofer ya no puede mover salidas a otro camión
create or replace function public.chofer_horario_camion(p_token uuid, p_id bigint, p_camion int)
returns void language plpgsql security definer set search_path = 'public' as $$
begin
  perform _validar_sesion(p_token, array['Chofer']);
  raise exception 'Solo la administración puede cambiar el camión de una salida';
end;
$$;
