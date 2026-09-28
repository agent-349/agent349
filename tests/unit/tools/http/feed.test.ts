import { describe, it, expect } from 'vitest';
import { decodeXmlEntities, parseFeed } from '../../../../src/tools/builtin/http/feed.js';
import { ValidationError } from '../../../../src/errors/index.js';

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Public calls &amp; tenders</title>
    <link>https://calls.example.gub.uy/</link>
    <item>
      <title><![CDATA[Call 12345: <b>AI</b> analytics platform]]></title>
      <link>https://calls.example.gub.uy/call/12345?utm_source=rss&amp;x=1</link>
      <guid isPermaLink="false">call-12345</guid>
      <pubDate>Wed, 09 Sep 2026 10:00:00 -0300</pubDate>
      <description>&lt;p&gt;Consultancy for &lt;em&gt;machine learning&lt;/em&gt; &#8212; ANEP&lt;/p&gt;</description>
      <category>IT</category>
      <category>AI</category>
      <dc:creator>Procurement Office</dc:creator>
    </item>
    <item>
      <title>Only a link</title>
      <link>https://calls.example.gub.uy/call/2</link>
    </item>
    <item>
      <title>Dangerous link</title>
      <link>javascript:alert(1)</link>
      <guid>dangerous-1</guid>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title type="text">Provider status</title>
  <link rel="alternate" href="https://status.example.com/"/>
  <link rel="self" href="https://status.example.com/feed.atom"/>
  <entry>
    <id>urn:incident:77</id>
    <title type="html">Degraded card authorizations &amp;lt;EU&amp;gt;</title>
    <link rel="self" href="https://status.example.com/77.atom"/>
    <link rel="alternate" href="/incidents/77"/>
    <published>2026-09-09T13:00:00Z</published>
    <updated>2026-09-09T14:10:00Z</updated>
    <summary>Error rates are elevated.</summary>
    <category term="payments" label="Payments"/>
    <author><name>Status bot</name></author>
  </entry>
</feed>`;

const RDF = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://old.example.org/"><title>Old feed</title><link>https://old.example.org/</link></channel>
  <item rdf:about="https://old.example.org/1">
    <title>First</title><link>https://old.example.org/1</link>
    <dc:date>2026-09-01T08:00:00Z</dc:date><dc:subject>archive</dc:subject>
  </item>
</rdf:RDF>`;

describe('parseFeed — RSS 2.0', () => {
  const feed = parseFeed(RSS);
  const [call, onlyLink, dangerous] = feed.entries;

  it('detects the format and the channel metadata', () => {
    expect(feed.format).toBe('rss');
    expect(feed.title).toBe('Public calls & tenders');
    expect(feed.link).toBe('https://calls.example.gub.uy/');
  });

  it('uses the guid as the entry id', () => {
    expect(call?.id).toBe('call-12345');
  });

  it('turns CDATA markup into plain text', () => {
    expect(call?.title).toBe('Call 12345: AI analytics platform');
  });

  it('decodes an escaped HTML description into plain text', () => {
    expect(call?.summary).toBe('Consultancy for machine learning — ANEP');
  });

  it('decodes entities inside links', () => {
    expect(call?.link).toBe('https://calls.example.gub.uy/call/12345?utm_source=rss&x=1');
  });

  it('normalises dates to ISO 8601', () => {
    expect(call?.published).toBe('2026-09-09T13:00:00.000Z');
  });

  it('collects categories and the Dublin Core creator', () => {
    expect(call?.categories).toEqual(['IT', 'AI']);
    expect(call?.author).toBe('Procurement Office');
  });

  it('falls back to the link when there is no guid', () => {
    expect(onlyLink?.id).toBe('https://calls.example.gub.uy/call/2');
  });

  // A javascript: link is a payload waiting for a UI that renders it.
  it('drops links that are not http or https', () => {
    expect(dangerous?.link).toBeUndefined();
    expect(dangerous?.id).toBe('dangerous-1');
  });
});

describe('parseFeed — Atom', () => {
  const feed = parseFeed(ATOM, { baseUrl: 'https://status.example.com/feed.atom' });
  const [incident] = feed.entries;

  it('detects Atom and prefers the alternate link', () => {
    expect(feed.format).toBe('atom');
    expect(feed.link).toBe('https://status.example.com/');
    expect(incident?.link).toBe('https://status.example.com/incidents/77');
  });

  it('decodes a double-escaped html title exactly once per layer', () => {
    expect(incident?.title).toBe('Degraded card authorizations <EU>');
  });

  it('reads id, dates, summary, category label and author', () => {
    expect(incident).toMatchObject({
      id: 'urn:incident:77',
      published: '2026-09-09T13:00:00.000Z',
      updated: '2026-09-09T14:10:00.000Z',
      summary: 'Error rates are elevated.',
      categories: ['Payments'],
      author: 'Status bot',
    });
  });

  it('drops a relative link when no base URL is known', () => {
    expect(parseFeed(ATOM).entries[0]?.link).toBeUndefined();
  });
});

describe('parseFeed — RSS 1.0 (RDF)', () => {
  it('reads items that sit beside the channel', () => {
    const feed = parseFeed(RDF);

    expect(feed.format).toBe('rdf');
    expect(feed.title).toBe('Old feed');
    expect(feed.entries[0]).toMatchObject({
      id: 'https://old.example.org/1',
      published: '2026-09-01T08:00:00.000Z',
      categories: ['archive'],
    });
  });
});

describe('parseFeed — caps and identity', () => {
  it('caps the entries and reports the total', () => {
    const feed = parseFeed(RSS, { maxEntries: 2 });

    expect(feed.entries).toHaveLength(2);
    expect(feed.totalEntries).toBe(3);
  });

  it('caps each summary', () => {
    const long = RSS.replace('Consultancy for', 'x'.repeat(500));
    const summary = parseFeed(long, { maxSummaryChars: 50 }).entries[0]?.summary ?? '';

    expect(summary.length).toBeLessThanOrEqual(50);
  });

  // An entry with neither guid nor link still needs an identity that does not
  // change between two reads of the same feed.
  it('derives a stable hash id for an entry with neither id nor link', () => {
    const xml =
      '<rss><channel><title>t</title><item><title>Bare</title><pubDate>Wed, 09 Sep 2026 10:00:00 GMT</pubDate></item></channel></rss>';
    const first = parseFeed(xml).entries[0]?.id;
    const second = parseFeed(xml).entries[0]?.id;

    expect(first).toMatch(/^sha1:[0-9a-f]{40}$/);
    expect(first).toBe(second);
  });

  it('skips an entry with nothing to identify it', () => {
    const xml = '<rss><channel><title>t</title><item></item></channel></rss>';
    expect(parseFeed(xml).entries).toEqual([]);
  });
});

describe('parseFeed — refusals', () => {
  it('refuses a document that declares entities', () => {
    const bomb =
      '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]>' +
      '<rss><channel><item><title>&lol2;</title></item></channel></rss>';
    expect(() => parseFeed(bomb)).toThrow(/declares XML entities/);
  });

  it('refuses a document that is not a feed', () => {
    expect(() => parseFeed('<html><body>hi</body></html>')).toThrow(ValidationError);
  });

  it('refuses an RSS document without a channel', () => {
    expect(() => parseFeed('<rss version="2.0"></rss>')).toThrow(/channel/);
  });
});

describe('decodeXmlEntities', () => {
  it('decodes the predefined entities and numeric references', () => {
    expect(decodeXmlEntities('&lt;a&gt; &quot;b&quot; &apos;c&apos; &amp; &#233; &#x1F600;')).toBe(
      '<a> "b" \'c\' & é 😀',
    );
  });

  it('decodes in a single pass', () => {
    expect(decodeXmlEntities('&amp;lt;')).toBe('&lt;');
  });

  it('leaves invalid references and unknown entities alone', () => {
    expect(decodeXmlEntities('&#xD800; &nbsp; &#0;')).toBe('&#xD800; &nbsp; &#0;');
  });
});
