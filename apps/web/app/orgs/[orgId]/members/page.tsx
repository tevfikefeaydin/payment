import type { Metadata } from "next";
import { listMembers, listPendingInvitations } from "@payrecon/db";
import {
  ORGANIZATION_ROLES,
  canAssignRole,
  canManageMemberWithRole,
  hasPermission,
} from "@payrecon/domain";
import { Alert, Card, Field, Input, PageHeader, Select, Table, Td, Th } from "@/components/ui";
import { ActionForm } from "@/components/action-form";
import { NotPermitted } from "@/components/forbidden";
import { displayDateTime, displayRelative } from "@/lib/format";
import { db } from "@/server/db";
import { getCsrfToken } from "@/server/csrf";
import { requireOrg } from "@/server/session";
import {
  changeMemberRoleAction,
  inviteMemberAction,
  removeMemberAction,
  revokeInvitationAction,
  transferOwnershipAction,
} from "@/server/member-actions";

export const metadata: Metadata = { title: "Members" };

export default async function MembersPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const org = await requireOrg(orgId);

  if (!hasPermission(org.role, "members:read")) {
    return (
      <>
        <PageHeader title="Members" />
        <NotPermitted what="the member list" role={org.role} />
      </>
    );
  }

  const canInvite = hasPermission(org.role, "members:invite");
  const canChangeRole = hasPermission(org.role, "members:change_role");
  const canRemove = hasPermission(org.role, "members:remove");
  const canTransfer = hasPermission(org.role, "org:transfer_ownership");

  const [members, invitations, csrf] = await Promise.all([
    listMembers(db(), org.organizationId),
    listPendingInvitations(db(), org.organizationId),
    getCsrfToken(),
  ]);

  // The roles this actor is allowed to grant. An admin never sees "owner" here,
  // and the server refuses it anyway if the form is tampered with.
  const assignableRoles = ORGANIZATION_ROLES.filter((role) => canAssignRole(org.role, role));
  const ownerCount = members.filter((member) => member.role === "owner").length;

  return (
    <>
      <PageHeader
        title="Members"
        description="Who can see and act on this organization's payment data, and at what level."
      />

      <div className="space-y-6">
        <Card
          title="Members"
          description={`${members.length} member${members.length === 1 ? "" : "s"} · ${ownerCount} owner${ownerCount === 1 ? "" : "s"}.`}
        >
          {ownerCount === 1 && (
            <div className="mb-4">
              <Alert tone="warning" title="This organization has a single owner">
                <p>
                  The last owner cannot be removed or demoted — the organization would be left
                  without anyone who can manage billing or transfer ownership. Promote another
                  member to owner first, or transfer ownership.
                </p>
              </Alert>
            </div>
          )}

          <Table caption="Organization members and their roles">
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Email</Th>
                <Th>Role</Th>
                <Th>Joined</Th>
                <Th>Actions</Th>
              </tr>
            </thead>
            <tbody>
              {members.map((member) => {
                const isSelf = member.userId === org.user.id;
                const manageable = canManageMemberWithRole(org.role, member.role);
                const isLastOwner = member.role === "owner" && ownerCount <= 1;

                return (
                  <tr key={member.userId}>
                    <Td>
                      {member.name}
                      {isSelf && (
                        <span className="ml-1 text-xs text-[var(--color-text-muted)]">(you)</span>
                      )}
                    </Td>
                    <Td>
                      <span className="break-all text-xs">{member.email}</span>
                    </Td>
                    <Td>
                      {canChangeRole && manageable && !isLastOwner ? (
                        <ActionForm
                          action={changeMemberRoleAction}
                          csrf={csrf}
                          organizationId={org.organizationId}
                          fields={{ userId: member.userId }}
                          submitLabel="Save role"
                          pendingLabel="Saving…"
                          size="sm"
                          className="space-y-2"
                        >
                          <label
                            htmlFor={`role-${member.userId}`}
                            className="sr-only"
                          >{`Role for ${member.name}`}</label>
                          <Select
                            id={`role-${member.userId}`}
                            name="role"
                            defaultValue={member.role}
                          >
                            {assignableRoles.map((role) => (
                              <option key={role} value={role}>
                                {role}
                              </option>
                            ))}
                          </Select>
                        </ActionForm>
                      ) : (
                        <>
                          <span className="capitalize">{member.role}</span>
                          {isLastOwner && (
                            <span className="block text-xs text-[var(--color-text-muted)]">
                              last owner
                            </span>
                          )}
                        </>
                      )}
                    </Td>
                    <Td>
                      <span title={displayDateTime(member.joinedAt)}>
                        {displayRelative(member.joinedAt)}
                      </span>
                    </Td>
                    <Td>
                      <div className="space-y-2">
                        {canRemove && manageable ? (
                          <ActionForm
                            action={removeMemberAction}
                            csrf={csrf}
                            organizationId={org.organizationId}
                            fields={{ userId: member.userId }}
                            submitLabel={isSelf ? "Leave organization" : "Remove"}
                            pendingLabel="Removing…"
                            variant="danger"
                            size="sm"
                            className="space-y-2"
                            confirm={
                              isSelf
                                ? `Leave ${org.organizationName}? You will immediately lose access to its exceptions, payment records and settings.`
                                : `Remove ${member.name} (${member.email}) from ${org.organizationName}? They immediately lose access to all of this organization's data. This does not delete their user account.`
                            }
                          />
                        ) : (
                          <span className="text-xs text-[var(--color-text-subtle)]">
                            {canRemove ? "Owners cannot be removed" : "—"}
                          </span>
                        )}

                        {canTransfer && !isSelf && member.role !== "owner" && (
                          <ActionForm
                            action={transferOwnershipAction}
                            csrf={csrf}
                            organizationId={org.organizationId}
                            fields={{ userId: member.userId }}
                            submitLabel="Make owner"
                            pendingLabel="Transferring…"
                            size="sm"
                            className="space-y-2"
                            confirm={`Transfer ownership of ${org.organizationName} to ${member.name}? You will be demoted to admin and will no longer be able to manage billing or transfer ownership yourself.`}
                          />
                        )}
                      </div>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Card>

        <Card
          title="Pending invitations"
          description="Invitation links are stored only as a hash. If a link is lost, revoke the invitation and issue a new one."
        >
          {invitations.length === 0 ? (
            <p className="text-sm text-[var(--color-text-muted)]">
              No invitations are outstanding.
            </p>
          ) : (
            <Table caption="Pending invitations">
              <thead>
                <tr>
                  <Th>Email</Th>
                  <Th>Role</Th>
                  <Th>Invited by</Th>
                  <Th>Expires</Th>
                  <Th>Actions</Th>
                </tr>
              </thead>
              <tbody>
                {invitations.map((invitation) => (
                  <tr key={invitation.id}>
                    <Td>
                      <span className="break-all text-xs">{invitation.email}</span>
                    </Td>
                    <Td>
                      <span className="capitalize">{invitation.role}</span>
                    </Td>
                    <Td>{invitation.invitedByName ?? "—"}</Td>
                    <Td>
                      <span title={displayDateTime(invitation.expiresAt)}>
                        {invitation.expiresAt.getTime() < Date.now()
                          ? "expired"
                          : displayRelative(invitation.expiresAt)}
                      </span>
                    </Td>
                    <Td>
                      {canInvite ? (
                        <ActionForm
                          action={revokeInvitationAction}
                          csrf={csrf}
                          organizationId={org.organizationId}
                          fields={{ invitationId: invitation.id }}
                          submitLabel="Revoke"
                          pendingLabel="Revoking…"
                          variant="danger"
                          size="sm"
                          className="space-y-2"
                          confirm={`Revoke the invitation for ${invitation.email}? The existing link stops working immediately.`}
                        />
                      ) : (
                        <span className="text-xs text-[var(--color-text-subtle)]">—</span>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        {canInvite ? (
          <Card
            title="Invite someone"
            description="The invitation link is displayed once, immediately after it is created. Send it to the person yourself — nothing is emailed from this screen."
          >
            <ActionForm
              action={inviteMemberAction}
              csrf={csrf}
              organizationId={org.organizationId}
              submitLabel="Create invitation"
              pendingLabel="Creating…"
              variant="primary"
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Email address"
                  htmlFor="invite-email"
                  hint="The invitation can only be accepted by an account with this address."
                >
                  <Input
                    id="invite-email"
                    name="email"
                    type="email"
                    required
                    maxLength={254}
                    placeholder="colleague@example.com"
                  />
                </Field>

                <Field
                  label="Role"
                  htmlFor="invite-role"
                  hint="You cannot grant a role more senior than your own."
                >
                  <Select id="invite-role" name="role" defaultValue="analyst">
                    {assignableRoles.map((role) => (
                      <option key={role} value={role}>
                        {role}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            </ActionForm>

            <div className="mt-4 border-t border-[var(--color-border)] pt-4">
              <h3 className="text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
                What each role can do
              </h3>
              <dl className="mt-2 space-y-1 text-sm text-[var(--color-text-muted)]">
                <div>
                  <dt className="inline font-medium text-[var(--color-text)]">Viewer:</dt>{" "}
                  <dd className="inline">reads exceptions, runs, members and the audit log.</dd>
                </div>
                <div>
                  <dt className="inline font-medium text-[var(--color-text)]">Analyst:</dt>{" "}
                  <dd className="inline">
                    also imports records, triggers reconciliation, and assigns and resolves
                    exceptions.
                  </dd>
                </div>
                <div>
                  <dt className="inline font-medium text-[var(--color-text)]">Admin:</dt>{" "}
                  <dd className="inline">
                    also manages connections, API keys, notifications, members and settings.
                  </dd>
                </div>
                <div>
                  <dt className="inline font-medium text-[var(--color-text)]">Owner:</dt>{" "}
                  <dd className="inline">
                    also manages the subscription, can transfer ownership, and can delete the
                    organization.
                  </dd>
                </div>
              </dl>
            </div>
          </Card>
        ) : (
          <Alert tone="info">
            <p>Your role ({org.role}) can see members but not invite or manage them.</p>
          </Alert>
        )}
      </div>
    </>
  );
}
