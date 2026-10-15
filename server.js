const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, execFile } = require("node:child_process");
const { pipeline } = require("node:stream/promises");
const { Transform } = require("node:stream");

const RFD_DIR = "C:\\Users\\baldi\\Music\\RFD";
const RFD_EXE = path.join(RFD_DIR, "RFD-windows.exe");
const CONFIG_PATH = path.join(RFD_DIR, "GameConfig.toml");
const ACTIVE_CONFIG_PATH = path.join(__dirname, "ActiveGameConfig.toml");
const MAPS_DIR = path.join(__dirname, "Maps");
const GAMES_PAGE_PATH = path.join(__dirname, "games.html");
const DEVELOP_PAGE_PATH = path.join(__dirname, "develop.html");
const THUMBS_DIR = path.join(__dirname, "Thumbnails");
const META_PATH = path.join(__dirname, "library.json");
const WEB_PORT = 2008;
const RFD_WEB_PORT = 2006;
const RCC_PORT = 2007;
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES = 5 * 1024 * 1024;
const MAX_TITLE_LENGTH = 80;

fs.mkdirSync(MAPS_DIR, { recursive: true });
fs.mkdirSync(THUMBS_DIR, { recursive: true });

let rfdProcess = null;
let launching = false;
let activeMapName = null;

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(data));
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// library.json stores per-game display names and thumbnails, keyed by .rbxl filename.
function loadMeta() {
  try {
    const data = JSON.parse(fs.readFileSync(META_PATH, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function saveMeta(meta) {
  const temp = META_PATH + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(meta, null, 2), "utf8");
  fs.renameSync(temp, META_PATH);
}

function getEntry(meta, name) {
  return Object.hasOwn(meta, name) && meta[name] && typeof meta[name] === "object"
    ? { ...meta[name] }
    : {};
}

function setEntry(meta, name, entry) {
  if (Object.keys(entry).length) {
    meta[name] = entry;
  } else {
    delete meta[name];
  }
}

function getMaps() {
  const meta = loadMeta();

  return fs.readdirSync(MAPS_DIR, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith(".rbxl"))
    .map(entry => {
      const stats = fs.statSync(path.join(MAPS_DIR, entry.name));
      const saved = getEntry(meta, entry.name);
      const hasThumb = typeof saved.thumbnail === "string" &&
        /^[a-f0-9]{16}\.(png|jpg|gif|webp)$/.test(saved.thumbnail) &&
        fs.existsSync(path.join(THUMBS_DIR, saved.thumbnail));

      return {
        name: entry.name,
        title: typeof saved.title === "string" && saved.title.trim()
          ? saved.title
          : path.basename(entry.name, path.extname(entry.name)),
        thumbnail: hasThumb ? "/thumbs/" + saved.thumbnail : null,
        size: stats.size,
        modified: Math.round(stats.mtimeMs)
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title, undefined, {
      numeric: true,
      sensitivity: "base"
    }));
}

function findMapOrThrow(name) {
  const map = getMaps().find(item => item.name === name);
  if (!map) throw new HttpError(404, "That game was not found in the library.");
  return map;
}

async function readBody(req, limit, tooLargeMessage) {
  const declared = Number(req.headers["content-length"]);

  if (Number.isFinite(declared) && declared > limit) {
    throw new HttpError(413, tooLargeMessage);
  }

  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new HttpError(413, tooLargeMessage);
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

async function readJson(req) {
  const buffer = await readBody(req, 10000, "Request is too large.");

  try {
    const value = JSON.parse(buffer.toString("utf8") || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new HttpError(400, "Invalid request.");
  }
}

function detectImageExtension(buffer) {
  if (buffer.length >= 8 &&
      buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return ".png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return ".jpg";
  }
  if (buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.toString("latin1", 0, 6))) {
    return ".gif";
  }
  if (buffer.length >= 12 && buffer.toString("latin1", 0, 4) === "RIFF" &&
      buffer.toString("latin1", 8, 12) === "WEBP") {
    return ".webp";
  }
  return null;
}

const IMAGE_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp"
};

function removeThumbnailFile(filename) {
  if (typeof filename !== "string" || !/^[a-f0-9]{16}\.(png|jpg|gif|webp)$/.test(filename)) return;

  try {
    fs.unlinkSync(path.join(THUMBS_DIR, filename));
  } catch {}
}

function servePage(res, filePath, label) {
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(label + " was not found. Place it in the RFD-MapBrowser folder.");
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-cache"
  });

  fs.createReadStream(filePath).pipe(res);
}

function safeFilename(name) {
  return String(name || "")
    .split(/[\\/]/)
    .pop()
    .replace(/[<>:"|?*\x00-\x1F]/g, "_")
    .trim();
}

function uniqueMapPath(filename) {
  const extension = path.extname(filename);
  const base = path.basename(filename, extension);
  let candidate = path.join(MAPS_DIR, filename);
  let counter = 2;

  while (fs.existsSync(candidate)) {
    candidate = path.join(MAPS_DIR, base + " (" + counter + ")" + extension);
    counter++;
  }

  return candidate;
}

function createActiveConfig(mapPath) {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error("GameConfig.toml was not found: " + CONFIG_PATH);
  }

  const original = fs.readFileSync(CONFIG_PATH, "utf8");
  const lines = original.split(/\r?\n/);

  let inPlaceSection = false;
  let replaced = false;

  const updated = lines.map(line => {
    if (/^\s*\[.*\]\s*$/.test(line)) {
      inPlaceSection = line.trim() === "[server_core.place_file]";
    }

    if (inPlaceSection && /^\s*rbxl_uri\s*=/.test(line)) {
      replaced = true;
      return "rbxl_uri = " + JSON.stringify(mapPath);
    }

    return line;
  }).join("\r\n");

  if (!replaced) {
    throw new Error(
      "Could not find rbxl_uri inside [server_core.place_file] in GameConfig.toml."
    );
  }

  fs.writeFileSync(ACTIVE_CONFIG_PATH, updated, "utf8");
  return ACTIVE_CONFIG_PATH;
}

function stopManagedRfd() {
  return new Promise(resolve => {
    if (!rfdProcess || !rfdProcess.pid) {
      rfdProcess = null;
      resolve();
      return;
    }

    const oldProcess = rfdProcess;
    rfdProcess = null;

    execFile("taskkill", [
      "/PID", String(oldProcess.pid), "/T", "/F"
    ], error => {
      if (error && error.code !== 128) {
        console.error("Could not stop the previous RFD process:", error.message);
      }
      resolve();
    });
  });
}

async function handleRequest(req, res) {
  const url = new URL(req.url, "http://127.0.0.1:" + WEB_PORT);

  // Block other websites from sending changes to this local server.
  if (req.method !== "GET" && req.method !== "HEAD") {
    const origin = req.headers.origin;
    let sameOrigin = true;

    if (origin) {
      try {
        sameOrigin = new URL(origin).host === req.headers.host;
      } catch {
        sameOrigin = false;
      }
    }

    if (!sameOrigin) {
      req.resume();
      sendJson(res, 403, { error: "Cross-site requests are not allowed." });
      return;
    }
  }

if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/games")) {
    servePage(res, GAMES_PAGE_PATH, "games.html");
    return;
  }

  if (req.method === "GET" && url.pathname === "/develop") {
    servePage(res, DEVELOP_PAGE_PATH, "develop.html");
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/thumbs/")) {
    const file = url.pathname.slice("/thumbs/".length);
    const type = IMAGE_TYPES[path.extname(file)];

    if (!/^[a-f0-9]{16}\.(png|jpg|gif|webp)$/.test(file) || !type ||
        !fs.existsSync(path.join(THUMBS_DIR, file))) {
      sendJson(res, 404, { error: "Not found." });
      return;
    }

    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff"
    });

    fs.createReadStream(path.join(THUMBS_DIR, file)).pipe(res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/maps") {
    sendJson(res, 200, getMaps());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/upload") {
    const filename = safeFilename(url.searchParams.get("name") || "");

    if (!filename || !filename.toLowerCase().endsWith(".rbxl")) {
      req.resume();
      sendJson(res, 400, { error: "Please upload a valid .rbxl filename." });
      return;
    }

    let received = 0;
    const destination = uniqueMapPath(filename);

    const limiter = new Transform({
      transform(chunk, encoding, callback) {
        received += chunk.length;

        if (received > MAX_UPLOAD_BYTES) {
          callback(new Error("File exceeds the 500 MB upload limit."));
        } else {
          callback(null, chunk);
        }
      }
    });

    try {
      await pipeline(
        req,
        limiter,
        fs.createWriteStream(destination, { flags: "wx" })
      );

      sendJson(res, 200, {
        message: "Uploaded " + path.basename(destination) + " successfully."
      });
    } catch (error) {
      try {
        fs.unlinkSync(destination);
      } catch {}

      if (!res.headersSent) {
        sendJson(res, 400, {
          error: error.message.includes("500 MB")
            ? error.message
            : "Upload failed. Check the file and available disk space."
        });
      }
    }

    return;
  }

  if (req.method === "POST" && url.pathname === "/api/maps/rename") {
    const body = await readJson(req);
    const map = findMapOrThrow(body.name);

    const title = String(body.title ?? "")
      .replace(/[\x00-\x1F\x7F]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (title.length > MAX_TITLE_LENGTH) {
      throw new HttpError(400, "Name must be " + MAX_TITLE_LENGTH + " characters or fewer.");
    }

    const meta = loadMeta();
    const entry = getEntry(meta, map.name);

    if (title) {
      entry.title = title;
    } else {
      delete entry.title;
    }

    setEntry(meta, map.name, entry);
    saveMeta(meta);

    sendJson(res, 200, {
      message: "Name updated.",
      map: findMapOrThrow(map.name)
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/maps/thumbnail") {
    const map = findMapOrThrow(url.searchParams.get("name"));
    const buffer = await readBody(req, MAX_THUMBNAIL_BYTES, "Thumbnail must be 5 MB or smaller.");
    const extension = detectImageExtension(buffer);

    if (!extension) {
      throw new HttpError(400, "Thumbnail must be a PNG, JPG, GIF or WebP image.");
    }

    const filename = crypto.randomBytes(8).toString("hex") + extension;
    fs.writeFileSync(path.join(THUMBS_DIR, filename), buffer);

    const meta = loadMeta();
    const entry = getEntry(meta, map.name);
    const previous = entry.thumbnail;

    entry.thumbnail = filename;
    setEntry(meta, map.name, entry);
    saveMeta(meta);
    removeThumbnailFile(previous);

    sendJson(res, 200, {
      message: "Thumbnail updated.",
      map: findMapOrThrow(map.name)
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/maps/thumbnail/remove") {
    const body = await readJson(req);
    const map = findMapOrThrow(body.name);

    const meta = loadMeta();
    const entry = getEntry(meta, map.name);
    const previous = entry.thumbnail;

    delete entry.thumbnail;
    setEntry(meta, map.name, entry);
    saveMeta(meta);
    removeThumbnailFile(previous);

    sendJson(res, 200, {
      message: "Thumbnail removed.",
      map: findMapOrThrow(map.name)
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/maps/delete") {
    const body = await readJson(req);
    const map = findMapOrThrow(body.name);

    if (launching || (rfdProcess && activeMapName === map.name)) {
      throw new HttpError(409, "This game is currently running. Close RFD before deleting it.");
    }

    try {
      fs.unlinkSync(path.join(MAPS_DIR, map.name));
    } catch (error) {
      if (error.code === "EBUSY" || error.code === "EPERM") {
        throw new HttpError(409, "The file is in use. Close RFD and try again.");
      }
      throw error;
    }

    const meta = loadMeta();
    const entry = getEntry(meta, map.name);

    removeThumbnailFile(entry.thumbnail);
    delete meta[map.name];
    saveMeta(meta);

    sendJson(res, 200, { message: "Deleted " + map.title + "." });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/play") {
    if (launching) {
      sendJson(res, 409, {
        error: "RFD is already switching maps. Please wait."
      });
      return;
    }

    let body = "";

    for await (const chunk of req) {
      body += chunk;

      if (body.length > 10000) {
        sendJson(res, 400, { error: "Invalid request." });
        return;
      }
    }

    let requested;

    try {
      requested = JSON.parse(body).name;
    } catch {
      sendJson(res, 400, { error: "Invalid map selection." });
      return;
    }

    const map = getMaps().find(item => item.name === requested);

    if (!map) {
      sendJson(res, 404, {
        error: "That map was not found in the library."
      });
      return;
    }

    const mapPath = path.resolve(MAPS_DIR, map.name);

    if (!fs.existsSync(mapPath)) {
      sendJson(res, 404, { error: "The selected map file no longer exists." });
      return;
    }

    launching = true;

    try {
      const activeConfig = createActiveConfig(mapPath);

      await stopManagedRfd();

      const child = spawn(RFD_EXE, [
        "server",
        "--config_path", activeConfig,
        "--rcc_port", String(RCC_PORT),
        "--web_port", String(RFD_WEB_PORT),
        "--run_client"
      ], {
        cwd: RFD_DIR,
        stdio: "inherit",
        windowsHide: false
      });

      rfdProcess = child;
      activeMapName = map.name;

      child.once("error", error => {
        console.error("Could not launch RFD:", error);

        if (rfdProcess === child) {
          rfdProcess = null;
        }
      });

      child.once("exit", code => {
        console.log("RFD process exited with code:", code);

        if (rfdProcess === child) {
          rfdProcess = null;
        }
      });

      sendJson(res, 200, {
        message: "Launching " + map.name +
          " with your configured Roblox version and startup script."
      });
    } catch (error) {
      console.error("Map launch failed:", error);
      sendJson(res, 500, {
        error: "Could not start RFD: " + error.message
      });
    } finally {
      launching = false;
    }

    return;
  }

  sendJson(res, 404, { error: "Not found." });
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(error => {
    if (error instanceof HttpError) {
      if (!res.headersSent) {
        res.setHeader("Connection", "close");
        sendJson(res, error.status, { error: error.message });
      }
      return;
    }

    console.error(error);

    if (!res.headersSent) {
      sendJson(res, 500, { error: "Internal server error." });
    }
  });
});

server.listen(WEB_PORT, "127.0.0.1", () => {
  console.log("RFD Map Browser: http://127.0.0.1:" + WEB_PORT);
  console.log("2016 Games page: http://127.0.0.1:" + WEB_PORT + "/games");
  console.log("Develop page: http://127.0.0.1:" + WEB_PORT + "/develop");
  console.log("Map storage: " + MAPS_DIR);
  console.log("RFD executable: " + RFD_EXE);
  console.log("Original config: " + CONFIG_PATH);
});