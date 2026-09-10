import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * **No source in this application may hand a string to the DOM as HTML.**
 *
 * The rule is BD-022 pointed at a browser: everything this app renders — ticket text, MR comments,
 * model output, tool results, log lines, KB documents — is attacker-influenced, and a single
 * `dangerouslySetInnerHTML` anywhere would make every other precaution in `ui/untrusted-text.ts`
 * irrelevant. React escapes what goes into a text node; it does not escape what goes into that
 * prop, and there is no third option.
 *
 * A rule written only in a docblock is a rule the next work package will not know about (standing
 * rule 30: when a defect is mechanically detectable, add the check). This is that check, and it is
 * a *test* rather than a lint rule so that it runs in a tier and can itself be mutated: change any
 * component to use `dangerouslySetInnerHTML` and this fails by name.
 *
 * **Why the walk cannot pass by finding nothing** (standing rule 4): the file count is asserted
 * first, and one file's content is asserted to have been read, so an empty walk — a moved
 * directory, a broken filter — fails here rather than reporting a clean scan of zero files.
 *
 * **Block comments are stripped before the scan, and only block comments.** A docblock that
 * explains this rule has to name the sinks it forbids, and a guard that reads prose about itself as
 * evidence is the vacuous pass `scripts/verify.test.ts` had to fix in the workflow parser. Stripping
 * line comments as well would be the dangerous direction — a `//` inside a string literal would
 * take the rest of a real line of code with it — so `stripBlockComments` removes exactly `/* … *`+`/`
 * and both directions are asserted below.
 */
const SOURCE_ROOT = dirname(fileURLToPath(import.meta.url));

/**
 * **And no source outside `ui/untrusted.tsx` may write a URL attribute.**
 *
 * `ui/untrusted-text.ts` used to say "the only place this app produces an `href`" in a docblock
 * while five call sites on the board and the task screen were putting a DTO string straight into
 * `href`. Nothing failed, because `urlSchema` is `z.url()` — which accepts `javascript:`, `data:`,
 * `vbscript:` and `file:` — and because React 19.3 happens to rewrite a `javascript:` URL. That
 * defence is a framework version's, it is unasserted, and it is partial: React passes `data:` and
 * `vbscript:` through verbatim.
 *
 * The rule earned there: *a "this is the only place X happens" docblock must be enforced by the
 * same check that enforces X, or it is decoration.* So the sentence lives here as a check —
 * `href=` and `src=` are attributes of `ui/untrusted.tsx` and of nowhere else, which forces every
 * URL through `safeHref` (`UntrustedText` for a link in text, `ExternalLink` for one a DTO
 * carried).
 *
 * ### The spellings it catches, listed rather than summarised
 *
 * The first version of this guard was the name followed by `=` and a docblock claiming that a
 * *property* form "does not put an attribute on an element". That sentence is false for two of
 * them, and a file containing both `{...{ href: u }}` and `createElement('a', { href: u })` passed
 * every case here — rule 44 again, on the guard rule 44 produced. So the check is now a list of
 * spellings and the docblock is that same list:
 *
 * | form | example | why it reaches the DOM |
 * |---|---|---|
 * | attribute or assignment | `href={u}`, `href = u`, `el.href = u` | JSX prop, or the property |
 * | subscript assignment | `el['href'] = u` | the same property, quoted |
 * | `setAttribute`, `setAttributeNS` | `el.setAttribute('href', u)` | the attribute by name |
 * | a property inside a **sink group** | `{...{ href: u }}`, `createElement('a', { href: u })`, `cloneElement(node, { href: u })`, `Object.assign(el, { href })` | the object *is* the props |
 *
 * A "sink group" is the bracketed text of a JSX/object spread, `createElement`, `cloneElement` or
 * `Object.assign`; the property form is refused there and nowhere else, so
 * `navigate({ href: path })` (a router argument) and `segments.push({ kind: 'link', href })` (the
 * output of `safeHref`, in `ui/untrusted-text.ts`) still pass. Names match case-insensitively
 * because `setAttribute` lower-cases its argument in an HTML document — `setAttribute('SRCSET', u)`
 * sets `srcset` — which is asserted below against a real element rather than cited from the spec.
 *
 * ### What it cannot catch, stated rather than implied
 *
 * - **Indirection.** `const props = { href: u }; <a {...props} />`, or `Object.assign(el, props)`:
 *   the literal is not at the sink and a source-text guard does not follow a variable.
 * - **A computed name.** `el.setAttribute(name, u)`, `el[name] = u`.
 * - **Navigation rather than an attribute.** `window.open(u)`, `location.assign(u)`.
 *   (`location.href = u` *is* caught, by the assignment form.)
 * - **Three URL-bearing attributes are deliberately not in `URL_ATTRIBUTES`:** `action`, `data`
 *   and `background`. All three collide with ordinary identifiers — a reducer's `action`,
 *   react-query's `data`, and `Object.assign(el.style, { background })` — so including them buys
 *   coverage of an attribute this app has never rendered at the price of failing the build on code
 *   that has nothing to do with URLs, and a guard that cries wolf earns an exception list, which
 *   is how it grows a hole (rule 7). Measured, not assumed: all three are currently absent from
 *   every source here, so this is a judgement about the future rather than about today. A screen
 *   that needs one of them adds it to the list.
 * - **An attribute nobody has thought of.** The list is hand-maintained, which rule 7 says drifts;
 *   what stops the drift from mattering is that the sinks below are enumerated the other way
 *   round — by substring, over the whole tree — so the worst an omission here can do is let a URL
 *   through, not markup.
 *
 * The residue is therefore a *navigation* risk (an uncaught `javascript:` URL), never a
 * markup-injection one.
 */
const URL_ATTRIBUTES = [
  'href',
  'src',
  'srcSet',
  'formAction',
  'poster',
  'ping',
  'cite',
  'xlinkHref',
] as const;

/** The one module allowed to write them, relative to `SOURCE_ROOT`. */
const URL_ATTRIBUTE_HOME = join('ui', 'untrusted.tsx');

/**
 * The openers of a "sink group": text whose object literal becomes an element's props.
 *
 * `{...` is the JSX/object spread; the three calls take props or a target element. Each is matched
 * at its own start, and the group is read to the bracket that closes it.
 */
const SINK_GROUP_OPENERS = [
  /\{\s*\.\.\./gu,
  /\bcreateElement\s*\(/gu,
  /\bcloneElement\s*\(/gu,
  /\bObject\s*\.\s*assign\s*\(/gu,
] as const;

/**
 * The bracketed text starting at `from`, or the rest of the source when the brackets never
 * balance. Over-reading is the fail-closed direction: it can only make the guard refuse more.
 */
const groupAt = (source: string, from: number): string => {
  let depth = 0;
  for (let index = from; index < source.length; index += 1) {
    const character = source[index];
    if (character === '(' || character === '{' || character === '[') {
      depth += 1;
    } else if (character === ')' || character === '}' || character === ']') {
      depth -= 1;
      if (depth <= 0) {
        return source.slice(from, index + 1);
      }
    }
  }
  return source.slice(from);
};

/** `href:`, `href,` or the shorthand `href }` — a property key, not a mention. */
const propertyKey = (attribute: string): RegExp => new RegExp(`\\b${attribute}\\s*[:,}]`, 'iu');

export const writesUrlAttribute = (source: string, attribute: string): boolean => {
  const code = stripBlockComments(source);
  const direct = [
    // `href={…}`, `href = …`, `el.href = …`. Not `href === x`: `[^=]` rejects the comparison.
    new RegExp(`\\b${attribute}\\s*=[^=]`, 'iu'),
    // `el['href'] = …`
    new RegExp(`\\[\\s*(['"\`])${attribute}\\1\\s*\\]\\s*=[^=]`, 'iu'),
    // `setAttribute('href', …)` and `setAttributeNS(ns, 'href', …)`
    new RegExp(`\\bsetAttribute(?:NS)?\\s*\\([^)]*(['"\`])${attribute}\\1`, 'iu'),
  ];
  if (direct.some((pattern) => pattern.test(code))) {
    return true;
  }
  const key = propertyKey(attribute);
  return SINK_GROUP_OPENERS.some((opener) => {
    opener.lastIndex = 0;
    return [...code.matchAll(opener)].some((match) => key.test(groupAt(code, match.index)));
  });
};

/** Every sink that turns a string into markup. `innerText` and `textContent` are not sinks. */
const FORBIDDEN = [
  'dangerouslySetInnerHTML',
  'innerHTML',
  'outerHTML',
  'insertAdjacentHTML',
  'document.write',
  'srcdoc',
  'createContextualFragment',
  'new Function',
  'eval(',
] as const;

/**
 * Removes `/* … *`+`/` comments and nothing else. Exported so both directions are testable.
 */
export const stripBlockComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ');

const walk = (directory: string): string[] =>
  readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

const sourceFiles = (): string[] =>
  walk(SOURCE_ROOT).filter(
    (path) =>
      /\.(ts|tsx)$/.test(path) &&
      // The tests may *name* a sink in order to assert its absence; the rule is about the app.
      !/\.test\.(ts|tsx)$/.test(path),
  );

describe('the web application', () => {
  it('has sources to scan at all', () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(20);
    // And they are readable: a walk that returned paths it cannot read would also report nothing.
    expect(readFileSync(join(SOURCE_ROOT, 'ui', 'untrusted.tsx'), 'utf8')).toContain(
      'UntrustedText',
    );
  });

  it.each(FORBIDDEN)('never uses %s', (sink) => {
    const offenders = sourceFiles()
      .filter((path) => stripBlockComments(readFileSync(path, 'utf8')).includes(sink))
      .map((path) => relative(SOURCE_ROOT, path));

    expect(
      offenders,
      `${sink} turns a string into markup; every string this app renders is untrusted (BD-022)`,
    ).toEqual([]);
  });

  it('strips a sink named in a block comment but never one written in code', () => {
    // The direction that must be forgiving: prose about the rule.
    expect(stripBlockComments('/** never use innerHTML */\nconst a = 1;')).not.toContain(
      'innerHTML',
    );
    // The direction that must not be: code, including code on a line that also has a `//`.
    expect(stripBlockComments('const url = "https://x"; element.innerHTML = value;')).toContain(
      'innerHTML',
    );
    expect(stripBlockComments('<div dangerouslySetInnerHTML={{ __html: value }} />')).toContain(
      'dangerouslySetInnerHTML',
    );
  });

  it.each(URL_ATTRIBUTES)('writes %s in no source but ui/untrusted.tsx', (attribute) => {
    const offenders = sourceFiles()
      .map((path) => relative(SOURCE_ROOT, path))
      .filter(
        (path) =>
          path !== URL_ATTRIBUTE_HOME &&
          writesUrlAttribute(readFileSync(join(SOURCE_ROOT, path), 'utf8'), attribute),
      );

    expect(
      offenders,
      `these files write ${attribute} onto an element — as an attribute, a property, a setAttribute call or a spread. A DTO field is not a safe URL (urlSchema is z.url(), which accepts javascript:, data:, vbscript: and file:), so render it with ExternalLink from ui/untrusted.tsx, which calls safeHref`,
    ).toEqual([]);
  });

  it.each(URL_ATTRIBUTES)('would notice %s if a screen ever wrote one', (attribute) => {
    // Rule 4 for the whole list rather than for its first member: `href` is the only name any
    // source actually writes, so without this every other entry would report a clean scan whether
    // the guard could see it or not. Each is checked in the attribute form and in the property
    // form, which are the two halves of the check.
    expect(writesUrlAttribute(`<element ${attribute}={candidate} />`, attribute)).toBe(true);
    expect(writesUrlAttribute(`<element {...{ ${attribute}: candidate }} />`, attribute)).toBe(
      true,
    );
  });

  it('can see the attribute it forbids, in the one file that is allowed to write it', () => {
    // Rule 4: a scan that found nothing because it cannot see anything is not a clean scan. The
    // home module *does* write `href=`, so the emptiness above is a property of the other files.
    expect(
      writesUrlAttribute(readFileSync(join(SOURCE_ROOT, URL_ATTRIBUTE_HOME), 'utf8'), 'href'),
    ).toBe(true);
    // And what it must and must not match, spelled out.
    expect(writesUrlAttribute('<a href={resolved}>x</a>', 'href')).toBe(true);
    expect(writesUrlAttribute('<img src="/logo.png" />', 'src')).toBe(true);
    expect(writesUrlAttribute('const href = safeHref(candidate);', 'href')).toBe(true);
    expect(writesUrlAttribute('const target = location.href;', 'href')).toBe(false);
    expect(writesUrlAttribute('await navigate({ href: safeRedirectPath(next) });', 'href')).toBe(
      false,
    );
    expect(writesUrlAttribute('if (href === null) return null;', 'href')).toBe(false);
    // And a docblock about the rule is prose, not a violation.
    expect(writesUrlAttribute('/** never write href={value} */', 'href')).toBe(false);
  });

  /**
   * The five spellings the first version of this guard was blind to.
   *
   * Each one was planted in a real source file and confirmed to fail this suite by name before it
   * was written down here; the strings below are what those plants looked like. `{...{ href: u }}`
   * and `createElement('a', { href: u })` are the two the old docblock explicitly excused.
   */
  it.each([
    ['a JSX spread of an object literal', '<a {...{ href: candidate }}>x</a>', 'href'],
    ['createElement', "createElement('a', { href: candidate }, label)", 'href'],
    ['cloneElement', 'cloneElement(anchor, { href: candidate })', 'href'],
    ['setAttribute', "anchor.setAttribute('href', candidate);", 'href'],
    ['setAttributeNS', 'anchor.setAttributeNS(null, "href", candidate);', 'href'],
    ['Object.assign with a shorthand', 'Object.assign(anchor, { href });', 'href'],
    ['a subscript assignment', "anchor['href'] = candidate;", 'href'],
    ['the HTML spelling of srcSet', '<img srcset={candidate} />', 'srcSet'],
    ['the React spelling of srcSet', '<img srcSet={candidate} />', 'srcSet'],
    ['formAction', '<button formAction={candidate} />', 'formAction'],
    ['formaction by setAttribute', "button.setAttribute('formaction', candidate);", 'formAction'],
  ])('catches %s', (_name, source, attribute) => {
    expect(writesUrlAttribute(source, attribute)).toBe(true);
  });

  it.each([
    ['a spread of a variable, which it cannot follow', '<a {...props} />', 'href'],
    ['a property outside a sink group', 'const link = { href: resolved };', 'href'],
    ['a similarly spelled key', 'Object.assign(node, { hrefs: list });', 'href'],
    ['a mention in a string', "throw new Error('href is not allowed here');", 'href'],
  ])('does not match %s', (_name, source, attribute) => {
    expect(writesUrlAttribute(source, attribute)).toBe(false);
  });

  it('matches names the way the DOM compares them, measured on an element', () => {
    // The case-insensitive flag is a claim about the DOM, so it is asked rather than assumed:
    // `setAttribute` lower-cases its qualified name in an HTML document, so a guard that only
    // knew `srcSet` would miss the spelling that actually works.
    const image = document.createElement('img');
    image.setAttribute('SRCSET', '/logo.png 1x');
    expect(image.getAttribute('srcset')).toBe('/logo.png 1x');

    expect(writesUrlAttribute("image.setAttribute('SRCSET', candidate);", 'srcSet')).toBe(true);
    expect(writesUrlAttribute('<button FORMACTION={candidate} />', 'formAction')).toBe(true);
  });

  it('links DTO URLs through ExternalLink on the screens that have them', () => {
    // The counterpart to the prohibition: the board and the task screen do render provider URLs,
    // so "no href anywhere" is not true because the app links to nothing (standing rule 4).
    const users = sourceFiles()
      .filter((path) => stripBlockComments(readFileSync(path, 'utf8')).includes('<ExternalLink'))
      .map((path) => relative(SOURCE_ROOT, path));

    expect(users).toContain(join('features', 'board.tsx'));
    expect(users).toContain(join('features', 'task-detail.tsx'));
  });

  it('renders untrusted text through the one module that is allowed to', () => {
    // A positive counterpart to the prohibitions: the screens do use the safe renderers, so the
    // assertions above are not vacuously true of an application that renders nothing.
    const users = sourceFiles().filter((path) =>
      stripBlockComments(readFileSync(path, 'utf8')).includes('UntrustedText'),
    );
    expect(users.length).toBeGreaterThan(5);
  });
});
