-- =====================================================================
-- CAMIFY · Correcciones de la revisión general
--  1. Finalizar un viaje solo actúa si el camión está en camino. Antes,
--     un teléfono con datos viejos podía vaciar la lista del siguiente
--     viaje sin cobrar. También reinicia el temporizador de salida.
--  2. Las contraseñas no pueden empezar ni terminar con espacios (al
--     escribirlas en el teléfono no se notan y luego no coinciden).
-- =====================================================================

create or replace function public.chofer_finalizar_viaje(p_token uuid, p_camion integer)
returns void language plpgsql security definer set search_path = 'public' as $$
declare
  v_chofer text := _validar_sesion(p_token, array['Chofer']);
begin
  perform _camion_valido(p_camion);
  lock table abordajes in share row exclusive mode;

  -- Otro teléfono ya lo finalizó: la lista actual es del siguiente viaje
  if coalesce((select estado from estado_viaje where id = p_camion for update), '') <> 'EN_CAMINO' then
    return;
  end if;

  delete from abordajes where camion = p_camion;
  update estado_viaje
     set estado = 'ESPERANDO', tiempo_salida = null, temporizador_activo = false, updated_at = now()
   where id = p_camion;
  perform privado.log('Chofer', v_chofer, 'viaje_finalizado', jsonb_build_object('camion', p_camion));
end;
$$;

create or replace function privado.validar_password(p_password text, p_identificador text)
returns void language plpgsql immutable set search_path = '' as $$
begin
  if p_password is null or char_length(p_password) < 8 then
    raise exception 'La contraseña debe tener al menos 8 caracteres';
  end if;
  if octet_length(p_password) > 72 then
    raise exception 'La contraseña es demasiado larga (máximo 72 caracteres)';
  end if;
  if p_password <> btrim(p_password, E' \t\r\n') then
    raise exception 'La contraseña no puede empezar ni terminar con espacios';
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
