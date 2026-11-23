create or replace function public.aqx_favorites_support_extract_subject()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  first_line text;
  prefix text := 'عنوان البلاغ: ';
begin
  first_line := split_part(coalesce(new.details,''), E'\n', 1);
  if new.subject = 'بلاغ دعم فني' and left(first_line, length(prefix)) = prefix then
    new.subject := nullif(btrim(substr(first_line, length(prefix) + 1)), '');
    new.details := ltrim(substr(new.details, length(first_line) + 1), E'\n');
    if new.subject is null then new.subject := 'بلاغ دعم فني'; end if;
  end if;
  return new;
end;
$$;
drop trigger if exists aqx_favorites_support_extract_subject on public.aqx_favorites_support_tickets;
create trigger aqx_favorites_support_extract_subject
before insert on public.aqx_favorites_support_tickets
for each row execute function public.aqx_favorites_support_extract_subject();
