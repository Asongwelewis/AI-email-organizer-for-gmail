import { describe, expect, it } from 'vitest';

import { folderColor } from './folderColor';

describe('folderColor', () => {
  // The whole point: a folder learned by colour keeps that colour between renders and sessions.
  it('gives one path the same colour every time', () => {
    expect(folderColor('Job hunt/Applications sent')).toEqual(
      folderColor('Job hunt/Applications sent'),
    );
  });

  it('does not depend on the order folders are rendered in', () => {
    const paths = ['Job hunt', 'Money in', 'Engineering', 'Learning'];
    const first = paths.map(folderColor);
    const second = [...paths].reverse().map(folderColor).reverse();
    expect(second).toEqual(first);
  });

  it('ignores case so a rename that only changes capitalisation keeps the colour', () => {
    expect(folderColor('Job hunt')).toEqual(folderColor('JOB HUNT'));
  });

  it('spreads a realistic tree across several hues', () => {
    const paths = [
      'Job hunt',
      'Job hunt/Applications sent',
      'Engineering',
      'Engineering/Infrastructure',
      'Learning',
      'Money in',
    ];
    const hues = new Set(paths.map((path) => folderColor(path).hue));
    expect(hues.size).toBeGreaterThan(3);
  });

  /**
   * Only the hue is decided here. Lightness and saturation belong to the theme, which is what lets
   * one folder keep its identity in light and dark without the hash knowing which is showing —
   * so what this has to guarantee is a usable hue and nothing else.
   */
  it('returns a bare hue in degrees, so the theme can choose the lightness', () => {
    const { hue } = folderColor('Job hunt');
    expect(Number.isInteger(hue)).toBe(true);
    expect(hue).toBeGreaterThanOrEqual(0);
    expect(hue).toBeLessThan(360);
  });

  it('never returns a hue outside the wheel, for any path', () => {
    const paths = Array.from({ length: 200 }, (_, index) => `MailMind/Folder ${index}`);
    for (const path of paths) {
      const { hue } = folderColor(path);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });
});
