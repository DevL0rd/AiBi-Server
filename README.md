# AIBI Server

Electron console and override proxy for an owned AIBI.

## Setup

```sh
npm install
npm run dev
```

Use `npm run build` and `npm start` only when you want to run the built renderer.

The proxy listens on HTTP `:80`, HTTPS `:443`, and DNS `:53`.

Point AIBI's DNS server at the LAN IP of the computer running this app. The built-in DNS server answers `api.aibipocket.com` with that LAN IP and forwards other DNS questions to `1.1.1.1`.

Local runtime files are intentionally ignored:

- `aibi.key` / `aibi.crt`
- `aibi.sqlite*`
- `firmware/`
- `logs/`
- `chat-media/`

## Notes

API notes are in `docs/api.md`.
