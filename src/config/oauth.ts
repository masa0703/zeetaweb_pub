/**
 * OAuth Configuration for Google and GitHub Authentication
 *
 * This file contains OAuth 2.0 configuration for external authentication providers.
 * Environment variables must be set in wrangler.toml or via Cloudflare dashboard.
 */

export interface OAuthConfig {
  clientId: string
  clientSecret: string
  redirectUri: string
  authUrl: string
  tokenUrl: string
  userInfoUrl: string
  scope: string
}

export interface OAuthProviderConfig {
  google: OAuthConfig
  github: OAuthConfig
}

/**
 * Get OAuth configuration for all providers
 * @param env - Cloudflare Workers environment bindings
 * @returns OAuth configuration object for all providers
 */
export function getOAuthConfig(env: any): OAuthProviderConfig {
  const appUrl = env.APP_URL || 'http://localhost:3000'

  return {
    google: {
      clientId: env.GOOGLE_CLIENT_ID || '',
      clientSecret: env.GOOGLE_CLIENT_SECRET || '',
      redirectUri: `${appUrl}/auth/callback/google`,
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      userInfoUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
      scope: 'openid email profile'
    },
    github: {
      clientId: env.GITHUB_CLIENT_ID || '',
      clientSecret: env.GITHUB_CLIENT_SECRET || '',
      redirectUri: `${appUrl}/auth/callback/github`,
      authUrl: 'https://github.com/login/oauth/authorize',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      userInfoUrl: 'https://api.github.com/user',
      scope: 'read:user user:email'
    }
  }
}

/**
 * Validate that required OAuth environment variables are set
 * @param env - Cloudflare Workers environment bindings
 * @returns Object with validation results
 */
export function validateOAuthConfig(env: any): { valid: boolean; missing: string[] } {
  const requiredVars = [
    'APP_URL',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GITHUB_CLIENT_ID',
    'GITHUB_CLIENT_SECRET',
    'JWT_SECRET'
  ]

  const missing = requiredVars.filter(varName => !env[varName])

  return {
    valid: missing.length === 0,
    missing
  }
}

/**
 * OAuth user information interface (normalized across providers)
 */
export interface OAuthUserInfo {
  id: string           // Provider's user ID
  email: string
  name: string
  picture?: string     // Profile picture URL
  provider: 'google' | 'github'
}

/**
 * Normalize Google OAuth user info to common format
 */
export function normalizeGoogleUser(googleUser: any): OAuthUserInfo | null {
  if (googleUser?.verified_email !== true) return null
  return {
    id: googleUser.id || googleUser.sub,
    email: googleUser.email,
    name: googleUser.name,
    picture: googleUser.picture,
    provider: 'google'
  }
}

/**
 * Normalize GitHub OAuth user info to common format
 */
export function normalizeGitHubUser(githubUser: any): OAuthUserInfo {
  return {
    id: String(githubUser.id),
    email: githubUser.email,
    name: githubUser.name || githubUser.login,
    picture: githubUser.avatar_url,
    provider: 'github'
  }
}

/**
 * Pick the best email from GitHub GET /user/emails entries.
 * GitHub returns email: null on /user when the account has no public email,
 * even though the user:email scope grants access to /user/emails.
 * Prefers the primary+verified address, then any verified address.
 */
export function pickPrimaryGithubEmail(emails: unknown): string | null {
  if (!Array.isArray(emails)) return null
  const entries = emails.filter(
    (entry): entry is { email: string; primary: boolean; verified: boolean } =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as { email?: unknown }).email === 'string'
  )
  const primaryVerified = entries.find((entry) => entry.primary && entry.verified)
  if (primaryVerified) return primaryVerified.email
  const verified = entries.find((entry) => entry.verified)
  return verified ? verified.email : null
}
