# VORTEX

License Management System — Web-based

## URLs

- `/` — License verification & product download
- `/panel` — Admin panel

## Deploy

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/repo?repo=https://github.com/dadamoayu2-coder/vortex)

## Default Login

- URL: `https://your-app.onrender.com/panel`
- Username: `admin`
- Password: `admin`

## How It Works

1. Admin uploads product EXE via `/panel` → server encrypts with AES-256-GCM
2. User visits `/` → enters license key → verified by server
3. User clicks "Download Product" → encrypted file downloaded directly in browser
