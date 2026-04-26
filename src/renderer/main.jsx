import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Activity, Bot, BrainCircuit, Check, History, KeyRound, Library, MessageCircle, Mic, PlugZap, Radio, RefreshCw, Search, Settings, Sparkles, ToggleLeft, Volume2, X } from "lucide-react";
import "./styles.css";

const fallbackApi = {
  getSnapshot: async () => ({
    settings: { mode: "passthrough" },
    events: [],
    learned: { behaviors: [], animations: [] },
    models: [],
  }),
  saveSettings: async (settings) => settings,
  setMode: async (mode) => ({ mode }),
  getModels: async () => [],
  refreshModels: async () => [],
  startProxy: async () => ({ running: false }),
  stopProxy: async () => ({ running: false }),
  resetChatHistory: async () => ({ cleared: 0 }),
  onEvent: () => () => {},
};

const api = window.aibi || fallbackApi;

function App() {
  const [events, setEvents] = useState([]);
  const [settings, setSettings] = useState({});
  const [learned, setLearned] = useState({ behaviors: [], animations: [] });
  const [models, setModels] = useState([]);
  const [tab, setTab] = useState("feed");
  const [draft, setDraft] = useState({});
  const [proxyRunning, setProxyRunning] = useState(true);

  useEffect(() => {
    api.getSnapshot().then((snapshot) => {
      setEvents(snapshot.events || []);
      setSettings(snapshot.settings || {});
      setDraft(snapshot.settings || {});
      setLearned(snapshot.learned || { behaviors: [], animations: [] });
      setModels(snapshot.models || []);
    });

    return api.onEvent((message) => {
      if (message.kind === "event") setEvents((current) => [message.event, ...current].slice(0, 100));
      if (message.kind === "settings") {
        setSettings(message.settings);
        setDraft(message.settings);
      }
      if (message.kind === "models") setModels(message.models || []);
      if (message.kind === "status") setProxyRunning(Boolean(message.status.running));
    });
  }, []);

  const mode = settings.mode || "passthrough";
  const visibleEvents = useMemo(() => events.filter((event) => [
    "voice_request",
    "speech_response",
    "action",
    "local_response",
    "mode",
    "warning",
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

  async function saveSettings() {
    const next = await api.saveSettings(draft);
    setSettings(next);
    setDraft(next);
  }

  async function resetChatHistory() {
    const result = await api.resetChatHistory();
    setEvents(result?.event ? [result.event] : []);
  }

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brandMark"><Bot size={24} /></div>
          <div>
            <strong>AiBi Console</strong>
            <span>{proxyRunning ? "Robot bridge active" : "Bridge paused"}</span>
          </div>
        </div>

        <nav className="nav">
          <button className={tab === "feed" ? "active" : ""} onClick={() => setTab("feed")}><Mic size={18} /> Feed</button>
          <button className={tab === "learned" ? "active" : ""} onClick={() => setTab("learned")}><Library size={18} /> Learned</button>
          <button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}><Settings size={18} /> Settings</button>
        </nav>

        <div className="modeCard">
          <span>Mode</span>
          <div className="segmented">
            <button className={mode === "passthrough" ? "selected" : ""} onClick={() => switchMode("passthrough")}>Learn</button>
            <button className={mode === "local" ? "selected" : ""} onClick={() => switchMode("local")}>Local</button>
          </div>
        </div>
      </aside>

      <section className="content">
        {tab === "feed" && <Feed events={visibleEvents} mode={mode} resetChatHistory={resetChatHistory} />}
        {tab === "learned" && <Learned learned={learned} />}
        {tab === "settings" && (
          <SettingsView
            draft={draft}
            setDraft={setDraft}
            saveSettings={saveSettings}
            models={models}
            setModels={setModels}
          />
        )}
      </section>
    </main>
  );
}

function Feed({ events, mode, resetChatHistory }) {
  const chatMode = getChatModeState(events);
  const lastReachout = events.find((event) => event.type === "proactive_reachout");

  return (
    <section className="panel">
      <header className="topbar">
        <div>
          <h1>Conversation</h1>
          <p>{mode === "local" ? "Local AI is answering the robot." : "Real server responses are being learned."}</p>
        </div>
        <div className="statusGroup">
          <button className="toolbarButton" onClick={resetChatHistory} title="Reset chat history"><History size={16} /> Reset</button>
          <div className={`status ${mode}`}>{mode === "local" ? <BrainCircuit size={16} /> : <PlugZap size={16} />} {mode === "local" ? "Local AI" : "Learning"}</div>
          <div className={`status ${chatMode ? "chatting" : ""}`}><MessageCircle size={16} /> {chatMode ? "Chat mode" : "Wake word"}</div>
        </div>
      </header>

      <div className="stateRow">
        <StateTile icon={<MessageCircle size={18} />} label="Chat Mode" value={chatMode ? "Active" : "Standing by"} />
        <StateTile icon={<Radio size={18} />} label="Proactive Reachout" value={lastReachout ? "Seen" : "Waiting"} />
      </div>

      <div className="timeline">
        {events.length === 0 ? (
          <div className="empty">
            <Sparkles size={34} />
            <span>Ask the robot something.</span>
          </div>
        ) : events.map((event) => <TimelineEvent key={event.id} event={event} />)}
      </div>
    </section>
  );
}

function StateTile({ icon, label, value }) {
  return (
    <div className="stateTile">
      <span>{icon}</span>
      <div>
        <small>{label}</small>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

function TimelineEvent({ event }) {
  const icon = getEventIcon(event);
  const view = getEventView(event);
  return (
    <article className={`event ${event.type}`}>
      <div className="eventIcon">{icon}</div>
      <div>
        <div className="eventTitle">{view.title}</div>
        {view.detail && <div className="eventDetail">{view.detail}</div>}
        {view.primaryChip && <span className="chip">{view.primaryChip}</span>}
        {view.secondaryChip && <span className="chip muted">{view.secondaryChip}</span>}
      </div>
    </article>
  );
}

function getEventIcon(event) {
  if (event.type === "voice_request") return <Mic size={18} />;
  if (event.type === "warning") return <PlugZap size={18} />;
  if (event.type === "chat_mode_start" || event.type === "chat_mode_end") return <MessageCircle size={18} />;
  if (event.type === "proactive_reachout") return <Radio size={18} />;
  if (event.type === "robot_status") return <Activity size={18} />;
  if (event.type === "speech_response" || event.type === "local_response") return <MessageCircle size={18} />;
  if (event.type === "action") return <Activity size={18} />;
  return <Volume2 size={18} />;
}

function getEventView(event) {
  const payload = event.payload || {};
  if (event.type === "chat_mode_start") {
    return { title: "Chat mode started", detail: event.detail, primaryChip: "No wake word", secondaryChip: "Chat" };
  }
  if (event.type === "chat_mode_end") {
    return { title: "Chat mode ended", detail: event.detail, primaryChip: "Wake word", secondaryChip: "Chat" };
  }
  if (event.type === "proactive_reachout") {
    return { title: "Proactive reachout", detail: event.detail, primaryChip: "Robot started", secondaryChip: "Voice" };
  }
  if (event.type === "robot_status") {
    return { title: "Robot status", detail: event.detail, primaryChip: "Status" };
  }
  if (event.type === "voice_request" && payload.chatMode) {
    return { title: "Conversation turn", detail: event.detail, primaryChip: "Chat mode" };
  }
  if (payload.behavior === "ability_chatgpt" && payload.chatModeType === "connect") {
    return { title: "Chat mode started", detail: event.detail, primaryChip: "No wake word", secondaryChip: "Chat" };
  }
  if (payload.behavior === "ability_chatgpt" && payload.chatModeType === "quit") {
    return { title: "Chat mode ended", detail: event.detail, primaryChip: "Wake word", secondaryChip: "Chat" };
  }
  return {
    title: event.title,
    detail: event.detail,
    primaryChip: payload.behavior,
    secondaryChip: payload.intent,
  };
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

function Learned({ learned }) {
  return (
    <section className="panel">
      <header className="topbar">
        <div>
          <h1>Learned</h1>
          <p>Behavior patterns collected while the robot uses the original service.</p>
        </div>
      </header>

      <div className="gridTwo">
        <Catalog title="Actions" rows={learned.behaviors || []} empty="No actions learned yet." />
        <Catalog title="Animations" rows={learned.animations || []} empty="No animations learned yet." />
      </div>
    </section>
  );
}

function Catalog({ title, rows, empty }) {
  return (
    <div className="catalog">
      <h2>{title}</h2>
      {rows.length === 0 ? <p className="subtle">{empty}</p> : rows.map((row) => (
        <div className="catalogRow" key={`${title}-${row.name}`}>
          <span>{row.name}</span>
          <small>{row.seen_count} seen</small>
        </div>
      ))}
    </div>
  );
}

function SettingsView({ draft, setDraft, saveSettings, models, setModels }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const update = (key, value) => setDraft((current) => ({ ...current, [key]: value }));

  async function selectModel(modelId) {
    const nextDraft = { ...draft, openRouterModel: modelId };
    setDraft(nextDraft);
    await api.saveSettings(nextDraft);
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
    <section className="panel">
      <header className="topbar">
        <div>
          <h1>Settings</h1>
          <p>Keys stay local on this machine.</p>
        </div>
        <button className="primary" onClick={saveSettings}>Save</button>
      </header>

      <div className="settingsGrid">
        <Field icon={<KeyRound size={18} />} label="OpenRouter API Key" value={draft.openRouterApiKey || ""} onChange={(v) => update("openRouterApiKey", v)} password />
        <ModelField
          value={draft.openRouterModel || ""}
          models={models}
          onOpen={() => setPickerOpen(true)}
          onRefresh={refreshModels}
          refreshing={refreshing}
        />
        <Field icon={<KeyRound size={18} />} label="Fish Audio API Key" value={draft.fishApiKey || ""} onChange={(v) => update("fishApiKey", v)} password />
        <Field icon={<Volume2 size={18} />} label="Fish Voice ID" value={draft.fishVoiceId || ""} onChange={(v) => update("fishVoiceId", v)} />
        <Field icon={<Sparkles size={18} />} label="Fallback Reply" value={draft.localTextFallback || ""} onChange={(v) => update("localTextFallback", v)} />
        <ToggleField icon={<ToggleLeft size={18} />} label="Action After Speech" checked={Boolean(draft.actionAfterSpeech)} onChange={(v) => update("actionAfterSpeech", v)} />
      </div>

      {pickerOpen && (
        <ModelPicker
          models={models}
          selected={draft.openRouterModel || ""}
          onSelect={selectModel}
          onClose={() => setPickerOpen(false)}
          onRefresh={refreshModels}
          refreshing={refreshing}
        />
      )}
    </section>
  );
}

function ModelField({ value, models, onOpen, onRefresh, refreshing }) {
  const selected = models.find((model) => model.id === value);
  return (
    <div className="field modelField">
      <span><BrainCircuit size={18} /> OpenRouter Model</span>
      <button className="modelSelect" onClick={onOpen}>
        <strong>{selected?.name || value || "Choose a model"}</strong>
        <small>{value || `${models.length} models available`}</small>
      </button>
      <button className="iconButton" onClick={onRefresh} disabled={refreshing} title="Refresh models">
        <RefreshCw size={17} />
      </button>
    </div>
  );
}

function ModelPicker({ models, selected, onSelect, onClose, onRefresh, refreshing }) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return models.slice(0, 120);
    return models
      .filter((model) => `${model.id} ${model.name} ${model.provider} ${model.description}`.toLowerCase().includes(needle))
      .slice(0, 120);
  }, [models, query]);

  return (
    <div className="modalBackdrop">
      <section className="modelPicker">
        <header>
          <div>
            <h2>Choose Model</h2>
            <p>{models.length} models synced from OpenRouter</p>
          </div>
          <div className="modalActions">
            <button className="iconButton" onClick={onRefresh} disabled={refreshing} title="Refresh models"><RefreshCw size={17} /></button>
            <button className="iconButton" onClick={onClose} title="Close"><X size={18} /></button>
          </div>
        </header>

        <label className="searchBox">
          <Search size={18} />
          <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search models" />
        </label>

        <div className="modelList">
          {filtered.length === 0 ? (
            <div className="empty compact">No matching models.</div>
          ) : filtered.map((model) => (
            <button className="modelRow" key={model.id} onClick={() => onSelect(model.id)}>
              <div>
                <strong>{model.name}</strong>
                <small>{model.id}</small>
              </div>
              <div className="modelMeta">
                <span>{model.contextLength ? `${model.contextLength.toLocaleString()} ctx` : "ctx unknown"}</span>
                {selected === model.id && <Check size={18} />}
              </div>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function Field({ icon, label, value, onChange, password = false }) {
  return (
    <label className="field">
      <span>{icon} {label}</span>
      <input type={password ? "password" : "text"} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function ToggleField({ icon, label, checked, onChange }) {
  return (
    <label className="field toggleField">
      <span>{icon} {label}</span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

createRoot(document.getElementById("root")).render(<App />);
