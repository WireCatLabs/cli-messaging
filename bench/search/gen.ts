import { createWriteStream, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DATA_DIR, FUZZY, LOOKALIKES, mulberry32, normalize, tokens, type Meta } from "./common.ts"

const N = Number(process.argv[2] ?? 100_000)
const SEED = Number(process.argv[3] ?? 42)
const rand = mulberry32(SEED)
const int = (n: number) => Math.floor(rand() * n)

const REAL = {
  ru: "привет как дела хорошо спасибо сегодня завтра вчера встреча работа дом документы нужно можно сделать знаю думаю хочу могу будет было есть нет да очень когда где почему потому что который время день неделя месяц год деньги банк квартира аренда договор паспорт виза справка очередь запись врач школа магазин машина вопрос ответ отправил получил позвони напиши посмотри скинь фото ссылка адрес город улица центр море пляж погода жарко холодно дождь кофе обед ужин друзья семья дети мама папа брат сестра новости цена дешево дорого срочно потом сейчас ладно конечно наверное вообще просто правда отлично понятно".split(
    " ",
  ),
  es: "hola que tal bien gracias hoy mañana ayer cita trabajo casa papeles hay que puedo quiero tengo hacer saber creo vale sí no muy cuando donde porque también pero para con sin semana mes año dinero banco piso alquiler contrato pasaporte visado certificado ayuntamiento previa oficina médico colegio tienda coche pregunta respuesta enviado recibido llamar escribir mira foto enlace dirección ciudad calle centro playa tiempo calor frío lluvia café comida cena amigos familia niños noticias precio barato caro urgente después ahora claro quizás verdad perfecto entendido extranjería huella solicitud trámite".split(
    " ",
  ),
  en: "hello how are you good thanks today tomorrow yesterday meeting work home papers need can make know think want have will was there not yes very when where why because which time day week month year money bank flat rent contract passport visa certificate appointment office doctor school shop car question answer sent received call write look photo link address city street centre beach weather hot cold rain coffee lunch dinner friends family kids news price cheap expensive urgent later now sure maybe really great understood ok please sorry check".split(
    " ",
  ),
}

const TYPOS = new Set(FUZZY.map((f) => normalize(f.query)))
const TARGET_KEYS = ["valencia", "empadronamiento", "whatsapp", "tie", "gestor", "ptsarev", "счет"]
const LOOKALIKE_KEYS = LOOKALIKES.flatMap((l) => l.forms.map(normalize))
const BANNED = new Set([...TYPOS, ...TARGET_KEYS, ...LOOKALIKE_KEYS])

const SYL = {
  ru: {
    c: "бвгджзклмнпрстфхцчшщ".split(""),
    v: "аааеееиииоооуыяюэ".split("").concat(["ё"]),
    end: ["", "", "", "й", "ть", "ся", "ов", "ами"],
  },
  es: {
    c: "bcdfglmnprstvz".split("").concat(["ch", "ll", "ñ", "rr", "qu"]),
    v: "aaaeeeiiooouu".split("").concat(["á", "é", "í", "ó", "ú"]),
    end: ["", "", "s", "n", "r", "ción", "mente"],
  },
  en: {
    c: "bcdfghklmnprstvwy".split("").concat(["th", "sh", "ch", "st"]),
    v: "aaeeiioouy".split(""),
    end: ["", "", "s", "ed", "ing", "er", "ly"],
  },
}
type Lang = keyof typeof SYL
const LANGS: Lang[] = ["ru", "es", "en"]
const VOCAB_SIZE = 30_000

function synth(lang: Lang): string {
  const s = SYL[lang]
  const n = 1 + int(4)
  let w = ""
  for (let i = 0; i < n; i++) {
    w += s.c[int(s.c.length)] + s.v[int(s.v.length)]
    // Occasional vowel-initial or double-consonant shapes widen the space.
    if (rand() < 0.15) w += s.c[int(s.c.length)]
  }
  return w + s.end[int(s.end.length)]
}

function buildVocab(lang: Lang): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const w of REAL[lang]) {
    const k = normalize(w)
    if (BANNED.has(k) || seen.has(k)) continue
    seen.add(k)
    out.push(w)
  }
  while (out.length < VOCAB_SIZE) {
    const w = synth(lang)
    const k = normalize(w)
    if (k.length < 2 || BANNED.has(k) || seen.has(k)) continue
    seen.add(k)
    out.push(w)
  }
  return out
}

function zipfCdf(n: number, s: number): Float64Array {
  const cdf = new Float64Array(n)
  let sum = 0
  for (let i = 0; i < n; i++) {
    sum += 1 / (i + 1) ** s
    cdf[i] = sum
  }
  for (let i = 0; i < n; i++) cdf[i] /= sum
  return cdf
}

function draw(cdf: Float64Array): number {
  const r = rand()
  let lo = 0
  let hi = cdf.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (cdf[mid] < r) lo = mid + 1
    else hi = mid
  }
  return lo
}

const vocab = Object.fromEntries(LANGS.map((l) => [l, buildVocab(l)])) as Record<Lang, string[]>
const wordCdf = zipfCdf(VOCAB_SIZE, 1.0)

const CHATS = 200
const chatCdf = zipfCdf(CHATS - 1, 1.0)
const chatLang: Lang[] = Array.from({ length: CHATS }, () => LANGS[int(3)])
const SENDERS = 5000
const senderCdf = zipfCdf(SENDERS, 0.8)
const SOURCES = ["max", "telegram", "whatsapp"]

const PLANTS: { p: number; forms: string[] }[] = [
  { p: 1 / 1500, forms: ["Valencia", "valencia"] },
  { p: 1 / 4000, forms: ["València"] },
  { p: 1 / 20000, forms: ["VALENCIA"] },
  { p: 1 / 8000, forms: ["empadronamiento", "Empadronamiento"] },
  { p: 1 / 800, forms: ["whatsapp", "WhatsApp"] },
  { p: 1 / 3000, forms: ["TIE"] },
  { p: 1 / 2500, forms: ["gestor", "Gestor"] },
  { p: 1 / 20000, forms: ["Ptsarev"] },
  { p: 1 / 3000, forms: ["счёт", "Счёт"] },
  { p: 1 / 6000, forms: ["счет"] },
  ...LOOKALIKES.map(({ forms }) => ({ p: 1 / 10000, forms })),
]

const END = Date.UTC(2026, 8, 1) / 1000
const SPAN = 3 * 365 * 86400
const START = END - SPAN

mkdirSync(DATA_DIR, { recursive: true })
const tsv = createWriteStream(join(DATA_DIR, `corpus-${N}.tsv`))
const truth: Record<string, number[]> = Object.fromEntries(TARGET_KEYS.map((k) => [k, []]))
const df = new Map<string, number>()
const chatCount = new Array(CHATS).fill(0)
const senderCount = new Array(SENDERS).fill(0)

function word(lang: Lang): string {
  const r = rand()
  if (r < 0.015) return String(int(100000))
  if (r < 0.03) {
    let w: string
    do w = synth(LANGS[int(3)]) + synth(LANGS[int(3)])
    while (BANNED.has(normalize(w)))
    return w
  }
  const l = rand() < 0.85 ? lang : LANGS[int(3)]
  return vocab[l][draw(wordCdf)]
}

const t0 = performance.now()
let buf = ""
for (let id = 1; id <= N; id++) {
  const chat = rand() < 0.5 ? 0 : 1 + draw(chatCdf)
  const sender = draw(senderCdf)
  const source = SOURCES[chat === 0 ? 0 : chat % 3]
  const sentAt = Math.floor(START + ((id - 0.5) / N) * SPAN + (rand() - 0.5) * 600)
  const len = 5 + int(36)
  const words: string[] = []
  for (let i = 0; i < len; i++) words.push(word(chatLang[chat]))
  for (const pl of PLANTS) {
    if (rand() < pl.p) words.splice(int(words.length + 1), 0, pl.forms[int(pl.forms.length)])
  }
  for (let i = 0; i < words.length; i++) {
    const r = rand()
    if (r < 0.06) words[i] += ","
    else if (r < 0.08) words[i] += "."
    else if (r < 0.09) words[i] += "?"
  }
  if (rand() < 0.3) words[0] = words[0][0].toUpperCase() + words[0].slice(1)
  const text = words.join(" ")
  const norm = normalize(text)
  const seen = new Set(tokens(norm))
  for (const t of seen) {
    df.set(t, (df.get(t) ?? 0) + 1)
    if (t in truth) truth[t].push(id)
    if (TYPOS.has(t)) throw new Error(`typo ${t} leaked into corpus`)
  }
  chatCount[chat]++
  senderCount[sender]++
  buf += `${id}\t${chat}\t${sender}\t${source}\t${sentAt}\t${text}\t${norm}\n`
  if (buf.length > 1 << 20) {
    if (!tsv.write(buf)) await new Promise((r) => tsv.once("drain", r))
    buf = ""
  }
}
tsv.write(buf)
await new Promise((r) => tsv.end(r))

const band = (lo: number, hi: number) =>
  [...df.entries()]
    .filter(([t, c]) => c >= lo * N && c <= hi * N && !/^\d+$/.test(t) && t.length >= 3)
    .map(([t]) => t)
    .sort()
const typicalBand = band(0.003, 0.03)
const commonBand = band(0.05, 0.15)
const qr = mulberry32(SEED + 1)
const qpick = (arr: string[]) => arr[Math.floor(qr() * arr.length)]
const sets = (make: () => string[]) => Array.from({ length: 20 }, make)

let smallChat = 1
for (let c = 1; c < CHATS; c++) {
  if (Math.abs(chatCount[c] - N * 0.002) < Math.abs(chatCount[smallChat] - N * 0.002)) smallChat = c
}
const sizedChats = [10_000, 50_000, 100_000]
  .map((target) => {
    let chat = 1
    for (let c = 1; c < CHATS; c++) {
      if (Math.abs(chatCount[c] - target) < Math.abs(chatCount[chat] - target)) chat = c
    }
    return { target, chat, count: chatCount[chat] }
  })
  .filter(({ target, count }) => count > target / 2 && count < target * 2)
const meta: Meta = {
  n: N,
  seed: SEED,
  bigChat: 0,
  smallChat,
  smallChatCount: chatCount[smallChat],
  sender: 20,
  senderCount: senderCount[20],
  sizedChats,
  minTs: START,
  maxTs: END,
  queries: {
    typical: sets(() => [qpick(typicalBand), qpick(typicalBand)]),
    three: sets(() => [qpick(typicalBand), qpick(typicalBand), qpick(commonBand)]),
    common: sets(() => [qpick(commonBand), qpick(commonBand)]),
  },
}
writeFileSync(join(DATA_DIR, `meta-${N}.json`), JSON.stringify(meta, null, 1))
writeFileSync(join(DATA_DIR, `truth-${N}.json`), JSON.stringify(truth))
console.log(
  JSON.stringify({
    n: N,
    secs: ((performance.now() - t0) / 1000).toFixed(1),
    vocab: df.size,
    typicalBand: typicalBand.length,
    commonBand: commonBand.length,
    truth: Object.fromEntries(Object.entries(truth).map(([k, v]) => [k, v.length])),
    bigChat: chatCount[0],
    smallChat: [smallChat, chatCount[smallChat]],
    sender20: senderCount[20],
    sizedChats,
    sender0: senderCount[0],
  }),
)
