// Outils de test : démarre le Worker en local (wrangler dev) sur une base D1 vide et temporaire.
import {spawn, execFileSync} from "node:child_process";
import {createServer} from "node:net";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, dirname} from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const ADMIN_EMAIL = "admin@test.local";

// Port libre attribué par le système : les fichiers de test tournent en parallèle, chacun avec son Worker (un port
// tiré au hasard entrait parfois en collision avec celui d'un autre fichier).
const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const {port} = srv.address();
      srv.close(() => resolve(port));
    });
  });

// Le Worker est prêt quand /api/me répond vraiment (JSON valide, migrations appliquées : la première requête les
// lance). Une simple connexion ne suffit pas : wrangler accepte parfois les requêtes avant que le Worker réponde.
async function workerReady(base) {
  try {
    const res = await fetch(base + "/api/me", {signal: AbortSignal.timeout(10000)});
    if (!res.ok) return false;
    const data = await res.json();
    return data && "user" in data;
  } catch {
    return false;
  }
}

// vars : variables supplémentaires du Worker (ex. clé et adresse d’un faux service OpenAI).
// Démarrage fiabilisé : si le Worker ne répond pas à temps (ou si wrangler s'arrête, par exemple sur un port pris
// entre-temps par un autre fichier de test), il est arrêté et relancé sur de nouveaux ports, 3 essais au plus.
export async function startWorker(port, vars = {}) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await startWorkerOnce(attempt === 1 ? port : undefined, vars);
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error("Le Worker de test n'a pas démarré après 3 essais : " + lastError?.message);
}

async function startWorkerOnce(port, vars) {
  port ??= await freePort();
  const inspectorPort = await freePort();
  const dir = mkdtempSync(join(tmpdir(), "fitfactory-test-"));
  const wrangler = ["-y", "wrangler@4"];
  try {
    execFileSync("npx", [...wrangler, "d1", "migrations", "apply", "myfitfactory", "--local", "--persist-to", dir], {
      cwd: ROOT,
      stdio: "ignore",
      env: {...process.env, CI: "1"},
    });
  } catch (err) {
    rmSync(dir, {recursive: true, force: true});
    throw err;
  }
  const child = spawn(
    "npx",
    [
      ...wrangler,
      "dev",
      "--local",
      "--persist-to",
      dir,
      "--port",
      String(port),
      "--ip",
      "127.0.0.1",
      "--inspector-port",
      String(inspectorPort),
      "--var",
      `ADMIN_EMAIL:${ADMIN_EMAIL}`,
      ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`]),
    ],
    // Groupe de processus à part : stop() arrête npx, wrangler et workerd ensemble (sinon ils restent en mémoire).
    {cwd: ROOT, stdio: "ignore", env: {...process.env, CI: "1"}, detached: true}
  );
  let exited = false;
  child.on("exit", () => (exited = true));
  const base = `http://127.0.0.1:${port}`,
    stop = () => {
      try {
        process.kill(-child.pid);
      } catch {
        child.kill();
      }
      rmSync(dir, {recursive: true, force: true});
    };
  const deadline = Date.now() + 120000;
  while (!(await workerReady(base))) {
    if (exited || Date.now() > deadline) {
      stop();
      throw new Error(exited ? "wrangler s'est arrêté au démarrage" : "pas de réponse en 2 minutes");
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  return {base, stop, persistPath: dir};
}

// Client HTTP minimal avec cookie de session et IP simulée (en-tête CF-Connecting-IP).
export function client(base, ip = "203.0.113." + Math.floor(Math.random() * 250 + 1)) {
  let cookie = "";
  const call = async (method, path, body, extraHeaders = {}) => {
    const res = await fetch(base + "/api" + path, {
      method,
      headers: {
        "content-type": "application/json",
        "CF-Connecting-IP": ip,
        ...(cookie ? {cookie} : {}),
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie?.() || []) {
      const [pair] = c.split(";");
      const [name, value] = pair.split("=");
      if (name === "fitfactory_session") cookie = value ? `${name}=${value}` : "";
    }
    let data = null;
    try {
      data = await res.json();
    } catch {}
    return {status: res.status, data, headers: res.headers};
  };
  return {
    get: p => call("GET", p),
    post: (p, b) => call("POST", p, b ?? {}),
    put: (p, b) => call("PUT", p, b ?? {}),
    del: (p, b) => call("DELETE", p, b),
    call,
    setCookie: c => {
      cookie = c;
    },
    get cookie() {
      return cookie;
    },
  };
}

export const today = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
export const mondayOf = d => {
  const x = new Date(d + "T12:00:00Z");
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return x.toISOString().slice(0, 10);
};
export const addDays = (d, n) => {
  const x = new Date(d + "T12:00:00Z");
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
