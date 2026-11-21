-- Becas de transporte: el admin marca a un alumno con beca del 50% o 100% y
-- sube el oficio firmado por el director como evidencia.
-- El descuento se aplica en privado.precio_boleto, así que cada cobro
-- (boleto del día, apartado perdido, cancelar tarde) se registra con el monto
-- real ya descontado: no se tocan saldos a mano y los reportes cuadran.

create table if not exists privado.becas (
  matricula text primary key references public.alumnos (matricula) on update cascade on delete cascade,
  porcentaje smallint not null check (porcentaje in (0, 50, 100)),
  oficio bytea,
  oficio_tipo text check (oficio_tipo in ('image/jpeg', 'application/pdf')),
  actualizada_en timestamptz not null default now(),
  actualizada_por text
);
revoke all on privado.becas from anon, authenticated;

create or replace function privado.precio_boleto(p_matricula text)
returns numeric
language sql
stable
set search_path = ''
as $$
  select round((case (select ubicacion from public.alumnos where matricula = p_matricula) when 'chinacates' then 40 else 60 end)::numeric
         * (100 - coalesce((select porcentaje from privado.becas where matricula = p_matricula), 0)) / 100, 2)
$$;

-- p_oficio: data URL (JPEG o PDF) o null para conservar el que ya tiene
create or replace function public.admin_alumno_beca(p_token uuid, p_matricula text, p_porcentaje integer, p_oficio text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin text := _validar_sesion(p_token, array['Admin']);
  v_mat text := privado.matricula_de(p_matricula);
  v_antes smallint;
  v_tiene_oficio boolean;
  v_tipo text;
  v_bytes bytea;
begin
  if v_mat is null then
    raise exception 'No hay alumno con esa matrícula';
  end if;
  if p_porcentaje is null or p_porcentaje not in (0, 50, 100) then
    raise exception 'La beca debe ser de 0%%, 50%% o 100%%';
  end if;

  if p_oficio is not null then
    v_tipo := substring(p_oficio from '^data:(image/jpeg|application/pdf);base64,');
    if v_tipo is null then
      raise exception 'El oficio debe ser una foto (JPG) o un PDF';
    end if;
    begin
      v_bytes := decode(substring(p_oficio from position(',' in p_oficio) + 1), 'base64');
    exception when others then
      raise exception 'El archivo del oficio no es válido';
    end;
    if (v_tipo = 'image/jpeg' and substring(v_bytes from 1 for 3) <> '\xffd8ff'::bytea)
       or (v_tipo = 'application/pdf' and substring(v_bytes from 1 for 4) <> '\x25504446'::bytea) then
      raise exception 'El archivo del oficio no es válido';
    end if;
    if length(v_bytes) > 3 * 1024 * 1024 then
      raise exception 'El oficio pesa más de 3 MB';
    end if;
  end if;

  select porcentaje, oficio is not null into v_antes, v_tiene_oficio from privado.becas where matricula = v_mat for update;
  if p_porcentaje > 0 and v_bytes is null and not coalesce(v_tiene_oficio, false) then
    raise exception 'Sube el oficio firmado por el director';
  end if;
  if coalesce(v_antes, 0) = p_porcentaje and v_bytes is null then
    return;
  end if;

  insert into privado.becas as b (matricula, porcentaje, oficio, oficio_tipo, actualizada_por)
  values (v_mat, p_porcentaje, v_bytes, v_tipo, v_admin)
  on conflict (matricula) do update set
    porcentaje = excluded.porcentaje,
    oficio = coalesce(excluded.oficio, b.oficio),
    oficio_tipo = coalesce(excluded.oficio_tipo, b.oficio_tipo),
    actualizada_en = now(),
    actualizada_por = excluded.actualizada_por;

  perform privado.log('Admin', v_admin, 'beca_cambiada', jsonb_build_object(
    'matricula', v_mat, 'nombre', (select nombre from alumnos where matricula = v_mat),
    'antes', coalesce(v_antes, 0), 'despues', p_porcentaje, 'oficio_nuevo', v_bytes is not null));

  if coalesce(v_antes, 0) <> p_porcentaje then
    perform _avisar(v_mat, 'beca_cambiada', case
      when p_porcentaje = 0 then 'La administración retiró tu beca de transporte. Tu boleto vuelve a su precio normal.'
      else format('La administración registró tu beca de transporte del %s%%. Tu boleto ahora cuesta $%s.',
                  p_porcentaje, to_char(privado.precio_boleto(v_mat), 'FM999,990'))
    end);
  end if;
end;
$$;

-- Para auditoría: Admin y Financiero pueden ver el oficio
create or replace function public.admin_beca_oficio(p_token uuid, p_matricula text)
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  perform _validar_sesion(p_token, array['Admin', 'Financiero']);
  return (select json_build_object('tipo', oficio_tipo, 'base64', translate(encode(oficio, 'base64'), E'\n', ''))
          from privado.becas where matricula = p_matricula and oficio is not null);
end;
$$;

create or replace function public.admin_usuarios(p_token uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  perform _validar_sesion(p_token, array['Admin']);
  return json_build_object(
    'alumnos', coalesce((select json_agg(json_build_object('id', a.id, 'nombre', a.nombre, 'matricula', a.matricula, 'saldo', a.saldo,
                                                           'ubicacion', a.ubicacion,
                                                           'foto', exists (select 1 from privado.fotos f where f.matricula = a.matricula),
                                                           'beca', coalesce(b.porcentaje, 0),
                                                           'oficio', b.oficio is not null)
                                         order by a.nombre) from alumnos a left join privado.becas b on b.matricula = a.matricula), '[]'::json),
    'choferes', coalesce((select json_agg(json_build_object('id', id, 'nombre', nombre, 'licencia', licencia) order by nombre) from choferes), '[]'::json),
    'financieros', coalesce((select json_agg(json_build_object('id', id, 'nombre', nombre, 'usuario', usuario) order by nombre) from financieros), '[]'::json),
    'admins', coalesce((select json_agg(json_build_object('id', id, 'usuario', usuario) order by usuario) from admins), '[]'::json)
  );
end;
$$;

create or replace function public.finanzas_alumnos(p_token uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  perform _validar_sesion(p_token, array['Admin', 'Financiero']);
  return coalesce((select json_agg(json_build_object('id', a.id, 'nombre', a.nombre, 'matricula', a.matricula, 'saldo', a.saldo,
                                                     'ubicacion', a.ubicacion, 'beca', coalesce(b.porcentaje, 0),
                                                     'oficio', b.oficio is not null) order by a.nombre)
                   from alumnos a left join privado.becas b on b.matricula = a.matricula), '[]'::json);
end;
$$;

revoke all on function public.admin_alumno_beca(uuid, text, integer, text) from public;
grant execute on function public.admin_alumno_beca(uuid, text, integer, text) to anon;
revoke all on function public.admin_beca_oficio(uuid, text) from public;
grant execute on function public.admin_beca_oficio(uuid, text) to anon;

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
    when 'beca_cambiada' then 'Beca de transporte'
    else 'CAMIFY'
  end
$$;
