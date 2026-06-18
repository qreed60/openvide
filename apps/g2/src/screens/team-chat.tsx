import { useEffect, useState, useRef } from 'react';
import { useSearchParams } from 'react-router';
import { Select } from 'even-toolkit/web';
import { ProviderBadge } from '../components/chat/provider-badge';
import { ChatBubble } from '../components/chat/chat-bubble';
import { ChatInput } from '../components/chat/chat-input';
import { rpc } from '../domain/daemon-client';
import { usePullRefresh } from '../hooks/use-pull-refresh';

interface TeamMessageSummary {
  id: string;
  from: string;
  fromTool?: string;
  to: string;
  text: string;
  createdAt: string;
  orchestration?: {
    runId: string;
    teamId: string;
    status: 'completed' | 'blocked' | 'failed';
    route: string[];
    routeSummary: string;
    timeline: Array<{
      memberName?: string;
      role?: string;
      tool?: string;
      model?: string;
      status?: 'started' | 'completed' | 'blocked' | 'failed';
      durationMs?: number;
      summary?: string;
    }>;
  };
}

interface OrchestratorRunSummary {
  runId: string;
  teamId: string;
  status: 'running' | 'completed' | 'blocked' | 'failed';
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  route: string[];
  routeSummary: string;
  eventCount: number;
  summary?: string;
}

interface OrchestratorRunEventSummary {
  id: string;
  type: string;
  timestamp: string;
  memberName?: string;
  role?: string;
  tool?: string;
  model?: string;
  status?: 'started' | 'completed' | 'blocked' | 'failed';
  durationMs?: number;
  summary?: string;
}

interface OrchestratorRunDetails {
  summary: OrchestratorRunSummary;
  events: OrchestratorRunEventSummary[];
  route: string[];
  routeSummary: string;
  members: Array<{
    name: string;
    role?: string;
    tool?: string;
    model?: string;
  }>;
}

function formatRecipient(to: string): string {
  if (to === '*' || to === 'team') return 'team';
  if (to === 'user' || to === 'you') return 'you';
  return to;
}

function sameMessages(a: TeamMessageSummary[], b: TeamMessageSummary[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (!left || !right) return false;
    if (
      left.id !== right.id
      || left.from !== right.from
      || left.to !== right.to
      || left.text !== right.text
      || left.createdAt !== right.createdAt
      || left.fromTool !== right.fromTool
      || JSON.stringify(left.orchestration ?? null) !== JSON.stringify(right.orchestration ?? null)
    ) {
      return false;
    }
  }
  return true;
}

function formatDuration(durationMs?: number): string {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) return '';
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
}

function formatAge(iso?: string): string {
  if (!iso) return '';
  const epoch = Date.parse(iso);
  if (!Number.isFinite(epoch)) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - epoch) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function statusClass(status?: string): string {
  if (status === 'failed') return 'border-red-500/30 bg-red-500/10 text-red-300';
  if (status === 'blocked') return 'border-amber-500/30 bg-amber-500/10 text-amber-300';
  if (status === 'running' || status === 'started') return 'border-[#4285F4]/30 bg-[#4285F4]/10 text-[#8AB4F8]';
  if (!status) return 'border-border bg-surface text-text-dim';
  return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300';
}

function eventBorderClass(event: { status?: string; memberName?: string }): string {
  if (event.status === 'failed') return 'border-red-500/40 bg-red-500/10';
  if (event.status === 'blocked' || !event.memberName) return 'border-amber-500/40 bg-amber-500/10';
  return 'border-border/70 bg-surface/60';
}

function routeText(route: string[], routeSummary?: string): string {
  if (route.length > 0) return route.join(' \u2192 ');
  return (routeSummary ?? '').replace(/ -> /g, ' \u2192 ');
}

function providerModel(tool?: string, model?: string): string {
  if (!tool && !model) return '';
  if (!model) return tool ?? '';
  if (!tool) return model;
  return `${tool} / ${model}`;
}

function OrchestrationDetails({ orchestration }: { orchestration: NonNullable<TeamMessageSummary['orchestration']> }) {
  const routeSummary = routeText(orchestration.route, orchestration.routeSummary);

  return (
    <div className="mt-2 w-full rounded-[6px] border border-border bg-bg/40 px-3 py-2 text-[12px] tracking-[-0.12px] text-text-dim">
      <div className="flex flex-wrap items-center gap-2">
        <span className="data-mono text-text">{routeSummary || 'Team orchestration'}</span>
        <span className={`rounded-[4px] border px-1.5 py-0.5 data-mono uppercase ${statusClass(orchestration.status)}`}>
          {orchestration.status}
        </span>
      </div>
      {orchestration.timeline.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer select-none data-mono text-text-dim">Timeline</summary>
          <div className="mt-2 flex flex-col gap-1.5">
            {orchestration.timeline.map((event, index) => (
              <div key={`${event.memberName ?? 'member'}-${index}`} className={`rounded-[6px] border px-2 py-1.5 ${eventBorderClass(event)}`}>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className={`data-mono ${event.memberName ? 'text-text' : 'text-amber-300'}`}>{event.memberName ?? 'Unknown member'}</span>
                  {event.role && <span>{event.role}</span>}
                  {(event.tool || event.model) && (
                    <span className="text-text-dim">
                      {providerModel(event.tool, event.model)}
                    </span>
                  )}
                  {event.durationMs != null && <span>{formatDuration(event.durationMs)}</span>}
                  {event.status && (
                    <span className={`rounded-[4px] border px-1.5 py-0.5 data-mono uppercase ${statusClass(event.status)}`}>
                      {event.status}
                    </span>
                  )}
                </div>
                {event.summary && (
                  <div className="mt-1 line-clamp-2 text-text-dim">{event.summary}</div>
                )}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function RecentRunsPanel({
  runs,
  expandedRunId,
  detailsByRunId,
  onToggle,
}: {
  runs: OrchestratorRunSummary[];
  expandedRunId: string | null;
  detailsByRunId: Record<string, OrchestratorRunDetails | undefined>;
  onToggle: (runId: string) => void;
}) {
  if (runs.length === 0) return null;

  return (
    <div className="rounded-[6px] border border-border bg-bg/70 px-3 py-2 text-[12px] tracking-[-0.12px] text-text-dim">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="data-mono text-text">Recent runs</span>
        <span>{runs.length}</span>
      </div>
      <div className="flex flex-col gap-1.5">
        {runs.map((run) => {
          const expanded = expandedRunId === run.runId;
          const details = detailsByRunId[run.runId];
          const routeSummary = routeText(run.route, run.routeSummary) || 'Team orchestration';
          const duration = formatDuration(run.durationMs);
          return (
            <div key={run.runId} className="rounded-[6px] border border-border/70 bg-surface/50">
              <button
                type="button"
                className="flex w-full cursor-pointer items-center gap-2 border-none bg-transparent px-2 py-1.5 text-left"
                onClick={() => onToggle(run.runId)}
              >
                <span className="min-w-0 flex-1 truncate data-mono text-text">{routeSummary}</span>
                {duration && <span className="shrink-0 text-text-dim">{duration}</span>}
                <span className={`shrink-0 rounded-[4px] border px-1.5 py-0.5 data-mono uppercase ${statusClass(run.status)}`}>
                  {run.status}
                </span>
              </button>
              <div className="flex items-center gap-2 px-2 pb-1.5 text-[11px] tracking-[-0.11px]">
                <span>{formatAge(run.finishedAt ?? run.startedAt)}</span>
                <span>{run.eventCount} events</span>
              </div>
              {expanded && (
                <div className="border-t border-border/70 px-2 py-1.5">
                  {!details && <p className="status-breathe-fast">Loading details...</p>}
                  {details && (
                    <div className="flex flex-col gap-1.5">
                      {details.members.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {details.members.map((member) => (
                            <span key={member.name} className="rounded-[4px] bg-bg px-1.5 py-0.5">
                              {member.name}{member.role ? ` · ${member.role}` : ''}{providerModel(member.tool, member.model) ? ` · ${providerModel(member.tool, member.model)}` : ''}
                            </span>
                          ))}
                        </div>
                      )}
                      {details.events.map((event) => (
                        <div key={event.id} className={`rounded-[6px] border px-2 py-1.5 ${eventBorderClass(event)}`}>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className={`data-mono ${event.memberName ? 'text-text' : 'text-amber-300'}`}>{event.memberName ?? 'Unknown member'}</span>
                            <span>{event.type.replace(/_/g, ' ')}</span>
                            {providerModel(event.tool, event.model) && <span>{providerModel(event.tool, event.model)}</span>}
                            {event.durationMs != null && <span>{formatDuration(event.durationMs)}</span>}
                            {event.status && (
                              <span className={`rounded-[4px] border px-1.5 py-0.5 data-mono uppercase ${statusClass(event.status)}`}>
                                {event.status}
                              </span>
                            )}
                          </div>
                          {event.summary && <div className="mt-1 line-clamp-2">{event.summary}</div>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function TeamChatRoute() {
  const [params] = useSearchParams();
  const teamId = params.get('id') ?? '';
  const [messages, setMessages] = useState<TeamMessageSummary[]>([]);
  const [recipient, setRecipient] = useState('*');
  const [recipients, setRecipients] = useState<Array<{ value: string; label: string }>>([{ value: '*', label: 'Team' }]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [recentRuns, setRecentRuns] = useState<OrchestratorRunSummary[]>([]);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [runDetailsById, setRunDetailsById] = useState<Record<string, OrchestratorRunDetails | undefined>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const refresh = async () => {
    try {
      const res = await rpc('team.message.list', { teamId, limit: 50 });
      if (res.ok && Array.isArray(res.teamMessages)) {
        const nextMessages = res.teamMessages as TeamMessageSummary[];
        setMessages((current) => (sameMessages(current, nextMessages) ? current : nextMessages));
      }
    } catch { /* ignore */ }
    setLoading(false);
  };

  const refreshRuns = async () => {
    try {
      const res = await rpc('team.orchestrator.runs.list', { teamId, limit: 5 });
      if (res.ok && Array.isArray(res.orchestratorRuns)) {
        setRecentRuns(res.orchestratorRuns as OrchestratorRunSummary[]);
      }
    } catch { /* ignore */ }
  };

  const toggleRun = async (runId: string) => {
    const nextRunId = expandedRunId === runId ? null : runId;
    setExpandedRunId(nextRunId);
    if (!nextRunId || runDetailsById[nextRunId]) return;
    try {
      const res = await rpc('team.orchestrator.run.get', { runId: nextRunId });
      if (res.ok && res.orchestratorRun) {
        setRunDetailsById((current) => ({
          ...current,
          [nextRunId]: res.orchestratorRun as OrchestratorRunDetails,
        }));
      }
    } catch { /* ignore */ }
  };

  useEffect(() => {
    if (!teamId) return;
    refresh();
    refreshRuns();
    const interval = setInterval(refresh, 3000);
    const runsInterval = setInterval(refreshRuns, 5000);
    return () => {
      clearInterval(interval);
      clearInterval(runsInterval);
    };
  }, [teamId]);

  useEffect(() => {
    if (!teamId) return;
    rpc('team.get', { teamId }).then((res) => {
      if (!res.ok || !res.team) return;
      const team = res.team as { members?: Array<{ name: string }> };
      const next = [{ value: '*', label: 'Team' }];
      for (const member of team.members ?? []) {
        next.push({ value: member.name, label: member.name });
      }
      setRecipients(next);
    }).catch(() => {});
  }, [teamId]);

  useEffect(() => {
    if (!autoScroll) return;
    bottomRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [autoScroll, messages]);

  const handleSend = async () => {
    if (!draft.trim() || sending) return;
    setSending(true);
    try {
      await rpc('team.message.send', { teamId, to: recipient, text: draft.trim() });
      setDraft('');
      await Promise.all([refresh(), refreshRuns()]);
    } catch { /* ignore */ }
    setSending(false);
  };

  const refreshAll = async () => {
    await Promise.all([refresh(), refreshRuns()]);
  };

  const { pullHandlers, PullIndicator } = usePullRefresh(refreshAll);

  const AI_TOOLS = ['claude', 'codex', 'gemini'];
  const isUserMessage = (msg: TeamMessageSummary) => {
    if (msg.from === 'user' || msg.from === 'you') return true;
    if (msg.fromTool && AI_TOOLS.includes(msg.fromTool)) return false;
    // Infer from sender name: if it matches a known AI tool, treat as AI
    if (AI_TOOLS.includes(msg.from.toLowerCase())) return false;
    // Default: messages without fromTool from unknown senders are user messages
    return !msg.fromTool;
  };

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAutoScroll(distanceFromBottom < 80);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-y-auto px-3 py-4 flex flex-col gap-4"
        {...pullHandlers}
      >
        <PullIndicator />
        <RecentRunsPanel
          runs={recentRuns}
          expandedRunId={expandedRunId}
          detailsByRunId={runDetailsById}
          onToggle={toggleRun}
        />

        {loading && (
          <p className="text-[13px] tracking-[-0.13px] text-text-dim text-center py-6 status-breathe-fast">Loading...</p>
        )}

        {!loading && messages.length === 0 && (
          <div className="flex flex-1 flex-col items-center justify-center py-15 text-center text-text-dim">
            <div className="text-[40px] mb-4 opacity-30">{'\u{1F4AC}'}</div>
            <div className="text-[15px] tracking-[-0.15px] font-normal text-text mb-1.5">No messages yet</div>
            <div className="text-[13px] tracking-[-0.13px]">Start the conversation with your team</div>
          </div>
        )}

        {messages.map((msg) => {
          const isUser = isUserMessage(msg);
          return (
            <div key={msg.id} className={`msg-enter flex flex-col ${isUser ? 'items-end' : 'items-start'}`}>
              {!isUser && (
                <div className="flex items-center gap-1.5 mb-1 ml-1">
                  <ProviderBadge provider={(msg.fromTool || 'claude') as 'claude' | 'codex' | 'gemini'} size={18} />
                  <span className="data-mono">{msg.from}</span>
                  <span className="text-[11px] tracking-[-0.11px] text-text-dim">{'\u2192'} {formatRecipient(msg.to)}</span>
                </div>
              )}
              <ChatBubble
                role={isUser ? 'user' : 'assistant'}
                tool={msg.fromTool || msg.from}
                timestamp={new Date(msg.createdAt).getTime()}
              >
                {msg.text}
              </ChatBubble>
              {!isUser && msg.orchestration && (
                <OrchestrationDetails orchestration={msg.orchestration} />
              )}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <div className="shrink-0 px-3 pb-3 pt-2 border-t border-border bg-bg">
        <div className="mb-2">
          <Select value={recipient} options={recipients} onValueChange={setRecipient} dropdownPosition="top" />
        </div>
        <ChatInput
          value={draft}
          onChange={setDraft}
          onSend={handleSend}
          isRunning={sending}
          placeholder="Type a message to the team..."
        />
      </div>
    </div>
  );
}
