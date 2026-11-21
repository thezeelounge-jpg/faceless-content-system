import { describe, expect, it } from "vitest";
import { applyDictionary, buildSpokenText, type PronunciationEntry } from "@/lib/pronunciation/dictionary";
import { normaliseForSpeech, numberToWords, yearToWords } from "@/lib/pronunciation/normalise";

const say = normaliseForSpeech;

describe("numbers", () => {
  it("turns numbers into words (British 'and')", () => {
    expect(numberToWords(0)).toBe("zero");
    expect(numberToWords(7)).toBe("seven");
    expect(numberToWords(21)).toBe("twenty-one");
    expect(numberToWords(105)).toBe("one hundred and five");
    expect(numberToWords(2999)).toBe("two thousand nine hundred and ninety-nine");
    expect(numberToWords(2050)).toBe("two thousand and fifty");
    expect(numberToWords(150000)).toBe("one hundred and fifty thousand");
    expect(numberToWords(1_000_000)).toBe("one million");
    expect(numberToWords(3_400_017)).toBe("three million four hundred thousand and seventeen");
  });

  it("reads years as years", () => {
    expect(yearToWords(2026)).toBe("twenty twenty-six");
    expect(yearToWords(1999)).toBe("nineteen ninety-nine");
    expect(yearToWords(2000)).toBe("two thousand");
    expect(yearToWords(2005)).toBe("two thousand and five");
    expect(yearToWords(1900)).toBe("nineteen hundred");
  });

  it("in text: plain numbers, commas, decimals, years, ordinals", () => {
    expect(say("I have 3 tips")).toBe("I have three tips");
    expect(say("We helped 1,250 families")).toBe("We helped one thousand two hundred and fifty families");
    expect(say("It grew 2.5 times")).toBe("It grew two point five times");
    expect(say("Since 2019 we")).toBe("Since twenty nineteen we");
    expect(say("my 3rd clinic")).toBe("my third clinic");
    expect(say("open 24/7")).toBe("open twenty-four seven");
    expect(say("book a 1:1 call")).toBe("book a one on one call");
    expect(say("3-5 days")).toBe("three to five days");
  });

  it("phone-style numbers (leading zero) are read digit by digit", () => {
    expect(say("Call 0300")).toBe("Call zero three zero zero");
  });
});

describe("money", () => {
  const rupees = "two thousand nine hundred and ninety-nine rupees";

  it('"Rs 2,999", "Rs. 2,999", "Rs2,999", "PKR 2,999" and "2,999 PKR" → words + rupees', () => {
    expect(say("Rs 2,999")).toBe(rupees);
    expect(say("Rs. 2,999")).toBe(rupees);
    expect(say("Rs2,999")).toBe(rupees);
    expect(say("PKR 2,999")).toBe(rupees);
    expect(say("only 2,999 PKR")).toBe(`only ${rupees}`);
    expect(say("Book now for Rs 2,999.")).toBe(`Book now for ${rupees}.`);
  });

  it("one rupee is singular; k means thousand; lakh stays lakh", () => {
    expect(say("Rs 1")).toBe("one rupee");
    expect(say("Rs 5k")).toBe("five thousand rupees");
    expect(say("Rs 2 lakh")).toBe("two lakh rupees");
  });

  it("AED, $ and ₹ amounts, with cents", () => {
    expect(say("AED 500")).toBe("five hundred dirhams");
    expect(say("AED 10.50")).toBe("ten dirhams and fifty fils");
    expect(say("$49")).toBe("forty-nine dollars");
    expect(say("$9.99")).toBe("nine dollars and ninety-nine cents");
    expect(say("$1")).toBe("one dollar");
    expect(say("₹999")).toBe("nine hundred and ninety-nine rupees");
  });
});

describe("percent", () => {
  it('"50%" → "fifty percent"', () => {
    expect(say("50%")).toBe("fifty percent");
    expect(say("save 12.5 % today")).toBe("save twelve point five percent today");
  });
});

describe("URLs and domains", () => {
  it('"yourbrand.com" → "your brand dot com" (joined words split by the leading-word rule)', () => {
    expect(say("yourbrand.com")).toBe("your brand dot com");
  });

  it("drops https:// and www. (nobody says them) and reads the path", () => {
    expect(say("Visit https://www.zeelounge.com/book now")).toBe("Visit zeelounge dot com slash book now");
    expect(say("www.drayesha.pk")).toBe("drayesha dot P K");
  });

  it("splits hyphens and camel case, reads digits", () => {
    expect(say("ZeeLounge.com")).toBe("Zee Lounge dot com");
    expect(say("my-clinic.ae")).toBe("my clinic dot A E");
    expect(say("web3.io")).toBe("web three dot I O");
  });

  it("emails", () => {
    expect(say("hello@zeelounge.com")).toBe("hello at zeelounge dot com");
  });
});

describe("@handles and hashtags", () => {
  it('"@zee_lounge" → "at zee underscore lounge"', () => {
    expect(say("Follow @zee_lounge")).toBe("Follow at zee underscore lounge");
    expect(say("@dr.ayesha")).toBe("at dr dot ayesha");
    expect(say("@ZeeLounge")).toBe("at Zee Lounge");
  });

  it("hashtags", () => {
    expect(say("#SmallBusiness")).toBe("hashtag Small Business");
  });
});

describe("emojis and symbols", () => {
  it("strips emojis (with skin tones, flags and joiners)", () => {
    expect(say("Big news 🎉🔥 today 👍🏽")).toBe("Big news today");
    expect(say("From 🇵🇰 with ❤️")).toBe("From with");
    expect(say("Family 👨‍👩‍👧 time")).toBe("Family time");
  });

  it("& and + and =", () => {
    expect(say("Q&A")).toBe("Q and A");
    expect(say("salt & pepper")).toBe("salt and pepper");
    expect(say("10+ years")).toBe("ten plus years");
    expect(say("a + b")).toBe("a plus b");
  });
});

describe("acronyms by rule", () => {
  it("spells acronyms letter by letter", () => {
    expect(say("Ask your CEO")).toBe("Ask your C E O");
    expect(say("good SEO and ROI")).toBe("good S E O and R O I");
    expect(say("two CEOs")).toBe("two C E O's");
  });

  it("reads allow-listed acronyms and shouted words as words", () => {
    expect(say("NASA and UNICEF")).toBe("nasa and unicef");
    expect(say("It is FREE NOW")).toBe("It is free now");
    expect(say("OK")).toBe("okay");
  });

  it("leaves single capitals alone", () => {
    expect(say("I am A grade")).toBe("I am A grade");
  });
});

describe("dates, times and titles", () => {
  it("times", () => {
    expect(say("at 7:30 pm")).toBe("at seven thirty p m");
    expect(say("at 7pm")).toBe("at seven p m");
    expect(say("9:00 AM")).toBe("nine a m");
    expect(say("at 10:05")).toBe("at ten oh five");
    expect(say("at 6:00")).toBe("at six o'clock");
  });

  it("day and month", () => {
    expect(say("on 12 Dec")).toBe("on the twelfth of December");
    expect(say("on Dec 12")).toBe("on December twelfth");
    expect(say("1st January 2027")).toBe("the first of January twenty twenty-seven");
  });

  it("titles", () => {
    expect(say("Dr Ayesha and Dr. Ali")).toBe("Doctor Ayesha and Doctor Ali");
  });
});

describe("keeps the text otherwise", () => {
  it("leaves words and punctuation alone and tidies spaces", () => {
    expect(say("Assalam o alaikum, seedhi baat!")).toBe("Assalam o alaikum, seedhi baat!");
    expect(say("  two   spaces  ")).toBe("two spaces");
  });

  it("does not change the input string (display_text stays as written)", () => {
    const display = "Rs 2,999 at drayesha.pk 🎉";
    say(display);
    expect(display).toBe("Rs 2,999 at drayesha.pk 🎉");
  });
});

describe("the brand dictionary", () => {
  const entries: PronunciationEntry[] = [
    { written: "Ayesha", say_as: "aa-ye-sha", status: "approved" },
    { written: "Dr Ayesha Clinic", say_as: "Doctor aa-ye-sha clinic", status: "approved" },
    { written: "Gulberg", say_as: "gul-berg", status: "approved" },
    { written: "Lahore", say_as: "la-hor", status: "suggested" },
    { written: "PKLI", say_as: "pee-kay-el-eye", status: "approved" },
  ];

  it("a dictionary word gets its say-as form (whole word, any case)", () => {
    expect(applyDictionary("I'm ayesha from GULBERG", entries)).toBe("I'm aa-ye-sha from gul-berg");
    expect(applyDictionary("Ayeshas and Gulberg2", entries)).toBe("Ayeshas and Gulberg2");
  });

  it("longest entry first", () => {
    expect(applyDictionary("Welcome to Dr Ayesha Clinic", entries)).toBe("Welcome to Doctor aa-ye-sha clinic");
  });

  it("suggested entries are NOT applied", () => {
    expect(applyDictionary("Lahore", entries)).toBe("Lahore");
  });

  it("spoken_text: dictionary + normaliser; the say-as form is not normalised again; display_text untouched", () => {
    const display = "Ayesha at PKLI says: Rs 2,999 only, in Lahore 🎉";
    const spoken = buildSpokenText(display, entries);
    expect(spoken).toBe("aa-ye-sha at pee-kay-el-eye says: two thousand nine hundred and ninety-nine rupees only, in Lahore");
    expect(display).toBe("Ayesha at PKLI says: Rs 2,999 only, in Lahore 🎉");
  });
});
