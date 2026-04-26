# AIBI API Notes

## Host

- `api.aibipocket.com`

## Common Headers

- `Authorization: Bearer <jwt>`
- `Secret: <opaque token>`
- `Connection: Keep-Alive`
- `Keep-Alive: timeout=300, max=1000`

## Startup / Status

### `GET /time`

Returns server time.

### `GET /token/<device_id>?version=9&name=1.6.0`

Returns the bearer token used by later requests.

### `GET /aibi/ota/version?type=1&version_num=9&current_name=1.6.0`

Checks firmware/app update state.

Observed update-resource metadata:

```json
{
  "version-num": "9",
  "version-name": "1.6.0",
  "updates": {
    "host": "res-us-east-1.living.ai",
    "firmware": "/aibi/version/public/9/1.6.0/202601301620/1.6.0.zip",
    "md5": "010b006723576ae64e7bd746d964a4fb"
  },
  "responsetag": "otares"
}
```

The firmware download URL is formed from `updates.host` plus `updates.firmware`:

```text
https://res-us-east-1.living.ai/aibi/version/public/9/1.6.0/202601301620/1.6.0.zip
```

The `md5` field matches the downloaded firmware archive.

### `GET /aibi/ota/res/<version>?current_name=<name>`

Checks resource-pack update state after firmware update flow starts.

Known no-update response:

```json
{
  "errcode": 0,
  "errmsg": "OK",
  "responsetag": "otares"
}
```

### `POST /aibi/report/status`

Reports AIBI status.

### `GET /aibi/permission`

Fetches enabled service permissions.

### `GET /aibi/poweron/voice?lang=en`

Fetches boot/power-on voice behavior.

### Other Firmware Endpoints

The 1.6.0 firmware string table also contains these server endpoints:

- `POST /aibi/messages/send`
- `GET /aibi/messages/receive?limit=<n>`
- `GET /aibi/messages/confirm`
- `POST /aibi/ai/imgrecog?languageCode=<lang>`
- `POST /aibi/ai/imgrecog?languageCode=<lang>&type=take_photo`
- `POST /aibi/ai/rockpaper?languageCode=<lang>`
- `GET /aibi/speech/tts?q=<text>&l=<lang>`
- `GET /aibi/ota/res/<version>?current_name=<name>`
- `GET /aibi/ota/allres/<version>?current_name=<name>`

Local handling policy:

- `GET /aibi/permission` always returns allowed.
- `POST /aibi/report/status` returns success and displays a summarized status event in the UI.
- Message send/receive/confirm are friend-message endpoints. Send posts `to`, `text`, `avatar`, and `name`; receive returns `responsetag = "getmessage"` with `m_list`; confirm acknowledges read messages.
- `GET /aibi/poweron/voice` and `GET /aibi/speech/tts` generate local TTS and serve it through the same streamed audio path used by local speech replies.
- `POST /aibi/ai/imgrecog` is treated as a normal local chat turn. If the selected OpenRouter model supports image input, the image is sent directly with the normal AIBI system prompt and chat history. If it does not, `google/gemini-2.5-flash-lite` first describes the image, then that description is sent through the normal local chat path. The final response is stored in chat history and returned with local TTS.
- `POST /aibi/ai/rockpaper` is forwarded to the real server.
- `GET /aibi/ota/version` returns local patched firmware metadata when a patched package exists.
- `GET /aibi/ota/res/<version>` returns local success with no update payload.
- Patched firmware zip downloads are served locally.

## Voice Intent Flow

### Request

```http
POST /aibi/voice/detectintent?locale=Muaklek&timezone=Asia/Bangkok&lon=101.18209&lat=14.67816&languagecode=en&alwaysReply=1&index=<index> HTTP/1.1
Host: api.aibipocket.com
Content-Type: application/octet-stream
Transfer-Encoding: chunked
```

Body is binary audio.

Observed optional query param:

- `role=chatgpt`

### Spoken Reply Response

```json
{
  "queryId": "...",
  "queryResult": {
    "rec_behavior": "interact_speak",
    "behavior_paras": {
      "txt": "Loud and clear! How can I assist you today?",
      "url": "http://api.aibipocket.com/tts/dl/20260426c9c4196cbc8c0ac1c041920b36d82de3",
      "pre_animation": "",
      "post_animation": "",
      "post_behavior": "",
      "sentiment": "",
      "listen": 0
    },
    "resultCode": "...",
    "queryText": "can you hear me?",
    "intent": {
      "name": "chatgpt_speak",
      "confidence": 1
    }
  },
  "languageCode": "en",
  "index": 6958
}
```

### Action Response

```json
{
  "queryId": "...",
  "queryResult": {
    "resultCode": "...",
    "queryText": "dance.",
    "intent": {
      "name": "ability_dance",
      "confidence": "0.9998"
    },
    "rec_behavior": "ability_dance",
    "behavior_paras": []
  },
  "languageCode": "en",
  "index": 1626
}
```

Observed action behaviors:

- `ability_dance`
- `ability_sing`
- `ability_animal`
- `ability_chatgpt`
- `interact_game_rps`
- `interact_recognize`

## TTS Flow

### Request

```http
GET /tts/dl/<id> HTTP/1.1
Host: api.aibipocket.com
```

### Response

```http
HTTP/1.1 200 OK
Content-Type: audio/mpeg
```

Body is MP3 audio.

## ChatGPT Conversation Mode

### Enter From Voice Intent

The user can enter conversation mode by asking to talk. This starts as a normal voice intent request.

```http
POST /aibi/voice/detectintent?locale=<locale>&timezone=<tz>&lon=<lon>&lat=<lat>&languagecode=en&alwaysReply=1&index=<index> HTTP/1.1
Host: api.aibipocket.com
Content-Type: application/octet-stream
Transfer-Encoding: chunked
```

Observed response:

```json
{
  "queryId": "...",
  "queryResult": {
    "resultCode": "...",
    "queryText": "let's talk.",
    "intent": {
      "name": "ability_chatgpt",
      "confidence": "0.9997"
    },
    "rec_behavior": "ability_chatgpt",
    "behavior_paras": {
      "type": "connect"
    }
  },
  "languageCode": "en",
  "index": 7611
}
```

### Conversation Turns

After conversation mode is active, AIBI keeps using the normal voice intent endpoint, with `role=chatgpt` added.

```http
POST /aibi/voice/detectintent?locale=<locale>&timezone=<tz>&lon=<lon>&lat=<lat>&languagecode=en&alwaysReply=1&index=<index>&role=chatgpt HTTP/1.1
Host: api.aibipocket.com
Content-Type: application/octet-stream
Transfer-Encoding: chunked
```

Responses are usually normal `interact_speak` replies with a TTS URL.

```json
{
  "queryId": "...",
  "queryResult": {
    "rec_behavior": "interact_speak",
    "behavior_paras": {
      "txt": "I'm just here, ready to chat, sing, or help you with anything you need! What would you like to do?",
      "url": "http://api.aibipocket.com/tts/dl/2026042618b919e7ac7f03b7090dc68c07438a22",
      "pre_animation": "",
      "post_animation": "",
      "post_behavior": "",
      "sentiment": "",
      "listen": 0
    },
    "resultCode": "...",
    "queryText": "what are you doing?",
    "intent": {
      "name": "chatgpt_speak",
      "confidence": 1
    }
  },
  "languageCode": "en",
  "index": 6495
}
```

AIBI then fetches the returned `/tts/dl/<id>` URL.

### Local AI Intent Shape

The local replacement asks OpenRouter for strict JSON with this flat shape:

```json
{
  "speech_text": "short text to speak, or empty",
  "speech_listen": 0,
  "chat_mode": "unchanged",
  "action_behavior": "ability_dance",
  "action_params_json": "{}",
  "recognition_enabled": false,
  "pre_animation": "",
  "post_animation": "",
  "post_behavior": ""
}
```

Valid `chat_mode` values are `unchanged`, `connect`, and `quit`.

The AI receives native behavior IDs from the extracted 1.6.0 firmware string table. Unknown behavior IDs are discarded before a response is sent to AIBI.

`pre_animation`, `post_animation`, and `post_behavior` are present in cloud `interact_speak` payloads, but those exact field names are not present in the 1.6.0 firmware string table. The local AI therefore leaves them empty until there is code-derived evidence for valid values.

Capabilities are seeded from the 1.6.0 firmware and merged with live observed server traffic as one normal capability set. Firmware-seeded names are not ranked below observed names.

Known action params are passed as `action_params_json`, a JSON object encoded as a string. Examples:

- `ability_chatgpt`: `{ "type": "connect" }` or `{ "type": "quit" }`
- `ability_light_control`: `{ "control": "blue" }`, `green`, `yellow`, `pink`, `orange`, or `purple`
- `ability_movement`: `{ "direction": "left" }`, `right`, or `around`
- `function_update`: `{ "type": "check" }` or `{ "type": "start" }`
- `interact_answer_with_animation`: `{ "animation_name": "<firmware animation name>" }`

Firmware strings show `interact_answer_with_animation` next to the `animation_name` parameter; this is the supported path for choosing one of the firmware animation names. It is separate from `pre_animation`, `post_animation`, and `post_behavior`.

### Local Response Selection

The local proxy maps the AI intent to one AIBI response:

- `chat_mode = connect` sends `ability_chatgpt` with `behavior_paras.type = "connect"`.
- `chat_mode = quit` sends `ability_chatgpt` with `behavior_paras.type = "quit"`.
- `recognition_enabled = true` with no speech sends `interact_recognize`.
- If action-after-speech is off, `action_behavior` sends a direct native action such as `ability_dance`, `ability_sing`, or `ability_animal`.
- If speech is present, the proxy sends `interact_speak` with a generated TTS URL.
- Action-after-speech is disabled unless code-derived `post_behavior` values are available.
- Parameterized actions are sent as direct native actions because `post_behavior` has no known place to carry `behavior_paras`.
- If no useful intent is produced, the proxy speaks the local fallback text.

### Exit Conversation Mode

Observed after a `detectintent` request with `role=chatgpt`:

```json
{
  "queryId": "...",
  "queryResult": {
    "resultCode": "...",
    "queryText": "",
    "intent": {
      "name": "ability_chatgpt",
      "confidence": 1
    },
    "rec_behavior": "ability_chatgpt",
    "behavior_paras": {
      "type": "quit"
    }
  },
  "languageCode": "en",
  "index": 6887
}
```

In local mode, chat mode can end in two ways:

- The AI returns `chat_mode = "quit"` for user phrases such as stop, goodbye, or end the conversation.
- If AIBI sends a chat-mode voice request and the raw mic audio looks silent, the proxy returns the same `ability_chatgpt` quit response without calling OpenRouter.

## Proactive Chat Flow

### Request

```http
GET /aibi/chat/start?lang=en&tz=Asia/Bangkok HTTP/1.1
Host: api.aibipocket.com
```

### Response

```json
{
  "errcode": 0,
  "url": "http://api.aibipocket.com/tts/dl/202604262a1b13b7e7be7915c058010b5412532d",
  "errmsg": "OK",
  "responsetag": "chatstart"
}
```

AIBI then fetches the returned TTS URL.

This is similar to ChatGPT conversation mode because later voice turns may use `detectintent` with `role=chatgpt`, but the entry point is different:

- User-initiated chat starts with `detectintent` returning `ability_chatgpt` and `behavior_paras.type = "connect"`.
- Proactive chat starts with `GET /aibi/chat/start`, which returns a TTS URL directly.

## Image Recognition Flow

### Step 1: Voice Intent

AIBI first sends a normal `POST /aibi/voice/detectintent?...`.

Observed response:

```json
{
  "queryId": "...",
  "queryResult": {
    "resultCode": "...",
    "queryText": "what is this?",
    "intent": {
      "name": "ability_photo_recog",
      "confidence": "0.7870"
    },
    "rec_behavior": "interact_recognize",
    "behavior_paras": []
  },
  "languageCode": "en",
  "index": 545
}
```

### Step 2: Image Recognition Upload

```http
POST /aibi/ai/imgrecog?languageCode=en HTTP/1.1
Host: api.aibipocket.com
Content-Type: application/octet-stream
Transfer-Encoding: chunked
```

Body is binary image/camera data.

## Local Audio Handling

### Input Audio

Observed AIBI voice uploads are headerless raw PCM. The local proxy treats raw voice audio as:

- 16 kHz
- mono
- signed 16-bit big-endian PCM

For models with native audio input, the proxy wraps this PCM as WAV and sends it directly to OpenRouter. If the selected OpenRouter model does not support audio input, the proxy sends the WAV to Fish speech-to-text first and passes the transcript to OpenRouter.

### TTS Generation

AIBI fetches TTS through `/tts/dl/<id>`. In override mode, the proxy opens the TTS stream before returning the URL, then streams audio through `/tts/dl/<id>`.

TTS order:

1. If the selected OpenRouter model supports audio output and OpenRouter TTS settings are present, use OpenRouter TTS.
2. Otherwise use Fish Audio TTS.

Fish Audio settings currently used by the local proxy:

- backend/model: `s2-pro`
- format: `mp3`
- sample rate: `32000`
- MP3 bitrate: `64`
- latency: `balanced`
- chunk length: `100`
- normalize: `true`

Fish docs list `balanced` as the faster latency mode, with `normal` as the higher-stability mode. Fish docs list MP3 output sample rates as 32 kHz and 44.1 kHz, so 32 kHz is the lowest documented MP3 sample rate.
