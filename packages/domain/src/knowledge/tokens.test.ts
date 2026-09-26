import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MODEL_RUNS, PROPERTY_TEST_TIMEOUT_MS } from '../testing/property.js';
import { BYTES_PER_TOKEN, estimateTokens, utf8ByteLength } from './tokens.js';

describe('utf8ByteLength', () => {
  it(
    'agrees with TextEncoder on every string, lone surrogates included',
    () => {
      fc.assert(
        fc.property(fc.string({ unit: 'binary' }), (text) => {
          expect(utf8ByteLength(text)).toBe(new TextEncoder().encode(text).length);
        }),
        { numRuns: MODEL_RUNS },
      );
    },
    PROPERTY_TEST_TIMEOUT_MS,
  );

  it('counts the scripts the ratio is wrong about, one at a time', () => {
    expect(utf8ByteLength('abcd')).toBe(4);
    expect(utf8ByteLength('ěščř')).toBe(8);
    // CJK is three bytes per character, which is the whole of PROGRESS backlog 14.
    expect(utf8ByteLength('日本語')).toBe(9);
    expect(utf8ByteLength('😀')).toBe(4);
    expect(utf8ByteLength('\u{D800}')).toBe(3);
  });
});

describe('estimateTokens', () => {
  it('is zero only for the empty string', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens(' ')).toBe(1);
  });

  it('never returns zero for text that exists, so the budget fill cannot admit a free document', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (text) => {
        expect(estimateTokens(text)).toBeGreaterThanOrEqual(1);
      }),
      { numRuns: 300 },
    );
  });

  it('is monotone in length, which is what makes a budget a budget', () => {
    fc.assert(
      fc.property(fc.string(), fc.string({ minLength: 1 }), (head, tail) => {
        expect(estimateTokens(head + tail)).toBeGreaterThanOrEqual(estimateTokens(head));
      }),
      { numRuns: 300 },
    );
  });

  it(
    'is exactly the stated ratio over UTF-8 bytes',
    () => {
      // PROGRESS backlog 14: "`tokens.test.ts` asserts non-zero and monotone, and both properties
      // are satisfied by an **arbitrarily wrong** estimator, so the suite cannot tell a
      // 4-bytes-per-token model from a 40-bytes-per-token one." This one pins the unit and the
      // constant — it fails for any divisor but the shipped one — and WP-58 noticed that is not the
      // same thing: it would pass a *wrong* shipped constant just as happily. The check against a
      // real tokeniser's counts is the describe at the end of this file.
      fc.assert(
        fc.property(fc.string({ unit: 'binary' }), (text) => {
          const bytes = new TextEncoder().encode(text).length;
          expect(estimateTokens(text)).toBe(bytes === 0 ? 0 : Math.ceil(bytes / BYTES_PER_TOKEN));
        }),
        { numRuns: MODEL_RUNS },
      );
    },
    PROPERTY_TEST_TIMEOUT_MS,
  );

  it('counts bytes and not JavaScript characters, which is the fix backlog 14 asked for', () => {
    expect(BYTES_PER_TOKEN).toBe(4);
    expect(estimateTokens('a'.repeat(4))).toBe(1);
    expect(estimateTokens('a'.repeat(5))).toBe(2);
    // ASCII is unchanged by the move to bytes: 48 000 characters are 48 000 bytes.
    expect(estimateTokens('a'.repeat(48_000))).toBe(12_000);
    // The measured corner. 48 000 CJK characters used to estimate at exactly the shipped 12 000
    // default budget; they are 144 000 bytes and now estimate at 36 000.
    expect(estimateTokens('日'.repeat(48_000))).toBe(36_000);
  });
});

/**
 * **Four texts with a token count a real tokeniser produced** — WP-58's criterion (6), PROGRESS
 * backlog 14's "a property that fails for an estimator with the wrong ratio".
 *
 * Provenance, stated because it is the whole value of the table: counted on 2026-09-26 with
 * `countTokens` from the npm package `@anthropic-ai/tokenizer@0.0.4`
 * (https://www.npmjs.com/package/@anthropic-ai/tokenizer), run in a scratch directory — it is **not**
 * a dependency of this repository. It is a tokeniser Anthropic published; it is **not** claimed to
 * be the one the current models use, and no credential for the token-counting API was available to
 * measure that. So these bound the estimator against *a* real byte-level BPE, not *the* one.
 * The Czech and Japanese texts were written for this measurement (a lesson about a session
 * service's seeded fixture user); the English is the fixture vault's padding paragraph; the
 * TypeScript is `utf8ByteLength` as it stood when counted.
 */
const MEASURED: Readonly<
  Record<string, { readonly text: string; readonly bytes: number; readonly tokens: number }>
> = (() => {
  const texts = {
    english:
      'The deployment topology places each worker behind its own supervisor process, and the supervisor restarts a worker whose heartbeat lapses. Restart storms are damped by a growing backoff that resets once a worker has stayed up for a full interval. Operators watching the dashboard will see the backoff as a widening gap between restarts rather than as an error.',
    czech:
      '# Lekce: testy relační služby potřebují připravená data\n\nTesty služby pro správu relací selhávají s porušením cizího klíče, pokud předtím neproběhl skript, který naplní tabulku uživatelů. Tento krok není součástí příkazu pro spuštění testů, a proto je nutné ho spustit ručně. Stálo nás to dvě odpoledne, než to někdo zapsal do znalostní báze.\n\n## Proč se to děje\n\nKaždá relace odkazuje na existujícího uživatele. Databáze vynucuje referenční integritu, takže vložení relace bez odpovídajícího uživatele skončí chybou. Vývojáři, kteří pracují na jiných částech systému, na to často zapomenou, protože jejich testy žádná data nepotřebují.\n\n## Co dělat\n\nPřed spuštěním testů vždy nejdříve připravte testovací uživatele. Pokud test přesto selže, zkontrolujte, zda migrace proběhly ve správném pořadí a zda databáze obsahuje očekávané schéma. Při nasazení na produkci se tento problém neobjevuje, protože tam uživatelé již existují.',
    japanese:
      '# 教訓：セッションサービスのテストには事前に用意したユーザーが必要\n\nセッションサービスのテストは、ユーザーテーブルを埋めるスクリプトを先に実行しないと外部キー違反で失敗します。この手順はテスト実行コマンドに含まれていないため、手動で実行する必要があります。誰かが知識ベースに書き留めるまで、二日分の午後を費やしました。\n\n## なぜ起きるのか\n\nすべてのセッションは既存のユーザーを参照します。データベースは参照整合性を強制するため、対応するユーザーのないセッションの挿入はエラーになります。システムの他の部分を担当する開発者は、自分のテストがデータを必要としないため、これをよく忘れます。',
    typescript:
      'export const utf8ByteLength = (text: string): number => {\n  let bytes = 0;\n  for (let at = 0; at < text.length; at += 1) {\n    const code = text.charCodeAt(at);\n    if (code < 0x80) {\n      bytes += 1;\n    } else if (code < 0x800) {\n      bytes += 2;\n    } else if (code >= 0xd800 && code <= 0xdbff) {\n      const next = at + 1 < text.length ? text.charCodeAt(at + 1) : 0;\n      if (next >= 0xdc00 && next <= 0xdfff) {\n        // A surrogate pair is one code point in four bytes.\n        bytes += 4;\n        at += 1;\n      } else {\n        // A lone high surrogate is not a code point; every UTF-8 encoder substitutes U+FFFD.\n        bytes += 3;\n      }\n    } else {\n      bytes += 3;\n    }\n  }\n  return bytes;\n};',
  };
  const counted = {
    english: [360, 72],
    czech: [1039, 452],
    japanese: [869, 286],
    typescript: [713, 220],
  } as const;
  return Object.fromEntries(
    Object.entries(texts).map(([name, text]) => {
      const [bytes, tokens] = counted[name as keyof typeof counted];
      return [name, { text, bytes, tokens }];
    }),
  );
})();

/**
 * The band the shipped estimator is held to, **from the table above** rather than chosen: its worst
 * measured sample is Czech at 0.575 of the real count (an under-estimate of 1.74×), its most
 * generous English at 1.25. The floor and ceiling are one half and two, which contain both with
 * room and still refuse a ratio off by 2× in either direction on some sample — a 40-bytes-per-token
 * estimator lands at 0.06 on the Czech text, a 1-byte-per-token one at 5.0 on the English.
 */
const MEASURED_BAND = { floor: 0.5, ceiling: 2 } as const;

describe('estimateTokens against a real tokeniser (WP-58, backlog 14)', () => {
  it.each(Object.keys(MEASURED))('%s is the text that was counted', (name) => {
    const sample = MEASURED[name] as (typeof MEASURED)[string];
    // The recorded count describes these bytes and no others; an edited sample fails here first.
    expect(utf8ByteLength(sample.text)).toBe(sample.bytes);
  });

  it.each(Object.keys(MEASURED))(
    '%s estimates within the measured band of its real count',
    (name) => {
      const sample = MEASURED[name] as (typeof MEASURED)[string];
      const ratio = estimateTokens(sample.text) / sample.tokens;
      expect(ratio).toBeGreaterThanOrEqual(MEASURED_BAND.floor);
      expect(ratio).toBeLessThanOrEqual(MEASURED_BAND.ceiling);
    },
  );

  it('refuses an estimator with the wrong ratio, which the properties above cannot', () => {
    // The property the row asked for, applied to two wrong estimators: each is non-zero and
    // monotone, so both pass the first two tests in this file, and each leaves the band on some
    // measured sample.
    const withRatio = (bytesPerToken: number) => (text: string) =>
      Math.ceil(utf8ByteLength(text) / bytesPerToken);
    const inBand = (estimate: (text: string) => number) =>
      Object.values(MEASURED).every((sample) => {
        const ratio = estimate(sample.text) / sample.tokens;
        return ratio >= MEASURED_BAND.floor && ratio <= MEASURED_BAND.ceiling;
      });
    expect(inBand(estimateTokens)).toBe(true);
    expect(inBand(withRatio(40))).toBe(false);
    expect(inBand(withRatio(1))).toBe(false);
    // …and the measured worst case the docblock states, produced here rather than quoted.
    const czech = MEASURED['czech'] as (typeof MEASURED)[string];
    expect(estimateTokens(czech.text)).toBe(260);
    expect(czech.tokens).toBe(452);
  });
});
