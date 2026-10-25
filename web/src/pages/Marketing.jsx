import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useApi, qs, post, put, del, fileToBase64 } from "../lib/api.js";
import { useSingleStore } from "../lib/session.jsx";
import { money, dateTime, num } from "../lib/format.js";
import { Card, Table, Badge, Button, PageHeader, Modal, Field, Input, Select, Textarea, Tabs, Empty, useAction, useToast } from "../components/ui.jsx";

const FIELD_LABELS = {
  total_spent: "Total spent",
  orders_count: "Number of orders",
  days_since_last_order: "Days since last order",
  days_since_first_order: "Days since first order",
  city: "City",
  country: "Country code",
  rfm_segment: "RFM segment",
  tag: "Customer tag",
  wa_opt_in: "Opted in",
  bought_product: "Bought product (title contains)",
};
const OPS = {
  number: [["gte", "≥"], ["gt", ">"], ["lte", "≤"], ["lt", "<"], ["eq", "="]],
  text: [["in", "is one of"], ["not_in", "is not"]],
  tag: [["contains", "has"], ["not_contains", "doesn't have"]],
  bool: [["eq", "is"]],
  product: [["contains", "bought"], ["not_contains", "never bought"]],
};

function SegmentEditor({ storeId, segment, onSaved, onClose }) {
  const fields = useApi("/segments/fields");
  const [name, setName] = useState(segment?.name || "");
  const [rules, setRules] = useState(segment?.rules || { match: "all", conditions: [] });
  const [preview, setPreview] = useState(null);
  const [run, busy] = useAction();
  const typeOf = (f) => fields.data?.find((x) => x.field === f)?.type || "number";

  useEffect(() => {
    const t = setTimeout(() => post("/segments/preview", { storeId, rules }).then(setPreview).catch(() => setPreview(null)), 400);
    return () => clearTimeout(t);
  }, [rules, storeId]);

  const setCond = (i, patch) => setRules({ ...rules, conditions: rules.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)) });

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={segment ? "Edit segment" : "New segment"}
      footer={
        <Button
          loading={busy}
          disabled={!name}
          onClick={async () => {
            const r = await run(() => (segment ? put(`/segments/${segment.id}`, { name, rules }) : post("/segments", { storeId, name, rules })), "Segment saved");
            if (r) onSaved();
          }}
        >
          Save segment
        </Button>
      }
    >
      <div className="space-y-3">
        <Field label="Segment name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Karachi VIPs" />
        </Field>
        <div className="flex items-center gap-2 text-sm">
          Customers matching
          <Select value={rules.match} onChange={(e) => setRules({ ...rules, match: e.target.value })} className="w-24" options={[{ value: "all", label: "all" }, { value: "any", label: "any" }]} />
          of these rules
        </div>
        {rules.conditions.map((c, i) => {
          const type = typeOf(c.field);
          return (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <Select value={c.field} onChange={(e) => setCond(i, { field: e.target.value, op: OPS[typeOf(e.target.value)][0][0], value: "" })} className="w-56">
                {(fields.data || []).map((f) => (
                  <option key={f.field} value={f.field}>
                    {FIELD_LABELS[f.field] || f.field}
                  </option>
                ))}
              </Select>
              <Select value={c.op} onChange={(e) => setCond(i, { op: e.target.value })} className="w-36">
                {OPS[type].map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </Select>
              {type === "bool" ? (
                <Select value={String(c.value)} onChange={(e) => setCond(i, { value: e.target.value === "true" })} className="w-28" options={[{ value: "true", label: "yes" }, { value: "false", label: "no" }]} />
              ) : (
                <Input value={c.value} onChange={(e) => setCond(i, { value: e.target.value })} className="w-48" placeholder={type === "text" ? "comma separated" : ""} />
              )}
              <Button variant="ghost" size="sm" onClick={() => setRules({ ...rules, conditions: rules.conditions.filter((_, j) => j !== i) })}>
                Remove
              </Button>
            </div>
          );
        })}
        <Button variant="secondary" size="sm" onClick={() => setRules({ ...rules, conditions: [...rules.conditions, { field: "total_spent", op: "gte", value: "" }] })}>
          + Add rule
        </Button>
        {preview && (
          <div className="rounded-lg bg-gray-50 p-3 text-sm dark:bg-gray-800/60">
            <b>{num(preview.matched)}</b> customers match · <b>{num(preview.reachable)}</b> can receive marketing on WhatsApp (opted in, valid number)
          </div>
        )}
      </div>
    </Modal>
  );
}

function CampaignEditor({ storeId, campaign, templates, segments, onSaved, onClose }) {
  const [c, setC] = useState(
    campaign || { name: "", template_id: null, template_b_id: null, ab_split: 50, segment_id: null, variables: { "campaign.text": "" }, header_media_url: "", link_url: "", discount: null }
  );
  const [brief, setBrief] = useState("");
  const [variants, setVariants] = useState([]);
  const [run, busy] = useAction();
  const toast = useToast();
  const marketing = templates.filter((t) => t.status === "APPROVED" && t.category === "MARKETING");
  const tpl = templates.find((t) => t.id === Number(c.template_id));
  const usesText = tpl?.variables?.some((v) => (typeof v === "string" ? v : v.source) === "campaign.text");
  const usesImage = tpl?.header?.source === "campaign.image";

  async function write() {
    const r = await run(() => post("/ai/copy", { storeId, brief, kind: "campaign" }));
    if (r) setVariants(r.variants);
  }

  async function upload(file) {
    const r = await run(async () => post("/media", { storeId, filename: file.name, mime: file.type, data: await fileToBase64(file) }), "Image uploaded");
    if (r) setC({ ...c, header_media_url: r.url });
  }

  async function save() {
    const body = { ...c, storeId, template_id: Number(c.template_id) || null, template_b_id: Number(c.template_b_id) || null, segment_id: Number(c.segment_id) || null, ab_split: Number(c.ab_split) };
    const r = await run(() => (campaign ? put(`/campaigns/${campaign.id}`, body) : post("/campaigns", body)), "Campaign saved");
    if (r) onSaved(r);
  }

  return (
    <Modal open wide onClose={onClose} title={campaign ? "Edit campaign" : "New campaign"} footer={<Button loading={busy} onClick={save} disabled={!c.name || !c.template_id}>Save draft</Button>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Campaign name">
          <Input value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} />
        </Field>
        <Field label="Audience (segment)" hint="Leave empty to send to every opted-in customer">
          <Select value={c.segment_id || ""} onChange={(e) => setC({ ...c, segment_id: e.target.value })}>
            <option value="">All opted-in customers</option>
            {segments.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Template (approved marketing)" hint={!marketing.length ? "No approved marketing templates yet. Create one under Templates." : ""}>
          <Select value={c.template_id || ""} onChange={(e) => setC({ ...c, template_id: e.target.value })}>
            <option value="">Choose…</option>
            {marketing.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="A/B test: template B (optional)">
          <div className="flex gap-2">
            <Select value={c.template_b_id || ""} onChange={(e) => setC({ ...c, template_b_id: e.target.value })}>
              <option value="">No A/B test</option>
              {marketing.filter((t) => t.id !== Number(c.template_id)).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
            {c.template_b_id && <Input type="number" min={1} max={99} value={c.ab_split} onChange={(e) => setC({ ...c, ab_split: e.target.value })} className="w-20" title="% getting A" />}
          </div>
        </Field>
        {usesText && (
          <Field label="Message text ({{campaign.text}})" className="sm:col-span-2">
            <Textarea value={c.variables?.["campaign.text"] || ""} onChange={(e) => setC({ ...c, variables: { ...c.variables, "campaign.text": e.target.value } })} />
            <div className="mt-2 flex gap-2">
              <Input value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="✨ Describe the offer and AI writes it (any language)" />
              <Button variant="secondary" onClick={write} disabled={!brief}>
                Write
              </Button>
            </div>
            {variants.map((v, i) => (
              <button
                key={i}
                type="button"
                onClick={() => {
                  setC({ ...c, variables: { ...c.variables, "campaign.text": v.text } });
                  toast("Text applied");
                }}
                className="mt-2 block w-full rounded-lg border border-gray-200 p-2 text-left text-sm hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
              >
                <span className="text-xs text-gray-500">{v.angle}</span>
                <div>{v.text}</div>
              </button>
            ))}
          </Field>
        )}
        {usesImage && (
          <Field label="Header image" hint="JPG or PNG, max 5 MB">
            <div className="flex items-center gap-2">
              <Input value={c.header_media_url || ""} onChange={(e) => setC({ ...c, header_media_url: e.target.value })} placeholder="https://…" />
              <label className="cursor-pointer text-sm text-brand-700">
                Upload
                <input type="file" accept="image/jpeg,image/png" className="hidden" onChange={(e) => e.target.files[0] && upload(e.target.files[0])} />
              </label>
            </div>
          </Field>
        )}
        <Field label="Button link (tracked)">
          <Input value={c.link_url || ""} onChange={(e) => setC({ ...c, link_url: e.target.value })} placeholder="https://yourstore.com/collections/sale" />
        </Field>
        <Field label="Unique discount code per customer" hint="Creates single-use Shopify codes and attributes orders to this campaign">
          <div className="flex gap-2">
            <Input type="number" placeholder="% off" value={c.discount?.percent || ""} onChange={(e) => setC({ ...c, discount: e.target.value ? { percent: Number(e.target.value), days: c.discount?.days || 7 } : null })} />
            <Input type="number" placeholder="days valid" value={c.discount?.days || ""} disabled={!c.discount} onChange={(e) => setC({ ...c, discount: { ...c.discount, days: Number(e.target.value) } })} />
          </div>
        </Field>
      </div>
    </Modal>
  );
}

export default function Marketing() {
  const { store } = useSingleStore();
  const navigate = useNavigate();
  const [tab, setTab] = useState("campaigns");
  const campaigns = useApi(store ? `/campaigns${qs({ storeId: store.id })}` : null, { interval: 15000 });
  const segments = useApi(store ? `/segments${qs({ storeId: store.id })}` : null);
  const templates = useApi(store ? `/templates${qs({ storeId: store.id })}` : null);
  const [editing, setEditing] = useState(null);
  const [segEditing, setSegEditing] = useState(null);
  const [run] = useAction();

  if (!store) return <Empty title="Connect a store first" />;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Marketing"
        subtitle={`Campaigns and audiences for ${store.name}. Only customers who opted in receive marketing messages.`}
        actions={
          <>
            <Button variant="secondary" onClick={() => setSegEditing({})}>
              New segment
            </Button>
            <Button onClick={() => setEditing({})}>New campaign</Button>
          </>
        }
      />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: "campaigns", label: "Campaigns", count: campaigns.data?.length }, { value: "segments", label: "Segments", count: segments.data?.length }]} />
      {tab === "campaigns" && (
        <Card padded={false}>
          <Table
            onRowClick={(c) => navigate(`/marketing/campaigns/${c.id}`)}
            rows={campaigns.data || []}
            empty="No campaigns yet. Create one to message a segment."
            columns={[
              { key: "name", label: "Campaign", render: (c) => <div><div className="font-medium">{c.name}</div><div className="text-xs text-gray-500">{c.template_name} → {c.segment_name || "all opted-in"}</div></div> },
              { key: "status", label: "Status", render: (c) => <Badge tone={{ sent: "green", sending: "blue", scheduled: "amber", failed: "red", cancelled: "gray" }[c.status]}>{c.status}</Badge> },
              { key: "schedule", label: "Scheduled", render: (c) => dateTime(c.schedule_at) },
              { key: "sent", label: "Sent", render: (c) => `${num(c.sent)} / ${num(c.recipients)}` },
              { key: "orders", label: "Orders", render: (c) => num(c.orders) },
              { key: "revenue", label: "Revenue", render: (c) => money(c.revenue, c.currency) },
              {
                key: "edit",
                label: "",
                render: (c) =>
                  ["draft", "scheduled"].includes(c.status) && (
                    <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setEditing(c); }}>
                      Edit
                    </Button>
                  ),
              },
            ]}
          />
        </Card>
      )}
      {tab === "segments" && (
        <Card padded={false}>
          <Table
            rows={segments.data || []}
            empty="No segments yet."
            columns={[
              { key: "name", label: "Segment", render: (s) => <span className="font-medium">{s.name}</span> },
              { key: "rules", label: "Rules", render: (s) => <span className="text-xs text-gray-500">{s.rules.conditions.map((c) => `${FIELD_LABELS[c.field] || c.field} ${c.op} ${c.value}`).join(s.rules.match === "any" ? " OR " : " AND ") || "everyone"}</span> },
              {
                key: "actions",
                label: "",
                render: (s) => (
                  <div className="flex justify-end gap-1">
                    <Button size="sm" variant="ghost" onClick={() => setSegEditing(s)}>
                      Edit
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => confirm("Delete this segment?") && run(() => del(`/segments/${s.id}`), "Deleted").then(segments.reload)}>
                      Delete
                    </Button>
                  </div>
                ),
              },
            ]}
          />
        </Card>
      )}
      {editing && (
        <CampaignEditor
          storeId={store.id}
          campaign={editing.id ? editing : null}
          templates={templates.data || []}
          segments={segments.data || []}
          onClose={() => setEditing(null)}
          onSaved={(c) => {
            setEditing(null);
            campaigns.reload();
            navigate(`/marketing/campaigns/${c.id}`);
          }}
        />
      )}
      {segEditing && (
        <SegmentEditor
          storeId={store.id}
          segment={segEditing.id ? segEditing : null}
          onClose={() => setSegEditing(null)}
          onSaved={() => {
            setSegEditing(null);
            segments.reload();
          }}
        />
      )}
    </div>
  );
}
