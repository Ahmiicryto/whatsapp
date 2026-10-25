import { Puzzle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useApi, qs, post, put, del, fileToBase64 } from "../lib/api.js";
import { useSingleStore } from "../lib/session.jsx";
import { Card, Table, Badge, Button, PageHeader, Modal, Field, Input, Select, Textarea, Empty, ErrorBox, useAction } from "../components/ui.jsx";

const STATUS_TONE = { APPROVED: "green", PENDING: "amber", REJECTED: "red", PAUSED: "orange", DISABLED: "red", draft: "gray" };
const ACTIONS = ["CONFIRM", "CANCEL", "ADDRESS", "ADDR_OK", "OPTIN_YES", "STOP", "BUTTON"];

function Preview({ tpl, variables }) {
  const sample = Object.fromEntries((variables || []).map((v) => [v.key, v.sample]));
  const body = (tpl.body || "").replace(/\{\{(\d+)\}\}/g, (_, n) => {
    const v = tpl.variables[Number(n) - 1];
    const key = typeof v === "string" ? v : v?.source;
    return (typeof v === "object" && v?.value) || sample[key] || `{{${n}}}`;
  });
  const fmt = (s) => s.replace(/\*(.+?)\*/g, "<b>$1</b>").replace(/_(.+?)_/g, "<i>$1</i>");
  return (
    <div className="wa-chat-bg rounded-xl p-4">
      <div className="max-w-xs rounded-lg bg-white p-2 text-sm shadow dark:bg-gray-800">
        {tpl.header?.format === "IMAGE" && <div className="mb-2 flex h-32 items-center justify-center rounded bg-gray-200 text-xs text-gray-500 dark:bg-gray-700">🖼 {tpl.header.url ? "image" : tpl.header.source}</div>}
        {tpl.header?.format === "DOCUMENT" && <div className="mb-2 rounded bg-gray-100 p-2 text-xs dark:bg-gray-700">📄 report.pdf</div>}
        {tpl.header?.format === "TEXT" && <div className="mb-1 font-semibold">{tpl.header.text}</div>}
        <div className="whitespace-pre-wrap" dangerouslySetInnerHTML={{ __html: fmt(body.replace(/</g, "&lt;")) }} />
        {tpl.footer && <div className="mt-1 text-xs text-gray-500">{tpl.footer}</div>}
        {tpl.buttons?.length > 0 && (
          <div className="mt-2 divide-y divide-gray-100 border-t border-gray-100 dark:divide-gray-700 dark:border-gray-700">
            {tpl.buttons.map((b, i) => (
              <div key={i} className="py-1.5 text-center text-sm text-sky-600">
                {b.type === "URL" ? "↗ " : b.type === "PHONE_NUMBER" ? "📞 " : "↩ "}
                {b.text}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Builder({ storeId, initial, meta, onClose, onSaved }) {
  const [t, setT] = useState(
    initial || { kind: "custom", name: "", language: "en", category: "MARKETING", header: { format: "NONE" }, body: "", footer: "", buttons: [], variables: [] }
  );
  const [problems, setProblems] = useState([]);
  const [brief, setBrief] = useState("");
  const [ideas, setIdeas] = useState([]);
  const [run, busy] = useAction();
  const vars = meta?.variables || [];
  const textVars = vars.filter((v) => !v.media);
  const mediaVars = vars.filter((v) => v.media);

  // keep variable mapping length in sync with {{n}} placeholders
  const count = useMemo(() => {
    const nums = [...(t.body || "").matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
    return nums.length ? Math.max(...nums) : 0;
  }, [t.body]);
  useEffect(() => {
    if (t.variables.length !== count) {
      setT((x) => ({ ...x, variables: Array.from({ length: count }, (_, i) => x.variables[i] || "customer.first_name") }));
    }
  }, [count]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!t.name && !t.body) return setProblems([]);
    const h = setTimeout(() => post("/templates/validate", { ...t, footer: t.footer || null }).then((r) => setProblems(r.problems)).catch((e) => setProblems(e.details || [e.message])), 300);
    return () => clearTimeout(h);
  }, [t]);

  const insertVar = () => setT({ ...t, body: `${t.body}{{${count + 1}}}` });
  const setBtn = (i, patch) => setT({ ...t, buttons: t.buttons.map((b, j) => (j === i ? { ...b, ...patch } : b)) });

  async function write() {
    const r = await run(() => post("/ai/copy", { storeId, brief, kind: "template" }));
    if (r) setIdeas(r.variants);
  }

  async function uploadHeader(file) {
    const r = await run(async () => post("/media", { storeId, filename: file.name, mime: file.type, data: await fileToBase64(file) }), "Uploaded");
    if (r) setT({ ...t, header: { ...t.header, url: r.url, source: null } });
  }

  async function save(submit) {
    const body = { ...t, storeId, footer: t.footer || null, header: t.header?.format === "NONE" ? null : t.header };
    const saved = await run(() => (initial?.id ? put(`/templates/${initial.id}`, body) : post("/templates", body)));
    if (!saved) return;
    if (submit) {
      const s = await run(() => post(`/templates/${saved.id}/submit`), "Submitted to Meta for approval");
      if (!s) return;
    }
    onSaved();
  }

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={initial?.id ? `Edit ${initial.name}` : "New template"}
      footer={
        <>
          <Button variant="secondary" loading={busy} onClick={() => save(false)}>
            Save draft
          </Button>
          <Button loading={busy} onClick={() => save(true)} disabled={problems.length > 0}>
            Save & submit to Meta
          </Button>
        </>
      }
    >
      <div className="grid gap-5 md:grid-cols-[1fr_280px]">
        <div className="space-y-3">
          <div className="flex gap-2">
            <Input value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="✨ Describe the message, AI drafts a Meta-friendly template" />
            <Button variant="secondary" onClick={write} disabled={!brief}>
              Draft
            </Button>
          </div>
          {ideas.map((v, i) => (
            <button
              key={i}
              type="button"
              className="block w-full rounded-lg border border-gray-200 p-2 text-left text-xs hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
              onClick={() => setT({ ...t, name: v.name, category: v.category, body: v.body, variables: v.variables, buttons: v.buttons.map((b) => (b.type === "URL" ? { ...b, url: meta.linkBase, source: "link.code" } : { ...b, action: "BUTTON" })) })}
            >
              <b>{v.name}</b> · {v.category}
              <div className="mt-1 whitespace-pre-wrap text-gray-600 dark:text-gray-300">{v.body}</div>
            </button>
          ))}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" hint="lowercase_with_underscores">
              <Input value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} disabled={!!initial?.id} />
            </Field>
            <Field label="Used for">
              <Select value={t.kind} onChange={(e) => setT({ ...t, kind: e.target.value })} options={(meta?.kinds || []).map((k) => ({ value: k, label: k.replace(/_/g, " ") }))} />
            </Field>
            <Field label="Category">
              <Select value={t.category} onChange={(e) => setT({ ...t, category: e.target.value })} options={["UTILITY", "MARKETING"]} />
            </Field>
            <Field label="Language code">
              <Input value={t.language} onChange={(e) => setT({ ...t, language: e.target.value })} disabled={!!initial?.id} placeholder="en, ur, ar, en_US" />
            </Field>
          </div>
          <Field label="Header">
            <div className="flex flex-wrap gap-2">
              <Select value={t.header?.format || "NONE"} onChange={(e) => setT({ ...t, header: { format: e.target.value } })} className="w-36" options={["NONE", "TEXT", "IMAGE", "DOCUMENT"]} />
              {t.header?.format === "TEXT" && <Input value={t.header.text || ""} onChange={(e) => setT({ ...t, header: { ...t.header, text: e.target.value } })} placeholder="Header text" className="flex-1" />}
              {["IMAGE", "DOCUMENT"].includes(t.header?.format) && (
                <>
                  <Select value={t.header.source || ""} onChange={(e) => setT({ ...t, header: { ...t.header, source: e.target.value || null, url: null } })} className="flex-1">
                    <option value="">Fixed file (upload)</option>
                    {mediaVars.map((v) => (
                      <option key={v.key} value={v.key}>
                        {v.label}
                      </option>
                    ))}
                  </Select>
                  {!t.header.source && (
                    <label className="cursor-pointer self-center text-sm text-brand-700">
                      {t.header.url ? "Replace file" : "Upload"}
                      <input type="file" className="hidden" accept="image/jpeg,image/png,application/pdf" onChange={(e) => e.target.files[0] && uploadHeader(e.target.files[0])} />
                    </label>
                  )}
                </>
              )}
            </div>
          </Field>
          <Field label="Body" hint="Use *bold*, _italic_. Variables can't be at the very start or end.">
            <Textarea value={t.body} onChange={(e) => setT({ ...t, body: e.target.value })} className="min-h-[140px]" />
            <Button size="sm" variant="ghost" className="mt-1" onClick={insertVar}>
              + Insert variable {`{{${count + 1}}}`}
            </Button>
          </Field>
          {t.variables.length > 0 && (
            <div className="space-y-2 rounded-lg bg-gray-50 p-3 dark:bg-gray-800/50">
              <div className="text-xs font-medium text-gray-600">Fill variables with</div>
              {t.variables.map((v, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="w-10 text-xs text-gray-500">{`{{${i + 1}}}`}</span>
                  <Select
                    value={typeof v === "string" ? v : "__static"}
                    onChange={(e) => setT({ ...t, variables: t.variables.map((x, j) => (j === i ? (e.target.value === "__static" ? { value: "" } : e.target.value) : x)) })}
                  >
                    {textVars.map((tv) => (
                      <option key={tv.key} value={tv.key}>
                        {tv.label}
                      </option>
                    ))}
                    <option value="__static">Fixed text…</option>
                  </Select>
                  {typeof v === "object" && <Input value={v.value || ""} onChange={(e) => setT({ ...t, variables: t.variables.map((x, j) => (j === i ? { value: e.target.value } : x)) })} />}
                </div>
              ))}
            </div>
          )}
          <Field label="Footer (optional)">
            <Input value={t.footer || ""} onChange={(e) => setT({ ...t, footer: e.target.value })} maxLength={60} />
          </Field>
          <div>
            <div className="mb-1 text-xs font-medium text-gray-600">Buttons</div>
            {t.buttons.map((b, i) => (
              <div key={i} className="mb-2 flex flex-wrap items-center gap-2">
                <Select value={b.type} onChange={(e) => setBtn(i, { type: e.target.value })} className="w-36" options={["QUICK_REPLY", "URL", "PHONE_NUMBER"]} />
                <Input value={b.text} onChange={(e) => setBtn(i, { text: e.target.value })} placeholder="Button text" className="w-40" maxLength={25} />
                {b.type === "QUICK_REPLY" && <Select value={b.action || "BUTTON"} onChange={(e) => setBtn(i, { action: e.target.value })} className="w-36" options={ACTIONS} />}
                {b.type === "URL" && (
                  <>
                    <Input value={b.url || ""} onChange={(e) => setBtn(i, { url: e.target.value })} placeholder={meta?.linkBase} className="flex-1" />
                    <Button size="sm" variant="ghost" onClick={() => setBtn(i, { url: meta.linkBase, source: "link.code" })}>
                      Tracked link
                    </Button>
                  </>
                )}
                {b.type === "PHONE_NUMBER" && <Input value={b.phone || ""} onChange={(e) => setBtn(i, { phone: e.target.value })} placeholder="+92300…" />}
                <Button size="sm" variant="ghost" onClick={() => setT({ ...t, buttons: t.buttons.filter((_, j) => j !== i) })}>
                  ✕
                </Button>
              </div>
            ))}
            <Button size="sm" variant="secondary" onClick={() => setT({ ...t, buttons: [...t.buttons, { type: "QUICK_REPLY", text: "", action: "BUTTON" }] })} disabled={t.buttons.length >= 10}>
              + Add button
            </Button>
          </div>
        </div>
        <div className="space-y-3">
          <div className="text-xs font-medium text-gray-600">Preview</div>
          <Preview tpl={t} variables={vars} />
          {problems.length > 0 && <ErrorBox error={{ message: "Fix before submitting", details: problems }} />}
        </div>
      </div>
    </Modal>
  );
}

export default function Templates() {
  const { store } = useSingleStore();
  const list = useApi(store ? `/templates${qs({ storeId: store.id })}` : null, { interval: 30000 });
  const meta = useApi("/templates/variables");
  const [editing, setEditing] = useState(null);
  const [run, busy] = useAction();
  if (!store) return <Empty title="Connect a store first" />;

  return (
    <div className="space-y-4">
      <PageHeader
        icon={Puzzle}
        title="WhatsApp templates"
        subtitle={`Business-initiated messages need templates approved by Meta. Showing ${store.name}.`}
        actions={
          <>
            <Button variant="secondary" loading={busy} onClick={() => run(() => post("/templates/sync", { storeId: store.id }), "Synced with Meta").then(list.reload)}>
              Sync status
            </Button>
            <Button variant="secondary" loading={busy} onClick={() => run(() => post("/templates/install-defaults", { storeId: store.id }), "Default templates submitted").then(list.reload)}>
              Install defaults
            </Button>
            <Button onClick={() => setEditing({})}>New template</Button>
          </>
        }
      />
      <Card padded={false}>
        <Table
          rows={list.data || []}
          empty="No templates yet. Click “Install defaults” to submit the ready-made set."
          columns={[
            { key: "name", label: "Template", render: (t) => <div><div className="font-medium">{t.name}</div><div className="max-w-md truncate text-xs text-gray-500">{t.body}</div></div> },
            { key: "kind", label: "Used for", render: (t) => <span className="text-xs">{t.kind.replace(/_/g, " ")}</span> },
            { key: "category", label: "Category", render: (t) => <Badge tone={t.category === "MARKETING" ? "purple" : "blue"}>{t.category.toLowerCase()}</Badge> },
            { key: "language", label: "Lang" },
            { key: "status", label: "Status", render: (t) => <div><Badge tone={STATUS_TONE[t.status]}>{t.status}</Badge>{t.rejection_reason && <div className="mt-1 text-xs text-red-600">{t.rejection_reason}</div>}</div> },
            {
              key: "actions",
              label: "",
              render: (t) => (
                <div className="flex justify-end gap-1">
                  {["draft", "REJECTED"].includes(t.status) && (
                    <Button size="sm" variant="secondary" onClick={() => run(() => post(`/templates/${t.id}/submit`), "Submitted").then(list.reload)}>
                      Submit
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => setEditing(t)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => confirm(`Delete ${t.name}? It will also be deleted from Meta.`) && run(() => del(`/templates/${t.id}?remote=1`), "Deleted").then(list.reload)}>
                    Delete
                  </Button>
                </div>
              ),
            },
          ]}
        />
      </Card>
      {editing && meta.data && (
        <Builder
          storeId={store.id}
          initial={editing.id ? editing : null}
          meta={meta.data}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            list.reload();
          }}
        />
      )}
    </div>
  );
}
