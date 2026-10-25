import PDFDocument from "pdfkit";
import { formatMoney } from "../lib/format.js";

const C = {
  ink: "#111827",
  muted: "#6b7280",
  line: "#e5e7eb",
  brand: "#16a34a",
  blue: "#2563eb",
  amber: "#d97706",
  red: "#dc2626",
  bg: "#f9fafb",
};

function kpiBox(doc, x, y, w, label, value, sub, color = C.ink) {
  doc.roundedRect(x, y, w, 58, 6).fillAndStroke(C.bg, C.line);
  doc.fillColor(C.muted).fontSize(8).text(label.toUpperCase(), x + 10, y + 9, { width: w - 20 });
  doc.fillColor(color).fontSize(16).text(String(value), x + 10, y + 22, { width: w - 20 });
  if (sub) doc.fillColor(C.muted).fontSize(8).text(sub, x + 10, y + 43, { width: w - 20 });
}

function barChart(doc, { x, y, w, h, title, labels, series }) {
  doc.fillColor(C.ink).fontSize(11).text(title, x, y);
  const top = y + 20;
  const chartH = h - 40;
  const max = Math.max(1, ...series.flatMap((s) => s.values.map(Number)));
  doc.strokeColor(C.line).lineWidth(0.5);
  for (let i = 0; i <= 4; i++) {
    const gy = top + chartH - (chartH * i) / 4;
    doc.moveTo(x, gy).lineTo(x + w, gy).stroke();
    doc.fillColor(C.muted).fontSize(6).text(String(Math.round((max * i) / 4)), x - 24, gy - 3, { width: 20, align: "right" });
  }
  const groupW = w / Math.max(1, labels.length);
  const barW = Math.max(2, Math.min(18, (groupW - 6) / series.length));
  labels.forEach((label, i) => {
    series.forEach((s, j) => {
      const v = Number(s.values[i] || 0);
      const bh = (chartH * v) / max;
      const bx = x + i * groupW + (groupW - barW * series.length) / 2 + j * barW;
      if (bh > 0) doc.rect(bx, top + chartH - bh, barW - 1, bh).fill(s.color);
    });
    if (labels.length <= 31 && (labels.length <= 10 || i % Math.ceil(labels.length / 10) === 0)) {
      doc.fillColor(C.muted).fontSize(6).text(label, x + i * groupW, top + chartH + 4, { width: groupW, align: "center" });
    }
  });
  let lx = x;
  series.forEach((s) => {
    doc.rect(lx, y + h - 10, 8, 8).fill(s.color);
    doc.fillColor(C.muted).fontSize(7).text(s.name, lx + 11, y + h - 9);
    lx += 70;
  });
}

function hbars(doc, { x, y, w, title, rows, color }) {
  doc.fillColor(C.ink).fontSize(11).text(title, x, y);
  const max = Math.max(1, ...rows.map((r) => Number(r.value)));
  rows.forEach((r, i) => {
    const ry = y + 20 + i * 18;
    doc.fillColor(C.ink).fontSize(8).text(r.label, x, ry + 2, { width: w * 0.42, ellipsis: true, lineBreak: false });
    const bw = ((w * 0.45) * Number(r.value)) / max;
    doc.rect(x + w * 0.44, ry, Math.max(1, bw), 11).fill(color);
    doc.fillColor(C.muted).fontSize(8).text(r.display ?? String(r.value), x + w * 0.44 + bw + 4, ry + 2, { lineBreak: false });
  });
}

/** Renders the owner report PDF. Returns a Buffer. */
export function renderReportPdf(report) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 40, info: { Title: report.title } });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const cur = report.currency;
    const k = report.metrics.kpis;
    const m = report.metrics.messages;
    const prev = report.previous?.kpis;
    const delta = (a, b) => {
      if (b === undefined || b === null || Number(b) === 0) return "";
      const d = Math.round(((Number(a) - Number(b)) / Number(b)) * 100);
      return `${d >= 0 ? "up" : "down"} ${Math.abs(d)}% vs previous`;
    };

    doc.rect(0, 0, doc.page.width, 70).fill(C.brand);
    doc.fillColor("#ffffff").fontSize(20).text(report.title, 40, 20);
    doc.fontSize(10).text(`${report.scopeName} · ${report.periodLabel}`, 40, 46);

    let y = 90;
    const w = (doc.page.width - 80 - 30) / 4;
    kpiBox(doc, 40, y, w, "Orders", k.orders, delta(k.orders, prev?.orders));
    kpiBox(doc, 40 + (w + 10), y, w, "Revenue", formatMoney(k.revenue, cur), delta(k.revenue, prev?.revenue));
    kpiBox(doc, 40 + (w + 10) * 2, y, w, "Confirmed", `${k.confirmed} (${k.confirmation_rate}%)`, null, C.brand);
    kpiBox(doc, 40 + (w + 10) * 3, y, w, "Cancelled", Number(k.cancelled_by_customer) + Number(k.cancelled), null, C.red);
    y += 68;
    kpiBox(doc, 40, y, w, "Pending reply", k.awaiting, `${k.no_response} no response`, C.amber);
    kpiBox(doc, 40 + (w + 10), y, w, "Messages sent", m.sent, `${m.read_rate}% read`, C.blue);
    kpiBox(doc, 40 + (w + 10) * 2, y, w, "Addresses fixed", k.address_updated, `${k.address_verified} verified`);
    kpiBox(doc, 40 + (w + 10) * 3, y, w, "Shipped", k.shipped, `${k.delivered} delivered`);
    y += 78;

    if (report.insights?.summary) {
      doc.roundedRect(40, y, doc.page.width - 80, 16 + 14 * (1 + (report.insights.actions?.length || 0)), 6).fillAndStroke("#ecfdf5", "#a7f3d0");
      doc.fillColor(C.ink).fontSize(10).text(`AI summary: ${report.insights.summary}`, 50, y + 8, { width: doc.page.width - 100 });
      (report.insights.actions || []).forEach((a) => doc.fontSize(9).fillColor(C.ink).text(`•  ${a}`, { width: doc.page.width - 100 }));
      y = doc.y + 18;
    }

    const series = report.trend || [];
    barChart(doc, {
      x: 70,
      y,
      w: doc.page.width - 110,
      h: 170,
      title: "Orders per day",
      labels: series.map((d) => d.day.slice(5)),
      series: [
        { name: "Orders", color: C.blue, values: series.map((d) => d.orders) },
        { name: "Confirmed", color: C.brand, values: series.map((d) => d.confirmed) },
        { name: "Cancelled", color: C.red, values: series.map((d) => d.cancelled) },
      ],
    });
    y += 190;

    const half = (doc.page.width - 100) / 2;
    hbars(doc, {
      x: 40,
      y,
      w: half,
      title: "Top products",
      color: C.blue,
      rows: report.metrics.topProducts.slice(0, 6).map((p) => ({ label: p.title, value: Number(p.qty), display: `${p.qty} sold` })),
    });
    hbars(doc, {
      x: 60 + half,
      y,
      w: half,
      title: "Top cities",
      color: C.brand,
      rows: report.metrics.topCities.slice(0, 6).map((c) => ({ label: c.city, value: Number(c.orders), display: `${c.orders}` })),
    });
    y += 140;

    hbars(doc, {
      x: 40,
      y,
      w: half,
      title: "WhatsApp messages",
      color: C.amber,
      rows: [
        { label: "Sent", value: Number(m.sent) },
        { label: "Delivered", value: Number(m.delivered) },
        { label: "Read", value: Number(m.read) },
        { label: "Failed", value: Number(m.failed) },
        { label: "Customer replies", value: Number(m.received) },
        { label: "AI replies", value: Number(m.ai_replies) },
      ],
    });
    const camp = report.metrics.campaigns;
    const carts = report.metrics.carts;
    hbars(doc, {
      x: 60 + half,
      y,
      w: half,
      title: "Marketing",
      color: C.blue,
      rows: [
        { label: "Campaign messages", value: Number(camp.sent) },
        { label: "Link clicks", value: Number(camp.clicked) },
        { label: "Campaign orders", value: Number(camp.orders), display: `${camp.orders} (${formatMoney(camp.revenue, cur)})` },
        { label: "Carts reminded", value: Number(carts.reminded) },
        { label: "Carts recovered", value: Number(carts.recovered), display: `${carts.recovered} (${formatMoney(carts.recovered_revenue, cur)})` },
      ],
    });

    doc.fillColor(C.muted).fontSize(7).text(
      `Generated ${new Date().toISOString().replace("T", " ").slice(0, 16)} UTC · Estimated WhatsApp cost ${formatMoney(m.cost, report.pricingCurrency || "USD")}`,
      40,
      doc.page.height - 50
    );
    doc.end();
  });
}
