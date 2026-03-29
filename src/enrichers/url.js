/**
 * url.js — Enrich messages by fetching metadata for URLs found in content.
 *
 * Before messages go to the LLM, this enricher:
 * 1. Finds URLs in message text
 * 2. Fetches title + og:description (or meta description)
 * 3. For GitHub repos, uses the API to get description + stars
 * 4. Inlines the metadata so the LLM can extract meaningful facts
 *
 * Gracefully handles failures — if a URL can't be fetched, it's left as-is.
 */

const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/g;
const GITHUB_REPO_REGEX = /^https?:\/\/github\.com\/([^/]+)\/([^/\s#?]+)/;

const DEFAULT_OPTIONS = {
  maxUrls: 10,         // max URLs to enrich per batch
  timeoutMs: 3000,     // per-URL fetch timeout (keep low — failures are non-fatal)
  userAgent: 'lizardbrain/0.6 (link enrichment)',
};

/**
 * Enrich an array of messages by resolving URL metadata inline.
 * Mutates message.content in place.
 */
async function enrichMessages(messages, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // Collect all unique URLs across messages
  const urlMap = new Map(); // url -> { messageIndexes, metadata }
  for (let i = 0; i < messages.length; i++) {
    const urls = (messages[i].content || '').match(URL_REGEX) || [];
    for (const url of urls) {
      const clean = url.replace(/[.,;:!?)]+$/, ''); // strip trailing punctuation
      if (!urlMap.has(clean)) {
        urlMap.set(clean, { indexes: [i], metadata: null });
      } else {
        urlMap.get(clean).indexes.push(i);
      }
    }
  }

  if (urlMap.size === 0) return { enriched: 0, failed: 0 };

  // Limit URLs to process
  const urlsToProcess = [...urlMap.keys()].slice(0, opts.maxUrls);
  let enriched = 0;
  let failed = 0;

  // Fetch metadata for each URL
  await Promise.all(urlsToProcess.map(async (url) => {
    try {
      const meta = await fetchUrlMetadata(url, opts);
      if (meta) {
        urlMap.get(url).metadata = meta;
        enriched++;
      } else {
        failed++;
      }
    } catch {
      failed++;
    }
  }));

  // Inline metadata into message content
  for (const [url, { metadata }] of urlMap) {
    if (!metadata) continue;

    let enrichedUrl = url;
    if (metadata.stars != null) {
      enrichedUrl = `${url} [${metadata.title || ''}${metadata.description ? ' — ' + metadata.description : ''} | ${metadata.stars} stars]`;
    } else if (metadata.title || metadata.description) {
      const parts = [metadata.title, metadata.description].filter(Boolean);
      enrichedUrl = `${url} [${parts.join(' — ')}]`;
    }

    // Replace in all messages that contain this URL
    for (const idx of urlMap.get(url).indexes) {
      messages[idx].content = messages[idx].content.replace(url, enrichedUrl);
    }
  }

  return { enriched, failed };
}

async function fetchUrlMetadata(url, opts) {
  const ghMatch = url.match(GITHUB_REPO_REGEX);
  if (ghMatch) {
    return fetchGitHubRepo(ghMatch[1], ghMatch[2], opts);
  }
  return fetchPageMeta(url, opts);
}

async function fetchGitHubRepo(owner, repo, opts) {
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: { 'User-Agent': opts.userAgent, 'Accept': 'application/vnd.github.v3+json' },
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    if (!res.ok) return fetchPageMeta(`https://github.com/${owner}/${repo}`, opts);
    const data = await res.json();
    return {
      title: data.full_name || `${owner}/${repo}`,
      description: data.description || '',
      stars: data.stargazers_count || 0,
    };
  } catch {
    return null;
  }
}

async function fetchPageMeta(url, opts) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': opts.userAgent },
      signal: AbortSignal.timeout(opts.timeoutMs),
      redirect: 'follow',
    });
    if (!res.ok) return null;

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) return null;

    // Read only the first 16KB — enough for <head> section
    const reader = res.body.getReader();
    let html = '';
    const decoder = new TextDecoder();
    while (html.length < 16384) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
    }
    reader.cancel().catch(() => {});

    const title = extractTag(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
    const ogDesc = extractMeta(html, 'og:description');
    const metaDesc = extractMeta(html, 'description');
    const description = ogDesc || metaDesc || '';

    if (!title && !description) return null;

    return {
      title: (title || '').trim().substring(0, 200),
      description: description.trim().substring(0, 300),
    };
  } catch {
    return null;
  }
}

function extractTag(html, regex) {
  const match = html.match(regex);
  return match ? decodeEntities(match[1].trim()) : null;
}

function extractMeta(html, name) {
  // Match both name="..." and property="..." attributes
  const patterns = [
    new RegExp(`<meta[^>]*(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*(?:name|property)=["']${name}["']`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return decodeEntities(match[1]);
  }
  return null;
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)));
}

module.exports = { enrichMessages, DEFAULT_OPTIONS };
