-- Fija el search_path de las auxiliares de tiempo (aviso del linter de Supabase).
-- No consultan tablas, así que basta con un search_path vacío.
alter function public._ahora() set search_path = '';
alter function public._salida_ts(date, time) set search_path = '';
alter function public._salida_texto(date, time) set search_path = '';
