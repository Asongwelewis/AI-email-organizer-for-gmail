import { describe, expect, it } from 'vitest';

import { gmailLabelUrl, gmailMessageUrl } from './gmailLink';

describe('gmailMessageUrl', () => {
  // Filed mail has left the inbox, so #inbox/<id> resolves to nothing.
  it('addresses the message in all mail, not the inbox', () => {
    const url = gmailMessageUrl('person@example.com', '18f2a9c4b1');
    expect(url).toContain('#all/18f2a9c4b1');
    expect(url).not.toContain('#inbox/');
  });

  // /u/0 is whichever account the browser profile happens to list first.
  it('selects the account by address rather than by profile index', () => {
    const url = gmailMessageUrl('person@example.com', '18f2a9c4b1');
    expect(url).toContain('authuser=person%40example.com');
    expect(url).not.toContain('/u/0/');
  });

  it('still produces a usable link when the connected address is unknown', () => {
    const url = gmailMessageUrl(null, '18f2a9c4b1');
    expect(url).toBe('https://mail.google.com/mail/#all/18f2a9c4b1');
  });

  it('escapes ids and label paths rather than pasting them into the fragment', () => {
    expect(gmailMessageUrl(null, 'a/b c')).toContain('#all/a%2Fb%20c');
    expect(gmailLabelUrl('person@example.com', 'MailMind/Job hunt')).toContain(
      '#label/MailMind%2FJob%20hunt',
    );
  });
});
