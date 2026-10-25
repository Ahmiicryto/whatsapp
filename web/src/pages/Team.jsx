import { UsersRound } from "lucide-react";
import { useState } from "react";
import { useApi, post, patch, del } from "../lib/api.js";
import { useSession } from "../lib/session.jsx";
import { dateTime, num } from "../lib/format.js";
import { Card, Table, Badge, Button, PageHeader, Modal, Field, Input, Select, Tabs, Toggle, useAction } from "../components/ui.jsx";

const ROLES = [
  { value: "owner", label: "Owner — everything incl. team & billing" },
  { value: "admin", label: "Admin — settings, templates, campaigns" },
  { value: "agent", label: "Agent — inbox and order actions" },
  { value: "viewer", label: "Viewer — read only" },
];

function MemberModal({ member, stores, onClose, onSaved }) {
  const [m, setM] = useState(member?.id ? { ...member } : { email: "", name: "", password: "", role: "agent", store_ids: null });
  const [run, busy] = useAction();
  const allStores = m.store_ids === null;
  return (
    <Modal
      open
      onClose={onClose}
      title={member?.id ? `Edit ${member.email}` : "Add team member"}
      footer={
        <Button
          loading={busy}
          onClick={async () => {
            const r = await run(() => (member?.id ? patch(`/team/${member.id}`, { role: m.role, store_ids: m.store_ids }) : post("/team", m)), "Saved");
            if (r) onSaved();
          }}
        >
          Save
        </Button>
      }
    >
      <div className="space-y-3">
        {!member?.id && (
          <>
            <Field label="Email">
              <Input value={m.email} onChange={(e) => setM({ ...m, email: e.target.value })} />
            </Field>
            <Field label="Name">
              <Input value={m.name} onChange={(e) => setM({ ...m, name: e.target.value })} />
            </Field>
            <Field label="Temporary password" hint="Only for new users. Ask them to change it after signing in.">
              <Input type="password" value={m.password} onChange={(e) => setM({ ...m, password: e.target.value })} />
            </Field>
          </>
        )}
        <Field label="Role">
          <Select value={m.role} onChange={(e) => setM({ ...m, role: e.target.value })} options={ROLES} />
        </Field>
        <Toggle checked={allStores} onChange={(v) => setM({ ...m, store_ids: v ? null : [] })} label="Access to all stores" />
        {!allStores && (
          <div className="space-y-2 pl-2">
            {stores.map((s) => (
              <Toggle key={s.id} checked={m.store_ids.includes(s.id)} onChange={(v) => setM({ ...m, store_ids: v ? [...m.store_ids, s.id] : m.store_ids.filter((x) => x !== s.id) })} label={s.name} />
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

export default function Team() {
  const { stores, can, me } = useSession();
  const [tab, setTab] = useState("team");
  const team = useApi("/team");
  const audit = useApi(tab === "audit" ? "/audit" : null);
  const usage = useApi(tab === "usage" ? "/usage" : null);
  const [editing, setEditing] = useState(null);
  const [run] = useAction();
  const [pw, setPw] = useState({ current: "", next: "" });

  return (
    <div className="space-y-4">
      <PageHeader icon={UsersRound} title="Team & logs" actions={tab === "team" && can("owner") && <Button onClick={() => setEditing({})}>Add member</Button>} />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: "team", label: "Team" }, { value: "audit", label: "Audit log" }, { value: "usage", label: "Usage" }, { value: "me", label: "My password" }]} />
      {tab === "team" && (
        <Card padded={false}>
          <Table
            rows={team.data || []}
            columns={[
              { key: "name", label: "Member", render: (m) => <div><div className="font-medium">{m.name}</div><div className="text-xs text-gray-500">{m.email}</div></div> },
              { key: "role", label: "Role", render: (m) => <Badge tone={m.role === "owner" ? "purple" : "blue"}>{m.role}</Badge> },
              { key: "stores", label: "Stores", render: (m) => (m.store_ids ? m.store_ids.map((id) => stores.find((s) => s.id === Number(id))?.name).filter(Boolean).join(", ") || "none" : "All stores") },
              { key: "last", label: "Last sign-in", render: (m) => dateTime(m.last_login_at) },
              {
                key: "actions",
                label: "",
                render: (m) =>
                  can("owner") &&
                  m.id !== me.user.id && (
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setEditing(m)}>
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => confirm(`Remove ${m.email}?`) && run(() => del(`/team/${m.id}`), "Removed").then(team.reload)}>
                        Remove
                      </Button>
                    </div>
                  ),
              },
            ]}
          />
        </Card>
      )}
      {tab === "audit" && (
        <Card padded={false}>
          <Table
            rows={audit.data || []}
            columns={[
              { key: "created_at", label: "When", render: (a) => dateTime(a.created_at) },
              { key: "actor", label: "Who", render: (a) => <span>{a.actor_email || "system"}{a.impersonator_email && <span className="text-xs text-purple-600"> (via {a.impersonator_email})</span>}</span> },
              { key: "action", label: "Action" },
              { key: "target", label: "Target" },
              { key: "store_name", label: "Store" },
            ]}
          />
        </Card>
      )}
      {tab === "usage" && (
        <Card padded={false}>
          <Table
            rows={usage.data || []}
            columns={[
              { key: "month", label: "Month" },
              { key: "messages", label: "Messages", render: (u) => num(u.messages) },
              { key: "marketing_messages", label: "Marketing", render: (u) => num(u.marketing_messages) },
              { key: "ai_tokens", label: "AI tokens", render: (u) => num(u.ai_tokens) },
              { key: "address_checks", label: "Address checks", render: (u) => num(u.address_checks) },
            ]}
          />
        </Card>
      )}
      {tab === "me" && (
        <Card title="Change password" className="max-w-md">
          <div className="space-y-3">
            <Field label="Current password">
              <Input type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
            </Field>
            <Field label="New password (8+ characters)">
              <Input type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
            </Field>
            <Button onClick={() => run(() => post("/auth/change-password", pw), "Password changed").then(() => setPw({ current: "", next: "" }))}>Change password</Button>
          </div>
        </Card>
      )}
      {editing && (
        <MemberModal
          member={editing.id ? editing : null}
          stores={stores}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            team.reload();
          }}
        />
      )}
    </div>
  );
}
