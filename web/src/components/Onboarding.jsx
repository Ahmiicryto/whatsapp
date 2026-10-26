import { useState } from "react";
import { Link } from "react-router-dom";
import { CheckCircle2, Circle, Rocket } from "lucide-react";
import { useApi } from "../lib/api.js";
import { Card, cx } from "./ui.jsx";

/** Getting-started checklist; hidden once complete (or dismissed on the dashboard). */
export default function Onboarding({ always = false }) {
  const { data } = useApi("/onboarding");
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem("wa.onboardingHidden") === "1";
    } catch {
      return false;
    }
  });
  if (!data || (!always && (dismissed || data.done === data.total))) return null;
  const pct = Math.round((data.done / data.total) * 100);
  return (
    <Card
      title={`Setup checklist · ${data.done} of ${data.total} done`}
      icon={Rocket}
      actions={
        !always && (
          <button
            className="text-xs text-gray-400 hover:text-gray-700"
            onClick={() => {
              try {
                localStorage.setItem("wa.onboardingHidden", "1");
              } catch {
                /* ignore */
              }
              setDismissed(true);
            }}
          >
            Hide
          </button>
        )
      }
    >
      <div className="mb-4 h-2 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="brand-gradient h-full rounded-full transition-all" style={{ width: `${pct}%` }} />
      </div>
      <ul className="grid gap-2 sm:grid-cols-2">
        {data.steps.map((s) => (
          <li key={s.id}>
            <Link to={s.link} className={cx("flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition hover:bg-gray-50 dark:hover:bg-gray-800/50", s.done && "text-gray-400 line-through")}>
              {s.done ? <CheckCircle2 className="h-4.5 w-4.5 shrink-0 text-brand-600" /> : <Circle className="h-4.5 w-4.5 shrink-0 text-gray-300" />}
              {s.title}
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}
