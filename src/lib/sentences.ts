/** Two sentences of one paragraph: a space between them, except after the
    full-width stop of Chinese and Japanese, which carries its own room. */
export function joinSentences(first: string, second: string) {
  return /[。！？]$/.test(first) ? first + second : `${first} ${second}`
}
