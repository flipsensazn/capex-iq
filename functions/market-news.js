// functions/market-news.js

// ── RSS PARSING ──────────────────────────────────────────────────────────────
// The Cloudflare Workers runtime has no DOMParser (it's a browser API), so we
// parse the RSS XML with scoped regexes instead. Each <item> is isolated first,
// then individual tags are extracted from within it.
function decodeEntities(str) {
  if (!str) return str;
  return str
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&"); // decode &amp; last so it doesn't double-decode
}

function extractTag(itemXml, tag) {
  const m = itemXml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return m ? decodeEntities(m[1].trim()).trim() : null;
}

function parseRssItems(xml) {
  const matches = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  return matches.map(itemXml => ({
    title:   extractTag(itemXml, "title"),
    link:    extractTag(itemXml, "link"),
    pubDate: extractTag(itemXml, "pubDate"),
  }));
}

export async function onRequest(context) {
  const { request, env } = context;

  const ALLOWED_ORIGIN = env.ALLOWED_ORIGIN || "";
  const origin = request.headers.get("Origin") || "";
  const corsOrigin = origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : "";

  const headers = {
    "Access-Control-Allow-Origin": corsOrigin,
    "Content-Type": "application/json",
    "Cache-Control": "public, max-age=60", // <-- Updated to 60 seconds (1 minute)
    "Vary": "Origin",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...headers, "Access-Control-Allow-Methods": "GET, OPTIONS" } });
  }

  const feeds = [
    { name: "Tech", url: "https://feeds.bloomberg.com/technology/news.rss" },
    { name: "Markets", url: "https://feeds.bloomberg.com/markets/news.rss" },
    { name: "Crypto", url: "https://feeds.bloomberg.com/crypto/news.rss" }
  ];

  try {
    let allItems = [];

    // Fetch all feeds in parallel
    const responses = await Promise.all(feeds.map(f => fetch(f.url, {
       headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
    })));
    
    for (let i = 0; i < responses.length; i++) {
      const res = responses[i];
      if (!res.ok) continue;
      
      const xmlText = await res.text();
      const feedName = feeds[i].name;

      const items = parseRssItems(xmlText);

      for (const item of items) {
        const { title, link, pubDate } = item;

        if (title && link && pubDate) {
          const pubDateObj = new Date(pubDate);
          allItems.push({
            title,
            link,
            timestamp: pubDateObj.getTime(),
            category: feedName,
          });
        }
      }
    }

    // Prefer today's items in NY market time, but fall back to the most recent
    // headlines so the panel does not go blank across weekends and holidays.
    const formatter = new Intl.DateTimeFormat("en-US", { 
      timeZone: "America/New_York", 
      year: "numeric", month: "2-digit", day: "2-digit" 
    });
    const todayStr = formatter.format(new Date());

    const todaysItems = allItems.filter(item => {
       const itemDateStr = formatter.format(new Date(item.timestamp));
       return itemDateStr === todayStr; // Keep only if it matches today's date
    });

    const recentItems = (todaysItems.length > 0 ? todaysItems : allItems)
      .filter(item => Number.isFinite(item.timestamp))
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 25);

    // Deduplicate by URL (in case an article overlaps feeds)
    const uniqueMap = new Map();
    recentItems.forEach(t => uniqueMap.set(t.link, t));
    const uniqueItems = Array.from(uniqueMap.values());

    return new Response(JSON.stringify({
      news: uniqueItems,
      mode: todaysItems.length > 0 ? "today" : "recent",
    }), { status: 200, headers });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}
