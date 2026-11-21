// Gate 2, step 2: turn the written script into words a text-to-speech voice
// reads correctly (docs/QA-SPEC.md, Gate 2). Pure functions: same text in,
// same text out. display_text is never changed; this builds spoken_text.
//
// The rules, in the order they run (each step only sees what earlier steps left):
//  1. Emojis are removed (with skin tones, flags, joiners and variation marks).
//  2. Emails: "hello@zee.com" → "hello at zee dot com".
//  3. Web addresses: "https://" and "www." are dropped (nobody says them).
//     Dots → "dot", "/" → "slash". Known endings are read the way people say
//     them ("com", "net"; "pk" → "P K", "ae" → "A E", "io" → "I O").
//     Joined words are split by ONE simple rule only: a lower-case name that
//     starts with a common short word ("your", "my", "the", "get", "best", ...)
//     is split after it ("yourbrand" → "your brand"); CamelCase and hyphens
//     split too ("ZeeLounge" → "Zee Lounge"). Anything else stays as written
//     ("zeelounge"); add it to the brand dictionary if it's read wrong.
//  4. @handles: "@" → "at", "_" → "underscore", "." → "dot", CamelCase split
//     ("@zee_lounge" → "at zee underscore lounge"). Hashtags: "#SmallBusiness"
//     → "hashtag Small Business".
//  5. Times: "7:30 pm" → "seven thirty p m", "7pm" → "seven p m",
//     "6:00" → "six o'clock", "10:05" → "ten oh five".
//  6. Money: Rs / Rs. / PKR / INR / ₹ → rupees, AED / Dhs → dirhams,
//     $ / USD → dollars; "Rs 2,999" → "two thousand nine hundred and
//     ninety-nine rupees"; cents/fils/paisa after a point; "5k" → "five
//     thousand"; "2 lakh" stays "two lakh". International grouping is used for
//     large numbers ("1,50,000" → "one hundred and fifty thousand").
//  7. Percent: "50%" → "fifty percent".
//  8. Dates: "12 Dec" → "the twelfth of December", "Dec 12" → "December
//     twelfth", with an optional year. Slashed dates (12/12) are not guessed.
//  9. Special number shapes: "24/7", "1:1" → "one on one", "3-5" → "three to
//     five", "9/10" → "nine out of ten", other "a:b" → "a to b".
// 10. Ordinals: "3rd" → "third".
// 11. Titles: "Dr"/"Dr." before a name → "Doctor", "Mr" → "Mister",
//     "Mrs" → "Missus"; "vs" → "versus", "etc." → "et cetera", "e.g." → "for example".
// 12. Symbols: "&" → "and", "+" → "plus", "=" → "equals", a lone "@" → "at".
// 13. Acronyms (2 to 6 capitals): spelled letter by letter ("CEO" → "C E O",
//     "CEOs" → "C E O's"), except the allow-list said as words (NASA, UNICEF,
//     NADRA...) and common English words written in capitals for emphasis
//     (FREE, NOW...), which become lower-case words. "OK" → "okay".
// 14. Numbers: letters and digits stuck together are split ("B2B" → "B two
//     B"); numbers with a leading zero (phone numbers) are read digit by
//     digit; 4-digit numbers from 1900 to 2099 without a comma are years
//     ("2026" → "twenty twenty-six"); everything else becomes words, British
//     style with "and" ("105" → "one hundred and five"); decimals use "point".
// 15. Spaces are tidied.

const ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function below100(n: number): string {
  if (n < 20) return ONES[n];
  const rest = n % 10;
  return rest ? `${TENS[Math.floor(n / 10)]}-${ONES[rest]}` : TENS[Math.floor(n / 10)];
}

function below1000(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const parts: string[] = [];
  if (hundreds) parts.push(`${ONES[hundreds]} hundred`);
  if (rest) parts.push(`${hundreds ? "and " : ""}${below100(rest)}`);
  return parts.join(" ");
}

const SCALES: [number, string][] = [
  [1e9, "billion"],
  [1e6, "million"],
  [1e3, "thousand"],
];

/** 2999 → "two thousand nine hundred and ninety-nine". Whole numbers below a trillion. */
export function numberToWords(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n >= 1e12) return digitsToWords(String(n));
  if (n === 0) return "zero";
  const parts: string[] = [];
  let rest = n;
  for (const [size, name] of SCALES) {
    const count = Math.floor(rest / size);
    if (count) parts.push(`${below1000(count)} ${name}`);
    rest %= size;
  }
  if (rest) parts.push(`${parts.length && rest < 100 ? "and " : ""}${below1000(rest)}`);
  return parts.join(" ");
}

/** 2026 → "twenty twenty-six", 2005 → "two thousand and five", 1900 → "nineteen hundred". */
export function yearToWords(year: number): string {
  if (year === 2000) return "two thousand";
  if (year > 2000 && year < 2010) return `two thousand and ${ONES[year - 2000]}`;
  const first = Math.floor(year / 100);
  const last = year % 100;
  if (last === 0) return `${below100(first)} hundred`;
  return `${below100(first)} ${last < 10 ? `oh ${ONES[last]}` : below100(last)}`;
}

/** "0300" → "zero three zero zero". */
export function digitsToWords(digits: string): string {
  return digits
    .replace(/\D/g, "")
    .split("")
    .map((d) => ONES[Number(d)])
    .join(" ");
}

const ORDINAL_ENDINGS: Record<string, string> = {
  one: "first",
  two: "second",
  three: "third",
  five: "fifth",
  eight: "eighth",
  nine: "ninth",
  twelve: "twelfth",
};

/** 3 → "third", 21 → "twenty-first", 40 → "fortieth". */
export function ordinalToWords(n: number): string {
  const words = numberToWords(n);
  return words.replace(/([a-z]+)$/, (last) => {
    if (ORDINAL_ENDINGS[last]) return ORDINAL_ENDINGS[last];
    if (last.endsWith("y")) return `${last.slice(0, -1)}ieth`;
    return `${last}th`;
  });
}

/** A number as written ("2,999", "2.5", "0300", "2026") → words, following rule 14. */
function writtenNumberToWords(written: string): string {
  const [whole, decimals] = written.split(".");
  const hasComma = whole.includes(",");
  const digits = whole.replace(/,/g, "");
  let words: string;
  if (!hasComma && digits.length > 1 && digits.startsWith("0")) words = digitsToWords(digits);
  else if (digits.length > 12) words = digitsToWords(digits);
  else if (!hasComma && decimals === undefined && digits.length === 4 && Number(digits) >= 1900 && Number(digits) <= 2099)
    words = yearToWords(Number(digits));
  else words = numberToWords(Number(digits));
  return decimals === undefined ? words : `${words} point ${digitsToWords(decimals)}`;
}

// ---------------------------------------------------------------------------
// Words in web addresses and handles
// ---------------------------------------------------------------------------

/** Rule 3: lower-case names starting with one of these are split after it. */
const LEADING_WORDS = ["your", "my", "the", "get", "go", "try", "shop", "best", "buy", "join", "book", "our", "hey", "hello"];

function splitLeadingWords(word: string): string {
  if (word !== word.toLowerCase()) return word;
  for (const lead of LEADING_WORDS) {
    if (word.startsWith(lead) && word.length - lead.length >= 3) {
      return `${lead} ${splitLeadingWords(word.slice(lead.length))}`;
    }
  }
  return word;
}

/** "ZeeLounge" → "Zee Lounge", "web3" → "web three", "yourbrand" → "your brand". */
function speakNamePart(part: string): string {
  return part
    .split(/-+/)
    .filter(Boolean)
    .map((piece) =>
      piece
        .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
        .split(/(\d+)/)
        .filter(Boolean)
        .map((chunk) => (/^\d+$/.test(chunk) ? digitsToWords(chunk) : chunk.split(" ").map(splitLeadingWords).join(" ")))
        .join(" "),
    )
    .join(" ");
}

const TLD_SPOKEN: Record<string, string> = {
  com: "com",
  net: "net",
  org: "org",
  co: "co",
  app: "app",
  me: "me",
  shop: "shop",
  store: "store",
  biz: "biz",
  info: "info",
  dev: "dev",
  in: "in",
  pk: "P K",
  ae: "A E",
  io: "I O",
  ai: "A I",
  uk: "U K",
  us: "U S",
};
const TLDS = Object.keys(TLD_SPOKEN).join("|");

function speakDomain(host: string): string {
  const labels = host.split(".");
  const tld = labels.pop() ?? "";
  return [...labels.map(speakNamePart), TLD_SPOKEN[tld.toLowerCase()] ?? tld].join(" dot ");
}

function speakPath(path: string): string {
  return path
    .split("/")
    .filter(Boolean)
    .map((piece) => speakNamePart(piece.replace(/[_]+/g, "-")))
    .map((piece) => ` slash ${piece}`)
    .join("");
}

/** "zee_lounge" / "dr.ayesha" → "zee underscore lounge" / "dr dot ayesha". */
function speakHandle(handle: string): string {
  return handle
    .split(/([._])/)
    .filter(Boolean)
    .map((piece) => (piece === "_" ? "underscore" : piece === "." ? "dot" : speakNamePart(piece)))
    .join(" ");
}

// ---------------------------------------------------------------------------
// Money, times, dates
// ---------------------------------------------------------------------------

type Currency = { one: string; many: string; centsOne: string; centsMany: string };
const RUPEE: Currency = { one: "rupee", many: "rupees", centsOne: "paisa", centsMany: "paisa" };
const DIRHAM: Currency = { one: "dirham", many: "dirhams", centsOne: "fils", centsMany: "fils" };
const DOLLAR: Currency = { one: "dollar", many: "dollars", centsOne: "cent", centsMany: "cents" };

function currencyFor(symbol: string): Currency {
  const s = symbol.replace(/\./g, "").toUpperCase();
  if (s === "AED" || s === "DH" || s === "DHS") return DIRHAM;
  if (s === "$" || s === "USD" || s === "US$") return DOLLAR;
  return RUPEE;
}

function speakMoney(amount: string, currency: Currency, multiplier?: string): string {
  const [whole, cents] = amount.replace(/,/g, "").split(".");
  const m = multiplier?.toLowerCase();
  if (m === "k") return `${numberToWords(Number(whole) * 1000)} ${currency.many}`;
  if (m) return `${numberToWords(Number(whole))} ${m === "lac" ? "lakh" : m} ${currency.many}`;
  const n = Number(whole);
  let words = `${numberToWords(n)} ${n === 1 && !cents ? currency.one : currency.many}`;
  const c = cents ? Number(cents.padEnd(2, "0")) : 0;
  if (c > 0) words += ` and ${numberToWords(c)} ${c === 1 ? currency.centsOne : currency.centsMany}`;
  return words;
}

function speakTime(hour: string, minutes: string | undefined, ampm: string | undefined): string {
  const h = numberToWords(Number(hour));
  const suffix = ampm ? ` ${ampm.toLowerCase()} m` : "";
  if (minutes === undefined) return `${h}${suffix}`;
  const m = Number(minutes);
  if (m === 0) return ampm ? `${h}${suffix}` : `${h} o'clock`;
  return `${h} ${m < 10 ? `oh ${ONES[m]}` : below100(m)}${suffix}`;
}

const MONTHS: Record<string, string> = {
  jan: "January", feb: "February", mar: "March", apr: "April", may: "May", jun: "June",
  jul: "July", aug: "August", sep: "September", sept: "September", oct: "October", nov: "November", dec: "December",
};
const MONTH_NAMES =
  "January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec";
const monthName = (written: string) => MONTHS[written.slice(0, written.toLowerCase().startsWith("sept") ? 4 : 3).toLowerCase()];
const yearSuffix = (year: string | undefined) => (year ? ` ${yearToWords(Number(year))}` : "");

// ---------------------------------------------------------------------------
// Acronyms
// ---------------------------------------------------------------------------

/** Acronyms people say as a word. */
export const ACRONYMS_SAID_AS_WORDS = ["NASA", "NATO", "UNICEF", "UNESCO", "NADRA", "FIFA", "LUMS", "OPEC", "SIM", "PIN", "GIF", "ASAP"];

/** Ordinary words often written in capitals for emphasis. */
const SHOUTED_WORDS = [
  "FREE", "NOW", "NEW", "NOT", "NO", "YES", "STOP", "BIG", "MUST", "NEVER", "ALWAYS", "ONLY", "TODAY", "SALE",
  "BEST", "OFF", "WOW", "ALL", "THIS", "THE", "AND", "YOU", "YOUR", "WHY", "HOW", "WHAT", "DON'T", "LIVE", "LAST",
];

const SAID_AS_WORD = new Set([...ACRONYMS_SAID_AS_WORDS, ...SHOUTED_WORDS]);

/** True for capitals the normaliser reads as a word (allow-listed acronyms, shouted words, OK). */
export function isReadAsWord(capitals: string): boolean {
  return capitals === "OK" || SAID_AS_WORD.has(capitals);
}

function speakAcronym(letters: string, plural: string): string {
  if (letters === "OK" && !plural) return "okay";
  if (SAID_AS_WORD.has(letters)) return `${letters.toLowerCase()}${plural}`;
  return `${letters.split("").join(" ")}${plural ? "'s" : ""}`;
}

// ---------------------------------------------------------------------------
// The normaliser
// ---------------------------------------------------------------------------

const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}‍️⃣]/gu;
const NOT_WORD_BEFORE = "(?<![\\p{L}\\p{N}_])";
const NOT_WORD_AFTER = "(?![\\p{L}\\p{N}_])";
const DOMAIN = `((?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\\.)+(?:${TLDS}))`;
const AMOUNT = "(\\d{1,3}(?:,\\d{2,3})+|\\d+)(?:\\.(\\d{1,2}))?";

const re = (source: string, flags = "gu") => new RegExp(source, flags);

/** Turns written text into words a voice reads correctly. See the rules at the top of this file. */
export function normaliseForSpeech(text: string): string {
  let out = text;

  // 1. Emojis.
  out = out.replace(EMOJI, " ");

  // 2. Emails.
  out = out.replace(
    re(`${NOT_WORD_BEFORE}([A-Za-z0-9][A-Za-z0-9._-]*)@${DOMAIN}${NOT_WORD_AFTER}`, "giu"),
    (_m, local: string, host: string) => `${speakHandle(local)} at ${speakDomain(host)}`,
  );

  // 3. Web addresses.
  out = out.replace(
    re(`(?:https?:\\/\\/)?(?:www\\.)?${NOT_WORD_BEFORE}${DOMAIN}${NOT_WORD_AFTER}((?:\\/[A-Za-z0-9._~%-]*[A-Za-z0-9_~%-])*\\/?)`, "giu"),
    (_m, host: string, path: string) => `${speakDomain(host)}${speakPath(path ?? "")}`,
  );

  // 4. Handles and hashtags.
  out = out.replace(
    /(?<![\p{L}\p{N}_@.])@([A-Za-z0-9_](?:[A-Za-z0-9_.]*[A-Za-z0-9_])?)/gu,
    (_m, handle: string) => `at ${speakHandle(handle)}`,
  );
  out = out.replace(/(?<![\p{L}\p{N}_&])#([A-Za-z][A-Za-z0-9_]*)/gu, (_m, tag: string) => `hashtag ${speakHandle(tag)}`);

  // 5. Times.
  out = out.replace(
    /(?<![\p{N}:])(\d{1,2}):(\d{2})(?:\s?([ap])\.?m\b\.?(?=\s|$|[,;!?]))?(?![\p{N}])/giu,
    (_m, h: string, m: string, ampm?: string) => speakTime(h, m, ampm),
  );
  out = out.replace(/(?<![\p{L}\p{N}])(\d{1,2})\s?([ap])\.?m\b/giu, (_m, h: string, ampm: string) => speakTime(h, undefined, ampm));

  // 6. Money (symbol first, then a code after the amount).
  out = out.replace(
    re(`(?<![\\p{L}\\p{N}])(Rs\\.?|PKR|INR|AED|Dhs?\\.?|USD|US\\$|\\$|₹)\\s?${AMOUNT}(?:(k)${NOT_WORD_AFTER}|\\s+(lakh|lac|crore)${NOT_WORD_AFTER})?`, "giu"),
    (_m, symbol: string, whole: string, cents: string | undefined, k?: string, big?: string) =>
      speakMoney(cents ? `${whole}.${cents}` : whole, currencyFor(symbol), k ?? big),
  );
  out = out.replace(
    re(`${NOT_WORD_BEFORE}${AMOUNT}\\s?(PKR|INR|AED|USD)${NOT_WORD_AFTER}`, "gu"),
    (_m, whole: string, cents: string | undefined, code: string) => speakMoney(cents ? `${whole}.${cents}` : whole, currencyFor(code)),
  );

  // 7. Percent.
  out = out.replace(/(?<![\p{L}\p{N}.,])(\d[\d,]*(?:\.\d+)?)\s?%/gu, (_m, n: string) => `${writtenNumberToWords(n)} percent`);

  // 8. Dates.
  out = out.replace(
    re(`${NOT_WORD_BEFORE}(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_NAMES})\\.?(?:,?\\s+(\\d{4}))?${NOT_WORD_AFTER}`),
    (_m, day: string, month: string, year?: string) => `the ${ordinalToWords(Number(day))} of ${monthName(month)}${yearSuffix(year)}`,
  );
  out = out.replace(
    re(`${NOT_WORD_BEFORE}(${MONTH_NAMES})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?![\\p{L}\\p{N}_,:])(?:,?\\s+(\\d{4})${NOT_WORD_AFTER})?`),
    (_m, month: string, day: string, year?: string) => `${monthName(month)} ${ordinalToWords(Number(day))}${yearSuffix(year)}`,
  );

  // 9. Special number shapes.
  out = out.replace(/(?<![\p{N}/])24\/7(?![\p{N}/])/gu, "twenty-four seven");
  out = out.replace(/(?<![\p{N}:])1:1(?![\p{N}:])/gu, "one on one");
  out = out.replace(/(?<![\p{N}:])(\d+):(\d+)(?![\p{N}:])/gu, (_m, a: string, b: string) => `${writtenNumberToWords(a)} to ${writtenNumberToWords(b)}`);
  out = out.replace(/(?<![\p{N}/])(\d+)\/(\d+)(?![\p{N}/])/gu, (_m, a: string, b: string) => `${writtenNumberToWords(a)} out of ${writtenNumberToWords(b)}`);
  out = out.replace(
    /(?<![\p{N}\-–])([1-9]\d{0,2})\s?[-–]\s?([1-9]\d{0,2})(?![\p{N}\-–])/gu,
    (_m, a: string, b: string) => `${numberToWords(Number(a))} to ${numberToWords(Number(b))}`,
  );

  // 10. Ordinals.
  out = out.replace(/(?<![\p{L}\p{N}])(\d+)(?:st|nd|rd|th)(?![\p{L}\p{N}])/giu, (_m, n: string) => ordinalToWords(Number(n)));

  // 11. Titles and short forms. (-: a name already replaced from the
  // brand dictionary, see lib/pronunciation/dictionary.ts.)
  out = out.replace(/(?<![\p{L}])Dr\.?(?=\s+[\p{Lu}-])/gu, "Doctor");
  out = out.replace(/(?<![\p{L}])Mrs\.?(?=\s+[\p{Lu}-])/gu, "Missus");
  out = out.replace(/(?<![\p{L}])Mr\.?(?=\s+[\p{Lu}-])/gu, "Mister");
  out = out.replace(/(?<![\p{L}])vs\.?(?=\s)/giu, "versus");
  out = out.replace(/(?<![\p{L}])etc\./giu, "et cetera");
  out = out.replace(/(?<![\p{L}])e\.g\./giu, "for example");

  // 12. Symbols.
  out = out.replace(/\s*&\s*/g, " and ");
  out = out.replace(/\s*\+\s*/g, " plus ");
  out = out.replace(/\s+=\s+/g, " equals ");
  out = out.replace(/(^|\s)@(?=\s)/g, "$1at");

  // 13. Acronyms.
  out = out.replace(/(?<![\p{L}\p{N}'])([A-Z]{2,6})(s?)(?![\p{L}\p{N}])/gu, (_m, letters: string, plural: string) =>
    speakAcronym(letters, plural),
  );

  // 14. Numbers.
  out = out.replace(/(\p{L})(\d)/gu, "$1 $2").replace(/(\d)(\p{L})/gu, "$1 $2");
  out = out.replace(/(?<![\p{N}.,])(\d{1,3}(?:,\d{2,3})+|\d+)(?:\.(\d+))?(?![\p{N}])/gu, (m) => writtenNumberToWords(m));

  // 15. Spaces.
  return out
    .replace(/[ \t]+/g, " ")
    .replace(/ +([,.!?;:])/g, "$1")
    .replace(/^ +| +$/gm, "")
    .trim();
}

/** Characters a voice can't read. spoken_text must have none (Gate 2 check). */
export function unspeakableCharacters(spoken: string): string[] {
  const found = spoken.match(/[\p{N}%$₹€£&@#+=_<>|~^*\\{}[\]]|\p{Extended_Pictographic}/gu) ?? [];
  return [...new Set(found)];
}
