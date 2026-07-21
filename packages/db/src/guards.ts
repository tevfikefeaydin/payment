import { sql } from "drizzle-orm";
import type { Database } from "./client";

/**
 * Database-level invariants applied after every migration run.
 *
 * These are expressed as triggers rather than application discipline so that
 * they hold even for a code path that forgets, a manual query, or a future
 * refactor. Everything here is idempotent and safe to re-run.
 */

/**
 * Make `audit_events` genuinely append-only.
 *
 * The specification requires that ordinary application paths cannot edit or
 * delete audit rows. A trigger enforces that at the engine level: even a
 * compromised or buggy code path holding the application's credentials cannot
 * rewrite history. Deliberate retention deletion is performed by a privileged
 * maintenance path that disables the trigger inside a transaction, which is
 * documented in docs/OPERATIONS.md.
 */
export async function applyAuditAppendOnlyGuard(db: Database): Promise<void> {
  await db.execute(sql`
    create or replace function payrecon_audit_events_immutable()
    returns trigger
    language plpgsql
    as $$
    begin
      raise exception
        'audit_events is append-only: % is not permitted', tg_op
        using errcode = 'restrict_violation';
    end;
    $$;
  `);

  await db.execute(sql`drop trigger if exists audit_events_no_update on audit_events;`);
  await db.execute(sql`
    create trigger audit_events_no_update
      before update on audit_events
      for each row execute function payrecon_audit_events_immutable();
  `);

  await db.execute(sql`drop trigger if exists audit_events_no_delete on audit_events;`);
  await db.execute(sql`
    create trigger audit_events_no_delete
      before delete on audit_events
      for each row execute function payrecon_audit_events_immutable();
  `);
}

/**
 * Enforce that an organization always retains at least one owner.
 *
 * The application checks this too (see `wouldRemoveLastOwner`), with a clearer
 * error message. This trigger is the backstop for any path that does not.
 */
export async function applyLastOwnerGuard(db: Database): Promise<void> {
  await db.execute(sql`
    create or replace function payrecon_require_owner()
    returns trigger
    language plpgsql
    as $$
    declare
      remaining integer;
      target_org uuid;
    begin
      target_org := coalesce(old.organization_id, new.organization_id);

      -- When the organization itself is being deleted, the FK cascade removes
      -- every member including the owner. That is legitimate, so skip the check.
      -- By the time the cascade fires, the parent row is already gone from this
      -- transaction's view.
      if not exists (select 1 from organizations where id = target_org) then
        if tg_op = 'DELETE' then return old; end if;
        return new;
      end if;

      -- Only relevant when an owner is being removed or demoted.
      if (tg_op = 'DELETE' and old.role <> 'owner') then
        return old;
      end if;
      if (tg_op = 'UPDATE' and old.role <> 'owner') then
        return new;
      end if;
      if (tg_op = 'UPDATE' and new.role = 'owner') then
        return new;
      end if;

      select count(*) into remaining
      from organization_members
      where organization_id = target_org
        and role = 'owner'
        and id <> coalesce(old.id, new.id);

      if remaining = 0 then
        raise exception
          'organization % must retain at least one owner', target_org
          using errcode = 'restrict_violation';
      end if;

      if tg_op = 'DELETE' then return old; end if;
      return new;
    end;
    $$;
  `);

  await db.execute(
    sql`drop trigger if exists organization_members_require_owner on organization_members;`,
  );
  await db.execute(sql`
    create trigger organization_members_require_owner
      before update or delete on organization_members
      for each row execute function payrecon_require_owner();
  `);
}

/** Apply every database guard. Called by the migration runner. */
export async function applyGuards(db: Database): Promise<void> {
  await applyAuditAppendOnlyGuard(db);
  await applyLastOwnerGuard(db);
}
