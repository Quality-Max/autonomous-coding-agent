import { describe, it, expect } from 'vitest';
import { assertSafeHttpUrl, shellQuote } from './preview';

// These guard the user-/agent-controlled URL before it reaches a browser/shell inside the
// preview sandbox. They are the security core of the live-preview feature, so they get the
// most exhaustive coverage — including the SSRF notation bypasses surfaced in review.

describe('assertSafeHttpUrl — allows legitimate public targets', () => {
  const allowed = [
    'https://8000-ib8svc4bbdwtrqqtifuau.e2b.app/',
    'https://example.com/?a=1&b=2',
    'https://github.com/owner/repo',
    'https://my-app.vercel.app/path',
    'http://public-site.org:8080/',
    // a real hostname whose label merely starts like an IP prefix
    'http://fcsite.com/',
  ];
  for (const url of allowed) {
    it(`allows ${url}`, () => {
      expect(assertSafeHttpUrl(url)).toBe(url);
    });
  }
});

describe('assertSafeHttpUrl — rejects non-http(s) schemes', () => {
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'ftp://example.com/']) {
    it(`rejects ${url}`, () => {
      expect(() => assertSafeHttpUrl(url)).toThrow();
    });
  }
});

describe('assertSafeHttpUrl — rejects loopback / private / metadata hosts', () => {
  const blocked = [
    'http://localhost:3000/',
    'http://localhost./',          // trailing-dot bypass
    'http://app.local/',
    'http://x.localhost./',
    'http://127.0.0.1:8000/',
    'http://10.0.0.5/',
    'http://192.168.1.10/',
    'http://172.16.0.1/',
    'http://169.254.169.254/latest/meta-data/', // cloud metadata
    'http://[::1]:8080/',          // IPv6 loopback
    'http://[::ffff:127.0.0.1]/',  // IPv4-mapped IPv6
  ];
  for (const url of blocked) {
    it(`rejects ${url}`, () => {
      expect(() => assertSafeHttpUrl(url)).toThrow(/public hostname/);
    });
  }
});

describe('assertSafeHttpUrl — rejects IP-notation SSRF bypasses', () => {
  // new URL() canonicalises these to 127.0.0.1 before our check, so they must all be blocked.
  const bypasses = [
    'http://0177.0.0.1/',   // octal
    'http://0x7f.0.0.1/',   // hex per-octet
    'http://0x7f000001/',   // single hex
    'http://2130706433/',   // single decimal
    'http://127.1/',        // short form
    'http://1.2.3.4/',      // public IP literal — refused too (targets are hostnames)
  ];
  for (const url of bypasses) {
    it(`rejects ${url}`, () => {
      expect(() => assertSafeHttpUrl(url)).toThrow(/public hostname/);
    });
  }
});

describe('assertSafeHttpUrl — rejects malformed input', () => {
  for (const url of ['not a url', '', 'http://', '://nohost']) {
    it(`rejects ${JSON.stringify(url)}`, () => {
      expect(() => assertSafeHttpUrl(url)).toThrow();
    });
  }
});

describe('shellQuote — neutralises shell metacharacters', () => {
  it('wraps a plain value in single quotes', () => {
    expect(shellQuote('https://example.com/')).toBe(`'https://example.com/'`);
  });

  it('escapes embedded single quotes with the \'\\\'\' idiom', () => {
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
  });

  it('keeps injection metacharacters inside the quotes (no breakout)', () => {
    const quoted = shellQuote('https://x.com/?a=1&b=2;echo pwned`id`$(whoami)');
    // Everything stays within the outer single quotes — no unquoted shell-significant char.
    expect(quoted.startsWith("'")).toBe(true);
    expect(quoted.endsWith("'")).toBe(true);
    // The only way to leave the quoted context is a literal ' — and we escape every one.
    const inner = quoted.slice(1, -1);
    expect(inner.includes("'")).toBe(false);
  });
});
