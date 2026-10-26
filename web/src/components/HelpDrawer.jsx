import { Link } from "react-router-dom";
import { BookOpen, CheckCircle2, Lightbulb } from "lucide-react";
import { Modal } from "./ui.jsx";

export function GuideBody({ guide }) {
  return (
    <div className="space-y-5 text-sm">
      <p className="text-gray-600 dark:text-gray-300">{guide.summary}</p>
      <ol className="space-y-3">
        {guide.steps.map((s, i) => (
          <li key={i} className="flex gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-bold text-brand-700 dark:bg-brand-900/50 dark:text-brand-300">{i + 1}</span>
            <span className="pt-0.5 leading-relaxed">{s}</span>
          </li>
        ))}
      </ol>
      {guide.tips?.length > 0 && (
        <div className="space-y-2 rounded-xl bg-amber-50 p-3 text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          {guide.tips.map((t, i) => (
            <p key={i} className="flex gap-2">
              <Lightbulb className="mt-0.5 h-4 w-4 shrink-0" /> {t}
            </p>
          ))}
        </div>
      )}
      {guide.faq?.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-bold uppercase tracking-wider text-gray-400">Questions</div>
          {guide.faq.map((f, i) => (
            <details key={i} className="rounded-xl bg-gray-50 p-3 dark:bg-gray-800/50">
              <summary className="cursor-pointer font-semibold">{f.q}</summary>
              <p className="mt-2 text-gray-600 dark:text-gray-300">{f.a}</p>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}

export default function HelpDrawer({ guide, onClose }) {
  return (
    <Modal open drawer onClose={onClose} title={`How to use: ${guide.title}`}>
      <GuideBody guide={guide} />
      <div className="mt-6 flex flex-col gap-2 border-t border-gray-100 pt-4 text-sm dark:border-gray-800">
        <Link to="/help" onClick={onClose} className="flex items-center gap-2 font-semibold text-brand-700 hover:underline dark:text-brand-400">
          <BookOpen className="h-4 w-4" /> All guides in the Help center
        </Link>
        <span className="flex items-center gap-2 text-xs text-gray-500">
          <CheckCircle2 className="h-3.5 w-3.5" /> Press Ctrl + K to search anything
        </span>
      </div>
    </Modal>
  );
}
