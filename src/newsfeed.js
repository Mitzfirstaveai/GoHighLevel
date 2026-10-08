// Gujarat & India news: reads the headline feeds (RSS or Atom) of news sites the committee chooses, keeps
// each story's headline, a short summary and the link to the full article, and shows them to members.
// Full articles are never copied: "Read the full story" opens the newspaper's own website.
const { getContent } = require('./site');

// Topics members can filter by. The committee picks one for each source.
const TOPICS = ['Gujarat', 'India', 'Cricket & sports', 'Culture & faith', 'Food & recipes', 'Health & lifestyle', 'Business'];

// A source's language: Gujarati, English, or both (a feed that mixes them, like some Gujarat news sites).
const LANGS = ['gu', 'en', 'both'];

// Suggested starting sources. The committee can switch them off, remove them or add others (for example a
// Gujarati newspaper's feed) on the admin News page, where "Check now" shows whether each one works.
const DEFAULT_SOURCES = [
  { name: 'BBC News ગુજરાતી', url: 'https://feeds.bbci.co.uk/gujarati/rss.xml', lang: 'gu', topic: 'India' },
  { name: 'Indian Express: Ahmedabad', url: 'https://indianexpress.com/section/cities/ahmedabad/feed/', lang: 'en', topic: 'Gujarat' },
  { name: 'The Hindu: India', url: 'https://www.thehindu.com/news/national/feeder/default.rss', lang: 'en', topic: 'India' },
  { name: 'Indian Express: Cricket', url: 'https://indianexpress.com/section/sports/cricket/feed/', lang: 'en', topic: 'Cricket & sports' },
];

const SUMMARY_MAX = 700;        // a "quick read": a few sentences, never the whole article
const KEEP_PER_SOURCE = 60;
const KEEP_DAYS = 10;
const FETCH_TIMEOUT_MS = 15000;
const MAX_FEED_BYTES = 3 * 1024 * 1024;

function addDefaultSources(db) {
  const insert = db.prepare('INSERT OR IGNORE INTO news_sources (name, url, lang, topic) VALUES (?, ?, ?, ?)');
  for (const s of DEFAULT_SOURCES) insert.run(s.name, s.url, s.lang, s.topic);
}

// ---------- Reading feeds ----------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', hellip: '…', bull: '•', middot: '·', rupee: '₹' };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

// Feed text may contain HTML: keep only the words.
function cleanText(html) {
  return decodeEntities(String(html)
    .replace(/<(script|style|iframe|figure|figcaption)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/li>/gi, ' ')
    .replace(/<[^>]*>/g, ' '))
    .replace(/<[^>]*>/g, ' ')            // markup that was entity-encoded
    .replace(/\s+/g, ' ')
    .trim();
}

function shorten(text, max = SUMMARY_MAX) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const sentence = cut.lastIndexOf('. ');
  if (sentence > max * 0.6) return cut.slice(0, sentence + 1);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 0 ? cut.lastIndexOf(' ') : max).trim()}…`;
}

// The raw value of the first matching element (CDATA unwrapped, otherwise entities decoded once).
function field(block, names) {
  for (const name of names) {
    const m = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
    if (m && m[1].trim()) {
      const cdata = m[1].match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
      return cdata ? cdata[1] : decodeEntities(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'));
    }
  }
  return '';
}

function atomLink(block) {
  const links = [...block.matchAll(/<link\b([^>]*)>/gi)].map((m) => m[1]);
  const pick = links.find((a) => /rel\s*=\s*["']alternate["']/i.test(a)) || links.find((a) => !/rel\s*=/i.test(a)) || links[0];
  const href = pick?.match(/href\s*=\s*["']([^"']+)["']/i);
  return href ? decodeEntities(href[1]) : '';
}

// Only ordinary web links are ever shown to members.
function safeLink(url) {
  try {
    const u = new URL(String(url).trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

function utc(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

// Returns [{ guid, title, summary, link, published }] for RSS 2.0, RSS 1.0 (RDF) and Atom feeds.
function parseFeed(xml, now = new Date()) {
  const items = [];
  for (const m of String(xml).matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const block = m[2];
    const title = cleanText(field(block, ['title'])).slice(0, 300);
    const link = safeLink(cleanText(field(block, ['link'])) || atomLink(block) || field(block, ['guid']));
    if (!title || !link) continue;
    let summary = cleanText(field(block, ['description', 'summary']));
    if (summary.length < 120) {
      const longer = cleanText(field(block, ['content:encoded', 'content']));
      if (longer.length > summary.length) summary = longer;
    }
    if (summary === title) summary = '';
    const dateText = cleanText(field(block, ['pubDate', 'published', 'updated', 'dc:date']));
    let published = dateText ? new Date(dateText) : now;
    if (Number.isNaN(published.getTime()) || published > now) published = now;
    items.push({
      guid: (cleanText(field(block, ['guid', 'id'])) || link).slice(0, 500),
      title,
      summary: shorten(summary),
      link,
      published: utc(published),
    });
  }
  return items;
}

// Feed addresses are entered by admins; keep them to public websites.
function feedUrlProblem(url) {
  let u;
  try { u = new URL(String(url).trim()); } catch { return 'Please enter the full feed address, starting with https://'; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'Please enter the full feed address, starting with https://';
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.')
      || /^[\d.]+$/.test(host) || host.startsWith('[')) {
    return 'Please use the news website’s own address (not a computer or IP address).';
  }
  return null;
}

// ---------- Keeping it suitable ----------

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The filter word that hides this story, or null. Case is ignored. Ordinary English words also catch longer forms
// ("vote" hides "voters"); names and abbreviations written with a capital letter match whole words only ("Trump"
// doesn't hide "trumpet", "AAP" doesn't hide "map"). Gujarati words match anywhere.
function filterMatch(item, words) {
  const text = `${item.title} ${item.summary}`.toLowerCase();
  for (const raw of words) {
    const word = String(raw).trim();
    if (!word) continue;
    const w = word.toLowerCase();
    let hit;
    if (!/^[\x20-\x7e]+$/.test(w)) hit = text.includes(w);
    else if (/^[A-Z]/.test(word)) hit = new RegExp(`(^|[^a-z0-9])${escapeRe(w)}(s|es)?($|[^a-z0-9])`).test(text);
    else hit = new RegExp(`(^|[^a-z0-9])${escapeRe(w)}`).test(text);
    if (hit) return word;
  }
  return null;
}

function filterWords(db) {
  const words = getContent(db, 'news_filter');
  return Array.isArray(words) ? words : [];
}

// A story's language. For a source that publishes in both, the headline's script decides: any Gujarati letters → Gujarati.
const storyLang = (sourceLang, title) => (sourceLang !== 'both' ? sourceLang : /[\u0A80-\u0AFF]/.test(title) ? 'gu' : 'en');

// Recent stories members may see: enabled sources, not hidden by the committee, not caught by the filter.
function shownStories(db, topic = '') {
  const words = filterWords(db);
  return db.prepare(`
    SELECT i.*, s.name AS source_name, s.lang AS source_lang, s.topic FROM news_items i JOIN news_sources s ON s.id = i.source_id
    WHERE s.enabled = 1 AND i.hidden = 0 AND (? = '' OR s.topic = ?)
    ORDER BY i.published_at DESC, i.id DESC LIMIT 400
  `).all(topic, topic)
    .filter((r) => !filterMatch(r, words))
    .map((r) => ({ ...r, lang: storyLang(r.source_lang, r.title) }));
}

// Stories for the news page, newest first, optionally in one language ('gu' or 'en') and one topic.
function visibleNews(db, { lang = '', topic = '', limit = 30, offset = 0 } = {}) {
  const visible = shownStories(db, topic).filter((r) => !lang || r.lang === lang);
  return { items: visible.slice(offset, offset + limit), more: visible.length > offset + limit };
}

// Topics and languages that currently have stories, for the filter buttons.
function newsChoices(db) {
  const rows = shownStories(db);
  return {
    topics: TOPICS.filter((topic) => rows.some((r) => r.topic === topic)),
    langs: ['gu', 'en'].filter((lang) => rows.some((r) => r.lang === lang)),
  };
}

// ---------- Fetching ----------

// Downloads a feed: follows up to 3 redirects, checking each address the same way, and stops at MAX_FEED_BYTES.
async function download(url, fetchImpl) {
  for (let hop = 0; hop <= 3; hop++) {
    const problem = feedUrlProblem(url);
    if (problem) throw new Error(problem);
    const res = await fetchImpl(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        'User-Agent': 'GSA-member-app/1.0 (community news headlines)',
        Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5',
      },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location'), url).href;
      continue;
    }
    if (!res.ok) throw new Error(`The website answered with error ${res.status}.`);
    if (Number(res.headers.get('content-length')) > MAX_FEED_BYTES) throw new Error('The feed is too large.');
    if (!res.body) return res.text();
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > MAX_FEED_BYTES) throw new Error('The feed is too large.');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  throw new Error('The feed address redirects too many times.');
}

async function fetchSource(db, source, { fetchImpl = fetch } = {}) {
  const now = new Date();
  try {
    const items = parseFeed(await download(source.url, fetchImpl), now);
    if (!items.length) throw new Error('No headlines were found at this address. It may not be a news feed.');
    const upsert = db.prepare(`
      INSERT INTO news_items (source_id, guid, title, summary, link, published_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (source_id, guid) DO UPDATE SET title = excluded.title, summary = excluded.summary, link = excluded.link
    `);
    for (const it of items) upsert.run(source.id, it.guid, it.title, it.summary, it.link, it.published);
    db.prepare(`DELETE FROM news_items WHERE source_id = ? AND (published_at < ? OR id NOT IN (
      SELECT id FROM news_items WHERE source_id = ? ORDER BY published_at DESC, id DESC LIMIT ?))`)
      .run(source.id, utc(new Date(now.getTime() - KEEP_DAYS * 86400000)), source.id, KEEP_PER_SOURCE);
    db.prepare('UPDATE news_sources SET last_checked_at = ?, last_ok_at = ?, last_error = NULL WHERE id = ?')
      .run(utc(now), utc(now), source.id);
    return { ok: true, count: items.length };
  } catch (err) {
    const message = err.name === 'TimeoutError' ? 'The website took too long to answer.'
      : err.cause?.code === 'ENOTFOUND' ? 'That website could not be found.'
      : String(err.message || err).slice(0, 200);
    db.prepare('UPDATE news_sources SET last_checked_at = ?, last_error = ? WHERE id = ?').run(utc(now), message, source.id);
    return { ok: false, error: message };
  }
}

let running = null;
// Checks every switched-on source, one after another. Overlapping calls share the same run.
function refreshNews(db, opts = {}) {
  if (!running) {
    running = (async () => {
      for (const source of db.prepare('SELECT * FROM news_sources WHERE enabled = 1').all()) await fetchSource(db, source, opts);
    })().finally(() => { running = null; });
  }
  return running;
}

// Hourly refresh while the app runs (started by server.js, not in tests).
function startNewsRefresh(db, minutes = 60) {
  if (!(minutes > 0)) return;
  const run = () => refreshNews(db).catch((err) => console.error('News refresh failed:', err));
  setTimeout(run, 5000).unref();
  setInterval(run, minutes * 60 * 1000).unref();
}

module.exports = {
  TOPICS, LANGS, DEFAULT_SOURCES, addDefaultSources, parseFeed, cleanText, safeLink, feedUrlProblem, filterMatch, filterWords,
  visibleNews, newsChoices, fetchSource, refreshNews, startNewsRefresh,
};
