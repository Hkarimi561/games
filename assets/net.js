/*
 * Game-night rooms: online play for these games without any sign-in.
 *
 * The games were first written for Claude artifacts, which provide
 * `window.claude.use("db" | "user" | "room")`. This file provides the same
 * small API, backed by a peer-to-peer room (PeerJS / WebRTC):
 *
 *   - One player creates a room and becomes its host. The host's browser keeps
 *     the shared game documents and relays live messages.
 *   - Friends join with the room code, or by opening the invite link
 *     (?room=CODE). Their reads and writes go to the host.
 *   - Paths under data/users/<id>/ (hidden dice, ship positions) never leave
 *     the player's own device.
 *
 * Testing hook: ?signal=host:port points PeerJS at a self-hosted signaling server.
 */
(function () {
  "use strict";

  var GAME = (document.documentElement.getAttribute("data-game") || "game").replace(/[^a-z0-9-]/gi, "").toLowerCase();
  var ID_PREFIX = "hkgames-v1-" + GAME + "-";
  var CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  var qs = new URLSearchParams(location.search);
  var META = Object.freeze({ fromCache: false, hasPendingWrites: false });

  // ---------- identity (kept per browser so a reload keeps your seat) ----------
  var uid = null;
  try { uid = localStorage.getItem("kgn-uid"); } catch (e) {}
  if (!uid || !/^u_[a-z0-9]{10,30}$/.test(uid)) {
    uid = "u_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    try { localStorage.setItem("kgn-uid", uid); } catch (e) {}
  }

  // ---------- helpers ----------
  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  function err(code, message) { var e = new Error(message || code); e.code = code; return e; }
  function plain(o) { return o && typeof o === "object" && !Array.isArray(o); }
  function later(fn) { Promise.resolve().then(fn); }
  function safe(fn, arg) { try { fn(arg); } catch (e) { setTimeout(function () { throw e; }); } }
  function genCode() { var s = ""; for (var i = 0; i < 5; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]; return s; }
  function cleanCode(s) { return String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8); }
  function peerId(code) { return ID_PREFIX + code.toLowerCase(); }
  function parentOf(p) { return p.split("/").slice(0, -1).join("/"); }
  function lastSeg(p) { var a = p.split("/"); return a[a.length - 1]; }
  function isPrivate(p) { return p.indexOf("data/users/") === 0; }
  function merge(a, b) {
    var out = plain(a) ? clone(a) : {};
    Object.keys(b).forEach(function (k) {
      if (plain(b[k]) && b[k].__delete__ === true) delete out[k];
      else if (plain(b[k]) && plain(out[k])) out[k] = merge(out[k], b[k]);
      else out[k] = clone(b[k]);
    });
    return out;
  }
  function checkPath(path, even) {
    if (typeof path !== "string" || !path) throw new TypeError("Path must be a non-empty string");
    var segs = path.split("/");
    if (segs.some(function (s) { return !/^[A-Za-z0-9_\-.~:@+]{1,200}$/.test(s) || s === "." || s === ".."; }))
      throw new TypeError("Bad path segment in " + path);
    if ((segs.length % 2 === 0) !== even) throw new TypeError((even ? "Document" : "Collection") + " path has the wrong number of segments: " + path);
  }

  // ---------- state ----------
  var state = {
    isHost: false, code: null, peer: null, conn: null, myLabel: null,
    connected: false, ready: null, resolveReady: null, lost: false
  };
  var shared = new Map();             // shared docs (host: master copy, guest: live replica)
  var priv = new Map();               // private docs, this device only
  var docSubs = new Map(), colSubs = new Map();
  var leases = new Map();             // host only
  var conns = new Map();              // host only: DataConnection -> {label, uid}
  var joinCount = 0;
  var pending = new Map(), reqSeq = 0; // guest only
  var pres = new Map();               // label -> {by, presence, updatedAt}
  var peerCache = null, peerSubs = new Set(), connSubs = new Set(), topicSubs = new Map();

  function privKey(path) { return "kgn-priv-" + GAME + "-" + path; }
  function readPriv(path) {
    if (!priv.has(path)) { var v; try { var s = localStorage.getItem(privKey(path)); if (s) v = JSON.parse(s); } catch (e) {} priv.set(path, v); }
    return priv.get(path);
  }
  function writePriv(path, v) {
    priv.set(path, v);
    try { if (v === undefined) localStorage.removeItem(privKey(path)); else localStorage.setItem(privKey(path), JSON.stringify(v)); } catch (e) {}
  }
  function readAny(path) { return isPrivate(path) ? readPriv(path) : shared.get(path); }

  // ---------- snapshots + local listeners ----------
  function docSnap(path, value) {
    var v = arguments.length > 1 ? value : readAny(path);
    return { id: lastSeg(path), exists: v !== undefined && v !== null, data: function () { return v == null ? undefined : clone(v); }, metadata: META };
  }
  function colSnap(col) {
    var src = isPrivate(col + "/x") ? priv : shared, paths = [];
    src.forEach(function (v, p) { if (v !== undefined && parentOf(p) === col) paths.push(p); });
    paths.sort();
    var docs = paths.map(function (p) { return docSnap(p); });
    return { docs: docs, size: docs.length, empty: !docs.length, metadata: META,
      docChanges: function () { return docs.map(function (d, i) { return { type: "added", doc: d, oldIndex: -1, newIndex: i }; }); } };
  }
  function notify(path) {
    later(function () {
      var ds = docSubs.get(path); if (ds) ds.forEach(function (fn) { safe(fn, docSnap(path)); });
      var col = parentOf(path), cs = colSubs.get(col); if (cs) cs.forEach(function (fn) { safe(fn, colSnap(col)); });
    });
  }
  function sub(map, key, fn) { if (!map.has(key)) map.set(key, new Set()); map.get(key).add(fn); return function () { var s = map.get(key); if (s) s.delete(fn); }; }

  // ---------- host: the master copy ----------
  function hostOp(op, path, data, writer) {
    if (typeof path !== "string" || isPrivate(path)) throw err("invalid_argument", "Bad path");
    checkPath(path, true);
    if (op === "get") return shared.has(path) ? clone(shared.get(path)) : null;
    if (op === "acquire") return hostAcquire(path, data || {});
    if (op === "set") { if (!plain(data)) throw err("invalid_argument", "Document must be an object"); hostCommit(path, clone(data)); release(path, writer); return null; }
    if (op === "update") { if (!shared.has(path)) throw err("invalid_argument", "Document does not exist"); if (!plain(data)) throw err("invalid_argument", "Document must be an object"); hostCommit(path, merge(shared.get(path), data)); release(path, writer); return null; }
    if (op === "delete") { hostCommit(path, undefined); release(path, writer); return null; }
    throw err("invalid_argument", "Unknown operation");
  }
  function hostCommit(path, v) {
    if (v === undefined) shared.delete(path); else shared.set(path, v);
    broadcast({ t: "doc", path: path, v: v === undefined ? null : v });
    notify(path);
  }
  // A lock is done once its holder has written: free it so the next player doesn't wait out the timer.
  function release(path, writer) { var l = leases.get(path); if (l && writer && l.holder === writer) leases.delete(path); }
  function hostAcquire(path, o) {
    var now = Date.now(), l = leases.get(path), holder = String(o.holder || "");
    var ttl = Math.max(1000, Math.min(600000, +o.ttlMs || 30000));
    if (!l || l.exp <= now || l.holder === holder) {
      leases.set(path, { holder: holder, exp: now + ttl });
      return { acquired: true, version: 1, expiresAt: new Date(now + ttl).toISOString(), holder: holder };
    }
    return { acquired: false, expiresAt: new Date(l.exp).toISOString() };
  }
  function broadcast(msg) { conns.forEach(function (m, c) { if (c.open) { try { c.send(msg); } catch (e) {} } }); }
  function peerList() {
    var out = []; pres.forEach(function (v, label) { out.push({ peer: label, by: v.by, presence: v.presence, updatedAt: v.updatedAt }); });
    out.sort(function (a, b) { return a.peer < b.peer ? -1 : 1; }); return out;
  }
  function hostPeersChanged() { var list = peerList(); broadcast({ t: "peers", list: list }); setPeers(list); }
  function hostRelay(topic, data, label, by) {
    var msg = { t: "msg", topic: topic, data: data, from: label, by: by };
    broadcast(msg); deliver(msg);
  }
  function hostOnConnection(conn) {
    conn.on("data", function (msg) {
      if (!msg || typeof msg !== "object") return;
      if (msg.t === "hello") {
        if (conns.has(conn)) return;
        var meta = { label: "b" + String(++joinCount).padStart(4, "0"), uid: String(msg.uid || "").slice(0, 40) || ("u_guest" + joinCount) };
        conns.set(conn, meta);
        pres.set(meta.label, { by: meta.uid, presence: {}, updatedAt: Date.now() });
        var docs = []; shared.forEach(function (v, p) { docs.push([p, v]); });
        conn.send({ t: "welcome", label: meta.label, docs: docs, peers: peerList() });
        hostPeersChanged(); updateBar();
        return;
      }
      var meta2 = conns.get(conn); if (!meta2) return;
      if (msg.t === "req") {
        var res;
        try { res = { t: "res", id: msg.id, ok: true, v: hostOp(String(msg.op), msg.path, msg.data, meta2.uid) }; }
        catch (e) { res = { t: "res", id: msg.id, ok: false, e: { code: e.code || "invalid_argument", message: e.message } }; }
        try { conn.send(res); } catch (e) {}
      } else if (msg.t === "emit") {
        if (typeof msg.topic === "string" && /^[a-z][a-z0-9_.-]{0,47}$/.test(msg.topic)) hostRelay(msg.topic, msg.data, meta2.label, meta2.uid);
      } else if (msg.t === "presence" && plain(msg.patch)) {
        var cur = pres.get(meta2.label); if (!cur) return;
        cur.presence = applyPatch(cur.presence, msg.patch); cur.updatedAt = Date.now(); hostPeersChanged();
      }
    });
    var drop = function () {
      var meta = conns.get(conn); if (!meta) return;
      conns.delete(conn); pres.delete(meta.label); hostPeersChanged(); updateBar();
    };
    conn.on("close", drop); conn.on("error", drop);
  }
  function applyPatch(cur, patch) {
    var out = {}; Object.keys(cur || {}).forEach(function (k) { out[k] = cur[k]; });
    Object.keys(patch).forEach(function (k) { if (patch[k] === null) delete out[k]; else out[k] = clone(patch[k]); });
    return Object.freeze(out);
  }

  // ---------- guest: talk to the host ----------
  function request(op, path, data) {
    if (!state.connected || !state.conn || !state.conn.open) return Promise.reject(err("unavailable", "Not connected to the room"));
    return new Promise(function (resolve, reject) {
      var id = ++reqSeq;
      var timer = setTimeout(function () { pending.delete(id); reject(err("unavailable", "The room didn't answer")); }, 12000);
      pending.set(id, { resolve: resolve, reject: reject, timer: timer });
      try { state.conn.send({ t: "req", id: id, op: op, path: path, data: data === undefined ? null : data }); }
      catch (e) { clearTimeout(timer); pending.delete(id); reject(err("unavailable", "Couldn't send")); }
    });
  }
  function guestOnData(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.t === "welcome") {
      state.myLabel = msg.label;
      shared.clear(); (msg.docs || []).forEach(function (e) { shared.set(e[0], e[1]); });
      setPeers(msg.peers || []);
      setConnected(true);
      if (state.resolveReady) { state.resolveReady(); state.resolveReady = null; }
      shared.forEach(function (v, p) { notify(p); });
    } else if (msg.t === "doc") {
      if (msg.v === null) shared.delete(msg.path); else shared.set(msg.path, msg.v);
      notify(msg.path);
    } else if (msg.t === "res") {
      var p = pending.get(msg.id); if (!p) return;
      clearTimeout(p.timer); pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.v); else p.reject(err(msg.e && msg.e.code || "unavailable", msg.e && msg.e.message));
    } else if (msg.t === "msg") deliver(msg);
    else if (msg.t === "peers") setPeers(msg.list || []);
  }
  function guestLost() {
    if (state.isHost || state.lost) return;
    state.lost = true; setConnected(false);
    pending.forEach(function (p) { clearTimeout(p.timer); p.reject(err("unavailable", "Disconnected")); }); pending.clear();
    updateBar();
  }

  // ---------- room presence + messages (both sides) ----------
  function setPeers(list) {
    var prev = peerCache || [];
    var prevLabels = new Set(prev.map(function (p) { return p.peer; }));
    peerCache = Object.freeze(list.map(function (p) {
      return Object.freeze({ peer: p.peer, by: p.by, isMe: p.by === uid, sameTab: p.peer === state.myLabel, kind: "viewer", guest: false,
        presence: Object.freeze(p.presence || {}), updatedAt: p.updatedAt || Date.now() });
    }));
    var nowLabels = new Set(peerCache.map(function (p) { return p.peer; }));
    var change = { peers: peerCache,
      joined: peerCache.filter(function (p) { return !prevLabels.has(p.peer); }),
      left: prev.filter(function (p) { return !nowLabels.has(p.peer); }),
      updated: peerCache.filter(function (p) { return prevLabels.has(p.peer); }) };
    peerSubs.forEach(function (fn) { later(function () { safe(fn, change); }); });
    updateBar();
  }
  function deliver(msg) {
    var subs = topicSubs.get(msg.topic); if (!subs) return;
    var m = Object.freeze({ topic: msg.topic, data: msg.data, peer: msg.from, by: msg.by, isMe: msg.by === uid, sameTab: msg.from === state.myLabel, kind: "viewer", guest: false });
    subs.forEach(function (fn) { later(function () { safe(fn, m); }); });
  }
  function setConnected(c) { if (state.connected === c) return; state.connected = c; connSubs.forEach(function (fn) { later(function () { safe(fn, c); }); }); }

  // ---------- the API the games call ----------
  function docRef(path) {
    checkPath(path, true);
    return {
      id: lastSeg(path), path: path,
      get: function () {
        if (isPrivate(path) || state.isHost) return Promise.resolve(docSnap(path));
        return request("get", path).then(function (v) { return docSnap(path, v === null ? undefined : v); });
      },
      set: function (d) { return write("set", path, d); },
      update: function (d) { return write("update", path, d); },
      delete: function () { return write("delete", path); },
      acquire: function (o) {
        if (isPrivate(path)) return Promise.resolve({ acquired: true, version: 1, expiresAt: new Date(Date.now() + 30000).toISOString(), holder: o && o.holder });
        if (state.isHost) { try { return Promise.resolve(hostAcquire(path, o || {})); } catch (e) { return Promise.reject(e); } }
        return request("acquire", path, { holder: o && o.holder, ttlMs: o && o.ttlMs });
      },
      onSnapshot: function (next, onErr) {
        var off = sub(docSubs, path, next);
        later(function () { safe(next, docSnap(path)); });
        return off;
      },
      collection: function (subPath) { return colRef(path + "/" + subPath); }
    };
  }
  function colRef(path) {
    checkPath(path, false);
    var q = {
      path: path,
      doc: function (id) { return docRef(path + "/" + (id || Math.random().toString(36).slice(2, 12))); },
      add: function (d) { var r = q.doc(); return r.set(d).then(function () { return r; }); },
      get: function () { return Promise.resolve(colSnap(path)); },
      onSnapshot: function (next) { var off = sub(colSubs, path, next); later(function () { safe(next, colSnap(path)); }); return off; },
      where: function () { return q; }, orderBy: function () { return q; }, limit: function () { return q; }
    };
    return q;
  }
  function write(op, path, data) {
    if (op !== "delete" && !plain(data)) return Promise.reject(err("invalid_argument", "Document must be an object"));
    if (isPrivate(path)) {
      var cur = readPriv(path);
      if (op === "update" && cur === undefined) return Promise.reject(err("invalid_argument", "Document does not exist"));
      writePriv(path, op === "delete" ? undefined : op === "update" ? merge(cur, data) : clone(data));
      notify(path); return Promise.resolve();
    }
    if (state.isHost) { try { hostOp(op, path, data, uid); return Promise.resolve(); } catch (e) { return Promise.reject(e); } }
    return request(op, path, data).then(function () {});
  }

  var dbApi = Object.freeze({ doc: docRef, collection: colRef });

  function blankProfile(id) { return { id: id, name: "", avatarUrl: "", color: "#888888", email: null, isMe: id === uid, guest: false }; }
  var userApi = Object.freeze({
    id: function () { return Promise.resolve(uid); },
    me: function () { return Promise.resolve({ id: uid, name: "", avatarUrl: "", color: "#888888", email: null, isOwner: state.isHost, canEdit: true }); },
    isOwner: function () { return Promise.resolve(state.isHost); },
    canEdit: function () { return Promise.resolve(true); },
    can: function () { return Promise.resolve(true); },
    profiles: function (ids) { var out = {}; [].concat(ids || []).forEach(function (i) { out[i] = blankProfile(i); }); return Promise.resolve(out); },
    name: function () { return Promise.resolve(""); },
    avatarUrl: function () { return Promise.resolve(null); },
    email: function () { return Promise.resolve(null); },
    search: function () { return Promise.resolve([]); }
  });

  var roomApi = Object.freeze({
    emit: function (topic, data) {
      if (!/^[a-z][a-z0-9_.-]{0,47}$/.test(String(topic))) return Promise.reject(err("invalid_argument", "Bad topic"));
      if (state.isHost) { hostRelay(topic, clone(data), state.myLabel, uid); return Promise.resolve(); }
      if (state.connected && state.conn && state.conn.open) { try { state.conn.send({ t: "emit", topic: topic, data: data === undefined ? null : data }); } catch (e) {} }
      return Promise.resolve();
    },
    on: function (topic, fn) { if (typeof fn !== "function") throw new TypeError("handler must be a function"); return sub(topicSubs, topic, fn); },
    presence: function (patch) {
      if (!plain(patch)) return Promise.reject(err("invalid_argument", "Presence must be an object"));
      if (state.isHost) {
        var cur = pres.get(state.myLabel); cur.presence = applyPatch(cur.presence, patch); cur.updatedAt = Date.now(); hostPeersChanged();
      } else if (state.connected && state.conn && state.conn.open) { try { state.conn.send({ t: "presence", patch: patch }); } catch (e) {} }
      return Promise.resolve();
    },
    peers: function () { return peerCache || Object.freeze([]); },
    onPeers: function (fn) {
      peerSubs.add(fn);
      later(function () { var p = peerCache || []; safe(fn, { peers: p, joined: p, left: [], updated: [] }); });
      return function () { peerSubs.delete(fn); };
    },
    connected: function () { return state.connected; },
    onConnection: function (fn) { connSubs.add(fn); later(function () { safe(fn, state.connected); }); return function () { connSubs.delete(fn); }; },
    join: function () { return Promise.reject(err("not_permitted", "Named rooms aren't available here")); },
    canSendToClaudeSession: function () { return Promise.resolve("off"); },
    sendToClaudeSession: function () { return Promise.reject(err("claude_unavailable", "Not available")); }
  });

  // ---------- connecting ----------
  function peerOptions() {
    var o = { debug: 0 };
    var sig = qs.get("signal");
    if (sig && /^[a-z0-9.-]+:\d{2,5}$/i.test(sig)) {
      var parts = sig.split(":"); o.host = parts[0]; o.port = +parts[1]; o.path = "/"; o.secure = false; o.config = { iceServers: [] };
    }
    return o;
  }
  function createRoom(attempt) {
    attempt = attempt || 0;
    var code = genCode();
    showStatus("Opening a room…");
    var peer = new window.Peer(peerId(code), peerOptions());
    var opened = false;
    peer.on("open", function () {
      opened = true;
      state.isHost = true; state.code = code; state.peer = peer; state.myLabel = "a0000";
      pres.set(state.myLabel, { by: uid, presence: {}, updatedAt: Date.now() });
      setPeers(peerList()); setConnected(true);
      closeModal(); updateBar();
      if (state.resolveReady) { state.resolveReady(); state.resolveReady = null; }
    });
    peer.on("connection", hostOnConnection);
    peer.on("disconnected", function () { if (!peer.destroyed) { try { peer.reconnect(); } catch (e) {} } });
    peer.on("error", function (e) {
      if (e && e.type === "unavailable-id" && attempt < 4) { peer.destroy(); createRoom(attempt + 1); return; }
      if (opened) return; // a guest's connection failing is not fatal for the host
      peer.destroy();
      showError(e && (e.type === "network" || e.type === "server-error" || e.type === "socket-error")
        ? "Couldn't reach the connection service. Check your internet and try again."
        : "Couldn't open a room. Try again.");
    });
  }
  function joinRoom(code) {
    code = cleanCode(code);
    if (code.length < 4) { showError("Type the room code your friend sent you."); return; }
    showStatus("Joining room " + code + "…");
    var peer = new window.Peer(peerOptions()), done = false;
    var fail = function (msg) { if (done) return; done = true; try { peer.destroy(); } catch (e) {} showError(msg); };
    var timer = setTimeout(function () { fail("Room " + code + " didn't answer. Check the code, or ask your friend to keep the game open."); }, 20000);
    peer.on("open", function () {
      var conn = peer.connect(peerId(code), { reliable: true, serialization: "json" });
      conn.on("open", function () { conn.send({ t: "hello", uid: uid }); });
      conn.on("data", function (msg) {
        if (msg && msg.t === "welcome" && !done) {
          done = true; clearTimeout(timer);
          state.isHost = false; state.code = code; state.peer = peer; state.conn = conn;
          closeModal();
          try { var u = new URL(location.href); u.searchParams.set("room", code); history.replaceState(null, "", u.toString()); } catch (e) {}
        }
        guestOnData(msg);
      });
      conn.on("close", guestLost); conn.on("error", guestLost);
    });
    peer.on("error", function (e) {
      if (state.connected) { if (e && e.type === "peer-unavailable") guestLost(); return; }
      clearTimeout(timer);
      if (e && e.type === "peer-unavailable") fail("Room " + code + " isn't open. The person who made it may have closed the game.");
      else if (e && (e.type === "network" || e.type === "server-error" || e.type === "socket-error")) fail("Couldn't reach the connection service. Check your internet and try again.");
      else fail("Couldn't join room " + code + ". Try again.");
    });
    peer.on("disconnected", function () { if (state.connected && !peer.destroyed) { try { peer.reconnect(); } catch (e) {} } });
  }
  function ensureRoom() {
    if (state.ready) return state.ready;
    state.ready = new Promise(function (resolve) { state.resolveReady = resolve; });
    if (!window.Peer) { openModal(); showError("The online library didn't load. Check your internet and reload the page."); return state.ready; }
    openModal();
    var code = cleanCode(qs.get("room"));
    if (code) { ui.code.value = code; joinRoom(code); }
    return state.ready;
  }

  window.claude = Object.freeze({
    use: function (name) {
      if (name === "db") return ensureRoom().then(function () { return dbApi; });
      if (name === "user") return ensureRoom().then(function () { return userApi; });
      if (name === "room") return ensureRoom().then(function () { return roomApi; });
      return Promise.resolve(null);
    }
  });

  // ---------- room UI: a join dialog and a small room bar ----------
  var css = [
    ".kgn-modal,.kgn-modal *{box-sizing:border-box}",
    ".kgn-modal{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(10,12,20,.55);font-family:system-ui,-apple-system,'Segoe UI',sans-serif}",
    ".kgn-card{--k-bg:#fff;--k-ink:#15181f;--k-muted:#5e6676;--k-line:#d6dbe4;--k-acc:#3b5bdb;background:var(--k-bg);color:var(--k-ink);border-radius:16px;padding:20px;width:100%;max-width:360px;display:flex;flex-direction:column;gap:12px;box-shadow:0 20px 50px -20px rgba(0,0,0,.5)}",
    "@media (prefers-color-scheme:dark){.kgn-card{--k-bg:#1a1e27;--k-ink:#eef1f6;--k-muted:#9aa3b2;--k-line:#2f3644;--k-acc:#7c9cff}}",
    ".kgn-card h2{margin:0;font-size:1.25rem}",
    ".kgn-card p{margin:0;color:var(--k-muted);font-size:.92rem;line-height:1.45}",
    ".kgn-btn{font:inherit;font-weight:700;font-size:.95rem;padding:10px 14px;border-radius:10px;border:1px solid var(--k-line);background:transparent;color:var(--k-ink);cursor:pointer}",
    ".kgn-btn.p{background:var(--k-acc);border-color:var(--k-acc);color:#fff}",
    ".kgn-btn:disabled{opacity:.5;cursor:default}",
    ".kgn-or{display:flex;align-items:center;gap:8px;color:var(--k-muted);font-size:.8rem;text-transform:uppercase;letter-spacing:.08em}",
    ".kgn-or::before,.kgn-or::after{content:'';flex:1;height:1px;background:var(--k-line)}",
    ".kgn-join{display:flex;gap:8px}",
    ".kgn-join input{flex:1;min-width:0;font:inherit;font-size:1.1rem;font-weight:700;letter-spacing:.15em;text-transform:uppercase;padding:9px 12px;border-radius:10px;border:1px solid var(--k-line);background:transparent;color:var(--k-ink)}",
    ".kgn-msg{font-size:.9rem;font-weight:600;min-height:1.3em}",
    ".kgn-msg.e{color:#d9381e}",
    ".kgn-card :focus-visible{outline:2px solid var(--k-acc);outline-offset:2px}",
    ".kgn-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:center;padding:7px 12px;padding-left:max(12px,env(safe-area-inset-left,0px));padding-right:max(12px,env(safe-area-inset-right,0px));font:600 13px/1.3 system-ui,-apple-system,'Segoe UI',sans-serif;background:#1f2633;color:#eef1f6}",
    ".kgn-bar b{letter-spacing:.12em;font-size:14px}",
    ".kgn-bar button{font:inherit;padding:4px 10px;border-radius:999px;border:1px solid rgba(255,255,255,.35);background:transparent;color:inherit;cursor:pointer}",
    ".kgn-bar button.p{background:#fff;color:#1f2633;border-color:#fff}",
    ".kgn-bar.lost{background:#b3261e}"
  ].join("\n");
  var ui = {};
  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { if (k === "text") e.textContent = attrs[k]; else e.setAttribute(k, attrs[k]); });
    (kids || []).forEach(function (k) { e.append(k); }); return e;
  }
  function buildModal() {
    if (ui.modal) return;
    document.head.append(el("style", { text: css }));
    ui.create = el("button", { type: "button", class: "kgn-btn p", text: "Create a room" });
    ui.code = el("input", { type: "text", id: "kgn-code", maxlength: "8", placeholder: "CODE", autocomplete: "off", autocapitalize: "characters", "aria-label": "Room code" });
    ui.join = el("button", { type: "button", class: "kgn-btn", text: "Join" });
    ui.msg = el("div", { class: "kgn-msg", role: "status", "aria-live": "polite" });
    ui.back = el("button", { type: "button", class: "kgn-btn", text: "Play offline instead" });
    ui.card = el("div", { class: "kgn-card", role: "dialog", "aria-modal": "true", "aria-labelledby": "kgn-title" }, [
      el("h2", { id: "kgn-title", text: "Play online" }),
      el("p", { text: "Create a room and send the invite link to your friends, or type the code a friend sent you. No sign-in needed." }),
      ui.create, el("div", { class: "kgn-or", text: "or join" }), el("div", { class: "kgn-join" }, [ui.code, ui.join]), ui.msg, ui.back
    ]);
    ui.modal = el("div", { class: "kgn-modal" }, [ui.card]);
    ui.create.addEventListener("click", function () { setBusy(true); createRoom(); });
    ui.join.addEventListener("click", function () { setBusy(true); joinRoom(ui.code.value); });
    ui.code.addEventListener("keydown", function (e) { if (e.key === "Enter") { setBusy(true); joinRoom(ui.code.value); } });
    ui.back.addEventListener("click", function () { location.href = location.pathname; });
  }
  function openModal() { buildModal(); document.body.append(ui.modal); setBusy(false); ui.msg.textContent = ""; }
  function closeModal() { if (ui.modal && ui.modal.parentNode) ui.modal.remove(); }
  function setBusy(b) { ui.create.disabled = b; ui.join.disabled = b; ui.code.disabled = b; }
  function showStatus(t) { if (!ui.msg) return; ui.msg.className = "kgn-msg"; ui.msg.textContent = t; }
  function showError(t) { if (!ui.msg) openModal(); ui.msg.className = "kgn-msg e"; ui.msg.textContent = t; setBusy(false); }

  function inviteLink() { var u = new URL(location.href); u.search = ""; u.hash = ""; u.searchParams.set("room", state.code); var s = qs.get("signal"); if (s) u.searchParams.set("signal", s); return u.toString(); }
  function updateBar() {
    if (!state.code) return;
    if (!ui.bar) {
      buildModal();
      ui.bar = el("div", { class: "kgn-bar", role: "region", "aria-label": "Online room" });
      document.body.prepend(ui.bar);
    }
    ui.bar.textContent = "";
    ui.bar.classList.toggle("lost", state.lost);
    if (state.lost) {
      var again = el("button", { type: "button", class: "p", text: "Reconnect" });
      again.addEventListener("click", function () { location.href = inviteLink(); });
      var off = el("button", { type: "button", text: "Play offline" });
      off.addEventListener("click", function () { location.href = location.pathname; });
      ui.bar.append(el("span", { text: "Lost connection to room " + state.code + "." }), again, off);
      return;
    }
    var n = (peerCache || []).length;
    var invite = el("button", { type: "button", class: "p", text: "Invite friends" });
    invite.addEventListener("click", function () {
      var link = inviteLink();
      if (navigator.share) { navigator.share({ title: document.title, text: "Join my game", url: link }).catch(function () {}); return; }
      (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(
        function () { invite.textContent = "Link copied"; setTimeout(function () { invite.textContent = "Invite friends"; }, 2000); },
        function () {
          var box = el("input", { type: "text", readonly: "", value: link, "aria-label": "Invite link", style: "font:inherit;min-width:0;width:16em;max-width:100%;padding:3px 8px;border-radius:6px;border:0" });
          invite.replaceWith(box); box.focus(); box.select();
        });
    });
    var leave = el("button", { type: "button", text: "Leave" });
    leave.addEventListener("click", function () { location.href = location.pathname; });
    ui.bar.append(el("span", {}, ["Room ", el("b", { text: state.code }), " · " + n + " connected" + (state.isHost ? " · you're the host" : "")]), invite, leave);
  }
  window.addEventListener("beforeunload", function (e) {
    if (state.isHost && conns.size > 0) { e.preventDefault(); e.returnValue = ""; }
  });

  // Opening an invite link switches straight to online play.
  function autoJoin() {
    if (!cleanCode(qs.get("room"))) return;
    var tab = document.getElementById("tabOnline");
    if (tab) tab.click(); else ensureRoom();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", autoJoin); else setTimeout(autoJoin, 0);
})();
