import { useMemo, useState } from "react";
import { BookOpen, LifeBuoy, Search } from "lucide-react";
import { GUIDES } from "../lib/guides.js";
import { Card, Input, PageHeader, cx } from "../components/ui.jsx";
import { GuideBody } from "../components/HelpDrawer.jsx";
import Onboarding from "../components/Onboarding.jsx";

export default function Help() {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(GUIDES[0].key);
  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return GUIDES;
    return GUIDES.filter((g) => [g.title, g.summary, ...g.steps, ...(g.tips || []), ...(g.faq || []).flatMap((f) => [f.q, f.a])].join(" ").toLowerCase().includes(t));
  }, [q]);
  const guide = list.find((g) => g.key === active) || list[0];
  return (
    <div className="space-y-5">
      <PageHeader icon={LifeBuoy} title="Help center" subtitle="Step-by-step guides for every part of the app" />
      <Onboarding always />
      <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
        <div className="space-y-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <Input className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the guides" aria-label="Search the guides" />
          </div>
          <nav className="space-y-0.5" aria-label="Guides">
            {list.map((g) => (
              <button
                key={g.key}
                onClick={() => setActive(g.key)}
                className={cx("flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm transition", guide?.key === g.key ? "bg-white font-semibold text-brand-700 shadow-soft dark:bg-gray-900 dark:text-brand-400" : "text-gray-600 hover:bg-white/60 dark:text-gray-300 dark:hover:bg-gray-800/50")}
              >
                <BookOpen className="h-4 w-4 shrink-0" /> {g.title}
              </button>
            ))}
            {list.length === 0 && <p className="px-3 text-sm text-gray-500">No guide matches “{q}”.</p>}
          </nav>
        </div>
        {guide && (
          <Card title={guide.title} icon={BookOpen}>
            <GuideBody guide={guide} />
          </Card>
        )}
      </div>
    </div>
  );
}
