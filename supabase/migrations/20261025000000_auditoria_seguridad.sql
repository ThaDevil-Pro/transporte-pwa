-- CAMIFY · Correcciones de la auditoría de seguridad
--  1. El inicio de sesión tarda lo mismo exista o no la cuenta, para que no
--     se pueda averiguar qué matrículas o licencias existen midiendo el tiempo.
--  2. RLS también en las tablas de privado que no lo tenían (defensa en
--     profundidad: el esquema privado ya no es accesible desde la API).

-- 1. Mismo costo de bcrypt cuando la cuenta no existe
do $$
declare
  v text := pg_get_functiondef('public.login(text, text, text, text)'::regprocedure);
  a text := E'  if v_ref is null then\n    if v_conocido then';
  b text := E'  if v_ref is null then\n'
         || E'    -- Mismo tiempo de respuesta exista o no la cuenta: no revela qué identificadores existen\n'
         || E'    v_existe := case p_rol\n'
         || E'      when \'Estudiante\' then exists (select 1 from alumnos where matricula = v_ident)\n'
         || E'      when \'Chofer\' then exists (select 1 from choferes where licencia = v_ident)\n'
         || E'      when \'Admin\' then exists (select 1 from admins where usuario = v_ident)\n'
         || E'      else false\n'
         || E'    end;\n'
         || E'    if not v_existe and octet_length(coalesce(p_password, \'\')) between 1 and 200 then\n'
         || E'      perform crypt(p_password, gen_salt(\'bf\', 10));\n'
         || E'    end if;\n'
         || E'    if v_conocido then';
begin
  v := replace(v, E'\r\n', E'\n');
  if position('no revela qué identificadores existen' in v) > 0 then
    return;
  elsif position(a in v) = 0 then
    raise exception 'No se encontró el punto a modificar en login';
  end if;
  execute replace(v, a, b);
end $$;

-- 2. RLS en las tablas de privado que faltaban
alter table privado.diesel_cargas enable row level security;
alter table privado.diesel_tickets enable row level security;
alter table privado.diesel_tanques enable row level security;
alter table privado.cortes enable row level security;
