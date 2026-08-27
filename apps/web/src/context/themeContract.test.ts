/// <reference types="node" />
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

// `index.html` comes through Vite's `?raw`. `theme.css` cannot: Vitest leaves CSS unprocessed by
// default, so a `?raw` import of a stylesheet resolves to an empty string and every assertion
// below would pass against nothing. Node types are pulled in for this file alone rather than
// added to a workspace that compiles for a browser.
import indexHtmlSource from '../../index.html?raw';
import {
  DEFAULT_THEME_PREFERENCE,
  THEME_COLOR,
  THEME_STORAGE_KEY,
  isThemePreference,
} from './useTheme';

const indexHtml = indexHtmlSource.replace(/\r\n/g, '\n');

/**
 * Comments are stripped first. theme.css opens by describing its own three states in prose, and a
 * selector quoted there is not a rule — matching it would parse the documentation instead of the
 * stylesheet, and quietly assert nothing.
 */
const themeCssSource = readFileSync(`${process.cwd()}/src/styles/theme.css`, 'utf8');
// Guard the read itself. A stylesheet that arrives empty would make every assertion below pass
// against nothing, which is the failure mode this whole file exists to rule out elsewhere.
if (themeCssSource.trim().length === 0) throw new Error('theme.css read as empty');

const themeCss = themeCssSource.replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');

/** The `{ … }` body of a rule, matched on braces so a nested at-rule comes out whole. */
function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`theme.css defines no \`${selector}\``);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    if (css[index] === '}') depth -= 1;
    if (depth === 0) return css.slice(open, index);
  }
  throw new Error(`unbalanced braces after \`${selector}\``);
}

const tokensIn = (css: string) =>
  new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((match) => match[1]!));

/** The pre-paint script, which is the only script inlined into the document head. */
const prePaintScript = indexHtml.slice(
  indexHtml.indexOf('<script>'),
  indexHtml.indexOf('</script>'),
);

/**
 * Three files hold one theme contract and none of them can import from the others: the pre-paint
 * script in `index.html` runs before any module exists, `theme.css` is stylesheet text, and
 * `useTheme` is the only one that is real TypeScript. All three say in comments that the others
 * have to change alongside them. This is that comment, enforced.
 */
describe('the theme contract the three files share', () => {
  it('has the pre-paint script read the key the app writes', () => {
    expect(prePaintScript).toContain(`'${THEME_STORAGE_KEY}'`);
  });

  it('has the pre-paint script fall back to the default the app falls back to', () => {
    // Dark is the default, not the OS preference. Reading the OS here would paint the wrong first
    // frame for everyone who never chose, which is the flash this script exists to prevent.
    expect(prePaintScript).toMatch(new RegExp(`:\\s*'${DEFAULT_THEME_PREFERENCE}'\\s*;`));
    expect(prePaintScript).toContain(`setAttribute('data-theme', '${DEFAULT_THEME_PREFERENCE}')`);
  });

  it('has the pre-paint script accept exactly the preferences the app recognises', () => {
    const compared = new Set(
      [...prePaintScript.matchAll(/stored === '([a-z]+)'/g)].map((match) => match[1]!),
    );

    expect(compared.size).toBeGreaterThan(0);
    for (const value of compared) expect(isThemePreference(value)).toBe(true);
    // And nothing the app accepts is missing, or that choice would not survive a reload.
    for (const value of ['dark', 'light', 'system']) expect(compared).toContain(value);
  });

  // `system` is the absence of a stamp, which is exactly the contract the CSS is written against:
  // stamping `data-theme="system"` would match none of its selectors.
  it('has `system` remove the stamp rather than invent a value for it', () => {
    expect(prePaintScript).toContain("removeAttribute('data-theme')");
    expect(prePaintScript).not.toContain("setAttribute('data-theme', 'system')");
  });

  it('paints the window ground the same colour in all three places', () => {
    const groundIn = (css: string) => css.match(/--surface-window:\s*([^;]+);/)![1]!.trim();

    expect(groundIn(ruleBody(themeCss, ':root {'))).toBe(THEME_COLOR.light);
    expect(groundIn(ruleBody(themeCss, ":root[data-theme='dark']"))).toBe(THEME_COLOR.dark);
    // `<meta name="theme-color">` takes a colour and not a custom property, so the browser paints
    // these behind the page. A mismatch shows up as a band above the content.
    expect(indexHtml).toContain(
      `<meta name="theme-color" media="(prefers-color-scheme: light)" content="${THEME_COLOR.light}" />`,
    );
    expect(indexHtml).toContain(
      `<meta name="theme-color" media="(prefers-color-scheme: dark)" content="${THEME_COLOR.dark}" />`,
    );
    expect(indexHtml).toContain(`<meta name="theme-color" content="${THEME_COLOR.dark}" />`);
  });
});

describe('theme.css defines its palette in three states', () => {
  const light = ruleBody(themeCss, ':root {');
  const darkBySystem = ruleBody(themeCss, '@media (prefers-color-scheme: dark)');
  const darkByChoice = ruleBody(themeCss, ":root[data-theme='dark']");

  it('guards the system-dark block so an explicit light choice still wins', () => {
    expect(darkBySystem).toContain(":root:not([data-theme='light'])");
  });

  /**
   * The systematic form of the bug this interface was already found to have once: a landing CTA
   * that rendered white-on-white in dark mode. A token whose only definition sits inside a dark
   * block has no value at all in light, and the element falls back to whatever it inherits.
   */
  it('gives every token a value on bare `:root`, so nothing is defined only in the dark', () => {
    const base = tokensIn(light);
    expect(base.size).toBeGreaterThan(0);

    for (const token of tokensIn(darkBySystem)) expect(base).toContain(token);
    for (const token of tokensIn(darkByChoice)) expect(base).toContain(token);
  });

  /**
   * The toggle has to reach everything the OS preference reaches. It did not: four `*-on-invert`
   * tokens were redefined for OS-dark and left out of the toggle, so choosing Dark on a light
   * machine left the landing band at its light `#1d1d1f` — one hex digit from the `#1c1c1e` page
   * it sits on, and therefore invisible.
   */
  it('redefines the same tokens whether dark came from the OS or from the toggle', () => {
    expect([...tokensIn(darkByChoice)].sort()).toEqual([...tokensIn(darkBySystem)].sort());
  });
});
