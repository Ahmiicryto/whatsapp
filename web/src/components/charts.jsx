import { useEffect, useState } from "react";
import { ResponsiveContainer, LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from "recharts";

// Validated categorical slots (light / dark), assigned in fixed order. Never cycled.
const SERIES = {
  light: ["#2a78d6", "#eb6834", "#1baf7a"],
  dark: ["#3987e5", "#d95926", "#199e70"],
};
const SEQ = { light: "#2a78d6", dark: "#3987e5" };
const INK = {
  light: { grid: "#ececea", axis: "#8a8984", text: "#52514e", surface: "#ffffff" },
  dark: { grid: "#2c2c2a", axis: "#8f8e88", text: "#c3c2b7", surface: "#111827" },
};

function useDark() {
  const q = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  const [dark, setDark] = useState(q?.matches ?? false);
  useEffect(() => {
    if (!q) return undefined;
    const h = (e) => setDark(e.matches);
    q.addEventListener("change", h);
    return () => q.removeEventListener("change", h);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return dark;
}

function TooltipBox({ active, payload, label, format, labelFormat }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs shadow-md dark:border-gray-700 dark:bg-gray-900">
      <div className="mb-1 font-medium text-gray-700 dark:text-gray-200">{labelFormat ? labelFormat(label) : label}</div>
      {payload.map((p) => (
        <div key={p.dataKey} className="flex items-center gap-2 text-gray-600 dark:text-gray-300">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: p.color }} />
          <span>{p.name}</span>
          <span className="ml-auto pl-3 font-medium text-gray-900 dark:text-gray-100">{format ? format(p.value) : p.value}</span>
        </div>
      ))}
    </div>
  );
}

const shortDay = (d) => {
  const dt = new Date(`${d}T00:00:00`);
  return Number.isNaN(dt.getTime()) ? d : dt.toLocaleDateString(undefined, { day: "numeric", month: "short" });
};

/** Multi-series trend (max 3 series). Legend + optional table view for accessibility. */
export function TrendChart({ data, series, height = 240, format }) {
  const dark = useDark();
  const mode = dark ? "dark" : "light";
  const ink = INK[mode];
  const [table, setTable] = useState(false);
  const colors = SERIES[mode];
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-4 text-xs text-gray-600 dark:text-gray-300">
        {series.length > 1 &&
          series.map((s, i) => (
            <span key={s.key} className="flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-4 rounded" style={{ background: colors[i] }} />
              {s.label}
            </span>
          ))}
        <button onClick={() => setTable(!table)} className="ml-auto text-gray-500 underline-offset-2 hover:underline">
          {table ? "Show chart" : "Show table"}
        </button>
      </div>
      {table ? (
        <div className="max-h-64 overflow-y-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-gray-500">
                <th className="py-1">Day</th>
                {series.map((s) => (
                  <th key={s.key} className="py-1 text-right">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.day} className="border-t border-gray-100 dark:border-gray-800">
                  <td className="py-1">{shortDay(d.day)}</td>
                  {series.map((s) => (
                    <td key={s.key} className="py-1 text-right">
                      {format ? format(d[s.key]) : d[s.key]}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={height}>
          <LineChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: -12 }}>
            <CartesianGrid stroke={ink.grid} vertical={false} />
            <XAxis dataKey="day" tickFormatter={shortDay} tick={{ fill: ink.axis, fontSize: 11 }} axisLine={false} tickLine={false} minTickGap={24} />
            <YAxis tick={{ fill: ink.axis, fontSize: 11 }} axisLine={false} tickLine={false} allowDecimals={false} tickFormatter={format} width={format ? 64 : 40} />
            <Tooltip content={<TooltipBox format={format} labelFormat={shortDay} />} cursor={{ stroke: ink.axis, strokeDasharray: "3 3" }} />
            {series.map((s, i) => (
              <Line
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.label}
                stroke={colors[i]}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, stroke: ink.surface, strokeWidth: 2 }}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

/** Single-series columns (e.g. revenue per day). */
export function ColumnChart({ data, dataKey, label, height = 220, format, axisFormat }) {
  const dark = useDark();
  const mode = dark ? "dark" : "light";
  const ink = INK[mode];
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: -12 }} barCategoryGap={2}>
        <CartesianGrid stroke={ink.grid} vertical={false} />
        <XAxis dataKey="day" tickFormatter={shortDay} tick={{ fill: ink.axis, fontSize: 11 }} axisLine={false} tickLine={false} minTickGap={24} />
        <YAxis tick={{ fill: ink.axis, fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={axisFormat || format} width={56} />
        <Tooltip content={<TooltipBox format={format} labelFormat={shortDay} />} cursor={{ fill: dark ? "#ffffff10" : "#00000008" }} />
        <Bar dataKey={dataKey} name={label} fill={SEQ[mode]} radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/**
 * Horizontal bar list (ranked categories, funnels). One hue; text stays in ink colours.
 * rows: [{label, value, display?, image?}]
 */
export function BarList({ rows, empty = "No data yet" }) {
  const dark = useDark();
  const max = Math.max(1, ...rows.map((r) => Number(r.value) || 0));
  if (!rows.length) return <div className="py-6 text-center text-sm text-gray-500">{empty}</div>;
  return (
    <div className="space-y-2.5">
      {rows.map((r) => (
        <div key={r.label} className="group" title={`${r.label}: ${r.display ?? r.value}`}>
          <div className="mb-1 flex items-center justify-between gap-2 text-xs">
            <span className="flex min-w-0 items-center gap-2 truncate text-gray-700 dark:text-gray-300">
              {r.image && <img src={r.image} alt="" className="h-5 w-5 shrink-0 rounded object-cover" />}
              <span className="truncate">{r.label}</span>
            </span>
            <span className="shrink-0 font-medium text-gray-900 dark:text-gray-100">{r.display ?? r.value}</span>
          </div>
          <div className="h-2 rounded bg-gray-100 dark:bg-gray-800">
            <div
              className="h-2 rounded transition-[width] group-hover:opacity-80"
              style={{ width: `${Math.max(2, ((Number(r.value) || 0) / max) * 100)}%`, background: dark ? SEQ.dark : SEQ.light }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
