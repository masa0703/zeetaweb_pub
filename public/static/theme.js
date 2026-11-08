(function () {
  const STORAGE_KEY = 'zeeta-theme'
  const DARK_CLASS = 'theme-dark'
  const THEMES = ['light', 'dark', 'system']

  const normalizeTheme = (value) => (THEMES.indexOf(value) !== -1 ? value : 'system')

  const getTheme = () => {
    try {
      return normalizeTheme(localStorage.getItem(STORAGE_KEY))
    } catch (error) {
      return 'system'
    }
  }

  const systemPrefersDark = () => Boolean(
    window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
  )

  const isDark = (theme) => (theme === 'system' ? systemPrefersDark() : theme === 'dark')

  const applyTheme = () => {
    document.documentElement.classList.toggle(DARK_CLASS, isDark(getTheme()))
  }

  const setTheme = (nextTheme) => {
    try {
      localStorage.setItem(STORAGE_KEY, normalizeTheme(nextTheme))
    } catch (error) {
      // localStorage が使えない環境でも見た目の切替だけは動かす
    }
    applyTheme()
    window.dispatchEvent(new CustomEvent('zeeta:themechange', { detail: { theme: getTheme() } }))
  }

  if (window.matchMedia) {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const listener = () => {
      if (getTheme() === 'system') applyTheme()
    }
    if (media.addEventListener) {
      media.addEventListener('change', listener)
    } else if (media.addListener) {
      media.addListener(listener)
    }
  }

  applyTheme()

  window.ZeetaTheme = { getTheme, setTheme, applyTheme, isDark }
})()
