/* a1k9training — the site's only script. No build step, no dependencies. */
;(function () {
  'use strict'

  /* ---- Mobile navigation disclosure ------------------------------------ */
  var navToggle = document.querySelector('[data-nav-toggle]')
  var navPanel = document.querySelector('[data-nav-panel]')

  function setNav(open) {
    if (!navToggle || !navPanel) return
    navToggle.setAttribute('aria-expanded', open ? 'true' : 'false')
    navPanel.classList.toggle('hidden', !open)
  }

  if (navToggle && navPanel) {
    navToggle.addEventListener('click', function () {
      setNav(navToggle.getAttribute('aria-expanded') !== 'true')
    })
  }

  /* ---- Desktop dropdowns ------------------------------------------------
   * CSS already opens a group on hover and on focus-within. This only keeps
   * aria-expanded honest, and lets the chevron button pin a group open. */
  var groups = document.querySelectorAll('[data-dropdown]')

  Array.prototype.forEach.call(groups, function (group) {
    var toggle = group.querySelector('[data-dropdown-toggle]')
    if (!toggle) return
    var set = function (open) {
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false')
    }
    toggle.addEventListener('click', function () {
      set(toggle.getAttribute('aria-expanded') !== 'true')
    })
    group.addEventListener('pointerenter', function () { set(true) })
    group.addEventListener('pointerleave', function () { set(false) })
    group.addEventListener('focusin', function () { set(true) })
    group.addEventListener('focusout', function (e) {
      if (!group.contains(e.relatedTarget)) set(false)
    })
  })

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return
    setNav(false)
    Array.prototype.forEach.call(groups, function (group) {
      var toggle = group.querySelector('[data-dropdown-toggle]')
      if (toggle) toggle.setAttribute('aria-expanded', 'false')
    })
    if (document.activeElement && document.activeElement.blur) {
      document.activeElement.blur()
    }
  })

  /* ---- Deferred hero video facade ---------------------------------------
   * The poster image is the hero. A YouTube iframe is injected behind the
   * overlay only on a wide viewport, only when motion and data are welcome,
   * and only after the first real interaction or a 6s idle window. Nothing
   * from youtube.com is requested before that moment. */
  var hero = document.querySelector('[data-hero-video]')
  var videoId = hero && hero.getAttribute('data-video-id')
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  var saveData = !!(navigator.connection && navigator.connection.saveData)

  if (hero && videoId && !reduceMotion && !saveData && window.innerWidth >= 1024) {
    var armed = true
    var events = ['pointermove', 'scroll', 'touchstart', 'keydown']

    var play = function () {
      if (!armed) return
      armed = false
      events.forEach(function (name) { window.removeEventListener(name, play) })

      var frame = document.createElement('iframe')
      frame.title = 'Background footage of A1K9 dog training'
      frame.tabIndex = -1
      frame.setAttribute('aria-hidden', 'true')
      frame.setAttribute('allow', 'autoplay; encrypted-media')
      frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin')
      // Inline styles on purpose: this file is not a Tailwind source, so no
      // utility class written here would ever be generated.
      frame.style.cssText =
        'position:absolute;top:50%;left:50%;z-index:-20;width:177.78vh;' +
        'min-width:100%;height:56.25vw;min-height:100%;border:0;' +
        'transform:translate(-50%,-50%);pointer-events:none;'
      frame.src =
        'https://www.youtube-nocookie.com/embed/' + videoId +
        '?autoplay=1&mute=1&loop=1&playlist=' + videoId +
        '&controls=0&playsinline=1&rel=0'
      hero.appendChild(frame)
    }

    events.forEach(function (name) {
      window.addEventListener(name, play, { once: true, passive: true })
    })
    var startTimer = function () { setTimeout(play, 6000) }
    if (document.readyState === 'complete') startTimer()
    else window.addEventListener('load', startTimer, { once: true })
  }
})()
