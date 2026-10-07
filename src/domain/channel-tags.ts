export const CHANNEL_TAG_RULES_VERSION = "keywords-v1"

const RULES: Record<string, RegExp[]> = {
  ai: [/\b(ai|gpt|llm|machine learning|artificial intelligence)\b/iu, /нейросет|искусственн/iu],
  news: [/\b(news|breaking|digest)\b/iu, /новост|дайджест|сводк/iu],
  memes: [/\b(memes?|humou?r|lol)\b/iu, /мем|юмор|шутк/iu],
  crypto: [/\b(crypto|bitcoin|btc|ethereum|blockchain)\b/iu, /крипт|блокчейн/iu],
  jobs: [/\b(jobs?|hiring|careers?)\b/iu, /ваканс|работа/iu],
  events: [/\b(events?|meetups?|conference)\b/iu, /мероприяти|митап|конференц/iu],
}

export interface ChannelTagMatch {
  tag: string
  score: number
  fields: string[]
}

/** Scores count matching metadata fields, not the probability of a topic. */
export const classifyChannel = (metadata: {
  title: string | null
  username: string | null
  description: string | null
}): ChannelTagMatch[] =>
  Object.entries(RULES).flatMap(([tag, patterns]) => {
    const fields = Object.entries(metadata)
      .filter(([, value]) => value && patterns.some((pattern) => pattern.test(value)))
      .map(([field]) => field)
    return fields.length ? [{ tag, score: fields.length / 3, fields }] : []
  })
