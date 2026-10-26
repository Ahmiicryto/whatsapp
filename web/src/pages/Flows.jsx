import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ArrowDown, GitBranch, Plus, Trash2, Zap } from "lucide-react";
import { useApi, post, put, del, qs } from "../lib/api.js";
import { useSession } from "../lib/session.jsx";
import { ago } from "../lib/format.js";
import { Badge, Button, Card, Empty, Field, Input, Modal, PageHeader, Select, Textarea, Toggle, useAction } from "../components/ui.jsx";

const OPS = [
  { value: "gte", label: "is at least" },
  { value: "gt", label: "is more than" },
  { value: "lte", label: "is at most" },
  { value: "lt", label: "is less than" },
  { value: "eq", label: "is" },
  { value: "neq", label: "is not" },
  { value: "contains", label: "contains any of" },
  { value: "not_contains", label: "contains none of" },
  { value: "in", label: "is one of" },
];

const EXAMPLES = [
  { name: "VIP orders", trigger: "order.confirmed", conditions: [{ field: "total", op: "gte", value: 10000 }], steps: [{ type: "add_tag", tag: "VIP" }, { type: "notify", title: "VIP order {{order}} ({{total}})" }] },
  { name: "Book small, safe orders right away", trigger: "order.confirmed", conditions: [{ field: "risk_score", op: "lt", value: 30 }], steps: [{ type: "book_courier" }] },
  { name: "Risky big COD: ask for advance", trigger: "order.created", conditions: [{ field: "is_cod", op: "eq", value: true }, { field: "total", op: "gte", value: 8000 }], steps: [{ type: "wait", hours: 1 }, { type: "request_advance" }] },
  { name: "Follow up on no reply", trigger: "order.no_response", conditions: [], steps: [{ type: "needs_attention" }, { type: "notify", title: "Call {{name}} about {{order}}" }] },
];

function StepEditor({ step, meta, onChange, team, templates, couriers }) {
  const set = (k, v) => onChange({ ...step, [k]: v });
  switch (step.type) {
    case "send_text":
      return <Textarea value={step.text || ""} onChange={(e) => set("text", e.target.value)} placeholder="Hi {{name}}, … ({{order}}, {{total}}, {{store}}, {{city}})" className="min-h-[60px]" />;
    case "send_template":
      return (
        <Select value={step.templateId || ""} onChange={(e) => set("templateId", Number(e.target.value))}>
          <option value="">Choose a template…</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({t.status})
            </option>
          ))}
        </Select>
      );
    case "add_tag":
    case "remove_tag":
      return <Input value={step.tag || ""} onChange={(e) => set("tag", e.target.value)} placeholder="Tag" />;
    case "notify":
      return <Input value={step.title || ""} onChange={(e) => set("title", e.target.value)} placeholder="Notification text, e.g. Check {{order}}" />;
    case "assign":
      return (
        <Select value={step.userId || ""} onChange={(e) => set("userId", Number(e.target.value))}>
          <option value="">Choose a teammate…</option>
          {team.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name || u.email}
            </option>
          ))}
        </Select>
      );
    case "book_courier":
      return (
        <Select value={step.courierId || ""} onChange={(e) => set("courierId", e.target.value ? Number(e.target.value) : null)}>
          <option value="">Default courier</option>
          {couriers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      );
    case "request_advance":
      return <Input type="number" value={step.amount || ""} onChange={(e) => set("amount", e.target.value ? Number(e.target.value) : null)} placeholder="Amount (empty = from settings)" />;
    case "wait":
      return <Input type="number" min="1" value={step.hours || 1} onChange={(e) => set("hours", Number(e.target.value))} placeholder="Hours" />;
    default:
      return <span className="text-xs text-gray-500">{meta.steps[step.type]}</span>;
  }
}

function RuleEditor({ rule, meta, stores, onClose, onSaved }) {
  const [r, setR] = useState(() => rule || { storeId: stores[0]?.id, name: "", trigger: "order.confirmed", conditions: [], steps: [{ type: "notify", title: "" }], active: true });
  const storeId = r.storeId || r.store_id;
  const team = useApi("/team/directory");
  const templates = useApi(storeId ? `/templates${qs({ storeId })}` : null);
  const couriers = useApi(storeId ? `/stores/${storeId}/couriers` : null);
  const [run, busy] = useAction();
  const upd = (k, v) => setR({ ...r, [k]: v });
  const save = () => {
    const body = { storeId: Number(storeId), name: r.name, trigger: r.trigger, conditions: r.conditions, steps: r.steps, active: r.active };
    return run(() => (r.id ? put(`/flows/${r.id}`, body) : post("/flows", body)), "Rule saved").then((x) => x && (onSaved(), onClose()));
  };
  return (
    <Modal open wide onClose={onClose} title={r.id ? "Edit rule" : "New automation rule"} footer={<Button loading={busy} onClick={save} disabled={!r.name}>Save rule</Button>}>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">
            <Input value={r.name} onChange={(e) => upd("name", e.target.value)} placeholder="e.g. VIP orders" />
          </Field>
          {!r.id && stores.length > 1 && (
            <Field label="Store">
              <Select value={storeId} onChange={(e) => upd("storeId", Number(e.target.value))} options={stores.map((s) => ({ value: s.id, label: s.name }))} />
            </Field>
          )}
        </div>
        <div className="rounded-2xl bg-brand-50 p-4 dark:bg-brand-900/20">
          <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-brand-800 dark:text-brand-300">
            <Zap className="h-4 w-4" /> When
          </div>
          <Select value={r.trigger} onChange={(e) => upd("trigger", e.target.value)} options={Object.entries(meta.triggers).map(([value, label]) => ({ value, label }))} />
        </div>
        <div className="rounded-2xl bg-gray-50 p-4 dark:bg-gray-800/40">
          <div className="mb-2 text-xs font-bold uppercase tracking-wider text-gray-500">And all of these are true</div>
          {r.conditions.length === 0 && <p className="mb-2 text-xs text-gray-500">No conditions: runs for every order.</p>}
          {r.conditions.map((c, i) => (
            <div key={i} className="mb-2 grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
              <Select value={c.field} onChange={(e) => upd("conditions", r.conditions.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)))} options={Object.entries(meta.fields).map(([value, f]) => ({ value, label: f.label }))} />
              {meta.fields[c.field]?.type === "boolean" ? (
                <>
                  <span className="self-center text-sm text-gray-500">is</span>
                  <Select value={String(c.value)} onChange={(e) => upd("conditions", r.conditions.map((x, j) => (j === i ? { ...x, op: "eq", value: e.target.value === "true" } : x)))} options={[{ value: "true", label: "Yes" }, { value: "false", label: "No" }]} />
                </>
              ) : (
                <>
                  <Select value={c.op} onChange={(e) => upd("conditions", r.conditions.map((x, j) => (j === i ? { ...x, op: e.target.value } : x)))} options={OPS} />
                  <Input value={c.value ?? ""} onChange={(e) => upd("conditions", r.conditions.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} placeholder={meta.fields[c.field]?.type === "number" ? "5000" : "Lahore, Karachi"} />
                </>
              )}
              <Button variant="ghost" size="sm" aria-label="Remove condition" onClick={() => upd("conditions", r.conditions.filter((_, j) => j !== i))}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
          <Button size="sm" variant="secondary" onClick={() => upd("conditions", [...r.conditions, { field: "total", op: "gte", value: "" }])}>
            <Plus className="h-3.5 w-3.5" /> Add condition
          </Button>
        </div>
        <div className="space-y-2">
          <div className="text-xs font-bold uppercase tracking-wider text-gray-500">Then do</div>
          {r.steps.map((st, i) => (
            <div key={i}>
              {i > 0 && <ArrowDown className="mx-auto my-1 h-4 w-4 text-gray-300" />}
              <div className="grid gap-2 rounded-2xl p-3 ring-1 ring-gray-200 sm:grid-cols-[14rem_1fr_auto] dark:ring-gray-700">
                <Select value={st.type} onChange={(e) => upd("steps", r.steps.map((x, j) => (j === i ? { type: e.target.value } : x)))} options={Object.entries(meta.steps).map(([value, label]) => ({ value, label }))} />
                <StepEditor step={st} meta={meta} team={team.data || []} templates={templates.data?.rows || templates.data || []} couriers={couriers.data || []} onChange={(v) => upd("steps", r.steps.map((x, j) => (j === i ? v : x)))} />
                <Button variant="ghost" size="sm" aria-label="Remove step" disabled={r.steps.length === 1} onClick={() => upd("steps", r.steps.filter((_, j) => j !== i))}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
          <Button size="sm" variant="secondary" onClick={() => upd("steps", [...r.steps, { type: "add_tag", tag: "" }])}>
            <Plus className="h-3.5 w-3.5" /> Add step
          </Button>
        </div>
        <Toggle checked={r.active} onChange={(v) => upd("active", v)} label="Rule is on" />
      </div>
    </Modal>
  );
}

export default function Flows() {
  const { storeId, stores, can } = useSession();
  const [params, setParams] = useSearchParams();
  const meta = useApi("/flows/meta");
  const { data, reload } = useApi(`/flows${qs({ storeId })}`);
  const [editing, setEditing] = useState(null);
  const [run] = useAction();
  useEffect(() => {
    if (params.get("new")) {
      setEditing({});
      setParams({}, { replace: true });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const scoped = storeId !== "all" ? stores.filter((s) => String(s.id) === String(storeId)) : stores;
  return (
    <div className="space-y-5">
      <PageHeader icon={GitBranch} title="Automation rules" subtitle="IF something happens AND conditions match, THEN run your steps" actions={can("admin") && <Button onClick={() => setEditing({})}><Plus className="h-4 w-4" /> New rule</Button>} />
      {data?.length === 0 && (
        <Card title="Start from an example">
          <div className="grid gap-3 md:grid-cols-2">
            {EXAMPLES.map((ex) => (
              <button key={ex.name} onClick={() => setEditing({ ...ex, storeId: scoped[0]?.id, active: true, isExample: true })} className="rounded-2xl p-4 text-left ring-1 ring-gray-200 transition hover:bg-brand-50 hover:ring-brand-300 dark:ring-gray-700 dark:hover:bg-brand-900/20">
                <div className="font-semibold">{ex.name}</div>
                <div className="mt-1 text-xs text-gray-500">
                  When: {meta.data?.triggers[ex.trigger]} → {ex.steps.map((s) => meta.data?.steps[s.type]).join(" → ")}
                </div>
              </button>
            ))}
          </div>
        </Card>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {data?.map((r) => (
          <Card key={r.id}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="font-semibold">{r.name}</div>
                <div className="text-xs text-gray-500">
                  {r.store_name} · ran {r.runs}× {r.last_run_at ? `· last ${ago(r.last_run_at)}` : ""}
                </div>
              </div>
              <Badge tone={r.active ? "green" : "gray"} dot>
                {r.active ? "On" : "Off"}
              </Badge>
            </div>
            <div className="mt-3 space-y-1 text-sm">
              <div>
                <span className="font-semibold text-brand-700 dark:text-brand-400">When</span> {meta.data?.triggers[r.trigger]}
              </div>
              {r.conditions.length > 0 && (
                <div>
                  <span className="font-semibold">If</span> {r.conditions.map((c) => `${meta.data?.fields[c.field]?.label.toLowerCase()} ${OPS.find((o) => o.value === c.op)?.label} ${c.value}`).join(" and ")}
                </div>
              )}
              <div>
                <span className="font-semibold">Then</span> {r.steps.map((s) => (s.type === "wait" ? `wait ${s.hours}h` : meta.data?.steps[s.type]?.toLowerCase())).join(" → ")}
              </div>
            </div>
            {can("admin") && (
              <div className="mt-3 flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => setEditing({ ...r, storeId: r.store_id })}>
                  Edit
                </Button>
                <Button size="sm" variant="ghost" onClick={() => run(() => put(`/flows/${r.id}`, { active: !r.active })).then(reload)}>
                  {r.active ? "Turn off" : "Turn on"}
                </Button>
                <Button size="sm" variant="ghost" aria-label="Delete" onClick={() => confirm(`Delete "${r.name}"?`) && run(() => del(`/flows/${r.id}`), "Deleted").then(reload)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
          </Card>
        ))}
      </div>
      {editing && meta.data && <RuleEditor rule={editing.id || editing.isExample ? editing : null} meta={meta.data} stores={scoped} onClose={() => setEditing(null)} onSaved={reload} />}
    </div>
  );
}
