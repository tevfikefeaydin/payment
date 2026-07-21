import { describe, expect, it } from "vitest";
import {
  MoneyBag,
  MoneyError,
  absMoney,
  absoluteDifference,
  addMoney,
  compareMoney,
  currencyExponent,
  formatMoney,
  isValidCurrency,
  isValidStripeAmount,
  isZeroDecimalCurrency,
  isZeroMoney,
  money,
  moneyEquals,
  negateMoney,
  normalizeCurrency,
  parseAmount,
  parseAmountMinor,
  parseDecimalToMinor,
  serializeAmountMinor,
  subtractMoney,
  toDecimalString,
  zero,
} from "./money";

describe("normalizeCurrency", () => {
  it("uppercases and trims", () => {
    expect(normalizeCurrency("usd")).toBe("USD");
    expect(normalizeCurrency("  eur  ")).toBe("EUR");
    expect(normalizeCurrency("JpY")).toBe("JPY");
  });

  it("rejects anything that is not three letters", () => {
    for (const bad of ["US", "USDX", "US1", "", "   ", "u$d", "12345"]) {
      expect(() => normalizeCurrency(bad)).toThrow(MoneyError);
    }
  });

  it("names the offending input in the error message", () => {
    expect(() => normalizeCurrency("US")).toThrow(/Invalid currency code/);
    expect(() => normalizeCurrency("US")).toThrow(/"US"/);
  });

  it("isValidCurrency mirrors normalizeCurrency without throwing", () => {
    expect(isValidCurrency("usd")).toBe(true);
    expect(isValidCurrency("US")).toBe(false);
    expect(isValidCurrency("")).toBe(false);
  });
});

describe("currencyExponent", () => {
  it("reports 0 for zero-decimal currencies", () => {
    for (const code of ["JPY", "KRW", "VND", "CLP", "XOF"]) {
      expect(currencyExponent(code)).toBe(0);
      expect(isZeroDecimalCurrency(code)).toBe(true);
    }
  });

  it("reports 3 for three-decimal currencies", () => {
    for (const code of ["BHD", "KWD", "JOD", "OMR", "TND"]) {
      expect(currencyExponent(code)).toBe(3);
      expect(isZeroDecimalCurrency(code)).toBe(false);
    }
  });

  it("defaults to 2 for everything else", () => {
    for (const code of ["USD", "EUR", "GBP", "AUD", "ZZZ"]) {
      expect(currencyExponent(code)).toBe(2);
    }
  });

  it("is case-insensitive", () => {
    expect(currencyExponent("jpy")).toBe(0);
    expect(currencyExponent("bhd")).toBe(3);
    expect(currencyExponent("usd")).toBe(2);
  });

  it("rejects an invalid code rather than defaulting to 2", () => {
    expect(() => currencyExponent("US")).toThrow(MoneyError);
  });
});

describe("parseAmountMinor", () => {
  it("accepts a bare integer number of minor units", () => {
    expect(parseAmountMinor("1050")).toBe(1050n);
    expect(parseAmountMinor("-1050")).toBe(-1050n);
    expect(parseAmountMinor("0")).toBe(0n);
    expect(parseAmountMinor("  1050  ")).toBe(1050n);
    expect(parseAmountMinor("000123")).toBe(123n);
  });

  it("rejects a decimal point outright rather than guessing", () => {
    expect(() => parseAmountMinor("10.50")).toThrow(MoneyError);
    expect(() => parseAmountMinor("10.50")).toThrow(/Decimal points are not accepted/);
  });

  it("rejects empty, non-numeric and exponential input", () => {
    expect(() => parseAmountMinor("")).toThrow(/Amount is required/);
    expect(() => parseAmountMinor("   ")).toThrow(/Amount is required/);
    expect(() => parseAmountMinor("abc")).toThrow(MoneyError);
    expect(() => parseAmountMinor("1e5")).toThrow(MoneyError);
    expect(() => parseAmountMinor("+1050")).toThrow(MoneyError);
    expect(() => parseAmountMinor("1_050")).toThrow(MoneyError);
    expect(() => parseAmountMinor("1,050")).toThrow(MoneyError);
  });
});

describe("parseDecimalToMinor", () => {
  it("converts a two-decimal major-unit string", () => {
    expect(parseDecimalToMinor("10.50", "USD")).toBe(1050n);
    expect(parseDecimalToMinor("0.01", "USD")).toBe(1n);
    expect(parseDecimalToMinor("10", "USD")).toBe(1000n);
  });

  it("treats a zero-decimal currency's major unit as its minor unit", () => {
    expect(parseDecimalToMinor("500", "JPY")).toBe(500n);
    expect(parseDecimalToMinor("500.0", "JPY")).toBe(500n);
    expect(() => parseDecimalToMinor("500.5", "JPY")).toThrow(/Refusing to round/);
  });

  it("pads a short fraction", () => {
    expect(parseDecimalToMinor("10.5", "USD")).toBe(1050n);
    expect(parseDecimalToMinor("10.5", "BHD")).toBe(10500n);
  });

  it("accepts consistently placed thousands separators", () => {
    expect(parseDecimalToMinor("1,234.56", "USD")).toBe(123456n);
    expect(parseDecimalToMinor("1,234,567.89", "USD")).toBe(123456789n);
    expect(() => parseDecimalToMinor("1,23,456.78", "USD")).toThrow(MoneyError);
    expect(() => parseDecimalToMinor("12,34", "USD")).toThrow(MoneyError);
  });

  it("drops trailing zeros beyond the currency's precision", () => {
    expect(parseDecimalToMinor("10.500", "USD")).toBe(1050n);
    expect(parseDecimalToMinor("10.5000000", "USD")).toBe(1050n);
  });

  it("REFUSES to round a value with more precision than the currency supports", () => {
    expect(() => parseDecimalToMinor("10.555", "USD")).toThrow(MoneyError);
    expect(() => parseDecimalToMinor("10.555", "USD")).toThrow(/more precision than USD/);
    expect(() => parseDecimalToMinor("10.555", "USD")).toThrow(/Refusing to round/);
    expect(() => parseDecimalToMinor("1.0001", "BHD")).toThrow(/Refusing to round/);
  });

  it("handles negatives, which is how refunds arrive", () => {
    expect(parseDecimalToMinor("-10.50", "USD")).toBe(-1050n);
    expect(parseDecimalToMinor("-0.01", "USD")).toBe(-1n);
    expect(parseDecimalToMinor("-500", "JPY")).toBe(-500n);
  });

  it("rejects malformed decimals", () => {
    for (const bad of ["", "  ", "abc", "1e5", ".50", "10.", "--1", "1.2.3", "+1.00"]) {
      expect(() => parseDecimalToMinor(bad, "USD")).toThrow(MoneyError);
    }
  });

  it("parseAmount dispatches on the declared unit", () => {
    expect(parseAmount("1050", "USD", "minor")).toBe(1050n);
    expect(parseAmount("10.50", "USD", "decimal")).toBe(1050n);
    expect(() => parseAmount("10.50", "USD", "minor")).toThrow(MoneyError);
  });
});

describe("exactness beyond Number.MAX_SAFE_INTEGER", () => {
  const huge = 9007199254740993n; // 2^53 + 1, not representable as a double

  it("round-trips through minor-unit serialisation", () => {
    const text = serializeAmountMinor(huge);
    expect(text).toBe("9007199254740993");
    expect(parseAmountMinor(text)).toBe(huge);
  });

  it("round-trips through a decimal major-unit string", () => {
    const decimal = toDecimalString(huge, "USD");
    expect(decimal).toBe("90071992547409.93");
    expect(parseDecimalToMinor(decimal, "USD")).toBe(huge);
  });

  it("would have been corrupted had it passed through a JS number", () => {
    expect(Number(huge).toString()).toBe("9007199254740992");
    expect(BigInt(Number(huge))).not.toBe(huge);
  });

  it("formats exactly", () => {
    expect(formatMoney(huge, "USD")).toBe("$90,071,992,547,409.93");
  });

  it("adds without loss", () => {
    const sum = addMoney(money(huge, "USD"), money(1n, "USD"));
    expect(sum.amountMinor).toBe(9007199254740994n);
  });
});

describe("toDecimalString", () => {
  it("renders two-decimal currencies", () => {
    expect(toDecimalString(1050n, "USD")).toBe("10.50");
    expect(toDecimalString(0n, "USD")).toBe("0.00");
    expect(toDecimalString(5n, "USD")).toBe("0.05");
    expect(toDecimalString(-5n, "USD")).toBe("-0.05");
    expect(toDecimalString(-1050n, "USD")).toBe("-10.50");
  });

  it("renders zero-decimal currencies without a separator", () => {
    expect(toDecimalString(500n, "JPY")).toBe("500");
    expect(toDecimalString(-500n, "JPY")).toBe("-500");
    expect(toDecimalString(0n, "JPY")).toBe("0");
  });

  it("renders three-decimal currencies", () => {
    expect(toDecimalString(10500n, "BHD")).toBe("10.500");
    expect(toDecimalString(1n, "KWD")).toBe("0.001");
  });
});

describe("formatMoney", () => {
  // Intl separates a currency code from the number with a non-breaking space.
  const NBSP = String.fromCharCode(0x00a0);

  it("formats per currency", () => {
    expect(formatMoney(1050n, "USD")).toBe("$10.50");
    expect(formatMoney(-1050n, "usd")).toBe("-$10.50");
    expect(formatMoney(500n, "JPY")).toBe("¥500");
    expect(formatMoney(10500n, "BHD")).toBe(`BHD${NBSP}10.500`);
    expect(formatMoney(500n, "KRW")).toBe("₩500");
  });

  it("uses the currency's own precision, never a hard-coded two decimals", () => {
    expect(formatMoney(500n, "JPY")).not.toContain(".");
    expect(formatMoney(10500n, "BHD")).toContain(".500");
  });

  it("falls back to an unambiguous plain rendering when Intl cannot help", () => {
    expect(formatMoney(1050n, "USD", "not a locale")).toBe("10.50 USD");
  });
});

describe("arithmetic", () => {
  it("adds and subtracts within one currency", () => {
    expect(addMoney(money(1000n, "USD"), money(50n, "USD"))).toEqual({
      amountMinor: 1050n,
      currency: "USD",
    });
    expect(subtractMoney(money(1000n, "USD"), money(1500n, "USD"))).toEqual({
      amountMinor: -500n,
      currency: "USD",
    });
  });

  it("THROWS rather than combining unlike currencies", () => {
    const usd = money(1000n, "USD");
    const eur = money(1000n, "EUR");
    expect(() => addMoney(usd, eur)).toThrow(MoneyError);
    expect(() => addMoney(usd, eur)).toThrow(/Refusing to combine unlike currencies/);
    expect(() => addMoney(usd, eur)).toThrow(/USD and EUR/);
    expect(() => subtractMoney(usd, eur)).toThrow(MoneyError);
    expect(() => compareMoney(usd, eur)).toThrow(MoneyError);
    expect(() => absoluteDifference(usd, eur)).toThrow(MoneyError);
  });

  it("negates and absolutises, which is how refund signs are handled", () => {
    expect(negateMoney(money(1050n, "USD")).amountMinor).toBe(-1050n);
    expect(negateMoney(money(-1050n, "USD")).amountMinor).toBe(1050n);
    expect(absMoney(money(-1050n, "USD")).amountMinor).toBe(1050n);
    expect(absMoney(money(1050n, "USD")).amountMinor).toBe(1050n);
    expect(negateMoney(money(0n, "USD")).amountMinor).toBe(0n);
  });

  it("compares and tests equality", () => {
    expect(compareMoney(money(1n, "USD"), money(2n, "USD"))).toBe(-1);
    expect(compareMoney(money(2n, "USD"), money(1n, "USD"))).toBe(1);
    expect(compareMoney(money(1n, "USD"), money(1n, "USD"))).toBe(0);
    expect(moneyEquals(money(1n, "USD"), money(1n, "USD"))).toBe(true);
    expect(moneyEquals(money(1n, "USD"), money(1n, "EUR"))).toBe(false);
    expect(isZeroMoney(zero("USD"))).toBe(true);
    expect(isZeroMoney(money(1n, "USD"))).toBe(false);
  });

  it("reports an absolute difference regardless of order", () => {
    expect(absoluteDifference(money(1000n, "USD"), money(1500n, "USD")).amountMinor).toBe(500n);
    expect(absoluteDifference(money(1500n, "USD"), money(1000n, "USD")).amountMinor).toBe(500n);
  });

  it("validates the currency when constructing", () => {
    expect(money(1n, "usd").currency).toBe("USD");
    expect(() => money(1n, "US")).toThrow(MoneyError);
    expect(() => zero("US")).toThrow(MoneyError);
  });
});

describe("isValidStripeAmount", () => {
  it("requires three-decimal currencies to be a multiple of 10", () => {
    expect(isValidStripeAmount(10n, "BHD")).toBe(true);
    expect(isValidStripeAmount(10500n, "BHD")).toBe(true);
    expect(isValidStripeAmount(0n, "BHD")).toBe(true);
    expect(isValidStripeAmount(15n, "BHD")).toBe(false);
    expect(isValidStripeAmount(1n, "KWD")).toBe(false);
    expect(isValidStripeAmount(-20n, "BHD")).toBe(true);
    expect(isValidStripeAmount(-15n, "BHD")).toBe(false);
  });

  it("requires hundred-multiple currencies to be a multiple of 100", () => {
    expect(isValidStripeAmount(100n, "HUF")).toBe(true);
    expect(isValidStripeAmount(5000n, "HUF")).toBe(true);
    expect(isValidStripeAmount(150n, "HUF")).toBe(false);
    expect(isValidStripeAmount(1n, "HUF")).toBe(false);
    expect(isValidStripeAmount(200n, "TWD")).toBe(true);
    expect(isValidStripeAmount(250n, "TWD")).toBe(false);
  });

  it("accepts any integer for ordinary currencies", () => {
    for (const amount of [0n, 1n, 7n, 1050n, 9007199254740993n, -3n]) {
      expect(isValidStripeAmount(amount, "USD")).toBe(true);
    }
    expect(isValidStripeAmount(1n, "JPY")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isValidStripeAmount(15n, "bhd")).toBe(false);
    expect(isValidStripeAmount(150n, "huf")).toBe(false);
  });
});

describe("MoneyBag", () => {
  it("keeps a separate total per currency", () => {
    const bag = new MoneyBag()
      .addAmount(1000n, "USD")
      .addAmount(50n, "usd")
      .addAmount(500n, "JPY")
      .addAmount(-200n, "USD");

    expect(bag.get("USD")).toBe(850n);
    expect(bag.get("jpy")).toBe(500n);
    expect(bag.get("EUR")).toBe(0n);
    expect(bag.isEmpty()).toBe(false);
    expect(new MoneyBag().isEmpty()).toBe(true);
  });

  it("returns entries sorted by currency code for stable rendering", () => {
    const bag = new MoneyBag()
      .addAmount(1n, "USD")
      .addAmount(2n, "EUR")
      .addAmount(3n, "AUD")
      .addAmount(4n, "JPY");

    expect(bag.currencies()).toEqual(["AUD", "EUR", "JPY", "USD"]);
    expect(bag.entries()).toEqual([
      { currency: "AUD", amountMinor: 3n },
      { currency: "EUR", amountMinor: 2n },
      { currency: "JPY", amountMinor: 4n },
      { currency: "USD", amountMinor: 1n },
    ]);
  });

  it("serialises amounts as strings so a bigint never becomes a JSON number", () => {
    const bag = new MoneyBag().addAmount(9007199254740993n, "USD").addAmount(500n, "JPY");

    expect(bag.toJSON()).toEqual([
      { currency: "JPY", amountMinor: "500" },
      { currency: "USD", amountMinor: "9007199254740993" },
    ]);
    for (const entry of bag.toJSON()) {
      expect(typeof entry.amountMinor).toBe("string");
    }
    expect(JSON.parse(JSON.stringify(bag))).toEqual(bag.toJSON());
  });

  it("deliberately offers NO combined cross-currency total", () => {
    const bag = new MoneyBag().addAmount(1000n, "USD").addAmount(500n, "JPY");
    const surface = bag as unknown as Record<string, unknown>;
    expect(surface.total).toBeUndefined();
    expect(surface.sum).toBeUndefined();
    const methods = Object.getOwnPropertyNames(MoneyBag.prototype);
    expect(methods).not.toContain("total");
    expect(methods).not.toContain("sum");
    expect(methods).not.toContain("grandTotal");
  });

  it("builds from an iterable and merges another bag", () => {
    const a = MoneyBag.from([
      { amountMinor: 100n, currency: "USD" },
      { amountMinor: 200n, currency: "EUR" },
    ]);
    const b = new MoneyBag().addAmount(50n, "USD").addAmount(7n, "JPY");

    a.merge(b);
    expect(a.entries()).toEqual([
      { currency: "EUR", amountMinor: 200n },
      { currency: "JPY", amountMinor: 7n },
      { currency: "USD", amountMinor: 150n },
    ]);
    // Merging does not mutate the source bag.
    expect(b.get("USD")).toBe(50n);
  });

  it("validates currencies on the way in", () => {
    expect(() => new MoneyBag().addAmount(1n, "US")).toThrow(MoneyError);
    expect(() => new MoneyBag().get("US")).toThrow(MoneyError);
  });
});
