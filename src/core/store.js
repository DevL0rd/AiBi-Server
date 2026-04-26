import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { FIRMWARE_ANIMATIONS, FIRMWARE_BEHAVIORS } from "./firmwareCapabilities.js";

const DEFAULT_SETTINGS = {
  mode: "passthrough",
  openRouterApiKey: "",
  openRouterModel: "openai/gpt-5-mini",
  fishApiKey: "",
  fishVoiceId: "",
  fishModel: "s2-pro",
  language: "en",
  localTextFallback: "I heard you.",
  actionAfterSpeech: false,
};

export class AppStore {
  constructor({ rootDir }) {
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

      CREATE TABLE IF NOT EXISTS behaviors (
        name TEXT PRIMARY KEY,
        intent_name TEXT,
        sample_payload TEXT NOT NULL,
        seen_count INTEGER NOT NULL DEFAULT 1,
        last_seen_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS animations (
        name TEXT PRIMARY KEY,
        field TEXT NOT NULL,
        seen_count INTEGER NOT NULL DEFAULT 1,
        last_seen_at TEXT NOT NULL
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

    const settings = this.getSettings();
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      if (settings[key] === undefined) this.setSetting(key, value);
    }
  }

  addColumnIfMissing(table, column, type) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((row) => row.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
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

  learnFromDetectIntent(responseJson) {
    const result = responseJson?.queryResult;
    if (!result?.rec_behavior) return;

    const now = new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO behaviors (name, intent_name, sample_payload, seen_count, last_seen_at)
        VALUES (?, ?, ?, 1, ?)
        ON CONFLICT(name) DO UPDATE SET
          intent_name = excluded.intent_name,
          sample_payload = excluded.sample_payload,
          seen_count = seen_count + 1,
          last_seen_at = excluded.last_seen_at
      `)
      .run(result.rec_behavior, result.intent?.name || "", JSON.stringify(result), now);

    const params = result.behavior_paras && !Array.isArray(result.behavior_paras) ? result.behavior_paras : {};
    for (const field of ["pre_animation", "post_animation", "post_behavior"]) {
      if (params[field]) this.learnAnimation(field, params[field], now);
    }
  }

  learnAnimation(field, name, now = new Date().toISOString()) {
    this.db
      .prepare(`
        INSERT INTO animations (name, field, seen_count, last_seen_at)
        VALUES (?, ?, 1, ?)
        ON CONFLICT(name) DO UPDATE SET
          field = excluded.field,
          seen_count = seen_count + 1,
          last_seen_at = excluded.last_seen_at
      `)
      .run(name, field, now);
  }

  getLearned() {
    const observedBehaviors = this.db.prepare("SELECT * FROM behaviors").all();
    const observedAnimations = this.db.prepare("SELECT * FROM animations").all();
    const behaviorRows = mergeNamedRows(
      observedBehaviors,
      FIRMWARE_BEHAVIORS.map((name) => ({
        name,
        intent_name: "",
        sample_payload: JSON.stringify({ source: "firmware" }),
        seen_count: 0,
        last_seen_at: "",
      })),
    );
    const animationRows = mergeNamedRows(
      observedAnimations,
      FIRMWARE_ANIMATIONS.map((name) => ({
        name,
        field: "firmware_animation",
        seen_count: 0,
        last_seen_at: "",
      })),
    );
    return {
      behaviors: behaviorRows.sort((a, b) => a.name.localeCompare(b.name)),
      animations: animationRows.sort((a, b) => a.name.localeCompare(b.name)),
    };
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
        insert.run(
          model.id,
          model.name || model.id,
          model.id?.split("/")?.[0] || "",
          model.contextLength ?? null,
          JSON.stringify(model.architecture?.inputModalities || []),
          JSON.stringify(model.architecture?.outputModalities || []),
          JSON.stringify(model.supportedParameters || []),
          model.pricing?.prompt ?? "",
          model.pricing?.completion ?? "",
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

function mergeNamedRows(primaryRows, secondaryRows) {
  const rowsByName = new Map();
  for (const row of secondaryRows) rowsByName.set(row.name, row);
  for (const row of primaryRows) rowsByName.set(row.name, row);
  return [...rowsByName.values()];
}

function parseModelRow(row) {
  const model = {
    ...row,
    inputModalities: parseJsonArray(row.inputModalitiesJson),
    outputModalities: parseJsonArray(row.outputModalitiesJson),
    supportedParameters: parseJsonArray(row.supportedParametersJson),
  };
  delete model.inputModalitiesJson;
  delete model.outputModalitiesJson;
  delete model.supportedParametersJson;
  return model;
}

export { DEFAULT_SETTINGS };
