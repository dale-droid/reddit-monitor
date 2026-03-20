# Reddit Monitor v2 — Shared Setup Guide

Shared dashboard with password protection, real-time sync via Supabase, and hosted on Railway.

---

## Step 1 — Set up Supabase (shared database)

1. Go to https://supabase.com and create a free account
2. Click **New project** — give it a name like "reddit-monitor", pick a region close to you (EU West is fine), set a database password and save it somewhere
3. Wait ~2 minutes for it to provision
4. Go to **SQL Editor** (left sidebar) → **New query**
5. Copy the entire contents of `supabase-setup.sql` and paste it in, then click **Run**
6. Go to **Project Settings** → **API**
7. Copy these two values — you'll need them shortly:
   - **Project URL** (looks like `https://xxxxxxxxxxxx.supabase.co`)
   - **service_role** key (under "Project API keys" — use the `service_role` one, not `anon`)

---

## Step 2 — Deploy to Railway (hosting)

1. Go to https://railway.app and sign up (free tier is fine)
2. Click **New Project** → **Deploy from GitHub repo**
   - If prompted, connect your GitHub account
   - Push this folder to a GitHub repo first (or use Railway's drag-and-drop deploy)
3. Once deployed, go to your project → **Variables** tab and add these environment variables:

| Variable | Value |
|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic API key (sk-ant-...) |
| `SUPABASE_URL` | Your Supabase project URL from Step 1 |
| `SUPABASE_SERVICE_KEY` | Your Supabase service_role key from Step 1 |
| `DASHBOARD_PASSWORD` | A password you and your colleague will share |
| `PORT` | 3000 |

4. Railway will automatically redeploy after you add the variables
5. Go to **Settings** → **Networking** → **Generate Domain** — this gives you a public URL like `https://reddit-monitor-production.up.railway.app`

---

## Step 3 — Share with your colleague

Send them the Railway URL and the dashboard password. That's it — you'll both see the same matches, and when either of you marks a post as replied, the other will see it within 20 seconds (auto-refreshes).

---

## How to use it

1. Open your Railway URL in a browser
2. Enter the shared password
3. In the sidebar, add subreddits, keywords, and your intent
4. Click **Save & apply** — it starts polling immediately
5. Flagged posts appear in the main panel with a relevance score and summary
6. Click **Draft reply** to have Claude write a suggested response
7. Click **↗ Open on Reddit** to go directly to the post
8. Click **✓ Mark as replied** once you've replied — your colleague will see this too
9. Use the **All / Pending / Replied** filters to manage your queue

---

## Troubleshooting

**Posts aren't appearing** — check that your keywords aren't too restrictive. Try removing keywords entirely so all posts go to Claude for evaluation.

**Railway keeps restarting** — check the logs in Railway dashboard. Usually means an environment variable is missing or wrong.

**Supabase errors in logs** — double-check you used the `service_role` key, not the `anon` key.

**Reddit rate limiting** — the poller adds delays between posts. If you're monitoring many subreddits, increase the poll interval to 30+ minutes.
