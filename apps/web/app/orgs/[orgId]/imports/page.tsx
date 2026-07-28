import type { Metadata } from "next";
import { and, desc, eq } from "drizzle-orm";
import { hasPermission } from "@payrecon/domain";
import { importBatches, importRowErrors } from "@payrecon/db";
import { CSV_CANONICAL_FIELDS, CSV_DATE_FORMATS } from "@payrecon/ingestion";
import { ActionForm } from "@/components/action-form";
import { Card, Field, Input, PageHeader, Select, Table, Td, Th } from "@/components/ui";
import { NotPermitted } from "@/components/forbidden";
import { displayDateTime, displayRelative } from "@/lib/format";
import { createImportAction } from "@/server/import-actions";
import { getCsrfToken } from "@/server/csrf";
import { db } from "@/server/db";
import { requireOrg } from "@/server/session";

export const metadata: Metadata = { title: "Imports" };

const REQUIRED_FIELDS = new Set(["externalId", "amountMinor", "currency", "status", "occurredAt"]);

export default async function ImportsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const org = await requireOrg(orgId);

  if (!hasPermission(org.role, "imports:read")) {
    return (
      <>
        <PageHeader title="Imports" />
        <NotPermitted what="data imports" role={org.role} />
      </>
    );
  }

  const [batches, csrf] = await Promise.all([
    db()
      .select({
        id: importBatches.id,
        filename: importBatches.filename,
        status: importBatches.status,
        totalRows: importBatches.totalRows,
        validRows: importBatches.validRows,
        errorRows: importBatches.errorRows,
        insertedRows: importBatches.insertedRows,
        updatedRows: importBatches.updatedRows,
        errorMessage: importBatches.errorMessage,
        createdAt: importBatches.createdAt,
        finishedAt: importBatches.finishedAt,
      })
      .from(importBatches)
      .where(eq(importBatches.organizationId, org.organizationId))
      .orderBy(desc(importBatches.createdAt))
      .limit(20),
    getCsrfToken(),
  ]);
  const latest = batches[0] ?? null;
  const latestErrors = latest
    ? await db()
        .select({
          rowNumber: importRowErrors.rowNumber,
          column: importRowErrors.column,
          message: importRowErrors.message,
          valueExcerpt: importRowErrors.valueExcerpt,
        })
        .from(importRowErrors)
        .where(
          and(
            eq(importRowErrors.organizationId, org.organizationId),
            eq(importRowErrors.batchId, latest.id),
          ),
        )
        .orderBy(importRowErrors.rowNumber)
        .limit(50)
    : [];
  const canCreate = hasPermission(org.role, "imports:create");

  return (
    <>
      <PageHeader
        title="Imports"
        description="Upload internal payment records as CSV. Re-importing an external id updates that record instead of duplicating it."
      />
      <div className="space-y-6">
        <Card
          title="Recent imports"
          description="The worker validates every row and keeps row-level errors for review."
        >
          {batches.length === 0 ? (
            <p className="text-sm text-[var(--color-text-muted)]">
              No CSV files have been imported.
            </p>
          ) : (
            <Table caption="Recent CSV imports">
              <thead>
                <tr>
                  <Th>File</Th>
                  <Th>Status</Th>
                  <Th>Rows</Th>
                  <Th>Written</Th>
                  <Th>Finished</Th>
                </tr>
              </thead>
              <tbody>
                {batches.map((batch) => (
                  <tr key={batch.id}>
                    <Td>
                      <code className="text-xs">{batch.filename}</code>
                      {batch.errorMessage && (
                        <span className="mt-1 block text-xs text-[var(--color-critical)]">
                          {batch.errorMessage}
                        </span>
                      )}
                    </Td>
                    <Td className="capitalize">{batch.status}</Td>
                    <Td>
                      {batch.totalRows} total · {batch.validRows} valid · {batch.errorRows} errors
                    </Td>
                    <Td>
                      {batch.insertedRows} inserted · {batch.updatedRows} updated
                    </Td>
                    <Td>
                      {batch.finishedAt ? (
                        <span title={displayDateTime(batch.finishedAt)}>
                          {displayRelative(batch.finishedAt)}
                        </span>
                      ) : (
                        <span title={displayDateTime(batch.createdAt)}>Queued</span>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        {latest && latestErrors.length > 0 && (
          <Card
            title={`Row errors in ${latest.filename}`}
            description="Showing the first 50 rejected rows from the latest import."
          >
            <Table caption="CSV row errors">
              <thead>
                <tr>
                  <Th>Row</Th>
                  <Th>Column</Th>
                  <Th>Reason</Th>
                  <Th>Value</Th>
                </tr>
              </thead>
              <tbody>
                {latestErrors.map((error, index) => (
                  <tr key={`${error.rowNumber}-${error.column ?? "row"}-${index}`}>
                    <Td>{error.rowNumber}</Td>
                    <Td>{error.column ?? "—"}</Td>
                    <Td>{error.message}</Td>
                    <Td>
                      <code className="text-xs">{error.valueExcerpt ?? "—"}</code>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        )}

        {canCreate && (
          <Card
            title="Upload CSV"
            description="Map each canonical field to the exact header in your spreadsheet. Required mappings are marked with an asterisk."
          >
            <ActionForm
              action={createImportAction}
              csrf={csrf}
              organizationId={org.organizationId}
              submitLabel="Upload and process"
              pendingLabel="Uploading…"
              variant="primary"
            >
              <Field
                label="CSV file"
                htmlFor="import-file"
                hint="Up to 20 MiB and 100,000 data rows."
              >
                <Input id="import-file" name="file" type="file" accept=".csv,text/csv" required />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                {CSV_CANONICAL_FIELDS.map((field) => (
                  <Field
                    key={field}
                    label={`${field}${REQUIRED_FIELDS.has(field) ? " *" : ""}`}
                    htmlFor={`column-${field}`}
                    hint={REQUIRED_FIELDS.has(field) ? "Required." : "Optional."}
                  >
                    <Input
                      id={`column-${field}`}
                      name={`column-${field}`}
                      required={REQUIRED_FIELDS.has(field)}
                      defaultValue={field}
                    />
                  </Field>
                ))}
                <Field
                  label="Amount unit"
                  htmlFor="amount-unit"
                  hint="Never inferred from the file."
                >
                  <Select id="amount-unit" name="amountUnit" defaultValue="minor">
                    <option value="minor">Minor units (e.g. 1050)</option>
                    <option value="decimal">Decimal units (e.g. 10.50)</option>
                  </Select>
                </Field>
                <Field label="Date format" htmlFor="date-format">
                  <Select id="date-format" name="dateFormat" defaultValue="iso8601">
                    {CSV_DATE_FORMATS.map((format) => (
                      <option key={format} value={format}>
                        {format}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            </ActionForm>
          </Card>
        )}
      </div>
    </>
  );
}
