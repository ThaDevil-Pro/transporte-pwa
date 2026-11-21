-- La administración también edita los horarios: qué salidas tiene cada unidad y a qué hora.
-- Mismas funciones del chofer, ahora aceptan el rol Admin.

create or replace function public.chofer_horario_actualizar(p_token uuid, p_id bigint, p_dia text, p_valor jsonb, p_camion integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hora text := coalesce(p_valor ->> 'hora', '');
  v_tipo text := coalesce(nullif(p_valor ->> 'tipo', ''), 'IDA');
begin
  perform _validar_sesion(p_token, array['Chofer', 'Admin']);
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

create or replace function public.chofer_horario_agregar(p_token uuid, p_camion integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform _validar_sesion(p_token, array['Chofer', 'Admin']);
  perform _camion_valido(p_camion);
  insert into horarios_matriz (camion) values (p_camion);
end;
$$;

create or replace function public.chofer_horario_eliminar(p_token uuid, p_id bigint, p_camion integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform _validar_sesion(p_token, array['Chofer', 'Admin']);
  perform _camion_valido(p_camion);
  delete from horarios_matriz where id = p_id and coalesce(camion, 1) = p_camion;
  if not found then raise exception 'Esa salida no es de tu camión'; end if;
end;
$$;
