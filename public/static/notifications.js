/**
 * Notification Management
 * Handles fetching, displaying, and managing notifications
 */

let notificationPollingInterval = null
let isNotificationDropdownOpen = false

const notificationTranslationKeys = {
  invitation: 'notification.invitation',
  invitation_accepted: 'notification.invitationAccepted'
}

function getNotificationContent(notification) {
  const keyPrefix = notificationTranslationKeys[notification.type]
  const hasParams = notification.params && typeof notification.params === 'object' && !Array.isArray(notification.params)
  if (!keyPrefix || !hasParams) {
    return { title: notification.title, message: notification.message || '' }
  }

  const titleKey = `${keyPrefix}.title`
  const messageKey = `${keyPrefix}.message`
  const translatedTitle = t(titleKey, notification.params)
  const translatedMessage = t(messageKey, notification.params)

  return {
    title: translatedTitle === titleKey ? notification.title : translatedTitle,
    message: translatedMessage === messageKey ? notification.message || '' : translatedMessage
  }
}

/**
 * Initialize notification system
 */
function initNotifications() {
  // Load notifications on page load
  loadNotifications()

  // Start polling every 60 seconds
  startNotificationPolling()

  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    const dropdown = document.getElementById('notification-dropdown')
    const bell = document.querySelector('.notification-bell') || e.target.closest('[onclick="toggleNotifications()"]')

    if (dropdown && !dropdown.contains(e.target) && !bell?.contains(e.target)) {
      closeNotifications()
    }
  })
}

/**
 * Start polling for new notifications
 */
function startNotificationPolling() {
  if (notificationPollingInterval) {
    clearInterval(notificationPollingInterval)
  }

  // Poll every 60 seconds
  notificationPollingInterval = setInterval(() => {
    loadNotifications()
  }, 60000) // 60 seconds
}

/**
 * Stop notification polling
 */
function stopNotificationPolling() {
  if (notificationPollingInterval) {
    clearInterval(notificationPollingInterval)
    notificationPollingInterval = null
  }
}

/**
 * Load notifications from the server
 */
async function loadNotifications() {
  try {
    const response = await fetch('/api/notifications', {
      method: 'GET',
      credentials: 'include'
    })

    if (!response.ok) {
      if (response.status === 401) {
        window.ZeetaAuth?.handleUnauthorized?.()
        return
      }
      const text = await response.text().catch(() => null)
      console.error('Failed to load notifications:', response.status, text)
      return
    }

    const result = await response.json().catch((e) => {
      console.error('Failed to parse /api/notifications JSON:', e)
      return null
    })

    if (result && result.success && result.data) {
      displayNotifications(result.data)
      updateNotificationBadge(result.data)
    } else {
      console.warn('[notifications] no notifications data', result)
    }
  } catch (error) {
    console.error('Error loading notifications:', error)
  }
}

/**
 * Display notifications in the dropdown
 */
function displayNotifications(notifications) {
  const listElement = document.getElementById('notification-list')
  if (!listElement) return
  try {
    if (!notifications || notifications.length === 0) {
    listElement.innerHTML = `
      <div style="
        padding: 3rem 1.5rem;
        text-align: center;
        color: #718096;
      ">
        <i class="fas fa-bell-slash" style="font-size: 2rem; opacity: 0.5; margin-bottom: 0.5rem;"></i>
        <p style="margin: 0;">${t('notification.empty')}</p>
      </div>
    `
    return
  }
    listElement.innerHTML = notifications.map(notification => {
    const isUnread = !notification.is_read
    const timeAgo = formatTimeAgo(notification.created_at)
    const content = getNotificationContent(notification)

    return `
      <div
        class="notification-item ${isUnread ? 'unread' : ''}"
        onclick="handleNotificationClick(${notification.id}, '${escapeHtml(notification.link || '')}')"
        style="
          padding: 1rem 1.25rem;
          border-bottom: 1px solid #f7fafc;
          cursor: pointer;
          ${isUnread ? 'background-color: #eef2ff;' : ''}
        "
      >
        <div style="font-weight: ${isUnread ? '600' : '500'}; color: #1a202c; margin-bottom: 0.25rem;">
          ${escapeHtml(content.title)}
        </div>
        <div style="font-size: 0.875rem; color: #4a5568; margin-bottom: 0.5rem;">
          ${escapeHtml(content.message)}
        </div>
        <div style="font-size: 0.75rem; color: #a0aec0;">
          ${timeAgo}
        </div>
      </div>
    `
    }).join('')
    return
  } catch (e) {
    console.error('Error rendering notifications:', e, notifications)
  }
}

/**
 * Update notification badge count
 */
function updateNotificationBadge(notifications) {
  const badge = document.getElementById('notification-badge')
  if (!badge) return

  const unreadCount = notifications.filter(n => !n.is_read).length

  if (unreadCount > 0) {
    badge.textContent = unreadCount > 99 ? '99+' : unreadCount
    badge.style.display = 'flex'
  } else {
    badge.style.display = 'none'
  }
}

/**
 * Toggle notification dropdown
 */
function toggleNotifications() {
  const dropdown = document.getElementById('notification-dropdown')
  if (!dropdown) return

  if (isNotificationDropdownOpen) {
    closeNotifications()
  } else {
    openNotifications()
  }
}

/**
 * Open notification dropdown
 */
function openNotifications() {
  const dropdown = document.getElementById('notification-dropdown')
  if (!dropdown) return

  dropdown.classList.add('active')
  document.getElementById('notification-bell-btn')?.setAttribute('aria-expanded', 'true')
  isNotificationDropdownOpen = true

  // Reload notifications when opening
  loadNotifications()
}

/**
 * Close notification dropdown
 */
function closeNotifications() {
  const dropdown = document.getElementById('notification-dropdown')
  if (!dropdown) return

  dropdown.classList.remove('active')
  document.getElementById('notification-bell-btn')?.setAttribute('aria-expanded', 'false')
  isNotificationDropdownOpen = false
}

/**
 * Handle notification click
 */
async function handleNotificationClick(notificationId, link) {
  try {
    // Mark as read
    const response = await fetch(`/api/notifications/${notificationId}/read`, {
      method: 'PUT',
      credentials: 'include'
    })
    if (!response.ok) {
      if (response.status === 401) {
        window.ZeetaAuth?.handleUnauthorized?.()
        return
      }
      console.error('Failed to mark notification as read:', response.statusText)
      return
    }

    // Reload notifications to update UI
    await loadNotifications()

    // Navigate to link if provided
    if (link && link !== 'null' && link !== '') {
      closeNotifications()
      window.location.href = link
    }
  } catch (error) {
    console.error('Error marking notification as read:', error)
  }
}

/**
 * Mark all notifications as read
 */
async function markAllAsRead() {
  try {
    const response = await fetch('/api/notifications/read-all', {
      method: 'PUT',
      credentials: 'include'
    })

    if (!response.ok) {
      if (response.status === 401) {
        window.ZeetaAuth?.handleUnauthorized?.()
        return
      }
      console.error('Failed to mark all as read:', response.statusText)
      return
    }

    // Reload notifications to update UI
    await loadNotifications()
  } catch (error) {
    console.error('Error marking all as read:', error)
  }
}

/**
 * Calculate time ago from a timestamp (notifications local implementation)
 * Use a uniquely named function to avoid colliding with other global helpers.
 */
function formatTimeAgo(timestamp) {
  const now = new Date()
  const past = new Date(timestamp)
  const diffMs = now - past
  const diffMinutes = Math.floor(diffMs / 60000)

  if (diffMinutes < 1) return t('notification.justNow')

  let value
  let unit
  let fallback
  if (diffMinutes < 60) {
    value = diffMinutes
    unit = 'minute'
    fallback = `${diffMinutes}分前`
  } else {
    const diffHours = Math.floor(diffMinutes / 60)
    if (diffHours < 24) {
      value = diffHours
      unit = 'hour'
      fallback = `${diffHours}時間前`
    } else {
      const diffDays = Math.floor(diffHours / 24)
      if (diffDays < 7) {
        value = diffDays
        unit = 'day'
        fallback = `${diffDays}日前`
      } else {
        const diffWeeks = Math.floor(diffDays / 7)
        if (diffWeeks < 4) {
          value = diffWeeks
          unit = 'week'
          fallback = `${diffWeeks}週間前`
        } else {
          const diffMonths = Math.floor(diffDays / 30)
          if (diffMonths < 12) {
            value = diffMonths
            unit = 'month'
            fallback = `${diffMonths}ヶ月前`
          } else {
            const diffYears = Math.floor(diffDays / 365)
            value = diffYears
            unit = 'year'
            fallback = `${diffYears}年前`
          }
        }
      }
    }
  }

  try {
    const locale = window.ZeetaI18n.locale === 'en' ? 'en' : 'ja'
    const style = locale === 'en' ? 'long' : 'narrow'
    return new Intl.RelativeTimeFormat(locale, { numeric: 'always', style }).format(-value, unit)
  } catch (error) {
    return fallback
  }
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
  if (typeof text !== 'string') return ''
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Initialize notifications when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initNotifications)
} else {
  initNotifications()
}
