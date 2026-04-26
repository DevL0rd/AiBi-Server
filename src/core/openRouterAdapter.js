const LOCAL_INTENT_SCHEMA = {
  type: "object",
  properties: {
    speech_text: {
      type: "string",
      description: "Short natural speech for the robot to say, or an empty string when only changing mode or starting recognition.",
    },
    speech_listen: {
      type: "integer",
      minimum: 0,
      maximum: 1,
      description: "Use 1 only when the robot should keep listening after this response.",
    },
    chat_mode: {
      type: "string",
      enum: ["unchanged", "connect", "quit"],
      description: "Use connect to enter chat mode, quit to leave chat mode, otherwise unchanged.",
    },
    action_behavior: {
      type: "string",
      description: "A native robot behavior id from the provided capabilities, or empty string.",
    },
    action_params_json: {
      type: "string",
      description: "JSON object string for action behavior params when the selected capability documents params, otherwise {}.",
    },
    recognition_enabled: {
      type: "boolean",
      description: "True when the robot should perform its native image recognition flow.",
    },
    pre_animation: {
      type: "string",
      description: "A native pre-speech animation id from the provided capabilities, or empty string.",
    },
    post_animation: {
      type: "string",
      description: "A native post-speech animation id from the provided capabilities, or empty string.",
    },
    post_behavior: {
      type: "string",
      description: "A native post-speech behavior id from the provided capabilities, or empty string.",
    },
  },
  required: [
    "speech_text",
    "speech_listen",
    "chat_mode",
    "action_behavior",
    "action_params_json",
    "recognition_enabled",
    "pre_animation",
    "post_animation",
    "post_behavior",
  ],
  additionalProperties: false,
};

const EMPTY_INTENT = {
  speech: { text: "", listen: 0 },
  mode: { chat: "unchanged" },
  action: { behavior: "" },
  recognition: { enabled: false },
  animation: { pre: "", post: "", post_behavior: "" },
};

const IMAGE_RECOGNITION_MODEL = "google/gemini-2.5-flash-lite";

export class OpenRouterAdapter {
  constructor(getSettings) {
    this.getSettings = getSettings;
  }

  async listModels() {
    const settings = this.getSettings();
    const { OpenRouter } = await import("@openrouter/sdk");
    const client = new OpenRouter(settings.openRouterApiKey ? { apiKey: settings.openRouterApiKey } : {});
    const response = await client.models.list({ output_modalities: "all" });
    return response?.data || [];
  }

  async generateLocalIntent({ transcript, audio, audioFormat, image, imageMimeType, capabilities, history, chatMode, modelInfo, proactive = false }) {
    const settings = this.getSettings();
    if (!settings.openRouterApiKey) {
      return { ...EMPTY_INTENT, speech: { text: settings.localTextFallback || "I heard you.", listen: 0 } };
    }

    const { OpenRouter } = await import("@openrouter/sdk");
    const client = new OpenRouter({ apiKey: settings.openRouterApiKey });
    const useAudioInput = supportsModality(modelInfo, "input", "audio") && audio && audioFormat;
    const useImageInput = supportsModality(modelInfo, "input", "image") && image?.length;
    const messages = buildMessages({
      transcript,
      audio,
      audioFormat,
      image,
      imageMimeType,
      capabilities,
      history,
      chatMode,
      useAudioInput,
      useImageInput,
      actionAfterSpeech: settings.actionAfterSpeech && Boolean(capabilities.native_animations?.post_behavior?.length),
      proactive,
    });

    const result = await client.chat.send({
      chatRequest: {
        model: settings.openRouterModel,
        messages,
        responseFormat: {
          type: "json_schema",
          jsonSchema: {
            name: "aibi_local_intent",
            strict: true,
            schema: LOCAL_INTENT_SCHEMA,
          },
        },
        provider: {
          requireParameters: true,
        },
        plugins: [{ id: "response-healing" }],
      },
    });

    const intent = normalizeIntent(parseIntent(result?.choices?.[0]?.message?.content), capabilities);
    if (chatMode && intent.mode.chat === "connect") intent.mode.chat = "unchanged";
    return intent;
  }

  async synthesizeSpeech({ text }) {
    const stream = await this.synthesizeSpeechStream({ text });
    if (!stream) return null;
    return Buffer.from(await new Response(stream).arrayBuffer());
  }

  async synthesizeSpeechStream({ text }) {
    const settings = this.getSettings();
    if (!settings.openRouterApiKey || !settings.openRouterTtsModel || !settings.openRouterTtsVoice) return null;

    const { OpenRouter } = await import("@openrouter/sdk");
    const client = new OpenRouter({ apiKey: settings.openRouterApiKey });
    return client.tts.createSpeech({
      speechRequest: {
        model: settings.openRouterTtsModel,
        voice: settings.openRouterTtsVoice,
        input: text,
        responseFormat: "mp3",
      },
    });
  }

  async describeImage({ image, mimeType = "image/jpeg" }) {
    const settings = this.getSettings();
    if (!settings.openRouterApiKey || !image?.length) return "";

    const { OpenRouter } = await import("@openrouter/sdk");
    const client = new OpenRouter({ apiKey: settings.openRouterApiKey });
    const result = await client.chat.send({
      chatRequest: {
        model: IMAGE_RECOGNITION_MODEL,
        messages: [
          {
            role: "system",
            content: "Describe the image plainly for another chat model. Do not roleplay, do not answer as the robot, and do not add personality.",
          },
          {
            role: "user",
            content: [
              { type: "text", text: "Describe what is visible in this image, including important objects, people, text, and scene context. Be concise but specific." },
              { type: "image_url", imageUrl: { url: `data:${mimeType};base64,${image.toString("base64")}` } },
            ],
          },
        ],
        provider: {
          requireParameters: true,
        },
      },
    });
    return stringValue(result?.choices?.[0]?.message?.content);
  }
}

function buildMessages({ transcript, audio, audioFormat, image, imageMimeType, capabilities, history, chatMode, useAudioInput, useImageInput, actionAfterSpeech, proactive }) {
  const recentHistory = history.slice(-12).map((item) => ({
    role: item.role,
    content: item.content,
  }));
  const capabilityPrompt = renderCapabilityPrompt(capabilities);
  const userContent = proactive
    ? "The robot decided to proactively reach out. Produce the short opener it should say now."
    : useAudioInput
    ? [
        { type: "text", text: "Use the attached robot microphone audio as the user's latest message." },
        { type: "input_audio", inputAudio: { data: audio.toString("base64"), format: audioFormat } },
      ]
    : useImageInput
    ? [
        { type: "text", text: "Use the attached robot camera image as the user's latest message. Respond exactly like a normal chat turn." },
        { type: "image_url", imageUrl: { url: `data:${imageMimeType || "image/jpeg"};base64,${image.toString("base64")}` } },
      ]
    : transcript || "The user spoke, but transcription was unavailable.";

  return [
    {
      role: "system",
      content: [
        "You are the local brain for a small desktop robot.",
        "Return only the structured JSON requested by the schema.",
        "Keep speech short and natural.",
        "Use only provided native robot capabilities. Unknown actions or animations must be empty strings.",
        "Act like an embodied robot, not just a text assistant. When a native action would be a better response than speech, use the action directly and leave speech_text empty.",
        "Use native actions naturally: dance for celebration or music, sing for song requests, animal for animal/playful requests, mood for emotional reactions, greeting for greetings, breath for calming, light_control for color/light requests, movement for turn/move requests, game_rps for rock-paper-scissors, recognize for looking/seeing/photo understanding.",
        "When speaking, add a natural pre_animation, post_animation, or post_behavior from the provided native_animations lists when it fits the response. Prefer post_animation for visual expression and post_behavior for a native behavior after speech.",
        "Good expressive speech animations include greeting_happy, greeting_wink, animal_cat1, animal_rabbit1, show_blow_bubbles, dance_ai1, dance_disco1, mood_happy, mood_surprise, mood_shy, and chatgpt_think when present.",
        "Do not use interact_answer_with_animation. For speech with expression, use interact_speak with pre_animation or post_animation.",
        "If the user needs information, answer with speech. If the user wants the robot to do something physical, prefer the native action. Do not explain that you are using an action.",
        actionAfterSpeech
          ? "Action-after-speech is enabled for code-derived post_behavior values, so you may combine speech_text with action_behavior when useful."
          : "Action-after-speech is unavailable from code-derived capabilities, so for direct native action requests leave speech_text empty and set action_behavior.",
        "When chat mode is active and the user wants to stop, leave, end the conversation, or says goodbye, set chat_mode to quit.",
        "Only set chat_mode to connect when chat mode is inactive and the user explicitly asks for an ongoing conversation, such as let's chat, let's talk, talk with me, start a conversation, or keep talking.",
        "Also set chat_mode to connect when the latest user request clearly cannot be handled as a single reply and needs a back-and-forth conversation.",
        "Do not set chat_mode to connect for ordinary questions, commands, greetings, image descriptions, jokes, facts, short requests, or anything that can be answered in one response.",
        "If chat mode is already active, do not set chat_mode to connect again; answer with speech_text or a native action instead.",
        proactive
          ? "This request is a proactive reachout: the robot is initiating contact without user speech. Greet briefly or make a simple timely invitation. Do not imply the user just asked a question. Set speech_listen to 1 when you want the robot to keep listening after the opener."
          : "This request is a response to the user's latest speech or action.",
        "Use action_params_json only when the selected action_behavior has documented params in action_param_schemas. Otherwise use {}.",
        "Use only animation names listed in native_animations.pre_animation or native_animations.post_animation for those fields. Use only behavior IDs listed in native_animations.post_behavior for post_behavior.",
        "Use the flat schema fields as follows: speech_text, speech_listen, chat_mode, action_behavior, action_params_json, recognition_enabled, pre_animation, post_animation, post_behavior.",
        `Chat mode is currently ${chatMode ? "active" : "inactive"}.`,
        capabilityPrompt,
      ].join("\n"),
    },
    ...recentHistory,
    { role: "user", content: userContent },
  ];
}

function renderCapabilityPrompt(capabilities = {}) {
  const behaviors = capabilities.native_behaviors || [];
  const params = capabilities.action_param_schemas || {};
  const animations = capabilities.firmware_animation_names || [];
  const preAnimations = capabilities.native_animations?.pre_animation || [];
  const postAnimations = capabilities.native_animations?.post_animation || [];
  const postBehaviors = capabilities.native_animations?.post_behavior || [];

  return [
    "Native behavior IDs and params:",
    ...behaviors.map((behavior) => `- ${behavior}${formatParamSchema(params[behavior])}`),
    "Animation IDs for pre_animation and post_animation:",
    wrapList(animations),
    "Post-speech behavior IDs for post_behavior:",
    wrapList(postBehaviors),
    `pre_animation accepts exactly these animation IDs: ${preAnimations.length} known values.`,
    `post_animation accepts exactly these animation IDs: ${postAnimations.length} known values.`,
  ].join("\n");
}

function formatParamSchema(schema) {
  if (!schema || typeof schema !== "object" || !Object.keys(schema).length) return "";
  const fields = Object.entries(schema).map(([key, value]) => {
    if (Array.isArray(value)) return `${key}=${value.join("|")}`;
    return `${key}=${value}`;
  });
  return ` params: { ${fields.join(", ")} }`;
}

function wrapList(values, lineLength = 140) {
  const list = [...new Set(values || [])].filter(Boolean).sort();
  const lines = [];
  let current = "- ";
  for (const value of list) {
    const next = current.endsWith("- ") ? value : `, ${value}`;
    if (current.length + next.length > lineLength && !current.endsWith("- ")) {
      lines.push(current);
      current = `- ${value}`;
    } else {
      current += next;
    }
  }
  if (!current.endsWith("- ")) lines.push(current);
  return lines.join("\n");
}

function parseIntent(content) {
  if (!content) return EMPTY_INTENT;
  if (typeof content === "object") return content;
  try {
    return JSON.parse(content);
  } catch {
    return EMPTY_INTENT;
  }
}

function normalizeIntent(intent, capabilities) {
  const nativeBehaviors = new Set(capabilities.native_behaviors || []);
  const preAnimations = new Set(capabilities.native_animations?.pre_animation || []);
  const postAnimations = new Set(capabilities.native_animations?.post_animation || []);
  const postBehaviors = new Set(capabilities.native_animations?.post_behavior || []);
  const flatIntent = intent?.speech_text !== undefined
    ? {
        speech: { text: intent.speech_text, listen: intent.speech_listen },
        mode: { chat: intent.chat_mode },
        action: { behavior: intent.action_behavior, params: parseActionParams(intent.action_params_json) },
        recognition: { enabled: intent.recognition_enabled },
        animation: {
          pre: intent.pre_animation,
          post: intent.post_animation,
          post_behavior: intent.post_behavior,
        },
      }
    : intent;

  const next = {
    speech: {
      text: stringValue(flatIntent?.speech?.text),
      listen: flatIntent?.speech?.listen === 1 ? 1 : 0,
    },
    mode: {
      chat: ["unchanged", "connect", "quit"].includes(flatIntent?.mode?.chat) ? flatIntent.mode.chat : "unchanged",
    },
    action: {
      behavior: nativeBehaviors.has(flatIntent?.action?.behavior) ? flatIntent.action.behavior : "",
      params: {},
    },
    recognition: {
      enabled: Boolean(flatIntent?.recognition?.enabled),
    },
    animation: {
      pre: preAnimations.has(flatIntent?.animation?.pre) ? flatIntent.animation.pre : "",
      post: postAnimations.has(flatIntent?.animation?.post) ? flatIntent.animation.post : "",
      post_behavior: postBehaviors.has(flatIntent?.animation?.post_behavior) ? flatIntent.animation.post_behavior : "",
    },
  };

  if (next.mode.chat !== "unchanged") {
    next.action.behavior = "";
    next.recognition.enabled = false;
    next.animation = { pre: "", post: "", post_behavior: "" };
  }
  next.action.params = next.action.behavior
    ? filterActionParams(next.action.behavior, flatIntent?.action?.params, capabilities)
    : {};

  return next;
}

function parseActionParams(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function filterActionParams(behavior, params, capabilities = {}) {
  const schemas = capabilities.action_param_schemas || {};
  const schema = schemas[behavior];
  const firmwareAnimationNames = new Set(capabilities.firmware_animation_names || []);
  if (!schema || !params || typeof params !== "object") return {};
  return Object.fromEntries(Object.entries(params).filter(([key, value]) => {
    const allowed = schema[key];
    if (Array.isArray(allowed)) return allowed.includes(value);
    if (allowed === "number") return typeof value === "number";
    if (allowed === "firmware_animation") return firmwareAnimationNames.has(value);
    if (allowed === "string") return typeof value === "string" && value.trim();
    return false;
  }));
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function supportsModality(modelInfo, side, modality) {
  const list = side === "input" ? modelInfo?.inputModalities : modelInfo?.outputModalities;
  return Array.isArray(list) && list.includes(modality);
}
