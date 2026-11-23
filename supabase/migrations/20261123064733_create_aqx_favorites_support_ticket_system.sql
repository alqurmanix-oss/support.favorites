create table if not exists public.aqx_favorites_support_tickets (
  id uuid primary key default gen_random_uuid(),
  ticket_number text not null unique,
  tracking_token_hash text not null,
  reporter_user_id uuid,
  reporter_name text not null,
  reply_contact text,
  category text not null,
  custom_category text,
  details text not null,
  page_url text,
  status text not null default 'received'
    check (status in ('received','in_review','waiting_user','answered','resolved','closed')),
  ai_status text not null default 'not_configured'
    check (ai_status in ('not_configured','answered','escalated','failed')),
  ai_failure_reason text,
  telegram_status text not null default 'pending'
    check (telegram_status in ('pending','sent','failed','not_configured')),
  admin_email_status text not null default 'pending'
    check (admin_email_status in ('pending','sent','failed','not_configured')),
  last_replied_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists aqx_favorites_support_tickets_user_created_idx
  on public.aqx_favorites_support_tickets (reporter_user_id, created_at desc)
  where reporter_user_id is not null;
create index if not exists aqx_favorites_support_tickets_status_created_idx
  on public.aqx_favorites_support_tickets (status, created_at desc);
create table if not exists public.aqx_favorites_support_replies (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.aqx_favorites_support_tickets(id) on delete cascade,
  author_type text not null check (author_type in ('admin','system')),
  author_label text not null default 'AQX Support',
  body text not null check (char_length(btrim(body)) between 1 and 10000),
  visibility text not null default 'public' check (visibility in ('public','internal')),
  created_at timestamptz not null default now()
);
create index if not exists aqx_favorites_support_replies_ticket_created_idx
  on public.aqx_favorites_support_replies (ticket_id, created_at asc);
alter table public.aqx_favorites_support_tickets enable row level security;
alter table public.aqx_favorites_support_replies enable row level security;
revoke all on public.aqx_favorites_support_tickets from anon, authenticated;
revoke all on public.aqx_favorites_support_replies from anon, authenticated;
grant all on public.aqx_favorites_support_tickets to service_role;
grant all on public.aqx_favorites_support_replies to service_role;
