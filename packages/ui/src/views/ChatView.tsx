import {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
  type KeyboardEvent,
} from "react";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk/dist/acp.js";
import type { ClientSideConnection } from "@agentclientprotocol/sdk/dist/acp.js";
import { useStore } from "../store.js";
import { openConnection } from "../acp.js";
import { createInstanceTrpc } from "../instance-trpc.js";
import { platform } from "../platform.js";
import { isMcpSecret, mcpHostnameFromSecretName } from "../types.js";
import type { Message, ToolChip as ToolChipT } from "../types.js";
import type { McpServer } from "@agentclientprotocol/sdk/dist/schema/types.gen.js";
import { instanceState, stateLabel, badgeColors, dotColors } from "../components/StatusIndicator.js";
import { ArrowLeft, Plus, Send as SendIcon } from "lucide-react";
import { Markdown } from "../components/Markdown.js";
import { ToolChip } from "../components/ToolChip.js";
import { ResizeHandle } from "../components/ResizeHandle.js";
import { SessionsSidebar } from "../panels/SessionsSidebar.js";
import { FilesPanel } from "../panels/FilesPanel.js";
import { LogPanel } from "../panels/LogPanel.js";
import { SchedulesPanel } from "../panels/SchedulesPanel.js";
import { ChannelsPanel } from "../panels/ChannelsPanel.js";
import { McpsPanel, type McpOption } from "../panels/McpsPanel.js";

export function ChatView() {
  const selectedInstance = useStore((s) => s.selectedInstance);
  const instances = useStore((s) => s.instances);
  const sessionId = useStore((s) => s.sessionId);
  const messages = useStore((s) => s.messages);
  const busy = useStore((s) => s.busy);
  const rightTab = useStore((s) => s.rightTab);
  const loadingSession = useStore((s) => s.loading.session);
  const goBack = useStore((s) => s.goBack);
  const setSessionId = useStore((s) => s.setSessionId);
  const setMessages = useStore((s) => s.setMessages);
  const setSessions = useStore((s) => s.setSessions);
  const setBusy = useStore((s) => s.setBusy);
  const setLoadingSessions = useStore((s) => s.setLoadingSessions);
  const setLoadingSession = useStore((s) => s.setLoadingSession);
  const addLog = useStore((s) => s.addLog);
  const setFileTree = useStore((s) => s.setFileTree);
  const setOpenFile = useStore((s) => s.setOpenFile);
  const setRightTab = useStore((s) => s.setRightTab);
  const openFile = useStore((s) => s.openFile);
  const secrets = useStore((s) => s.secrets);
  const fetchSecrets = useStore((s) => s.fetchSecrets);
  const agentAccess = useStore((s) => s.agentAccess);
  const fetchAgentAccess = useStore((s) => s.fetchAgentAccess);

  const [input, setInput] = useState("");
  const [leftW, setLeftW] = useState(() => Number(localStorage.getItem("humr-left-w")) || 220);
  const [rightW, setRightW] = useState(() => Number(localStorage.getItem("humr-right-w")) || 340);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const connectionRef = useRef<{
    connection: ClientSideConnection;
    ws: WebSocket;
  } | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const currentAssistantIdRef = useRef<string | null>(null);

  const instanceTrpc = useMemo(
    () => (selectedInstance ? createInstanceTrpc(selectedInstance) : null),
    [selectedInstance],
  );

  // --- MCP picker state ---
  // The agent whose credential access governs which MCPs are available.
  const currentAgentId = useMemo(
    () => instances.find((i) => i.id === selectedInstance)?.agentId,
    [instances, selectedInstance],
  );
  const access = currentAgentId ? agentAccess[currentAgentId] : undefined;

  // Fetch data needed to build the picker
  useEffect(() => { fetchSecrets(); }, [fetchSecrets]);
  useEffect(() => {
    if (currentAgentId && !agentAccess[currentAgentId]) {
      fetchAgentAccess(currentAgentId);
    }
  }, [currentAgentId, agentAccess, fetchAgentAccess]);

  // Compute available MCPs: in "all" mode — every MCP secret; in "selective"
  // mode — only those explicitly assigned to the agent.
  const mcpOptions = useMemo<McpOption[]>(() => {
    const mcpSecrets = secrets.filter(isMcpSecret);
    if (!access) return [];
    if (access.mode === "all") {
      return mcpSecrets.map((s) => ({
        id: s.id,
        hostname: mcpHostnameFromSecretName(s.name),
        assigned: true,
      }));
    }
    return mcpSecrets
      .filter((s) => access.secretIds.includes(s.id))
      .map((s) => ({
        id: s.id,
        hostname: mcpHostnameFromSecretName(s.name),
        assigned: true,
      }));
  }, [secrets, access]);

  // User's per-session enable/disable selection. Default: every available one.
  const [enabledMcps, setEnabledMcps] = useState<Set<string>>(new Set());
  const mcpInitializedRef = useRef(false);
  useEffect(() => {
    if (!mcpInitializedRef.current && mcpOptions.length > 0) {
      setEnabledMcps(new Set(mcpOptions.map((o) => o.hostname)));
      mcpInitializedRef.current = true;
    }
  }, [mcpOptions]);

  const toggleMcp = useCallback(
    (hostname: string) =>
      setEnabledMcps((p) => {
        const n = new Set(p);
        n.has(hostname) ? n.delete(hostname) : n.add(hostname);
        return n;
      }),
    [],
  );
  const selectAllMcps = useCallback(
    () => setEnabledMcps(new Set(mcpOptions.map((o) => o.hostname))),
    [mcpOptions],
  );
  const clearAllMcps = useCallback(() => setEnabledMcps(new Set()), []);

  // Reset initialisation when the agent changes so defaults re-apply.
  useEffect(() => {
    mcpInitializedRef.current = false;
    setEnabledMcps(new Set());
  }, [currentAgentId]);

  // Derive the ACP-shape payload for session creation/loading.
  const selectedMcpServers = useMemo<McpServer[]>(() => {
    return mcpOptions
      .filter((o) => enabledMcps.has(o.hostname))
      .map((o) => ({
        type: "http",
        name: o.hostname.split(".")[0],
        url: `https://${o.hostname}/mcp`,
        headers: [],
      }));
  }, [mcpOptions, enabledMcps]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // File tree
  useEffect(() => {
    if (instanceTrpc)
      instanceTrpc.files.tree
        .query()
        .then(({ entries }) => setFileTree(entries))
        .catch(() => {});
  }, [instanceTrpc, setFileTree]);
  useEffect(() => {
    if (!instanceTrpc) return;
    const i = setInterval(async () => {
      try {
        const { entries } = await instanceTrpc.files.tree.query();
        setFileTree(entries);
        const cur = useStore.getState().openFile;
        if (cur) {
          try {
            const d = await instanceTrpc.files.read.query({ path: cur.path });
            d.content !== undefined
              ? setOpenFile({ path: d.path, content: d.content })
              : setOpenFile(null);
          } catch {
            setOpenFile(null);
          }
        }
      } catch {}
    }, 2000);
    return () => clearInterval(i);
  }, [instanceTrpc, setFileTree, setOpenFile]);

  // Wake instance if hibernated on entry
  useEffect(() => {
    if (!selectedInstance) return;
    const inst = instances.find(i => i.id === selectedInstance);
    const state = inst ? instanceState(inst) : "unknown";
    if (state === "hibernated") {
      platform.instances.wake.mutate({ id: selectedInstance }).catch(() => {});
    }
  }, [selectedInstance, instances]);

  const includeChannelSessions = useStore((s) => s.includeChannelSessions);
  const fetchSessions = useCallback(async () => {
    if (!selectedInstance) return false;
    const inst = useStore.getState().instances.find(x => x.id === selectedInstance);
    if (inst?.state !== "running") return false;
    try {
      const list = await platform.sessions.list.query({ instanceId: selectedInstance, includeChannel: includeChannelSessions });
      setSessions(list);
      return true;
    } catch {
      return false;
    }
  }, [selectedInstance, includeChannelSessions, setSessions]);
  useEffect(() => {
    if (!selectedInstance) return;
    setLoadingSessions(true);
    let stopped = false;
    const attempt = () => {
      if (stopped) return;
      fetchSessions().then((ok) => {
        if (stopped) return;
        if (ok) { setLoadingSessions(false); return; }
        setTimeout(attempt, 3000);
      });
    };
    attempt();
    return () => { stopped = true; };
  }, [selectedInstance, fetchSessions, setLoadingSessions]);

  const resumeSession = useCallback(
    async (sid: string) => {
      if (!selectedInstance) return;
      setBusy(true);
      setLoadingSession(true);
      setMessages([]);
      setSessionId(sid);
      connectionRef.current?.ws.close();
      connectionRef.current = null;
      activeSessionIdRef.current = null;
      const mm = new Map<string, Message>(),
        mo: string[] = [];
      try {
        const { connection, ws } = await openConnection(
          selectedInstance,
          (u) => {
            // Helper: get or create the assistant message for the current agent turn
            // (everything between two user messages belongs to one assistant message)
            const currentAssistant = (): Message => {
              // Find last user message index
              let lastUserIdx = -1;
              for (let i = mo.length - 1; i >= 0; i--) {
                if (mm.get(mo[i])?.role === "user") { lastUserIdx = i; break; }
              }
              // Look for existing assistant message after it
              for (let i = lastUserIdx + 1; i < mo.length; i++) {
                const m = mm.get(mo[i]);
                if (m?.role === "assistant") return m;
              }
              // None found — create one
              const id = crypto.randomUUID();
              const m: Message = { id, role: "assistant", parts: [], streaming: false };
              mm.set(id, m);
              mo.push(id);
              return m;
            };

            if (u.sessionUpdate === "user_message_chunk" && u.content.type === "text") {
              const txt = (u.content.text as string).replace(/<[a-z-]+>[\s\S]*?<\/[a-z-]+>/g, "").trim();
              if (!txt) return;
              const mid = u.messageId ?? crypto.randomUUID();
              const ex = mm.get(mid);
              if (ex) {
                const l = ex.parts[ex.parts.length - 1];
                l?.kind === "text" ? (l.text += txt) : ex.parts.push({ kind: "text", text: txt });
              } else {
                mm.set(mid, { id: mid, role: "user", parts: [{ kind: "text", text: txt }], streaming: false });
                mo.push(mid);
              }
            } else if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") {
              const txt = (u.content.text as string).replace(/<[a-z-]+>[\s\S]*?<\/[a-z-]+>/g, "").trim();
              if (!txt) return;
              const target = currentAssistant();
              const l = target.parts[target.parts.length - 1];
              l?.kind === "text" ? (l.text += txt) : target.parts.push({ kind: "text", text: txt });
            } else if (u.sessionUpdate === "tool_call") {
              const target = currentAssistant();
              const content = u.content?.map((c: any) => ({ type: c.type, text: c.text ?? c.content?.text })).filter((c: any) => c.text);
              target.parts.push({ kind: "tool", toolCallId: u.toolCallId, title: u.title, status: u.status, content });
            } else if (u.sessionUpdate === "tool_call_update") {
              for (const [, m] of mm) {
                const chip = m.parts.find((p): p is ToolChipT => p.kind === "tool" && p.toolCallId === u.toolCallId);
                if (chip) {
                  if (u.status) chip.status = u.status;
                  if (u.title) chip.title = u.title;
                  if (u.content) chip.content = u.content.map((c: any) => ({ type: c.type, text: c.text ?? c.content?.text })).filter((c: any) => c.text);
                  break;
                }
              }
            }
          },
        );
        await connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
          },
        });
        await connection.loadSession({
          sessionId: sid,
          cwd: ".",
          mcpServers: selectedMcpServers,
        });
        ws.close();
      } catch {}
      setMessages(mo.map((id) => mm.get(id)!));
      setLoadingSession(false);
      setBusy(false);
    },
    [
      selectedInstance,
      selectedMcpServers,
      setBusy,
      setLoadingSession,
      setMessages,
      setSessionId,
    ],
  );

  const openFileHandler = useCallback(
    async (path: string) => {
      if (!instanceTrpc) return;
      if (openFile?.path === path) {
        setOpenFile(null);
        return;
      }
      try {
        const d = await instanceTrpc.files.read.query({ path });
        if (d.content !== undefined) {
          setOpenFile({ path: d.path, content: d.content });
          setRightTab("files");
        }
      } catch {}
    },
    [instanceTrpc, openFile, setOpenFile],
  );

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy || !selectedInstance) return;
    setInput("");
    setBusy(true);
    const uMsg: Message = {
      id: crypto.randomUUID(),
      role: "user",
      parts: [{ kind: "text", text }],
      streaming: false,
    };
    const aId = crypto.randomUUID();
    const aMsg: Message = {
      id: aId,
      role: "assistant",
      parts: [],
      streaming: true,
    };
    currentAssistantIdRef.current = aId;
    setMessages((p) => [...p, uMsg, aMsg]);
    addLog("prompt", { text });
    try {
      if (
        !connectionRef.current ||
        connectionRef.current.ws.readyState !== WebSocket.OPEN
      ) {
        const { connection, ws } = await openConnection(
          selectedInstance,
          (u) => {
            const aid = currentAssistantIdRef.current;
            if (!aid) return;
            if (
              u.sessionUpdate === "agent_message_chunk" &&
              u.content.type === "text"
            ) {
              setMessages((p) =>
                p.map((m) => {
                  if (m.id !== aid) return m;
                  const parts = [...m.parts];
                  const l = parts[parts.length - 1];
                  l?.kind === "text"
                    ? (parts[parts.length - 1] = {
                        kind: "text",
                        text: l.text + u.content.text,
                      })
                    : parts.push({ kind: "text", text: u.content.text });
                  return { ...m, parts };
                }),
              );
              addLog("text", { text: u.content.text });
            } else if (u.sessionUpdate === "tool_call") {
              const content = u.content?.map((c: any) => ({ type: c.type, text: c.text ?? c.content?.text })).filter((c: any) => c.text);
              setMessages((p) =>
                p.map((m) =>
                  m.id === aid
                    ? { ...m, parts: [...m.parts, { kind: "tool", toolCallId: u.toolCallId, title: u.title, status: u.status, content } as ToolChipT] }
                    : m,
                ),
              );
              addLog("tool", { title: u.title, status: u.status });
            } else if (u.sessionUpdate === "tool_call_update") {
              const newContent = u.content?.map((c: any) => ({ type: c.type, text: c.text ?? c.content?.text })).filter((c: any) => c.text);
              setMessages((p) =>
                p.map((m) => {
                  if (m.id !== aid) return m;
                  const parts = m.parts.map((part) =>
                    part.kind === "tool" && part.toolCallId === u.toolCallId
                      ? {
                          ...part,
                          status: u.status ?? part.status,
                          title: u.title ?? part.title,
                          content: newContent?.length ? newContent : part.content,
                        }
                      : part,
                  );
                  return { ...m, parts };
                }),
              );
            }
          },
        );
        await connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
          },
        });
        ws.onclose = () => {
          connectionRef.current = null;
        };
        connectionRef.current = { connection, ws };
      }
      const conn = connectionRef.current!.connection;
      if (!activeSessionIdRef.current) {
        if (sessionId) {
          await conn.unstable_resumeSession({
            sessionId,
            cwd: ".",
            mcpServers: selectedMcpServers,
          });
          activeSessionIdRef.current = sessionId;
        } else {
          const s = await conn.newSession({
            cwd: ".",
            mcpServers: selectedMcpServers,
          });
          setSessionId(s.sessionId);
          activeSessionIdRef.current = s.sessionId;
          addLog("session", { sessionId: s.sessionId });
          platform.sessions.create.mutate({ sessionId: s.sessionId, instanceId: selectedInstance }).catch(() => {});
        }
      }
      const r = await conn.prompt({
        sessionId: activeSessionIdRef.current!,
        prompt: [{ type: "text", text }],
      });
      setMessages((p) =>
        p.map((m) => (m.id === aId ? { ...m, streaming: false } : m)),
      );
      addLog("done", { stopReason: r.stopReason });
    } catch (err: any) {
      const errMsg = err?.message ?? String(err);
      addLog("error", { message: errMsg });
      setMessages((p) =>
        p.map((m) =>
          m.id === aId
            ? { ...m, streaming: false, parts: [{ kind: "text" as const, text: errMsg }] }
            : m,
        ),
      );
      connectionRef.current?.ws.close();
      connectionRef.current = null;
      activeSessionIdRef.current = null;
    } finally {
      setBusy(false);
      fetchSessions();
      textareaRef.current?.focus();
    }
  }, [
    input,
    busy,
    selectedInstance,
    sessionId,
    selectedMcpServers,
    addLog,
    setBusy,
    setMessages,
    setSessionId,
    fetchSessions,
  ]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="flex h-screen bg-bg relative overflow-hidden">
      <div className="blob blob-1" />
      <div className="blob blob-2" />
      <div className="blob blob-3" />
      {/* ── Left: Sessions ── */}
      <div style={{ width: leftW }} className="shrink-0 flex flex-col border-r border-border-light bg-surface/50 backdrop-blur-xl overflow-hidden relative z-10">
        <SessionsSidebar onResumeSession={resumeSession} onRefresh={fetchSessions} />
      </div>
      <ResizeHandle side="left" onResize={d => setLeftW(w => { const v = Math.max(140, Math.min(400, w + d)); localStorage.setItem("humr-left-w", String(v)); return v; })} />

      {/* ── Main chat column ── */}
      <div className="flex flex-1 flex-col min-w-0">
        {/* Header */}
        <header className="flex items-center gap-4 px-5 h-11 border-b border-border-light bg-surface/50 backdrop-blur-xl shrink-0">
          <button
            className="flex items-center gap-1 text-[13px] font-medium text-text-secondary hover:text-accent transition-colors"
            onClick={() => { connectionRef.current?.ws.close(); connectionRef.current = null; activeSessionIdRef.current = null; goBack(); }}
          >
            <ArrowLeft size={14} /> Agents
          </button>
          <span className="w-px h-4 bg-border-light" />
          <h1 className="text-[14px] font-bold text-text">{selectedInstance}</h1>
          {sessionId && (
            <button
              className="btn-brutal ml-auto h-7 rounded-lg border border-border-light px-3 text-[11px] font-semibold text-text-secondary hover:text-accent hover:border-accent flex items-center gap-1"
              onClick={() => { connectionRef.current?.ws.close(); connectionRef.current = null; activeSessionIdRef.current = null; setSessionId(null); setMessages([]); }}
            >
              <Plus size={12} /> New Session
            </button>
          )}
          <div className={`${sessionId ? "" : "ml-auto"} flex items-center gap-2`}>
            {(() => {
              const inst = instances.find(i => i.id === selectedInstance);
              const state = inst ? instanceState(inst) : ("starting" as const);
              const label = busy ? "Busy" : stateLabel[state];
              const color = busy ? "bg-warning-light text-warning border-warning" : badgeColors[state];
              const dot = busy ? "bg-warning anim-pulse" : dotColors[state];
              return (
                <span className={`inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.03em] border rounded-full px-2.5 py-0.5 ${color}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
                  {label}
                </span>
              );
            })()}
          </div>
        </header>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[760px] px-8 py-8 flex flex-col gap-6">
            {loadingSession && (
              <div className="py-20 flex items-center justify-center gap-3 text-[14px] text-text-muted">
                <span className="w-5 h-5 rounded-full border-2 border-border-light border-t-accent anim-spin" />
                Loading session...
              </div>
            )}
            {!loadingSession && messages.length === 0 && (
              <div className="py-24 text-center">
                <p className="text-[16px] font-bold text-text mb-2">Start a conversation</p>
                <p className="text-[14px] text-text-muted">Send a message to begin a new session with this agent</p>
              </div>
            )}

            {messages.map((m) => (
              <div key={m.id} className={`flex flex-col gap-1 anim-in ${m.role === "user" ? "items-end" : "items-start"}`}>
                <span className="text-[11px] font-bold uppercase tracking-[0.05em] text-text-muted mb-0.5">
                  {m.role === "user" ? "You" : "Agent"}
                </span>
                <div className={m.role === "user"
                  ? "rounded-xl rounded-br-sm border border-accent/30 bg-accent-light px-5 py-3 text-[14px] text-text max-w-[620px]"
                  : "flex flex-col gap-2 max-w-full"
                }>
                  {m.parts.map((p, i) =>
                    p.kind === "text" ? (
                      m.role === "assistant" ? <Markdown key={i} onFileClick={openFileHandler}>{p.text}</Markdown> : (
                        <span key={i} className="whitespace-pre-wrap break-words">
                          {p.text}
                          {m.streaming && i === m.parts.length - 1 && <span className="inline-block w-[7px] h-4 bg-accent ml-0.5 align-text-bottom anim-blink rounded-sm" />}
                        </span>
                      )
                    ) : <ToolChip key={i} chip={p} />
                  )}
                  {m.streaming && m.parts.length === 0 && <span className="inline-block w-[7px] h-4 bg-accent anim-blink rounded-sm" />}
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
        </div>

        {/* Input */}
        <div className="border-t border-border-light bg-surface/50 backdrop-blur-xl px-8 py-4 shrink-0">
          <div className="mx-auto max-w-[760px] flex items-end gap-3">
            <textarea
              ref={textareaRef}
              className="flex-1 rounded-lg border border-border-light bg-bg px-4 py-3 text-[14px] text-text outline-none resize-none min-h-[44px] max-h-[180px] overflow-y-auto transition-all focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-glow)] placeholder:text-text-muted disabled:opacity-40"
              value={input} onChange={e => setInput(e.target.value)} onKeyDown={onKeyDown}
              placeholder="Message agent... (Enter to send)" rows={1} disabled={busy}
            />
            <button
              className="btn-brutal h-[44px] rounded-lg border-2 border-accent-hover bg-accent px-6 text-[13px] font-bold text-white disabled:opacity-40 shrink-0 flex items-center gap-1.5"
              style={{ boxShadow: "var(--shadow-brutal-accent)" }}
              onClick={send} disabled={busy || !input.trim()}
            >
              {busy ? "..." : <><SendIcon size={14} /> Send</>}
            </button>
          </div>
        </div>
      </div>

      {/* ── Right: Files/Log/Schedules ── */}
      <ResizeHandle side="right" onResize={d => setRightW(w => { const v = Math.max(240, Math.min(600, w + d)); localStorage.setItem("humr-right-w", String(v)); return v; })} />
      <div style={{ width: rightW }} className="shrink-0 flex flex-col border-l border-border-light bg-surface/50 backdrop-blur-xl overflow-hidden relative z-10">
        <div className="flex border-b border-border-light shrink-0">
          {(["files", "log", "schedules", "channels", "mcps"] as const).map(tab => (
            <button key={tab} onClick={() => setRightTab(tab)}
              className={`flex-1 h-9 text-[11px] font-bold uppercase tracking-[0.05em] border-b-2 transition-colors ${rightTab === tab ? "text-accent border-accent bg-accent-light" : "text-text-muted border-transparent hover:text-text-secondary"}`}>
              {tab}
            </button>
          ))}
        </div>
        <div className="flex flex-1 flex-col overflow-hidden">
          {rightTab === "files" && <FilesPanel onOpenFile={openFileHandler} />}
          {rightTab === "log" && <LogPanel />}
          {rightTab === "schedules" && <SchedulesPanel onResumeSession={resumeSession} />}
          {rightTab === "channels" && <ChannelsPanel />}
          {rightTab === "mcps" && (
            <McpsPanel
              options={mcpOptions}
              enabled={enabledMcps}
              onToggle={toggleMcp}
              onSelectAll={selectAllMcps}
              onClearAll={clearAllMcps}
              hasActiveSession={!!sessionId}
              accessMode={access?.mode ?? null}
            />
          )}
        </div>
      </div>
    </div>
  );
}
