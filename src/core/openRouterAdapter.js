const LOCAL_INTENT_SCHEMA = {
  type: "object",
  properties: {
    speech_text: {
      type: "string",
      description: "Short natural speech for AIBI to say, or an empty string when only changing mode or starting recognition.",
    },
    speech_listen: {
      type: "integer",
      minimum: 0,
      maximum: 1,
      description: "Use 1 only when AIBI should keep listening after this response.",
    },
    transcribed_speech: {
      type: "string",
      description: "Exact transcript of the user's latest spoken audio. Use an empty string when no audio was attached.",
    },
    chat_mode: {
      type: "string",
      enum: ["unchanged", "connect", "quit"],
      description: "Use connect to enter chat mode, quit to leave chat mode, otherwise unchanged.",
    },
    action_behavior: {
      type: "string",
      description: "A native AIBI behavior id from the provided capabilities, or empty string.",
    },
    action_params_json: {
      type: "string",
      description: "JSON object string for action behavior params when the selected capability documents params, otherwise {}.",
    },
    recognition_enabled: {
      type: "boolean",
      description: "True when AIBI should perform its native image recognition flow.",
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
    "transcribed_speech",
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

const LOCAL_SPEECH_SCHEMA = {
  type: "object",
  properties: {
    speech_text: {
      type: "string",
      description: "Short natural speech for AIBI to say.",
    },
    speech_listen: {
      type: "integer",
      minimum: 0,
      maximum: 1,
      description: "Use 1 only when AIBI should keep listening after this response.",
    },
  },
  required: ["speech_text", "speech_listen"],
  additionalProperties: false,
};

const EMPTY_INTENT = {
  speech: { text: "", listen: 0 },
  transcribedSpeech: "",
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

  async generateLocalIntent({
    transcript,
    audio,
    audioFormat,
    image,
    imageMimeType,
    capabilities,
    history = [],
    chatMode,
    modelInfo,
    stageDirections = [],
    transcribeAudio,
    responseMode = "intent",
    timeZone,
  }) {
    const settings = this.getSettings();
    const fallbackIntent = { ...EMPTY_INTENT, speech: { text: settings.localTextFallback, listen: 0 } };
    if (!settings.openRouterApiKey) {
      const inputText = formatInputText({ stageDirections, transcript });
      return { intent: fallbackIntent, inputText, latestUserContent: inputText };
    }

    const { OpenRouter } = await import("@openrouter/sdk");
    const client = new OpenRouter({ apiKey: settings.openRouterApiKey });
    const hasAudioInput = Boolean(audio?.length && audioFormat);
    const useAudioInput = supportsModality(modelInfo, "input", "audio") && hasAudioInput;
    const useImageInput = supportsModality(modelInfo, "input", "image") && image?.length;
    let inputText = stringValue(transcript);

    if (!useAudioInput && audio?.length && audioFormat && transcribeAudio) {
      inputText = stringValue(await transcribeAudio({ audio, audioFormat }));
    }

    if (!useImageInput && image?.length) {
      const description = await this.describeImageForFallback({ image, mimeType: imageMimeType });
      inputText = description
        ? `The user sent an image. Image description: ${description}`
        : "The user sent an image, but image description failed.";
    }

    const messages = buildMessages({
      transcript: inputText,
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
      personalityPrompt: settings.personalityPrompt,
      stageDirections,
      responseMode,
      timeZone,
    });

    const schema = responseMode === "speech" ? LOCAL_SPEECH_SCHEMA : LOCAL_INTENT_SCHEMA;
    const schemaName = responseMode === "speech" ? "aibi_local_speech" : "aibi_local_intent";
    const chatRequest = withOpenRouterOptions(settings, modelInfo, {
      model: settings.openRouterModel,
      messages,
      responseFormat: {
        type: "json_schema",
        jsonSchema: {
          name: schemaName,
          strict: true,
          schema,
        },
      },
      provider: {
        requireParameters: true,
      },
    });

    const result = await client.chat.send({
      chatRequest,
    });

    const parsed = parseIntent(result?.choices?.[0]?.message?.content);
    const intent = responseMode === "speech" ? normalizeSpeechIntent(parsed) : normalizeIntent(parsed, capabilities);
    if (hasAudioInput && !useAudioInput) intent.transcribedSpeech = inputText;
    const finalInputText = hasAudioInput
      ? stringValue(intent.transcribedSpeech) || inputText
      : inputText;
    if (chatMode && intent.mode.chat === "connect") intent.mode.chat = "unchanged";
    return {
      intent,
      inputText: formatInputText({ stageDirections, transcript: finalInputText }),
      latestUserContent: buildLoggedUserContent({
        originalContent: messages[messages.length - 1]?.content,
        stageDirections,
        transcript: finalInputText,
        hasAudioInput,
      }),
    };
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

  async describeImageForFallback({ image, mimeType = "image/jpeg" }) {
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
            content: "Describe the image plainly for another chat model. Do not roleplay, do not answer as AIBI, and do not add personality.",
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

function withOpenRouterOptions(settings, modelInfo, chatRequest) {
  const next = { ...chatRequest };
  const plugins = [{ id: "response-healing" }];
  if (settings.openRouterWebSearchEnabled) plugins.unshift({ id: "web" });
  next.plugins = plugins;

  if (settings.openRouterReasoningEnabled && modelSupportsParameter(modelInfo, "reasoning")) {
    next.reasoning = {
      effort: normalizeReasoningEffort(settings.openRouterReasoningEffort),
    };
  }

  const temperature = numberOrNull(settings.openRouterTemperature);
  if (temperature !== null && modelSupportsParameter(modelInfo, "temperature")) next.temperature = Math.min(2, Math.max(0, temperature));

  const maxTokens = integerOrNull(settings.openRouterMaxTokens);
  if (maxTokens !== null && maxTokens > 0 && modelSupportsParameter(modelInfo, "max_tokens")) next.maxTokens = maxTokens;

  return next;
}

function modelSupportsParameter(modelInfo, parameter) {
  const params = modelInfo?.supportedParameters || [];
  if (!params.length) return true;
  return params.some((value) => String(value).toLowerCase() === parameter);
}

function normalizeReasoningEffort(value) {
  const effort = String(value || "").toLowerCase();
  return ["minimal", "low", "medium", "high"].includes(effort) ? effort : "medium";
}

function numberOrNull(value) {
  if (value === "" || value === undefined || value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function integerOrNull(value) {
  const number = numberOrNull(value);
  return number === null ? null : Math.floor(number);
}

function buildMessages({
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
  actionAfterSpeech,
  personalityPrompt,
  stageDirections,
  responseMode,
  timeZone,
}) {
  const now = new Date();
  const resolvedTimeZone = normalizeTimeZone(timeZone);
  const lastUserMessage = [...(history || [])].reverse().find((item) => item.role === "user" && item.createdAt);
  const timeContext = buildTimeContext({ now, timeZone: resolvedTimeZone, lastUserMessage });
  const recentHistory = history.slice(-12).map((item) => ({
    role: item.role,
    content: annotateMessageWithTime(item.content, item.createdAt, now, resolvedTimeZone),
  }));
  const capabilityPrompt = renderCapabilityPrompt(capabilities, { chatMode });
  const stageText = formatStageDirections(stageDirections);
  const textPrefix = stageText ? `${stageText}\n` : "";
  const latestPrefix = buildLatestMessageTimePrefix({ now, timeZone: resolvedTimeZone, lastUserMessage });
  const userContent = useAudioInput
    ? [
        { type: "text", text: `${latestPrefix}${textPrefix}Use the attached AIBI microphone audio as the user's latest message.` },
        { type: "input_audio", inputAudio: { data: audio.toString("base64"), format: audioFormat } },
      ]
    : useImageInput
    ? [
        { type: "text", text: `${latestPrefix}${textPrefix}Use the attached AIBI camera image as the user's latest message.` },
        { type: "image_url", imageUrl: { url: `data:${imageMimeType || "image/jpeg"};base64,${image.toString("base64")}` } },
      ]
    : `${latestPrefix}${formatInputText({ stageDirections, transcript }) || "The user spoke, but transcription was unavailable."}`;

  return [
    {
      role: "system",
      content: buildSystemPrompt({ personalityPrompt, responseMode, actionAfterSpeech, chatMode, capabilityPrompt, timeContext }),
    },
    ...recentHistory,
    { role: "user", content: userContent },
  ];
}

function buildSystemPrompt({ personalityPrompt, responseMode, actionAfterSpeech, chatMode, capabilityPrompt, timeContext }) {
  const base = [
    "You are the local brain for AIBI, a small desktop companion.",
    "AIBI personality:",
    stringValue(personalityPrompt),
    timeContext,
    "Return only the structured JSON requested by the schema.",
    "Keep speech short and natural.",
    "Text wrapped in square brackets is a stage direction or context event. Do not quote it, repeat it, or explicitly acknowledge that you received it. Let it guide what you do and say.",
  ];

  if (responseMode === "speech") {
    return [
      ...base,
      "Use the flat schema fields as follows: speech_text, speech_listen.",
    ].join("\n");
  }

  return [
    ...base,
    "Act like AIBI is physically present, not just a text assistant. When a native action would be a better response than speech, use the action directly and leave speech_text empty.",
    "When the latest user message includes attached audio, transcribe that audio into transcribed_speech. Keep transcribed_speech as only the user's spoken words, not your response. If no audio was attached, use an empty string.",
    "Use native actions naturally: dance for celebration or music, sing for song requests, animal/playful requests, breath for calming, light_control for color/light requests, movement for turn/move requests, game_rps for rock-paper-scissors etc...",
    "When speaking, add a natural pre_animation, post_animation, or post_behavior only from non-empty provided native_animations lists when it fits the response.",
    "If the user needs information, answer with speech. If the user wants AIBI to do something physical, prefer the native action. Do not explain that you are using an action.",
    actionAfterSpeech
      ? "Action-after-speech is enabled for code-derived post_behavior values, so you may combine speech_text with action_behavior when useful."
      : "Action-after-speech is unavailable from code-derived capabilities, so for direct native action requests leave speech_text empty and set action_behavior.",
    chatMode
      ? "For chat_mode, only use quit when the user wants to stop, leave, end the conversation, or says goodbye. Otherwise use unchanged."
      : "For chat_mode, only use connect when the user explicitly asks for an ongoing conversation, such as let's chat, let's talk, talk with me, start a conversation, or keep talking. Otherwise use unchanged.",
    chatMode
      ? "For ordinary questions, commands, greetings, image descriptions, jokes, facts, and short requests, answer with speech_text or a native action."
      : "Do not set chat_mode to connect for ordinary questions, commands, greetings, image descriptions, jokes, facts, short requests, or anything that can be answered or executed in one response.",
    "Use action_params_json only when the selected action_behavior has documented params in action_param_schemas. Otherwise use {}.",
    "Use only animation names listed in native_animations.pre_animation or native_animations.post_animation for those fields. Use only behavior IDs listed in native_animations.post_behavior for post_behavior.",
    "Use the flat schema fields as follows: speech_text, speech_listen, transcribed_speech, chat_mode, action_behavior, action_params_json, recognition_enabled, pre_animation, post_animation, post_behavior.",
    capabilityPrompt,
  ].join("\n");
}

function formatStageDirections(stageDirections = []) {
  const list = Array.isArray(stageDirections) ? stageDirections : [stageDirections];
  return list.map((value) => stringValue(value)).filter(Boolean).map((value) => (
    value.startsWith("[") && value.endsWith("]") ? value : `[${value}]`
  )).join("\n");
}

function formatInputText({ stageDirections = [], transcript = "" }) {
  return [formatStageDirections(stageDirections), stringValue(transcript)].filter(Boolean).join("\n");
}

function buildTimeContext({ now, timeZone, lastUserMessage }) {
  const current = formatLocalDateTime(now, timeZone);
  const last = lastUserMessage?.createdAt
    ? `${formatRelativeAge(new Date(lastUserMessage.createdAt), now)} ago`
    : "none in recent history";
  return `Time context: user local time is ${current.date} ${current.time} (${timeZone}); previous user message was ${last}.`;
}

function buildLatestMessageTimePrefix({ now, timeZone, lastUserMessage }) {
  const current = formatLocalDateTime(now, timeZone);
  const since = lastUserMessage?.createdAt
    ? formatRelativeAge(new Date(lastUserMessage.createdAt), now)
    : "no prior user message";
  return `[message_time ${current.date} ${current.time}; since_previous_user_message ${since}]\n`;
}

function annotateMessageWithTime(content, createdAt, now, timeZone) {
  const text = stringValue(content);
  if (!createdAt) return text;
  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime())) return text;
  const local = formatLocalDateTime(created, timeZone);
  return `[message_time ${local.date} ${local.time}; age ${formatRelativeAge(created, now)}]\n${text}`;
}

function formatLocalDateTime(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== "literal") acc[part.type] = part.value;
    return acc;
  }, {});
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

function formatRelativeAge(from, to) {
  if (!(from instanceof Date) || Number.isNaN(from.getTime())) return "unknown";
  const seconds = Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000));
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

function normalizeTimeZone(value) {
  const zone = stringValue(value) || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(new Date());
    return zone;
  } catch {
    return "UTC";
  }
}

function buildLoggedUserContent({ originalContent, stageDirections = [], transcript = "", hasAudioInput = false }) {
  if (!hasAudioInput) return originalContent;
  return formatInputText({ stageDirections, transcript }) || "[audio attached]";
}

function renderCapabilityPrompt(capabilities = {}, { chatMode = false } = {}) {
  const actions = (capabilities.actions || []).map((action) => action.id === "ability_chatgpt"
    ? {
        ...action,
        instructions: chatMode
          ? "Use type=quit only when the user wants to stop the ongoing conversation."
          : "Use type=connect only when the user explicitly asks for an ongoing conversation.",
        valid_params: { type: [chatMode ? "quit" : "connect"] },
      }
    : action);
  const animations = capabilities.firmware_animation_names || [];
  const preAnimations = capabilities.native_animations?.pre_animation || [];
  const postAnimations = capabilities.native_animations?.post_animation || [];
  const postBehaviors = capabilities.native_animations?.post_behavior || [];

  return [
    "Native actions:",
    ...actions.map((action) => [
      `- ${action.id}: ${action.description}`,
      action.instructions ? `  instructions: ${action.instructions}` : "",
      `  valid_params: ${formatParamSchema(action.valid_params)}`,
    ].filter(Boolean).join("\n")),
    "Animation IDs for pre_animation and post_animation:",
    wrapList(animations),
    "Post-speech behavior IDs for post_behavior:",
    wrapList(postBehaviors),
    `pre_animation accepts exactly these animation IDs: ${preAnimations.length} known values.`,
    `post_animation accepts exactly these animation IDs: ${postAnimations.length} known values.`,
  ].join("\n");
}

function formatParamSchema(schema) {
  if (!schema || typeof schema !== "object" || !Object.keys(schema).length) return "{}";
  const fields = Object.entries(schema).map(([key, value]) => {
    if (Array.isArray(value)) return `${key}=${value.join("|")}`;
    return `${key}=${value}`;
  });
  return `{ ${fields.join(", ")} }`;
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

function normalizeSpeechIntent(intent) {
  return {
    ...EMPTY_INTENT,
    speech: {
      text: stringValue(intent?.speech_text || intent?.speech?.text),
      listen: intent?.speech_listen === 1 || intent?.speech?.listen === 1 ? 1 : 0,
    },
  };
}

function normalizeIntent(intent, capabilities) {
  const nativeBehaviors = new Set(capabilities.native_behaviors || []);
  const preAnimations = new Set(capabilities.native_animations?.pre_animation || []);
  const postAnimations = new Set(capabilities.native_animations?.post_animation || []);
  const postBehaviors = new Set(capabilities.native_animations?.post_behavior || []);
  const flatIntent = intent?.speech_text !== undefined
    ? {
        speech: { text: intent.speech_text, listen: intent.speech_listen },
        transcribedSpeech: intent.transcribed_speech,
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
    transcribedSpeech: stringValue(flatIntent?.transcribedSpeech),
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
    return isAllowedParamValue(allowed, value, firmwareAnimationNames);
  }));
}

function isAllowedParamValue(allowed, value, firmwareAnimationNames) {
  if (allowed === "number") return typeof value === "number";
  if (allowed === "number 1-12") return typeof value === "number" && value >= 1 && value <= 12;
  if (allowed === "HH:mm") return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
  if (allowed === "firmware_animation") return firmwareAnimationNames.has(value);
  if (allowed === "string") return typeof value === "string" && value.trim();
  return false;
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function supportsModality(modelInfo, side, modality) {
  const list = side === "input" ? modelInfo?.inputModalities : modelInfo?.outputModalities;
  return Array.isArray(list) && list.includes(modality);
}
