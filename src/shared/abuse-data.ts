/**
 * Static, in-repo reference tables for abuse screening (ADR-034/035).
 *
 * No npm dependency is added (constraint + OWASP A06): the public-suffix subset,
 * the confusable-character map, and the top-50 brand list are small, deterministic
 * in-repo tables. They are easily extended (a stale list only MISSES a typosquat;
 * FLAG-not-block means a miss is low-blast-radius, and a false positive only costs
 * an admin review — ADR-035). Keep them sorted/grouped and documented.
 */

/**
 * Public-suffix subset for registrable-domain (eTLD+1) reduction (ADR-034).
 *
 * This is the SMALL common-case subset of the IANA Public Suffix List — enough
 * to reduce multi-label TLDs (`foo.co.uk`, `foo.com.tr`) to the correct
 * registrable domain WITHOUT a dependency. Any suffix NOT listed here falls back
 * to the last-two-labels rule (see `registrableDomain`), which over-blocks a
 * sibling on a rare multi-label TLD (acceptable — blocklist entries are
 * admin-curated and rare) but NEVER under-blocks the common `evil.com` /
 * `a.b.evil.com` case. If this subset proves insufficient in production, escalate
 * to tech-lead for a maintained PSL lib (do NOT add one silently).
 *
 * Entries are the multi-label public suffixes themselves (the part AFTER the
 * registrable label), lowercased ASCII. The registrable domain is then one label
 * MORE than the matched suffix.
 */
export const MULTI_LABEL_PUBLIC_SUFFIXES: ReadonlySet<string> = new Set([
  // United Kingdom
  'co.uk',
  'org.uk',
  'me.uk',
  'ltd.uk',
  'plc.uk',
  'net.uk',
  'sch.uk',
  'gov.uk',
  'ac.uk',
  // Australia
  'com.au',
  'net.au',
  'org.au',
  'edu.au',
  'gov.au',
  'id.au',
  // Brazil
  'com.br',
  'net.br',
  'org.br',
  'gov.br',
  // Turkey
  'com.tr',
  'net.tr',
  'org.tr',
  'gov.tr',
  'edu.tr',
  // Japan
  'co.jp',
  'or.jp',
  'ne.jp',
  'go.jp',
  'ac.jp',
  // India
  'co.in',
  'net.in',
  'org.in',
  'gov.in',
  // China
  'com.cn',
  'net.cn',
  'org.cn',
  'gov.cn',
  // South Africa / Mexico / Singapore / others common
  'co.za',
  'com.mx',
  'com.sg',
  'co.nz',
  'com.hk',
  'co.kr',
  'com.ar',
  'com.co',
]);

/**
 * Confusable-character map for homograph detection (ADR-035).
 *
 * Maps a visually-confusable Unicode (or look-alike ASCII) character to its
 * canonical ASCII skeleton character. Used to fold a candidate host to a
 * "skeleton" that collapses homoglyph attacks (Cyrillic `а`→`a`, Greek `ο`→`o`,
 * digit `0`→`o`, capital-`I`→`l`, etc.) so a confusable lookalike of a top-50
 * brand can be detected. This is a deliberately small, high-value subset of the
 * Unicode confusables data — NOT the full table (no dependency). A character not
 * in the map maps to itself (identity).
 */
export const CONFUSABLE_MAP: ReadonlyMap<string, string> = new Map([
  // Cyrillic lookalikes
  ['а', 'a'], // U+0430
  ['е', 'e'], // U+0435
  ['о', 'o'], // U+043E
  ['р', 'p'], // U+0440
  ['с', 'c'], // U+0441
  ['у', 'y'], // U+0443
  ['х', 'x'], // U+0445
  ['ѕ', 's'], // U+0455
  ['і', 'i'], // U+0456
  ['ј', 'j'], // U+0458
  ['ԁ', 'd'], // U+0501
  ['һ', 'h'], // U+04BB
  ['ӏ', 'l'], // U+04CF
  // Greek lookalikes
  ['α', 'a'], // U+03B1
  ['ο', 'o'], // U+03BF
  ['ρ', 'p'], // U+03C1
  ['ν', 'v'], // U+03BD
  ['ι', 'i'], // U+03B9
  ['κ', 'k'], // U+03BA
  // ASCII / digit confusables folded to letters
  ['0', 'o'],
  ['1', 'l'],
  ['3', 'e'],
  ['4', 'a'],
  ['5', 's'],
  ['7', 't'],
  ['8', 'b'],
  ['9', 'g'],
]);

/**
 * Static top-50 brand registrable domains for typosquat/homograph scoring
 * (ADR-035). Each is already in canonical registrable form (lowercase ASCII
 * eTLD+1). A candidate within Levenshtein distance 1–2 of any of these (and not
 * exactly equal to one) is FLAGGED; an exact match is the real brand (ALLOW,
 * never flagged against itself).
 */
export const TOP_BRAND_DOMAINS: readonly string[] = [
  'google.com',
  'youtube.com',
  'facebook.com',
  'instagram.com',
  'twitter.com',
  'x.com',
  'amazon.com',
  'apple.com',
  'microsoft.com',
  'netflix.com',
  'paypal.com',
  'linkedin.com',
  'wikipedia.org',
  'yahoo.com',
  'reddit.com',
  'whatsapp.com',
  'tiktok.com',
  'office.com',
  'live.com',
  'bing.com',
  'ebay.com',
  'spotify.com',
  'dropbox.com',
  'adobe.com',
  'salesforce.com',
  'github.com',
  'gitlab.com',
  'twitch.tv',
  'discord.com',
  'slack.com',
  'zoom.us',
  'stripe.com',
  'coinbase.com',
  'binance.com',
  'chase.com',
  'wellsfargo.com',
  'bankofamerica.com',
  'citibank.com',
  'walmart.com',
  'target.com',
  'aliexpress.com',
  'alibaba.com',
  'booking.com',
  'airbnb.com',
  'uber.com',
  'dropbox.com',
  'cloudflare.com',
  'oracle.com',
  'ibm.com',
  'samsung.com',
];
