-- =====================================================================
-- CAMIFY · Abordaje manual e importación de usuarios
--  1. El chofer busca a un alumno por nombre o matrícula y lo sube a mano
--     (para quien no trae celular o batería). El abordaje queda marcado
--     como manual en la lista, en el historial del alumno y en la bitácora,
--     para que se pueda revisar si alguien reclama un cobro.
--  2. La administración da de alta alumnos y choferes en lote desde un
--     Excel o CSV. Si una fila no trae contraseña se genera una temporal.
-- =====================================================================

alter table public.abordajes add column if not exists manual boolean not null default false;
alter table public.historial_viajes add column if not exists manual boolean not null default false;

-- ---------------------------------------------------------------------
-- 1. Auxiliares privadas
-- ---------------------------------------------------------------------
-- Minúsculas y sin acentos, para buscar "jose" y encontrar "José"
create or replace function privado.normalizar(p_texto text)
returns text language sql immutable set search_path = '' as $$
  select translate(lower(coalesce(p_texto, '')), 'áàäâéèëêíìïîóòöôúùüûñç', 'aaaaeeeeiiiioooouuuunc');
$$;

-- Contraseña temporal fácil de dictar: "Hqtw-4829" (sin l, o ni i para no confundirlas)
create or replace function privado.password_temporal(p_identificador text)
returns text language plpgsql volatile set search_path = '' as $$
declare
  v_letras constant text := 'abcdefghjkmnpqrstuvwxyz';
  v_bytes bytea;
  v_pw text;
  v_intento int;
  i int;
begin
  for v_intento in 1..10 loop
    v_bytes := extensions.gen_random_bytes(8);
    v_pw := '';
    for i in 0..3 loop
      v_pw := v_pw || substr(v_letras, get_byte(v_bytes, i) % 23 + 1, 1);
    end loop;
    v_pw := upper(left(v_pw, 1)) || substr(v_pw, 2) || '-';
    for i in 4..7 loop
      v_pw := v_pw || (get_byte(v_bytes, i) % 10)::text;
    end loop;
    begin
      perform privado.validar_password(v_pw, p_identificador);
      return v_pw;
    exception when others then
      null; -- coincidió con el identificador: se genera otra
    end;
  end loop;
  raise exception 'No se pudo generar una contraseña temporal';
end;
$$;

revoke all on function privado.normalizar(text) from public, anon, authenticated;
revoke all on function privado.password_temporal(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. Abordaje: una sola lógica para QR y registro manual
-- ---------------------------------------------------------------------
create or replace function public._abordar(p_camion int, p_matricula text, p_manual boolean)
returns json language plpgsql set search_path = 'public' as $$
declare
  v_nombre text;
  v_otro_camion int;
  v_fecha date;
  v_hora time;
  v_asiento int;
begin
  lock table abordajes in share row exclusive mode;

  if (select estado from estado_viaje where id = p_camion) = 'EN_CAMINO' then
    raise exception 'El corte de este viaje ya se hizo. Finaliza el viaje antes de subir a más alumnos.';
  end if;

  if (select count(*) from abordajes where camion = p_camion) >= 40 then
    raise exception 'Límite alcanzado (Máximo 40 pasajeros)';
  end if;

  select nombre into v_nombre from alumnos where matricula = p_matricula;
  if v_nombre is null then
    raise exception 'Este alumno ya no está registrado';
  end if;

  select camion into v_otro_camion from abordajes where matricula = p_matricula;
  if v_otro_camion = p_camion then
    raise exception 'El alumno (%) ya está a bordo', p_matricula;
  elsif v_otro_camion is not null then
    raise exception 'El alumno (%) ya está a bordo del camión %', p_matricula, v_otro_camion;
  end if;

  insert into abordajes (nombre, matricula, camion, manual) values (v_nombre, p_matricula, p_camion, p_manual);

  -- Salida en curso de este camión: la próxima (o la que salió hace menos de 30 min)
  select s.fecha, s.hora into v_fecha, v_hora
  from _salidas_programadas((_ahora() at time zone 'America/Mexico_City')::date - 1, 3) s
  where s.camion = p_camion and _salida_ts(s.fecha, s.hora) > _ahora() - interval '30 minutes'
  order by _salida_ts(s.fecha, s.hora)
  limit 1;

  select asiento into v_asiento from reservas
  where fecha = v_fecha and hora = v_hora and camion = p_camion and matricula = p_matricula;

  return json_build_object('nombre', v_nombre, 'asiento', v_asiento);
end;
$$;

revoke all on function public._abordar(int, text, boolean) from public, anon, authenticated;

create or replace function public.chofer_registrar_abordaje(p_token uuid, p_camion integer, p_matricula text)
returns json language plpgsql security definer set search_path = 'public' as $$
declare
  v_chofer text := _validar_sesion(p_token, array['Chofer']);
  v_codigo text := trim(coalesce(p_matricula, ''));
  v_partes text[];
  v_matricula text;
  v_ventana bigint;
  v_actual bigint := privado.qr_ventana();
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

  return _abordar(p_camion, v_matricula, false);
end;
$$;

-- Búsqueda para el registro manual: por matrícula (desde el inicio) o por
-- nombre (todas las palabras, en cualquier orden, sin importar acentos)
create or replace function public.chofer_buscar_alumnos(p_token uuid, p_texto text)
returns json language plpgsql security definer set search_path = 'public' as $$
declare
  v_q text := privado.normalizar(regexp_replace(trim(left(coalesce(p_texto, ''), 60)), '\s+', ' ', 'g'));
  v_like text;
  v_palabras text[];
begin
  perform _validar_sesion(p_token, array['Chofer']);
  if char_length(v_q) < 2 then
    return '[]'::json;
  end if;

  -- Los comodines de LIKE se buscan como texto normal
  v_like := replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_');
  v_palabras := string_to_array(v_like, ' ');

  return coalesce((
    select json_agg(json_build_object('nombre', x.nombre, 'matricula', x.matricula, 'camion', x.camion) order by x.orden, x.nombre)
    from (
      select a.nombre, a.matricula, b.camion,
             case when lower(a.matricula) = v_q then 0
                  when lower(a.matricula) like v_like || '%' then 1
                  else 2 end as orden
      from alumnos a
      left join abordajes b on b.matricula = a.matricula
      where lower(a.matricula) like v_like || '%'
         or (select bool_and(privado.normalizar(a.nombre) like '%' || w || '%') from unnest(v_palabras) w)
      order by orden, a.nombre
      limit 8
    ) x
  ), '[]'::json);
end;
$$;

create or replace function public.chofer_abordar_manual(p_token uuid, p_camion integer, p_matricula text)
returns json language plpgsql security definer set search_path = 'public' as $$
declare
  v_chofer text := _validar_sesion(p_token, array['Chofer']);
  v_res json;
begin
  perform _camion_valido(p_camion);
  v_res := _abordar(p_camion, trim(coalesce(p_matricula, '')), true);
  perform privado.log('Chofer', v_chofer, 'abordaje_manual', jsonb_build_object(
    'camion', p_camion, 'matricula', trim(p_matricula), 'nombre', v_res ->> 'nombre'));
  return v_res;
end;
$$;

-- El corte copia la marca de manual al historial del alumno
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

  insert into historial_viajes (matricula, monto, fecha_hora, camion, manual)
  select matricula, 30, now(), p_camion, manual from abordajes where camion = p_camion;

  update estado_viaje set estado = 'EN_CAMINO', updated_at = now() where id = p_camion;
  perform privado.log('Chofer', v_chofer, 'corte', jsonb_build_object('camion', p_camion, 'alumnos', v_total, 'total', v_total * 30,
    'manuales', (select count(*) from abordajes where camion = p_camion and manual)));
  return v_total;
end;
$$;

create or replace function public.alumno_historial(p_token uuid)
returns json language plpgsql security definer set search_path = 'public' as $$
declare
  v_matricula text := _validar_sesion(p_token, array['Estudiante']);
begin
  return coalesce((
    select json_agg(x order by x.fecha_hora desc)
    from (
      select * from (
        select 'v' || id as id, 'viaje' as tipo, monto, fecha_hora, camion, null::text as nota, manual
        from historial_viajes where matricula = v_matricula
        union all
        select 'p' || id, 'pago', monto, creado_en, null, nota, false
        from privado.pagos where matricula = v_matricula
      ) u
      order by fecha_hora desc
      limit 100
    ) x
  ), '[]'::json);
end;
$$;

-- ---------------------------------------------------------------------
-- 3. Importación de usuarios
--    p_filas: [{fila, rol, nombre, identificador, password?, saldo?}, …]
--    Hasta 15 filas por llamada (cifrar cada contraseña tarda ~85 ms y la
--    API corta a los 3 s). Cada fila se guarda o falla por separado.
--    Devuelve [{fila, ok, error?, password?}] — password solo si se generó.
-- ---------------------------------------------------------------------
create or replace function public.admin_importar_usuarios(p_token uuid, p_filas jsonb)
returns json language plpgsql security definer set search_path = 'public' as $$
declare
  v_admin text := _validar_sesion(p_token, array['Admin']);
  v_fila jsonb;
  v_num int;
  v_rol text;
  v_ident text;
  v_nombre text;
  v_pw text;
  v_generada boolean;
  v_saldo_txt text;
  v_saldo numeric;
  v_resultados jsonb := '[]'::jsonb;
  v_alumnos int := 0;
  v_choferes int := 0;
  v_fallidos int := 0;
begin
  if jsonb_typeof(p_filas) is distinct from 'array' or jsonb_array_length(p_filas) not between 1 and 15 then
    raise exception 'Envía de 1 a 15 filas por lote';
  end if;

  for v_fila, v_num in select value, ordinality::int from jsonb_array_elements(p_filas) with ordinality loop
    if coalesce(v_fila ->> 'fila', '') ~ '^[0-9]{1,6}$' then
      v_num := (v_fila ->> 'fila')::int;
    end if;

    begin
      v_rol := coalesce(nullif(trim(v_fila ->> 'rol'), ''), 'Estudiante');
      if v_rol not in ('Estudiante', 'Chofer') then
        raise exception 'Rol inválido: solo se pueden importar alumnos y choferes';
      end if;
      v_ident := privado.validar_identificador(v_fila ->> 'identificador');
      v_nombre := privado.validar_nombre(v_fila ->> 'nombre');

      v_saldo_txt := replace(replace(trim(coalesce(v_fila ->> 'saldo', '')), '$', ''), ',', '');
      if v_saldo_txt = '' then
        v_saldo := 0;
      elsif v_saldo_txt ~ '^[0-9]{1,6}(\.[0-9]{1,2})?$' then
        v_saldo := v_saldo_txt::numeric;
      else
        raise exception 'Saldo inválido: usa un número como 0 o 150.50';
      end if;
      if v_saldo > 100000 then
        raise exception 'El saldo inicial debe estar entre $0 y $100,000';
      end if;
      if v_rol = 'Chofer' and v_saldo <> 0 then
        raise exception 'Los choferes no llevan saldo';
      end if;

      v_pw := nullif(trim(coalesce(v_fila ->> 'password', '')), '');
      v_generada := v_pw is null;
      if v_generada then
        v_pw := privado.password_temporal(v_ident);
      else
        perform privado.validar_password(v_pw, v_ident);
      end if;

      if v_rol = 'Estudiante' then
        insert into alumnos (nombre, matricula, password, saldo, debe_cambiar_password)
        values (v_nombre, v_ident, privado.hash(v_pw), v_saldo, true);
        v_alumnos := v_alumnos + 1;
      else
        insert into choferes (nombre, licencia, password, debe_cambiar_password)
        values (v_nombre, v_ident, privado.hash(v_pw), true);
        v_choferes := v_choferes + 1;
      end if;

      v_resultados := v_resultados || jsonb_build_object('fila', v_num, 'ok', true,
        'password', case when v_generada then v_pw end);
    exception
      when unique_violation then
        v_fallidos := v_fallidos + 1;
        v_resultados := v_resultados || jsonb_build_object('fila', v_num, 'ok', false,
          'error', case when v_rol = 'Chofer' then 'Ya existe un chofer con esa licencia' else 'Ya existe un alumno con esa matrícula' end);
      when others then
        v_fallidos := v_fallidos + 1;
        v_resultados := v_resultados || jsonb_build_object('fila', v_num, 'ok', false, 'error', sqlerrm);
    end;
  end loop;

  perform privado.log('Admin', v_admin, 'usuarios_importados', jsonb_build_object(
    'alumnos', v_alumnos, 'choferes', v_choferes, 'fallidos', v_fallidos));
  return v_resultados::json;
end;
$$;
