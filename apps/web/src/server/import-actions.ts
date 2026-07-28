"use server";

import { MAX_CSV_BYTES, safeFilename } from "@payrecon/domain";
import { eq } from "drizzle-orm";
import { CSV_CANONICAL_FIELDS, CSV_DATE_FORMATS, type CsvMapping } from "@payrecon/ingestion";
import { importBatches, recordAudit } from "@payrecon/db";
import { enqueueImport, getQueue } from "@payrecon/jobs";
import { loadEnv } from "@payrecon/config/env";
import { actionError, actionSuccess, orgAction, type ActionState } from "./actions";
import { db } from "./db";

const createHandler = orgAction("imports:create", async (context, formData) => {
  const uploaded = formData.get("file");
  if (!(uploaded instanceof File) || uploaded.size === 0) {
    return actionError("Choose a non-empty CSV file.");
  }
  if (uploaded.size > MAX_CSV_BYTES) {
    return actionError(`CSV files must be smaller than ${MAX_CSV_BYTES / 1_048_576} MiB.`);
  }
  if (!uploaded.name.toLowerCase().endsWith(".csv")) {
    return actionError("Choose a CSV file.");
  }

  const columns: CsvMapping["columns"] = {};
  for (const field of CSV_CANONICAL_FIELDS) {
    const header = formData.get(`column-${field}`);
    if (typeof header === "string" && header.trim().length > 0) columns[field] = header.trim();
  }
  const amountUnit = formData.get("amountUnit");
  const dateFormat = formData.get("dateFormat");
  if (amountUnit !== "minor" && amountUnit !== "decimal") {
    return actionError("Choose the unit used by the amount column.");
  }
  if (
    typeof dateFormat !== "string" ||
    !(CSV_DATE_FORMATS as readonly string[]).includes(dateFormat)
  ) {
    return actionError("Choose the date format used by the file.");
  }

  const content = await uploaded.text();
  const [batch] = await db()
    .insert(importBatches)
    .values({
      organizationId: context.org.organizationId,
      filename: safeFilename(uploaded.name, "import.csv"),
      byteSize: uploaded.size,
      status: "uploaded",
      mapping: { columns, amountUnit, dateFormat },
      rawContent: content,
      createdByUserId: context.org.user.id,
    })
    .returning({ id: importBatches.id });
  if (!batch) throw new Error("Import batch creation returned no row");

  await recordAudit(db(), {
    organizationId: context.org.organizationId,
    actor: { type: "user", userId: context.org.user.id },
    action: "import.created",
    targetType: "import_batch",
    targetId: batch.id,
    correlationId: context.correlationId,
    ipHash: context.ipHash,
    metadata: { filename: safeFilename(uploaded.name, "import.csv"), byteSize: uploaded.size },
  });

  try {
    const queue = await getQueue({ connectionString: loadEnv().DATABASE_URL, max: 2 });
    await enqueueImport(queue, {
      organizationId: context.org.organizationId,
      batchId: batch.id,
      correlationId: context.correlationId,
    });
  } catch (error) {
    await db()
      .update(importBatches)
      .set({
        status: "failed",
        finishedAt: new Date(),
        errorMessage: "Could not queue this import.",
      })
      .where(eq(importBatches.id, batch.id));
    throw error;
  }

  return actionSuccess(
    "Import uploaded and queued. Refresh this page shortly to see row counts and validation errors.",
  );
});

export async function createImportAction(
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return createHandler(previous, formData);
}
