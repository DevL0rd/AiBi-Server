import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  Bot,
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  Cpu,
  KeyRound,
  ListChecks,
  MessageCircle,
  Mic,
  Minus,
  Pencil,
  PlaySquare,
  PlugZap,
  Radio,
  RefreshCw,
  Save,
  Search,
  Settings,
  Sparkles,
  Square,
  Terminal,
  ToggleLeft,
  Trash2,
  Volume2,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import "./styles.css";

const fallbackApi = {
  getSnapshot: async () => ({
    settings: { mode: "local" },
    events: [],
    chatMessages: [],
    models: [],
    capabilities: { actions: [], animations: [] },
  }),
  saveSettings: async (settings) => settings,
  setMode: async (mode) => ({ mode }),
  getModels: async () => [],
  refreshModels: async () => [],
  startProxy: async () => ({ running: false }),
  stopProxy: async () => ({ running: false }),
  clearConsoleEvents: async () => ({ eventsCleared: 0 }),
  clearChatLog: async () => ({ cleared: 0 }),
  updateChatMessage: async (id, content) => ({ id, content }),
  deleteChatMessage: async () => ({}),
  getChatMedia: async () => null,
  minimizeWindow: async () => {},
  toggleMaximizeWindow: async () => {},
  closeWindow: async () => {},
  onEvent: () => () => {},
};

const api = window.aibi || fallbackApi;

function App() {
  const [events, setEvents] = useState([]);
  const [chatMessages, setChatMessages] = useState([]);
  const [settings, setSettings] = useState({});
  const [models, setModels] = useState([]);
  const [capabilities, setCapabilities] = useState({ actions: [], animations: [] });
  const [tab, setTab] = useState("chat");
  const [draft, setDraft] = useState({});
  const [proxyRunning, setProxyRunning] = useState(true);
  const [settingsSaveState, setSettingsSaveState] = useState("saved");
  const settingsDirtyRef = useRef(false);
  const settingsSaveTimerRef = useRef(null);
  const settingsSaveSeqRef = useRef(0);
  const pendingSettingsPatchRef = useRef({});

  useEffect(() => {
    api.getSnapshot().then((snapshot) => {
      setEvents(snapshot.events || []);
      setChatMessages(snapshot.chatMessages || []);
      setSettings(snapshot.settings || {});
      setDraft(snapshot.settings || {});
      setModels(snapshot.models || []);
      setCapabilities(snapshot.capabilities || { actions: [], animations: [] });
    });

    const unsubscribe = api.onEvent((message) => {
      if (message.kind === "event") setEvents((current) => [message.event, ...current].slice(0, 100));
      if (message.kind === "events_cleared") setEvents([]);
      if (message.kind === "chat_message") {
        setChatMessages((current) => upsertById(current, message.message));
      }
      if (message.kind === "chat_message_deleted") {
        setChatMessages((current) => current.filter((item) => item.id !== message.id));
      }
      if (message.kind === "chat_log_cleared") setChatMessages([]);
      if (message.kind === "settings") {
        setSettings(message.settings);
        if (!settingsDirtyRef.current) setDraft(message.settings);
      }
      if (message.kind === "models") setModels(message.models || []);
      if (message.kind === "status") setProxyRunning(Boolean(message.status.running));
    });

    return () => {
      unsubscribe?.();
      if (settingsSaveTimerRef.current) clearTimeout(settingsSaveTimerRef.current);
    };
  }, []);

  const mode = settings.mode || "passthrough";
  const visibleEvents = useMemo(() => events.filter((event) => [
    "voice_request",
    "speech_response",
    "action",
    "override_response",
    "local_response",
    "http_message",
    "mode",
    "warning",
    "firmware_capture",
    "chat_mode_start",
    "chat_mode_end",
    "proactive_reachout",
    "robot_status",
  ].includes(event.type)), [events]);

  async function switchMode(nextMode) {
    const next = await api.setMode(nextMode);
    setSettings(next);
    setDraft(next);
  }

  function updateSetting(key, value) {
    setDraft((current) => ({ ...current, [key]: value }));
    pendingSettingsPatchRef.current = { ...pendingSettingsPatchRef.current, [key]: value };
    settingsDirtyRef.current = true;
    setSettingsSaveState("saving");

    if (settingsSaveTimerRef.current) clearTimeout(settingsSaveTimerRef.current);
    const sequence = settingsSaveSeqRef.current + 1;
    settingsSaveSeqRef.current = sequence;
    settingsSaveTimerRef.current = setTimeout(async () => {
      settingsSaveTimerRef.current = null;
      const patch = pendingSettingsPatchRef.current;
      pendingSettingsPatchRef.current = {};

      try {
        const next = await api.saveSettings(patch);
        if (sequence !== settingsSaveSeqRef.current) return;
        settingsDirtyRef.current = false;
        setSettings(next);
        setDraft(next);
        setSettingsSaveState("saved");
      } catch {
        pendingSettingsPatchRef.current = { ...patch, ...pendingSettingsPatchRef.current };
        if (sequence === settingsSaveSeqRef.current) setSettingsSaveState("error");
      }
    }, 350);
  }

  async function clearConsoleEvents() {
    await api.clearConsoleEvents();
    setEvents([]);
  }

  async function clearChatLog() {
    await api.clearChatLog();
    setChatMessages([]);
  }

  async function updateChatMessage(id, content) {
    const message = await api.updateChatMessage(id, content);
    if (message) setChatMessages((current) => upsertById(current, message));
  }

  async function deleteChatMessage(id) {
    await api.deleteChatMessage(id);
    setChatMessages((current) => current.filter((item) => item.id !== id));
  }

  return (
    <main className="dark h-screen overflow-hidden bg-background text-foreground">
      <div className="flex h-full flex-col bg-background">
        <Titlebar mode={mode} setMode={switchMode} proxyRunning={proxyRunning} />
        <div className="grid min-h-0 flex-1 grid-cols-[244px_minmax(0,1fr)]">
        <Sidebar
          tab={tab}
          setTab={setTab}
          proxyRunning={proxyRunning}
        />

        <section className="h-full min-w-0 overflow-hidden p-5">
          <div className="relative h-full min-h-0">
            <TabPanel active={tab === "chat"}>
              <ChatLogView
                messages={chatMessages}
                clearChatLog={clearChatLog}
                updateChatMessage={updateChatMessage}
                deleteChatMessage={deleteChatMessage}
              />
            </TabPanel>
            <TabPanel active={tab === "console"}>
              <ConsoleView
                events={visibleEvents}
                mode={mode}
                clearConsoleEvents={clearConsoleEvents}
              />
            </TabPanel>
            <TabPanel active={tab === "capabilities"}>
            <CapabilitiesView
              actions={capabilities.actions || []}
              disabledIds={draft.disabledCapabilityIds || []}
              updateSetting={updateSetting}
              saveState={settingsSaveState}
            />
            </TabPanel>
            <TabPanel active={tab === "animations"}>
              <AnimationsView
                animations={capabilities.animations || []}
                disabledIds={draft.disabledAnimationIds || []}
                updateSetting={updateSetting}
                saveState={settingsSaveState}
              />
            </TabPanel>
            <TabPanel active={tab === "settings"}>
              <SettingsView
                draft={draft}
                updateSetting={updateSetting}
                saveState={settingsSaveState}
                models={models}
                setModels={setModels}
              />
            </TabPanel>
          </div>
        </section>
        </div>
      </div>
    </main>
  );
}

function TabPanel({ active, children }) {
  return (
    <div
      className={cn(
        "absolute inset-0 h-full min-h-0",
        active ? "visible" : "invisible pointer-events-none"
      )}
      aria-hidden={!active}
    >
      {children}
    </div>
  );
}

function Titlebar({ mode, setMode, proxyRunning }) {
  const serverEnabled = mode === "local";

  return (
    <header className="drag-region flex h-11 shrink-0 items-center border-b border-border bg-background pl-4 text-sm">
      <div className="flex min-w-0 items-center gap-3">
        <div className="grid size-6 place-items-center rounded-md border border-cyan-400 bg-secondary text-cyan-200">
          <Bot size={15} />
        </div>
        <div className="truncate font-medium">AIBI Server</div>
        <Badge variant="outline" className="h-5 border-border text-[11px] text-muted-foreground">
          {proxyRunning ? "Bridge running" : "Bridge stopped"}
        </Badge>
      </div>

      <div className="no-drag ml-auto flex h-full items-center">
        <div className="mr-3 flex items-center gap-2 rounded-lg border border-border bg-card px-2 py-1">
          <span className="text-xs text-muted-foreground">AIBI Server</span>
          <Label className="gap-2 text-xs text-foreground">
            Enable
            <Switch
              size="sm"
              checked={serverEnabled}
              onCheckedChange={(checked) => setMode(checked ? "local" : "passthrough")}
            />
          </Label>
        </div>
        <WindowButton label="Minimize" onClick={() => api.minimizeWindow()}>
          <Minus className="size-4" />
        </WindowButton>
        <WindowButton label="Maximize" onClick={() => api.toggleMaximizeWindow()}>
          <Square className="size-3.5" />
        </WindowButton>
        <WindowButton label="Close" danger onClick={() => api.closeWindow()}>
          <X className="size-4" />
        </WindowButton>
      </div>
    </header>
  );
}

function WindowButton({ label, danger = false, children, onClick }) {
  return (
    <button
      type="button"
      className={cn(
        "grid h-11 w-12 place-items-center text-muted-foreground hover:bg-muted hover:text-foreground",
        danger && "hover:bg-red-500 hover:text-white"
      )}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Sidebar({ tab, setTab, proxyRunning }) {
  return (
    <aside className="flex min-h-0 flex-col border-r border-border bg-sidebar p-4 text-sidebar-foreground">
      <div className="flex items-center gap-3 px-1 py-2">
        <div className="grid size-10 place-items-center rounded-xl border border-cyan-400 bg-secondary text-cyan-200">
          <Bot size={22} />
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold tracking-wide">AIBI Server</div>
          <div className="truncate text-xs text-muted-foreground">{proxyRunning ? "Bridge running" : "Bridge stopped"}</div>
        </div>
      </div>

      <nav className="mt-6 grid gap-1">
        <NavButton active={tab === "chat"} onClick={() => setTab("chat")} icon={<MessageCircle />}>
          Chat Log
        </NavButton>
        <NavButton active={tab === "capabilities"} onClick={() => setTab("capabilities")} icon={<ListChecks />}>
          Capabilities
        </NavButton>
        <NavButton active={tab === "animations"} onClick={() => setTab("animations")} icon={<PlaySquare />}>
          Animations
        </NavButton>
        <NavButton active={tab === "console"} onClick={() => setTab("console")} icon={<Terminal />}>
          Console
        </NavButton>
        <NavButton active={tab === "settings"} onClick={() => setTab("settings")} icon={<Settings />}>
          Settings
        </NavButton>
      </nav>
    </aside>
  );
}

function NavButton({ active, icon, children, ...props }) {
  return (
    <Button
      variant={active ? "secondary" : "ghost"}
      className={cn(
        "h-10 justify-start gap-3 px-3",
        active && "bg-secondary text-foreground ring-1 ring-cyan-400"
      )}
      {...props}
    >
      {React.cloneElement(icon, { className: "size-4" })}
      {children}
    </Button>
  );
}

function ConsoleView({ events, mode, clearConsoleEvents }) {
  const chatMode = getChatModeState(events);
  const lastReachout = events.find((event) => event.type === "proactive_reachout");
  const httpCount = events.filter((event) => event.type === "http_message").length;

  return (
    <section className="flex h-full min-h-0 flex-col gap-4">
      <PageHeader
        icon={<Terminal size={20} />}
        title="Console"
        description={mode === "local" ? "Override responses are active." : "Official responses are passing through."}
        actions={(
          <ClearButton onClick={clearConsoleEvents} />
        )}
      />

      <div className="grid grid-cols-3 gap-3">
        <MetricCard icon={<Activity />} label="Events" value={String(events.length)} />
        <MetricCard icon={<MessageCircle />} label="Chat" value={chatMode ? "Active" : "Standing by"} />
        <MetricCard icon={<Radio />} label="HTTP / Reachout" value={httpCount ? `${httpCount} HTTP` : lastReachout ? "Reachout seen" : "Waiting"} />
      </div>

      <Card className="min-h-0 flex-1 gap-0 overflow-hidden border-border bg-card py-0">
        <div className="grid grid-cols-[32px_92px_140px_minmax(0,1fr)_minmax(110px,0.45fr)] gap-3 border-b border-border bg-muted px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          <span />
          <span>Time</span>
          <span>Kind</span>
          <span>Event</span>
          <span className="text-right">Signal</span>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-1.5 p-2">
            {events.length === 0 ? (
              <EmptyState icon={<Sparkles />} title="No events yet" description="Ask AIBI something." />
            ) : events.map((event) => <ConsoleEvent key={event.id} event={event} />)}
          </div>
        </ScrollArea>
      </Card>
    </section>
  );
}

function ClearButton({ onClick }) {
  return (
    <Button variant="outline" className="min-w-24 justify-center" onClick={onClick}>
      <Trash2 />
      Clear
    </Button>
  );
}

function PageHeader({ icon, title, description, actions }) {
  return (
    <Card className="border-border bg-card py-0">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid size-11 place-items-center rounded-xl border border-cyan-400 bg-secondary text-cyan-200">
            {icon}
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{title}</h1>
            <p className="mt-1 truncate text-sm text-muted-foreground">{description}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      </div>
    </Card>
  );
}

function MetricCard({ icon, label, value }) {
  return (
    <Card size="sm" className="border-border bg-card">
      <CardContent className="flex items-center gap-3 py-0">
        <div className="grid size-9 place-items-center rounded-lg bg-secondary text-cyan-200">
          {React.cloneElement(icon, { className: "size-4" })}
        </div>
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="truncate text-sm font-medium">{value}</div>
        </div>
      </CardContent>
    </Card>
  );
}

function EmptyState({ icon, title, description }) {
  return (
    <div className="grid min-h-64 place-items-center rounded-xl border border-dashed border-border bg-background p-8 text-center">
      <div>
        <div className="mx-auto mb-3 grid size-10 place-items-center rounded-xl bg-muted text-muted-foreground">
          {React.cloneElement(icon, { className: "size-5" })}
        </div>
        <div className="text-sm font-medium">{title}</div>
        <div className="mt-1 text-sm text-muted-foreground">{description}</div>
      </div>
    </div>
  );
}

function ConsoleEvent({ event }) {
  const [expanded, setExpanded] = useState(false);
  const icon = getEventIcon(event);
  const view = getEventView(event);
  const payload = event.payload || {};
  const detailSections = getEventDetailSections(event);
  const canExpand = detailSections.length > 0;
  const tone = getEventTone(event.type);

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <div className="overflow-hidden rounded-lg border border-border bg-background">
        <CollapsibleTrigger
          disabled={!canExpand}
          className="grid min-h-10 w-full grid-cols-[32px_92px_140px_minmax(0,1fr)_minmax(110px,0.45fr)] items-center gap-3 px-3 py-1.5 text-left hover:bg-muted disabled:cursor-default"
        >
          <span className="grid size-6 place-items-center rounded-md border border-border text-muted-foreground">
            {canExpand ? expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" /> : null}
          </span>
          <span className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
            <Clock3 className="size-3" />
            {formatEventTime(event.created_at)}
          </span>
          <span className="flex min-w-0 items-center gap-2">
            <span className={cn("grid size-6 shrink-0 place-items-center rounded-md text-slate-950", tone.icon)}>
              {icon}
            </span>
            <span className="truncate text-xs font-medium capitalize text-muted-foreground">{formatEventType(event.type)}</span>
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{view.title}</span>
            {view.detail && <span className="block truncate text-xs text-muted-foreground">{view.detail}</span>}
          </span>
          <span className="flex min-w-0 justify-end gap-1.5">
            {view.primaryChip && <Badge className="max-w-full truncate bg-cyan-400 text-slate-950">{view.primaryChip}</Badge>}
            {view.secondaryChip && <Badge variant="outline" className="max-w-full truncate">{view.secondaryChip}</Badge>}
            {!view.primaryChip && payload.connectionId && <Badge variant="outline">#{payload.connectionId}</Badge>}
          </span>
        </CollapsibleTrigger>
        {canExpand && (
          <CollapsibleContent>
            <div className="grid gap-2 border-t border-border bg-muted p-3 lg:grid-cols-3">
              {detailSections.map((section) => (
                <section className="min-w-0 rounded-lg border border-border bg-background p-3" key={section.title}>
                  <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{section.title}</h3>
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground/85">
                    {formatDetailValue(section.value)}
                  </pre>
                </section>
              ))}
            </div>
          </CollapsibleContent>
        )}
      </div>
    </Collapsible>
  );
}

function ChatLogView({ messages, clearChatLog, updateChatMessage, deleteChatMessage }) {
  const sortedMessages = useMemo(() => [...messages].sort((a, b) => b.id - a.id), [messages]);

  return (
    <section className="flex h-full min-h-0 flex-col gap-4">
      <PageHeader
        icon={<MessageCircle size={20} />}
        title="Chat Log"
        description="Only messages kept in the override conversation context."
        actions={(
          <ClearButton onClick={clearChatLog} />
        )}
      />

      <Card className="min-h-0 flex-1 gap-0 overflow-hidden border-border bg-card py-0">
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-3 p-3">
            {messages.length === 0 ? (
              <EmptyState icon={<MessageCircle />} title="No chat messages" description="Override turns will appear here." />
            ) : sortedMessages.map((message) => (
              <ChatMessageRow
                key={message.id}
                message={message}
                onUpdate={updateChatMessage}
                onDelete={deleteChatMessage}
              />
            ))}
          </div>
        </ScrollArea>
      </Card>
    </section>
  );
}

function ChatMessageRow({ message, onUpdate, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content || "");
  const media = message.payload?.media || [];

  useEffect(() => {
    if (!editing) setDraft(message.content || "");
  }, [message.content, editing]);

  async function save() {
    await onUpdate(message.id, draft);
    setEditing(false);
  }

  return (
    <Card className="border-border bg-background">
      <CardContent className="space-y-3 py-0">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Badge className={cn(
                "capitalize",
                message.role === "assistant" ? "bg-cyan-400 text-slate-950" : "bg-emerald-300 text-slate-950"
              )}>
                {message.role}
              </Badge>
              <span className="font-mono text-xs text-muted-foreground">{formatEventTime(message.created_at)}</span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {editing ? (
              <>
                <Button size="sm" onClick={save}><Save /> Save</Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(false)}><X /> Cancel</Button>
              </>
            ) : (
              <>
                <Button size="icon-sm" variant="ghost" onClick={() => setEditing(true)} title="Edit message">
                  <Pencil />
                </Button>
                <Button size="icon-sm" variant="ghost" className="text-red-300 hover:bg-red-500 hover:text-white" onClick={() => onDelete(message.id)} title="Delete message">
                  <Trash2 />
                </Button>
              </>
            )}
          </div>
        </div>

        {editing ? (
          <Textarea className="min-h-28" value={draft} onChange={(event) => setDraft(event.target.value)} />
        ) : (
          <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground/90">
            {message.content}
          </div>
        )}

        {media.length > 0 && (
          <div className="grid gap-2 sm:grid-cols-2">
            {media.map((item) => <ChatMedia key={item.path} media={item} />)}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ChatMedia({ media }) {
  const [source, setSource] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setSource("");
    setError("");
    api.getChatMedia(media.path).then((result) => {
      if (cancelled || !result?.data) return;
      setSource(`data:${result.contentType || media.mimeType};base64,${result.data}`);
    }).catch((err) => {
      if (!cancelled) setError(err.message || "media unavailable");
    });
    return () => {
      cancelled = true;
    };
  }, [media.path, media.mimeType]);

  return (
    <div className="rounded-lg border border-border bg-muted p-2">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="truncate text-xs text-muted-foreground">{media.label || media.type}</span>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{formatBytes(media.bytes)}</span>
      </div>
      {error ? (
        <div className="text-xs text-red-300">{error}</div>
      ) : !source ? (
        <div className="text-xs text-muted-foreground">Loading media...</div>
      ) : media.type === "image" ? (
        <img className="max-h-72 w-full rounded-md object-contain" src={source} alt={media.label || "chat image"} />
      ) : media.type === "audio" ? (
        <audio className="w-full" controls src={source} />
      ) : (
        <a className="text-xs text-cyan-300 underline" href={source}>Open media</a>
      )}
    </div>
  );
}

function CapabilitiesView({ actions, disabledIds, updateSetting, saveState }) {
  const [query, setQuery] = useState("");
  const disabled = useMemo(() => new Set(disabledIds), [disabledIds]);
  const visibleActions = useMemo(() => filterCapabilityRows(actions, query), [actions, query]);
  const enabledCount = actions.length - disabled.size;

  function setEnabled(id, enabled) {
    const next = new Set(disabledIds);
    if (enabled) next.delete(id);
    else next.add(id);
    updateSetting("disabledCapabilityIds", [...next].sort());
  }

  return (
    <CatalogView
      icon={<ListChecks size={20} />}
      title="Capabilities"
      description={`${enabledCount} enabled / ${actions.length} total native actions.`}
      saveState={saveState}
      query={query}
      setQuery={setQuery}
      emptyTitle="No capabilities"
      emptyDescription="No matching native actions."
    >
      {visibleActions.map((action) => (
        <CapabilityToggleRow
          key={action.id}
          id={action.id}
          title={action.id}
          description={action.description}
          detail={action.instructions}
          params={action.valid_params}
          enabled={!disabled.has(action.id)}
          onEnabledChange={(enabled) => setEnabled(action.id, enabled)}
        />
      ))}
    </CatalogView>
  );
}

function AnimationsView({ animations, disabledIds, updateSetting, saveState }) {
  const [query, setQuery] = useState("");
  const disabled = useMemo(() => new Set(disabledIds), [disabledIds]);
  const visibleAnimations = useMemo(() => filterCapabilityRows(animations, query), [animations, query]);
  const enabledCount = animations.length - disabled.size;

  function setEnabled(id, enabled) {
    const next = new Set(disabledIds);
    if (enabled) next.delete(id);
    else next.add(id);
    updateSetting("disabledAnimationIds", [...next].sort());
  }

  return (
    <CatalogView
      icon={<PlaySquare size={20} />}
      title="Animations"
      description={`${enabledCount} enabled / ${animations.length} total animation IDs.`}
      saveState={saveState}
      query={query}
      setQuery={setQuery}
      emptyTitle="No animations"
      emptyDescription="No matching animation IDs."
    >
      {visibleAnimations.map((animation) => (
        <CapabilityToggleRow
          key={animation.id}
          id={animation.id}
          title={animation.id}
          enabled={!disabled.has(animation.id)}
          onEnabledChange={(enabled) => setEnabled(animation.id, enabled)}
        />
      ))}
    </CatalogView>
  );
}

function CatalogView({ icon, title, description, saveState, query, setQuery, emptyTitle, emptyDescription, children }) {
  const rows = React.Children.toArray(children);

  return (
    <section className="flex h-full min-h-0 flex-col gap-4">
      <PageHeader
        icon={icon}
        title={title}
        description={description}
        actions={<AutosaveStatus state={saveState} />}
      />

      <Card className="min-h-0 flex-1 gap-0 overflow-hidden border-border bg-card py-0">
        <div className="border-b border-border p-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search ${title.toLowerCase()}`}
            />
          </div>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="grid gap-2 p-3">
            {rows.length ? rows : <EmptyState icon={icon} title={emptyTitle} description={emptyDescription} />}
          </div>
        </ScrollArea>
      </Card>
    </section>
  );
}

function CapabilityToggleRow({
  id,
  title,
  description = "",
  detail = "",
  params = null,
  enabled,
  onEnabledChange,
}) {
  return (
    <div className={cn(
      "grid gap-3 rounded-lg border border-border bg-background p-3 sm:grid-cols-[minmax(0,1fr)_auto]",
      !enabled && "opacity-55"
    )}>
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate font-mono text-sm font-medium">{title}</span>
          <Badge variant={enabled ? "default" : "outline"} className={enabled ? "bg-emerald-300 text-slate-950" : ""}>
            {enabled ? "Enabled" : "Disabled"}
          </Badge>
        </div>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
        {detail && <p className="mt-1 text-xs text-muted-foreground">{detail}</p>}
        {params && Object.keys(params).length > 0 && (
          <pre className="mt-2 max-h-32 overflow-auto rounded-md border border-border bg-muted p-2 font-mono text-[11px] leading-relaxed text-foreground/80">
            {formatDetailValue(params)}
          </pre>
        )}
      </div>
      <div className="grid gap-2 sm:min-w-36">
        <span className="text-right text-xs text-muted-foreground">{id}</span>
        <label className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted px-2 py-1.5 text-xs">
          Enabled
          <Switch checked={enabled} onCheckedChange={onEnabledChange} />
        </label>
      </div>
    </div>
  );
}

function SettingsView({ draft, updateSetting, saveState, models, setModels }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  async function selectModel(modelId) {
    updateSetting("openRouterModel", modelId);
    setPickerOpen(false);
  }

  async function refreshModels() {
    setRefreshing(true);
    try {
      const next = await api.refreshModels();
      setModels(next || []);
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <section className="flex h-full min-h-0 flex-col gap-4">
      <PageHeader
        icon={<Settings size={20} />}
        title="Settings"
        description="Keys, model selection, voice, and AIBI personality stay local on this machine."
        actions={<AutosaveStatus state={saveState} />}
      />

      <ScrollArea className="min-h-0 flex-1">
        <div className="grid gap-4 pb-4 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.8fr)]">
          <div className="space-y-4">
            <SettingsSection
              icon={<BrainCircuit />}
              title="AI Provider"
              description="Model and API credentials used by override mode."
            >
              <ModelField
                value={draft.openRouterModel || ""}
                models={models}
                onOpen={() => setPickerOpen(true)}
                onRefresh={refreshModels}
                refreshing={refreshing}
              />
              <SettingField
                icon={<KeyRound />}
                label="OpenRouter API Key"
                value={draft.openRouterApiKey || ""}
                onChange={(v) => updateSetting("openRouterApiKey", v)}
                password
              />
            </SettingsSection>

            <SettingsSection
              icon={<Volume2 />}
              title="Voice"
              description="Speech generation and transcription service credentials."
            >
              <SettingField
                icon={<KeyRound />}
                label="Fish Audio API Key"
                value={draft.fishApiKey || ""}
                onChange={(v) => updateSetting("fishApiKey", v)}
                password
              />
              <SettingField
                icon={<Volume2 />}
                label="Fish Voice ID"
                value={draft.fishVoiceId || ""}
                onChange={(v) => updateSetting("fishVoiceId", v)}
              />
            </SettingsSection>
          </div>

          <div className="space-y-4">
            <SettingsSection
              icon={<Bot />}
              title="AIBI"
              description="AIBI personality and response behavior used by override responses."
            >
              <TextareaSetting
                icon={<Bot />}
                label="Personality Prompt"
                value={draft.personalityPrompt || ""}
                onChange={(v) => updateSetting("personalityPrompt", v)}
              />
              <SettingField
                icon={<Sparkles />}
                label="Fallback Reply"
                value={draft.localTextFallback || ""}
                onChange={(v) => updateSetting("localTextFallback", v)}
              />
              <SwitchSetting
                icon={<ToggleLeft />}
                label="Action After Speech"
                checked={Boolean(draft.actionAfterSpeech)}
                onChange={(v) => updateSetting("actionAfterSpeech", v)}
              />
            </SettingsSection>
          </div>
        </div>
      </ScrollArea>

      <ModelPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        models={models}
        selected={draft.openRouterModel || ""}
        onSelect={selectModel}
        onRefresh={refreshModels}
        refreshing={refreshing}
      />
    </section>
  );
}

function AutosaveStatus({ state }) {
  if (state === "saving") {
    return (
      <Badge variant="outline" className="gap-1.5 border-cyan-400 text-cyan-200">
        <RefreshCw className="size-3 animate-spin" />
        Saving
      </Badge>
    );
  }

  if (state === "error") {
    return (
      <Badge variant="outline" className="border-red-400 text-red-200">
        Save failed
      </Badge>
    );
  }

  return (
    <Badge variant="outline" className="gap-1.5 border-emerald-400 text-emerald-200">
      <Check className="size-3" />
      Saved
    </Badge>
  );
}

function SettingsSection({ icon, title, description, children }) {
  return (
    <Card className="border-border bg-card">
      <CardHeader>
        <div className="flex items-start gap-3">
          <div className="grid size-9 place-items-center rounded-lg bg-secondary text-cyan-200">
            {React.cloneElement(icon, { className: "size-4" })}
          </div>
          <div>
            <CardTitle>{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {children}
      </CardContent>
    </Card>
  );
}

function ModelField({ value, models, onOpen, onRefresh, refreshing }) {
  const selected = models.find((model) => model.id === value);
  return (
    <div className="space-y-2">
      <Label><Cpu className="size-4" /> OpenRouter Model</Label>
      <div className="grid grid-cols-[minmax(0,1fr)_36px] gap-2">
        <Button variant="outline" className="h-auto min-w-0 justify-start px-3 py-2 text-left" onClick={onOpen}>
          <span className="min-w-0">
            <span className="block truncate text-sm">{selected?.name || value || "Choose a model"}</span>
            <span className="block truncate text-xs text-muted-foreground">{value || `${models.length} models available`}</span>
          </span>
        </Button>
        <Button variant="outline" size="icon" onClick={onRefresh} disabled={refreshing} title="Refresh models">
          <RefreshCw className={cn(refreshing && "animate-spin")} />
        </Button>
      </div>
    </div>
  );
}

function SettingField({ icon, label, value, onChange, password = false }) {
  return (
    <div className="space-y-2">
      <Label>{React.cloneElement(icon, { className: "size-4" })} {label}</Label>
      <Input type={password ? "password" : "text"} value={value} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}

function TextareaSetting({ icon, label, value, onChange }) {
  return (
    <div className="space-y-2">
      <Label>{React.cloneElement(icon, { className: "size-4" })} {label}</Label>
      <Textarea className="min-h-36 resize-y" value={value} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}

function SwitchSetting({ icon, label, checked, onChange }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-background p-3">
      <Label>{React.cloneElement(icon, { className: "size-4" })} {label}</Label>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function ModelPicker({ open, onOpenChange, models, selected, onSelect, onRefresh, refreshing }) {
  const [query, setQuery] = useState("");
  const filteredModels = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return models.slice(0, 120);
    return models
      .filter((model) => `${model.id} ${model.name} ${model.provider} ${model.description}`.toLowerCase().includes(needle))
      .slice(0, 120);
  }, [models, query]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl overflow-hidden p-0" showCloseButton>
        <DialogHeader className="border-b border-border p-4 pb-3">
          <div className="flex items-start justify-between gap-4">
            <div>
              <DialogTitle>Choose Model</DialogTitle>
              <DialogDescription>{models.length} models synced from OpenRouter</DialogDescription>
            </div>
            <Button variant="outline" size="sm" onClick={onRefresh} disabled={refreshing}>
              <RefreshCw className={cn(refreshing && "animate-spin")} />
              Refresh
            </Button>
          </div>
        </DialogHeader>
        <Command className="rounded-none" shouldFilter={false}>
          <CommandInput value={query} onValueChange={setQuery} placeholder="Search models" />
          <CommandList className="max-h-[520px]">
            <CommandEmpty>No matching models.</CommandEmpty>
            <CommandGroup>
              {filteredModels.map((model) => (
                <CommandItem
                  key={model.id}
                  value={`${model.id} ${model.name} ${model.provider} ${model.description}`}
                  data-checked={selected === model.id}
                  onSelect={() => onSelect(model.id)}
                  className="items-start gap-3 py-2"
                >
                  <BrainCircuit className="mt-0.5 size-4 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{model.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">{model.id}</span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {model.contextLength ? `${model.contextLength.toLocaleString()} ctx` : "ctx unknown"}
                  </span>
                  {selected === model.id && <Check className="mt-0.5 size-4 text-cyan-300" />}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

function formatEventTime(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "--:--:--";
  return date.toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatEventType(type) {
  return String(type || "event").replaceAll("_", " ");
}

function getEventIcon(event) {
  if (event.type === "voice_request") return <Mic className="size-3.5" />;
  if (event.type === "warning") return <PlugZap className="size-3.5" />;
  if (event.type === "http_message") return <Terminal className="size-3.5" />;
  if (event.type === "firmware_capture") return <Search className="size-3.5" />;
  if (event.type === "chat_mode_start" || event.type === "chat_mode_end") return <MessageCircle className="size-3.5" />;
  if (event.type === "proactive_reachout") return <Radio className="size-3.5" />;
  if (event.type === "robot_status") return <Activity className="size-3.5" />;
  if (event.type === "speech_response" || event.type === "override_response" || event.type === "local_response") return <MessageCircle className="size-3.5" />;
  if (event.type === "action") return <Activity className="size-3.5" />;
  return <Volume2 className="size-3.5" />;
}

function getEventTone(type) {
  if (type === "warning") return { icon: "bg-rose-300" };
  if (type === "http_message") return { icon: "bg-cyan-300" };
  if (type === "firmware_capture") return { icon: "bg-violet-300" };
  if (type === "action") return { icon: "bg-emerald-300" };
  if (type === "proactive_reachout") return { icon: "bg-amber-300" };
  return { icon: "bg-slate-300" };
}

function getEventView(event) {
  const payload = event.payload || {};
  if (event.type === "http_message") return getHttpEventView(event);
  if (event.type === "firmware_capture") {
    return {
      title: event.title || "Firmware capture",
      detail: event.detail,
      primaryChip: payload.kind || "Capture",
      secondaryChip: payload.version,
    };
  }
  if (event.type === "chat_mode_start") {
    return { title: "Chat mode started", detail: event.detail, primaryChip: "Continuous", secondaryChip: "Chat" };
  }
  if (event.type === "chat_mode_end") {
    return { title: "Chat mode ended", detail: event.detail, primaryChip: "Listening", secondaryChip: "Chat" };
  }
  if (event.type === "proactive_reachout") {
    return { title: "Proactive reachout", detail: event.detail, primaryChip: "AIBI started", secondaryChip: "Voice" };
  }
  if (event.type === "robot_status") {
    return { title: "AIBI status", detail: event.detail, primaryChip: "Status" };
  }
  if (event.type === "voice_request" && payload.chatMode) {
    return { title: "Conversation turn", detail: event.detail, primaryChip: "Chat mode" };
  }
  if (payload.behavior === "ability_chatgpt" && payload.chatModeType === "connect") {
    return { title: "Chat mode started", detail: event.detail, primaryChip: "Continuous", secondaryChip: "Chat" };
  }
  if (payload.behavior === "ability_chatgpt" && payload.chatModeType === "quit") {
    return { title: "Chat mode ended", detail: event.detail, primaryChip: "Listening", secondaryChip: "Chat" };
  }
  return {
    title: event.title,
    detail: event.detail,
    primaryChip: payload.behavior,
    secondaryChip: payload.intent,
  };
}

function getHttpEventView(event) {
  const payload = event.payload || {};
  const body = payload.body || {};
  return {
    title: payload.startLine || event.title || "HTTP message",
    detail: getHttpBodyPreview(body) || event.detail,
    primaryChip: [payload.side, payload.kind].filter(Boolean).join(" / "),
    secondaryChip: getHeaderValue(payload.headers, "content-type") || (body.bytes ? `${body.bytes} bytes` : ""),
  };
}

function getHttpBodyPreview(body) {
  if (!body) return "";
  if (body.kind === "binary") return `${body.bytes || 0} bytes ${body.contentType || "binary"}`.trim();
  if (body.kind === "decode_error") return body.error || "Body decode failed";
  if (body.kind !== "text" || !body.text) return "";
  const parsed = parseJson(body.text);
  const result = parsed?.queryResult || parsed;
  const parts = [
    result?.queryText,
    result?.rec_behavior,
    result?.intent?.name,
    typeof result?.behavior_paras === "object" ? result.behavior_paras?.txt : "",
  ].filter(Boolean);
  return (parts.join(" | ") || body.text).slice(0, 220);
}

function getHeaderValue(headers, name) {
  if (!headers) return "";
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  const value = key ? headers[key] : "";
  return Array.isArray(value) ? value.join(", ") : value;
}

function getEventDetailSections(event) {
  const payload = event.payload || {};
  const sections = [{
    title: "Event",
    value: {
      id: event.id,
      type: event.type,
      title: event.title,
      detail: event.detail,
      created_at: event.created_at,
    },
  }];

  if (event.type === "http_message") {
    sections.push({
      title: "Request / Response",
      value: {
        connectionId: payload.connectionId,
        side: payload.side,
        kind: payload.kind,
        startLine: payload.startLine,
        headers: payload.headers,
      },
    });
    if (payload.body) {
      sections.push({ title: "Body", value: formatHttpBody(payload.body) });
    }
  }

  if (Object.keys(payload).length > 0) {
    sections.push({ title: "Payload", value: payload });
  }

  return sections;
}

function formatHttpBody(body) {
  if (body.kind === "text") {
    return parseJson(body.text) || body.text || "";
  }
  return body;
}

function parseJson(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function formatDetailValue(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function filterCapabilityRows(rows, query) {
  const needle = query.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((row) => [
    row.id,
    row.description,
    row.instructions,
    formatDetailValue(row.valid_params || {}),
  ].filter(Boolean).join(" ").toLowerCase().includes(needle));
}

function getChatModeState(events) {
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.type === "chat_mode_start") return true;
    if (event.type === "chat_mode_end") return false;
    if (event.payload?.behavior === "ability_chatgpt" && event.payload?.chatModeType === "connect") return true;
    if (event.payload?.behavior === "ability_chatgpt" && event.payload?.chatModeType === "quit") return false;
  }
  return false;
}

function upsertById(items, item) {
  if (!item?.id) return items;
  const index = items.findIndex((current) => current.id === item.id);
  if (index === -1) return [...items, item].sort((a, b) => b.id - a.id);
  const next = [...items];
  next[index] = item;
  return next.sort((a, b) => b.id - a.id);
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

createRoot(document.getElementById("root")).render(<App />);
