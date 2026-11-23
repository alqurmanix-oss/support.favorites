alter table public.aqx_favorites_support_tickets
  add column if not exists subject text not null default 'بلاغ دعم فني';
