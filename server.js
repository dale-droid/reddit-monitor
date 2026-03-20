const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ─── Clients ──────────────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── Auth ─────────────────────────────────────────────────────────────────────
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;
const sessions = new Set();

function requireAuth(req, res, next) {
  const token = req.headers['x-session-token'];
  if (token && sessions.has(token)) return next();
  res.status(401).json({ error: 'Unauthorised' });
}

app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === DASHBOARD_PASSWORD) {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.add(token);
    res.json({ token });
  } else {
    res.status(401).json({ error: 'Wrong password' });
  }
});

app.post('/api/logout', (req, res) => {
  sessions.delete(req.headers['x-session-token']);
  res.json({ ok: true });
});

// ─── Config ───────────────────────────────────────────────────────────────────
async function getConfig() {
  const { data } = await supabase
    .from('config').select('value').eq('key', 'main').single();
  return data?.value || {
    subreddits: [],
    keywords: [],
    themes: [],
    pollIntervalMinutes: 15,
    minRelevanceScore: 7,
    brandVoiceDescription: '',
    brandVoiceUrls: [],
    brandVoiceCache: null,
    brandVoiceCachedAt: null,
    sitePageUrls: [],
  };
}

async function setConfig(cfg) {
  await supabase.from('config')
    .upsert({ key: 'main', value: cfg }, { onConflict: 'key' });
}

app.get('/api/config', requireAuth, async (req, res) => res.json(await getConfig()));
app.post('/api/config', requireAuth, async (req, res) => {
  await setConfig(req.body);
  schedulePoll(req.body.pollIntervalMinutes);
  res.json({ ok: true });
});

// ─── Brand voice ──────────────────────────────────────────────────────────────
async function fetchPageText(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'RedditMonitor/1.0' },
      signal: AbortSignal.timeout(10000)
    });
    const html = await res.text();
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ').trim().slice(0, 3500);
  } catch (e) {
    console.error(`Failed to fetch ${url}:`, e.message);
    return null;
  }
}

async function buildBrandVoiceContext(cfg) {
  const parts = [];
  if (cfg.brandVoiceDescription?.trim()) {
    parts.push(`TONE GUIDANCE FROM OWNER:\n${cfg.brandVoiceDescription.trim()}`);
  }
  if (cfg.brandVoiceUrls?.length) {
    const texts = await Promise.all(cfg.brandVoiceUrls.map(fetchPageText));
    const combined = texts.filter(Boolean).join('\n\n---\n\n');
    if (combined) {
      const res = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514', max_tokens: 600,
        messages: [{ role: 'user', content: `Analyse this website copy and write a concise (200 word max) description of the brand's tone of voice — personality, how they communicate, recurring values, what they avoid. Focus purely on HOW they write.\n\nWEBSITE COPY:\n${combined}\n\nRespond with just the tone description, no preamble.` }]
      });
      parts.push(`TONE EXTRACTED FROM WEBSITE:\n${res.content[0].text.trim()}`);
    }
  }
  return parts.join('\n\n');
}

app.post('/api/brand-voice/refresh', requireAuth, async (req, res) => {
  const cfg = await getConfig();
  try {
    const voiceContext = await buildBrandVoiceContext(cfg);
    cfg.brandVoiceCache = voiceContext;
    cfg.brandVoiceCachedAt = new Date().toISOString();
    await setConfig(cfg);
    res.json({ ok: true, voiceContext, cachedAt: cfg.brandVoiceCachedAt });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Reddit ───────────────────────────────────────────────────────────────────
async function fetchSubredditPosts(subreddit, limit = 25) {
  const url = `https://www.reddit.com/r/${subreddit}/new.json?limit=${limit}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'RedditMonitor/1.0' } });
  if (!res.ok) throw new Error(`Reddit fetch failed for r/${subreddit}: ${res.status}`);
  const data = await res.json();
  return data.data.children.map(c => ({
    id: c.data.id,
    subreddit: c.data.subreddit,
    title: c.data.title,
    selftext: c.data.selftext || '',
    author: c.data.author,
    url: `https://reddit.com${c.data.permalink}`,
    created_utc: c.data.created_utc,
    score: c.data.score,
    num_comments: c.data.num_comments,
    flair: c.data.link_flair_text || null,
  }));
}

function passesKeywordFilter(post, keywords) {
  if (!keywords?.length) return true;
  const text = `${post.title} ${post.selftext}`.toLowerCase();
  return keywords.some(kw => text.includes(kw.toLowerCase()));
}

// ─── Claude: evaluate post against all active themes ─────────────────────────
async function evaluatePost(post, themes) {
  const themeList = themes.map((t, i) => `${i + 1}. "${t.name}": ${t.description}`).join('\n');
  const res = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514', max_tokens: 400,
    messages: [{ role: 'user', content: `Evaluate this Reddit post against each intent theme. Respond ONLY with valid JSON.

THEMES:
${themeList}

POST:
Title: ${post.title}
Body: ${post.selftext || '(no body)'}
Subreddit: r/${post.subreddit}
Flair: ${post.flair || 'none'}

{
  "overallScore": <integer 1-10>,
  "summary": "<one sentence neutral summary>",
  "reason": "<one sentence why this is or isn't relevant>",
  "topics": ["<topic1>", "<topic2>"],
  "themeScores": [
    { "themeId": "<theme name>", "score": <1-10>, "matches": <true|false> }
  ]
}` }]
  });
  return JSON.parse(res.content[0].text.trim());
}

// ─── Claude: draft reply ──────────────────────────────────────────────────────
async function generateDraftReply(post, themes, matchedThemeIds, voiceContext) {
  const matchedThemes = themes.filter(t => matchedThemeIds.includes(t.id));
  const themeContext = matchedThemes.length
    ? `This post matches: ${matchedThemes.map(t => t.name).join(', ')}.` : '';
  const voiceSection = voiceContext
    ? `BRAND VOICE:\n${voiceContext}\n\nApply naturally — sound like a knowledgeable person, not a brand account.`
    : 'Write in a warm, direct, knowledgeable tone. Helpful, not salesy.';

  const res = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514', max_tokens: 600,
    messages: [{ role: 'user', content: `Help write a genuine Reddit reply. ${themeContext}

${voiceSection}

RULES: Sound like a community member. Be helpful first. No CTAs, no marketing language. 3-5 short paragraphs max.

POST:
Title: ${post.title}
Body: ${post.selftext || '(no body)'}
Subreddit: r/${post.subreddit}

Write ONLY the reply. No preamble.` }]
  });
  return res.content[0].text.trim();
}

// ─── Claude: content gap analysis ────────────────────────────────────────────
async function fetchSitePageTexts(urls) {
  const results = await Promise.all(urls.map(async url => {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'RedditMonitor/1.0' }, signal: AbortSignal.timeout(10000) });
      const html = await res.text();
      const text = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000);
      return { url, text };
    } catch (e) { return { url, text: null }; }
  }));
  return results.filter(r => r.text);
}

async function runContentGapAnalysis(matches, voiceContext, siteUrls = [], existingGaps = []) {
  if (!matches.length) throw new Error('No matches to analyse');
  const sitePages = await fetchSitePageTexts(siteUrls);
  const siteContext = sitePages.length
    ? `EXISTING SITE CONTENT:\n` + sitePages.map(p => `URL: ${p.url}\n---\n${p.text}`).join('\n\n===\n\n')
    : 'No site pages provided.';
  const doneTitles = existingGaps.filter(g => g.status === 'done').map(g => `- "${g.title}"`);
  const inProgressTitles = existingGaps.filter(g => g.status === 'in_progress').map(g => `- "${g.title}"`);
  const existingContext = [
    doneTitles.length ? `GAPS COMPLETED:\n${doneTitles.join('\n')}` : '',
    inProgressTitles.length ? `IN PROGRESS:\n${inProgressTitles.join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
  const postSummaries = matches.slice(0, 60).map((m, i) => `${i + 1}. [r/${m.subreddit}] "${m.title}"`).join('\n');
  const voiceNote = voiceContext ? `Brand voice:\n${voiceContext}\n\n` : '';

  const res = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514', max_tokens: 4000,
    messages: [{ role: 'user', content: `Content strategist analysing Reddit posts for a green coffee supplier (sells unroasted beans to home roasters/small roasters across Europe).

${voiceNote}${siteContext}

${existingContext ? existingContext + '\n\n' : ''}FLAGGED POSTS (${matches.length}):
${postSummaries}

RULES:
1. Don't suggest gaps already well covered by the site.
2. Partially covered = update (type:"update") with existing page.
3. Missing = new content (type:"new") or glossary (type:"glossary").
4. Done gaps: only re-suggest if 3+ posts still ask — set needs_update:true.
5. Never suggest in-progress items.
6. Include real evidence with direct quotes.
7. Urgency: high=5+ posts or 2+ subreddits, medium=3-4, low=1-2.

Valid JSON only:
{
  "summary": "<2-3 sentence observation>",
  "gaps": [{
    "title": "<title>", "type": "<new|update|glossary>", "urgency": "<high|medium|low>",
    "needs_update": <bool>, "update_reason": "<if needs_update>",
    "rationale": "<why this matters>", "angle": "<specific approach>",
    "contentType": "<blog|guide|faq|glossary>",
    "existingPage": <null or {"title":"...","url":"..."}>,
    "sections": ["<s1>","<s2>","<s3>","<s4>"],
    "frequency": <int>, "subreddits": ["<sub>"],
    "recurringPhrases": ["<phrase>"],
    "evidence": [{"subreddit":"<sub>","score":<int>,"title":"<title>","quote":"<quote>","postedAgo":"<age>"}]
  }]
}

4-8 gaps, quality over quantity.` }]
  });

  const parsed = JSON.parse(res.content[0].text.trim().replace(/```json|```/g, ''));
  const existingByTitle = {};
  existingGaps.forEach(g => { existingByTitle[g.title.toLowerCase()] = g; });

  const mergedGaps = parsed.gaps.map(g => {
    const existing = existingByTitle[g.title.toLowerCase()];
    if (existing) {
      if (g.needs_update && existing.status === 'done') return { ...existing, ...g, status: 'needs_update', updatedAt: new Date().toISOString() };
      if (['todo', 'in_progress'].includes(existing.status)) return { ...existing, ...g, status: existing.status };
      return { ...existing, ...g };
    }
    return { ...g, id: `gap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, status: 'todo', createdAt: new Date().toISOString() };
  });

  return { summary: parsed.summary, gaps: mergedGaps, generatedAt: new Date().toISOString(), postCount: matches.length, sitePagesFetched: sitePages.length };
}

// ─── Seen posts ───────────────────────────────────────────────────────────────
async function getSeenIds() {
  const { data } = await supabase.from('seen_posts').select('post_id');
  return new Set((data || []).map(r => r.post_id));
}

async function markSeen(ids) {
  if (!ids.length) return;
  await supabase.from('seen_posts').upsert(ids.map(id => ({ post_id: id })), { onConflict: 'post_id', ignoreDuplicates: true });
}

// ─── Engagement refresh ───────────────────────────────────────────────────────
async function refreshEngagement(match) {
  try {
    const res = await fetch(`https://www.reddit.com/by_id/t3_${match.post_id}.json`, { headers: { 'User-Agent': 'RedditMonitor/1.0' } });
    if (!res.ok) return;
    const data = await res.json();
    const post = data?.data?.children?.[0]?.data;
    if (!post) return;
    const commentGrowth = post.num_comments - (match.comments_at_reply || 0);
    let engagement = 'low';
    if ((match.reply_upvotes || 0) >= 10 || commentGrowth >= 10) engagement = 'great';
    else if ((match.reply_upvotes || 0) >= 3 || commentGrowth >= 3) engagement = 'good';
    await supabase.from('matches').update({ current_comments: post.num_comments, engagement }).eq('id', match.id);
  } catch (e) { console.error('Engagement refresh failed:', e.message); }
}

// ─── Poll ─────────────────────────────────────────────────────────────────────
let pollTimer = null, isPolling = false, lastPollTime = null, lastPollStats = null;

async function runPoll() {
  if (isPolling) return;
  isPolling = true;
  lastPollTime = new Date().toISOString();
  const config = await getConfig();
  const themes = (config.themes || []).filter(t => t.active);
  const seenIds = await getSeenIds();
  let newPostsChecked = 0, newMatches = 0;
  const errors = [], newSeenIds = [];

  console.log(`[${new Date().toLocaleTimeString()}] Polling ${config.subreddits.length} subreddit(s)...`);

  for (const subreddit of config.subreddits) {
    try {
      const posts = await fetchSubredditPosts(subreddit);
      for (const post of posts) {
        if (seenIds.has(post.id)) continue;
        newSeenIds.push(post.id);
        newPostsChecked++;
        if (!passesKeywordFilter(post, config.keywords)) continue;
        if (!themes.length) continue;
        try {
          const evaluation = await evaluatePost(post, themes);
          const matchedThemeIds = (evaluation.themeScores || [])
            .filter(ts => ts.matches && ts.score >= config.minRelevanceScore)
            .map(ts => themes.find(t => t.name === ts.themeId)?.id)
            .filter(Boolean);
          if (evaluation.overallScore >= config.minRelevanceScore && matchedThemeIds.length > 0) {
            await supabase.from('matches').insert({
              post_id: post.id, subreddit: post.subreddit, title: post.title,
              selftext: post.selftext, author: post.author, url: post.url,
              flair: post.flair, created_utc: post.created_utc,
              evaluation: { ...evaluation, matchedThemeIds },
              matched_themes: matchedThemeIds,
              matched_at: new Date().toISOString(),
              status: 'active', replied: false, replied_at: null,
              archived_at: null, archive_reason: null, draft_reply: null,
              engagement: null, comments_at_reply: null,
              current_comments: post.num_comments, reply_upvotes: null,
            });
            newMatches++;
            console.log(`  ✓ r/${subreddit}: "${post.title.slice(0, 60)}" (${evaluation.overallScore}/10)`);
          }
        } catch (e) { console.error(`  Eval error ${post.id}:`, e.message); }
        await new Promise(r => setTimeout(r, 500));
      }
    } catch (e) { errors.push(`r/${subreddit}: ${e.message}`); console.error(`  Error r/${subreddit}:`, e.message); }
  }

  await markSeen(newSeenIds);
  lastPollStats = { newPostsChecked, newMatches, errors };
  isPolling = false;
  console.log(`[${new Date().toLocaleTimeString()}] Done. Checked: ${newPostsChecked}, Matched: ${newMatches}`);

  // Refresh engagement on recently replied posts
  const { data: repliedPosts } = await supabase.from('matches').select('*').eq('replied', true)
    .not('reply_upvotes', 'is', null).gte('replied_at', new Date(Date.now() - 7 * 86400000).toISOString());
  if (repliedPosts?.length) {
    for (const m of repliedPosts.slice(0, 10)) { await refreshEngagement(m); await new Promise(r => setTimeout(r, 500)); }
  }

  // Auto content gap analysis
  if (newMatches > 0) {
    try {
      const { data: allMatches } = await supabase.from('matches').select('title, subreddit, evaluation')
        .neq('status', 'dismissed').order('matched_at', { ascending: false }).limit(60);
      const existing = await supabase.from('config').select('value').eq('key', 'content_gaps').single();
      const existingGaps = existing?.data?.value?.gaps || [];
      const siteUrls = [...(config.brandVoiceUrls || []), ...(config.sitePageUrls || [])].filter(Boolean);
      if (allMatches?.length) {
        const result = await runContentGapAnalysis(allMatches, config.brandVoiceCache || '', siteUrls, existingGaps);
        await supabase.from('config').upsert({ key: 'content_gaps', value: result }, { onConflict: 'key' });
        console.log(`Content gaps updated — ${result.gaps.length} gaps.`);
      }
    } catch (e) { console.error('Content gap analysis error:', e.message); }
  }
}

function schedulePoll(mins) {
  if (pollTimer) clearInterval(pollTimer);
  if (mins > 0) pollTimer = setInterval(runPoll, mins * 60 * 1000);
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/api/matches', requireAuth, async (req, res) => {
  const { data } = await supabase.from('matches').select('*').eq('status', 'active').order('matched_at', { ascending: false });
  res.json(data || []);
});

app.get('/api/matches/archived', requireAuth, async (req, res) => {
  const { data } = await supabase.from('matches').select('*').eq('status', 'archived').order('archived_at', { ascending: false });
  res.json(data || []);
});

app.post('/api/matches/:id/archive', requireAuth, async (req, res) => {
  const { reason } = req.body;
  const now = new Date().toISOString();
  const update = { status: 'archived', archived_at: now, archive_reason: reason };
  if (reason === 'replied') {
    const { data: match } = await supabase.from('matches').select('current_comments').eq('id', req.params.id).single();
    update.replied = true; update.replied_at = now;
    update.comments_at_reply = match?.current_comments || 0;
    update.engagement = 'low';
  }
  await supabase.from('matches').update(update).eq('id', req.params.id);
  res.json({ ok: true });
});

app.post('/api/matches/:id/restore', requireAuth, async (req, res) => {
  await supabase.from('matches').update({ status: 'active', archived_at: null, archive_reason: null, replied: false, replied_at: null }).eq('id', req.params.id);
  res.json({ ok: true });
});

app.post('/api/matches/:id/upvotes', requireAuth, async (req, res) => {
  const { upvotes } = req.body;
  let engagement = 'low';
  if (upvotes >= 10) engagement = 'great';
  else if (upvotes >= 3) engagement = 'good';
  await supabase.from('matches').update({ reply_upvotes: upvotes, engagement }).eq('id', req.params.id);
  res.json({ ok: true });
});

app.post('/api/matches/:id/draft', requireAuth, async (req, res) => {
  const config = await getConfig();
  const { data: match } = await supabase.from('matches').select('*').eq('id', req.params.id).single();
  if (!match) return res.status(404).json({ error: 'Not found' });
  try {
    const draft = await generateDraftReply(match, config.themes || [], match.matched_themes || [], config.brandVoiceCache || '');
    await supabase.from('matches').update({ draft_reply: draft }).eq('id', req.params.id);
    res.json({ draft });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/content-gaps', requireAuth, async (req, res) => {
  const { data } = await supabase.from('config').select('value').eq('key', 'content_gaps').single();
  res.json(data?.value || null);
});

app.post('/api/content-gaps/analyse', requireAuth, async (req, res) => {
  const config = await getConfig();
  const { data: matches } = await supabase.from('matches').select('title, subreddit, evaluation')
    .neq('status', 'dismissed').order('matched_at', { ascending: false }).limit(60);
  if (!matches?.length) return res.status(400).json({ error: 'No matches to analyse yet.' });
  const existing = await supabase.from('config').select('value').eq('key', 'content_gaps').single();
  const existingGaps = existing?.data?.value?.gaps || [];
  const siteUrls = [...(config.brandVoiceUrls || []), ...(config.sitePageUrls || [])].filter(Boolean);
  try {
    const result = await runContentGapAnalysis(matches, config.brandVoiceCache || '', siteUrls, existingGaps);
    await supabase.from('config').upsert({ key: 'content_gaps', value: result }, { onConflict: 'key' });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/content-gaps/:gapId/status', requireAuth, async (req, res) => {
  const { status } = req.body;
  const { data: existing } = await supabase.from('config').select('value').eq('key', 'content_gaps').single();
  if (!existing?.value) return res.status(404).json({ error: 'No gaps found' });
  const result = existing.value;
  result.gaps = result.gaps.map(g => g.id !== req.params.gapId ? g : {
    ...g, status,
    ...(status === 'done' ? { done_at: new Date().toISOString() } : {}),
    ...(status === 'in_progress' ? { started_at: new Date().toISOString() } : {}),
  });
  await supabase.from('config').upsert({ key: 'content_gaps', value: result }, { onConflict: 'key' });
  res.json({ ok: true });
});

app.get('/api/status', requireAuth, (req, res) => res.json({ isPolling, lastPollTime, lastPollStats }));
app.post('/api/poll', requireAuth, (req, res) => { runPoll(); res.json({ ok: true }); });

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`\n🟢 Reddit Monitor running on port ${PORT}\n`);
  const config = await getConfig();
  if (config.subreddits?.length > 0) {
    schedulePoll(config.pollIntervalMinutes || 15);
    runPoll();
  } else {
    console.log('No subreddits configured yet. Open the dashboard to set up.\n');
  }
});
