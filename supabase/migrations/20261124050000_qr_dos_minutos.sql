-- El código QR se acepta hasta 2 minutos después de que apareció en pantalla (2026-11-23)
-- La imagen sigue cambiando cada 30 s (privado.qr_ventana); solo se amplía la tolerancia al escanear:
-- antes, de 2 ventanas atrás (60 a 90 s); ahora, 4 ventanas atrás (2 a 2.5 min).
-- No se cambia el periodo: los celulares guardan 2 horas de códigos para usarlos sin señal.
create or replace function public.chofer_registrar_abordaje(p_token uuid, p_camion integer, p_matricula text)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
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

  if v_ventana < v_actual - 4 or v_ventana > v_actual + 1 then
    perform privado.log('Chofer', v_chofer, 'qr_rechazado', jsonb_build_object('motivo', 'vencido', 'camion', p_camion, 'matricula', v_matricula));
    return json_build_object('error', 'Código vencido. Pide al alumno que lo vuelva a abrir.');
  end if;

  return _abordar(p_camion, v_matricula, false);
end;
$function$;
