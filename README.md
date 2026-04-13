# Tab Tidy Side Panel (Plasmo + TypeScript)

This is a Chrome extension built with the **Plasmo framework** and **TypeScript**.

## What it does

- Side panel UI for tab management
- Dedupes duplicate tabs (keeps the best candidate: active/pinned/recent)
- Finds and closes old tabs by threshold
- Groups tabs by domain
- Supports "current window only" mode

## Run

```bash
npm install
npm run dev
```

Then in Chrome:

1. Open `chrome://extensions`
2. Enable Developer mode
3. Load unpacked extension from `tab-organizer-plasmo/build/chrome-mv3-dev`

For production build:

```bash
npm run build
```

Output will be under `build/chrome-mv3-prod`.
