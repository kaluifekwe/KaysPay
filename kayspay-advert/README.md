# KSP Adverts

Reusable creative-production workspace for KaysPay social media content.

## Purpose

This project is separate from the financial application. Use it for social posts, product mockups, campaign images, Reels, TikTok videos, YouTube adverts, voice-overs, motion graphics, captions, music, and final exports.

Never copy `.env` files, API credentials, customer information, transaction records, NIN data, BVN data, phone numbers, or other sensitive application data into this project.

## Common commands

```powershell
npm.cmd install
npm.cmd run lint
npm.cmd run dev
npx.cmd remotion render KaysPay-2Minute-Advert output\campaign-name.mp4
```

## Workflow

1. Create a dated campaign folder under `projects/`.
2. Save the approved brief and prompts in that folder.
3. Copy approved brand assets into `brand/` or campaign-specific assets into `assets/`.
4. Reuse components and scenes from `src/`.
5. Render drafts into `output/drafts/`.
6. Move approved deliverables into `output/approved/` without overwriting earlier versions.
7. Record the final prompt and output names in `prompts/content-history.md`.

## Existing production

The first reusable composition is `KaysPay-2Minute-Advert`. It includes Nigerian English narration, original background music, animated service scenes, and action-focused calls to action.
