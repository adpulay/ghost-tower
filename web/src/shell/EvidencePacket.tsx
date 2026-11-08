import { useRef, useState } from "react";
import type { CaseReport } from "../spacetime/types";

const TITLES: Record<string, string> = {
  police: "Police brief",
  registrar: "Report to the domain registrar",
};

function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("done");
    } catch {
      setState("failed"); // no clipboard access, e.g. on plain http
    }
    setTimeout(() => setState("idle"), 2000);
  };
  return (
    <button type="button" className="link-btn" onClick={copy}>
      {state === "done" ? "Copied" : state === "failed" ? "Couldn't copy" : "Copy"}
    </button>
  );
}

/** The drafted reports for one track, opened from the facts list. The row disappears until the agent has written them. */
export function EvidencePacket({ reports }: { reports: CaseReport[] }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  if (reports.length === 0) return null;
  const ordered = [...reports].sort((a, b) => a.kind.localeCompare(b.kind));

  return (
    <div title="Ready to send to police and the domain registrar.">
      <dt>Evidence packet</dt>
      <dd>
        <button type="button" className="link-btn" onClick={() => dialogRef.current?.showModal()}>
          Open reports
        </button>
        <dialog ref={dialogRef} className="packet" aria-labelledby="packet-title">
          <header className="packet-head">
            <h2 id="packet-title">Evidence packet</h2>
            <button type="button" className="link-btn" onClick={() => dialogRef.current?.close()}>
              Close
            </button>
          </header>
          {ordered.map((r) => (
            <article key={r.id} className="packet-report">
              <header className="packet-report-head">
                <h3>{TITLES[r.kind] ?? r.kind}</h3>
                <CopyButton text={r.text} />
              </header>
              <pre>{r.text}</pre>
              <p className="packet-source">
                {r.generated
                  ? "Written by Nemotron from the database's facts. Review before sending."
                  : "Fixed template filled in from the database's facts (no model text was used)."}
              </p>
            </article>
          ))}
        </dialog>
      </dd>
    </div>
  );
}
