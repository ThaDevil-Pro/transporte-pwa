-- =====================================================================
-- CAMIFY · Camiones con nombre y color
--  Los camiones 1 y 2 se reemplazan por cuatro: Rojo, Blanco, Amarillo
--  y Gris (ids 1 a 4, así no cambia nada de lo que ya usa el número).
--  Los mensajes del servidor dicen "camión Rojo" en lugar de "camión 1".
-- =====================================================================
alter table public.estado_viaje add column if not exists nombre text;
alter table public.estado_viaje add column if not exists color text;

insert into public.estado_viaje (id, estado, temporizador_activo, tiempo_salida, nombre, color)
values
  (1, 'ESPERANDO', false, null, 'Rojo', '#ff3b30'),
  (2, 'ESPERANDO', false, null, 'Blanco', '#f2f2f7'),
  (3, 'ESPERANDO', false, null, 'Amarillo', '#ffcc00'),
  (4, 'ESPERANDO', false, null, 'Gris', '#8e8e93')
on conflict (id) do update set nombre = excluded.nombre, color = excluded.color;

-- Nombre corto del camión para los mensajes ("Rojo", o el número si no tiene)
create or replace function public._camion_nombre(p_camion integer)
returns text language sql stable security definer set search_path = 'public' as $$
  select coalesce((select nombre from estado_viaje where id = p_camion), p_camion::text);
$$;
revoke all on function public._camion_nombre(integer) from public, anon, authenticated;

-- Mensajes con el número del camión: se cambia solo el dato que se muestra
do $$
declare
  v text;
  f text;
  cambios text[][] := array[
    array['public.alumno_apartar(uuid,date,time without time zone,integer,integer,boolean)',
          '_salida_texto(p_fecha, p_hora), p_camion, v_vecino', '_salida_texto(p_fecha, p_hora), _camion_nombre(p_camion), v_vecino'],
    array['public.alumno_apartar(uuid,date,time without time zone,integer,integer,boolean)',
          '_salida_texto(p_fecha, p_hora), p_camion, _nombre_corto', '_salida_texto(p_fecha, p_hora), _camion_nombre(p_camion), _nombre_corto'],
    array['public._abordar(integer,text,boolean)',
          'p_matricula, v_otro_camion;', 'p_matricula, _camion_nombre(v_otro_camion);']
  ];
  i int;
begin
  for i in 1 .. array_length(cambios, 1) loop
    f := cambios[i][1];
    v := pg_get_functiondef(f::regprocedure);
    if position(cambios[i][2] in v) > 0 then
      execute replace(v, cambios[i][2], cambios[i][3]);
    elsif position(cambios[i][3] in v) = 0 then
      raise exception 'La función % cambió; revisa sus mensajes', f;
    end if;
  end loop;
end;
$$;
