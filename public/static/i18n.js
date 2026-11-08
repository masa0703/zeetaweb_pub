(function () {
  const normalizeLocale = (value) => {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
    return normalized.startsWith('ja') ? 'ja' : 'en'
  }

  const locale = normalizeLocale(window.__LOCALE__ || navigator.language)
  const hasInlineDictionary = window.__I18N__ && typeof window.__I18N__ === 'object'
  let dictionary = hasInlineDictionary ? window.__I18N__ : {}

  const getValue = (key) => key.split('.').reduce((value, part) => value && value[part], dictionary)

  const t = (key, params) => {
    const value = getValue(key)
    if (typeof value !== 'string') {
      console.warn(`[ZeetaI18n] Missing translation: ${key}`)
      return key
    }
    return value.replace(/\{([^}]+)\}/g, (match, name) => (
      params && Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
    ))
  }

  const ready = hasInlineDictionary
    ? Promise.resolve()
    : fetch(`/static/i18n/${locale}.json`)
      .then((response) => response.ok ? response.json() : {})
      .then((loadedDictionary) => { dictionary = loadedDictionary || {} })
      .catch(() => { dictionary = {} })

  const applyI18n = (root = document) => {
    root.querySelectorAll('[data-i18n]').forEach((element) => {
      element.textContent = t(element.getAttribute('data-i18n'))
    })
    root.querySelectorAll('[data-i18n-attr]').forEach((element) => {
      element.getAttribute('data-i18n-attr').split(';').forEach((entry) => {
        const separator = entry.indexOf(':')
        if (separator === -1) return
        const attribute = entry.slice(0, separator).trim()
        const key = entry.slice(separator + 1).trim()
        if (attribute && key) element.setAttribute(attribute, t(key))
      })
    })
  }

  const setLocale = (nextLocale) => {
    document.cookie = `lang=${normalizeLocale(nextLocale)}; path=/; max-age=31536000; SameSite=Lax`
    location.reload()
  }

  window.ZeetaI18n = { locale, t, applyI18n, setLocale, ready }
  window.t = t

  document.addEventListener('DOMContentLoaded', () => {
    ready.then(() => applyI18n()).catch(() => applyI18n())
  })
})()
