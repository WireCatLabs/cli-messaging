export const PRESET_VERSION = 1
export const PRESETS: Record<
  string,
  { explanation: string; candidate: (body: string, attachments: readonly string[]) => boolean }
> = {
  password: {
    explanation: "a password label followed by a value",
    candidate: (s) => /(?:password|пароль)\s*[:=]\s*\S{4,128}/iu.test(s),
  },
  code: {
    explanation: "a verification-code label and 4–8 digits",
    candidate: (s) => /(?:code|код)\s*[:=]\s*\d{4,8}\b/iu.test(s),
  },
  "api-key": {
    explanation: "an API-key label and a value",
    candidate: (s) => /(?:api[_ -]?key|api[_ -]?ключ)\s*[:=]\s*\S{8,128}/iu.test(s),
  },
  secret: {
    explanation: "a password, secret, token or API-key label and a value",
    candidate: (s) => /(?:password|пароль|secret|секрет|token|токен|api[_ -]?key)\s*[:=]\s*\S{4,128}/iu.test(s),
  },
  card: {
    explanation: "13–19 digits with optional spaces or hyphens; no issuer verification",
    candidate: (s) => /\b(?:\d[ -]?){12,18}\d\b/u.test(s),
  },
  bank: {
    explanation: "an IBAN-shaped value; no bank or checksum verification",
    candidate: (s) => /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/u.test(s),
  },
  passport: {
    explanation: "a labelled passport value or Russian 4+6 digit shape",
    candidate: (s) => /(?:passport|паспорт)\s*[:=]\s*[\p{L}\d -]{5,24}|\b\d{4}[ -]?\d{6}\b/iu.test(s),
  },
  phone: {
    explanation: "a plus-prefixed 8–15 digit international-phone shape",
    candidate: (s) => /\+(?:\d[ ()-]?){7,14}\d\b/u.test(s),
  },
  email: {
    explanation: "an email-address shape",
    candidate: (s) => /\b[\w.+-]{1,64}@[\w-]{1,63}\.[A-Za-z]{2,24}\b/u.test(s),
  },
  "telegram-link": {
    explanation: "a t.me or telegram.me URL",
    candidate: (s) => /https?:\/\/(?:t\.me|telegram\.me)\/[\w/+?-]{1,128}/iu.test(s),
  },
  url: { explanation: "an HTTP(S) URL", candidate: (s) => /https?:\/\/[^\s<>]{1,2048}/iu.test(s) },
  contact: {
    explanation: "a contact attachment or email/phone candidate",
    candidate: (s, a) =>
      a.includes("contact") || (PRESETS.email?.candidate(s, a) ?? false) || (PRESETS.phone?.candidate(s, a) ?? false),
  },
  location: {
    explanation: "a location attachment or geo: URI",
    candidate: (s, a) => a.includes("location") || /\bgeo:-?\d{1,2}(?:\.\d{1,8})?,-?\d{1,3}(?:\.\d{1,8})?\b/u.test(s),
  },
}
