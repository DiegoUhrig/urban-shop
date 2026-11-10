import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;
const ROOT = dirname(fileURLToPath(import.meta.url));
const LOCAL_ENV_KEYS = new Set(["DATABASE_URL", "PGSSLROOTCERT", "ADMIN_USERNAME", "ADMIN_PASSWORD", "SESSION_SECRET", "NODE_ENV", "PORT"]);
const MAX_BODY_BYTES = 16 * 1024;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 5;

function loadLocalEnv() {
  let contents;
  try {
    contents = readFileSync(join(ROOT, ".env"), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }

  for (const line of contents.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || !LOCAL_ENV_KEYS.has(match[1]) || Object.hasOwn(process.env, match[1])) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}

loadLocalEnv();

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const DATABASE_URL = process.env.DATABASE_URL || "";
const PORT = Number(process.env.PORT || 4173);
const IS_PRODUCTION = process.env.NODE_ENV === "production";

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

if (!DATABASE_URL) throw new Error("Falta configurar DATABASE_URL.");
if (!ADMIN_USERNAME || ADMIN_USERNAME.length > 80) throw new Error("ADMIN_USERNAME debe tener entre 1 y 80 caracteres.");
if (ADMIN_PASSWORD.length < 12) throw new Error("ADMIN_PASSWORD debe tener al menos 12 caracteres.");
if (SESSION_SECRET.length < 32) throw new Error("SESSION_SECRET debe tener al menos 32 caracteres aleatorios.");
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error("PORT no es válido.");

const databaseSsl = { rejectUnauthorized: true };
if (process.env.PGSSLROOTCERT) {
  databaseSsl.ca = readFileSync(process.env.PGSSLROOTCERT, "utf8");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 5,
  ssl: databaseSsl
});
const sessions = new Map();
const loginAttempts = new Map();
const usernameDigest = createHash("sha256").update(ADMIN_USERNAME).digest();
const passwordDigest = scryptSync(ADMIN_PASSWORD, SESSION_SECRET, 32);

function secureEqual(actual, expected) {
  const actualDigest = createHash("sha256").update(actual).digest();
  return timingSafeEqual(actualDigest, expected);
}

function sendJson(response, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders
  });
  response.end(body);
}

async function readJsonBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] || "")) {
    throw new HttpError(415, "La solicitud debe usar el formato JSON.");
  }
  const contentLength = Number(request.headers["content-length"] || 0);
  if (contentLength > MAX_BODY_BYTES) throw new HttpError(413, "La solicitud supera el tamaño permitido.");

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "La solicitud supera el tamaño permitido.");
    chunks.push(chunk);
  }

  let data;
  try {
    data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "El cuerpo de la solicitud no contiene JSON válido.");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new HttpError(400, "El cuerpo de la solicitud debe ser un objeto JSON.");
  }
  return data;
}

function requireSameOrigin(request) {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (!origin || !host) throw new HttpError(403, "Origen de solicitud no permitido.");
  let parsedOrigin;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    throw new HttpError(403, "Origen de solicitud no permitido.");
  }
  if (!["http:", "https:"].includes(parsedOrigin.protocol) || parsedOrigin.host.toLowerCase() !== host.toLowerCase()) {
    throw new HttpError(403, "Origen de solicitud no permitido.");
  }
}

function getCookies(request) {
  return Object.fromEntries((request.headers.cookie || "").split(";").map(part => {
    const separator = part.indexOf("=");
    if (separator < 0) return ["", ""];
    return [part.slice(0, separator).trim(), part.slice(separator + 1).trim()];
  }).filter(([name]) => name));
}

function requireAdmin(request) {
  const token = getCookies(request).urban_admin;
  const expiresAt = token && sessions.get(token);
  if (!expiresAt || expiresAt <= Date.now()) {
    if (token) sessions.delete(token);
    throw new HttpError(401, "Tu sesión venció. Volvé a ingresar.");
  }
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

function sessionCookie(token, maxAge) {
  const secure = IS_PRODUCTION ? "; Secure" : "";
  return `urban_admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;
}

function clientAddress(request) {
  return request.socket.remoteAddress || "unknown";
}

function checkLoginLimit(request) {
  const key = clientAddress(request);
  const now = Date.now();
  const record = loginAttempts.get(key);
  if (!record || record.resetAt <= now) {
    loginAttempts.set(key, { count: 0, resetAt: now + LOGIN_WINDOW_MS });
    return key;
  }
  if (record.count >= MAX_LOGIN_ATTEMPTS) {
    const retrySeconds = Math.ceil((record.resetAt - now) / 1000);
    throw new HttpError(429, `Demasiados intentos. Probá de nuevo en ${retrySeconds} segundos.`);
  }
  return key;
}

function text(value, field, maxLength, required = false) {
  if (typeof value !== "string") {
    if (!required && (value === undefined || value === null)) return "";
    throw new HttpError(400, `${field} debe ser texto.`);
  }
  const normalized = value.trim();
  if (required && !normalized) throw new HttpError(400, `${field} es obligatorio.`);
  if (normalized.length > maxLength) throw new HttpError(400, `${field} no puede superar ${maxLength} caracteres.`);
  return normalized;
}

function parseProduct(data) {
  const name = text(data.name, "El nombre", 100, true);
  const brand = text(data.brand, "La marca", 80, true);
  const size = text(data.size, "El tamaño", 80, true);
  const description = text(data.description, "La descripción", 500);
  const price = data.price;
  const stock = data.stock;
  if (typeof price !== "number" || !Number.isFinite(price) || price < 0 || price > 1_000_000_000) {
    throw new HttpError(400, "El precio debe ser un número entre 0 y 1.000.000.000.");
  }
  if (!Number.isInteger(stock) || stock < 0 || stock > 1_000_000) {
    throw new HttpError(400, "El stock debe ser un número entero entre 0 y 1.000.000.");
  }
  if (typeof data.active !== "boolean") throw new HttpError(400, "Indicá si el perfume debe mostrarse en la tienda.");

  const imageUrl = text(data.imageUrl, "La URL de la foto", 1000);
  if (imageUrl) {
    let url;
    try {
      url = new URL(imageUrl);
    } catch {
      throw new HttpError(400, "La URL de la foto no es válida.");
    }
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new HttpError(400, "La foto debe usar una URL HTTPS válida.");
    }
  }
  return { name, brand, size, description, price: Math.round(price * 100) / 100, stock, active: data.active, imageUrl };
}

function parseStoreSettings(data) {
  const rawPhone = text(data.whatsapp, "WhatsApp", 40);
  const whatsapp = rawPhone.replace(/\D/g, "");
  if (whatsapp && !/^\d{8,15}$/.test(whatsapp)) {
    throw new HttpError(400, "WhatsApp debe incluir el código de país y tener entre 8 y 15 dígitos.");
  }
  return {
    whatsapp,
    transferAlias: text(data.transferAlias, "El alias", 60),
    transferHolder: text(data.transferHolder, "El titular", 100)
  };
}

function publicProduct(row) {
  return {
    id: String(row.id),
    name: row.name,
    brand: row.brand,
    size: row.size,
    description: row.description,
    price: Number(row.price),
    stock: row.stock,
    active: row.active,
    imageUrl: row.image_url || ""
  };
}

function publicSettings(row) {
  return {
    whatsapp: row.whatsapp,
    transferAlias: row.transfer_alias,
    transferHolder: row.transfer_holder
  };
}

async function serveFile(response, filename) {
  const content = await readFile(join(ROOT, filename));
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Length": content.length,
    "Content-Security-Policy": "default-src 'self'; img-src 'self' https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
    "Content-Type": "text/html; charset=utf-8",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY"
  });
  response.end(content);
}

async function handleRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const path = url.pathname;
  const method = request.method || "GET";

  if (method === "GET" && path === "/healthz") return sendJson(response, 200, { status: "ok" });
  if (method === "GET" && path === "/") return serveFile(response, "index.html");
  if (method === "GET" && ["/admin", "/admin/"].includes(path)) return serveFile(response, "admin.html");

  if (method === "GET" && path === "/api/products") {
    const result = await pool.query("SELECT * FROM products WHERE active = TRUE ORDER BY name ASC");
    return sendJson(response, 200, { products: result.rows.map(publicProduct) });
  }
  if (method === "GET" && path === "/api/store") {
    const result = await pool.query("SELECT whatsapp, transfer_alias, transfer_holder FROM store_settings WHERE id = 1");
    return sendJson(response, 200, publicSettings(result.rows[0]));
  }

  if (method === "GET" && path === "/api/admin/session") {
    try {
      requireAdmin(request);
      return sendJson(response, 200, { authenticated: true });
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) return sendJson(response, 200, { authenticated: false });
      throw error;
    }
  }

  if (method === "POST" && path === "/api/admin/login") {
    requireSameOrigin(request);
    const address = checkLoginLimit(request);
    const data = await readJsonBody(request);
    const usernameMatches = secureEqual(String(data.username || ""), usernameDigest);
    const candidateDigest = scryptSync(String(data.password || ""), SESSION_SECRET, 32);
    const passwordMatches = timingSafeEqual(candidateDigest, passwordDigest);
    if (!usernameMatches || !passwordMatches) {
      const attempts = loginAttempts.get(address);
      attempts.count += 1;
      throw new HttpError(401, "Usuario o contraseña incorrectos.");
    }
    loginAttempts.delete(address);
    const token = randomBytes(32).toString("hex");
    sessions.set(token, Date.now() + SESSION_TTL_MS);
    return sendJson(response, 200, { authenticated: true }, { "Set-Cookie": sessionCookie(token, SESSION_TTL_MS / 1000) });
  }

  if (path.startsWith("/api/admin/")) {
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) requireSameOrigin(request);
    const token = requireAdmin(request);
    if (method === "POST" && path === "/api/admin/logout") {
      sessions.delete(token);
      return sendJson(response, 200, { success: true }, { "Set-Cookie": sessionCookie("", 0) });
    }
    if (method === "GET" && path === "/api/admin/products") {
      const result = await pool.query("SELECT * FROM products ORDER BY name ASC");
      return sendJson(response, 200, { products: result.rows.map(publicProduct) });
    }
    if (method === "POST" && path === "/api/admin/products") {
      const product = parseProduct(await readJsonBody(request));
      const result = await pool.query(
        `INSERT INTO products (name, brand, size, description, price, stock, active, image_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [product.name, product.brand, product.size, product.description, product.price, product.stock, product.active, product.imageUrl || null]
      );
      return sendJson(response, 201, { product: publicProduct(result.rows[0]) });
    }
    const productMatch = /^\/api\/admin\/products\/(\d+)$/.exec(path);
    if (productMatch && method === "PUT") {
      const product = parseProduct(await readJsonBody(request));
      const result = await pool.query(
        `UPDATE products SET name = $1, brand = $2, size = $3, description = $4, price = $5,
         stock = $6, active = $7, image_url = $8, updated_at = NOW()
         WHERE id = $9 RETURNING *`,
        [product.name, product.brand, product.size, product.description, product.price, product.stock, product.active, product.imageUrl || null, productMatch[1]]
      );
      if (!result.rowCount) throw new HttpError(404, "No encontramos ese perfume.");
      return sendJson(response, 200, { product: publicProduct(result.rows[0]) });
    }
    if (productMatch && method === "DELETE") {
      const result = await pool.query("DELETE FROM products WHERE id = $1", [productMatch[1]]);
      if (!result.rowCount) throw new HttpError(404, "No encontramos ese perfume.");
      return sendJson(response, 200, { success: true });
    }
    if (method === "GET" && path === "/api/admin/store") {
      const result = await pool.query("SELECT whatsapp, transfer_alias, transfer_holder FROM store_settings WHERE id = 1");
      return sendJson(response, 200, publicSettings(result.rows[0]));
    }
    if (method === "PUT" && path === "/api/admin/store") {
      const settings = parseStoreSettings(await readJsonBody(request));
      const result = await pool.query(
        `UPDATE store_settings SET whatsapp = $1, transfer_alias = $2, transfer_holder = $3, updated_at = NOW()
         WHERE id = 1 RETURNING whatsapp, transfer_alias, transfer_holder`,
        [settings.whatsapp, settings.transferAlias, settings.transferHolder]
      );
      return sendJson(response, 200, publicSettings(result.rows[0]));
    }
  }

  throw new HttpError(404, "No encontramos esa página.");
}

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      brand VARCHAR(80) NOT NULL,
      size VARCHAR(80) NOT NULL,
      description VARCHAR(500) NOT NULL DEFAULT '',
      price NUMERIC(12, 2) NOT NULL CHECK (price >= 0),
      stock INTEGER NOT NULL CHECK (stock >= 0),
      active BOOLEAN NOT NULL DEFAULT TRUE,
      image_url VARCHAR(1000),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS store_settings (
      id SMALLINT PRIMARY KEY CHECK (id = 1),
      whatsapp VARCHAR(15) NOT NULL DEFAULT '',
      transfer_alias VARCHAR(60) NOT NULL DEFAULT '',
      transfer_holder VARCHAR(100) NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    INSERT INTO store_settings (id) VALUES (1)
    ON CONFLICT (id) DO NOTHING
  `);
}

const server = createServer((request, response) => {
  handleRequest(request, response).catch(error => {
    if (error instanceof HttpError) {
      if (error.status >= 500) console.error(error);
      if (!response.headersSent) sendJson(response, error.status, { error: error.message });
      else response.destroy();
      return;
    }
    console.error("Error procesando solicitud:", error);
    if (!response.headersSent) sendJson(response, 500, { error: "Ocurrió un error interno. Intentá nuevamente." });
    else response.destroy();
  });
});

server.headersTimeout = 10_000;
server.requestTimeout = 20_000;
pool.on("error", error => console.error("Error inesperado en la conexión PostgreSQL:", error));

setInterval(() => {
  const now = Date.now();
  for (const [token, expiresAt] of sessions) {
    if (expiresAt <= now) sessions.delete(token);
  }
  for (const [address, attempt] of loginAttempts) {
    if (attempt.resetAt <= now) loginAttempts.delete(address);
  }
}, 5 * 60 * 1000).unref();

await initializeDatabase();
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Urban SHOP disponible en el puerto ${PORT}.`);
});

async function shutdown() {
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
