import { describe, expect, it } from "vitest";
import { sanitizeCsvValue } from "@payrecon/domain";
import {
  detectHeaders,
  parseAndValidate,
  parseCsvDate,
  previewRows,
  toCsvExport,
  type CsvMapping,
} from "./csv";

/**
 * These tests exercise the real parser against real CSV text. Nothing is
 * stubbed: every assertion is about the records and errors an operator would
 * actually get.
 */

const HEADER = "id,amount,currency,state,when";

const MAPPING: CsvMapping = {
  columns: {
    externalId: "id",
    amountMinor: "amount",
    currency: "currency",
    status: "state",
    occurredAt: "when",
  },
  amountUnit: "minor",
};

const DECIMAL_MAPPING: CsvMapping = { ...MAPPING, amountUnit: "decimal" };

function csv(...dataRows: string[]): string {
  return [HEADER, ...dataRows].join("\n") + "\n";
}

describe("detectHeaders", () => {
  it("reads the header row", async () => {
    expect(await detectHeaders(csv("a,1,USD,paid,2026-01-01T00:00:00Z"))).toEqual([
      "id",
      "amount",
      "currency",
      "state",
      "when",
    ]);
  });

  it("strips a UTF-8 BOM so the first column keeps its name", async () => {
    const withBom = `\uFEFF${HEADER}\r\n`;
    const headers = await detectHeaders(withBom);
    expect(headers[0]).toBe("id");
    // The BOM must not survive anywhere in the name, or the mapping would miss.
    expect(headers[0]?.charCodeAt(0)).toBe("i".charCodeAt(0));
  });

  it("handles CRLF line endings", async () => {
    expect(await detectHeaders("a,b\r\n1,2\r\n")).toEqual(["a", "b"]);
  });

  it("returns an empty list for empty content", async () => {
    expect(await detectHeaders("")).toEqual([]);
  });
});

describe("previewRows", () => {
  it("returns the first N data rows keyed by header", async () => {
    const preview = await previewRows(
      csv(
        "a,100,USD,paid,2026-01-01T00:00:00Z",
        "b,200,USD,paid,2026-01-02T00:00:00Z",
        "c,300,USD,paid,2026-01-03T00:00:00Z",
      ),
      2,
    );
    expect(preview.headers).toEqual(["id", "amount", "currency", "state", "when"]);
    expect(preview.rows).toHaveLength(2);
    expect(preview.rows[0]).toMatchObject({ id: "a", amount: "100" });
    expect(preview.truncated).toBe(true);
  });

  it("reports truncated=false when the file fits within the limit", async () => {
    const preview = await previewRows(csv("a,100,USD,paid,2026-01-01T00:00:00Z"), 10);
    expect(preview.rows).toHaveLength(1);
    expect(preview.truncated).toBe(false);
  });
});

describe("parseAndValidate — happy path", () => {
  it("accepts a valid file and normalises every field", async () => {
    const result = await parseAndValidate(
      csv(
        "ord-1,1050,usd,paid,2026-01-15T10:00:00Z",
        "ord-2,-250,EUR,refunded,2026-01-16T10:00:00Z",
      ),
      MAPPING,
    );

    expect(result.errors).toEqual([]);
    expect(result.totalRows).toBe(2);
    expect(result.validRows).toBe(2);
    expect(result.records).toHaveLength(2);

    const [first, second] = result.records;
    expect(first?.externalId).toBe("ord-1");
    // Amount stays exact and becomes a bigint of minor units.
    expect(first?.amountMinor).toBe(1050n);
    expect(first?.currency).toBe("USD");
    expect(first?.status).toBe("paid");
    expect(first?.occurredAt.toISOString()).toBe("2026-01-15T10:00:00.000Z");
    expect(second?.amountMinor).toBe(-250n);
    expect(second?.currency).toBe("EUR");
  });

  it("handles CRLF and a BOM in a full import", async () => {
    const content = `\uFEFF${HEADER}\r\nord-1,1050,USD,paid,2026-01-15T10:00:00Z\r\n`;
    const result = await parseAndValidate(content, MAPPING);
    expect(result.errors).toEqual([]);
    expect(result.records[0]?.externalId).toBe("ord-1");
  });

  it("converts decimal amounts when the operator declares that unit", async () => {
    const result = await parseAndValidate(
      csv("ord-1,10.50,USD,paid,2026-01-15T10:00:00Z"),
      DECIMAL_MAPPING,
    );
    expect(result.errors).toEqual([]);
    expect(result.records[0]?.amountMinor).toBe(1050n);
  });

  it("ignores blank lines without counting them as rows or errors", async () => {
    const content = `${HEADER}\nord-1,100,USD,paid,2026-01-15T10:00:00Z\n\n   \nord-2,200,USD,paid,2026-01-16T10:00:00Z\n`;
    const result = await parseAndValidate(content, MAPPING);
    expect(result.errors).toEqual([]);
    expect(result.totalRows).toBe(2);
    // The parser drops the truly empty line itself; the whitespace-only line
    // reaches us and is skipped here rather than reported as a malformed row.
    expect(result.blankRows).toBe(1);
  });
});

describe("parseAndValidate — row numbering", () => {
  it("numbers rows as a spreadsheet does: header is 1, first data row is 2", async () => {
    const result = await parseAndValidate(
      csv(
        "ord-1,100,USD,paid,2026-01-15T10:00:00Z", // spreadsheet row 2
        "ord-2,100,ZZZZ,paid,2026-01-15T10:00:00Z", // row 3 — bad currency
        "ord-3,100,USD,paid,2026-01-15T10:00:00Z", // row 4
        "ord-4,nope,USD,paid,2026-01-15T10:00:00Z", // row 5 — bad amount
      ),
      MAPPING,
    );

    expect(result.errors.map((e) => e.rowNumber)).toEqual([3, 5]);
    expect(result.validRows).toBe(2);
    expect(result.totalRows).toBe(4);
  });

  it("keeps spreadsheet numbering when a quoted field contains a newline", async () => {
    // "ord\n2" is ONE spreadsheet row even though it spans two physical lines,
    // so the following bad row must be reported as row 4, not row 5.
    const content =
      `${HEADER}\n` +
      `ord-1,100,USD,paid,2026-01-15T10:00:00Z\n` +
      `"ord\n2",100,USD,paid,2026-01-15T10:00:00Z\n` +
      `ord-3,100,ZZZ9,paid,2026-01-15T10:00:00Z\n`;
    const result = await parseAndValidate(content, MAPPING);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.rowNumber).toBe(4);
  });
});

describe("parseAndValidate — rejections", () => {
  it("reports a row with the wrong column count and keeps importing the rest", async () => {
    const result = await parseAndValidate(
      csv(
        "ord-1,100,USD,paid,2026-01-15T10:00:00Z",
        "ord-2,100,USD,paid", // one column short
        "ord-3,100,USD,paid,2026-01-15T10:00:00Z,extra", // one too many
        "ord-4,100,USD,paid,2026-01-15T10:00:00Z",
      ),
      MAPPING,
    );

    expect(result.validRows).toBe(2);
    expect(result.errorRows).toBe(2);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]?.rowNumber).toBe(3);
    expect(result.errors[0]?.message).toContain("expected 5 columns but found 4");
    expect(result.errors[1]?.message).toContain("expected 5 columns but found 6");
    // A malformed row is a whole-row problem, not a column problem.
    expect(result.errors[0]?.column).toBeNull();
  });

  it("rejects an invalid date and names the column", async () => {
    const result = await parseAndValidate(csv("ord-1,100,USD,paid,not-a-date"), MAPPING);
    expect(result.records).toEqual([]);
    expect(result.errors[0]?.column).toBe("when");
    expect(result.errors[0]?.message).toContain("not a valid iso8601 date");
    expect(result.errors[0]?.valueExcerpt).toBe("not-a-date");
  });

  it("rejects a date that looks well-formed but does not exist", async () => {
    const mapping: CsvMapping = { ...MAPPING, dateFormat: "YYYY-MM-DD" };
    const result = await parseAndValidate(csv("ord-1,100,USD,paid,2026-02-30"), mapping);
    expect(result.records).toEqual([]);
    expect(result.errors[0]?.column).toBe("when");
  });

  it("rejects an invalid currency", async () => {
    const result = await parseAndValidate(
      csv("ord-1,100,DOLLARS,paid,2026-01-15T10:00:00Z"),
      MAPPING,
    );
    expect(result.records).toEqual([]);
    expect(result.errors[0]?.column).toBe("currency");
    expect(result.errors[0]?.message).toContain("ISO 4217");
  });

  it("rejects an invalid status", async () => {
    const result = await parseAndValidate(
      csv("ord-1,100,USD,settled,2026-01-15T10:00:00Z"),
      MAPPING,
    );
    expect(result.records).toEqual([]);
    expect(result.errors[0]?.column).toBe("state");
    expect(result.errors[0]?.message).toContain("status must be one of");
  });

  it("accepts a status whose case differs from the canonical spelling", async () => {
    const result = await parseAndValidate(csv("ord-1,100,USD,Paid,2026-01-15T10:00:00Z"), MAPPING);
    expect(result.errors).toEqual([]);
    expect(result.records[0]?.status).toBe("paid");
  });

  it("rejects an empty required cell", async () => {
    const result = await parseAndValidate(csv(",100,USD,paid,2026-01-15T10:00:00Z"), MAPPING);
    expect(result.records).toEqual([]);
    expect(result.errors[0]?.column).toBe("id");
    expect(result.errors[0]?.message).toContain("required");
  });

  it("fails the whole file when a required field is not mapped", async () => {
    const result = await parseAndValidate(csv("ord-1,100,USD,paid,2026-01-15T10:00:00Z"), {
      columns: { externalId: "id", amountMinor: "amount", currency: "currency" },
      amountUnit: "minor",
    });
    expect(result.records).toEqual([]);
    expect(result.errors.map((e) => e.message)).toContain(
      'Required field "status" is not mapped to any column.',
    );
  });

  it("fails the whole file when a mapped column is absent from the header", async () => {
    const result = await parseAndValidate(csv("ord-1,100,USD,paid,2026-01-15T10:00:00Z"), {
      ...MAPPING,
      columns: { ...MAPPING.columns, externalId: "reference" },
    });
    expect(result.errors[0]?.message).toContain('Mapped column "reference" was not found');
  });

  it("reports an empty file", async () => {
    const result = await parseAndValidate("", MAPPING);
    expect(result.errors[0]?.message).toContain("no header row");
  });
});

describe("parseAndValidate — ambiguous money is never coerced", () => {
  it('rejects "10.50" when the operator declared MINOR units', async () => {
    const result = await parseAndValidate(
      csv("ord-1,10.50,USD,paid,2026-01-15T10:00:00Z"),
      MAPPING,
    );

    // The critical assertion: the row FAILS. It is neither 1050 nor 10.
    expect(result.records).toEqual([]);
    expect(result.validRows).toBe(0);
    expect(result.errorRows).toBe(1);
    expect(result.errors[0]?.column).toBe("amount");
    expect(result.errors[0]?.message).toContain("Decimal points are not accepted here");
    expect(result.errors[0]?.valueExcerpt).toBe("10.50");
  });

  it("rejects a decimal with more precision than the currency supports", async () => {
    // USD has 2 minor digits; 10.505 cannot be represented and must not round.
    const result = await parseAndValidate(
      csv("ord-1,10.505,USD,paid,2026-01-15T10:00:00Z"),
      DECIMAL_MAPPING,
    );
    expect(result.records).toEqual([]);
    expect(result.errors[0]?.message).toContain("Refusing to round");
  });

  it("rejects a non-numeric amount", async () => {
    const result = await parseAndValidate(
      csv("ord-1,1 050,USD,paid,2026-01-15T10:00:00Z"),
      MAPPING,
    );
    expect(result.records).toEqual([]);
    expect(result.errors[0]?.column).toBe("amount");
  });

  it("honours zero-decimal currencies when converting a decimal amount", async () => {
    // JPY has no minor unit: 500 JPY is ¥500, not ¥5.00.
    const result = await parseAndValidate(
      csv("ord-1,500,JPY,paid,2026-01-15T10:00:00Z"),
      DECIMAL_MAPPING,
    );
    expect(result.errors).toEqual([]);
    expect(result.records[0]?.amountMinor).toBe(500n);
  });
});

describe("parseAndValidate — duplicate externalIds within one file", () => {
  it("keeps the first occurrence and reports the later one", async () => {
    const result = await parseAndValidate(
      csv(
        "ord-1,100,USD,paid,2026-01-15T10:00:00Z",
        "ord-2,200,USD,paid,2026-01-16T10:00:00Z",
        "ord-1,999,USD,failed,2026-01-17T10:00:00Z",
      ),
      MAPPING,
    );

    expect(result.records).toHaveLength(2);
    expect(result.records.map((r) => r.externalId)).toEqual(["ord-1", "ord-2"]);
    // The kept record is the FIRST one, not the duplicate.
    expect(result.records[0]?.amountMinor).toBe(100n);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.rowNumber).toBe(4);
    expect(result.errors[0]?.message).toContain("already used on row 2");
  });
});

describe("parseAndValidate — row limit", () => {
  it("stops and reports once the row limit is exceeded", async () => {
    const rows = Array.from({ length: 6 }, (_, i) => `ord-${i},100,USD,paid,2026-01-15T10:00:00Z`);
    const result = await parseAndValidate(csv(...rows), MAPPING, { maxRows: 3 });

    expect(result.limitExceeded).toBe(true);
    // Nothing is retained: the batch is rejected, so holding rows wastes memory.
    expect(result.records).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("maximum of 3 data rows");
  });

  it("accepts a file exactly at the limit", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => `ord-${i},100,USD,paid,2026-01-15T10:00:00Z`);
    const result = await parseAndValidate(csv(...rows), MAPPING, { maxRows: 3 });
    expect(result.limitExceeded).toBe(false);
    expect(result.records).toHaveLength(3);
  });

  it("caps the number of collected errors", async () => {
    // "DOLLARS" is not a three-letter ISO code, so every row fails identically.
    const rows = Array.from(
      { length: 20 },
      (_, i) => `ord-${i},100,DOLLARS,paid,2026-01-15T10:00:00Z`,
    );
    const result = await parseAndValidate(csv(...rows), MAPPING, { maxErrors: 5 });
    expect(result.errors).toHaveLength(5);
    expect(result.errorsTruncated).toBe(true);
    // Every row still failed, even though not every failure was retained.
    expect(result.errorRows).toBe(20);
  });
});

describe("parseAndValidate — structurally broken files", () => {
  it("reports an unterminated quote as a structured error instead of throwing", async () => {
    const content = `${HEADER}\nord-1,100,USD,paid,2026-01-15T10:00:00Z\n"ord-2,100,USD,paid,2026-01-15T10:00:00Z\n`;
    const result = await parseAndValidate(content, MAPPING);

    // csv-parse aborts the stream on a structural failure, so no record from
    // the file is trusted. The operator gets a readable explanation rather
    // than an exception — and specifically NOT the misleading "file is empty".
    expect(result.errors.at(-1)?.message).toContain("could not be parsed as CSV");
    expect(result.errors.at(-1)?.message).toContain("Quote Not Closed");
    expect(result.errors.at(-1)?.message).not.toContain("empty");
    expect(result.errorRows).toBeGreaterThan(0);
  });
});

describe("CSV formula injection", () => {
  const INJECTION = "=cmd|'/c calc'!A1";

  it("imports a formula-shaped cell verbatim, as data", async () => {
    const mapping: CsvMapping = {
      ...MAPPING,
      columns: { ...MAPPING.columns, customerId: "cust" },
    };
    const content =
      "id,amount,currency,state,when,cust\n" +
      `ord-1,100,USD,paid,2026-01-15T10:00:00Z,"${INJECTION}"\n`;

    const result = await parseAndValidate(content, mapping);

    expect(result.errors).toEqual([]);
    // Import does NOT mangle the value: it is stored exactly as supplied.
    expect(result.records[0]?.customerId).toBe(INJECTION);
  });

  it("neutralises the cell on export with a leading apostrophe", async () => {
    const exported = toCsvExport([{ customerId: INJECTION, externalId: "ord-1" }]);
    const lines = exported.trimEnd().split("\r\n");

    expect(lines[0]).toBe("customerId,externalId");
    // The apostrophe forces Excel/Sheets/LibreOffice to treat it as text. No
    // surrounding quotes are added because the value has no comma, quote or
    // newline that would require them.
    expect(lines[1]).toBe(`'${INJECTION},ord-1`);
    expect(lines[1]?.startsWith("'=")).toBe(true);
  });

  it("survives a full import-then-export round trip still neutralised", async () => {
    const mapping: CsvMapping = {
      ...MAPPING,
      columns: { ...MAPPING.columns, customerId: "cust" },
    };
    const content =
      "id,amount,currency,state,when,cust\n" +
      `ord-1,100,USD,paid,2026-01-15T10:00:00Z,"${INJECTION}"\n`;

    const parsed = await parseAndValidate(content, mapping);
    const exported = toCsvExport(
      parsed.records.map((r) => ({ externalId: r.externalId, customerId: r.customerId })),
    );

    expect(exported).toContain(`'${INJECTION}`);
    // And it never appears unescaped at the start of a field, which is the
    // position Excel would evaluate.
    expect(exported).not.toContain(`,${INJECTION}`);
  });

  it("neutralises every formula lead character, including in headers", () => {
    const exported = toCsvExport([{ "=evil": "+1", b: "-2", c: "@x", d: "safe" }]);
    const [header, row] = exported.trimEnd().split("\r\n");
    expect(header).toBe("'=evil,b,c,d");
    expect(row).toBe("'+1,'-2,'@x,safe");
  });

  it("agrees with the domain-level sanitiser", () => {
    // Guards against the export helper drifting away from the shared rule.
    expect(sanitizeCsvValue(INJECTION)).toBe(`'${INJECTION}`);
  });
});

describe("toCsvExport", () => {
  it("quotes embedded commas, quotes and newlines", () => {
    const exported = toCsvExport([{ a: 'has "quotes"', b: "has,comma", c: "has\nnewline" }]);
    const lines = exported.split("\r\n");
    expect(lines[1]).toBe('"has ""quotes""","has,comma","has\nnewline"');
  });

  it("serialises bigints as exact decimal strings, never as numbers", () => {
    const huge = 9007199254740993n; // Number.MAX_SAFE_INTEGER + 2
    const exported = toCsvExport([{ amountMinor: huge }]);
    expect(exported).toContain("9007199254740993");
  });

  it("uses an explicit column list when given one", () => {
    const exported = toCsvExport([{ a: "1", b: "2" }], ["b", "a"]);
    expect(exported.split("\r\n")[0]).toBe("b,a");
    expect(exported.split("\r\n")[1]).toBe("2,1");
  });

  it("renders a missing key as an empty cell", () => {
    const exported = toCsvExport([{ a: "1" }, { b: "2" }]);
    expect(exported.trimEnd().split("\r\n")).toEqual(["a,b", "1,", ",2"]);
  });
});

describe("parseCsvDate", () => {
  it("resolves the same digits differently for DD/MM and MM/DD, as declared", () => {
    // The importer never guesses which one "03/04/2026" is.
    expect(parseCsvDate("03/04/2026", "DD/MM/YYYY")).toBe("2026-04-03T00:00:00.000Z");
    expect(parseCsvDate("03/04/2026", "MM/DD/YYYY")).toBe("2026-03-04T00:00:00.000Z");
  });

  it("accepts an optional time component", () => {
    expect(parseCsvDate("2026-01-15 14:30:05", "YYYY-MM-DD")).toBe("2026-01-15T14:30:05.000Z");
  });

  it("rejects impossible dates and times", () => {
    expect(parseCsvDate("2026-02-30", "YYYY-MM-DD")).toBeNull();
    expect(parseCsvDate("2026-13-01", "YYYY-MM-DD")).toBeNull();
    expect(parseCsvDate("2026-01-15 25:00:00", "YYYY-MM-DD")).toBeNull();
  });

  it("rejects a value in a format other than the declared one", () => {
    expect(parseCsvDate("15/01/2026", "YYYY-MM-DD")).toBeNull();
    expect(parseCsvDate("", "iso8601")).toBeNull();
  });
});
