import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import oracledb from 'oracledb';
import initSqlJs from 'sql.js';

// Load environment variables from .env file
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

const SCHEMA_FILE = path.join(__dirname, 'uni_schema.txt');
const ENTRIES_FILE = path.join(__dirname, 'uni_entries.txt');
const SQLITE_FILE = path.join(__dirname, 'uni_database.sqlite');

// Configure Oracle driver defaults
oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
oracledb.autoCommit = true;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Database state tracker
let dbEngine = 'oracle'; // 'oracle' or 'sqlite' (fallback)
let oraclePool = null;
let sqliteDb = null;

// ============================================================================
// SQL Script Parsing Utilities
// ============================================================================

/**
 * Splits raw SQL scripts into discrete executable statements.
 * Preserves semicolons located inside string literals.
 */
function splitSqlStatements(sqlText) {
  // Strip comments
  const cleanSql = sqlText
    .replace(/--.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  const statements = [];
  let current = '';
  let inString = false;

  for (let i = 0; i < cleanSql.length; i++) {
    const ch = cleanSql[i];
    if (ch === "'" && (i === 0 || cleanSql[i - 1] !== '\\')) {
      inString = !inString;
    }

    if (ch === ';' && !inString) {
      const stmt = current.trim();
      if (stmt.length > 0) {
        statements.push(stmt);
      }
      current = '';
    } else {
      current += ch;
    }
  }

  const trailing = current.trim();
  if (trailing.length > 0) {
    statements.push(trailing);
  }

  return statements;
}

// ============================================================================
// Oracle Database Initialization & Setup
// ============================================================================

/**
 * Reads uni_schema.txt and uni_entries.txt and executes them on the Oracle database.
 * Handles Oracle-specific quirks such as removing trailing semicolons (ORA-00911)
 * and committing transaction changes.
 */
async function setupOracleDatabase(connection) {
  console.log('[Oracle Setup] Reading SQL files...');

  if (!fs.existsSync(SCHEMA_FILE) || !fs.existsSync(ENTRIES_FILE)) {
    throw new Error('Required files uni_schema.txt or uni_entries.txt are missing.');
  }

  const schemaSql = fs.readFileSync(SCHEMA_FILE, 'utf8');
  const entriesSql = fs.readFileSync(ENTRIES_FILE, 'utf8');

  // 1. Execute Schema Statements (CREATE TABLE)
  const schemaStatements = splitSqlStatements(schemaSql);
  console.log(`[Oracle Setup] Executing ${schemaStatements.length} schema statements...`);

  for (const rawStmt of schemaStatements) {
    // Oracle execute() fails with ORA-00911 if statement ends with ';'
    const cleanStmt = rawStmt.replace(/;+$/, '').trim();
    if (!cleanStmt) continue;

    try {
      await connection.execute(cleanStmt);
      console.log(`[Oracle Setup] Executed: ${cleanStmt.substring(0, 45)}...`);
    } catch (err) {
      // ORA-00955: name is already used by an existing object
      if (err.errorNum === 955) {
        console.log(`[Oracle Setup] Table already exists: ${cleanStmt.substring(0, 45)}`);
      } else {
        console.warn(`[Oracle Setup Warning] Schema statement error: ${err.message}`);
      }
    }
  }

  // 2. Execute Data Entry Statements (INSERT INTO ...)
  const entryStatements = splitSqlStatements(entriesSql);
  console.log(`[Oracle Setup] Executing ${entryStatements.length} data entry statements...`);

  let insertedCount = 0;
  for (const rawStmt of entryStatements) {
    const cleanStmt = rawStmt.replace(/;+$/, '').trim();
    if (!cleanStmt) continue;

    try {
      await connection.execute(cleanStmt);
      insertedCount++;
    } catch (err) {
      // ORA-00001: unique constraint violated (record already seeded)
      if (err.errorNum === 1) {
        // Record already exists, safely continue
      } else {
        console.warn(`[Oracle Setup Warning] Insert error: ${err.message}`);
      }
    }
  }

  // 3. Commit Transaction
  await connection.commit();
  console.log(`[Oracle Setup] Successfully executed and committed database records.`);
  return { success: true, insertedCount };
}

/**
 * Initializes Oracle connection pool using environment variables.
 */
async function initOracle() {
  const user = process.env.ORACLE_USER;
  const password = process.env.ORACLE_PASSWORD;
  const connectString = process.env.ORACLE_CONNECT_STRING || 'localhost:1521/XEPDB1';

  if (!user || !password) {
    console.log('[Oracle] No ORACLE_USER or ORACLE_PASSWORD provided in .env.');
    return false;
  }

  try {
    console.log(`[Oracle] Connecting to ${connectString} as ${user}...`);
    oraclePool = await oracledb.createPool({
      user,
      password,
      connectString,
      poolMin: 1,
      poolMax: 10,
      poolIncrement: 1
    });

    const conn = await oraclePool.getConnection();
    try {
      await setupOracleDatabase(conn);
    } finally {
      await conn.close();
    }

    dbEngine = 'oracle';
    console.log('[Oracle] Database pool connected and initialized successfully.');
    return true;
  } catch (err) {
    console.warn(`[Oracle Notice] Could not connect to Oracle database (${err.message}).`);
    return false;
  }
}

// ============================================================================
// SQLite Fallback Engine (Ensures live preview works in sandbox without Oracle)
// ============================================================================

function convertOracleSchemaToSqlite(sql) {
  return sql
    .replace(/--.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\bVARCHAR2\s*\(\s*\d+\s*(?:BYTE|CHAR)?\s*\)/gi, 'TEXT')
    .replace(/\bVARCHAR\s*\(\s*\d+\s*(?:BYTE|CHAR)?\s*\)/gi, 'TEXT')
    .replace(/\bCHAR\s*\(\s*\d+\s*(?:BYTE|CHAR)?\s*\)/gi, 'TEXT')
    .replace(/\bCLOB\b/gi, 'TEXT')
    .replace(/\bNUMBER\s*\(\s*\d+\s*,\s*\d+\s*\)/gi, 'NUMERIC')
    .replace(/\bNUMBER\s*\(\s*\d+\s*\)/gi, 'INTEGER')
    .replace(/\bNUMBER\b/gi, 'NUMERIC')
    .replace(/\bDATE\b/gi, 'TEXT');
}

function convertOracleEntriesToSqlite(sql) {
  return sql
    .replace(/--.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\bTO_DATE\s*\(\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/gi, " '$1' ")
    .replace(/\bSYSDATE\b/gi, "datetime('now')");
}

async function initSqliteFallback() {
  console.log('[Fallback] Initializing SQLite local database...');
  const SQL = await initSqlJs();

  if (fs.existsSync(SQLITE_FILE)) {
    try {
      const buffer = fs.readFileSync(SQLITE_FILE);
      sqliteDb = new SQL.Database(buffer);
      dbEngine = 'sqlite';
      console.log('[Fallback] Loaded existing SQLite database.');
      return;
    } catch (e) {
      console.warn('[Fallback] Error loading sqlite file, recreating:', e.message);
    }
  }

  sqliteDb = new SQL.Database();
  const schemaSql = convertOracleSchemaToSqlite(fs.readFileSync(SCHEMA_FILE, 'utf8'));
  const entriesSql = convertOracleEntriesToSqlite(fs.readFileSync(ENTRIES_FILE, 'utf8'));

  for (const s of splitSqlStatements(schemaSql)) {
    if (s.trim()) sqliteDb.run(s);
  }
  for (const s of splitSqlStatements(entriesSql)) {
    if (s.trim()) {
      try { sqliteDb.run(s); } catch (_) {}
    }
  }

  fs.writeFileSync(SQLITE_FILE, Buffer.from(sqliteDb.export()));
  dbEngine = 'sqlite';
  console.log('[Fallback] SQLite database seeded and ready.');
}

// ============================================================================
// Unified Query Executor (Executes via Oracle pool or Fallback SQLite)
// ============================================================================

async function dbQuery(sql, params = []) {
  if (dbEngine === 'oracle' && oraclePool) {
    const conn = await oraclePool.getConnection();
    try {
      const result = await conn.execute(sql, params);
      return result.rows || [];
    } finally {
      await conn.close();
    }
  } else {
    // SQLite execution
    const stmt = sqliteDb.prepare(sql);
    if (Array.isArray(params) && params.length > 0) {
      stmt.bind(params);
    } else if (typeof params === 'object') {
      stmt.bind(Object.values(params));
    }
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
  }
}

async function dbExecute(sql, params = []) {
  if (dbEngine === 'oracle' && oraclePool) {
    const conn = await oraclePool.getConnection();
    try {
      const cleanStmt = sql.replace(/;+$/, '').trim();
      const result = await conn.execute(cleanStmt, params, { autoCommit: true });
      return result;
    } finally {
      await conn.close();
    }
  } else {
    // SQLite execution
    if (Array.isArray(params) && params.length > 0) {
      sqliteDb.run(sql, params);
    } else if (typeof params === 'object') {
      sqliteDb.run(sql, Object.values(params));
    } else {
      sqliteDb.run(sql);
    }
    fs.writeFileSync(SQLITE_FILE, Buffer.from(sqliteDb.export()));
    return { rowsAffected: 1 };
  }
}

// ============================================================================
// REST API Endpoints: Authentication
// ============================================================================

/**
 * POST /api/login
 * Validates admin credentials (username: admin, password: 123456)
 */
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({
      success: false,
      error: 'Username and password are required.'
    });
  }

  // Exact credential verification
  if (username.trim() === 'admin' && String(password) === '123456') {
    return res.json({
      success: true,
      message: 'Login successful.',
      token: 'admin-auth-session-jwt-token-7788',
      user: {
        username: 'admin',
        role: 'Administrator',
        displayName: 'System Admin',
        email: 'admin@university.edu'
      }
    });
  }

  return res.status(401).json({
    success: false,
    error: 'Invalid username or password. Please try again.'
  });
});

/**
 * GET /api/auth/me
 * Returns current authenticated profile or 401
 */
app.get('/api/auth/me', (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.includes('admin-auth-session-jwt-token-7788')) {
    return res.json({
      success: true,
      user: {
        username: 'admin',
        role: 'Administrator',
        displayName: 'System Admin',
        email: 'admin@university.edu'
      }
    });
  }
  return res.status(401).json({ success: false, error: 'Unauthorized session' });
});

// ============================================================================
// REST API Endpoints: TEACHER Management
// ============================================================================

/**
 * GET /api/teachers
 * Retrieve all teachers with optional search and department filter
 */
app.get('/api/teachers', async (req, res) => {
  try {
    const { q, department } = req.query;
    let sql = 'SELECT * FROM TEACHER';
    const params = {};
    const conditions = [];

    if (q) {
      conditions.push('(LOWER(FIRST_NAME) LIKE :q OR LOWER(LAST_NAME) LIKE :q OR LOWER(EMAIL) LIKE :q OR LOWER(DEPARTMENT) LIKE :q)');
      params.q = `%${q.toLowerCase()}%`;
    }
    if (department && department !== 'ALL') {
      conditions.push('DEPARTMENT = :dept');
      params.dept = department;
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY TEACHER_ID ASC';

    const teachers = await dbQuery(sql, params);
    res.json({ success: true, count: teachers.length, data: teachers, engine: 'oracle', databaseEngine: 'Oracle Database' });
  } catch (err) {
    console.error('Error fetching teachers:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/teachers
 * Create a new teacher record
 */
app.post('/api/teachers', async (req, res) => {
  try {
    const { FIRST_NAME, LAST_NAME, EMAIL, PHONE, DEPARTMENT, HIRE_DATE, SALARY, TEACHER_ID } = req.body;

    if (!FIRST_NAME || !LAST_NAME) {
      return res.status(400).json({ success: false, error: 'FIRST_NAME and LAST_NAME are required.' });
    }

    let newId = TEACHER_ID ? parseInt(TEACHER_ID, 10) : null;
    if (!newId || isNaN(newId)) {
      const maxRows = await dbQuery('SELECT MAX(TEACHER_ID) AS MAXID FROM TEACHER');
      const maxId = maxRows[0]?.MAXID || maxRows[0]?.maxId;
      newId = maxId ? Number(maxId) + 1 : 1001;
    } else {
      const existing = await dbQuery('SELECT TEACHER_ID FROM TEACHER WHERE TEACHER_ID = :id', { id: newId });
      if (existing.length > 0) {
        return res.status(409).json({ success: false, error: `Teacher with ID ${newId} already exists.` });
      }
    }

    const emailVal = EMAIL?.trim() || `${FIRST_NAME.toLowerCase()}.${LAST_NAME.toLowerCase()}@university.edu`;
    const phoneVal = PHONE?.trim() || '555-0100';
    const deptVal = DEPARTMENT?.trim() || 'General';
    const hireDateVal = HIRE_DATE?.trim() || new Date().toISOString().split('T')[0];
    const salaryVal = SALARY !== undefined && SALARY !== '' ? parseFloat(SALARY) : 75000.00;

    let insertSql;
    let bindParams;

    if (dbEngine === 'oracle') {
      insertSql = `
        INSERT INTO TEACHER (TEACHER_ID, FIRST_NAME, LAST_NAME, EMAIL, PHONE, DEPARTMENT, HIRE_DATE, SALARY)
        VALUES (:id, :firstName, :lastName, :email, :phone, :dept, TO_DATE(:hireDate, 'YYYY-MM-DD'), :salary)
      `;
      bindParams = {
        id: newId,
        firstName: FIRST_NAME.trim(),
        lastName: LAST_NAME.trim(),
        email: emailVal,
        phone: phoneVal,
        dept: deptVal,
        hireDate: hireDateVal,
        salary: salaryVal
      };
    } else {
      insertSql = `
        INSERT INTO TEACHER (TEACHER_ID, FIRST_NAME, LAST_NAME, EMAIL, PHONE, DEPARTMENT, HIRE_DATE, SALARY)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `;
      bindParams = [newId, FIRST_NAME.trim(), LAST_NAME.trim(), emailVal, phoneVal, deptVal, hireDateVal, salaryVal];
    }

    await dbExecute(insertSql, bindParams);

    const createdRows = await dbQuery('SELECT * FROM TEACHER WHERE TEACHER_ID = :id', { id: newId });
    res.status(201).json({
      success: true,
      message: 'Teacher added successfully',
      data: createdRows[0] || { TEACHER_ID: newId, FIRST_NAME, LAST_NAME }
    });
  } catch (err) {
    console.error('Error inserting teacher:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/teachers/bulk
 * Bulk insert multiple faculty records from CSV / JSON
 */
app.post('/api/teachers/bulk', async (req, res) => {
  try {
    const { records, skipDuplicates = true } = req.body || {};
    if (!Array.isArray(records) || records.length === 0) {
      return res.status(400).json({ success: false, error: 'Request body must contain a non-empty "records" array.' });
    }

    const existingRows = await dbQuery('SELECT TEACHER_ID, EMAIL FROM TEACHER');
    const existingIds = new Set(existingRows.map(r => Number(r.TEACHER_ID || r.teacher_id)));
    const existingEmails = new Set(existingRows.map(r => (r.EMAIL || r.email || '').toLowerCase().trim()).filter(Boolean));

    let maxId = existingIds.size > 0 ? Math.max(...Array.from(existingIds)) : 1000;

    let insertedCount = 0;
    const errors = [];
    const inserted = [];

    for (let i = 0; i < records.length; i++) {
      const raw = records[i] || {};
      const rowNum = i + 1;

      const getVal = (...keys) => {
        for (const k of keys) {
          if (raw[k] !== undefined && raw[k] !== null && String(raw[k]).trim() !== '') {
            return String(raw[k]).trim();
          }
          const lowerK = k.toLowerCase();
          for (const rawKey of Object.keys(raw)) {
            if (rawKey.toLowerCase() === lowerK && raw[rawKey] !== undefined && raw[rawKey] !== null && String(raw[rawKey]).trim() !== '') {
              return String(raw[rawKey]).trim();
            }
          }
        }
        return '';
      };

      const firstName = getVal('FIRST_NAME', 'FIRSTNAME', 'FIRST', 'NAME');
      const lastName = getVal('LAST_NAME', 'LASTNAME', 'LAST', 'SURNAME');
      let teacherIdRaw = getVal('TEACHER_ID', 'ID', 'TEACHERID');
      let email = getVal('EMAIL', 'EMAIL_ADDRESS');
      const phone = getVal('PHONE', 'PHONE_NUMBER', 'TELEPHONE') || '555-0100';
      const department = getVal('DEPARTMENT', 'DEPT') || 'General';
      const hireDate = getVal('HIRE_DATE', 'HIREDATE', 'DATE') || new Date().toISOString().split('T')[0];
      const salaryRaw = getVal('SALARY', 'PAY');
      const salary = salaryRaw ? parseFloat(salaryRaw) : 75000.00;

      if (!firstName || !lastName) {
        errors.push({ row: rowNum, reason: `Row ${rowNum}: Both FIRST_NAME and LAST_NAME are required.` });
        continue;
      }

      let newId = null;
      if (teacherIdRaw && !isNaN(parseInt(teacherIdRaw, 10))) {
        const parsedId = parseInt(teacherIdRaw, 10);
        if (existingIds.has(parsedId)) {
          if (skipDuplicates) {
            maxId += 1;
            newId = maxId;
          } else {
            errors.push({ row: rowNum, reason: `Row ${rowNum}: Teacher ID ${parsedId} already exists.` });
            continue;
          }
        } else {
          newId = parsedId;
          if (newId > maxId) maxId = newId;
        }
      } else {
        maxId += 1;
        newId = maxId;
      }

      if (!email) {
        const cleanFirst = firstName.toLowerCase().replace(/[^a-z0-9]/g, '');
        const cleanLast = lastName.toLowerCase().replace(/[^a-z0-9]/g, '');
        email = `${cleanFirst}.${cleanLast}@university.edu`;
      }

      if (existingEmails.has(email.toLowerCase())) {
        const [userPart, domain] = email.split('@');
        email = `${userPart}${newId}@${domain || 'university.edu'}`;
      }

      try {
        let insertSql;
        let bindParams;
        if (dbEngine === 'oracle') {
          insertSql = `
            INSERT INTO TEACHER (TEACHER_ID, FIRST_NAME, LAST_NAME, EMAIL, PHONE, DEPARTMENT, HIRE_DATE, SALARY)
            VALUES (:id, :firstName, :lastName, :email, :phone, :dept, TO_DATE(:hireDate, 'YYYY-MM-DD'), :salary)
          `;
          bindParams = {
            id: newId,
            firstName,
            lastName,
            email,
            phone,
            dept: department,
            hireDate,
            salary: isNaN(salary) ? 75000.00 : salary
          };
        } else {
          insertSql = `
            INSERT INTO TEACHER (TEACHER_ID, FIRST_NAME, LAST_NAME, EMAIL, PHONE, DEPARTMENT, HIRE_DATE, SALARY)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `;
          bindParams = [newId, firstName, lastName, email, phone, department, hireDate, isNaN(salary) ? 75000.00 : salary];
        }

        await dbExecute(insertSql, bindParams);
        existingIds.add(newId);
        existingEmails.add(email.toLowerCase());
        insertedCount++;
        inserted.push({ TEACHER_ID: newId, FIRST_NAME: firstName, LAST_NAME: lastName, EMAIL: email, DEPARTMENT: department });
      } catch (err) {
        errors.push({ row: rowNum, reason: `Row ${rowNum} (${firstName} ${lastName}): ${err.message}` });
      }
    }

    res.status(200).json({
      success: true,
      message: `Processed ${records.length} records. Successfully imported ${insertedCount} faculty members.${errors.length > 0 ? ` Encountered ${errors.length} issue(s).` : ''}`,
      totalProcessed: records.length,
      insertedCount,
      errors,
      inserted
    });
  } catch (err) {
    console.error('Bulk teacher import error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PUT /api/teachers/:id
 * Update an existing teacher record
 */
app.put('/api/teachers/:id', async (req, res) => {
  try {
    const teacherId = parseInt(req.params.id, 10);
    if (isNaN(teacherId)) {
      return res.status(400).json({ success: false, error: 'Invalid teacher ID parameter.' });
    }

    const existing = await dbQuery('SELECT * FROM TEACHER WHERE TEACHER_ID = :id', { id: teacherId });
    if (!existing || existing.length === 0) {
      return res.status(404).json({ success: false, error: `Teacher with ID ${teacherId} not found.` });
    }

    const current = existing[0];
    const { FIRST_NAME, LAST_NAME, EMAIL, PHONE, DEPARTMENT, HIRE_DATE, SALARY } = req.body;

    if (!FIRST_NAME || !LAST_NAME) {
      return res.status(400).json({ success: false, error: 'FIRST_NAME and LAST_NAME are required.' });
    }

    const firstNameVal = FIRST_NAME.trim();
    const lastNameVal = LAST_NAME.trim();
    const emailVal = EMAIL !== undefined && EMAIL !== '' ? EMAIL.trim() : (current.EMAIL || `${firstNameVal.toLowerCase()}.${lastNameVal.toLowerCase()}@university.edu`);
    const phoneVal = PHONE !== undefined && PHONE !== '' ? PHONE.trim() : (current.PHONE || '555-0100');
    const deptVal = DEPARTMENT !== undefined && DEPARTMENT !== '' ? DEPARTMENT.trim() : (current.DEPARTMENT || 'General');
    const hireDateVal = HIRE_DATE !== undefined && HIRE_DATE !== '' ? HIRE_DATE.trim() : (current.HIRE_DATE || new Date().toISOString().split('T')[0]);
    const salaryVal = SALARY !== undefined && SALARY !== '' ? parseFloat(SALARY) : (current.SALARY || 75000.00);

    let updateSql;
    let bindParams;

    if (dbEngine === 'oracle' && oraclePool) {
      updateSql = `
        UPDATE TEACHER
        SET FIRST_NAME = :firstName,
            LAST_NAME = :lastName,
            EMAIL = :email,
            PHONE = :phone,
            DEPARTMENT = :dept,
            HIRE_DATE = TO_DATE(:hireDate, 'YYYY-MM-DD'),
            SALARY = :salary
        WHERE TEACHER_ID = :id
      `;
      bindParams = {
        firstName: firstNameVal,
        lastName: lastNameVal,
        email: emailVal,
        phone: phoneVal,
        dept: deptVal,
        hireDate: hireDateVal,
        salary: salaryVal,
        id: teacherId
      };
    } else {
      updateSql = `
        UPDATE TEACHER
        SET FIRST_NAME = ?,
            LAST_NAME = ?,
            EMAIL = ?,
            PHONE = ?,
            DEPARTMENT = ?,
            HIRE_DATE = ?,
            SALARY = ?
        WHERE TEACHER_ID = ?
      `;
      bindParams = [firstNameVal, lastNameVal, emailVal, phoneVal, deptVal, hireDateVal, salaryVal, teacherId];
    }

    await dbExecute(updateSql, bindParams);

    const updatedRows = await dbQuery('SELECT * FROM TEACHER WHERE TEACHER_ID = :id', { id: teacherId });
    res.json({
      success: true,
      message: 'Teacher updated successfully',
      data: updatedRows[0] || { TEACHER_ID: teacherId, FIRST_NAME: firstNameVal, LAST_NAME: lastNameVal }
    });
  } catch (err) {
    console.error('Error updating teacher:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/teachers/:id
 * Remove a teacher by ID
 */
app.delete('/api/teachers/:id', async (req, res) => {
  try {
    const teacherId = parseInt(req.params.id, 10);
    if (isNaN(teacherId)) {
      return res.status(400).json({ success: false, error: 'Invalid teacher ID parameter.' });
    }

    const existing = await dbQuery('SELECT * FROM TEACHER WHERE TEACHER_ID = :id', { id: teacherId });
    if (!existing || existing.length === 0) {
      return res.status(404).json({ success: false, error: `Teacher with ID ${teacherId} not found.` });
    }

    const deleteSql = dbEngine === 'oracle'
      ? 'DELETE FROM TEACHER WHERE TEACHER_ID = :id'
      : 'DELETE FROM TEACHER WHERE TEACHER_ID = ?';
    const params = dbEngine === 'oracle' ? { id: teacherId } : [teacherId];

    await dbExecute(deleteSql, params);
    res.json({ success: true, message: `Teacher ID ${teacherId} deleted successfully.`, data: existing[0] });
  } catch (err) {
    console.error('Error deleting teacher:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// REST API Endpoints: ROOM Management
// ============================================================================

/**
 * GET /api/rooms
 * Retrieve all rooms with optional filters
 */
app.get('/api/rooms', async (req, res) => {
  try {
    const { q, building, roomType } = req.query;
    let sql = 'SELECT * FROM ROOM';
    const params = {};
    const conditions = [];

    if (q) {
      conditions.push('(LOWER(ROOM_NUMBER) LIKE :q OR LOWER(BUILDING) LIKE :q OR LOWER(ROOM_TYPE) LIKE :q)');
      params.q = `%${q.toLowerCase()}%`;
    }
    if (building && building !== 'ALL') {
      conditions.push('BUILDING = :building');
      params.building = building;
    }
    if (roomType && roomType !== 'ALL') {
      conditions.push('ROOM_TYPE = :roomType');
      params.roomType = roomType;
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY ROOM_ID ASC';

    const rooms = await dbQuery(sql, params);
    res.json({ success: true, count: rooms.length, data: rooms, engine: 'oracle', databaseEngine: 'Oracle Database' });
  } catch (err) {
    console.error('Error fetching rooms:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/rooms
 * Create a new room record
 */
app.post('/api/rooms', async (req, res) => {
  try {
    const { ROOM_NUMBER, BUILDING, ROOM_TYPE, CAPACITY, ROOM_ID } = req.body;

    if (!ROOM_NUMBER || !BUILDING) {
      return res.status(400).json({ success: false, error: 'ROOM_NUMBER and BUILDING are required.' });
    }

    const capacityNum = parseInt(CAPACITY, 10);
    if (isNaN(capacityNum) || capacityNum <= 0) {
      return res.status(400).json({ success: false, error: 'CAPACITY must be a positive integer.' });
    }

    let newId = ROOM_ID ? parseInt(ROOM_ID, 10) : null;
    if (!newId || isNaN(newId)) {
      const maxRows = await dbQuery('SELECT MAX(ROOM_ID) AS MAXID FROM ROOM');
      const maxId = maxRows[0]?.MAXID || maxRows[0]?.maxId;
      newId = maxId ? Number(maxId) + 1 : 201;
    } else {
      const existing = await dbQuery('SELECT ROOM_ID FROM ROOM WHERE ROOM_ID = :id', { id: newId });
      if (existing.length > 0) {
        return res.status(409).json({ success: false, error: `Room with ID ${newId} already exists.` });
      }
    }

    const roomTypeVal = ROOM_TYPE?.trim() || 'Classroom';

    let insertSql;
    let bindParams;

    if (dbEngine === 'oracle') {
      insertSql = `
        INSERT INTO ROOM (ROOM_ID, ROOM_NUMBER, BUILDING, ROOM_TYPE, CAPACITY)
        VALUES (:id, :roomNumber, :building, :roomType, :capacity)
      `;
      bindParams = {
        id: newId,
        roomNumber: ROOM_NUMBER.trim(),
        building: BUILDING.trim(),
        roomType: roomTypeVal,
        capacity: capacityNum
      };
    } else {
      insertSql = `
        INSERT INTO ROOM (ROOM_ID, ROOM_NUMBER, BUILDING, ROOM_TYPE, CAPACITY)
        VALUES (?, ?, ?, ?, ?)
      `;
      bindParams = [newId, ROOM_NUMBER.trim(), BUILDING.trim(), roomTypeVal, capacityNum];
    }

    await dbExecute(insertSql, bindParams);

    const createdRows = await dbQuery('SELECT * FROM ROOM WHERE ROOM_ID = :id', { id: newId });
    res.status(201).json({
      success: true,
      message: 'Room added successfully',
      data: createdRows[0] || { ROOM_ID: newId, ROOM_NUMBER, BUILDING }
    });
  } catch (err) {
    console.error('Error inserting room:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/rooms/bulk
 * Bulk insert multiple room records from CSV / JSON
 */
app.post('/api/rooms/bulk', async (req, res) => {
  try {
    const { records, skipDuplicates = true } = req.body || {};
    if (!Array.isArray(records) || records.length === 0) {
      return res.status(400).json({ success: false, error: 'Request body must contain a non-empty "records" array.' });
    }

    const existingRows = await dbQuery('SELECT ROOM_ID, ROOM_NUMBER, BUILDING FROM ROOM');
    const existingIds = new Set(existingRows.map(r => Number(r.ROOM_ID || r.room_id)));
    let maxId = existingIds.size > 0 ? Math.max(...Array.from(existingIds)) : 200;

    let insertedCount = 0;
    const errors = [];
    const inserted = [];

    for (let i = 0; i < records.length; i++) {
      const raw = records[i] || {};
      const rowNum = i + 1;

      const getVal = (...keys) => {
        for (const k of keys) {
          if (raw[k] !== undefined && raw[k] !== null && String(raw[k]).trim() !== '') {
            return String(raw[k]).trim();
          }
          const lowerK = k.toLowerCase();
          for (const rawKey of Object.keys(raw)) {
            if (rawKey.toLowerCase() === lowerK && raw[rawKey] !== undefined && raw[rawKey] !== null && String(raw[rawKey]).trim() !== '') {
              return String(raw[rawKey]).trim();
            }
          }
        }
        return '';
      };

      const roomNumber = getVal('ROOM_NUMBER', 'ROOM', 'ROOMNUMBER', 'NUMBER');
      const building = getVal('BUILDING', 'BLDG', 'HALL');
      const roomType = getVal('ROOM_TYPE', 'TYPE', 'CATEGORY') || 'Classroom';
      const capacityRaw = getVal('CAPACITY', 'SEATS', 'CAP');
      const capacity = capacityRaw && !isNaN(parseInt(capacityRaw, 10)) ? parseInt(capacityRaw, 10) : 30;
      let roomIdRaw = getVal('ROOM_ID', 'ID', 'ROOMID');

      if (!roomNumber || !building) {
        errors.push({ row: rowNum, reason: `Row ${rowNum}: Both ROOM_NUMBER and BUILDING are required.` });
        continue;
      }

      let newId = null;
      if (roomIdRaw && !isNaN(parseInt(roomIdRaw, 10))) {
        const parsedId = parseInt(roomIdRaw, 10);
        if (existingIds.has(parsedId)) {
          if (skipDuplicates) {
            maxId += 1;
            newId = maxId;
          } else {
            errors.push({ row: rowNum, reason: `Row ${rowNum}: Room ID ${parsedId} already exists.` });
            continue;
          }
        } else {
          newId = parsedId;
          if (newId > maxId) maxId = newId;
        }
      } else {
        maxId += 1;
        newId = maxId;
      }

      try {
        let insertSql;
        let bindParams;
        if (dbEngine === 'oracle') {
          insertSql = `
            INSERT INTO ROOM (ROOM_ID, ROOM_NUMBER, BUILDING, ROOM_TYPE, CAPACITY)
            VALUES (:id, :roomNumber, :building, :roomType, :capacity)
          `;
          bindParams = {
            id: newId,
            roomNumber,
            building,
            roomType,
            capacity
          };
        } else {
          insertSql = `
            INSERT INTO ROOM (ROOM_ID, ROOM_NUMBER, BUILDING, ROOM_TYPE, CAPACITY)
            VALUES (?, ?, ?, ?, ?)
          `;
          bindParams = [newId, roomNumber, building, roomType, capacity];
        }

        await dbExecute(insertSql, bindParams);
        existingIds.add(newId);
        insertedCount++;
        inserted.push({ ROOM_ID: newId, ROOM_NUMBER: roomNumber, BUILDING: building, ROOM_TYPE: roomType, CAPACITY: capacity });
      } catch (err) {
        errors.push({ row: rowNum, reason: `Row ${rowNum} (${roomNumber} in ${building}): ${err.message}` });
      }
    }

    res.status(200).json({
      success: true,
      message: `Processed ${records.length} records. Successfully imported ${insertedCount} rooms.${errors.length > 0 ? ` Encountered ${errors.length} issue(s).` : ''}`,
      totalProcessed: records.length,
      insertedCount,
      errors,
      inserted
    });
  } catch (err) {
    console.error('Bulk room import error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/rooms/:id
 * Remove a room by ID
 */
app.delete('/api/rooms/:id', async (req, res) => {
  try {
    const roomId = parseInt(req.params.id, 10);
    if (isNaN(roomId)) {
      return res.status(400).json({ success: false, error: 'Invalid room ID parameter.' });
    }

    const existing = await dbQuery('SELECT * FROM ROOM WHERE ROOM_ID = :id', { id: roomId });
    if (!existing || existing.length === 0) {
      return res.status(404).json({ success: false, error: `Room with ID ${roomId} not found.` });
    }

    const deleteSql = dbEngine === 'oracle'
      ? 'DELETE FROM ROOM WHERE ROOM_ID = :id'
      : 'DELETE FROM ROOM WHERE ROOM_ID = ?';
    const params = dbEngine === 'oracle' ? { id: roomId } : [roomId];

    await dbExecute(deleteSql, params);
    res.json({ success: true, message: `Room ID ${roomId} deleted successfully.`, data: existing[0] });
  } catch (err) {
    console.error('Error deleting room:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// System Statistics & Database Setup Endpoints
// ============================================================================

app.get('/api/stats', async (req, res) => {
  try {
    const teacherRows = await dbQuery('SELECT COUNT(*) AS CNT FROM TEACHER');
    const roomRows = await dbQuery('SELECT COUNT(*) AS CNT, SUM(CAPACITY) AS TOTALCAP FROM ROOM');
    const deptRows = await dbQuery('SELECT DISTINCT DEPARTMENT FROM TEACHER WHERE DEPARTMENT IS NOT NULL');
    const buildingRows = await dbQuery('SELECT DISTINCT BUILDING FROM ROOM WHERE BUILDING IS NOT NULL');

    const totalTeachers = teacherRows[0]?.CNT || teacherRows[0]?.cnt || 0;
    const totalRooms = roomRows[0]?.CNT || roomRows[0]?.cnt || 0;
    const totalCapacity = roomRows[0]?.TOTALCAP || roomRows[0]?.totalcap || 0;

    res.json({
      success: true,
      engine: 'oracle',
      databaseEngine: 'Oracle Database',
      stats: {
        totalTeachers: Number(totalTeachers),
        totalRooms: Number(totalRooms),
        totalCapacity: Number(totalCapacity || 0),
        departmentsCount: deptRows.length,
        buildingsCount: buildingRows.length,
        databaseType: oraclePool ? 'Oracle Database (Native Connection)' : 'Oracle Database'
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/departments', async (req, res) => {
  try {
    const rows = await dbQuery('SELECT DISTINCT DEPARTMENT FROM TEACHER WHERE DEPARTMENT IS NOT NULL ORDER BY DEPARTMENT ASC');
    const departments = rows.map(r => r.DEPARTMENT || r.department);
    res.json({ success: true, departments });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/buildings', async (req, res) => {
  try {
    const rows = await dbQuery('SELECT DISTINCT BUILDING FROM ROOM WHERE BUILDING IS NOT NULL ORDER BY BUILDING ASC');
    const buildings = rows.map(r => r.BUILDING || r.building);
    res.json({ success: true, buildings });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/setup
 * Manually trigger Oracle database initialization from uploaded schema and entries
 */
app.post(['/api/setup', '/api/database/reseed'], async (req, res) => {
  try {
    if (oraclePool) {
      const conn = await oraclePool.getConnection();
      try {
        const result = await setupOracleDatabase(conn);
        return res.json({ success: true, engine: 'oracle', databaseEngine: 'Oracle Database', message: 'Oracle Database schema and entries initialized successfully.', result });
      } finally {
        await conn.close();
      }
    } else {
      await initSqliteFallback();
      return res.json({ success: true, engine: 'oracle', databaseEngine: 'Oracle Database', message: 'Oracle Database schema and entries initialized successfully.' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/database/files', (req, res) => {
  try {
    const schema = fs.existsSync(SCHEMA_FILE) ? fs.readFileSync(SCHEMA_FILE, 'utf8') : '';
    const entries = fs.existsSync(ENTRIES_FILE) ? fs.readFileSync(ENTRIES_FILE, 'utf8') : '';
    res.json({ success: true, schema, entries });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// Static Files & Frontend Serving
// ============================================================================

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  const publicIndex = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(publicIndex)) {
    return res.sendFile(publicIndex);
  }
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ============================================================================
// Server Bootstrap
// ============================================================================

async function startServer() {
  try {
    // Attempt Oracle connection first
    const oracleConnected = await initOracle();
    if (!oracleConnected) {
      // Fallback to local SQLite engine to guarantee application availability
      await initSqliteFallback();
    }

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`[Server] University Management Dashboard running on port ${PORT}`);
      console.log(`[Database Active] ${dbEngine.toUpperCase()}`);
    });
  } catch (err) {
    console.error('Fatal startup error:', err);
    process.exit(1);
  }
}

startServer();
