import { useState, useEffect, useCallback } from "react";
import { useStore } from "../store.js";
import { platform } from "../platform.js";
import { Plus, X, ChevronDown, ChevronRight } from "lucide-react";
import type { SessionView } from "../types.js";

export function SchedulesPanel({ onResumeSession }: { onResumeSession?: (sid: string) => void }) {
  const inst = useStore(s => s.selectedInstance);
  const schedules = useStore(s => s.schedules);
  const fetchSchedules = useStore(s => s.fetchSchedules);
  const toggleSchedule = useStore(s => s.toggleSchedule);
  const deleteSchedule = useStore(s => s.deleteSchedule);
  const resetScheduleSession = useStore(s => s.resetScheduleSession);
  const showAlert = useStore(s => s.showAlert);
  const showConfirm = useStore(s => s.showConfirm);

  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ type: "cron" as "cron" | "heartbeat", name: "", cron: "", task: "", mins: 5, sessionMode: "fresh" as "continuous" | "fresh" });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [scheduleSessions, setScheduleSessions] = useState<Record<string, SessionView[]>>({});

  const poll = useCallback(() => fetchSchedules(), [fetchSchedules]);
  useEffect(() => { poll(); const i = setInterval(poll, 5000); return () => clearInterval(i); }, [poll]);

  // Fetch sessions when a schedule card is expanded
  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    const fetchSessions = async () => {
      try {
        const sessions = await platform.sessions.listByScheduleId.query({ scheduleId: expanded });
        if (!cancelled) setScheduleSessions(prev => ({ ...prev, [expanded]: sessions }));
      } catch {}
    };
    fetchSessions();
    return () => { cancelled = true; };
  }, [expanded]);

  const toggleExpanded = (id: string) => {
    setExpanded(prev => prev === id ? null : id);
  };

  const create = async () => {
    if (!inst) return; setBusy(true);
    try {
      if (f.type === "cron") await platform.schedules.createCron.mutate({ name: f.name, instanceId: inst, cron: f.cron, task: f.task, sessionMode: f.sessionMode !== "fresh" ? f.sessionMode : undefined });
      else await platform.schedules.createHeartbeat.mutate({ name: f.name, instanceId: inst, intervalMinutes: f.mins });
      setShow(false); fetchSchedules();
    } catch (e) { showAlert(e instanceof Error ? e.message : "Failed", "Schedule Error"); }
    finally { setBusy(false); }
  };

  const inp = "w-full h-8 rounded-md border-2 border-border-light bg-surface px-3 text-[12px] text-text outline-none transition-all focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-glow)]";

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="px-4 py-3 border-b-2 border-border-light shrink-0">
        <button
          className="btn-brutal h-7 rounded-md border-2 border-border px-3.5 text-[11px] font-bold text-text-secondary hover:text-accent hover:border-accent flex items-center gap-1"
          style={{ boxShadow: "var(--shadow-brutal-sm)" }}
          onClick={() => { setF({ type: "cron", name: "", cron: "", task: "", mins: 5, sessionMode: "fresh" }); setShow(true); }}
        >
          <Plus size={12} /> Add Schedule
        </button>
      </div>

      {show && (
        <div className="flex flex-col gap-3 border-b-2 border-border-light bg-surface-raised p-4 anim-scale-in">
          <div className="flex gap-1.5">
            {(["cron", "heartbeat"] as const).map(t => (
              <button
                key={t}
                className={`text-[11px] font-bold uppercase tracking-[0.03em] border-2 rounded-full px-3 py-0.5 capitalize ${f.type === t ? "bg-accent text-white border-accent-hover" : "bg-surface text-text-muted border-border-light"}`}
                onClick={() => setF(p => ({ ...p, type: t }))}
              >
                {t}
              </button>
            ))}
          </div>
          <input className={inp} placeholder="Name" value={f.name} onChange={e => setF(p => ({ ...p, name: e.target.value }))} />
          {f.type === "cron" && <>
            <input className={`${inp} font-mono`} placeholder="Cron expression" value={f.cron} onChange={e => setF(p => ({ ...p, cron: e.target.value }))} />
            <textarea className="w-full rounded-md border-2 border-border-light bg-surface px-3 py-2 text-[12px] text-text outline-none transition-all focus:border-accent resize-y min-h-[50px]" placeholder="Task prompt" value={f.task} onChange={e => setF(p => ({ ...p, task: e.target.value }))} rows={2} />
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold text-text-secondary">Session:</span>
              {(["fresh", "continuous"] as const).map(m => (
                <button
                  key={m}
                  className={`text-[10px] font-bold uppercase tracking-[0.03em] border-2 rounded-full px-2.5 py-0.5 capitalize ${f.sessionMode === m ? "bg-accent text-white border-accent-hover" : "bg-surface text-text-muted border-border-light"}`}
                  onClick={() => setF(p => ({ ...p, sessionMode: m }))}
                >
                  {m}
                </button>
              ))}
            </div>
          </>}
          {f.type === "heartbeat" && <input className={`${inp} font-mono`} type="number" min={1} placeholder="Minutes" value={f.mins} onChange={e => setF(p => ({ ...p, mins: parseInt(e.target.value) || 1 }))} />}
          <div className="flex justify-end gap-2">
            <button className="h-7 rounded-md border-2 border-border-light px-3 text-[11px] font-semibold text-text-muted hover:text-text transition-colors" onClick={() => setShow(false)}>Cancel</button>
            <button
              className="btn-brutal h-7 rounded-md border-2 border-accent-hover bg-accent px-3.5 text-[11px] font-bold text-white disabled:opacity-40"
              style={{ boxShadow: "var(--shadow-brutal-accent)" }}
              disabled={busy || !f.name.trim()}
              onClick={create}
            >
              {busy ? "..." : "Create"}
            </button>
          </div>
        </div>
      )}

      {schedules.length === 0 && !show && <p className="px-4 py-5 text-[12px] text-text-muted">No schedules</p>}
      {schedules.map(s => {
        const isExpanded = expanded === s.id;
        const sessions = scheduleSessions[s.id] ?? [];

        return (
          <div key={s.id} className="border-b border-border-light">
            {/* Schedule card header — clickable to expand */}
            <div
              className={`flex flex-col gap-1.5 px-4 py-3 cursor-pointer transition-colors hover:bg-surface-raised ${isExpanded ? "bg-surface-raised" : ""}`}
              onClick={() => toggleExpanded(s.id)}
            >
              <div className="flex items-center gap-2">
                {isExpanded ? <ChevronDown size={12} className="text-text-muted shrink-0" /> : <ChevronRight size={12} className="text-text-muted shrink-0" />}
                <span className={`text-[10px] font-bold uppercase tracking-[0.03em] border-2 rounded-full px-2 py-0.5 ${s.type === "cron" ? "bg-info-light text-info border-info" : "bg-success-light text-success border-success"}`}>{s.type}</span>
                {(s.sessionMode === "continuous" || s.type === "heartbeat") && (
                  <span className="text-[10px] font-bold uppercase tracking-[0.03em] border rounded-full px-2 py-0.5 bg-purple-50 text-purple-600 border-purple-300">
                    continuous
                  </span>
                )}
                <span className="text-[13px] font-semibold text-text flex-1 truncate">{s.name}</span>
                <span className="text-[11px] font-mono text-text-muted">{s.cron}</span>
                <button
                  className={`text-[10px] font-bold uppercase tracking-[0.03em] border-2 rounded-full px-2.5 py-0.5 ${s.enabled ? "bg-success-light text-success border-success" : "bg-bg text-text-muted border-border-light"} hover:opacity-80`}
                  onClick={(e) => { e.stopPropagation(); toggleSchedule(s.id); }}
                >
                  {s.enabled ? "On" : "Off"}
                </button>
                <button
                  className="text-text-muted hover:text-danger transition-colors"
                  onClick={async (e) => { e.stopPropagation(); if (await showConfirm(`Delete schedule "${s.name}"?`, "Delete Schedule")) deleteSchedule(s.id); }}
                >
                  <X size={14} />
                </button>
              </div>
              {s.status && (
                <div className="flex gap-3 text-[11px] text-text-muted pl-5">
                  {s.status.lastRun && <span>last: {new Date(s.status.lastRun).toLocaleString()}</span>}
                  {s.status.nextRun && <span>next: {new Date(s.status.nextRun).toLocaleString()}</span>}
                  {s.status.lastResult && <span className={s.status.lastResult === "success" ? "text-success" : "text-danger"}>{s.status.lastResult}</span>}
                </div>
              )}
            </div>

            {/* Expanded session list */}
            {isExpanded && (
              <div className="border-t border-border-light bg-bg/50">
                {sessions.length === 0 && (
                  <p className="px-4 py-3 text-[11px] text-text-muted pl-9">No sessions yet</p>
                )}
                {sessions.map(session => (
                  <div
                    key={session.sessionId}
                    onClick={() => onResumeSession?.(session.sessionId)}
                    className="flex items-center gap-2 px-4 py-2.5 pl-9 cursor-pointer hover:bg-accent-light transition-colors border-b border-border-light last:border-b-0"
                  >
                    <span className="text-[12px] text-text font-medium truncate flex-1">
                      {session.title || session.sessionId.slice(0, 12)}
                    </span>
                    <span className="text-[10px] text-text-muted shrink-0">
                      {new Date(session.updatedAt ?? session.createdAt).toLocaleString()}
                    </span>
                  </div>
                ))}
                {(s.type === "heartbeat" || s.sessionMode === "continuous") && sessions.length > 0 && (
                  <div className="px-4 py-2 pl-9">
                    <button
                      className="text-[10px] font-bold uppercase tracking-[0.03em] border border-border-light rounded px-1.5 py-0.5 text-text-muted hover:text-danger hover:border-danger transition-colors"
                      onClick={async (e) => {
                        e.stopPropagation();
                        if (await showConfirm(`Reset session for "${s.name}"? The next tick will start a fresh conversation.`, "Reset Session")) {
                          await resetScheduleSession(s.id);
                          setScheduleSessions(prev => ({ ...prev, [s.id]: [] }));
                        }
                      }}
                    >
                      Reset
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
