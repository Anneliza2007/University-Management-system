# University Management Dashboard

A full-stack university faculty and facilities management system built with Node.js, Express, and modern web technologies. Supports full CRUD operations, live metrics, bulk CSV data importing, and dual-mode database support (automated zero-config local storage or enterprise Oracle Database).

---

## Prerequisites

Before running the application locally, ensure you have the following installed on your computer:

- **Node.js**: Version 18.0.0 or higher ([Download Node.js](https://nodejs.org/))
- **npm**: Comes bundled with Node.js (or you can use `yarn`, `pnpm`, or `bun`)

---

## How to Download & Run Locally

### 1. Download the Project Files
- In the top-right menu of your browser interface, click the **Settings / Code** menu and select **Export to ZIP** or **Download ZIP** (or clone the repository if connected to GitHub).
- Extract the downloaded ZIP archive into a folder on your computer (e.g., `~/Documents/university-management-dashboard`).

### 2. Open a Terminal
- Open your preferred terminal (Terminal on macOS/Linux, Command Prompt or PowerShell on Windows, or the integrated terminal in VS Code).
- Navigate to the project directory:
  ```bash
  cd path/to/university-management-dashboard
  ```

### 3. Install Dependencies
Run the following command in your terminal to install all required packages:
```bash
npm install
```

### 4. Configure Environment Variables (Optional)
Copy the example environment file:
```bash
cp .env.example .env
```

The system works **out-of-the-box** without any configuration:
- **Default Database**: If no Oracle Database credentials are provided, the server automatically boots up with a self-initializing, high-performance SQLite engine that persists data to `uni_database.sqlite` and loads `uni_schema.txt` and `uni_entries.txt`.
- **Oracle Database (Optional)**: If you wish to connect to an external Oracle instance, simply fill in your credentials in `.env`:
  ```env
  ORACLE_USER=my_user
  ORACLE_PASSWORD=my_password
  ORACLE_CONNECT_STRING=localhost:1521/XEPDB1
  PORT=3000
  ```

### 5. Start the Application
Run:
```bash
npm run dev
```
*(or `npm start` / `node server.js`)*

### 6. Open the Dashboard in Your Browser
Navigate to:
```
http://localhost:3000
```

---

## Default Login Credentials
- **Username**: `admin`
- **Password**: `admin123`

---

## Project Structure
- `server.js` - Express API backend, database connector (Oracle / SQLite fallback), and schema initializer.
- `public/index.html` - Responsive single-page dashboard with Faculty directory, Classrooms/Labs management, Schema inspector, live search/filtering, and Bulk CSV import.
- `uni_schema.txt` - SQL DDL table creation scripts (`TEACHER` and `ROOM`).
- `uni_entries.txt` - SQL sample seed entries.
- `package.json` - Node dependencies and run scripts.
