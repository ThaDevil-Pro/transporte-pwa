-- CAMIFY · El buzón de quejas no acepta groserías ni insultos
-- Antes se tapaban con asteriscos y se guardaba la queja; ahora el mensaje no se envía.
-- Se detectan aunque se disfracen:
--   números o símbolos por letras (p3nd3j0, ch1ng4, put@, $hit), letras repetidas (putoooo),
--   ortografía cambiada (kbron, xinga, berga, güebón), letras separadas (p u t o, p.u.t.o),
--   asteriscos (f*ck, p*ta), abreviaturas (ptm, hdp, alv) e inglés.
-- Las palabras se comparan completas, así que vehículo, computadora o disputa no cuentan.

-- Forma "fonética" de una palabra: minúsculas, sin acentos, números de truco cambiados por
-- letras, solo letras, sonidos iguales unificados (c/k/q, s/z, b/v, ch/sh/x, y/ll/i, h muda)
-- y letras repetidas reducidas (la r doble se conserva: perra ≠ pera).
create or replace function privado.ofensa_forma(p text, p_uno text default 'i', p_ve text default 'b')
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  t text := lower(coalesce(p, ''));
begin
  t := translate(t, 'áàäâãéèëêíìïîóòöôõúùüûçµ', 'aaaaaeeeeiiiiooooouuuucu');
  t := translate(t, '03457896@$!|€£+', 'oeastbggasiielt');
  t := replace(t, '1', p_uno);
  t := regexp_replace(t, '[^a-zñ*]', '', 'g');
  t := replace(t, 'ph', 'f');
  t := replace(t, 'qu', 'k');
  t := replace(t, 'ch', 'x');
  t := replace(t, 'sh', 'x');
  t := regexp_replace(t, 'c([eiy])', 's\1', 'g');
  t := translate(t, 'cqzw', 'kksu');
  t := replace(t, 'v', p_ve);
  t := replace(t, 'll', 'i');
  t := translate(t, 'y', 'i');
  t := replace(t, 'h', '');
  t := regexp_replace(t, 'r{3,}', 'rr', 'g');
  t := regexp_replace(t, '([a-qs-zñ])\1+', '\1', 'g');
  return t;
end;
$$;

-- Lista de groserías e insultos en forma fonética (palabra completa)
create or replace function privado.ofensa_es(p text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p ~ ('^(' || array_to_string(array[
    -- groserías
    'put(o|a|os|as|it[oa]s?|as[oa]s?|isim[oa]s?|ead[oa]s?|ear|er[oa]s?|amadre|otes?)',
    'pendej[a-z]*', 'pinx(e|es|i|is|isim[oa]s?)', 'xing[a-z]*', 'berg(a|as|ota|otas|uita|uitas|as[oa]s?|on|ones)',
    'kul(o|os|er[oa]s?|ead[oa]s?|ear|ito)', 'ka?bron(a|as|es|sit[oa]s?|as[oa]s?)?',
    'mam(on|ona|ones|onas|ad[ao]s?|ar|asita|asitas)', 'jot(o|os|ito)', 'marik(a|as|on|ona|ones|onas)',
    'mierd(a|as|ita|os[oa]s?)', 'karaj(o|os)', 'koñ(o|a)', 'sorr(a|as|ita|itas)', 'perr(a|as|ita|itas)',
    'ojet(e|es)', 'panox(a|as)', 'g?uebon(a|as|es|ad[oa]s?)?', 'ij(o|u|ue|oe)(de)?put(a|o|as|os)',
    'malparid(o|a|os|as)', 'gonor{1,2}ea', 'jod(er|ido|ida|idos|idas|ete)', 'kojon(es)?',
    'kag(ar|ada|adas|ado|ados|on|ona|o)', 'pajer(o|a|os|as)', 'puñet(a|as|ero|eros)', 'nak(o|a|os|as)',
    'prostitut(a|as)', 'lakr(a|as)', 'bastard(o|a|os|as|s)?',
    -- insultos
    'idiot(a|as|o|os|s)?', 'imbesil(es)?', 'est[ou]pid(o|a|os|as)?', 'tarad(o|a|os|as)', 'mongol(o|a|ik[oa]s?)',
    'subnormal(es)?', 'babos(o|a|os|as)', 'mens(o|a|os|as)', 'tont(o|a|os|as|it[oa]s?)', 'pendej',
    -- inglés
    '(moter|mader)?fuk[a-z]*', 'fk', 'xit[a-z]*', 'bitx(es|i|ies)?', 'asxol(e|es)', 'bu[il]?xit', 'dikead(s)?', 'kunt(s)?',
    'uor(e|es)', 'slut(s)?', 'retard(ed|s)?', 'fag(ot|ots|s)?', 'nig(er|a|as|ers)', 'dumbas', 'moron(s)?',
    'stupid'
  ], '|') || ')$')
$$;

-- Abreviaturas: se revisan solo en minúsculas y sin símbolos (ptm no es una palabra)
create or replace function privado.ofensa_abrev(p text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select regexp_replace(translate(lower(coalesce(p, '')), '034578@$', 'oeastbas'), '[^a-z]', '', 'g')
         ~ '^(ptm|ctm|hdp|hdpm|alv|vrg|vrga|pndj[a-z]*|pnch[a-z]*|stfu|wtf|mf|kbron|kbrn|cbrn|hpta|hptm|ijueputa)$'
$$;

-- ¿Una "palabra" (ya sin espacios) es ofensiva? Prueba las variantes de 1 (i/l) y v (b/u)
-- y, si trae asteriscos o similares, cada vocal en su lugar (hasta dos).
create or replace function privado.ofensa_palabra(p text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_forma text;
  v_uno text;
  v_ve text;
  v_a text;
  v_b text;
begin
  if p is null or p = '' then return false; end if;
  if privado.ofensa_abrev(p) then return true; end if;
  foreach v_uno in array array['i', 'l'] loop
    foreach v_ve in array array['b', 'u'] loop
      v_forma := privado.ofensa_forma(translate(p, '#_?·•', '*****'), v_uno, v_ve);
      if v_forma = '' then continue; end if;
      if position('*' in v_forma) = 0 then
        if privado.ofensa_es(v_forma) then return true; end if;
      elsif length(v_forma) - length(replace(v_forma, '*', '')) <= 2 then
        foreach v_a in array array['a', 'e', 'i', 'o', 'u', ''] loop
          foreach v_b in array array['a', 'e', 'i', 'o', 'u', ''] loop
            if privado.ofensa_es(regexp_replace(regexp_replace(v_forma, '\*', v_a), '\*', v_b)) then
              return true;
            end if;
          end loop;
        end loop;
      end if;
    end loop;
  end loop;
  return false;
end;
$$;

-- Devuelve la primera palabra ofensiva tal como se escribió, o null si el texto está bien
create or replace function privado.ofensa(p_texto text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_tokens text[] := regexp_split_to_array(btrim(coalesce(p_texto, '')), '\s+');
  v_tok text;
  v_corrida text := '';
  v_original text := '';
  i int;
begin
  if p_texto ~ '🖕' then return '🖕'; end if;
  for i in 1 .. coalesce(array_length(v_tokens, 1), 0) loop
    v_tok := v_tokens[i];
    if privado.ofensa_palabra(v_tok) then
      return coalesce(nullif(regexp_replace(v_tok, '^[^[:alnum:]@$*]+|[^[:alnum:]@$*]+$', '', 'g'), ''), v_tok);
    end if;
    -- Letras sueltas seguidas ("p u t o") se juntan y se revisan como una palabra
    if length(regexp_replace(v_tok, '[^[:alnum:]@$*]', '', 'g')) = 1 then
      v_corrida := v_corrida || v_tok;
      v_original := btrim(v_original || ' ' || v_tok);
      if length(v_corrida) >= 2 and privado.ofensa_palabra(v_corrida) then return v_original; end if;
    else
      v_corrida := '';
      v_original := '';
    end if;
  end loop;
  return null;
end;
$$;

revoke all on function privado.ofensa_forma(text, text, text) from public, anon, authenticated;
revoke all on function privado.ofensa_es(text) from public, anon, authenticated;
revoke all on function privado.ofensa_abrev(text) from public, anon, authenticated;
revoke all on function privado.ofensa_palabra(text) from public, anon, authenticated;
revoke all on function privado.ofensa(text) from public, anon, authenticated;

-- La queja con groserías o insultos no se guarda
create or replace function public.alumno_queja_enviar(p_token uuid, p_categoria text, p_camion integer, p_mensaje text)
returns json language plpgsql security definer set search_path = 'public' as $$
declare
  v_yo text := _validar_sesion(p_token, array['Estudiante']);
  v_texto text := privado.limpiar_texto(p_mensaje);
  v_ofensa text;
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
  v_ofensa := privado.ofensa(v_texto);
  if v_ofensa is not null then
    raise exception 'Tu mensaje no se envió: tiene una grosería o un insulto («%»). Escríbelo con respeto y vuelve a intentarlo.', left(v_ofensa, 40)
      using errcode = 'CMF06';
  end if;
  if (select count(*) from quejas where matricula = v_yo and creado_en > now() - interval '24 hours') >= 5 then
    raise exception 'Ya enviaste 5 quejas en las últimas 24 horas. Intenta más tarde.';
  end if;

  insert into quejas (matricula, nombre, categoria, camion, mensaje, censurada)
  values (v_yo, (select nombre from alumnos where matricula = v_yo), p_categoria, p_camion, v_texto, false)
  returning id into v_id;

  perform _senal('quejas');
  return json_build_object('id', v_id, 'censurada', false);
end;
$$;
