# VORTEX

License Management System with Encrypted Product Delivery

## Features

- **Admin Panel** - Web-based management for products, keys, and clients
- **VORTEX Launcher** - Electron app for license verification and secure product execution
- **AES-256-GCM Encryption** - Product executables encrypted at rest
- **Memory Execution** - Products decrypted and run in memory, never stored unencrypted on disk
- **HWID Locking** - Keys bound to hardware identifiers
- **Real-time Monitoring** - Online client tracking with heartbeat system
- **Audit Logs** - Complete activity tracking

## Deploy

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/repo?repo=https://github.com/dadamoayu2-coder/vortex)

## Quick Start

### Web Server
```bash
npm install
npm start
```
Panel: http://localhost:8080/panel
Default login: admin / admin

### Build Launcher (EXE)
```bash
npm run build:launcher
```
Output: `dist/VORTEX.exe`

## Architecture

```
Admin Panel (Web)  ←→  Express Server (Render)  ←→  VORTEX Launcher (EXE)
     ↓                       ↓                           ↓
  Product/Key Mgmt    AES-256 Encrypted Storage    License Verify → Memory Execute
  Dashboard           Heartbeat API                Auto Update Check
  Client Monitoring   Audit Logs
```

## API Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/login` | POST | No | Admin login |
| `/api/verify` | POST | No | License key verification |
| `/api/heartbeat` | POST | No | Client heartbeat |
| `/api/version` | GET | No | Server version info |
| `/api/product-download/:token` | GET | No | Download encrypted product |
| `/api/products` | GET/POST | Yes | Manage products |
| `/api/keys` | GET/POST | Yes | Manage license keys |
| `/api/clients` | GET | Yes | View connected clients |
| `/api/logs` | GET | Yes | View audit logs |
| `/api/settings` | GET/PUT | Yes | System settings |
