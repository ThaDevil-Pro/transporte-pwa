-- La deuda solo cuenta en dos reglas: apartar (hasta $60) y subir (hasta $600).
-- Antes, quien debía más de $60 y no había apartado recibía en automático el primer asiento
-- que nadie apartó y, si no quedaba ninguno, no podía subir ni de pie. Ahora sube como
-- cualquier alumno sin apartado: sentado si hay lugar, de pie si no.

CREATE OR REPLACE FUNCTION public._abordar(p_camion integer, p_matricula text, p_manual boolean, p_asiento integer DEFAULT NULL::integer)
 RETURNS json
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_nombre text;
  v_saldo numeric;
  v_ubic text;
  v_otro_camion int;
  v_s record;
  v_ocupa text;
  v_asiento int;
  v_ocupados int;
  v_de_pie boolean;
  v_asignado boolean := false;
  v_cap int := privado.capacidad(p_camion);
begin
  lock table abordajes in share row exclusive mode;
  perform privado.limpiar_viajes_viejos();

  if (select estado from estado_viaje where id = p_camion) = 'EN_CAMINO' then
    raise exception 'El corte de este viaje ya se hizo. Finaliza el viaje antes de subir a más alumnos.';
  end if;

  select nombre, saldo, ubicacion into v_nombre, v_saldo, v_ubic from alumnos where matricula = p_matricula;
  if v_nombre is null then
    raise exception 'Este alumno ya no está registrado';
  end if;

  if (select exclusivo_chinacates from estado_viaje where id = p_camion) and v_ubic is distinct from 'chinacates' then
    raise exception '% no es de Chinacates: este vehículo es exclusivo para alumnos de Chinacates.', split_part(v_nombre, ' ', 1);
  end if;

  select camion into v_otro_camion from abordajes where matricula = p_matricula;
  if v_otro_camion = p_camion then
    raise exception 'El alumno (%) ya está a bordo', p_matricula;
  elsif v_otro_camion is not null then
    raise exception 'El alumno (%) ya está a bordo de %', p_matricula, _camion_nombre(v_otro_camion);
  end if;

  if v_saldo > 600 then
    raise exception '% debe $% (el máximo es $600). Tiene que pagar en la administración antes de subir.',
      split_part(v_nombre, ' ', 1), to_char(v_saldo, 'FM999,990.00');
  end if;

  select * into v_s from _salida_actual(p_camion);

  -- Lugares ocupados: apartados de esta salida + sentados sin apartar
  if v_s.fecha is not null then
    select (select count(*) from reservas r
             where r.fecha = v_s.fecha and r.hora = v_s.hora and r.camion = p_camion)
         + (select count(*) from abordajes b
             where b.camion = p_camion and not b.de_pie
               and not exists (select 1 from reservas r where r.fecha = v_s.fecha and r.hora = v_s.hora
                                 and r.camion = p_camion and r.matricula = b.matricula))
      into v_ocupados;
  else
    select count(*) into v_ocupados from abordajes b where b.camion = p_camion and not b.de_pie;
  end if;

  if v_s.fecha is not null then
    if p_asiento is not null then
      if not exists (select 1 from privado.asientos_de(p_camion) a where a.n = p_asiento) then
        raise exception 'Asiento inválido';
      end if;
      select matricula into v_ocupa from reservas
      where fecha = v_s.fecha and hora = v_s.hora and camion = p_camion and asiento = p_asiento;
      if v_ocupa is not null and v_ocupa <> p_matricula then
        raise exception 'El asiento % ya está ocupado', p_asiento;
      end if;
      v_asignado := not exists (select 1 from reservas where fecha = v_s.fecha and hora = v_s.hora
                                  and camion = p_camion and matricula = p_matricula);
      delete from reservas where fecha = v_s.fecha and hora = v_s.hora and matricula = p_matricula;
      begin
        insert into reservas (fecha, hora, tipo, camion, asiento, matricula)
        values (v_s.fecha, v_s.hora, v_s.tipo, p_camion, p_asiento, p_matricula);
      exception when unique_violation then
        raise exception 'El asiento % se acaba de ocupar. Elige otro.', p_asiento;
      end;
    end if;
    select asiento into v_asiento from reservas
    where fecha = v_s.fecha and hora = v_s.hora and camion = p_camion and matricula = p_matricula;
  end if;

  -- Sin asiento propio y con todos los lugares ocupados: va de pie, deba o no (hasta $600)
  if v_asiento is null then
    v_de_pie := v_ocupados >= v_cap;
  else
    v_de_pie := false;
  end if;

  insert into abordajes (nombre, matricula, camion, manual, de_pie, asiento_asignado)
  values (v_nombre, p_matricula, p_camion, p_manual, v_de_pie, v_asignado);

  return json_build_object('nombre', v_nombre, 'asiento', v_asiento, 'de_pie', v_de_pie, 'asignado', false, 'ubicacion', v_ubic);
end;
$function$;
