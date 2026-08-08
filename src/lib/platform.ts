export function isMacOSUserAgent(userAgent: string) {
  return /Macintosh|Mac OS X/.test(userAgent)
}

export function isMacOS() {
  return isMacOSUserAgent(window.navigator.userAgent)
}
