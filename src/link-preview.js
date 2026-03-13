const URL_REGEX = /https?:\/\/[^\s<>)\]]+/g;

const FETCH_TIMEOUT = 5000;
const MAX_HTML_SIZE = 200 * 1024;

/**
 * Extracts unique URLs from text content, ignoring code blocks and inline code.
 * @param {string} text
 * @returns {string[]}
 */
export function extractUrls(text) {
  const stripped = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`]+`/g, '');
  return [...new Set(stripped.match(URL_REGEX) || [])];
}

/**
 * Extracts a charset from a Content-Type header value.
 * @param {string|null} ct
 * @returns {string|null}
 */
function charsetFromContentType(ct) {
  const m = ct && ct.match(/charset=([^\s;]+)/i);
  return m ? m[1].trim() : null;
}

/**
 * Extracts a charset from an HTML meta tag in a latin1-encoded string.
 * @param {string} latin1Html
 * @returns {string|null}
 */
function charsetFromHtml(latin1Html) {
  const m1 = latin1Html.match(/<meta[^>]+charset=["']?([^"';\s>]+)/i);
  if (m1) {
    return m1[1].trim();
  }
  return null;
}

/**
 * Decodes a buffer to a string using the charset from the Content-Type header or HTML meta tag.
 * @param {Buffer} buf
 * @param {string} contentTypeHeader
 * @returns {string}
 */
function decodeBuffer(buf, contentTypeHeader) {
  let charset = charsetFromContentType(contentTypeHeader);
  if (!charset) {
    charset = charsetFromHtml(buf.toString('latin1'));
  }
  const normalized = (charset || 'utf-8').toLowerCase().replace(/^utf8$/, 'utf-8');
  if (normalized === 'utf-8') {
    return buf.toString('utf-8');
  }
  try {
    return new TextDecoder(normalized).decode(buf);
  } catch {
    return buf.toString('utf-8');
  }
}

/**
 * Returns true only for URLs pointing to public, routable hosts.
 * Rejects localhost, bare hostnames without a TLD, and private/reserved IP ranges.
 * @param {string} url
 * @returns {boolean}
 */
function isPublicUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  const hostname = parsed.hostname.toLowerCase();

  if (hostname === 'localhost' || !hostname.includes('.')) {
    return false;
  }

  const v4 = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0) {
      return false;
    }
    if (a === 10) {
      return false;
    }
    if (a === 127) {
      return false;
    }
    if (a === 169 && b === 254) {
      return false;
    }
    if (a === 172 && b >= 16 && b <= 31) {
      return false;
    }
    if (a === 192 && b === 168) {
      return false;
    }
    if (a === 198 && (b === 18 || b === 19)) {
      return false;
    }
    if (a === 100 && b >= 64 && b <= 127) {
      return false;
    }
    if (a >= 224) {
      return false;
    }
    return true;
  }

  const v6 = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
  if (v6.includes(':')) {
    if (v6 === '::' || v6 === '::1') {
      return false;
    }
    if (/^fe[89ab]/i.test(v6)) {
      return false;
    }
    if (/^f[cd]/i.test(v6)) {
      return false;
    }
    return true;
  }

  return true;
}

/**
 * Fetches Open Graph / meta tag preview data for a single URL.
 * @param {string} url
 * @returns {Promise<{url: string, title: string, description: string, image: string|null, siteName: string}|null>}
 */
async function fetchPreview(url) {
  if (!isPublicUrl(url)) {
    return null;
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; GimodiBot/1.0; +link-preview)',
        Accept: 'text/html',
      },
      redirect: 'follow',
    });

    clearTimeout(timeout);

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) {
      return null;
    }

    const reader = res.body.getReader();
    const chunks = [];
    let totalSize = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(value);
      totalSize += value.length;
      if (totalSize > MAX_HTML_SIZE) {
        break;
      }
    }
    reader.cancel();

    const buf = Buffer.concat(chunks);
    const html = decodeBuffer(buf, contentType);
    return parseOgTags(html, url);
  } catch {
    return null;
  }
}

/**
 * Parses Open Graph meta tags from an HTML string.
 * @param {string} html
 * @param {string} url
 * @returns {{url: string, title: string, description: string, image: string|null, siteName: string}|null}
 */
function parseOgTags(html, url) {
  const getMeta = (property) => {
    const re = new RegExp(
      `<meta[^>]+(?:property|name)=["'](?:og:)?${property}["'][^>]+content=["']([^"']+)["']` + `|<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:)?${property}["']`,
      'i',
    );
    const match = html.match(re);
    return match ? match[1] || match[2] : null;
  };

  const title = getMeta('title') || getTitleTag(html);
  const description = getMeta('description');
  const image = getMeta('image');
  const siteName = getMeta('site_name');

  if (!title && !description && !image) {
    return null;
  }

  let imageUrl = image;
  if (image && !image.startsWith('http')) {
    try {
      imageUrl = new URL(image, url).href;
    } catch {
      imageUrl = null;
    }
  }

  return {
    url,
    title: decodeEntities(title || ''),
    description: decodeEntities(description || ''),
    image: imageUrl || null,
    siteName: decodeEntities(siteName || new URL(url).hostname),
  };
}

/**
 * Extracts the content of the first <title> tag from HTML.
 * @param {string} html
 * @returns {string|null}
 */
function getTitleTag(html) {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match ? match[1].trim() : null;
}

/**
 * Decodes common HTML entities in a string.
 * @param {string} str
 * @returns {string}
 */
function decodeEntities(str) {
  return str
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/');
}

/**
 * Fetches link previews for all URLs found in text (up to 3).
 * @param {string} text
 * @returns {Promise<Array<{url: string, title: string, description: string, image: string|null, siteName: string}>>}
 */
export async function fetchLinkPreviews(text) {
  const urls = extractUrls(text);
  if (urls.length === 0) {
    return [];
  }

  const limited = urls.slice(0, 3);
  const results = await Promise.all(limited.map(fetchPreview));
  return results.filter(Boolean);
}
