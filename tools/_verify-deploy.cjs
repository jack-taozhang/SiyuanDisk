/** 校验三处 pages.py 的 md5 是否与本地 v4 一致 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { SUDO } = require("./_secrets.cjs");

const LOCAL = path.join(__dirname, "ref/pages.patched.py");
const HOST = "/vol1/1000/Docker/NebulaDisk/nebula/app/routers/pages.py";
const CONT = "/opt/nebula/app/routers/pages.py";

function ssh(cmd) {
  const r = spawnSync(process.execPath, [path.join(__dirname, "ssh-nb.cjs"), cmd],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { out: (r.stdout || "").trim(), code: r.status, err: (r.stderr || "").trim() };
}

const out = [];
const P = (s) => out.push(s);

const lb = fs.readFileSync(LOCAL);
const lm = crypto.createHash("md5").update(lb).digest("hex");
P("本地 ref/pages.patched.py : " + lm + "  (" + lb.length + "B)");

const src = ssh(`${SUDO}md5sum '${HOST}'`);
P("宿主源码位               : " + (src.out || src.err));

const cm = ssh(`${SUDO}docker exec nebula md5sum '${CONT}'`);
P("容器 /opt/nebula          : " + (cm.out || cm.err));

const sel = ssh(`${SUDO}docker exec nebula grep -oE 'nb-cad-hide-v[0-9]+|__nbSeedCad|_LITE_CAD_STORAGE_KEY|__NB_SEED_CAD_JS' '${CONT}' | sort | uniq -c`);
P("");
P("容器内 marker 命中:");
P(sel.out || sel.err);

const pyc = ssh(`${SUDO}docker exec nebula ls -la /opt/nebula/app/routers/__pycache__`);
P("");
P("容器内 __pycache__:");
P(pyc.out || pyc.err);

fs.writeFileSync(path.join(__dirname, "_deploy.txt"), out.join("\n"), "utf8");
