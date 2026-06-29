# EMS — Windows Setup Guide

Step-by-step setup for running the Expense Management System on **Windows 10/11**
using PowerShell. (For macOS/Linux see the quick steps in `app/README.md`.)

There are two ways to run it on Windows:

- **Option A — Native Windows** (Node + PostgreSQL installed on Windows). Simplest
  if you just want it running.
- **Option B — WSL2 (Ubuntu)** (recommended if you're comfortable with Linux) —
  then follow the macOS/Linux instructions in `app/README.md` inside WSL.

This guide focuses on **Option A**.

---

## 1. Prerequisites

Install these once. The fastest path is `winget` (built into Windows 11 and
recent Windows 10); installer links are given as an alternative.

### 1.1 Node.js (18+)
```powershell
winget install OpenJS.NodeJS.LTS
```
Or download the LTS MSI from <https://nodejs.org>. Verify in a **new** terminal:
```powershell
node -v
npm -v
```

### 1.2 Git
```powershell
winget install Git.Git
```

### 1.3 PostgreSQL (14+)
```powershell
winget install PostgreSQL.PostgreSQL.16
```
Or use the EDB installer: <https://www.postgresql.org/download/windows/>.

During install:
- **Remember the password** you set for the `postgres` superuser — you'll need it
  in the connection string.
- Keep the default **port 5432**.
- Let it install the **command-line tools** (`psql`, `createdb`).

### 1.4 (Optional) Redis
Redis is **optional** — the app automatically falls back to an in-memory cache if
it's not present, so you can skip this. If you want it on Windows, use **Memurai**
(<https://www.memurai.com>) or run Redis inside WSL2. If you skip it, leave
`REDIS_URL` unset (see §3).

---

## 2. Add the PostgreSQL tools to PATH (so `psql` / `createdb` work)

The installer usually adds them, but if `psql` is "not recognized", add the
`bin` folder to your PATH:

1. Find it — typically `C:\Program Files\PostgreSQL\16\bin`.
2. Start menu → **"Edit the system environment variables"** → **Environment
   Variables** → under *User variables* select **Path** → **Edit** → **New** →
   paste the `bin` path → OK.
3. **Open a new PowerShell window** and check:
```powershell
psql --version
createdb --version
```

---

## 3. Get the code and configure

```powershell
git clone https://github.com/divyam59/expense-management-system.git
cd expense-management-system\app
npm install
copy .env.example .env
```

Now edit **`.env`** (e.g. `notepad .env`). The important line is the Postgres
connection string — on Windows the `postgres` user has a **password**, so include
it:

```ini
DATABASE_URL=postgres://postgres:YOUR_PASSWORD@localhost:5432/ems
TEST_DATABASE_URL=postgres://postgres:YOUR_PASSWORD@localhost:5432/ems_test

# Leave Redis unset to use the in-memory cache, or point it at Memurai/WSL:
# REDIS_URL=redis://localhost:6379
```

> If your password contains special characters (`@ : / #`), URL-encode them
> (e.g. `@` → `%40`).

---

## 4. Create the databases

Using the tools from §2 (you'll be prompted for the `postgres` password):

```powershell
createdb -U postgres ems
createdb -U postgres ems_test
```

**No `createdb`?** Use `psql` instead:
```powershell
psql -U postgres -c "CREATE DATABASE ems;"
psql -U postgres -c "CREATE DATABASE ems_test;"
```

**Prefer a GUI?** Open **pgAdmin** (installed with PostgreSQL) → right-click
*Databases* → *Create* → *Database…* → name it `ems` (repeat for `ems_test`).

---

## 5. Migrate, seed, and run

```powershell
npm run setup     # runs migrations + seeds sample data into `ems`
npm run dev       # starts the server
```

Open the UI at **http://localhost:4000/**

Sample logins (password `password123`): `admin@acme.test`, `cfo@acme.test`,
`manager@acme.test`, `riya@acme.test`.

> Want a clean slate instead of full sample data? Run `npm run seed:minimal` —
> it leaves one org with one user per role and nothing else.

---

## 6. Run the tests

Tests run against the `ems_test` database created in §4:
```powershell
npm test            # full suite
npm run test:cov    # with coverage
```

---

## 7. Useful npm scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the API + UI on http://localhost:4000 |
| `npm run setup` | Migrate **and** seed sample data |
| `npm run migrate` | Run DB migrations only |
| `npm run seed` | Seed full demo data |
| `npm run seed:minimal` | Reset to 1 org + 4 role users (clean slate) |
| `npm test` | Run the test suite |
| `npm run build` | Compile TypeScript to `dist/` |

---

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| `psql`/`createdb` not recognized | Add PostgreSQL `bin` to PATH (§2) and open a **new** terminal |
| `password authentication failed for user "postgres"` | Wrong password in `DATABASE_URL`; or URL-encode special characters |
| `database "ems" does not exist` | You skipped §4 — create `ems` and `ems_test` |
| `ECONNREFUSED 127.0.0.1:5432` | PostgreSQL service isn't running — start **"postgresql-x64-16"** in *Services* (`services.msc`) |
| `EADDRINUSE: port 4000` | Another process uses 4000. Find it: `netstat -ano \| findstr :4000`, then `taskkill /PID <pid> /F` |
| Redis connection errors | Safe to ignore — the app falls back to in-memory cache. Or unset `REDIS_URL` |
| `npm install` fails on native build | Ensure Node LTS is installed (§1.1); reopen the terminal so PATH is fresh |
| Git line-ending warnings (CRLF/LF) | Harmless; optionally `git config core.autocrlf true` |

---

## 9. WSL2 alternative (Option B)

If you prefer a Linux environment:
1. `wsl --install` (installs Ubuntu), reboot if prompted.
2. Inside Ubuntu, install Node + PostgreSQL with `apt`, start Postgres, then
   follow the macOS/Linux steps in `app/README.md`.
3. Access the UI from Windows at `http://localhost:4000` (WSL2 forwards the port).
