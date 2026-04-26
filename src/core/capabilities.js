import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const capabilitiesPath = path.join(__dirname, "capabilities.json");
const capabilities = JSON.parse(fs.readFileSync(capabilitiesPath, "utf8"));

const allActions = normalizeActions(capabilities.actions);
const allAnimations = normalizeAnimations(capabilities.animations);

export function getCapabilityCatalog() {
  return {
    actions: allActions,
    animations: allAnimations,
  };
}

export function getCapabilities(settings = {}) {
  const disabledActionIds = new Set(settings.disabledCapabilityIds || []);
  const disabledAnimationIds = new Set(settings.disabledAnimationIds || []);
  const actions = allActions.filter((action) => !disabledActionIds.has(action.id));
  const animations = allAnimations.filter((animation) => !disabledAnimationIds.has(animation.id));
  const actionIds = actions.map((action) => action.id);
  const animationIds = animations.map((animation) => animation.id);
  return {
    actions,
    animations,
    native_behaviors: actionIds,
    action_param_schemas: Object.fromEntries(actions.map((action) => [action.id, action.valid_params || {}])),
    firmware_animation_names: animationIds,
    native_animations: {
      pre_animation: animationIds,
      post_animation: animationIds,
      post_behavior: actionIds,
    },
  };
}

function normalizeActions(rows) {
  return [...new Map((rows || [])
    .filter((row) => row?.id)
    .map((row) => [row.id, {
      id: String(row.id),
      description: String(row.description || ""),
      instructions: String(row.instructions || ""),
      valid_params: row.valid_params && typeof row.valid_params === "object" && !Array.isArray(row.valid_params) ? row.valid_params : {},
    }])).values()].sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeAnimations(rows) {
  return [...new Map((rows || [])
    .map((row) => typeof row === "string" ? row : row?.id)
    .filter(Boolean)
    .map((id) => [id, { id: String(id) }])).values()].sort((a, b) => a.id.localeCompare(b.id));
}
