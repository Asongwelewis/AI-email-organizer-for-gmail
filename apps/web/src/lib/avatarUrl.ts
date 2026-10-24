/**
 * Google hands out a 96px photo (`…=s96-c`), which is soft at the size the side panel and the menu
 * show it on a high-density screen. The same URL serves any size, so ask for one that stays sharp.
 */
export function sharpAvatarUrl(src: string): string {
  return /googleusercontent\.com\//.test(src) ? src.replace(/=s\d+(-c)?$/, '=s256-c') : src;
}
