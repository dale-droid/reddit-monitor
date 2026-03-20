-- Reddit Monitor — Supabase setup
-- Run this entire file in your Supabase SQL Editor (Dashboard → SQL Editor → New query → Run)

-- Config table
create table if not exists config (
  key text primary key,
  value jsonb not null
);

-- Matched posts
create table if not exists matches (
  id uuid primary key default gen_random_uuid(),
  post_id text not null unique,
  subreddit text not null,
  title text not null,
  selftext text,
  author text,
  url text,
  flair text,
  created_utc bigint,
  evaluation jsonb,
  matched_themes text[],
  matched_at timestamptz default now(),
  status text default 'active',
  replied boolean default false,
  replied_at timestamptz,
  archived_at timestamptz,
  archive_reason text,
  draft_reply text,
  engagement text,
  comments_at_reply integer,
  current_comments integer,
  reply_upvotes integer
);

-- Seen posts
create table if not exists seen_posts (
  post_id text primary key,
  seen_at timestamptz default now()
);

-- Indexes
create index if not exists matches_status_idx on matches(status);
create index if not exists matches_matched_at_idx on matches(matched_at desc);
create index if not exists matches_replied_idx on matches(replied);
create index if not exists matches_archived_at_idx on matches(archived_at desc);
