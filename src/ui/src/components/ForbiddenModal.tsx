import { useEffect, useState } from "react";

/**
 * ForbiddenModal — listens for the global `api:forbidden` CustomEvent fired by
 * the Axios response interceptor whenever the API returns HTTP 403.
 *
 * Renders a small centred modal with the server-supplied reason message.
 * Dismissed by clicking the close button or anywhere on the backdrop.
 */
export default function ForbiddenModal() {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const onForbidden = (e: Event) => {
      const detail = (e as CustomEvent<{ message: string }>).detail;
      setMessage(detail?.message ?? "You are not authorised to perform this action.");
    };
    window.addEventListener("api:forbidden", onForbidden);
    return () => window.removeEventListener("api:forbidden", onForbidden);
  }, []);

  if (!message) return null;

  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={() => setMessage(null)}
    >
      {/* Card — stop clicks from closing when clicking inside the card */}
      <div
        className="relative w-full max-w-sm mx-4 rounded-xl border border-red-700/60 bg-[#130a0a] shadow-2xl shadow-red-950/40 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close button */}
        <button
          className="absolute top-3 right-3 text-slate-500 hover:text-slate-200 transition-colors"
          onClick={() => setMessage(null)}
          aria-label="Dismiss"
        >
          <svg viewBox="0 0 20 20" className="w-4 h-4" fill="currentColor">
            <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
          </svg>
        </button>

        {/* Icon + heading */}
        <div className="flex items-center gap-3 mb-3">
          <span className="flex items-center justify-center w-9 h-9 rounded-full bg-red-900/40 ring-1 ring-red-700/50 shrink-0">
            <svg viewBox="0 0 24 24" className="w-5 h-5 text-red-400" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </span>
          <h2 className="text-red-300 font-semibold text-base">Access Denied (403)</h2>
        </div>

        {/* Message */}
        <p className="text-slate-300 text-sm leading-relaxed">{message}</p>

        {/* Dismiss button */}
        <div className="mt-5 flex justify-end">
          <button
            onClick={() => setMessage(null)}
            className="px-4 py-1.5 rounded-md bg-red-900/40 hover:bg-red-800/50 text-red-300 text-sm font-medium ring-1 ring-red-700/50 transition-colors"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
