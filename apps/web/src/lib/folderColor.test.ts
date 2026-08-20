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
    const hues = new Set(paths.map((path) => folderColor(path).surface));
    expect(hues.size).toBeGreaterThan(3);
  });

  it('keeps tint and ink on the same hue so a label reads as part of its tile', () => {
    const { surface, ink, line } = folderColor('Job hunt');
    const hueOf = (value: string) => Number(/hsl\((\d+)/.exec(value)?.[1]);
    expect(hueOf(ink)).toBe(hueOf(surface));
    expect(hueOf(line)).toBe(hueOf(surface));
  });
});
