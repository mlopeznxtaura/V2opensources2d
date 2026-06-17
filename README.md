# Screen2D V2

Browser screen recorder with dual video feeds, optional in-browser virtual background (physical webcams only), and passthrough for NVIDIA Broadcast / OBS virtual cameras.

**Live:** https://app5.nextaura.fit

## Principles

- **No device blocking** — every video input appears in every feed dropdown; your selection is used as-is.
- **Virtual cam passthrough** — NVIDIA Broadcast, OBS Virtual Camera, etc. are never processed by BodyPix.
- **Preview = real video** — the webcam circle is a DOM `<video>` element, not a hidden off-screen decoder.
- **100% client-side** — no accounts, no server storage.

## Deploy

```powershell
.\scripts\rebuild-ce.ps1
cd workers && npx wrangler deploy
```

## License

ISC
