# AiBi Server

Local Electron console and Node proxy for an owned AiBi robot.

## Setup

```sh
npm install
npm run allow-low-ports
npm run start
```

The proxy listens on HTTP `:80` and HTTPS `:443`. Local runtime files are intentionally ignored:

- `aibi.key` / `aibi.crt`
- `aibi.sqlite*`
- `captures/`
- `logs/`
- `tts/`

## Notes

API notes are in `docs/api.md`.
