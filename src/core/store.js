import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const capabilities = JSON.parse(fs.readFileSync(path.join(__dirname, "capabilities.json"), "utf8"));
const DEFAULT_DISABLED_ANIMATION_IDS = (capabilities.animations || [])
  .map((animation) => typeof animation === "string" ? animation : animation?.id)
  .filter(Boolean)
  .map(String);
const DEFAULT_DISABLED_CAPABILITY_IDS = ["interact_answer_with_animation", "interact_mood", "interact_greeting"];

const DEFAULT_SETTINGS = {
  mode: "local",
  openRouterApiKey: "",
  openRouterModel: "openai/gpt-5-mini",
  openRouterWebSearchEnabled: false,
  openRouterReasoningEnabled: false,
  openRouterReasoningEffort: "medium",
  openRouterTemperature: 0.7,
  openRouterMaxTokens: 900,
  fishApiKey: "",
  fishVoiceId: "",
  fishModel: "s2-pro",
  language: "en",
  personalityPrompt: "You are AIBI: warm, curious, playful, and concise. You feel like a small embodied desktop companion, not a generic assistant.",
  localTextFallback: "A error has occured.",
  actionAfterSpeech: false,
  disabledCapabilityIds: DEFAULT_DISABLED_CAPABILITY_IDS,
  disabledAnimationIds: DEFAULT_DISABLED_ANIMATION_IDS,
};

export class AppStore {
  constructor({ rootDir }) {
    this.rootDir = rootDir;
    this.db = new DatabaseSync(path.join(rootDir, "aibi.sqlite"));
    this.init();
  }

  init() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT,
        payload TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        payload TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS openrouter_models (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        context_length INTEGER,
        input_modalities TEXT,
        output_modalities TEXT,
        supported_parameters TEXT,
        prompt_price TEXT,
        completion_price TEXT,
        description TEXT,
        raw_payload TEXT NOT NULL,
        fetched_at TEXT NOT NULL
      );
    `);

    this.addColumnIfMissing("openrouter_models", "input_modalities", "TEXT");
    this.addColumnIfMissing("openrouter_models", "output_modalities", "TEXT");
    this.addColumnIfMissing("openrouter_models", "supported_parameters", "TEXT");
    this.dropLegacyCapabilityTables();

    const settings = this.getSettings();
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      if (settings[key] === undefined) this.setSetting(key, value);
    }
    this.migrateDefaultDisabledCapabilities(settings);
  }

  addColumnIfMissing(table, column, type) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((row) => row.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  dropLegacyCapabilityTables() {
    this.db.exec(`
      DROP TABLE IF EXISTS behaviors;
      DROP TABLE IF EXISTS animations;
    `);
  }

  migrateDefaultDisabledCapabilities(settings) {
    const disabledCapabilityIds = new Set(settings.disabledCapabilityIds || []);
    for (const id of DEFAULT_DISABLED_CAPABILITY_IDS) disabledCapabilityIds.add(id);
    if (disabledCapabilityIds.size !== (settings.disabledCapabilityIds || []).length) {
      this.setSetting("disabledCapabilityIds", [...disabledCapabilityIds].sort());
    }

    if (Array.isArray(settings.disabledAnimationIds) && settings.disabledAnimationIds.length === 0) {
      this.setSetting("disabledAnimationIds", DEFAULT_DISABLED_ANIMATION_IDS);
    }
  }

  getSettings() {
    const rows = this.db.prepare("SELECT key, value FROM settings").all();
    return rows.reduce((acc, row) => {
      try {
        acc[row.key] = JSON.parse(row.value);
      } catch {
        acc[row.key] = row.value;
      }
      return acc;
    }, {});
  }

  setSetting(key, value) {
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, JSON.stringify(value));
  }

  saveSettings(settings) {
    this.db.exec("BEGIN");
    try {
      for (const [key, value] of Object.entries(settings)) this.setSetting(key, value);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getSettings();
  }

  addEvent(event) {
    const row = {
      created_at: new Date().toISOString(),
      type: event.type,
      title: event.title,
      detail: event.detail || "",
      payload: JSON.stringify(event.payload || {}),
    };
    const result = this.db
      .prepare("INSERT INTO events (created_at, type, title, detail, payload) VALUES (?, ?, ?, ?, ?)")
      .run(row.created_at, row.type, row.title, row.detail, row.payload);
    return { id: Number(result.lastInsertRowid), ...row, payload: event.payload || {} };
  }

  getRecentEvents(limit = 80) {
    return this.db
      .prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?")
      .all(limit)
      .map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
  }

  clearEvents() {
    const result = this.db.prepare("DELETE FROM events").run();
    return result.changes || 0;
  }

  addChatMessage(message) {
    const row = {
      created_at: new Date().toISOString(),
      role: message.role,
      content: message.content || "",
      payload: JSON.stringify(message.payload || {}),
    };
    const result = this.db
      .prepare("INSERT INTO chat_messages (created_at, role, content, payload) VALUES (?, ?, ?, ?)")
      .run(row.created_at, row.role, row.content, row.payload);
    return { id: Number(result.lastInsertRowid), ...row, payload: message.payload || {} };
  }

  getChatMessages(limit = 200) {
    return this.db
      .prepare("SELECT * FROM chat_messages ORDER BY id DESC LIMIT ?")
      .all(limit)
      .reverse()
      .map((row) => ({ ...row, payload: safeJsonParse(row.payload, {}) }));
  }

  getChatMessage(id) {
    const row = this.db.prepare("SELECT * FROM chat_messages WHERE id = ?").get(id);
    return row ? { ...row, payload: safeJsonParse(row.payload, {}) } : null;
  }

  updateChatMessage(id, content) {
    this.db.prepare("UPDATE chat_messages SET content = ? WHERE id = ?").run(content || "", id);
    return this.getChatMessage(id);
  }

  updateChatMessagePayload(id, payload) {
    this.db.prepare("UPDATE chat_messages SET payload = ? WHERE id = ?").run(JSON.stringify(payload || {}), id);
    return this.getChatMessage(id);
  }

  deleteChatMessage(id) {
    const row = this.getChatMessage(id);
    if (!row) return null;
    this.db.prepare("DELETE FROM chat_messages WHERE id = ?").run(id);
    return row;
  }

  clearChatMessages() {
    const rows = this.getChatMessages(100000);
    const result = this.db.prepare("DELETE FROM chat_messages").run();
    return { rows, cleared: result.changes || 0 };
  }

  replaceOpenRouterModels(models) {
    const now = new Date().toISOString();
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM openrouter_models").run();
      const insert = this.db.prepare(`
        INSERT INTO openrouter_models (
          id,
          name,
          provider,
          context_length,
          input_modalities,
          output_modalities,
          supported_parameters,
          prompt_price,
          completion_price,
          description,
          raw_payload,
          fetched_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const model of models) {
        const architecture = model.architecture || {};
        const pricing = model.pricing || {};
        insert.run(
          model.id,
          model.name || model.id,
          model.id?.split("/")?.[0] || "",
          model.contextLength ?? model.context_length ?? null,
          JSON.stringify(arrayValue(architecture.inputModalities ?? architecture.input_modalities)),
          JSON.stringify(arrayValue(architecture.outputModalities ?? architecture.output_modalities)),
          JSON.stringify(arrayValue(model.supportedParameters ?? model.supported_parameters)),
          stringValue(pricing.prompt),
          stringValue(pricing.completion),
          model.description || "",
          JSON.stringify(model),
          now,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getOpenRouterModels();
  }

  getOpenRouterModels(limit = 1000) {
    return this.db
      .prepare(`
        SELECT
          id,
          name,
          provider,
          context_length AS contextLength,
          input_modalities AS inputModalitiesJson,
          output_modalities AS outputModalitiesJson,
          supported_parameters AS supportedParametersJson,
          prompt_price AS promptPrice,
          completion_price AS completionPrice,
          description,
          raw_payload AS rawPayload,
          fetched_at AS fetchedAt
        FROM openrouter_models
        ORDER BY provider ASC, name ASC
        LIMIT ?
      `)
      .all(limit)
      .map(parseModelRow);
  }

  getOpenRouterModel(id) {
    const row = this.db
      .prepare(`
        SELECT
          id,
          name,
          provider,
          context_length AS contextLength,
          input_modalities AS inputModalitiesJson,
          output_modalities AS outputModalitiesJson,
          supported_parameters AS supportedParametersJson,
          prompt_price AS promptPrice,
          completion_price AS completionPrice,
          description,
          raw_payload AS rawPayload,
          fetched_at AS fetchedAt
        FROM openrouter_models
        WHERE id = ?
      `)
      .get(id);
    return row ? parseModelRow(row) : null;
  }
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function parseModelRow(row) {
  const rawPayload = safeJsonParse(row.rawPayload, {});
  const rawArchitecture = rawPayload.architecture || {};
  const rawPricing = rawPayload.pricing || {};
  const inputModalities = parseJsonArray(row.inputModalitiesJson);
  const outputModalities = parseJsonArray(row.outputModalitiesJson);
  const supportedParameters = parseJsonArray(row.supportedParametersJson);
  const model = {
    ...row,
    contextLength: row.contextLength ?? rawPayload.contextLength ?? rawPayload.context_length ?? null,
    created: rawPayload.created ?? rawPayload.createdAt ?? rawPayload.created_at ?? null,
    inputModalities: inputModalities.length ? inputModalities : arrayValue(rawArchitecture.inputModalities ?? rawArchitecture.input_modalities),
    outputModalities: outputModalities.length ? outputModalities : arrayValue(rawArchitecture.outputModalities ?? rawArchitecture.output_modalities),
    supportedParameters: supportedParameters.length ? supportedParameters : arrayValue(rawPayload.supportedParameters ?? rawPayload.supported_parameters),
    promptPrice: row.promptPrice || stringValue(rawPricing.prompt),
    completionPrice: row.completionPrice || stringValue(rawPricing.completion),
  };
  delete model.inputModalitiesJson;
  delete model.outputModalitiesJson;
  delete model.supportedParametersJson;
  delete model.rawPayload;
  return model;
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function stringValue(value) {
  return value === undefined || value === null ? "" : String(value);
}

export { DEFAULT_SETTINGS };
