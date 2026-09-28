import { describe, it, expect } from 'vitest';
import { HTMLLoader } from '../../../../../src/rag/ingestion/loaders/HTMLLoader.js';

describe('HTMLLoader', () => {
  const loader = new HTMLLoader();

  it('has correct name and MIME types', () => {
    expect(loader.name).toBe('html');
    expect(loader.supportedMimeTypes).toContain('text/html');
  });

  it('strips HTML tags', async () => {
    const raw = await loader.load({
      type: 'text',
      mimeType: 'text/html',
      text: '<html><body><h1>Title</h1><p>Hello <b>world</b></p></body></html>',
    });
    expect(raw.content).toContain('Title');
    expect(raw.content).toContain('Hello');
    expect(raw.content).not.toContain('<h1>');
    expect(raw.content).not.toContain('<b>');
  });

  it('extracts title from <title> tag', async () => {
    const raw = await loader.load({
      type: 'text',
      mimeType: 'text/html',
      text: '<html><head><title>My Page</title></head><body><p>Content</p></body></html>',
    });
    expect(raw.metadata.title).toBe('My Page');
  });

  it('removes script and style content', async () => {
    const raw = await loader.load({
      type: 'text',
      mimeType: 'text/html',
      text: '<html><body><script>alert("xss")</script><style>body{color:red}</style><p>Safe</p></body></html>',
    });
    expect(raw.content).not.toContain('alert');
    expect(raw.content).not.toContain('color:red');
    expect(raw.content).toContain('Safe');
  });

  it('loads from buffer', async () => {
    const raw = await loader.load({
      type: 'buffer',
      mimeType: 'text/html',
      buffer: Buffer.from('<p>Buffer</p>', 'utf-8'),
    });
    expect(raw.content).toContain('Buffer');
  });
});
