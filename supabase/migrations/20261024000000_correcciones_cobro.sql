-- =====================================================================
-- CAMIFY · Correcciones del cobro y del abordaje
--  1. Después del corte, la lista a bordo muestra lo que se cobró en él
--     (antes volvía a calcular y salía $0 para quien sí pagó $60).
--  2. La búsqueda del registro manual avisa si el adeudo pasa de $600.
--  3. Si otro alumno ganó el asiento al mismo tiempo, mensaje claro.
-- =====================================================================
alter table public.abordajes add column if not exists cobrado numeric;

-- 1. El corte guarda lo cobrado a cada uno
do $$
declare
  v text := pg_get_functiondef('public.chofer_hacer_corte(uuid,integer)'::regprocedure);
  a text := '  select coalesce(sum(monto), 0) into v_monto from historial_viajes where corte_id = v_corte;';
  b text := '  update abordajes b set cobrado = h.monto
    from historial_viajes h where h.corte_id = v_corte and h.matricula = b.matricula and b.camion = p_camion;

  select coalesce(sum(monto), 0) into v_monto from historial_viajes where corte_id = v_corte;';
begin
  if position(a in v) = 0 then
    raise exception 'chofer_hacer_corte cambió';
  end if;
  if position('set cobrado = h.monto' in v) = 0 then
    execute replace(v, a, b);
  end if;
end;
$$;

create or replace function public.chofer_abordajes(p_token uuid, p_camion integer)
returns json language plpgsql security definer set search_path = 'public' as $$
begin
  perform _validar_sesion(p_token, array['Chofer']);
  perform _camion_valido(p_camion);
  return coalesce((
    select json_agg(to_jsonb(b) || jsonb_build_object('cobro', coalesce(b.cobrado, privado.cobro_viaje(b.matricula)))
                    order by b.created_at)
    from abordajes b where b.camion = p_camion
  ), '[]'::json);
end;
$$;

-- 2. "bloqueado": el chofer ve en la búsqueda que no puede subir (sin mostrar cuánto debe)
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

  v_like := replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_');
  v_palabras := string_to_array(v_like, ' ');

  return coalesce((
    select json_agg(json_build_object('nombre', x.nombre, 'matricula', x.matricula, 'camion', x.camion,
                                      'bloqueado', x.bloqueado) order by x.orden, x.nombre)
    from (
      select a.nombre, a.matricula, b.camion, coalesce(a.saldo, 0) > 600 as bloqueado,
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

-- 3. Asiento ganado por otro al mismo tiempo
do $$
declare
  v text := pg_get_functiondef('public._abordar(integer,text,boolean,integer)'::regprocedure);
  a text := '      insert into reservas (fecha, hora, tipo, camion, asiento, matricula)
      values (v_s.fecha, v_s.hora, v_s.tipo, p_camion, p_asiento, p_matricula);';
  b text := '      begin
        insert into reservas (fecha, hora, tipo, camion, asiento, matricula)
        values (v_s.fecha, v_s.hora, v_s.tipo, p_camion, p_asiento, p_matricula);
      exception when unique_violation then
        raise exception ''El asiento % se acaba de ocupar. Elige otro.'', p_asiento;
      end;';
begin
  if position(a in v) > 0 then
    execute replace(v, a, b);
  elsif position('se acaba de ocupar' in v) = 0 then
    raise exception '_abordar cambió';
  end if;
end;
$$;
