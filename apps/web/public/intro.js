/**
 * The opening animation: four seconds of mail flying into folders, ending on the AMO mark, then
 * the landing page.
 *
 * A plain script rather than part of the app, so it starts with the HTML and does not wait for the
 * JavaScript bundle: the video is on screen while React is still downloading, and the landing page
 * is already rendered underneath when it fades out.
 *
 * It plays once per visit (per tab session), only on the landing page, never for someone who asked
 * their system for less motion, and it never holds the page hostage: if the browser will not play
 * it, or it has not started within a moment on a slow connection, the landing page simply shows.
 */
(function () {
  var intro = document.getElementById('amo-intro');
  if (!intro) return;

  var SEEN_KEY = 'amo_intro_seen';
  var START_TIMEOUT_MS = 2500;
  var finished = false;

  function seen() {
    try {
      return window.sessionStorage.getItem(SEEN_KEY) === '1';
    } catch {
      return false;
    }
  }

  function remember() {
    try {
      window.sessionStorage.setItem(SEEN_KEY, '1');
    } catch {
      /* Private windows can refuse storage; the intro then just plays again next time. */
    }
  }

  function announce() {
    window.__amoIntroDone = true;
    window.dispatchEvent(new Event('amo:intro-done'));
  }

  var reduceMotion =
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (window.location.pathname !== '/' || reduceMotion || seen()) {
    intro.parentNode.removeChild(intro);
    announce();
    return;
  }

  var video = intro.querySelector('video');
  // A phone gets the 720p cut: the same picture at less than half the download.
  var physicalWidth = window.innerWidth * (window.devicePixelRatio || 1);
  video.src = intro.getAttribute(physicalWidth > 1400 ? 'data-src-large' : 'data-src-small');
  intro.hidden = false;
  document.documentElement.classList.add('amo-intro-playing');

  function finish() {
    if (finished) return;
    finished = true;
    remember();
    intro.classList.add('amo-intro--leaving');
    document.documentElement.classList.remove('amo-intro-playing');
    announce();
    window.setTimeout(function () {
      if (intro.parentNode) intro.parentNode.removeChild(intro);
    }, 450);
  }

  var startGuard = window.setTimeout(finish, START_TIMEOUT_MS);
  video.addEventListener('playing', function () {
    window.clearTimeout(startGuard);
    // However the clip ends, it ends: a second past its length at the latest.
    window.setTimeout(finish, ((video.duration || 4) + 1) * 1000);
  });
  video.addEventListener('ended', finish);
  video.addEventListener('error', finish);
  intro.querySelector('.amo-intro__skip').addEventListener('click', finish);
  window.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') finish();
  });

  var playing = video.play();
  if (playing && typeof playing.catch === 'function') playing.catch(finish);
})();
