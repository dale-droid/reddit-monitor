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
// Tokens are HMAC-signed with the dashboard password so they survive server
// restarts without needing an in-memory session store.
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;

function signToken(payload) {
  const data = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', DASHBOARD_PASSWORD).update(data).digest('hex');
  return Buffer.from(JSON.stringify({ data, sig })).toString('base64');
}

function verifyToken(token) {
  try {
    const { data, sig } = JSON.parse(Buffer.from(token, 'base64').toString());
    const expected = crypto.createHmac('sha256', DASHBOARD_PASSWORD).update(data).digest('hex');
    if (sig !== expected) return null;
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function requireAuth(req, res, next) {
  const token = req.headers['x-session-token'];
  if (token && verifyToken(token)) return next();
  res.status(401).json({ error: 'Unauthorised' });
}

app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === DASHBOARD_PASSWORD) {
    const token = signToken({ loggedInAt: Date.now() });
    res.json({ token });
  } else {
    res.status(401).json({ error: 'Wrong password' });
  }
});

app.post('/api/logout', (req, res) => {
  // Client-side: browser removes the token from localStorage
  res.json({ ok: true });
});

// ─── Config ───────────────────────────────────────────────────────────────────
const CONFIG_DEFAULTS = {
  subreddits: [],
  keywords: [],
  themes: [],
  brandTerms: [
    { id:'bt1', term:'Green Coffee Collective', type:'own',        color:'#ff4500', active:true },
    { id:'bt2', term:'GCC',                     type:'own',        color:'#ff4500', active:true },
    { id:'bt3', term:'Small Batch Roasting',    type:'competitor', color:'#4e9eff', active:true },
    { id:'bt4', term:'Roast Rebels',            type:'competitor', color:'#a78bfa', active:true },
  ],
  pollIntervalMinutes: 15,
  minRelevanceScore: 7,
  brandVoiceDescription: '',
  brandVoiceUrls: [],
  brandVoiceCache: null,
  brandVoiceCachedAt: null,
  sitePageUrls: [],
};

async function getConfig() {
  const { data } = await supabase
    .from('config').select('value').eq('key', 'main').single();

  if (!data?.value) {
    // First run — persist defaults to Supabase so they survive restarts
    await supabase.from('config').upsert({ key: 'main', value: CONFIG_DEFAULTS }, { onConflict: 'key' });
    return CONFIG_DEFAULTS;
  }

  const cfg = data.value;

  // Backfill any missing fields so existing configs gain new features automatically
  let changed = false;
  if (!cfg.brandTerms || cfg.brandTerms.length === 0) {
    cfg.brandTerms = CONFIG_DEFAULTS.brandTerms;
    changed = true;
  }
  if (!cfg.themes) { cfg.themes = []; changed = true; }
  if (!cfg.sitePageUrls) { cfg.sitePageUrls = []; changed = true; }
  if (!cfg.brandVoiceUrls) { cfg.brandVoiceUrls = []; changed = true; }

  if (changed) {
    await supabase.from('config').upsert({ key: 'main', value: cfg }, { onConflict: 'key' });
  }

  return cfg;
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
    model: 'claude-sonnet-4-20250514', max_tokens: 600,
    messages: [{ role: 'user', content: `You are evaluating a Reddit post for a green coffee supplier that sells unroasted beans to home roasters and small roasters across Europe. Score how relevant this post is for engagement.

INTENT THEMES (what we want to find):
${themeList}

POST:
Title: ${post.title}
Body: ${(post.selftext || '').slice(0, 1000) || '(no body)'}
Subreddit: r/${post.subreddit}
Flair: ${post.flair || 'none'}

Score each theme 1-10 where:
- 8-10: Post is clearly about this topic, strong opportunity to engage helpfully
- 5-7: Post touches on this topic, moderate engagement opportunity  
- 1-4: Post barely relates to this theme

The overallScore should be the HIGHEST individual theme score (not an average).

Respond ONLY with valid JSON, no other text:
{
  "overallScore": <integer 1-10, must equal the highest themeScore>,
  "summary": "<one sentence neutral summary of what this post is asking or discussing>",
  "reason": "<one sentence explaining the engagement opportunity>",
  "topics": ["<topic1>", "<topic2>"],
  "themeScores": [
    { "themeId": "<exact theme name>", "score": <1-10>, "matches": <true if score >= 6> }
  ]
}` }]
  });

  const raw = res.content[0].text.trim().replace(/```json|```/g, '');
  const parsed = JSON.parse(raw);

  // Safety: ensure overallScore actually reflects theme scores
  const maxThemeScore = Math.max(...(parsed.themeScores || []).map(ts => ts.score || 0), 0);
  if (maxThemeScore > 0 && parsed.overallScore < maxThemeScore) {
    parsed.overallScore = maxThemeScore;
  }

  console.log(`  Eval: "${post.title.slice(0, 50)}" → ${parsed.overallScore}/10`);
  return parsed;
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
    ? `EXISTING SITE CONTENT (${sitePages.length} pages):\n` + sitePages.map(p => `URL: ${p.url}\n---\n${p.text}`).join('\n\n===\n\n')
    : 'No site pages provided — assume the site has minimal content.';
  const doneTitles = existingGaps.filter(g => g.status === 'done').map(g => `- "${g.title}"`);
  const inProgressTitles = existingGaps.filter(g => g.status === 'in_progress').map(g => `- "${g.title}"`);
  const existingContext = [
    doneTitles.length ? `GAPS ALREADY COMPLETED:\n${doneTitles.join('\n')}` : '',
    inProgressTitles.length ? `IN PROGRESS (skip these):\n${inProgressTitles.join('\n')}` : '',
  ].filter(Boolean).join('\n\n');

  // Include full post body for richness — not just titles
  const postSummaries = matches.slice(0, 100).map((m, i) => {
    const body = m.selftext ? m.selftext.slice(0, 300).replace(/\n+/g, ' ') : '';
    return `${i + 1}. [r/${m.subreddit}] "${m.title}"${body ? `\n   "${body}..."` : ''}`;
  }).join('\n\n');

  const voiceNote = voiceContext ? `Brand voice context:\n${voiceContext}\n\n` : '';

  const res = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514', max_tokens: 8000,
    messages: [{ role: 'user', content: `You are a senior content strategist conducting a COMPREHENSIVE content audit for a green coffee supplier called Green Coffee Collective (GCC). They sell unroasted/green beans to home roasters and small startup roasters across Europe, primarily the UK. Their sourcing model has three tiers: Staples (reliable everyday lots), Seasonal (crop-fresh rotating lots), and Rare & Special Lots.

${voiceNote}YOUR TASK:
Analyse every Reddit post below and produce an EXHAUSTIVE list of content gaps — things people are repeatedly asking, struggling with, or searching for that GCC's website doesn't cover well. Be thorough and specific. Do not be conservative. A comprehensive content strategy requires identifying ALL gaps, not just the obvious ones.

${siteContext}

${existingContext ? existingContext + '\n\n' : ''}REDDIT POSTS (${matches.length} posts from home roasting and specialty coffee communities):
${postSummaries}

ANALYSIS INSTRUCTIONS:
1. Read every post carefully. Identify ALL distinct questions, pain points, and information needs.
2. Group related questions into content pieces — one gap can address multiple related questions.
3. For each gap, check against the site content: is it missing entirely (type:"new"), partially covered (type:"update"), or a terminology definition needed (type:"glossary")?
4. Urgency: "high" = appears in 3+ posts or across 2+ subreddits, "medium" = 2 posts, "low" = 1 post but clearly important.
5. Include specific quotes from the posts as evidence — these are real words your audience uses.
6. Identify the exact recurring phrases and language — these are SEO gold and should inform your copy.
7. Think beyond the obvious: roast profiles for specific origins, processing method effects, storage, equipment compatibility, cupping and tasting notes, sourcing ethics, pricing transparency, subscription value, beginner mistakes, advanced techniques, origin deep-dives.

TARGET: Identify 12-20 content gaps minimum. This should be a comprehensive working list for a content calendar, not a light scan.

Respond ONLY with valid JSON:
{
  "summary": "<3-4 sentence executive summary of the dominant themes, patterns, and biggest opportunities>",
  "gaps": [
    {
      "title": "<specific, actionable content title>",
      "type": "<new|update|glossary>",
      "urgency": "<high|medium|low>",
      "needs_update": <bool>,
      "update_reason": "<if needs_update: specific gap in existing content>",
      "rationale": "<2-3 sentences: what people are asking, why this matters commercially, what GCC loses by not having it>",
      "angle": "<specific unique hook or approach that makes this piece stand out>",
      "contentType": "<blog|guide|faq|glossary|origin-profile|recipe|comparison>",
      "existingPage": <null or {"title":"page name","url":"url if known"}>,
      "sections": ["<section 1>","<section 2>","<section 3>","<section 4>","<section 5>"],
      "frequency": <integer: number of posts touching this gap>,
      "subreddits": ["<sub1>","<sub2>"],
      "recurringPhrases": ["<exact phrase 1>","<exact phrase 2>","<exact phrase 3>"],
      "evidence": [
        {"subreddit":"<sub>","score":<relevance 1-10>,"title":"<post title>","quote":"<direct quote showing the gap>","postedAgo":"<approximate age>"}
      ]
    }
  ]
}

Be exhaustive. A good content strategy for a specialist supplier like GCC should have at least 15 distinct pieces to work on.` }]
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
  const allFetchedPosts = []; // collect all posts for brand scan reuse

  console.log(`[${new Date().toLocaleTimeString()}] Polling ${config.subreddits.length} subreddit(s)...`);

  for (const subreddit of config.subreddits) {
    try {
      const posts = await fetchSubredditPosts(subreddit);
      allFetchedPosts.push(...posts); // collect for brand scan
      for (const post of posts) {
        if (seenIds.has(post.id)) continue;
        newSeenIds.push(post.id);
        newPostsChecked++;
        if (!passesKeywordFilter(post, config.keywords)) continue;
        if (!themes.length) continue;
        try {
          const evaluation = await evaluatePost(post, themes);
          const matchedThemeIds = (evaluation.themeScores || [])
            .filter(ts => ts.matches || ts.score >= 6)
            .map(ts => themes.find(t => t.name === ts.themeId)?.id)
            .filter(Boolean);
          const passes = evaluation.overallScore >= (config.minRelevanceScore || 7) && matchedThemeIds.length > 0;
          console.log(`  ${passes ? '✓' : '✗'} "${post.title.slice(0,50)}" score=${evaluation.overallScore} themes=${matchedThemeIds.length}`);
          if (passes) {
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
      const { data: allMatches } = await supabase.from('matches').select('title, subreddit, selftext, evaluation')
        .neq('status', 'dismissed').order('matched_at', { ascending: false }).limit(100);
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

  // Brand scan — pass already-fetched posts so we don't hit Reddit twice
  try {
    await runBrandScan(allFetchedPosts);
  } catch (e) { console.error('Brand scan error:', e.message); }
}

function schedulePoll(mins) {
  if (pollTimer) clearInterval(pollTimer);
  if (mins > 0) pollTimer = setInterval(runPoll, mins * 60 * 1000);
}

// ─── Brand monitor ────────────────────────────────────────────────────────────
// Crawls monitored subreddits directly rather than using Reddit's unreliable
// search API. Every post fetched during a poll is checked for brand term mentions.

async function getBrandTerms() {
  const config = await getConfig();
  const terms = config.brandTerms;
  if (terms?.length) return terms.filter(t => t.active !== false);
  return CONFIG_DEFAULTS.brandTerms;
}

function postMentionsBrand(post, term) {
  const text = `${post.title} ${post.selftext || ''}`.toLowerCase();
  return text.includes(term.toLowerCase());
}

async function analyseBrandMention(post, term, brandType) {
  const res = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514', max_tokens: 300,
    messages: [{ role: 'user', content: `Analyse this Reddit post that mentions "${term}" (a green coffee supplier). Respond ONLY with valid JSON.

POST:
Title: ${post.title}
Body: ${(post.selftext || '').slice(0, 800) || '(no body)'}
Subreddit: r/${post.subreddit}

{
  "relevant": <true if the post genuinely discusses this brand or a competing product in a coffee context, false if coincidental>,
  "sentiment": "<'positive' | 'neutral' | 'negative' | 'comparison' | 'warm_lead'>",
  "summary": "<one sentence summary of what is being said>",
  "context": "<the specific sentence or phrase mentioning the brand, or null>",
  "warmLeadReason": "<if warm_lead or negative competitor: why this person might be open to alternatives, else null>"
}

Use warm_lead when someone is unhappy with a competitor or actively shopping around for a new supplier.` }]
  });
  return JSON.parse(res.content[0].text.trim());
}

async function runBrandScan(postsToScan = null) {
  const brandTerms = await getBrandTerms();
  if (!brandTerms.length) { console.log('[Brand scan] No active terms — skipping.'); return null; }

  const config = await getConfig();
  const subreddits = config.subreddits || [];
  if (!subreddits.length) { console.log('[Brand scan] No subreddits configured — skipping.'); return null; }

  console.log(`[Brand scan] Scanning ${subreddits.length} subreddits for ${brandTerms.length} terms...`);

  // Use posts passed in from the poll loop, or fetch fresh
  let allPosts = postsToScan ? [...postsToScan] : [];
  if (!allPosts.length) {
    for (const subreddit of subreddits) {
      try {
        const posts = await fetchSubredditPosts(subreddit, 25);
        allPosts.push(...posts);
        console.log(`[Brand scan] Fetched ${posts.length} posts from r/${subreddit}`);
        await new Promise(r => setTimeout(r, 500));
      } catch (e) {
        console.error(`[Brand scan] Fetch failed r/${subreddit}: ${e.message}`);
      }
    }
  }

  console.log(`[Brand scan] Checking ${allPosts.length} posts against ${brandTerms.length} brand terms`);

  const existing = await supabase.from('config').select('value').eq('key', 'brand_mentions').single();
  const existingMentions = existing?.data?.value?.mentions || [];
  const existingById = {};
  existingMentions.forEach(m => { existingById[m.id] = m; });

  const seenPostIds = new Set();
  const freshMentions = [];
  const preservedDismissed = existingMentions.filter(m => m.dismissed);
  let newCount = 0;

  for (const brand of brandTerms) {
    const matchingPosts = allPosts.filter(p => postMentionsBrand(p, brand.term));
    console.log(`[Brand scan] "${brand.term}" — ${matchingPosts.length} matching posts`);

    for (const post of matchingPosts) {
      const postKey = post.id + brand.term;
      if (seenPostIds.has(postKey)) continue;
      seenPostIds.add(postKey);

      const mentionId = `bm_${post.id}_${brand.term.replace(/\s/g,'_')}`;

      if (existingById[mentionId] && !existingById[mentionId].dismissed) {
        freshMentions.push(existingById[mentionId]);
        continue;
      }
      if (existingById[mentionId]?.dismissed) continue;

      try {
        const analysis = await analyseBrandMention(post, brand.term, brand.type);
        if (!analysis.relevant) {
          console.log(`[Brand scan] ✗ Not relevant: "${post.title.slice(0,50)}"`);
          continue;
        }
        freshMentions.push({
          id: mentionId,
          brand: brand.term,
          brandType: brand.type,
          brandColor: brand.color || '#6b7080',
          subreddit: post.subreddit,
          title: post.title,
          author: post.author,
          url: post.url,
          postedAt: new Date(post.created_utc * 1000).toISOString(),
          sentiment: analysis.sentiment,
          summary: analysis.summary,
          context: analysis.context,
          warmLeadReason: analysis.warmLeadReason,
          dismissed: false,
        });
        newCount++;
        console.log(`[Brand scan] ✓ "${post.title.slice(0,60)}" (${brand.term} · ${analysis.sentiment})`);
        await new Promise(r => setTimeout(r, 300));
      } catch (e) {
        console.error(`[Brand scan] Analysis error: ${e.message}`);
      }
    }
  }

  const allMentions = [...freshMentions, ...preservedDismissed];
  const result = {
    mentions: allMentions,
    scannedAt: new Date().toISOString(),
    termCount: brandTerms.length,
    subredditsScanned: subreddits.length,
    postsChecked: allPosts.length,
  };
  await supabase.from('config').upsert({ key: 'brand_mentions', value: result }, { onConflict: 'key' });
  console.log(`[Brand scan] Done — ${newCount} new, ${freshMentions.length} total active, ${preservedDismissed.length} archived`);
  return result;
}

// Debug endpoint
app.get('/api/brand-mentions/debug', requireAuth, async (req, res) => {
  const config = await getConfig();
  const brandTerms = (config.brandTerms || []).filter(t => t.active !== false);
  if (!brandTerms.length) return res.json({ error: 'No active brand terms configured.' });
  const subreddits = config.subreddits || [];
  const samplePosts = [];
  for (const sub of subreddits.slice(0, 3)) {
    try { const posts = await fetchSubredditPosts(sub, 10); samplePosts.push(...posts); } catch (e) {}
  }
  const results = brandTerms.map(brand => ({
    term: brand.term,
    type: brand.type,
    matchesInSample: samplePosts.filter(p => postMentionsBrand(p, brand.term)).length,
    sampleMatches: samplePosts.filter(p => postMentionsBrand(p, brand.term)).slice(0,3).map(p => ({ title: p.title, subreddit: p.subreddit })),
  }));
  res.json({ subredditsChecked: subreddits.slice(0,3), postsInSample: samplePosts.length, results });
});

app.get('/api/brand-mentions', requireAuth, async (req, res) => {
  const { data } = await supabase.from('config').select('value').eq('key', 'brand_mentions').single();
  res.json(data?.value || null);
});

app.post('/api/brand-mentions/scan', requireAuth, async (req, res) => {
  try {
    const result = await runBrandScan();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/brand-mentions/:id/dismiss', requireAuth, async (req, res) => {
  const { data: existing } = await supabase.from('config').select('value').eq('key', 'brand_mentions').single();
  if (!existing?.value) return res.status(404).json({ error: 'Not found' });
  existing.value.mentions = existing.value.mentions.map(m =>
    m.id === req.params.id ? { ...m, dismissed: true, dismissedAt: new Date().toISOString() } : m
  );
  await supabase.from('config').upsert({ key: 'brand_mentions', value: existing.value }, { onConflict: 'key' });
  res.json({ ok: true });
});

app.post('/api/brand-mentions/:id/restore', requireAuth, async (req, res) => {
  const { data: existing } = await supabase.from('config').select('value').eq('key', 'brand_mentions').single();
  if (!existing?.value) return res.status(404).json({ error: 'Not found' });
  existing.value.mentions = existing.value.mentions.map(m =>
    m.id === req.params.id ? { ...m, dismissed: false, dismissedAt: null } : m
  );
  await supabase.from('config').upsert({ key: 'brand_mentions', value: existing.value }, { onConflict: 'key' });
  res.json({ ok: true });
});

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

  // Fetch from both flagged posts AND directly from subreddits for maximum depth
  const { data: flaggedMatches } = await supabase.from('matches')
    .select('title, subreddit, selftext, evaluation').neq('status', 'dismissed')
    .order('matched_at', { ascending: false }).limit(100);

  // Also fetch recent posts directly from all monitored subreddits
  const directPosts = [];
  for (const subreddit of (config.subreddits || []).slice(0, 6)) {
    try {
      const posts = await fetchSubredditPosts(subreddit, 25);
      directPosts.push(...posts.map(p => ({ title: p.title, subreddit: p.subreddit, selftext: p.selftext, evaluation: null })));
    } catch (e) { console.error(`Direct fetch failed for r/${subreddit}:`, e.message); }
  }

  // Merge, deduplicate by title
  const seenTitles = new Set();
  const allMatches = [...(flaggedMatches || []), ...directPosts].filter(m => {
    if (seenTitles.has(m.title)) return false;
    seenTitles.add(m.title);
    return true;
  });

  if (!allMatches.length) return res.status(400).json({ error: 'No posts found. Make sure you have subreddits configured.' });

  const existing = await supabase.from('config').select('value').eq('key', 'content_gaps').single();
  const existingGaps = existing?.data?.value?.gaps || [];
  const siteUrls = [...(config.brandVoiceUrls || []), ...(config.sitePageUrls || [])].filter(Boolean);

  try {
    const result = await runContentGapAnalysis(allMatches, config.brandVoiceCache || '', siteUrls, existingGaps);
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

app.get('/api/status', requireAuth, (req, res) => res.json({ isPolling, lastPollTime, lastPollStats }));
app.post('/api/poll', requireAuth, (req, res) => { runPoll(); res.json({ ok: true }); });

// ─── Deep crawl ───────────────────────────────────────────────────────────────
// Walks back through subreddit history page by page using Reddit's after param.
// Rate-limited and stoppable. Progress is written to Supabase so the UI can poll it.

let deepCrawlActive = false;
let deepCrawlAbort = false;

const CRAWL_DELAY_MS = 3000;   // 3s between pages — respectful to Reddit
const CRAWL_PAGE_SIZE = 100;   // max Reddit allows
const CRAWL_MAX_PAGES = 10;    // per subreddit — ~1000 posts, adjustable

async function fetchSubredditPage(subreddit, after = null) {
  let url = `https://www.reddit.com/r/${subreddit}/new.json?limit=${CRAWL_PAGE_SIZE}&raw_json=1`;
  if (after) url += `&after=${after}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'RedditMonitor/1.0 (greencoffeecollective.co.uk)' },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return {
    posts: (data.data.children || []).map(c => ({
      id: c.data.id,
      title: c.data.title,
      selftext: c.data.selftext || '',
      author: c.data.author,
      subreddit: c.data.subreddit,
      url: `https://reddit.com${c.data.permalink}`,
      score: c.data.score,
      num_comments: c.data.num_comments,
      flair: c.data.link_flair_text || null,
      created_utc: c.data.created_utc,
    })),
    after: data.data.after || null,
  };
}

async function fetchSubredditPostCount(subreddit) {
  // Reddit's about.json gives us subscriber count and approximate post counts
  // subscribers is not post count, but posts_per_day × age gives an estimate
  // More reliably: fetch the first page and use Reddit's dist (items per page) + their count field
  try {
    const url = `https://www.reddit.com/r/${subreddit}/about.json`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'RedditMonitor/1.0 (greencoffeecollective.co.uk)' },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) return null;
    const data = await res.json();
    // Reddit doesn't expose total post count publicly, but we can use
    // the number of subscribers as a proxy for activity level,
    // and cap our crawl target at maxPages * CRAWL_PAGE_SIZE
    return {
      subscribers: data.data?.subscribers || 0,
      title: data.data?.title || subreddit,
      // Estimate accessible posts: Reddit typically allows ~1000 posts back via API
      accessiblePosts: 1000,
    };
  } catch (e) {
    return null;
  }
}

async function updateCrawlProgress(progress) {
  await supabase.from('config').upsert({ key: 'crawl_progress', value: progress }, { onConflict: 'key' });
}

async function runDeepCrawl(subreddits, maxPages = CRAWL_MAX_PAGES) {
  if (deepCrawlActive) return { error: 'Crawl already running' };
  deepCrawlActive = true;
  deepCrawlAbort = false;

  const config = await getConfig();
  const themes = (config.themes || []).filter(t => t.active);
  const brandTerms = await getBrandTerms();
  const seenIds = await getSeenIds();
  const newSeenIds = [];

  // Fetch real subreddit info upfront so progress bar reflects actual post counts
  console.log('[Deep crawl] Fetching subreddit info...');
  const subredditInfo = {};
  for (const sub of subreddits) {
    const info = await fetchSubredditPostCount(sub);
    // Reddit API only allows ~1000 posts back. Our target is min(maxPages*100, 1000)
    const targetPosts = Math.min(maxPages * CRAWL_PAGE_SIZE, 1000);
    subredditInfo[sub] = {
      subscribers: info?.subscribers || 0,
      title: info?.title || sub,
      targetPosts,
      targetPages: Math.ceil(targetPosts / CRAWL_PAGE_SIZE),
    };
    console.log(`[Deep crawl] r/${sub}: ${(info?.subscribers||0).toLocaleString()} subscribers, targeting ${targetPosts} posts`);
    await new Promise(r => setTimeout(r, 500));
  }

  const progress = {
    status: 'running',
    startedAt: new Date().toISOString(),
    subreddits: subreddits.map(s => ({
      name: s,
      status: 'pending',
      subscribers: subredditInfo[s]?.subscribers || 0,
      targetPosts: subredditInfo[s]?.targetPosts || maxPages * CRAWL_PAGE_SIZE,
      targetPages: subredditInfo[s]?.targetPages || maxPages,
      pagesScanned: 0,
      postsScanned: 0,
      newMatches: 0,
      brandMentions: 0,
      lastAfter: null,
    })),
    totals: { pagesScanned: 0, postsScanned: 0, newMatches: 0, brandMentions: 0 },
    stoppedAt: null,
  };
  await updateCrawlProgress(progress);

  const allCrawledPosts = [];

  for (let si = 0; si < subreddits.length; si++) {
    if (deepCrawlAbort) break;
    const subreddit = subreddits[si];
    progress.subreddits[si].status = 'scanning';
    await updateCrawlProgress(progress);

    let after = null;
    let page = 0;
    const targetPages = progress.subreddits[si].targetPages;

    while (page < targetPages && !deepCrawlAbort) {
      try {
        console.log(`[Deep crawl] r/${subreddit} page ${page + 1}/${targetPages}${after ? ` after=${after}` : ''}`);
        const { posts, after: nextAfter } = await fetchSubredditPage(subreddit, after);

        if (!posts.length) { console.log(`[Deep crawl] r/${subreddit} no more posts`); break; }

        allCrawledPosts.push(...posts);
        progress.subreddits[si].pagesScanned++;
        progress.subreddits[si].postsScanned += posts.length;
        progress.totals.pagesScanned++;
        progress.totals.postsScanned += posts.length;

        // Intent matching on unseen posts
        const pageNewSeenIds = [];
        for (const post of posts) {
          if (seenIds.has(post.id) || newSeenIds.includes(post.id)) continue;
          newSeenIds.push(post.id);
          pageNewSeenIds.push(post.id);
          seenIds.add(post.id); // update in-memory set so next iteration is accurate

          if (!passesKeywordFilter(post, config.keywords) || !themes.length) continue;

          try {
            const evaluation = await evaluatePost(post, themes);
            const matchedThemeIds = (evaluation.themeScores || [])
              .filter(ts => ts.matches || ts.score >= 6)
              .map(ts => themes.find(t => t.name === ts.themeId)?.id)
              .filter(Boolean);
            if (evaluation.overallScore >= (config.minRelevanceScore || 7) && matchedThemeIds.length > 0) {
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
              }).onConflict('post_id').ignore();
              progress.subreddits[si].newMatches++;
              progress.totals.newMatches++;
              console.log(`[Deep crawl] ✓ Match: "${post.title.slice(0,60)}" (${evaluation.overallScore}/10)`);
            }
          } catch (e) { /* skip eval errors silently */ }
        }

        // Flush seen IDs after every page so progress survives a stop/restart
        if (pageNewSeenIds.length > 0) await markSeen(pageNewSeenIds);

        // Brand mention check on this page — full analysis, not just counting
        const existingBrandData = await supabase.from('config').select('value').eq('key', 'brand_mentions').single();
        const existingMentions = existingBrandData?.data?.value?.mentions || [];
        const existingById = {};
        existingMentions.forEach(m => { existingById[m.id] = m; });
        const newMentionsThisPage = [];

        for (const brand of brandTerms) {
          const matchingPosts = posts.filter(p => postMentionsBrand(p, brand.term));
          for (const post of matchingPosts) {
            const mentionId = `bm_${post.id}_${brand.term.replace(/\s/g,'_')}`;
            if (existingById[mentionId]) continue; // already stored

            try {
              const analysis = await analyseBrandMention(post, brand.term, brand.type);
              if (!analysis.relevant) continue;

              const mention = {
                id: mentionId,
                brand: brand.term,
                brandType: brand.type,
                brandColor: brand.color || '#6b7080',
                subreddit: post.subreddit,
                title: post.title,
                author: post.author,
                url: post.url,
                postedAt: new Date(post.created_utc * 1000).toISOString(),
                sentiment: analysis.sentiment,
                summary: analysis.summary,
                context: analysis.context,
                warmLeadReason: analysis.warmLeadReason,
                dismissed: false,
              };
              newMentionsThisPage.push(mention);
              existingById[mentionId] = mention; // prevent duplicates within this page
              progress.subreddits[si].brandMentions++;
              progress.totals.brandMentions++;
              console.log(`[Deep crawl] 👁 Brand mention: "${post.title.slice(0,50)}" (${brand.term} · ${analysis.sentiment})`);
              await new Promise(r => setTimeout(r, 300));
            } catch (e) {
              console.error(`[Deep crawl] Brand analysis error: ${e.message}`);
            }
          }
        }

        // Save new brand mentions to Supabase immediately so they appear in Brand Monitor
        if (newMentionsThisPage.length > 0) {
          const allMentions = [...existingMentions.filter(m => !newMentionsThisPage.find(n => n.id === m.id)), ...newMentionsThisPage];
          await supabase.from('config').upsert({
            key: 'brand_mentions',
            value: { mentions: allMentions, scannedAt: new Date().toISOString(), termCount: brandTerms.length }
          }, { onConflict: 'key' });
          console.log(`[Deep crawl] Saved ${newMentionsThisPage.length} new brand mentions to Brand Monitor`);
        }

        progress.subreddits[si].lastAfter = nextAfter; // save cursor for resume
        after = nextAfter;
        page++;
        await updateCrawlProgress(progress); // save progress after every page

        if (!after) { console.log(`[Deep crawl] r/${subreddit} reached end`); break; }

        // Respectful delay between pages
        await new Promise(r => setTimeout(r, CRAWL_DELAY_MS));

      } catch (e) {
        console.error(`[Deep crawl] Error on r/${subreddit} page ${page}: ${e.message}`);
        // Back off and retry once if rate limited
        if (e.message.includes('429') || e.message.includes('503')) {
          console.log('[Deep crawl] Rate limited — waiting 30s...');
          await new Promise(r => setTimeout(r, 30000));
        } else {
          break;
        }
      }
    }

    progress.subreddits[si].status = deepCrawlAbort ? 'stopped' : 'done';
    await updateCrawlProgress(progress);
  }

  progress.status = deepCrawlAbort ? 'stopped' : 'complete';
  progress.stoppedAt = new Date().toISOString();
  await updateCrawlProgress(progress);
  deepCrawlActive = false;
  console.log(`[Deep crawl] ${progress.status} — ${progress.totals.postsScanned} posts scanned, ${progress.totals.newMatches} new matches in Flagged Posts, ${progress.totals.brandMentions} brand mentions in Brand Monitor`);
  return progress;
}

app.post('/api/crawl/start', requireAuth, async (req, res) => {
  if (deepCrawlActive) return res.status(409).json({ error: 'Crawl already running' });
  const config = await getConfig();
  const { subreddits, maxPages } = req.body;
  const targets = subreddits || config.subreddits;
  if (!targets?.length) return res.status(400).json({ error: 'No subreddits specified' });
  res.json({ ok: true, message: `Starting deep crawl of ${targets.length} subreddit(s)` });
  runDeepCrawl(targets, maxPages || CRAWL_MAX_PAGES).catch(e => console.error('[Deep crawl] Fatal error:', e.message));
});

app.post('/api/crawl/stop', requireAuth, (req, res) => {
  deepCrawlAbort = true;
  res.json({ ok: true, message: 'Stop signal sent — crawl will finish current page and stop' });
});

app.get('/api/crawl/status', requireAuth, async (req, res) => {
  const { data } = await supabase.from('config').select('value').eq('key', 'crawl_progress').single();
  res.json(data?.value || { status: 'idle' });
});

// ─── Test poll — fetch one real post and evaluate it ─────────────────────────
app.post('/api/test-poll', requireAuth, async (req, res) => {
  const config = await getConfig();
  const themes = (config.themes || []).filter(t => t.active);
  if (!config.subreddits?.length) return res.status(400).json({ error: 'No subreddits configured yet.' });
  if (!themes.length) return res.status(400).json({ error: 'No active intent themes configured yet.' });

  const subreddit = config.subreddits[0];
  try {
    const posts = await fetchSubredditPosts(subreddit, 5);
    if (!posts.length) return res.status(400).json({ error: `No posts found in r/${subreddit}.` });
    const post = posts[0];
    const evaluation = await evaluatePost(post, themes);
    res.json({
      subreddit: post.subreddit,
      title: post.title,
      url: post.url,
      author: post.author,
      evaluation,
      themes: themes.map(t => ({ id: t.id, name: t.name, color: t.color })),
      message: `Successfully fetched and evaluated a real post from r/${subreddit}. Your pipeline is working.`
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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
