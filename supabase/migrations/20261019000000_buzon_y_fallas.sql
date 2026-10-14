-- =====================================================================
-- CAMIFY · Buzón de quejas y reportes de fallas del camión
--  1. Los alumnos envían quejas o sugerencias. El chofer las lee sin
--     saber quién las escribió; la administración sí ve al autor para
--     darle seguimiento y puede responder (el alumno recibe un aviso).
--  2. Los choferes reportan fallas del camión; la administración las
--     sigue (abierta → en reparación → resuelta).
--  3. Las groserías e insultos se censuran en el servidor, antes de
--     guardarse, también si se escriben con números o letras repetidas.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Censura
-- ---------------------------------------------------------------------
-- Una palabra en minúsculas, sin acentos y con los números "de truco"
-- cambiados por letras (p3nd3j0 → pendejo, @ → a, $ → s)
create or replace function privado.normalizar_palabra(p text)
returns text language sql immutable set search_path = '' as $$
  select translate(lower(coalesce(p, '')), 'áàäâéèëêíìïîóòöôúùüûñç0134578@$', 'aaaaeeeeiiiioooouuuuncoieastbas');
$$;

-- Devuelve el texto con cada grosería cambiada por asteriscos y si hubo cambios.
-- Las letras repetidas también cuentan ("putooo"). Se cuidan palabras
-- normales parecidas: perro, vergüenza, pera, mamá, cono…
create or replace function privado.censurar(p_texto text, out texto text, out censurado boolean)
language plpgsql immutable set search_path = '' as $$
declare
  v_patron constant text := '^(' || array_to_string(array[
    -- groserías
    'p+u+t+[oa]+s*', 'p+u+t+(i+t+[oa]+|e+r+i+[oa]+|a+z+[oa]+|e+a+d+[oa]+|a+m+a+d+r+e+|i+s+i+m+[oa]+)s*',
    'p+e+n+d+e+j+[a-z]*', 'p+i+n+c+h+e+s*', 'c+h+i+n+g+[a-z]*',
    'v+e+r+g+(a+|a+z+[oa]+|u+d+[oa]+|u+i+t+a+)s*', 'c+u+l+(o+|e+r+[oa]+|i+a+d+[oa]+)s*',
    'c+a+b+r+o+n+(e+s+|a+s*|a+z+o+s*|c+i+t+[oa]+s*)?',
    'm+a+m+(o+n+(e+s+|a+s*)?|a+d+a+s*|a+r+|e+s+|a+d+o+r+[ae]?s*|a+s+t+e+)',
    'j+o+t+[oa]+s*', 'm+a+r+i+c+(a+|o+n+|o+n+e+s+|o+n+a+)s*', 'm+i+e+r+d+[ao]+s*', 'c+a+r+a+j+o+s*',
    'p+a+n+o+c+h+a+s*', 'o+j+e+t+[ea]+s*', 'p+e+r{2,}a+s*', 'z+o+r{2,}a+s*', 'p+e+d+[oa]+s*',
    'c+o+g+(e+r+|i+o+|e+s*|e+n+|i+d+[oa]+s*|i+e+n+d+o+|i+e+r+o+n+)',
    'c+a+g+(a+r+|a+d+[oa]+s*|o+|a+s+|a+n+|u+e+|a+r+l+a+)',
    'h+i+j+(o+d+e+p+u+t+a+|u+e+p+u+t+a+|o+e+p+u+t+a+|o+p+u+t+a+)s*', 'm+a+l+p+a+r+i+d+[oa]+s*',
    'g+i+l+i+p+o+l+l+a+s+', 'c+u+l+e+a+r+',
    -- insultos
    'i+d+i+o+t+[ao]+s*', 'i+m+b+e+c+i+l+(e+s+)?', 'e+s+t+u+p+i+d+[oa]+s*', 'p+e+n+d+e+j+',
    -- abreviaturas comunes
    'p+t+m+', 'c+t+m+', 'h+d+p+', 'a+l+v+', 'v+r+g+', 'p+n+d+j+[a-z]*', 'p+n+c+h+e+',
    -- inglés
    'f+u+c+k+[a-z]*', 's+h+i+t+[a-z]*', 'b+i+t+c+h+[a-z]*', 'a+s+s+h+o+l+e+s*', 'd+i+c+k+s*',
    'm+o+t+h+e+r+f+u+c+k+[a-z]*'
  ], '|') || ')$';
  m text[];
begin
  texto := '';
  censurado := false;
  for m in
    select regexp_matches(coalesce(p_texto, ''), '([A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9@$]+)|([^A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9@$]+)', 'g')
  loop
    if m[1] is not null then
      if privado.normalizar_palabra(m[1]) ~ v_patron then
        texto := texto || repeat('*', char_length(m[1]));
        censurado := true;
      else
        texto := texto || m[1];
      end if;
    else
      texto := texto || m[2];
    end if;
  end loop;
end;
$$;

revoke all on function privado.normalizar_palabra(text) from public, anon, authenticated;
revoke all on function privado.censurar(text) from public, anon, authenticated;

-- Texto de un formulario: sin espacios sobrantes ni más de dos saltos de línea seguidos
create or replace function privado.limpiar_texto(p text)
returns text language sql immutable set search_path = '' as $$
  select btrim(regexp_replace(regexp_replace(regexp_replace(replace(coalesce(p, ''), E'\r', ''),
    '[ \t]+', ' ', 'g'), ' ?\n ?', E'\n', 'g'), '\n{3,}', E'\n\n', 'g'), E' \t\n');
$$;
revoke all on function privado.limpiar_texto(text) from public, anon, authenticated;

-- Señal de tiempo real (sin datos): avisa que algo cambió
create or replace function public._senal(p_clave text)
returns void language sql security definer set search_path = 'public' as $$
  insert into actividad (clave, actualizado) values (p_clave, now())
  on conflict (clave) do update set actualizado = excluded.actualizado;
$$;
revoke all on function public._senal(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. Tablas
-- ---------------------------------------------------------------------
create table if not exists public.quejas (
  id bigint generated always as identity primary key,
  creado_en timestamptz not null default now(),
  matricula text references public.alumnos (matricula) on update cascade on delete set null,
  nombre text,                -- nombre del autor al enviarla (por si lo dan de baja)
  categoria text not null check (categoria in ('servicio', 'chofer', 'camion', 'horario', 'otro')),
  camion smallint,
  mensaje text not null,
  censurada boolean not null default false,
  estado text not null default 'nueva' check (estado in ('nueva', 'revision', 'atendida')),
  respuesta text,
  atendida_por text,
  actualizada_en timestamptz
);
create index if not exists quejas_creado_idx on public.quejas (creado_en desc);
create index if not exists quejas_matricula_idx on public.quejas (matricula, creado_en desc);

create table if not exists public.fallas (
  id bigint generated always as identity primary key,
  creado_en timestamptz not null default now(),
  chofer text not null,       -- licencia
  chofer_nombre text,
  camion smallint not null,
  tipo text not null check (tipo in ('motor', 'frenos', 'llantas', 'luces', 'puertas', 'clima', 'electrico', 'otro')),
  gravedad text not null check (gravedad in ('baja', 'media', 'alta')),
  descripcion text not null,
  estado text not null default 'abierta' check (estado in ('abierta', 'reparacion', 'resuelta')),
  nota text,
  atendida_por text,
  actualizada_en timestamptz
);
create index if not exists fallas_creado_idx on public.fallas (creado_en desc);
create index if not exists fallas_chofer_idx on public.fallas (chofer, creado_en desc);

alter table public.quejas enable row level security;
alter table public.fallas enable row level security;
revoke all on public.quejas from public, anon, authenticated;
revoke all on public.fallas from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. Alumno
-- ---------------------------------------------------------------------
create or replace function public.alumno_queja_enviar(p_token uuid, p_categoria text, p_camion integer, p_mensaje text)
returns json language plpgsql security definer set search_path = 'public' as $$
declare
  v_yo text := _validar_sesion(p_token, array['Estudiante']);
  v_texto text := privado.limpiar_texto(p_mensaje);
  v_c record;
  v_id bigint;
begin
  if p_categoria is null or p_categoria not in ('servicio', 'chofer', 'camion', 'horario', 'otro') then
    raise exception 'Elige de qué trata tu queja';
  end if;
  if p_camion is not null and not exists (select 1 from estado_viaje where id = p_camion) then
    raise exception 'Ese camión no existe';
  end if;
  if char_length(v_texto) < 10 then
    raise exception 'Cuéntanos un poco más (mínimo 10 caracteres)';
  end if;
  if char_length(v_texto) > 600 then
    raise exception 'El mensaje es muy largo (máximo 600 caracteres)';
  end if;
  if (select count(*) from quejas where matricula = v_yo and creado_en > now() - interval '24 hours') >= 5 then
    raise exception 'Ya enviaste 5 quejas en las últimas 24 horas. Intenta más tarde.';
  end if;

  select * into v_c from privado.censurar(v_texto);
  insert into quejas (matricula, nombre, categoria, camion, mensaje, censurada)
  values (v_yo, (select nombre from alumnos where matricula = v_yo), p_categoria, p_camion, v_c.texto, v_c.censurado)
  returning id into v_id;

  perform _senal('quejas');
  return json_build_object('id', v_id, 'censurada', v_c.censurado);
end;
$$;

create or replace function public.alumno_quejas(p_token uuid)
returns json language plpgsql security definer set search_path = 'public' as $$
declare
  v_yo text := _validar_sesion(p_token, array['Estudiante']);
begin
  return coalesce((
    select json_agg(json_build_object('id', id, 'creado_en', creado_en, 'categoria', categoria, 'camion', camion,
      'mensaje', mensaje, 'censurada', censurada, 'estado', estado, 'respuesta', respuesta, 'actualizada_en', actualizada_en)
      order by creado_en desc)
    from (select * from quejas where matricula = v_yo order by creado_en desc limit 20) q
  ), '[]'::json);
end;
$$;

-- ---------------------------------------------------------------------
-- 4. Chofer
-- ---------------------------------------------------------------------
-- Quejas sin autor
create or replace function public.chofer_quejas(p_token uuid)
returns json language plpgsql security definer set search_path = 'public' as $$
begin
  perform _validar_sesion(p_token, array['Chofer']);
  return coalesce((
    select json_agg(json_build_object('id', id, 'creado_en', creado_en, 'categoria', categoria, 'camion', camion,
      'mensaje', mensaje, 'estado', estado) order by creado_en desc)
    from (select * from quejas order by creado_en desc limit 100) q
  ), '[]'::json);
end;
$$;

create or replace function public.chofer_falla_reportar(p_token uuid, p_camion integer, p_tipo text, p_gravedad text, p_descripcion text)
returns json language plpgsql security definer set search_path = 'public' as $$
declare
  v_chofer text := _validar_sesion(p_token, array['Chofer']);
  v_texto text := privado.limpiar_texto(p_descripcion);
  v_c record;
  v_id bigint;
begin
  if p_camion is null or not exists (select 1 from estado_viaje where id = p_camion) then
    raise exception 'Ese camión no existe';
  end if;
  if p_tipo is null or p_tipo not in ('motor', 'frenos', 'llantas', 'luces', 'puertas', 'clima', 'electrico', 'otro') then
    raise exception 'Elige qué tipo de falla es';
  end if;
  if p_gravedad is null or p_gravedad not in ('baja', 'media', 'alta') then
    raise exception 'Indica qué tan grave es';
  end if;
  if char_length(v_texto) < 5 then
    raise exception 'Describe la falla (mínimo 5 caracteres)';
  end if;
  if char_length(v_texto) > 600 then
    raise exception 'La descripción es muy larga (máximo 600 caracteres)';
  end if;
  if (select count(*) from fallas where chofer = v_chofer and creado_en > now() - interval '24 hours') >= 15 then
    raise exception 'Ya enviaste 15 reportes en las últimas 24 horas. Avisa directamente a la administración.';
  end if;

  select * into v_c from privado.censurar(v_texto);
  insert into fallas (chofer, chofer_nombre, camion, tipo, gravedad, descripcion)
  values (v_chofer, (select nombre from choferes where licencia = v_chofer), p_camion, p_tipo, p_gravedad, v_c.texto)
  returning id into v_id;

  perform privado.log('Chofer', v_chofer, 'falla_reportada',
    jsonb_build_object('id', v_id, 'camion', p_camion, 'tipo', p_tipo, 'gravedad', p_gravedad));
  perform _senal('fallas');
  return json_build_object('id', v_id, 'censurada', v_c.censurado);
end;
$$;

-- Reportes de ambos camiones: el chofer sabe cómo está la unidad que maneja
create or replace function public.chofer_fallas(p_token uuid)
returns json language plpgsql security definer set search_path = 'public' as $$
declare
  v_chofer text := _validar_sesion(p_token, array['Chofer']);
begin
  return coalesce((
    select json_agg(json_build_object('id', id, 'creado_en', creado_en, 'camion', camion, 'tipo', tipo,
      'gravedad', gravedad, 'descripcion', descripcion, 'estado', estado, 'nota', nota,
      'chofer_nombre', chofer_nombre, 'mia', chofer = v_chofer, 'actualizada_en', actualizada_en)
      order by creado_en desc)
    from (select * from fallas order by creado_en desc limit 60) f
  ), '[]'::json);
end;
$$;

-- ---------------------------------------------------------------------
-- 5. Administración
-- ---------------------------------------------------------------------
create or replace function public.admin_buzon_pendientes(p_token uuid)
returns json language plpgsql security definer set search_path = 'public' as $$
begin
  perform _validar_sesion(p_token, array['Admin']);
  return json_build_object(
    'quejas', (select count(*) from quejas where estado = 'nueva'),
    'fallas', (select count(*) from fallas where estado = 'abierta')
  );
end;
$$;

-- Quejas con su autor
create or replace function public.admin_quejas(p_token uuid)
returns json language plpgsql security definer set search_path = 'public' as $$
begin
  perform _validar_sesion(p_token, array['Admin']);
  return coalesce((
    select json_agg(json_build_object('id', q.id, 'creado_en', q.creado_en, 'categoria', q.categoria, 'camion', q.camion,
      'mensaje', q.mensaje, 'censurada', q.censurada, 'estado', q.estado, 'respuesta', q.respuesta,
      'atendida_por', q.atendida_por, 'actualizada_en', q.actualizada_en,
      'matricula', q.matricula, 'nombre', coalesce(a.nombre, q.nombre), 'dado_de_baja', q.matricula is null)
      order by q.creado_en desc)
    from (select * from quejas order by creado_en desc limit 300) q
    left join alumnos a on a.matricula = q.matricula
  ), '[]'::json);
end;
$$;

create or replace function public.admin_queja_actualizar(p_token uuid, p_id bigint, p_estado text, p_respuesta text)
returns void language plpgsql security definer set search_path = 'public' as $$
declare
  v_admin text := _validar_sesion(p_token, array['Admin']);
  v_respuesta text := nullif(privado.limpiar_texto(p_respuesta), '');
  v_antes quejas%rowtype;
begin
  if p_estado is null or p_estado not in ('nueva', 'revision', 'atendida') then
    raise exception 'Estado inválido';
  end if;
  if char_length(coalesce(v_respuesta, '')) > 500 then
    raise exception 'La respuesta es muy larga (máximo 500 caracteres)';
  end if;
  select * into v_antes from quejas where id = p_id for update;
  if v_antes.id is null then
    raise exception 'La queja ya no existe';
  end if;

  update quejas
     set estado = p_estado, respuesta = v_respuesta, atendida_por = v_admin, actualizada_en = now()
   where id = p_id;

  -- El alumno se entera en su panel cuando le responden o se atiende su queja
  if v_antes.matricula is not null then
    if v_respuesta is not null and v_respuesta is distinct from v_antes.respuesta then
      perform _avisar(v_antes.matricula, 'queja_respondida', v_respuesta);
    elsif p_estado = 'atendida' and v_antes.estado <> 'atendida' then
      perform _avisar(v_antes.matricula, 'queja_atendida', 'La administración marcó tu queja como atendida.');
    end if;
  end if;

  perform privado.log('Admin', v_admin, 'queja_actualizada',
    jsonb_build_object('id', p_id, 'estado', p_estado, 'respondida', v_respuesta is not null));
  perform _senal('quejas');
end;
$$;

create or replace function public.admin_fallas(p_token uuid)
returns json language plpgsql security definer set search_path = 'public' as $$
begin
  perform _validar_sesion(p_token, array['Admin']);
  return coalesce((
    select json_agg(json_build_object('id', f.id, 'creado_en', f.creado_en, 'camion', f.camion, 'tipo', f.tipo,
      'gravedad', f.gravedad, 'descripcion', f.descripcion, 'estado', f.estado, 'nota', f.nota,
      'atendida_por', f.atendida_por, 'actualizada_en', f.actualizada_en,
      'chofer', f.chofer, 'chofer_nombre', coalesce(c.nombre, f.chofer_nombre, f.chofer))
      order by f.creado_en desc)
    from (select * from fallas order by creado_en desc limit 300) f
    left join choferes c on c.licencia = f.chofer
  ), '[]'::json);
end;
$$;

create or replace function public.admin_falla_actualizar(p_token uuid, p_id bigint, p_estado text, p_nota text)
returns void language plpgsql security definer set search_path = 'public' as $$
declare
  v_admin text := _validar_sesion(p_token, array['Admin']);
  v_nota text := nullif(privado.limpiar_texto(p_nota), '');
begin
  if p_estado is null or p_estado not in ('abierta', 'reparacion', 'resuelta') then
    raise exception 'Estado inválido';
  end if;
  if char_length(coalesce(v_nota, '')) > 500 then
    raise exception 'La nota es muy larga (máximo 500 caracteres)';
  end if;
  update fallas
     set estado = p_estado, nota = v_nota, atendida_por = v_admin, actualizada_en = now()
   where id = p_id;
  if not found then
    raise exception 'El reporte ya no existe';
  end if;
  perform privado.log('Admin', v_admin, 'falla_actualizada', jsonb_build_object('id', p_id, 'estado', p_estado));
  perform _senal('fallas');
end;
$$;

-- ---------------------------------------------------------------------
-- 6. Permisos: las funciones públicas validan el token de sesión
-- ---------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'alumno_queja_enviar(uuid, text, integer, text)', 'alumno_quejas(uuid)',
    'chofer_quejas(uuid)', 'chofer_falla_reportar(uuid, integer, text, text, text)', 'chofer_fallas(uuid)',
    'admin_buzon_pendientes(uuid)', 'admin_quejas(uuid)', 'admin_queja_actualizar(uuid, bigint, text, text)',
    'admin_fallas(uuid)', 'admin_falla_actualizar(uuid, bigint, text, text)'
  ] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
end;
$$;
