export function isMacOSUserAgent(userAgent: string) {
  return /Macintosh|Mac OS X/.test(userAgent)
}

export function isMacOS() {
  return isMacOSUserAgent(window.navigator.userAgent)
}

export function isWindowsUserAgent(userAgent: string) {
  return /Windows/.test(userAgent)
}

export function isWindows() {
  return isWindowsUserAgent(window.navigator.userAgent)
}
