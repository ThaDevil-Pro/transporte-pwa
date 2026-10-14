-- =====================================================================
-- CAMIFY · Solo se aceptan los camiones registrados
-- Antes cualquier número del 1 al 9 era válido y, si no existía, se
-- creaba un camión sin nombre en estado_viaje.
-- =====================================================================
create or replace function public._camion_valido(p_camion integer)
returns void language plpgsql set search_path = 'public' as $$
begin
  if p_camion is null or not exists (select 1 from estado_viaje where id = p_camion) then
    raise exception 'Ese camión no existe';
  end if;
end;
$$;
