import jaDictionary from '../../public/static/i18n/ja.json' with { type: 'json' }
import enDictionary from '../../public/static/i18n/en.json' with { type: 'json' }

export const SUPPORTED_LOCALES = ['ja', 'en'] as const
export type Locale = (typeof SUPPORTED_LOCALES)[number]

export const DEFAULT_LOCALE: Locale = 'en'

export function normalizeLocale(value: string | null | undefined): Locale | null {
  const normalized = value?.trim().toLowerCase()
  if (normalized?.startsWith('ja')) return 'ja'
  if (normalized?.startsWith('en')) return 'en'
  return null
}

export function resolveLocaleFromRequest(
  cookieValue: string | null | undefined,
  acceptLanguage: string | null | undefined,
): Locale {
  const cookieLocale = normalizeLocale(cookieValue)
  if (cookieLocale) return cookieLocale

  const acceptLanguageLocale = normalizeLocale(acceptLanguage?.split(',')[0])
  return acceptLanguageLocale === 'ja' ? 'ja' : DEFAULT_LOCALE
}

export function serverT(
  locale: Locale,
  key: string,
  params?: Record<string, string | number>,
): string {
  const dictionary: unknown = locale === 'ja' ? jaDictionary : enDictionary
  const value = key.split('.').reduce<unknown>((current, part) => {
    if (!current || typeof current !== 'object') return undefined
    return (current as Record<string, unknown>)[part]
  }, dictionary)

  if (typeof value !== 'string') return key

  return value.replace(/\{([^}]+)\}/g, (match, name: string) => (
    params && Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
  ))
}
